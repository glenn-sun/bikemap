// Bike-comfort cost function.
//
// All cost-function knobs live in a `weights` object built from a small set
// of user-facing slider values (s1..s5). The five sliders map to many raw
// constants via the formulas in `weightsFromSliders` below.
//
// Per-edge cost (feet, equivalent distance) = lengthFt × multiplier(weights, edge).
// Crossing penalty and turn penalty are added in feet at the node level by
// the A* expansion. Sign coverage is layered post-route in signCoverage.js.
//
// Twists ("Quieter", "More direct") shift the active sliders by small deltas
// and produce a sibling route under the same overall preset.

// ---------- preset slider values ----------
//
// Sliders all live in [0, 1]. Higher = stronger preference for the
// property named in the slider label (better infra, fewer turns,
// protected crossings, narrower streets, flatter terrain). Comfort is
// the "stay on greenways and protected crossings even if longer"
// persona; Athletic is the "directness first" persona — both keep s2
// (turn aversion) at 0.5 so directness vs. comfort is decided by
// infrastructure choice and crossing avoidance, not by zigzag-vs-not.
export const PRESETS = {
  athletic: { s1: 0.2, s2: 0.5, s3: 0.2, s4: 0.2, s5: 0.2 },
  comfort:  { s1: 0.7, s2: 0.5, s3: 0.7, s4: 0.7, s5: 0.7 },
};

// Sign-coverage cap is set per preset (it doesn't have its own slider —
// the 5-slider cap is already saturated, and most users don't have an
// opinion on bike-sign coverage). 
const SIGN_COV_BY_PRESET = { athletic: 0.5, comfort: 0.5, custom: 0.5 };

// Slider metadata for the UI (label + tooltip). Order here = display order.
export const SLIDERS = [
  { key: 's1', label: 'Prefer better bike infrastructure' },
  { key: 's2', label: 'Prefer fewer turns' },
  { key: 's3', label: 'Prefer protected crossings' },
  { key: 's4', label: 'Prefer narrower streets'},
  { key: 's5', label: 'Prefer flatter terrain' },
];

// Twist definitions for alternate routes. Each twist's deltas are added to
// the active sliders (then clipped to [0, 1]) before running A*. Tuned so
// the alternate is forced to use materially different streets without
// turning into "a different preset."
export const TWISTS = [
  { id: 'quieter', label: 'Quieter',     deltas: { s1: +0.3, s3: +0.3, s4: +0.3} },
  { id: 'direct',  label: 'More direct', deltas: { s1: -0.2, s2: +0.5, s3: -0.2, s4: -0.2 } },
  { id: 'flatter', label: 'Flatter',     deltas: { s5: +0.5 } },
];

// Fixed (non-tunable) constants. Kept here so the rest of the engine has a
// single import path. TURN_THRESHOLD_DEG governs step-list verbosity (what
// counts as a "turn" worth a maneuver) — not a user preference.
export const TURN_THRESHOLD_DEG = 30;

// Sidewalk routing constants.
//   SIDEWALK_MULTIPLIER  — fixed 3× cost multiplier on every sidewalk
//                          edge (not user-tunable). The high penalty
//                          ensures sidewalks are picked only when the
//                          road alternative is materially worse.
//   SHORT_SIDEWALK_FT    — sidewalk segments ≤ this length are always
//                          allowed even when the user has disabled
//                          sidewalks. They typically represent trail/
//                          street stitching gaps where OSM uses a short
//                          footway as the connector. Longer sidewalks
//                          (along-road walks) are gated by the toggle.
export const SIDEWALK_MULTIPLIER = 3.0;
export const SHORT_SIDEWALK_FT = 50;

function clip01(v) { return Math.max(0, Math.min(1, v ?? 0.5)); }

/** Build a full weights object from a slider snapshot.
 * `signCoverageMax` is supplied externally (per preset).
 * `enableSidewalks` (optional) — when true, long sidewalk segments (> 50 ft)
 *   are usable at a fixed 3× penalty. When false, only short sidewalk
 *   segments (≤ 50 ft, treated as crossings/connectors) are usable; long
 *   sidewalks return Infinity from edgeMultiplier and are skipped by A*.
 */
