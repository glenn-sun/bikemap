// Routing UI. Responsibilities:
//
//   1. Two route-endpoint inputs (Start, End) with FlexSearch-backed
//      autocomplete. When focused + empty, the dropdown shows three options:
//      Home, Work, "Choose on map". Otherwise it shows search hits.
//
//   2. "Choose on map" mode — explicit state where the next map click
//      sets the endpoint. Cursor turns to a crosshair via CSS; Escape
//      cancels. While the mode is active, popups.js suppresses its per-
//      layer popup handlers (see src/routing/mode.js).
//
//   3. A Settings modal (native <dialog>) where the user edits Home / Work
//      and the 5 Custom-preset sliders, plus attributions.
//
//   4. Up to 3 routes (primary + 2 twists from cost.js TWISTS). When >1
//      survives the similarity filter (findPathsMulti), a tab strip lets
//      the user swap which one is the rendered primary. Clicking a route
//      line on the map does the same. Each alt has a small floating label
//      at the midpoint of its longest unique segment (not the route
//      midpoint — that often lands on shared road).
//
// Naming convention: the route computed under the chosen preset's weights
// always carries the label "Primary". Twist routes carry their twist
// label ("Quieter", "More direct") permanently — even after a user
// promotes a twist by clicking, the original primary stays "Primary" and
// the twist stays "More direct".

import maplibregl from 'maplibre-gl';
import { loadGraph } from './graph.js';
import { findPath, findPathsMulti } from './astar.js';
import { buildDirections, formatDistance } from './directions.js';
import { computeSignCoverage } from './signCoverage.js';
import { buildElevationSeries, climbStats, elevationProfileSvg,
         pointAtDistance, distanceAtPoint, slopeAtDistance } from './elevation.js';
import {
  PRESETS, SLIDERS, TWISTS,
  weightsForPreset, weightsForCustom,
  applyTwistToSliders, weightsFromSliders,
} from './cost.js';
import { searchAddresses, preloadAddrIndex } from '../search/addr_search.js';
import { setMode, clearMode, getMode, isChoosingOnMap } from './mode.js';
import { snapSheet } from '../sheet.js';

const GRAPH_URL = `${import.meta.env.BASE_URL}data/routing_graph.json`;
const SIGNS_URL = `${import.meta.env.BASE_URL}data/bike_signs.geojson`;
const BIKE_RACKS_URL = `${import.meta.env.BASE_URL}data/bicycle_racks.geojson`;

// Distance thresholds for the destination bike-parking section that
// renders between the route summary and the turn-by-turn steps.
const RACK_GREEN_FT  = 300;
const RACK_YELLOW_FT = 1000;

const ROUTE_SOURCE  = 'route';
const ALT_SOURCE    = 'route-alts';
const ROUTE_CASING  = 'route-line-casing';
const ROUTE_LINE    = 'route-line';
const ALT_CASING    = 'route-alt-casing';
const ALT_LINE      = 'route-alt-line';

const LS_PRESET = 'bikemap-routing-preset';
const LS_CUSTOM = 'bikemap-routing-custom';
const LS_CUSTOM_ENABLED = 'bikemap-routing-custom-enabled';
const LS_DEBUG_ENABLED = 'bikemap-routing-debug-enabled';
const LS_SIDEWALKS_ENABLED = 'bikemap-routing-sidewalks-enabled';
const LS_HOME   = 'bikemap-saved-home';
const LS_WORK   = 'bikemap-saved-work';
const LS_SPEED  = 'bikemap-cycling-speed-mph';
const DEFAULT_SPEED_MPH = 10;

// IDs of the five routing-debug toggle checkboxes (one per debug overlay
// in the layers panel). The "Enable routing debug layers" Settings toggle
// gates their visibility in the layers panel AND clears all seven when it
// is disabled.
const DEBUG_TOGGLE_IDS = [
  'toggle-signals-debug',
  'toggle-crosswalks-debug',
  'toggle-beacons-debug',
  'toggle-stop-signs-debug',
  'toggle-graph-debug',
];

// Route is rendered in pink — opposite green on the color wheel so AAA /
// BBL / BL paint shows through (via the below-infra layer order) without
// the route hue clashing or being swallowed by green. Alt is the same
// hue, lighter, to read as "secondary" without changing thickness.
const PRIMARY_COLOR    = '#e91e63';
const ALT_LINE_COLOR   = '#f48fb1';
const ALT_CASING_COLOR = '#ffffff';

let state_holder = { current: null };

export function initRoutingUI(map, vm = null) {
  const state = {
    map,
    vm,                  // visibility manager (for graph-debug refresh)
    graph: null,
    signs: null,
    bikeRacks: null,
    startSpec: null,
    endSpec: null,
    startLabel: '',
    endLabel: '',
    startMarker: null,
    endMarker: null,
    stepMarkers: [],
    altMarkers: [],
    routes: [],
    panel: document.getElementById('directions-panel'),
    preset: loadPresetFromStorage(),
    customSliders: loadCustomFromStorage(),
    customEnabled: loadCustomEnabledFromStorage(),
    debugEnabled: loadDebugEnabledFromStorage(),
    sidewalksEnabled: loadSidewalksEnabledFromStorage(),
    home: loadLocFromStorage(LS_HOME),
    work: loadLocFromStorage(LS_WORK),
    speedMph: loadSpeedFromStorage(),
    activeIndex: 0,      // index into state.routes that's currently rendered
                         // as the pink primary line / step list
    userLocation: null,  // {lon, lat, accuracy} — null until first GPS fix
    userLocationMarker: null,
    geoWatchIdHigh: null,
    geoWatchIdLow: null,
    locationPending: false,   // a "My location" pick is awaiting a fix
    locationError: null,      // last error string from a failed location pick;
                              // surfaced as subtext under "My location" in the
                              // endpoint dropdown, not as a panel banner
    locationDropdownRefresh: null,  // installed by the currently-focused
                                    // endpoint dropdown so requestLocationOnce
                                    // can re-render it as state changes
    // Two-way hover sync between elevation chart and the active route
    // line on the map. `hoverSeries` is the current active route's
    // elevation series (distances/elevations/coords); `hoverMarker` is a
    // pink dot that tracks the cursor on the map; the chart cursor lives
    // inside the .route-elev SVG as a <line> + <circle>.
    hoverSeries: null,
    hoverMarker: null,
  };
  // If the persisted preset is Custom but Custom is no longer enabled,
  // fall back so we never expose a hidden mode.
  if (state.preset === 'custom' && !state.customEnabled) {
    state.preset = 'comfort';
    savePresetToStorage(state.preset);
  }
  state_holder.current = state;

  preloadAddrIndex();
  addRouteSources(map, state);
  wireAddressInputs(state);
  wireSettingsModal(state);
  wirePresetUI(state);
  setPresetUI(state);
  wireSidewalksToggle(state);
  wireGlobalChooseInteractions(state);
  startUserLocationTracking(state);
  attachMapHoverHandlers(state);
  attachDirectionsResizeHandler(state);
  // Boot-time enforcement of the debug gate: if it's off (default), make
  // sure no debug layer is visible even if a stale `bikemap-toggles` entry
  // would otherwise have re-enabled one.
  applyDebugEnabledUI(state, { forceClearOnDisable: true });

  // The panel stays hidden until there's actually a route to show. While
  // the graph is loading, the absence of any UI here is the cue.

  Promise.all([
    loadGraph(GRAPH_URL),
    fetch(SIGNS_URL).then((r) => r.json()),
    fetch(BIKE_RACKS_URL).then((r) => r.json()),
  ]).then(([graph, signs, bikeRacks]) => {
    state.graph = graph;
    state.signs = signs;
    state.bikeRacks = bikeRacks;
    addGraphDebugLayers(map, graph);
    // The visibility manager bound graph-debug to a checkbox before the
    // layers existed; apply now so the checkbox state takes effect.
    vm?.apply();
    console.log(`[routing] graph loaded: ${graph.nodeCount} nodes, ${graph.edgeCount} edges`);
  }).catch((err) => {
    console.error('[routing] failed to load graph:', err);
    setPanel(state, '<p class="route-error">Failed to load routing graph.</p>');
  });

  document.getElementById('clear-start')?.addEventListener('click', () => {
    clearEndpoint(state, 'start');
  });
  document.getElementById('clear-end')?.addEventListener('click', () => {
    clearEndpoint(state, 'end');
  });
  document.getElementById('swap-endpoints')?.addEventListener('click', () => {
    swapEndpoints(state);
  });
}

// ---------- public entry: route from current location to a POI ----------
//
// Called from popups.js when the user clicks the "Go" button inside a POI
// popup. Writes My Location into the Start field and the POI into the End
// field, then triggers compute via setEndpoint's auto-route.

export function routeFromMyLocationTo(lon, lat, label) {
  const state = state_holder.current;
  if (!state || !state.graph) return;
  const dest = snapToGraph(state.graph, lon, lat, 800);
  if (!dest.spec) {
    setPanel(state, '<p class="route-error">Destination is too far from the bike network.</p>');
    return;
  }
  setEndpoint(state, 'end', dest.spec, dest.projLon, dest.projLat, label || 'Destination');
  if (!state.userLocation) {
    state.locationPending = true;
    state.locationError = null;
    state.locationDropdownRefresh?.();
    requestLocationOnce(state).then(() => {
      state.locationPending = false;
      if (!state.userLocation) {
        state.locationError = 'Couldn’t get your location';
        state.locationDropdownRefresh?.();
        return;
      }
      applyMyLocationAsStart(state);
    });
    return;
  }
  applyMyLocationAsStart(state);
}

function applyMyLocationAsStart(state) {
  const u = state.userLocation;
  if (!u) return;
  const snap = snapToGraph(state.graph, u.lon, u.lat, 800);
  if (!snap.spec) {
    state.locationError = 'Your location is too far from the bike network.';
    state.locationDropdownRefresh?.();
    return;
  }
  state.locationError = null;
  setEndpoint(state, 'start', snap.spec, snap.projLon, snap.projLat, 'My location');
}

// ---------- map sources / layers ----------

