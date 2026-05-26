// Register the service worker. Fire-and-forget; the install/update flows in
// install.js + update.js are what gate any user-visible state on the SW
// being ready.

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const swUrl = `${import.meta.env.BASE_URL}sw.js`;
  navigator.serviceWorker.register(swUrl, { scope: import.meta.env.BASE_URL })
    .catch((err) => console.warn('[pwa] SW register failed:', err));
}
