"""Build a Seattle bike-routable graph from OSM + the SDOT snapshots.

Output: public/data/routing_graph.json — consumed by src/routing/graph.js.

This is the offline half of the routing prototype. We fetch OSM via Overpass
(plain HTTP, no GDAL/osmnx), spatially join SDOT attributes onto OSM edges,
snap intersection-control points onto OSM nodes, collapse traffic circles,
and precompute per-edge constants (length, lanes, centerline, bearings).

Re-run when source data changes:

    source .venv/bin/activate
    pip install requests shapely      # already installed for fetch_data.py
    python3 scripts/build_graph.py

Notes / decisions:

- Spatial joins use a 15 m buffer for streets, 12 m for control points (mod
  to ~30 m for traffic-circle clusters). These radii are tuned for Seattle's
  typical street widths but can be revisited.
- A two-way street becomes two directed edges with mirrored bearings so
  future directional cost terms can fold in without re-shaping the graph.
- Per-edge geometry is stored inline (a list of [lon, lat] points). Plain
  JSON. The file is in the ~10-20 MB range — fine for a prototype; binary
  packing is the next escalation if it gets in the way.
"""

from __future__ import annotations

import json
import math
import sys
import time
from collections import defaultdict
from pathlib import Path

import requests
from shapely.geometry import LineString, Point, shape
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "public" / "data"
OUT  = DATA / "routing_graph.json"

# Roads always included (cars + bikes).
ROAD_HIGHWAYS = {
    "residential", "tertiary", "tertiary_link",
    "secondary", "secondary_link",
    "primary", "primary_link",
    "unclassified", "living_street",
}
# Bike-specific OSM types — always allowed.
CYCLEWAY_HIGHWAYS = {"cycleway"}
# Pedestrian-ish types — require explicit bike access tag, else skipped.
RESTRICTED_HIGHWAYS = {"path", "footway", "track", "pedestrian"}

# Hardcoded refusals — never route on these even with bicycle=yes.
NEVER = {"motorway", "motorway_link", "trunk", "trunk_link", "construction",
         "raceway", "proposed", "abandoned", "razed"}

# Constants matching the JS cost-function schema (kept here for the graph
# build; the JS side has its own copy for tunability).
FT_PER_METER = 3.28084


# ---------- OSM via Overpass ----------

def load_seattle_polygon():
    """Read the cached Seattle polygon. fetch_data.py creates this."""
    p = DATA / "seattle_polygon.geojson"
    data = json.loads(p.read_text())
    return shape(data["features"][0]["geometry"])


def fetch_overpass(bbox):
    """Pull all bike-routable highway ways within bbox and their nodes.

    bbox = (minLon, minLat, maxLon, maxLat). Overpass wants S,W,N,E."""
    s, w, n, e = bbox[1], bbox[0], bbox[3], bbox[2]
    # Filter aggressively at the query so we don't pull I-5 etc.
    q = f"""
    [out:json][timeout:300];
    (
      way["highway"]({s},{w},{n},{e});
    );
    (._;>;);
    out body;
    """
    print(f"  Overpass query bbox {s:.4f},{w:.4f} -> {n:.4f},{e:.4f}")
    r = requests.post(
        "https://overpass-api.de/api/interpreter",
        data={"data": q},
        timeout=600,
        headers={"User-Agent": "bikemap-prototype/0.1"},
    )
    r.raise_for_status()
    body = r.json()
    return body["elements"]


