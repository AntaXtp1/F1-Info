// F1 Stream Player v7 — Parallel Pre-fetch Fragment Loader
// Fixed: Custom fLoader to parallelize segment downloads for slow connections

class PrefetchLoader extends Hls.DefaultConfig.loader {
  constructor(config) {
    super(config);
    if (!window.prefetchCache) {
      window.prefetchCache = new Map();
      window.activePrefetches = new Set();
    }
  }

  load(context, config, callbacks) {
    const url = context.url;
    
    // If it's not a media segment (e.g. manifest/playlist), use default loader
    if (!url.includes('.html') && !url.includes('.ts')) {
      super.load(context, config, callbacks);
      return;
    }

    // Check if we have this segment pre-fetched in cache
    if (window.prefetchCache.has(url)) {
      const data = window.prefetchCache.get(url);
      window.prefetchCache.delete(url); // consume once
      
      const stats = {
        trequest: performance.now() - 10,
        tfirst: performance.now() - 5,
        tload: performance.now(),
        loaded: data.byteLength,
        total: data.byteLength
      };
      
      callbacks.onSuccess({ data }, stats, context);
      
      // Trigger pre-fetch for next segments
      this.triggerPrefetchOfNextSegments(context);
      return;
    }

    // Fallback: load normally but also trigger prefetch for next ones
    const originalSuccess = callbacks.onSuccess;
    callbacks.onSuccess = (response, stats, context) => {
      originalSuccess(response, stats, context);
      this.triggerPrefetchOfNextSegments(context);
    };

    super.load(context, config, callbacks);
  }

  triggerPrefetchOfNextSegments(context) {
    try {
      const details = window.player?.hls?.levels?.[window.player?.hls?.currentLevel]?.details;
      if (!details || !details.fragments) return;

      const frags = details.fragments;
      const currentSn = context.frag?.sn;
      if (typeof currentSn !== 'number') return;

      // Prefetch up to 3 next segments
      const prefetchCount = 3;
      for (let i = 1; i <= prefetchCount; i++) {
        const nextFrag = frags.find(f => f.sn === currentSn + i);
        if (nextFrag && nextFrag.url) {
          this.prefetch(nextFrag.url);
        }
      }
    } catch (e) {
      // quiet
    }
  }

  async prefetch(url) {
    if (window.prefetchCache.has(url) || window.activePrefetches.has(url)) {
      return;
    }

    if (window.prefetchCache.size > 8) {
      // Clear oldest to prevent leak
      const firstKey = window.prefetchCache.keys().next().value;
      window.prefetchCache.delete(firstKey);
    }

    window.activePrefetches.add(url);
    
    try {
      let fetchUrl = url;
      if (window.player?.useProxy && window.player?.PROXY_URL) {
        fetchUrl = window.player.PROXY_URL + encodeURIComponent(url);
      }

      const res = await fetch(fetchUrl, {
        headers: {
          'Accept': '*/*',
        }
      });
      
      if (!res.ok) throw new Error('status ' + res.status);
      
      const buffer = await res.arrayBuffer();
      window.prefetchCache.set(url, buffer);
    } catch (e) {
      // quiet fail
    } finally {
      window.activePrefetches.delete(url);
    }
  }
}

class StreamPlayer {
  constructor() {
    this.PROXY_URL = 'https://dryproxy.antarahimmuhammad.workers.dev/?url=';
    this.useProxy = false;
    this.currentUrl = '';
    this.hls = null;
    this.retryCount = 0;
    this.logTotal = 0;
    this.fragLoadTimes = [];
    this.loadingHidden = false;
    this.stallRecoveryAttempts = 0;
    this.lastStallTime = 0;
    this.isRecovering = false;
    this.videoEventListeners = [];
    this.bufferWatchdog = null;
    
    // Log filtering
    this.logFilters = {
      info: true,
      ok: true,
      warn: true,
      err: true,
      debug: false
    };

    // DOM cache
    this.video = document.getElementById('video');
    this.urlInput = document.getElementById('urlInput');
    this.statusEl = document.getElementById('status');
    this.logBox = document.getElementById('logBox');
    this.logCountEl = document.getElementById('logCount');
    this.urlLabel = document.getElementById('urlLabel');
    this.loadingOverlay = document.getElementById('loadingOverlay');
    this.loadingBar = document.getElementById('loadingBar');
    this.loadingText = document.getElementById('loadingText');
    this.bandwidthMeter = document.getElementById('bandwidthMeter');

    this.init();
  }

