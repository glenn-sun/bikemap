// Source + paint config for every SDOT / King County data layer.
//
// Color tiers for bike infrastructure (per user spec):
//   dark green   — Bike+, NGW, PBL, all multi-use & regional trails
//   medium green — BBL (buffered bike lane)
//   light green  — BL  (bike lane)
//   orange       — CLMB (climbing) and SHW (sharrow / shoulder)
//   hot pink     — OFFST (off-street, exploratory color so we can see them)
// Proposed segments are dashed.

const DATA = (name) => `${import.meta.env.BASE_URL}data/${name}.geojson`;

const DARK_GREEN    = '#1F6B3D';
const MEDIUM_GREEN  = '#3FA85F';
const LIGHT_GREEN   = '#7FCC9C';
const ORANGE        = '#E07A1F';
const PLANNED_GRAY  = '#9aa1a3';   // dotted + gray for planned segments
// Fallback for unrecognized categories — hidden by default so unmapped
// Non-Bike+ / null CATEGORY items don't add noise. Flip to a real color if
// you want to see them again.
const HIDDEN        = 'rgba(0,0,0,0)';

// Same width interp for the green tier (Bike+, NGW, PBL, trails, BBL, BL).
const GREEN_WIDTH  = ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 3.5];
// Narrower width for CLMB/SHW orange.
const ORANGE_WIDTH = ['interpolate', ['linear'], ['zoom'], 10, 0.8, 14, 1.8];

// Dot pattern: tight short dashes. line-cap defaults to 'butt'; that reads
// as small rectangles, which is what we want.
const DOTTED_DASH = [1, 2];

// Single icon-size interp shared across all four large POI symbol layers.
const POI_ICON_SIZE = ['interpolate', ['linear'], ['zoom'], 10, 0.45, 14, 0.9];

const BIKE_PLUS_COLORS = [
  'match', ['get', 'bike_network_category'],
  'Existing Bike+ - Arterial',          DARK_GREEN,
  'Existing Bike+ - Non-Arterial',      DARK_GREEN,
  'Existing Multi-Use Trail',           DARK_GREEN,
  'Proposed Bike+ - Arterial',          DARK_GREEN,
  'Proposed Bike+ - Upgrade, Arterial', DARK_GREEN,
  'Proposed Bike+ - Non-Arterial',      DARK_GREEN,
  'Proposed Multi-Use Trail',           DARK_GREEN,
  /* Non-Bike+ / Non-Bike+ Planned: hidden */ HIDDEN,
];

const isProposed = [
  'match', ['get', 'bike_network_category'],
  ['Proposed Bike+ - Arterial', 'Proposed Bike+ - Upgrade, Arterial',
   'Proposed Bike+ - Non-Arterial', 'Proposed Multi-Use Trail',
   'Non-Bike+ Planned'],
  true,
  false,
];

// Bike facility category groups, one toggleable group each.
const AAA_CATS  = ['BKF-NGW', 'BKF-PBL', 'BKF-OFFST'];        // all ages and abilities
const BBL_CATS  = ['BKF-BBL'];                                 // buffered
const BL_CATS   = ['BKF-BL'];                                  // standard
const NARROW_CATS = ['BKF-CLMB', 'BKF-SHW'];                   // climbing + sharrows

const inCats = (cats) => ['in', ['get', 'CATEGORY'], ['literal', cats]];

// bike_facilities lifecycle (CURRENT_STATUS):
//   'INSVC'     → installed and in service
//   'PLNRECON'  → installed AND in service today, but slated for upgrade
//                  (verified in the field; renders identically to INSVC)
//   'UNDERCONS' → currently being built (dotted, category color)
// Anything else (null, blank, etc.) is treated as out-of-service and hidden.
const INSTALLED_FILTER = ['in', ['get', 'CURRENT_STATUS'], ['literal', ['INSVC', 'PLNRECON']]];
const UNDERCONS_FILTER = ['==', ['get', 'CURRENT_STATUS'], 'UNDERCONS'];

// ---------- Material Symbols icon loader ----------
//
// Composes each Material Symbol on a filled colored circle (drawn on canvas)
// so the icons read at a glance against the busy bike layers. We pull the
// filled (fill1) heavy-weight variant for extra legibility.

const MATERIAL_BASE =
  'https://fonts.gstatic.com/s/i/short-term/release/materialsymbolsoutlined';

