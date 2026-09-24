#!/usr/bin/env node
"use strict";

/*
 * swormctl: the command line for your sworm fleet.
 *
 * Config lives at ~/.swormrc (json):
 *   { "workerUrl": "https://YOUR_WORKER_URL", "ownerToken": "..." }
 *
 * The env vars SWORM_WORKER_URL and SWORM_OWNER_TOKEN override the file.
 * Requires node 18 or newer (uses the built-in fetch).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const CONFIG_FILE = path.join(os.homedir(), ".swormrc");

function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {}
  const workerUrl = (process.env.SWORM_WORKER_URL || file.workerUrl || "").replace(/\/+$/, "");
  const ownerToken = process.env.SWORM_OWNER_TOKEN || file.ownerToken || "";
  if (!workerUrl || !ownerToken) {
    console.error("missing config. write " + CONFIG_FILE + " like this:");
    console.error('{ "workerUrl": "https://YOUR_WORKER_URL", "ownerToken": "..." }');
    process.exit(1);
  }
  return { workerUrl, ownerToken };
}

async function owner(pathname, { method = "GET", body } = {}) {
  const c = loadConfig();
  const res = await fetch(c.workerUrl + pathname, {
    method,
    headers: {
      authorization: "Bearer " + c.ownerToken,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(data.error || res.status, data.hint || "", data.hostname ? "hostname: " + data.hostname : "");
    process.exit(1);
  }
  return data;
}

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
    if (out[key] === undefined) out[key] = val;
    else if (Array.isArray(out[key])) out[key].push(val);
    else out[key] = [out[key], val];
  }
  return out;
}

function asList(v) {
  if (v === undefined || v === true) return [];
  return Array.isArray(v) ? v : [v];
}

function fmtUptime(sec) {
  if (!sec) return "-";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function fmtSize(n) {
  if (n === undefined || n === null || isNaN(n)) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  return (n / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

async function fetchResult(machine, orderId) {
  const c = loadConfig();
  const url =
    c.workerUrl +
    "/v1/owner/result?machine=" +
    encodeURIComponent(machine) +
    "&order=" +
    encodeURIComponent(orderId);
  const res = await fetch(url, { headers: { authorization: "Bearer " + c.ownerToken } });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(data.error || res.status);
    process.exit(1);
  }
  return data;
}

// Poll for a result until it shows up or the deadline passes.
async function waitResult(machine, orderId, maxMs) {
  const deadline = Date.now() + (maxMs || 90_000);
  process.stdout.write("waiting for result");
  while (Date.now() < deadline) {
    const r = await fetchResult(machine, orderId);
    if (r) {
      process.stdout.write("\n");
      return r;
    }
    process.stdout.write(".");
    await new Promise((res) => setTimeout(res, 5000));
  }
  process.stdout.write("\n");
  return null;
}

function printTree(result) {
  if (result.error) console.log("agent reported:", result.error);
  const entries = Array.isArray(result.entries) ? result.entries : [];
  console.log(
    (result.root || "") +
      `  (${entries.length} entries${result.truncated ? ", truncated at cap" : ""})`
  );
  for (const e of entries) {
    const parts = String(e.path || "").split("/");
    const indent = "  ".repeat(parts.length - 1);
    const name = parts[parts.length - 1];
    if (e.type === "d") {
      console.log(`${indent}${name}/`);
    } else {
      console.log(`${indent}${name}  ${fmtSize(e.size)}`);
    }
  }
}

function writePull(result, outDir) {
  let written = 0;
  for (const f of result.files || []) {
    const rel = String(f.path || "").replace(/\\/g, "/");
    const parts = rel.split("/").filter((s) => s && s !== "." && s !== "..");
    if (!parts.length) continue;
    const dest = path.join(outDir, ...parts);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(String(f.contentB64 || ""), "base64"));
      written++;
    } catch (e) {
      console.error("write failed:", rel, e.message);
    }
  }
  const skipped = Array.isArray(result.skipped) ? result.skipped : [];
  console.log(`${written} files written to ${outDir}`);
  if (skipped.length) {
    console.log(`${skipped.length} skipped:`);
    for (const s of skipped) console.log(`  ${s.path}  (${s.reason})`);
  }
}

// Print an exec result the way a terminal would: stdout on stdout,
// stderr on stderr, then the exit code.
function printExec(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.timedOut) console.error("[timed out]");
  console.error(`[exit ${result.exitCode}]`);
}

// Split a --file spec of the form <local>:<remote>. Windows paths carry
// their own colons, so split at the first colon where the local part
// actually exists on disk.
function splitFileSpec(spec) {
  for (let i = 1; i < spec.length - 1; i++) {
    if (spec[i] !== ":") continue;
    const local = spec.slice(0, i);
    if (fs.existsSync(path.resolve(local))) {
      return { local, remote: spec.slice(i + 1) };
    }
  }
  return null;
}

// Print the machine detail before any order goes out, so the operator
// sees exactly what they are about to touch.
async function showMachineFirst(id) {
  const detail = await owner("/v1/owner/machines/" + id);
  console.log(JSON.stringify(detail, null, 2));
}

function requireConfirm(args) {
  if (!args.machine || !args["confirm-hostname"]) {
    console.error('needs --machine <id> and --confirm-hostname "<hostname>"');
    process.exit(1);
  }
}

function help() {
  console.log(`swormctl: command line for your sworm fleet

setup:
  write ~/.swormrc with your worker url and owner token:
  { "workerUrl": "https://YOUR_WORKER_URL", "ownerToken": "..." }

commands:
  swormctl list                       list enrolled machines
  swormctl show <machineId>           full detail for one machine
  swormctl status                     every order and its state
  swormctl wipe   --machine <id> --confirm-hostname <h> [--folders a,b] [--keep-agent] [--reason t]
  swormctl delete --machine <id> --path <p> [--path ...] --confirm-hostname <h>
  swormctl push   --machine <id> --file <local>:<remote> [--file ...] --confirm-hostname <h>
  swormctl tree   --machine <id> --path <dir> [--depth N] --confirm-hostname <h>
  swormctl pull   --machine <id> --path <p> [--path ...] [--out <dir>] --confirm-hostname <h>
  swormctl exec   --machine <id> --confirm-hostname <h> [--timeout N] [--cwd <dir>] -- <command>
  swormctl shell  --machine <id> --confirm-hostname <h>
  swormctl result --machine <id> --order <orderId> [--out <dir>]
  swormctl cancel --machine <id>

notes:
  exec runs each command in a fresh login shell on the machine. state
  like cd does not persist between commands; chain with && instead.
  shell is an interactive loop over exec. type exit to quit.`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    help();
    return;
  }

  if (cmd === "list") {
    const { machines } = await owner("/v1/owner/machines");
    if (!machines.length) {
      console.log("(no machines yet)");
      return;
    }
    for (const m of machines) {
      const loc = [m.city, m.country].filter(Boolean).join(" ");
      console.log(
        [
          m.machineId,
          m.hostname || "-",
          m.os || "-",
          m.user || "-",
          loc || "-",
          "up " + fmtUptime(m.uptimeSec),
          m.lastSeen || "-",
          m.order || "none",
        ].join("  ")
      );
    }
    return;
  }

  if (cmd === "show") {
    const id = rest[0];
    if (!id) {
      console.error("swormctl show <machineId>");
      process.exit(1);
    }
    console.log(JSON.stringify(await owner("/v1/owner/machines/" + id), null, 2));
    return;
  }

  if (cmd === "status") {
    console.log(JSON.stringify(await owner("/v1/owner/status"), null, 2));
    return;
  }

  if (cmd === "wipe") {
    const args = parseFlags(rest);
    requireConfirm(args);
    await showMachineFirst(args.machine);
    const body = {
      machineId: args.machine,
      confirmHostname: args["confirm-hostname"],
      reason: args.reason || "",
      removeAgent: !args["keep-agent"],
    };
    if (args.folders) {
      body.folders = String(args.folders).split(",").map((s) => s.trim()).filter(Boolean);
    }
    const out = await owner("/v1/owner/wipe", { method: "POST", body });
    console.log("ordered", out.order);
    return;
  }

  if (cmd === "delete") {
    const args = parseFlags(rest);
    const paths = asList(args.path);
    requireConfirm(args);
    if (!paths.length) {
      console.error("needs at least one --path");
      process.exit(1);
    }
    await showMachineFirst(args.machine);
    const out = await owner("/v1/owner/delete", {
      method: "POST",
      body: {
        machineId: args.machine,
        confirmHostname: args["confirm-hostname"],
        reason: args.reason || "",
        paths,
      },
    });
    console.log("ordered", out.order);
    return;
  }

  if (cmd === "push") {
    const args = parseFlags(rest);
    const specs = asList(args.file);
    requireConfirm(args);
    if (!specs.length) {
      console.error("needs at least one --file <local>:<remote>");
      process.exit(1);
    }
    if (specs.length > 10) {
      console.error("max 10 files per push");
      process.exit(1);
    }
    const files = [];
    for (const spec of specs) {
      const split = splitFileSpec(String(spec));
      if (!split || !split.remote) {
        console.error("bad --file, expected <local>:<remote>:", spec);
        process.exit(1);
      }
      const abs = path.resolve(split.local);
      if (!fs.statSync(abs).isFile()) {
        console.error("local file missing:", split.local);
        process.exit(1);
      }
      const buf = fs.readFileSync(abs);
      if (buf.length > 256 * 1024) {
        console.error("file too large (max 256KB):", split.local);
        process.exit(1);
      }
      files.push({ path: split.remote, contentB64: buf.toString("base64") });
    }
    await showMachineFirst(args.machine);
    const out = await owner("/v1/owner/push", {
      method: "POST",
      body: {
        machineId: args.machine,
        confirmHostname: args["confirm-hostname"],
        reason: args.reason || "",
        files,
      },
    });
    console.log("ordered", out.order);
    return;
  }

  if (cmd === "tree") {
    const args = parseFlags(rest);
    requireConfirm(args);
    if (!args.path) {
      console.error("needs --path <dir>");
      process.exit(1);
    }
    await showMachineFirst(args.machine);
    const out = await owner("/v1/owner/tree", {
      method: "POST",
      body: {
        machineId: args.machine,
        confirmHostname: args["confirm-hostname"],
        reason: args.reason || "",
        path: String(args.path),
        depth: args.depth !== undefined ? Number(args.depth) : undefined,
      },
    });
    console.log("ordered", out.order);
    const result = await waitResult(args.machine, out.order.orderId);
    if (!result) {
      console.log("no result yet. the machine may be offline.");
      console.log(`check later: swormctl result --machine ${args.machine} --order ${out.order.orderId}`);
      return;
    }
    printTree(result);
    return;
  }

  if (cmd === "pull") {
    const args = parseFlags(rest);
    const paths = asList(args.path);
    requireConfirm(args);
    if (!paths.length) {
      console.error("needs at least one --path");
      process.exit(1);
    }
    await showMachineFirst(args.machine);
    const out = await owner("/v1/owner/pull", {
      method: "POST",
      body: {
        machineId: args.machine,
        confirmHostname: args["confirm-hostname"],
        reason: args.reason || "",
        paths,
      },
    });
    console.log("ordered", out.order);
    const outDir = args.out || `pull-${args.machine}-${out.order.orderId}`;
    const result = await waitResult(args.machine, out.order.orderId);
    if (!result) {
      console.log("no result yet. the machine may be offline.");
      console.log(
        `check later: swormctl result --machine ${args.machine} --order ${out.order.orderId} --out ${outDir}`
      );
      return;
    }
    writePull(result, outDir);
    return;
  }

  if (cmd === "exec") {
    // Everything after a literal "--" is the command, joined with spaces.
    const sep = rest.indexOf("--");
    const flagArgs = sep >= 0 ? rest.slice(0, sep) : rest;
    const command = sep >= 0 ? rest.slice(sep + 1).join(" ") : "";
    const args = parseFlags(flagArgs);
    requireConfirm(args);
    if (!command.trim()) {
      console.error('needs a command after --, for example:');
      console.error('swormctl exec --machine <id> --confirm-hostname <h> -- "ls -la ~/Documents"');
      process.exit(1);
    }
    const timeoutSec = args.timeout !== undefined ? Number(args.timeout) : 60;
    await showMachineFirst(args.machine);
    const out = await owner("/v1/owner/exec", {
      method: "POST",
      body: {
        machineId: args.machine,
        confirmHostname: args["confirm-hostname"],
        reason: args.reason || "",
        command,
        timeoutSec,
        cwd: args.cwd ? String(args.cwd) : "",
      },
    });
    console.log("ordered", out.order);
    // Give the machine the command timeout plus polling margin.
    const result = await waitResult(args.machine, out.order.orderId, (Math.min(timeoutSec, 300) + 120) * 1000);
    if (!result) {
      console.log("no result yet. the machine may be offline.");
      console.log(`check later: swormctl result --machine ${args.machine} --order ${out.order.orderId}`);
      return;
    }
    printExec(result);
    return;
  }

  if (cmd === "shell") {
    const args = parseFlags(rest);
    requireConfirm(args);
    const detail = await owner("/v1/owner/machines/" + args.machine);
    const hostname = (detail.profile && detail.profile.hostname) || args.machine;
    console.log(`sworm shell connected to ${hostname} (${args.machine})`);
    console.log("each line runs in a fresh shell; chain with && when you need state. type exit to quit.");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = () => {
      rl.question(`${hostname}> `, async (line) => {
        const command = line.trim();
        if (!command) return ask();
        if (command === "exit" || command === "quit") {
          rl.close();
          return;
        }
        try {
          const out = await owner("/v1/owner/exec", {
            method: "POST",
            body: {
              machineId: args.machine,
              confirmHostname: args["confirm-hostname"],
              command,
              timeoutSec: 60,
              cwd: "",
            },
          });
          const result = await waitResult(args.machine, out.order.orderId, 180_000);
          if (!result) {
            console.log("no result. the machine may be offline.");
            console.log(`check later: swormctl result --machine ${args.machine} --order ${out.order.orderId}`);
          } else {
            printExec(result);
          }
        } catch (e) {
          console.error("error:", e && e.message ? e.message : e);
        }
        ask();
      });
    };
    ask();
    return;
  }

  if (cmd === "result") {
    const args = parseFlags(rest);
    if (!args.machine || !args.order) {
      console.error("swormctl result --machine <id> --order <orderId> [--out <dir>]");
      process.exit(1);
    }
    const result = await fetchResult(args.machine, args.order);
    if (!result) {
      console.log("no result stored for that order (expired or never uploaded)");
      process.exit(1);
    }
    if (result.kind === "tree") {
      printTree(result);
    } else if (result.kind === "pull") {
      const outDir = args.out || `pull-${args.machine}-${args.order}`;
      writePull(result, outDir);
    } else if (result.kind === "exec") {
      printExec(result);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    return;
  }

  if (cmd === "cancel") {
    const i = rest.indexOf("--machine");
    const id = i >= 0 ? rest[i + 1] : rest[0];
    if (!id) {
      console.error("swormctl cancel --machine <id>");
      process.exit(1);
    }
    console.log(await owner("/v1/owner/cancel", { method: "POST", body: { machineId: id } }));
    return;
  }

  console.error("unknown command:", cmd);
  help();
  process.exit(1);
}

main().catch((e) => {
  console.error("error:", e && e.message ? e.message : e);
  process.exit(1);
});
