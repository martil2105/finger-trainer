/* sw.js — offline app-shell cache. Bump CACHE on any asset change. */
const CACHE = 'ft-v55';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './fonts/jura-light.woff2',
  './fonts/jura-medium.woff2',
  './fonts/geistmono-regular.woff2',
  './fonts/geistmono-bold.woff2',
  './motion.css',
  './motion.js',
  './cone.js',
  './cone_data.js',
  './kalman.js',
  './kalman_data.js',
  './rpe_cal.js',
  './calc.js',
  './templates.js',
  './db.js',
  './sync.js',
  './timer.js',
  './builder.js',
  './app.js',
  './manifest.json',
  './history_import.csv',
  './apple-touch-icon.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for app shell; network fallback fills cache for same-origin GETs.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.status === 200 && new URL(req.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
