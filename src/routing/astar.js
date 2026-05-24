// A* over the routing graph. Open set uses a binary min-heap keyed on
// f = g + h. State per entry carries enough context to charge turn and
// crossing penalties at expansion time without revisiting the parent.
//
// Heuristic: haversine distance to goal (ft) × min multiplier (1.0).
// Admissible because no edge costs less per foot than its raw length.
//
// All cost functions take a `weights` object as their first argument, so
// the caller can run several A* searches with different weight sets to
// produce alternative routes without disturbing any global state.

import { edgeCostFt, turnPenaltyFt, crossingPenaltyFt } from './cost.js';

const FT_PER_METER = 3.28084;
const R_M = 6371000.0;

function haversineFt(lon1, lat1, lon2, lat2) {
  const toRad = (d) => d * Math.PI / 180;
  const lat1r = toRad(lat1), lat2r = toRad(lat2);
  const dLat = lat2r - lat1r;
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1r) * Math.cos(lat2r) * Math.sin(dLon / 2) ** 2;
  const dM = 2 * R_M * Math.asin(Math.sqrt(a));
  return dM * FT_PER_METER;
}

// --- minimal binary heap (lower f wins) ---
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      const n = a.length;
      while (true) {
        const l = 2*i + 1, r = 2*i + 2;
        let best = i;
        if (l < n && a[l].f < a[best].f) best = l;
        if (r < n && a[r].f < a[best].f) best = r;
        if (best === i) break;
        [a[best], a[i]] = [a[i], a[best]];
        i = best;
      }
    }
    return top;
  }
}

// A "spec" describes a route endpoint. Two flavors:
//   { kind: 'node', nodeId }
//   { kind: 'edge', projection }   where projection is the result of
//                                  graph.findNearestEdgeProjection(...)
//
// For an edge spec, the router treats the projection as a virtual node that
// can be reached / exited via the two endpoints of the matched edge, paying
// partial-edge cost on each side.

function startEntries(weights, graph, spec) {
  if (spec.kind === 'node') {
    return [{ nodeId: spec.nodeId, baseG: 0, prevBearing: null, prefixGeom: [graph.nodeCoord(spec.nodeId)] }];
  }
  const p = spec.projection;
  const entries = [];
  // Toward the directed edge's `to` node (along the same direction)
  const fwdMult = edgeCostFt(weights, graph, p.edgeId) / graph.edgeLengthFt(p.edgeId);
  if (Number.isFinite(fwdMult) && p.distFromToFt > 0) {
    entries.push({
      nodeId: p.toNodeId,
      baseG:  p.distFromToFt * fwdMult,
      prevBearing: graph.edgeBearingEnd(p.edgeId),
      prefixGeom: graph.sliceProjectionToEndpoint(p, 'to'),
    });
  }
  // Toward `from` (requires the reverse-direction edge)
  if (p.reverseEdgeId != null) {
    const revMult = edgeCostFt(weights, graph, p.reverseEdgeId) / graph.edgeLengthFt(p.reverseEdgeId);
    if (Number.isFinite(revMult) && p.distFromFromFt > 0) {
      entries.push({
        nodeId: p.fromNodeId,
        baseG:  p.distFromFromFt * revMult,
        prevBearing: graph.edgeBearingEnd(p.reverseEdgeId),
        prefixGeom: graph.sliceProjectionToEndpoint(p, 'from'),
      });
    }
  }
  return entries;
}

