// Retail POS — the service worker: the app's own files are kept so the till
// opens with no connection. Data (Firestore, the functions, the Firebase
// SDK) is never cached here: Firestore keeps its own offline store, and the
// functions must be live. A new version of the app replaces the old one on
// the next open.
const VERSION = 'pos-v1';
const FILES = ['./', './index.html', './css/pos.css', './manifest.webmanifest',
  './js/app.js', './js/auth.js', './js/db.js', './js/ui.js', './js/config.js', './js/admin.js', './js/products.js', './js/sell.js', './js/pay.js',
  './js/receipt.js', './js/receiptui.js', './js/sales.js', './js/register.js', './js/outbox.js', './js/money.js', './js/csv.js', './js/barcode.js', './js/icons.js'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.includes('/pos/')) return;   // only the app's own files
  if (url.search.includes('emulator=1')) return;                                                                  // tests run live
  // network first (a new version wins), the cache when the line is down
  e.respondWith(fetch(e.request).then(r => { if (r.ok) caches.open(VERSION).then(c => c.put(e.request, r.clone())); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
});
