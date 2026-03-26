#!/bin/bash
# Print the one-liner to connect another computer to this Hive network.
#
# Usage:
#   bash scripts/invite.sh          # print the connect command
#   bash scripts/invite.sh --copy   # print + copy to clipboard

set -euo pipefail

HIVE_DIR="$HOME/.hive"
TUNNEL_FILE="$HIVE_DIR/tunnel-url.txt"
TOKEN_FILE="$HIVE_DIR/token"

# ── Validate ─────────────────────────────────────────────────────────

if [ ! -f "$TOKEN_FILE" ]; then
  echo "  No Hive token found at $TOKEN_FILE."
  echo "  Run the install first: bash scripts/install.sh --fresh"
  exit 1
fi

TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null | tr -d '\n')"
if ! echo "$TOKEN" | grep -qE '^[0-9a-f]{64}$'; then
  echo "  Token file exists but content is invalid (expected 64-char hex)."
  echo "  Re-run setup: bash scripts/install.sh --fresh"
  exit 1
fi

if [ ! -f "$TUNNEL_FILE" ]; then
  echo "  No tunnel URL found at $TUNNEL_FILE."
  echo "  Start the daemon first: npm start"
  exit 1
fi

TUNNEL_URL="$(grep -Eo 'https://[^[:space:]]+' "$TUNNEL_FILE" | head -1 || true)"

if [ -z "$TUNNEL_URL" ]; then
  echo "  Tunnel file exists but has no valid URL."
  echo "  Restart the daemon: npm start"
  exit 1
fi

WS_URL="${TUNNEL_URL/https:\/\//wss://}"

# ── Output ───────────────────────────────────────────────────────────

CONNECT_CMD="bash scripts/install.sh --connect $WS_URL $TOKEN"

echo ""
echo "  ┌──────────────────────────────────────────────────────┐"
echo "  │  Connect another computer to this Hive network       │"
echo "  └──────────────────────────────────────────────────────┘"
echo ""
echo "  On the other machine, clone Hive and run:"
echo ""
echo "  git clone https://github.com/RohitMangtani/hive.git"
echo "  cd hive"
echo "  $CONNECT_CMD"
echo ""
echo "  Windows (PowerShell):"
echo ""
echo "  git clone https://github.com/RohitMangtani/hive.git"
echo "  cd hive"
echo "  .\\scripts\\install.ps1 -Connect -Url $WS_URL -Token $TOKEN"
echo ""
echo "  Or paste this into Claude Code / Codex on the other machine:"
echo ""
echo "  Install Hive for me. Clone https://github.com/RohitMangtani/hive."
echo "  Then run: $CONNECT_CMD"
echo "  Give me whatever it prints at the end."
echo ""
echo "  ── Connection is permanent ──"
echo ""
echo "  Once connected, the satellite runs as a background"
echo "  service. It survives sleep, reboot, and terminal"
echo "  close. Agents appear and disappear as the machine"
echo "  wakes and sleeps. The only way to disconnect is to"
echo "  explicitly remove the service."
echo ""

if [ "${1:-}" = "--copy" ]; then
  if command -v pbcopy &>/dev/null; then
    echo "$CONNECT_CMD" | pbcopy
    echo "  Copied to clipboard."
  elif command -v xclip &>/dev/null; then
    echo "$CONNECT_CMD" | xclip -selection clipboard
    echo "  Copied to clipboard."
  elif command -v xsel &>/dev/null; then
    echo "$CONNECT_CMD" | xsel --clipboard
    echo "  Copied to clipboard."
  else
    echo "  (clipboard tool not found — copy manually)"
  fi
  echo ""
fi