function endExits(weights, graph, spec) {
  if (spec.kind === 'node') {
    return {
      goalLon: graph.nodeCoord(spec.nodeId)[0],
      goalLat: graph.nodeCoord(spec.nodeId)[1],
      exits: new Map([[spec.nodeId, { suffixCost: 0, suffixGeom: [graph.nodeCoord(spec.nodeId)] }]]),
    };
  }
  const p = spec.projection;
  const exits = new Map();
  const fwdMult = edgeCostFt(weights, graph, p.edgeId) / graph.edgeLengthFt(p.edgeId);
  if (Number.isFinite(fwdMult) && p.distFromFromFt > 0) {
    const fromSlice = graph.sliceProjectionToEndpoint(p, 'from'); // [proj, ..., from]
    const reversedSlice = [...fromSlice].reverse();
    exits.set(p.fromNodeId, {
      suffixCost: p.distFromFromFt * fwdMult,
      suffixGeom: reversedSlice,
    });
  }
  if (p.reverseEdgeId != null) {
    const revMult = edgeCostFt(weights, graph, p.reverseEdgeId) / graph.edgeLengthFt(p.reverseEdgeId);
    if (Number.isFinite(revMult) && p.distFromToFt > 0) {
      const toSlice = graph.sliceProjectionToEndpoint(p, 'to');
      const reversedSlice = [...toSlice].reverse();
      const cur = exits.get(p.toNodeId);
      const candCost = p.distFromToFt * revMult;
      if (!cur || candCost < cur.suffixCost) {
        exits.set(p.toNodeId, { suffixCost: candCost, suffixGeom: reversedSlice });
      }
    }
  }
  return {
    goalLon: p.projLon,
    goalLat: p.projLat,
    exits,
  };
}

/**
 * Find the shortest path under the given `weights`. startSpec/endSpec are
 *   { kind: 'node', nodeId } OR { kind: 'edge', projection }.
 *
 * `penaltyEdgeIds` (optional Set<number>): edge IDs whose cost is
 *   multiplied by `penaltyMultiplier` during this run. Used by the
 *   penalize-and-rerun fallback to coax a visually distinct alternate.
 *
 * Returns { pathEdgeIds, pathNodeIds, totalCostFt, totalLengthFt,
 *           prefixGeom, suffixGeom } or null.
 */
export function findPath(weights, graph, startSpec, endSpec,
                         penaltyEdgeIds = null, penaltyMultiplier = 1.5) {
  const starts = startEntries(weights, graph, startSpec);
  const { goalLon, goalLat, exits } = endExits(weights, graph, endSpec);
  if (starts.length === 0 || exits.size === 0) return null;

  const bestG = new Map();
  const cameFrom = new Map();

  const open = new MinHeap();
  for (const entry of starts) {
    bestG.set(entry.nodeId, Math.min(bestG.get(entry.nodeId) ?? Infinity, entry.baseG));
    cameFrom.set(entry.nodeId, { from: null, edge: null, startEntry: entry });
    const [lon, lat] = graph.nodeCoord(entry.nodeId);
    const h = haversineFt(lon, lat, goalLon, goalLat);
    open.push({
      node: entry.nodeId,
      g: entry.baseG,
      f: entry.baseG + h,
      prevEdge: null,
      prevBearing: entry.prevBearing,
    });
  }

  while (open.size > 0) {
    const cur = open.pop();
    if (cur.g > (bestG.get(cur.node) ?? Infinity)) continue;

    if (exits.has(cur.node)) {
      const exit = exits.get(cur.node);
      return reconstruct(graph, cameFrom, cur.node, cur.g + exit.suffixCost, exit);
    }

    const outgoing = graph.outgoingEdges(cur.node);
    for (const eid of outgoing) {
      let edgeBase = edgeCostFt(weights, graph, eid);
      if (!Number.isFinite(edgeBase)) continue;
      if (penaltyEdgeIds && penaltyEdgeIds.has(eid)) edgeBase *= penaltyMultiplier;
      const toNode = graph.edgeTo(eid);

      let stepCost = edgeBase;
      stepCost += turnPenaltyFt(
        weights,
        cur.prevBearing,
        graph.edgeBearingStart(eid),
        graph.nodeFlags(cur.node),
      );
      const cross = crossingPenaltyFt(weights, graph, cur.node, cur.prevEdge, eid);
      if (!Number.isFinite(cross)) continue;
      stepCost += cross;

      const newG = cur.g + stepCost;
      if (newG >= (bestG.get(toNode) ?? Infinity)) continue;
      bestG.set(toNode, newG);
      cameFrom.set(toNode, { from: cur.node, edge: eid });
      const [lon, lat] = graph.nodeCoord(toNode);
      const h = haversineFt(lon, lat, goalLon, goalLat);
      open.push({
        node: toNode,
        g: newG,
        f: newG + h,
        prevEdge: eid,
        prevBearing: graph.edgeBearingEnd(eid),
      });
    }
  }
  return null;
}

