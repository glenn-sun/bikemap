#!/usr/bin/env bash
# Rasterize public/icons/bikemap.svg into the PNG sizes the PWA manifest +
# Apple/Android home-screen icons need.
#
# The SVG is self-contained: every visible shape (including the "OBMS"
# wordmark) is encoded as a vector <path>, so rasterization needs no fonts
# and produces identical output on any machine. If you ever re-edit the
# SVG with live <text>, convert text to paths (Inkscape: Object to Path,
# or --export-text-to-path) before committing.
#
# Requires: brew install librsvg  (provides rsvg-convert)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVG="$ROOT/public/icons/bikemap.svg"
OUT="$ROOT/public/icons"

if ! command -v rsvg-convert >/dev/null; then
  echo "ERROR: rsvg-convert not found. Install with: brew install librsvg" >&2
  exit 1
fi

if [ ! -f "$SVG" ]; then
  echo "ERROR: $SVG not found." >&2
  exit 1
fi

mkdir -p "$OUT"

NOCLIP="$ROOT/scripts/no-clip.css"

# Square outputs: apple-touch-icon (180), manifest 'any' (192/512), and
# manifest 'maskable' (512). Apple + Android maskable need the full pink
# canvas (each platform applies its own corner masking on top); the
# no-clip stylesheet cancels the SVG's default circular clipPath.
for SIZE in 180 192 512; do
  rsvg-convert --stylesheet="$NOCLIP" -w "$SIZE" -h "$SIZE" "$SVG" -o "$OUT/icon-$SIZE.png"
done
cp "$OUT/icon-512.png" "$OUT/icon-512-maskable.png"

# Circle outputs: favicon (32) + the larger in-app uses (modal hero,
# title bar). Render WITHOUT the no-clip stylesheet so the clipPath
# applies — corners come out transparent.
rsvg-convert -w 32  -h 32  "$SVG" -o "$OUT/icon-circle-32.png"
rsvg-convert -w 192 -h 192 "$SVG" -o "$OUT/icon-circle-192.png"

echo "Icons written to $OUT:"
ls -lh "$OUT"
