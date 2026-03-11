#!/bin/bash
# Start Hive daemon + cloudflared quick tunnel for the hosted dashboard.

set -euo pipefail

HIVE_DIR="$HOME/.hive"
TUNNEL_FILE="$HIVE_DIR/tunnel-url.txt"
TUNNEL_LOG="$HIVE_DIR/cloudflared.log"

# Check cloudflared
if ! command -v cloudflared &> /dev/null; then
  echo "Installing cloudflared..."
  brew install cloudflared
fi

mkdir -p "$HIVE_DIR"
rm -f "$TUNNEL_FILE" "$TUNNEL_LOG"

# Start daemon in background
echo "Starting Hive daemon..."
npx tsx apps/daemon/src/index.ts &
DAEMON_PID=$!

# Wait for daemon to start
sleep 2

# Start tunnel
echo "Starting tunnel..."
cloudflared tunnel --url http://localhost:3002 >"$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

TUNNEL_URL=""
for _ in $(seq 1 20); do
  if [ -f "$TUNNEL_LOG" ]; then
    TUNNEL_URL="$(python3 - <<'PY' "$TUNNEL_LOG"
import re, sys
path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as f:
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
fi

echo ""
echo "Hive is running."
echo "  Daemon PID: $DAEMON_PID"
echo "  Tunnel PID: $TUNNEL_PID"
if [ -n "$TUNNEL_URL" ]; then
  echo "  Tunnel URL: $TUNNEL_URL"
  echo "  WebSocket URL: ${TUNNEL_URL/https:\/\//wss://}"
  echo "  Saved to: $TUNNEL_FILE"
  echo "  Deploy the hosted dashboard with: npm run deploy:dashboard"
else
  echo "  Tunnel URL: waiting on cloudflared startup"
  echo "  Check: tail -f $TUNNEL_LOG"
fi
echo ""
echo "Press Ctrl+C to stop."

trap "kill $DAEMON_PID $TUNNEL_PID 2>/dev/null; exit" INT
wait