def detect_geometric_circles(nodes, edges, max_perim_ft=200, max_diameter_ft=60):
    """Find clusters of 3-6 nodes whose connecting edges form a small closed
    cycle — typically OSM-modeled traffic circle rings that aren't tagged
    junction=roundabout. Returns (lon, lat) centroids to feed into the
    traffic-circle collapse step.

    Heuristic:
      - Build a sub-adjacency of "short" edges (length <= 60 ft each).
      - BFS to find connected components.
      - Keep components where every node has in-component degree == 2 AND
        the component has 3-6 nodes AND its perimeter is <= max_perim_ft AND
        its bounding diameter is <= max_diameter_ft.
    """
    from collections import defaultdict
    SHORT_FT = 60
    edge_len_ft = {}
    short_adj = defaultdict(set)   # node -> {(neighbor, edge_index), ...}
    for i, e in enumerate(edges):
        seg = e["nodes"]
        if len(seg) < 2:
            continue
        coords = [nodes[n] for n in seg]
        ln = sum(haversine_ft(coords[j], coords[j + 1])
                 for j in range(len(coords) - 1))
        edge_len_ft[i] = ln
        if ln <= SHORT_FT:
            a, b = seg[0], seg[-1]
            if a == b:
                continue
            short_adj[a].add((b, i))
            short_adj[b].add((a, i))

    visited = set()
    centroids = []
    for start in list(short_adj.keys()):
        if start in visited:
            continue
        comp_nodes = []
        stack = [start]
        comp_set = set()
        while stack:
            n = stack.pop()
            if n in comp_set:
                continue
            comp_set.add(n)
            comp_nodes.append(n)
            visited.add(n)
            for (nb, _) in short_adj[n]:
                if nb not in comp_set:
                    stack.append(nb)
        if not (3 <= len(comp_set) <= 6):
            continue
        # Each node must have exactly 2 in-component neighbors (closed cycle).
        all_deg_two = True
        comp_edges = set()
        for n in comp_set:
            in_comp_deg = 0
            for (nb, eidx) in short_adj[n]:
                if nb in comp_set:
                    in_comp_deg += 1
                    comp_edges.add(eidx)
            if in_comp_deg != 2:
                all_deg_two = False
                break
        if not all_deg_two:
            continue
        # Perimeter
        perim = sum(edge_len_ft[ei] for ei in comp_edges)
        if perim > max_perim_ft:
            continue
        # Diameter (pairwise max)
        coords = [nodes[n] for n in comp_nodes]
        max_diam = 0.0
        for j in range(len(coords)):
            for k in range(j + 1, len(coords)):
                d = haversine_ft(coords[j], coords[k])
                if d > max_diam:
                    max_diam = d
        if max_diam > max_diameter_ft:
            continue
        cx = sum(c[0] for c in coords) / len(coords)
        cy = sum(c[1] for c in coords) / len(coords)
        centroids.append((cx, cy))
    return centroids


def extract_osm_circles(elements):
    """Return OSM nodes tagged as some kind of traffic circle / mini-
    roundabout as (lon, lat) tuples — supplemental points to fill gaps in
    SDOT's Traffic_Circles_view dataset. Note that OSM Seattle has very
    sparse coverage (~50 nodes total vs SDOT's 1000+), so this is just a
    last-resort supplement.
    """
    pts = []
    for el in elements:
        if el["type"] != "node":
            continue
        tags = el.get("tags") or {}
        if tags.get("highway") == "mini_roundabout":
            pts.append((el["lon"], el["lat"]))
        elif tags.get("junction") in ("mini_roundabout", "roundabout", "circular"):
            pts.append((el["lon"], el["lat"]))
    return pts


def parse_osm(elements, seattle_poly):
    """Turn Overpass elements into node + edge dicts.

    Filters out non-routable highway classes, splits ways into per-segment
    edges, drops anything outside the Seattle polygon.
    """
    nodes_raw = {}
    ways_raw = []
    for el in elements:
        if el["type"] == "node":
            nodes_raw[el["id"]] = (el["lon"], el["lat"])
        elif el["type"] == "way":
            ways_raw.append(el)

    # Find intersection nodes — nodes that appear in >1 way OR endpoints of a
    # way OR appear multiple times in the same way (rare).
    occurrences = defaultdict(int)
    for w in ways_raw:
        tags = w.get("tags", {})
        if tags.get("highway") in NEVER:
            continue
        if not _is_bike_routable(tags):
            continue
        nids = w["nodes"]
        for i, nid in enumerate(nids):
            occurrences[nid] += 1
            if i == 0 or i == len(nids) - 1:
                occurrences[nid] += 1  # force endpoint to be a graph node

    # Now build edges. An edge runs from one intersection-node to the next
    # along a way.
    edges = []
    node_set = set()
    for w in ways_raw:
        tags = w.get("tags", {})
        if tags.get("highway") in NEVER:
            continue
        if not _is_bike_routable(tags):
            continue
        nids = w["nodes"]
        # Walk the way, breaking at intersection nodes.
        start = 0
        for i in range(1, len(nids)):
            if occurrences[nids[i]] >= 2 or i == len(nids) - 1:
                seg = nids[start:i + 1]
                if len(seg) < 2:
                    continue
                # Skip if any node missing coords (Overpass should give us all).
                if not all(nid in nodes_raw for nid in seg):
                    continue
                # Reject if midpoint outside Seattle polygon.
                mid_idx = len(seg) // 2
                mid_lon, mid_lat = nodes_raw[seg[mid_idx]]
                if not seattle_poly.contains(Point(mid_lon, mid_lat)):
                    start = i
                    continue
                edges.append({
                    "way_id": w["id"],
                    "tags":   tags,
                    "nodes":  seg,
                })
                node_set.update(seg)
                start = i

    nodes = {nid: nodes_raw[nid] for nid in node_set if nid in nodes_raw}
    print(f"  parsed: {len(nodes):,} nodes, {len(edges):,} undirected edges")
    return nodes, edges


