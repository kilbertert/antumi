#!/bin/bash
# Remote core for the Windows Antumi app: the runtime half of a split deployment.
#
# The Windows app opens an SSH local forward to this host and dials 127.0.0.1:<corePort>, which
# lands on the core below. This core still listens only on loopback, so nothing here gains an
# exposed port — the boundary is the SSH link, exactly as VS Code Remote arranges it.
#
# Separate ANTUMI_HOME from the interactive server-side instance on purpose: two clients sharing
# one core would share one task list, which is a decision, not a default.
set -euo pipefail

export ANTUMI_HOME=${ANTUMI_HOME:-/home/claude/.antumi-remote}
export ANTUMI_PORT=${ANTUMI_PORT:-19450}
ANTUMI=/home/claude/Projects/antumi
logs=$ANTUMI_HOME/logs
mkdir -p "$logs"

# Started from a shell that may be inside another Claude Code session: those markers would make
# every agent believe it is a nested session.
unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY \
  ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL \
  CLAUDECODE CLAUDE_PID CLAUDE_EFFORT CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID \
  CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ATTENDED CLAUDE_CODE_MESSAGING_SOCKET \
  CLAUDE_CODE_MESSAGING_TOKEN

# Same agent PATH this host uses, with the relay wrapper first so agents authenticate the way
# the interactive setup does (~/.local/bin/claude-deepseek is the same route).
export PATH="/home/claude/.antumi/bin:$PATH"

cd "$ANTUMI"

daemon_up() { [ -S "$ANTUMI_HOME/daemon-v3.sock" ] && pgrep -af "packages/daemon/src/main.ts" >/dev/null; }
core_up() { ss -ltn 2>/dev/null | grep -q "127.0.0.1:$ANTUMI_PORT "; }

start() {
  daemon_up || setsid nohup ./node_modules/.bin/tsx packages/daemon/src/main.ts \
    >"$logs/daemon.log" 2>&1 < /dev/null &
  until daemon_up; do sleep 1; done
  core_up || setsid nohup ./node_modules/.bin/tsx packages/core/src/main.ts \
    >"$logs/core.log" 2>&1 < /dev/null &
  # The Windows app reads core.json over ssh to learn the token, so this file is the handshake.
  until [ -f "$ANTUMI_HOME/core.json" ] && core_up; do sleep 1; done
  echo "remote core: 127.0.0.1:$ANTUMI_PORT (home $ANTUMI_HOME)"
}

stop() {
  pkill -f "packages/core/src/main.ts" || true
  pkill -f "packages/daemon/src/main.ts" || true
  echo "remote core: stopped"
}

status() {
  core_up && echo "core: listening on $ANTUMI_PORT" || echo "core: not listening"
  [ -f "$ANTUMI_HOME/core.json" ] && cat "$ANTUMI_HOME/core.json" && echo
  pgrep -af "packages/(core|daemon)/src/main.ts" | head -3 || true
}

case "${1:-status}" in
  # start is what the app runs over ssh when remote.json names a startCommand. It must be
  # idempotent and quiet: the app reads core.json itself afterwards.
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 2; start ;;
  status)  status ;;
  *) echo "usage: $0 {start|stop|restart|status}" >&2; exit 64 ;;
esac
