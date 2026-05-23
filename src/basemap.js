// Helpers for tweaking the Protomaps basemap before it goes to MapLibre.
//
// - desaturateBasemapLayers: walks the paint expressions of every basemap
//   layer and reduces HSL saturation by a fixed factor. Only color values
//   (hex or rgb/rgba strings) are touched; expression structure is preserved.

const HEX_RE = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const RGB_RE = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/;

function parseColor(s) {
  if (typeof s !== 'string') return null;
  if (s.startsWith('#') || HEX_RE.test(s)) {
    let h = s.replace(/^#/, '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }
  const m = s.match(RGB_RE);
  if (m) {
    return {
      r: +m[1], g: +m[2], b: +m[3],
      a: m[4] !== undefined ? +m[4] : 1,
    };
  }
  return null;
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  switch (max) {
    case r: h = (g - b) / d + (g < b ? 6 : 0); break;
    case g: h = (b - r) / d + 2; break;
    default: h = (r - g) / d + 4;
  }
  return [h / 6, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue2rgb(h + 1 / 3) * 255),
    Math.round(hue2rgb(h) * 255),
    Math.round(hue2rgb(h - 1 / 3) * 255),
  ];
}

function desaturateString(color, factor) {
  const c = parseColor(color);
  if (!c) return color;
  const [h, s, l] = rgbToHsl(c.r, c.g, c.b);
  const [r, g, b] = hslToRgb(h, s * factor, l);
  return c.a === 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${c.a})`;
}

function deepDesaturate(value, factor) {
  if (typeof value === 'string') return desaturateString(value, factor);
  if (Array.isArray(value)) return value.map((v) => deepDesaturate(v, factor));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepDesaturate(v, factor);
    return out;
  }
  return value;
}

// Mutates the layer list. Only paint keys ending in -color are walked, so
// expressions like `line-width` and dasharrays remain untouched.
export function desaturateBasemapLayers(layers, factor = 0.55) {
  for (const l of layers) {
    if (!l.paint) continue;
    for (const k of Object.keys(l.paint)) {
      if (k.endsWith('-color')) {
        l.paint[k] = deepDesaturate(l.paint[k], factor);
      }
    }
  }
  return layers;
}
