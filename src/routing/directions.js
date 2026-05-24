// Turn-by-turn instruction generator.
//
// Walks the resolved route, merges consecutive same-street edges into one
// step, and emits classifications based on heading change at each junction.
// Annotates steps that traverse a BKF-ONEWAY bike facility with the
// "may or may not be in direction of travel" disclaimer.

import { abbreviateDirectionalsStr } from '../labels.js';
import { TURN_THRESHOLD_DEG } from './cost.js';

const SHARP_DEG = 110;

/**
 * Build the directions list.
 *
 * @param graph        the routing graph
 * @param pathEdgeIds  ordered list of edge IDs from A*
 * @returns Array<{ instruction, streetName, distanceFt, annotations: string[] }>
 */
// A short unnamed edge that sits between two same-named edges of the same
// street is almost always just an OSM way-split (driveway, bridge expansion
// joint, jurisdiction change). Treat it as part of the surrounding street
// so the route doesn't fragment into a "Continue" sub-step.
const FILLIN_MAX_FT = 100;

// Trailing bike-facility tokens that should be ignored when comparing
// two street names for the purpose of merging consecutive steps. The
// same physical corridor often shows up in OSM under several names
// (e.g. "Westlake Cycle Track" + "Westlake Protected Bike Lane" along
// the same path), causing the step list to flip between them. Stripping
// these for *comparison only* collapses the flip-flop. Longest first so
// "protected bike lane" wins over "bike lane".
const FACILITY_SUFFIXES = [
  'protected bike lane',
  'bike lane', 'bike path',
  'cycle track', 'cycletrack', 'cycleway',
];

function normName(s) {
  if (!s) return '';
  let n = s.toLowerCase().trim();
  for (const suf of FACILITY_SUFFIXES) {
    if (n.endsWith(' ' + suf)) {
      n = n.slice(0, n.length - suf.length - 1).trim();
      break;
    }
  }
  return n;
}

function fillInUnnamedConnectors(graph, pathEdgeIds) {
  const names = pathEdgeIds.map(eid => graph.edgeStreetName(eid));
  // Walk forward, locate runs of null/empty names whose neighbors share a name.
  for (let i = 0; i < names.length; i++) {
    if (names[i]) continue;
    // Find the run [i .. j-1] of unnamed edges
    let j = i;
    let runLen = 0;
    while (j < names.length && !names[j]) {
      runLen += graph.edgeLengthFt(pathEdgeIds[j]);
      j++;
    }
    if (runLen > FILLIN_MAX_FT) { i = j - 1; continue; }
    const beforeName = i > 0 ? names[i - 1] : null;
    const afterName  = j < names.length ? names[j] : null;
    if (beforeName && afterName
        && normName(beforeName) === normName(afterName)) {
      for (let k = i; k < j; k++) names[k] = beforeName;
    }
    i = j - 1;
  }
  return names;
}

/**
 * Build the directions list.
 *
 * @param graph        the routing graph
 * @param pathEdgeIds  ordered list of edge IDs from A*
 * @param routeStartLonLat  optional [lon, lat] for the route's actual start
 *                          (used as the maneuver point for step 0 when the
 *                          start was a mid-edge projection)
 * @param routeEndLonLat    same for the route's actual end / "Arrive" step
 * @returns Array<{ instruction, streetName, distanceFt, annotations: string[],
 *                  maneuverLonLat: [lon, lat] }>
 */
