# Seattle Bike Map

A static MapLibre + Protomaps rendering of Seattle's bike infrastructure,
sourced from SDOT's public ArcGIS services and King County's GIS portal.
No API keys, no third-party tile provider — everything ships in the repo.

## Quickstart

```bash
npm install
npm run dev      # http://localhost:5173
```

The repo already contains `public/data/*.geojson` and `public/tiles/seattle.pmtiles`,
so the map runs out of the box.

## Refreshing the data

Pull the latest SDOT / King County data (re-run any time):

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install requests
python3 scripts/fetch_data.py
```

Overwrites every file in `public/data/`. Filters from the official ArcGIS
experience are preserved (light rail stations limited to `STATUS = 'COMPLETE'`,
bike signs limited to `CATEGORY = 'GBP'`, King County trails limited to
regional paved trails outside Seattle).

## Refreshing the basemap

```bash
bash scripts/make_basemap.sh 20260521   # pick a recent date from build.protomaps.com
```

`pmtiles extract` clips a Seattle-area window (`-122.55,47.40,-121.95,47.85`,
maxzoom 15) directly from the global Protomaps daily build using HTTP range
requests — the full ~120 GB planet is never downloaded. Output is ~60 MB.

Install the `pmtiles` CLI once: `brew install pmtiles`.

## Deploy to GitHub Pages

```bash
npm run build
# dist/ contains the static site; push to gh-pages or wire a GH Action.
```

`vite.config.js` uses `base: './'` so the build works under any GitHub Pages
path (root or subpath).

## Layers

| Layer | Source | Filter |
|---|---|---|
| Existing Bike Facilities | SDOT `SDOT_Bike_Facilities/2` | colored per `CATEGORY` (PBL, BBL, BL, NGW, …) |
| Multi-Use Trails (Seattle) | SDOT `SDOT_Bike_Facilities/1` | — |
| Bike+ Network (existing + planned) | SDOT `Seattle_Transportation_Plan_Bicycle_Element/9` | dashed if proposed |
| Bicycle Racks | SDOT `Bicycle_Racks_(Active)/0` | shown z≥13 |
| King County Regional Trails | KC `recreatn__trail_line/MapServer/273` | paved, regional, outside Seattle |
| Link Light Rail Stations | SDOT `Sound_Transit_Link_Light_Station_Point/0` | `STATUS='COMPLETE'` |
| Seattle Public Library | SDOT `Seattle_Public_Library/0` | — |
| Community Centers | SDOT `Community_Centers/0` | — |
| Park Restrooms | SDOT `Parks_Restrooms/0` | — |
| Seattle City Limits | SDOT `Seattle_City_Limits/0` | — |
| Bike Route Signs | SDOT `SDOT_Street_Signs/1` | `CATEGORY='GBP'`, shown z≥14 |

## Layout

```
src/main.js          MapLibre init, PMTiles protocol, Protomaps style
src/layers.js        All 11 SDOT/KC sources + paint properties
public/data/         GeoJSON snapshots (regenerated via fetch_data.py)
public/tiles/        Seattle-area PMTiles basemap (regenerated via make_basemap.sh)
scripts/             Data + basemap regeneration
```

## Verification

After `npm run dev`, expect:

1. Map opens centered on downtown Seattle at z≈11.5 on a clean Protomaps light basemap.
2. Bike facilities visible as colored lines (orange BL, blue PBL, light blue BBL, green NGW).
3. Bike+ Network planned segments rendered as dashed lines in the same palette.
4. King County regional trails appear as dashed purple east of city limits — Sammamish River, East Lake Sammamish, etc.
5. Light rail stations (teal dots) line up along the 1 Line from Northgate to Angle Lake.
6. Zoom past 13 → individual bike racks become visible as dark dots.
7. Zoom past 14 → bike route signs become faint blue dots.
8. URL hash tracks center/zoom (`#zoom/lat/lng`) for shareable views.