function reconstruct(graph, cameFrom, endNodeId, totalCostFt, exit) {
  const edges = [];
  const nodes = [endNodeId];
  let cur = endNodeId;
  let totalLen = 0;
  let startEntry = null;
  while (true) {
    const entry = cameFrom.get(cur);
    if (!entry) return null;
    if (entry.from == null) {
      startEntry = entry.startEntry;
      break;
    }
    edges.unshift(entry.edge);
    nodes.unshift(entry.from);
    totalLen += graph.edgeLengthFt(entry.edge);
    cur = entry.from;
  }
  totalLen += (startEntry?.baseG ?? 0) > 0
    ? (startEntry.prefixGeom ? distFtOfPolyline(startEntry.prefixGeom) : 0)
    : 0;
  if (exit.suffixGeom && exit.suffixGeom.length > 1) totalLen += distFtOfPolyline(exit.suffixGeom);
  return {
    pathEdgeIds: edges,
    pathNodeIds: nodes,
    totalCostFt,
    totalLengthFt: totalLen,
    prefixGeom: startEntry ? startEntry.prefixGeom : null,
    suffixGeom: exit.suffixGeom || null,
  };
}

function distFtOfPolyline(poly) {
  let t = 0;
  for (let i = 1; i < poly.length; i++) {
    t += haversineFt(poly[i - 1][0], poly[i - 1][1], poly[i][0], poly[i][1]);
  }
  return t;
}

// ---------- multi-route wrapper for alternates ----------

/** Compute primary + twist alternates. Returns an array of { id, label,
 *  weights, result } in order: primary first, then any twist alternates
 *  that survived the similarity filter.
 *
 * Algorithm (verified with owner 2026-05):
 *   1. Run primary + every twist (always — fixed number of A* runs).
 *   2. Drop any twist whose route is >`overlapThreshold` similar to the
 *      primary's route (measured on underlying geometry indices).
 *   3. If two surviving twists are >`overlapThreshold` similar to each
 *      other, keep the one less similar to the primary; drop the other.
 *   4. Surviving twists keep their original label ("Quieter", "More
 *      direct"). We never fall back to a relabeled "Alternative" — if a
 *      twist isn't meaningfully different on this route, just omit it.
 */
export function findPathsMulti(primaryWeights, graph, startSpec, endSpec,
                               twistRuns, overlapThreshold = 0.8) {
  const out = [];
  const primary = findPath(primaryWeights, graph, startSpec, endSpec);
  out.push({ id: 'primary', label: 'Primary', weights: primaryWeights, result: primary });
  if (!primary) return out;
  const primaryGeomSet = geomSetForPath(graph, primary.pathEdgeIds);

  // Step 1 + 2: compute every twist; keep those distinct from the primary.
  const survivors = [];
  for (const t of twistRuns) {
    const alt = findPath(t.weights, graph, startSpec, endSpec);
    if (!alt) continue;
    const geomSet = geomSetForPath(graph, alt.pathEdgeIds);
    const simToPrimary = jaccardOverlap(geomSet, primaryGeomSet);
    if (simToPrimary > overlapThreshold) continue;
    survivors.push({ id: t.id, label: t.label, weights: t.weights,
                     result: alt, geomSet, simToPrimary });
  }

  // Step 3: pairwise dedup — if two survivors are too similar to each other,
  // keep the one LESS similar to the primary (more informative alternate).
  // Sort by simToPrimary ascending so the most-different twists come first.
  survivors.sort((a, b) => a.simToPrimary - b.simToPrimary);
  const kept = [];
  for (const s of survivors) {
    if (kept.some((k) => jaccardOverlap(k.geomSet, s.geomSet) > overlapThreshold)) continue;
    kept.push(s);
  }

  for (const k of kept) {
    out.push({ id: k.id, label: k.label, weights: k.weights, result: k.result });
  }
  return out;
}

function geomSetForPath(graph, pathEdgeIds) {
  const s = new Set();
  for (const eid of pathEdgeIds) s.add(graph.edgeGeomIndex(eid));
  return s;
}

function jaccardOverlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter++;
  // Use min-size denominator to detect "alt is a subset of primary" cases
  // (e.g. trivially-shorter alternates) more aggressively than Jaccard.
  return inter / Math.min(a.size, b.size);
}
