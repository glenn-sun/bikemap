// A* over the routing graph. Open set uses a binary min-heap keyed on
// f = g + h. State per entry carries enough context to charge turn and
// crossing penalties at expansion time without revisiting the parent.
//
// Heuristic: haversine distance to goal (ft) × min multiplier (1.0).
// Admissible because no edge costs less per foot than its raw length.

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

function startEntries(graph, spec) {
  if (spec.kind === 'node') {
    return [{ nodeId: spec.nodeId, baseG: 0, prevBearing: null, prefixGeom: [graph.nodeCoord(spec.nodeId)] }];
  }
  const p = spec.projection;
  const entries = [];
  // Toward the directed edge's `to` node (along the same direction)
  const fwdMult = edgeCostFt(graph, p.edgeId) / graph.edgeLengthFt(p.edgeId);
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
    const revMult = edgeCostFt(graph, p.reverseEdgeId) / graph.edgeLengthFt(p.reverseEdgeId);
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

function endExits(graph, spec) {
  if (spec.kind === 'node') {
    return {
      goalLon: graph.nodeCoord(spec.nodeId)[0],
      goalLat: graph.nodeCoord(spec.nodeId)[1],
      exits: new Map([[spec.nodeId, { suffixCost: 0, suffixGeom: [graph.nodeCoord(spec.nodeId)] }]]),
    };
  }
  const p = spec.projection;
  const exits = new Map();
  // Enter the projection via the directed edge's `from` -> `to` direction:
  //   path enters node `from`, then we traverse partial edge to projection.
  const fwdMult = edgeCostFt(graph, p.edgeId) / graph.edgeLengthFt(p.edgeId);
  if (Number.isFinite(fwdMult) && p.distFromFromFt > 0) {
    // Suffix geometry runs from `from` -> projection (i.e. away from `from`)
    const fromSlice = graph.sliceProjectionToEndpoint(p, 'from'); // [proj, ..., from]
    const reversedSlice = [...fromSlice].reverse();
    exits.set(p.fromNodeId, {
      suffixCost: p.distFromFromFt * fwdMult,
      suffixGeom: reversedSlice,
    });
  }
  // Enter via the reverse direction: path enters node `to`, traverses reverse partial edge.
  if (p.reverseEdgeId != null) {
    const revMult = edgeCostFt(graph, p.reverseEdgeId) / graph.edgeLengthFt(p.reverseEdgeId);
    if (Number.isFinite(revMult) && p.distFromToFt > 0) {
      const toSlice = graph.sliceProjectionToEndpoint(p, 'to'); // [proj, ..., to]
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
 * Find the shortest path. startSpec and endSpec each are either
 *   { kind: 'node', nodeId }  OR  { kind: 'edge', projection }.
 *
 * Returns { pathEdgeIds, pathNodeIds, totalCostFt, totalLengthFt,
 *           prefixGeom, suffixGeom } or null.
 *
 * prefixGeom/suffixGeom are the partial-edge geometry pieces from the
 * projection point to/from the first/last graph node visited (empty when
 * the spec was 'node').
 */
export function findPath(graph, startSpec, endSpec) {
  const starts = startEntries(graph, startSpec);
  const { goalLon, goalLat, exits } = endExits(graph, endSpec);
  if (starts.length === 0 || exits.size === 0) return null;

  // If start projection == end projection, return a degenerate route.
  if (startSpec.kind === 'edge' && endSpec.kind === 'edge'
      && startSpec.projection.edgeId === endSpec.projection.edgeId) {
    // Same edge — route is just the segment between the two projections.
    // Punt: route to the nearest endpoint and back. Cost is small; A* handles.
  }

  const bestG = new Map();
  const cameFrom = new Map();
  const startKey = (e) => `S:${e.nodeId}:${e.baseG}`;

  const open = new MinHeap();
  for (const entry of starts) {
    const k = startKey(entry);
    bestG.set(entry.nodeId, Math.min(bestG.get(entry.nodeId) ?? Infinity, entry.baseG));
    // Remember which start entry led here, for prefix reconstruction.
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

    // Check if cur.node is an exit; total = cur.g + exit.suffixCost
    if (exits.has(cur.node)) {
      const exit = exits.get(cur.node);
      return reconstruct(graph, cameFrom, cur.node, cur.g + exit.suffixCost, exit);
    }

    const outgoing = graph.outgoingEdges(cur.node);
    for (const eid of outgoing) {
      const edgeBase = edgeCostFt(graph, eid);
      if (!Number.isFinite(edgeBase)) continue;
      const toNode = graph.edgeTo(eid);

      let stepCost = edgeBase;
      stepCost += turnPenaltyFt(
        cur.prevBearing,
        graph.edgeBearingStart(eid),
        graph.nodeFlags(cur.node),
      );
      const cross = crossingPenaltyFt(graph, cur.node, cur.prevEdge, eid);
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
  // totalLen does NOT include the partial-edge pieces; add them so the
  // displayed mileage includes the mid-block tails.
  totalLen += (startEntry?.baseG  ?? 0) > 0 ? startEntry.prefixGeom ? distFtOfPolyline(startEntry.prefixGeom) : 0 : 0;
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
