#!/usr/bin/env bash
# Regenerates every app icon size and the menu bar template icon from the hand-authored SVGs in
# desktop/icons-src/ (the only icon sources; the PNG/ICNS/ICO files are build outputs, committed
# so a fresh checkout builds without this step).
#
#   scripts/build-icons.sh
#
# Needs the Tauri CLI (`cargo tauri`), which renders SVG itself (resvg): no other tools.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/desktop/icons-src"
OUT="$ROOT/desktop/src-tauri/icons"
# shellcheck disable=SC1091
[[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# App icon: only the files tauri.conf.json bundles (plus icon.ico for Windows builds).
cargo tauri icon "$SRC/icon.svg" -o "$TMP/app" >"$TMP/log" 2>&1 || { cat "$TMP/log"; exit 1; }
for f in 32x32.png 64x64.png 128x128.png 128x128@2x.png icon.icns icon.ico icon.png; do
  cp "$TMP/app/$f" "$OUT/$f"
done

# Menu bar icon: a black + alpha template, 18 pt (18 px @1x, 36 px @2x).
cargo tauri icon "$SRC/tray-template.svg" -p 18 -p 36 -o "$TMP/tray" >"$TMP/log" 2>&1 || { cat "$TMP/log"; exit 1; }
cp "$TMP/tray/18x18.png" "$OUT/tray-template.png"
cp "$TMP/tray/36x36.png" "$OUT/tray-template@2x.png"

echo "icons written to ${OUT#"$ROOT"/}"
