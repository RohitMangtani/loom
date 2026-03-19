#!/bin/bash
# One-shot Hive install.
#
# Fresh instance:   bash scripts/install.sh
# Join existing:    bash scripts/install.sh --connect wss://URL TOKEN
# Non-interactive:  bash scripts/install.sh --fresh
#
# With no flags, prompts the user to choose.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── Parse flags ──────────────────────────────────────────────────────

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

  PRIMARY_URL="${PRIMARY_URL/https:\/\//wss://}"

elif [ "${1:-}" = "--fresh" ]; then
  SATELLITE_MODE=0

elif [ -t 0 ]; then
  # Interactive terminal: ask the user what they want
  echo ""
  echo "  ┌─────────────────────────────────────────┐"
  echo "  │             Hive Setup                   │"
  echo "  │                                          │"
  echo "  │  1) New environment                      │"
  echo "  │     Start fresh with your own dashboard  │"
  echo "  │                                          │"
  echo "  │  2) Join a Hive network                  │"
  echo "  │     Connect this Mac's terminals to an   │"
  echo "  │     existing Hive running on another      │"
  echo "  │     computer                             │"
  echo "  │                                          │"
  echo "  └─────────────────────────────────────────┘"
  echo ""
  printf "  Choose (1 or 2): "
  read -r CHOICE

  if [ "$CHOICE" = "2" ]; then
    SATELLITE_MODE=1
    echo ""
    printf "  Tunnel URL (wss://... from primary dashboard): "
    read -r PRIMARY_URL
    printf "  Token (from primary dashboard): "
    read -r PRIMARY_TOKEN

    if [ -z "$PRIMARY_URL" ] || [ -z "$PRIMARY_TOKEN" ]; then
      echo ""
      echo "  Both URL and token are required."
      exit 1
    fi

    PRIMARY_URL="${PRIMARY_URL/https:\/\//wss://}"
  fi
else
  # Non-interactive (piped from Claude Code, CI, etc.)
  # Check environment variables for satellite mode
  if [ -n "${HIVE_PRIMARY_URL:-}" ] && [ -n "${HIVE_PRIMARY_TOKEN:-}" ]; then
    SATELLITE_MODE=1
    PRIMARY_URL="${HIVE_PRIMARY_URL}"
    PRIMARY_TOKEN="${HIVE_PRIMARY_TOKEN}"
    PRIMARY_URL="${PRIMARY_URL/https:\/\//wss://}"
  else
    SATELLITE_MODE=0
    echo "  ┌──────────────────────────────────────────────────────┐"
    echo "  │  Running in non-interactive mode → fresh install.    │"
    echo "  │                                                      │"
    echo "  │  To join an existing Hive network instead, re-run:   │"
    echo "  │  bash scripts/install.sh --connect <URL> <TOKEN>     │"
    echo "  │                                                      │"
    echo "  │  Or set env vars before running:                     │"
    echo "  │  HIVE_PRIMARY_URL=wss://... HIVE_PRIMARY_TOKEN=...   │"
    echo "  └──────────────────────────────────────────────────────┘"
  fi
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
  # Always ensure dependencies are current (git pull may have changed them)
  echo "  Installing dependencies..."
  npm install --silent 2>&1 | tail -1
  echo "  ✓ Dependencies up to date"
fi

# ── Satellite: store config + start ───────────────────────────────────

if [ "$SATELLITE_MODE" -eq 1 ]; then
  # Store primary connection info
  mkdir -p "$HOME/.hive"
  echo "$PRIMARY_URL" > "$HOME/.hive/primary-url"
  echo "$PRIMARY_TOKEN" > "$HOME/.hive/primary-token"
  chmod 600 "$HOME/.hive/primary-url" "$HOME/.hive/primary-token"
  echo "  ✓ Primary connection stored"

  # Stop any existing daemon on port 3001
  if lsof -tiTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "  Stopping existing daemon on :3001..."
    kill "$(lsof -tiTCP:3001 -sTCP:LISTEN)" 2>/dev/null || true
    sleep 2
  fi

  # Unload old satellite plist if present (in case of re-install)
  launchctl bootout "gui/$(id -u)/com.hive.satellite" 2>/dev/null || true

  # Find npx/node paths for the plist. Capture the full PATH so launchd
  # can find node even when installed via nvm, volta, or homebrew.
  NPX_PATH="$(which npx 2>/dev/null || echo '/opt/homebrew/bin/npx')"
  NODE_DIR="$(dirname "$(which node 2>/dev/null || echo '/opt/homebrew/bin/node')")"
  CURRENT_PATH="$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

  # Install launchd plist — survives sleep, reboot, terminal close.
  # Auto-restarts on crash. Reads primary URL/token from stored files.
  mkdir -p "$HOME/.hive/logs" "$HOME/Library/LaunchAgents"
  cat > "$HOME/Library/LaunchAgents/com.hive.satellite.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hive.satellite</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd '$ROOT' &amp;&amp; '$NPX_PATH' tsx apps/daemon/src/index.ts --satellite</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$CURRENT_PATH</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/.hive/logs/satellite.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.hive/logs/satellite.stderr.log</string>
</dict>
</plist>
PLIST
  echo "  ✓ Satellite service installed (com.hive.satellite)"

  # Start the service (try modern API first, fall back to legacy)
  if ! launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.hive.satellite.plist" 2>/dev/null; then
    launchctl load "$HOME/Library/LaunchAgents/com.hive.satellite.plist" 2>/dev/null
  fi

  # Wait for satellite to start
  SAT_OK=0
  for _ in $(seq 1 15); do
    if lsof -tiTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
      SAT_OK=1
      break
    fi
    sleep 1
  done

  if [ "$SAT_OK" -eq 1 ]; then
    echo "  ✓ Satellite daemon running"
  else
    echo "  ✗ Satellite daemon failed to start."
    echo "    Log: cat ~/.hive/logs/satellite.stderr.log"
    echo ""
    tail -10 "$HOME/.hive/logs/satellite.stderr.log" 2>/dev/null | sed 's/^/    /'
    exit 1
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
  echo "  The satellite runs as a background service."
  echo "  It survives sleep, reboot, and terminal close."
  echo "  Agents disappear from the dashboard when this"
  echo "  computer is off and reappear when it wakes."
  echo ""
  echo "  Log:   cat ~/.hive/logs/satellite.stderr.log"
  echo "  Stop:  launchctl bootout gui/$(id -u)/com.hive.satellite"
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