def _is_bike_routable(tags):
    """OSM tag heuristic for 'a bike can ride here'."""
    hw = tags.get("highway")
    if not hw or hw in NEVER:
        return False
    if tags.get("bicycle") == "no":
        return False
    if tags.get("access") in ("no", "private"):
        if tags.get("bicycle") not in ("yes", "designated", "permissive"):
            return False
    if hw in ROAD_HIGHWAYS or hw in CYCLEWAY_HIGHWAYS:
        return True
    if hw in RESTRICTED_HIGHWAYS:
        return tags.get("bicycle") in ("yes", "designated")
    # service / driveways / alleys: explicit bike access only.
    if hw == "service":
        return tags.get("bicycle") in ("yes", "designated")
    return False


# ---------- Spatial joins ----------

def build_edge_geometries(nodes, edges):
    """Attach a LineString to each edge."""
    for e in edges:
        coords = [nodes[nid] for nid in e["nodes"]]
        e["geom"] = LineString(coords)


def majority_attr(values):
    """Return the most common non-None value, or None."""
    counts = defaultdict(int)
    for v in values:
        if v is None or v == "":
            continue
        counts[v] += 1
    if not counts:
        return None
    return max(counts.items(), key=lambda kv: kv[1])[0]


def sample_along(line, n=4):
    """Yield n evenly spaced points (excluding endpoints) on the line."""
    for i in range(1, n + 1):
        yield line.interpolate(i / (n + 1), normalized=True)


def spatial_join_streets(edges, streets_path):
    """Match SDOT seattle_streets attrs onto each OSM edge.

    Off-street trail edges (highway in CYCLEWAY_HIGHWAYS | RESTRICTED_HIGHWAYS)
    are SKIPPED. At a trail × street intersection the street's centerline
    runs through the trail's geometry and wins the "nearest-feature within
    ~15 m" contest, contaminating the trail edge with the street's
    ONEWAY/lanes/centerline attributes. The most catastrophic symptom
    we've seen: BGT-on-Corliss at N 35th picked up Corliss's ONEWAY='Y'
    and severed southbound connectivity on the trail, forcing a half-mile
    detour for what should be a 16 ft hop. Trails get sdot={} here and
    fall through to safe off-street defaults later (oneway=False from
    parse_oneway, has_centerline=False from artclass=0, lane fallback).
    """
    print("  joining seattle_streets...")
    fc = json.loads(streets_path.read_text())
    feats = []
    geoms = []
    for f in fc["features"]:
        g = shape(f["geometry"])
        if g.geom_type not in ("LineString", "MultiLineString"):
            continue
        for part in (g.geoms if g.geom_type == "MultiLineString" else [g]):
            feats.append(f["properties"])
            geoms.append(part)
    tree = STRtree(geoms)
    SEARCH_DEG = 0.00015  # ~15 m at Seattle's latitude

    TRAIL_HIGHWAYS = CYCLEWAY_HIGHWAYS | RESTRICTED_HIGHWAYS
    matched = 0
    skipped_trails = 0
    for e in edges:
        if e["tags"].get("highway") in TRAIL_HIGHWAYS:
            e["sdot"] = {}
            skipped_trails += 1
            continue
        attrs_per_sample = []
        for pt in sample_along(e["geom"], n=4):
            candidates = tree.query(pt.buffer(SEARCH_DEG))
            best = None
            best_dist = float("inf")
            for idx in candidates:
                d = geoms[idx].distance(pt)
                if d < best_dist:
                    best_dist = d
                    best = feats[idx]
            if best is not None and best_dist <= SEARCH_DEG:
                attrs_per_sample.append(best)
        if attrs_per_sample:
            e["sdot"] = {
                "SURFACEWIDTH": majority_attr([a.get("SURFACEWIDTH") for a in attrs_per_sample]),
                "ARTCLASS":     majority_attr([a.get("ARTCLASS") for a in attrs_per_sample]),
                "SPEEDLIMIT":   majority_attr([a.get("SPEEDLIMIT") for a in attrs_per_sample]),
                "ONEWAY":       majority_attr([a.get("ONEWAY") for a in attrs_per_sample]),
                "UNITDESC":     majority_attr([a.get("UNITDESC") for a in attrs_per_sample]),
            }
            matched += 1
        else:
            e["sdot"] = {}
    print(f"    {matched:,} / {len(edges):,} street edges matched a SDOT street "
          f"(skipped {skipped_trails:,} off-street trail edges)")