export function buildDirections(graph, pathEdgeIds, routeStartLonLat, routeEndLonLat) {
  if (pathEdgeIds.length === 0) return [];
  const steps = [];
  // Precomputed name per edge, with short unnamed connectors filled in.
  const edgeNames = fillInUnnamedConnectors(graph, pathEdgeIds);
  let segStart = 0;

  // Group consecutive edges by normalized streetName (after the fill-in
  // pass). Case-insensitive + null-tolerant. Bike-facility suffix
  // variants ("Cycle Track" / "Protected Bike Lane" / "Bike Path" / …)
  // are stripped for comparison so an OSM-flip-flopping corridor renders
  // as one step.
  while (segStart < pathEdgeIds.length) {
    const startEdge = pathEdgeIds[segStart];
    const name = edgeNames[segStart];
    const nameN = normName(name);
    let segEnd = segStart;
    while (segEnd + 1 < pathEdgeIds.length
        && normName(edgeNames[segEnd + 1]) === nameN) {
      segEnd++;
    }

    let distanceFt = 0;
    let hasOnewayLane = false;
    let allRoadOneway = true;
    for (let i = segStart; i <= segEnd; i++) {
      const eid = pathEdgeIds[i];
      distanceFt += graph.edgeLengthFt(eid);
      if (graph.edgeModelType(eid) === 'BKF-ONEWAY') hasOnewayLane = true;
      if (!graph.edgeOneway(eid)) allRoadOneway = false;
    }

    let instruction;
    if (segStart === 0) {
      instruction = `Head ${cardinalFromBearing(graph.edgeBearingStart(startEdge))}`
                  + (name ? ` on ${abbreviateDirectionalsStr(name)}` : '');
    } else {
      // Turn classification based on bearing change at the join.
      const prevEdge = pathEdgeIds[segStart - 1];
      const turn = classifyTurn(graph.edgeBearingEnd(prevEdge),
                                graph.edgeBearingStart(startEdge),
                                graph.nodeFlags(graph.edgeTo(prevEdge)));
      instruction = name
        ? `${turn} onto ${abbreviateDirectionalsStr(name)}`
        : `${turn}`;
    }

    const annotations = [];
    // Only show the disclaimer when the bike lane is one-way AND the road
    // is two-way (so the lane could face either direction). If the road is
    // one-way, the bike lane direction equals the travel direction.
    if (hasOnewayLane && !allRoadOneway) {
      annotations.push('One-way bike lane may or may not be in direction of travel');
    }

    // Skip a bare "Continue" with no street name — it carries no info
    // (no maneuver, no street to confirm you're on). Absorb the distance
    // and any annotations into the previous step so the running mileage
    // stays correct. Step 0 is exempt because "Head <cardinal>" is its
    // own useful instruction even when unnamed.
    if (segStart !== 0 && !name && instruction === 'Continue'
        && steps.length > 0) {
      const prev = steps[steps.length - 1];
      prev.distanceFt += distanceFt;
      for (const a of annotations) {
        if (!prev.annotations.includes(a)) prev.annotations.push(a);
      }
      segStart = segEnd + 1;
      continue;
    }

    // Maneuver point: where this step begins. For step 0 that's the
    // route's actual start (the projection point if mid-edge, else the
    // first graph node). For later steps, it's the node we entered at.
    let maneuverLonLat;
    if (segStart === 0) {
      maneuverLonLat = routeStartLonLat || graph.nodeCoord(graph.edgeFrom(startEdge));
    } else {
      maneuverLonLat = graph.nodeCoord(graph.edgeFrom(startEdge));
    }

    steps.push({
      instruction,
      streetName: name ? abbreviateDirectionalsStr(name) : '',
      distanceFt,
      annotations,
      maneuverLonLat,
    });
    segStart = segEnd + 1;
  }

  // Final "arrive" step
  const last = pathEdgeIds[pathEdgeIds.length - 1];
  steps.push({
    instruction: 'Arrive at destination',
    streetName: graph.edgeStreetName(last)
      ? abbreviateDirectionalsStr(graph.edgeStreetName(last))
      : '',
    distanceFt: 0,
    annotations: [],
    maneuverLonLat: routeEndLonLat || graph.nodeCoord(graph.edgeTo(last)),
  });
  return steps;
}

function classifyTurn(prevBearing, nextBearing, nodeFlags) {
  // Bearings are compass-clockwise (0=N, 90=E, 180=S, 270=W). Heading east
  // and rotating counter-clockwise to head north drops the bearing from 90
  // to 0 — i.e. NEGATIVE delta = LEFT in physical-driving terms.
  const delta = ((nextBearing - prevBearing + 540) % 360) - 180;  // (-180, 180]
  const abs = Math.abs(delta);
  if (abs <= TURN_THRESHOLD_DEG) return 'Continue';
  const isLeft = delta < 0;
  if (nodeFlags?.isTrafficCircle) {
    if (isLeft) {
      return abs >= SHARP_DEG ? 'Make a left at the traffic circle'
                              : 'Turn left at the traffic circle';
    }
    return abs >= SHARP_DEG ? 'Make a right at the traffic circle'
                            : 'Turn right at the traffic circle';
  }
  if (isLeft) {
    if (abs >= SHARP_DEG) return 'Sharp left';
    if (abs >= 60)        return 'Turn left';
    return 'Slight left';
  } else {
    if (abs >= SHARP_DEG) return 'Sharp right';
    if (abs >= 60)        return 'Turn right';
    return 'Slight right';
  }
}

function cardinalFromBearing(b) {
  const dirs = ['north', 'northeast', 'east', 'southeast',
                'south', 'southwest', 'west', 'northwest'];
  const i = Math.round(b / 45) % 8;
  return dirs[i];
}

/** Format a distance in feet for display. Short distances stay in ft;
 * longer ones get expressed in miles. */
export function formatDistance(ft) {
  if (ft < 528) return `${Math.round(ft / 10) * 10} ft`;
  return `${(ft / 5280).toFixed(2)} mi`;
}
