// sworm worker: the control plane for your fleet.
//
// Routes:
//   GET  /health                 liveness, no auth
//   GET  /install                installer script for macOS and linux, public
//   GET  /install.ps1            installer script for windows, public
//   GET  /v1/agent               agent source, bootstrap or agent token
//   POST /v1/enroll              enroll a new machine, bootstrap token
//   POST /v1/poll                agent heartbeat, signed order envelope out
//   POST /v1/ack                 agent reports an order outcome
//   POST /v1/result              agent uploads a tree or pull payload
//   GET  /v1/owner/machines      list the fleet, owner token
//   GET  /v1/owner/machines/:id  one machine in full
//   POST /v1/owner/wipe          scoped wipe order
//   POST /v1/owner/delete        delete explicit paths
//   POST /v1/owner/push          write small files
//   POST /v1/owner/tree          directory listing
//   POST /v1/owner/pull          read files back
//   POST /v1/owner/exec          run a shell command
//   GET  /v1/owner/result        read a stored tree, pull, or exec result
//   POST /v1/owner/cancel        cancel a pending order
//   GET  /v1/owner/status        every order and its state
//
// Required secrets (set with: npx wrangler secret put <NAME>):
//   OWNER_TOKEN      signs in to the /v1/owner/* routes
//   BOOTSTRAP_TOKEN  signs in to /v1/enroll and the agent download
//   HMAC_KEY         signs the order envelopes that agents verify
//
// Optional vars (wrangler.toml [vars]):
//   AGENT_URL     where /v1/agent and the installer download agent.js from
//   WIPE_FOLDERS  comma separated folder names a wipe order targets
//   SEARCH_ROOTS  comma separated home-relative roots a wipe searches

import { INSTALL_SH } from "./install-sh.js";
import { INSTALL_PS1 } from "./install-ps1.js";

const ORDER_TTL_SEC = 24 * 60 * 60; // orders die 24 hours after they are placed
const RESULT_TTL_SEC = 60 * 60; // tree and pull results live for 1 hour
const KV_VALUE_CAP = 24 * 1024 * 1024; // kv values max out at 25 MB, keep margin
const ENVELOPE_TTL_SEC = 180; // a signed order envelope is valid for 3 minutes

// Roots a wipe searches when neither the order nor SEARCH_ROOTS name any.
// Each entry is relative to the managed machine's home directory.
const DEFAULT_SEARCH_ROOTS = [
  "Documents/GitHub",
  "Documents/github",
  "Documents/code",
  "GitHub",
  "Projects",
  "dev",
  "src",
  "code",
  "repos",
  "workspace",
  "Developer",
  "Sites",
  "Desktop",
  "Downloads",
];

