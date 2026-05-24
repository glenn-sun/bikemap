# CLAUDE.md — Bikemap

Notes for future Claude sessions working on this project. Read this first.

## Project at a glance

Static site (GitHub Pages target) showing Seattle bike infrastructure on a
MapLibre GL JS + Protomaps PMTiles basemap. No API keys anywhere — data
is snapshotted from SDOT + King County ArcGIS REST as GeoJSON; basemap is
a Seattle-area `.pmtiles` extract committed to the repo.

The owner uses it to navigate Seattle by bike and wants visual nuance the
official ArcGIS Experience map lacks. Built on macOS / arm64.

## Working with the owner

- **AskUserQuestion is welcome.** Use it freely to clarify intent or pick
  between approaches.
- **The owner verifies UI themselves and is faster at it than you are.**
  Once the basics render, don't burn cycles in `preview_screenshot` loops —
  ship the change and let them tell you what's off. They explicitly asked
  for code velocity over agent-side visual testing.
- **Reuse the owner's terminology.** "AAA" = all ages & abilities (= dark
  green tier). "Planned" = Bike+ Network proposals. Don't invent synonyms.
- **When the owner corrects you, accept it.** They have ground truth from
  riding the streets (see PLNRECON below — I assumed it meant "nothing
  exists yet"; they verified it means "exists, planned for upgrade").
- **Tell them how to verify your work** at the end of each task. Usually:
  what to look at on `http://localhost:5173`, what to click.
- **Python: always venv.** `.venv/` is already in `.gitignore`.

## Layout

```
src/main.js        Orchestrator: pmtiles protocol, style assembly, glue
src/layers.js      Every SDOT/KC data layer; paint/filter expressions; icon loader
src/basemap.js     Walks Protomaps layer paint and HSL-desaturates colors
src/labels.js      Hand-rolled symbol layers for road/place/water names;
                   also exports abbreviateDirectionalsStr for the directions panel
src/visibility.js  Multi-group visibility manager (layer can belong to >1 group)
src/popups.js      Per-layer click popup formatters + code decoder dictionaries
src/style.css      Map fullsize, controls panel, popup styles, route step markers
src/routing/       Client-side routing (graph loader, A*, cost fn, directions, UI)

public/data/       Snapshot GeoJSON (regenerable; see fetch_data.py)
public/data/seattle_polygon.geojson   Seattle boundary from OSM (used for clipping)
public/data/routing_graph.json        Routable graph (~8.5 MB, see build_graph.py)
public/tiles/seattle.pmtiles          Basemap extract (~62 MB)

scripts/fetch_data.py     ArcGIS REST → GeoJSON, clipped to Seattle polygon
scripts/build_graph.py    Overpass + SDOT joins → public/data/routing_graph.json
scripts/make_basemap.sh   pmtiles extract for Seattle bbox

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
python3 scripts/fetch_data.py    # SDOT/KC layers → public/data/*.geojson
python3 scripts/build_graph.py   # OSM (Overpass) + SDOT joins → routing_graph.json
```
`build_graph.py` reads the GeoJSONs that `fetch_data.py` wrote, so the order
matters. Overpass query is bbox-only; full Seattle pulls ~700k OSM elements
and takes 30–90 s. The output graph is ~8.5 MB.

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
`public/data/seattle_polygon.geojson` instead (fetched from Nominatim;
cached on first run).

### `bike_facilities.CURRENT_STATUS`

| Code | Meaning | Render |
|---|---|---|
| `INSVC` | In service | Solid in category color |
| `PLNRECON` | **In service today**, upgrade planned later | Solid in category color (same as INSVC) |
| `UNDERCONS` | Being built right now | Dotted `[1, 2]` in category color |
| anything else (null, blank) | Out of service | Hidden |

PLNRECON is **owner-verified to mean "exists, planned for upgrade"**, not
"planned from scratch". Treat it as in-service for rendering; popup says
"In service · upgrade planned". The strategic *brand-new* future network
lives in a different source: `bike_plus_network` with `bike_network_category`
starting with "Proposed".

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

### Out-of-service filters (applied at the MapLibre layer level)

These are layer `filter` expressions, not data-fetch filters — keeps data
complete and reversible without re-fetching.

- `parks_restrooms`: `OPENTOPUBLIC = 'YES'` AND `LIFECYCLESTATUSTXT = 'A'`
  AND `CURRENTSTATUS != 'CLOSED'`
- `community_centers`: `OPERATIONALSTATUS = 'Open Regular Hours'`
- `bicycle_racks`: `CURRENT_STATUS IN ('INSVC', 'PLNRECON')`

These are applied at fetch time (in `scripts/fetch_data.py`) because they
match the original ArcGIS experience and shrink the snapshot:

- `bike_signs`: `CATEGORY = 'GBP' AND CURRENT_STATUS IN ('INSVC') OR NULL`
- `light_rail_stations`: `STATUS = 'COMPLETE'`
- `kc_regional_trails`: `Surf_Type IN ('Paved Trail','On Street Trail')
  AND Owner NOT LIKE '%Seattle%' AND Trail_Type = 'Trail (Regional)'`

## Gotchas (the time-savers)

### Tooling

- **`brew install pmtiles`** — straight from homebrew-core. The old
  `protomaps/tap/pmtiles` tap has been removed and will fail.
- **npm `pmtiles` is at `^4.4.1`**, not v5. Don't get confused by the
  MapLibre style spec version which is unrelated.
- **Vite vanilla template won't scaffold into a non-empty dir** (interactive
  overwrite prompt blocks). Write `package.json` + `index.html` +
  `vite.config.js` by hand instead.