function addRouteSources(map, state) {
  // Insert route layers BELOW bike infrastructure (so green/orange paint
  // strips show through where the route follows them — easier to see
  // which segments are on AAA, BBL, etc.). `kc-regional-trails` is the
  // bottom-most bike-infra layer per layers.js; if it's not in the
  // style yet, fall through to top-of-stack as before.
  const beforeId = map.getLayer('kc-regional-trails') ? 'kc-regional-trails' : undefined;

  // All four route layers share the wider width — primary and alts read
  // alike at a glance, with color (saturation vs. softness) being the
  // visual cue for which is active rather than thickness.
  const CASING_WIDTH = ['interpolate', ['linear'], ['zoom'], 10, 5,   16, 14];
  const LINE_WIDTH   = ['interpolate', ['linear'], ['zoom'], 10, 3.5, 16, 10];

  // Alternates BELOW the primary (insertion order = render bottom-to-top).
  map.addSource(ALT_SOURCE, { type: 'geojson',
    data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: ALT_CASING, type: 'line', source: ALT_SOURCE,
    paint: {
      'line-color': ALT_CASING_COLOR,
      'line-width': CASING_WIDTH,
      'line-opacity': 0.7,
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  }, beforeId);
  map.addLayer({
    id: ALT_LINE, type: 'line', source: ALT_SOURCE,
    paint: {
      'line-color': ALT_LINE_COLOR,
      'line-width': LINE_WIDTH,
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  }, beforeId);

  map.addSource(ROUTE_SOURCE, { type: 'geojson',
    data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: ROUTE_CASING, type: 'line', source: ROUTE_SOURCE,
    paint: {
      'line-color': '#ffffff',
      'line-width': CASING_WIDTH,
      'line-opacity': 0.9,
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  }, beforeId);
  map.addLayer({
    id: ROUTE_LINE, type: 'line', source: ROUTE_SOURCE,
    paint: {
      'line-color': PRIMARY_COLOR,
      'line-width': LINE_WIDTH,
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  }, beforeId);

  // Activate an alternate by clicking its line (same effect as clicking a
  // tab in the directions panel).
  map.on('click', ALT_LINE, (e) => {
    if (isChoosingOnMap()) return;
    const altId = e.features?.[0]?.properties?.altId;
    if (altId != null) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      setActiveRoute(state, altId);
    }
  });
  map.on('mouseenter', ALT_LINE, () => {
    if (isChoosingOnMap()) return;
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', ALT_LINE, () => {
    if (isChoosingOnMap()) return;
    map.getCanvas().style.cursor = '';
  });

  // The ONLY way to set an endpoint by clicking the map is to be in
  // choose-on-map mode for one of the inputs.
  map.on('click', (e) => {
    const mode = getMode();
    if (!mode) return;
    if (!state.graph) return;
    const lon = e.lngLat.lng, lat = e.lngLat.lat;
    const { spec, projLon, projLat } = snapToGraph(state.graph, lon, lat);
    if (!spec) return;
    const label = formatLatLngLabel(projLon, projLat);
    finishChooseOnMap(state, mode.which, spec, projLon, projLat, label);
  });
}

function snapToGraph(graph, lon, lat, radiusFt = 200) {
  const proj = graph.findNearestEdgeProjection(lon, lat, radiusFt);
  if (proj) {
    return { spec: { kind: 'edge', projection: proj },
             projLon: proj.projLon, projLat: proj.projLat };
  }
  const nid = graph.findNearestNode(lon, lat);
  if (nid == null) return { spec: null };
  const [pl, pa] = graph.nodeCoord(nid);
  return { spec: { kind: 'node', nodeId: nid }, projLon: pl, projLat: pa };
}

// ---------- endpoint setting (start or end) ----------

function setEndpoint(state, which, spec, lon, lat, label) {
  const marker = new maplibregl.Marker({
    color: which === 'start' ? '#1faa5a' : '#d93030',
  }).setLngLat([lon, lat]).addTo(state.map);
  if (which === 'start') {
    if (state.startMarker) state.startMarker.remove();
    state.startMarker = marker;
    state.startSpec = spec;
    state.startLabel = label;
    setInputValue('route-start-input', label);
  } else {
    if (state.endMarker) state.endMarker.remove();
    state.endMarker = marker;
    state.endSpec = spec;
    state.endLabel = label;
    setInputValue('route-end-input', label);
  }
  if (state.startSpec && state.endSpec) {
    compute(state);
  } else if (state.panel) {
    // One endpoint pinned, one to go — keep the directions panel hidden
    // (the green/red marker is its own affordance).
    state.panel.hidden = true;
  }
}

// ---------- compute primary + twists ----------

function activeWeights(state) {
  const sw = state.sidewalksEnabled;
  if (state.preset === 'custom') return weightsForCustom(state.customSliders, sw);
  return weightsForPreset(state.preset, sw);
}
function activeSliders(state) {
  return state.preset === 'custom' ? state.customSliders : PRESETS[state.preset];
}

function compute(state) {
  // Loading state: vertically-centered "Computing route" with animated
  // ellipsis. Three separately-fading dots in spans (CSS animates each
  // span's opacity at staggered delays).
  setPanel(state,
    '<div class="route-loading">'
    + '<span class="route-loading-text">Computing route</span>'
    + '<span class="route-loading-dots">'
    + '<span>.</span><span>.</span><span>.</span>'
    + '</span>'
    + '</div>');
  setTimeout(() => {
    const t0 = performance.now();
    const primaryWeights = activeWeights(state);
    const baseSliders = activeSliders(state);
    const twistRuns = TWISTS.map((t) => ({
      id: t.id, label: t.label,
      weights: weightsFromSliders(
        applyTwistToSliders(baseSliders, t.id),
        primaryWeights.signCoverageMax,
        state.sidewalksEnabled,
      ),
    }));
    const routes = findPathsMulti(primaryWeights, state.graph,
                                  state.startSpec, state.endSpec, twistRuns);
    const tMs = performance.now() - t0;
    const primary = routes[0]?.result;
    if (!primary) {
      setPanel(state, '<p class="route-error">No path found between those points.</p>');
      state.routes = [];
      drawRoutes(state);
    } else {
      // Annotate each route with its geometry index set (used for
      // max-difference label placement on alts) and its stitched polyline.
      state.routes = routes.map((r) => ({
        ...r,
        fullGeom: stitchGeometry(state.graph, r.result),
        geomSet: geomIndexSet(state.graph, r.result.pathEdgeIds),
      }));
      state.activeIndex = 0;    // primary is active by default; tabs stay stable
      state.lastComputeMs = tMs;
      drawRoutes(state);
      renderPrimary(state);
    }
    // On mobile, expand the sheet to "full" whenever compute finishes —
    // so the user can see directions immediately after typing/selecting
    // endpoints OR after a Choose-on-map flow (which had collapsed
    // the sheet to peek so the user could see the map). Fired even on
    // route-not-found so the error message is also visible. The double
    // call (now + rAF) survives a stray keyboard-dismiss resize that
    // could otherwise re-apply a stale snap state.
    snapSheet('full');
    requestAnimationFrame(() => snapSheet('full'));
  }, 0);
}

function geomIndexSet(graph, edgeIds) {
  const s = new Set();
  for (const eid of edgeIds) s.add(graph.edgeGeomIndex(eid));
  return s;
}

function stitchGeometry(graph, result) {
  const out = [];
  if (result.prefixGeom?.length > 0) out.push(...result.prefixGeom);
  for (const eid of result.pathEdgeIds) {
    const edge = graph.edge(eid);
    if (out.length === 0) out.push(...edge.geometry);
    else for (let i = 1; i < edge.geometry.length; i++) out.push(edge.geometry[i]);
  }
  if (result.suffixGeom?.length > 0) {
    for (let i = 1; i < result.suffixGeom.length; i++) out.push(result.suffixGeom[i]);
  }
  return out;
}

function drawRoutes(state) {
  const map = state.map;
  const active = state.routes[state.activeIndex];
  map.getSource(ROUTE_SOURCE).setData(active ? {
    type: 'FeatureCollection',
    features: [{ type: 'Feature',
                 geometry: { type: 'LineString', coordinates: active.fullGeom },
                 properties: { altId: active.id } }],
  } : { type: 'FeatureCollection', features: [] });

  // Alts = every route OTHER than the active one. We keep the original
  // insertion order stable across promotions so the tab strip's positions
  // don't shuffle when the user clicks a tab.
  const inactiveIndices = state.routes
    .map((_, i) => i)
    .filter((i) => i !== state.activeIndex);
  const altFeatures = inactiveIndices.map((i) => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: state.routes[i].fullGeom },
    properties: { altId: state.routes[i].id },
  }));
  map.getSource(ALT_SOURCE).setData({
    type: 'FeatureCollection', features: altFeatures,
  });

  // Floating midpoint labels on each alternate, placed where the alt
  // actually diverges from the CURRENT active route (longest contiguous
  // unique stretch).
  for (const m of state.altMarkers) m.remove();
  state.altMarkers = [];
  const activeGeomSet = active?.geomSet;
  for (const i of inactiveIndices) {
    const r = state.routes[i];
    const pos = labelPositionFor(state.graph, r, activeGeomSet);
    if (!pos) continue;
    const miles = (r.result.totalLengthFt / 5280).toFixed(2);
    const el = document.createElement('div');
    el.className = 'route-alt-label';
    el.innerHTML = `<b>${escHtml(r.label)}</b><br><span class="route-alt-meta">${miles} mi</span>`;
    el.title = 'Click to use this route';
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      setActiveRoute(state, r.id);
    });
    const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat(pos).addTo(state.map);
    state.altMarkers.push(marker);
  }
}

/** Pick a label position for an alt: the midpoint of the alt's longest
 *  contiguous run of edges whose geometry index is NOT in the primary's
 *  geom set. If the alt overlaps the primary entirely (shouldn't happen
 *  per the similarity filter), fall back to the route midpoint. */
function labelPositionFor(graph, altRoute, primaryGeomSet) {
  const eids = altRoute.result.pathEdgeIds;
  if (!eids?.length) return null;
  let bestStart = -1, bestEnd = -1, bestLen = 0;
  let curStart = -1, curLen = 0;
  for (let i = 0; i < eids.length; i++) {
    const inPrim = primaryGeomSet
      ? primaryGeomSet.has(graph.edgeGeomIndex(eids[i]))
      : false;
    if (!inPrim) {
      if (curStart < 0) { curStart = i; curLen = 0; }
      curLen += graph.edgeLengthFt(eids[i]);
      if (curLen > bestLen) {
        bestStart = curStart; bestEnd = i; bestLen = curLen;
      }
    } else {
      curStart = -1; curLen = 0;
    }
  }
  if (bestStart < 0) return midpointOf(altRoute.fullGeom);
  // Midpoint of the unique-run edges by length-weighted geometry.
  const segCoords = [];
  for (let i = bestStart; i <= bestEnd; i++) {
    const edge = graph.edge(eids[i]);
    if (segCoords.length === 0) segCoords.push(...edge.geometry);
    else for (let j = 1; j < edge.geometry.length; j++) segCoords.push(edge.geometry[j]);
  }
  return midpointOf(segCoords);
}

