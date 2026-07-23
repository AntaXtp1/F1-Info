// Service Worker v2 — HLS Prefetch + PWA Support
const CACHE_NAME = 'f1-live-assets-v2';
const SEGMENT_CACHE = 'f1-live-segments-v2';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/player.js',
  '/manifest.json',
  '/favicon.ico',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key !== SEGMENT_CACHE) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. Static assets cache first
  if (STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((res) => res || fetch(event.request))
    );
    return;
  }

  // 2. Intercept segment requests
  if ((url.hostname.includes('hdtvs2') || url.hostname.includes('dryproxy')) && 
      (url.pathname.includes('.html') || url.pathname.match(/\.ts$/))) {
    
    event.respondWith(
      caches.open(SEGMENT_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) {
          notifyClients({ type: 'cache-hit', url: url.pathname.split('/').pop() });
          return cached;
        }

        try {
          const response = await fetch(event.request);
          if (response.ok) {
            cache.put(event.request, response.clone());
            pruneCache(cache, 30);
            notifyClients({ type: 'cache-store', url: url.pathname.split('/').pop() });
          }
          return response;
        } catch (err) {
          return fetch(event.request);
        }
      })
    );
    return;
  }

  // Normal request bypass
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

// Communication with player
self.addEventListener('message', async (event) => {
  if (event.data?.type === 'prefetch-segments') {
    const { segments, proxyUrl, useProxy } = event.data;
    const cache = await caches.open(SEGMENT_CACHE);

    for (const seg of segments) {
      const cached = await cache.match(seg.url);
      if (cached) continue;

      try {
        const fetchUrl = useProxy ? proxyUrl + encodeURIComponent(seg.url) : seg.url;
        const res = await fetch(fetchUrl, { mode: 'cors', credentials: 'omit' });
        if (res.ok) {
          await cache.put(new Request(seg.url), res.clone());
          notifyClients({ type: 'sw-prefetch', url: seg.url.split('/').pop(), sn: seg.sn });
        }
      } catch (e) {}
    }
    pruneCache(cache, 30);
  }

  if (event.data?.type === 'clear-cache') {
    await caches.delete(SEGMENT_CACHE);
    notifyClients({ type: 'cache-cleared' });
  }
});

async function pruneCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const toDelete = keys.length - maxEntries;
  for (let i = 0; i < toDelete; i++) {
    await cache.delete(keys[i]);
  }
}

function notifyClients(msg) {
  self.clients.matchAll().then(clients => {
    clients.forEach(client => client.postMessage(msg));
  });
}