const enc = new TextEncoder();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function timingSafeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bearer(req) {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function uuid() {
  return crypto.randomUUID();
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function geo(req) {
  const c = req.cf || {};
  return {
    ip: req.headers.get("cf-connecting-ip") || "",
    city: c.city || "",
    country: c.country || "",
    isp: c.asOrganization || "",
  };
}

async function kvGet(env, key) {
  const raw = await env.SWORM_KV.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function kvPut(env, key, obj, ttlSec) {
  const opts = ttlSec ? { expirationTtl: ttlSec } : undefined;
  await env.SWORM_KV.put(key, JSON.stringify(obj), opts);
}

async function listKeys(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.SWORM_KV.list({ prefix, cursor });
    out.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

// The order envelope the agent verifies. Field order matters: the agent
// rebuilds this exact string and compares HMACs. Change both sides together.
async function signPayload(env, payload) {
  const foldersHash = await sha256Hex(
    JSON.stringify({
      folders: payload.folders || [],
      searchRoots: payload.searchRoots || [],
      removeAgent: !!payload.removeAgent,
    })
  );
  const parts = [
    "v1",
    String(payload.iat),
    String(payload.exp),
    payload.machineId,
    payload.wipe ? "true" : "false",
    payload.orderId || "",
    String(payload.orderVersion || 0),
    payload.nonce,
    foldersHash,
  ];
  if (payload.action) {
    const actionData = {
      action: payload.action,
      paths: payload.paths || [],
      files: payload.files || [],
    };
    if (payload.action === "tree") {
      actionData.path = payload.path || "";
      actionData.depth = payload.depth || 0;
    }
    if (payload.action === "exec") {
      actionData.command = payload.command || "";
      actionData.timeoutSec = payload.timeoutSec || 0;
      actionData.cwd = payload.cwd || "";
    }
    parts.push(await sha256Hex(JSON.stringify(actionData)));
  }
  const mac = await hmacHex(env.HMAC_KEY, parts.join("|"));
  return { payload, sig: { alg: "HS256", kid: "sworm-1", mac } };
}

function ownerOk(env, token) {
  return !!env.OWNER_TOKEN && timingSafeEq(token, env.OWNER_TOKEN);
}

// Agent tokens get their own index key at enroll time, so auth is one kv
// read instead of a full fleet scan.
async function requireAgent(env, req) {
  const token = bearer(req);
  if (!token) return { ok: false, res: json({ error: "auth" }, 401) };
  const hit = await kvGet(env, `token:${token}`);
  if (!hit || !hit.machineId) return { ok: false, res: json({ error: "auth" }, 401) };
  return { ok: true, machineId: hit.machineId };
}

async function tokenIsAgent(env, token) {
  if (!token) return false;
  const hit = await kvGet(env, `token:${token}`);
  return !!(hit && hit.machineId);
}

// Fill the installer template with this worker's origin and secrets.
function renderInstaller(env, req, template) {
  const origin = new URL(req.url).origin;
  return template
    .split("__SWORM_WORKER_URL__").join(origin)
    .split("__SWORM_BOOTSTRAP_TOKEN__").join(env.BOOTSTRAP_TOKEN || "")
    .split("__SWORM_AGENT_URL__").join(env.AGENT_URL || "");
}

function textResponse(body) {
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

// Shared prologue for the five order routes: find the machine and make
// sure the caller confirmed the exact hostname they are targeting.
async function orderTarget(env, body) {
  const id = String(body.machineId || "");
  if (!id) return { error: json({ error: "machineId required" }, 400) };
  const profile = await kvGet(env, `machine:${id}:profile`);
  if (!profile) return { error: json({ error: "unknown machine" }, 404) };
  if (body.confirmHostname !== profile.hostname) {
    return { error: json({ error: "hostname mismatch", hostname: profile.hostname }, 400) };
  }
  return { id, profile };
}

async function placeOrder(env, id, type, extra) {
  const existing = await kvGet(env, `order:${id}`);
  const order = {
    orderId: "ord_" + uuid().replace(/-/g, "").slice(0, 12),
    orderVersion: (existing && existing.orderVersion || 0) + 1,
    type,
    status: "pending",
    orderedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ORDER_TTL_SEC * 1000).toISOString(),
    ...extra,
  };
  await kvPut(env, `order:${id}`, order, ORDER_TTL_SEC);
  return order;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (req.method === "GET" && path === "/health") {
        return json({ ok: true, service: "sworm", version: "1.0.0" });
      }

      // Every other route needs the three secrets configured.
      if (!env.OWNER_TOKEN || !env.BOOTSTRAP_TOKEN || !env.HMAC_KEY) {
        return json(
          {
            error: "misconfigured",
            hint: "set OWNER_TOKEN, BOOTSTRAP_TOKEN, and HMAC_KEY with: npx wrangler secret put <NAME>",
          },
          500
        );
      }

      // Public installers. They embed the bootstrap token, which only
      // allows enrollment. See docs/security.md before you deploy.
      if (req.method === "GET" && path === "/install") {
        return textResponse(renderInstaller(env, req, INSTALL_SH));
      }
      if (req.method === "GET" && path === "/install.ps1") {
        return textResponse(renderInstaller(env, req, INSTALL_PS1));
      }

      // Agent source. The installer downloads agent.js from here when no
      // direct AGENT_URL is set or reachable.
      if (req.method === "GET" && path === "/v1/agent") {
        const token = bearer(req);
        const boot = timingSafeEq(token, env.BOOTSTRAP_TOKEN);
        if (!boot && !(await tokenIsAgent(env, token))) return json({ error: "auth" }, 401);
        if (!env.AGENT_URL) {
          return json(
            { error: "agent source not configured", hint: "set AGENT_URL in wrangler.toml [vars]" },
            404
          );
        }
        const upstream = await fetch(env.AGENT_URL, { headers: { "user-agent": "sworm-worker" } });
        if (!upstream.ok) return json({ error: "agent source unavailable" }, 502);
        const body = await upstream.text();
        return new Response(body, {
          headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" },
        });
      }

      if (req.method === "POST" && path === "/v1/enroll") {
        if (!timingSafeEq(bearer(req), env.BOOTSTRAP_TOKEN)) return json({ error: "auth" }, 401);
        const body = await req.json().catch(() => ({}));
        const machineId = "m_" + uuid().replace(/-/g, "").slice(0, 12);
        const agentToken = "at_" + uuid().replace(/-/g, "") + uuid().replace(/-/g, "").slice(0, 16);
        const now = new Date().toISOString();
        await kvPut(env, `machine:${machineId}:profile`, {
          machineId,
          hostname: String(body.hostname || ""),
          os: String(body.os || ""),
          osVersion: String(body.osVersion || ""),
          arch: String(body.arch || ""),
          cpu: String(body.cpu || ""),
          cores: body.cores || 0,
          ram: String(body.ram || ""),
          user: String(body.user || ""),
          timezone: String(body.timezone || ""),
          node: String(body.node || ""),
          shell: String(body.shell || ""),
          enrolledAt: now,
        });
        await kvPut(env, `machine:${machineId}:auth`, { agentToken, issuedAt: now });
        await kvPut(env, `token:${agentToken}`, { machineId, issuedAt: now });
        await kvPut(env, `machine:${machineId}:telemetry`, {
          lastSeen: now,
          ...geo(req),
          uptimeSec: body.uptimeSec || 0,
        });
        // The agent needs the HMAC key to verify order envelopes. It only
        // travels here, once, over TLS to a bootstrap-authenticated caller.
        return json({ machineId, agentToken, hmacKey: env.HMAC_KEY });
      }

      if (req.method === "POST" && path === "/v1/poll") {
        const auth = await requireAgent(env, req);
        if (!auth.ok) return auth.res;
        const body = await req.json().catch(() => ({}));
        const nonce = String(body.nonce || "");
        const now = Math.floor(Date.now() / 1000);

        // Telemetry writes are throttled to one per 15 minutes per machine.
        const tel = (await kvGet(env, `machine:${auth.machineId}:telemetry`)) || {};
        const lastWrite = Date.parse(tel.lastWrite || 0) || 0;
        if (Date.now() - lastWrite > 15 * 60 * 1000) {
          await kvPut(env, `machine:${auth.machineId}:telemetry`, {
            ...tel,
            lastSeen: new Date().toISOString(),
            lastWrite: new Date().toISOString(),
            ...geo(req),
            uptimeSec: body.uptimeSec || 0,
          });
        }

        const order = await kvGet(env, `order:${auth.machineId}`);
        let deliver = !!(
          order &&
          (order.status === "pending" || order.status === "running")
        );
        if (deliver && order.expiresAt && Date.parse(order.expiresAt) <= Date.now()) {
          order.status = "expired";
          order.expiredAt = new Date().toISOString();
          await kvPut(env, `order:${auth.machineId}`, order);
          deliver = false;
        }
        if (deliver && order.status === "pending") {
          order.status = "running";
          await kvPut(env, `order:${auth.machineId}`, order);
        }

        const orderType = (order && order.type) || "";
        const isWipe = deliver && orderType === "wipe";
        const payload = {
          machineId: auth.machineId,
          wipe: isWipe,
          orderId: deliver ? order.orderId : "",
          orderVersion: deliver ? order.orderVersion : 0,
          nonce,
          iat: now,
          exp: now + ENVELOPE_TTL_SEC,
          folders: isWipe ? order.folders || [] : [],
          searchRoots: isWipe ? order.searchRoots || [] : [],
          removeAgent: isWipe ? order.removeAgent !== false : false,
        };
        if (deliver && orderType === "delete") {
          payload.action = "delete";
          payload.paths = Array.isArray(order.paths) ? order.paths : [];
        }
        if (deliver && orderType === "push") {
          payload.action = "push";
          payload.files = Array.isArray(order.files) ? order.files : [];
        }
        if (deliver && orderType === "tree") {
          payload.action = "tree";
          payload.path = order.path || "";
          payload.depth = order.depth || 4;
        }
        if (deliver && orderType === "pull") {
          payload.action = "pull";
          payload.paths = Array.isArray(order.paths) ? order.paths : [];
        }
        if (deliver && orderType === "exec") {
          payload.action = "exec";
          payload.command = order.command || "";
          payload.timeoutSec = order.timeoutSec || 60;
          payload.cwd = order.cwd || "";
        }
        return json(await signPayload(env, payload));
      }

      if (req.method === "POST" && path === "/v1/ack") {
        const auth = await requireAgent(env, req);
        if (!auth.ok) return auth.res;
        const body = await req.json().catch(() => ({}));
        const order = await kvGet(env, `order:${auth.machineId}`);
        if (!order || order.orderId !== body.orderId) return json({ error: "order" }, 409);
        const failed = Array.isArray(body.pathsFailed) && body.pathsFailed.length > 0;
        order.status = failed ? "partial" : "completed";
        order.ackedAt = new Date().toISOString();
        await kvPut(env, `order:${auth.machineId}`, order, ORDER_TTL_SEC);
        await kvPut(env, `order:${auth.machineId}:ack`, {
          pathsRemoved: body.pathsRemoved || [],
          pathsFailed: body.pathsFailed || [],
          pathsNotFound: body.pathsNotFound || [],
        }, ORDER_TTL_SEC);
        return json({ ok: true, status: order.status });
      }

      if (req.method === "POST" && path === "/v1/result") {
        const auth = await requireAgent(env, req);
        if (!auth.ok) return auth.res;
        const body = await req.json().catch(() => ({}));
        const order = await kvGet(env, `order:${auth.machineId}`);
        if (!order || order.orderId !== body.orderId) return json({ error: "order" }, 409);
        const kind = String(body.kind || "");
        if (kind !== "tree" && kind !== "pull" && kind !== "exec") {
          return json({ error: "kind" }, 400);
        }
        const result = {
          machineId: auth.machineId,
          orderId: String(body.orderId),
          kind,
          receivedAt: new Date().toISOString(),
        };
        if (kind === "tree") {
          result.root = String(body.root || "");
          result.error = String(body.error || "");
          result.truncated = !!body.truncated;
          result.entries = Array.isArray(body.entries) ? body.entries.slice(0, 5000) : [];
        } else if (kind === "pull") {
          result.files = Array.isArray(body.files) ? body.files : [];
          result.skipped = Array.isArray(body.skipped) ? body.skipped : [];
        } else {
          // exec output. The agent truncates at 512 KB; slice again here
          // so a buggy or hostile agent cannot fill kv.
          result.stdout = String(body.stdout || "").slice(0, 512 * 1024);
          result.stderr = String(body.stderr || "").slice(0, 512 * 1024);
          result.exitCode = typeof body.exitCode === "number" ? body.exitCode : -1;
          result.timedOut = !!body.timedOut;
        }
        const serialized = JSON.stringify(result);
        if (serialized.length > KV_VALUE_CAP) return json({ error: "too large" }, 413);
        await env.SWORM_KV.put(`result:${auth.machineId}:${result.orderId}`, serialized, {
          expirationTtl: RESULT_TTL_SEC,
        });
        return json({ ok: true });
      }

      if (path.startsWith("/v1/owner/")) {
        if (!ownerOk(env, bearer(req))) return json({ error: "auth" }, 401);
        return ownerRoutes(req, env, path);
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: "server" }, 500);
    }
  },
};

async function ownerRoutes(req, env, path) {
  if (req.method === "GET" && path === "/v1/owner/machines") {
    const keys = await listKeys(env, "machine:");
    const ids = new Set();
    for (const k of keys) {
      const parts = k.name.split(":");
      if (parts[2] === "profile") ids.add(parts[1]);
    }
    const machines = [];
    for (const id of ids) {
      const profile = await kvGet(env, `machine:${id}:profile`);
      const tel = await kvGet(env, `machine:${id}:telemetry`);
      const order = await kvGet(env, `order:${id}`);
      machines.push({
        machineId: id,
        hostname: profile && profile.hostname,
        os: profile && profile.os,
        user: profile && profile.user,
        city: tel && tel.city,
        country: tel && tel.country,
        lastSeen: tel && tel.lastSeen,
        uptimeSec: tel && tel.uptimeSec,
        order: (order && order.status) || "none",
      });
    }
    return json({ machines });
  }

  const show = path.match(/^\/v1\/owner\/machines\/([^/]+)$/);
  if (req.method === "GET" && show) {
    const id = show[1];
    return json({
      profile: await kvGet(env, `machine:${id}:profile`),
      telemetry: await kvGet(env, `machine:${id}:telemetry`),
      order: await kvGet(env, `order:${id}`),
      ack: await kvGet(env, `order:${id}:ack`),
    });
  }

  if (req.method === "POST" && path === "/v1/owner/wipe") {
    const body = await req.json().catch(() => ({}));
    const target = await orderTarget(env, body);
    if (target.error) return target.error;
    // Wipe targets come from the order itself, falling back to the
    // worker's WIPE_FOLDERS var. With neither, refuse: an unscoped wipe
    // order is never valid.
    const folders = Array.isArray(body.folders) && body.folders.length
      ? body.folders.map(String).filter(Boolean)
      : parseCsv(env.WIPE_FOLDERS);
    if (!folders.length) {
      return json(
        {
          error: "no wipe folders configured",
          hint: "pass folders in the order body or set WIPE_FOLDERS on the worker",
        },
        400
      );
    }
    if (folders.length > 50) return json({ error: "too many folders" }, 400);
    const searchRoots = Array.isArray(body.searchRoots) && body.searchRoots.length
      ? body.searchRoots.map(String).filter(Boolean)
      : parseCsv(env.SEARCH_ROOTS).length
        ? parseCsv(env.SEARCH_ROOTS)
        : DEFAULT_SEARCH_ROOTS;
    const order = await placeOrder(env, target.id, "wipe", {
      reason: String(body.reason || ""),
      folders,
      searchRoots,
      removeAgent: body.removeAgent !== false,
    });
    return json({ ok: true, order });
  }

  if (req.method === "POST" && path === "/v1/owner/delete") {
    const body = await req.json().catch(() => ({}));
    const target = await orderTarget(env, body);
    if (target.error) return target.error;
    const paths = Array.isArray(body.paths) ? body.paths.map(String).filter(Boolean) : [];
    if (!paths.length) return json({ error: "paths required" }, 400);
    if (paths.length > 50) return json({ error: "too many paths" }, 400);
    const order = await placeOrder(env, target.id, "delete", {
      reason: String(body.reason || ""),
      paths,
    });
    return json({ ok: true, order });
  }

  if (req.method === "POST" && path === "/v1/owner/push") {
    const body = await req.json().catch(() => ({}));
    const target = await orderTarget(env, body);
    if (target.error) return target.error;
    const files = Array.isArray(body.files) ? body.files : [];
    if (!files.length) return json({ error: "files required" }, 400);
    if (files.length > 10) return json({ error: "max 10 files" }, 400);
    const MAX_B64 = Math.ceil((256 * 1024 * 4) / 3) + 64; // 256 KB as base64
    const normalized = [];
    for (const f of files) {
      const p = String((f && f.path) || "").trim();
      const contentB64 = String((f && f.contentB64) || "");
      if (!p || !contentB64) return json({ error: "path and contentB64 required" }, 400);
      if (contentB64.length > MAX_B64) return json({ error: "file too large", path: p }, 400);
      normalized.push({ path: p, contentB64 });
    }
    const order = await placeOrder(env, target.id, "push", {
      reason: String(body.reason || ""),
      files: normalized,
    });
    return json({ ok: true, order });
  }

  if (req.method === "POST" && path === "/v1/owner/tree") {
    const body = await req.json().catch(() => ({}));
    const target = await orderTarget(env, body);
    if (target.error) return target.error;
    const treePath = String(body.path || "").trim();
    if (!treePath) return json({ error: "path required" }, 400);
    let depth = Math.floor(Number(body.depth || 4));
    if (!Number.isFinite(depth) || depth < 1) depth = 4;
    if (depth > 8) depth = 8;
    const order = await placeOrder(env, target.id, "tree", {
      reason: String(body.reason || ""),
      path: treePath,
      depth,
    });
    return json({ ok: true, order });
  }

  if (req.method === "POST" && path === "/v1/owner/pull") {
    const body = await req.json().catch(() => ({}));
    const target = await orderTarget(env, body);
    if (target.error) return target.error;
    const paths = Array.isArray(body.paths) ? body.paths.map(String).filter(Boolean) : [];
    if (!paths.length) return json({ error: "paths required" }, 400);
    if (paths.length > 20) return json({ error: "too many paths" }, 400);
    const order = await placeOrder(env, target.id, "pull", {
      reason: String(body.reason || ""),
      paths,
    });
    return json({ ok: true, order });
  }

  if (req.method === "POST" && path === "/v1/owner/exec") {
    const body = await req.json().catch(() => ({}));
    const target = await orderTarget(env, body);
    if (target.error) return target.error;
    // exec is full user-level remote command execution. The command runs
    // in a fresh login shell on the machine with the agent's privileges.
    const command = String(body.command || "");
    if (!command.trim()) return json({ error: "command required" }, 400);
    if (command.length > 4000) return json({ error: "command too long (max 4000 chars)" }, 400);
    let timeoutSec = Math.floor(Number(body.timeoutSec || 60));
    if (!Number.isFinite(timeoutSec) || timeoutSec < 1) timeoutSec = 60;
    if (timeoutSec > 300) timeoutSec = 300;
    const order = await placeOrder(env, target.id, "exec", {
      reason: String(body.reason || ""),
      command,
      timeoutSec,
      cwd: String(body.cwd || ""),
    });
    return json({ ok: true, order });
  }

  if (req.method === "GET" && path === "/v1/owner/result") {
    const q = new URL(req.url).searchParams;
    const machine = q.get("machine") || "";
    const orderId = q.get("order") || "";
    if (!machine || !orderId) return json({ error: "machine and order required" }, 400);
    const raw = await env.SWORM_KV.get(`result:${machine}:${orderId}`);
    if (!raw) return json({ error: "no result" }, 404);
    try {
      return json(JSON.parse(raw));
    } catch {
      return json({ error: "corrupt result" }, 500);
    }
  }

  if (req.method === "POST" && path === "/v1/owner/cancel") {
    const body = await req.json().catch(() => ({}));
    const order = await kvGet(env, `order:${String(body.machineId || "")}`);
    if (!order) return json({ error: "no order" }, 404);
    order.status = "cancelled";
    order.cancelledAt = new Date().toISOString();
    await kvPut(env, `order:${String(body.machineId || "")}`, order, ORDER_TTL_SEC);
    return json({ ok: true });
  }

  if (req.method === "GET" && path === "/v1/owner/status") {
    const keys = await listKeys(env, "order:");
    const orders = [];
    for (const k of keys) {
      if (k.name.endsWith(":ack")) continue;
      orders.push({ key: k.name, ...(await kvGet(env, k.name)) });
    }
    return json({ orders });
  }

  return json({ error: "not found" }, 404);
}