- **Direct GitHub binary downloads can be blocked** by the harness
  classifier when in autonomous mode. Use brew or apt instead.

### `@protomaps/basemaps` (5.7.x)

- **`layers(src, flavor)` returns ZERO label layers.** The `labelsOnly`
  option is documented but also returns nothing in this version. **Labels
  must be hand-written** — see `src/labels.js`. Pull from the pmtiles'
  actual source layers (`roads`, `places`, `water` with their `name` field).
- Glyphs URL that works without a key:
  `https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf`.
  Known-good fontstacks: `Noto Sans Regular`, `Noto Sans Medium`,
  `Noto Sans Italic`. No fontstack-fallback chain needed.
- Sprite (mostly unused): `https://protomaps.github.io/basemaps-assets/sprites/v4/light`.

### MapLibre GL JS

- **`line-width` can't contain a `match` with nested zoom `interpolate`s.**
  Error: "Only one zoom-based step/interpolate subexpression may be used in
  an expression." Solution: split into multiple layers each with its own
  `filter`, like the `bike-facilities-*` family. This is why we have eight
  bike-facility sub-layers instead of one.
- `m.style.sourceCaches` is **`m.style.tileManagers` in v5.x**. Don't trust
  old SO answers.
- `m.getStyle()` returns `undefined` until style loads. Poll
  `m.isStyleLoaded()` with `setTimeout` retries.
- **CSS `filter: saturate()` on `.maplibregl-canvas` affects the data layers
  too** — wrong move. Walk the basemap layers' paint and recompute colors
  in HSL space instead (see `src/basemap.js`).
- **Deeply nested `let` with shadowed variable names breaks initial-style
  validation but passes `setLayoutProperty`.** Hit this while building
  the directional-abbreviation expression in `labels.js`. A 16-level chain
  of `['let', 's', input, ...]` was accepted at runtime but caused
  `map.on('load')` to never fire when the same expression appeared in the
  initial style spec. Fix: collapse the chain into ONE outer `let` whose
  body is a `case` over all branches, not nested `let`s. See
  `abbreviateDirectionals` in `src/labels.js`.
- **For compass bearings, NEGATIVE delta means LEFT turn.** Bearings are
  clockwise (N=0, E=90, S=180, W=270). Heading east (90°) and turning to
  head north (0°) gives `delta = -90` — counter-clockwise rotation =
  LEFT in driving convention. Easy to flip this sign by accident
  (`classifyTurn` in `directions.js` originally had it backwards).
- `IDBDatabase ... connection is closing` in the console is benign teardown
  noise from a previous failed page load. Don't chase it; do a hard reload
  (or Application → Clear site data once). Attempts to swallow it with an
  `unhandledrejection` handler can mask real errors.

### `preview_*` tools

