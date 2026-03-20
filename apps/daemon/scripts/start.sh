#!/bin/bash
# Start Hive daemon + tunnel for the hosted dashboard.
#
# Tunnel priority:
# 1. Reuse existing tunnel process (stable URL preserved)
# 2. ngrok (stable free subdomain — survives restarts)
# 3. cloudflared (random URL — last resort)
#
# The tunnel is NOT killed when the daemon stops. Satellites need it stable.

set -euo pipefail

HIVE_DIR="$HOME/.hive"
TUNNEL_FILE="$HIVE_DIR/tunnel-url.txt"
TUNNEL_PID_FILE="$HIVE_DIR/tunnel.pid"

mkdir -p "$HIVE_DIR"

# ── Tunnel: reuse existing or start new ──────────────────────────────

TUNNEL_PID=""
TUNNEL_URL=""

# 1. Check if an existing tunnel process is still running
if [ -f "$TUNNEL_PID_FILE" ]; then
  OLD_PID="$(cat "$TUNNEL_PID_FILE" 2>/dev/null || echo "")"
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    TUNNEL_PID="$OLD_PID"
    TUNNEL_URL="$(cat "$TUNNEL_FILE" 2>/dev/null || echo "")"
    if [ -n "$TUNNEL_URL" ]; then
      echo "  Reusing existing tunnel (PID $TUNNEL_PID)"
      echo "  URL: $TUNNEL_URL"
    fi
  fi
fi

# Also check for any tunnel process on port 3002
if [ -z "$TUNNEL_PID" ]; then
  # Check ngrok
  EXISTING="$(pgrep -f 'ngrok.*3002' 2>/dev/null | head -1 || echo "")"
  if [ -n "$EXISTING" ]; then
    TUNNEL_PID="$EXISTING"
    # Read URL from ngrok API
    TUNNEL_URL="$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | python3 -c "
import sys, json
try:
    for t in json.load(sys.stdin)['tunnels']:
        if 'https' in t.get('public_url',''):
            print(t['public_url']); break
except: pass
" 2>/dev/null || echo "")"
    if [ -n "$TUNNEL_URL" ]; then
      echo "  Found existing ngrok tunnel (PID $TUNNEL_PID): $TUNNEL_URL"
      echo "$TUNNEL_PID" > "$TUNNEL_PID_FILE"
      echo "$TUNNEL_URL" > "$TUNNEL_FILE"
    fi
  fi
  # Check cloudflared
  if [ -z "$TUNNEL_PID" ]; then
    EXISTING="$(pgrep -f 'cloudflared.*3002' 2>/dev/null | head -1 || echo "")"
    if [ -n "$EXISTING" ]; then
      TUNNEL_PID="$EXISTING"
      TUNNEL_URL="$(cat "$TUNNEL_FILE" 2>/dev/null || echo "")"
      if [ -n "$TUNNEL_URL" ]; then
        echo "  Found existing cloudflared tunnel (PID $TUNNEL_PID): $TUNNEL_URL"
        echo "$TUNNEL_PID" > "$TUNNEL_PID_FILE"
      fi
    fi
  fi
fi

# 2. Start a new tunnel if none exists
if [ -z "$TUNNEL_PID" ] || [ -z "$TUNNEL_URL" ]; then
  # Prefer ngrok (stable URLs) over cloudflared (random URLs)
  if command -v ngrok &>/dev/null; then
    echo "  Starting ngrok tunnel..."
    ngrok http 3002 --log=stdout > "$HIVE_DIR/ngrok.log" 2>&1 &
    TUNNEL_PID=$!
    echo "$TUNNEL_PID" > "$TUNNEL_PID_FILE"
    sleep 5
    TUNNEL_URL="$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | python3 -c "
import sys, json
try:
    for t in json.load(sys.stdin)['tunnels']:
        if 'https' in t.get('public_url',''):
            print(t['public_url']); break
except: pass
" 2>/dev/null || echo "")"
  elif command -v cloudflared &>/dev/null; then
    echo "  Starting cloudflared tunnel (install ngrok for stable URLs)..."
    cloudflared tunnel --url http://localhost:3002 --no-autoupdate > "$HIVE_DIR/cloudflared.log" 2>&1 &
    TUNNEL_PID=$!
    echo "$TUNNEL_PID" > "$TUNNEL_PID_FILE"
    for _ in $(seq 1 20); do
      TUNNEL_URL="$(python3 -c "
import re
try:
    with open('$HIVE_DIR/cloudflared.log') as f:
        m = re.search(r'https://[-a-z0-9.]+trycloudflare\.com', f.read())
        if m: print(m.group(0))
except: pass
" 2>/dev/null || echo "")"
      if [ -n "$TUNNEL_URL" ]; then break; fi
      sleep 1
    done
  else
    echo "  No tunnel tool found. Install ngrok (brew install ngrok) or cloudflared (brew install cloudflared)."
    echo "  Without a tunnel, only localhost access is available."
    echo "  Continuing without tunnel..."
  fi

  if [ -n "$TUNNEL_URL" ]; then
    echo "$TUNNEL_URL" > "$TUNNEL_FILE"
    echo "  Tunnel: $TUNNEL_URL"
  fi
fi

# ── Daemon ───────────────────────────────────────────────────────────

echo ""
echo "  Starting Hive daemon..."
npx tsx apps/daemon/src/index.ts &
DAEMON_PID=$!

sleep 2

echo ""
echo "  ────────────────────────────────────────────────"
echo ""
echo "  Hive is running."
echo ""
if [ -n "$TUNNEL_URL" ]; then
  WS_URL="${TUNNEL_URL/https:\/\//wss://}"
  echo "  Tunnel:  $TUNNEL_URL"
  echo "  Token:   $(cat "$HIVE_DIR/token" 2>/dev/null || echo '(not found)')"
  echo ""
  echo "  Connect another Mac:"
  echo "  bash scripts/install.sh --connect $WS_URL $(cat "$HIVE_DIR/token" 2>/dev/null || echo 'TOKEN')"
else
  echo "  No tunnel — localhost only."
  echo "  Run: npm run launch:local"
fi
echo ""
echo "  Press Ctrl+C to stop daemon."
echo "  (Tunnel stays running for satellites.)"
echo ""
echo "  ────────────────────────────────────────────────"
echo ""

# Only kill daemon on Ctrl+C, NOT the tunnel
trap "kill $DAEMON_PID 2>/dev/null; exit" INT
wait $DAEMON_PID
