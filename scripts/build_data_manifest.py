#!/usr/bin/env python3
"""Emit public/data/version.json — the manifest the PWA's install + update
flows consume to know which files to download and whether the local copy
is current.

Run this LAST in the data refresh pipeline:

    python3 scripts/fetch_data.py
    python3 scripts/build_graph.py
    python3 scripts/sample_dtm.py
    python3 scripts/resolve_elevation.py
    python3 scripts/build_addr_index.py
    python3 scripts/build_data_manifest.py     # <-- this

Output schema:
{
  "version": "20260525-150412",          # bump every time any file changes
  "generatedAt": 1748185452,             # unix epoch
  "totalBytes": 130123456,               # on-disk total (for cache budgeting)
  "totalGzippedBytes": 78234567,         # what the user actually downloads
  "files": [
    { "url": "./tiles/seattle.pmtiles", "size": N, "gzippedSize": N, "hash": "16hex" },
    ...
  ]
}

Hashes are sha256, truncated to 16 hex chars — 64 bits is plenty for cache
invalidation. The hash field is the only authority on "has this file
changed" — the per-version string moves on every regeneration but is only
used as a quick-equality check; per-file diffing is what gives users the
small-update experience when only one file changed.
"""
import gzip
import hashlib
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).parent.parent
PUBLIC = ROOT / "public"

# Explicit list, not a glob — keeps any future staging files from accidentally
# shipping. Add new data files here as the app grows.
TARGETS = [
    # (relative path under public/, gzip-on-transit?)
    ("tiles/seattle.pmtiles",            False),  # pmtiles is internally compressed
    ("data/routing_graph.json",          True),
    ("data/addr_index.json",             True),
    ("data/bike_signs.geojson",          True),
    ("data/bike_facilities.geojson",     True),
    ("data/bike_plus_network.geojson",   True),
    ("data/bicycle_racks.geojson",       True),
    ("data/multi_use_trails.geojson",    True),
    ("data/kc_regional_trails.geojson",  True),
    ("data/parks_restrooms.geojson",     True),
    ("data/libraries.geojson",           True),
    ("data/community_centers.geojson",   True),
    ("data/light_rail_stations.geojson", True),
    ("data/seattle_streets.geojson",     True),
    ("data/seattle_polygon.geojson",     True),
    ("data/contours.geojson",            True),
    ("data/crosswalks.geojson",          True),
    ("data/signals.geojson",             True),
    ("data/beacons.geojson",             True),
    ("data/stop_signs.geojson",          True),
    ("data/traffic_circles.geojson",     True),
]


def hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def gzipped_size(path: Path) -> int:
    with path.open("rb") as f:
        return len(gzip.compress(f.read(), compresslevel=6))


def main() -> int:
    files = []
    missing = []
    for rel, do_gzip in TARGETS:
        p = PUBLIC / rel
        if not p.exists():
            missing.append(rel)
            continue
        size = p.stat().st_size
        files.append({
            "url": f"./{rel}",
            "size": size,
            "gzippedSize": gzipped_size(p) if do_gzip else size,
            "hash": hash_file(p),
        })

    if missing:
        print(f"WARNING: missing {len(missing)} file(s):", file=sys.stderr)
        for m in missing:
            print(f"  - {m}", file=sys.stderr)

    manifest = {
        "version": time.strftime("%Y%m%d-%H%M%S"),
        "generatedAt": int(time.time()),
        "totalBytes": sum(f["size"] for f in files),
        "totalGzippedBytes": sum(f["gzippedSize"] for f in files),
        "files": files,
    }

    out = PUBLIC / "data" / "version.json"
    out.write_text(json.dumps(manifest, indent=2) + "\n")

    raw_mb = manifest["totalBytes"] / 1e6
    gz_mb = manifest["totalGzippedBytes"] / 1e6
    print(
        f"Wrote {out}: {len(files)} files, "
        f"{raw_mb:.1f} MB on disk, {gz_mb:.1f} MB over wire"
    )
    return 0 if not missing else 1


if __name__ == "__main__":
    sys.exit(main())
