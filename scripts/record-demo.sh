#!/bin/bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONVERTER="$ROOT/scripts/mov-to-gif.sh"
OUTPUT_GIF="$ROOT/docs/hive-demo.gif"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hive-demo.XXXXXX")"
TMP_MOV="$TMP_DIR/hive-demo.mov"

trap 'rm -rf "$TMP_DIR"' EXIT

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: '$cmd' is required."
    exit 1
  fi
}

require_cmd screencapture
require_cmd ffmpeg

mkdir -p "$(dirname "$OUTPUT_GIF")"

echo "Preparing a 20-second Hive demo recording."
echo "macOS will open the screen recording UI."
echo "Click a display to record full screen, or drag to record a region."
echo "Recording stops automatically after 20 seconds."

if ! screencapture -v -V20 -x "$TMP_MOV"; then
  echo "Recording failed or was canceled."
  echo "If macOS asks for Screen Recording access, allow it in System Settings and rerun the script."
  exit 1
fi

if [ ! -s "$TMP_MOV" ]; then
  echo "Recording completed, but no .mov file was created."
  exit 1
fi

bash "$CONVERTER" "$TMP_MOV" "$OUTPUT_GIF"

echo "Demo GIF written to $OUTPUT_GIF"
