// Shared helpers for the install + update flows.

export const INSTALL_FLAG = 'bikemap-installed-version';
export const DATA_CACHE = 'bikemap-data-v1';
export const VERSION_URL_REL = 'data/version.json';

export function versionUrl() {
  return `${import.meta.env.BASE_URL}${VERSION_URL_REL}`;
}

// Fetch the live manifest from network — used at install time (no cache yet)
// and by the update flow (SW route applies network-first with timeout).
export async function fetchRemoteManifest() {
  const resp = await fetch(versionUrl(), { cache: 'no-store' });
  if (!resp.ok) throw new Error(`version.json fetch failed: ${resp.status}`);
  return resp.json();
}

// Read the manifest we cached at install/update time, so we can diff it
// against `fetchRemoteManifest()`.
export async function getCachedManifest() {
  if (!('caches' in self)) return null;
  const cache = await caches.open(DATA_CACHE);
  const cached = await cache.match(versionUrl());
  if (!cached) return null;
  try { return await cached.json(); } catch { return null; }
}

// Returns the subset of `remote.files` whose hash differs from (or is
// absent from) `installed.files`. If `installed` is null, returns all.
export function diffManifests(installed, remote) {
  if (!installed) return remote.files.slice();
  const byUrl = new Map(installed.files.map((f) => [f.url, f]));
  return remote.files.filter((rf) => {
    const im = byUrl.get(rf.url);
    return !im || im.hash !== rf.hash;
  });
}

// Wait for navigator.serviceWorker to be controlling. Used by the install
// flow so subsequent cache.put() writes are visible to the SW's fetch
// handler. Resolves immediately if already controlling.
export async function waitForController(timeoutMs = 10000) {
  if (!('serviceWorker' in navigator)) return false;
  if (navigator.serviceWorker.controller) return true;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      clearTimeout(t);
      resolve(true);
    }, { once: true });
  });
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function inferContentType(url) {
  if (url.endsWith('.pmtiles')) return 'application/octet-stream';
  if (url.endsWith('.json') || url.endsWith('.geojson')) return 'application/json';
  return 'application/octet-stream';
}
