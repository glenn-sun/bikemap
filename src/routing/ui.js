// Two-click route-planning UI. Click 1 sets start; click 2 sets end and
// triggers A* + render. Subsequent click resets to "set start". The
// "Clear route" button also resets.

import maplibregl from 'maplibre-gl';
import { loadGraph } from './graph.js';
import { findPath } from './astar.js';
import { buildDirections, formatDistance } from './directions.js';
import { computeSignCoverage } from './signCoverage.js';
import { SIGN_COVERAGE_MAX_MULTIPLIER } from './cost.js';

const GRAPH_URL = `${import.meta.env.BASE_URL}data/routing_graph.json`;
const SIGNS_URL = `${import.meta.env.BASE_URL}data/bike_signs.geojson`;

const ROUTE_SOURCE = 'route';
const ROUTE_CASING_LAYER = 'route-line-casing';
const ROUTE_LINE_LAYER   = 'route-line';

export function initRoutingUI(map) {
  const state = {
    map,
    graph: null,
    signs: null,         // FeatureCollection
    phase: 'idle',       // idle | gotStart | gotEnd
    startSpec: null,
    endSpec: null,
    startMarker: null,
    endMarker: null,
    stepMarkers: [],     // maplibregl.Marker per direction step
    panel: document.getElementById('directions-panel'),
  };

  // Add a no-op source + layers so map.setData later works without races.
  map.addSource(ROUTE_SOURCE, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: ROUTE_CASING_LAYER,
    type: 'line',
    source: ROUTE_SOURCE,
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 11],
      'line-opacity': 0.9,
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });
  map.addLayer({
    id: ROUTE_LINE_LAYER,
    type: 'line',
    source: ROUTE_SOURCE,
    paint: {
      'line-color': '#7e3ff2',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 16, 7],
    },
    layout: { 'line-cap': 'round', 'line-join': 'round' },
  });

  // Show a "Loading routing data…" placeholder while we fetch the graph.
  setPanel(state, '<p class="route-loading">Loading routing data…</p>');

  Promise.all([
    loadGraph(GRAPH_URL),
    fetch(SIGNS_URL).then((r) => r.json()),
  ]).then(([graph, signs]) => {
    state.graph = graph;
    state.signs = signs;
    setPanel(state, '<p class="route-hint">Click the map to set <b>start</b>, then click again to set <b>end</b>.</p>');
    console.log(`[routing] graph loaded: ${graph.nodeCount} nodes, ${graph.edgeCount} edges`);
  }).catch((err) => {
    console.error('[routing] failed to load graph:', err);
    setPanel(state, '<p class="route-error">Failed to load routing graph.</p>');
  });

  map.on('click', (e) => onMapClick(state, e));

  document.getElementById('clear-route')?.addEventListener('click', () => {
    resetState(state);
  });
}

function onMapClick(state, e) {
  if (!state.graph) return;
  const lon = e.lngLat.lng;
  const lat = e.lngLat.lat;
  // Snap to the nearest point on the nearest edge (mid-block snapping).
  // Fall back to nearest-node if no edge is within 200 ft.
  const proj = state.graph.findNearestEdgeProjection(lon, lat, 200);
  let spec, markerLon, markerLat;
  if (proj) {
    spec = { kind: 'edge', projection: proj };
    markerLon = proj.projLon;
    markerLat = proj.projLat;
  } else {
    const nodeId = state.graph.findNearestNode(lon, lat);
    if (nodeId == null) return;
    spec = { kind: 'node', nodeId };
    [markerLon, markerLat] = state.graph.nodeCoord(nodeId);
  }

  if (state.phase === 'idle' || state.phase === 'gotEnd') {
    resetState(state, /*keepPanelHint*/ false);
    state.startSpec = spec;
    state.startMarker = new maplibregl.Marker({ color: '#1faa5a' })
      .setLngLat([markerLon, markerLat])
      .addTo(state.map);
    state.phase = 'gotStart';
    setPanel(state, '<p class="route-hint">Now click to set <b>end</b>.</p>');
  } else if (state.phase === 'gotStart') {
    state.endSpec = spec;
    state.endMarker = new maplibregl.Marker({ color: '#d93030' })
      .setLngLat([markerLon, markerLat])
      .addTo(state.map);
    state.phase = 'gotEnd';
    compute(state);
  }
}

