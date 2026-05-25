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
  'toggle-graph-osm-tags-debug',
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
    home: loadLocFromStorage(LS_HOME),
    work: loadLocFromStorage(LS_WORK),
    speedMph: loadSpeedFromStorage(),
    activeIndex: 0,      // index into state.routes that's currently rendered
                         // as the pink primary line / step list
    userLocation: null,  // {lon, lat, accuracy} — null until first GPS fix
    userLocationMarker: null,
    geoWatchId: null,
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
  ]).then(([graph, signs]) => {
    state.graph = graph;
    state.signs = signs;
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
    setPanel(state, '<p class="route-loading">Waiting for your location…</p>');
    requestLocationOnce(state).then((loc) => {
      if (!loc) {
        setPanel(state, '<p class="route-error">Couldn’t get your location.</p>');
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
    setPanel(state, '<p class="route-error">Your location is too far from the bike network.</p>');
    return;
  }
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
  if (state.preset === 'custom') return weightsForCustom(state.customSliders);
  return weightsForPreset(state.preset);
}
function activeSliders(state) {
  return state.preset === 'custom' ? state.customSliders : PRESETS[state.preset];
}

function compute(state) {
  setPanel(state, '<p class="route-loading">Computing route…</p>');
  setTimeout(() => {
    const t0 = performance.now();
    const primaryWeights = activeWeights(state);
    const baseSliders = activeSliders(state);
    const twistRuns = TWISTS.map((t) => ({
      id: t.id, label: t.label,
      weights: weightsFromSliders(
        applyTwistToSliders(baseSliders, t.id),
        primaryWeights.signCoverageMax,
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
      return;
    }
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
  let aaa = 0, bbl = 0, bl = 0, shw = 0, local = 0, major = 0, total = 0;
  for (const eid of edgeIds) {
    const len = graph.edgeLengthFt(eid);
    total += len;
    const fac = graph.edgeFacility(eid);
    if (fac === 'BKF-NGW' || fac === 'BKF-PBL' || fac === 'BKF-OFFST') aaa += len;
    else if (fac === 'BKF-BBL') bbl += len;
    else if (fac === 'BKF-BL')  bl += len;
    else if (fac === 'BKF-CLMB' || fac === 'BKF-SHW') shw += len;
    else if (!graph.edgeCenterline(eid)) local += len;
    else major += len;
  }
  return { aaa, bbl, bl, shw, local, major, total };
}

// Sub-segment fill colors — MUST stay in sync with the per-tier line
// colors in src/layers.js so the bar reads as the same legend as the map.
// "Local streets" is white (rendered with a thin gray stroke so it's
// visible against the white panel); "Major streets" is a muted red.
const INFRA_COLORS = {
  aaa:   '#1F6B3D',
  bbl:   '#3FA85F',
  bl:    '#7FCC9C',
  shw:   '#E07A1F',
  local: '#ffffff',
  major: '#d65a5a',
};

const INFRA_GROUP_META = {
  aaa:   { label: 'All ages & abilities', pos: 'top' },
  other: { label: 'Other bike',           pos: 'bot' },
  local: { label: 'Local streets',        pos: 'top' },
  major: { label: 'Major streets',        pos: 'bot' },
};

function infraSummaryBarSvg(b, vbWidth = 320) {
  // Render the breakdown as a horizontal bar:
  //   [AAA | BBL | BL | SHW | LOCAL | MAJOR]
  // Two labels above (AAA, Local) and two below (Other bike, Major), each
  // with an L-line pointing to its segment. "Other bike" gets a T-shape
  // bracket spanning all of BBL+BL+SHW when more than one sub-color is
  // present, so the colors visibly belong together.
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
    { k: 'aaa',   ft: b.aaa,   group: 'aaa'   },
    { k: 'bbl',   ft: b.bbl,   group: 'other' },
    { k: 'bl',    ft: b.bl,    group: 'other' },
    { k: 'shw',   ft: b.shw,   group: 'other' },
    { k: 'local', ft: b.local, group: 'local' },
    { k: 'major', ft: b.major, group: 'major' },
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
    groups.push({
      g, x0, x1, center: (x0 + x1) / 2,
      multi: ss.length > 1,
      pct,
      label: `${INFRA_GROUP_META[g].label} · ${pct}%`,
      pos: INFRA_GROUP_META[g].pos,
    });
  }

  // Collapse the unused side's zone when only one side has labels.
  //   Full layout (both sides):  [top zone 32 | bar 14 | bot zone 36] = 82
  //   Only top labels (e.g. all-AAA): drop the 36 px bottom zone → 50 px tall.
  //   Only bot labels (e.g. all-major): drop the 32 px top zone → 54 px tall.
  // SVG aspect ratio changes, so the rendered height shrinks with the
  // collapsed viewBox (width stays 100 %).
  const hasTop = groups.some((g) => g.pos === 'top');
  const hasBot = groups.some((g) => g.pos === 'bot');
  const TOP_ZONE = hasTop ? 32 : 4;       // 4 px tiny pad when no top labels
  const BOT_ZONE = hasBot ? 36 : 4;
  const BAR_H = 14;
  const BAR_Y0 = TOP_ZONE;
  const BAR_Y1 = BAR_Y0 + BAR_H;
  const VB_H = TOP_ZONE + BAR_H + BOT_ZONE;
  const TOP_BASELINE = 12;                // label baseline inside top zone
  const BOT_BASELINE = BAR_Y1 + 28;       // label baseline inside bot zone

  // Estimate label widths from char count (9.5px sans ≈ 5.3 px/char) so
  // we can clamp them inside the viewBox. Then push same-side labels
  // apart when they'd overlap. Two labels per side max, so a single
  // greedy left-to-right pass is sufficient.
  for (const grp of groups) {
    const estW = grp.label.length * 5.3 + 4;
    grp.halfW = estW / 2;
    grp.labelX = Math.max(grp.halfW, Math.min(VB_W - grp.halfW, grp.center));
  }
  for (const side of ['top', 'bot']) {
    const gs = groups.filter((g) => g.pos === side)
                     .sort((a, b) => a.labelX - b.labelX);
    for (let i = 1; i < gs.length; i++) {
      const prev = gs[i - 1], cur = gs[i];
      const minGap = prev.halfW + cur.halfW + 4;
      if (cur.labelX - prev.labelX < minGap) {
        cur.labelX = prev.labelX + minGap;
        const maxRight = VB_W - cur.halfW;
        if (cur.labelX > maxRight) {
          cur.labelX  = maxRight;
          prev.labelX = Math.max(prev.halfW, cur.labelX - minGap);
        }
      }
    }
  }

  // Sub-segment rects.
  const segRects = subs.filter((s) => s.w > 0).map((s) => {
    const stroke = s.k === 'local'
      ? ' stroke="#bbb" stroke-width="0.5"' : '';
    return `<rect x="${s.x0.toFixed(2)}" y="${BAR_Y0}" `
         + `width="${Math.max(0.1, s.w).toFixed(2)}" `
         + `height="${BAR_Y1 - BAR_Y0}" `
         + `fill="${INFRA_COLORS[s.k]}"${stroke}/>`;
  }).join('');

  // Connector lines + label text.
  const parts = [];
  for (const grp of groups) {
    const cx = grp.center, lx = grp.labelX;
    if (grp.pos === 'top') {
      const ly = TOP_BASELINE + 3;            // just below label baseline
      const midY = (ly + BAR_Y0) / 2;
      parts.push(`<polyline points="${lx.toFixed(2)},${ly} ${lx.toFixed(2)},${midY} ${cx.toFixed(2)},${midY} ${cx.toFixed(2)},${BAR_Y0}" class="route-infra-line"/>`);
    } else {
      const ly = BOT_BASELINE - 11;           // just above label top
      if (grp.g === 'other' && grp.multi) {
        // T-bracket: a horizontal flat side just below the bar, spanning
        // the whole "other" range, then a stem (L-bent if shifted) down
        // to the label.
        const bracketY = BAR_Y1 + 3;
        const stemMidY = (bracketY + ly) / 2;
        parts.push(`<polyline points="${grp.x0.toFixed(2)},${bracketY} ${grp.x1.toFixed(2)},${bracketY}" class="route-infra-line"/>`);
        parts.push(`<polyline points="${cx.toFixed(2)},${bracketY} ${cx.toFixed(2)},${stemMidY} ${lx.toFixed(2)},${stemMidY} ${lx.toFixed(2)},${ly}" class="route-infra-line"/>`);
      } else {
        const midY = (BAR_Y1 + ly) / 2;
        parts.push(`<polyline points="${cx.toFixed(2)},${BAR_Y1} ${cx.toFixed(2)},${midY} ${lx.toFixed(2)},${midY} ${lx.toFixed(2)},${ly}" class="route-infra-line"/>`);
      }
    }
    const baseY = grp.pos === 'top' ? TOP_BASELINE : BOT_BASELINE;
    parts.push(`<text x="${lx.toFixed(2)}" y="${baseY}" class="route-infra-label" text-anchor="middle">${escHtml(grp.label)}</text>`);
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

function renderDirections(state, info) {
  // Tab strip — only when >1 route is showing. Active tab = currently
  // primary route. Clicking a tab swaps which route is primary (same as
  // clicking the route on the map).
  let tabsHtml = '';
  if (state.routes.length > 1) {
    tabsHtml = `<ul class="route-tabs">${state.routes.map((r, i) => {
      const mi  = r.result.totalLengthFt / 5280;
      const min = predictedMinutes(mi, state.speedMph);
      return `
      <li class="route-tab ${i === state.activeIndex ? 'active' : ''}" data-route-id="${escHtml(r.id)}">
        <div class="route-tab-name">${escHtml(r.label)}</div>
        <div class="route-tab-mi">${min} min · ${mi.toFixed(2)} mi</div>
      </li>`;
    }).join('')}</ul>`;
  }
  const miles = info.totalLengthFt / 5280;
  const mins = predictedMinutes(miles, state.speedMph);
  // Infrastructure bar for the ACTIVE route, always shown under the
  // min/mi line in the summary block. (Lives outside the tab strip so it
  // doesn't bloat every tab and stays tied to the route that's actually
  // rendered as primary.)
  const activeRoute = state.routes[state.activeIndex];
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

  setPanel(state, tabsHtml + summary + `<ol class="route-steps">${stepsHtml}</ol>`);

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
  try {
    state.geoWatchId = navigator.geolocation.watchPosition(
      (pos) => updateUserLocation(state, pos),
      (err) => console.warn('[geolocation] watch error:', err.message),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
  } catch (e) {
    console.warn('[geolocation] watchPosition threw:', e);
  }
}

function updateUserLocation(state, pos) {
  const { longitude: lon, latitude: lat, accuracy } = pos.coords;
  state.userLocation = { lon, lat, accuracy };
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
function requestLocationOnce(state) {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => { updateUserLocation(state, pos); resolve(state.userLocation); },
      () => resolve(null),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );
  });
}

function pickMyLocation(state, which) {
  if (state.userLocation) {
    const u = state.userLocation;
    const snap = snapToGraph(state.graph, u.lon, u.lat, 800);
    if (!snap.spec) {
      setPanel(state, '<p class="route-error">Your location is too far from the bike network.</p>');
      return;
    }
    setEndpoint(state, which, snap.spec, snap.projLon, snap.projLat, 'My location');
    return;
  }
  setPanel(state, '<p class="route-loading">Waiting for your location…</p>');
  requestLocationOnce(state).then((loc) => {
    if (!loc) {
      setPanel(state, '<p class="route-error">Couldn’t get your location.</p>');
      return;
    }
    pickMyLocation(state, which);
  });
}

function predictedMinutes(miles, mph) {
  const m = Math.round(miles / Math.max(0.1, mph) * 60);
  return Math.max(1, m);
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
        loc: state.userLocation },
      { type: 'saved',  which: 'home', loc: state.home, icon: 'home', name: 'Home' },
      { type: 'saved',  which: 'work', loc: state.work, icon: 'work', name: 'Work' },
      { type: 'choose', icon: 'my_location', name: 'Choose on map',
        subtext: 'Click a spot to set this point' },
    ];
  };

  const pickRow = (row) => {
    if (!row) return;
    if (row.type === 'mylocation') {
      closeDrop();
      input.blur();
      pickMyLocation(state, opts.which);
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
      limit: 6, mapCenter: [center.lng, center.lat],
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
  input.addEventListener('blur', () => setTimeout(closeDrop, 150));
}

function renderRow(row, i, activeIdx) {
  const active = i === activeIdx ? ' active' : '';
  if (row.type === 'mylocation') {
    const sub = row.loc ? 'Use my current location' : 'Locating… click to allow';
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
// Two layers share one edge source:
//   - graph-debug-edges     colored by absolute DTM slope (DTM sampled
//                           at edge endpoints; |Δelev| / lengthFt, signed
//                           value also stored as `slopePct` for inspection)
//   - graph-osm-tags-debug  colored by OSM elevation-related tag
//                           (bridge / tunnel / default)
// Both are added lazily (after the graph loads); visibility is driven by
// the VisibilityManager bindings in main.js.

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
    const fromId = graph.edgeFrom(edgeId);
    const toId   = graph.edgeTo(edgeId);
    const fromElev = graph.nodeElev(fromId);
    const toElev   = graph.nodeElev(toId);
    // Signed slope in percent, going from geom-start to geom-end.
    // Note: with all node elevations = 0, this is just 0 until a v3
    // pipeline writes real data — but the layer is wired to it now so it
    // lights up automatically once data lands.
    const slopePct = lenFt > 0
      ? ((toElev - fromElev) / lenFt) * 100
      : 0;
    // Classify by OSM elevation-related tag with a fixed priority. By
    // construction `untagged-crossing` and `approach` only fire on
    // edges with no other elevation tag; the ordering below is mostly
    // documentary — first match wins. `untagged-crossing` outranks
    // `approach` because it signals an OSM tagging gap (data quality
    // issue) rather than expected structure proximity.
    const layer = graph.edgeLayer(edgeId);
    let osmTag;
    if (graph.edgeIsUntaggedCrossing(edgeId))      osmTag = 'untagged-crossing';
    else if (graph.edgeIsBridge(edgeId))           osmTag = 'bridge';
    else if (graph.edgeIsTunnel(edgeId))           osmTag = 'tunnel';
    else if (layer != null && layer !== 0)         osmTag = 'layered';
    else if (graph.edgeIsEmbankment(edgeId))       osmTag = 'embankment';
    else if (graph.edgeIsCutting(edgeId))          osmTag = 'cutting';
    else if (graph.edgeIsCovered(edgeId))          osmTag = 'covered';
    else if (graph.edgeIsIndoor(edgeId))           osmTag = 'indoor';
    else if (graph.edgeIsApproach(edgeId)) {
      const src = graph.edgeApproachOf(edgeId) || 'bridge';
      osmTag = `approach-of-${src}`;
    } else                                          osmTag = 'default';
    edgeFeatures.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: graph.geoms[gIdx] },
      properties: {
        slopePct: Math.round(slopePct * 100) / 100,
        osmTag,
        layer: layer ?? 0,
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
  // 26% steepest-real-street ceiling: ≥20% is "off-the-chart" purple.
  // Cycling-comfort thresholds: ≤3% gentle, 3-6% moderate, 6-10% hilly,
  // 10%+ steep. When elevation is all zero, every edge is gray.
  map.addLayer({
    id: 'graph-debug-edges',
    type: 'line',
    source: 'graph-debug-edges',
    paint: {
      'line-color': [
        'step', ['abs', ['get', 'slopePct']],
        '#dddddd',          // 0-1%   essentially flat
        1,  '#81c784',      // 1-3%   gentle
        3,  '#fff176',      // 3-6%   moderate
        6,  '#ffa726',      // 6-10%  hilly
        10, '#ef5350',      // 10-15% steep
        15, '#b71c1c',      // 15-20% very steep
        20, '#4a148c',      // 20%+   extreme (above Seattle's real max)
      ],
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 16, 2.0],
      'line-opacity': 0.85,
    },
    // Initial visibility 'none' — the VisibilityManager flips it based on
    // the persisted checkbox state in the next apply() call.
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

  // Sibling layer over the same edge source: paint edges by OSM elevation-
  // related categorical tag. Useful for v3 planning — these are the spans
  // where a raw DTM sample is most likely to be wrong, plus a derived
  // "untagged-crossing" data-quality flag for ambiguous geometry.
  map.addLayer({
    id: 'graph-osm-tags-debug',
    type: 'line',
    source: 'graph-debug-edges',
    paint: {
      'line-color': [
        'match', ['get', 'osmTag'],
        // hot pink — derived data-quality flag: this edge 2D-crosses
        // another way-segment (no shared node) but carries no elevation
        // tag of its own. The other way may or may not be tagged.
        'untagged-crossing', '#ec407a',
        'bridge',            '#d32f2f',   // red    — elevated, DTM unreliable
        'tunnel',            '#1565c0',   // blue   — buried, DTM samples surface above
        'layered',           '#8e24aa',   // purple — OSM layer=±N, no bridge/tunnel tag
        'embankment',        '#6d4c41',   // brown  — raised earthwork; DTM is correct
        'cutting',           '#455a64',   // slate  — sub-grade cut; DTM is correct
        'covered',           '#f9a825',   // amber  — sheltered (arcade / awning)
        'indoor',            '#00897b',   // teal   — inside a building
        // Derived "approach" flag: untagged edges within ~200 ft graph-
        // walk distance of a tagged source. Painted in a desaturated /
        // pastel version of the source category's color so you can see
        // what each approach attaches to.
        'approach-of-bridge',     '#ffcdd2', // light red
        'approach-of-tunnel',     '#bbdefb', // light blue
        'approach-of-layered',    '#d1c4e9', // light purple
        'approach-of-embankment', '#d7ccc8', // light brown
        'approach-of-cutting',    '#cfd8dc', // light slate
        'approach-of-covered',    '#fff9c4', // light amber
        'approach-of-indoor',     '#b2dfdb', // light teal
        '#9e9e9e',                        // default gray
      ],
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 16, 2.0],
      'line-opacity': 0.85,
    },
    layout: { visibility: 'none' },
  });
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
