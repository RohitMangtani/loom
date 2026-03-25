#!/bin/bash
# Hive Satellite Setup for Windows (WSL2)
#
# Run this INSIDE WSL2 (Ubuntu). It installs everything needed to
# connect your Windows gaming PC to the Hive network.
#
# Prerequisites (run in PowerShell as admin FIRST):
#   wsl --install
#   # Then install NVIDIA WSL2 drivers from:
#   # https://developer.nvidia.com/cuda/wsl
#   # (Regular GeForce Game Ready drivers 525+ include WSL2 support)
#
# Usage:
#   bash setup-windows-satellite.sh <primary-url> <token>
#
# Example:
#   bash setup-windows-satellite.sh wss://hive-xyz.trycloudflare.com abc123...

set -euo pipefail

PRIMARY_URL="${1:-}"
TOKEN="${2:-}"

if [ -z "$PRIMARY_URL" ] || [ -z "$TOKEN" ]; then
  echo "Usage: bash setup-windows-satellite.sh <primary-wss-url> <token>"
  echo ""
  echo "Get these from your Mac Mini:"
  echo "  URL:   cat ~/.hive/primary-url   (or your Cloudflare tunnel URL)"
  echo "  Token: cat ~/.hive/token"
  exit 1
fi

echo "=== Hive Satellite Setup for Windows/WSL2 ==="
echo ""

# 1. System packages
echo "[1/8] Installing system packages..."
sudo apt-get update -qq
sudo apt-get install -y -qq tmux git curl build-essential

# 2. Node.js (via nvm)
echo "[2/8] Installing Node.js..."
if ! command -v node &>/dev/null; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install 22
  nvm use 22
else
  echo "  Node.js already installed: $(node --version)"
fi

# 3. Claude Code
echo "[3/8] Installing Claude Code..."
if ! command -v claude &>/dev/null; then
  npm install -g @anthropic-ai/claude-code
else
  echo "  Claude Code already installed"
fi

# 4. Clone hive repo
echo "[4/8] Setting up Hive..."
HIVE_DIR="$HOME/hive"
if [ ! -d "$HIVE_DIR" ]; then
  git clone https://github.com/RohitMangtani/hive.git "$HIVE_DIR"
else
  echo "  Hive repo already exists at $HIVE_DIR"
  cd "$HIVE_DIR" && git pull --ff-only || true
fi

cd "$HIVE_DIR"
npm install

# 5. Build daemon
echo "[5/8] Building daemon..."
npm run build --workspace=apps/daemon

# 6. GPU check
echo "[6/8] Checking GPU..."
if command -v nvidia-smi &>/dev/null; then
  echo "  GPU detected:"
  nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
else
  echo "  WARNING: nvidia-smi not found."
  echo "  Install NVIDIA WSL2 drivers from https://developer.nvidia.com/cuda/wsl"
  echo "  (Your regular Windows GeForce drivers 525+ should include WSL2 support)"
fi

# 7. Create Hive config directory
echo "[7/8] Configuring Hive..."
mkdir -p "$HOME/.hive"

# Store primary connection info
echo "$PRIMARY_URL" > "$HOME/.hive/primary-url"
echo "$TOKEN" > "$HOME/.hive/primary-token"
chmod 600 "$HOME/.hive/primary-token"

# Generate local token for hook auth
LOCAL_TOKEN=$(openssl rand -hex 32)
echo "$LOCAL_TOKEN" > "$HOME/.hive/token"
chmod 600 "$HOME/.hive/token"

# 8. Create startup script
echo "[8/8] Creating startup script..."
cat > "$HOME/.hive/start-satellite.sh" << 'STARTUP'
#!/bin/bash
# Start Hive satellite in tmux
cd ~/hive

PRIMARY_URL=$(cat ~/.hive/primary-url)
TOKEN=$(cat ~/.hive/primary-token)

# Ensure tmux session exists
tmux has-session -t hive 2>/dev/null || tmux new-session -d -s hive -n swarm

# Start satellite
exec npx tsx apps/daemon/src/index.ts --satellite "$PRIMARY_URL" "$TOKEN"
STARTUP
chmod +x "$HOME/.hive/start-satellite.sh"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "GPU:     $(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo 'not detected')"
echo "Node:    $(node --version)"
echo "Claude:  $(claude --version 2>/dev/null || echo 'installed')"
echo "Hive:    $HIVE_DIR"
echo ""
echo "To start the satellite:"
echo "  tmux new -s hive"
echo "  bash ~/.hive/start-satellite.sh"
echo ""
echo "Or run directly:"
echo "  cd ~/hive && npx tsx apps/daemon/src/index.ts --satellite '$PRIMARY_URL' '$TOKEN'"
echo ""
echo "The gaming PC will appear in the Hive dashboard as a new machine."
echo "You can spawn agents on it and dispatch GPU tasks from any terminal."
