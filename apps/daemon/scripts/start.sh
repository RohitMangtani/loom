#!/bin/bash
# Start Hive daemon + cloudflared tunnel

# Check cloudflared
if ! command -v cloudflared &> /dev/null; then
  echo "Installing cloudflared..."
  brew install cloudflared
fi

# Start daemon in background
echo "Starting Hive daemon..."
npx tsx apps/daemon/src/index.ts &
DAEMON_PID=$!

# Wait for daemon to start
sleep 2

# Start tunnel
echo "Starting tunnel..."
cloudflared tunnel --url http://localhost:3002 2>&1 &
TUNNEL_PID=$!

echo ""
echo "Hive is running."
echo "  Daemon PID: $DAEMON_PID"
echo "  Tunnel PID: $TUNNEL_PID"
echo ""
echo "Press Ctrl+C to stop."

trap "kill $DAEMON_PID $TUNNEL_PID 2>/dev/null; exit" INT
wait
