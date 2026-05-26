// First-run install flow. `ensureInstalled()` blocks the rest of main.js
// from starting up the map until the user has clicked Download and the
// streaming fetch has populated the data cache.
//
// Owner explicitly opted for blocking (no online-only escape hatch). To
// relax later: add a "Use online" button that sets a sessionStorage flag
// that ensureInstalled() honors.

import {
  INSTALL_FLAG,
  DATA_CACHE,
  fetchRemoteManifest,
  waitForController,
  formatBytes,
  inferContentType,
  versionUrl,
} from './version.js';
import { isIOS, isStandalone } from './platform.js';

export async function ensureInstalled() {
  const existing = localStorage.getItem(INSTALL_FLAG);
  if (existing) return;

  await waitForController();
  let manifest;
  try {
    manifest = await fetchRemoteManifest();
  } catch (err) {
    showFatalError(`Could not load version manifest: ${err.message}. Reload to retry.`);
    throw err;
  }

  await runInstallModal(manifest);

  if ('storage' in navigator && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch {}
  }
  localStorage.setItem(INSTALL_FLAG, manifest.version);
}

function runInstallModal(manifest) {
  return new Promise((resolve, reject) => {
    const modal = document.getElementById('install-modal');
    const size = document.getElementById('install-size');
    const cta = document.getElementById('install-go');
    const progressWrap = document.getElementById('install-progress-wrap');
    const progressFill = document.getElementById('install-progress-fill');
    const progressText = document.getElementById('install-progress-text');
    const errEl = document.getElementById('install-error');
    const iosHint = document.getElementById('ios-hint');

    if (!modal || !cta || !size) {
      reject(new Error('install modal markup missing'));
      return;
    }

    size.textContent = formatBytes(manifest.totalGzippedBytes ?? manifest.totalBytes);

    if (isIOS() && !isStandalone()) {
      iosHint?.removeAttribute('hidden');
    }

    modal.removeAttribute('hidden');

    cta.addEventListener('click', async () => {
      cta.disabled = true;
      cta.textContent = 'Downloading…';
      progressWrap?.removeAttribute('hidden');
      errEl?.setAttribute('hidden', '');
      try {
        await downloadAll(manifest, (frac, downloaded, total) => {
          if (progressFill) progressFill.style.width = `${(frac * 100).toFixed(1)}%`;
          if (progressText) {
            progressText.textContent =
              `${(frac * 100).toFixed(0)}% — ${formatBytes(downloaded)} / ${formatBytes(total)}`;
          }
        });
        await cacheManifest(manifest);
        modal.setAttribute('hidden', '');
        resolve();
      } catch (err) {
        cta.disabled = false;
        cta.textContent = 'Retry';
        if (errEl) {
          errEl.textContent = `Download failed: ${err.message}`;
          errEl.removeAttribute('hidden');
        }
        // Don't reject — let the user retry by clicking the CTA again.
      }
    }, { once: false });
  });
}

// Sequentially download every file in `manifest.files`, write it into the
// data cache, and report aggregate progress (weighted by file size — the
// 62 MB routing graph dominates a single percent of the bar).
//
// Sequential not parallel: keeps peak memory bounded to one file's worth
// of buffered chunks (~62 MB worst case), and avoids overwhelming GH Pages.
export async function downloadAll(manifest, onProgress) {
  const cache = await caches.open(DATA_CACHE);
  // Use gzipped sizes for the progress weighting so the bar matches reality.
  const totalBytes = manifest.files.reduce((s, f) => s + (f.gzippedSize ?? f.size), 0);
  let downloaded = 0;

  for (const file of manifest.files) {
    const fileWeight = file.gzippedSize ?? file.size;
    const fileBefore = downloaded;
    const bytes = await fetchToUint8Array(file.url, (chunkBytes, receivedTotal) => {
      // chunkBytes is uncompressed-on-wire if the server gzips, so we
      // can't trust it as a wire-bytes signal. Use percentage of file
      // size for sub-file progress, capped to the file's weight.
      const fileFrac = receivedTotal / file.size;
      downloaded = fileBefore + Math.min(fileWeight, fileWeight * fileFrac);
      onProgress(Math.min(downloaded / totalBytes, 1), downloaded, totalBytes);
    });
    const resp = new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': inferContentType(file.url),
        'Content-Length': String(bytes.byteLength),
      },
    });
    await cache.put(new Request(file.url, { method: 'GET' }), resp);
    downloaded = fileBefore + fileWeight;
    onProgress(Math.min(downloaded / totalBytes, 1), downloaded, totalBytes);
  }
}

async function cacheManifest(manifest) {
  const cache = await caches.open(DATA_CACHE);
  await cache.put(
    versionUrl(),
    new Response(JSON.stringify(manifest), {
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

async function fetchToUint8Array(url, onChunk) {
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  if (!resp.body) {
    // No streaming support — fall back to buffered read.
    const buf = new Uint8Array(await resp.arrayBuffer());
    onChunk(buf.byteLength, buf.byteLength);
    return buf;
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onChunk(value.byteLength, received);
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

function showFatalError(msg) {
  const errEl = document.getElementById('install-error');
  const modal = document.getElementById('install-modal');
  modal?.removeAttribute('hidden');
  if (errEl) {
    errEl.textContent = msg;
    errEl.removeAttribute('hidden');
  } else {
    alert(msg);
  }
}