async function loadMaterialIcon(map, name, fillColor) {
  // Filled variant is much bolder than the default outline.
  const url = `${MATERIAL_BASE}/${name}/fill1/48px.svg`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch icon ${name}: ${res.status}`);
  let svg = await res.text();
  svg = svg.replace(/<svg /, `<svg fill="#ffffff" `); // icon glyph in white
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const objUrl = URL.createObjectURL(blob);
  const iconImg = new Image(48, 48);
  await new Promise((resolve, reject) => {
    iconImg.onload = resolve;
    iconImg.onerror = reject;
    iconImg.src = objUrl;
  });
  URL.revokeObjectURL(objUrl);

  // Compose on a 64x64 canvas: filled circle background + icon centered.
  const SIZE = 64;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');

  // Soft drop shadow so icons pop on the basemap.
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;

  // Filled circle.
  ctx.fillStyle = fillColor;
  ctx.beginPath();
  ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 3, 0, Math.PI * 2);
  ctx.fill();

  // Reset shadow before drawing the glyph so it stays crisp.
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // White icon glyph, padded inside the circle.
  const PAD = 12;
  ctx.drawImage(iconImg, PAD, PAD, SIZE - PAD * 2, SIZE - PAD * 2);

  const bmp = await createImageBitmap(canvas);
  map.addImage(name, bmp, { pixelRatio: 2 });
}

// ---------- main entry ----------

export async function addDataLayers(map, beforeId = undefined) {
  // Local helper so every layer we add slots in just below the basemap labels.
  const add = (layer) => map.addLayer(layer, beforeId);
  // ---------- icon loads (parallel) ----------
  await Promise.all([
    loadMaterialIcon(map, 'wc',            '#3aa0ff'),  // park restrooms
    loadMaterialIcon(map, 'groups',        '#1faa8d'),  // community centers
    loadMaterialIcon(map, 'local_library', '#d97506'),  // libraries
    loadMaterialIcon(map, 'train',         '#0091B3'),  // light rail stations
  ]);

  // ---------- sources ----------
  const sources = {
    kc_regional_trails: 'kc_regional_trails',
    multi_use_trails: 'multi_use_trails',
    bike_plus_network: 'bike_plus_network',
    bike_facilities: 'bike_facilities',
    bicycle_racks: 'bicycle_racks',
    bike_signs: 'bike_signs',
    parks_restrooms: 'parks_restrooms',
    community_centers: 'community_centers',
    libraries: 'libraries',
    light_rail_stations: 'light_rail_stations',
    // Routing prototype: visual-verification sources. All start hidden; users
    // toggle them on to sanity-check the data feeding the routing graph.
    signals: 'signals',
    crosswalks: 'crosswalks',
    beacons: 'beacons',
  };
  for (const [id, name] of Object.entries(sources)) {
    map.addSource(id, { type: 'geojson', data: DATA(name) });
  }

  // ---------- line layers, bottom -> top ----------

  // King County regional trails — dark green, dashed to differentiate from
  // Seattle's solid trails (though all green per spec).
  add({
    id: 'kc-regional-trails',
    type: 'line',
    source: 'kc_regional_trails',
    paint: {
      'line-color': DARK_GREEN,
      'line-width': GREEN_WIDTH,
      'line-dasharray': [3, 1.5],
    },
  });

  // SDOT Multi-Use Trails (Seattle) — dark green.
  add({
    id: 'multi-use-trails',
    type: 'line',
    source: 'multi_use_trails',
    paint: {
      'line-color': DARK_GREEN,
      'line-width': GREEN_WIDTH,
    },
  });

  // Bike+ Network — planned: dotted AND grayscale, so it reads visually
  // distinct from existing infrastructure.
  add({
    id: 'bike-plus-planned',
    type: 'line',
    source: 'bike_plus_network',
    filter: ['==', ['to-boolean', isProposed], true],
    paint: {
      'line-color': PLANNED_GRAY,
      'line-width': GREEN_WIDTH,
      'line-dasharray': DOTTED_DASH,
    },
  });

  // Bike+ Network — existing.
  add({
    id: 'bike-plus-existing',
    type: 'line',
    source: 'bike_plus_network',
    filter: ['!', ['to-boolean', isProposed]],
    paint: {
      'line-color': BIKE_PLUS_COLORS,
      'line-width': GREEN_WIDTH,
    },
  });

  // ----- bike_facilities split by category and INSVC vs UNDERCONS -----
  // Each pair is one toggleable category. AAA = NGW + PBL + OFFST (dark green).

  // AAA — installed
  add({
    id: 'bike-facilities-aaa',
    type: 'line',
    source: 'bike_facilities',
    filter: ['all', INSTALLED_FILTER, inCats(AAA_CATS)],
    paint: { 'line-color': DARK_GREEN, 'line-width': GREEN_WIDTH },
  });
  // AAA — under construction (dotted)
  add({
    id: 'bike-facilities-construction-aaa',
    type: 'line',
    source: 'bike_facilities',
    filter: ['all', UNDERCONS_FILTER, inCats(AAA_CATS)],
    paint: {
      'line-color': DARK_GREEN, 'line-width': GREEN_WIDTH,
      'line-dasharray': DOTTED_DASH,
    },
  });

  // BBL — installed
  add({
    id: 'bike-facilities-bbl',
    type: 'line',
    source: 'bike_facilities',
    filter: ['all', INSTALLED_FILTER, inCats(BBL_CATS)],
    paint: { 'line-color': MEDIUM_GREEN, 'line-width': GREEN_WIDTH },
  });
  add({
    id: 'bike-facilities-construction-bbl',
    type: 'line',
    source: 'bike_facilities',
    filter: ['all', UNDERCONS_FILTER, inCats(BBL_CATS)],
    paint: {
      'line-color': MEDIUM_GREEN, 'line-width': GREEN_WIDTH,
      'line-dasharray': DOTTED_DASH,
    },
  });

  // BL — installed
  add({
    id: 'bike-facilities-bl',
    type: 'line',
    source: 'bike_facilities',
    filter: ['all', INSTALLED_FILTER, inCats(BL_CATS)],
    paint: { 'line-color': LIGHT_GREEN, 'line-width': GREEN_WIDTH },
  });
  add({
    id: 'bike-facilities-construction-bl',
    type: 'line',
    source: 'bike_facilities',
    filter: ['all', UNDERCONS_FILTER, inCats(BL_CATS)],
    paint: {
      'line-color': LIGHT_GREEN, 'line-width': GREEN_WIDTH,
      'line-dasharray': DOTTED_DASH,
    },
  });

  // Sharrows + climbing lanes — narrow orange.
  add({
    id: 'bike-facilities-narrow',
    type: 'line',
    source: 'bike_facilities',
    filter: ['all', INSTALLED_FILTER, inCats(NARROW_CATS)],
    paint: { 'line-color': ORANGE, 'line-width': ORANGE_WIDTH },
  });
  add({
    id: 'bike-facilities-construction-narrow',
    type: 'line',
    source: 'bike_facilities',
    filter: ['all', UNDERCONS_FILTER, inCats(NARROW_CATS)],
    paint: {
      'line-color': ORANGE, 'line-width': ORANGE_WIDTH,
      'line-dasharray': DOTTED_DASH,
    },
  });


  // ---------- point layers ----------

  // Bike racks — small dark dots; visible at every zoom, tiny far out.
  // INSVC + PLNRECON (slated for upgrade but currently installed).
  add({
    id: 'bike-racks',
    type: 'circle',
    source: 'bicycle_racks',
    filter: ['in', ['get', 'CURRENT_STATUS'], ['literal', ['INSVC', 'PLNRECON']]],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 13, 2, 17, 4],
      'circle-color': '#333',
      'circle-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.3, 13, 0.7],
    },
  });

  // Bike route signs — blue dots a bit larger than bike-rack dots; all zooms.
  add({
    id: 'bike-signs',
    type: 'circle',
    source: 'bike_signs',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 0.7, 13, 2.5, 17, 5],
      'circle-color': '#1e88e5',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12, 0, 14, 0.5],
      'circle-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.35, 14, 0.85],
    },
  });

  // ---------- symbol (Material icon) layers ----------

  add({
    id: 'parks-restrooms',
    type: 'symbol',
    source: 'parks_restrooms',
    // In-service only: open to public, lifecycle 'A' (active), not closed.
    filter: ['all',
      ['==', ['get', 'OPENTOPUBLIC'], 'YES'],
      ['==', ['get', 'LIFECYCLESTATUSTXT'], 'A'],
      ['!=', ['get', 'CURRENTSTATUS'], 'CLOSED'],
    ],
    layout: {
      'icon-image': 'wc',
      'icon-size': POI_ICON_SIZE,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });

  add({
    id: 'community-centers',
    type: 'symbol',
    source: 'community_centers',
    filter: ['==', ['get', 'OPERATIONALSTATUS'], 'Open Regular Hours'],
    layout: {
      'icon-image': 'groups',
      'icon-size': POI_ICON_SIZE,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });

  add({
    id: 'libraries',
    type: 'symbol',
    source: 'libraries',
    layout: {
      'icon-image': 'local_library',
      'icon-size': POI_ICON_SIZE,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });

  // Light rail stations on top.
  add({
    id: 'light-rail-stations',
    type: 'symbol',
    source: 'light_rail_stations',
    layout: {
      'icon-image': 'train',
      'icon-size': POI_ICON_SIZE,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });

  // ---------- routing-prototype debug layers ----------
  // All hidden by default; toggleable. Owner uses these to spot-check that
  // the SDOT classifications we route on (alleys, signal-controlled
  // intersections, marked crosswalks, beacons) match what's actually on
  // the street.

  add({
    id: 'signals-debug',
    type: 'circle',
    source: 'signals',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 4.5],
      'circle-color': '#ff3030',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1,
      'circle-opacity': 0.9,
    },
    layout: { visibility: 'none' },
  });

  add({
    id: 'crosswalks-debug',
    type: 'circle',
    source: 'crosswalks',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 1, 14, 2.6],
      'circle-color': '#ffd400',
      'circle-stroke-color': '#7a5d00',
      'circle-stroke-width': 0.6,
      'circle-opacity': 0.85,
    },
    layout: { visibility: 'none' },
  });

  add({
    id: 'beacons-debug',
    type: 'circle',
    source: 'beacons',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 5],
      'circle-color': '#a020f0',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1,
      'circle-opacity': 0.9,
    },
    layout: { visibility: 'none' },
  });
}