- `preview_eval` errors with "Style is not done loading" before tiles
  arrive. Poll `isStyleLoaded()`.
- `preview_console_logs` returns stale entries (with old vite `?t=`
  timestamps) that look live. To force a clean state, use
  `location.replace(origin + '?bust=' + Date.now())`.
- **The viewport often collapses to 0×0 on a fresh `preview_start`.** Check
  `window.innerHeight`; if 0 or 1, call `preview_resize` with explicit
  `width: 1280, height: 800` (preset='desktop' sometimes also reverts to 0).
  When the viewport is 0×0, MapLibre's style hangs in mid-load with
  `_loaded: false` and `stylesheet: null` and looks like a code bug. Always
  rule out viewport size first when the map mysteriously doesn't load.
- The preview server can disconnect between sessions — restart with
  `preview_start` using the config in `.claude/launch.json`.
- **Synthetic clicks need a proper MapMouseEvent.** Plain `m.fire('click',
  {lngLat, point})` throws "Cannot read properties of undefined (reading
  'target')" inside MapLibre's internal click handler. Use:
  `m.fire('click', new ml.MapMouseEvent('click', m, { type:'click', target:
  m.getCanvas(), preventDefault:()=>{}, defaultPrevented:false, button:0,
  buttons:1, clientX:px, clientY:py, pageX:px, pageY:py, screenX:px,
  screenY:py }, { lngLat, point }))`. Useful for testing the routing UI
  from `preview_eval`.

### Data fetching

- `f=geojson&outSR=4326&geometryPrecision=6` works for both ArcGIS Online
  FeatureServer AND the older King County MapServer. Paginate with
  `resultOffset` + `resultRecordCount` using each layer's `maxRecordCount`.
- ArcGIS occasionally returns features with `null` geometry. `clip_features`
  skips them defensively.
- Nominatim TOS: send a real User-Agent. The fetch script uses
  `bikemap-prototype/0.1`. The Seattle polygon is cached after the first
  fetch (`public/data/seattle_polygon.geojson`) — don't hammer them.
- **Slim wide layers with `out_fields` on the `Layer` dataclass.**
  `Seattle_Streets_1` returns 39 MB if you `outFields=*`, but only ~8 MB
  with the half-dozen fields we actually need. Vite serves `public/`
  flat, so file size IS the user's download size in dev.
- **Overpass via curl needs URL-encoded form data.** A multi-line POST
  body returns 406. Use:
  `curl -sS -X POST "https://overpass-api.de/api/interpreter" -A "ua/0.1" --data-urlencode 'data=[out:json];...'`

### Data traps (don't relearn these)

- **`Street_Network_Database_SND.SEGMENT_TYPE = 15` is NOT alleys.** It
  looked like alleys when sampled (`13TH AVE S`, `3RD AVE S`, etc.) but
  the features are tiny micro-segments (median 6 m, max 36 m) — likely
  intersection corner pieces. For real Seattle alleys, use OSM
  `highway=service` + `service=alley` (~2,300 features, real block-long
  polylines). And honestly, **don't even fetch alleys for routing**:
  `_is_bike_routable` in `build_graph.py` excludes them at parse time, so
  they never enter the graph.
- **`SDOT_Bike_Facilities` has no side-of-street field.** A PBL on the
  north side and a sharrow on the south appear as two separate features
  with the same street name. We don't infer side; the cost function picks
  the best one. `MODEL_TYPE = BKF-ONEWAY` indicates a one-way bike lane,
  but it's only worth a turn-by-turn disclaimer when the road itself is
  two-way (a one-way bike lane on a one-way road is always in your
  direction of travel).
- **`SDOT_Traffic_Circles_view` is incomplete** (~1063 circles, missing
  e.g. 23rd & NE 68th). OSM tagging is also sparse (~50 nodes total in
  Seattle). For coverage, `build_graph.py` runs `detect_geometric_circles`
  which finds short-edge cycles in the OSM topology — picks up ~1100
  additional circles modeled as ring ways.
- **`Seattle_Streets_1` doesn't have a lane-count field.** Derive from
  `SURFACEWIDTH` (paved-roadway width in feet) via
  `lanes = max(1, (SURFACEWIDTH - 7.5) / 10)` — assumes 7.5 ft of parking
  on one side, 10 ft per moving lane. Fall back to ARTCLASS-based defaults
  when SURFACEWIDTH is null.
