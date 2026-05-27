#!/usr/bin/env python3
"""
Elevation prep — Stage 1 of two: sample (smoothed) USGS 3DEP DTM at
every routing-graph node, uniform-resample per-edge profiles, and
extract 25-ft contour lines from the raw DTM.

The DTM (Digital Terrain Model, bare earth) for Western Washington is
USGS 3DEP 1/3 arc-second tile `n48w123` (~10 m resolution, ~415 MB).
We stream it via rasterio `/vsicurl/` — only the Seattle window
(~10×10 km) is actually fetched via HTTP range requests, totaling a
few MB rather than the full 415 MB. The fetched window is cached to
`dtm_cache/seattle_window.npy` so repeat runs are instant.

Outputs:
  - public/data/routing_graph.json   Populates nodes.elev[], geomElevs[]
                                     (per-vertex bilinear DTM, sampled
                                     from a 5×5-median + σ=2 Gaussian-
                                     smoothed window), and the per-
                                     directed-edge climb metrics
                                     (uphillFt, maxUphillPct, steepFt2)
                                     computed against a uniform 75-ft
                                     sub-segment resample. Bridges and
                                     other DTM-wrong corridors are NOT
                                     fixed here — that's Stage 2
                                     (resolve_elevation.py).
  - public/data/contours.geojson     25-ft contour lines (-50 .. 500 ft),
                                     extracted from the RAW (unsmoothed)
                                     DTM so the topographic layer stays
                                     free of resampling artifacts.
"""

import json
import math
import os
import time
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import from_bounds
from rasterio.transform import Affine
from scipy.ndimage import median_filter, gaussian_filter
from skimage import measure
from shapely.geometry import LineString


# USGS 3DEP 1/3 arc-second seamless DEM, tile n48w123 (Western WA).
DTM_URL = (
    "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/"
    "current/n48w123/USGS_13_n48w123.tif"
)
DTM_VSICURL = f"/vsicurl/{DTM_URL}"

GRAPH_PATH    = Path("public/data/routing_graph.json")
CONTOURS_OUT  = Path("public/data/contours.geojson")
WINDOW_CACHE  = Path("dtm_cache/seattle_window.npy")
WINDOW_META   = Path("dtm_cache/seattle_window.json")

CONTOUR_LEVELS = list(range(-50, 525, 25))     # -50, -25, 0, ..., 500
COORD_DECIMALS = 6
# Douglas-Peucker tolerance for contour simplification. 9e-5 deg ≈ 10 m
# at this latitude — empirically tuned for ~1.7 MB / ~67 K-vertex output.
SIMPLIFY_TOL_DEG = 9e-5

M_TO_FT = 3.28084                              # USGS 3DEP DTM is in meters NAVD88


def fetch_window(west, south, east, north):
    """Return (elev_m_array, win_transform, nodata). Caches to disk."""
    if WINDOW_CACHE.exists() and WINDOW_META.exists():
        print(f"[sample_dtm] reusing cached {WINDOW_CACHE}")
        elev_m = np.load(WINDOW_CACHE)
        meta = json.loads(WINDOW_META.read_text())
        return elev_m, Affine(*meta["transform"]), meta["nodata"]

    print(f"[sample_dtm] streaming DTM window from {DTM_URL} ...")
    WINDOW_CACHE.parent.mkdir(exist_ok=True)
    with rasterio.Env(GDAL_HTTP_TIMEOUT="60", CPL_VSIL_CURL_CHUNK_SIZE="1048576"):
        with rasterio.open(DTM_VSICURL) as ds:
            print(f"[sample_dtm]   source: CRS={ds.crs}, shape={ds.shape}, "
                  f"nodata={ds.nodata}, transform={ds.transform}")
            window = from_bounds(west, south, east, north, ds.transform)
            print(f"[sample_dtm]   reading window {window} ...")
            t0 = time.time()
            elev_m = ds.read(1, window=window, masked=False)
            print(f"[sample_dtm]   read {elev_m.shape} in {time.time()-t0:.1f}s")
            win_transform = ds.window_transform(window)
            nodata = float(ds.nodata) if ds.nodata is not None else None

    np.save(WINDOW_CACHE, elev_m)
    WINDOW_META.write_text(json.dumps({
        "transform": [win_transform.a, win_transform.b, win_transform.c,
                      win_transform.d, win_transform.e, win_transform.f],
        "nodata": nodata,
        "shape": list(elev_m.shape),
        "source_url": DTM_URL,
        "units": "meters",
        "bbox_lonlat": [west, south, east, north],
    }))
    print(f"[sample_dtm]   cached → {WINDOW_CACHE}")
    return elev_m, win_transform, nodata


