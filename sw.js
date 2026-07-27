// Service Worker v3 — F1 Live Player
// Intercepts segments from all known CDN hosts + caches static assets.

const CACHE_NAME = 'f1-live-assets-v3';
const SEGMENT_CACHE = 'f1-live-segments-v3';
const MAX_SEGMENTS = 40;

const STATIC_ASSETS = ['/', '/index.html', '/css/style.css', '/js/player.js', '/manifest.json'];

// All CDN hosts that serve HLS segments
const SEGMENT_HOSTS = [
  'master2.hdtvs2.top',
  'master2.s1stream.top',
  'master2.sabunhitam.com',
  'dryproxy.antarahimmuhammad.workers.dev'
];

const isSegment = (url) =>
  SEGMENT_HOSTS.some(h => url.hostname.includes(h.split('.').slice(-2).join('.'))) &&
  (url.pathname.endsWith('.html') || url.pathname.match(/\.ts$/) || url.pathname.match(/\.m4s$/));

const notifyClients = (msg) =>
  self.clients.matchAll().then(clients => clients.forEach(c => c.postMessage(msg)));

const pruneCache = async (cache) => {
  const keys = await cache.keys();
  const excess = keys.length - MAX_SEGMENTS;
  if (excess > 0) await Promise.all(keys.slice(0, excess).map(k => cache.delete(k)));
};

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(STATIC_ASSETS).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME && k !== SEGMENT_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Static assets: cache first
  if (STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then(res => res || fetch(event.request)));
    return;
  }

  // HLS segments & manifests: route through SW with custom Referer
  if (isSegment(url) || url.pathname.endsWith('.m3u8')) {
    event.respondWith(handleStreamRequest(event.request));
    return;
  }

  // Default
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

async function handleStreamRequest(request) {
  const url = new URL(request.url);
  const cache = await caches.open(SEGMENT_CACHE);
  const hit = await cache.match(request);
  if (hit) {
    notifyClients({ type: 'cache-hit', url: url.pathname.split('/').pop() });
    return hit;
  }

  // Try direct with spoofed Referer — many CDNs 403 without it
  try {
    const spoofed = new Request(request, {
      headers: {
        ...Object.fromEntries(request.headers.entries()),
        Referer: 'https://esp32.nontonx.com/',
        Origin: 'https://esp32.nontonx.com'
      }
    });
    const res = await fetch(spoofed, { mode: 'cors', credentials: 'omit' });
    if (res.ok) {
      await cache.put(request, res.clone());
      await pruneCache(cache);
      notifyClients({ type: 'cache-store', url: url.pathname.split('/').pop() });
      return res;
    }
  } catch (_) {}

  // Fallback: bare fetch
  try {
    const res = await fetch(request);
    if (res.ok) {
      await cache.put(request, res.clone());
      await pruneCache(cache);
      notifyClients({ type: 'cache-store', url: url.pathname.split('/').pop() });
      return res;
    }
    return new Response('CDN returned ' + res.status, { status: res.status });
  } catch (e) {
    return new Response('SW fetch failed: ' + e.message, { status: 502 });
  }
}

// Prefetch command from player
self.addEventListener('message', async (event) => {
  if (event.data?.type !== 'prefetch-segments') return;
  const cache = await caches.open(SEGMENT_CACHE);
  for (const seg of event.data.segments || []) {
    if (!seg?.url) continue;
    if (await cache.match(seg.url)) continue;
    try {
      const res = await fetch(seg.url, { mode: 'cors', credentials: 'omit' });
      if (res.ok) {
        await cache.put(new Request(seg.url), res.clone());
        notifyClients({ type: 'sw-prefetch', sn: seg.sn, url: seg.url.split('/').pop() });
      }
    } catch (_) {}
  }
  pruneCache(cache);

  if (event.data?.type === 'clear-cache') {
    await caches.delete(SEGMENT_CACHE);
  }
});
