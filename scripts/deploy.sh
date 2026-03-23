#!/bin/zsh
# Hive deploy pipeline: typecheck → test → build → push → restart daemon
# Usage: ./scripts/deploy.sh [commit message]
#   If no commit message, skips git commit/push (just rebuilds + restarts)

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

step() { echo "${GREEN}[deploy]${NC} $1"; }
warn() { echo "${YELLOW}[deploy]${NC} $1"; }
fail() { echo "${RED}[deploy]${NC} $1"; exit 1; }

# 1. Type-check daemon
step "Type-checking daemon..."
cd "$ROOT/apps/daemon"
npx tsc --noEmit || fail "Daemon type-check failed"

# 2. Run daemon tests
step "Running daemon tests..."
npx vitest run --reporter=verbose 2>&1 | tail -20
if [ ${pipestatus[1]} -ne 0 ]; then
  fail "Daemon tests failed"
fi

# 3. Build daemon (compile TS → dist/)
step "Building daemon..."
npx tsc || fail "Daemon build failed"

# 4. Build dashboard
step "Building dashboard..."
cd "$ROOT/apps/dashboard"
npx next build 2>&1 | tail -5 || fail "Dashboard build failed"

# 5. Git commit + push (if message provided)
cd "$ROOT"
if [ $# -gt 0 ]; then
  MSG="$*"
  step "Committing: $MSG"
  git add -A
  if git diff --cached --quiet; then
    warn "No changes to commit"
  else
    git commit -m "$MSG

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
    step "Pushing to origin..."
    git push
  fi
else
  warn "No commit message — skipping git push"
fi

# 6. Restart daemon
step "Restarting daemon..."
launchctl stop com.hive.daemon 2>/dev/null || true
sleep 1
launchctl start com.hive.daemon 2>/dev/null || true
sleep 2

# 7. Verify daemon is up
TOKEN=$(cat ~/.hive/token 2>/dev/null || echo "")
if [ -n "$TOKEN" ]; then
  WORKERS=$(curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3001/api/workers 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
  step "Daemon up — $WORKERS workers detected"
else
  warn "Could not verify daemon (no token)"
fi

step "Deploy complete"