function midpointOf(geom) {
  if (!geom || geom.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < geom.length; i++) {
    const [x0, y0] = geom[i - 1], [x1, y1] = geom[i];
    cum.push(cum[i - 1] + Math.hypot((x1 - x0) * 245000, (y1 - y0) * 364000));
  }
  const half = cum[cum.length - 1] / 2;
  for (let i = 1; i < cum.length; i++) {
    if (cum[i] >= half) {
      const t = (half - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
      const [x0, y0] = geom[i - 1], [x1, y1] = geom[i];
      return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    }
  }
  return geom[Math.floor(geom.length / 2)];
}

function setActiveRoute(state, routeId) {
  const idx = state.routes.findIndex((r) => r.id === routeId);
  if (idx < 0 || idx === state.activeIndex) return;
  // We do NOT reorder state.routes — the tab strip needs stable positions
  // across promotions. Only the "which is active" pointer moves.
  state.activeIndex = idx;
  drawRoutes(state);
  renderPrimary(state);
}

function renderPrimary(state) {
  const r = state.routes[state.activeIndex];
  if (!r) return;
  const result = r.result;
  const fullGeom = r.fullGeom;
  const weights = r.weights;
  const sig = computeSignCoverage(weights, fullGeom, state.signs?.features || []);

  const routeStart = fullGeom[0];
  const routeEnd   = fullGeom[fullGeom.length - 1];
  const steps = buildDirections(state.graph, result.pathEdgeIds, routeStart, routeEnd);
  addStepMarkers(state, steps);
  renderDirections(state, {
    steps,
    totalLengthFt: result.totalLengthFt,
    totalCostFt: result.totalCostFt
                + sig.uncoveredFraction * result.totalLengthFt * weights.signCoverageMax,
    timeMs: state.lastComputeMs ?? 0,
    sig,
  });
}

function addStepMarkers(state, steps) {
  for (const m of state.stepMarkers) m.remove();
  state.stepMarkers = [];
  for (let i = 1; i < steps.length - 1; i++) {
    const s = steps[i];
    if (!s.maneuverLonLat) continue;
    const el = document.createElement('div');
    el.className = 'route-step-marker';
    el.textContent = String(i + 1);
    const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat(s.maneuverLonLat).addTo(state.map);
    state.stepMarkers.push(marker);
  }
}

// ---------- chart ↔ map hover sync ----------
//
// Two-way: mousing over the elevation chart drops a pink dot on the map
// at the matching route position; mousing over the active route LINE on
// the map drops a cursor line on the chart at the matching distance.
//
// hoverSeries / hoverChartGeom are populated by elevationBlockHtml() each
// time the active route is rendered, so the cursor is always in sync with
// whatever route is currently shown.

function ensureHoverMarker(state) {
  if (state.hoverMarker) return state.hoverMarker;
  const el = document.createElement('div');
  el.className = 'route-hover-dot';
  state.hoverMarker = new maplibregl.Marker({ element: el, anchor: 'center' });
  return state.hoverMarker;
}

function hideHoverCursor(state) {
  if (state.hoverMarker) state.hoverMarker.remove();
  const panel = state.panel;
  if (!panel) return;
  panel.querySelector('.route-elev-cursor-line')?.setAttribute('hidden', '');
  panel.querySelector('.route-elev-cursor-dot') ?.setAttribute('hidden', '');
  panel.querySelector('.route-elev-cursor-label')?.setAttribute('hidden', '');
}

/** Move both cursors (map dot + chart line/dot/label) to the given
 *  distance along the active route. Either direction calls this. */
function moveHoverCursorToDist(state, distFt) {
  const series = state.hoverSeries;
  const geom = state.hoverChartGeom;
  if (!series || !geom) return;
  const totalDist = geom.totalDist;
  if (!(totalDist > 0)) return;
  const d = Math.max(0, Math.min(totalDist, distFt));
  const pt = pointAtDistance(series, d);
  if (!pt) return;
  // Map marker
  const marker = ensureHoverMarker(state);
  marker.setLngLat([pt.lon, pt.lat]).addTo(state.map);
  // Chart cursor
  const panel = state.panel;
  const line = panel?.querySelector('.route-elev-cursor-line');
  const dot  = panel?.querySelector('.route-elev-cursor-dot');
  const lbl  = panel?.querySelector('.route-elev-cursor-label');
  if (!line || !dot || !lbl) return;
  const pad = geom.pad;
  const innerW = geom.width - pad.l - pad.r;
  const innerH = geom.height - pad.t - pad.b;
  const x = pad.l + (d / totalDist) * innerW;
  const elevRange = Math.max(1, geom.maxElev - geom.minElev);
  const y = pad.t + (1 - (pt.elevFt - geom.minElev) / elevRange) * innerH;
  line.setAttribute('x1', x.toFixed(1));
  line.setAttribute('x2', x.toFixed(1));
  line.removeAttribute('hidden');
  dot.setAttribute('cx', x.toFixed(1));
  dot.setAttribute('cy', y.toFixed(1));
  dot.removeAttribute('hidden');
  // Three-line label stacked vertically: elev / distance / slope. The
  // grade uses a smoothed window so a single noisy DEM segment doesn't
  // dominate. Stacking keeps each line short (~6 chars) so the
  // text-anchor="middle" rarely clips at the chart's left/right edges.
  const slope = slopeAtDistance(series, d);
  const pctStr = (slope >= 0 ? '+' : '') + (slope * 100).toFixed(1) + '%';
  // 3 lines stacked at 10 px each. With pad.t = 32, lines at y = 9, 19,
  // 29 sit entirely in the top padding above the elevation curve, so the
  // tooltip never overlaps the plotted data.
  lbl.setAttribute('y', '9');
  lbl.querySelector('.route-elev-cursor-elev').setAttribute('x', x.toFixed(1));
  lbl.querySelector('.route-elev-cursor-mi'  ).setAttribute('x', x.toFixed(1));
  lbl.querySelector('.route-elev-cursor-pct' ).setAttribute('x', x.toFixed(1));
  lbl.querySelector('.route-elev-cursor-elev').textContent = `${Math.round(pt.elevFt)} ft`;
  lbl.querySelector('.route-elev-cursor-mi'  ).textContent = `${(d / 5280).toFixed(2)} mi`;
  lbl.querySelector('.route-elev-cursor-pct' ).textContent = pctStr;
  lbl.removeAttribute('hidden');
}

function attachChartHoverHandlers(state) {
  if (!state.panel) return;
  const svg = state.panel.querySelector('.route-elev-chart');
  if (!svg) return;
  const geom = state.hoverChartGeom;
  if (!geom) return;
  const innerW = geom.width - geom.pad.l - geom.pad.r;
  const onMove = (e) => {
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const xPx = e.clientX - rect.left;
    const xVB = xPx * (geom.width / rect.width);
    const t = (xVB - geom.pad.l) / innerW;
    const d = geom.totalDist * Math.max(0, Math.min(1, t));
    moveHoverCursorToDist(state, d);
  };
  svg.addEventListener('mousemove', onMove);
  svg.addEventListener('mouseleave', () => hideHoverCursor(state));
}

/** One-time wiring: hovering the active route LINE on the map drives the
 *  same cursor sync. Called once from initRoutingUI(); it stays bound for
 *  the life of the page and reads `state.hoverSeries` (refreshed on each
 *  route render) so it always reflects the current active route. */
function attachMapHoverHandlers(state) {
  const map = state.map;
  if (!map) return;
  map.on('mousemove', ROUTE_LINE, (e) => {
    if (isChoosingOnMap()) return;
    if (!state.hoverSeries) return;
    const d = distanceAtPoint(state.hoverSeries, e.lngLat.lng, e.lngLat.lat);
    if (d == null) return;
    moveHoverCursorToDist(state, d);
  });
  map.on('mouseleave', ROUTE_LINE, () => hideHoverCursor(state));
}

function infraBreakdown(graph, edgeIds) {
  // Bucket each edge's length by routing category. Used to render the
  // per-route infrastructure bar.
  //   - AAA          : facility ∈ {BKF-NGW, BKF-PBL, BKF-OFFST}
  //   - Other bike   : split into BBL / BL / sharrow-or-climbing so the
  //                    bar can render their three colors in proportion
  //   - Local streets: no facility AND no centerline (≈ residential)
  //   - Major streets: no facility AND has centerline (arterial/collector)
  //   - Sidewalk     : OSM footway=sidewalk|crossing (gray)
  let aaa = 0, bbl = 0, bl = 0, shw = 0, local = 0, major = 0, sidewalk = 0, total = 0;
  for (const eid of edgeIds) {
    const len = graph.edgeLengthFt(eid);
    total += len;
    // Sidewalks short-circuit ahead of facility classification (a
    // sidewalk should never inherit AAA paint anyway, but we re-assert
    // it here so the bar is consistent with the routing logic).
    if (graph.edgeIsSidewalk(eid)) { sidewalk += len; continue; }
    const fac = graph.edgeFacility(eid);
    if (fac === 'BKF-NGW' || fac === 'BKF-PBL' || fac === 'BKF-OFFST') aaa += len;
    else if (fac === 'BKF-BBL') bbl += len;
    else if (fac === 'BKF-BL')  bl += len;
    else if (fac === 'BKF-CLMB' || fac === 'BKF-SHW') shw += len;
    else if (!graph.edgeCenterline(eid)) local += len;
    else major += len;
  }
  return { aaa, bbl, bl, shw, local, major, sidewalk, total };
}

// Sub-segment fill colors — MUST stay in sync with the per-tier line
// colors in src/layers.js so the bar reads as the same legend as the map.
// "Local streets" is white (rendered with a thin gray stroke so it's
// visible against the white panel); "Major streets" is a muted red.
const INFRA_COLORS = {
  aaa:      '#1F6B3D',
  bbl:      '#3FA85F',
  bl:       '#7FCC9C',
  shw:      '#E07A1F',
  local:    '#ffffff',
  major:    '#d65a5a',
  sidewalk: '#9e9e9e',
};

const INFRA_GROUP_META = {
  aaa:      { label: 'All ages & abilities', pos: 'top' },
  other:    { label: 'Other bike',           pos: 'bot' },
  local:    { label: 'Local streets',        pos: 'top' },
  major:    { label: 'Major streets',        pos: 'bot' },
  sidewalk: { label: 'Sidewalk',             pos: 'bot' },
};

function infraSummaryBarSvg(b, vbWidth = 320) {
  // Render the breakdown as a horizontal bar:
  //   [AAA | BBL | BL | SHW | LOCAL | MAJOR | SIDEWALK]
  // Each category gets a label connected to its bar segment by an L-line.
  // Labels sit above the bar (`pos: 'top'`) or below (`pos: 'bot'`).
  //
  // Layout strategy (single row per side):
  //   1. Label x-placement: each label starts at its bar-segment center.
  //      Then we run a symmetric repulsion relaxation — for each pair
  //      with overlapping x-extents we push both members apart by half
  //      of the overlap, then clamp to the viewBox. Iterate until
  //      stable. This distributes displacement across both sides of an
  //      overlap rather than letting one label accumulate the full push.
  //   2. Connector defaults: each connector has the original midY
  //      (midpoint between the bar edge and the label-glyph edge).
  //   3. Connector overlap resolution: if two connectors on the same
  //      side end up with horizontal mid-segments at the same y and
  //      x-overlapping, we nudge one a few px toward the label and the
  //      other a few px toward the bar. Iterate until separated.
  //
  // `vbWidth` is the SVG's RENDERED PIXEL WIDTH and is also used as the
  // viewBox width, so 1 viewBox unit = 1 screen pixel. Result: font
  // size and bar height stay constant regardless of container width;
  // only the bar's horizontal extent stretches.
  if (!b.total) return '';
  const VB_W = vbWidth;
  const PAD_X = 6;
  const BAR_X0 = PAD_X, BAR_X1 = VB_W - PAD_X;
  const BAR_W = BAR_X1 - BAR_X0;

  // Walk the sub-segments left-to-right and assign x ranges.
  const subs = [
    { k: 'aaa',      ft: b.aaa,            group: 'aaa'      },
    { k: 'bbl',      ft: b.bbl,            group: 'other'    },
    { k: 'bl',       ft: b.bl,             group: 'other'    },
    { k: 'shw',      ft: b.shw,            group: 'other'    },
    { k: 'local',    ft: b.local,          group: 'local'    },
    { k: 'major',    ft: b.major,          group: 'major'    },
    { k: 'sidewalk', ft: b.sidewalk || 0,  group: 'sidewalk' },
  ];
  let cursor = BAR_X0;
  for (const s of subs) {
    s.x0 = cursor;
    s.w  = BAR_W * s.ft / b.total;
    cursor += s.w;
    s.x1 = cursor;
  }

  // One group per category (skipped if its total length is 0).
  const groups = [];
  for (const g of Object.keys(INFRA_GROUP_META)) {
    const ss = subs.filter((s) => s.group === g && s.w > 0);
    if (!ss.length) continue;
    const x0 = Math.min(...ss.map((s) => s.x0));
    const x1 = Math.max(...ss.map((s) => s.x1));
    const ft = ss.reduce((acc, s) => acc + s.ft, 0);
    const pct = Math.round(100 * ft / b.total);
    // Sub-1% categories show as "<1%" rather than rounded to 0% — a
    // sliver that contributes any nonzero distance is still on the
    // route, and the user should see it called out as such.
    const pctText = pct === 0 ? '<1%' : `${pct}%`;
    groups.push({
      g, x0, x1, center: (x0 + x1) / 2,
      multi: ss.length > 1,
      pct,
      label: `${INFRA_GROUP_META[g].label} · ${pctText}`,
      pos: INFRA_GROUP_META[g].pos,
    });
  }

  // Label width estimate (9.5px sans ≈ 5.3 px/char) for collision tests.
  for (const grp of groups) {
    const estW = grp.label.length * 5.3 + 4;
    grp.halfW = estW / 2;
  }

  // Geometry: single row per side at the ORIGINAL y positions.
  const hasTop = groups.some((g) => g.pos === 'top');
  const hasBot = groups.some((g) => g.pos === 'bot');
  const TOP_ZONE = hasTop ? 32 : 4;
  const BOT_ZONE = hasBot ? 36 : 4;
  const BAR_H = 14;
  const BAR_Y0 = TOP_ZONE;
  const BAR_Y1 = BAR_Y0 + BAR_H;
  const VB_H = TOP_ZONE + BAR_H + BOT_ZONE;
  const TOP_BASELINE = 12;
  const BOT_BASELINE = BAR_Y1 + 28;

  // Symmetric repulsion: push half of each overlap onto each member,
  // clamp to viewBox edges, iterate until stable (or capped). Works
  // for any label widths and any number of labels per side.
  function placeLabels(side) {
    const ls = groups.filter((g) => g.pos === side).sort((a, b) => a.center - b.center);
    for (const l of ls) l.labelX = l.center;
    const minGap = (a, b) => a.halfW + b.halfW + 6;
    const clamp = (l) => { l.labelX = Math.max(l.halfW, Math.min(VB_W - l.halfW, l.labelX)); };
    for (let iter = 0; iter < 40; iter++) {
      let maxOverlap = 0;
      for (let i = 1; i < ls.length; i++) {
        const a = ls[i - 1], c = ls[i];
        const overlap = minGap(a, c) - (c.labelX - a.labelX);
        if (overlap > 0) {
          a.labelX -= overlap / 2;
          c.labelX += overlap / 2;
          if (overlap > maxOverlap) maxOverlap = overlap;
        }
      }
      for (const l of ls) clamp(l);
      if (maxOverlap < 0.5) break;
    }
    return ls;
  }
  const topLabels = placeLabels('top');
  const botLabels = placeLabels('bot');

  // Sub-segment rects.
  const segRects = subs.filter((s) => s.w > 0).map((s) => {
    const stroke = s.k === 'local'
      ? ' stroke="#bbb" stroke-width="0.5"' : '';
    return `<rect x="${s.x0.toFixed(2)}" y="${BAR_Y0}" `
         + `width="${Math.max(0.1, s.w).toFixed(2)}" `
         + `height="${BAR_Y1 - BAR_Y0}" `
         + `fill="${INFRA_COLORS[s.k]}"${stroke}/>`;
  }).join('');

  // Build connector data per label. Each connector has a horizontal
  // mid-segment running between segCenter and labelX at y = midY. The
  // midY is constrained to [yMin, yMax]; we start at the default
  // midpoint and nudge in resolveConnectorOverlaps if needed.
  function buildConn(grp) {
    const cx = grp.center, lx = grp.labelX;
    if (grp.pos === 'top') {
      const ly = TOP_BASELINE + 3;            // just below the label glyph
      const yMin = BAR_Y0 + 2;                // just below bar top
      const yMax = ly - 1;                    // just above label edge
      const midY = (ly + BAR_Y0) / 2;
      return { grp, ly, anchorY: BAR_Y0, midY, yMin, yMax,
               xMin: Math.min(cx, lx), xMax: Math.max(cx, lx) };
    }
    const ly = BOT_BASELINE - 11;             // just above the label top
    const yMin = BAR_Y1 + 2;
    const yMax = ly - 1;
    const useBracket = (grp.g === 'other' && grp.multi);
    // The "other" T-bracket sits closer to the bar by default; the
    // others sit at the midpoint between bar and label.
    const midY = useBracket ? (BAR_Y1 + 3) : (BAR_Y1 + ly) / 2;
    return { grp, ly, anchorY: BAR_Y1, midY, yMin, yMax,
             // Horizontal extent: full BBL+BL+SHW span for the bracket,
             // segCenter→labelX for the simple connectors.
             xMin: useBracket ? grp.x0 : Math.min(cx, lx),
             xMax: useBracket ? grp.x1 : Math.max(cx, lx),
             useBracket };
  }
  const topConns = topLabels.map(buildConn);
  const botConns = botLabels.map(buildConn);

  // Build the geometry of each connector as a list of line segments
  // (used for crossing detection). The L-shape connector emits
  //   - 1 horizontal at y=midY, x in [min(cx,lx), max(cx,lx)]
  //   - 2 verticals (cx leg between bar anchor and midY; lx leg
  //                  between midY and label edge)
  // The T-bracket "Other bike" multi connector emits
  //   - 2 horizontals (the bracket at midY across the full BBL+BL+SHW
  //                    span, plus the stem horizontal between cx and lx)
  //   - 2 verticals (cx leg between midY and stemMidY; lx leg between
  //                  stemMidY and label edge)
  // Note brackets have no leg up to the bar — they hang in the air
  // visually just below the bar.
  function buildSegments(c) {
    const cx = c.grp.center, lx = c.grp.labelX;
    if (c.useBracket) {
      const stemMid = (c.midY + c.ly) / 2;
      return {
        horiz: [
          { y: c.midY,  xMin: c.grp.x0, xMax: c.grp.x1 },                     // bracket
          { y: stemMid, xMin: Math.min(cx, lx), xMax: Math.max(cx, lx) },     // stem horiz
        ],
        verts: [
          { x: cx, yMin: Math.min(c.midY, stemMid), yMax: Math.max(c.midY, stemMid) },
          { x: lx, yMin: Math.min(stemMid, c.ly),   yMax: Math.max(stemMid, c.ly) },
        ],
      };
    }
    return {
      horiz: [
        { y: c.midY, xMin: Math.min(cx, lx), xMax: Math.max(cx, lx) },
      ],
      verts: [
        { x: cx, yMin: Math.min(c.anchorY, c.midY), yMax: Math.max(c.anchorY, c.midY) },
        { x: lx, yMin: Math.min(c.midY, c.ly),     yMax: Math.max(c.midY, c.ly) },
      ],
    };
  }

  // Count visible crossings between two connectors. Counts every
  // vertical-leg × horizontal-segment intersection plus any same-y
  // horizontal-horizontal overlap.
  function pairCrossings(c1, c2) {
    const a = buildSegments(c1);
    const b = buildSegments(c2);
    let n = 0;
    const hvCross = (h, v) =>
      v.x >= h.xMin && v.x <= h.xMax && h.y >= v.yMin && h.y <= v.yMax;
    for (const h of a.horiz) for (const v of b.verts) if (hvCross(h, v)) n++;
    for (const h of b.horiz) for (const v of a.verts) if (hvCross(h, v)) n++;
    for (const h1 of a.horiz) for (const h2 of b.horiz) {
      if (Math.abs(h1.y - h2.y) < 0.5
          && !(h1.xMax < h2.xMin || h2.xMax < h1.xMin)) n++;
    }
    return n;
  }
  function totalCrossings(conns) {
    let n = 0;
    for (let i = 0; i < conns.length; i++) {
      for (let j = i + 1; j < conns.length; j++) n += pairCrossings(conns[i], conns[j]);
    }
    return n;
  }

  // Exhaustively search discrete midY assignments for the combination
  // with the fewest crossings. With at most ~5 connectors per side
  // (aaa/local on top; other/major/sidewalk on bot) and 5 candidate
  // levels per connector, that's ≤ 5^5 = 3,125 evaluations — trivial.
  // Each connector's allowed range is [yMin, yMax]; we sample 5 evenly
  // spaced levels including the default midpoint.
  //
  // Tiebreak: prefer assignments with less total perturbation from the
  // default midY (avoids gratuitous movement when crossings are tied).
  // This is the core fix for the "all heights differ but two
  // connectors still cross" case — a swap of two midYs often clears
  // the crossing, and exhaustive search picks it up.
  function optimizeMidYs(conns) {
    if (conns.length <= 1) return;
    const N_LEVELS = 5;
    // Stash defaults for the perturbation tiebreaker.
    for (const c of conns) c._defaultMidY = c.midY;
    const levelsPer = conns.map((c) => {
      const out = [];
      const span = c.yMax - c.yMin;
      for (let i = 0; i < N_LEVELS; i++) {
        out.push(c.yMin + (span * i) / (N_LEVELS - 1));
      }
      return out;
    });

    const N = conns.length;
    const total = N_LEVELS ** N;
    let bestScore = Infinity;
    const bestIdx = new Array(N).fill(0);
    const cur = new Array(N).fill(0);
    for (let combo = 0; combo < total; combo++) {
      let t = combo;
      for (let i = 0; i < N; i++) { cur[i] = t % N_LEVELS; t = Math.floor(t / N_LEVELS); }
      for (let i = 0; i < N; i++) conns[i].midY = levelsPer[i][cur[i]];
      const crossings = totalCrossings(conns);
      let perturbation = 0;
      for (let i = 0; i < N; i++) perturbation += Math.abs(conns[i].midY - conns[i]._defaultMidY);
      const score = crossings * 1e6 + perturbation;
      if (score < bestScore) {
        bestScore = score;
        for (let i = 0; i < N; i++) bestIdx[i] = cur[i];
      }
    }
    for (let i = 0; i < N; i++) conns[i].midY = levelsPer[i][bestIdx[i]];
  }
  optimizeMidYs(topConns);
  optimizeMidYs(botConns);

  // Connector lines + label text.
  const parts = [];
  const allConns = [...topConns, ...botConns];
  for (const c of allConns) {
    const grp = c.grp;
    const cx = grp.center, lx = grp.labelX;
    const midY = c.midY;
    if (grp.pos === 'top') {
      const ly = c.ly;
      parts.push(`<polyline points="${lx.toFixed(2)},${ly} ${lx.toFixed(2)},${midY.toFixed(2)} ${cx.toFixed(2)},${midY.toFixed(2)} ${cx.toFixed(2)},${BAR_Y0}" class="route-infra-line"/>`);
      parts.push(`<text x="${lx.toFixed(2)}" y="${TOP_BASELINE}" class="route-infra-label" text-anchor="middle">${escHtml(grp.label)}</text>`);
    } else {
      const ly = c.ly;
      if (c.useBracket) {
        // T-bracket spans the BBL+BL+SHW range at `midY`; the stem
        // drops to a halfway point and then to the label x.
        const bracketY = midY;
        const stemMidY = (bracketY + ly) / 2;
        parts.push(`<polyline points="${grp.x0.toFixed(2)},${bracketY.toFixed(2)} ${grp.x1.toFixed(2)},${bracketY.toFixed(2)}" class="route-infra-line"/>`);
        parts.push(`<polyline points="${cx.toFixed(2)},${bracketY.toFixed(2)} ${cx.toFixed(2)},${stemMidY.toFixed(2)} ${lx.toFixed(2)},${stemMidY.toFixed(2)} ${lx.toFixed(2)},${ly}" class="route-infra-line"/>`);
      } else {
        parts.push(`<polyline points="${cx.toFixed(2)},${BAR_Y1} ${cx.toFixed(2)},${midY.toFixed(2)} ${lx.toFixed(2)},${midY.toFixed(2)} ${lx.toFixed(2)},${ly}" class="route-infra-line"/>`);
      }
      parts.push(`<text x="${lx.toFixed(2)}" y="${BOT_BASELINE}" class="route-infra-label" text-anchor="middle">${escHtml(grp.label)}</text>`);
    }
  }

  // Explicit width/height attrs (in pixels) — the SVG renders 1:1 with
  // the viewBox, so font-size and bar height stay constant. CSS sets
  // `width: 100%` to 0, so the inline attribute wins. See style.css.
  return `<svg class="route-infra-bar" `
       + `width="${VB_W}" height="${VB_H}" `
       + `viewBox="0 0 ${VB_W} ${VB_H}" `
       + `xmlns="http://www.w3.org/2000/svg" `
       + `role="img" aria-label="Infrastructure breakdown">`
       + `<g class="route-infra-segs">${segRects}</g>`
       + parts.join('')
       + `</svg>`;
}

function elevationBlockHtml(state, route, vbWidth = 320) {
  if (!state.graph?.hasElevation) return '';
  const series = buildElevationSeries(state.graph, route.result);
  if (!series || series.elevations.length < 2) return '';
  const stats = climbStats(series);
  // vbWidth is the chart's actual pixel width AND its viewBox width
  // (1:1) so font-size and chart height stay constant regardless of
  // container width.
  const svg = elevationProfileSvg(series, { width: vbWidth });
  if (!svg.area) return '';
  // Stash on state so hover handlers can find it.
  state.hoverSeries = series;
  state.hoverChartGeom = {
    width: svg.width, height: svg.height, pad: svg.pad,
    minElev: svg.minElevFt, maxElev: svg.maxElevFt, totalDist: svg.totalDistFt,
  };
  // SVG chart: filled brown area under a darker outline. Min/max elevation
  // labels on the y-axis; total distance is on the directions summary so
  // the x-axis is implicit. Steepest-grade + total-uphill stats sit
  // alongside the chart.
  // The cursor (vertical line + circle) starts hidden and is moved by
  // the hover handler in attachElevHover() — both chart-mouse and
  // map-mouse trigger it.
  const pad = svg.pad;
  const baseline = svg.height - pad.b;
  return `
    <div class="route-elev">
      <svg class="route-elev-chart"
           width="${svg.width}" height="${svg.height}"
           viewBox="0 0 ${svg.width} ${svg.height}"
           xmlns="http://www.w3.org/2000/svg" aria-label="Elevation profile">
        <path d="${svg.area}" class="route-elev-fill" />
        <path d="${svg.line}" class="route-elev-line" />
        <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${baseline}"
              class="route-elev-axis" />
        <line x1="${pad.l}" y1="${baseline}" x2="${svg.width - pad.r}" y2="${baseline}"
              class="route-elev-axis" />
        <text x="${pad.l - 4}" y="${pad.t + 8}" class="route-elev-tick" text-anchor="end">${svg.maxElevFt} ft</text>
        <text x="${pad.l - 4}" y="${baseline}" class="route-elev-tick" text-anchor="end">${svg.minElevFt} ft</text>
        <line class="route-elev-cursor-line" x1="0" y1="${pad.t}" x2="0" y2="${baseline}"
              hidden />
        <circle class="route-elev-cursor-dot" cx="0" cy="0" r="3.5" hidden />
        <text class="route-elev-cursor-label" x="0" y="0"
              text-anchor="middle" hidden>
          <tspan class="route-elev-cursor-elev" x="0" dy="0"></tspan>
          <tspan class="route-elev-cursor-mi"   x="0" dy="10"></tspan>
          <tspan class="route-elev-cursor-pct"  x="0" dy="10"></tspan>
        </text>
      </svg>
      <div class="route-elev-stats">
        <div><b>${stats.totalUphillFt}</b> ft total climb</div>
        <div><b>${(stats.steepestUphillPct * 100).toFixed(1)}%</b> steepest uphill</div>
      </div>
    </div>`;
}

// ---------- destination bike-parking block ----------
//
// Renders a small "P" badge + summary right above the turn-by-turn step
// list. The badge color is a traffic-light tier based on the closest
// public bike rack (from the bicycle_racks SDOT layer) to the route's
// final coordinate:
//   green  — at least one rack within RACK_GREEN_FT
//   yellow — closest rack within RACK_YELLOW_FT (gives bearing + dist)
//   red    — no rack within RACK_YELLOW_FT
//
// Uses haversine distance on raw lon/lat. The bike-rack source is loaded
// once into state at app boot (same Promise.all as the graph + signs).

const FT_PER_METER_RACK = 3.28084;
const EARTH_RADIUS_M = 6371000;

function haversineFtRack(lon1, lat1, lon2, lat2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad)
            * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a)) * FT_PER_METER_RACK;
}

