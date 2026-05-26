// Wires the Settings → Manage data section:
//  - Re-runs a network update check every time the Settings dialog opens.
//  - Reflects status on the "Update available" button (or grays it).
//  - Clicking the button runs the scoped download, then becomes a Reload CTA.
//  - "Delete data" prompts confirmation, clears caches + install flag, reloads.

import { getUpdateStatus, applyUpdate, deleteAllData } from './update.js';
import { formatBytes, getCachedManifest } from './version.js';

// GitHub commit URL pattern — used to link the displayed appVersion SHA
// to the exact code that's installed. Same repo as the About → "View
// source" link.
const COMMIT_URL_PREFIX = 'https://github.com/glenn-sun/bikemap/commit/';
import {
  isIOS,
  isStandalone,
  hasDeferredInstallPrompt,
  triggerInstallPrompt,
  onInstallPromptChange,
} from './platform.js';

const CONFIRM_MSG =
  'Delete all downloaded map data?\n\n' +
  'You will be returned to the first-time download screen. Your saved ' +
  'home/work locations and route preferences will be preserved.';

export function initManageData() {
  const openBtn = document.getElementById('open-settings');
  const updateBtn = document.getElementById('settings-update-btn');
  const deleteBtn = document.getElementById('settings-delete-btn');
  if (!openBtn || !updateBtn || !deleteBtn) return;

  wireInstallButton();

  openBtn.addEventListener('click', () => {
    // Fire-and-forget; the button shows "Checking…" until the promise lands.
    refreshUpdateButton();
    // Re-evaluate install affordance every time the dialog opens — install
    // state can change (user installed via URL-bar icon, or the deferred
    // prompt arrived after first render).
    syncInstallButton();
    // Refresh the installed-version line. Re-read every open in case an
    // update was just applied in this session.
    refreshInstalledVersion();
  });

  deleteBtn.addEventListener('click', async () => {
    if (!window.confirm(CONFIRM_MSG)) return;
    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Deleting…';
    try {
      await deleteAllData();
    } catch (err) {
      console.error('[pwa] delete failed:', err);
      deleteBtn.disabled = false;
      deleteBtn.textContent = 'Delete data';
      alert(`Delete failed: ${err.message}`);
    }
  });
}

async function refreshUpdateButton() {
  setBtn({ text: 'Checking for updates…', disabled: true, onClick: null });
  const status = await getUpdateStatus();
  if (!status) {
    setBtn({ text: 'Could not reach server', disabled: true, onClick: null });
    return;
  }
  if (status.state === 'not-installed') {
    setBtn({ text: 'Not installed', disabled: true, onClick: null });
    return;
  }
  if (status.state === 'current') {
    setBtn({ text: 'No updates available', disabled: true, onClick: null });
    return;
  }
  // status.state === 'update'. Show size only when data actually changed;
  // a shell-only update is small + invisible to the user, so no size badge.
  const label = status.deltaBytes > 0
    ? `Update available (${formatBytes(status.deltaBytes)})`
    : 'Update available';
  setBtn({
    text: label,
    disabled: false,
    onClick: async () => {
      setBtn({ text: 'Updating 0%', disabled: true, onClick: null });
      try {
        await applyUpdate(status, (frac) => {
          const btn = document.getElementById('settings-update-btn');
          if (btn) btn.textContent = `Updating ${Math.floor(frac * 100)}%`;
        });
        setBtn({
          text: 'Updated — reload to apply',
          disabled: false,
          onClick: () => window.location.reload(),
        });
      } catch (err) {
        console.error('[pwa] update failed:', err);
        setBtn({
          text: 'Update failed — retry',
          disabled: false,
          onClick: () => refreshUpdateButton(),
        });
      }
    },
  });
}

// Show / hide / wire the Install app button. Chrome/Edge get a real
// `.prompt()` call (only possible while the user-gesture chain is alive,
// so we call it directly in the click handler). iOS users get a short
// instruction line explaining the Share → Add to Home Screen flow,
// since Safari doesn't expose a programmatic install API.
const IOS_INSTALL_HINT =
  'In Safari, tap the Share button, then "Add to Home Screen".';