export function weightsFromSliders(s, signCoverageMax = SIGN_COV_BY_PRESET.custom,
                                    enableSidewalks = false) {
  const s1 = clip01(s.s1), s2 = clip01(s.s2), s3 = clip01(s.s3),
        s4 = clip01(s.s4), s5 = clip01(s.s5);
  return {
    facBase: {
      'BKF-NGW': 1.0, 'BKF-PBL': 1.0, 'BKF-OFFST': 1.0,
      'BKF-BBL':  1.0 + 1.0 * s1,
      'BKF-BL':   1.0 + 1.5 * s1,
      'BKF-CLMB': 1.0 + 2.5 * s1, 
      'BKF-SHW':  1.0 + 2.5 * s1,
    },
    facLaneSlope: {
      'BKF-NGW': 0, 'BKF-PBL': 0, 'BKF-OFFST': 0,
      'BKF-BBL':  0.5 * s4,
      'BKF-BL':   1.0 * s4,
      'BKF-CLMB': 1.0 * s4,
      'BKF-SHW':  1.0 * s4,
    },
    facLaneThreshold: 3.0,
    noneNoCenterline: 1 + 1.0 * s1,
    noneCenterlineBase: 1.5 + 2.5 * s1,
    noneCenterlineLaneSlope: 1.5 * s4,
    turnPenaltyFt: 500 * s2,
    crossingScale: 2 * s3,
    crossingAnchorsFt: [[1, 0], [2, 400], [3, 800], [4, 1600], [5, 1600]],
    signSnapFt: 50,
    signGapFt:  1320,
    signCoverageMax,
    // Uphill aversion: each foot of UPHILL gain (downhill contributes
    // nothing) on an edge adds uphillFt × uphillFtPenalty to its
    // equivalent-distance cost. At max-s5 a 10-ft climb costs the same
    // as +400 ft of flat road (a "40× the rise" exchange rate). Strong
    // enough to swing routes around hills when an alternative exists;
    // not so strong that a short steep connector loses to long detours
    // that also climb.
    uphillFtPenalty: 40 * s5,
    // Quadratic steepness penalty: penalty term is
    //     s5 · steepCoeff · Σ_seg(lengthFt · max(0, slope - 0.02)²)
    // where the sum is precomputed offline as `graph.edgeSteepFt2(eid)`.
    // The squared term means a 20% segment hurts MUCH more than two
    // 10% segments of the same combined length — sustained steep grades
    // are qualitatively worse for a cyclist than mild rolling terrain.
    // At s5=1, a 100-ft 10% segment adds ~256 ft equivalent (~2.5×
    // surcharge); a 100-ft 26% segment adds ~2300 ft (~24× its length).
    // The 2% threshold matches `STEEP_THRESHOLD` baked into
    // build_elevation.py's per-edge `steepFt2` precompute.
    steepCoeff:        400 * s5,
    enableSidewalks,                     // gates long sidewalks (> 50 ft)
    sliders: { s1, s2, s3, s4, s5 },     // diagnostic / for UI display
  };
}

/** Weights for a named preset (athletic | comfort). */
export function weightsForPreset(name, enableSidewalks = false) {
  if (!(name in PRESETS)) throw new Error(`unknown preset: ${name}`);
  return weightsFromSliders(PRESETS[name], SIGN_COV_BY_PRESET[name],
                            enableSidewalks);
}

/** Weights for the Custom preset: sliders user-controlled. */
export function weightsForCustom(sliders, enableSidewalks = false) {
  return weightsFromSliders(sliders, SIGN_COV_BY_PRESET.custom,
                            enableSidewalks);
}

/** Apply a twist's delta map to a slider snapshot, clipping to [0, 1]. */
export function applyTwistToSliders(sliders, twistId) {
  const t = TWISTS.find((x) => x.id === twistId);
  if (!t) return { ...sliders };
  const out = { ...sliders };
  for (const k of Object.keys(t.deltas)) {
    out[k] = clip01((out[k] ?? 0.5) + t.deltas[k]);
  }
  return out;
}

// ---------- pure cost functions (take a `weights` object) ----------

/** Multiplier on edge length. */
export function edgeMultiplier(weights, graph, edgeId) {
  // Sidewalks short-circuit ahead of every other classification. Short
  // segments (≤ 50 ft) are always usable at a fixed 3× penalty since
  // they're typically the OSM-data-quality "connector" between a trail
  // and a roadway. Longer sidewalks (along-road walks) are blocked
  // unless the user explicitly enabled them.
  if (graph.edgeIsSidewalk(edgeId)) {
    const len = graph.edgeLengthFt(edgeId);
    if (len <= SHORT_SIDEWALK_FT) return SIDEWALK_MULTIPLIER;
    return weights.enableSidewalks ? SIDEWALK_MULTIPLIER : Infinity;
  }
  const lanes = graph.edgeLanes(edgeId);
  const cat   = graph.edgeFacility(edgeId);
  if (cat && cat in weights.facBase) {
    const base  = weights.facBase[cat];
    const slope = weights.facLaneSlope[cat];
    return base + slope * Math.max(0, lanes - weights.facLaneThreshold);
  }
  // No facility — branch on centerline presence.
  if (!graph.edgeCenterline(edgeId)) return weights.noneNoCenterline;
  return weights.noneCenterlineBase
       + weights.noneCenterlineLaneSlope
         * Math.max(0, lanes - weights.facLaneThreshold);
}