def spatial_join_facilities(edges, data_dir):
    """Carry bike-facility CATEGORY + MODEL_TYPE onto each OSM edge.

    Pulls from the SAME four GeoJSON sources that render dark-green-AAA on
    the map, so the visual classification and routing classification stay
    in sync (this used to use only bike_facilities.geojson, which meant
    KC trails / SDOT multi-use trails / Bike+ Network "Existing" all
    rendered as dark green but got the no-facility 1.8× multiplier in
    routing — most visibly along the Burke-Gilman).

    Sources, in order of authoritativeness:
      1. bike_facilities.geojson — CATEGORY taken as-is (only INSVC/PLNRECON;
         UNDERCONS is skipped so an under-construction PBL doesn't get
         routed as if installed; the road underneath still routes as
         no-facility, which is what you want today).
      2. multi_use_trails.geojson — SDOT off-street paths; all tagged
         BKF-OFFST (no status field on this layer).
      3. kc_regional_trails.geojson — KC regional trails clipped to
         Seattle (heavily pre-filtered by the fetch step); BKF-OFFST.
      4. bike_plus_network.geojson — only "Existing*" categories; mapped
         to NGW/PBL/OFFST by sub-category. Proposed* is skipped (planned
         infra isn't built yet).

    All AAA tiers share multiplier 1.0× in cost.js, so within-AAA picks
    are routing-cost-equivalent; the distinction only matters for popups.
    """
    print("  joining facility sources (bike_facilities + multi_use_trails "
          "+ kc_regional_trails + bike_plus_network Existing)...")

    feats = []
    geoms = []

    def _add_source(path, classify):
        """classify(props) returns (category, model_type) or (None, None) to skip."""
        if not path.exists():
            print(f"    warn: {path.name} not found, skipping")
            return 0
        fc = json.loads(path.read_text())
        n_before = len(feats)
        for f in fc["features"]:
            props = f["properties"]
            cat, model = classify(props)
            if cat is None:
                continue
            g = f.get("geometry")
            if not g:
                continue
            g = shape(g)
            if g.geom_type not in ("LineString", "MultiLineString"):
                continue
            for part in (g.geoms if g.geom_type == "MultiLineString" else [g]):
                # Reuse `feats` as parallel-arrays to geoms: store (cat, model).
                feats.append((cat, model))
                geoms.append(part)
        return len(feats) - n_before

    # Source 1: SDOT bike_facilities — installed (INSVC) or installed-but-
    # slated-for-upgrade (PLNRECON). UNDERCONS is skipped on purpose.
    def _classify_bike_facilities(props):
        if props.get("CURRENT_STATUS") not in ("INSVC", "PLNRECON"):
            return None, None
        cat = props.get("CATEGORY")
        if cat not in ("BKF-NGW", "BKF-PBL", "BKF-OFFST",
                       "BKF-BBL", "BKF-BL", "BKF-CLMB", "BKF-SHW"):
            return None, None
        return cat, props.get("MODEL_TYPE")
    n1 = _add_source(data_dir / "bike_facilities.geojson", _classify_bike_facilities)
    print(f"    +{n1:,} from bike_facilities")

    # Source 2: SDOT multi_use_trails — all off-street paths.
    def _classify_multi_use(props):
        return "BKF-OFFST", None
    n2 = _add_source(data_dir / "multi_use_trails.geojson", _classify_multi_use)
    print(f"    +{n2:,} from multi_use_trails")

    # Source 3: KC regional trails (clipped to Seattle).
    def _classify_kc(props):
        return "BKF-OFFST", None
    n3 = _add_source(data_dir / "kc_regional_trails.geojson", _classify_kc)
    print(f"    +{n3:,} from kc_regional_trails")

    # Source 4: Bike+ Network — only the Existing* sub-categories; Proposed
    # is future plans and shouldn't change today's routing.
    BIKE_PLUS_AAA = {
        "Existing Bike+ - Non-Arterial": "BKF-NGW",     # neighborhood greenway
        "Existing Bike+ - Arterial":     "BKF-PBL",     # protected on arterial
        "Existing Multi-Use Trail":      "BKF-OFFST",   # off-street path
    }
    def _classify_bike_plus(props):
        return BIKE_PLUS_AAA.get(props.get("bike_network_category"), None), None
    n4 = _add_source(data_dir / "bike_plus_network.geojson", _classify_bike_plus)
    print(f"    +{n4:,} from bike_plus_network Existing*")

    if not geoms:
        for e in edges:
            e["facility_category"] = None
            e["facility_model_type"] = None
        return
    tree = STRtree(geoms)
    SEARCH_DEG = 0.00012  # ~12 m

    # Cost-tier ranking: lower number = better. Pick the best when multiple
    # facilities overlap an edge.
    RANK = {
        "BKF-NGW": 0, "BKF-PBL": 0, "BKF-OFFST": 0,
        "BKF-BBL": 1, "BKF-BL": 2,
        "BKF-CLMB": 3, "BKF-SHW": 3,
    }
    matched = 0
    matched_by_cat: dict[str, int] = {}
    for e in edges:
        best_cat = None
        best_model = None
        for pt in sample_along(e["geom"], n=3):
            for idx in tree.query(pt.buffer(SEARCH_DEG)):
                if geoms[idx].distance(pt) > SEARCH_DEG:
                    continue
                cat, model = feats[idx]
                if cat in RANK:
                    if best_cat is None or RANK[cat] < RANK[best_cat]:
                        best_cat = cat
                        best_model = model
        e["facility_category"] = best_cat
        e["facility_model_type"] = best_model
        if best_cat:
            matched += 1
            matched_by_cat[best_cat] = matched_by_cat.get(best_cat, 0) + 1
    print(f"    {matched:,} edges got a bike-facility class")
    for cat, n in sorted(matched_by_cat.items()):
        print(f"      {cat}: {n:,}")


