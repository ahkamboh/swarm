# swormctl reference

The CLI talks to your worker's `/v1/owner/*` routes with your owner token.

## Setup

Write `~/.swormrc`:

```json
{
  "workerUrl": "https://YOUR_WORKER_URL",
  "ownerToken": "your OWNER_TOKEN"
}
```

The env vars `SWORM_WORKER_URL` and `SWORM_OWNER_TOKEN` override the file.

Put it on your PATH:

```bash
ln -s "$PWD/cli/swormctl.js" ~/bin/swormctl
chmod +x cli/swormctl.js
```

Every order command prints the full machine detail before sending, and needs `--confirm-hostname` matching the enrolled hostname exactly. A mismatch places no order.

## swormctl list

One line per machine: id, hostname, os, user, location, uptime, last seen, current order.

```bash
$ swormctl list
m_4f2a9c1e77d2  LATIF-PC  windows  latif  Lahore PK  up 3h 12m  2026-09-24T08:14:02Z  none
m_91bd0e55a1c8  dev-box   darwin   sara   Lahore PK  up 40m     2026-09-24T08:10:11Z  none
```

No machines yet prints `(no machines yet)`.

## swormctl show \<machineId\>

Full json detail for one machine: profile, telemetry, current order, last ack.

```bash
swormctl show m_4f2a9c1e77d2
```

Use this before a wipe to copy the exact hostname.

## swormctl status

Every order across the fleet with its state: `pending`, `running`, `completed`, `partial`, `cancelled`, or `expired`.

```bash
swormctl status
```

## swormctl wipe

Place a scoped wipe order. The agent searches the configured roots for the named folders (and matching zip or tgz archives) and deletes them.

```bash
swormctl wipe --machine m_4f2a9c1e77d2 \
  --folders "client-app,design-assets" \
  --confirm-hostname "LATIF-PC" \
  --reason "engagement ended"
```

- `--folders` is a comma separated list of folder names. If you omit it, the worker's `WIPE_FOLDERS` var is used. With neither, the worker refuses the order. There is no unscoped wipe.
- After a clean wipe the agent removes itself from the machine. Pass `--keep-agent` to leave it installed.
- Watch `swormctl status` for `completed`. `partial` means some paths failed; `swormctl show` lists them under the ack.

## swormctl delete

Delete explicit paths on one machine. The agent stays installed.

```bash
swormctl delete --machine m_4f2a9c1e77d2 \
  --path "~/Desktop/notes.txt" \
  --path "~/Downloads/old-build.zip" \
  --confirm-hostname "LATIF-PC"
```

- Pass `--path` once per path, up to 50.
- `~` and relative paths resolve against the machine's home directory.
- The agent refuses filesystem roots and the home directory itself. Refused paths show up as failed in the ack.

## swormctl push

Write small files onto a machine.

```bash
swormctl push --machine m_4f2a9c1e77d2 \
  --file ./note.txt:/Users/latif/Desktop/note.txt \
  --confirm-hostname "LATIF-PC"
```

- Each `--file` is `<local>:<remote>`. The local file is read on your machine; the remote path is on the target.
- Caps: 256 KB per file, 10 files per order.
- The agent creates parent directories and writes mode `0644`.

## swormctl tree

List files on one machine. The agent walks the directory and uploads the listing; the CLI waits for it and prints an indented tree with sizes.

```bash
swormctl tree --machine m_4f2a9c1e77d2 --path "~/Documents" --depth 3 --confirm-hostname "LATIF-PC"
```

- `--depth` defaults to 4 and caps at 8. The listing caps at 5000 entries.
- The walk skips `node_modules`, `.git`, macOS `~/Library`, and the windows AppData dirs, unless the path you asked for is already inside one.
- If the machine does not answer within 90 seconds, the CLI prints a `swormctl result` command to run later. Results live for one hour.

## swormctl pull

Copy files from a machine back to yours.

```bash
swormctl pull --machine m_4f2a9c1e77d2 \
  --path "~/Documents/report.pdf" \
  --path "~/Desktop/screenshots" \
  --out ./latif-pull \
  --confirm-hostname "LATIF-PC"
```

- Each `--path` is a file or directory. Directories are walked up to 6 levels deep.
- Caps: 5 MB per file, 50 files per order, 20 MB total. Skipped files are listed with the reason.
- Files land under `--out` with relative paths preserved. The default out dir is `./pull-<machineId>-<orderId>`.

## swormctl exec

Run one command on a machine and print the output like a terminal would.

```bash
swormctl exec --machine m_4f2a9c1e77d2 --confirm-hostname "LATIF-PC" -- "ls -la ~/Documents"
swormctl exec --machine m_4f2a9c1e77d2 --confirm-hostname "LATIF-PC" -- "pkill -f chrome"
swormctl exec --machine m_4f2a9c1e77d2 --confirm-hostname "LATIF-PC" --timeout 120 --cwd "~/client-app" -- "git status"
```

- Everything after `--` is the command.
- The command runs in a fresh login shell (`$SHELL -lc` on macOS and linux, `cmd.exe /d /s /c` on windows) with the agent's normal user privileges. No sudo, no elevation.
- `--timeout` defaults to 60 seconds and caps at 300. Combined output truncates at 512 KB.
- `--cwd` sets the working directory. It defaults to the machine's home dir. Filesystem roots are refused.
- Each command is a fresh shell. State like `cd` does not persist between commands; chain with `&&` instead.

## swormctl shell

An interactive loop over exec:

```bash
swormctl shell --machine m_4f2a9c1e77d2 --confirm-hostname "LATIF-PC"
```

```
sworm shell connected to LATIF-PC (m_4f2a9c1e77d2)
each line runs in a fresh shell; chain with && when you need state. type exit to quit.
LATIF-PC> node -v
v22.11.0
[exit 0]
LATIF-PC> exit
```

Each line becomes one exec order with a 60 second timeout. Type `exit` to quit.

## swormctl result

Fetch a stored tree, pull, or exec result.

```bash
swormctl result --machine m_4f2a9c1e77d2 --order ord_a1b2c3d4
swormctl result --machine m_4f2a9c1e77d2 --order ord_a1b2c3d4 --out ./latif-pull
```

Results expire one hour after the agent uploads them.

## swormctl cancel

Cancel a pending order before the machine picks it up.

```bash
swormctl cancel --machine m_4f2a9c1e77d2
```

Only useful while the order is `pending`. Once the agent starts, cancel does not undo deletions, writes, or commands already run.

## Offboarding cookbook

1. Revoke the person's access to your repos and services.
2. `swormctl show <machineId>` and copy the exact hostname.
3. `swormctl pull` anything you need to keep.
4. `swormctl wipe --machine <id> --folders "your-project" --confirm-hostname "<hostname>"`.
5. Wait for `completed` in `swormctl status`. The agent removes itself after a clean wipe, so nothing is left on the laptop.