- **`Seattle_Streets_1` ARTCLASS = 0 means "Not Designated"** (residential
  local), not "missing data". `>= 1` is principal/minor/collector/state —
  used as a proxy for "this road has a painted centerline".

## Styling cheat sheet (current)

| Concept | Style |
|---|---|
| AAA tier | Dark green `#1F6B3D`, solid, `GREEN_WIDTH` |
| BBL | Medium green `#3FA85F`, solid, `GREEN_WIDTH` |
| BL | Light green `#7FCC9C`, solid, `GREEN_WIDTH` |
| Sharrows / climbing | Orange `#E07A1F`, `ORANGE_WIDTH` (narrower) |
| Under construction (any tier) | Same color as installed equivalent, `DOTTED_DASH = [1, 2]` |
| Bike+ proposed | Gray `#9aa1a3`, dotted |
| Bike racks | Dark dot `#333`, radius 0.5→4 px from z9→z17 |
| Bike signs | Bright blue `#1e88e5`, radius 0.7→5 px, white halo z14+ |
| Large POI icons (restroom/library/community center/light rail) | Filled colored circle + white Material Symbols `fill1` glyph + drop shadow, `POI_ICON_SIZE` 0.45→0.9 |

Basemap saturation factor: **0.55** (in `main.js`).

`POI_ICON_SIZE`, `GREEN_WIDTH`, `ORANGE_WIDTH`, `DOTTED_DASH` are exported
constants at the top of `src/layers.js` — change once, apply everywhere.

## Adding a new toggleable layer

1. If the source data is new, add to `LAYERS` in `scripts/fetch_data.py`
   and re-run.
2. In `addDataLayers` (`src/layers.js`):
   - `map.addSource(id, { type: 'geojson', data: DATA(name) })`
   - One or more `add({...})` calls — **use the local `add()` helper, not
     `map.addLayer`** — it injects `beforeId` so labels stay on top.
3. In `wireToggles` (`src/main.js`):
   - `vm.group('newgroup', ['layer-id-1', 'layer-id-2'])`
   - `.bindCheckbox('newgroup', 'toggle-newgroup')`
4. In `index.html`, add the checkbox inside the appropriate `<fieldset>`.
5. If the layer has popup-worthy metadata, add a formatter to
   `src/popups.js` and reference it in `formatters[layerId]`.

## Auditing fields before adding popups

When designing or revising popups, **dump the schema first**. The pattern
that worked:

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

Decisions to make per field:
- Cardinality 1 across all features → drop (uniform, not informative).
- Mostly null → probably drop unless the non-null value is gold.
- Cryptic code → either decode (add to popups.js dictionary) or drop.
- Looks readable (e.g. `UNITDESC` for bike facilities) → keep, titlecase
  if uppercase, surface in popup.

The owner specifically dislikes cryptic abbreviations in popups; if a field
needs context, prefer dropping it over showing a code.

## Code decoders (current dictionaries in `src/popups.js`)

| Field | Codes decoded |
|---|---|
| bike_facilities `CATEGORY` | `BKF-NGW`, `-PBL`, `-OFFST`, `-BBL`, `-BL`, `-CLMB`, `-SHW` |
| bike_facilities `MODEL_TYPE` | `BKF-ONEWAY`, `BKF-TWOWAY` |
| bike_facilities `CURRENT_STATUS` | `INSVC`, `UNDERCONS`, `PLNRECON` |
| bicycle_racks `BIKE_FACILITY` | `SGL`, `CLSTR`, `ONST` |
| bicycle_racks `MODEL_TYPE` | `BKR-INVRU`, `BKR-RLRCK`, `BKR-ARCRE`, etc. |

Unknown codes fall through to the raw value — they don't disappear, they
just look like raw codes. If users report cryptic strings in popups, add
to the dictionary.

## Patterns that work well here

1. **Classify-then-style with separate layers** instead of complex paint
   expressions. Way easier to reason about, debug, and toggle. MapLibre
   also gates certain expression complexity (see the line-width gotcha).
2. **Filter at MapLibre layer level for "show/hide me" rules**; only filter
   at fetch time for things that match the original SDOT/KC experience or
   meaningfully shrink the snapshot.
