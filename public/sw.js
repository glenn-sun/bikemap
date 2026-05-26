// Bikemap service worker.
//
// Caches: three buckets, with intentionally different lifecycles.
//   bikemap-shell-v${APP_VERSION}  HTML/JS/CSS/fonts. Versioned with the
//                                  app bundle; activate evicts old versions.
//   bikemap-data-v1                Data + tiles. Version-independent;
//                                  populated by src/pwa/install.js, swapped
//                                  by src/pwa/update.js. Never cleared by
//                                  the SW lifecycle.
//   bikemap-external-v1            Protomaps sprites/glyphs. SWR.
//
// The placeholders __APP_VERSION__ and __PRECACHE_MANIFEST__ are rewritten
// at build time by vite-plugins/precache-manifest.js — see that file for
// the exact substitution mechanics.
//
// The owner-driven install flow runs in the MAIN thread (not in this SW's
// install event) so it can stream progress reports per file. This SW only
// serves what the main thread has already cached. The shell precache
// (HTML/JS/CSS) IS handled here — that piece is small and atomic.

const APP_VERSION = '__APP_VERSION__';
// The vite plugin (vite-plugins/precache-manifest.js) replaces the line
// below at build time. The default `[]` keeps `npm run dev` parse-clean —
// in dev the SW registers but the precache install is a no-op, which is
// fine because Cache API in src/pwa/install.js works without the SW.
let PRECACHE_MANIFEST = [];

const SHELL_CACHE = `bikemap-shell-v${APP_VERSION}`;
const DATA_CACHE  = 'bikemap-data-v1';
const EXT_CACHE   = 'bikemap-external-v1';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Use addAll with explicit Request objects so we control caching mode
    // and avoid the implicit credentials-include behavior.
    await Promise.all(PRECACHE_MANIFEST.map(async (url) => {
      try {
        const resp = await fetch(url, { cache: 'reload', credentials: 'same-origin' });
        if (resp.ok) await cache.put(url, resp);
      } catch (e) {
        console.warn('[sw] precache miss for', url, e);
      }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('bikemap-shell-v') && k !== SHELL_CACHE)
        .map((k) => caches.delete(k)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // (1) PMTiles range slicing — must be first. pmtiles.js sends
  // Range: bytes=X-Y; we cache the full body once and slice it here.
  if (url.pathname.endsWith('.pmtiles')) {
    event.respondWith(handlePmtilesRange(req));
    return;
  }

  // (2) Live version manifest — always network-first (short timeout)
  // so the update banner can react quickly to a fresh deploy.
  if (url.pathname.endsWith('/data/version.json')) {
    event.respondWith(networkFirst(req, DATA_CACHE, 3000));
    return;
  }

  // (3) Other /data/ → cache-first. Cache populated by install/update flow.
  if (url.pathname.includes('/data/')) {
    event.respondWith(cacheFirst(req, DATA_CACHE));
    return;
  }

  // (4) Protomaps assets (glyphs, sprites) → SWR.
  if (url.origin === 'https://protomaps.github.io') {
    event.respondWith(staleWhileRevalidate(req, EXT_CACHE));
    return;
  }

  // (5) Same-origin (app shell) → cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }

  // (6) Else → network passthrough.
});

async function handlePmtilesRange(req) {
  const cache = await caches.open(DATA_CACHE);
  // Cache key is the URL only — we never cache per-range entries.
  const key = new Request(req.url, { method: 'GET' });
  const cached = await cache.match(key);
  if (!cached) {
    // Pre-install: nothing cached yet. Pass through to network so the
    // pmtiles client at least functions in the (rare) uninstalled fallback.
    return fetch(req);
  }
  const rangeHeader = req.headers.get('range');
  if (!rangeHeader) return cached.clone();
  const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
  if (!m) return cached.clone();

  const buf = await cached.clone().arrayBuffer();
  const start = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : buf.byteLength - 1;
  if (start >= buf.byteLength || end >= buf.byteLength) {
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${buf.byteLength}` },
    });
  }
  const slice = buf.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`,
      'Content-Length': String(slice.byteLength),
      'Accept-Ranges': 'bytes',
    },
  });
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreSearch: false });
  if (cached) return cached;
  try {
    const resp = await fetch(req);
    if (resp.ok && resp.type !== 'opaque') {
      cache.put(req, resp.clone()).catch(() => {});
    }
    return resp;
  } catch (e) {
    // Fall through; the caller sees a network error.
    throw e;
  }
}

async function networkFirst(req, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  try {
    const resp = await Promise.race([
      fetch(req),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    if (resp.ok) cache.put(req, resp.clone()).catch(() => {});
    return resp;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw e;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const networkPromise = fetch(req).then((resp) => {
    if (resp.ok && resp.type !== 'opaque') {
      cache.put(req, resp.clone()).catch(() => {});
    }
    return resp;
  }).catch(() => null);
  return cached || (await networkPromise) || new Response('', { status: 504 });
}
