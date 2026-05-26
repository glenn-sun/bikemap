// Per-layer popup formatters.
//
// Designed off the audit in scripts/fetch_data.py output: we surface only
// fields that vary across features and are meaningful to a human (e.g. drop
// light-rail STATUS — uniformly 'COMPLETE' — and bike-sign CATEGORY/
// CATEGORYDESCR — uniformly 'GBP'/'Guide-Bike / Ped'). Cryptic SDOT codes
// are decoded via small lookup tables; if a code is missing from the
// dictionary we fall back to the raw value so the user can still spot it.

import maplibregl from 'maplibre-gl';
import { isChoosingOnMap } from './routing/mode.js';
import { routeFromMyLocationTo } from './routing/ui.js';
import { snapSheet } from './sheet.js';

// POI-style layers that get a "Go" button in their popup. Linear bike
// infrastructure and routing-debug overlays are excluded — they aren't
// destinations a user would route to from their current location.
const POI_LAYERS = new Set([
  'libraries', 'community-centers', 'parks-restrooms',
  'light-rail-stations', 'bike-racks', 'bike-signs',
]);

function popupTitleFromHtml(html) {
  const m = html.match(/<div class="pop-title">([\s\S]*?)<\/div>/);
  if (!m) return 'Destination';
  // Strip any nested HTML in the title (e.g. &mdash; entities, <a>).
  const tmp = document.createElement('div');
  tmp.innerHTML = m[1];
  const txt = tmp.textContent || '';
  return txt.trim() || 'Destination';
}

// ---------- helpers ----------

function safe(s) {
  if (s === undefined || s === null || s === '') return null;
  const str = String(s).trim();
  if (!str) return null;
  return str.replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c]));
}

function titlecase(s) {
  if (!s) return s;
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
    // Re-uppercase street directionals.
    .replace(/\b(Nw|Ne|Sw|Se|N|S|E|W)\b/g, (m) => m.toUpperCase())
    // Re-uppercase common abbreviations.
    .replace(/\b(St|Ave|Blvd|Rd|Dr|Ln|Pl|Ct|Ter|Way|Pkwy|Trl)\b/g, (m) => m);
}

function row(label, value) {
  const v = safe(value);
  if (!v) return '';
  return `<div class="pop-row"><span class="pop-key">${label}</span>${v}</div>`;
}

function normPhone(p) {
  if (!p) return null;
  const digits = String(p).replace(/\D/g, '');
  if (digits.length === 7) return `(206) ${digits.slice(0, 3)}-${digits.slice(3)}`;
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return String(p);
}

// ---------- code decoders ----------

const BIKE_FACILITY_CATEGORY = {
  'BKF-NGW':   'Neighborhood greenway',
  'BKF-PBL':   'Protected bike lane',
  'BKF-OFFST': 'Off-street path',
  'BKF-BBL':   'Buffered bike lane',
  'BKF-BL':    'Bike lane',
  'BKF-CLMB':  'Climbing lane',
  'BKF-SHW':   'Sharrow / shared lane',
};

const BIKE_FACILITY_MODEL = {
  'BKF-ONEWAY': 'One-way',
  'BKF-TWOWAY': 'Two-way',
};

const BIKE_FACILITY_STATUS = {
  'INSVC':     'In service',
  'UNDERCONS': 'Under construction',
  'PLNRECON':  'In service · upgrade planned',
};

// Bike-rack BIKE_FACILITY layout codes.
const RACK_LAYOUT = {
  SGL:   'Single rack',
  CLSTR: 'Cluster',
  ONST:  'On-street corral',
};

const RACK_MODEL = {
  'BKR-INVRU':  'Inverted-U',
  'BKR-RLRCK':  'Wheel-bender',
  'BKR-ARCRE':  'Decorative arc',
  'BKR-WAVE':   'Wave rack',
  'BKR-LOOP':   'Loop',
};

const decode = (table, code) => (code && table[code]) || code || null;

// ---------- per-layer formatters ----------