# 8 cardinal direction codes used by SDOT's FACING field, mapped to a
# bit index (0..7) and the bearing (degrees, clockwise from north) of
# the controlled approach. Convention: a stop sign with FACING='E' is
# physically pointed east, so eastbound traffic (travel bearing 90°)
# sees it and stops. So the bit index for FACING='E' is keyed by bearing
# 90° = approaching-traffic travel direction.
STOP_FACING_BITS = {  # SDOT FACING token  →  (bit-index, bearing of stopped traffic in deg)
    "N":  (0,   0),
    "NE": (1,  45),
    "E":  (2,  90),
    "SE": (3, 135),
    "S":  (4, 180),
    "SW": (5, 225),
    "W":  (6, 270),
    "NW": (7, 315),
}

def snap_control_points(nodes, signals_p, crosswalks_p, beacons_p, stop_signs_p):
    """Mark nodes that have a nearby signal / crosswalk / beacon /
    stop sign. Stop signs are also direction-tagged (which approach
    direction stops) using SDOT's FACING attribute — needed because the
    crossing penalty zeros out only when the cross-traffic is stopped,
    not the cyclist."""
    print("  snapping intersection controls...")
    # ~20 m. The previous 12 m was too tight — SDOT typically digitizes
    # signal heads at the curb, and several real signals on Aurora /
    # Westlake / arterials fell 13-18 m from the corresponding graph
    # node, causing spurious unsignalized-crossing penalties.
    SEARCH_DEG = 0.0002
    flags = {nid: {"sig": False, "xwk": False, "bcn": False,
                   "stopBits": 0}
             for nid in nodes}
    node_pts = [Point(lon, lat) for nid, (lon, lat) in nodes.items()]
    node_ids = list(nodes.keys())
    tree = STRtree(node_pts)

    for path, key in [(signals_p, "sig"), (crosswalks_p, "xwk"), (beacons_p, "bcn")]:
        fc = json.loads(path.read_text())
        hits = 0
        for f in fc["features"]:
            g = shape(f["geometry"])
            pts = list(g.geoms) if hasattr(g, "geoms") else [g]
            for pt in pts:
                for idx in tree.query(pt.buffer(SEARCH_DEG)):
                    if node_pts[idx].distance(pt) <= SEARCH_DEG:
                        flags[node_ids[idx]][key] = True
                        hits += 1
        print(f"    {key}: {hits:,} hits across nodes")

    # Stop signs: OR the FACING bit into EVERY node within radius — same
    # as the sig/xwk/bcn logic above. Snapping to a single nearest node
    # is wrong here: OSM models each stop-sign-bearing curb as its own
    # degree-2 node, ~20-30 ft from the intersection center. "Nearest"
    # then routes each sign to its own curb node, missing the
    # intersection center where the route's crossing penalty is
    # actually evaluated. Spraying to all nearby nodes is benign because
    # the only place crossingPenaltyFt fires is at multi-way junctions;
    # curb (degree-2) nodes never have a cross-street and naturally
    # short-circuit out.
    fc = json.loads(stop_signs_p.read_text())
    snapped = 0
    unknown_facing = 0
    for f in fc["features"]:
        facing = (f["properties"].get("FACING") or "").upper().strip()
        bit_info = STOP_FACING_BITS.get(facing)
        if bit_info is None:
            unknown_facing += 1
            continue
        bit, _bearing = bit_info
        g = shape(f["geometry"])
        pts = list(g.geoms) if hasattr(g, "geoms") else [g]
        for pt in pts:
            hit_any = False
            for idx in tree.query(pt.buffer(SEARCH_DEG)):
                if node_pts[idx].distance(pt) <= SEARCH_DEG:
                    flags[node_ids[idx]]["stopBits"] |= (1 << bit)
                    hit_any = True
            if hit_any: snapped += 1
    print(f"    stop: {snapped:,} signs snapped "
          f"({unknown_facing:,} skipped for missing/unknown FACING)")

    return flags


