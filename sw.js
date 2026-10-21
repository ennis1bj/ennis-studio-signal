// App shell: cache-first. Feed data and keys: network-first with cache fallback (all data is encrypted at rest).
const VERSION = 'sig-v4';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'assets/fonts/zodiak-400.woff2', 'assets/fonts/zodiak-700.woff2', 'assets/fonts/switzer-400.woff2', 'assets/fonts/switzer-500.woff2', 'assets/fonts/switzer-600.woff2',
  'assets/icons/es-mark-64.png', 'assets/icons/es-mark-192.png', 'assets/icons/es-mark-512.png', 'assets/icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const isData = /\/(data|keys)\//.test(url.pathname);
  if (isData || e.request.mode === 'navigate' || /\/(app\.js|styles\.css)$/.test(url.pathname)) {
    e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, cp)); } return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
  } else {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
  }
});
