/* TradeLab service worker — full precache, fully offline.
   The PRECACHE line below is injected at build time by a small vite plugin. */
const CACHE = 'tradelab-v1';
const PRECACHE = JSON.parse('__PRECACHE_ASSETS__');

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .catch((err) => console.warn('precache failed', err))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      // App shell fallback for navigation requests (SPA).
      if (request.mode === 'navigate') {
        return caches.match('./index.html').then((doc) => doc || fetch(request));
      }
      return fetch(request);
    })
  );
});
