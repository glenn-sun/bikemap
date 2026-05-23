// Hand-rolled basemap label layers.
//
// @protomaps/basemaps@5.7.x ships no label layers — `layers()` returns only
// fills/lines/background. The pmtiles we extracted does carry `name` on
// roads, places, water, and POIs (verified via `pmtiles show --metadata`),
// so we author symbol layers directly against those source layers.
//
// Fonts come from protomaps.github.io/basemaps-assets/fonts (key-free).

const TEXT_HALO_COLOR = 'rgba(255,255,255,0.95)';
const PRIMARY_TEXT    = '#3a3a3a';
const PLACE_TEXT      = '#222';
const WATER_TEXT      = '#3f7fa0';

// Compound directions checked first so "North " (single) doesn't shadow
// "Northwest " — both end with a space so a single won't match a compound
// prefix anyway, but ordering keeps the generated expression readable.
const DIRECTIONALS = [
  ['Northwest', 'NW'], ['Northeast', 'NE'],
  ['Southwest', 'SW'], ['Southeast', 'SE'],
  ['North', 'N'], ['South', 'S'],
  ['East', 'E'],  ['West', 'W'],
];

// Wrap a name expression so that directional words at the start or end of
// the string become their abbreviations. MapLibre has no regex / string-
// replace, so we chain `case` arms over `index-of` / `slice` / `concat`.
// Structure: let n = name; let p = (prefix-swap n); (suffix-swap p).
// Shallow (two `let` bindings) — deep-nested `let` with shadowed names
// breaks MapLibre's initial style validation.
function abbreviateDirectionals(nameExpr) {
  const prefixCase = (input) => {
    const args = [];
    for (const [full, abbr] of DIRECTIONALS) {
      const p = full + ' ';
      args.push(['==', ['index-of', p, input], 0]);
      args.push(['concat', abbr + ' ', ['slice', input, p.length]]);
    }
    return ['case', ...args, input];
  };
  const suffixCase = (input) => {
    const args = [];
    for (const [full, abbr] of DIRECTIONALS) {
      const sfx = ' ' + full;
      args.push(['all',
        ['>=', ['length', input], sfx.length],
        ['==', ['slice', input, ['-', ['length', input], sfx.length]], sfx]]);
      args.push(['concat',
        ['slice', input, 0, ['-', ['length', input], sfx.length]],
        ' ' + abbr]);
    }
    return ['case', ...args, input];
  };
  return ['let', 'n', nameExpr,
    ['let', 'p', prefixCase(['var', 'n']),
      suffixCase(['var', 'p'])]];
}

const ROAD_NAME = abbreviateDirectionals(['get', 'name']);

/**
 * Returns the label layer array to append on top of the basemap fills/lines.
 * Pass the same source name used for the pmtiles vector source.
 */
export function basemapLabelLayers(source = 'protomaps') {
  return [
    // ---------- Place labels (cities, neighborhoods, suburbs) ----------
    {
      id: 'places_country',
      type: 'symbol',
      source,
      'source-layer': 'places',
      filter: ['==', ['get', 'kind'], 'country'],
      minzoom: 2,
      maxzoom: 6,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Medium'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 5, 14],
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.08,
      },
      paint: { 'text-color': PRIMARY_TEXT, 'text-halo-color': TEXT_HALO_COLOR, 'text-halo-width': 1.2 },
    },
    {
      id: 'places_city',
      type: 'symbol',
      source,
      'source-layer': 'places',
      filter: ['==', ['get', 'kind'], 'locality'],
      minzoom: 6,
      maxzoom: 13,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Medium'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 6, 11, 12, 18],
      },
      paint: { 'text-color': PLACE_TEXT, 'text-halo-color': TEXT_HALO_COLOR, 'text-halo-width': 1.5 },
    },
    {
      id: 'places_neighbourhood',
      type: 'symbol',
      source,
      'source-layer': 'places',
      filter: ['in', ['get', 'kind'], ['literal', ['neighbourhood', 'suburb', 'quarter']]],
      minzoom: 12,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 14],
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.06,
      },
      paint: { 'text-color': '#555', 'text-halo-color': TEXT_HALO_COLOR, 'text-halo-width': 1.2 },
    },

    // ---------- Water labels (lakes, bays) ----------
    {
      id: 'water_labels',
      type: 'symbol',
      source,
      'source-layer': 'water',
      filter: ['all', ['has', 'name'], ['!=', ['get', 'kind'], 'stream']],
      minzoom: 9,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Italic'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 14, 14],
      },
      paint: { 'text-color': WATER_TEXT, 'text-halo-color': 'rgba(255,255,255,0.7)', 'text-halo-width': 1 },
    },

    // ---------- Road labels ----------
    // Highways (placed first so other labels can leapfrog if overlapping).
    {
      id: 'roads_highway_label',
      type: 'symbol',
      source,
      'source-layer': 'roads',
      filter: ['all', ['==', ['get', 'kind'], 'highway'], ['has', 'name']],
      minzoom: 11,
      layout: {
        'text-field': ROAD_NAME,
        'text-font': ['Noto Sans Medium'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 16, 13],
        'symbol-placement': 'line',
        'text-pitch-alignment': 'viewport',
      },
      paint: { 'text-color': PRIMARY_TEXT, 'text-halo-color': TEXT_HALO_COLOR, 'text-halo-width': 1.5 },
    },
    {
      id: 'roads_major_label',
      type: 'symbol',
      source,
      'source-layer': 'roads',
      filter: ['all', ['==', ['get', 'kind'], 'major_road'], ['has', 'name']],
      minzoom: 12,
      layout: {
        'text-field': ROAD_NAME,
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 12, 9, 17, 13],
        'symbol-placement': 'line',
      },
      paint: { 'text-color': PRIMARY_TEXT, 'text-halo-color': TEXT_HALO_COLOR, 'text-halo-width': 1.3 },
    },
    {
      id: 'roads_minor_label',
      type: 'symbol',
      source,
      'source-layer': 'roads',
      filter: ['all', ['==', ['get', 'kind'], 'minor_road'], ['has', 'name'],
               ['!=', ['get', 'kind_detail'], 'service']],
      minzoom: 14,
      layout: {
        'text-field': ROAD_NAME,
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 14, 9, 18, 12],
        'symbol-placement': 'line',
      },
      paint: { 'text-color': '#555', 'text-halo-color': TEXT_HALO_COLOR, 'text-halo-width': 1.2 },
    },
  ];
}
