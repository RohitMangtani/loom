#!/bin/bash
# Hive setup — run once after cloning.
# Usage: bash setup.sh

set -e

echo ""
echo "  Setting up Hive..."
echo ""

# ── Check prerequisites ──────────────────────────────────────────────

if ! command -v node &>/dev/null; then
  echo "  ✗ Node.js not found. Install it: https://nodejs.org (v20+)"
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "  ✗ Node.js $NODE_MAJOR found, need 20+. Update: https://nodejs.org"
  exit 1
fi
echo "  ✓ Node.js $(node -v)"

HAS_CLAUDE=0
HAS_CODEX=0

if command -v claude &>/dev/null; then
  HAS_CLAUDE=1
fi

if command -v codex &>/dev/null; then
  HAS_CODEX=1
fi

if [ "$HAS_CLAUDE" -eq 0 ] && [ "$HAS_CODEX" -eq 0 ]; then
  echo "  ✗ No supported CLI found."
  echo "    Install at least one:"
  echo "      Claude Code: npm install -g @anthropic-ai/claude-code"
  echo "      Codex:       npm install -g @openai/codex"
  exit 1
fi

if [ "$HAS_CLAUDE" -eq 1 ]; then
  echo "  ✓ Claude Code"
fi

if [ "$HAS_CODEX" -eq 1 ]; then
  echo "  ✓ Codex"
fi

if ! command -v swiftc &>/dev/null; then
  echo "  ✗ swiftc not found. Install Xcode Command Line Tools: xcode-select --install"
  exit 1
fi
echo "  ✓ Swift compiler"

# ── Install dependencies ─────────────────────────────────────────────

echo ""
echo "  Installing dependencies..."
npm install --silent 2>&1 | tail -1
echo "  ✓ Dependencies installed"

# ── Compile send-return binary (auto-pilot needs this) ───────────────

if [ ! -f "$HOME/send-return" ]; then
  echo ""
  echo "  Compiling send-return binary..."
  swiftc -o "$HOME/send-return" tools/send-return.swift
  chmod +x "$HOME/send-return"
  echo "  ✓ ~/send-return compiled"
  echo ""
  echo "  ⚠  Grant Accessibility permission to ~/send-return"
  echo "     System Settings → Privacy & Security → Accessibility"
  echo "     Drag ~/send-return into the list and enable it."
  echo ""
else
  echo "  ✓ ~/send-return already exists"
fi

# ── Create Hive auth token ───────────────────────────────────────────

echo ""
echo "  Preparing Hive auth..."
node <<'NODE'
const { randomBytes, createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

const dir = path.join(process.env.HOME, '.hive');
const tokenPath = path.join(dir, 'token');
const viewerPath = path.join(dir, 'viewer-token');

fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

let token = '';
if (fs.existsSync(tokenPath)) {
  token = fs.readFileSync(tokenPath, 'utf-8').trim();
}

if (!/^[a-f0-9]{64}$/.test(token)) {
  token = randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
}

const viewer = createHash('sha256').update(token + ':viewer').digest('hex');
fs.writeFileSync(viewerPath, viewer + '\n', { mode: 0o600 });
NODE
echo "  ✓ ~/.hive/token ready"

# ── Set up Claude Code hooks (if Claude is installed) ───────────────

if [ "$HAS_CLAUDE" -eq 1 ]; then
  bash setup-hooks.sh
  echo "  ✓ Claude Code hooks configured"
else
  echo "  • Claude Code not installed — skipping Claude hook setup"
fi

# ── Create .env from template ────────────────────────────────────────

if [ ! -f .env ]; then
  cp .env.example .env
  echo "  ✓ .env created from template"
else
  echo "  ✓ .env already exists"
fi

# ── Done ─────────────────────────────────────────────────────────────

echo ""
echo "  ┌─────────────────────────────────────────┐"
echo "  │  Hive is ready.                         │"
echo "  │                                         │"
echo "  │  Fastest local path:                    │"
echo "  │    npm run launch                       │"
echo "  │                                         │"
echo "  │  Hosted dashboard (Vercel):             │"
echo "  │    npm start                            │"
echo "  │    npm run deploy:dashboard             │"
echo "  │                                         │"
echo "  │  Then open 1-4 Terminal windows and run │"
echo "  │  'claude' and/or 'codex'. The daemon    │"
echo "  │  auto-discovers supported CLIs in ~3s.  │"
echo "  └─────────────────────────────────────────┘"
echo ""