def sample_nodes(graph, elev_ft, win_transform):
    """Bilinear-sample DTM at every routing-graph node. Returns list of feet."""
    lons = np.array(graph["nodes"]["lon"], dtype="float64")
    lats = np.array(graph["nodes"]["lat"], dtype="float64")

    a, b, c = win_transform.a, win_transform.b, win_transform.c
    d, e, f = win_transform.d, win_transform.e, win_transform.f
    # north-up raster: b==0, d==0
    cols = (lons - c) / a
    rows = (lats - f) / e

    h, w = elev_ft.shape
    c0 = np.clip(np.floor(cols).astype(int), 0, w - 2)
    r0 = np.clip(np.floor(rows).astype(int), 0, h - 2)
    fc = cols - c0
    fr = rows - r0

    v00 = elev_ft[r0,     c0    ]
    v01 = elev_ft[r0,     c0 + 1]
    v10 = elev_ft[r0 + 1, c0    ]
    v11 = elev_ft[r0 + 1, c0 + 1]
    samples = (v00 * (1 - fc) * (1 - fr) +
               v01 * fc       * (1 - fr) +
               v10 * (1 - fc) * fr       +
               v11 * fc       * fr)

    in_bounds = (cols >= 0) & (cols < w) & (rows >= 0) & (rows < h)
    samples = np.where(in_bounds, samples, 0.0)
    samples = np.nan_to_num(samples, nan=0.0)
    return [round(float(v), 1) for v in samples]


# The 2% steep threshold is baked into the precomputed steepFt2 here;
# cost.js multiplies that by `steepCoeff` (no JS-side threshold). Change
# this and you must rebuild the graph.
STEEP_THRESHOLD = 0.02
EARTH_RADIUS_FT = 20902231.0

# Per-edge climb metrics (uphillFt / maxUphillPct / steepFt2) are
# computed on a RESAMPLED uniform-spacing profile so that the metrics
# don't depend on OSM mappers' vertex-placement choices. For each geom
# of total arc-length L, we split into max(1, round(L / 75 ft)) evenly-
# spaced sub-segments and linear-interp the elevation at each break-
# point from the per-OSM-vertex profile. 75 ft is the practical sweet
# spot — fine enough to preserve real terrain features, coarse enough
# to smooth out single-segment "catch up" artifacts where the OSM
# centerline drifts off-true and corrects itself at the next vertex.
# `geomElevs[]` is then rewritten with the resampled curve linear-
# interped back to the OSM vertex positions, so the chart and
# climbStats see the same smoothed curve the cost metrics were built
# from.
COST_RESAMPLE_FT = 75.0

# Light raster denoising for graph sampling ONLY. Contour extraction
# still runs against the raw DTM so the topographic-line layer remains
# pristine. The two-pass median + Gaussian combo kills isolated spike
# outliers AND continuous low-amplitude noise without smearing real
# terrain edges (bluffs, retaining walls) too much. Bridges are NOT
# fixed by this — they're systematic, not noise — and are corrected in
# the Stage-2 heat-equation pass (resolve_elevation.py).
MEDIAN_KERNEL_SIZE = 5      # 5×5 = ~50 m at our 10 m raster
GAUSSIAN_SIGMA_PX  = 2.0    # σ ~ 2 cells — moderate residual smoothing


def smooth_raster(elev_ft):
    """Apply median + Gaussian denoising. Returns a new array of the
    same shape; the input is not modified."""
    arr = elev_ft
    if np.isnan(arr).any():
        # Fill NaN cells with the global median so filters don't
        # propagate them. Cheap fallback — our Seattle window has no
        # NaN today, but USGS releases can introduce them later.
        fallback = float(np.nanmedian(arr))
        arr = np.where(np.isnan(arr), fallback, arr)
    smoothed = median_filter(arr, size=MEDIAN_KERNEL_SIZE)
    smoothed = gaussian_filter(smoothed, sigma=GAUSSIAN_SIGMA_PX)
    return smoothed.astype("float32")


