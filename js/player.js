// F1 Live Player v17 — "Silver Drive"
// Splash server-pick → 5s buffer veil → playback.
// HLS.js + Service Worker segment cache + dynamic buffer tuning.

(() => {
  const SERVERS = {
    primary: {
      label: 'PRIMARY',
      host: 'master2.hdtvs2.top',
      base: 'https://master2.hdtvs2.top/hls',
      levels: { 1: '720p', 2: '480p', 3: '360p' },
      defaultLevel: 2
    },
    mirror1: {
      label: 'MIRROR 1',
      host: 'master2.s1stream.top',
      base: 'https://master2.s1stream.top/hls',
      levels: { 2: '480p' },
      defaultLevel: 2
    },
    mirror2: {
      label: 'MIRROR 2',
      host: 'master2.sabunhitam.com',
      base: 'https://master2.sabunhitam.com/hls',
      levels: { 2: '480p' },
      defaultLevel: 2
    }
  };

  const PRELOAD_BUFFER_S = 7;     // dismiss loading veil after this many seconds ahead
  const MIN_BUFFER_HARD = 4;       // hard minimum before allowing play
  const ANIMATION_HOLD_MS = 5000;  // visual loading duration even when buffer ready sooner

  const state = {
    serverKey: null,
    server: null,
    level: 2,
    hls: null,
    video: null,
    fragTimes: [],
    swHits: 0,
    logEntries: [],
    lastFragSn: 0,
    playbackRateBase: 1
  };

  const $ = (id) => document.getElementById(id);

  // ──────────────── Splash probing ────────────────
  const PROXY = 'https://dryproxy.antarahimmuhammad.workers.dev/?url=';

  async function probeServer(key) {
    const cfg = SERVERS[key];
    const url = `${cfg.base}/${state.level}/stream.m3u8`;
    const t0 = performance.now();
    // Try direct first
    try {
      const res = await fetch(url, { cache: 'no-store', mode: 'cors', credentials: 'omit' });
      const ms = Math.round(performance.now() - t0);
      if (res.ok) return { ok: true, ms, url, viaProxy: false };
    } catch (_) {}
    // Fallback: via proxy
    try {
      const res = await fetch(PROXY + encodeURIComponent(url), { cache: 'no-store' });
      const ms = Math.round(performance.now() - t0);
      if (res.ok) return { ok: true, ms, url, viaProxy: true };
      throw new Error('HTTP ' + res.status);
    } catch (e) {
      return { ok: false, ms: null, error: String(e.message || e) };
    }
  }

  async function probeAll() {
    const probes = await Promise.all(
      Object.keys(SERVERS).map(async (k) => [k, await probeServer(k)])
    );
    for (const [k, result] of probes) {
      const dot = $('dot' + k);
      const lat = $('lat' + k);
      const btn = $('btn' + k);
      if (result.ok) {
        dot.classList.add('live');
        lat.textContent = result.ms + ' ms' + (result.opaque ? ' (cors)' : '');
        lat.classList.add('ok');
      } else {
        dot.classList.add('dead');
        lat.textContent = result.error || 'offline';
        lat.classList.add('bad');
        btn.disabled = true;
      }
    }
  }

  // ──────────────── Server selection ────────────────
  function pickServer(key) {
    if (!SERVERS[key]) return;
    state.serverKey = key;
    state.server = SERVERS[key];
    state.level = state.server.defaultLevel;
    runLoadingSequence();
  }

  function resolveUrl(url, useProxy) {
    return useProxy ? PROXY + encodeURIComponent(url) : url;
  }

  // ──────────────── Loading veil sequence ────────────────
  function runLoadingSequence() {
    const veil = $('loadingVeil');
    $('splash').style.display = 'none';
    $('loadName').textContent = state.server.label;
    $('loadRes').textContent = `${state.server.levels[state.level]} · Membangun buffer...`;
    $('loadStatus').textContent = 'Menghubungkan ke server...';
    $('loadFill').style.width = '0%';
    veil.classList.add('active');

    setStatusText('connecting', 'warn');

    // Start playback immediately
    startStream();

    // Animate progress
    const start = Date.now();
    const tick = setInterval(() => {
      const elapsed = Date.now() - start;
      const bufferSec = getBufferedAhead();
      const target = PRELOAD_BUFFER_S;
      const ratio = Math.min(1, bufferSec / target);
      $('loadFill').style.width = (ratio * 100).toFixed(0) + '%';

      if (bufferSec < 1) {
        $('loadStatus').textContent = 'Meminta playlist...';
      } else if (bufferSec < 3) {
        $('loadStatus').textContent = `Buffer ${bufferSec.toFixed(1)}s / ${target}s`;
      } else if (bufferSec < target) {
        $('loadStatus').textContent = `Mengamankan buffer ${bufferSec.toFixed(1)}s / ${target}s`;
      } else {
        $('loadStatus').textContent = 'Buffer aman · Menyiapkan playback';
      }

      if (ratio >= 1 || elapsed >= ANIMATION_HOLD_MS) {
        clearInterval(tick);
        finishLoading();
      }
    }, 200);
  }

  function finishLoading() {
    $('loadingVeil').classList.remove('active');
    $('playerShell').classList.add('active');
    $('tpServerLabel').textContent = state.server.label + ' · ' + state.server.levels[state.level];
    syncResMenu();
    state.video.play().catch((e) => appendLog('autoplay blocked: ' + e.message, 'warn'));
  }

  // ──────────────── Stream engine ────────────────
  function startStream() {
    if (!Hls.isSupported()) {
      appendLog('HLS not supported', 'err');
      return;
    }
    cleanupStream();

    const url = `${state.server.base}/${state.level}/stream.m3u8`;
    state.video = $('video');
    state.video.muted = true;

    state.hls = new Hls({
      enableWorker: false,
      lowLatencyMode: false,
      maxBufferLength: 60,
      maxMaxBufferLength: 120,
      backBufferLength: 30,
      liveSyncDurationCount: state.level === 3 ? 5 : 10,
      liveMaxLatencyDurationCount: state.level === 3 ? 12 : 30,
      liveDurationInfinity: false,
      maxBufferHole: 0.3,
      nudgeOffset: 0.05,
      nudgeMaxRetry: 8,
      highBufferWatchdogPeriod: 2,
      manifestLoadingTimeOut: 25000,
      levelLoadingTimeOut: 25000,
      fragLoadingTimeOut: 40000,
      fragLoadingMaxRetry: 10,
      fragLoadingRetryDelay: 600,
      levelLoadingMaxRetry: 6,
      progressive: true,
      startLevel: 0
    });

    state.hls.loadSource(url);
    state.hls.attachMedia(state.video);

    state.hls.on(Hls.Events.MANIFEST_PARSED, () => {
      appendLog(`manifest parsed (${state.server.label} ${state.server.levels[state.level]})`, 'ok');
      setStatusText('loading', 'warn');
      requestSWPrefetch();
    });

    state.hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
      const stats = data?.stats;
      if (stats?.loading?.start && stats?.loading?.end && stats.total) {
        const dur = stats.loading.end - stats.loading.start;
        const bps = (stats.total / dur) * 1000;
        state.fragTimes.push(bps);
        if (state.fragTimes.length > 8) state.fragTimes.shift();
        const kbps = Math.round((bps * 8) / 1024);
        $('tpBw').textContent = `${kbps} Kbps`;
        state.lastFragSn = data.frag.sn;
      }
      requestSWPrefetch();
    });

    state.hls.on(Hls.Events.ERROR, (_, data) => {
      appendLog(`[${data.type}] ${data.details}` + (data.fatal ? ' FATAL' : ''), 'err');
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        try { state.hls.recoverMediaError(); } catch (e) {}
      } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        setTimeout(() => state.hls?.startLoad(), 2000);
      }
    });

    state.video.addEventListener('playing', () => setStatusText('live', 'ok'));
    state.video.addEventListener('waiting', () => setStatusText('buffering', 'warn'));

    updateDebugInfo();
  }

  function cleanupStream() {
    if (state.hls) {
      state.hls.destroy();
      state.hls = null;
    }
  }

  function switchResolution(level) {
    if (!state.server || level === state.level) return;
    if (!state.server.levels[level]) return;
    state.level = level;
    startStream();
    syncResMenu();
    $('tpServerLabel').textContent = state.server.label + ' · ' + state.server.levels[level];
  }

  function syncResMenu() {
    document.querySelectorAll('.res-pop button').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.level) === state.level);
    });
    $('btnResToggle').textContent = state.server.levels[state.level];
  }

  // ──────────────── SW prefetch bridge ────────────────
  function requestSWPrefetch() {
    if (!state.hls || !navigator.serviceWorker?.controller) return;
    const level = state.hls.levels[state.hls.currentLevel];
    if (!level?.details) return;
    const fragments = level.details.fragments || [];
    const idx = state.lastFragSn;
    const upcoming = fragments.slice(idx + 1, idx + 9).map((f) => ({ sn: f.sn, url: f.url }));
    if (!upcoming.length) return;
    navigator.serviceWorker.controller.postMessage({
      type: 'prefetch-segments',
      segments: upcoming
    });
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg?.type === 'cache-hit') {
        state.swHits++;
        appendLog('SW cache hit: ' + msg.url, 'debug');
      } else if (msg?.type === 'cache-store') {
        appendLog('SW cached: ' + msg.url, 'debug');
      }
    });
  }

  // ──────────────── Helpers ────────────────
  function getBufferedAhead() {
    const v = state.video;
    if (!v?.buffered?.length) return 0;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.currentTime >= v.buffered.start(i) && v.currentTime <= v.buffered.end(i)) {
        return v.buffered.end(i) - v.currentTime;
      }
    }
    return v.buffered.end(v.buffered.length - 1) - v.currentTime;
  }

  function setStatusText(text, cls) {
    $('statusTxt').textContent = text;
    $('tpStatus').className = 'chip live ' + cls;
  }

  function appendLog(msg, type = 'info') {
    const ts = new Date().toLocaleTimeString('id-ID', { hour12: false });
    state.logEntries.push({ ts, msg, type });
    if (state.logEntries.length > 50) state.logEntries.shift();
    const el = $('dbLog');
    if (el) {
      const div = document.createElement('div');
      div.innerHTML = `<span style="color:#5a6370">[${ts}]</span> ${msg}`;
      el.appendChild(div);
      el.scrollTop = el.scrollHeight;
    }
  }

  function updateDebugInfo() {
    if (!state.server) return;
    $('dbServer').textContent = state.server.label;
    $('dbUrl').textContent = `${state.server.base}/${state.level}/stream.m3u8`;
    $('dbRes').textContent = state.server.levels[state.level];
  }

  // ──────────────── UI bindings ────────────────
  function bindUI() {
    document.querySelectorAll('.server-btn').forEach((b) => {
      b.addEventListener('click', () => pickServer(b.dataset.server));
    });

    $('btnResToggle').addEventListener('click', (e) => {
      e.stopPropagation();
      $('resPop').classList.toggle('active');
    });
    document.querySelectorAll('.res-pop button').forEach((b) => {
      b.addEventListener('click', () => {
        $('resPop').classList.remove('active');
        switchResolution(Number(b.dataset.level));
      });
    });
    document.addEventListener('click', () => $('resPop').classList.remove('active'));

    $('btnUnmute').addEventListener('click', () => {
      const v = $('video');
      v.muted = !v.muted;
      $('btnUnmute').textContent = v.muted ? 'Aktifkan Suara' : 'Matikan Suara';
      $('btnUnmute').classList.toggle('active', !v.muted);
    });

    $('btnReload').addEventListener('click', () => startStream());

    $('btnFullscreen').addEventListener('click', () => {
      const v = $('video');
      if (!document.fullscreenElement) v.requestFullscreen?.();
      else document.exitFullscreen?.();
    });

    $('btnDebug').addEventListener('click', () => {
      $('debugDrawer').classList.toggle('active');
    });
    $('btnDebugClose').addEventListener('click', () => {
      $('debugDrawer').classList.remove('active');
    });

    $('btnBack').addEventListener('click', () => {
      cleanupStream();
      $('playerShell').classList.remove('active');
      $('splash').style.display = 'flex';
      $('loadingVeil').classList.remove('active');
      probeAll();
    });

    // Periodic debug refresh
    setInterval(() => {
      if (!state.server || !state.video) return;
      $('dbBuf').textContent = getBufferedAhead().toFixed(1) + 's';
      $('dbBw').textContent = $('tpBw').textContent;
      $('dbRate').textContent = state.video.playbackRate.toFixed(2) + 'x';
      $('dbFrag').textContent = state.lastFragSn;
      $('dbSw').textContent = state.swHits;
      const lat = state.hls?.liveSyncPosition;
      if (lat != null && state.video) {
        $('dbLat').textContent = (lat - state.video.currentTime).toFixed(1) + 's';
      }
    }, 1000);
  }

  // ──────────────── Boot ────────────────
  document.addEventListener('DOMContentLoaded', () => {
    bindUI();
    registerSW();
    probeAll();
  });
})();