3. **`HIDDEN` constant** (`rgba(0,0,0,0)`) for fallback colors so unknown
   categories disappear by default. Easy to flip back to a real color when
   the owner wants to audit them.
4. **Always pre-load all four Material icons in parallel** (`Promise.all`)
   before adding the symbol layers, so they never render a broken-image
   placeholder.

## Routing prototype

Client-side bike comfort routing on a precomputed graph. Two halves:

1. **Offline build** (`scripts/build_graph.py`) — Overpass for OSM
   topology, then SDOT spatial joins for attributes. Avoids osmnx/GDAL.
   Writes `public/data/routing_graph.json` (~8.5 MB).
2. **Browser** (`src/routing/`) — A* with the comfort cost function, plus
   the click-to-route UI and turn-by-turn directions.

The whole engine is JS so a future slider UI can tweak weights without
rebuilding the graph. The graph stores EDGE ATTRIBUTES (length, lanes,
facility class, oneway, bearings, centerline) but NOT cost — cost is
computed on the fly in `src/routing/cost.js`.

```bash
source .venv/bin/activate
python3 scripts/build_graph.py     # ~30-90 s
```

### File map

```
scripts/build_graph.py     OSM extract + spatial joins + serialize
src/routing/graph.js       Loader, nearest-node, nearest-edge projection
src/routing/cost.js        Comfort cost constants + edgeCost/turn/crossing fns
src/routing/astar.js       Binary heap A* with virtual start/end (mid-edge)
src/routing/signCoverage.js  Post-route bike-sign coverage multiplier
src/routing/directions.js  Path → step list (fill-in pass, classifyTurn)
src/routing/ui.js          Two-click state machine, route layers, step markers
```

### Build pipeline phases (run in this order)

A. Pull OSM via Overpass (bbox-only). Filter highways via `_is_bike_routable`
   — drop motorways/trunks, service unless `bicycle=designated|yes`, paths
   unless explicit bike access. Alleys (`highway=service` + `service=alley`)
   never enter the graph.

B.1 Extract OSM `highway|junction=mini_roundabout` / `junction=circular` /
    `traffic_calming=island` nodes as supplemental traffic-circle points
    (only ~16 of these in Seattle; OSM tagging is sparse).

C. Spatial-join `seattle_streets.geojson` onto each OSM edge — sample 3-5
   points along the edge, look up nearest SDOT segment within ~15 m via
   shapely STRtree, majority-vote `SURFACEWIDTH`, `ARTCLASS`, `SPEEDLIMIT`,
   `ONEWAY` onto the OSM edge.

E. Spatial-join `bike_facilities.geojson` (filtered to `INSVC` + `PLNRECON`).
   Pick the BEST facility (lowest cost tier) when multiple overlap.

F. Snap `signals` / `crosswalks` / `beacons` GeoJSON points to OSM nodes
   within ~12 m — set bitfield flags on the node.

G. **Geometric circle detection** — find short-edge cycles in the OSM
   topology (3-6 nodes, perimeter ≤ 200 ft, diameter ≤ 60 ft, every node
   has in-cluster degree 2). Picks up ~1,100 neighborhood circles that OSM
   models as ring ways but doesn't tag.

G.1 Collapse all circle-cluster nodes (SDOT + OSM-tagged + geometric) into
    synthetic merged nodes. Edges with both endpoints inside a circle are
    dropped; the merged node inherits the union of external incident edges.
    Tag `isTrafficCircle` so `classifyTurn` knows to skip the turn-cost
    penalty and emit "Turn left at the traffic circle".

H. Expand each undirected edge to one or two directed edges per its
   `oneway` resolution (`forward` / `reverse` / `bidir`). Precompute
   `lengthFt`, `lanes`, `hasCenterline`, `bearingStart`, `bearingEnd`,
   `streetName` (OSM `name` only, no SDOT UNITDESC fallback).

I. Serialize in COLUMNAR layout: parallel arrays per attribute, geometry
   deduped (forward + reverse share a geom index + `reversed` flag), street
   names / facility codes / model types interned. The columnar form is what
   gets the file down to 8.5 MB; per-record JSON-key overhead would bloat
   it to 200+ MB. The router's `graph.js` matches this exact shape.

