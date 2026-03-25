#!/bin/bash
# Start Hive with the hosted dashboard path: daemon + tunnel + Vercel deploy.
# Satellite-aware: if this machine is a satellite, starts the satellite daemon
# instead of the primary flow.

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

# Auto-run setup if not done yet
if [ ! -f "$HOME/.hive/token" ]; then
  echo "First run detected — running setup..."
  bash "$ROOT/setup.sh"
fi

# ── Satellite guard ──────────────────────────────────────────────────
# If this machine is configured as a satellite, start the satellite
# daemon instead of the primary + tunnel + dashboard deploy flow.
if [ -f "$HIVE_DIR/primary-url" ]; then
  PRIMARY_URL="$(cat "$HIVE_DIR/primary-url" 2>/dev/null | tr -d '\n')"
  if [ -n "$PRIMARY_URL" ]; then
    echo ""
    echo "  This machine is a satellite."
    echo "  Primary: $PRIMARY_URL"
    echo ""

    if is_listening "$DAEMON_PORT"; then
      echo "  Satellite daemon already running on :$DAEMON_PORT"
      echo ""
      echo "  Your agents are visible on the primary's dashboard."
      echo "  Open Terminal windows and run 'claude', 'codex', or any agent."
      echo ""
      # Keep the script alive so "npm run launch" doesn't exit immediately
      echo "  Press Ctrl+C to stop."
      tail -f /dev/null &
      STACK_PID=$!
      STARTED_STACK=1
      wait "$STACK_PID"
    else
      echo "  Starting satellite daemon..."
      npx tsx apps/daemon/src/index.ts --satellite &
      STACK_PID=$!
      STARTED_STACK=1

      # Wait for satellite to start
      SAT_OK=0
      for _ in $(seq 1 15); do
        if is_listening "$DAEMON_PORT"; then
          SAT_OK=1
          break
        fi
        sleep 1
      done

      echo ""
      if [ "$SAT_OK" -eq 1 ]; then
        echo "  Satellite daemon running on :$DAEMON_PORT"
        echo ""
        echo "  Your agents are visible on the primary's dashboard."
        echo "  Open Terminal windows and run 'claude', 'codex', or any agent."
        echo ""
        echo "  Press Ctrl+C to stop."
        wait "$STACK_PID"
      else
        echo "  Satellite daemon failed to start."
        echo "  Log: cat ~/.hive/logs/satellite.stderr.log"
        tail -10 "$HOME/.hive/logs/satellite.stderr.log" 2>/dev/null | sed 's/^/    /'
        exit 1
      fi
    fi
    exit 0
  fi
fi

# ── Primary mode ─────────────────────────────────────────────────────

if ! npx vercel whoami >/dev/null 2>&1; then
  echo "Vercel login required for the hosted launch path."
  echo "Run: npx vercel login"
  echo "Or use: npm run launch:local (no Vercel needed)"
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
    TUNNEL_URL="$(grep -Eo 'https://[^[:space:]]+' "$TUNNEL_FILE" | head -n 1 || true)"
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
