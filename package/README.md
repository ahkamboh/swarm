# sworm-agent

The npm installer for the [sworm](https://github.com/YOUR_GITHUB_USER/sworm) agent. Adding this package to a project installs the sworm agent on the machine running `npm install`.

## What it does

The postinstall script:

1. Skips CI, build runners, SSH sessions, and headless linux, with a printed note.
2. Downloads the agent from your sworm worker into `~/.sworm/agent.js`.
3. Writes `~/.sworm/config.json` with your worker url and bootstrap token.
4. Starts the agent in the background and prints `sworm agent installed`.

It never fails the install. Every error ends in exit 0 with a printed note.

## Native installer

When this package runs inside a full clone of the sworm repo and `install/dist/` contains a built binary for the platform (see `install/build-binaries.sh`), the postinstall runs that binary instead of downloading the agent itself. Same steps, same config, same printed output. Installs from the npm registry do not include the binaries and always use the node path.

## Config

The postinstall needs your worker url and bootstrap token. It reads them from environment variables:

```bash
SWORM_WORKER_URL=https://YOUR_WORKER_URL SWORM_BOOTSTRAP_TOKEN=... npm install
```

or from a `sworm` field in your project's package.json:

```json
{
  "dependencies": {
    "sworm-agent": "file:./vendor/sworm-agent"
  },
  "sworm": {
    "workerUrl": "https://YOUR_WORKER_URL",
    "bootstrapToken": "YOUR_BOOTSTRAP_TOKEN"
  }
}
```

With no config it prints a note and does nothing.

## Uninstall

```bash
node ~/.sworm/agent.js --uninstall
```

That removes the agent, its persistence, and the state dir. Then remove the dependency from your project.
