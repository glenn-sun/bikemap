// Loader + spatial index for the routing graph produced by
// scripts/build_graph.py. Columnar layout matches the Python writer.
//
// Public API:
//   const graph = await loadGraph(url);
//   graph.findNearestNode(lon, lat) -> nodeId | null
//   graph.nodeCoord(id) -> [lon, lat]
//   graph.edge(id) -> { from, to, lengthFt, lanes, hasCenterline, isAlley,
//                       facilityCategory, facilityModelType, oneway,
//                       bearingStart, bearingEnd, streetName,
//                       geometry: [[lon, lat], ...] }
//   graph.outgoingEdges(nodeId) -> int[]
//   graph.nodeFlags(id) -> { hasSignal, hasCrosswalk, hasBeacon, isTrafficCircle }

export async function loadGraph(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`loadGraph: ${url} -> ${res.status}`);
  const raw = await res.json();
  return new Graph(raw);
}

class Graph {
  constructor(raw) {
    this.meta  = raw.meta;
    this.names = raw.names;
    this.facs  = raw.facilities;
    this.models = raw.modelTypes;
    this.geoms = raw.geoms;
    this.n = raw.nodes;
    this.e = raw.edges;
    this._buildIndex();
  }

  get nodeCount() { return this.n.lon.length; }
  get edgeCount() { return this.e.from.length; }

  nodeCoord(id) {
    return [this.n.lon[id], this.n.lat[id]];
  }

  nodeFlags(id) {
    const f = this.n.flags[id];
    return {
      hasSignal:       (f & 1) !== 0,
      hasCrosswalk:    (f & 2) !== 0,
      hasBeacon:       (f & 4) !== 0,
      isTrafficCircle: (f & 8) !== 0,
    };
  }

  outgoingEdges(nodeId) {
    return this.n.edges[nodeId];
  }

  edge(id) {
    const e = this.e;
    const fl = e.flags[id];
    const gIdx = e.geom[id];
    const geom = e.geomRev[id]
      ? [...this.geoms[gIdx]].reverse()
      : this.geoms[gIdx];
    const facIdx   = e.facility[id];
    const modelIdx = e.model[id];
    const nameIdx  = e.name[id];
    return {
      id,
      from: e.from[id], to: e.to[id],
      lengthFt: e.lengthFt[id], lanes: e.lanes[id],
      hasCenterline: (fl & 1) !== 0,
      oneway:        (fl & 2) !== 0,
      facilityCategory:  facIdx   >= 0 ? this.facs[facIdx]    : null,
      facilityModelType: modelIdx >= 0 ? this.models[modelIdx]: null,
      streetName:        nameIdx  >= 0 ? this.names[nameIdx]  : null,
      bearingStart: e.b0[id], bearingEnd: e.b1[id],
      geometry: geom,
    };
  }

  // Cheap edge-attribute accessors so the cost function doesn't pay for the
  // full `edge()` object every time it inspects a candidate.
  edgeLanes(id)         { return this.e.lanes[id]; }
  edgeLengthFt(id)      { return this.e.lengthFt[id]; }
  edgeFrom(id)          { return this.e.from[id]; }
  edgeTo(id)            { return this.e.to[id]; }
  edgeFlag(id, bit)     { return (this.e.flags[id] & bit) !== 0; }
  edgeCenterline(id)    { return (this.e.flags[id] & 1) !== 0; }
  edgeOneway(id)        { return (this.e.flags[id] & 2) !== 0; }
  edgeBearingStart(id)  { return this.e.b0[id]; }
  edgeBearingEnd(id)    { return this.e.b1[id]; }
  edgeFacility(id) {
    const i = this.e.facility[id];
    return i >= 0 ? this.facs[i] : null;
  }
  edgeModelType(id) {
    const i = this.e.model[id];
    return i >= 0 ? this.models[i] : null;
  }
  edgeStreetName(id) {
    const i = this.e.name[id];
    return i >= 0 ? this.names[i] : null;
  }

