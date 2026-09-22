// ReptiCube POS — service worker.
//
// Deliberately minimal: the page is ALWAYS fetched network-first so a deploy
// reaches every till on the next reload (no stale-app problem); the cached
// copy is only served when the network is down, so the till still opens
// offline (its own catalogue cache + offline queue handle the rest). Icons
// and the manifest are cache-first (they never change without a rename).
// Non-GET requests (Shopify proxy calls, Firestore) are never touched.
const CACHE = 'reptipos-v1';
const PRECACHE = ['./', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // CDN scripts manage their own caching

  // The app page: network first, fall back to the cached copy when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('./', copy)); return res; })
        .catch(() => caches.match('./'))
    );
    return;
  }
  // Static assets under the till's scope: cache first, then network.
  if (url.pathname.includes('/icons/') || url.pathname.endsWith('manifest.webmanifest')) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res;
      }))
    );
  }
});
