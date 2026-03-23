#!/bin/bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HTML_PATH="$ROOT/docs/demo/hive-demo.html"
OUTPUT_GIF="$ROOT/docs/hive-demo.gif"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hive-demo-render.XXXXXX")"
FRAMES_DIR="$TMP_DIR/frames"
PALETTE_PATH="$TMP_DIR/palette.png"

trap 'rm -rf "$TMP_DIR"' EXIT

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: '$cmd' is required."
    exit 1
  fi
}

detect_chrome() {
  local candidate
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

build_file_url() {
  node -e '
    const { pathToFileURL } = require("url");
    const fileUrl = pathToFileURL(process.argv[1]);
    const time = process.argv[2];
    if (time !== "") {
      fileUrl.searchParams.set("t", time);
      fileUrl.searchParams.set("capture", "1");
    }
    console.log(fileUrl.href);
  ' "$HTML_PATH" "${1:-}"
}

render_with_playwright() {
  local index
  local frame_id
  local frame_path
  local frame_url

  for index in $(seq 0 39); do
    printf -v frame_id "%03d" "$index"
    frame_path="$FRAMES_DIR/frame-$frame_id.png"
    frame_url="$(build_file_url "$((index * 500))")"

    npx playwright screenshot \
      --channel chrome \
      --color-scheme dark \
      --viewport-size 520,920 \
      --wait-for-timeout 100 \
      "$frame_url" \
      "$frame_path" >/dev/null
  done
}

render_with_screencapture() {
  local chrome_path="$1"
  local chrome_url
  local chrome_pid
  local index

  require_cmd screencapture

  chrome_url="$(build_file_url "")"

  mkdir -p "$FRAMES_DIR"
  "$chrome_path" \
    --user-data-dir="$TMP_DIR/chrome-profile" \
    --new-window \
    --app="$chrome_url" \
    --window-position=80,40 \
    --window-size=520,920 >/dev/null 2>&1 &
  chrome_pid="$!"
  sleep 2

  for index in $(seq 0 39); do
    printf -v frame_id "%03d" "$index"
    screencapture -x -R80,40,520,920 "$FRAMES_DIR/frame-$frame_id.png"
    sleep 0.5
  done

  kill "$chrome_pid" 2>/dev/null || true
}

encode_gif() {
  mkdir -p "$(dirname "$OUTPUT_GIF")"

  ffmpeg -v error -y \
    -framerate 2 \
    -i "$FRAMES_DIR/frame-%03d.png" \
    -vf "fps=10,scale=400:-1:flags=lanczos,palettegen=stats_mode=diff" \
    -frames:v 1 \
    -update 1 \
    "$PALETTE_PATH"

  ffmpeg -v error -y \
    -framerate 2 \
    -i "$FRAMES_DIR/frame-%03d.png" \
    -i "$PALETTE_PATH" \
    -lavfi "fps=10,scale=400:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a" \
    -loop 0 \
    "$OUTPUT_GIF"
}

require_cmd ffmpeg
require_cmd node

if [ ! -f "$HTML_PATH" ]; then
  echo "Error: demo HTML not found at $HTML_PATH"
  exit 1
fi

mkdir -p "$FRAMES_DIR"

if chrome_path="$(detect_chrome)"; then
  if command -v npx >/dev/null 2>&1 && npx playwright --version >/dev/null 2>&1; then
    if ! render_with_playwright; then
      echo "Playwright render failed. Falling back to Chrome + screencapture."
      render_with_screencapture "$chrome_path"
    fi
  else
    echo "Playwright CLI is unavailable. Falling back to Chrome + screencapture."
    render_with_screencapture "$chrome_path"
  fi
else
  echo "Error: no supported Chrome-based browser found."
  exit 1
fi

encode_gif

echo "GIF written to $OUTPUT_GIF"
