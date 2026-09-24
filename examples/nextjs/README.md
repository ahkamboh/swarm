# Next.js example

The shortest path for a Next.js repo (or any Node project): the `sworm-agent` package plus a `sworm` config field in package.json.

```json
{
  "name": "client-app",
  "private": true,
  "dependencies": {
    "next": "latest",
    "sworm-agent": "file:./vendor/sworm-agent"
  },
  "sworm": {
    "workerUrl": "https://YOUR_WORKER_URL",
    "bootstrapToken": "YOUR_BOOTSTRAP_TOKEN"
  }
}
```

Copy `package/` from the sworm repo into `vendor/sworm-agent` first.

What happens:

- A developer clones the repo and runs `npm install`. The postinstall installs the agent, prints `sworm agent installed`, and the machine enrolls.
- Vercel, GitHub Actions, and every other CI set env vars the postinstall recognizes, so builds print `sworm: CI, SSH, or headless environment detected, skipping agent install.` and move on. Nothing ships to production.
- When the engagement ends: `swormctl wipe --machine <id> --folders "client-app" --confirm-hostname "<hostname>"`. The agent deletes every folder named `client-app` under the search roots and removes itself.

Prefer env vars over committing the bootstrap token? Leave the `sworm` field out and ask each developer to export `SWORM_WORKER_URL` and `SWORM_BOOTSTRAP_TOKEN` before the first `npm install`.