/** Elevation surcharge in equivalent feet of distance for an edge.
 *  Two terms:
 *    1. Linear uphill: total uphillFt × uphillFtPenalty.
 *    2. Quadratic steepness: precomputed steepFt2 × steepCoeff.
 *       `steepFt2 = Σ_seg(length · max(0, slope - 0.02)²)` aggregated by
 *       build_elevation.py so we don't walk the geometry at routing time.
 *  Downhill segments contribute nothing to either term. */
export function elevationPenaltyFt(weights, graph, edgeId) {
  const up = graph.edgeUphillFt(edgeId);
  return up * weights.uphillFtPenalty
       + graph.edgeSteepFt2(edgeId) * weights.steepCoeff;
}

/** Pure edge cost in ft (length × multiplier, + elevation surcharge).
 *  Inf for blocked edges. */
export function edgeCostFt(weights, graph, edgeId) {
  const base = graph.edgeLengthFt(edgeId) * edgeMultiplier(weights, graph, edgeId);
  return base + elevationPenaltyFt(weights, graph, edgeId);
}

/** Turn penalty in ft. `prevBearing` may be null on the first edge. */
export function turnPenaltyFt(weights, prevBearing, nextBearing, nodeFlags) {
  if (prevBearing == null) return 0;
  const delta = Math.abs(((nextBearing - prevBearing + 540) % 360) - 180);
  if (delta <= TURN_THRESHOLD_DEG) return 0;
  if (nodeFlags.isTrafficCircle) return 0;
  return weights.turnPenaltyFt;
}

/** Crossing penalty as a function of cross-street lane count. Returns
 *  Infinity above the last anchor — the caller will reject the edge. */
export function crossingPenaltyByLanes(weights, lanes) {
  const anchors = weights.crossingAnchorsFt;
  const scale   = weights.crossingScale;
  if (lanes <= anchors[0][0]) return 0;
  for (let i = 1; i < anchors.length; i++) {
    const [lA, pA] = anchors[i - 1];
    const [lB, pB] = anchors[i];
    if (lanes <= lB) {
      if (lB === lA) return pA * scale;
      const t = (lanes - lA) / (lB - lA);
      return (pA + t * (pB - pA)) * scale;
    }
  }
  return Infinity;
}

// How close to perpendicular a cross-edge has to be (in degrees) to be
// counted as an actual crossing. Smaller = stricter. The cross-edge's
// axis must be at least PERPENDICULAR_MIN_DEG away from PARALLEL to
// BOTH the prev and next edges; otherwise it's a continuation/fork
// along the cyclist's own path (e.g. another segment of the same
// street), not a perpendicular crossing.
const PERPENDICULAR_MIN_DEG = 60;

// Axis-distance between two bearings: 0° = parallel/anti-parallel,
// 90° = perpendicular. (Treats forward and backward as the same axis,
// since a street's "axis" is undirected.)
function axisAngleDeg(a, b) {
  const d = Math.abs(((a - b + 540) % 360) - 180);  // 0..180
  return d > 90 ? 180 - d : d;
}

/** Crossing penalty in ft at a node, considering the prev/next edges and
 *  the candidate cross-street lane count. Zero when there's a signal /
 *  crosswalk / beacon at the node, OR when cross-traffic on the
 *  identified cross-street has stop signs on both approach directions
 *  (i.e. cyclist is on the through-street of a 2-way stop, or it's a
 *  4-way stop). */
