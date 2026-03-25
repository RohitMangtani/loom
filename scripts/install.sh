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

install_dependencies() {
  local log_file
  log_file="$(mktemp)"

  if npm install --silent >"$log_file" 2>&1; then
    rm -f "$log_file"
    return 0
  fi

  echo ""
  echo "  ✗ Dependency install failed. Last 50 lines:"
  tail -50 "$log_file" 2>/dev/null | sed 's/^/    /'
  rm -f "$log_file"
  exit 1
}

IS_LINUX=0
IS_WSL=0
if [ "$(uname)" = "Linux" ]; then
  IS_LINUX=1
  if grep -qi microsoft /proc/version 2>/dev/null; then
    IS_WSL=1
  fi
fi

cleanup_hive_satellite_runtime() {
  mkdir -p "$HOME/.hive/runtime"

  if [ "$IS_LINUX" -eq 1 ]; then
    # systemd cleanup
    systemctl --user stop hive-satellite.service 2>/dev/null || true
    systemctl --user disable hive-satellite.service 2>/dev/null || true
  else
    # macOS launchd cleanup
    mkdir -p "$HOME/Library/LaunchAgents"
    for plist in "$HOME/Library/LaunchAgents"/com.hive.satellite*.plist; do
      [ -e "$plist" ] || continue
      label="$(basename "$plist" .plist)"
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || launchctl unload "$plist" 2>/dev/null || true
      if [ "$plist" != "$HOME/Library/LaunchAgents/com.hive.satellite.plist" ]; then
        rm -f "$plist"
      fi
    done
  fi

  pkill -f 'apps/daemon/src/index.ts --satellite|dist/index.js --satellite' 2>/dev/null || true
  rm -f "$HOME/.hive/runtime/satellite.json"
}

ensure_tunnel_tools() {
  local have_ngrok=0
  local have_cloudflared=0

  if command -v ngrok &>/dev/null; then
    echo "  ✓ ngrok"
    have_ngrok=1
  fi

  if command -v cloudflared &>/dev/null; then
    echo "  ✓ cloudflared"
    have_cloudflared=1
  fi

  if [ "$have_ngrok" -eq 1 ] && [ "$have_cloudflared" -eq 0 ] && command -v brew &>/dev/null; then
    echo ""
    echo "  Installing cloudflared fallback (keeps hosted launch working if ngrok is unavailable)..."
    brew install cloudflared
    echo "  ✓ cloudflared installed"
    have_cloudflared=1
  fi

  if [ "$have_ngrok" -eq 0 ] && [ "$have_cloudflared" -eq 0 ]; then
    if command -v brew &>/dev/null; then
      echo ""
      echo "  Installing cloudflared (fallback tunnel for remote dashboard access)..."
      brew install cloudflared
      echo "  ✓ cloudflared installed"
      have_cloudflared=1
    else
      echo "  ✗ No public tunnel tool found."
      echo "    Install Homebrew (https://brew.sh), ngrok, or cloudflared and re-run."
      echo "    Or use: npm run launch:local  (localhost only, no remote access)"
      exit 1
    fi
  fi
}

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
  install_dependencies
  echo "  ✓ Dependencies up to date"
fi

# ── Satellite: store config + start ───────────────────────────────────