// Bearing FROM (lon1,lat1) TO (lon2,lat2), degrees clockwise from north.
function bearingDegRack(lon1, lat1, lon2, lat2) {
  const toRad = Math.PI / 180;
  const φ1 = lat1 * toRad, φ2 = lat2 * toRad;
  const Δλ = (lon2 - lon1) * toRad;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2)
          - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  let θ = Math.atan2(y, x) * 180 / Math.PI;
  return (θ + 360) % 360;
}

function compass8(bearingDeg) {
  // 8-sector compass, 45° wide each, centered on the cardinal.
  const dirs = ['north', 'northeast', 'east', 'southeast',
                'south', 'southwest', 'west', 'northwest'];
  const idx = Math.floor(((bearingDeg + 22.5) % 360) / 45);
  return dirs[idx];
}

function bikeRackInfoForDestination(state, destLon, destLat) {
  const feats = state.bikeRacks?.features;
  if (!feats || !feats.length) return null;
  // Quick lat/lon bbox prefilter — 1000 ft ~ 305 m. At Seattle's
  // latitude 1° lat ≈ 364,000 ft, 1° lon ≈ 247,000 ft. Use a generous
  // 1° / 200 ≈ 1,800 ft window (well past RACK_YELLOW_FT) so we never
  // miss the nearest rack to a haversine roundoff edge case.
  const latRange = RACK_YELLOW_FT / 364000;
  const lonRange = RACK_YELLOW_FT / 247000;
  let closestFt = Infinity;
  let closestLon = 0, closestLat = 0;
  let withinGreen = 0;
  for (const f of feats) {
    const g = f.geometry;
    if (!g || g.type !== 'Point') continue;
    const [lon, lat] = g.coordinates;
    if (Math.abs(lat - destLat) > latRange) continue;
    if (Math.abs(lon - destLon) > lonRange) continue;
    const d = haversineFtRack(destLon, destLat, lon, lat);
    if (d <= RACK_GREEN_FT) withinGreen++;
    if (d < closestFt) { closestFt = d; closestLon = lon; closestLat = lat; }
  }
  if (withinGreen > 0) return { tier: 'green', count: withinGreen };
  if (closestFt <= RACK_YELLOW_FT) {
    return {
      tier: 'yellow',
      distanceFt: Math.round(closestFt),
      direction: compass8(bearingDegRack(destLon, destLat, closestLon, closestLat)),
    };
  }
  return { tier: 'red' };
}

