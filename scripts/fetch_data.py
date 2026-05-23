"""Snapshot every SDOT / King County layer used by the bike map to GeoJSON.

Every layer except `kc_regional_trails` and `seattle_polygon` is clipped to the
Seattle city boundary (fetched from OSM/Nominatim and cached at
public/data/seattle_polygon.geojson). KC regional trails are *meant* to be
outside Seattle and are intentionally left unclipped.

Run once (or any time you want fresh data):

    python3 -m venv .venv
    source .venv/bin/activate
    pip install requests shapely
    python3 scripts/fetch_data.py

Output goes to public/data/<name>.geojson. Files are overwritten in place.
"""

from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import requests
from shapely.geometry import shape, mapping
from shapely.geometry.base import BaseGeometry

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "public" / "data"

SDOT = "https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services"
KC = "https://gisdata.kingcounty.gov/arcgis/rest/services"


@dataclass
class Layer:
    name: str
    url: str
    where: str = "1=1"
    page_size: int = 1000
    clip_to_seattle: bool = True
    # Some servers reject f=geojson and need esriJSON -> manual conversion; not needed here.


LAYERS: list[Layer] = [
    Layer(
        "bike_facilities",
        f"{SDOT}/SDOT_Bike_Facilities/FeatureServer/2",
    ),
    Layer(
        "multi_use_trails",
        f"{SDOT}/SDOT_Bike_Facilities/FeatureServer/1",
    ),
    Layer(
        "bike_plus_network",
        f"{SDOT}/Seattle_Transportation_Plan_Bicycle_Element/FeatureServer/9",
    ),
    Layer(
        "bicycle_racks",
        f"{SDOT}/Bicycle_Racks_(Active)/FeatureServer/0",
    ),
    Layer(
        "kc_regional_trails",
        f"{KC}/OpenDataPortal/recreatn__trail_line/MapServer/273",
        where=(
            "Surf_Type IN ('Paved Trail','On Street Trail') "
            "AND Owner NOT LIKE '%Seattle%' "
            "AND Trail_Type = 'Trail (Regional)'"
        ),
        # User wants every layer clipped to Seattle. With the Owner != Seattle
        # filter this leaves only KC-owned segments that physically cross into
        # the city (likely few or zero).
    ),
    Layer(
        "light_rail_stations",
        f"{SDOT}/Sound_Transit_Link_Light_Station_Point/FeatureServer/0",
        where="STATUS = 'COMPLETE'",
    ),
    Layer(
        "libraries",
        f"{SDOT}/Seattle_Public_Library/FeatureServer/0",
    ),
    Layer(
        "community_centers",
        f"{SDOT}/Community_Centers/FeatureServer/0",
    ),
    Layer(
        "parks_restrooms",
        f"{SDOT}/Parks_Restrooms/FeatureServer/0",
    ),
    Layer(
        "bike_signs",
        f"{SDOT}/SDOT_Street_Signs/FeatureServer/1",
        where=(
            "CATEGORY = 'GBP' AND "
            "(CURRENT_STATUS IN ('INSVC') OR CURRENT_STATUS IS NULL)"
        ),
    ),
]


SEATTLE_POLYGON_PATH = OUT_DIR / "seattle_polygon.geojson"


def get_seattle_polygon() -> BaseGeometry:
    """Return the Seattle city boundary as a shapely polygon.

    Cached on disk; on first run pulls it from OSM/Nominatim.
    """
    if not SEATTLE_POLYGON_PATH.exists():
        print("Fetching Seattle boundary from OSM (Nominatim)...")
        SEATTLE_POLYGON_PATH.parent.mkdir(parents=True, exist_ok=True)
        r = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={
                "city": "Seattle",
                "state": "Washington",
                "country": "USA",
                "polygon_geojson": "1",
                "format": "json",
                "limit": 1,
            },
            headers={"User-Agent": "bikemap-prototype/0.1"},
            timeout=30,
        )
        r.raise_for_status()
        geom = r.json()[0]["geojson"]
        SEATTLE_POLYGON_PATH.write_text(
            json.dumps({
                "type": "FeatureCollection",
                "features": [{"type": "Feature", "properties": {}, "geometry": geom}],
            })
        )
    data = json.loads(SEATTLE_POLYGON_PATH.read_text())
    return shape(data["features"][0]["geometry"])


def clip_features(features: list[dict], poly: BaseGeometry) -> list[dict]:
    """Clip line features to the polygon; drop points outside; preserve attributes."""
    out: list[dict] = []
    for f in features:
        g = f.get("geometry")
        if g is None:
            continue
        try:
            geom = shape(g)
        except Exception:
            continue
        if geom.is_empty:
            continue
        if geom.geom_type == "Point":
            if poly.contains(geom):
                out.append(f)
            continue
        # Lines (and other geoms): intersect with polygon.
        clipped = geom.intersection(poly)
        if clipped.is_empty:
            continue
        out.append({
            "type": "Feature",
            "properties": f.get("properties", {}),
            "geometry": mapping(clipped),
        })
    return out


def discover_page_size(layer_url: str) -> int:
    """Return min(maxRecordCount, 2000) for the layer."""
    r = requests.get(layer_url, params={"f": "json"}, timeout=30)
    r.raise_for_status()
    meta = r.json()
    return min(int(meta.get("maxRecordCount") or 1000), 2000)


def fetch_layer(layer: Layer) -> dict:
    """Page through the layer and return one merged GeoJSON FeatureCollection."""
    page_size = discover_page_size(layer.url)
    print(f"  page size: {page_size}")

    features: list[dict] = []
    offset = 0
    while True:
        params = {
            "where": layer.where,
            "outFields": "*",
            "outSR": "4326",
            "geometryPrecision": "6",
            "f": "geojson",
            "resultOffset": offset,
            "resultRecordCount": page_size,
        }
        r = requests.get(f"{layer.url}/query", params=params, timeout=60)
        r.raise_for_status()
        body = r.json()
        batch = body.get("features", [])
        features.extend(batch)
        print(f"  +{len(batch)} (total {len(features)})")
        # ArcGIS GeoJSON responses use exceededTransferLimit (top level) or properties.exceededTransferLimit.
        exceeded = body.get("properties", {}).get("exceededTransferLimit") or body.get(
            "exceededTransferLimit"
        )
        if not exceeded or not batch:
            break
        offset += len(batch)
        time.sleep(0.1)  # be polite

    return {"type": "FeatureCollection", "features": features}


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    seattle_poly = get_seattle_polygon()
    failed: list[str] = []
    for layer in LAYERS:
        print(f"\n→ {layer.name}  ({layer.url})")
        try:
            fc = fetch_layer(layer)
        except Exception as exc:
            print(f"  FAILED: {exc}")
            failed.append(layer.name)
            continue
        if layer.clip_to_seattle:
            before = len(fc["features"])
            fc["features"] = clip_features(fc["features"], seattle_poly)
            print(f"  clipped to Seattle: {before} -> {len(fc['features'])}")
        out_path = OUT_DIR / f"{layer.name}.geojson"
        out_path.write_text(json.dumps(fc))
        print(f"  wrote {out_path.relative_to(ROOT)} ({len(fc['features'])} features)")
    if failed:
        print(f"\nFailed layers: {', '.join(failed)}", file=sys.stderr)
        return 1
    print("\nDone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