  init() {
    this.bindEvents();
    this.log('player ready — paste URL or pick preset', 'info');
  }

  bindEvents() {
    document.getElementById('loadBtn').addEventListener('click', () => {
      const url = this.urlInput.value.trim();
      if (url) this.load(url);
    });

    this.urlInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const url = this.urlInput.value.trim();
        if (url) this.load(url);
      }
    });

    document.getElementById('proxyToggle').addEventListener('click', (e) => {
      this.useProxy = !this.useProxy;
      e.target.classList.toggle('active', this.useProxy);
      this.log('proxy: ' + (this.useProxy ? 'ON' : 'OFF'), 'warn');
      if (this.currentUrl) this.load(this.currentUrl);
    });

    document.getElementById('reloadBtn').addEventListener('click', () => {
      this.log('manual reload', 'info');
      if (this.currentUrl) this.load(this.currentUrl);
    });

    document.getElementById('clearLog').addEventListener('click', () => {
      this.logBox.innerHTML = '';
      this.logTotal = 0;
      this.logCountEl.textContent = '0';
    });

    document.getElementById('copyUrl').addEventListener('click', () => {
      if (!this.currentUrl) return;
      navigator.clipboard.writeText(this.currentUrl).then(() => {
        this.log('URL copied to clipboard', 'ok');
      }).catch(() => {
        this.log('clipboard copy failed', 'err');
      });
    });

    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.dataset.url;
        this.urlInput.value = url;
        this.load(url);
      });
    });

    document.querySelectorAll('.log-filter input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const type = e.target.dataset.type;
        this.logFilters[type] = e.target.checked;
        this.applyLogFilters();
      });
    });
  }

  applyLogFilters() {
    document.querySelectorAll('.log-line').forEach(line => {
      const types = ['info', 'ok', 'warn', 'err', 'debug'];
      const lineType = types.find(t => line.classList.contains(t));
      if (lineType && !this.logFilters[lineType]) {
        line.classList.add('hidden');
      } else {
        line.classList.remove('hidden');
      }
    });
  }

  log(text, type = 'info') {
    const now = new Date().toLocaleTimeString('id-ID', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const div = document.createElement('div');
    div.className = 'log-line ' + type;
    if (!this.logFilters[type]) div.classList.add('hidden');
    div.innerHTML = '<span class="time">[' + now + ']</span>' + this.escapeHtml(text);
    this.logBox.appendChild(div);
    this.logBox.scrollTop = this.logBox.scrollHeight;
    this.logTotal++;
    this.logCountEl.textContent = this.logTotal;
  }

  escapeHtml(t) {
    return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  setStatus(text, cls) {
    this.statusEl.textContent = text;
    this.statusEl.className = 'status ' + (cls || '');
  }

  showLoading(text) {
    this.loadingOverlay.classList.add('active');
    this.loadingText.textContent = text || 'connecting...';
    this.loadingBar.style.width = '0%';
    this.loadingHidden = false;
  }

  hideLoading() {
    if (this.loadingHidden) return;
    this.loadingHidden = true;
    this.loadingOverlay.classList.remove('active');
  }

  updateLoadingProgress(percent) {
    this.loadingBar.style.width = percent + '%';
  }

  buildUrl(rawUrl) {
    if (!rawUrl) return '';
    this.urlLabel.textContent = rawUrl;
    if (this.useProxy && this.PROXY_URL) return this.PROXY_URL + encodeURIComponent(rawUrl);
    return rawUrl;
  }

  updateBandwidth(bytesPerSec) {
    const kbps = (bytesPerSec * 8 / 1024).toFixed(0);
    this.bandwidthMeter.textContent = kbps + ' Kbps';
    this.bandwidthMeter.className = 'bandwidth-meter';
    if (bytesPerSec > 200000) this.bandwidthMeter.classList.add('good');
    else if (bytesPerSec > 100000) this.bandwidthMeter.classList.add('slow');
    else this.bandwidthMeter.classList.add('bad');
  }

  getStatsBytes(stats) {
    if (!stats) return 0;
    return stats.total || stats.loaded || 0;
  }

  getStatsTiming(stats) {
    if (!stats) return null;
    if (stats.loading && stats.loading.start && stats.loading.end) {
      return { start: stats.loading.start, end: stats.loading.end };
    }
    if (stats.trequest && stats.tload) {
      return { start: stats.trequest, end: stats.tload };
    }
    return null;
  }

  checkBufferProgress() {
    if (this.loadingHidden) return;
    
    const buffered = this.video.buffered;
    if (buffered.length === 0) return;
    
    const bufferedEnd = buffered.end(buffered.length - 1);
    const bufferedSec = bufferedEnd - this.video.currentTime;
    const targetBuffer = 8;
    const progress = Math.min(95, 30 + (bufferedSec / targetBuffer) * 65);
    
    if (bufferedSec < 0) {
      this.loadingText.textContent = 'rebuffering... (buffer empty)';
      this.updateLoadingProgress(30);
      this.setStatus('rebuffering', 'warn');
      return;
    }
    
    this.updateLoadingProgress(progress);
    this.loadingText.textContent = 'buffering... ' + bufferedSec.toFixed(1) + 's';
    
    if (bufferedSec >= targetBuffer) {
      this.hideLoading();
      this.setStatus('live', 'ok');
      if (this.video.paused) {
        this.video.play().catch(e => {
          this.log('autoplay blocked: ' + e.message, 'warn');
        });
      }
    }
  }

  // === KEY FIX: Stall Recovery ===
  recoverFromStall() {
    if (this.isRecovering) return;
    this.isRecovering = true;
    this.stallRecoveryAttempts++;
    
    const buffered = this.video.buffered;
    const currentTime = this.video.currentTime;
    
    // Find earliest buffered position
    let bufferStart = Infinity;
    for (let i = 0; i < buffered.length; i++) {
      bufferStart = Math.min(bufferStart, buffered.start(i));
    }
    
    this.log('stall recovery #' + this.stallRecoveryAttempts + ' — buffer start: ' + bufferStart.toFixed(1) + 's, current: ' + currentTime.toFixed(1) + 's', 'warn');
    
    // Strategy: Seek to buffer start if ahead of current position
    if (bufferStart < Infinity && bufferStart > currentTime + 0.5) {
      this.video.currentTime = bufferStart;
      this.log('seeking to buffer start: ' + bufferStart.toFixed(1), 'info');
    } else if (this.hls && this.hls.liveSyncPosition) {
      // Fallback: seek to live edge - 2s (but validate against buffer)
      const target = this.hls.liveSyncPosition - 2;
      if (target > 0) {
        this.video.currentTime = target;
        this.log('seeking to live edge - 2s: ' + target.toFixed(1), 'info');
      }
    }
    
    // Force reload
    if (this.hls) {
      this.hls.startLoad();
    }
    
    setTimeout(() => {
      this.isRecovering = false;
    }, 3000);
  }

  load(rawUrl) {
    if (!rawUrl) {
      this.log('no URL provided', 'err');
      return;
    }

    this.currentUrl = rawUrl;
    const url = this.buildUrl(rawUrl);
    this.retryCount = 0;
    this.fragLoadTimes = [];
    this.stallRecoveryAttempts = 0;
    this.lastStallTime = 0;
    this.isRecovering = false;
    
    this.setStatus('loading', 'loading');
    this.showLoading('connecting to stream...');
    this.log('connecting: ' + rawUrl, 'info');
    if (this.useProxy) this.log('via proxy: ' + this.PROXY_URL.split('?')[0], 'info');

    // Cleanup
    this.cleanup();

    if (Hls.isSupported()) {
      this.hls = new Hls({
        enableWorker: false,
        debug: false,
        
        // Inject Custom Parallel Loader
        fLoader: PrefetchLoader,
        
        // Live stream config
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
        maxLiveSyncPlaybackRate: 1.1,
        
        // Buffer tuning
        maxBufferLength: 15,
        maxMaxBufferLength: 30,
        backBufferLength: 0,
        
        // Gap handling
        maxBufferHole: 0.5,
        highBufferWatchdogPeriod: 2,
        nudgeMaxRetry: 10,
        
        // Network retry
        manifestLoadingTimeOut: 15000,
        manifestLoadingMaxRetry: 4,
        manifestLoadingRetryDelay: 1000,
        
        levelLoadingTimeOut: 15000,
        levelLoadingMaxRetry: 4,
        levelLoadingRetryDelay: 1000,
        
        fragLoadingTimeOut: 30000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 1000,
        fragLoadingMaxRetryTimeout: 64000,
        
        // ABR
        startLevel: 0,
        capLevelToPlayerSize: false,
        
        xhrSetup: (xhr, url) => {
          xhr.responseType = 'arraybuffer';
          xhr.overrideMimeType('application/octet-stream');
        }
      });

      this.hls.loadSource(url);
      this.hls.attachMedia(this.video);

      // === MANIFEST ===
      this.hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        this.log('manifest ok — ' + data.levels.length + ' level(s)', 'ok');
        this.updateLoadingProgress(20);
        data.levels.forEach((level, idx) => {
          const res = level.width && level.height ? level.width + 'x' + level.height : 'audio-only';
          const br = level.bitrate ? (level.bitrate / 1000).toFixed(0) + ' Kbps' : '?';
          this.log('  level ' + idx + ': ' + res + ' @ ' + br, 'debug');
        });
        
        // Auto-play setelah manifest parsed
        this.video.play().catch(e => {
          this.log('autoplay blocked: ' + e.message, 'warn');
        });
      });

      // === LEVEL LOADED ===
      let levelLoadCount = 0;
      this.hls.on(Hls.Events.LEVEL_LOADED, (_, data) => {
        levelLoadCount++;
        if (levelLoadCount <= 2 || levelLoadCount % 10 === 0) {
          const frags = data.details.fragments?.length || '?';
          this.log('playlist refresh #' + levelLoadCount + ' — ' + frags + ' frags', 'debug');
        }
      });

      // === FRAG LOADED ===
      let fragLoadCount = 0;
      this.hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
        try {
          const frag = data.frag;
          const stats = data.stats;
          fragLoadCount++;

          const bytes = this.getStatsBytes(stats);
          const timing = this.getStatsTiming(stats);
          const size = bytes ? (bytes / 1024).toFixed(1) + 'KB' : '?';
          
          let speed = '?';
          let downloadMs = 0;
          let fragDurMs = (frag.duration || 0) * 1000;
          
          if (timing) {
            downloadMs = timing.end - timing.start;
            if (downloadMs > 0 && bytes > 0) {
              const bytesPerSec = (bytes / downloadMs) * 1000;
              speed = (bytesPerSec / 1024).toFixed(1) + ' KB/s';
              this.updateBandwidth(bytesPerSec);
            }
          }
          
          const ratio = fragDurMs > 0 && downloadMs > 0 ? (downloadMs / fragDurMs).toFixed(2) : '?';
          
          const isSlow = downloadMs > fragDurMs * 1.5;
          if (fragLoadCount === 1 || fragLoadCount % 5 === 0 || isSlow) {
            let msg = 'frag ' + frag.sn + ' — ' + size + ' @ ' + speed + ' (ratio ' + ratio + ')';
            this.log(msg, isSlow ? 'warn' : 'info');
          }

          this.checkBufferProgress();
        } catch (e) {
          this.log('FRAG_LOADED handler error: ' + e.message, 'err');
        }
      });

      // === BUFFER_APPENDED ===
      let bufferAppendCount = 0;
      this.hls.on(Hls.Events.BUFFER_APPENDED, (_, data) => {
        bufferAppendCount++;
        const b = this.video.buffered;
        if (b.length > 0) {
          const bufferedSec = (b.end(b.length - 1) - this.video.currentTime).toFixed(1);
          if (bufferAppendCount === 1 || bufferAppendCount % 3 === 0) {
            this.log('buffer append #' + bufferAppendCount + ' — ' + bufferedSec + 's ahead', 'info');
          }
        }
        this.checkBufferProgress();
      });

      // === FRAG_BUFFERED ===
      this.hls.on(Hls.Events.FRAG_BUFFERED, (_, data) => {
        const b = this.video.buffered;
        if (b.length > 0) {
          const bufferedSec = (b.end(b.length - 1) - this.video.currentTime).toFixed(1);
          this.log('buffer: ' + bufferedSec + 's ahead @ pos ' + this.video.currentTime.toFixed(1), 'debug');
        }
        this.checkBufferProgress();
      });

      // === === === === === === === === === === === === === ===
      // === FIXED: Comprehensive Error Handling ===
      // === === === === === === === === === === === === === ===
      this.hls.on(Hls.Events.ERROR, (_, data) => {
        const msg = '[' + data.type + '] ' + data.details;
        
        // Log semua error tapi bedain severity
        if (data.fatal) {
          this.log(msg, 'err');
        } else if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
          this.log(msg, 'warn');
        } else {
          this.log(msg, 'info');
        }
        
        if (data.response) this.log('HTTP ' + data.response.code, 'err');
        if (data.reason) this.log('reason: ' + data.reason, 'err');

        // === BUFFER STALLED (let hls.js handle via nudge) ===
        if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
          this.log('buffer stalled — hls.js will attempt nudge', 'info');
          return;
        }

        // === BUFFER NUDGE (gap handling) ===
        if (data.details === Hls.ErrorDetails.BUFFER_NUDGE_ON_STALL) {
          this.log('nudging playback to overcome gap', 'info');
          return;
        }

        if (data.fatal) {
          this.hideLoading();
          this.setStatus('fatal', 'err');
          
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              this.retryCount++;
              if (this.retryCount > 5) {
                this.log('retry limit reached', 'err');
                this.setStatus('failed', 'err');
              } else {
                this.log('network error — retry #' + this.retryCount + ' in 3s', 'warn');
                setTimeout(() => {
                  if (this.hls) this.hls.startLoad();
                }, 3000);
              }
              break;
              
            case Hls.ErrorTypes.MEDIA_ERROR:
              this.log('media error — attempting recovery...', 'warn');
              try {
                this.hls.recoverMediaError();
              } catch (e) {
                this.log('media recovery failed, trying swap...', 'err');
                try {
                  this.hls.swapAudioCodec();
                  this.hls.recoverMediaError();
                } catch (e2) {
                  this.log('unrecoverable media error', 'err');
                  this.setStatus('failed', 'err');
                }
              }
              break;
              
            default:
              this.log('unrecoverable error: ' + data.type, 'err');
              this.setStatus('failed', 'err');
          }
        }
      });

      // === VIDEO ELEMENT EVENTS (tracked for cleanup) ===
      const onWaiting = () => {
        const pos = this.video.currentTime.toFixed(1);
        this.log('WAITING @ ' + pos, 'warn');
        
        if (this.loadingHidden) {
          this.loadingHidden = false;
          this.loadingOverlay.classList.add('active');
          this.loadingText.textContent = 'rebuffering...';
          this.setStatus('rebuffering', 'warn');
        }
        
        const buffered = this.video.buffered;
        let hasBuffer = false;
        for (let i = 0; i < buffered.length; i++) {
          if (this.video.currentTime >= buffered.start(i) && this.video.currentTime <= buffered.end(i)) {
            hasBuffer = true;
            break;
          }
        }
        
        // Manual stall recovery disabled — let hls.js handle it
        // if (!hasBuffer && !this.isRecovering) {
        //   this.recoverFromStall();
        // }
      };

      const onStalled = () => {
        this.log('STALLED — network interrupted', 'warn');
      };

      const onPlaying = () => {
        this.log('playback resumed', 'ok');
        this.setStatus('live', 'ok');
        this.hideLoading();
        this.stallRecoveryAttempts = 0;
      };

      const onError = () => {
        const err = this.video.error;
        if (err) {
          const codes = ['', 'ABORTED', 'NETWORK', 'DECODE', 'SRC_NOT_SUPPORTED'];
          this.log('video element error: ' + (codes[err.code] || 'UNKNOWN') + ' (' + err.code + ')', 'err');
        }
      };

      this.video.addEventListener('waiting', onWaiting);
      this.video.addEventListener('stalled', onStalled);
      this.video.addEventListener('playing', onPlaying);
      this.video.addEventListener('error', onError);
      
      this.videoEventListeners.push(['waiting', onWaiting], ['stalled', onStalled], ['playing', onPlaying], ['error', onError]);
      
      // === PERIODIC BUFFER CHECK (disabled — let hls.js handle stalls) ===
      // Watchdog disabled — HLS.js built-in stall detection + nudge is more reliable
      // this.bufferWatchdog = setInterval(() => { ... }, 5000);

    } else if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      this.log('native HLS (Safari/iOS)', 'info');
      this.video.src = url;
      this.video.addEventListener('loadedmetadata', () => {
        this.hideLoading();
        this.video.play();
        this.setStatus('live', 'ok');
        this.log('native stream OK', 'ok');
      }, { once: true });
      this.video.addEventListener('error', () => {
        this.hideLoading();
        this.setStatus('error', 'err');
      }, { once: true });
      
    } else {
      this.hideLoading();
      this.log('HLS not supported', 'err');
      this.setStatus('unsupported', 'err');
    }
  }
  
  cleanup() {
    if (this.bufferWatchdog) {
      clearInterval(this.bufferWatchdog);
      this.bufferWatchdog = null;
    }
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.videoEventListeners.forEach(([event, handler]) => {
      this.video.removeEventListener(event, handler);
    });
    this.videoEventListeners = [];
  }
  
  destroy() {
    this.cleanup();
  }
}

// Init
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { window.player = new StreamPlayer(); });
} else {
  window.player = new StreamPlayer();
}