function bikeRackBlockHtml(info) {
  if (!info) return '';
  let msg = '';
  if (info.tier === 'green') {
    const noun = info.count === 1 ? 'public bike rack' : 'public bike racks';
    msg = `There ${info.count === 1 ? 'is' : 'are'} ${info.count} ${noun} within ${RACK_GREEN_FT} ft of the destination.`;
  } else if (info.tier === 'yellow') {
    msg = `The closest public bike rack is ${info.distanceFt} ft to the ${info.direction} of the destination.`;
  } else {
    msg = `No public bike racks available within ${RACK_YELLOW_FT} ft of destination.`;
  }
  return `
    <div class="route-rack route-rack-${info.tier}">
      <div class="route-rack-badge" aria-hidden="true">P</div>
      <div class="route-rack-msg">${escHtml(msg)}</div>
    </div>`;
}

function renderDirections(state, info) {
  // Tab strip — only when >1 route is showing. Active tab = currently
  // primary route. Clicking a tab swaps which route is primary (same as
  // clicking the route on the map).
  let tabsHtml = '';
  if (state.routes.length > 1) {
    tabsHtml = `<ul class="route-tabs">${state.routes.map((r, i) => {
      const mi  = r.result.totalLengthFt / 5280;
      const min = predictedMinutes(state, r);
      return `
      <li class="route-tab ${i === state.activeIndex ? 'active' : ''}" data-route-id="${escHtml(r.id)}">
        <div class="route-tab-name">${escHtml(r.label)}</div>
        <div class="route-tab-mi">${min} min · ${mi.toFixed(2)} mi</div>
      </li>`;
    }).join('')}</ul>`;
  }
  const miles = info.totalLengthFt / 5280;
  // Infrastructure bar for the ACTIVE route, always shown under the
  // min/mi line in the summary block. (Lives outside the tab strip so it
  // doesn't bloat every tab and stays tied to the route that's actually
  // rendered as primary.)
  const activeRoute = state.routes[state.activeIndex];
  const mins = predictedMinutes(state, activeRoute);
  // Both summary SVGs render at the directions panel's actual inner
  // width, with viewBox-W = pixel-W (1:1), so their font-size and
  // height stay constant across phone/desktop. See infraSummaryBarSvg
  // and elevationBlockHtml. Cached on state so the resize handler can
  // re-render if the panel width changes meaningfully.
  const svgWidth = directionsPanelInnerWidth(state);
  state.lastDirectionsWidth = svgWidth;
  const summaryPct = activeRoute
    ? infraSummaryBarSvg(infraBreakdown(state.graph,
        activeRoute.result.pathEdgeIds), svgWidth)
    : '';
  const elevHtml = activeRoute ? elevationBlockHtml(state, activeRoute, svgWidth) : '';
  const summary = `
    <div class="route-summary">
      <b>${mins} min</b> · ${miles.toFixed(2)} mi
      ${summaryPct}
    </div>
    ${elevHtml}`;

  // Destination bike-parking block — green/yellow/red P badge + message
  // based on the closest public bike rack to the route end.
  let rackHtml = '';
  if (activeRoute && activeRoute.fullGeom?.length) {
    const end = activeRoute.fullGeom[activeRoute.fullGeom.length - 1];
    rackHtml = bikeRackBlockHtml(bikeRackInfoForDestination(state, end[0], end[1]));
  }

  const stepsHtml = info.steps.map((s) => {
    const dist = s.distanceFt > 0 ? formatDistance(s.distanceFt) : '';
    const annots = s.annotations.length
      ? `<div class="route-step-annotation">${s.annotations.map(escHtml).join('<br>')}</div>`
      : '';
    return `
      <li class="route-step">
        <div class="route-step-instruction">${escHtml(s.instruction)}</div>
        ${dist ? `<div class="route-step-distance">${dist}</div>` : ''}
        ${annots}
      </li>`;
  }).join('');

  setPanel(state, tabsHtml + summary + rackHtml + `<ol class="route-steps">${stepsHtml}</ol>`);

  // Wire tab clicks to activate.
  if (tabsHtml) {
    state.panel.querySelectorAll('.route-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const id = tab.dataset.routeId;
        if (id) setActiveRoute(state, id);
      });
    });
  }
  // Wire the chart-hover handler each render (the SVG is re-built every
  // time the panel rerenders). The map-hover handler is bound once at
  // boot and reads state.hoverSeries — refreshed by elevationBlockHtml.
  attachChartHoverHandlers(state);
}

function setPanel(state, html) {
  if (!state.panel) return;
  state.panel.hidden = false;
  state.panel.innerHTML = html;
}

// Pixel width to render the summary SVGs at. Used as both the SVG's
// `width` attribute and its viewBox width, so 1 viewBox unit = 1
// screen pixel — font-size and bar/chart heights stay constant across
// desktop and phone widths.
//
// Prefer the panel's measured clientWidth; fall back to the panel
// container width before first paint. The values are clamped so a
// transient 0 (e.g. while #directions-panel is still hidden=true)
// doesn't render a zero-width SVG.
function directionsPanelInnerWidth(state) {
  if (state.panel) {
    // Force layout-known geometry: ensure panel is visible before
    // measuring. (`renderDirections` flips `hidden = false` via setPanel
    // AFTER computing this width, so we have to peek manually here.)
    const wasHidden = state.panel.hidden;
    if (wasHidden) state.panel.hidden = false;
    const measured = state.panel.clientWidth;
    if (wasHidden) state.panel.hidden = true;
    if (measured >= 200) return measured;
  }
  // Fallback when we can't measure (e.g. boot): use the known #left-stack
  // width on desktop, viewport minus sheet padding on mobile.
  if (window.matchMedia('(max-width: 719px)').matches) {
    return Math.max(280, window.innerWidth - 20);
  }
  return 360;
}

// Re-render the active route's panel when the viewport resizes if the
// directions-panel width changed meaningfully. Without this, the SVGs
// would keep their initial-render width (fine on desktop, but rotating
// a phone or dragging the window would leave them mis-sized).
function attachDirectionsResizeHandler(state) {
  let pending = 0;
  window.addEventListener('resize', () => {
    if (pending) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      pending = 0;
      if (!state.routes.length) return;
      const w = directionsPanelInnerWidth(state);
      // Skip re-render unless the width drifted enough to matter (>= 4 px).
      // This keeps mobile-keyboard-show events and other tiny resizes
      // from thrashing the panel.
      if (Math.abs((state.lastDirectionsWidth ?? 0) - w) < 4) return;
      renderPrimary(state);
    });
  });
}