function wireInstallButton() {
  const btn = document.getElementById('settings-install-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (hasDeferredInstallPrompt()) {
      btn.disabled = true;
      const prior = btn.textContent;
      btn.textContent = 'Opening…';
      try { await triggerInstallPrompt(); } catch {}
      btn.disabled = false;
      btn.textContent = prior;
      syncInstallButton();
    } else if (isIOS() && !isStandalone()) {
      alert(IOS_INSTALL_HINT);
    }
  });
  // Re-sync if the deferred prompt arrives or clears (user installs
  // outside our flow, e.g. via the URL-bar icon).
  onInstallPromptChange(syncInstallButton);
  syncInstallButton();
}

function syncInstallButton() {
  const btn = document.getElementById('settings-install-btn');
  const hint = document.getElementById('settings-install-hint');
  if (!btn) return;
  if (isStandalone()) {
    btn.setAttribute('hidden', '');
    hint?.setAttribute('hidden', '');
    return;
  }
  if (hasDeferredInstallPrompt()) {
    btn.removeAttribute('hidden');
    btn.textContent = 'Install app';
    hint?.setAttribute('hidden', '');
    return;
  }
  if (isIOS()) {
    btn.removeAttribute('hidden');
    btn.textContent = 'How to install on iPhone';
    if (hint) {
      hint.textContent = IOS_INSTALL_HINT;
      hint.removeAttribute('hidden');
    }
    return;
  }
  btn.setAttribute('hidden', '');
  hint?.setAttribute('hidden', '');
}

// Render the "Installed <date> · <sha>" line under the Manage data
// buttons. Reads the cached install manifest (written at install-time
// by install.js and on each update by update.js) — both fields are
// optional, so the line gracefully degrades if either is missing
// (e.g. installs from before appVersion was added).
async function refreshInstalledVersion() {
  const el = document.getElementById('settings-version-info');
  if (!el) return;
  el.replaceChildren();
  const manifest = await getCachedManifest();
  if (!manifest) {
    el.setAttribute('hidden', '');
    return;
  }
  const parts = [];
  if (manifest.version) {
    const span = document.createElement('span');
    span.textContent = `Installed ${formatVersionDate(manifest.version)}`;
    parts.push(span);
  }
  if (manifest.appVersion && /^[0-9a-f]{7,40}$/i.test(manifest.appVersion)) {
    const a = document.createElement('a');
    a.href = COMMIT_URL_PREFIX + manifest.appVersion;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = 'manage-data-version-sha';
    a.textContent = manifest.appVersion.slice(0, 7);
    parts.push(a);
  }
  if (!parts.length) {
    el.setAttribute('hidden', '');
    return;
  }
  const betaChip = document.createElement('span');
  betaChip.className = 'manage-data-version-beta';
  betaChip.textContent = 'BETA';
  el.appendChild(betaChip);
  parts.forEach((node) => {
    el.appendChild(document.createTextNode(' · '));
    el.appendChild(node);
  });
  el.removeAttribute('hidden');
}

// build_data_manifest.py emits version as `YYYYMMDD-HHMMSS` in local
// build-machine time (CI runs in UTC, so for our deploys it IS UTC).
// Parse loosely; fall through to the raw string if it doesn't match
// (e.g. a future schema change or a manually-edited manifest).
function formatVersionDate(v) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(v);
  if (!m) return v;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d));
  if (isNaN(date.getTime())) return v;
  return date.toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

// Atomically swap the button's click handler. Uses a `_pwaHandler` slot
// on the element so prior listeners get removed before the new one binds.
function setBtn({ text, disabled, onClick }) {
  const btn = document.getElementById('settings-update-btn');
  if (!btn) return;
  btn.textContent = text;
  btn.disabled = disabled;
  if (btn._pwaHandler) {
    btn.removeEventListener('click', btn._pwaHandler);
    btn._pwaHandler = null;
  }
  if (onClick) {
    btn._pwaHandler = onClick;
    btn.addEventListener('click', onClick);
  }
}
