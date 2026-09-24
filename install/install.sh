#!/bin/sh
# sworm installer for macOS and linux.
#
# This is the repo copy of the script your worker serves at GET /install.
# The worker fills the three __SWORM_*__ placeholders when it serves it.
# To run this copy by hand, fill the three lines below first.
#
# The script does exactly five things:
#
#   1. Checks for node.js 18 or newer.
#   2. Creates the directory ~/.sworm.
#   3. Downloads the sworm agent into ~/.sworm/agent.js.
#   4. Writes ~/.sworm/config.json (worker url and bootstrap token).
#   5. Starts the agent in the background.
#
# The agent then enrolls this machine with your worker and sets up
# persistence so it starts at login: a LaunchAgent named
# com.sworm.agent on macOS, a cron @reboot line on linux.
#
# Remove everything at any time:
#   node ~/.sworm/agent.js --uninstall

set -e

SWORM_WORKER_URL="__SWORM_WORKER_URL__"
SWORM_BOOTSTRAP_TOKEN="__SWORM_BOOTSTRAP_TOKEN__"
SWORM_AGENT_URL="__SWORM_AGENT_URL__"
SWORM_DIR="$HOME/.sworm"

echo "sworm installer"
echo "worker: $SWORM_WORKER_URL"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node.js is not installed. install node 18 or newer, then rerun this script." >&2
  exit 1
fi
if ! node -e "process.exit(Number(process.version.slice(1).split('.')[0]) >= 18 ? 0 : 1)"; then
  echo "error: node 18 or newer is required." >&2
  exit 1
fi

echo "creating $SWORM_DIR"
mkdir -p "$SWORM_DIR"

download_agent() {
  if [ -n "$SWORM_AGENT_URL" ]; then
    if curl -fsSL "$SWORM_AGENT_URL" -o "$SWORM_DIR/agent.js"; then
      return 0
    fi
    echo "direct download failed, trying the worker route"
  fi
  curl -fsSL -H "Authorization: Bearer $SWORM_BOOTSTRAP_TOKEN" \
    "$SWORM_WORKER_URL/v1/agent" -o "$SWORM_DIR/agent.js"
}

echo "downloading the agent"
if ! download_agent; then
  echo "error: could not download the agent." >&2
  exit 1
fi

echo "writing config"
umask 077
printf '%s\n' "{" \
  "  \"workerUrl\": \"$SWORM_WORKER_URL\"," \
  "  \"bootstrapToken\": \"$SWORM_BOOTSTRAP_TOKEN\"" \
  "}" > "$SWORM_DIR/config.json"

echo "starting the agent"
nohup node "$SWORM_DIR/agent.js" >/dev/null 2>&1 &

echo "sworm agent installed"
echo "state dir: $SWORM_DIR"
echo "uninstall: node $SWORM_DIR/agent.js --uninstall"