def sample_geom_elevs(graph, elev_ft, win_transform):
    """Bilinear-sample DTM at every vertex of every unique geom.

    Returns a list-of-lists parallel to graph['geoms'] — each inner list
    is one float-per-vertex in the geom's raw orientation. Directed
    edges that share a geom share this profile (the consumer flips it
    via graph.geomRev[id] for reverse traversal)."""
    # Flatten all vertices for one vectorized bilinear sample.
    lengths = [len(g) for g in graph["geoms"]]
    flat_lons = np.fromiter(
        (pt[0] for g in graph["geoms"] for pt in g),
        dtype="float64", count=sum(lengths))
    flat_lats = np.fromiter(
        (pt[1] for g in graph["geoms"] for pt in g),
        dtype="float64", count=sum(lengths))

    a, c = win_transform.a, win_transform.c
    e, f = win_transform.e, win_transform.f
    cols = (flat_lons - c) / a
    rows = (flat_lats - f) / e
    h, w = elev_ft.shape
    c0 = np.clip(np.floor(cols).astype(int), 0, w - 2)
    r0 = np.clip(np.floor(rows).astype(int), 0, h - 2)
    fc = cols - c0
    fr = rows - r0
    v00 = elev_ft[r0,     c0    ]
    v01 = elev_ft[r0,     c0 + 1]
    v10 = elev_ft[r0 + 1, c0    ]
    v11 = elev_ft[r0 + 1, c0 + 1]
    samples = (v00 * (1 - fc) * (1 - fr) +
               v01 * fc       * (1 - fr) +
               v10 * (1 - fc) * fr       +
               v11 * fc       * fr)
    in_bounds = (cols >= 0) & (cols < w) & (rows >= 0) & (rows < h)
    samples = np.where(in_bounds, samples, 0.0)
    samples = np.nan_to_num(samples, nan=0.0)

    geom_elevs = []
    offset = 0
    for n in lengths:
        geom_elevs.append([round(float(v), 1) for v in samples[offset:offset + n]])
        offset += n
    return geom_elevs


def _haversine_ft(lon1, lat1, lon2, lat2):
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_FT * math.asin(math.sqrt(h))


def _resample_geom_profile(geom_coords, geom_elev, target_spacing_ft):
    """Resample a per-OSM-vertex elevation profile in two consistent
    representations:

      breakpoint_elevs       — n+1 elevations at uniform spacing
                               (seg_len = total_arc / n, where
                                n = max(1, round(total_arc / target)))
      back_interp_at_osm     — len(geom_elev) elevations at the ORIGINAL
                               OSM vertex positions, linear-interped back
                               from the breakpoint profile

    Both arrays are derived from the same uniform-resampled curve.
    Cost-metric computation uses `breakpoint_elevs` (uniform sub-segments
    → no OSM-vertex-spacing artifacts); chart + climbStats consume the
    back-interp version via `geomElevs[]` so they see the same smoothed
    curve sampled at the geometry the chart actually plots.

    Returns (seg_len_ft, breakpoint_elevs, back_interp_at_osm).
    For edges shorter than target_spacing_ft, n=1 → just the endpoints
    (no detail added or lost vs the original 2-vertex case).
    """
    cum = [0.0]
    for k in range(len(geom_coords) - 1):
        cum.append(cum[-1] +
                   _haversine_ft(geom_coords[k][0], geom_coords[k][1],
                                  geom_coords[k+1][0], geom_coords[k+1][1]))
    total = cum[-1]
    if total <= 0 or len(geom_elev) < 2:
        flat = list(geom_elev) if geom_elev else [0.0, 0.0]
        return 0.0, flat, flat

    n_segs = max(1, round(total / target_spacing_ft))
    seg_len = total / n_segs
    bp_dists = [s * seg_len if s < n_segs else total for s in range(n_segs + 1)]

    # Pass 1: linear-interp original per-vertex profile → uniform breakpoints
    bp_elevs = []
    seg_idx = 0
    for d in bp_dists:
        while seg_idx < len(cum) - 1 and cum[seg_idx + 1] < d:
            seg_idx += 1
        if seg_idx >= len(cum) - 1:
            bp_elevs.append(geom_elev[-1])
            continue
        a, b = cum[seg_idx], cum[seg_idx + 1]
        if b == a:
            bp_elevs.append(geom_elev[seg_idx])
        else:
            t = (d - a) / (b - a)
            bp_elevs.append(geom_elev[seg_idx] +
                            t * (geom_elev[seg_idx + 1] - geom_elev[seg_idx]))

    # Pass 2: linear-interp those breakpoints back to OSM vertex distances
    back_elevs = []
    bp_idx = 0
    for vd in cum:
        while bp_idx < n_segs and bp_dists[bp_idx + 1] < vd:
            bp_idx += 1
        if bp_idx >= n_segs:
            back_elevs.append(bp_elevs[-1])
            continue
        a, b = bp_dists[bp_idx], bp_dists[bp_idx + 1]
        if b == a:
            back_elevs.append(bp_elevs[bp_idx])
        else:
            t = (vd - a) / (b - a)
            back_elevs.append(bp_elevs[bp_idx] +
                              t * (bp_elevs[bp_idx + 1] - bp_elevs[bp_idx]))

    return seg_len, bp_elevs, back_elevs