function resetRoute(state) {
  if (state.startMarker) { state.startMarker.remove(); state.startMarker = null; }
  if (state.endMarker)   { state.endMarker.remove();   state.endMarker = null; }
  for (const m of state.stepMarkers) m.remove();
  for (const m of state.altMarkers)  m.remove();
  state.stepMarkers = []; state.altMarkers = [];
  state.routes = [];
  state.hoverSeries = null;
  hideHoverCursor(state);
  state.startSpec = null; state.endSpec = null;
  state.startLabel = ''; state.endLabel = '';
  if (state.map.getSource(ROUTE_SOURCE)) {
    state.map.getSource(ROUTE_SOURCE).setData({ type: 'FeatureCollection', features: [] });
  }
  if (state.map.getSource(ALT_SOURCE)) {
    state.map.getSource(ALT_SOURCE).setData({ type: 'FeatureCollection', features: [] });
  }
  if (state.panel) state.panel.hidden = true;
}

// Clear just one endpoint (Start or End). Drops the route + step markers
// since the remaining single pin can't form a route on its own.
function clearEndpoint(state, which) {
  if (which === 'start') {
    if (state.startMarker) { state.startMarker.remove(); state.startMarker = null; }
    state.startSpec = null; state.startLabel = '';
    setInputValue('route-start-input', '');
  } else {
    if (state.endMarker) { state.endMarker.remove(); state.endMarker = null; }
    state.endSpec = null; state.endLabel = '';
    setInputValue('route-end-input', '');
  }
  for (const m of state.stepMarkers) m.remove();
  for (const m of state.altMarkers)  m.remove();
  state.stepMarkers = []; state.altMarkers = [];
  state.routes = [];
  if (state.map.getSource(ROUTE_SOURCE)) {
    state.map.getSource(ROUTE_SOURCE).setData({ type: 'FeatureCollection', features: [] });
  }
  if (state.map.getSource(ALT_SOURCE)) {
    state.map.getSource(ALT_SOURCE).setData({ type: 'FeatureCollection', features: [] });
  }
  if (state.panel) state.panel.hidden = true;
}

// Swap Start and End endpoints. Marker color must match its new role, so
// we recreate the markers (MapLibre Marker has no setColor).
function swapEndpoints(state) {
  if (!state.startSpec && !state.endSpec) return;
  const sSpec = state.startSpec, sLabel = state.startLabel;
  const eSpec = state.endSpec,   eLabel = state.endLabel;
  const sLngLat = state.startMarker?.getLngLat();
  const eLngLat = state.endMarker?.getLngLat();
  state.startMarker?.remove(); state.startMarker = null;
  state.endMarker?.remove();   state.endMarker = null;

  // Old end → new start.
  state.startSpec = eSpec; state.startLabel = eLabel;
  setInputValue('route-start-input', eLabel || '');
  if (eSpec && eLngLat) {
    state.startMarker = new maplibregl.Marker({ color: '#1faa5a' })
      .setLngLat([eLngLat.lng, eLngLat.lat]).addTo(state.map);
  }

  // Old start → new end.
  state.endSpec = sSpec; state.endLabel = sLabel;
  setInputValue('route-end-input', sLabel || '');
  if (sSpec && sLngLat) {
    state.endMarker = new maplibregl.Marker({ color: '#d93030' })
      .setLngLat([sLngLat.lng, sLngLat.lat]).addTo(state.map);
  }

  if (state.startSpec && state.endSpec) {
    compute(state);
  } else {
    // Only one endpoint left — drop any stale route artifacts.
    for (const m of state.stepMarkers) m.remove();
    for (const m of state.altMarkers)  m.remove();
    state.stepMarkers = []; state.altMarkers = [];
    state.routes = [];
    if (state.map.getSource(ROUTE_SOURCE)) {
      state.map.getSource(ROUTE_SOURCE).setData({ type: 'FeatureCollection', features: [] });
    }
    if (state.map.getSource(ALT_SOURCE)) {
      state.map.getSource(ALT_SOURCE).setData({ type: 'FeatureCollection', features: [] });
    }
    if (state.panel) state.panel.hidden = true;
  }
}

// ---------- user location (blue dot + "My location" picker option) ----------

function startUserLocationTracking(state) {
  if (!('geolocation' in navigator)) return;
  // Run two watchers in parallel: a high-accuracy one (GPS, when
  // available) and a low-accuracy fallback (WiFi/IP). The low-accuracy
  // watcher catches the indoor case where the GPS-only watcher
  // silently fails to ever fire a success. Whichever fires first
  // populates `state.userLocation`; subsequent updates overwrite it,
  // and the GPS one (when working) is more accurate, so it wins as
  // soon as it lands.
  const startWatcher = (opts, label) => {
    try {
      return navigator.geolocation.watchPosition(
        (pos) => updateUserLocation(state, pos),
        (err) => console.warn(`[geolocation] ${label} watch error:`, err.message),
        opts,
      );
    } catch (e) {
      console.warn(`[geolocation] ${label} watchPosition threw:`, e);
      return null;
    }
  };
  state.geoWatchIdHigh = startWatcher(
    { enableHighAccuracy: true,  maximumAge: 5000,  timeout: 20000 },
    'high-accuracy');
  state.geoWatchIdLow  = startWatcher(
    { enableHighAccuracy: false, maximumAge: 30000, timeout: 30000 },
    'low-accuracy');
}

function updateUserLocation(state, pos) {
  const { longitude: lon, latitude: lat, accuracy } = pos.coords;
  state.userLocation = { lon, lat, accuracy };
  if (state.locationError) {
    state.locationError = null;
    state.locationDropdownRefresh?.();
  }
  if (!state.userLocationMarker) {
    const el = document.createElement('div');
    el.className = 'user-location-dot';
    el.title = 'Your current location';
    state.userLocationMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat([lon, lat]).addTo(state.map);
  } else {
    state.userLocationMarker.setLngLat([lon, lat]);
  }
}

// One-shot location request used when the user picks "My location" or
// the popup Go button before the watcher has produced a fix. Resolves to
// the new userLocation or null on failure / denial.
//
// Robustness layers (most failures hit one of these):
//   1. If the background `watchPosition` watcher already has a recent
//      fix on `state.userLocation`, use it immediately — no new
//      browser call needed.
//   2. Try high-accuracy GPS with a short timeout.
//   3. On failure (most often: indoors, no GPS hardware, GPS cold-
//      start), fall back to low-accuracy positioning which uses WiFi
//      / IP-based location. This is what fixes the sporadic "permission
//      is on but location fails" case — the high-accuracy provider
//      times out while the low-accuracy one succeeds.
function requestLocationOnce(state) {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) { resolve(null); return; }
    if (state.userLocation) {
      resolve(state.userLocation);
      return;
    }
    const onSuccess = (pos) => {
      updateUserLocation(state, pos);
      resolve(state.userLocation);
    };
    navigator.geolocation.getCurrentPosition(
      onSuccess,
      (err) => {
        console.warn('[geolocation] high-accuracy failed, falling back to low:', err.message);
        navigator.geolocation.getCurrentPosition(
          onSuccess,
          (err2) => {
            console.warn('[geolocation] low-accuracy also failed:', err2.message);
            resolve(null);
          },
          { enableHighAccuracy: false, maximumAge: 60000, timeout: 10000 },
        );
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 8000 },
    );
  });
}

// Snap state.userLocation to the graph and pin it as the named endpoint.
// Returns true on success; on failure sets state.locationError so the
// endpoint dropdown can surface it as the "My location" subtext.
function applyUserLocationAsEndpoint(state, which) {
  const u = state.userLocation;
  if (!u) {
    state.locationError = 'Couldn’t get your location';
    return false;
  }
  const snap = snapToGraph(state.graph, u.lon, u.lat, 800);
  if (!snap.spec) {
    state.locationError = 'Your location is too far from the bike network.';
    return false;
  }
  state.locationError = null;
  setEndpoint(state, which, snap.spec, snap.projLon, snap.projLat, 'My location');
  return true;
}

// Time estimate (minutes) for a computed route. Routing is unaffected —
// these adjustments are display-only.
//
// Components:
//   - Base riding time at the user's stated speed for non-sidewalk
//     distance, plus a 5 mph cap on any sidewalk distance regardless
//     of the user's speed.
//   - +2 s per ft of total climb, −0.5 s per ft of total descent (no
//     grade-dependent term — just total ascent/descent).
//   - +10 s per traffic signal at an interior node of the path.
//   - +2 s per stop sign at an interior node facing the cyclist's
//     direction of travel (the end-bearing of the incoming edge).
function predictedMinutes(state, route) {
  const sec = predictedSeconds(state, route);
  return Math.max(1, Math.round(sec / 60));
}

function predictedSeconds(state, route) {
  const graph = state.graph;
  const r = route?.result;
  if (!graph || !r) return 0;
  const mph = Math.max(0.1, state.speedMph);

  // Sidewalk vs non-sidewalk distance. Prefix/suffix never land on
  // sidewalks (findNearestEdgeProjection skips them), so subtracting
  // sidewalk-edge length from totalLengthFt leaves all non-sidewalk
  // distance — including the mid-edge prefix/suffix slices.
  let sidewalkFt = 0;
  for (const eid of r.pathEdgeIds) {
    if (graph.edgeIsSidewalk(eid)) sidewalkFt += graph.edgeLengthFt(eid);
  }
  const baseFt = Math.max(0, r.totalLengthFt - sidewalkFt);
  const baseSec     = (baseFt     / 5280) / mph * 3600;
  const sidewalkSec = (sidewalkFt / 5280) / 5   * 3600;

  let climbSec = 0;
  if (graph.hasElevation) {
    const series = buildElevationSeries(graph, r);
    const stats = climbStats(series);
    climbSec = 2 * stats.totalUphillFt - 0.5 * stats.totalDownhillFt;
  }

  let stopSec = 0, signalSec = 0;
  const nodes = r.pathNodeIds, edges = r.pathEdgeIds;
  for (let i = 1; i < nodes.length - 1; i++) {
    const nid = nodes[i];
    if (graph.nodeFlags(nid).hasSignal) signalSec += 10;
    const bearing = graph.edgeBearingEnd(edges[i - 1]);
    if (graph.hasStopFacing(nid, bearing)) stopSec += 2;
  }

  return baseSec + sidewalkSec + climbSec + signalSec + stopSec;
}

// ---------- address inputs + dropdowns ----------

function wireAddressInputs(state) {
  setupSearchInput(state, 'route-start-input', 'route-start-suggestions', {
    role: 'endpoint', which: 'start',
  });
  setupSearchInput(state, 'route-end-input', 'route-end-suggestions', {
    role: 'endpoint', which: 'end',
  });
  setupSearchInput(state, 'settings-home-input', 'settings-home-suggestions', {
    role: 'saved-location', which: 'home',
  });
  setupSearchInput(state, 'settings-work-input', 'settings-work-suggestions', {
    role: 'saved-location', which: 'work',
  });
  refreshSavedLocationInputs(state);
}

function refreshSavedLocationInputs(state) {
  setInputValue('settings-home-input', state.home?.label || '');
  setInputValue('settings-work-input', state.work?.label || '');
}

