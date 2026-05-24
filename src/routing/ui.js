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
import {
  PRESETS, SLIDERS, TWISTS,
  weightsForPreset, weightsForCustom,
  applyTwistToSliders, weightsFromSliders,
} from './cost.js';
import { searchAddresses, preloadAddrIndex } from '../search/addr_search.js';
import { setMode, clearMode, getMode, isChoosingOnMap } from './mode.js';

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
// gates their visibility in the layers panel AND clears all five when it
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

function infraBreakdown(graph, edgeIds) {
  // Bucket each edge's length by routing category. Used to render the
  // per-route AAA / Other / Local / Major percentages.
  //   - AAA          : facility ∈ {BKF-NGW, BKF-PBL, BKF-OFFST}
  //   - Other bike   : any other facility tag (BBL, BL, CLMB, SHW)
  //   - Local streets: no facility AND no centerline (≈ residential)
  //   - Major streets: no facility AND has centerline (arterial/collector)
  let aaa = 0, other = 0, local = 0, major = 0, total = 0;
  for (const eid of edgeIds) {
    const len = graph.edgeLengthFt(eid);
    total += len;
    const fac = graph.edgeFacility(eid);
    if (fac === 'BKF-NGW' || fac === 'BKF-PBL' || fac === 'BKF-OFFST') aaa += len;
    else if (fac) other += len;
    else if (!graph.edgeCenterline(eid)) local += len;
    else major += len;
  }
  return { aaa, other, local, major, total };
}

function pctRow(label, ft, total, cls) {
  const pct = total > 0 ? Math.round(100 * ft / total) : 0;
  return `<div class="${cls}">${pct}% ${escHtml(label)}</div>`;
}

function infraSummaryHtml(b, cls) {
  return pctRow('All ages & abilities', b.aaa,   b.total, cls)
       + pctRow('Other bike routes',    b.other, b.total, cls)
       + pctRow('Local streets',        b.local, b.total, cls)
       + pctRow('Major streets',        b.major, b.total, cls);
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
  // 4-line infrastructure breakdown for the ACTIVE route, always shown
  // under the min/mi line in the summary block. (Lives outside the tab
  // strip so it doesn't bloat every tab and stays tied to the route
  // that's actually rendered as primary.)
  const activeRoute = state.routes[state.activeIndex];
  const summaryPct = activeRoute
    ? infraSummaryHtml(infraBreakdown(state.graph,
        activeRoute.result.pathEdgeIds), 'route-summary-pct')
    : '';
  const summary = `
    <div class="route-summary">
      <b>${mins} min</b> · ${miles.toFixed(2)} mi
      ${summaryPct}
    </div>`;

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
}

function setPanel(state, html) {
  if (!state.panel) return;
  state.panel.hidden = false;
  state.panel.innerHTML = html;
}

function resetRoute(state) {
  if (state.startMarker) { state.startMarker.remove(); state.startMarker = null; }
  if (state.endMarker)   { state.endMarker.remove();   state.endMarker = null; }
  for (const m of state.stepMarkers) m.remove();
  for (const m of state.altMarkers)  m.remove();
  state.stepMarkers = []; state.altMarkers = [];
  state.routes = [];
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
}

function finishChooseOnMap(state, which, spec, lon, lat, label) {
  cancelChooseOnMap();
  setEndpoint(state, which, spec, lon, lat, label);
}

function cancelChooseOnMap() {
  if (!isChoosingOnMap()) return;
  clearMode();
  document.body.classList.remove('choosing-on-map');
}

function wireGlobalChooseInteractions(state) {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancelChooseOnMap();
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
  const fs = document.getElementById('layers-debug-fieldset');
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
        <input type="range" id="slider-${s.key}" min="0" max="1" step="0.05"
               value="${state.customSliders[s.key]}" />
        <span class="slider-val" id="slider-val-${s.key}">${formatSliderVal(state.customSliders[s.key])}</span>
      </label>`).join('');
    SLIDERS.forEach((s) => {
      const input = document.getElementById(`slider-${s.key}`);
      const out   = document.getElementById(`slider-val-${s.key}`);
      input.addEventListener('input', () => {
        state.customSliders[s.key] = Number(input.value);
        out.textContent = formatSliderVal(state.customSliders[s.key]);
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

function formatSliderVal(v) { return Number(v).toFixed(2); }

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
    if (Number.isFinite(v) && v >= 4 && v <= 25) return v;
  } catch {}
  return DEFAULT_SPEED_MPH;
}
function saveSpeedToStorage(mph) {
  try { localStorage.setItem(LS_SPEED, String(mph)); } catch {}
}

// ---------- graph debug layer (toggleable visualization) ----------
//
// Renders the routing graph as it actually sits in memory: every directed
// edge as a line (deduped by underlying geometry index, so forward + reverse
// share one feature) and every node as a small circle. Useful for spotting
// snap targets, isolated trail islands, and edge-coverage gaps.
// The layers are added lazily (after the graph loads) and their visibility
// is driven by the VisibilityManager binding in main.js.

function addGraphDebugLayers(map, graph) {
  // Edges: dedupe by geomIndex so we don't draw the same line twice.
  const edgeFeatures = [];
  const seen = new Set();
  for (let i = 0; i < graph.edgeCount; i++) {
    const gIdx = graph.edgeGeomIndex(i);
    if (seen.has(gIdx)) continue;
    seen.add(gIdx);
    edgeFeatures.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: graph.geoms[gIdx] },
      properties: {},
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
  map.addLayer({
    id: 'graph-debug-edges',
    type: 'line',
    source: 'graph-debug-edges',
    paint: {
      'line-color': '#ff00aa',
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.4, 16, 1.2],
      'line-opacity': 0.55,
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
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
