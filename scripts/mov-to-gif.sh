#!/bin/bash

set -euo pipefail

usage() {
  echo "Usage: bash scripts/mov-to-gif.sh input.mov [output.gif]"
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: '$cmd' is required."
    exit 1
  fi
}

if [ $# -eq 0 ]; then
  usage
  exit 1
fi

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac

INPUT="$1"
OUTPUT="${2:-${INPUT%.*}.gif}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hive-gif.XXXXXX")"
PALETTE="$TMP_DIR/palette.png"
FILTER_CHAIN="fps=15,scale=800:-1:flags=lanczos"

trap 'rm -rf "$TMP_DIR"' EXIT

require_cmd ffmpeg

if [ ! -f "$INPUT" ]; then
  echo "Error: input file not found: $INPUT"
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT")"

ffmpeg -v warning -y \
  -i "$INPUT" \
  -vf "${FILTER_CHAIN},palettegen=stats_mode=diff" \
  -frames:v 1 \
  -update 1 \
  "$PALETTE"

ffmpeg -v warning -y \
  -i "$INPUT" \
  -i "$PALETTE" \
  -lavfi "[0:v]${FILTER_CHAIN}[x];[x][1:v]paletteuse=dither=sierra2_4a" \
  -loop 0 \
  "$OUTPUT"

echo "GIF written to $OUTPUT"
