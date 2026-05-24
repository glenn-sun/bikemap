// Sign-coverage adjustment applied AFTER A* finds the route.
//
// Walks the route's polyline, snaps every bike-sign point within `signSnapFt`
// to the route, marks the closest sign position (as a distance-along-route),
// then computes the fraction of route distance whose nearest snapped sign
// is > `signGapFt` away (along the route). That fraction times
// `signCoverageMax` is added to the total cost multiplier (i.e. extra ft
// equivalent to the same fraction of route length × signCoverageMax).
//
// All thresholds come from the active `weights` object so a preset switch
// picks up immediately.

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
 * Compute the sign-coverage cost multiplier addition (0 .. weights.signCoverageMax).
 *
 * @param weights       weights object (see cost.js); supplies signSnapFt,
 *                      signGapFt, signCoverageMax.
 * @param routeGeometry array of [lon, lat] points (the route polyline).
 * @param signFeatures  array of GeoJSON Point features for bike signs.
 * @returns { multiplier, uncoveredFraction, snappedCount } — multiplier is the
 *          extra cost factor; the others are diagnostic.
 */
export function computeSignCoverage(weights, routeGeometry, signFeatures) {
  if (routeGeometry.length < 2) {
    return { multiplier: 0, uncoveredFraction: 0, snappedCount: 0 };
  }

  const cumFt = [0];
  for (let i = 1; i < routeGeometry.length; i++) {
    const [x0, y0] = routeGeometry[i - 1];
    const [x1, y1] = routeGeometry[i];
    cumFt.push(cumFt[i - 1] + haversineFt(x0, y0, x1, y1));
  }
  const totalFt = cumFt[cumFt.length - 1];
  if (totalFt < 1) return { multiplier: 0, uncoveredFraction: 0, snappedCount: 0 };

  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const [lon, lat] of routeGeometry) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }
  const PAD = 0.00015;
  minLon -= PAD; minLat -= PAD; maxLon += PAD; maxLat += PAD;

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
      const { distFt, alongFt } = closestOnSegmentFt(slon, slat, x0, y0, x1, y1, cumFt[i - 1]);
      if (distFt < bestDistFt) {
        bestDistFt = distFt;
        bestAlongFt = alongFt;
      }
    }
    if (bestDistFt <= weights.signSnapFt) {
      snappedDists.push(bestAlongFt);
    }
  }

  if (snappedDists.length === 0) {
    return {
      multiplier: weights.signCoverageMax,
      uncoveredFraction: 1,
      snappedCount: 0,
    };
  }
  snappedDists.sort((a, b) => a - b);

  let coveredFt = 0;
  const halfWidth = weights.signGapFt;
  let prevEnd = -Infinity;
  for (const s of snappedDists) {
    const start = Math.max(0, s - halfWidth);
    const end   = Math.min(totalFt, s + halfWidth);
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
    multiplier: uncoveredFraction * weights.signCoverageMax,
    uncoveredFraction,
    snappedCount: snappedDists.length,
  };
}

function closestOnSegmentFt(px, py, x0, y0, x1, y1, cumStartFt) {
  const FT_PER_LAT = 364000;
  const FT_PER_LON = 245000;
  const bx = (x1 - x0) * FT_PER_LON;
  const by = (y1 - y0) * FT_PER_LAT;
  const qx = (px - x0) * FT_PER_LON;
  const qy = (py - y0) * FT_PER_LAT;
  const segLenSq = bx * bx + by * by;
  let t = segLenSq > 0 ? (qx * bx + qy * by) / segLenSq : 0;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  const cx = t * bx;
  const cy = t * by;
  const dx = qx - cx, dy = qy - cy;
  const distFt = Math.sqrt(dx * dx + dy * dy);
  const alongSegFt = Math.sqrt(segLenSq) * t;
  return { distFt, alongFt: cumStartFt + alongSegFt };
}
