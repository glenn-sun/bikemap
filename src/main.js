import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { layers as protomapsLayers, namedFlavor } from '@protomaps/basemaps';

import { addDataLayers } from './layers.js';
import { desaturateBasemapLayers } from './basemap.js';
import { basemapLabelLayers } from './labels.js';
import { VisibilityManager } from './visibility.js';
import { attachPopups } from './popups.js';
import { initRoutingUI } from './routing/ui.js';

const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

const PMTILES_URL = `${import.meta.env.BASE_URL}tiles/seattle.pmtiles`;
const ASSETS = 'https://protomaps.github.io/basemaps-assets';

// Build the basemap in three pieces so we can sandwich our data between
// shapes (bottom) and labels (top): basemap fills/lines → data → labels.
// (@protomaps/basemaps 5.7.x ships no label layers, so labels come from
// src/labels.js — hand-written symbol layers against the same pmtiles.)
const flavor = namedFlavor('light');
const baseLayers   = desaturateBasemapLayers(protomapsLayers('protomaps', flavor), 0.55);
const labelLayers  = basemapLabelLayers('protomaps');
const FIRST_LABEL_ID = labelLayers[0]?.id ?? null;

const map = new maplibregl.Map({
  container: 'map',
  center: [-122.335, 47.61],
  zoom: 11.5,
  hash: true,
  style: {
    version: 8,
    glyphs: `${ASSETS}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${ASSETS}/sprites/v4/light`,
    sources: {
      protomaps: {
        type: 'vector',
        url: `pmtiles://${PMTILES_URL}`,
        // Protomaps + OSM attribution stays on-map (Protomaps requests
        // basemap attribution be visible). SDOT / King County credits
        // live in the in-app Settings → Attributions section.
        attribution:
          '<a href="https://protomaps.com">Protomaps</a> &copy; <a href="https://openstreetmap.org">OpenStreetMap</a>',
      },
    },
    layers: [...baseLayers, ...labelLayers],
  },
});

map.on('error', (e) => console.error('[map error]', e.error || e));

map.addControl(new maplibregl.NavigationControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');

map.on('load', () => {
  addDataLayers(map, FIRST_LABEL_ID)
    .then(() => {
      const vm = wireToggles(map);
      attachPopups(map);
      initRoutingUI(map, vm);
    })
    .catch((err) => console.error('addDataLayers failed:', err));
});

const LS_TOGGLES = 'bikemap-toggles';

function loadPersistedToggles() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_TOGGLES) || 'null');
    if (v && typeof v === 'object') return v;
  } catch {}
  return {};
}

function wireToggles(map) {
  const vm = new VisibilityManager(map);
  const persisted = loadPersistedToggles();

  vm.group('aaa', [
    'kc-regional-trails',
    'multi-use-trails',
    'bike-plus-existing',
    'bike-facilities-aaa',
    'bike-facilities-construction-aaa',
  ]);
  vm.group('bbl', ['bike-facilities-bbl', 'bike-facilities-construction-bbl']);
  vm.group('bl',  ['bike-facilities-bl',  'bike-facilities-construction-bl']);
  vm.group('sharrows', ['bike-facilities-narrow', 'bike-facilities-construction-narrow']);
  vm.group('planned', ['bike-plus-planned']);
  vm.group('construction', [
    'bike-facilities-construction-aaa',
    'bike-facilities-construction-bbl',
    'bike-facilities-construction-bl',
    'bike-facilities-construction-narrow',
  ]);
  vm.group('light-rail',  ['light-rail-stations']);
  vm.group('pois',        ['libraries', 'community-centers']);
  vm.group('restrooms',   ['parks-restrooms']);
  vm.group('bike-racks',  ['bike-racks']);
  vm.group('bike-signs',  ['bike-signs']);
  vm.group('signals-debug',    ['signals-debug']);
  vm.group('crosswalks-debug', ['crosswalks-debug']);
  vm.group('beacons-debug',    ['beacons-debug']);
  vm.group('stop-signs-debug', ['stop-signs-debug']);
  // The graph-debug layers are added later by initRoutingUI (the graph
  // isn't loaded yet at this point). VisibilityManager.apply() skips
  // missing layers silently, and we'll call vm.apply() again once the
  // layers actually exist.
  vm.group('graph-debug',      ['graph-debug-edges', 'graph-debug-nodes']);

  vm.bindCheckbox('aaa',         'toggle-aaa',         persisted)
    .bindCheckbox('bbl',         'toggle-bbl',         persisted)
    .bindCheckbox('bl',          'toggle-bl',          persisted)
    .bindCheckbox('sharrows',    'toggle-sharrows',    persisted)
    .bindCheckbox('planned',     'toggle-planned',     persisted)
    .bindCheckbox('construction','toggle-construction',persisted)
    .bindCheckbox('light-rail',  'toggle-light-rail',  persisted)
    .bindCheckbox('pois',        'toggle-pois',        persisted)
    .bindCheckbox('restrooms',   'toggle-restrooms',   persisted)
    .bindCheckbox('bike-racks',  'toggle-bike-racks',  persisted)
    .bindCheckbox('bike-signs',  'toggle-bike-signs',  persisted)
    .bindCheckbox('signals-debug',    'toggle-signals-debug',    persisted)
    .bindCheckbox('crosswalks-debug', 'toggle-crosswalks-debug', persisted)
    .bindCheckbox('beacons-debug',    'toggle-beacons-debug',    persisted)
    .bindCheckbox('stop-signs-debug', 'toggle-stop-signs-debug', persisted)
    .bindCheckbox('graph-debug',      'toggle-graph-debug',      persisted)
    .onChange((snap) => {
      try { localStorage.setItem(LS_TOGGLES, JSON.stringify(snap)); } catch {}
    })
    .apply();
  return vm;
}

if (import.meta.env.DEV) {
  window.__map = map;
}
