// RoadSoS Service Worker — offline-first tile + asset caching
const STATIC_CACHE = 'roadsos-static-v1';
const TILE_CACHE   = 'roadsos-tiles-v1';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/script.js',
];

// On install: pre-cache static assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(STATIC_CACHE)
      .then(c => c.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// On activate: clean up old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => k !== STATIC_CACHE && k !== TILE_CACHE)
        .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // ── Map tiles: cache-first (tiles don't change) ──
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    e.respondWith(
      caches.open(TILE_CACHE).then(cache =>
        cache.match(e.request).then(cached => {
          if (cached) return cached;
          return fetch(e.request, { mode: 'cors' }).then(res => {
            // Only cache successful tile responses
            if (res && res.status === 200) {
              cache.put(e.request, res.clone());
              // Prune tile cache if it gets too big (keep ~500 tiles ≈ ~5 MB)
              cache.keys().then(keys => {
                if (keys.length > 500) {
                  keys.slice(0, keys.length - 500).forEach(k => cache.delete(k));
                }
              });
            }
            return res;
          }).catch(() => cached); // If network fails, return stale tile (even expired)
        })
      )
    );
    return;
  }

  // ── Static assets: cache-first ──
  if (url.pathname.match(/\.(html|css|js)$/)) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
    return;
  }

  // ── All other requests (Nominatim, Overpass, OSRM): network-first ──
  // Falls back to cache only if offline
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
