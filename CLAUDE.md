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
                   loads + persists checkbox state to localStorage
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
                                    isolated trail islands)
                     cost.js        Slider → raw constants formulas;
                                    presets; twist definitions
                     astar.js       Binary-heap A* + findPathsMulti
                                    (primary + filtered twists)
                     signCoverage.js  Post-route sign-coverage multiplier
                     directions.js  Path → step list (unnamed-connector
                                    fill-in; classifyTurn)
                     mode.js        Tiny shared bus for "choose on map" mode
                     ui.js          Inputs, autocomplete, settings modal,
                                    tabs, alts, choose-on-map, graph debug

public/data/       Snapshot GeoJSON (regenerable; see fetch_data.py)
public/data/seattle_polygon.geojson   Seattle boundary from OSM (used for clipping)
public/data/routing_graph.json        Routable graph (~8.5 MB, see build_graph.py)
public/data/addr_index.json           OSM addresses + POIs index (~19 MB,
                                       see build_addr_index.py)
public/tiles/seattle.pmtiles          Basemap extract (~62 MB)

scripts/fetch_data.py        ArcGIS REST → GeoJSON, clipped to Seattle polygon
scripts/build_graph.py       Overpass + SDOT joins → public/data/routing_graph.json
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
pip install requests shapely
python3 scripts/fetch_data.py         # SDOT/KC layers → public/data/*.geojson
python3 scripts/build_graph.py        # OSM (Overpass) + SDOT joins → routing_graph.json
python3 scripts/build_addr_index.py   # OSM addresses + named POIs → addr_index.json
```
`build_graph.py` reads the GeoJSONs `fetch_data.py` writes, so run them
in order. `build_addr_index.py` is independent of `build_graph.py` but
reads `seattle_polygon.geojson` (`fetch_data.py` creates it), so run
`fetch_data.py` first if missing. Overpass queries are bbox-only; full
Seattle pulls take 30–90 s each. Output sizes: routing_graph ~8.5 MB,
addr_index ~19 MB.

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
  click handlers — `preventDefault()` does not stop them.** To suppress
  popups for layers underneath a clicked route line, use
  `map.queryRenderedFeatures(e.point, { layers: ['route-line', 'route-alt-line'] })`
  and early-return when any feature is found. See `src/popups.js`.

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
   Writes `public/data/routing_graph.json` (~8.5 MB).
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
   `streetName` (OSM `name` only).
I. **Serialize columnar**: parallel arrays per attribute; geometry deduped
   (fwd/rev share index + `reversed` flag); strings interned. This
   columnar form is what gets the file to 8.5 MB; per-record JSON-key
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
Turning the gate off force-unchecks all 5 debug toggles (each
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
  app boot in `routing/ui.js` (`startUserLocationTracking`).
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
- `bikemap-routing-debug-enabled` — `"true" | "false"` (default `"false"`); when `false`, the Routing debug fieldset in the layers panel is hidden and all 5 debug toggles are force-cleared at boot.
- `bikemap-cycling-speed-mph` — number, 4–25, default 10 (drives the
  predicted-minutes display)
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
- **Routing graph** — overlays the entire bike-routable graph: every
  edge as a magenta line, every node as a small dark-pink circle.
  Edges are deduped by `geomIndex` (fwd/rev share). Useful for spotting
  isolated trail islands, snap targets, edge-coverage gaps.

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
- **Bitfield reference.** Edges: `1 = hasCenterline`, `2 = oneway`
  (alleys were removed entirely at OSM parse time via
  `_is_bike_routable`, so no `isAlley` bit). Nodes: see Step F.

## What's intentionally out of scope (so far)

- GitHub Actions deploy workflow (one-liner when wanted; the build
  already produces a clean `dist/`).
- **Elevation / flatter-terrain preference.** The 5th slider (`s5`,
  UI label "Prefer flatter terrain (coming soon)") is wired into the UI
  and persisted but does nothing — the routing graph carries no
  elevation. Owner has plans for a >40% steep-slope layer; once
  elevation is in `routing_graph.json`, wire `s5` into the cost
  function.
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