### Cost-function constants (single source of truth)

All knobs live in `src/routing/cost.js` as exported `const`s. Future
slider UI will mutate them in place.

| Concept | Constant | Default |
|---|---|---|
| AAA tier | `FACILITY_BASE['BKF-NGW' \| 'BKF-PBL' \| 'BKF-OFFST']` | 1.0× |
| BBL | base 1.3 + 0.3 × max(0, lanes − 3) | |
| BL  | base 1.5 + 0.5 × max(0, lanes − 3) | |
| Sharrow / climbing | base 2.0 + 0.5 × max(0, lanes − 3) | |
| No facility, no centerline | `NONE_NO_CENTERLINE` | 1.8 |
| No facility, has centerline | 2.5 + 0.8 × max(0, lanes − 3) | |
| Turn penalty | `TURN_PENALTY_FT` | 200 ft (> 30° heading change) |
| Sign coverage gap | `SIGN_GAP_THRESHOLD_FT` | 1320 (0.25 mi) |
| Sign snap radius | `SIGN_SNAP_THRESHOLD_FT` | 50 ft |
| Sign coverage max | `SIGN_COVERAGE_MAX_MULTIPLIER` | +0.3 |
| Crossing penalty | piecewise (1→0, 2→400, 3→800, 4→1600, 5→1600) ft, > 5 lanes blocked unless signal/crosswalk/beacon | |

Alleys aren't a cost; they're absent from the graph.

Lane count is continuous: `lanes = max(1, (SURFACEWIDTH − 7.5) / 10)`,
assuming 7.5 ft of parking on one side. Has-centerline = `ARTCLASS >= 1`.

### Routing UI

- Click 1 sets start (green pin), Click 2 sets end (red pin) and computes,
  Click 3 resets. "Clear route" button always resets.
- **Mid-edge snapping**: clicks snap to the nearest point on the nearest
  edge within 200 ft via `findNearestEdgeProjection`. A* treats the
  projection as a virtual node whose entries lead to BOTH endpoints of the
  matched edge (cost = partial-edge length × facility multiplier per
  side); whichever endpoint A* reaches first wins. The mid-block tails of
  the route are stitched back onto the rendered polyline.
- Route geometry stitching: `prefixGeom` (projection → first graph node) +
  edge geometries + `suffixGeom` (last graph node → projection).
- Route line is purple `#7e3ff2` over a white casing.
- **Numbered step markers** (`maplibregl.Marker` with custom DOM) overlay
  the route at each step's maneuver point. Step 1 is implicit in the green
  start pin and the "Arrive" step is implicit in the red end pin, so map
  markers go from 2 to N-1.
- Directions panel: `<ol>` of steps with `abbreviateDirectionalsStr` from
  `src/labels.js`. Step grouping is case-insensitive on the normalized
  OSM name.
- **Unnamed-connector fill-in**: before grouping, any run of null-named
  edges sitting between two same-named edges with total length ≤ 100 ft
  adopts the surrounding name. Catches OSM way-splits at driveways /
  bridge expansion joints / jurisdiction boundaries that would otherwise
  emit a tiny "Continue" sub-step.
