#!/bin/bash
# One-time setup: install or update Loom hooks in ~/.claude/settings.json.
# Run: bash setup-hooks.sh

set -e

if ! command -v claude &>/dev/null; then
  echo "Claude Code not found. Skipping Claude hook installation."
  echo "Install it later with: npm install -g @anthropic-ai/claude-code"
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
SETTINGS="$HOME/.claude/settings.json"
HIVE_DIR="$HOME/.hive"
TOKEN_PATH="$HIVE_DIR/token"
VIEWER_PATH="$HIVE_DIR/viewer-token"
IDENTITY_SRC="$REPO_ROOT/apps/daemon/src/hooks/identity.sh"
IDENTITY_DST="$HIVE_DIR/identity.sh"
AUTO_APPROVE_CMD="$REPO_ROOT/apps/daemon/src/hooks/auto-approve.sh"
DAEMON_URL="${HIVE_DAEMON_URL:-http://localhost:3001}"

mkdir -p "$HOME/.claude" "$HIVE_DIR"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"

if [ ! -f "$IDENTITY_SRC" ]; then
  echo "Missing identity hook source: $IDENTITY_SRC"
  exit 1
fi

cp "$IDENTITY_SRC" "$IDENTITY_DST"
chmod +x "$IDENTITY_DST"

if [ ! -f "$TOKEN_PATH" ]; then
  node <<'NODE'
const { randomBytes, createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

const home = process.env.HOME;
const dir = path.join(home, '.hive');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const token = randomBytes(32).toString('hex');
fs.writeFileSync(path.join(dir, 'token'), token + '\n', { mode: 0o600 });
const viewer = createHash('sha256').update(token + ':viewer').digest('hex');
fs.writeFileSync(path.join(dir, 'viewer-token'), viewer + '\n', { mode: 0o600 });
NODE
fi

if [ ! -f "$VIEWER_PATH" ]; then
  node <<'NODE'
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

const home = process.env.HOME;
const dir = path.join(home, '.hive');
const token = fs.readFileSync(path.join(dir, 'token'), 'utf-8').trim();
const viewer = createHash('sha256').update(token + ':viewer').digest('hex');
fs.writeFileSync(path.join(dir, 'viewer-token'), viewer + '\n', { mode: 0o600 });
NODE
fi

TOKEN=$(tr -d '\n' < "$TOKEN_PATH")
if [ -z "$TOKEN" ]; then
  echo "Failed to read $TOKEN_PATH"
  exit 1
fi

SETTINGS="$SETTINGS" \
IDENTITY_CMD="$IDENTITY_DST" \
AUTO_APPROVE_CMD="$AUTO_APPROVE_CMD" \
DAEMON_URL="$DAEMON_URL" \
HIVE_TOKEN="$TOKEN" \
node <<'NODE'
const fs = require('fs');

const settingsPath = process.env.SETTINGS;
const identityCmd = process.env.IDENTITY_CMD;
const autoApproveCmd = process.env.AUTO_APPROVE_CMD;
const daemonUrl = process.env.DAEMON_URL;
const token = process.env.HIVE_TOKEN;
const authedHookUrl = `${daemonUrl}/hook?token=${token}`;

const raw = fs.readFileSync(settingsPath, 'utf-8');
const settings = raw.trim() ? JSON.parse(raw) : {};
const hooks = (settings.hooks && typeof settings.hooks === 'object') ? settings.hooks : {};

function ensureEntry(event) {
  const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
  let entry = entries.find((candidate) => (candidate?.matcher ?? '') === '');
  if (!entry) {
    entry = { matcher: '', hooks: [] };
    entries.push(entry);
  }
  if (!Array.isArray(entry.hooks)) {
    entry.hooks = [];
  }
  hooks[event] = entries;
  return entry;
}

function dedupeExact(entry) {
  const seen = new Set();
  entry.hooks = entry.hooks.filter((hook) => {
    const key = hook.type === 'http'
      ? `http:${hook.url || ''}`
      : `command:${hook.command || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function upsertHook(event, candidate, matchesLogicalHook) {
  const entry = ensureEntry(event);
  let replaced = false;
  const nextHooks = [];
  for (const hook of entry.hooks) {
    if (matchesLogicalHook(hook)) {
      if (!replaced) {
        nextHooks.push(candidate);
        replaced = true;
      }
      continue;
    }
    nextHooks.push(hook);
  }
  if (!replaced) {
    nextHooks.push(candidate);
  }
  entry.hooks = nextHooks;
  dedupeExact(entry);
}

const isHiveHttpHook = (hook) =>
  hook?.type === 'http' &&
  typeof hook.url === 'string' &&
  hook.url.startsWith(`${daemonUrl}/hook`);

const isIdentityHook = (hook) =>
  hook?.type === 'command' &&
  typeof hook.command === 'string' &&
  hook.command.includes('.hive/identity.sh');

const isAutoApproveHook = (hook) =>
  hook?.type === 'command' &&
  typeof hook.command === 'string' &&
  hook.command.includes('auto-approve.sh');

upsertHook('UserPromptSubmit', { type: 'command', command: identityCmd }, isIdentityHook);
upsertHook('UserPromptSubmit', { type: 'http', url: authedHookUrl }, isHiveHttpHook);
upsertHook('Notification', { type: 'http', url: authedHookUrl }, isHiveHttpHook);
upsertHook('PreToolUse', { type: 'command', command: autoApproveCmd }, isAutoApproveHook);
upsertHook('PreToolUse', { type: 'http', url: authedHookUrl }, isHiveHttpHook);
upsertHook('PostToolUse', { type: 'http', url: authedHookUrl }, isHiveHttpHook);
upsertHook('Stop', { type: 'http', url: authedHookUrl }, isHiveHttpHook);

settings.hooks = hooks;
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

console.log(`Updated ${settingsPath}`);
console.log('Installed Loom hooks for UserPromptSubmit, PreToolUse, PostToolUse, Notification, and Stop.');
console.log(`Identity hook: ${identityCmd}`);
console.log(`Auto-approve hook: ${autoApproveCmd}`);
NODE
