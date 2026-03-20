#!/bin/bash
# Start Hive daemon + cloudflared tunnel for the hosted dashboard.
# IMPORTANT: Reuses existing tunnel if running — satellite URLs stay stable.

set -euo pipefail

HIVE_DIR="$HOME/.hive"
TUNNEL_FILE="$HIVE_DIR/tunnel-url.txt"
TUNNEL_LOG="$HIVE_DIR/cloudflared.log"
TUNNEL_PID_FILE="$HIVE_DIR/tunnel.pid"

# Check cloudflared
if ! command -v cloudflared &> /dev/null; then
  echo "Installing cloudflared..."
  brew install cloudflared
fi

mkdir -p "$HIVE_DIR"

# ── Tunnel: reuse existing or start new ──────────────────────────────

TUNNEL_PID=""
TUNNEL_URL=""
STARTED_TUNNEL=0

# Check if an existing tunnel process is still running
if [ -f "$TUNNEL_PID_FILE" ]; then
  OLD_PID="$(cat "$TUNNEL_PID_FILE" 2>/dev/null || echo "")"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    TUNNEL_PID="$OLD_PID"
    TUNNEL_URL="$(cat "$TUNNEL_FILE" 2>/dev/null || echo "")"
    if [ -n "$TUNNEL_URL" ]; then
      echo "Reusing existing tunnel (PID $TUNNEL_PID): $TUNNEL_URL"
    fi
  fi
fi

# Also check for any cloudflared process tunneling to 3002
if [ -z "$TUNNEL_PID" ]; then
  EXISTING="$(pgrep -f 'cloudflared.*localhost:3002' 2>/dev/null | head -1 || echo "")"
  if [ -n "$EXISTING" ]; then
    TUNNEL_PID="$EXISTING"
    TUNNEL_URL="$(cat "$TUNNEL_FILE" 2>/dev/null || echo "")"
    if [ -n "$TUNNEL_URL" ]; then
      echo "Found existing tunnel process (PID $TUNNEL_PID): $TUNNEL_URL"
      echo "$TUNNEL_PID" > "$TUNNEL_PID_FILE"
    fi
  fi
fi

# Start a new tunnel only if none exists
if [ -z "$TUNNEL_PID" ] || [ -z "$TUNNEL_URL" ]; then
  echo "Starting new tunnel..."
  rm -f "$TUNNEL_FILE" "$TUNNEL_LOG"
  cloudflared tunnel --url http://localhost:3002 --no-autoupdate >"$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!
  STARTED_TUNNEL=1
  echo "$TUNNEL_PID" > "$TUNNEL_PID_FILE"

  # Wait for URL to appear in log
  for _ in $(seq 1 20); do
    if [ -f "$TUNNEL_LOG" ]; then
      TUNNEL_URL="$(python3 - <<'PY' "$TUNNEL_LOG"
import re, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        text = f.read()
except FileNotFoundError:
    text = ""
match = re.search(r'https://[-a-z0-9.]+trycloudflare\.com', text)
print(match.group(0) if match else "")
PY
)"
      if [ -n "$TUNNEL_URL" ]; then
        break
      fi
    fi
    sleep 1
  done

  if [ -n "$TUNNEL_URL" ]; then
    echo "$TUNNEL_URL" > "$TUNNEL_FILE"
    echo "New tunnel: $TUNNEL_URL"
  fi
fi

# ── Daemon ───────────────────────────────────────────────────────────

echo "Starting Hive daemon..."
npx tsx apps/daemon/src/index.ts &
DAEMON_PID=$!

echo ""
echo "Hive is running."
echo "  Daemon PID: $DAEMON_PID"
echo "  Tunnel PID: $TUNNEL_PID"
if [ -n "$TUNNEL_URL" ]; then
  echo "  Tunnel URL: $TUNNEL_URL"
  echo "  WebSocket:  ${TUNNEL_URL/https:\/\//wss://}"
  echo ""
  echo "  Connect another Mac:"
  echo "  bash scripts/install.sh --connect ${TUNNEL_URL/https:\/\//wss://} $(cat "$HIVE_DIR/token" 2>/dev/null || echo 'YOUR_TOKEN')"
fi
echo ""
echo "Press Ctrl+C to stop daemon (tunnel stays running for satellites)."

# Only kill daemon on Ctrl+C, NOT the tunnel — satellites need it stable
trap "kill $DAEMON_PID 2>/dev/null; exit" INT
wait $DAEMON_PID
