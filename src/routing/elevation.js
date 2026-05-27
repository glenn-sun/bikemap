// Elevation profile + climb stats for a computed route.
//
// Pure functions over the routing graph. Stitches together each edge's
// per-point elevation profile (in the edge's directed-traversal order)
// into a single (distanceFt, elevationFt) series, then derives:
//   - totalUphillFt: cumulative gain across all uphill segments
//   - totalDownhillFt: cumulative loss across all downhill segments
//   - steepestUphillPct: max uphill grade (fraction) over a moving
//     window so a single noisy 5-ft jump doesn't pin the display value
//   - elevation range
//
// The graph stores per-edge `uphillFt` and `maxUphillPct` precomputed
// from the same smoothed profile, but the live route may include partial
// edges at the start/end (mid-edge snap projections). Stitching the
// raw profile here keeps the chart, the summary stats, and the routing
// cost function all referring to the same elevations.

const FT_PER_LON = 245000;
const FT_PER_LAT = 364000;

function segLenFt(p1, p2) {
  const dx = (p2[0] - p1[0]) * FT_PER_LON;
  const dy = (p2[1] - p1[1]) * FT_PER_LAT;
  return Math.hypot(dx, dy);
}

/**
 * Build a {distances: [ft], elevations: [ft]} series for a route.
 *
 * Returns null if the graph carries no elevation data, so callers can
 * gracefully render a "no elevation" placeholder.
 *
 * Prefix / suffix slices (from mid-edge projections) are estimated by
 * linearly interpolating across the parent edge's elevation profile —
 * good enough for the chart since the projection rarely cuts more than
 * 100 ft off an edge.
 */
export function buildElevationSeries(graph, route) {
  if (!graph.hasElevation || !route?.pathEdgeIds?.length) return null;
  const distances = [];
  const elevations = [];
  const coords = [];   // parallel [lon, lat] per series point — used by the
                       // chart-hover ↔ map-hover cursor sync in routing/ui.js
  let cumDist = 0;

  const addPoint = (dist, elev, lon, lat) => {
    distances.push(dist);
    elevations.push(elev);
    coords.push([lon, lat]);
  };

  // ---- Prefix: linearly interpolate elevation across the prefix polyline.
  // The first edge's profile covers [start node, end node] in travel order;
  // its first elevation = elev at the edge's `from` node. Routes starting
  // mid-edge replace the start with a projection point. We approximate
  // that point's elevation by linearly interpolating along the prefix.
  const firstEdge = route.pathEdgeIds[0];
  const firstProfile = graph.edgeElevProfile(firstEdge);
  const firstEdgeStartElev = firstProfile[0];
  if (route.prefixGeom && route.prefixGeom.length > 0) {
    const prefix = route.prefixGeom;
    const prefixLen = polylineLenFt(prefix);
    addPoint(0, firstEdgeStartElev, prefix[0][0], prefix[0][1]);
    let d = 0;
    for (let i = 1; i < prefix.length; i++) {
      d += segLenFt(prefix[i - 1], prefix[i]);
      const t = prefixLen > 0 ? d / prefixLen : 1;
      addPoint(d, firstEdgeStartElev + (firstProfile[0] - firstEdgeStartElev) * t,
               prefix[i][0], prefix[i][1]);
    }
    cumDist = prefixLen;
  } else {
    const startPt = graph.edge(firstEdge).geometry[0];
    addPoint(0, firstEdgeStartElev, startPt[0], startPt[1]);
  }

  // ---- Edges: walk each edge's profile, emitting points at cumulative ft.
  for (let ei = 0; ei < route.pathEdgeIds.length; ei++) {
    const eid = route.pathEdgeIds[ei];
    const profile = graph.edgeElevProfile(eid);
    const edge = graph.edge(eid);
    const pts = edge.geometry;
    // The first profile point matches the previous edge's last point, so
    // skip it to avoid duplication.
    for (let i = 1; i < pts.length; i++) {
      cumDist += segLenFt(pts[i - 1], pts[i]);
      addPoint(cumDist, profile[i], pts[i][0], pts[i][1]);
    }
  }

  // ---- Suffix: hold elevation flat at the last edge's end-node value
  // along the suffix polyline (same proxy as the prefix).
  if (route.suffixGeom && route.suffixGeom.length > 1) {
    const suffix = route.suffixGeom;
    const endNodeElev = elevations[elevations.length - 1];
    for (let i = 1; i < suffix.length; i++) {
      cumDist += segLenFt(suffix[i - 1], suffix[i]);
      addPoint(cumDist, endNodeElev, suffix[i][0], suffix[i][1]);
    }
  }

  return { distances, elevations, coords };
}

