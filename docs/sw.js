// Service worker: lets Ryana install as a home-screen app and open its pages offline.
// Network first, so the app always runs the latest code when online; the cache is only a
// fallback. Supabase requests (other origins) are never touched.
const CACHE = 'ryana-v2';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  event.respondWith((async () => {
    try {
      // no-cache: always ask GitHub Pages whether the file changed, instead of trusting the
      // browser's 10-minute cache (which served new pages with an old stylesheet).
      const response = await fetch(request, { cache: 'no-cache' });
      if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
      return response;
    } catch (err) {
      const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
      if (cached) return cached;
      throw err;
    }
  })());
});
