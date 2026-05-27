// Routing UI: endpoint inputs (FlexSearch autocomplete + Home/Work/
// My-location/Choose-on-map options), choose-on-map mode, settings modal,
// and up to 3 routes (primary + twists) with a tab strip for swapping
// which is rendered as the pink primary. Tab labels are insertion-stable
// — promoting a twist by click does not relabel it.

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

// Distance thresholds for the destination bike-parking badge.
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

// Routing-debug toggle checkbox ids. The Settings "Enable routing debug"
// toggle gates this whole group and force-clears them when disabled.
const DEBUG_TOGGLE_IDS = [
  'toggle-signals-debug',
  'toggle-crosswalks-debug',
  'toggle-beacons-debug',
  'toggle-stop-signs-debug',
  'toggle-graph-debug',
];

// Route in pink so the green tier paint shows through it (route layers
// sit below bike infra). Alts use the same hue, lighter, instead of a
// thinner stroke.
const PRIMARY_COLOR    = '#e91e63';
const ALT_LINE_COLOR   = '#f48fb1';
const ALT_CASING_COLOR = '#ffffff';

let state_holder = { current: null };

export function initRoutingUI(map, vm = null) {
  const state = {
    map,
    vm,
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
    activeIndex: 0,
    userLocation: null,        // {lon, lat, accuracy} — null until first fix
    userLocationMarker: null,
    geoWatchIdHigh: null,
    geoWatchIdLow: null,
    locationPending: false,    // a "My location" pick is awaiting a fix
    locationError: null,       // surfaced as "My location" dropdown subtext
    locationDropdownRefresh: null, // set by the focused endpoint dropdown
    hoverSeries: null,         // active route's elevation series (chart↔map hover)
    hoverMarker: null,
  };
  // Persisted preset == 'custom' but Custom is disabled → fall back.
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
  // Force-clear any stale debug toggles persisted from a prior session
  // where the gate was on.
  applyDebugEnabledUI(state, { forceClearOnDisable: true });

  Promise.all([
    loadGraph(GRAPH_URL),
    fetch(SIGNS_URL).then((r) => r.json()),
    fetch(BIKE_RACKS_URL).then((r) => r.json()),
  ]).then(([graph, signs, bikeRacks]) => {
    state.graph = graph;
    state.signs = signs;
    state.bikeRacks = bikeRacks;
    addGraphDebugLayers(map, graph);
    // graph-debug was bound to a checkbox before the layers existed;
    // re-apply now that they do.
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

// Called by popups.js when the "Go" button inside a POI popup is clicked.
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
  // Route layers go below bike infrastructure (so green tier paint shows
  // through). `kc-regional-trails` is the bottom bike-infra layer.
  const beforeId = map.getLayer('kc-regional-trails') ? 'kc-regional-trails' : undefined;

  // Primary and alts share widths — color, not thickness, signals which
  // route is active.
  const CASING_WIDTH = ['interpolate', ['linear'], ['zoom'], 10, 5,   16, 14];
  const LINE_WIDTH   = ['interpolate', ['linear'], ['zoom'], 10, 3.5, 16, 10];

  // Alts go in first so the primary paints above them.
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

  // Click an alt line to promote it (same as clicking its tab).
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

  // Endpoint-by-map-click only works in choose-on-map mode.
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
    // Only one endpoint pinned so far — the marker is the affordance.
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
  // "Computing route…" with CSS-animated ellipsis dots.
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
      // Cache stitched polyline + geom-index set per route for label
      // placement on alts.
      state.routes = routes.map((r) => ({
        ...r,
        fullGeom: stitchGeometry(state.graph, r.result),
        geomSet: geomIndexSet(state.graph, r.result.pathEdgeIds),
      }));
      state.activeIndex = 0;
      state.lastComputeMs = tMs;
      drawRoutes(state);
      renderPrimary(state);
    }
    // Mobile: expand sheet so directions (or the no-path error) are
    // visible. Double call survives a stray keyboard-dismiss resize.
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

  // Alts = every route other than the active one. Original insertion
  // order is preserved so tab positions don't shuffle on promote.
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

  // Floating label per alt, placed at the midpoint of its longest
  // contiguous divergence from the active route.
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

/** Midpoint of the alt's longest contiguous run of edges not shared
 *  with the active route. Falls back to overall route midpoint. */
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
  // Only the active pointer moves; state.routes order is stable.
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
// state.hoverSeries / hoverChartGeom are populated by elevationBlockHtml
// on each render; both hover handlers read from them.

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

/** Move map dot + chart cursor to the given distance along the route. */
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
  // Tooltip: three short lines (elev / mi / %) stacked at y=9,19,29
  // sit entirely inside pad.t=32 so they never overlap the curve.
  const slope = slopeAtDistance(series, d);
  const pctStr = (slope >= 0 ? '+' : '') + (slope * 100).toFixed(1) + '%';
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

/** Bind once at boot; reads state.hoverSeries (refreshed per render). */
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
  // Bucket each edge by tier. Local = no facility + no centerline;
  // Major = no facility + has centerline. AAA covers NGW/PBL/OFFST;
  // BBL/BL/SHW each get their own bar color under "Other bike".
  let aaa = 0, bbl = 0, bl = 0, shw = 0, local = 0, major = 0, sidewalk = 0, total = 0;
  for (const eid of edgeIds) {
    const len = graph.edgeLengthFt(eid);
    total += len;
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

// Keep in sync with the per-tier line colors in src/layers.js. Local is
// white (gray-stroked); Major is muted red.
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
  // Horizontal bar [AAA | BBL | BL | SHW | LOCAL | MAJOR | SIDEWALK]
  // with each category labeled via an L-connector above or below.
  //
  // Layout: labels x-place by symmetric repulsion from their segment
  // center (each overlap pushes both sides by half, clamp to viewBox,
  // iterate). Connector midY assignments are then exhaustively
  // searched (see optimizeMidYs) to minimize crossings.
  //
  // vbWidth is both pixel width and viewBox width — 1:1 mapping keeps
  // font-size and bar height constant across container widths.
  if (!b.total) return '';
  const VB_W = vbWidth;
  const PAD_X = 6;
  const BAR_X0 = PAD_X, BAR_X1 = VB_W - PAD_X;
  const BAR_W = BAR_X1 - BAR_X0;

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

  const groups = [];
  for (const g of Object.keys(INFRA_GROUP_META)) {
    const ss = subs.filter((s) => s.group === g && s.w > 0);
    if (!ss.length) continue;
    const x0 = Math.min(...ss.map((s) => s.x0));
    const x1 = Math.max(...ss.map((s) => s.x1));
    const ft = ss.reduce((acc, s) => acc + s.ft, 0);
    const pct = Math.round(100 * ft / b.total);
    // Any nonzero presence on the route renders as "<1%" rather than 0%.
    const pctText = pct === 0 ? '<1%' : `${pct}%`;
    groups.push({
      g, x0, x1, center: (x0 + x1) / 2,
      multi: ss.length > 1,
      pct,
      label: `${INFRA_GROUP_META[g].label} · ${pctText}`,
      pos: INFRA_GROUP_META[g].pos,
    });
  }

  // Label-width estimate for collision tests (~5.3 px/char at 9.5 px).
  for (const grp of groups) {
    const estW = grp.label.length * 5.3 + 4;
    grp.halfW = estW / 2;
  }

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

  const segRects = subs.filter((s) => s.w > 0).map((s) => {
    const stroke = s.k === 'local'
      ? ' stroke="#bbb" stroke-width="0.5"' : '';
    return `<rect x="${s.x0.toFixed(2)}" y="${BAR_Y0}" `
         + `width="${Math.max(0.1, s.w).toFixed(2)}" `
         + `height="${BAR_Y1 - BAR_Y0}" `
         + `fill="${INFRA_COLORS[s.k]}"${stroke}/>`;
  }).join('');

  // Connector: a horizontal mid-segment at y=midY between segCenter
  // and labelX. midY is constrained to [yMin, yMax]; optimizeMidYs
  // picks the per-connector level that minimizes crossings.
  function buildConn(grp) {
    const cx = grp.center, lx = grp.labelX;
    if (grp.pos === 'top') {
      const ly = TOP_BASELINE + 3;
      const yMin = BAR_Y0 + 2;
      const yMax = ly - 1;
      const midY = (ly + BAR_Y0) / 2;
      return { grp, ly, anchorY: BAR_Y0, midY, yMin, yMax,
               xMin: Math.min(cx, lx), xMax: Math.max(cx, lx) };
    }
    const ly = BOT_BASELINE - 11;
    const yMin = BAR_Y1 + 2;
    const yMax = ly - 1;
    const useBracket = (grp.g === 'other' && grp.multi);
    // The "other" T-bracket spans BBL+BL+SHW; it sits closer to the bar.
    const midY = useBracket ? (BAR_Y1 + 3) : (BAR_Y1 + ly) / 2;
    return { grp, ly, anchorY: BAR_Y1, midY, yMin, yMax,
             xMin: useBracket ? grp.x0 : Math.min(cx, lx),
             xMax: useBracket ? grp.x1 : Math.max(cx, lx),
             useBracket };
  }
  const topConns = topLabels.map(buildConn);
  const botConns = botLabels.map(buildConn);

  // Connector decomposed into line segments for crossing detection.
  // L-shape: 1 horizontal + 2 verticals. T-bracket (multi "other"):
  // 2 horizontals + 2 verticals; no leg up to the bar.
  function buildSegments(c) {
    const cx = c.grp.center, lx = c.grp.labelX;
    if (c.useBracket) {
      const stemMid = (c.midY + c.ly) / 2;
      return {
        horiz: [
          { y: c.midY,  xMin: c.grp.x0, xMax: c.grp.x1 },
          { y: stemMid, xMin: Math.min(cx, lx), xMax: Math.max(cx, lx) },
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

  // Count vertical×horizontal intersections plus same-y horizontal
  // overlaps between two connectors.
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

  // Exhaustive search of 5 levels per connector (≤ 5^5 = 3,125 evals).
  // Score = crossings × 1e6 + total perturbation from default midY, so
  // ties break toward minimal movement.
  function optimizeMidYs(conns) {
    if (conns.length <= 1) return;
    const N_LEVELS = 5;
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

  // Inline width/height in pixels; viewBox is 1:1 so font-size and bar
  // height stay constant across container widths.
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
  const svg = elevationProfileSvg(series, { width: vbWidth });
  if (!svg.area) return '';
  // Stashed for hover handlers (chart + map).
  state.hoverSeries = series;
  state.hoverChartGeom = {
    width: svg.width, height: svg.height, pad: svg.pad,
    minElev: svg.minElevFt, maxElev: svg.maxElevFt, totalDist: svg.totalDistFt,
  };
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
// "P" badge above the step list, tiered green/yellow/red on the closest
// public bike rack from bicycle_racks.geojson (haversine distance).

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
  const dirs = ['north', 'northeast', 'east', 'southeast',
                'south', 'southwest', 'west', 'northwest'];
  const idx = Math.floor(((bearingDeg + 22.5) % 360) / 45);
  return dirs[idx];
}

function bikeRackInfoForDestination(state, destLon, destLat) {
  const feats = state.bikeRacks?.features;
  if (!feats || !feats.length) return null;
  // Bbox prefilter at Seattle's latitude (1° lat ≈ 364,000 ft,
  // 1° lon ≈ 247,000 ft).
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
  // Tab strip only when >1 route is showing.
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
  const activeRoute = state.routes[state.activeIndex];
  const mins = predictedMinutes(state, activeRoute);
  // Summary SVGs render at the panel's measured width with viewBox 1:1
  // so font-size and height stay constant. Cached for the resize handler.
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

  if (tabsHtml) {
    state.panel.querySelectorAll('.route-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const id = tab.dataset.routeId;
        if (id) setActiveRoute(state, id);
      });
    });
  }
  // Chart SVG is rebuilt on every render, so rebind its hover handler.
  attachChartHoverHandlers(state);
}

function setPanel(state, html) {
  if (!state.panel) return;
  state.panel.hidden = false;
  state.panel.innerHTML = html;
}

// Panel width used as both SVG pixel-width and viewBox-width (1:1).
// renderDirections sets hidden=false AFTER this runs, so we temporarily
// un-hide to measure, then restore.
function directionsPanelInnerWidth(state) {
  if (state.panel) {
    const wasHidden = state.panel.hidden;
    if (wasHidden) state.panel.hidden = false;
    const measured = state.panel.clientWidth;
    if (wasHidden) state.panel.hidden = true;
    if (measured >= 200) return measured;
  }
  if (window.matchMedia('(max-width: 719px)').matches) {
    return Math.max(280, window.innerWidth - 20);
  }
  return 360;
}

// Re-render the panel when the viewport resize changes its width by
// >= 4 px (deadband avoids thrashing on mobile-keyboard show/hide).
function attachDirectionsResizeHandler(state) {
  let pending = 0;
  window.addEventListener('resize', () => {
    if (pending) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      pending = 0;
      if (!state.routes.length) return;
      const w = directionsPanelInnerWidth(state);
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

// Clear just one endpoint. The remaining single pin can't route.
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

// MapLibre Marker has no setColor, so role-swapped markers are recreated.
function swapEndpoints(state) {
  if (!state.startSpec && !state.endSpec) return;
  const sSpec = state.startSpec, sLabel = state.startLabel;
  const eSpec = state.endSpec,   eLabel = state.endLabel;
  const sLngLat = state.startMarker?.getLngLat();
  const eLngLat = state.endMarker?.getLngLat();
  state.startMarker?.remove(); state.startMarker = null;
  state.endMarker?.remove();   state.endMarker = null;

  state.startSpec = eSpec; state.startLabel = eLabel;
  setInputValue('route-start-input', eLabel || '');
  if (eSpec && eLngLat) {
    state.startMarker = new maplibregl.Marker({ color: '#1faa5a' })
      .setLngLat([eLngLat.lng, eLngLat.lat]).addTo(state.map);
  }

  state.endSpec = sSpec; state.endLabel = sLabel;
  setInputValue('route-end-input', sLabel || '');
  if (sSpec && sLngLat) {
    state.endMarker = new maplibregl.Marker({ color: '#d93030' })
      .setLngLat([sLngLat.lng, sLngLat.lat]).addTo(state.map);
  }

  if (state.startSpec && state.endSpec) {
    compute(state);
  } else {
    // Only one endpoint — drop any stale route artifacts.
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
  // Two parallel watchers: high-accuracy (GPS) + low-accuracy
  // (WiFi/IP). The low-accuracy one covers the indoor case where the
  // GPS-only watcher silently never fires.
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

// One-shot location used by "My location" picks and the popup Go
// button. Tries cached → high-accuracy → low-accuracy in that order.
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

// Snap state.userLocation to the graph and pin it as the endpoint.
// On failure sets state.locationError for the dropdown subtext.
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

// Display-only ETA (routing cost ignores this).
//   base / mph + sidewalk / 5 mph
//   + 2 s/ft climb − 0.5 s/ft descent
//   + 10 s per interior-node signal + 2 s per interior-node stop sign
//     facing the cyclist's bearing.
function predictedMinutes(state, route) {
  const sec = predictedSeconds(state, route);
  return Math.max(1, Math.round(sec / 60));
}

function predictedSeconds(state, route) {
  const graph = state.graph;
  const r = route?.result;
  if (!graph || !r) return 0;
  const mph = Math.max(0.1, state.speedMph);

  // Prefix/suffix never land on sidewalks (findNearestEdgeProjection
  // skips them), so total − sidewalkFt is the non-sidewalk distance
  // including any mid-edge slices.
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

  // Re-render option rows when a "My location" pick's state changes.
  // No-op when the dropdown is showing search hits (don't yank the rug).
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
      // No fix yet — show "Locating…" inline while we request one.
      state.locationPending = true;
      state.locationError = null;
      currentRows = optionRows();
      renderRows(currentRows);
      requestLocationOnce(state).then(() => {
        state.locationPending = false;
        if (!state.userLocation) {
          state.locationError = 'Couldn’t get your location';
          // User may have moved to the other input by now.
          state.locationDropdownRefresh?.();
          return;
        }
        // Apply only if the user is still on this dropdown.
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
    // Mobile: expand sheet so the dropdown has room inside it.
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
  // Mobile: collapse sheet so the map is visible for the tap.
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

  // Gates #layers-debug-section and force-clears its toggles when off.
  const debugToggle = document.getElementById('settings-debug-enabled');
  if (debugToggle) {
    debugToggle.checked = state.debugEnabled;
    debugToggle.addEventListener('change', () => {
      state.debugEnabled = debugToggle.checked;
      saveDebugEnabledToStorage(state.debugEnabled);
      applyDebugEnabledUI(state, { forceClearOnDisable: true });
    });
  }

  // Disabling while Custom is the active preset falls back to Comfort
  // so the visible segmented buttons always reflect the active mode.
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
      if (state.routes.length > 0) renderPrimary(state);
    });
  }
}

function applyCustomEnabledUI(state) {
  const seg = document.getElementById('preset-segmented');
  if (seg) seg.classList.toggle('custom-enabled', state.customEnabled);
  // Sliders stay visible when Custom is off — grayed out and inert.
  const sliders = document.getElementById('custom-sliders');
  if (sliders) {
    sliders.hidden = false;
    sliders.classList.toggle('disabled', !state.customEnabled);
    sliders.querySelectorAll('input[type="range"]').forEach((el) => {
      el.disabled = !state.customEnabled;
    });
  }
}

// Show/hide #layers-debug-section. When disabled, uncheck every debug
// toggle and fire `change` so VisibilityManager drops each layer.
function applyDebugEnabledUI(state, { forceClearOnDisable = false } = {}) {
  const section = document.getElementById('layers-debug-section');
  if (section) section.hidden = !state.debugEnabled;
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
    // Re-apply now that the slider inputs exist (wireSettingsModal ran
    // before this, when only the container was present).
    applyCustomEnabledUI(state);
  }
}

function setPresetUI(state) {
  document.querySelectorAll('input[name="route-preset"]').forEach((el) => {
    el.checked = (el.value === state.preset);
  });
}

// "Enable sidewalks" gates long sidewalks (> 50 ft). Short ones
// (≤ 50 ft) stay routable either way. Flipping re-runs A*.
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
// Custom sliders open at a neutral 0.5 (not a named preset) so the
// user starts from a blank canvas.
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
  // Default ON; only an explicit prior "false" disables.
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

// ---------- graph debug layers (Street Slopes toggle) ----------
//
// Three layers share two sources, gated by VisibilityManager group
// 'graph-debug' (see main.js):
//   - graph-debug-edges          roads, solid, slope-colored
//   - graph-debug-sidewalk-edges sidewalks, dashed, same color ramp
//   - graph-debug-nodes          dark-pink dots at every node

function addGraphDebugLayers(map, graph) {
  // Dedupe by geomIndex; prefer the forward edge so slope sign matches
  // the geometry's drawn direction.
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
  // Color steps by |slopePct|. Seattle's steepest real street is 26%,
  // so ≥20% purple is either a sustained real climb or a heat-eq
  // artifact at a multi-level junction. Shared by road + sidewalk
  // layers so the same slope reads the same color.
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

  // Roads: solid.
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
  // Sidewalks: dashed (proportional 2/2 in line-widths) so they're
  // visually distinguishable from on-street edges.
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
