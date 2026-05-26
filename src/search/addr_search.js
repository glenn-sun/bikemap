// Fully-offline address + POI search for route endpoints.
//
// Loads public/data/addr_index.json (built by scripts/build_addr_index.py
// from OSM via Overpass), builds a FlexSearch Document index keyed on the
// `t` (text) field, and exposes `search(query, opts)` for the UI's
// autocomplete dropdown. No external API calls.
//
// Index record schema (see build_addr_index.py):
//   { i: <number>, k: 'a'|'p', t: <label>, c: <category|undefined>,
//     x: <lon>, y: <lat> }

import FlexSearch from 'flexsearch';

const INDEX_URL = `${import.meta.env.BASE_URL}data/addr_index.json`;

// Display-and-search normalization: Seattle's OSM addresses mix the
// long ("Northeast 65th Street") and abbreviated ("NE 65th St") forms
// of directionals and street types, sometimes in the same record
// ("Northeast 65th Street & Wellesley Way Northeast"). Collapsing
// both to the abbreviated form makes the dropdown consistent AND lets
// a query typed in either form match the index.
const ABBREVIATIONS = [
  // Directionals — apply two-word forms before single-word ones so
  // "Northeast" doesn't tokenize to "N E".
  [/\bnortheast\b/gi, 'NE'],
  [/\bnorthwest\b/gi, 'NW'],
  [/\bsoutheast\b/gi, 'SE'],
  [/\bsouthwest\b/gi, 'SW'],
  [/\bnorth\b/gi,     'N'],
  [/\bsouth\b/gi,     'S'],
  [/\beast\b/gi,      'E'],
  [/\bwest\b/gi,      'W'],
  // Common street-type suffixes — same rationale: OSM is inconsistent
  // between "Street" and "St", "Avenue" and "Ave", etc.
  [/\bstreet\b/gi,    'St'],
  [/\bavenue\b/gi,    'Ave'],
  [/\bboulevard\b/gi, 'Blvd'],
  [/\bparkway\b/gi,   'Pkwy'],
  [/\bhighway\b/gi,   'Hwy'],
  [/\bterrace\b/gi,   'Ter'],
  [/\bplace\b/gi,     'Pl'],
  [/\bdrive\b/gi,     'Dr'],
  [/\bcourt\b/gi,     'Ct'],
  [/\broad\b/gi,      'Rd'],
  [/\blane\b/gi,      'Ln'],
];

export function normalizeAddress(s) {
  if (!s) return s;
  let r = s;
  for (const [re, abbr] of ABBREVIATIONS) r = r.replace(re, abbr);
  return r;
}

let loadPromise = null;   // resolves to { records, index } on first call

function ensureLoaded() {
  if (loadPromise) return loadPromise;
  loadPromise = fetch(INDEX_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`addr_index: HTTP ${r.status}`);
      return r.json();
    })
    .then((records) => {
      // Tokenize on "forward" so prefix typing like "Cal And" matches
      // "Cal Anderson Park"; cache resolutions so repeated keystrokes are
      // sub-ms; soundex-style suggest=true so single-char typos still match.
      const index = new FlexSearch.Index({
        tokenize: 'forward',
        cache: true,
        resolution: 9,
      });
      for (const r of records) {
        if (r.t) r.t = normalizeAddress(r.t);
        if (r.a) r.a = normalizeAddress(r.a);
        index.add(r.i, r.t);
      }
      console.log(`[addr_search] indexed ${records.length.toLocaleString()} records`);
      return { records, index };
    });
  return loadPromise;
}

/** Kick off the index load eagerly (e.g. on app boot) so by the time the
 *  user clicks an input box the data is already there. */
export function preloadAddrIndex() {
  ensureLoaded().catch((err) => console.warn('[addr_search] preload failed:', err));
}

/**
 * Search the address+POI index.
 *
 * @param query  user input string
 * @param opts.limit         max results (default 6)
 * @param opts.mapCenter     [lon, lat] for proximity tie-breaker (optional)
 * @returns Promise<Array<{ id, kind, label, category, lon, lat }>>
 */
export async function searchAddresses(query, opts = {}) {
  const limit = opts.limit ?? 6;
  const mapCenter = opts.mapCenter ?? null;
  const trimmed = String(query || '').trim();
  if (trimmed.length < 2) return [];
  const { records, index } = await ensureLoaded();
  // Normalize so "Northeast" and "Street" match the abbreviated index.
  const q = normalizeAddress(trimmed);
  // Search slightly wider than limit so we have room to rank by proximity.
  const ids = index.search(q, limit * 4);
  if (!ids.length) return [];
  let hits = ids.map((i) => records[i]).filter(Boolean);

  // Rank: POIs above addresses, then by proximity to mapCenter (if given),
  // then by raw FlexSearch order (stable). Apply *after* fetching wider set.
  if (mapCenter) {
    const [cx, cy] = mapCenter;
    hits.forEach((h) => {
      const dx = (h.x - cx) * 0.7;     // crude lon scale at lat 47.6°
      const dy = h.y - cy;
      h._distSq = dx * dx + dy * dy;
    });
  }
  hits.sort((a, b) => {
    if (a.k !== b.k) return a.k === 'p' ? -1 : 1;
    if (mapCenter && a._distSq !== b._distSq) return a._distSq - b._distSq;
    return 0;
  });
  return hits.slice(0, limit).map((h) => {
    // For POIs, snapTo the nearest STREET ADDRESS coords when available —
    // a POI's own centroid can be inside a building footprint or a park
    // where the only nearby graph edges form a disconnected trail island.
    // Using the assigned address's coordinates pins it to a real street.
    const snapLon = h.k === 'p' && typeof h.ax === 'number' ? h.ax : h.x;
    const snapLat = h.k === 'p' && typeof h.ay === 'number' ? h.ay : h.y;
    return {
      id: h.i,
      kind: h.k === 'p' ? 'poi' : 'addr',
      label: h.t,
      category: h.c || null,
      address: h.a || null,
      // Display coords (used for the green/red pin) stay at the POI centroid
      // so the pin lands on the building. Snap coords nudge to the street.
      lon: h.x,
      lat: h.y,
      snapLon,
      snapLat,
    };
  });
}
