#!/bin/bash
# One-shot Hive install: setup → vercel login → daemon → deploy → done.
# The daemon stays running in the background after this script exits.
# Run from the Hive repo root: bash scripts/install.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo ""
echo "  Installing Hive..."
echo ""

# ── 1. Setup ──────────────────────────────────────────────────────────

if [ ! -f "$HOME/.hive/token" ]; then
  bash "$ROOT/setup.sh"
else
  echo "  ✓ Already set up"
fi

# ── 2. Cloudflared ────────────────────────────────────────────────────

if ! command -v cloudflared &>/dev/null; then
  if command -v brew &>/dev/null; then
    echo ""
    echo "  Installing cloudflared (for remote dashboard access)..."
    brew install cloudflared
    echo "  ✓ cloudflared installed"
  else
    echo "  ✗ cloudflared not found and Homebrew not available."
    echo "    Install Homebrew (https://brew.sh) and re-run, or use:"
    echo "    npm run launch:local  (localhost only, no remote access)"
    exit 1
  fi
else
  echo "  ✓ cloudflared"
fi

# ── 3. Vercel login ──────────────────────────────────────────────────

if ! npx vercel whoami >/dev/null 2>&1; then
  echo ""
  echo "  Logging into Vercel (this opens your browser — click authorize)..."
  npx vercel login
fi
echo "  ✓ Vercel authenticated"

# ── 4. Start daemon + tunnel ──────────────────────────────────────────

if lsof -tiTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  ✓ Daemon already running on :3001"
else
  echo ""
  echo "  Starting daemon + tunnel..."
  # Start in a new Terminal window so the daemon runs as a Terminal.app
  # child process. This is required for osascript Automation permission
  # (closing terminals from the dashboard). macOS may show an approval
  # dialog the first time — click OK.
  if osascript -e "tell application \"Terminal\" to do script \"cd '$ROOT' && npm start\"" 2>/dev/null; then
    echo "  ✓ Daemon started in a new Terminal window"
  else
    # Fallback: background process (X button won't close terminal windows)
    echo "  Could not open Terminal window — starting in background..."
    nohup npm start > "$HOME/.hive/daemon.log" 2>&1 &
    disown "$!" 2>/dev/null || true
    echo "  ✓ Daemon started in background (log: ~/.hive/daemon.log)"
  fi
fi

# ── 5. Wait for tunnel URL ───────────────────────────────────────────

echo "  Waiting for tunnel..."
TUNNEL_URL=""
for _ in $(seq 1 90); do
  if [ -f "$HOME/.hive/tunnel-url.txt" ]; then
    TUNNEL_URL="$(grep -Eo 'https://[-a-z0-9.]+trycloudflare.com' "$HOME/.hive/tunnel-url.txt" | head -1 || true)"
    if [ -n "$TUNNEL_URL" ]; then
      break
    fi
  fi
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  echo "  ✗ Timed out waiting for tunnel. Check ~/.hive/daemon.log"
  exit 1
fi
echo "  ✓ Tunnel ready"

# ── 6. Deploy dashboard ──────────────────────────────────────────────

echo ""
echo "  Deploying dashboard to Vercel..."
npm run deploy:dashboard

# ── 7. Done ───────────────────────────────────────────────────────────

TOKEN="$(cat "$HOME/.hive/token" 2>/dev/null || echo '(not found)')"
DASHBOARD_URL="$(grep -Eo 'https://[[:alnum:].-]+\.vercel\.app' "$HOME/.hive/dashboard-url.txt" 2>/dev/null | tail -1 || echo '(check deploy output above)')"

echo ""
echo "  ────────────────────────────────────────────────"
echo ""
echo "  Hive is installed and running."
echo ""
echo "  Dashboard: $DASHBOARD_URL"
echo "  Token:     $TOKEN"
echo ""
echo "  Open the dashboard, paste your token, and start"
echo "  running agents in Terminal windows."
echo ""
echo "  The daemon runs in the background."
echo "  Log: ~/.hive/daemon.log"
echo "  Stop: kill \$(lsof -tiTCP:3001)"
echo ""
echo "  ────────────────────────────────────────────────"
echo ""