def compute_edge_climb_metrics(graph, geom_elevs):
    """For each directed edge, derive uphillFt / maxUphillPct / steepFt2
    from a UNIFORM-spacing resample of the geom's per-vertex DTM profile.
    Returns three parallel arrays (length = directed-edge count).

    Conventions match graph.js + cost.js:
      uphillFt[i]      total positive rise in directed traversal direction
      maxUphillPct[i]  max sub-segment uphill slope as a FRACTION (0.05 = 5%)
      steepFt2[i]      Σ_seg(length_ft · max(0, slope − 0.02)²) over uphill segs

    The resampling step decouples these metrics from OSM mapper vertex
    placement — without it, a centerline that's drawn slightly off-true
    and corrects with one short final segment shows that catch-up
    segment as catastrophically steep, even when the actual climb is
    spread over a much longer arc.

    Side effect: OVERWRITES `geom_elevs` (a list of per-geom elev lists)
    in place with the same resampled profile linear-interped back to
    the original OSM vertex positions. Routes' directions-panel chart
    + `climbStats` consume `graph.edgeElevProfile()` → `geomElevs[]`,
    so this ensures the chart, the steepest-uphill caption, and the
    routing cost all reference the same smoothed elevations.
    """
    geoms = graph["geoms"]
    n_edges = len(graph["edges"]["from"])
    edge_geom = graph["edges"]["geom"]
    edge_rev  = graph["edges"]["geomRev"]

    # Resample each geom once. breakpoint_elevs drives the cost metrics
    # (uniform sub-segments); back_interp_at_osm replaces geom_elevs[gi]
    # so the chart sees the same smoothed curve at the OSM-vertex grid.
    geom_resampled = []  # parallel to geoms: (seg_len, breakpoint_elevs)
    for gi, g in enumerate(geoms):
        seg_len, bp_elevs, back_elevs = _resample_geom_profile(
            g, geom_elevs[gi], COST_RESAMPLE_FT)
        geom_resampled.append((seg_len, bp_elevs))
        # 1-decimal round keeps the JSON compact without losing visible detail.
        geom_elevs[gi] = [round(float(v), 1) for v in back_elevs]

    uphill_ft   = [0.0] * n_edges
    max_up_pct  = [0.0] * n_edges
    steep_ft2   = [0.0] * n_edges

    for i in range(n_edges):
        seg_len, profile = geom_resampled[edge_geom[i]]
        if edge_rev[i]:
            profile = profile[::-1]

        u = 0.0
        mp = 0.0
        sf = 0.0
        for j in range(len(profile) - 1):
            dz = profile[j+1] - profile[j]
            if dz > 0 and seg_len > 0:
                u += dz
                slope = dz / seg_len
                if slope > mp:
                    mp = slope
                ex = slope - STEEP_THRESHOLD
                if ex > 0:
                    sf += seg_len * ex * ex
        uphill_ft[i]  = round(u, 2)
        max_up_pct[i] = round(mp, 4)
        steep_ft2[i]  = round(sf, 3)

    return uphill_ft, max_up_pct, steep_ft2


def extract_contours(elev_ft, win_transform):
    """Marching squares at every 25-ft level; returns list of GeoJSON features."""
    a, c = win_transform.a, win_transform.c
    e, f = win_transform.e, win_transform.f
    # Pre-replace nan with a sentinel below the lowest level so contours skip it.
    elev_fc = np.where(np.isnan(elev_ft), -9999.0, elev_ft)

    features = []
    for level in CONTOUR_LEVELS:
        contours = measure.find_contours(elev_fc, level)
        kept = 0
        for contour in contours:
            if len(contour) < 2:
                continue
            rs = contour[:, 0]
            cs = contour[:, 1]
            lons_c = a * cs + c    # b == 0
            lats_c = e * rs + f    # d == 0
            line = LineString(zip(lons_c, lats_c))
            if line.length == 0:
                continue
            simp = line.simplify(SIMPLIFY_TOL_DEG, preserve_topology=False)
            if simp.is_empty or simp.length == 0:
                continue
            simp_coords = list(simp.coords)
            if len(simp_coords) < 2:
                continue

            rounded = [[round(lon, COORD_DECIMALS), round(lat, COORD_DECIMALS)]
                       for lon, lat in simp_coords]
            features.append({
                "type": "Feature",
                "properties": {
                    "elev_ft": level,
                    "index": 1 if level % 100 == 0 else 0,
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": rounded,
                },
            })
            kept += 1
        print(f"[sample_dtm]   level {level:>4} ft: {kept} features")
    return features


