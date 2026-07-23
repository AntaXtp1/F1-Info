# F1 Live Stream Player v6

Lightweight HLS live stream player optimized for low-latency F1 broadcasts.

## Features

- **Direct level playback** — bypass ABR, load specific quality (480p/720p/1080p)
- **Anti-leech bypass** — handles `.html` segment extensions via XHR override
- **Live log panel** — real-time fragment loading, buffer stats, error tracking
- **Proxy support** — Cloudflare Worker proxy for CORS/ISP blocks
- **Mobile-friendly** — responsive layout, touch controls

## Stack

- **HLS.js 1.5.13** — mature, battle-tested
- **Vanilla JS** — zero dependencies beyond HLS.js
- **Dark minimal UI** — ~6KB CSS, monospace aesthetic

## Config Highlights

```js
{
  liveSyncDurationCount: 2,        // 2 segments behind live edge
  maxBufferLength: 10,             // 10s buffer (fast startup)
  nudgeMaxRetry: 10,               // aggressive gap handling
  fragLoadingTimeOut: 20000,       // 20s timeout per segment
  xhrSetup: (xhr) => {
    xhr.responseType = 'arraybuffer';
    xhr.overrideMimeType('application/octet-stream'); // bypass MIME check
  }
}
```

## Deployment

### Cloudflare Pages

```bash
npm install -g wrangler  # if needed
wrangler pages deploy . --project-name=f1-live
```

### Static Host

Upload `index.html`, `css/`, `js/` to any static host. HTTPS required for HTTPS streams.

## Proxy Worker

Required for:
- ISP blocks (`master2.hdtvs2.top`, `*.r2.dev`)
- CORS bypass
- Mixed content (HTTP origin → HTTPS stream)

```js
// worker.js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    if (!target) return new Response('Missing ?url=', { status: 400 });
    
    const res = await fetch(target, {
      headers: { 'Origin': new URL(target).origin }
    });
    
    const headers = new Headers(res.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    headers.set('Access-Control-Max-Age', '86400');
    
    return new Response(res.body, {
      status: res.status,
      headers
    });
  }
};
```

Deploy: `wrangler deploy worker.js`

Update `PROXY_URL` in `js/player.js`:
```js
this.PROXY_URL = 'https://YOUR-WORKER.workers.dev/?url=';
```

## Known Issues

### Mixed Content
HTTP origin + HTTPS stream = blocked by browsers. Deploy to HTTPS or enable proxy.

### Segment `.html` Extension
Stream uses `.html` for TS segments (anti-leech). `overrideMimeType()` handles it, but some CDNs/workers may timeout on large binary fetches with text/html Content-Type.

### Buffer Stalls
Live streams + slow connections → periodic stalls. Player relies on HLS.js built-in nudge recovery. Watchdog disabled to avoid seek loops.

## License

MIT