def collapse_traffic_circles(nodes, edges, circles_path, extra_circle_pts=None):
    """Merge OSM nodes inside each traffic circle into one synthetic node.

    Sets is_traffic_circle on the merged node. Edges that previously
    terminated on a circle member point to the new synthetic node. Edges
    with both endpoints inside the same circle are dropped (the circle's
    internal geometry).

    `extra_circle_pts` is a list of (lon, lat) tuples — OSM
    mini_roundabouts that supplement SDOT's incomplete dataset.
    """
    print("  collapsing traffic circles...")
    fc = json.loads(circles_path.read_text())
    SEARCH_DEG = 0.00018  # ~18 m
    circle_pts = [shape(f["geometry"]) for f in fc["features"]]
    if extra_circle_pts:
        for lon, lat in extra_circle_pts:
            circle_pts.append(Point(lon, lat))
        print(f"    +{len(extra_circle_pts):,} OSM mini-roundabouts")

    # For each circle find member node IDs.
    node_pts  = [Point(lon, lat) for lon, lat in nodes.values()]
    node_ids  = list(nodes.keys())
    tree = STRtree(node_pts)

    merged = 0
    circle_node_id_base = max(nodes.keys()) + 1  # synthetic node id space
    next_synth = circle_node_id_base
    remap = {}  # old node id -> synthetic node id
    synth_meta = {}  # synth id -> dict
    for cpt in circle_pts:
        member_ids = []
        for idx in tree.query(cpt.buffer(SEARCH_DEG)):
            if node_pts[idx].distance(cpt) <= SEARCH_DEG:
                member_ids.append(node_ids[idx])
        if not member_ids:
            continue
        synth = next_synth
        next_synth += 1
        # Centroid of member nodes
        clons = [nodes[m][0] for m in member_ids]
        clats = [nodes[m][1] for m in member_ids]
        synth_meta[synth] = (sum(clons)/len(clons), sum(clats)/len(clats))
        for m in member_ids:
            remap[m] = synth
        merged += 1
    print(f"    merged {merged:,} circles, {len(remap):,} OSM nodes absorbed")

    # Rewrite edges.
    new_edges = []
    for e in edges:
        new_nodes = [remap.get(n, n) for n in e["nodes"]]
        # Drop interior duplicates (e.g. a long way looping back through the
        # circle center). Keep endpoints.
        deduped = [new_nodes[0]]
        for n in new_nodes[1:]:
            if n != deduped[-1]:
                deduped.append(n)
        if len(deduped) < 2:
            continue
        if deduped[0] == deduped[-1]:
            continue  # self-loop, drop
        e["nodes"] = deduped
        new_edges.append(e)

    # Add synthetic nodes
    is_circle = {nid: False for nid in nodes}
    for synth, (lon, lat) in synth_meta.items():
        nodes[synth] = (lon, lat)
        is_circle[synth] = True
    print(f"    {len(new_edges):,} edges remain after circle collapse")
    return new_edges, is_circle


# ---------- Per-edge constants ----------

def haversine_ft(p1, p2):
    """Distance between two (lon, lat) tuples in feet."""
    R_M = 6371000.0
    lon1, lat1 = math.radians(p1[0]), math.radians(p1[1])
    lon2, lat2 = math.radians(p2[0]), math.radians(p2[1])
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    a = math.sin(dlat/2)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon/2)**2
    d_m = 2 * R_M * math.asin(math.sqrt(a))
    return d_m * FT_PER_METER


def initial_bearing(p1, p2):
    """Compass bearing (deg) from p1 to p2."""
    lon1, lat1 = math.radians(p1[0]), math.radians(p1[1])
    lon2, lat2 = math.radians(p2[0]), math.radians(p2[1])
    dlon = lon2 - lon1
    x = math.sin(dlon) * math.cos(lat2)
    y = (math.cos(lat1) * math.sin(lat2)
         - math.sin(lat1) * math.cos(lat2) * math.cos(dlon))
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def derive_lanes(surface_width):
    """Continuous lane count from SDOT SURFACEWIDTH (feet).

    Assumes 7.5 ft of parking on one side that doesn't count as a lane,
    and 10 ft per moving lane. min 1.
    """
    if surface_width is None or surface_width == "":
        return None
    try:
        w = float(surface_width)
    except (TypeError, ValueError):
        return None
    if w <= 0:
        return None
    return max(1.0, (w - 7.5) / 10.0)


def fallback_lanes_from_artclass(artclass):
    """When SURFACEWIDTH is null, pick a sensible default from arterial class.
    0 = Not Designated (local), 1 = Principal, 2 = Minor, 3 = Collector,
    4 = State Route, 5 = Interstate (these are excluded upstream anyway),
    9 = County."""
    if artclass is None:
        return 2.0
    try:
        a = int(artclass)
    except (TypeError, ValueError):
        return 2.0
    return {0: 2.0, 1: 4.0, 2: 3.0, 3: 2.5, 9: 3.0}.get(a, 2.0)


def parse_oneway(osm_tag, sdot_tag):
    """Resolve forward/reverse/bidir from OSM + SDOT tags.

    Returns: 'forward' (way direction only), 'reverse', or 'bidir'.
    SDOT takes precedence when OSM is silent, OSM takes precedence
    when it's explicit (since OSM tagging is what splits ways).
    """
    o = osm_tag
    if o == "-1" or o == "reverse":
        return "reverse"
    if o in ("yes", "true", "1"):
        return "forward"
    if o in ("no", "false", "0"):
        return "bidir"
    if sdot_tag == "Y":
        return "forward"
    return "bidir"