if [ "$SATELLITE_MODE" -eq 1 ]; then
  # Store primary connection info
  mkdir -p "$HOME/.hive"
  echo "$PRIMARY_URL" > "$HOME/.hive/primary-url"
  {
    echo "$PRIMARY_URL"
    [ -f "$HOME/.hive/primary-urls.txt" ] && cat "$HOME/.hive/primary-urls.txt"
  } | awk 'NF && !seen[$0]++' | head -5 > "$HOME/.hive/primary-urls.txt"
  echo "$PRIMARY_TOKEN" > "$HOME/.hive/primary-token"
  chmod 600 "$HOME/.hive/primary-url" "$HOME/.hive/primary-urls.txt" "$HOME/.hive/primary-token"
  echo "  ✓ Primary connection stored"

  echo "  Cleaning existing Hive satellite runtime..."
  cleanup_hive_satellite_runtime

  # Stop any existing daemon on port 3001
  check_port_3001() {
    if [ "$IS_LINUX" -eq 1 ]; then
      ss -tlnp 2>/dev/null | grep -q ':3001 ' || return 1
    else
      lsof -tiTCP:3001 -sTCP:LISTEN >/dev/null 2>&1 || return 1
    fi
  }

  if check_port_3001; then
    echo "  Stopping existing daemon on :3001..."
    if [ "$IS_LINUX" -eq 1 ]; then
      fuser -k 3001/tcp 2>/dev/null || true
    else
      kill "$(lsof -tiTCP:3001 -sTCP:LISTEN)" 2>/dev/null || true
    fi
    sleep 2
  fi

  # Find npx/node paths for the service
  NPX_PATH="$(which npx 2>/dev/null || echo '/usr/local/bin/npx')"
  NODE_DIR="$(dirname "$(which node 2>/dev/null || echo '/usr/local/bin/node')")"
  mkdir -p "$HOME/.hive/logs"

  if [ "$IS_LINUX" -eq 1 ]; then
    # ── Linux / WSL: systemd user service ────────────────────────────
    CURRENT_PATH="$NODE_DIR:/usr/local/bin:/usr/bin:/bin"

    # Ensure tmux is installed (Linux platform uses tmux for terminal IO)
    if ! command -v tmux &>/dev/null; then
      echo "  Installing tmux (required for terminal management on Linux)..."
      if command -v apt-get &>/dev/null; then
        sudo apt-get install -y tmux 2>/dev/null || true
      elif command -v yum &>/dev/null; then
        sudo yum install -y tmux 2>/dev/null || true
      fi
    fi
    if command -v tmux &>/dev/null; then
      echo "  ✓ tmux"
    else
      echo "  ⚠ tmux not found — install manually for terminal management"
    fi

    # Check if systemd is available (real Linux or WSL2 with systemd)
    HAS_SYSTEMD=0
    if command -v systemctl &>/dev/null && systemctl --user status 2>/dev/null | head -1 | grep -q "State:"; then
      HAS_SYSTEMD=1
    fi

    if [ "$HAS_SYSTEMD" -eq 1 ]; then
      mkdir -p "$HOME/.config/systemd/user"
      cat > "$HOME/.config/systemd/user/hive-satellite.service" <<UNIT
[Unit]
Description=Hive Satellite Daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=PATH=$CURRENT_PATH
Environment=HOME=$HOME
ExecStart=$NPX_PATH tsx apps/daemon/src/index.ts --satellite
Restart=always
RestartSec=5
StandardOutput=append:$HOME/.hive/logs/satellite.stdout.log
StandardError=append:$HOME/.hive/logs/satellite.stderr.log

[Install]
WantedBy=default.target
UNIT
      systemctl --user daemon-reload
      systemctl --user enable hive-satellite.service
      systemctl --user restart hive-satellite.service
      echo "  ✓ Satellite service installed (systemd user service)"

      # Enable lingering so the service runs even when not logged in
      loginctl enable-linger "$(whoami)" 2>/dev/null || true
    else
      # No systemd (WSL1 or minimal container) — use nohup fallback
      echo "  No systemd available — starting satellite in background..."
      nohup "$NPX_PATH" tsx apps/daemon/src/index.ts --satellite \
        > "$HOME/.hive/logs/satellite.stdout.log" \
        2> "$HOME/.hive/logs/satellite.stderr.log" &
      echo $! > "$HOME/.hive/runtime/satellite.pid"
      disown "$!" 2>/dev/null || true
      echo "  ✓ Satellite started (PID $(cat "$HOME/.hive/runtime/satellite.pid"))"
      echo "  ⚠ No systemd — satellite won't auto-start on reboot."
      echo "    Add to ~/.bashrc or crontab:"
      echo "    @reboot cd $ROOT && $NPX_PATH tsx apps/daemon/src/index.ts --satellite"
    fi
  else
    # ── macOS: launchd plist ─────────────────────────────────────────
    launchctl bootout "gui/$(id -u)/com.hive.satellite" 2>/dev/null || true
    CURRENT_PATH="$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

    mkdir -p "$HOME/Library/LaunchAgents"
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
  fi

  # Wait for satellite to start (platform-agnostic)
  SAT_OK=0
  for _ in $(seq 1 15); do
    if check_port_3001; then
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

  # GPU detection report (useful for routing tasks to GPU machines)
  if command -v nvidia-smi &>/dev/null; then
    GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo "")"
    GPU_VRAM="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 || echo "")"
    if [ -n "$GPU_NAME" ]; then
      echo "  ✓ GPU detected: $GPU_NAME (${GPU_VRAM}MB)"
      echo "    Tasks with \"requires\":[\"gpu\"] will route here."
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
  if [ "$IS_LINUX" -eq 1 ]; then
    echo "  Open tmux panes and run 'claude', 'codex',"
    echo "  or any agent — the primary dashboard sees them."
    echo "  (Hive uses tmux for terminal management on Linux.)"
  else
    echo "  Open Terminal windows and run 'claude', 'codex',"
    echo "  or any agent — the primary dashboard sees them."
  fi
  echo ""
  echo "  The satellite runs as a background service."
  echo "  It survives sleep, reboot, and terminal close."
  echo "  Agents disappear from the dashboard when this"
  echo "  computer is off and reappear when it wakes."
  echo ""
  if [ "$IS_LINUX" -eq 0 ]; then
    echo "  ⚠  If macOS asks you to approve Node.js in"
    echo "     System Settings → Privacy & Security,"
    echo "     click Allow. This is a one-time approval"
    echo "     so the background service can run."
    echo ""
  fi
  echo "  Log:   cat ~/.hive/logs/satellite.stderr.log"
  if [ "$IS_LINUX" -eq 1 ] && [ "$HAS_SYSTEMD" -eq 1 ]; then
    echo "  Stop:  systemctl --user stop hive-satellite"
  elif [ "$IS_LINUX" -eq 0 ]; then
    echo "  Stop:  launchctl bootout gui/$(id -u)/com.hive.satellite"
  fi
  echo ""
  echo "  ────────────────────────────────────────────────"
  echo ""
  exit 0
