// Canonical road-name abbreviation rules for Seattle. One source of truth
// for three surfaces:
//   - src/search/addr_search.js  — search index entries + user queries
//   - src/routing/directions.js  — turn-by-turn instruction text
//   - src/labels.js              — basemap road labels (drives the
//                                  MapLibre expression off these same
//                                  constants)
//
// The MapLibre expression in labels.js has to be hand-built (MapLibre
// style values are expression trees, not JS function calls) — but it
// reads from the same DIRECTIONALS / STREET_SUFFIXES lists below so it
// stays in lock-step with the JS normalizer used by the other two
// surfaces.

// Compound directions listed before singles so the generated MapLibre
// case-arms read top-down longest-first. Both forms end with a space
// when matched as a prefix so single-word "North " never shadows
// "Northwest " in practice, but the explicit ordering keeps the source
// readable.
export const DIRECTIONALS = [
  ['Northwest', 'NW'], ['Northeast', 'NE'],
  ['Southwest', 'SW'], ['Southeast', 'SE'],
  ['North', 'N'], ['South', 'S'],
  ['East', 'E'],  ['West', 'W'],
];

// Street-type suffixes, ordered longest-first for the same readability
// reason. "Way" is intentionally absent — already short, and "X Way"
// appears so often as a literal place name (Aurora Ave, Sand Point Way)
// that no abbreviation is desired.
export const STREET_SUFFIXES = [
  ['Boulevard', 'Blvd'],
  ['Parkway',   'Pkwy'],
  ['Highway',   'Hwy'],
  ['Terrace',   'Ter'],
  ['Avenue',    'Ave'],
  ['Street',    'St'],
  ['Place',     'Pl'],
  ['Drive',     'Dr'],
  ['Court',     'Ct'],
  ['Road',      'Rd'],
  ['Lane',      'Ln'],
];

// Global word-boundary regex pass. Seattle road names use directionals
// only at the very start or end of the string, and street types only at
// the end (or right before a trailing directional). For those positions
// the global replace produces identical output to the positional
// MapLibre expression in labels.js, while staying readable. Word
// boundaries keep "Streetside" / "Northeastern" / "Eastland" from
// triggering. Case-insensitive on the input so a user typing
// "northeast 65th" still matches the index.
const REGEXES = [
  ...DIRECTIONALS.map(([full, abbr]) => [new RegExp(`\\b${full}\\b`, 'gi'), abbr]),
  ...STREET_SUFFIXES.map(([full, abbr]) => [new RegExp(`\\b${full}\\b`, 'gi'), abbr]),
];

export function normalizeAddress(s) {
  if (!s) return s;
  let r = s;
  for (const [re, abbr] of REGEXES) r = r.replace(re, abbr);
  return r;
}
