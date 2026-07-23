// Service Worker v1 — HLS Segment Prefetch Cache
// Intercepts .html/.ts segment requests, serves from Cache API when available

const CACHE_NAME = 'hls-segment-cache-v1';
const PREFETCH_AHEAD = 5; // prefetch 5 segments ahead
const MAX_CACHE_ENTRIES = 30; // max 30 segments cached (prevents memory leak)

let currentManifest = null;
let lastKnownSN = null;

// Install — activate immediately
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Activate — claim all clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(() => self.clients.claim())
  );
});

// Fetch — intercept segment requests
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only intercept segment files (.html extension from hdtvs2 streams)
  if (!url.hostname.includes('hdtvs2') && !url.hostname.includes('dryproxy')) return;
  if (!url.pathname.includes('.html') && !url.pathname.match(/\.ts$/)) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Check cache first
      const cached = await cache.match(event.request);
      if (cached) {
        // Notify clients about cache hit (for log panel)
        notifyClients({ type: 'cache-hit', url: url.pathname.split('/').pop() });
        return cached;
      }

      // Cache miss — fetch from network, cache result
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          // Clone because response body can only be consumed once
          const clone = response.clone();
          cache.put(event.request, clone);

          // Prune old entries
          pruneCache(cache);

          // Notify clients
          notifyClients({ type: 'cache-store', url: url.pathname.split('/').pop() });
        }
        return response;
      } catch (err) {
        notifyClients({ type: 'cache-error', url: url.pathname.split('/').pop(), error: err.message });
        throw err;
      }
    })
  );
});

// Listen for manifest updates from the main page (tells SW which segments to prefetch)
self.addEventListener('message', async (event) => {
  if (event.data?.type === 'prefetch-segments') {
    const { segments, proxyUrl, useProxy } = event.data;
    const cache = await caches.open(CACHE_NAME);

    for (const seg of segments) {
      const cacheKey = seg.url;
      const cached = await cache.match(cacheKey);
      if (cached) continue; // already cached

      try {
        const fetchUrl = useProxy ? proxyUrl + encodeURIComponent(seg.url) : seg.url;
        const res = await fetch(fetchUrl, {
          mode: 'cors',
          credentials: 'omit'
        });
        if (res.ok) {
          const clone = res.clone();
          // Store with original URL as key (so XHR lookup works)
          await cache.put(new Request(seg.url), clone);
          notifyClients({ type: 'sw-prefetch', url: seg.url.split('/').pop(), sn: seg.sn });
        }
      } catch (e) {
        // quiet fail
      }
    }

    // Prune after prefetch
    pruneCache(cache);
  }

  if (event.data?.type === 'clear-cache') {
    await caches.delete(CACHE_NAME);
    notifyClients({ type: 'cache-cleared' });
  }
});

// Prune oldest entries when cache exceeds MAX_CACHE_ENTRIES
async function pruneCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_CACHE_ENTRIES) return;

  const toDelete = keys.length - MAX_CACHE_ENTRIES;
  for (let i = 0; i < toDelete; i++) {
    await cache.delete(keys[i]);
  }
}

// Notify all connected clients (the player page)
function notifyClients(msg) {
  self.clients.matchAll().then(clients => {
    clients.forEach(client => client.postMessage(msg));
  });
}
