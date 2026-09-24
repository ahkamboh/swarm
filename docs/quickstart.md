# Quickstart

From zero to a managed machine in about five minutes.

## What you need

- A cloudflare account (the free plan is enough)
- node 18 or newer on your machine and on each machine you manage
- wrangler: `npm install -g wrangler`, then `npx wrangler login`

## 1. Deploy the worker

```bash
cd worker
npx wrangler kv namespace create SWORM_KV
```

Copy the printed id into `wrangler.toml`, replacing `YOUR_KV_NAMESPACE_ID`.

Set the three secrets. Generate each with `openssl rand -hex 32`:

```bash
npx wrangler secret put OWNER_TOKEN
npx wrangler secret put BOOTSTRAP_TOKEN
npx wrangler secret put HMAC_KEY
```

Point `AGENT_URL` in `wrangler.toml` at the agent source in your fork:

```toml
AGENT_URL = "https://raw.githubusercontent.com/YOUR_GITHUB_USER/sworm/main/agent/agent.js"
```

Deploy:

```bash
npx wrangler deploy
```

Your worker url is `https://sworm.<your-subdomain>.workers.dev`.

## 2. Install the agent on a machine

On the machine you want to manage (macOS or linux):

```bash
curl -s https://YOUR_WORKER_URL/install | bash
```

On windows (PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://YOUR_WORKER_URL/install.ps1 | iex"
```

The script prints every step. The agent enrolls, installs its persistence, and starts polling. Read it first if you like: `curl -s https://YOUR_WORKER_URL/install`.

Other ways to install (npm package, shared folders, fleets) are in [install-everywhere.md](install-everywhere.md).

## 3. Set up the CLI

On your own machine, write `~/.swormrc`:

```json
{
  "workerUrl": "https://YOUR_WORKER_URL",
  "ownerToken": "the OWNER_TOKEN you set in step 1"
}
```

Put `swormctl` on your PATH, for example:

```bash
ln -s "$PWD/cli/swormctl.js" ~/bin/swormctl
chmod +x cli/swormctl.js
```

## 4. Use it

```bash
swormctl list
swormctl tree --machine m_abc123 --path "~/Documents" --confirm-hostname "LATIF-PC"
swormctl exec --machine m_abc123 --confirm-hostname "LATIF-PC" -- "uptime"
```

Every order command prints the machine detail first and needs `--confirm-hostname` matching the enrolled hostname exactly. That is deliberate: it keeps you from wiping the wrong laptop.

Next: [cli.md](cli.md) for every command, [security.md](security.md) for the threat model.
