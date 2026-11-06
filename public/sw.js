const CACHE = 'resale-tracker-shell-v4';
const BASE = new URL('.', self.registration.scope).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const indexResponse = await fetch(BASE, { cache: 'reload' });
    if (!indexResponse.ok) throw new Error('Could not fetch the updated app shell.');
    const html = await indexResponse.clone().text();
    await cache.put(BASE, indexResponse);
    const assets = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)]
      .map((match) => new URL(match[1], self.registration.scope).href)
      .filter((url) => new URL(url).origin === location.origin);
    await cache.addAll([...new Set([...assets, `${BASE}manifest.webmanifest`, `${BASE}icons/resale-tracker-192.png`])]);
    // Initial install takes control. Updates wait until the page confirms that
    // local changes are persisted or the user explicitly accepts the update.
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'ACTIVATE_RESALE_TRACKER_UPDATE') event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('resale-tracker-shell-') && key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith(`${BASE}api/`)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
      return response;
    } catch {
      return await cache.match(request) || await cache.match(BASE) || Response.error();
    }
  })());
});
