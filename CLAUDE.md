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
src/labels.js      Hand-rolled symbol layers for road/place/water names
src/visibility.js  Multi-group visibility manager (layer can belong to >1 group)
src/popups.js      Per-layer click popup formatters + code decoder dictionaries
src/style.css      Map fullsize, controls panel, popup styles

public/data/       Snapshot GeoJSON (regenerable; see fetch_data.py)
public/data/seattle_polygon.geojson   Seattle boundary from OSM (used for clipping)
public/tiles/seattle.pmtiles          Basemap extract (~62 MB)

scripts/fetch_data.py     ArcGIS REST → GeoJSON, clipped to Seattle polygon
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
python3 scripts/fetch_data.py
```

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

### `preview_*` tools

- `preview_eval` errors with "Style is not done loading" before tiles
  arrive. Poll `isStyleLoaded()`.
- `preview_console_logs` returns stale entries (with old vite `?t=`
  timestamps) that look live. To force a clean state, use
  `location.replace(origin + '?bust=' + Date.now())`.
- The viewport sometimes collapses to 1px. Check `window.innerHeight`; if 1,
  call `preview_resize` with explicit `width`/`height`.
- The preview server can disconnect between sessions — restart with
  `preview_start` using the config in `.claude/launch.json`.

### Data fetching

- `f=geojson&outSR=4326&geometryPrecision=6` works for both ArcGIS Online
  FeatureServer AND the older King County MapServer. Paginate with
  `resultOffset` + `resultRecordCount` using each layer's `maxRecordCount`.
- ArcGIS occasionally returns features with `null` geometry. `clip_features`
  skips them defensively.
- Nominatim TOS: send a real User-Agent. The fetch script uses
  `bikemap-prototype/0.1`. The Seattle polygon is cached after the first
  fetch (`public/data/seattle_polygon.geojson`) — don't hammer them.

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

## What's intentionally out of scope (so far)

- GitHub Actions deploy workflow (one-liner when wanted; the build already
  produces a clean `dist/`).
- Geolocation, search, route planning.
- A custom >40% steep-slope layer — owner has plans for this separately.
- Refresh automation for snapshots — manual `fetch_data.py` is fine
  while the data model is still in flux.

## If you're picking this up after a long break

1. `npm install`
2. `npm run dev`
3. Open the map, click around, read each popup, check each toggle.
4. Read `src/layers.js` top-to-bottom — that's where 80% of decisions live.
5. If the owner mentions something looks wrong, your default move is to
   ask them which layer/feature and start there. Don't pre-emptively
   restructure.