fi

# ══════════════════════════════════════════════════════════════════════
# Primary mode (default) — unchanged from original install flow
# ══════════════════════════════════════════════════════════════════════

# ── 2. Tunnel tooling ────────────────────────────────────────────────

ensure_tunnel_tools

# ── 3. Vercel login ──────────────────────────────────────────────────

if ! npx vercel whoami >/dev/null 2>&1; then
  echo ""
  echo "  Logging into Vercel (this opens your browser — click authorize)..."
  npx vercel login
fi
echo "  ✓ Vercel authenticated"

# ── 4. Start daemon + tunnel ──────────────────────────────────────────

DAEMON_START_MODE="existing"

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
    DAEMON_START_MODE="terminal_window"
  else
    # Fallback: background process (X button won't close terminal windows)
    echo "  Could not open Terminal window — starting in background..."
    nohup npm start > "$HOME/.hive/daemon.log" 2>&1 &
    disown "$!" 2>/dev/null || true
    echo "  ✓ Daemon started in background (log: ~/.hive/daemon.log)"
    DAEMON_START_MODE="background"
  fi
fi

# ── 5. Wait for tunnel URL ───────────────────────────────────────────

echo "  Waiting for tunnel..."
TUNNEL_URL=""
for _ in $(seq 1 90); do
  if [ -f "$HOME/.hive/tunnel-url.txt" ]; then
    TUNNEL_URL="$(grep -Eo 'https://[^[:space:]]+' "$HOME/.hive/tunnel-url.txt" | head -1 || true)"
    if [ -n "$TUNNEL_URL" ]; then
      break
    fi
  fi
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  echo "  ✗ Timed out waiting for tunnel."
  if [ "$DAEMON_START_MODE" = "terminal_window" ]; then
    echo "    Check the Terminal window Hive opened for daemon output."
  elif [ "$DAEMON_START_MODE" = "background" ]; then
    echo "    Check ~/.hive/daemon.log for daemon output."
  fi
  echo "    Tunnel logs: ~/.hive/ngrok.log or ~/.hive/cloudflared.log"
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
if [ "$DAEMON_START_MODE" = "terminal_window" ]; then
  echo "  The daemon is running in a separate Terminal window."
  echo "  Keep that window open while Hive is running."
  echo ""
elif [ "$DAEMON_START_MODE" = "background" ]; then
  echo "  The daemon is running in the background."
  echo "  Log: ~/.hive/daemon.log"
  echo ""
else
  echo "  The daemon was already running on :3001."
  echo ""
fi
echo "  ── Connect another machine ──"
echo ""
echo "  On the other computer, clone Hive and run:"
echo ""
echo "  git clone https://github.com/RohitMangtani/hive.git"
echo "  cd hive"
echo "  bash scripts/install.sh --connect $WS_URL $TOKEN"
echo ""
echo "  Or paste this into Claude Code / Codex on the other machine:"
echo ""
echo "  Install Hive for me. Clone https://github.com/RohitMangtani/hive."
echo "  Then run: bash scripts/install.sh --connect $WS_URL $TOKEN"
echo "  Give me whatever it prints at the end."
echo ""
echo "  Connection is permanent. The satellite runs as a"
echo "  background service and survives sleep and reboot."
echo ""
echo "  To get this invite again later: npm run invite"
echo ""
echo "  Tunnel logs: ~/.hive/ngrok.log or ~/.hive/cloudflared.log"
echo "  Stop: kill \$(lsof -tiTCP:3001)"
echo ""
echo "  ────────────────────────────────────────────────"
echo ""
