// Platform sniffing for the install UX.
//
// Chrome/Edge fire `beforeinstallprompt`; we stash the event so the install
// modal can offer a real "Install" button after the data download finishes.
// iOS Safari does NOT fire it — those users have to Add to Home Screen
// manually via the Share menu. We detect iOS to surface that hint.

let deferredInstallPrompt = null;

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
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
  deferredInstallPrompt.prompt();
  const result = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  return result?.outcome ?? null;
}