  // ---------- nearest-node + nearest-edge spatial indexes ----------
  // Uniform-grid index over (lon, lat). Cell ~0.0008 deg ≈ 60-80 m at
  // Seattle's latitude. findNearestNode searches the cell containing the
  // query plus its 8 neighbors. Edges are bucketed by every cell their
  // bounding box touches (lines crossing cell boundaries are inserted into
  // each crossed cell).
  _buildIndex() {
    const CELL = 0.0008;
    this._cell = CELL;
    this._grid = new Map();
    this._edgeGrid = new Map();
    const lons = this.n.lon, lats = this.n.lat;
    for (let i = 0; i < lons.length; i++) {
      const k = this._cellKey(lons[i], lats[i]);
      let bucket = this._grid.get(k);
      if (!bucket) { bucket = []; this._grid.set(k, bucket); }
      bucket.push(i);
    }
    // Edge index: dedupe by geometry index so each physical road segment
    // appears once even though forward + reverse share the same geom.
    const seenGeom = new Set();
    for (let i = 0; i < this.e.from.length; i++) {
      const gIdx = this.e.geom[i];
      if (seenGeom.has(gIdx)) continue;
      seenGeom.add(gIdx);
      const geom = this.geoms[gIdx];
      // Insert this edge id into every cell touched by its line strip.
      const cellsSeen = new Set();
      for (const [lon, lat] of geom) {
        const cx = Math.floor(lon / CELL);
        const cy = Math.floor(lat / CELL);
        const ck = cx + ',' + cy;
        if (cellsSeen.has(ck)) continue;
        cellsSeen.add(ck);
        let bucket = this._edgeGrid.get(ck);
        if (!bucket) { bucket = []; this._edgeGrid.set(ck, bucket); }
        bucket.push(i);
      }
    }
  }

  _cellKey(lon, lat) {
    const cx = Math.floor(lon / this._cell);
    const cy = Math.floor(lat / this._cell);
    return cx + ',' + cy;
  }

