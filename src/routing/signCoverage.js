// Sign-coverage adjustment applied AFTER A* finds the route.
//
// Walks the route's polyline, snaps every bike-sign point within 50 ft to
// the route, marks the closest sign position (as a distance-along-route),
// then computes the fraction of route distance whose nearest snapped sign
// is > 0.25 mi away. That fraction times +0.3 is added to the total cost
// multiplier (i.e. extra ft equivalent to the same fraction of route length
// × 0.3).
//
// Performance: bike_signs has ~6k points in Seattle. For a typical
// 5-mile route that's a handful of ms per query.

import { SIGN_SNAP_THRESHOLD_FT, SIGN_GAP_THRESHOLD_FT,
         SIGN_COVERAGE_MAX_MULTIPLIER } from './cost.js';

const FT_PER_METER = 3.28084;
const R_M = 6371000.0;

function haversineFt(lon1, lat1, lon2, lat2) {
  const toRad = (d) => d * Math.PI / 180;
  const lat1r = toRad(lat1), lat2r = toRad(lat2);
  const dLat = lat2r - lat1r;
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1r) * Math.cos(lat2r) * Math.sin(dLon / 2) ** 2;
  return 2 * R_M * Math.asin(Math.sqrt(a)) * FT_PER_METER;
}

/**
 * Compute the sign-coverage cost multiplier addition (0 .. SIGN_COVERAGE_MAX_MULTIPLIER).
 *
 * @param routeGeometry - array of [lon, lat] points (the route polyline).
 * @param signFeatures  - array of GeoJSON Point features for bike signs.
 * @returns { multiplier, uncoveredFraction, snappedCount } — multiplier is the
 *          extra cost factor; the others are diagnostic.
 */
export function computeSignCoverage(routeGeometry, signFeatures) {
  if (routeGeometry.length < 2) {
    return { multiplier: 0, uncoveredFraction: 0, snappedCount: 0 };
  }

  // Build per-vertex cumulative distance along the route.
  const cumFt = [0];
  for (let i = 1; i < routeGeometry.length; i++) {
    const [x0, y0] = routeGeometry[i - 1];
    const [x1, y1] = routeGeometry[i];
    cumFt.push(cumFt[i - 1] + haversineFt(x0, y0, x1, y1));
  }
  const totalFt = cumFt[cumFt.length - 1];
  if (totalFt < 1) return { multiplier: 0, uncoveredFraction: 0, snappedCount: 0 };

  // Bounding box for fast culling.
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of routeGeometry) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }
  // Pad bbox by ~50 ft in degrees (~0.00015).
  const PAD = 0.00015;
  minLon -= PAD; minLat -= PAD; maxLon += PAD; maxLat += PAD;

  // For each sign within bbox, snap to the closest point on the polyline.
  const snappedDists = [];
  for (const f of signFeatures) {
    const c = f?.geometry?.coordinates;
    if (!c) continue;
    const [slon, slat] = c;
    if (slon < minLon || slon > maxLon || slat < minLat || slat > maxLat) continue;
    let bestDistFt = Infinity;
    let bestAlongFt = 0;
    for (let i = 1; i < routeGeometry.length; i++) {
      const [x0, y0] = routeGeometry[i - 1];
      const [x1, y1] = routeGeometry[i];
      // Closest point on segment in equirectangular approximation.
      const { distFt, alongFt } = closestOnSegmentFt(slon, slat, x0, y0, x1, y1, cumFt[i - 1]);
      if (distFt < bestDistFt) {
        bestDistFt = distFt;
        bestAlongFt = alongFt;
      }
    }
    if (bestDistFt <= SIGN_SNAP_THRESHOLD_FT) {
      snappedDists.push(bestAlongFt);
    }
  }

  if (snappedDists.length === 0) {
    return {
      multiplier: SIGN_COVERAGE_MAX_MULTIPLIER,
      uncoveredFraction: 1,
      snappedCount: 0,
    };
  }
  snappedDists.sort((a, b) => a - b);

  // For each point along the route, the nearest sign distance (along-route)
  // is min(point - prevSign, nextSign - point). Compute the total length
  // covered by 0.25-mi buffers around each sign, then subtract from total.
  let coveredFt = 0;
  const halfWidth = SIGN_GAP_THRESHOLD_FT;
  let prevEnd = -Infinity;
  for (const s of snappedDists) {
    let start = Math.max(0, s - halfWidth);
    let end   = Math.min(totalFt, s + halfWidth);
    if (start > prevEnd) {
      coveredFt += end - start;
      prevEnd = end;
    } else if (end > prevEnd) {
      coveredFt += end - prevEnd;
      prevEnd = end;
    }
  }
  const uncoveredFraction = Math.max(0, Math.min(1, 1 - coveredFt / totalFt));
  return {
    multiplier: uncoveredFraction * SIGN_COVERAGE_MAX_MULTIPLIER,
    uncoveredFraction,
    snappedCount: snappedDists.length,
  };
}

function closestOnSegmentFt(px, py, x0, y0, x1, y1, cumStartFt) {
  // Convert to feet via equirectangular projection centered on (y0, x0).
  // For Seattle: 1 deg lat ≈ 364,000 ft, 1 deg lon ≈ 245,000 ft at 47.6°N.
  const FT_PER_LAT = 364000;
  const FT_PER_LON = 245000;
  const ax = 0, ay = 0;
  const bx = (x1 - x0) * FT_PER_LON;
  const by = (y1 - y0) * FT_PER_LAT;
  const qx = (px - x0) * FT_PER_LON;
  const qy = (py - y0) * FT_PER_LAT;
  const segLenSq = bx * bx + by * by;
  let t = segLenSq > 0 ? ((qx - ax) * bx + (qy - ay) * by) / segLenSq : 0;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  const cx = ax + t * bx;
  const cy = ay + t * by;
  const dx = qx - cx, dy = qy - cy;
  const distFt = Math.sqrt(dx * dx + dy * dy);
  const alongSegFt = Math.sqrt(segLenSq) * t;
  return { distFt, alongFt: cumStartFt + alongSegFt };
}
