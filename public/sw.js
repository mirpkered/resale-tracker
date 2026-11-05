const CACHE = 'resale-tracker-shell-v3';
const BASE = new URL('.', self.registration.scope).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil(Promise.all([
    caches.open(CACHE).then((cache) => cache.addAll([
      BASE,
      `${BASE}manifest.webmanifest`,
      `${BASE}icons/resale-tracker-192.png`,
    ])),
    self.skipWaiting(),
  ]));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
    )),
    self.clients.claim(),
  ]));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'GET' && url.origin === location.origin && !url.pathname.startsWith(`${BASE}api/`)) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then((hit) => hit || caches.match(BASE))));
  }
});
