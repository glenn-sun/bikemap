// Platform sniffing for the install UX.
//
// Chrome/Edge fire `beforeinstallprompt`; we stash the event so our own UI
// can call `.prompt()` later (the browser suppresses its native banner once
// preventDefault is called). iOS Safari does NOT fire it — those users have
// to Add to Home Screen manually via the Share menu, so we detect iOS and
// surface a hint instead.
//
// The event can fire before OR after this module loads (depending on how
// quickly the page meets install criteria), so we expose a subscribe API
// for UI components that need to react when a deferred prompt arrives.

let deferredInstallPrompt = null;
const subscribers = new Set();

function notify() {
  for (const fn of subscribers) {
    try { fn(); } catch (err) { console.warn('[pwa] install-prompt subscriber threw:', err); }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    notify();
  });
  // Once the user installs (via our prompt, the URL-bar icon, or anywhere
  // else) the deferred event is no longer usable — drop it and notify
  // subscribers so install affordances can hide themselves.
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    notify();
  });
}

export function isIOS() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ reports Mac UA; disambiguate via touchpoints.
  const iPadOS = ua.includes('Macintosh') && navigator.maxTouchPoints > 1;
  return /iPad|iPhone|iPod/.test(ua) || iPadOS;
}

export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches
    || window.navigator.standalone === true; // iOS
}

export function hasDeferredInstallPrompt() {
  return deferredInstallPrompt !== null;
}

export async function triggerInstallPrompt() {
  if (!deferredInstallPrompt) return null;
  const evt = deferredInstallPrompt;
  // Null out before awaiting so re-entrant clicks can't double-prompt.
  deferredInstallPrompt = null;
  evt.prompt();
  const result = await evt.userChoice;
  notify();
  return result?.outcome ?? null;
}

// Subscribe to changes in deferred-prompt availability (event fired late,
// or cleared after a successful install). Returns an unsubscribe fn.
export function onInstallPromptChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