function polylineLenFt(poly) {
  let t = 0;
  for (let i = 1; i < poly.length; i++) t += segLenFt(poly[i - 1], poly[i]);
  return t;
}

/** Binary-search the series for the segment containing distance `d`, then
 *  linearly interpolate to return { lon, lat, elevFt }. Out-of-range d
 *  is clamped to the endpoints. */
export function pointAtDistance(series, d) {
  const { distances, elevations, coords } = series;
  const N = distances.length;
  if (N === 0) return null;
  if (d <= distances[0]) {
    return { lon: coords[0][0], lat: coords[0][1], elevFt: elevations[0] };
  }
  if (d >= distances[N - 1]) {
    return { lon: coords[N - 1][0], lat: coords[N - 1][1], elevFt: elevations[N - 1] };
  }
  let lo = 0, hi = N - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (distances[mid] <= d) lo = mid; else hi = mid;
  }
  const t = (d - distances[lo]) / (distances[hi] - distances[lo]);
  return {
    lon: coords[lo][0] + t * (coords[hi][0] - coords[lo][0]),
    lat: coords[lo][1] + t * (coords[hi][1] - coords[lo][1]),
    elevFt: elevations[lo] + t * (elevations[hi] - elevations[lo]),
  };
}

/** Local slope (fraction, signed: positive = uphill, negative = downhill)
 *  at distance `d` along the series, smoothed over a ±windowFt/2 window.
 *  Smoothing matters because raw per-segment slope is jittery when the
 *  series has dense interior geometry — a single 5 ft segment with
 *  rounded elevations can show 8% even on a flat road. */
export function slopeAtDistance(series, d, windowFt = 100) {
  const total = series.distances[series.distances.length - 1] || 0;
  if (total <= 0) return 0;
  const lo = Math.max(0, d - windowFt / 2);
  const hi = Math.min(total, d + windowFt / 2);
  const dx = hi - lo;
  if (dx <= 0) return 0;
  const pLo = pointAtDistance(series, lo);
  const pHi = pointAtDistance(series, hi);
  return (pHi.elevFt - pLo.elevFt) / dx;
}

/** Project (lon, lat) onto the route polyline and return the cumulative
 *  distance from the start at the closest point. Used by the map→chart
 *  cursor sync: as the cursor moves over the route line, we compute its
 *  position along the route and update the chart. Returns null if the
 *  series is empty. */
export function distanceAtPoint(series, lon, lat) {
  const { distances, coords } = series;
  const N = coords.length;
  if (N < 2) return null;
  let bestD = 0;
  let bestSq = Infinity;
  for (let i = 1; i < N; i++) {
    const [x0, y0] = coords[i - 1];
    const [x1, y1] = coords[i];
    const ax = (x1 - x0) * FT_PER_LON;
    const ay = (y1 - y0) * FT_PER_LAT;
    const qx = (lon - x0) * FT_PER_LON;
    const qy = (lat - y0) * FT_PER_LAT;
    const sq = ax * ax + ay * ay;
    let t = sq > 0 ? (qx * ax + qy * ay) / sq : 0;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    const dx = qx - t * ax;
    const dy = qy - t * ay;
    const dsq = dx * dx + dy * dy;
    if (dsq < bestSq) {
      bestSq = dsq;
      bestD = distances[i - 1] + (distances[i] - distances[i - 1]) * t;
    }
  }
  return bestD;
}

/**
 * Climb stats from a series:
 *   - totalUphillFt  : sum of all positive Δelev
 *   - totalDownhillFt: sum of |negative Δelev|
 *   - minElevFt, maxElevFt
 *   - steepestUphillPct: max grade computed over a 100-ft sliding window.
 *     We use a window rather than per-segment so a single 5-ft segment
 *     with a noisy 1-ft elevation jump (15% grade!) doesn't dominate
 *     what the user sees as "the steepest part of this route."
 */