function compute(state) {
  setPanel(state, '<p class="route-loading">Computing route…</p>');
  setTimeout(() => {
    const t0 = performance.now();
    const result = findPath(state.graph, state.startSpec, state.endSpec);
    const tMs = performance.now() - t0;

    if (!result) {
      setPanel(state, '<p class="route-error">No path found between those points.</p>');
      return;
    }

    // Stitch the route geometry: prefixGeom (projection -> first graph node) +
    // each interior edge's geometry + suffixGeom (last graph node -> projection).
    const fullGeom = [];
    if (result.prefixGeom && result.prefixGeom.length > 0) {
      // prefixGeom is [proj, ..., firstGraphNode]; that's the direction we travel.
      fullGeom.push(...result.prefixGeom);
    }
    for (const eid of result.pathEdgeIds) {
      const edge = state.graph.edge(eid);
      if (fullGeom.length === 0) {
        fullGeom.push(...edge.geometry);
      } else {
        for (let i = 1; i < edge.geometry.length; i++) {
          fullGeom.push(edge.geometry[i]);
        }
      }
    }
    if (result.suffixGeom && result.suffixGeom.length > 0) {
      // suffixGeom is [lastGraphNode, ..., proj]. First point dupes the
      // current tail of fullGeom; skip it.
      for (let i = 1; i < result.suffixGeom.length; i++) {
        fullGeom.push(result.suffixGeom[i]);
      }
    }

    // Draw on the map.
    state.map.getSource(ROUTE_SOURCE).setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: fullGeom },
        properties: {},
      }],
    });

    // Sign coverage (post-route).
    const sig = computeSignCoverage(fullGeom, state.signs?.features || []);

    // Directions — pass actual route endpoints so step 0 / "Arrive" point
    // to the projection (mid-edge) rather than the nearest graph node.
    const routeStart = fullGeom[0];
    const routeEnd   = fullGeom[fullGeom.length - 1];
    const steps = buildDirections(state.graph, result.pathEdgeIds, routeStart, routeEnd);

    addStepMarkers(state, steps);

    renderDirections(state, {
      steps,
      totalLengthFt: result.totalLengthFt,
      totalCostFt: result.totalCostFt + sig.uncoveredFraction * result.totalLengthFt * SIGN_COVERAGE_MAX_MULTIPLIER,
      timeMs: tMs,
      sig,
    });
  }, 0);
}

function addStepMarkers(state, steps) {
  // Remove any previous step markers.
  for (const m of state.stepMarkers) m.remove();
  state.stepMarkers = [];
  // Render one numbered circle per step at the maneuver point. We skip
  // step 0's marker because the green start-pin already sits there, and
  // the final "Arrive" marker because the red end-pin sits there.
  for (let i = 1; i < steps.length - 1; i++) {
    const s = steps[i];
    if (!s.maneuverLonLat) continue;
    const el = document.createElement('div');
    el.className = 'route-step-marker';
    el.textContent = String(i + 1);
    const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat(s.maneuverLonLat)
      .addTo(state.map);
    state.stepMarkers.push(marker);
  }
}

function renderDirections(state, info) {
  const stepsHtml = info.steps.map((s, i) => {
    const dist = s.distanceFt > 0 ? formatDistance(s.distanceFt) : '';
    const annots = s.annotations.length
      ? `<div class="route-step-annotation">${s.annotations.map(esc).join('<br>')}</div>`
      : '';
    return `
      <li class="route-step">
        <div class="route-step-instruction">${esc(s.instruction)}</div>
        ${dist ? `<div class="route-step-distance">${dist}</div>` : ''}
        ${annots}
      </li>`;
  }).join('');

  const milesTotal = (info.totalLengthFt / 5280).toFixed(2);
  const summary = `
    <div class="route-summary">
      <b>${milesTotal} mi</b> route
      <span class="route-meta">computed in ${info.timeMs.toFixed(0)} ms</span>
    </div>`;

  setPanel(state, summary + `<ol class="route-steps">${stepsHtml}</ol>`);
}

function setPanel(state, html) {
  if (!state.panel) return;
  state.panel.hidden = false;
  state.panel.innerHTML = html;
}

function resetState(state, keepPanelHint = false) {
  if (state.startMarker) { state.startMarker.remove(); state.startMarker = null; }
  if (state.endMarker)   { state.endMarker.remove();   state.endMarker = null; }
  for (const m of state.stepMarkers) m.remove();
  state.stepMarkers = [];
  state.startSpec = null;
  state.endSpec = null;
  state.phase = 'idle';
  if (state.map.getSource(ROUTE_SOURCE)) {
    state.map.getSource(ROUTE_SOURCE).setData({ type: 'FeatureCollection', features: [] });
  }
  if (!keepPanelHint && state.graph) {
    setPanel(state, '<p class="route-hint">Click the map to set <b>start</b>, then click again to set <b>end</b>.</p>');
  }
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
