#!/bin/bash
# Deploy the dashboard to the user's Vercel account using the current
# Cloudflare quick tunnel as NEXT_PUBLIC_WS_URL.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TUNNEL_FILE="$HOME/.hive/tunnel-url.txt"
DRY_RUN=0

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

if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "Dry run only. Would execute:"
  echo "  cd \"$ROOT/apps/dashboard\""
  echo "  npx vercel deploy --prod --yes -b NEXT_PUBLIC_WS_URL=$WS_URL -e NEXT_PUBLIC_WS_URL=$WS_URL"
  exit 0
fi

if ! npx vercel whoami >/dev/null 2>&1; then
  echo "Vercel login required."
  echo "Run 'npx vercel login' and then rerun this script."
  exit 1
fi

cd "$ROOT/apps/dashboard"
npx vercel deploy --prod --yes \
  -b "NEXT_PUBLIC_WS_URL=$WS_URL" \
  -e "NEXT_PUBLIC_WS_URL=$WS_URL"
