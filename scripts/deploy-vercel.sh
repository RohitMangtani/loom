#!/bin/bash
# Deploy the dashboard to the user's Vercel account using the current
# Cloudflare quick tunnel as NEXT_PUBLIC_WS_URL.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TUNNEL_FILE="$HOME/.hive/tunnel-url.txt"
DASHBOARD_FILE="$HOME/.hive/dashboard-url.txt"
DRY_RUN=0
ROOT_VERCEL_DIR="$ROOT/.vercel"
DASHBOARD_VERCEL_DIR="$ROOT/apps/dashboard/.vercel"
TEMP_ROOT_LINK=0

cleanup() {
  if [ "$TEMP_ROOT_LINK" -eq 1 ]; then
    rm -rf "$ROOT_VERCEL_DIR"
  fi
}

trap cleanup EXIT

if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
fi

if [ ! -f "$TUNNEL_FILE" ]; then
  echo "No tunnel URL found at $TUNNEL_FILE"
  echo "Start Hive with 'npm start' first so cloudflared can create a public WebSocket URL."
  exit 1
fi

TUNNEL_URL="$(grep -Eo 'https://[-a-z0-9.]+trycloudflare.com' "$TUNNEL_FILE" | head -n 1 || true)"
if [ -z "$TUNNEL_URL" ]; then
  TUNNEL_URL="$(tr -d '\n' < "$TUNNEL_FILE")"
fi

if [[ ! "$TUNNEL_URL" =~ ^https://[-a-z0-9.]+trycloudflare\.com$ ]]; then
  echo "Could not parse a Cloudflare quick tunnel URL from $TUNNEL_FILE"
  echo "Current contents:"
  cat "$TUNNEL_FILE"
  exit 1
fi

WS_URL="${TUNNEL_URL/https:\/\//wss://}"

echo "Using tunnel URL: $TUNNEL_URL"
echo "Using WebSocket URL: $WS_URL"
echo "Keep 'npm start' running while you use the deployed dashboard."

if [ ! -d "$ROOT_VERCEL_DIR" ] && [ -d "$DASHBOARD_VERCEL_DIR" ]; then
  mkdir -p "$ROOT_VERCEL_DIR"
  cp "$DASHBOARD_VERCEL_DIR"/project.json "$ROOT_VERCEL_DIR"/project.json
  [ -f "$DASHBOARD_VERCEL_DIR/README.txt" ] && cp "$DASHBOARD_VERCEL_DIR/README.txt" "$ROOT_VERCEL_DIR/README.txt"
  TEMP_ROOT_LINK=1
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "Dry run only. Would execute:"
  echo "  cd \"$ROOT\""
  echo "  npx vercel deploy --prod --yes -b NEXT_PUBLIC_WS_URL=$WS_URL -e NEXT_PUBLIC_WS_URL=$WS_URL"
  exit 0
fi

if ! npx vercel whoami >/dev/null 2>&1; then
  echo "Vercel login required."
  echo "Run 'npx vercel login' and then rerun this script."
  exit 1
fi

cd "$ROOT"

# Link project on first deploy so Vercel knows which scope/team to use
if [ ! -f "$ROOT_VERCEL_DIR/project.json" ]; then
  echo "Linking Vercel project..."
  npx vercel link --yes
fi
DEPLOY_LOG="$(mktemp)"
npx vercel deploy --prod --yes \
  -b "NEXT_PUBLIC_WS_URL=$WS_URL" \
  -e "NEXT_PUBLIC_WS_URL=$WS_URL" 2>&1 | tee "$DEPLOY_LOG"

DEPLOY_URL="$(grep -Eo 'https://[[:alnum:].-]+\.vercel\.app' "$DEPLOY_LOG" | tail -n 1 || true)"
rm -f "$DEPLOY_LOG"

if [ -n "$DEPLOY_URL" ]; then
  echo "$DEPLOY_URL" > "$DASHBOARD_FILE"
  echo "Dashboard URL: $DEPLOY_URL"
fi
