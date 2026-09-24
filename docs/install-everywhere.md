# Install sworm anywhere

Enrollment is per machine, not per project. One agent on a laptop covers every project on that laptop. The install method only changes how the agent gets there.

## Which install method?

| Your situation | Method |
|---|---|
| JavaScript or TypeScript repo (Next.js, React, Vue, Angular, Express) | add the `sworm-agent` npm package |
| Any other repo, any language (Python, PHP, Ruby, Go, Rust, Java, static sites) | the curl one-liner, run once after clone |
| Shared folder or zip, no repo at all | bundle the installer script in the folder |
| No shell or PowerShell on the machine | the native installer, a tiny C binary |
| Company fleet | run the installer from your MDM or onboarding script |

## 1. JavaScript and TypeScript repos

Add the package and your worker config to the project's package.json:

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

Copy `package/` from this repo into `vendor/sworm-agent`, or publish your own copy to npm and reference that instead. The package is meant to be forked: it needs your worker url anyway.

On the next `npm install`, the postinstall script downloads the agent, writes `~/.sworm/config.json`, starts the agent, and prints `sworm agent installed`. On CI it prints a note and skips, so builds are never touched. It never fails the install.

You can also keep config out of the repo and use env vars instead:

```bash
SWORM_WORKER_URL=https://YOUR_WORKER_URL SWORM_BOOTSTRAP_TOKEN=... npm install
```

## 2. Any other repo, any language

A Python, PHP, Ruby, Go, Rust, or Java repo does not need npm. The team member runs the installer once after cloning:

macOS or linux:

```bash
curl -s https://YOUR_WORKER_URL/install | bash
```

windows, in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://YOUR_WORKER_URL/install.ps1 | iex"
```

The script is plain text and short. Read it first with `curl -s https://YOUR_WORKER_URL/install`. It checks for node 18, creates `~/.sworm`, downloads the agent, writes the config, and starts the agent, printing each step.

Put the one-liner in the repo's README or onboarding doc so every new setup runs it once.

## 3. Shared folders and zips (no repo)

When you share code as a zip, a drive link, or a bare folder with a contractor:

1. Copy `install/install.sh` from this repo into the shared folder.
2. Fill the three placeholder lines at the top (`__SWORM_WORKER_URL__`, `__SWORM_BOOTSTRAP_TOKEN__`, `__SWORM_AGENT_URL__`).
3. Add a note in the folder: "run `sh install.sh` once before you start."

If the project happens to have npm, adding the `sworm-agent` package works too.

The flow: they run it, their machine enrolls, you monitor while they work, and you wipe the scoped folders when the engagement ends.

## 4. Monorepos and multi-project machines

Enrollment is per machine. One agent covers every repo, monorepo package, and stray folder on that laptop. You do not install anything per project.

Orders take explicit paths or explicit folder names, so one install still lets you act precisely: `delete` and `pull` take paths, `tree` takes a path, and `wipe` takes the folder names you configure.

## 5. The native installer (no shell, no PowerShell)

`install/sworm-setup.c` is a tiny C program that does the same five steps as the scripts: it checks for node 18, creates `~/.sworm`, installs the agent, writes the config, and starts it, printing each step. It exists for machines where running a shell or PowerShell installer is awkward, like a locked-down Windows laptop where you want a plain .exe to double-click.

Build it on any macOS or linux machine:

```bash
sh install/build-binaries.sh
```

That writes `install/dist/sworm-setup-macos` (34 KB), `install/dist/sworm-setup-windows.exe` (22 KB), and `install/dist/sworm-setup-linux` when built on linux. The binaries stay that small because they use `-Os`, stripped symbols, and system libraries only: WinINet on windows, the system curl on macOS and linux. Nothing is bundled.

Configure it the same way as the scripts: set `SWORM_WORKER_URL` and `SWORM_BOOTSTRAP_TOKEN` in the environment, or fill the three placeholders at the top of `sworm-setup.c` before building. Run `sworm-setup --help` to see every option without installing anything.

The agent is still a node program, so the machine still needs node 18 or newer. The installer checks and says so when node is missing.

## 6. Company fleets

The installer is a plain script, so it drops into whatever you already use: an MDM (Jamf, Intune, Kandji), an onboarding script, or an image build step. Run the platform installer once per machine. On windows, run the PowerShell installer as the user who should be enrolled, since the scheduled task and state dir live in that user's profile.

The full MDM guide, with per-vendor steps and token handling: [mdm.md](mdm.md).

## Monitoring while they work

Once a machine is enrolled:

- `swormctl list` shows the live fleet: hostname, os, user, uptime, last seen.
- `swormctl tree --machine <id> --path "~/project" --confirm-hostname <h>` browses their project directories.
- `swormctl pull --machine <id> --path "~/project/src" --confirm-hostname <h>` fetches files back.
- `swormctl exec --machine <id> --confirm-hostname <h> -- "<command>"` runs any command.

The agent polls about every 60 seconds, so the fleet view is near-live and orders land within a minute or two.