export function crossingPenaltyFt(weights, graph, nodeId, prevEdgeId, nextEdgeId) {
  // When the cyclist is staying on the sidewalk past an intersection
  // (prev = sidewalk, next = sidewalk), the existing road-on-road
  // perpendicular-crossing logic would wrongly fire because the
  // physically-parallel main road would qualify as a cross-street. But
  // the sidewalk itself doesn't cross the perpendicular street — the
  // pedestrian throat just continues. The real road-crossing event is
  // charged via `sidewalkCrossingPenaltyFt` on the crosswalk edge.
  if (prevEdgeId != null
      && graph.edgeIsSidewalk(prevEdgeId)
      && graph.edgeIsSidewalk(nextEdgeId)) return 0;
  const flags = graph.nodeFlags(nodeId);
  if (flags.hasSignal || flags.hasCrosswalk || flags.hasBeacon) return 0;
  const incident = graph.outgoingEdges(nodeId);
  // Cyclist's local travel axes — used to filter out fork/continuation
  // edges that the original wide-lanes-only test wrongly counted as
  // "cross streets" (most commonly: a same-name OSM way continuation
  // past a T-junction onto an unnamed connector).
  const prevBearingEnd = prevEdgeId != null
    ? graph.edgeBearingEnd(prevEdgeId) : null;
  const nextBearingStart = graph.edgeBearingStart(nextEdgeId);

  let crossLanes = 0;
  let crossHasCenterline = false;
  let crossBearingStart = 0;
  for (const eid of incident) {
    if (eid === nextEdgeId) continue;
    if (prevEdgeId != null) {
      const prevFrom = graph.edgeFrom(prevEdgeId);
      const prevTo   = graph.edgeTo(prevEdgeId);
      const candFrom = graph.edgeFrom(eid);
      const candTo   = graph.edgeTo(eid);
      const sameAsPrev = (candFrom === prevTo && candTo === prevFrom)
                      || (candFrom === prevFrom && candTo === prevTo);
      if (sameAsPrev) continue;
    }
    const candBearing = graph.edgeBearingStart(eid);
    // Perpendicularity gate: must be far from parallel to both prev and
    // next. Skip if fork/merge-ish along the cyclist's axis.
    if (axisAngleDeg(candBearing, nextBearingStart) < PERPENDICULAR_MIN_DEG) continue;
    if (prevBearingEnd != null
        && axisAngleDeg(candBearing, prevBearingEnd) < PERPENDICULAR_MIN_DEG) continue;
    const lanes = graph.edgeLanes(eid);
    if (lanes > crossLanes) {
      crossLanes = lanes;
      crossHasCenterline = graph.edgeCenterline(eid);
      crossBearingStart = candBearing;
    }
  }
  if (crossLanes === 0) return 0;
  if (!crossHasCenterline) return 0;
  const currentLanes = prevEdgeId != null
    ? Math.max(graph.edgeLanes(prevEdgeId), graph.edgeLanes(nextEdgeId))
    : graph.edgeLanes(nextEdgeId);
  if (crossLanes <= currentLanes) return 0;
  // 2-way / 4-way stop on the cross-street: cross traffic is stopped
  // in both directions, so cyclist crosses with right-of-way. SDOT
  // FACING = the bearing that approaching traffic is travelling, so
  // we check both axes of the cross-street.
  if (graph.hasStopFacing(nodeId, crossBearingStart)
      && graph.hasStopFacing(nodeId, crossBearingStart + 180)) return 0;
  return crossingPenaltyByLanes(weights, crossLanes);
}

/** Crosswalk penalty: fired at the entry node of a crosswalk sidewalk
 *  segment (a sidewalk that 2D-crosses a road). The penalty is keyed
 *  off the crossed road's lane count and is zeroed by the same
 *  signal/crosswalk/beacon flags as the regular crossing penalty.
 *
 *  This complements `crossingPenaltyFt`: the regular penalty handles
 *  road-on-road perpendicular crossings; this one handles
 *  sidewalk-on-road crossings (where the cyclist is traversing the
 *  crosswalk edge itself rather than going-straight at a road
 *  intersection). At a signalized crossing, both zero out; at an
 *  unsignalized one, the cyclist pays the same lane-keyed penalty
 *  whether they're a car going straight or a sidewalk-walker
 *  crossing — both wait on the same cross traffic.
 *
 *  Returns 0 when `nextEdgeId` is not a crosswalk (data-driven: only
 *  sidewalks with crosswalkLanes > 0 from build_graph.py annotate). */
export function sidewalkCrossingPenaltyFt(weights, graph, nodeId, nextEdgeId) {
  const lanes = graph.edgeCrosswalkLanes(nextEdgeId);
  if (lanes == null || lanes <= 0) return 0;
  const flags = graph.nodeFlags(nodeId);
  if (flags.hasSignal || flags.hasCrosswalk || flags.hasBeacon) return 0;
  // 2-way / 4-way stop on the crossed road — check both axes
  // perpendicular to the crosswalk's bearing.
  const crosswalkBearing = graph.edgeBearingStart(nextEdgeId);
  const crossAxis = (crosswalkBearing + 90) % 360;
  if (graph.hasStopFacing(nodeId, crossAxis)
      && graph.hasStopFacing(nodeId, crossAxis + 180)) return 0;
  return crossingPenaltyByLanes(weights, lanes);
}
