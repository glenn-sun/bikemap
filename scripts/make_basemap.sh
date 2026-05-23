#!/usr/bin/env bash
# Extract a Seattle-area basemap from the global Protomaps PMTiles.
#
# Requires: pmtiles (brew install pmtiles)
# Bbox covers Seattle + Eastside + buffer so King County regional trails are visible.
# Pick a recent build date from https://build.protomaps.com/ — they only keep
# a rolling few days online.

set -euo pipefail

BUILD_DATE="${1:-20260521}"
OUT="public/tiles/seattle.pmtiles"

mkdir -p "$(dirname "$OUT")"

pmtiles extract \
  "https://build.protomaps.com/${BUILD_DATE}.pmtiles" \
  "$OUT" \
  --bbox=-122.55,47.40,-121.95,47.85 \
  --maxzoom=15

ls -lh "$OUT"
