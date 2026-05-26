// Update status + apply API consumed by the Settings → Manage data section.
//
// The user-driven UX lives in src/pwa/manage.js (settings buttons). This
// module only does the work: fetch the live manifest, diff per-file, and
// stream the changed files into the data cache.

import {
  INSTALL_FLAG,
  DATA_CACHE,
  fetchRemoteManifest,
  getCachedManifest,
  diffManifests,
  versionUrl,
} from './version.js';
import { downloadAll } from './install.js';

/**
 * Check whether the server has newer data OR a newer app shell than
 * the local cache. Returns an object describing the current state, or
 * null if the live manifest couldn't be fetched (offline / transient).
 *
 *   { state: 'current',       deltaBytes: 0, changed: [], appChanged: false, remote }
 *   { state: 'update',        deltaBytes: N, changed: [...], appChanged: bool, remote }
 *   { state: 'not-installed' }
 *
 * `deltaBytes` is the size of the data delta (sum of gzipped sizes of
 * changed data files). `appChanged` is true when the deployed shell's
 * appVersion differs from the cached manifest's appVersion — caller can
 * use this to label "Update available" vs. "Update available (XX MB)".
 */
export async function getUpdateStatus() {
  if (!localStorage.getItem(INSTALL_FLAG)) return { state: 'not-installed' };
  let remote;
  try {
    remote = await fetchRemoteManifest();
  } catch {
    return null;
  }
  const installed = await getCachedManifest();

  const changed = diffManifests(installed, remote);
  const appChanged =
    !!installed && remote.appVersion !== undefined && installed.appVersion !== remote.appVersion;

  if (!changed.length && !appChanged) {
    return { state: 'current', deltaBytes: 0, changed: [], appChanged: false, remote };
  }
  const deltaBytes = changed.reduce((s, f) => s + (f.gzippedSize ?? f.size), 0);
  return { state: 'update', deltaBytes, changed, appChanged, remote };
}

/**
 * Download every file in `status.changed`, replace the cached
 * version.json with `status.remote`, and pull the latest service worker
 * so the next reload picks up new HTML/JS/CSS as well as new data.
 * `onProgress(frac)` is called as download progresses (0..1). Updates
 * the install flag on success.
 *
 * SW activation note: when the deployed sw.js has a new APP_VERSION,
 * registration.update() installs the new SW into the "waiting" state
 * (the old SW is still controlling). We post SKIP_WAITING and wait for
 * controllerchange before resolving — that way the caller's
 * window.location.reload() loads the new shell from the new SHELL_CACHE.
 */
export async function applyUpdate(status, onProgress = () => {}) {
  if (status.state !== 'update') return;

  await downloadAll(
    {
      files: status.changed,
      totalBytes: status.deltaBytes,
      totalGzippedBytes: status.deltaBytes,
    },
    (frac) => onProgress(frac),
  );

  const cache = await caches.open(DATA_CACHE);
  await cache.put(
    versionUrl(),
    new Response(JSON.stringify(status.remote), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  localStorage.setItem(INSTALL_FLAG, status.remote.version);

  await activateLatestServiceWorker();
}

async function activateLatestServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let reg;
  try {
    reg = await navigator.serviceWorker.getRegistration();
  } catch { return; }
  if (!reg) return;

  // Force a fetch + parse of sw.js. If the bytes differ from the
  // currently-installed SW, a new SW enters the install lifecycle.
  try { await reg.update(); } catch { return; }

  // If a new SW was installed, it may already be waiting OR still
  // installing — wait for installing to settle into waiting, then ask
  // it to skipWaiting so it takes over before the caller reloads.
  const installing = reg.installing;
  if (installing) {
    await new Promise((resolve) => {
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' || installing.state === 'redundant') resolve();
      });
    });
  }
  if (reg.waiting) {
    const controllerChanged = new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
    });
    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    // Don't wait forever — if the new SW silently fails to activate, the
    // reload will still happen and the user sees old shell + new data.
    await Promise.race([
      controllerChanged,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
}

/**
 * Tear down every PWA-managed cache + the install flag, then reload so
 * the install modal re-runs. Triggered by the Settings → Delete data
 * button after the user confirms.
 *
 * Does NOT touch other localStorage keys (saved home/work, route prefs,
 * cycling speed, etc.) — those are user preferences, not downloaded data.
 */
export async function deleteAllData() {
  if ('caches' in self) {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('bikemap-'))
        .map((k) => caches.delete(k)),
    );
  }
  localStorage.removeItem(INSTALL_FLAG);
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  }
  // Reload onto the install modal.
  window.location.reload();
}

/**
 * Boot-time hook kept for compatibility with src/main.js's boot
 * sequence. With per-file hash diffing + appVersion in version.json,
 * there is no "version-only" silent-catchup case to handle anymore —
 * the Settings → Manage data button is now the sole UI surface for
 * update prompting.
 */
export async function checkForUpdate() {
  /* no-op */
}