  findNearestNode(lon, lat) {
    const cx = Math.floor(lon / this._cell);
    const cy = Math.floor(lat / this._cell);
    let bestId = -1, bestDistSq = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this._grid.get((cx + dx) + ',' + (cy + dy));
        if (!bucket) continue;
        for (const id of bucket) {
          const dLon = this.n.lon[id] - lon;
          const dLat = this.n.lat[id] - lat;
          const dsq  = dLon * dLon + dLat * dLat;
          if (dsq < bestDistSq) {
            bestDistSq = dsq; bestId = id;
          }
        }
      }
    }
    // Expand search if nothing found in the 3x3 — fall back to 5x5.
    if (bestId < 0) {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
          const bucket = this._grid.get((cx + dx) + ',' + (cy + dy));
          if (!bucket) continue;
          for (const id of bucket) {
            const dLon = this.n.lon[id] - lon;
            const dLat = this.n.lat[id] - lat;
            const dsq  = dLon * dLon + dLat * dLat;
            if (dsq < bestDistSq) {
              bestDistSq = dsq; bestId = id;
            }
          }
        }
      }
    }
    return bestId >= 0 ? bestId : null;
  }

  /**
   * Find the nearest edge to (lon, lat) and project the click onto it.
   * Returns null if nothing is within `radiusFt` feet.
   *
   * Result:
   *   {
   *     edgeId,          // a representative directed edge id for the segment
   *     reverseEdgeId,   // matching opposite-direction edge id, or null
   *     projLon, projLat,
   *     alongFt,         // distance along this edge from its `from` node to the projection
   *     distFt,          // perpendicular distance from click to projection
   *     fromNodeId, toNodeId,
   *     geometry,        // the underlying segment's geometry [[lon,lat], ...]
   *   }
   */
  findNearestEdgeProjection(lon, lat, radiusFt = 200) {
    const FT_PER_LAT = 364000;
    const FT_PER_LON = 245000;
    const cx = Math.floor(lon / this._cell);
    const cy = Math.floor(lat / this._cell);
    let bestEdge = -1, bestDistFt = Infinity;
    let bestSegIdx = 0, bestT = 0;
    let bestProjLon = 0, bestProjLat = 0;

    const tryEdge = (eid) => {
      const gIdx = this.e.geom[eid];
      const geom = this.geoms[gIdx];
      for (let i = 1; i < geom.length; i++) {
        const [x0, y0] = geom[i - 1];
        const [x1, y1] = geom[i];
        const ax = (x1 - x0) * FT_PER_LON;
        const ay = (y1 - y0) * FT_PER_LAT;
        const qx = (lon - x0) * FT_PER_LON;
        const qy = (lat - y0) * FT_PER_LAT;
        const segSq = ax * ax + ay * ay;
        let t = segSq > 0 ? (qx * ax + qy * ay) / segSq : 0;
        if (t < 0) t = 0;
        if (t > 1) t = 1;
        const dx = qx - t * ax, dy = qy - t * ay;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestDistFt) {
          bestDistFt = d;
          bestEdge = eid;
          bestSegIdx = i;       // projection lies on segment (i-1 -> i)
          bestT = t;
          bestProjLon = x0 + (x1 - x0) * t;
          bestProjLat = y0 + (y1 - y0) * t;
        }
      }
    };

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this._edgeGrid.get((cx + dx) + ',' + (cy + dy));
        if (!bucket) continue;
        for (const eid of bucket) tryEdge(eid);
      }
    }
    if (bestDistFt > radiusFt) {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
          const bucket = this._edgeGrid.get((cx + dx) + ',' + (cy + dy));
          if (!bucket) continue;
          for (const eid of bucket) tryEdge(eid);
        }
      }
    }
    if (bestEdge < 0 || bestDistFt > radiusFt) return null;

    // Find the reverse-direction edge (if the road is bidirectional) so the
    // router can leave the projection toward either endpoint.
    const fromN = this.e.from[bestEdge];
    const toN   = this.e.to[bestEdge];
    let reverseEdge = -1;
    for (const eid of this.n.edges[toN]) {
      if (this.e.to[eid] === fromN && this.e.geom[eid] === this.e.geom[bestEdge]) {
        reverseEdge = eid;
        break;
      }
    }

    // Compute "raw alongFt" — distance along the un-reversed geometry from
    // its first point to the projection, in equirectangular ft.
    const gIdx = this.e.geom[bestEdge];
    const raw  = this.geoms[gIdx];
    let alongRawFt = 0;
    for (let i = 1; i < bestSegIdx; i++) {
      alongRawFt += segLenFt(raw[i - 1], raw[i]);
    }
    alongRawFt += segLenFt(raw[bestSegIdx - 1], raw[bestSegIdx]) * bestT;

    const totalRawFt = (() => {
      let t = 0;
      for (let i = 1; i < raw.length; i++) t += segLenFt(raw[i - 1], raw[i]);
      return t;
    })();
    // Distance from each endpoint of the directed `bestEdge` to projection.
    // If geomRev=false: edge goes raw[0] -> raw[N-1], so from=raw[0], to=raw[N-1].
    // If geomRev=true: edge goes raw[N-1] -> raw[0], so from=raw[N-1].
    const reversed = this.e.geomRev[bestEdge];
    const distFromBestFromFt = reversed ? (totalRawFt - alongRawFt) : alongRawFt;
    const distFromBestToFt   = reversed ? alongRawFt : (totalRawFt - alongRawFt);

    return {
      // The directed edge whose 'from -> to' frame the projection lives on.
      edgeId: bestEdge,
      reverseEdgeId: reverseEdge >= 0 ? reverseEdge : null,
      projLon: bestProjLon,
      projLat: bestProjLat,
      distFt: bestDistFt,
      fromNodeId: fromN,
      toNodeId:   toN,
      // distance from each endpoint to the projection point, in feet
      distFromFromFt: distFromBestFromFt,
      distFromToFt:   distFromBestToFt,
      // for geometry splicing:
      rawGeomIndex: gIdx,
      segmentIndex: bestSegIdx,
      tOnSegment:   bestT,
    };
  }

  /**
   * Slice the underlying segment geometry to produce a piece from the
   * projection point to one of the endpoint nodes.
   *
   * @param proj  result of findNearestEdgeProjection
   * @param toEndpoint  'from' (toward fromNodeId) or 'to' (toward toNodeId)
   */
  sliceProjectionToEndpoint(proj, toEndpoint) {
    const raw = this.geoms[proj.rawGeomIndex];
    const projPt = [proj.projLon, proj.projLat];
    const reversed = this.e.geomRev[proj.edgeId];
    // Determine which end of `raw` corresponds to this directed edge's `from`.
    // The mapping is: from = reversed ? raw[N-1] : raw[0].
    const fromAtStartOfRaw = !reversed;
    const goingTowardFrom = (toEndpoint === 'from');
    // In raw-geometry frame, "toward raw[0]" if (fromAtStartOfRaw && goingTowardFrom)
    //                                          || (!fromAtStartOfRaw && !goingTowardFrom)
    const towardRawStart = fromAtStartOfRaw === goingTowardFrom;
    if (towardRawStart) {
      // [projection, raw[segmentIndex-1], raw[segmentIndex-2], ..., raw[0]]
      const slice = [projPt];
      for (let i = proj.segmentIndex - 1; i >= 0; i--) slice.push(raw[i]);
      return slice;
    } else {
      // [projection, raw[segmentIndex], raw[segmentIndex+1], ..., raw[N-1]]
      const slice = [projPt];
      for (let i = proj.segmentIndex; i < raw.length; i++) slice.push(raw[i]);
      return slice;
    }
  }
}

// Equirectangular-ft length of one polyline segment. Good enough at Seattle's
// latitude; <1% error vs. haversine.
function segLenFt(p1, p2) {
  const FT_PER_LAT = 364000, FT_PER_LON = 245000;
  const dx = (p2[0] - p1[0]) * FT_PER_LON;
  const dy = (p2[1] - p1[1]) * FT_PER_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}
