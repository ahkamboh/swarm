#!/usr/bin/env node
"use strict";

/*
 * sworm agent
 *
 * A small, readable agent that connects one machine to your sworm worker.
 * There is no obfuscation here on purpose. Read it before you run it.
 *
 * What it does:
 *   - enrolls this machine with your worker (once)
 *   - polls about once a minute for signed orders
 *   - verifies every order's HMAC signature, expiry, and nonce
 *   - runs the order: wipe, delete, push, tree, pull, or exec
 *   - reports the outcome back to the worker
 *
 * Where it lives:
 *   state dir:   ~/.sworm (visible, plain name)
 *   persistence: LaunchAgent com.sworm.agent (macOS),
 *                scheduled task SwormAgent (windows),
 *                one cron @reboot line tagged "# sworm-agent" (linux)
 *
 * Flags:
 *   node agent.js --once        enroll if needed, poll once, exit
 *   node agent.js --no-persist  run without installing persistence
 *   node agent.js --uninstall   remove persistence and the state dir, exit
 *   node agent.js --help        show usage
 *
 * The agent does not run on CI, build runners, SSH sessions, or headless
 * linux machines. That is a feature: ephemeral machines should not enroll.
 * Set SWORM_RUN_ANYWHERE=1 to override (for example on a real server).
 *
 * Config comes from environment variables or ~/.sworm/config.json:
 *   SWORM_WORKER_URL       workerUrl
 *   SWORM_BOOTSTRAP_TOKEN  bootstrapToken
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync, execSync } = require("child_process");

const VERSION = "1.0.0";
const HOME = os.homedir();
const IS_WIN = process.platform === "win32";
const STATE_DIR = path.join(HOME, ".sworm");
const CONFIG_FILE = path.join(STATE_DIR, "config.json");
const MACHINE_FILE = path.join(STATE_DIR, "machine.json");
const LOCK_FILE = path.join(STATE_DIR, "agent.lock");
const PLIST_LABEL = "com.sworm.agent";
const TASK_NAME = "SwormAgent";
const CRON_TAG = "# sworm-agent";

const POLL_MS = Number(process.env.SWORM_POLL_MS) || 60_000;
const ENVELOPE_SKEW_SEC = 300; // tolerate clock skew on iat
const EXEC_OUTPUT_CAP = 512 * 1024; // combined stdout + stderr cap
const EXEC_TIMEOUT_DEFAULT = 60;
const EXEC_TIMEOUT_MAX = 300;
const PUSH_MAX_FILE = 256 * 1024;
const TREE_ENTRY_CAP = 5000;
const PULL_MAX_FILE = 5 * 1024 * 1024;
const PULL_MAX_TOTAL_B64 = 20 * 1024 * 1024;
const PULL_MAX_FILES = 50;
const PULL_WALK_DEPTH = 6;

// Roots a wipe searches when the order names none. Each entry is
// relative to the machine's home directory.
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

// Never walked during tree or pull unless explicitly requested inside.
const TREE_SKIP_NAMES = new Set(["node_modules", ".git", ".svn", ".hg"]);

function log(msg) {
  const line = `[sworm] ${msg}`;
  try {
    process.stdout.write(line + "\n");
  } catch {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

function resolved(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.normalize(p);
  }
}

// Resolve an order path: "~" expands to home, relative paths resolve
// against home, absolute paths pass through.
function resolveTarget(p) {
  let t = String(p || "").trim();
  if (!t) return "";
  if (t === "~" || t.startsWith("~/") || t.startsWith("~\\")) {
    t = path.join(HOME, t.slice(1));
  }
  if (!path.isAbsolute(t)) t = path.join(HOME, t);
  return path.normalize(t);
}

// Paths the agent refuses to delete, overwrite, or use as a working
// directory: filesystem roots and the home directory itself.
function isForbiddenTarget(target) {
  if (!target || typeof target !== "string") return true;
  const n = path.normalize(target);
  const real = resolved(n);
  const home = resolved(HOME);
  if (n === "/" || real === "/" || n === "\\" || real === "\\") return true;
  if (IS_WIN) {
    if (/^[a-zA-Z]:\\?$/.test(n) || /^[a-zA-Z]:\\?$/.test(real)) return true;
  }
  if (real === home || n === home || n === "~" || n === HOME) return true;
  return false;
}

// Roots are refused as a working directory too, but home is fine: it is
// the default cwd for exec orders.
function isForbiddenCwd(target) {
  if (!target || typeof target !== "string") return true;
  const n = path.normalize(target);
  const real = resolved(n);
  if (n === "/" || real === "/" || n === "\\" || real === "\\") return true;
  if (IS_WIN && (/^[a-zA-Z]:\\?$/.test(n) || /^[a-zA-Z]:\\?$/.test(real))) return true;
  return false;
}

function loadConfig() {
  const fromFile = readJson(CONFIG_FILE) || {};
  return {
    workerUrl: String(process.env.SWORM_WORKER_URL || fromFile.workerUrl || "").replace(/\/+$/, ""),
    bootstrapToken: String(process.env.SWORM_BOOTSTRAP_TOKEN || fromFile.bootstrapToken || ""),
  };
}

async function api(cfg, pathname, { method = "POST", token, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = "Bearer " + token;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let res;
  try {
    res = await fetch(cfg.workerUrl + pathname, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

// Machine facts sent at enroll time. Deliberately boring: hostname, os,
// hardware, user. No browser data, no keychain, no documents.
function collect() {
  const cpus = os.cpus() || [];
  return {
    hostname: os.hostname(),
    os: process.platform === "darwin" ? "darwin" : IS_WIN ? "windows" : process.platform,
    osVersion: os.release(),
    arch: os.arch(),
    cpu: cpus[0] ? cpus[0].model : "",
    cores: cpus.length,
    ram: Math.round(os.totalmem() / (1024 * 1024 * 1024)) + " GB",
    user: os.userInfo().username,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    node: process.version,
    shell: process.env.SHELL || process.env.ComSpec || "",
    uptimeSec: Math.round(os.uptime()),
  };
}

// Verify the signed order envelope. This rebuilds the exact string the
// worker signed; change both sides together.
function verifyEnvelope(env, hmacKey) {
  const p = env && env.payload;
  const mac = env && env.sig && env.sig.mac;
  if (!p || !mac || !hmacKey) return false;
  const now = Math.floor(Date.now() / 1000);
  if (p.exp < now - 5 || p.iat > now + ENVELOPE_SKEW_SEC) return false;
  const foldersHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        folders: p.folders || [],
        searchRoots: p.searchRoots || [],
        removeAgent: !!p.removeAgent,
      })
    )
    .digest("hex");
  const parts = [
    "v1",
    String(p.iat),
    String(p.exp),
    p.machineId,
    p.wipe ? "true" : "false",
    p.orderId || "",
    String(p.orderVersion || 0),
    p.nonce,
    foldersHash,
  ];
  if (p.action) {
    const actionData = {
      action: p.action,
      paths: p.paths || [],
      files: p.files || [],
    };
    if (p.action === "tree") {
      actionData.path = p.path || "";
      actionData.depth = p.depth || 0;
    }
    if (p.action === "exec") {
      actionData.command = p.command || "";
      actionData.timeoutSec = p.timeoutSec || 0;
      actionData.cwd = p.cwd || "";
    }
    parts.push(crypto.createHash("sha256").update(JSON.stringify(actionData)).digest("hex"));
  }
  const expect = crypto.createHmac("sha256", hmacKey).update(parts.join("|")).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expect, "hex"), Buffer.from(mac, "hex"));
  } catch {
    return false;
  }
}

async function enrollIfNeeded(cfg) {
  const st = readJson(MACHINE_FILE);
  if (st && st.machineId && st.agentToken && st.hmacKey) return st;
  if (!cfg.workerUrl || !cfg.bootstrapToken) return "unconfigured";
  const info = collect();
  let r;
  try {
    r = await api(cfg, "/v1/enroll", { token: cfg.bootstrapToken, body: info });
  } catch {
    return null; // network down, try again next tick
  }
  if (!r.ok || !r.data.machineId) {
    log("enroll failed" + (r.data && r.data.error ? ": " + r.data.error : ""));
    return null;
  }
  const next = {
    machineId: r.data.machineId,
    agentToken: r.data.agentToken,
    hmacKey: r.data.hmacKey || "",
  };
  writeJson(MACHINE_FILE, next);
  log(`enrolled as ${next.machineId}`);
  return next;
}

// --- order handlers ---------------------------------------------------

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
}

function deletePath(target) {
  if (isForbiddenTarget(target)) return { ok: false, path: target, refused: true };
  if (!fs.existsSync(target)) return { ok: false, path: target, notFound: true };
  try {
    rmrf(target);
    return { ok: !fs.existsSync(target), path: target };
  } catch {
    return { ok: false, path: target };
  }
}

// Find wipe targets: directories (or zip/tgz archives) whose name matches
// one of the ordered folder names, directly under a search root.
function findMatches(folders, roots) {
  const found = new Set();
  const names = folders.map((n) => String(n).toLowerCase());
  const seenRoots = new Set();
  for (const root of roots) {
    const abs = path.join(HOME, root);
    if (!abs.startsWith(HOME)) continue;
    const realRoot = resolved(abs);
    if (seenRoots.has(realRoot)) continue;
    seenRoots.add(realRoot);
    let entries = [];
    try {
      entries = fs.readdirSync(realRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const lower = e.name.toLowerCase();
      const isArchive = lower.endsWith(".zip") || lower.endsWith(".tgz");
      const base = isArchive ? lower.replace(/\.(zip|tgz)$/, "") : lower;
      if (names.includes(base)) found.add(path.join(realRoot, e.name));
    }
  }
  return [...found];
}

async function runWipe(st, cfg, payload) {
  const folders = Array.isArray(payload.folders) ? payload.folders : [];
  const roots =
    Array.isArray(payload.searchRoots) && payload.searchRoots.length
      ? payload.searchRoots
      : DEFAULT_SEARCH_ROOTS;
  const targets = findMatches(folders, roots);
  const pathsRemoved = [];
  const pathsFailed = [];
  const pathsNotFound = [];
  if (!targets.length) pathsNotFound.push("(none)");
  for (const t of targets) {
    const res = deletePath(t);
    (res.ok ? pathsRemoved : pathsFailed).push(t);
  }
  await sendAck(cfg, st, payload.orderId, { pathsRemoved, pathsFailed, pathsNotFound });
  log(`wipe ${payload.orderId}: ${pathsRemoved.length} removed, ${pathsFailed.length} failed`);
  // A wipe usually means offboarding. Unless the order says otherwise,
  // the agent removes itself once the wipe is clean.
  if (payload.removeAgent && pathsFailed.length === 0) {
    log("wipe complete, removing the agent as ordered");
    uninstall();
    process.exit(0);
  }
}

async function runDelete(st, cfg, payload) {
  const pathsRemoved = [];
  const pathsFailed = [];
  const pathsNotFound = [];
  const list = Array.isArray(payload.paths) ? payload.paths : [];
  for (const raw of list) {
    const res = deletePath(resolveTarget(raw));
    if (res.notFound) pathsNotFound.push(raw);
    else if (res.ok) pathsRemoved.push(raw);
    else pathsFailed.push(raw);
  }
  await sendAck(cfg, st, payload.orderId, { pathsRemoved, pathsFailed, pathsNotFound });
  log(`delete ${payload.orderId}: ${pathsRemoved.length} removed, ${pathsFailed.length} failed`);
}

async function runPush(st, cfg, payload) {
  const pathsRemoved = []; // written paths, name kept for ack shape
  const pathsFailed = [];
  const list = Array.isArray(payload.files) ? payload.files : [];
  for (const f of list.slice(0, 10)) {
    const dest = resolveTarget(f && f.path);
    const b64 = String((f && f.contentB64) || "");
    if (!dest || !b64 || isForbiddenTarget(dest)) {
      pathsFailed.push(String((f && f.path) || "(empty)"));
      continue;
    }
    try {
      const buf = Buffer.from(b64, "base64");
      if (buf.length > PUSH_MAX_FILE) {
        pathsFailed.push(dest);
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf, { mode: 0o644 });
      pathsRemoved.push(dest);
    } catch {
      pathsFailed.push(dest);
    }
  }
  await sendAck(cfg, st, payload.orderId, { pathsRemoved, pathsFailed, pathsNotFound: [] });
  log(`push ${payload.orderId}: ${pathsRemoved.length} written, ${pathsFailed.length} failed`);
}

function treeSystemSkips(rootReal) {
  const dirs = [];
  if (process.platform === "darwin") dirs.push(path.join(HOME, "Library"));
  if (IS_WIN) {
    if (process.env.APPDATA) dirs.push(process.env.APPDATA);
    if (process.env.LOCALAPPDATA) dirs.push(process.env.LOCALAPPDATA);
  }
  // Skip these heavy system dirs unless the requested root is inside one.
  return dirs
    .map((d) => resolved(d))
    .filter((rd) => !(rootReal === rd || rootReal.startsWith(rd + path.sep)));
}

function walkTree(root, depth) {
  const entries = [];
  const rootReal = resolved(root);
  const skips = treeSystemSkips(rootReal);
  let truncated = false;
  const walk = (dir, rel, d) => {
    if (entries.length >= TREE_ENTRY_CAP) {
      truncated = true;
      return;
    }
    let list;
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of list) {
      if (entries.length >= TREE_ENTRY_CAP) {
        truncated = true;
        return;
      }
      const full = path.join(dir, e.name);
      const relPath = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) {
        if (TREE_SKIP_NAMES.has(e.name)) continue;
        if (skips.some((sd) => full === sd || full.startsWith(sd + path.sep))) continue;
        entries.push({ path: relPath, type: "d" });
        if (d < depth) walk(full, relPath, d + 1);
      } else if (e.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {}
        entries.push({ path: relPath, type: "f", size });
      }
    }
  };
  walk(rootReal, "", 1);
  return { entries, truncated, rootReal };
}

async function runTree(st, cfg, payload) {
  const target = resolveTarget(payload.path);
  let entries = [];
  let truncated = false;
  let root = target;
  let error = "";
  if (!target || isForbiddenTarget(target)) {
    error = "refused";
  } else {
    let stt = null;
    try {
      stt = fs.statSync(target);
    } catch {}
    if (!stt) {
      error = "not found";
    } else if (stt.isDirectory()) {
      const depth = Math.min(Math.max(Number(payload.depth) || 4, 1), 8);
      const out = walkTree(target, depth);
      entries = out.entries;
      truncated = out.truncated;
      root = out.rootReal;
    } else if (stt.isFile()) {
      entries = [{ path: path.basename(target), type: "f", size: stt.size }];
    } else {
      error = "not a file or directory";
    }
  }
  const up = await sendResult(cfg, st, payload.orderId, {
    kind: "tree",
    root,
    entries,
    truncated,
    error,
  });
  await sendAck(cfg, st, payload.orderId, {
    pathsRemoved: [],
    pathsFailed: error ? [error] : up ? [] : ["upload failed"],
    pathsNotFound: [],
  });
  log(`tree ${payload.orderId}: ${entries.length} entries${error ? ", " + error : ""}`);
}

function collectPull(rawPaths) {
  const files = [];
  const skipped = [];
  let totalB64 = 0;

  const addFile = (full, rel) => {
    if (files.length >= PULL_MAX_FILES) {
      skipped.push({ path: rel, reason: "file count cap" });
      return;
    }
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      skipped.push({ path: rel, reason: "stat failed" });
      return;
    }
    if (!st.isFile()) return;
    if (st.size > PULL_MAX_FILE) {
      skipped.push({ path: rel, reason: "over 5MB" });
      return;
    }
    const estB64 = Math.ceil(st.size / 3) * 4;
    if (totalB64 + estB64 > PULL_MAX_TOTAL_B64) {
      skipped.push({ path: rel, reason: "total size cap" });
      return;
    }
    let buf;
    try {
      buf = fs.readFileSync(full);
    } catch {
      skipped.push({ path: rel, reason: "read failed" });
      return;
    }
    totalB64 += estB64;
    files.push({ path: rel, contentB64: buf.toString("base64") });
  };

  const walkDir = (dir, rel, d) => {
    if (d > PULL_WALK_DEPTH || files.length >= PULL_MAX_FILES) return;
    let list;
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      skipped.push({ path: rel, reason: "read failed" });
      return;
    }
    for (const e of list) {
      if (files.length >= PULL_MAX_FILES) return;
      const full = path.join(dir, e.name);
      const relPath = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) {
        if (TREE_SKIP_NAMES.has(e.name)) continue;
        walkDir(full, relPath, d + 1);
      } else if (e.isFile()) {
        addFile(full, relPath);
      }
    }
  };

  for (const raw of rawPaths) {
    const target = resolveTarget(raw);
    if (!target || isForbiddenTarget(target)) {
      skipped.push({ path: String(raw || ""), reason: "refused" });
      continue;
    }
    let st;
    try {
      st = fs.statSync(target);
    } catch {
      skipped.push({ path: String(raw || ""), reason: "not found" });
      continue;
    }
    if (st.isDirectory()) {
      walkDir(target, path.basename(target), 1);
    } else if (st.isFile()) {
      addFile(target, path.basename(target));
    }
    if (files.length >= PULL_MAX_FILES) break;
  }
  return { files, skipped };
}

async function runPull(st, cfg, payload) {
  const list = Array.isArray(payload.paths) ? payload.paths : [];
  const { files, skipped } = collectPull(list);
  const up = await sendResult(cfg, st, payload.orderId, { kind: "pull", files, skipped });
  await sendAck(cfg, st, payload.orderId, {
    pathsRemoved: [],
    pathsFailed: up ? [] : ["upload failed"],
    pathsNotFound: [],
  });
  log(`pull ${payload.orderId}: ${files.length} files, ${skipped.length} skipped`);
}

// Run one command in a fresh login shell and capture everything.
// Privileges are the agent's own: no sudo, no elevation.
function execCommand(command, timeoutSec, cwdRaw) {
  return new Promise((resolve) => {
    let cwd = HOME;
    if (cwdRaw) {
      const t = resolveTarget(cwdRaw);
      if (!t || isForbiddenCwd(t)) {
        return resolve({ stdout: "", stderr: "refused cwd: " + cwdRaw, exitCode: -1, timedOut: false });
      }
      cwd = t;
    }
    let shell, args;
    if (IS_WIN) {
      shell = process.env.ComSpec || "cmd.exe";
      args = ["/d", "/s", "/c", command];
    } else {
      shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
      args = ["-lc", command];
    }
    let child;
    try {
      child = spawn(shell, args, { cwd, windowsHide: true });
    } catch (e) {
      return resolve({ stdout: "", stderr: String(e && e.message || e), exitCode: -1, timedOut: false });
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // Combined cap: stop recording once stdout + stderr hit 512 KB.
    const room = () => EXEC_OUTPUT_CAP - (stdout.length + stderr.length);
    child.stdout.on("data", (d) => {
      const r = room();
      if (r > 0) stdout += d.toString("utf8", 0, Math.min(d.length, r));
    });
    child.stderr.on("data", (d) => {
      const r = room();
      if (r > 0) stderr += d.toString("utf8", 0, Math.min(d.length, r));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      // Give it five seconds to die, then force it.
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 5000);
    }, timeoutSec * 1000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(e && e.message || e), exitCode: -1, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (room() <= 0) stderr += "\n[output truncated at 512KB]";
      resolve({ stdout, stderr, exitCode: typeof code === "number" ? code : -1, timedOut });
    });
  });
}

async function runExec(st, cfg, payload) {
  const command = String(payload.command || "");
  let timeoutSec = Math.floor(Number(payload.timeoutSec) || EXEC_TIMEOUT_DEFAULT);
  if (timeoutSec < 1) timeoutSec = EXEC_TIMEOUT_DEFAULT;
  if (timeoutSec > EXEC_TIMEOUT_MAX) timeoutSec = EXEC_TIMEOUT_MAX;
  const out = await execCommand(command, timeoutSec, payload.cwd);
  const up = await sendResult(cfg, st, payload.orderId, { kind: "exec", ...out });
  await sendAck(cfg, st, payload.orderId, {
    pathsRemoved: [],
    pathsFailed: up ? [] : ["upload failed"],
    pathsNotFound: [],
  });
  log(`exec ${payload.orderId}: exit ${out.exitCode}${out.timedOut ? " (timed out)" : ""}`);
}

// --- reporting --------------------------------------------------------

async function sendAck(cfg, st, orderId, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await api(cfg, "/v1/ack", {
        token: st.agentToken,
        body: { machineId: st.machineId, orderId, ...body },
      });
      if (r && r.ok) return true;
    } catch {}
    await sleep(5000);
  }
  return false;
}

async function sendResult(cfg, st, orderId, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await api(cfg, "/v1/result", {
        token: st.agentToken,
        body: { machineId: st.machineId, orderId, ...body },
      });
      if (r && r.ok) return true;
    } catch {}
    await sleep(5000);
  }
  return false;
}

async function pollOnce(cfg, st) {
  const nonce = crypto.randomBytes(16).toString("hex");
  let r;
  try {
    r = await api(cfg, "/v1/poll", {
      token: st.agentToken,
      body: { machineId: st.machineId, nonce, uptimeSec: Math.round(os.uptime()) },
    });
  } catch {
    return; // network down, try again next tick
  }
  if (!r.ok) {
    log(`poll failed (${r.status})`);
    return;
  }
  if (!verifyEnvelope(r.data, st.hmacKey)) {
    log("poll: envelope failed verification, ignored");
    return;
  }
  const p = r.data.payload;
  if (p.nonce !== nonce) return;
  if (!p.wipe && !p.action) return; // no order waiting
  log(`order ${p.orderId}: ${p.wipe ? "wipe" : p.action}`);
  if (p.wipe) return runWipe(st, cfg, p);
  if (p.action === "delete") return runDelete(st, cfg, p);
  if (p.action === "push") return runPush(st, cfg, p);
  if (p.action === "tree") return runTree(st, cfg, p);
  if (p.action === "pull") return runPull(st, cfg, p);
  if (p.action === "exec") return runExec(st, cfg, p);
}

// --- persistence ------------------------------------------------------
// Everything below uses clear names and standard OS mechanisms. The
// uninstaller removes every trace.

function plistPath() {
  return path.join(HOME, "Library", "LaunchAgents", PLIST_LABEL + ".plist");
}

function persist() {
  const self = path.resolve(process.argv[1]);
  const node = process.execPath;
  if (IS_WIN) {
    // Scheduled task named SwormAgent, runs at logon as the current user.
    spawnSync(
      "schtasks.exe",
      ["/Create", "/TN", TASK_NAME, "/TR", `"${node}" "${self}"`, "/SC", "ONLOGON", "/RL", "LIMITED", "/F"],
      { stdio: "ignore", windowsHide: true }
    );
    return;
  }
  if (process.platform === "darwin") {
    try {
      const dir = path.join(HOME, "Library", "LaunchAgents");
      fs.mkdirSync(dir, { recursive: true });
      const plist = plistPath();
      fs.writeFileSync(
        plist,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
<key>Label</key><string>${PLIST_LABEL}</string>
<key>ProgramArguments</key><array><string>${node}</string><string>${self}</string></array>
<key>RunAtLoad</key><true/>
</dict>
</plist>
`
      );
      const uid = typeof process.getuid === "function" ? process.getuid() : 0;
      spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plist], { stdio: "ignore" });
      spawnSync("launchctl", ["load", plist], { stdio: "ignore" });
    } catch {}
    return;
  }
  // linux and others: one cron @reboot line, tagged so uninstall finds it.
  try {
    let cur = "";
    try {
      cur = execSync("crontab -l", { encoding: "utf8" });
    } catch {
      cur = "";
    }
    if (cur.includes(self)) return;
    const line = `@reboot "${node}" "${self}" ${CRON_TAG}`;
    const f = path.join(STATE_DIR, "crontab.txt");
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(f, (cur.trim() ? cur.trim() + "\n" : "") + line + "\n");
    execSync(`crontab "${f}"`, { stdio: "ignore" });
  } catch {}
}

function unpersist() {
  if (IS_WIN) {
    try {
      spawnSync("schtasks.exe", ["/Delete", "/TN", TASK_NAME, "/F"], { stdio: "ignore", windowsHide: true });
    } catch {}
    return;
  }
  if (process.platform === "darwin") {
    try {
      const plist = plistPath();
      const uid = typeof process.getuid === "function" ? process.getuid() : 0;
      spawnSync("launchctl", ["bootout", `gui/${uid}/${PLIST_LABEL}`], { stdio: "ignore" });
      spawnSync("launchctl", ["unload", plist], { stdio: "ignore" });
      fs.unlinkSync(plist);
    } catch {}
    return;
  }
  try {
    const cur = execSync("crontab -l", { encoding: "utf8" });
    const next = cur
      .split("\n")
      .filter((l) => !l.includes(CRON_TAG) && !l.includes(STATE_DIR))
      .join("\n");
    execSync(`printf %s ${JSON.stringify(next)} | crontab -`, { stdio: "ignore" });
  } catch {}
}

// Remove persistence and the state dir. Safe to run when nothing exists:
// every step ignores missing files and the command always exits 0.
function uninstall() {
  log("removing persistence");
  try {
    unpersist();
  } catch {}
  log("removing " + STATE_DIR);
  try {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
  } catch {}
  log("sworm agent uninstalled");
}

// --- environment guards ------------------------------------------------

// CI providers, build runners, SSH sessions, cloud dev environments, and
// headless linux boxes. The agent does not run on these. That is a
// feature: ephemeral machines should not enroll in the fleet.
function remoteHost() {
  const e = process.env;
  if (
    e.CI || e.VERCEL || e.VERCEL_ENV || e.NETLIFY || e.GITHUB_ACTIONS ||
    e.GITLAB_CI || e.CIRCLECI || e.TRAVIS || e.BUILDKITE || e.JENKINS_URL ||
    e.TF_BUILD || e.CF_PAGES || e.DIGITALOCEAN_APP_ID || e.RENDER ||
    e.RAILWAY_ENVIRONMENT || e.FLY_APP_NAME || e.HEROKU_APP_NAME || e.DYNO ||
    e.CODEBUILD_BUILD_ID || e.GOOGLE_CLOUD_BUILD
  ) return true;
  if (e.SSH_CONNECTION || e.SSH_TTY || e.SSH_CLIENT) return true;
  if (e.CODESPACES || e.GITPOD_WORKSPACE_ID || e.REPL_ID) return true;
  if (process.platform === "linux" && !e.DISPLAY && !e.WAYLAND_DISPLAY) return true;
  return false;
}

// --- single instance lock ----------------------------------------------

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === "EPERM");
  }
}

async function takeLock() {
  for (let i = 0; i < 20; i++) {
    let holder = 0;
    let mtime = 0;
    try {
      mtime = fs.statSync(LOCK_FILE).mtimeMs;
      holder = Number(fs.readFileSync(LOCK_FILE, "utf8"));
    } catch {}
    const stale = mtime > 0 && Date.now() - mtime > 180_000;
    if (!holder || holder === process.pid || !pidAlive(holder) || stale) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(LOCK_FILE, String(process.pid));
      return true;
    }
    await sleep(30_000);
  }
  return false;
}

function heartbeat() {
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch {}
}

// --- main ----------------------------------------------------------------

function usage() {
  console.log(`sworm agent ${VERSION}

usage:
  node agent.js              run the agent (installs persistence on first run)
  node agent.js --once       enroll if needed, poll once, exit
  node agent.js --no-persist run in the foreground without persistence
  node agent.js --uninstall  remove persistence and the state dir, exit
  node agent.js --help       show this text

config:
  ~/.sworm/config.json or env vars SWORM_WORKER_URL and SWORM_BOOTSTRAP_TOKEN

notes:
  the agent does not run on CI, build runners, SSH sessions, or headless
  linux. set SWORM_RUN_ANYWHERE=1 to override.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  if (args.includes("--version")) {
    console.log(VERSION);
    return;
  }
  if (args.includes("--uninstall")) {
    uninstall();
    return;
  }
  if (remoteHost() && !process.env.SWORM_RUN_ANYWHERE) {
    log("CI, SSH, or headless environment detected; the agent does not run here.");
    log("set SWORM_RUN_ANYWHERE=1 to override.");
    return;
  }
  const cfg = loadConfig();
  if (args.includes("--once")) {
    const st = await enrollIfNeeded(cfg);
    if (st === "unconfigured") {
      log("no worker configured. write ~/.sworm/config.json or set SWORM_WORKER_URL and SWORM_BOOTSTRAP_TOKEN.");
      return;
    }
    if (st) await pollOnce(cfg, st);
    return;
  }
  if (!(await takeLock())) return;
  if (!process.env.SWORM_NO_PERSIST && !args.includes("--no-persist")) persist();
  log(`sworm agent ${VERSION} running, polling about every ${Math.round(POLL_MS / 1000)}s`);
  const tick = async () => {
    try {
      heartbeat();
      const st = await enrollIfNeeded(cfg);
      if (st === "unconfigured") {
        log("no worker configured, exiting. write ~/.sworm/config.json or set SWORM_WORKER_URL and SWORM_BOOTSTRAP_TOKEN.");
        process.exit(0);
      }
      if (st) await pollOnce(cfg, st);
    } catch (e) {
      log("error: " + (e && e.message ? e.message : e));
    }
    setTimeout(tick, POLL_MS + Math.floor(Math.random() * 15_000));
  };
  tick();
}

main();