- **One-way bike-lane disclaimer** ("may or may not be in direction of
  travel") only appears when the bike lane is one-way (`BKF-ONEWAY`) AND
  the underlying road is two-way. On a one-way road, the bike lane
  direction matches travel direction.

### Debug toggles for verifying inputs

In the "Routing" fieldset:

- **Traffic signals (debug)** — red dots.
- **Crosswalks (debug)** — yellow dots.
- **Beacons (debug)** — purple dots (RFB + school).

These read raw SDOT GeoJSON so the owner can sanity-check classifications.
(The "Alleys (debug)" toggle was removed — alleys aren't in the routing
graph at all, so there's nothing to verify.)

### Known caveats

- **Side-of-street** isn't inferred from `bike_facilities` (data lacks the
  field). The router treats a facility as bidirectionally applicable.
  Owner accepted this; one-way bike lanes get the disclaimer when the
  road is two-way.
- **OSM ↔ SDOT spatial join** uses ~15 m majority-vote sampling. Some
  edges near major intersections will mistag. Iterate after first owner
  feedback rather than over-engineering.
- **Traffic-circle gaps remain.** SDOT (1063) + OSM-tagged (~16) +
  geometric detection (~1100) catches most Seattle circles, but circles
  modeled in OSM as a single 4-way junction with no special tag and no
  ring-of-ways topology are indistinguishable from a normal intersection.
  Net effect: route emits "Turn left" instead of "Turn left at the
  traffic circle" — visually correct, just less specific.
- **`isAlley` flag is gone.** Routing excludes alleys at OSM parse time
  (`_is_bike_routable`), so the per-edge flag added nothing. Flag bitfield
  is now `1 = hasCenterline`, `2 = oneway`. If you re-add a flag bit,
  update both `build_graph.py:renumber_and_serialize` and `graph.js`.

## What's intentionally out of scope (so far)

- GitHub Actions deploy workflow (one-liner when wanted; the build already
  produces a clean `dist/`).
- **Slider UI for cost-function tuning.** Constants in `src/routing/cost.js`
  are structured for easy exposure — the next step is binding them to
  range inputs and triggering a recompute on change.
- **Address geocoder** for routing endpoints. Click-to-set only. Nominatim
  is used in `fetch_data.py` but not from the browser. If you add this,
  respect their TOS (real User-Agent, low rate).
- Comfort summary panel (% AAA, sign count, # protected crossings, etc.)
  — owner wants this eventually but explicitly deferred for v1.
- **Side-of-street rendering** (parallel offset lines for bike facilities).
  Considered, then dropped: SDOT doesn't publish the side, so inferring it
  from polyline geometry vs. the road centerline would be a whole
  preprocessing pipeline of its own. Current rendering shows the best
  facility on each segment, with a turn-by-turn disclaimer for one-way
  bike lanes on two-way roads.
- A custom >40% steep-slope layer — owner has plans for this separately.
- Refresh automation for snapshots — manual `fetch_data.py` +
  `build_graph.py` is fine while the data model is still in flux.

## If you're picking this up after a long break

1. `npm install`
2. `npm run dev`
3. Open the map. Click around, read each popup, check each toggle. Then
   click two points to compute a route.
4. Read in this order to get the lay of the land:
   - `src/layers.js` — 80% of the data-layer decisions
   - `src/routing/cost.js` — all routing knobs in one file
   - `scripts/build_graph.py` `main()` — build pipeline phases
5. If the owner mentions something looks wrong, your default move is to
   ask them which layer/feature and start there. Don't pre-emptively
   restructure.

## Hard-won lessons from prior sessions

- **Don't trust SDOT field names that sound right** without sampling the
  data. SEGMENT_TYPE=15 looked like alleys until I measured: median 6 m,
  max 36 m. They're micro-segments. ALWAYS dump a few representative
  features (with geometry) before depending on a code.
- **Don't add SDOT `UNITDESC` as a streetName fallback.** It's verbose
  all-caps with "BETWEEN X AND Y" suffixes; fragments direction grouping.
  Use OSM `name` only; tolerate null for unnamed paths/connectors.
- **The IDB error is a distraction.** Multiple sessions chased
  `IDBDatabase: connection is closing` and the fixes (unhandled-rejection
  handlers, etc.) introduced new bugs. It's benign teardown noise from a
  previous failed page load. A hard reload makes it go away.
- **When the preview map "doesn't load," check the viewport size first.**
  `window.innerHeight === 0` is the most common cause of an apparently
  broken map. `preview_resize` with explicit width/height.
- **`setLayoutProperty` accepting an expression doesn't mean the initial
  style validator will.** They're different code paths; the initial
  validator is stricter (or has different bugs) around deep nesting and
  variable shadowing. Test the expression in the SAME shape it'll appear
  in the style passed to `new Map(...)`.
- **The owner is faster at visual verification than you.** Ship the change
  and tell them how to verify (what to click, what to look for) rather
  than running `preview_screenshot` loops yourself. They flagged this as
  an explicit preference for code velocity.
- **When the owner corrects an assumption, the data is the ground truth.**
  PLNRECON, the alley question, the 23rd & NE 68th circle gap — every
  time my a-priori reasoning disagreed with the owner's lived experience,
  they were right. Don't argue; verify with data.
