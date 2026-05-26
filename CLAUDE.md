# CLAUDE.md — Bikemap

Notes for future Claude sessions working on this project. Read this first.

## Project at a glance

Static site (GitHub Pages target) showing Seattle bike infrastructure on a
MapLibre GL JS + Protomaps PMTiles basemap. No API keys anywhere — data
is snapshotted from SDOT + King County ArcGIS REST as GeoJSON; basemap is
a Seattle-area `.pmtiles` extract committed to the repo. Address +
POI search is fully offline (OSM via Overpass → FlexSearch index).

The owner uses it to navigate Seattle by bike and wants visual nuance the
official ArcGIS Experience map lacks. Built on macOS / arm64. Aimed at
becoming a PWA — the offline-first stance and explicit data downloads
support that.

## Working with the owner

- **AskUserQuestion is welcome.** Use it freely to clarify intent or pick
  between approaches.
- **The owner verifies UI themselves and is faster at it than you are.**
  Once the basics render, don't burn cycles in `preview_screenshot` loops
  or repeated `preview_eval` retries — ship the change and let them tell
  you what's off. They explicitly asked for code velocity over agent-side
  visual testing. Use `npx vite build` as a quick syntax sanity check
  instead.
- **Reuse the owner's terminology.** "AAA" = all ages & abilities (= dark
  green tier). "Planned" = Bike+ Network proposals. "Twist" = the small
  weight-shift variations of the active preset that produce route
  alternates ("Quieter", "More direct"). Don't invent synonyms.