function setupSearchInput(state, inputId, dropId, opts) {
  const input = document.getElementById(inputId);
  const drop  = document.getElementById(dropId);
  if (!input || !drop) return;
  let activeIdx = -1;
  let currentRows = [];
  let debounceTimer = null;

  const closeDrop = () => {
    drop.innerHTML = '';
    drop.hidden = true;
    activeIdx = -1;
    currentRows = [];
  };

  const renderRows = (rows) => {
    if (!rows.length) { closeDrop(); return; }
    drop.innerHTML = rows.map((row, i) => renderRow(row, i, activeIdx)).join('');
    drop.hidden = false;
    drop.querySelectorAll('.addr-sugg').forEach((li) => {
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const i = Number(li.dataset.i);
        pickRow(currentRows[i]);
      });
    });
  };

  const optionRows = () => {
    if (opts.role !== 'endpoint') return [];
    return [
      { type: 'mylocation', icon: 'near_me', name: 'My location',
        loc: state.userLocation,
        pending: state.locationPending,
        error: state.locationError },
      { type: 'saved',  which: 'home', loc: state.home, icon: 'home', name: 'Home' },
      { type: 'saved',  which: 'work', loc: state.work, icon: 'work', name: 'Work' },
      { type: 'choose', icon: 'my_location', name: 'Choose on map',
        subtext: 'Click a spot to set this point' },
    ];
  };

  // Re-render the dropdown with the latest option rows (used when the
  // pending state of a "My location" pick resolves). No-op when the
  // dropdown isn't showing options (the user has typed a query and is
  // now looking at address hits — don't yank the rug).
  const refreshOptionRows = () => {
    if (drop.hidden) return;
    if (!currentRows.length || currentRows[0].type !== 'mylocation') return;
    currentRows = optionRows();
    renderRows(currentRows);
  };

  const pickRow = (row) => {
    if (!row) return;
    if (row.type === 'mylocation') {
      if (state.userLocation) {
        closeDrop();
        input.blur();
        applyUserLocationAsEndpoint(state, opts.which);
        return;
      }
      // No fix yet — keep the dropdown open and show "Locating…" inline.
      state.locationPending = true;
      state.locationError = null;
      currentRows = optionRows();
      renderRows(currentRows);
      requestLocationOnce(state).then(() => {
        state.locationPending = false;
        if (!state.userLocation) {
          state.locationError = 'Couldn’t get your location';
          // Refresh whichever endpoint dropdown is currently focused
          // (the user may have already moved to the other input).
          state.locationDropdownRefresh?.();
          return;
        }
        // Success — if the user is still here, apply; otherwise just
        // leave the new fix available for next time.
        if (drop.hidden || !currentRows[0] || currentRows[0].type !== 'mylocation') {
          state.locationError = null;
          return;
        }
        closeDrop();
        input.blur();
        applyUserLocationAsEndpoint(state, opts.which);
      });
      return;
    }
    if (row.type === 'saved') {
      if (!row.loc) {
        closeDrop();
        input.blur();
        openSettings();
        const targetId = row.which === 'home' ? 'settings-home-input' : 'settings-work-input';
        setTimeout(() => document.getElementById(targetId)?.focus(), 50);
        return;
      }
      const { lon, lat } = row.loc;
      pickFromCoords(row.loc.label, lon, lat);
      return;
    }
    if (row.type === 'choose') {
      closeDrop();
      input.blur();
      beginChooseOnMap(state, opts.which);
      return;
    }
    if (!state.graph) return;
    const sl = row.snapLon ?? row.lon, sa = row.snapLat ?? row.lat;
    pickFromCoords(row.label, sl, sa);
  };

  const pickFromCoords = (label, lon, lat) => {
    const { spec, projLon, projLat } = snapToGraph(state.graph, lon, lat, 800);
    if (!spec) return;
    if (opts.role === 'endpoint') {
      setEndpoint(state, opts.which, spec, projLon, projLat, label);
    } else if (opts.role === 'saved-location') {
      const loc = { label, lon: projLon, lat: projLat };
      if (opts.which === 'home') {
        state.home = loc; saveLocToStorage(LS_HOME, loc);
      } else {
        state.work = loc; saveLocToStorage(LS_WORK, loc);
      }
      refreshSavedLocationInputs(state);
    }
    closeDrop();
    input.blur();
  };

  const triggerSearch = async (q) => {
    if (q.length < 2) {
      currentRows = optionRows();
      activeIdx = -1;
      renderRows(currentRows);
      return;
    }
    const center = state.map.getCenter();
    const hits = await searchAddresses(q, {
      limit: 50, mapCenter: [center.lng, center.lat],
    });
    currentRows = hits.map((h) => ({ ...h, type: 'hit' }));
    activeIdx = -1;
    renderRows(currentRows);
  };

  input.addEventListener('focus', () => {
    // On mobile: expand the bottom sheet so the suggestion dropdown has
    // room to render inside the sheet's scrollable area. Only meaningful
    // for the routing-endpoint inputs; the settings inputs are inside
    // their own modal.
    if (opts.role === 'endpoint') snapSheet('full');
    // Let async location callbacks re-render this dropdown while open.
    if (opts.role === 'endpoint') state.locationDropdownRefresh = refreshOptionRows;
    const q = input.value.trim();
    if (q.length < 2) {
      currentRows = optionRows();
      activeIdx = -1;
      renderRows(currentRows);
    }
  });
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    debounceTimer = setTimeout(() => triggerSearch(q), 100);
  });
  input.addEventListener('keydown', (e) => {
    if (drop.hidden) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(currentRows.length - 1, activeIdx + 1);
      renderRows(currentRows);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(0, activeIdx - 1);
      renderRows(currentRows);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0) pickRow(currentRows[activeIdx]);
      else if (currentRows[0]) pickRow(currentRows[0]);
    } else if (e.key === 'Escape') {
      closeDrop();
      input.blur();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => {
    if (opts.role === 'endpoint' && state.locationDropdownRefresh === refreshOptionRows) {
      state.locationDropdownRefresh = null;
    }
    closeDrop();
  }, 150));
}

function renderRow(row, i, activeIdx) {
  const active = i === activeIdx ? ' active' : '';
  if (row.type === 'mylocation') {
    let sub;
    if (row.pending) sub = 'Locating…';
    else if (row.error) sub = row.error;
    else if (row.loc) sub = 'Use my current location';
    else sub = 'Tap to use your current location';
    return `<li class="addr-sugg option-row${active}" data-i="${i}">
      <span class="addr-sugg-text"><span class="material-symbols-outlined">${row.icon}</span>${escHtml(row.name)}</span>
      <span class="addr-sugg-sub">${escHtml(sub)}</span>
    </li>`;
  }
  if (row.type === 'saved') {
    const cls = 'option-row' + (row.loc ? '' : ' disabled');
    const sub = row.loc ? row.loc.label : 'Not set — click to set in Settings';
    return `<li class="addr-sugg ${cls}${active}" data-i="${i}">
      <span class="addr-sugg-text"><span class="material-symbols-outlined">${row.icon}</span>${escHtml(row.name)}</span>
      <span class="addr-sugg-sub">${escHtml(sub)}</span>
    </li>`;
  }
  if (row.type === 'choose') {
    return `<li class="addr-sugg option-row${active}" data-i="${i}">
      <span class="addr-sugg-text"><span class="material-symbols-outlined">${row.icon}</span>${escHtml(row.name)}</span>
      <span class="addr-sugg-sub">${escHtml(row.subtext)}</span>
    </li>`;
  }
  // hit
  const subBits = [];
  if (row.kind === 'poi' && row.address) subBits.push(row.address);
  if (row.category) subBits.push(prettyCategory(row.category));
  const subHtml = subBits.length
    ? `<span class="addr-sugg-sub">${subBits.map(escHtml).join(' · ')}</span>`
    : '';
  return `<li class="addr-sugg${active}" data-i="${i}">
    <span class="addr-sugg-text">${escHtml(row.label)}</span>
    ${subHtml}
  </li>`;
}

function setInputValue(id, value) {
  const el = document.getElementById(id);
  if (el && el.value !== value) el.value = value;
}

function formatLatLngLabel(lon, lat) {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

function prettyCategory(c) {
  if (!c) return '';
  const eq = c.indexOf('=');
  return eq >= 0 ? c.slice(eq + 1).replaceAll('_', ' ') : c;
}

// ---------- choose-on-map mode ----------

function beginChooseOnMap(state, which) {
  setMode({ which });
  document.body.classList.add('choosing-on-map');
  showChooseBanner(which);
  // On mobile, collapse the sheet so the user can actually see the map
  // they need to tap.
  snapSheet('peek');
}

function finishChooseOnMap(state, which, spec, lon, lat, label) {
  cancelChooseOnMap();
  setEndpoint(state, which, spec, lon, lat, label);
}

function cancelChooseOnMap() {
  if (!isChoosingOnMap()) return;
  clearMode();
  document.body.classList.remove('choosing-on-map');
  hideChooseBanner();
}

function showChooseBanner(which) {
  const el = document.getElementById('choose-on-map-banner');
  if (!el) return;
  const msg = el.querySelector('.cob-msg');
  if (msg) msg.textContent = which === 'start'
    ? 'Tap the map to set start'
    : 'Tap the map to set end';
  el.hidden = false;
}

function hideChooseBanner() {
  const el = document.getElementById('choose-on-map-banner');
  if (el) el.hidden = true;
}

function wireGlobalChooseInteractions(state) {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancelChooseOnMap();
  });
  document.getElementById('cob-cancel')?.addEventListener('click', () => {
    cancelChooseOnMap();
  });
}

// ---------- settings modal ----------

function openSettings() {
  const dlg = document.getElementById('settings-modal');
  if (!dlg) return;
  if (typeof dlg.showModal === 'function') {
    if (!dlg.open) dlg.showModal();
  } else {
    dlg.setAttribute('open', '');
  }
}
function closeSettings() {
  const dlg = document.getElementById('settings-modal');
  if (!dlg) return;
  if (typeof dlg.close === 'function') dlg.close();
  else dlg.removeAttribute('open');
}

function wireSettingsModal(state) {
  document.getElementById('open-settings')?.addEventListener('click', openSettings);
  document.getElementById('settings-close')?.addEventListener('click', closeSettings);

  const dlg = document.getElementById('settings-modal');
  dlg?.addEventListener('click', (e) => {
    if (e.target === dlg) closeSettings();
  });

  document.getElementById('clear-home')?.addEventListener('click', () => {
    state.home = null; saveLocToStorage(LS_HOME, null);
    setInputValue('settings-home-input', '');
  });
  document.getElementById('clear-work')?.addEventListener('click', () => {
    state.work = null; saveLocToStorage(LS_WORK, null);
    setInputValue('settings-work-input', '');
  });

  // Routing debug: gates the "Routing debug" fieldset in #layers-panel
  // and force-clears all 5 toggles when disabled.
  const debugToggle = document.getElementById('settings-debug-enabled');
  if (debugToggle) {
    debugToggle.checked = state.debugEnabled;
    debugToggle.addEventListener('change', () => {
      state.debugEnabled = debugToggle.checked;
      saveDebugEnabledToStorage(state.debugEnabled);
      applyDebugEnabledUI(state, { forceClearOnDisable: true });
    });
  }

  // Custom route style: hidden in the segmented control unless the user
  // opts in here. Disabling while Custom is the active preset falls back
  // to Comfort so the visible buttons always reflect the active mode.
  const customToggle = document.getElementById('settings-custom-enabled');
  if (customToggle) {
    customToggle.checked = state.customEnabled;
    applyCustomEnabledUI(state);
    customToggle.addEventListener('change', () => {
      state.customEnabled = customToggle.checked;
      saveCustomEnabledToStorage(state.customEnabled);
      if (!state.customEnabled && state.preset === 'custom') {
        state.preset = 'comfort';
        savePresetToStorage(state.preset);
        setPresetUI(state);
        if (state.startSpec && state.endSpec) compute(state);
      }
      applyCustomEnabledUI(state);
    });
  }

  // Average cycling speed.
  const speedInput = document.getElementById('settings-speed-input');
  const speedVal   = document.getElementById('settings-speed-val');
  if (speedInput && speedVal) {
    speedInput.value = String(state.speedMph);
    speedVal.textContent = `${state.speedMph} mph`;
    speedInput.addEventListener('input', () => {
      state.speedMph = Number(speedInput.value);
      speedVal.textContent = `${state.speedMph} mph`;
    });
    speedInput.addEventListener('change', () => {
      saveSpeedToStorage(state.speedMph);
      // If a route is showing, re-render the summary with the new ETA.
      if (state.routes.length > 0) renderPrimary(state);
    });
  }
}

