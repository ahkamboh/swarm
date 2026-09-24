# Uninstall

Everything sworm installs is removable, and the agent removes itself on request.

## Remove the agent from a machine

```bash
node ~/.sworm/agent.js --uninstall
```

That one command:

- macOS: removes the LaunchAgent `com.sworm.agent` (`launchctl bootout` plus deleting `~/Library/LaunchAgents/com.sworm.agent.plist`)
- windows: deletes the scheduled task `SwormAgent`
- linux: removes the cron line tagged `# sworm-agent`
- deletes the state dir `~/.sworm` (agent source, config, machine credentials, lock file)

It exits 0 even if nothing was installed. Safe to run twice.

On windows, if you prefer the GUI: open Task Scheduler, delete `SwormAgent`, then delete the `.sworm` folder in your user profile.

## Remove the CLI

```bash
rm ~/bin/swormctl   # or wherever you symlinked it
rm ~/.swormrc
```

## Remove the npm package from a project

```bash
npm uninstall sworm-agent
```

Then uninstall the agent on any machine that installed it (above).

## Tear down the worker

Only do this when you are retiring the whole fleet.

```bash
cd worker
npx wrangler delete
```

Then delete the kv namespace in the cloudflare dashboard (Workers & Pages, KV, your namespace, Delete). That erases machine profiles, tokens, orders, and any stored results.

Note: results expire on their own after one hour and orders after 24 hours, so a fleet you simply stop using goes quiet by itself.
