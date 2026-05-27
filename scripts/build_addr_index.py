"""Build an offline address + POI index for Seattle bike-map address search.

Pulls two OSM-derived datasets via a single Overpass query within the
Seattle bbox, filters to the Seattle polygon, and emits a compact JSON
file at `public/data/addr_index.json`. The browser side uses FlexSearch
to do fuzzy/prefix matching entirely client-side (no API keys).

Re-run when you want fresh data:

    source .venv/bin/activate
    pip install requests shapely     # already installed for fetch_data.py
    python3 scripts/build_addr_index.py

Output schema (one record = one address or POI):

    { i: <id>,
      k: 'a' | 'p',                  # 'a' = street address, 'p' = POI
      t: "123 Pine St" | "Cal Anderson Park",
      c: "amenity=cafe" | null,      # category (POIs only)
      a: "844 NW 54th St" | null,    # nearest housenumber label (POIs only)
      ax: lon, ay: lat,              # coords of that nearest housenumber
                                     # (POIs only) — used by the browser for
                                     # graph snapping so a POI whose centroid
                                     # sits in a park / building interior
                                     # still routes from its closest street.
      x: lon, y: lat }               # POI / address own coords (for pins)

Address coverage of street-numbered houses is essentially complete in
Seattle's OSM. Known gaps: DADUs/AADUs (backyard cottages typically
share the main house's polygon), apartment-unit specificity, and POI
name variants without `alt_name` tags. The browser side falls back to
whichever named record matches best when a typed housenumber isn't found.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import requests
from shapely.geometry import Point, shape

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "public" / "data"
OUT = DATA / "addr_index.json"

POLY_PATH = DATA / "seattle_polygon.geojson"

# Subset of OSM "named feature" keys we want as POIs. Keeps the index focused
# on things a user would type to navigate to.
POI_TAG_KEYS = [
    "amenity",
    "leisure",
    "tourism",
    "shop",
    "public_transport",
    "railway",
    "aeroway",
    "office",
    "place",       # neighborhoods, suburbs, hamlets — useful for navigation
    "natural",     # parks, beaches when tagged this way
    "historic",
]


def load_seattle_polygon():
    """Read the cached Seattle polygon (created by scripts/fetch_data.py)."""
    if not POLY_PATH.exists():
        raise SystemExit(
            f"missing {POLY_PATH.relative_to(ROOT)} — run scripts/fetch_data.py first"
        )
    data = json.loads(POLY_PATH.read_text())
    return shape(data["features"][0]["geometry"])


def fetch_overpass(bbox):
    """Pull addr:housenumber records AND named POIs from Overpass.

    bbox = (minLon, minLat, maxLon, maxLat). Overpass wants S,W,N,E.
    """
    s, w, n, e = bbox[1], bbox[0], bbox[3], bbox[2]
    tag_filter = "|".join(POI_TAG_KEYS)
    # nwr = nodes + ways + relations. For polygons (ways/relations) Overpass
    # gives us a `center` lon/lat in `out center`. Single query, two body
    # blocks combined into one result set.
    q = f"""
    [out:json][timeout:600];
    (
      nwr["addr:housenumber"]["addr:street"]({s},{w},{n},{e});
      nwr["name"][~"^({tag_filter})$"~"."]({s},{w},{n},{e});
    );
    out center tags;
    """
    print(f"  Overpass query bbox {s:.4f},{w:.4f} -> {n:.4f},{e:.4f}")
    r = requests.post(
        "https://overpass-api.de/api/interpreter",
        data={"data": q},
        timeout=900,
        headers={"User-Agent": "bikemap-prototype/0.1"},
    )
    r.raise_for_status()
    body = r.json()
    return body["elements"]


def element_center(el):
    """Return (lon, lat) for any element type."""
    if el["type"] == "node":
        return (el["lon"], el["lat"])
    c = el.get("center")
    if c:
        return (c["lon"], c["lat"])
    return None


def primary_poi_category(tags):
    """First (in POI_TAG_KEYS order) key:value pair that classifies the POI."""
    for k in POI_TAG_KEYS:
        v = tags.get(k)
        if v and v != "no":
            return f"{k}={v}"
    return None


def address_label(tags):
    """'<housenumber> <street>' if both present, else None."""
    num = tags.get("addr:housenumber")
    street = tags.get("addr:street")
    if not num or not street:
        return None
    # Strip extra whitespace.
    return f"{num.strip()} {street.strip()}"


def main():
    if not POLY_PATH.exists():
        print("Seattle polygon not found; run scripts/fetch_data.py first.",
              file=sys.stderr)
        return 1
    poly = load_seattle_polygon()
    bbox = poly.bounds

    print("Fetching OSM addresses + POIs via Overpass...")
    elements = fetch_overpass(bbox)
    print(f"  {len(elements):,} raw elements")

    addrs = {}   # dedup by (label, lon×lat~rounded)
    pois  = {}
    for el in elements:
        tags = el.get("tags") or {}
        c = element_center(el)
        if not c:
            continue
        lon, lat = c
        if not poly.contains(Point(lon, lat)):
            continue

        # Address candidate.
        a_label = address_label(tags)
        if a_label:
            # Use rounded coords for dedup; same numbered house tagged on
            # both node + way in OSM would otherwise appear twice.
            key = (a_label.lower(), round(lon, 5), round(lat, 5))
            if key not in addrs:
                addrs[key] = (a_label, lon, lat)

        # POI candidate (must be named).
        name = tags.get("name")
        cat = primary_poi_category(tags)
        if name and cat:
            key = (name.lower(), cat, round(lon, 5), round(lat, 5))
            if key not in pois:
                pois[key] = (name, cat, lon, lat)

    print(f"  {len(addrs):,} unique addresses, {len(pois):,} unique POIs")

    # For each POI, find the nearest housenumber within ~100m so the search
    # dropdown can display a street address alongside the POI name (helps
    # the user disambiguate similarly-named places). Uses a shapely STRtree
    # over the addresses for O(n log n) total instead of O(n*m).
    print("  assigning nearest address to each POI...")
    from shapely.strtree import STRtree
    from shapely.geometry import Point as ShPoint
    addr_pts = []
    addr_labels = []
    for (label, lon, lat) in addrs.values():
        addr_pts.append(ShPoint(lon, lat))
        addr_labels.append(label)
    addr_tree = STRtree(addr_pts)
    SEARCH_DEG = 0.0012   # ~120m at Seattle's latitude — slightly forgiving
    poi_addr = {}         # poi-key -> (label, lon, lat) or None
    for key, (name, cat, lon, lat) in pois.items():
        pt = ShPoint(lon, lat)
        cands = addr_tree.query(pt.buffer(SEARCH_DEG))
        best_idx = -1
        best_d = float("inf")
        for idx in cands:
            d = addr_pts[idx].distance(pt)
            if d < best_d:
                best_d = d
                best_idx = idx
        if best_idx >= 0:
            poi_addr[key] = (addr_labels[best_idx],
                             addr_pts[best_idx].x, addr_pts[best_idx].y)
        else:
            poi_addr[key] = None

    # Emit one flat array. 'p' (POI) records come first so a same-name tie
    # ranks POIs above addresses in the browser when scores are equal.
    records = []
    next_id = 0
    for key, (name, cat, lon, lat) in pois.items():
        nearest = poi_addr.get(key)
        rec = {"i": next_id, "k": "p", "t": name, "c": cat,
               "x": round(lon, 6), "y": round(lat, 6)}
        if nearest:
            label, ax, ay = nearest
            rec["a"]  = label
            rec["ax"] = round(ax, 6)
            rec["ay"] = round(ay, 6)
        else:
            rec["a"] = None
        records.append(rec)
        next_id += 1
    for (label, lon, lat) in addrs.values():
        records.append({"i": next_id, "k": "a", "t": label,
                        "x": round(lon, 6), "y": round(lat, 6)})
        next_id += 1

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(records, separators=(",", ":")))
    size_mb = OUT.stat().st_size / (1024 * 1024)
    print(f"  wrote {OUT.relative_to(ROOT)} "
          f"({len(records):,} records, {size_mb:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
