#!/bin/bash
# Hive runtime diagnostics and repair helpers.
#
# Usage:
#   bash scripts/doctor.sh
#   bash scripts/doctor.sh --repair-satellite
#   bash scripts/doctor.sh --repair-daemon

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HIVE_DIR="$HOME/.hive"
RUNTIME_DIR="$HIVE_DIR/runtime"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
UID_STR="$(id -u)"
SAT_PLIST="$LAUNCH_DIR/com.hive.satellite.plist"

print_lock() {
  local name="$1"
  local file="$RUNTIME_DIR/$name.json"
  if [ -f "$file" ]; then
    echo "  $name lock: $(cat "$file" | tr '\n' ' ')"
  else
    echo "  $name lock: none"
  fi
}

print_status() {
  echo ""
  echo "Hive doctor"
  echo ""
  echo "Processes:"
  pgrep -af 'apps/daemon/src/index.ts|dist/index.js' 2>/dev/null || echo "  none"
  echo ""
  echo "Ports:"
  lsof -nP -iTCP:3001 -sTCP:LISTEN 2>/dev/null || echo "  3001: none"
  lsof -nP -iTCP:3002 -sTCP:LISTEN 2>/dev/null || echo "  3002: none"
  echo ""
  echo "Runtime locks:"
  print_lock "daemon"
  print_lock "satellite"
  echo ""
  echo "LaunchAgents:"
  ls "$LAUNCH_DIR"/com.hive.satellite*.plist 2>/dev/null || echo "  none"
  echo ""
  echo "launchctl:"
  launchctl print "gui/$UID_STR/com.hive.satellite" 2>/dev/null | rg 'state =|pid =|program =' || echo "  com.hive.satellite not loaded"
  echo ""
}

repair_satellite() {
  echo "Repairing satellite runtime..."
  mkdir -p "$RUNTIME_DIR" "$LAUNCH_DIR"

  for plist in "$LAUNCH_DIR"/com.hive.satellite*.plist; do
    [ -e "$plist" ] || continue
    label="$(basename "$plist" .plist)"
    launchctl bootout "gui/$UID_STR/$label" 2>/dev/null || launchctl unload "$plist" 2>/dev/null || true
    if [ "$plist" != "$SAT_PLIST" ]; then
      rm -f "$plist"
    fi
  done

  pkill -f 'apps/daemon/src/index.ts --satellite|dist/index.js --satellite' 2>/dev/null || true
  rm -f "$RUNTIME_DIR/satellite.json"

  if [ -f "$SAT_PLIST" ]; then
    if ! launchctl bootstrap "gui/$UID_STR" "$SAT_PLIST" 2>/dev/null; then
      launchctl kickstart -k "gui/$UID_STR/com.hive.satellite" 2>/dev/null || launchctl load "$SAT_PLIST" 2>/dev/null || true
    fi
  fi

  sleep 2
  print_status
}

repair_daemon() {
  echo "Repairing primary daemon runtime..."
  mkdir -p "$RUNTIME_DIR"
  daemon_pids="$(lsof -tiTCP:3001 -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$daemon_pids" ]; then
    echo "$daemon_pids" | xargs kill 2>/dev/null || true
  fi
  ws_pids="$(lsof -tiTCP:3002 -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$ws_pids" ]; then
    echo "$ws_pids" | xargs kill 2>/dev/null || true
  fi
  rm -f "$RUNTIME_DIR/daemon.json"
  sleep 1
  print_status
}

case "${1:---status}" in
  --status)
    print_status
    ;;
  --repair-satellite)
    repair_satellite
    ;;
  --repair-daemon)
    repair_daemon
    ;;
  *)
    echo "Usage: bash scripts/doctor.sh [--status|--repair-satellite|--repair-daemon]"
    exit 1
    ;;
esac
