#!/bin/bash
# Start Hive locally with one command: daemon + dashboard + browser tab.
# Satellite-aware: if this machine is a satellite, starts the satellite daemon.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HIVE_DIR="$HOME/.hive"
URL="${HIVE_LOCAL_URL:-http://localhost:3000}"
DAEMON_PORT=3001
DASHBOARD_PORT=3000
STARTED_DAEMON=0
STARTED_DASHBOARD=0
DAEMON_PID=""
DASHBOARD_PID=""

is_listening() {
  local port="$1"
  lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

cleanup() {
  if [ "$STARTED_DASHBOARD" -eq 1 ] && [ -n "$DASHBOARD_PID" ]; then
    kill "$DASHBOARD_PID" 2>/dev/null || true
  fi
  if [ "$STARTED_DAEMON" -eq 1 ] && [ -n "$DAEMON_PID" ]; then
    kill "$DAEMON_PID" 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

cd "$ROOT"

# Auto-run setup if not done yet
if [ ! -f "$HOME/.hive/token" ]; then
  echo "First run detected — running setup..."
  bash "$ROOT/setup.sh"
fi

# ── Satellite guard ──────────────────────────────────────────────────
if [ -f "$HIVE_DIR/primary-url" ]; then
  PRIMARY_URL="$(cat "$HIVE_DIR/primary-url" 2>/dev/null | tr -d '\n')"
  if [ -n "$PRIMARY_URL" ]; then
    echo ""
    echo "  This machine is a satellite."
    echo "  Primary: $PRIMARY_URL"
    echo ""

    if is_listening "$DAEMON_PORT"; then
      echo "  Satellite daemon already running on :$DAEMON_PORT"
    else
      echo "  Starting satellite daemon..."
      npx tsx apps/daemon/src/index.ts --satellite &
      DAEMON_PID=$!
      STARTED_DAEMON=1

      for _ in $(seq 1 15); do
        if is_listening "$DAEMON_PORT"; then break; fi
        sleep 1
      done
    fi

    echo ""
    echo "  Your agents are visible on the primary's dashboard."
    echo "  Open Terminal windows and run 'claude', 'codex', or any agent."
    echo ""
    echo "  Press Ctrl+C to stop."
    if [ "$STARTED_DAEMON" -eq 1 ]; then
      wait "$DAEMON_PID"
    else
      tail -f /dev/null &
      DAEMON_PID=$!
      STARTED_DAEMON=1
      wait "$DAEMON_PID"
    fi
    exit 0
  fi
fi

# ── Primary mode ─────────────────────────────────────────────────────

if is_listening "$DAEMON_PORT"; then
  echo "Hive daemon already running on :$DAEMON_PORT"
else
  echo "Starting Hive daemon..."
  npm run dev:daemon &
  DAEMON_PID=$!
  STARTED_DAEMON=1
fi

if is_listening "$DASHBOARD_PORT"; then
  echo "Hive dashboard already running on :$DASHBOARD_PORT"
else
  echo "Starting Hive dashboard..."
  npm run dev:dashboard &
  DASHBOARD_PID=$!
  STARTED_DASHBOARD=1
fi

echo "Waiting for dashboard at $URL ..."
for _ in $(seq 1 60); do
  if curl -fsS "$URL" >/dev/null 2>&1; then
    echo ""
    echo "Hive is live: $URL"
    echo "Open 1-4 Terminal.app windows, run 'claude' and/or 'codex', and place them in the screen corners."
    if command -v open >/dev/null 2>&1; then
      open "$URL" >/dev/null 2>&1 || true
    fi
    wait
    exit 0
  fi
  sleep 1
done

echo "Hive dashboard did not become reachable at $URL within 60 seconds."
exit 1