def main():
    t0 = time.time()
    print(f"[sample_dtm] loading {GRAPH_PATH} ...")
    graph = json.loads(GRAPH_PATH.read_text())
    west, south, east, north = graph["meta"]["bbox"]
    pad = 0.01
    print(f"[sample_dtm] bbox (padded): "
          f"lon [{west - pad}, {east + pad}], lat [{south - pad}, {north + pad}]")

    elev_m, win_transform, nodata = fetch_window(west - pad, south - pad,
                                                  east + pad, north + pad)

    if nodata is not None:
        elev_m = np.where(elev_m == nodata, np.nan, elev_m)
    elev_ft = elev_m.astype("float32") * M_TO_FT
    valid = ~np.isnan(elev_ft)
    print(f"[sample_dtm] window {elev_ft.shape}: "
          f"valid {valid.sum():,}/{elev_ft.size:,}, "
          f"elev {np.nanmin(elev_ft):.1f} – {np.nanmax(elev_ft):.1f} ft")

    print(f"[sample_dtm] smoothing for graph sampling "
          f"({MEDIAN_KERNEL_SIZE}×{MEDIAN_KERNEL_SIZE} median + "
          f"σ={GAUSSIAN_SIGMA_PX} px Gaussian); contours stay on raw DTM...")
    elev_ft_smooth = smooth_raster(elev_ft)
    # Quick sanity report on what changed in the window.
    delta = elev_ft_smooth - elev_ft
    print(f"[sample_dtm]   smoothing delta: "
          f"|max|={np.nanmax(np.abs(delta)):.1f} ft, "
          f"stdev={np.nanstd(delta):.3f} ft, "
          f"p99|Δ|={np.nanpercentile(np.abs(delta), 99):.2f} ft")

    print("[sample_dtm] sampling nodes from smoothed DTM (bilinear)...")
    node_elev = sample_nodes(graph, elev_ft_smooth, win_transform)
    print(f"[sample_dtm]   sampled {len(node_elev)} nodes; "
          f"range {min(node_elev):.1f} – {max(node_elev):.1f} ft")

    graph["nodes"]["elev"] = node_elev
    graph.setdefault("meta", {})
    graph["meta"]["elevation_source"] = (
        f"usgs_3dep_dtm_smoothed_median{MEDIAN_KERNEL_SIZE}_gauss{GAUSSIAN_SIGMA_PX}"
    )
    graph["meta"]["elevation_units"] = "feet"

    print("[sample_dtm] sampling per-vertex DTM along geoms (bilinear, smoothed)...")
    geom_elevs = sample_geom_elevs(graph, elev_ft_smooth, win_transform)
    n_vertices = sum(len(g) for g in geom_elevs)
    print(f"[sample_dtm]   sampled {n_vertices:,} vertices across "
          f"{len(geom_elevs):,} geoms")

    print("[sample_dtm] computing per-directed-edge climb metrics...")
    uphill_ft, max_up_pct, steep_ft2 = compute_edge_climb_metrics(graph, geom_elevs)
    graph["geomElevs"] = geom_elevs
    graph["edges"]["uphillFt"]     = uphill_ft
    graph["edges"]["maxUphillPct"] = max_up_pct
    graph["edges"]["steepFt2"]     = steep_ft2
    graph["meta"]["steep_threshold"] = STEEP_THRESHOLD

    GRAPH_PATH.write_text(json.dumps(graph, separators=(",", ":")))
    print(f"[sample_dtm] wrote {GRAPH_PATH}")
    print(f"[sample_dtm]   uphillFt range: "
          f"{min(uphill_ft):.1f} – {max(uphill_ft):.1f} ft")
    print(f"[sample_dtm]   maxUphillPct range: "
          f"{min(max_up_pct):.3f} – {max(max_up_pct):.3f} (fractions)")
    print(f"[sample_dtm]   steepFt2 range: "
          f"{min(steep_ft2):.1f} – {max(steep_ft2):.1f}")

    print("[sample_dtm] extracting contours via marching squares...")
    features = extract_contours(elev_ft, win_transform)

    geojson = {"type": "FeatureCollection", "features": features}
    CONTOURS_OUT.write_text(json.dumps(geojson, separators=(",", ":")))
    nv = sum(len(ft["geometry"]["coordinates"]) for ft in features)
    sz = CONTOURS_OUT.stat().st_size
    print(f"[sample_dtm] wrote {CONTOURS_OUT}: "
          f"{len(features)} features, {nv:,} vertices, {sz/1e6:.2f} MB")
    print(f"[sample_dtm] done in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
