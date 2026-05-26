// Wires the Settings → Manage data section:
//  - Re-runs a network update check every time the Settings dialog opens.
//  - Reflects status on the "Update available" button (or grays it).
//  - Clicking the button runs the scoped download, then becomes a Reload CTA.
//  - "Delete data" prompts confirmation, clears caches + install flag, reloads.

import { getUpdateStatus, applyUpdate, deleteAllData } from './update.js';
import { formatBytes } from './version.js';

const CONFIRM_MSG =
  'Delete all downloaded map data?\n\n' +
  'You will be returned to the first-time download screen. Your saved ' +
  'home/work locations and route preferences will be preserved.';

export function initManageData() {
  const openBtn = document.getElementById('open-settings');
  const updateBtn = document.getElementById('settings-update-btn');
  const deleteBtn = document.getElementById('settings-delete-btn');
  if (!openBtn || !updateBtn || !deleteBtn) return;

  openBtn.addEventListener('click', () => {
    // Fire-and-forget; the button shows "Checking…" until the promise lands.
    refreshUpdateButton();
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