- **When the owner corrects you, accept it — they have ground truth.**
  Multiple times this project I've made confident claims from indirect
  signals that turned out to be wrong; each time the owner corrected me
  with field knowledge. Before claiming a data quality gap (or any
  empirical claim about Seattle), measure against ground truth (parcels,
  permits, the owner's local knowledge). See `memory/MEMORY.md`.
- **Tell them how to verify your work** at the end of each task. Usually:
  what to look at on `http://localhost:5173`, what to click.
- **Python: always venv.** `.venv/` is already in `.gitignore`.

## Layout

```
src/main.js        Orchestrator: pmtiles protocol, style assembly, glue;
                   loads + persists checkbox state to localStorage;
                   wires layers FAB → toggling #layers-panel `.open`
                   class (mobile overlay)
src/sheet.js       Mobile bottom-sheet controller (active only when
                   @media (max-width: 719px) matches). Pointer-drag with
                   2 snap points (peek/full), velocity-biased snap,
                   tap-to-toggle. Exports initSheet() + snapSheet(name).
                   No-ops on desktop. Other modules call snapSheet() to
                   collapse/expand the sheet at the right moments
                   (popup open → peek, address-input focus → full,
                   choose-on-map → peek). Sets #left-stack maxHeight
                   per-snap so the bottom of long step lists is
                   reachable.
src/layers.js      Every SDOT/KC data layer; paint/filter expressions; icon loader
src/basemap.js     Walks Protomaps layer paint and HSL-desaturates colors
src/labels.js      Hand-rolled symbol layers for road/place/water names;
                   exports abbreviateDirectionalsStr for the directions panel
src/visibility.js  Multi-group visibility manager; onChange callback for
                   localStorage persistence; bindCheckbox(group, id, persisted)
                   restores state at bind time
src/popups.js      Per-layer click popup formatters + code decoders;
                   suppresses when isChoosingOnMap() OR when click also
                   intersects a route line (via queryRenderedFeatures)
src/style.css      All app styles
src/search/        addr_search.js — offline FlexSearch wrapper around
                   addr_index.json. preloadAddrIndex(), searchAddresses()
src/routing/       Client-side routing:
                     graph.js       Loader + spatial indexes + connected-
                                    components precompute (snap filters out
                                    isolated trail islands); also exposes
                                    nodeElev / edgeUphillFt / edgeElevProfile
                     cost.js        Slider → raw constants formulas;
                                    presets; twist definitions; elevation
                                    surcharge via uphillFtPenalty +
                                    steepBonusPerPct
                     astar.js       Binary-heap A* + findPathsMulti
                                    (primary + filtered twists)
                     signCoverage.js  Post-route sign-coverage multiplier
                     elevation.js   Per-route series builder, climb stats,
                                    elevationProfileSvg()
                     directions.js  Path → step list (unnamed-connector
                                    fill-in; classifyTurn)
                     mode.js        Tiny shared bus for "choose on map" mode
                     ui.js          Inputs, autocomplete, settings modal,
                                    tabs, alts, choose-on-map, graph debug,
                                    elevation chart in directions panel

public/data/       Snapshot GeoJSON (regenerable; see fetch_data.py)
public/data/seattle_polygon.geojson   Seattle boundary from OSM (used for clipping)
public/data/routing_graph.json        Routable graph + per-node/per-geom
                                       elevation + heat-eq corrections
                                       (~11 MB, see build_graph.py →
                                       sample_dtm.py → resolve_elevation.py).
public/data/contours.geojson          25-ft elevation contour lines
                                       (~1.7 MB; `index=1` flag for thicker
                                       every-100ft). Re-extracted from the
                                       RAW (unsmoothed) DTM by sample_dtm.py.
public/data/addr_index.json           OSM addresses + POIs index (~19 MB,
                                       see build_addr_index.py)
public/tiles/seattle.pmtiles          Basemap extract (~62 MB)

scripts/fetch_data.py        ArcGIS REST → GeoJSON, clipped to Seattle polygon
scripts/build_graph.py       Overpass + SDOT joins → public/data/routing_graph.json
                              (also: 2D-crossing detection, approach BFS)
scripts/sample_dtm.py        Stream USGS 3DEP DTM via /vsicurl/. Denoise
                              (5×5 median + σ=2 Gaussian), bilinear-sample
                              nodes + geom vertices, uniform-resample
                              profiles to 75-ft sub-segments, compute
                              per-edge climb metrics → routing_graph.json.
                              Also extract 25-ft contours from the RAW
                              DTM → contours.geojson. Caches Seattle window
                              to dtm_cache/ (~32 MB, .gitignored).
scripts/resolve_elevation.py Heat-equation elevation correction for
                              every flagged-subgraph group with ≥1
                              boundary node. Solves the discrete
                              Dirichlet problem on the flagged-only
                              adjacency with boundary elevations fixed
                              at their (trustworthy) DTM values.
                              Overwrites interior node elevations,
                              linear-interps each flagged geom's
                              per-vertex profile between the corrected
                              endpoints, and recomputes per-edge
                              uphillFt/maxUphillPct/steepFt2 analytically
                              (linear profile → constant slope).
scripts/build_addr_index.py  Overpass addr:housenumber + named POIs → public/data/addr_index.json
scripts/make_basemap.sh      pmtiles extract for Seattle bbox

public/data/stop_signs.geojson  SDOT R1-1 stop signs with FACING dir
                                 (used by build_graph.py Step F to zero
                                 the crossing penalty when cross traffic
                                 is stopped)

vite.config.js     base: './'  (works under any GH Pages subpath)
```

The original implementation plan is at
`/Users/glennsun/.claude/plans/i-accidentally-missed-some-imperative-waterfall.md`
(yes that filename — don't rename). It captures the initial scaffolding
decisions but does not reflect later iterations. This doc is authoritative
for the current state.

## Quickstart

```bash
npm install
npm run dev    # http://localhost:5173
```

**Refresh data**:
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install requests shapely numpy rasterio scipy scikit-image
python3 scripts/fetch_data.py          # SDOT/KC layers → public/data/*.geojson
python3 scripts/build_graph.py         # OSM (Overpass) + SDOT joins → routing_graph.json
python3 scripts/sample_dtm.py          # smoothed DTM + resampling → nodes.elev[]/geomElevs[]/edge climb + contours.geojson
python3 scripts/resolve_elevation.py   # heat-eq smoothing on flagged subgraph → rewrites nodes.elev/geomElevs + edge climb metrics
python3 scripts/build_addr_index.py    # OSM addresses + named POIs → addr_index.json
python3 scripts/build_data_manifest.py # PWA: hash+size+gzipSize → public/data/version.json (MUST run last)
```
`build_graph.py` reads the GeoJSONs `fetch_data.py` writes, so run them
in order. `sample_dtm.py` reads the graph that `build_graph.py` writes
and updates elevation in place — re-run it whenever the graph rebuilds.
`resolve_elevation.py` reads what `sample_dtm.py` wrote and again
overwrites in place — re-run it any time the elevation data changes,
because sample_dtm will wipe the heat-eq corrections otherwise.
`build_addr_index.py` is independent of the graph scripts but reads
`seattle_polygon.geojson` (`fetch_data.py` creates it). Overpass queries
are bbox-only; full Seattle pulls take 30–90 s each (the fetch is
retried across 4 mirror endpoints because overpass-api.de often
504s). Output sizes: routing_graph ~11 MB, contours ~1.7 MB, addr_index
~19 MB.

**Elevation overview.** Two-stage offline pipeline writes the
elevation fields consumed by `cost.js`, the directions-panel chart,
`climbStats`, and the Street Slopes debug overlay. Stage 1
(`sample_dtm.py`) bilinear-samples a smoothed + uniform-resampled
USGS 3DEP DTM. Stage 2 (`resolve_elevation.py`) applies heat-equation
correction over every flagged-subgraph group connected to the
routable network — fixing the systematic "DTM reads water under
the bridge deck" errors. See the "Elevation pipeline" section below
for details, schema, and lessons.

**Refresh basemap**:
```bash
bash scripts/make_basemap.sh <YYYYMMDD>
```
Pick a date from build.protomaps.com — only the last ~3 days are hosted.
Output is ~60 MB.

## Data facts (verified in the field)

All SDOT layers come from ArcGIS org `ZOyb2t4B0UYuYNYH` (Seattle / SDOT).
King County trails come from `gisdata.kingcounty.gov`.

**`Seattle_City_Limits` is polylines (north + south boundaries only), not
a polygon.** Don't try to use it for clipping. Use the OSM-sourced
`public/data/seattle_polygon.geojson` instead (Nominatim; cached on first run).

### `bike_facilities.CURRENT_STATUS`

| Code | Meaning | Render |
|---|---|---|
| `INSVC` | In service | Solid in category color |
| `PLNRECON` | **In service today**, upgrade planned later | Solid in category color (same as INSVC) |
| `UNDERCONS` | Being built right now | Dotted `[1, 2]` in category color |
| anything else (null, blank) | Out of service | Hidden |

PLNRECON is **owner-verified to mean "exists, planned for upgrade"**, not
"planned from scratch". Treat it as in-service; popup says "In service ·
upgrade planned". Brand-new future network lives in `bike_plus_network`
with `bike_network_category` starting with "Proposed".

### `bike_facilities.CATEGORY` tiers

| Code | Plain English | Color | Visibility group |
|---|---|---|---|
| `BKF-NGW` | Neighborhood greenway | `DARK_GREEN` `#1F6B3D` | `aaa` |
| `BKF-PBL` | Protected bike lane | `DARK_GREEN` | `aaa` |
| `BKF-OFFST` | Off-street path | `DARK_GREEN` | `aaa` |
| `BKF-BBL` | Buffered bike lane | `MEDIUM_GREEN` `#3FA85F` | `bbl` |
| `BKF-BL` | Bike lane | `LIGHT_GREEN` `#7FCC9C` | `bl` |
| `BKF-CLMB` | Climbing lane | `ORANGE` `#E07A1F` (narrower) | `sharrows` |
| `BKF-SHW` | Sharrow | `ORANGE` (narrower) | `sharrows` |

### Filters

Applied at MapLibre layer level (data complete, reversible):
- `parks_restrooms`: `OPENTOPUBLIC = 'YES'` AND `LIFECYCLESTATUSTXT = 'A'` AND `CURRENTSTATUS != 'CLOSED'`
- `community_centers`: `OPERATIONALSTATUS = 'Open Regular Hours'`
- `bicycle_racks`: `CURRENT_STATUS IN ('INSVC', 'PLNRECON')`

Applied at fetch time in `scripts/fetch_data.py` (matches the SDOT
experience, shrinks the snapshot):
- `bike_signs`: `CATEGORY = 'GBP' AND CURRENT_STATUS IN ('INSVC') OR NULL`
- `light_rail_stations`: `STATUS = 'COMPLETE'`
- `kc_regional_trails`: `Surf_Type IN ('Paved Trail','On Street Trail') AND Owner NOT LIKE '%Seattle%' AND Trail_Type = 'Trail (Regional)'`

## Gotchas (the time-savers)

### Tooling

- **`brew install pmtiles`** — straight from homebrew-core. The old
  `protomaps/tap/pmtiles` tap has been removed and will fail.
- **npm `pmtiles` is at `^4.4.1`**, not v5. Don't get confused by the
  MapLibre style spec version which is unrelated.
- **Direct GitHub binary downloads can be blocked** by the harness
  classifier in autonomous mode. Use brew or apt instead.

### `@protomaps/basemaps` (5.7.x)

- **`layers(src, flavor)` returns ZERO label layers.** The `labelsOnly`
  option also returns nothing. **Labels are hand-written** — see
  `src/labels.js`, pulling from the pmtiles source layers (`roads`,
  `places`, `water` with their `name` field).
- Glyphs URL that works without a key:
  `https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf`.
  Known-good fontstacks: `Noto Sans Regular`, `Noto Sans Medium`,
  `Noto Sans Italic`. No fontstack-fallback chain needed.

### MapLibre GL JS

- **`line-width` can't contain a `match` with nested zoom `interpolate`s.**
  Error: "Only one zoom-based step/interpolate subexpression may be used in
  an expression." Solution: split into multiple layers each with its own
  `filter`. This is why we have eight bike-facility sub-layers instead of one.
- `m.style.sourceCaches` is **`m.style.tileManagers` in v5.x**. Don't
  trust old SO answers.
- `m.getStyle()` returns `undefined` until style loads. Poll
  `m.isStyleLoaded()`.
- **CSS `filter: saturate()` on `.maplibregl-canvas` affects the data
  layers too** — wrong move. Walk the basemap layers' paint and recompute
  colors in HSL space instead (see `src/basemap.js`).
- **Deeply nested `let` with shadowed variable names breaks initial-style
  validation but passes `setLayoutProperty`.** Hit this on the directional-
  abbreviation expression in `labels.js`. Fix: collapse the chain into ONE
  outer `let` whose body is a `case`, not nested `let`s.
- **For compass bearings, NEGATIVE delta means LEFT turn.** Bearings are
  clockwise (N=0, E=90, S=180, W=270). Heading east (90°) and rotating to
  head north (0°) gives `delta = -90` — counter-clockwise = LEFT in driving
  convention. Easy to flip; `classifyTurn` originally had it backwards.
- **`map.on('click', 'layer-x', ...)` fires INDEPENDENTLY of other layer
  click handlers — `preventDefault()` does not stop them.** Two
  consequences in `src/popups.js`:
  1. **To suppress popups for layers underneath a clicked route line**,
     use `map.queryRenderedFeatures(e.point, { layers: ['route-line',
     'route-alt-line'] })` and early-return when any feature is found.
  2. **To ensure only one popup opens per click** when multiple POI /
     bike-facility layers stack at the same pixel, register ONE global
     `map.on('click', ...)` handler that runs `queryRenderedFeatures`
     over all clickable layers and shows the topmost feature only
     (`features[0]`). Per-layer click handlers fire independently and
     each would open its own popup. Cursor-style hover handlers still
     bind per-layer (they're naturally layer-scoped).

### Preview server (`preview_*` tools)

- **`isStyleLoaded()` sometimes stays `false` forever after a `location.reload()`
  via `preview_eval`.** This isn't a code bug — the preview harness gets
  stuck mid-load. Workaround: `preview_stop` then `preview_start` for a
  clean session, instead of relying on reloads. Caching: vite + the
  preview test browser tend to behave better on a fresh boot.
- `preview_console_logs` returns stale entries with old vite `?t=`
  timestamps that look live. For a clean state, use
  `location.replace(origin + '/')`.
- **Viewport often collapses to 0×0 on a fresh `preview_start`.** Check
  `window.innerHeight`; if 0 or 1, call `preview_resize` with explicit
  `width: 1280, height: 800`. When the viewport is 0×0, MapLibre's style
  hangs in mid-load with `_loaded: false` and `stylesheet: null` and looks
  like a code bug. Always rule out viewport size first.
- **Synthetic clicks need a real DOM event on the canvas container**, not
  `map.fire('click', …)`. The fire approach throws inside MapLibre's
  internal click handler. Use:
  ```
  const canvas = map.getCanvasContainer();
  const rect = canvas.getBoundingClientRect();
  const evt = (type) => new MouseEvent(type, {
    bubbles:true, cancelable:true, view:window,
    clientX: rect.left + 700, clientY: rect.top + 400, button:0, buttons:1,
  });
  canvas.dispatchEvent(evt('mousedown')); canvas.dispatchEvent(evt('mouseup')); canvas.dispatchEvent(evt('click'));
  ```

### Data fetching

- `f=geojson&outSR=4326&geometryPrecision=6` works for both ArcGIS Online
  FeatureServer AND the older King County MapServer. Paginate with
  `resultOffset` + `resultRecordCount`.
- ArcGIS occasionally returns features with `null` geometry. `clip_features`
  skips them defensively.
- Nominatim TOS: real User-Agent. The fetch script uses
  `bikemap-prototype/0.1`. The Seattle polygon is cached after first fetch
  (`public/data/seattle_polygon.geojson`).
- **Slim wide layers with `out_fields` on the `Layer` dataclass.**
  `Seattle_Streets_1` returns 39 MB with `outFields=*`, only ~8 MB with
  the half-dozen fields we need.
- **Overpass via curl needs URL-encoded form data.** Multi-line POST body
  returns 406. Use `--data-urlencode 'data=…'`.

### Data traps

- **`Street_Network_Database_SND.SEGMENT_TYPE = 15` is NOT alleys.** Tiny
  micro-segments (median 6 m). For real Seattle alleys, OSM `highway=service`
  + `service=alley`. We exclude alleys from the routing graph in
  `_is_bike_routable` (`build_graph.py`), so they never enter at all.
- **`SDOT_Bike_Facilities` has no side-of-street field.** PBL on north +
  sharrow on south = two separate features. `MODEL_TYPE = BKF-ONEWAY` =
  one-way bike lane; only worth the turn-by-turn disclaimer when the road
  itself is two-way.
- **`SDOT_Traffic_Circles_view` is incomplete** (~1063 circles; missing
  23rd & NE 68th and others). `build_graph.py` runs `detect_geometric_circles`
  for short-edge cycles in the OSM topology — picks up ~1100 more.
- **`Seattle_Streets_1` doesn't have a lane-count field.** Derive from
  `SURFACEWIDTH`: `lanes = max(1, (SURFACEWIDTH - 7.5) / 10)` — assumes
  7.5 ft of parking on one side, 10 ft per moving lane. Fall back to
  ARTCLASS-based defaults when SURFACEWIDTH is null.
- **`Seattle_Streets_1.ARTCLASS = 0` means "Not Designated"** (residential
  local), not "missing data". `>= 1` is principal/minor/collector/state —
  our proxy for "this road has a painted centerline".

## Styling cheat sheet

| Concept | Style |
|---|---|
| AAA tier | Dark green `#1F6B3D`, solid, `GREEN_WIDTH` |
| BBL | Medium green `#3FA85F`, solid, `GREEN_WIDTH` |
| BL | Light green `#7FCC9C`, solid, `GREEN_WIDTH` |
| Sharrows / climbing | Orange `#E07A1F`, `ORANGE_WIDTH` (narrower) |
| Under construction (any tier) | Same color as installed equivalent, `DOTTED_DASH = [1, 2]` |
| Bike+ proposed | Gray `#9aa1a3`, dotted |
| Bike racks | Dark dot `#333`, radius 0.5→4 px from z9→z17 |
| Bike signs | Wayfinding brown `#6d4c41`, radius 0.7→5 px, white halo z14+ (moved off blue to avoid clashing with the user-location dot) |
| Stop signs (debug) | Stop-sign red `#c8102e`, 1.8→4 px, white border |
| Large POI icons (restroom/library/community center/light rail) | Filled colored circle + white Material Symbols `fill1` glyph + drop shadow, `POI_ICON_SIZE` 0.45→0.9 |
| Routes — primary | Pink `#e91e63` line over white casing |
| Routes — alternates | Soft pink `#f48fb1` line over white casing (same widths as primary) |
| Step number badge | Pink `#e91e63` 24×24 circle, white 11px bold numeral, 2px white border, drop shadow. **Same rule** powers both the turn-by-turn `.route-step::before` and the on-map `.route-step-marker` — keep both in sync. |
| Graph debug (toggle) | Magenta-pink lines `#ff00aa` + small dark-pink nodes `#880e4f` |
| Elevation contours (toggle) | Brown `#9b7355` thin (every 25 ft, z12.5+) + darker brown `#7d5a3a` index (every 100 ft, z10.5+); italic "N ft" labels along index contours from z13.5+. Layer is added near the bottom of the data stack so bike infra and routes paint over it. |
| Elevation profile chart (in directions panel) | Brown filled area (`#cdb293` @ 0.55 alpha) under a `#6d4c41` outline; y-axis tick labels `9px #6d4c41`; "N ft total climb" / "X% steepest uphill" caption row below the chart. Uses the same brown family as the contour layer so chart-and-map are visibly the same domain. |
| UI chrome icons | Google Material Symbols Outlined (settings, home, work, my_location, near_me, swap_vert, close, directions) |
| UI chrome accent (all) | Pink `#e91e63` — address-input focus, settings slider accents, dropdown-option icons, the "Go" POI button, and the "Customize in Settings" link. Pale pink `#fce4ec` for option-row hover and active-tab background. One pink palette across the UI so it reads consistently with the route line. |
| User location dot | Standard Google-blue `#4285f4` filled circle, 11 px + white border (`.user-location-dot`); tracked live via `navigator.geolocation.watchPosition` in `routing/ui.js`. The blue POIs were shifted off this hue (restroom indigo `#3949ab`, light rail teal `#00838f`, bike-signs brown `#6d4c41`) so the user marker reads as the standard live-location indicator. |
| POI popup "Go" button | Pink `#e91e63` rectangle, white text + `directions` glyph; clicking calls `routeFromMyLocationTo(lon, lat, label)` exported by `routing/ui.js`. |

Basemap saturation factor: **0.55** (in `main.js`).

`POI_ICON_SIZE`, `GREEN_WIDTH`, `ORANGE_WIDTH`, `DOTTED_DASH` are exported
constants at the top of `src/layers.js`.

**Route-line stacking.** All four route layers (alt casing/line + primary
casing/line) are inserted with `beforeId='kc-regional-trails'` so they
paint *below* every bike-infra layer. Where the route follows AAA / BBL /
BL / sharrow infrastructure, the tier color shows through and the
(slightly wider) white casing forms a halo around it; where there's no
infra, the pink route line is fully visible. Pink was chosen specifically
to contrast with all the greens (an earlier purple `#7e3ff2` clashed).
The same pink is now used for every UI accent (focus rings, slider
accents, the Go button on POI popups), so there is no remaining purple
in the app.
Click handlers on the route lines still work — MapLibre dispatches by
feature-hit, not z-order, so being below the infra doesn't disable
"click an alt to make it primary".

## Adding a new toggleable data layer

1. If source data is new, add to `LAYERS` in `scripts/fetch_data.py`
   and re-run.
2. In `addDataLayers` (`src/layers.js`):
   - `map.addSource(id, { type: 'geojson', data: DATA(name) })`
   - One or more `add({...})` calls — **use the local `add()` helper**, not
     `map.addLayer`, since it injects `beforeId` so labels stay on top.
3. In `wireToggles` (`src/main.js`):
   - `vm.group('newgroup', ['layer-id-1', ...])`
   - `.bindCheckbox('newgroup', 'toggle-newgroup', persisted)`
4. In `index.html`, add the checkbox inside the appropriate `<fieldset>`
   of the `#layers-panel`.
5. If popup-worthy, add a formatter to `src/popups.js` and reference it
   in `formatters[layerId]`.

## Auditing fields before adding popups

Dump the schema first:
```python
import json
from collections import Counter

d = json.load(open(f'public/data/{layer}.geojson'))
fields = {}
for f in d['features']:
    for k, v in f['properties'].items():
        fields.setdefault(k, Counter())[v if v is not None else '<null>'] += 1
for k, c in fields.items():
    print(f'{k:30s} ({len(c)} unique)', c.most_common(3))
```

Per-field decisions:
- Cardinality 1 across all features → drop (uniform, not informative).
- Mostly null → probably drop unless the non-null value is gold.
- Cryptic code → either decode (`popups.js` dictionary) or drop.
- Looks readable (e.g. `UNITDESC`) → keep, titlecase if uppercase.

The owner dislikes cryptic abbreviations in popups; if a field needs
context, prefer dropping it over showing a code.

## Code decoders in `src/popups.js`

| Field | Codes decoded |
|---|---|
| bike_facilities `CATEGORY` | `BKF-NGW`, `-PBL`, `-OFFST`, `-BBL`, `-BL`, `-CLMB`, `-SHW` |
| bike_facilities `MODEL_TYPE` | `BKF-ONEWAY`, `BKF-TWOWAY` |
| bike_facilities `CURRENT_STATUS` | `INSVC`, `UNDERCONS`, `PLNRECON` |
| bicycle_racks `BIKE_FACILITY` | `SGL`, `CLSTR`, `ONST` |
| bicycle_racks `MODEL_TYPE` | `BKR-INVRU`, `BKR-RLRCK`, `BKR-ARCRE`, etc. |

Unknown codes fall through to the raw value.

## Patterns that work well here

1. **Classify-then-style with separate layers** instead of complex paint
   expressions. Easier to reason about, debug, and toggle. MapLibre also
   gates certain expression complexity (see line-width gotcha).
2. **Filter at MapLibre layer level for "show/hide me" rules**; only
   filter at fetch time for things that match the original SDOT/KC
   experience or meaningfully shrink the snapshot.
3. **`HIDDEN` constant** (`rgba(0,0,0,0)`) for fallback colors so unknown
   categories disappear by default. Flip to a real color when auditing.
4. **Pre-load all Material PNGs in parallel** (`Promise.all`) before
   adding symbol layers, so they never render a broken-image placeholder.

## Routing prototype

Client-side bike comfort routing on a precomputed graph. Two halves:

1. **Offline build** (`scripts/build_graph.py`) — Overpass for OSM
   topology, SDOT spatial joins for attributes. Avoids osmnx/GDAL.
   Writes `public/data/routing_graph.json` (~11 MB after the
   sample_dtm + resolve_elevation passes).
2. **Browser** (`src/routing/`, `src/search/`) — A\* with the comfort cost
   function, address/POI search, click-to-route UI, turn-by-turn directions,
   tabbed alternates.

The whole engine is JS so a slider UI can tweak weights without rebuilding
the graph. The graph stores EDGE ATTRIBUTES (length, lanes, facility
class, oneway, bearings, centerline, geomIndex) but NOT cost — cost is
computed on the fly in `cost.js`.

```bash
source .venv/bin/activate
python3 scripts/build_graph.py     # ~30–90 s
```

### Build pipeline phases

A. **OSM via Overpass** (bbox-only). Filter via `_is_bike_routable` —
   drop motorways/trunks, service unless `bicycle=designated|yes`, paths
   unless explicit bike access. Alleys (`service=alley`) never enter.
B.1 Extract OSM `highway|junction=mini_roundabout` / `junction=circular` /
    `traffic_calming=island` nodes as supplemental traffic-circle points.
C. **Spatial-join `seattle_streets.geojson`** onto each OSM edge —
   sample 3–5 points, nearest SDOT segment within ~15 m, majority-vote
   `SURFACEWIDTH`, `ARTCLASS`, `SPEEDLIMIT`, `ONEWAY`.
   **Off-street trail edges (`highway` in `CYCLEWAY_HIGHWAYS |
   RESTRICTED_HIGHWAYS`) are SKIPPED.** At a trail × street intersection
   the street's centerline literally runs through the trail's geometry
   and wins the nearest-feature contest, contaminating the trail edge
   with the street's attributes. Skipped trail edges get `sdot={}` and
   fall through to off-street defaults (oneway=False, lane fallback,
   has_centerline=False). Worst historical symptom: BGT-on-Corliss at
   N 35th inherited Corliss's `ONEWAY='Y'`, severed southbound
   connectivity, and turned a 16 ft hop into a 0.574 mi detour.
E. **Spatial-join all four AAA-rendered facility sources** so visual ≡
   routing for the dark-green tier:
     1. `bike_facilities.geojson` — `INSVC` + `PLNRECON` only (UNDERCONS
        skipped: in-progress infra ≠ usable today).
     2. `multi_use_trails.geojson` → BKF-OFFST.
     3. `kc_regional_trails.geojson` → BKF-OFFST.
     4. `bike_plus_network.geojson` `Existing*` only: Non-Arterial →
        BKF-NGW, Arterial → BKF-PBL, Multi-Use Trail → BKF-OFFST.
   Pick best facility (lowest cost tier) when multiple overlap. The
   AAA-tier visual-vs-routing divergence used to bite the Burke-Gilman
   (rendered green, routed at 1.8×) until sources 2–4 were added.
F. **Snap signals / crosswalks / beacons / stop signs** to OSM nodes
   within ~20 m. Node-flag bitfield (12 bits total):
     - bit 0: hasSignal
     - bit 1: hasCrosswalk
     - bit 2: hasBeacon
     - bit 3: isTrafficCircle
     - bits 4..11: stop-sign FACING in 8 cardinal sectors (N, NE, E, SE,
       S, SW, W, NW). See `STOP_FACING_BITS` in build_graph.py and
       `graph.hasStopFacing(nodeId, bearingDeg)` in graph.js.
   SDOT FACING = cardinal direction the sign physically points = bearing
   of stopped approaching traffic (`FACING='E'` → eastbound traffic
   stops). The crossing-penalty zero-out at `crossingPenaltyFt` checks
   both directions of the cross-street axis (need FACING ≈ θ AND
   FACING ≈ θ+180° = 2-way stop on the cross OR a 4-way stop).
   Snap radius is 20 m (was 12 m; raised because signals digitized at
   the curb sat 13–18 m from the graph node). **Stop signs OR-into
   EVERY node within radius**, not just the nearest — OSM models each
   curb-side stop location as its own degree-2 node ~20–30 ft from the
   intersection center, and "nearest" sent stops to the curb instead of
   the intersection. Curb-node copies are harmless because
   `crossingPenaltyFt` only fires at multi-way junctions.
G. **Geometric circle detection** — short-edge cycles in OSM topology
   (3–6 nodes, perimeter ≤ 200 ft, diameter ≤ 60 ft, in-cluster degree 2).
   Picks up ~1,100 untagged circles.
G.1 **Collapse circle-cluster nodes** into synthetic merged nodes. Edges
    with both endpoints inside a circle drop; merged node inherits union
    of external incident edges. Tags `isTrafficCircle`.
H. **Expand to directed edges**: `forward` / `reverse` / `bidir`.
   Precompute `lengthFt`, `lanes`, `hasCenterline`, `bearingStart/End`,
   `streetName` (OSM `name` only). Carry the OSM elevation-related tags
   into the directed-edge record: `isBridge`, `isTunnel`, `isCovered`,
   `isIndoor`, and integer `layer` (parsed from `layer=*`).
I. **Detect untagged 2D crossings** — way-segments that geometrically
   intersect another way without sharing an OSM node. Sets bit 64; the
   data-quality flag for "v3 can't place either edge in 3D".
J. **Detect approach edges** — multi-source Dijkstra from every tagged
   (bridge / tunnel / layered / covered / indoor / embankment / cutting)
   edge endpoint, max graph-walk 200 ft. Returns two buckets: edges
   with BOTH endpoints in range (fully inside), and edges that straddle
   the 200 ft isoline (close endpoint in, far endpoint out).
J.1 **Cut straddling approaches at the polyline isoline** — every
    straddling directed edge is sliced at exactly `200 − d_close` ft
    along its polyline from the close endpoint. A new interior node is
    inserted at the cut; the close half inherits the approach flag,
    the far half does not. Both directions of a way-segment cut at the
    same arc-length so they share the new interior node. Slivers
    (cut < 1 ft on either side) are special-cased: close-end sliver →
    unflagged; far-end sliver → whole edge promoted to fully-flagged.
    On the current Seattle snapshot: ~700 new interior nodes,
    ~29 mi of approach surface trimmed, disentangles several merged
    bridge-corridor groups.
K. **Serialize columnar**: parallel arrays per attribute; geometry deduped
   (fwd/rev share index + `reversed` flag); strings interned. This
   columnar form is what gets the file to ~9 MB; per-record JSON-key
   overhead would bloat it to 200+ MB. `graph.js` matches this shape.

### Cost function: presets, custom sliders, twists

`src/routing/cost.js` parametrizes routing by FIVE user-facing sliders
(s1..s5, each ∈ [0, 1]). Higher = stronger preference for the named
property; lower = more willing to give it up for directness.

| Slider | UI label | What it scales | Direction |
|---|---|---|---|
| `s1` | Prefer better bike infrastructure | `facBase` for BBL/BL/sharrow/climbing AND the `noneNoCenterline` / `noneCenterlineBase` multipliers | Higher → more penalty for non-AAA edges |
| `s2` | Prefer fewer turns | `turnPenaltyFt = 500 · s2` | Higher → bigger per-turn penalty (favors straighter paths). **Note:** the prior label "detour tolerance" had the inverted meaning; the formula was unchanged. |
| `s3` | Prefer protected crossings | `crossingScale = 2 · s3` on `crossingAnchorsFt` | Higher → bigger penalty for unsignalized multi-lane crossings |
| `s4` | Prefer narrower streets | `facLaneSlope` (BBL/BL/CLMB/SHW) and `noneCenterlineLaneSlope` | Higher → per-lane penalty above 3 lanes grows faster |
| `s5` | Prefer flatter terrain (coming soon) | **STUB — no effect** (waiting on elevation data) | — |

Current preset defaults (read straight from cost.js — keep this in sync
when you tune them):

| | s1 | s2 | s3 | s4 | s5 | sign-cov max |
|---|---:|---:|---:|---:|---:|---:|
| Athletic | 0.2 | 0.5 | 0.2 | 0.2 | 0.2 | 0.5 |
| Comfort  | 0.7 | 0.5 | 0.7 | 0.7 | 0.7 | 0.5 |
| Custom (initial) | 0.5 | 0.5 | 0.5 | 0.5 | 0.5 | 0.5 |

Custom's initial defaults (`CUSTOM_DEFAULTS` in `routing/ui.js`) are
neutral midpoints — the user tunes from there. Once any slider moves,
the new values persist in `bikemap-routing-custom` and replace these
defaults on next load.

Fixed (not user-tunable):
- AAA tier (`BKF-NGW` / `BKF-PBL` / `BKF-OFFST`) always 1.0×
- `facLaneThreshold` = 3 (per-lane penalty only above 3 lanes),
  `TURN_THRESHOLD_DEG` = 30° (step-list granularity, not preference)
- `crossingAnchorsFt` = `[[1, 0], [2, 400], [3, 800], [4, 1600], [5, 1600]]`
  scaled by `2 · s3`. >5 lanes uncontrolled = Infinity → blocked.
- Cross-edge perpendicularity gate: a candidate cross-street must have
  axis-angle ≥ 60° from BOTH the prev and next edges; otherwise it's a
  fork/continuation along the cyclist's path, not a real crossing.
  `PERPENDICULAR_MIN_DEG = 60` in cost.js.
- Crossing penalty zeroes out when EITHER (signal/crosswalk/beacon at
  node) OR (cross-street has stop signs facing both approach directions
  = 2-way stop on the cross OR a 4-way stop). Stop checks read 8 cardinal
  bits from `graph.hasStopFacing(nodeId, bearingDeg)`.
- `signSnapFt` = 50, `signGapFt` = 1320 (0.25 mi)

Several constants inside `weightsFromSliders` also vary with the
sliders rather than being fixed — `facBase`, `facLaneSlope`,
`noneNoCenterline`, `noneCenterlineBase`, `noneCenterlineLaneSlope` are
all linear functions of `s1` / `s4`. Read the function to see the exact
formula at the moment you're tuning.

API:
- `weightsForPreset('athletic' | 'comfort')` — preset → full weights
- `weightsForCustom(sliders)` — user's custom slider snapshot → weights
- `weightsFromSliders(sliders, signCoverageMax)` — low-level (used to
  build twist weights)
- `applyTwistToSliders(sliders, twistId)` — add a twist's deltas, clip
  to [0, 1]

### Sidewalks

OSM `highway=footway` + `footway in (sidewalk, crossing)` ways are
admitted to the graph as a last-resort option (bit 1024 on
`edges.flags`). The routing engine never picks sidewalks unless the
road alternative is materially worse.

- **Fixed 3× multiplier** for every sidewalk edge — not user-tunable.
  Constants `SIDEWALK_MULTIPLIER` and `SHORT_SIDEWALK_FT` live in
  `cost.js`.
- **"Enable sidewalks" toggle** under the Comfort/Athletic segmented
  control gates the LONG ones (> 50 ft). Short sidewalks (≤ 50 ft)
  are always allowed regardless — they typically represent the OSM-
  data-quality "connector" between a trail and a roadway (e.g. a few-
  foot footway at the end of a path), and blocking them would sever
  connectivity. Persisted to `bikemap-routing-sidewalks-enabled`.
- **Snap targets exclude sidewalks** — `findNearestEdgeProjection`
  skips bit-1024 edges so route start/end always lands on a roadway
  even when the user clicked closer to a sidewalk.
- **Side of road** is computed once at build time
  (`annotate_sidewalks` in `build_graph.py`): perpendicular compass
  bearing FROM the nearest parallel road centerline TO the sidewalk
  midpoint, stored as `edges.sidewalkBearing[]`. At runtime,
  `sidewalkSideFromBearings(cyclistHeading, offsetBearing)` in
  `directions.js` resolves to "left" / "right" relative to the
  cyclist's direction of travel. Used to phrase "Continue on the
  right sidewalk of Brooklyn Ave".
- **Crossing penalty interactions:**
  1. `crossingPenaltyFt` returns 0 when BOTH prev and next edges are
     sidewalks — staying on a sidewalk past an intersection (sidewalk
     continuity through the pedestrian throat) is not a real
     road-crossing event.
  2. A separate `sidewalkCrossingPenaltyFt` fires when ENTERING a
     crosswalk segment (a sidewalk that 2D-crosses a road, detected
     at build time and recorded in `edges.crosswalkLanes[]`). Zeroed
     by the same signal/crosswalk/beacon/stop flags as the road-on-
     road penalty. This lets A* discover the pattern: walk along
     sidewalk → reach signalized intersection → cross at 0 penalty →
     continue along sidewalk on the other side.
- **Infra summary bar** gains a gray "Sidewalk" section
  (`#9e9e9e`) when the active route uses any sidewalk.
- **Elevation pipeline:** sidewalks are at-grade, so they get
  regular DTM samples + analytic climb metrics like any other
  ground-level edge. The heat-eq correction triggers only on bits
  4/8/64/128 (bridge/tunnel/untagged-crossing/approach) — bit 1024
  is independent. A sidewalk on a bridge would carry the bridge tag
  too and get fixed normally; a sidewalk crossing a road at-grade
  may pick up `isUntaggedCrossing` and get heat-eq smoothed between
  road boundary nodes, which is exactly right.

### Twist alternates (verified algorithm)

`findPathsMulti(primaryWeights, graph, start, end, twistRuns)` always
runs primary + every twist. A twist is dropped if its route is >80%
similar to the primary's. If two surviving twists are >80% similar to
each other, the one less similar to the primary is kept. Surviving
twists keep their original label ("Quieter", "More direct") — there is
no penalize-and-rerun fallback or "Alternative" relabel. Similarity is
`|A ∩ B| / min(|A|, |B|)` over underlying geometry indices.

Current `TWISTS` (cost.js):
- **Quieter** — `s1` +0.3, `s3` +0.3, `s4` +0.3. Pushes onto better
  infra and away from unprotected crossings + wider roads. No change to
  turn aversion.
- **More direct** — `s1` −0.2, `s2` +0.5, `s3` −0.2, `s4` −0.2. Boosts
  turn aversion (straighter path), accepts lower-tier facilities, less
  fussy about crossings, accepts wider roads.

Compute cost: 3 A\* runs per request (~100 ms total on a typical route).

### Directions step assembly (`directions.js`)

Order matters; each filter is there for a real failure mode we hit:

1. **`fillInUnnamedConnectors`** — short (<100 ft) unnamed edges sandwiched
   between two named edges of the same street (driveways, OSM way-splits)
   inherit the surrounding name, so the directions don't fragment with a
   spurious "Continue" sub-step.
2. **Name normalization (`normName`)** strips trailing bike-facility
   suffixes (`cycle track`, `cycletrack`, `cycleway`, `bike lane`, `bike
   path`, `protected bike lane`) before comparing names for the merge
   pass. Same physical corridor in OSM often flip-flops between e.g.
   "Westlake Cycle Track" and "Westlake Protected Bike Lane"; stripping
   the suffix collapses them into one merged step. **Display** uses the
   first edge's original name; only the comparison is normalized.
3. **Merge loop is pure name-equality** (no bearing-gate). A bearing
   guard was tried (break merge if joint angle > TURN_THRESHOLD_DEG) and
   removed — it fragmented legitimate curving streets like Lake
   Washington Blvd into multiple sub-steps. The classic risk (a sharp
   turn within a same-named bike-facility transition gets silently
   swallowed) doesn't actually appear in Seattle's OSM data.
4. **`s2` semantics** = "Prefer fewer turns" (higher s2 → more penalty per
   turn → favors straighter routes). The old "detour tolerance" label was
   inverted relative to the `turnPenaltyFt = 500 · s2` formula; fixed.
5. **Skip bare "Continue" with no street name** — those steps carry no
   info. Absorb their distance into the previous step. Step 0 ("Head
   <cardinal>") is exempt because the cardinal direction is itself useful.

### `cost.js` — what's safe to tweak vs load-bearing

**Safe to edit freely** (just changes defaults / tuning, no consumer breaks):
- `PRESETS.athletic` / `PRESETS.comfort` slider values
- `SIGN_COV_BY_PRESET` values
- `TWISTS[i].deltas` and `TWISTS[i].label`
- The numeric coefficients inside `weightsFromSliders` (0.6, 1.0, 2.0,
  500, 2, 1.6, etc.) and the `crossingAnchorsFt` curve
- `PERPENDICULAR_MIN_DEG`, `signSnapFt`, `signGapFt`
- `SLIDERS[i].label` (UI text)
- `TURN_THRESHOLD_DEG` — but it's imported by `directions.js` too, so
  also affects the step-list "Continue" threshold

**Load-bearing — don't touch without an audit:**
- `TWISTS[i].id` (`'quieter'`, `'direct'`) — used as `data-route-id` on
  tabs and `altId` on map features; `setActiveRoute` looks them up.
- Slider keys (`s1`..`s5`) — referenced by `weightsFromSliders` formulas,
  the persisted `bikemap-routing-custom` localStorage shape, and DOM ids
  `slider-${key}`.
- The shape of the object `weightsFromSliders` returns — read by
  `astar.js`, `signCoverage.js`, and the per-edge helpers in `cost.js`.
- Exported function names — imported across `ui.js`, `astar.js`,
  `directions.js`. Same for exported `PRESETS`, `SLIDERS`, `TWISTS`,
  `TURN_THRESHOLD_DEG`.
- `PRESETS` keys (`athletic`, `comfort`) — UI radios in `index.html`
  are hardcoded with those values, and `loadPresetFromStorage` validates
  against this set.
- `SLIDERS` array length / order — settings modal renders one row per
  entry; persisted custom-slider object expects exactly these keys.

Vite HMR picks up `cost.js` edits with a page refresh — no data rebuild
needed; the routing graph is independent of `cost.js`.

### UI layout

Top-left **`#left-stack`** (a flex column, `width: 360px`):
- **`#routing-panel`** — Top row is an `#app-header` with the title
  **Open Bike Map Seattle** on the left and the ⚙ Settings button on
  the right. Below that: Start/End inputs with FlexSearch typeahead, a
  small vertical **swap-endpoints** button (`swap_vert`, 22 px wide) on
  the left of the pair, and a per-input close (`close`) button on the
  right of each input that mirrors the Home / Work editor in Settings.
  Then the **Riding style** picker is a `.segmented-control`
  (Comfort first since it's the default, then Athletic, plus Custom
  only when explicitly enabled in Settings). The two legends in this
  panel read **Directions** and **Riding style** (renamed from "Route"
  / "Route style"). Material Symbols for every chrome icon.
  - **Comfort** is the default preset (radios `checked` and JS default
    both agree). The segmented control hides `#preset-custom` +
    `#preset-custom-label` by default; toggling `#settings-custom-enabled`
    in Settings adds `.custom-enabled` to `#preset-segmented` which
    reveals the Custom button. Disabling while Custom is the active
    preset falls back to Comfort and re-routes if endpoints are set.
  - The Custom sliders panel in Settings stays *visible* even when
    Custom is disabled — `applyCustomEnabledUI` toggles a `.disabled`
    class that grays the section (`opacity 0.45`, `pointer-events:none`,
    `filter: grayscale(0.5)`) and sets `input.disabled = true` on each
    range. This way users can see what's available without it being
    interactive.
- **`#directions-panel`** — Hidden until there's a route. When >1 route,
  starts with a `<ul.route-tabs>` strip (one tab per route, label + min ·
  mi). Tabs are in stable insertion order; the `.active` class moves
  rather than the tabs themselves. Clicking a tab calls `setActiveRoute`
  (same as clicking the route line on the map). When only one route, no
  tab strip — the summary block is the only header. The summary block
  always shows a 4-line infrastructure breakdown for the active route
  (%AAA / %Other bike routes / %Local streets / %Major streets) under
  the min/mi line. "Local" = no facility + no centerline; "Major" = no
  facility + has centerline. See `infraBreakdown()` in `ui.js`.
- The stack has `max-height: calc(100vh - 60px)` to clear MapLibre's
  bottom-left ScaleControl.

Top-right **`#layers-panel`** at `right: 60px` — sits left of MapLibre's
NavigationControl. Bike infrastructure / Points / Routing debug toggles
(including the **Routing graph** debug overlay — renders all ~25k nodes
+ ~32k unique-geometry edges; toggleable like other layers). The whole
**Routing debug** fieldset (`#layers-debug-fieldset`) is hidden by
default; flipping `#settings-debug-enabled` in Settings reveals it.
Turning the gate off force-unchecks all 6 debug toggles (each
`change` event runs through `VisibilityManager`, so any visible debug
layer is removed).

**`#settings-modal`** (`<dialog>`) opened by ⚙ button — Home / Work
editor (typeable address inputs reusing addr_search), Average cycling
speed slider, a **Custom route preferences** section gated by the
`#settings-custom-enabled` toggle (sliders + Custom mode both hidden
when off), and Attributions. Click outside the modal content to close.

### Routing endpoint flow

- The map's general click handler **only** sets an endpoint when the user
  has explicitly entered "choose on map" mode for a specific input. No
  ambient click-to-route.
- The Start / End dropdowns show **My location / Home / Work / Choose
  on map** when focused and empty. Picking My Location snaps the live
  GPS fix to the graph (and requests permission once if there is no fix
  yet). Picking Home/Work uses the saved coords; picking when "Not set"
  opens the Settings modal at the matching input. "Choose on map"
  enters click-to-place for that input only.
- A blue dot (`.user-location-dot`) tracks the user's GPS position on
  the map at all times once permission is granted. The watch starts on
  app boot in `routing/ui.js` (`startUserLocationTracking`). Two
  watchers run in parallel: a high-accuracy GPS watcher and a
  low-accuracy (WiFi/IP) watcher. The high-accuracy one wins when
  available; the low-accuracy one provides indoor coverage where GPS
  silently times out. `requestLocationOnce` (one-shot for "My location"
  picks) reuses `state.userLocation` if already set, otherwise tries
  high-accuracy → low-accuracy fallback before giving up. Fixes the
  intermittent "permission is on but location fails" failure mode.
- `src/routing/mode.js` carries the shared mode flag.
  `popups.js` imports `isChoosingOnMap()` and bails out of its per-layer
  popup handlers so you can click a bike-rack icon to set an endpoint
  without summoning its popup. Cursor turns crosshair; Escape cancels.
- POIs in the dropdown show their nearest-housenumber address as
  subtext.
- POI lat/lng for graph snapping uses the nearest-housenumber's coords
  (`ax`, `ay` in addr_index records), not the POI centroid. A park's
  centroid often sits inside an OSM-tagged trail loop that's disconnected
  from streets; routing from there would fail.
- `graph.findNearestEdgeProjection` / `findNearestNode` filter snap
  candidates to the **main connected component** (computed at graph load),
  so they never return a node on an isolated park-trail island. Tiny
  clusters with <some-threshold nodes are silently skipped.
- Per-input X buttons (`#clear-start`, `#clear-end`) clear just that
  endpoint and tear down any rendered route + step markers (the
  remaining single pin can't form a route on its own). The swap button
  (`#swap-endpoints`) flips Start and End, recreating the green/red
  markers in their new roles and re-routing if both are set.
- POI popups for libraries / community centers / parks-restrooms /
  light-rail stations / bike racks / bike signs include a pink "Go"
  button. Clicking it routes from the user's current GPS location to
  that POI via `routeFromMyLocationTo(lon, lat, label)` exported from
  `routing/ui.js`.

### Saved locations (Home / Work)

`bikemap-saved-home` and `bikemap-saved-work` localStorage keys hold
`{ label, lon, lat }`. Edited in the Settings modal via typeable address
inputs (same FlexSearch backend). Surfaced as options in the Start / End
dropdowns when the input is empty.

### Persistence (localStorage)

JSON-encoded under these keys:

- `bikemap-routing-preset` — `"athletic" | "comfort" | "custom"` (default `"comfort"`); if it's `"custom"` but custom isn't enabled, it auto-falls-back to `"comfort"` on load.
- `bikemap-routing-custom` — `{ s1, s2, s3, s4, s5 }` slider snapshot
- `bikemap-routing-custom-enabled` — `"true" | "false"` (default `"false"`); when `false`, the Custom button is hidden from the segmented control and the slider section is grayed out in Settings.
- `bikemap-routing-debug-enabled` — `"true" | "false"` (default `"false"`); when `false`, the Routing debug fieldset in the layers panel is hidden and all 6 debug toggles are force-cleared at boot.
- `bikemap-cycling-speed-mph` — number, 4–25, default 10 (drives the
  predicted-minutes display). The display estimate is **display-only**
  — routing is unaffected. `predictedMinutes(state, route)` in
  `routing/ui.js` sums: base distance ÷ stated mph + sidewalk distance
  ÷ 5 mph (sidewalks always 5 mph regardless of stated speed) + 2 s/ft
  total climb − 0.5 s/ft total descent (from `climbStats`, no grade
  term) + 10 s per signal at an interior path node + 2 s per stop sign
  facing the cyclist's bearing at an interior node. Clamped to ≥ 1 min.
- `bikemap-saved-home`, `bikemap-saved-work` — `{ label, lon, lat }`
- `bikemap-toggles` — `{ groupName: bool }` diff vs HTML defaults (only
  groups that have been toggled away from default are stored)

Loaded once at startup. Saved on every change (no debounce needed at
these sizes). Wrapped in `try {}` so storage-disabled browsers degrade
silently.

### Address + POI search

Offline FlexSearch index built by `scripts/build_addr_index.py`.
Browser wrapper is `src/search/addr_search.js`:
- `preloadAddrIndex()` — fetch + index build on app boot
- `searchAddresses(query, { limit, mapCenter })` — async, ranked

Coverage (owner-verified 2026-05):

- **Street-numbered houses are essentially complete.** Multiple attempts
  to find "missing" addresses turned up only lot-consolidation patterns
  (commercial buildings spanning multiple frontages, multifamily / townhouse
  developments using one number per building, etc.) — never an actual
  unmapped house.
- **DADUs / AADUs (backyard cottages) are largely missing.** Seattle has
  issued 3,000+ DADU/AADU permits since 2019; the index contains only
  ~100 letter-suffix addresses ("1234A NW 54th St" pattern). Backyard
  cottages typically share the main house's polygon and don't get a
  separate addr node.
- **Apartment-unit specificity is absent.** Only 4 records contain "unit"
  or "#". Typing "1234 5th Ave Unit 304" prefix-matches the building but
  can't navigate to a specific unit — UX gap rather than coverage gap.
- **POIs have name-variant gaps.** Buildings exist under their formal OSM
  `name`, but informal local names won't match without `alt_name` tags.
  Verified examples: "Ballard Locks" misses (only "Hiram M. Chittenden
  Locks" is tagged); "The Spheres" misses; "Pike Brewing Company" misses.
  Remedy is more `alt_name=*` in OSM, not more code.

No online geocoder fallback (no-API-keys constraint). When a match
doesn't appear, the user drops a pin via "Choose on map".

### Debug toggles

In the "Routing debug" fieldset:
- **Traffic signals** — red dots (raw SDOT GeoJSON).
- **Crosswalks** — yellow dots.
- **Beacons** — purple dots (RFB + school).
- **Stop signs** — stop-sign-red dots (SDOT R1-1, with FACING attribute).
- **Street slopes** — overlays every bike-routable edge colored by
  absolute slope, with each node as a small dark-pink circle. Edges
  deduped by `geomIndex`; slope = `(elev_to − elev_from) / lengthFt`
  computed in the UI from `nodes.elev[]` (which is heat-eq-corrected on
  every flagged corridor; raw smoothed-DTM elsewhere). Roads render as
  solid lines; **sidewalks render as dashed lines** (same color ramp)
  so they're visually distinguishable. The single "Street slopes"
  checkbox toggles three layers as a group: `graph-debug-edges`
  (roads, solid), `graph-debug-sidewalk-edges` (sidewalks, dashed),
  and `graph-debug-nodes` (nodes). Step thresholds:
  0–1% gray, 1–3% light green, 3–6% yellow, 6–10% orange, 10–15% red,
  15–20% dark red, 20%+ dark purple. Seattle's steepest real street is
  ~26%, so anything purple is either a sustained real climb (e.g.
  Marshall Park) or a residual artifact at a multi-level junction where
  heat eq smoothed across grade.

### Known caveats

- **Side-of-street** isn't inferred from `bike_facilities` (data lacks
  the field). The router treats a facility as bidirectionally applicable.
  One-way bike lanes get the disclaimer when the road is two-way.
- **OSM ↔ SDOT spatial join** uses ~15 m majority-vote sampling. Some
  edges near major intersections will mistag.
- **Traffic-circle gaps remain.** SDOT (1063) + OSM-tagged (~16) +
  geometric detection (~1100) catches most. Circles modeled in OSM as a
  single 4-way junction with no special tag and no ring-of-ways topology
  are indistinguishable from a normal intersection. Net effect: route
  emits "Turn left" instead of "Turn left at the traffic circle" —
  visually correct, just less specific.
- **Bitfield reference.** Edges:
  `1 = hasCenterline`, `2 = oneway`,
  `4 = isBridge`, `8 = isTunnel`,
  `16 = isCovered`, `32 = isIndoor`,
  `64 = isUntaggedCrossing`, `128 = isApproach`,
  `256 = isEmbankment`, `512 = isCutting`,
  `1024 = isSidewalk`.
  Six OSM elevation-related flags (bridge / tunnel / covered / indoor /
  embankment / cutting) are independent — same edge can have multiple
  set. Bridge / tunnel are "DTM is structurally wrong here" flags
  (read water/ground below or surface above). Embankment / cutting are
  "DTM is correct, but the way is on raised earthwork / in a cut" —
  informational, distinguish real-terrain transitions from structures.
  (Earlier versions fused `covered=yes` into `isTunnel` — that's been
  split.) Bits 64 and 128 are **derived**, not from OSM:
  `isUntaggedCrossing` is set by `detect_untagged_crossings` on every
  way-segment that 2D-crosses another (no shared OSM node) and carries
  no elevation tag of its own; `isApproach` is set by
  `detect_approach_edges` on every untagged edge within ~200 ft
  graph-walk distance of any tagged edge (now including embankment
  and cutting sources). The 200 ft is enforced as a polyline cutoff:
  edges straddling the isoline are split by `apply_approach_splits`
  at the precise 200 ft point, with a fresh interior node inserted at
  the cut; the close half is flagged, the far half isn't. New interior
  nodes get no signal / stop-sign / circle bits (those belong to OSM
  endpoint nodes); they're degree-2 by construction and inherit
  elevation by linear interp during `sample_dtm.py`. The nearest source
  category is recorded in the
  parallel `edges.approachOf[]` string column — one of
  `bridge` / `tunnel` / `layered` / `embankment` / `cutting` /
  `covered` / `indoor`, null when not an approach; ties broken by
  that priority order. Alleys were removed entirely at OSM parse time
  via `_is_bike_routable`, so no `isAlley` bit. Plus a separate
  `edges.layer[]` signed-int column for OSM `layer=*` (null = unset).
  Nodes: see Step F.

## Elevation pipeline

**Current state.** Two-stage pipeline: `sample_dtm.py` populates raw
elevation from smoothed-and-resampled USGS 3DEP DTM, then
`resolve_elevation.py` applies heat-equation correction over the
flagged subgraph (every bridge / tunnel / layered / approach corridor
that connects to the regular street network). All elevation-consuming
code paths (`cost.js`, the directions-panel elevation chart,
`climbStats`, the Street Slopes debug overlay) read from the final
post-correction `nodes.elev[]` / `geomElevs[]`. The slider works; the
chart renders real curves on every corridor including over-I-5
downtown; the Flatter twist meaningfully differentiates routes.

### Stage 1: sample_dtm.py

1. Stream USGS 3DEP tile `n48w123` via rasterio `/vsicurl/`; cache the
   Seattle window to `dtm_cache/seattle_window.npy` (~32 MB).
2. **Denoise** the in-memory window with `5×5 median + σ=2 px Gaussian`
   (`MEDIAN_KERNEL_SIZE`, `GAUSSIAN_SIGMA_PX` in `sample_dtm.py`). The
   median kills isolated outlier cells; the Gaussian smooths residual
   noise. Effective extent ~50 m — small enough not to flatten real
   bluffs.
3. Bilinear-sample at every routing-graph node → `nodes.elev[]` (feet).
4. Bilinear-sample at every geom vertex → temporary per-vertex profile.
5. **Uniform-resample** each geom: `n = max(1, round(arc_length / 75 ft))`
   even sub-segments. Compute per-edge `uphillFt` / `maxUphillPct` /
   `steepFt2` from the resampled breakpoints (per-sub-segment, 2% steep
   threshold).
6. Linear-interp the resampled breakpoints back to the OSM vertex
   positions → overwrite `geomElevs[]`. The chart + `climbStats` now
   see the same smoothed curve.
7. Extract 25-ft contours from the **raw** (unsmoothed) DTM → overwrite
   `contours.geojson`. The topographic layer stays free of resampling
   artifacts.

### Flag annotations used by the elevation pipeline

The graph carries enough OSM tagging to drive the heat-eq correction.
Counts on the current Seattle snapshot (per unique geometry):

- `isBridge` (351), `isTunnel` (31), `isCovered` (30), `isIndoor` (0)
  — OSM elevation-related tags. DTM is structurally wrong on bridges
  (reads water under deck) and tunnels (reads surface above floor).
- `edges.layer[]` (410 with `layer=*`, distribution +1=355, −1=25,
  +2=14, +3=9, −2=5, +4=2). The cleanest single elevation tag.
- `isEmbankment` (22) / `isCutting` (13) — **real earthworks, DTM is
  CORRECT here.** Don't apply bridge-style fix logic. They're seeded
  into the approach BFS only for neighborhood context.
- `isUntaggedCrossing` (~159 unique segs after splits, from 192
  crossing pairs) — derived: this way-segment 2D-crosses another
  without sharing a node and carries no elevation tag of its own.
- `isApproach` (~1,457 unique segs after Step J.1 polyline cutoff;
  697 new interior nodes inserted at the 200 ft isoline; ~29 mi of
  polyline length trimmed vs the previous node-granularity rule) —
  derived: an untagged edge whose polyline arc-length is within 200
  ft graph-walk of any tagged source. Source category recorded in
  `edges.approachOf[]` (one of bridge / tunnel / layered / embankment
  / cutting / covered / indoor).

### Heat-eq correction (`scripts/resolve_elevation.py`)

Solves a discrete Dirichlet problem on the flagged subgraph. A
"group" is a connected component of flagged way-segments, connectivity
by shared OSM nodes. For each group with ≥1 boundary node:

- **Boundary nodes** = endpoints with ≥1 unflagged incident edge in
  the full graph. Their DTM elevation is trustworthy (sitting at the
  transition out of the flagged surface, or at the 200 ft polyline
  isoline split node added by Step J.1).
- **Interior nodes** = endpoints all of whose incident edges are
  flagged (typically bridge spans deep inside a corridor).
- Solve `min Σ_edges (e_u − e_v)² / L_{uv}` with boundary elevations
  fixed. Linear system on interior unknowns, sparse SPD, dense numpy
  solve since groups are small (max ~125 segs).
- Apply: overwrite interior `nodes.elev[]`. For each flagged geom in
  the group, replace `geomElevs[gi]` with linear interp between the
  (now corrected) endpoint elevations. Recompute
  `edges.uphillFt/maxUphillPct/steepFt2` analytically (linear profile
  → constant slope).

Coverage on the current snapshot: **264 of 277 groups solved**. The
13 unsolved have no boundary nodes — isolated all-flagged "island"
components disconnected from the routable network (pedestrian
bridges between trail islands, etc.). 2,003 geoms rewritten / 3,277
directed edges (~85% of the 3,594 v3-flagged directed edges).

**Multi-level junctions remain a localized failure mode.** The heat
eq runs on graph adjacency, not 2D geometry, so paths that 2D-cross
without sharing an OSM node naturally stay at independent
elevations. Where they DO share a node elsewhere in the same group
(stairs / elevators / shared building entrances at Convention
Place, freeway ramp merges, the Beacon Hill / I-90 complex), the
solution collapses both paths in a small neighborhood. **Accepted
tradeoff** — for bike routing, slope magnitudes matter, not
absolute layer ordering.

### Things explicitly NOT to do (elevation)

- Don't apply bridge-fix logic to `isEmbankment` / `isCutting` —
  those are real terrain, DTM is right.
- Don't pursue within-edge spike-pair detection (the v2 idea).
  Audited the top-5 "spike" candidates; all 5 were sustained multi-
  segment STEPS at one edge endpoint, not isolated single-vertex
  spikes. Spike rejection wouldn't help. Their underlying cause is
  probably intersection-node elevation contamination.
- Don't re-sample raster finer than `~50 m` — that's our smoothing
  extent and the practical resolution limit at 10 m cells. Finer is
  sampling noise.
- Don't re-introduce DSM. First-return DSM reads bridge superstructure
  tops correctly but also reads tree canopy over at-grade roads.
  v1's hybrid wasn't enough; the heat-eq approach replaces it.

### Schema written by the elevation pipeline

| Field | Shape | Notes |
|---|---|---|
| `nodes.elev[]` | one float per node, feet | One elevation per node (the one-node-one-elevation invariant). |
| `geomElevs[]` | parallel to `geoms[]`, one float per vertex | Consumed by `edgeElevProfile()` → chart + `climbStats`. |
| `edges.uphillFt[]` | one float per directed edge | Σ positive Δelev in traversal direction. |
| `edges.maxUphillPct[]` | one float per directed edge, fraction | Inspection metric ONLY; **not** consumed by `cost.js`. |
| `edges.steepFt2[]` | one float per directed edge | `Σ_seg(length · max(0, slope − 0.02)²)`. Consumed by `cost.js`. |

Cost-function wiring in `src/routing/cost.js`:
- `uphillFtPenalty = 40 · s5` — linear per-foot uphill penalty
- `steepCoeff = 400 · s5` — quadratic-on-slope steepness penalty
- `STEEP_THRESHOLD = 0.02` in both `cost.js` and `sample_dtm.py` —
  keep them in sync if you change it
- `Flatter` twist (`s5: +0.5`) meaningfully differentiates routes
  against the heat-eq-corrected elevations.

### Elevation lessons (carry forward)

- **Bridges are systematic errors, not noise.** Raster smoothing
  doesn't help with bridges — they're correctly-measured *wrong*
  terrain (DTM reads water under deck). The heat eq solves this
  topologically by interpolating between trustworthy boundary nodes.
- **DTM ≠ DSM.** First-return DSM reads bridge tops correctly but
  also reads tree canopy over at-grade roads. Don't re-introduce it.
- **`maxUphillPct` is for human inspection, not cost.** `cost.js`
  reads `uphillFt` (total positive rise) and `steepFt2` (length-
  weighted quadratic). Both are robust to OSM-vertex-spacing
  variation. So a catastrophic-looking max slope on a long-flat-with-
  spike edge doesn't necessarily mean the routing is being misled —
  but it does mislead the debug overlay and the chart caption.
- **"Spike artifacts" are usually multi-segment steps.** Don't bother
  with single-vertex spike detection; the high-slope sub-segments
  are typically 3-6 consecutive sub-segments at one edge endpoint
  (intersection-node elevation contamination at trail-road
  junctions).
- **Real Seattle hills exist and shouldn't be "fixed".** Owner-
  verified steepest real street is 26% (Lenora downtown / Union
  St / W Commodore Way / various West Seattle blocks). >30% in the
  final graph means residual noise (or genuine bike-path / staircase,
  rare).
- **Owner ground truth wins over indirect analysis.** When in doubt
  about empirical claims, measure against parcels / permits / owner's
  lived experience rather than data-density proxies.

## Mobile layout

Single breakpoint at `@media (max-width: 719px)`. Above 719 px the
desktop layout is byte-identical to what existed before the mobile work
(spot-check by resizing). Below 719 px the page transforms into:

**Design intent**: mobile reuses the desktop COMPONENT styling — same
panel padding, hit-target sizes, section/h3 look. Only the OUTER layout
changes (title bar pins to the top; routing/directions become a
draggable bottom sheet; layers panel becomes a full-screen overlay).
Font sizes are shared between desktop and mobile.

**Section primitive.** All grouped controls — Directions / Riding style
in the routing panel, Bike infrastructure / Terrain / etc. in layers,
Saved locations / Cycling speed / etc. in settings — use the same
markup: `<section class="panel-section"><h3>Title</h3>…</section>`.
One CSS rule (`.panel-section` + `.panel-section h3`) styles them all.
The settings modal overrides padding to `12px 16px` via
`#settings-modal .panel-section` for a bit more breathing room; the
pills use the default `10px 12px`. Don't use `<fieldset>` /
`<legend>` — `<fieldset>` has unusual built-in padding/legend offset
behavior that diverges from `<div>` / `<h3>`, and using both was the
inconsistency this primitive was created to remove.

- **Title bar** (`#app-header`) — top-level DOM sibling of `#sheet`,
  NOT a descendant. This is load-bearing on mobile: a `position: fixed`
  element inside a transformed ancestor (the sheet's `translateY`) is
  positioned relative to the ancestor, not the viewport. Putting
  `#app-header` outside `#sheet` is the fix that keeps it pinned to
  the top of the screen.
  - Desktop: own pill at `top: 10px left: 10px width: 360px`, with an
    explicit `height: 40px` (28 px chrome buttons + 6 px top/bottom
    padding, `box-sizing: border-box`). `#left-stack` is pushed down
    to `top: 56px` (= 10 + 40 + 6) so the title-bar→routing-panel gap
    equals the 6 px flex `gap` between routing-panel and
    directions-panel. Keep `#app-header`'s height in sync with that
    arithmetic if you change either.
  - Mobile: `position: fixed; top: 0; left: 0; right: 0` spanning the
    viewport, with `z-index: 5` so it sits above the sheet (`z: 3`).
  Holds the app title and the two chrome buttons (`#layers-fab`,
  `#open-settings`) wrapped in `.app-header-actions`.
- **Bottom sheet** (`#sheet`) — wraps `#left-stack`; on mobile,
  `position: fixed` filling the viewport and translated vertically by
  `src/sheet.js` to one of TWO snap points:
  - **peek** (static `PEEK_HEIGHT = 148 px` — drag handle + the
    Directions input section as it's CSS-stable) — only the
    "Directions" Start/End input section is visible. The riding-style
    picker and Enable-sidewalks toggle are hidden in peek; user drags
    up for full. Tune `PEEK_HEIGHT` in `sheet.js` if the section's
    CSS height changes.
  - **full** (`vh - FULL_TOP_OFFSET`, where `FULL_TOP_OFFSET = 44 px`)
    — sheet top anchors at a fixed pixel offset from the viewport top
    instead of `0.92 * vh`, so the visual top doesn't shift when the
    iOS keyboard dismisses and `window.innerHeight` grows. Floored at
    `PEEK_HEIGHT + 60` so full is always larger than peek on tiny
    viewports.
  - **Auto-snap to full on route compute** — `compute()` calls
    `snapSheet('full')` after rendering (both on success and on
    "no path found"), plus a follow-up rAF call to survive any
    stray keyboard-dismiss resize that might re-apply a stale snap
    state. Handles both "user typed/picked an address" (sheet stays
    up) and "user finished Choose-on-map" (sheet was at peek during
    the map tap, snaps back up so the user sees the directions
    immediately).
  Sheet has its OWN white background + drop shadow + top-rounded
  corners; the drag pill lies on top of that sheet surface (not
  floating above a separate inner panel). Inner `#routing-panel` /
  `#directions-panel` are background-transparent on mobile so the
  sheet reads as a single component.
- **Drag handle** (`#sheet-handle-bar`) — 40 × 4 px gray bar centered
  at the top of the sheet (26 px-tall hit strip). **Pointer events
  are bound to the pill ONLY** — taps on the sheet content (dropdown
  rows, inputs, step list) are NOT sheet gestures. Drag snaps to
  nearer of {peek, full} with velocity bias (`|vy| > 0.5 px/ms` →
  snap in direction of motion); pure tap on the pill toggles peek ↔
  full. (The pill-only restriction is the fix for the regression
  where tapping a dropdown row registered as a sheet pointer-down +
  pointer-up "no move → toggle" → e.g. tapping "Choose on map"
  snapped the sheet to full immediately after `beginChooseOnMap`'s
  `snapSheet('peek')`.) Inner scrolling of `#left-stack` works
  natively without any guard. `sheet.js` still sets
  `scrollEl.style.maxHeight = snapPx[name] - HANDLE_HEIGHT` after
  every snap so the inner scroll container is sized to the visible
  sheet portion — without this, the last items of long step lists
  would sit in the off-screen tail of the sheet and be unreachable.
- **Layers icon** (`#layers-fab`) lives inside the title bar next to
  the settings gear on BOTH desktop and mobile. Both buttons share the
  `#open-settings, #layers-fab` rule for matching chrome styling (28 ×
  28 square, light-gray bg, thin border). The FAB gets a pink
  `.active` class (managed by `wireLayersModal` in `src/main.js`) when
  the layers panel is currently visible — same pink as the segmented
  control's checked label, so the affordance reads as "this control is
  active." Toggle semantics differ between viewports:
  - Desktop: panel visible by default → FAB starts active (pink).
    Click → `panel.classList.toggle('layers-hidden')`; CSS
    `#layers-panel.layers-hidden { display: none }`.
  - Mobile: panel hidden by default → FAB starts inactive. Click →
    `panel.classList.toggle('open')`; the mobile @media block
    restyles `#layers-panel.open` into a full-screen overlay modeled
    on the settings dialog (sticky header with "Layers" title +
    close X, sections).
  The layers checkboxes are a single source of truth — they live in
  `<div id="layers-panel">` at all times; only its outer positioning
  flips between desktop (top-right pill, no title) and mobile
  (`.open` overlay with "Layers" title). On desktop the layers panel
  is restyled to match the settings modal's spacing and colors
  (sections with `padding: 12px 16px`, `border-bottom: 1px solid
  #f0f0f0`, rounded 8 px, brighter shadow). `#layers-panel-close` is
  the X inside the mobile overlay; Escape also closes (mobile only).
  A `matchMedia('(max-width: 719px)')` change listener re-syncs the
  FAB's `.active` state when the user resizes across the breakpoint.
- **Settings dialog** — `dialog#settings-modal` overridden to
  `100vw × 100vh, border-radius: 0` on mobile; header is `position:
  sticky` so the close-X stays reachable while content scrolls. Inner
  styling unchanged.
- **Choose-on-map banner** (`#choose-on-map-banner`) — pink rounded chip
  at top-center, shown by `beginChooseOnMap` and dismissed by
  `cancelChooseOnMap` or the Cancel button. Shown on both desktop and
  mobile.
- **`:active` rules** — placed outside the media query so they apply
  everywhere (desktop hover preserved; tap feedback added on touch).
  No padding or font-size changes — only background/color.
- **MapLibre NavigationControl hidden on mobile** — the FAB owns the
  top-right corner; pinch + drag are native.

Sheet-snap helpers other modules already call:
- `snapSheet('peek')` — `popups.js` when a popup opens; `ui.js` when
  entering choose-on-map mode.
- `snapSheet('full')` — `ui.js` when an `.addr-input` (routing-endpoint
  role only) gains focus, so the autocomplete dropdown has room.

Files that own the mobile UX: `src/sheet.js`, the `@media (max-width:
719px) { ... }` block at the bottom of `src/style.css`, the
`#sheet` / `#sheet-handle-bar` / `#layers-fab` / `#layers-panel-close` /
`#choose-on-map-banner` elements in `index.html`.

### Summary-block SVGs (infra bar + elevation chart)

Both inline SVGs in the directions summary (`infraSummaryBarSvg` and
the chart from `elevationProfileSvg` rendered by `elevationBlockHtml`)
use a **viewBox-width == rendered-pixel-width = 1:1** mapping. Each
generator takes a `vbWidth` argument and emits `<svg width="W"
height="H" viewBox="0 0 W H">` where W is computed at render time from
`directionsPanelInnerWidth(state)` — typically `state.panel.clientWidth`,
with a viewport-based fallback. CSS gives them only `display: block;
max-width: 100%` — no `width: 100%; height: auto`, because that path
uniformly scales the whole SVG (including font size and bar height)
with container width.

Consequence: font sizes (e.g. `.route-infra-label { font-size: 11px }`,
`.route-elev-tick { font-size: 10px }`) and inner heights (e.g. the
14 px-tall infra bar, the 114 px-tall chart) stay constant across
phone and desktop widths. Only the horizontal extent stretches.

A `window.resize` listener (`attachDirectionsResizeHandler` in
`src/routing/ui.js`) re-runs `renderPrimary` when the panel width
drifts by ≥ 4 px so the SVGs re-render at the new width. The 4 px
deadband avoids thrashing from mobile-keyboard show/hide and other
trivial resize events.

Other details worth knowing for these SVGs:

- The infra bar runs **a single row per side** at fixed y zones (top
  zone 32 px, bottom zone 36 px, plus a 14 px bar). Labels are
  x-placed with symmetric repulsion relaxation (each overlapping pair
  pushes both members by half the overlap, then both clamp to
  viewBox; iterate till stable). Connector horizontal-segment y
  values are then assigned by **exhaustive search**: each side has
  up to ~5 labels and we try 5 discrete y levels per connector
  (≤ 5⁵ = 3,125 evaluations), picking the assignment with the
  fewest leg/horizontal crossings (vertical-leg × horizontal-line
  intersections, plus same-y horizontal overlap), with total
  perturbation-from-default as the tiebreaker. This handles the
  case where two connectors are at different y values but their
  L-shapes still cross — the search finds a swap that clears the
  crossing if one exists. See `infraSummaryBarSvg` for the layout.
  Sub-1% categories label as `<1%` rather than rounding to `0%`.
- The elevation chart's inner `pad` is `{ l: 40, r: 22, t: 32, b: 16 }`.
  `pad.l = 40` is sized for the y-axis tick labels ("525 ft" ≈ 32 px
  at the 10 px tabular-nums tick font, anchored end-aligned at
  `x = pad.l - 4`). `pad.r = 22` is sized for the centered cursor
  tooltip text (~36 px wide for "+24.5%") at the right end of the
  chart. If you change either label's content (e.g. add a unit suffix
  beyond "ft"), revisit those numbers.
- The chart's resolution comes from per-polyline-vertex elevations in
  `graph.geomElevs[]` (a parallel array to `graph.geoms[]`, one float
  per shape point). It is NOT linear interpolation between node
  elevations. See the Elevation pipeline section — short version:
  USGS 3DEP DTM sampled at every polyline vertex, then median-5 +
  Gaussian σ=2 smoothed at build time.

Decisions worth remembering:
- **Sheet vs. side panel**: the owner explicitly chose bottom sheet
  (familiar Google / Apple Maps pattern). Don't refactor to a hamburger
  drawer without re-asking.
- **No new npm deps** for the drag controller — implemented inline in
  `src/sheet.js`.
- **Map symbols not resized on mobile** (bike-rack / bike-sign dots stay
  small for legibility when they're dense). Mobile-tap-target work for
  those POIs is deferred and will land via a different mechanism later.
- **Layers checkboxes live in ONE place** — `<div id="layers-panel">`.
  CSS reshapes it (top-right pill on desktop, full-screen overlay on
  mobile when `.open`). Do not clone the fieldsets and don't wrap them
  in a `<dialog>` — earlier attempts at this broke the desktop render
  because `<dialog>` defaults to `display: none` and CSS overrides
  proved fragile.
- **Mobile keeps desktop visuals.** Don't bump paddings, font sizes, or
  hit-target dimensions inside the @media block. The owner verified
  that mobile should look like the desktop layout, just repositioned
  into a sheet.
- **Layers FAB shows on desktop too** — toggles `#layers-panel`
  visibility on desktop (default visible → FAB starts pink). Mobile
  uses the same FAB to open the overlay. Both flows are unified in
  `wireLayersModal` in `src/main.js`; the FAB's pink `.active` class
  tracks whether the panel is currently visible. Pink "active" is the
  established affordance for "this toggle is on" — see the segmented
  control's checked label and the Go-button on POI popups.

## PWA architecture

The app is a fully installable PWA with blocking first-run install and
automatic update detection. After install, every byte of data is served
from the local cache — the app boots and operates with zero network
round-trips. The owner explicitly chose blocking install (no online-only
escape hatch).

### Runtime states

A single `localStorage['bikemap-installed-version']` flag (the version
string of the last installed `version.json`) drives three states:

1. **Uninstalled** — `src/main.js`'s `boot()` calls `ensureInstalled()`
   which shows `#install-modal` and blocks `initApp()`. The modal CTA
   ("Download now") streams every file in `public/data/version.json`
   into the SW data cache with per-file streaming progress, then sets
   the flag and lets `initApp()` proceed.
2. **Installed (current)** — flag exists, cached `version.json` matches
   remote. `ensureInstalled()` returns immediately; map init runs; every
   data `fetch()` is served from the SW cache.
3. **Update available** — flag exists, but remote `version.json` differs
   from cached. App boots normally on cached data; `checkForUpdate()`
   shows the non-blocking `#update-banner` with the size delta of
   *changed files only* (per-file hash diff).

### Service worker (`public/sw.js`)

Three caches with intentionally different lifecycles:

| Cache | Contents | Lifecycle |
|---|---|---|
| `bikemap-shell-v${APP_VERSION}` | HTML, JS, CSS, vendored font | Activate event deletes old shell-v* caches |
| `bikemap-data-v1` | PMTiles, GeoJSONs, addr/graph JSON, `version.json` | **Never** cleared by SW lifecycle; managed by `src/pwa/install.js` + `update.js` |
| `bikemap-external-v1` | `protomaps.github.io/basemaps-assets/*` (sprites + glyphs) | Stale-while-revalidate |

Fetch routing priority in the SW:
1. `*.pmtiles` → `handlePmtilesRange()` slices the cached ArrayBuffer per
   `Range:` header, returns `206 Partial Content` with proper
   `Content-Range`/`Content-Length`/`Accept-Ranges`. The SW caches the
   full body once; subsequent range requests slice in-memory.
2. `/data/version.json` → network-first with 3s timeout (so updates are
   noticed fast).
3. `/data/*` → cache-first.
4. `protomaps.github.io` → SWR.
5. Same-origin → cache-first (shell cache).
6. Else → passthrough.

Two placeholders in `sw.js` are rewritten at build time by
`vite-plugins/precache-manifest.js`:
- `__APP_VERSION__` — used in shell cache name (defaults to a UTC
  timestamp; override with `APP_VERSION=foo npm run build`)
- `__PRECACHE_MANIFEST__` — array of dist-relative paths the SW
  pre-caches on install (everything in `dist/` minus `tiles/`, `data/`,
  `sw.js`, `manifest.webmanifest`, and the bikemap.svg source)

### Install / update flow

`src/pwa/install.js` (`ensureInstalled`):
- Returns immediately if the install flag is set.
- Otherwise waits for the SW to be controlling
  (`navigator.serviceWorker.ready` via `waitForController()`).
- Fetches `./data/version.json` from network (no cache yet).
- Populates `#install-size` with `formatBytes(totalGzippedBytes)`.
- Shows iOS hint (`#ios-hint`) when `isIOS() && !isStandalone()` — without
  Add-to-Home-Screen on iOS, persistent storage is not granted and the
  cache may be evicted by ITP after 7 days of disuse.
- On user click: sequentially downloads each file via streaming
  `ReadableStream` reader, writes each to `bikemap-data-v1`, updates
  aggregate progress (weighted by size — the 62 MB routing graph
  dominates ~75% of the bar).
- Also caches `version.json` so the next launch can diff.
- Calls `navigator.storage.persist()` (best-effort).
- Sets the install flag and hides the modal.

`src/pwa/update.js` (`checkForUpdate`):
- Honors a `sessionStorage['bikemap-update-dismissed-until']` cooldown
  so refreshing the tab doesn't re-show after Later.
- Fetches fresh `version.json`, diffs per-file against the cached
  manifest, shows the banner if anything changed.
- "Update" runs a scoped `downloadAll()` (same code path as install)
  for just the changed files, swaps the cached version.json, updates
  the flag, prompts reload.

`src/pwa/version.js` is the shared helper: `fetchRemoteManifest()`,
`getCachedManifest()`, `diffManifests()`, `waitForController()`,
`formatBytes()`, `inferContentType()`.

`src/pwa/platform.js` does `isIOS()` / `isStandalone()` and stashes the
Chrome/Edge `beforeinstallprompt` event for an optional explicit
Install button later.

### Build pipeline additions

The data-refresh sequence (in CLAUDE.md's Quickstart) now ends with:

```bash
python3 scripts/build_data_manifest.py    # always last
```

This walks `public/data/` + `public/tiles/`, sha256-hashes each file
(truncated to 16 hex chars), and emits `public/data/version.json` with
`{ version, files: [{ url, size, gzippedSize, hash }, ...] }`. The list
of included files is **explicit** in `TARGETS` — not a glob — so
staging files like `contours_new.geojson` don't accidentally ship.

PWA-specific build steps (one-shot or rerun-on-asset-change):

```bash
npm run build:fonts      # vendor Material Symbols woff2 + CSS into public/fonts/
npm run build:icons      # rasterize public/icons/bikemap.svg → PNGs
npm run build:manifest   # generate public/data/version.json
npm run build:pwa        # all three above
```

`build:fonts` requires `curl`. `build:icons` requires
`brew install librsvg`. Once committed, these don't need to re-run
unless the source SVG, the font, or the data files change.

### Why hand-rolled SW instead of vite-plugin-pwa

PMTiles range-request handling is custom code anyway (Workbox doesn't
do it), the version-diffing update flow is custom, and a single 180-LOC
auditable `sw.js` is more transparent than Workbox's runtime caching
config. The only meta the SW needs from the build is the precache
manifest, which is a 25-line custom vite plugin.

### iOS specifics

- `viewport-fit=cover` in the viewport meta is required for
  `env(safe-area-inset-*)` to return non-zero.
- `apple-mobile-web-app-capable=yes` makes Add-to-Home-Screen launch
  standalone (no Safari URL bar).
- `apple-mobile-web-app-status-bar-style=default` keeps a translucent
  status bar; the white `.install-card` extends behind it correctly.
- The `@media (display-mode: standalone)` block in style.css adds
  `safe-area-inset-top` padding to `#app-header` so the title doesn't
  collide with the dynamic island, and `safe-area-inset-bottom`
  padding to `#sheet` so the drag pill / inputs aren't under the home
  indicator.

### Vendored Material Symbols

`fonts.googleapis.com` is no longer linked from `index.html`. The font
lives in `public/fonts/material-symbols-outlined.woff2` (~311 KB
variable font, all glyphs at opsz=24 wght=400). Sourced via
`scripts/fetch_material_symbols.sh` which scrapes the woff2 URL from
Google's CSS endpoint, downloads it, and writes a local `@font-face`
declaration. Re-run the script to refresh; output is committed.

## What's intentionally out of scope (so far)

- GitHub Actions deploy workflow (one-liner when wanted; the build
  already produces a clean `dist/`).
- **Online geocoder fallback** for addresses missing from OSM. Constraint
  is no API keys / fully static. Photon (`photon.komoot.io`) would fit
  if this relaxes; for now coverage gaps mean the user drops a pin.
- **Comfort summary panel** (% AAA, sign count, # protected crossings,
  etc.) — owner wants eventually but explicitly deferred.
- **Side-of-street rendering** (parallel offset lines for bike
  facilities). SDOT doesn't publish the side; inferring from geometry
  vs. road centerline would be a whole preprocessing pipeline.
- **Refresh automation** for snapshots — manual is fine while the data
  model is still evolving.

## Hard-won lessons

- **`position: fixed` inside a transformed ancestor is positioned
  relative to that ancestor, NOT the viewport.** The bottom-sheet's
  `transform: translateY(...)` made it a containing block for any
  fixed-positioned descendant. An "always-on-top" title bar nested
  inside `#sheet` therefore moved with the sheet's translateY,
  appearing at the top of the SHEET (which was mid-screen) rather
  than the top of the SCREEN. The fix is structural: keep
  fixed-positioned chrome OUT of any transformed ancestor — make
  `#app-header` a top-level sibling of `#sheet`, not a child.
- **`<svg width="100%" viewBox="0 0 W H">` uniformly scales the
  entire SVG**, including text font-size and inner shape heights, with
  the container width. That's a problem when you want a responsive
  *width* but a stable *height + font*. The fix is to render with
  `width="<px>" height="<px>" viewBox="0 0 <px> <px>"` (1:1 viewBox
  to pixel), recomputing the pixel width at render time from the
  container's clientWidth. Then 1 viewBox unit = 1 screen pixel and
  font sizes/heights stay constant. See `directionsPanelInnerWidth`
  + `attachDirectionsResizeHandler` in `src/routing/ui.js` and the
  Summary-block SVGs section under Mobile layout.
- **Owner ground truth wins over indirect analysis.** I've made
  successive overclaims from indirect signals (addr/node density →
  "neighborhood gap", building polygons without `addr:housenumber` → "65%
  coverage") and been wrong every time. The owner corrected each with
  field knowledge. When in doubt about empirical claims, measure against
  the actual ground truth (parcel data, permits, owner's lived
  experience) rather than relying on a proxy.
- **Don't trust SDOT field names that sound right** without sampling the
  data. SEGMENT_TYPE=15 looked like alleys until I measured: median 6 m,
  max 36 m. Always dump representative features (with geometry) before
  depending on a code.
- **Don't add SDOT `UNITDESC` as a streetName fallback.** Verbose all-
  caps with "BETWEEN X AND Y" suffixes; fragments direction grouping.
  Use OSM `name` only; tolerate null for unnamed paths.
- **`setLayoutProperty` accepting an expression doesn't mean the initial
  style validator will.** Different code paths; the initial validator is
  stricter around deep nesting / variable shadowing. Test in the SAME
  shape it'll appear in the style passed to `new Map(...)`.
- **The owner is faster at visual verification than you.** Ship the
  change and tell them how to verify (what to click, what to look for)
  rather than running `preview_screenshot` loops yourself. `npx vite build`
  catches syntax errors in seconds; trust that, ship, ask the owner to
  look.
- **Preview server gets stuck on style-load after repeated
  `location.reload()` via `preview_eval`.** Restart the server cleanly
  (`preview_stop` → `preview_start`) instead of chasing the hang. The
  hang is a harness flake, not a code bug.
- **POIs need extra care for graph snapping.** A POI's centroid often
  sits inside a building footprint or a park where the only nearby
  routable edges are on a disconnected trail island. Use the assigned
  nearest-housenumber coords (`ax`, `ay` in addr_index records) AND
  filter snap candidates to the main connected component in
  `graph.findNearestEdgeProjection`. Both fixes are in.
- **When MapLibre layer click handlers cascade**, use
  `queryRenderedFeatures` to detect "is the click also on a route line"
  rather than relying on `preventDefault()` — `preventDefault()` does NOT
  stop other layer handlers.
- **The IDB error in the console is a distraction.**
  `IDBDatabase: connection is closing` is benign teardown noise from a
  previous failed page load. Multiple sessions have chased it with
  unhandled-rejection handlers that introduced new bugs. Hard reload
  makes it go away.
- **Owner invariant: visual classification = routing classification.**
  Anything that renders in a tier color on the map (dark green = AAA,
  medium green = BBL, etc.) must also be routed at that tier's
  multiplier. The AAA tier is the trap because its visual is the union
  of FOUR sources (bike_facilities AAA + multi_use_trails +
  kc_regional_trails + bike_plus_network Existing*) — if you add another
  source to `addDataLayers` that paints dark green, also add it to
  `spatial_join_facilities` in `build_graph.py`. Don't ask "is this in
  bike_facilities?" — ask "what color does it render?"
- **Spatial joins by proximity bleed attributes across intersections.**
  At a trail × street crossing, the street centerline literally passes
  through the trail centerline; a "nearest feature within R" lookup will
  pick the street even when matching a trail OSM edge. This is why
  `spatial_join_streets` skips trail-class edges entirely — otherwise an
  OSM-bidirectional cycleway picks up `ONEWAY='Y'` from a one-way side
  street and the directed-edge expansion silently severs reverse-
  direction connectivity, producing dramatic detours (a 16 ft hop
  became a 0.574 mi loop until this was fixed). If you ever add another
  proximity-based join that pulls *attributes* (not just classification),
  apply the same exclusion or use a "match same feature kind" filter.
- **"Nearest single node" snap can miss the intersection center.** OSM
  models each curb-side stop sign / signal head as its own degree-2 node
  ~20–30 ft from the actual intersection center. If you snap a point
  feature to the nearest node, several stops at one intersection each
  go to a different curb node and none land on the intersection center
  where `crossingPenaltyFt` actually evaluates. The signal/crosswalk/
  beacon/stop snap loops therefore OR into EVERY node within radius.
  Curb-node duplicates are benign (crossings only fire at multi-way
  junctions). If you add another point-snap, default to OR-all-in-radius.
- **SDOT sign-type codes use MUTCD.** Stop signs are `SIGNTYPE='R1-1'`
  (TEXT='STOP'), `CATEGORY='REGMIS'`. Speed-limit signs are R2-*, in
  CATEGORY='REGSL' ("SL" is "Speed Limit", not "stop limit" as one might
  guess). When adding any new sign type, look up the MUTCD code rather
  than searching CATEGORY/CATEGORYDESCR text. **FACING is the direction
  the sign physically points = the bearing approaching traffic is
  travelling** (so FACING='E' stops eastbound traffic). 8 cardinal
  values: N, NE, E, SE, S, SW, W, NW.
- **`s2` slider was historically inverted in labels/comments.** The
  formula `turnPenaltyFt = 500 · s2` means higher s2 → bigger per-turn
  penalty → fewer turns. The old label "detour tolerance — higher =
  accept more turns" claimed the opposite; the old "More direct" twist
  used `s2: −0.3` which under the correct reading made A* accept MORE
  turns, not fewer. Now fixed: label is "Prefer fewer turns", "More
  direct" uses `s2: +0.5`. Lesson: when a slider has an inversion bug,
  fix the *label* (and twist deltas), not the formula, because the
  formula is also referenced by `weights.turnPenaltyFt` semantics across
  the engine.
- **A\* is admissible *and consistent* under the haversine heuristic** —
  proven by triangle inequality (no edge costs less per foot than its
  straight-line distance because every multiplier ≥ 1.0, and turn /
  crossing penalties are ≥ 0). So first-pop = optimal, no re-expansion
  needed. If you ever find A\* picking a "worse" route, the bug is
  almost never in A\* — it's usually (a) a graph-topology issue (severed
  connectivity), (b) sign-coverage is added POST-route so the displayed
  total differs from the A\* objective, or (c) the displayed route is a
  twist with perturbed weights rather than the primary.
- **Elevation has its own section.** See "Elevation pipeline" above
  for the full current-state, schema, and lessons. Short version:
  smoothed + resampled USGS DTM → heat-eq correction over the
  flagged subgraph (bridges, tunnels, layered, untagged crossings,
  approaches within 200 ft polyline distance) → linear-interp'd geom
  profiles + analytic climb metrics. Multi-level shared-node
  junctions remain a localized failure mode; accepted because slopes
  are still reasonable.
- **BFS-style annotations over-count without a polyline cutoff.** A
  node-granularity "within N ft graph-walk" BFS flags whole edges
  whenever either endpoint is in range, so a 400-ft block edge with
  one endpoint just inside the radius gets fully flagged. Splitting
  the edge at the precise arc-length cutoff (inserting a degree-2
  interior node at the isoline; flagging only the close half) gives
  a much cleaner correction surface — ~700 new interior nodes added
  for the 200 ft approach radius here, ~29 mi of polyline length
  trimmed. The split is one extra pass after the BFS; it doesn't
  require changing the BFS itself. See `apply_approach_splits` in
  build_graph.py.
- **The heat equation on graph adjacency is the right elevation
  primitive.** For any "correction surface" of edges whose DTM
  elevations are wrong, with boundary nodes at the surface's
  transition to trustworthy territory: solve `min Σ_edges (e_u −
  e_v)² / L_{uv}` with boundary fixed. Linear, SPD, cheap (dense
  numpy on each group). The Dirichlet condition makes the
  one-node-one-elevation invariant work out — interior nodes inherit
  smooth interp from their boundary anchors. Crucially, this is
  solved on graph adjacency NOT 2D geometry, so paths that 2D-cross
  without a shared OSM node naturally stay at independent elevations.
  Shared-node coupling at multi-level junctions IS a failure mode
  (the solver collapses the two paths there), but it's local and
  acceptable for slope-driven consumers.
- **"What does the consumer need?" prunes the problem.** When the
  consumer is a bike-routing cost function (slopes + elevation gain),
  absolute layer ordering between physically-stacked paths doesn't
  matter — only that each path's per-edge slope is reasonable. That
  insight let us accept the heat-eq's failure mode at multi-level
  junctions without engineering a fix. If a future consumer needs
  absolute elevations (e.g., 3D rendering), revisit.
- **Predict, then measure.** I predicted ~15% of hard-case internal
  crossings would have heat-eq collapse (the "Case B" shared-node
  failure mode); the real number was 76%. Multi-level structures
  in real Seattle have much denser shared-node coupling than the
  abstract case suggests. Don't pre-commit to a path based on
  theoretical predictions when you can run the experiment in 5
  minutes.