export function climbStats(series, windowFt = 100) {
  if (!series || series.elevations.length < 2) {
    return { totalUphillFt: 0, totalDownhillFt: 0,
             minElevFt: 0, maxElevFt: 0, steepestUphillPct: 0 };
  }
  const { distances: d, elevations: e } = series;
  let up = 0, down = 0;
  let minE = e[0], maxE = e[0];
  for (let i = 1; i < e.length; i++) {
    const dh = e[i] - e[i - 1];
    if (dh > 0) up += dh; else down += -dh;
    if (e[i] < minE) minE = e[i];
    if (e[i] > maxE) maxE = e[i];
  }
  // Sliding window for the steepest sustained climb.
  let steepest = 0;
  let j = 0;
  for (let i = 1; i < d.length; i++) {
    while (d[i] - d[j] > windowFt && j < i - 1) j++;
    const dx = d[i] - d[j];
    if (dx < windowFt * 0.5) continue;     // skip tiny windows
    const dh = e[i] - e[j];
    if (dh > 0 && dh / dx > steepest) steepest = dh / dx;
  }
  return {
    totalUphillFt:   Math.round(up),
    totalDownhillFt: Math.round(down),
    minElevFt:       Math.round(minE),
    maxElevFt:       Math.round(maxE),
    steepestUphillPct: steepest,
  };
}

/**
 * Render an SVG <path> string for the elevation series, fitted into a
 * (width × height) box with internal padding `pad`. Returns the path
 * data string for the elevation line, plus axis tick info.
 */
export function elevationProfileSvg(series, opts = {}) {
  const w = opts.width ?? 320;
  const h = opts.height ?? 114;
  // Top padding 32 reserves room for the 3-line hover tooltip (elev /
  // distance / grade-%, ~10 px per line). Total chart inner height
  // stays the same as before (66 px) by adding 16 px to both the
  // overall height and the top padding.
  //
  // Horizontal padding:
  //   pad.l = 40 → fits the y-axis tick labels ("525 ft" ≈ 32 px at
  //                10 px tabular-nums) sitting at `x = pad.l - 4` with
  //                text-anchor="end". With pad.l = 40, label right edge
  //                is at x = 36 and the leftmost glyph lands around
  //                x = 4 — safely inside the SVG.
  //   pad.r = 22 → fits the right end of the cursor tooltip
  //                ("+24.5%" ≈ 36 px, text-anchor="middle"). When the
  //                cursor reaches the rightmost data point at
  //                x = w - pad.r, the tooltip extends ~18 px past it,
  //                landing at x ≈ w - 4 — safely inside the SVG.
  const pad = { l: 40, r: 22, t: 32, b: 16 };
  if (!series || series.elevations.length < 2) {
    return { width: w, height: h, paths: null };
  }
  const { distances: d, elevations: e } = series;
  const totalDist = d[d.length - 1];
  if (totalDist <= 0) return { width: w, height: h, paths: null };
  let minE = Math.min(...e), maxE = Math.max(...e);
  if (maxE - minE < 10) {
    // Pad the range so a near-flat profile doesn't render as a noisy
    // squiggle filling the whole chart height.
    const mid = (maxE + minE) / 2;
    minE = mid - 5; maxE = mid + 5;
  }
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const xAt = (dist) => pad.l + (dist / totalDist) * innerW;
  const yAt = (elev) => pad.t + (1 - (elev - minE) / (maxE - minE)) * innerH;

  // Polyline as M x y L x y ... — keeps the SVG terse.
  let line = `M${xAt(d[0]).toFixed(1)} ${yAt(e[0]).toFixed(1)}`;
  for (let i = 1; i < d.length; i++) {
    line += ` L${xAt(d[i]).toFixed(1)} ${yAt(e[i]).toFixed(1)}`;
  }
  // Filled area: extend down to the chart baseline.
  const baseline = yAt(minE);
  const area = `${line} L${xAt(d[d.length - 1]).toFixed(1)} ${baseline.toFixed(1)}`
             + ` L${xAt(d[0]).toFixed(1)} ${baseline.toFixed(1)} Z`;
  // Two y-axis tick labels: min and max elevation.
  return {
    width: w, height: h, pad,
    area, line,
    minElevFt: Math.round(minE), maxElevFt: Math.round(maxE),
    totalDistFt: totalDist,
  };
}
