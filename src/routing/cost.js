// Bike-comfort cost function. All constants exported so a future slider UI
// can mutate them in place without touching the rest of the engine.
//
// Per-edge cost (feet, equivalent distance) = lengthFt × multiplier(edge).
// Crossing penalty and turn penalty are added in feet at the node level by
// the A* expansion (see astar.js). Sign coverage is layered post-route in
// signCoverage.js.

// ---------- per-edge facility multipliers ----------
// multiplier = base + slope * max(0, lanes - threshold)
// AAA tier (NGW / PBL / OFFST) is flat at 1.0 regardless of lanes.
export const FACILITY_BASE = {
  'BKF-NGW':   1.0, 'BKF-PBL':   1.0, 'BKF-OFFST': 1.0,
  'BKF-BBL':   1.3,
  'BKF-BL':    1.5,
  'BKF-CLMB':  2.0, 'BKF-SHW':   2.0,
};
export const FACILITY_LANE_SLOPE = {
  'BKF-NGW':   0.0, 'BKF-PBL':   0.0, 'BKF-OFFST': 0.0,
  'BKF-BBL':   0.3,
  'BKF-BL':    0.5,
  'BKF-CLMB':  0.5, 'BKF-SHW':   0.5,
};
export const FACILITY_LANE_THRESHOLD = 3.0;

// No bike facility on the segment.
export const NONE_NO_CENTERLINE = 1.8;
export const NONE_WITH_CENTERLINE_BASE = 2.5;
export const NONE_WITH_CENTERLINE_LANE_SLOPE = 0.8;

// Turn penalty: 200 ft per turn > 30°. Traffic-circle traversal counts once.
export const TURN_THRESHOLD_DEG = 30;
export const TURN_PENALTY_FT = 200;

// Sign coverage: snap signs within 50 ft of the route, then penalize the
// fraction of route distance whose nearest sign is > 0.25 mi away (along
// the route). Multiplier is additive on top of route's per-edge cost.
export const SIGN_SNAP_THRESHOLD_FT = 50;
export const SIGN_GAP_THRESHOLD_FT  = 1320;     // 0.25 mi
export const SIGN_COVERAGE_MAX_MULTIPLIER = 0.3;

// Crossing penalty (ft) at a node, piecewise-linear in fractional `lanes`
// of the cross street. Anchors per the plan; >5 lanes blocked unless the
// node has signal / crosswalk / beacon (then zero).
const CROSSING_ANCHORS = [
  [1, 0],
  [2, 400],
  [3, 800],
  [4, 1600],
  [5, 1600],
];
export function crossingPenaltyByLanes(lanes) {
  if (lanes <= CROSSING_ANCHORS[0][0]) return 0;
  for (let i = 1; i < CROSSING_ANCHORS.length; i++) {
    const [lA, pA] = CROSSING_ANCHORS[i - 1];
    const [lB, pB] = CROSSING_ANCHORS[i];
    if (lanes <= lB) {
      if (lB === lA) return pA;
      const t = (lanes - lA) / (lB - lA);
      return pA + t * (pB - pA);
    }
  }
  return Infinity;     // > 5 lanes uncontrolled
}

// ---------- public functions ----------

/** Multiplier on edge length. */
export function edgeMultiplier(graph, edgeId) {
  const lanes = graph.edgeLanes(edgeId);
  const cat   = graph.edgeFacility(edgeId);
  if (cat && cat in FACILITY_BASE) {
    const base  = FACILITY_BASE[cat];
    const slope = FACILITY_LANE_SLOPE[cat];
    return base + slope * Math.max(0, lanes - FACILITY_LANE_THRESHOLD);
  }
  // No facility — branch on centerline presence.
  if (!graph.edgeCenterline(edgeId)) return NONE_NO_CENTERLINE;
  return NONE_WITH_CENTERLINE_BASE
       + NONE_WITH_CENTERLINE_LANE_SLOPE * Math.max(0, lanes - FACILITY_LANE_THRESHOLD);
}

/** Pure edge cost in ft (length × multiplier). Inf for blocked edges. */
export function edgeCostFt(graph, edgeId) {
  return graph.edgeLengthFt(edgeId) * edgeMultiplier(graph, edgeId);
}

/** Turn penalty in ft given the bearing-out of the previous edge and the
 * bearing-in of the next edge. Skips turn cost if the node is a collapsed
 * traffic circle (we charged the turn when entering the circle).
 *
 * `prevBearing` may be null on the first edge of a route (no prior heading).
 */
export function turnPenaltyFt(prevBearing, nextBearing, nodeFlags) {
  if (prevBearing == null) return 0;
  let delta = Math.abs(((nextBearing - prevBearing + 540) % 360) - 180);
  if (delta <= TURN_THRESHOLD_DEG) return 0;
  if (nodeFlags.isTrafficCircle) return 0;  // already charged once
  return TURN_PENALTY_FT;
}

/** Crossing penalty in ft at a node, given the prev and next edges and
 * the candidate "cross-street" lane count.
 *
 * Rules:
 *  - Signal / crosswalk / beacon at the node -> 0
 *  - Cross-street lanes <= current-street lanes -> 0
 *  - Cross-street has no centerline -> 0
 *  - Else piecewise function (CROSSING_ANCHORS), Inf above 5 lanes uncontrolled.
 */
export function crossingPenaltyFt(graph, nodeId, prevEdgeId, nextEdgeId) {
  const flags = graph.nodeFlags(nodeId);
  if (flags.hasSignal || flags.hasCrosswalk || flags.hasBeacon) return 0;
  // Walk all edges at this node; pick the cross street as the one with the
  // most lanes that isn't the prev/next.
  const incident = graph.outgoingEdges(nodeId);
  let crossLanes = 0;
  let crossHasCenterline = false;
  for (const eid of incident) {
    if (eid === nextEdgeId) continue;
    // The reverse of prevEdge is the matching outgoing edge from this node
    // — its `to` is where we came from. Skip both directions of the prev
    // edge by comparing endpoint sets.
    if (prevEdgeId != null) {
      const prevFrom = graph.edgeFrom(prevEdgeId);
      const prevTo   = graph.edgeTo(prevEdgeId);
      const candFrom = graph.edgeFrom(eid);
      const candTo   = graph.edgeTo(eid);
      const sameAsPrev = (candFrom === prevTo && candTo === prevFrom)
                      || (candFrom === prevFrom && candTo === prevTo);
      if (sameAsPrev) continue;
    }
    const lanes = graph.edgeLanes(eid);
    if (lanes > crossLanes) {
      crossLanes = lanes;
      crossHasCenterline = graph.edgeCenterline(eid);
    }
  }
  if (crossLanes === 0) return 0;     // no cross street found
  if (!crossHasCenterline) return 0;
  const currentLanes = prevEdgeId != null
    ? Math.max(graph.edgeLanes(prevEdgeId), graph.edgeLanes(nextEdgeId))
    : graph.edgeLanes(nextEdgeId);
  if (crossLanes <= currentLanes) return 0;
  return crossingPenaltyByLanes(crossLanes);
}