function applyCustomEnabledUI(state) {
  const seg = document.getElementById('preset-segmented');
  if (seg) seg.classList.toggle('custom-enabled', state.customEnabled);
  // Sliders stay visible even when Custom is off so the user can see what
  // they'll get if they enable it — but they're grayed out and inert.
  const sliders = document.getElementById('custom-sliders');
  if (sliders) {
    sliders.hidden = false;
    sliders.classList.toggle('disabled', !state.customEnabled);
    sliders.querySelectorAll('input[type="range"]').forEach((el) => {
      el.disabled = !state.customEnabled;
    });
  }
}

// Show/hide the routing-debug fieldset; when disabled, also uncheck all
// 5 debug toggles (dispatching `change` so the VisibilityManager removes
// each layer from view). Called both at boot and from the Settings
// toggle's change handler.
function applyDebugEnabledUI(state, { forceClearOnDisable = false } = {}) {
  const fs = document.getElementById('layers-debug-section');
  if (fs) fs.hidden = !state.debugEnabled;
  if (!state.debugEnabled && forceClearOnDisable) {
    for (const id of DEBUG_TOGGLE_IDS) {
      const cb = document.getElementById(id);
      if (cb && cb.checked) {
        cb.checked = false;
        cb.dispatchEvent(new Event('change'));
      }
    }
  }
}

// ---------- preset / sliders UI ----------

function wirePresetUI(state) {
  document.querySelectorAll('input[name="route-preset"]').forEach((el) => {
    el.addEventListener('change', () => {
      if (!el.checked) return;
      state.preset = el.value;
      savePresetToStorage(state.preset);
      setPresetUI(state);
      if (state.startSpec && state.endSpec) compute(state);
    });
  });
  const panel = document.getElementById('custom-sliders');
  if (panel) {
    panel.innerHTML = SLIDERS.map((s) => `
      <label class="slider-row" for="slider-${s.key}" title="${escHtml(s.hint)}">
        <span class="slider-label">${escHtml(s.label)}</span>
        <input type="range" id="slider-${s.key}" min="0" max="1" step="0.1"
               value="${state.customSliders[s.key]}" />
        <span class="slider-val" id="slider-val-${s.key}">${formatSliderVal(state.customSliders[s.key])}</span>
      </label>`).join('');
    SLIDERS.forEach((s) => {
      const input = document.getElementById(`slider-${s.key}`);
      const out   = document.getElementById(`slider-val-${s.key}`);
      input.addEventListener('input', () => {
        state.customSliders[s.key] = Number(input.value);
        out.innerHTML = formatSliderVal(state.customSliders[s.key]);
      });
      input.addEventListener('change', () => {
        saveCustomToStorage(state.customSliders);
        if (state.preset === 'custom' && state.startSpec && state.endSpec) {
          compute(state);
        }
      });
    });
    // Sliders are built after wireSettingsModal ran, so the disabled/
    // grayed state set there only landed on the container. Re-apply now
    // that the inputs exist.
    applyCustomEnabledUI(state);
  }
}

function setPresetUI(state) {
  document.querySelectorAll('input[name="route-preset"]').forEach((el) => {
    el.checked = (el.value === state.preset);
  });
}

// "Enable sidewalks" checkbox under the Comfort/Athletic segmented
// control. Flipping it re-runs A* against the same endpoints with the
// new `enableSidewalks` flag in the weights — long sidewalks (> 50 ft)
// are gated by this; short ones (≤ 50 ft) stay routable either way.
function wireSidewalksToggle(state) {
  const cb = document.getElementById('toggle-sidewalks');
  if (!cb) return;
  cb.checked = state.sidewalksEnabled;
  cb.addEventListener('change', () => {
    state.sidewalksEnabled = cb.checked;
    saveSidewalksEnabledToStorage(state.sidewalksEnabled);
    if (state.startSpec && state.endSpec) compute(state);
  });
}

function formatSliderVal(v) {
  const n = Math.round(Number(v) * 10);
  return `${n}<span class="slider-val-denom">/10</span>`;
}

// ---------- localStorage ----------

function loadPresetFromStorage() {
  try {
    const v = localStorage.getItem(LS_PRESET);
    if (v === 'athletic' || v === 'comfort' || v === 'custom') return v;
  } catch {}
  return 'comfort';
}
function savePresetToStorage(p) {
  try { localStorage.setItem(LS_PRESET, p); } catch {}
}
// Custom sliders open at a neutral midpoint (all 0.5) rather than
// inheriting Athletic's values — gives the user a blank canvas to tune
// from rather than starting them on one of the named presets.
const CUSTOM_DEFAULTS = { s1: 0.5, s2: 0.5, s3: 0.5, s4: 0.5, s5: 0.5 };
function loadCustomFromStorage() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_CUSTOM) || 'null');
    if (v && typeof v === 'object') return { ...CUSTOM_DEFAULTS, ...v };
  } catch {}
  return { ...CUSTOM_DEFAULTS };
}
function saveCustomToStorage(custom) {
  try { localStorage.setItem(LS_CUSTOM, JSON.stringify(custom)); } catch {}
}
function loadCustomEnabledFromStorage() {
  try {
    const v = localStorage.getItem(LS_CUSTOM_ENABLED);
    if (v === 'true') return true;
  } catch {}
  return false;
}
function saveCustomEnabledToStorage(enabled) {
  try { localStorage.setItem(LS_CUSTOM_ENABLED, enabled ? 'true' : 'false'); } catch {}
}
function loadDebugEnabledFromStorage() {
  try {
    const v = localStorage.getItem(LS_DEBUG_ENABLED);
    if (v === 'true') return true;
  } catch {}
  return false;
}
function saveDebugEnabledToStorage(enabled) {
  try { localStorage.setItem(LS_DEBUG_ENABLED, enabled ? 'true' : 'false'); } catch {}
}
function loadSidewalksEnabledFromStorage() {
  // Default ON for fresh users; respect an explicit prior off-toggle.
  try {
    const v = localStorage.getItem(LS_SIDEWALKS_ENABLED);
    if (v === 'false') return false;
  } catch {}
  return true;
}
function saveSidewalksEnabledToStorage(enabled) {
  try { localStorage.setItem(LS_SIDEWALKS_ENABLED, enabled ? 'true' : 'false'); } catch {}
}
function loadLocFromStorage(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    if (v && typeof v === 'object' && typeof v.lon === 'number'
        && typeof v.lat === 'number' && typeof v.label === 'string') return v;
  } catch {}
  return null;
}
function saveLocToStorage(key, loc) {
  try {
    if (loc) localStorage.setItem(key, JSON.stringify(loc));
    else     localStorage.removeItem(key);
  } catch {}
}
function loadSpeedFromStorage() {
  try {
    const v = Number(localStorage.getItem(LS_SPEED));
    if (Number.isFinite(v) && v >= 5 && v <= 20) return v;
  } catch {}
  return DEFAULT_SPEED_MPH;
}
function saveSpeedToStorage(mph) {
  try { localStorage.setItem(LS_SPEED, String(mph)); } catch {}
}

// ---------- graph debug layers (toggleable visualizations) ----------
//
// Renders the routing graph as it actually sits in memory: every directed
// edge as a line (deduped by underlying geometry index, so forward + reverse
// share one feature) and every node as a small circle. Useful for spotting
// snap targets, isolated trail islands, and edge-coverage gaps.
//
// Two layers share one edge source — both rendered only when the
// Street Slopes checkbox is on (VisibilityManager group 'graph-debug'
// in main.js):
//   - graph-debug-edges  colored by absolute slope. Slope comes from the
//                        resolved node elevations on each edge
//                        endpoint, so it reflects the heat-eq-corrected
//                        view on every flagged corridor and the raw
//                        smoothed-DTM view elsewhere.
//   - graph-debug-nodes  small dark-pink dots at every routing-graph
//                        node, for spotting topology issues alongside
//                        the slope edges.

function addGraphDebugLayers(map, graph) {
  // Walk all directed edges, dedupe by geomIndex, prefer the forward edge
  // for each geom so slope sign matches the geometry's drawn direction.
  const geomToEdgeId = new Map();
  for (let i = 0; i < graph.edgeCount; i++) {
    const gIdx = graph.edgeGeomIndex(i);
    const isForward = !graph.e.geomRev[i];
    if (!geomToEdgeId.has(gIdx)) {
      geomToEdgeId.set(gIdx, i);
    } else if (isForward && graph.e.geomRev[geomToEdgeId.get(gIdx)]) {
      geomToEdgeId.set(gIdx, i);
    }
  }

  const edgeFeatures = [];
  for (const [gIdx, edgeId] of geomToEdgeId) {
    const lenFt = graph.edgeLengthFt(edgeId);
    const fromElev = graph.nodeElev(graph.edgeFrom(edgeId));
    const toElev   = graph.nodeElev(graph.edgeTo(edgeId));
    // Signed slope in percent, geom-start to geom-end.
    const slopePct = lenFt > 0 ? ((toElev - fromElev) / lenFt) * 100 : 0;
    edgeFeatures.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: graph.geoms[gIdx] },
      properties: {
        slopePct: Math.round(slopePct * 100) / 100,
        // Used by the second layer's filter — sidewalks render as
        // dashed lines (still slope-colored) so they're visibly
        // distinguishable from on-street edges in the overlay.
        isSidewalk: graph.edgeIsSidewalk(edgeId),
      },
    });
  }

  const nodeFeatures = [];
  for (let i = 0; i < graph.nodeCount; i++) {
    nodeFeatures.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: graph.nodeCoord(i) },
      properties: {},
    });
  }

  map.addSource('graph-debug-edges', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: edgeFeatures },
  });
  // Color steps by |slopePct| in percent. Calibrated against Seattle's
  // 26% steepest-real-street ceiling: ≥20% is "off-the-chart" purple,
  // either a sustained real climb or a residual artifact at a hard-case
  // multi-level junction where the heat eq smoothed across grade.
  // Shared step-color expression for both road and sidewalk debug layers
  // so the same slope reads the same color whether you're on a road or
  // a sidewalk.
  const SLOPE_COLOR = [
    'step', ['abs', ['get', 'slopePct']],
    '#dddddd',          // 0-1%   essentially flat
    1,  '#81c784',      // 1-3%   gentle
    3,  '#fff176',      // 3-6%   moderate
    6,  '#ffa726',      // 6-10%  hilly
    10, '#ef5350',      // 10-15% steep
    15, '#b71c1c',      // 15-20% very steep
    20, '#4a148c',      // 20%+   extreme (above Seattle's real max)
  ];
  const SLOPE_WIDTH = ['interpolate', ['linear'], ['zoom'], 11, 0.8, 16, 2.0];

  // Roads: solid lines.
  map.addLayer({
    id: 'graph-debug-edges',
    type: 'line',
    source: 'graph-debug-edges',
    filter: ['!=', ['get', 'isSidewalk'], true],
    paint: {
      'line-color': SLOPE_COLOR,
      'line-width': SLOPE_WIDTH,
      'line-opacity': 0.85,
    },
    layout: { visibility: 'none' },
  });
  // Sidewalks: dashed, same color ramp. The dash pattern makes them
  // visually distinguishable from on-street edges at a glance while
  // still showing the slope-step color so the debug overlay reads as
  // "everything in the routing graph, colored by slope." Dasharray is
  // in line-widths, so the 2/2 pattern stays proportional at any zoom.
  map.addLayer({
    id: 'graph-debug-sidewalk-edges',
    type: 'line',
    source: 'graph-debug-edges',
    filter: ['==', ['get', 'isSidewalk'], true],
    paint: {
      'line-color': SLOPE_COLOR,
      'line-width': SLOPE_WIDTH,
      'line-opacity': 0.85,
      'line-dasharray': [2, 2],
    },
    layout: { visibility: 'none' },
  });
  map.addSource('graph-debug-nodes', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: nodeFeatures },
  });
  map.addLayer({
    id: 'graph-debug-nodes',
    type: 'circle',
    source: 'graph-debug-nodes',
    paint: {
      'circle-color': '#880e4f',
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 16, 3],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 0.5,
    },
    layout: { visibility: 'none' },
  });
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
