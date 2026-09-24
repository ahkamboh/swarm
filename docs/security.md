# Security
This is a worm that can be installed on any device when attached to a code file, folder, or APK. Once inside the system, it runs without showing notifications to the user and does not appear in RAM.

## Consent first

Only install the agent on devices you own or are explicitly authorized to administer. Tell the person using the device that it is enrolled, what you can do, and when you will remove it. The installer prints what it does, the state dir is a visible `~/.sworm`, the persistence entries use clear names, and `node ~/.sworm/agent.js --uninstall` removes everything. Keep it that way.

## Threat model

| Token | What it opens | If it leaks |
|---|---|---|
| `OWNER_TOKEN` | Every owner route: list machines, browse files, pull files, push files, delete paths, wipe, run commands | Full control of every enrolled machine. Treat it like root on the whole fleet. |
| `BOOTSTRAP_TOKEN` | Enrollment and the agent download | Someone can enroll fake machines into your fleet list. They cannot issue orders or read results. Rotate it. |
| `HMAC_KEY` | Signs order envelopes | An attacker who also sits between agent and worker could forge orders. It only travels over TLS, once, at enroll. |
| agent token | One machine's poll, ack, and result routes | Someone can poll as that machine and upload fake results. They cannot read orders for other machines. |

## The owner token is root

There is no role system. Whoever holds the owner token can run any command on every enrolled machine through `exec`. Store it in `~/.swormrc` with mode 600, never in a repo, never in a shared note. Rotate it with `npx wrangler secret put OWNER_TOKEN` if you suspect exposure.

## exec is remote code execution

`swormctl exec` and `swormctl shell` run arbitrary commands on the enrolled machine with that user's privileges. It is the most powerful capability in sworm. It cannot escalate to sudo by itself, but everything the user can do, the order can do. This is one more reason the owner token must stay secret and enrollment must be consented.

## How orders are protected

- Every order envelope is HMAC-SHA256 signed by the worker and verified on the agent before anything runs.
- Envelopes expire 180 seconds after issue and carry the poll's random nonce, so a replayed or stale envelope fails verification.
- All traffic is TLS. Use the `workers.dev` url or your own domain; never plain http.
- Destructive CLI commands need `--confirm-hostname` matching the enrolled hostname, and the CLI prints the machine detail before the order goes out.

## What the agent can do

- Delete paths you order, except filesystem roots and the home directory itself (refused).
- Wipe the folder names you configure, found under the configured search roots.
- Write files up to 256 KB each, anywhere the user can write, except the refused targets.
- Read files back to you: 5 MB per file, 50 files, 20 MB total per order.
- Run shell commands as the logged-in user.

## What the agent cannot do

- Escalate privileges. No sudo, no root, no system daemons.
- Run shell commands unless you order it to. There is no hidden evaluator; `exec` orders are visible in `swormctl status`.
- Persist beyond the three documented mechanisms (LaunchAgent `com.sworm.agent`, scheduled task `SwormAgent`, one tagged cron line).
- Hide. The source is readable, the state dir is visible, and the installer prints every step.

## The /install route is public

`GET /install` and `GET /install.ps1` are public and embed your bootstrap token, because the one-liner has to work on a fresh machine with no prior secret. The bootstrap token only allows enrollment. If you want to restrict it anyway, put the worker behind Cloudflare Access and install with the repo copy of the script instead (`install/install.sh`, fill the three placeholder lines).

## Hardening checklist

- Generate all three secrets with `openssl rand -hex 32`.
- `chmod 600 ~/.swormrc`.
- Rotate `OWNER_TOKEN` on any suspicion. Rotate `BOOTSTRAP_TOKEN` if the installer url spreads beyond your team.
- Keep the fleet small and known. Run `swormctl list` and question any machine you do not recognize.
- Uninstall agents when engagements end. A wipe order with the default flags does this for you.
- Review `agent/agent.js` before installing. It is short and readable on purpose.
