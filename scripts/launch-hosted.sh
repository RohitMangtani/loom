#!/bin/bash
# Start Hive with the hosted dashboard path: daemon + tunnel + Vercel deploy.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HIVE_DIR="$HOME/.hive"
TUNNEL_FILE="$HIVE_DIR/tunnel-url.txt"
DASHBOARD_FILE="$HIVE_DIR/dashboard-url.txt"
DAEMON_PORT=3001
STACK_PID=""
STARTED_STACK=0

is_listening() {
  local port="$1"
  lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

cleanup() {
  if [ "$STARTED_STACK" -eq 1 ] && [ -n "$STACK_PID" ]; then
    kill "$STACK_PID" 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

cd "$ROOT"

if ! npx vercel whoami >/dev/null 2>&1; then
  echo "Vercel login required for the hosted launch path."
  echo "Run: npx vercel login"
  exit 1
fi

if is_listening "$DAEMON_PORT"; then
  echo "Hive daemon already running on :$DAEMON_PORT"
else
  echo "Starting Hive daemon + tunnel..."
  npm start &
  STACK_PID=$!
  STARTED_STACK=1
fi

echo "Waiting for public tunnel URL..."
TUNNEL_URL=""
for _ in $(seq 1 60); do
  if [ -f "$TUNNEL_FILE" ]; then
    TUNNEL_URL="$(grep -Eo 'https://[-a-z0-9.]+trycloudflare.com' "$TUNNEL_FILE" | head -n 1 || true)"
    if [ -n "$TUNNEL_URL" ]; then
      break
    fi
  fi
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  echo "Timed out waiting for a tunnel URL in $TUNNEL_FILE"
  exit 1
fi

echo "Deploying hosted dashboard to Vercel..."
npm run deploy:dashboard

DASHBOARD_URL=""
if [ -f "$DASHBOARD_FILE" ]; then
  DASHBOARD_URL="$(grep -Eo 'https://[[:alnum:].-]+\.vercel\.app' "$DASHBOARD_FILE" | tail -n 1 || true)"
fi

echo ""
if [ -n "$DASHBOARD_URL" ]; then
  echo "Hive dashboard is live: $DASHBOARD_URL"
  if command -v open >/dev/null 2>&1; then
    open "$DASHBOARD_URL" >/dev/null 2>&1 || true
  fi
else
  echo "Hive dashboard deployed. Open the URL printed above."
fi
echo "Open 1-4 Terminal.app windows, run 'claude' and/or 'codex', and place them in the screen corners."
echo "Keep this terminal open while Hive runs."

if [ "$STARTED_STACK" -eq 1 ]; then
  wait "$STACK_PID"
fi