def expand_to_directed(nodes, edges, is_circle):
    """Produce directed edges with all precomputed constants."""
    print("  building directed edges...")
    out = []

    for e in edges:
        seg_nodes = e["nodes"]
        coords = [nodes[n] for n in seg_nodes]
        length_ft = sum(haversine_ft(coords[i], coords[i+1])
                         for i in range(len(coords)-1))
        b_start = initial_bearing(coords[0], coords[1])
        b_end   = initial_bearing(coords[-2], coords[-1])

        sdot = e.get("sdot", {})
        lanes = derive_lanes(sdot.get("SURFACEWIDTH"))
        if lanes is None:
            lanes = fallback_lanes_from_artclass(sdot.get("ARTCLASS"))
        try:
            artclass = int(sdot.get("ARTCLASS") or 0)
        except (TypeError, ValueError):
            artclass = 0
        has_centerline = artclass >= 1

        ow = parse_oneway(e["tags"].get("oneway"), sdot.get("ONEWAY"))
        directions = []
        if ow in ("forward", "bidir"):
            directions.append(("fwd", seg_nodes, coords, b_start, b_end))
        if ow in ("reverse", "bidir"):
            rev_coords = list(reversed(coords))
            rev_nodes  = list(reversed(seg_nodes))
            directions.append(("rev", rev_nodes,
                               rev_coords,
                               initial_bearing(rev_coords[0], rev_coords[1]),
                               initial_bearing(rev_coords[-2], rev_coords[-1])))

        for (_, nseq, cseq, b0, b1) in directions:
            out.append({
                "from": nseq[0],
                "to":   nseq[-1],
                "lengthFt": round(length_ft, 1),
                "lanes":    round(lanes, 2),
                "hasCenterline": has_centerline,
                "facilityCategory": e.get("facility_category"),
                "facilityModelType": e.get("facility_model_type"),
                "oneway":   (ow != "bidir"),
                "bearingStart": round(b0, 1),
                "bearingEnd":   round(b1, 1),
                # Use OSM name only; SDOT UNITDESC is verbose all-caps with
                # "BETWEEN X AND Y" suffixes that fragment direction steps.
                "streetName": e["tags"].get("name"),
                "geometry": [[round(c[0], 6), round(c[1], 6)] for c in cseq],
            })
    print(f"    {len(out):,} directed edges")
    return out