const formatters = {
  libraries: (p) => `
    <div class="pop-title">${safe(p.LABEL || titlecase(p.NAME))} Library</div>
    ${row('Address', titlecase(p.ADDRESS))}
    ${p.WEBSITE ? `<div class="pop-row"><a href="${safe(p.WEBSITE)}" target="_blank" rel="noopener">spl.org &rarr;</a></div>` : ''}`,

  'community-centers': (p) => `
    <div class="pop-title">${safe(p.NAME)}</div>
    ${row('Address', p.ADDRESS)}
    ${row('Phone', normPhone(p.PHONE))}`,

  'parks-restrooms': (p) => {
    const name = safe(p.ALT_NAME) || safe(p.DESCRIPTION && titlecase(p.DESCRIPTION)) || 'Park restroom';
    return `
      <div class="pop-title">${name}</div>
      ${row('Park', p.PARK)}
      ${row('Hours', p.HOURS)}
      ${p.SEASON && p.SEASON !== 'YEAR ROUND' ? row('Season', p.SEASON.toLowerCase()) : ''}`;
  },

  // Status is uniformly 'COMPLETE' since we filtered to that; nothing else
  // is human-meaningful, so just confirm the station name on click.
  'light-rail-stations': (p) => `
    <div class="pop-title">${safe(p.NAME || p.STATION)}</div>`,

  'bike-racks': (p) => {
    const layout = decode(RACK_LAYOUT, p.BIKE_FACILITY);
    const model  = decode(RACK_MODEL,  p.MODEL_TYPE);
    return `
      <div class="pop-title">Bike rack</div>
      ${row('Capacity', p.RACK_CAPACITY ? `${p.RACK_CAPACITY} bikes` : null)}
      ${row('Layout', layout)}
      ${row('Style', model)}
      ${row('Condition', p.CONDITION && titlecase(p.CONDITION))}`;
  },

  'bike-signs': (p) => `
    <div class="pop-title">Bike sign &mdash; ${safe(p.SIGNTYPE) || 'unknown'}</div>
    ${row('Reads', p.TEXT)}
    ${row('Size', p.SIGNSZ && `${p.SIGNSZ}"`)}
    ${row('Mount', p.SUPPORTDESCR && p.SUPPORTDESCR.trim())}`,

  // All four bike-facility sub-layers + the new planned layer share schema.
  __bikeFacility: (p) => {
    const cat = decode(BIKE_FACILITY_CATEGORY, p.CATEGORY);
    const dir = decode(BIKE_FACILITY_MODEL, p.MODEL_TYPE);
    const status = decode(BIKE_FACILITY_STATUS, p.CURRENT_STATUS);
    return `
      <div class="pop-title">${safe(p.UNITDESC) ? titlecase(p.UNITDESC) : 'Bike facility'}</div>
      ${row('Type', cat)}
      ${row('Direction', dir)}
      ${row('Width', p.ASSET_WIDTH ? `${p.ASSET_WIDTH} ft` : null)}
      ${row('Status', status)}`;
  },

  // Bike+ planning network — name + planned vs existing.
  __bikePlus: (p) => `
    <div class="pop-title">${safe(p.stname_ord) ? titlecase(p.stname_ord) : 'Bike+ segment'}</div>
    ${row('Status', p.bike_network_category)}`,

  'kc-regional-trails': (p) => `
    <div class="pop-title">${safe(p.Trail_Name) || 'Regional trail'}</div>
    ${row('Owner', p.Owner)}`,

  // Multi-use trails (SDOT) — actually does carry a clean trail name.
  'multi-use-trails': (p) => {
    const name = safe(p.ORD_STNAME_CONCAT) ? titlecase(p.ORD_STNAME_CONCAT) : 'Multi-use trail';
    return `<div class="pop-title">${name}</div>`;
  },
};

// Spread shared formatters across every layer ID that reuses them.
const BIKE_FACILITY_LAYERS = [
  'bike-facilities-aaa', 'bike-facilities-bbl', 'bike-facilities-bl',
  'bike-facilities-narrow',
  'bike-facilities-construction-aaa', 'bike-facilities-construction-bbl',
  'bike-facilities-construction-bl', 'bike-facilities-construction-narrow',
  'bike-facilities-planned',
];
for (const id of BIKE_FACILITY_LAYERS) formatters[id] = formatters.__bikeFacility;
formatters['bike-plus-existing'] = formatters.__bikePlus;
formatters['bike-plus-planned']  = formatters.__bikePlus;

const CLICKABLE_LAYERS = Object.keys(formatters).filter((k) => !k.startsWith('__'));

// ---------- wire-up ----------

const ROUTE_LINE_LAYERS = ['route-line', 'route-alt-line'];

function clickedOnRouteLine(map, e) {
  // queryRenderedFeatures throws if a queried layer doesn't exist yet; only
  // ask about layers that currently exist on the map.
  const present = ROUTE_LINE_LAYERS.filter((id) => map.getLayer(id));
  if (!present.length) return false;
  return map.queryRenderedFeatures(e.point, { layers: present }).length > 0;
}

export function attachPopups(map) {
  // ONE global click handler — not per-layer. Per-layer `map.on('click',
  // layerId, …)` listeners fire independently, so a single click that
  // hits multiple stacked features (a bike rack on top of a bike-facility
  // polyline, etc.) opens one popup per layer. Instead we run a single
  // `queryRenderedFeatures` over all clickable layers and show the
  // top-most match only. Hover handlers below stay per-layer because
  // cursor behavior is naturally layer-scoped.
  map.on('click', (e) => {
    if (isChoosingOnMap()) return;
    // If the click also lands on a route line, the routing UI is
    // handling it (promoting an alternate) — don't summon an unrelated
    // bike-rack / restroom / etc. popup over the same pixel.
    if (clickedOnRouteLine(map, e)) return;
    const present = CLICKABLE_LAYERS.filter((id) => map.getLayer(id));
    if (!present.length) return;
    // queryRenderedFeatures returns features in render order, topmost
    // first — so [0] is the layer the user visually clicked on.
    const features = map.queryRenderedFeatures(e.point, { layers: present });
    if (!features.length) return;
    const f = features[0];
    const layerId = f.layer.id;
    const fmt = formatters[layerId];
    if (!fmt) return;
    const html = fmt(f.properties);
    if (!html || !html.trim()) return;
    const ll = pointFromFeature(f, e.lngLat);
    const popup = new maplibregl.Popup({
      closeButton: false,
      maxWidth: 'min(320px, calc(100vw - 24px))',
    })
      .setLngLat(ll)
      .setHTML(`<div class="pop"><div class="pop-toolbar"></div><div class="pop-body">${html}</div></div>`)
      .addTo(map);
    // On mobile, collapse the sheet so the popup isn't covered.
    snapSheet('peek');
    const toolbar = popup.getElement()?.querySelector('.pop-toolbar');
    if (toolbar) {
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'pop-close-btn';
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.title = 'Close';
      closeBtn.innerHTML = '<span class="material-symbols-outlined">close</span>';
      closeBtn.addEventListener('click', () => popup.remove());
      toolbar.appendChild(closeBtn);

      if (POI_LAYERS.has(layerId)) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pop-go-btn';
        btn.title = 'Route here from my location';
        btn.innerHTML = '<span class="material-symbols-outlined">directions</span>Go';
        btn.addEventListener('click', () => {
          const label = popupTitleFromHtml(html);
          popup.remove();
          routeFromMyLocationTo(ll[0], ll[1], label);
        });
        toolbar.appendChild(btn);
      }
    }
  });

  for (const layerId of CLICKABLE_LAYERS) {
    map.on('mouseenter', layerId, () => {
      if (isChoosingOnMap()) return;
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layerId, () => {
      if (isChoosingOnMap()) return;
      map.getCanvas().style.cursor = '';
    });
  }
}

function pointFromFeature(feature, fallback) {
  const g = feature.geometry;
  if (g && g.type === 'Point') return g.coordinates;
  return fallback;
}
