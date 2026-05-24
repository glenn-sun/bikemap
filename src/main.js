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
        attribution:
          '<a href="https://protomaps.com">Protomaps</a> &copy; <a href="https://openstreetmap.org">OpenStreetMap</a> &middot; bike layers &copy; SDOT / King County',
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
      wireToggles(map);
      attachPopups(map);
      initRoutingUI(map);
    })
    .catch((err) => console.error('addDataLayers failed:', err));
});

function wireToggles(map) {
  const vm = new VisibilityManager(map);

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

  vm.bindCheckbox('aaa',         'toggle-aaa')
    .bindCheckbox('bbl',         'toggle-bbl')
    .bindCheckbox('bl',          'toggle-bl')
    .bindCheckbox('sharrows',    'toggle-sharrows')
    .bindCheckbox('planned',     'toggle-planned')
    .bindCheckbox('construction','toggle-construction')
    .bindCheckbox('light-rail',  'toggle-light-rail')
    .bindCheckbox('pois',        'toggle-pois')
    .bindCheckbox('restrooms',   'toggle-restrooms')
    .bindCheckbox('bike-racks',  'toggle-bike-racks')
    .bindCheckbox('bike-signs',  'toggle-bike-signs')
    .bindCheckbox('signals-debug',    'toggle-signals-debug')
    .bindCheckbox('crosswalks-debug', 'toggle-crosswalks-debug')
    .bindCheckbox('beacons-debug',    'toggle-beacons-debug')
    .apply();
}

if (import.meta.env.DEV) {
  window.__map = map;
}