def renumber_and_serialize(nodes, directed_edges, control_flags, is_circle, out_path):
    """Dense-pack IDs and emit columnar JSON.

    Columnar layout: one parallel array per attribute. Strings (street names,
    facility codes) interned via lookup table. The router code in
    src/routing/graph.js mirrors this shape.

    Geometry sharing: directed forward and reverse edges of the same
    undirected segment share a single entry in the `geoms` array; the edge
    stores an index and a `reversed` flag.
    """
    print("  serializing...")
    used = set()
    for e in directed_edges:
        used.add(e["from"]); used.add(e["to"])
    keep = [nid for nid in nodes if nid in used]
    remap = {nid: i for i, nid in enumerate(keep)}

    # Geometry deduplication: hash the tuple of coords.
    geoms = []
    geom_index = {}
    def add_geom(coords_list):
        key = tuple((c[0], c[1]) for c in coords_list)
        rev_key = tuple(reversed(key))
        if key in geom_index:
            return geom_index[key], False
        if rev_key in geom_index:
            return geom_index[rev_key], True
        idx = len(geoms)
        geoms.append([list(c) for c in coords_list])
        geom_index[key] = idx
        return idx, False

    # String interning helpers
    def interner():
        table = []
        index = {}
        def intern(s):
            if s is None or s == "":
                return -1
            if s in index:
                return index[s]
            i = len(table)
            index[s] = i
            table.append(s)
            return i
        return table, intern

    names,  intern_name  = interner()
    facs,   intern_fac   = interner()
    models, intern_model = interner()

    # Node arrays
    n_lon, n_lat, n_flags = [], [], []
    n_edges = [[] for _ in keep]
    for nid in keep:
        lon, lat = nodes[nid]
        n_lon.append(round(lon, 6))
        n_lat.append(round(lat, 6))
        f = control_flags.get(nid) or {"sig": False, "xwk": False,
                                       "bcn": False, "stopBits": 0}
        # Bitfield layout (matches graph.js nodeFlags() / hasStopFacing()):
        #   bit 0: hasSignal
        #   bit 1: hasCrosswalk
        #   bit 2: hasBeacon
        #   bit 3: isTrafficCircle
        #   bits 4..11: stop-sign FACING (one bit per cardinal direction,
        #               in STOP_FACING_BITS order: N, NE, E, SE, S, SW, W, NW).
        flag = 0
        if f["sig"]: flag |= 1
        if f["xwk"]: flag |= 2
        if f["bcn"]: flag |= 4
        if is_circle.get(nid): flag |= 8
        flag |= (f.get("stopBits", 0) & 0xFF) << 4
        n_flags.append(flag)

    # Edge arrays
    e_from, e_to = [], []
    e_lenFt, e_lanes = [], []
    e_flags, e_fac, e_model, e_name = [], [], [], []
    e_geom, e_geom_rev = [], []
    e_b0, e_b1 = [], []

    for i, e in enumerate(directed_edges):
        fr = remap[e["from"]]; to = remap[e["to"]]
        gidx, grev = add_geom(e["geometry"])
        # Bitfield: 1 = hasCenterline, 2 = oneway.
        flags = 0
        if e["hasCenterline"]: flags |= 1
        if e["oneway"]:        flags |= 2
        e_from.append(fr); e_to.append(to)
        e_lenFt.append(e["lengthFt"]); e_lanes.append(e["lanes"])
        e_flags.append(flags)
        e_fac.append(intern_fac(e["facilityCategory"]))
        e_model.append(intern_model(e["facilityModelType"]))
        e_name.append(intern_name(e["streetName"]))
        e_geom.append(gidx); e_geom_rev.append(grev)
        e_b0.append(e["bearingStart"]); e_b1.append(e["bearingEnd"])
        n_edges[fr].append(i)

    bbox = [min(n_lon), min(n_lat), max(n_lon), max(n_lat)]
    payload = {
        "meta": {
            "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "node_count": len(n_lon),
            "edge_count": len(e_from),
            "geom_count": len(geoms),
            "bbox": bbox,
        },
        "names":      names,
        "facilities": facs,
        "modelTypes": models,
        "geoms":      geoms,
        "nodes": {
            "lon":   n_lon,
            "lat":   n_lat,
            "flags": n_flags,
            "edges": n_edges,
        },
        "edges": {
            "from":     e_from,
            "to":       e_to,
            "lengthFt": e_lenFt,
            "lanes":    e_lanes,
            "flags":    e_flags,
            "facility": e_fac,
            "model":    e_model,
            "name":     e_name,
            "geom":     e_geom,
            "geomRev":  e_geom_rev,
            "b0":       e_b0,
            "b1":       e_b1,
        },
    }
    out_path.write_text(json.dumps(payload, separators=(",", ":")))
    size_mb = out_path.stat().st_size / (1024 * 1024)
    print(f"    wrote {out_path.relative_to(ROOT)} "
          f"({len(n_lon):,} nodes, {len(e_from):,} edges, "
          f"{len(geoms):,} geom segs, {size_mb:.1f} MB)")


# ---------- main ----------

def main():
    print(f"build_graph.py — output: {OUT.relative_to(ROOT)}")
    poly = load_seattle_polygon()
    bbox = poly.bounds  # (minLon, minLat, maxLon, maxLat)

    print("Step A: fetching OSM via Overpass...")
    elements = fetch_overpass(bbox)
    print(f"  {len(elements):,} elements")

    print("Step B: parsing OSM...")
    nodes, edges = parse_osm(elements, poly)
    build_edge_geometries(nodes, edges)

    print("Step B.1: collecting OSM mini-roundabouts...")
    osm_circle_pts = extract_osm_circles(elements)
    print(f"    {len(osm_circle_pts):,} OSM nodes")

    print("Step C: spatial-join SDOT seattle_streets...")
    spatial_join_streets(edges, DATA / "seattle_streets.geojson")

    # (Alley spatial-join removed entirely — alleys are excluded at OSM
    # parse time via _is_bike_routable, so they never enter the graph and
    # an explicit isAlley flag adds nothing.)

    print("Step E: spatial-join all AAA-rendered facility sources...")
    spatial_join_facilities(edges, DATA)

    print("Step F: snap intersection-control points to nodes...")
    control_flags = snap_control_points(
        nodes,
        DATA / "signals.geojson",
        DATA / "crosswalks.geojson",
        DATA / "beacons.geojson",
        DATA / "stop_signs.geojson",
    )

    print("Step G: detect geometric traffic-circle rings from OSM topology...")
    geo_circle_pts = detect_geometric_circles(nodes, edges)
    print(f"    {len(geo_circle_pts):,} OSM rings detected geometrically")

    print("Step G.1: collapse all traffic-circle node clusters...")
    edges, is_circle = collapse_traffic_circles(
        nodes, edges,
        DATA / "traffic_circles.geojson",
        extra_circle_pts=osm_circle_pts + geo_circle_pts,
    )

    print("Step H: expand to directed edges + precompute constants...")
    directed = expand_to_directed(nodes, edges, is_circle)

    print("Step I: renumber and serialize...")
    renumber_and_serialize(nodes, directed, control_flags, is_circle, OUT)

    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
