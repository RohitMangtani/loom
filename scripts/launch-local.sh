#!/bin/bash
# Start Hive locally with one command: daemon + dashboard + browser tab.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
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
