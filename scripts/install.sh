#!/bin/bash
# One-shot Hive install.
#
# Fresh instance:   bash scripts/install.sh
# Join existing:    bash scripts/install.sh --connect wss://URL TOKEN
#
# The daemon stays running in the background after this script exits.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── Parse --connect flag ─────────────────────────────────────────────

SATELLITE_MODE=0
PRIMARY_URL=""
PRIMARY_TOKEN=""

if [ "${1:-}" = "--connect" ]; then
  SATELLITE_MODE=1
  PRIMARY_URL="${2:-}"
  PRIMARY_TOKEN="${3:-}"

  if [ -z "$PRIMARY_URL" ] || [ -z "$PRIMARY_TOKEN" ]; then
    echo ""
    echo "  Usage: bash scripts/install.sh --connect <tunnel-url> <token>"
    echo ""
    echo "  Get these from your primary Hive dashboard (the machine"
    echo "  that's already running Hive)."
    echo ""
    exit 1
  fi

  # Normalize URL: https → wss
  PRIMARY_URL="${PRIMARY_URL/https:\/\//wss://}"
fi

echo ""
if [ "$SATELLITE_MODE" -eq 1 ]; then
  echo "  Connecting to Hive network..."
else
  echo "  Installing Hive..."
fi
echo ""

# ── 1. Setup ──────────────────────────────────────────────────────────

if [ ! -f "$HOME/.hive/token" ]; then
  bash "$ROOT/setup.sh"
else
  echo "  ✓ Already set up"
fi

# ── Satellite: store config + start ───────────────────────────────────

if [ "$SATELLITE_MODE" -eq 1 ]; then
  # Store primary connection info
  mkdir -p "$HOME/.hive"
  echo "$PRIMARY_URL" > "$HOME/.hive/primary-url"
  echo "$PRIMARY_TOKEN" > "$HOME/.hive/primary-token"
  chmod 600 "$HOME/.hive/primary-url" "$HOME/.hive/primary-token"
  echo "  ✓ Primary connection stored"

  # Start satellite daemon
  if lsof -tiTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "  ✓ Satellite already running on :3001"
  else
    echo ""
    echo "  Starting satellite daemon..."
    if osascript -e "tell application \"Terminal\" to do script \"cd '$ROOT' && npx tsx apps/daemon/src/index.ts --satellite\"" 2>/dev/null; then
      echo "  ✓ Satellite started in a new Terminal window"
    else
      echo "  Starting in background..."
      nohup npx tsx apps/daemon/src/index.ts --satellite > "$HOME/.hive/satellite.log" 2>&1 &
      disown "$!" 2>/dev/null || true
      echo "  ✓ Satellite started in background (log: ~/.hive/satellite.log)"
    fi
  fi

  echo ""
  echo "  ────────────────────────────────────────────────"
  echo ""
  echo "  Connected to Hive network."
  echo ""
  echo "  Primary: $PRIMARY_URL"
  echo ""
  echo "  Your terminals will appear on the primary's"
  echo "  dashboard within a few seconds."
  echo ""
  echo "  Open Terminal windows and run 'claude', 'codex',"
  echo "  or any agent — the primary dashboard sees them."
  echo ""
  echo "  Stop: kill \$(lsof -tiTCP:3001)"
  echo ""
  echo "  ────────────────────────────────────────────────"
  echo ""
  exit 0
fi

# ══════════════════════════════════════════════════════════════════════
# Primary mode (default) — unchanged from original install flow
# ══════════════════════════════════════════════════════════════════════

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
WS_URL="${TUNNEL_URL/https:\/\//wss://}"

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
echo "  ── Connect another machine ──"
echo ""
echo "  On the other computer, clone Hive and run:"
echo "  bash scripts/install.sh --connect $WS_URL $TOKEN"
echo ""
echo "  The daemon runs in the background."
echo "  Log: ~/.hive/daemon.log"
echo "  Stop: kill \$(lsof -tiTCP:3001)"
echo ""
echo "  ────────────────────────────────────────────────"
echo ""
