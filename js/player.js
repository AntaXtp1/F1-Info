// F1 Stream Player v8 — Silent Browser-Cache Prefetcher
// Fixed: Zero-risk cache pre-fetching using standard browser cache

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
    this.prefetchedUrls = new Set();
    
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
    this.registerServiceWorker();
    this.log('player ready — starting 360p auto-load...', 'info');
    
    // === Opsi 1: Auto-start 360p loading with startup overlay ===
    this.startupLoad();
  }

  registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
      this.log('service worker not supported', 'warn');
      return;
    }
    navigator.serviceWorker.register('/sw.js')
      .then(reg => {
        this.log('service worker registered', 'ok');
        // Listen for SW messages (cache hits, prefetch logs)
        navigator.serviceWorker.addEventListener('message', (event) => {
          const msg = event.data;
          if (msg?.type === 'sw-prefetch') {
            this.log('SW cached seg ' + msg.sn + ' (' + msg.url + ')', 'debug');
          } else if (msg?.type === 'cache-hit') {
            this.log('SW cache hit: ' + msg.url, 'debug');
          }
        });
      })
      .catch(err => {
        this.log('SW registration failed: ' + err.message, 'warn');
      });
  }

  // Tell Service Worker to prefetch upcoming segments
  prefetchViaSW(segments) {
    if (!navigator.serviceWorker?.controller) return;
    navigator.serviceWorker.controller.postMessage({
      type: 'prefetch-segments',
      segments: segments.slice(0, 5).map(f => ({ url: f.url, sn: f.sn })),
      proxyUrl: this.PROXY_URL,
      useProxy: this.useProxy
    });
  }

  startupLoad() {
    this.startupOverlay = document.getElementById('startupOverlay');
    this.startupProgressBar = document.getElementById('startupProgressBar');
    this.startupStats = document.getElementById('startupStats');
    this.startupSkipBtn = document.getElementById('startupSkipBtn');
    this.startupActive = true;
    this.startupTargetBuffer = 6; // 6 seconds of buffer before we reveal
    this.startupStartTime = Date.now();
    this.startupMaxTime = 8000; // 8 second hard timeout

    // Skip button
    this.startupSkipBtn.addEventListener('click', () => {
      this.dismissStartup();
    });

    // Auto-load 360p on startup
    const url360p = 'https://master2.hdtvs2.top/hls/3/stream.m3u8';
    document.getElementById('urlInput').value = url360p;
    this.load(url360p);

    // Monitor buffer progress during startup
    this.startupMonitor = setInterval(() => {
      if (!this.startupActive) return;
      
      const elapsed = Date.now() - this.startupStartTime;
      const buffered = this.video.buffered;
      let bufferedSec = 0;
      if (buffered.length > 0) {
        bufferedSec = buffered.end(buffered.length - 1) - this.video.currentTime;
      }

      const progress = Math.min(100, (bufferedSec / this.startupTargetBuffer) * 100);
      this.startupProgressBar.style.width = progress + '%';
      this.startupStats.textContent = 'buffer: ' + bufferedSec.toFixed(1) + 's / ' + this.startupTargetBuffer + 's';
      this.startupProgressBar.style.background = progress >= 100 ? '#4ade80' : '#e63946';

      // Dismiss conditions: buffer target met OR hard timeout
      if (bufferedSec >= this.startupTargetBuffer) {
        this.dismissStartup();
      } else if (elapsed >= this.startupMaxTime) {
        this.log('startup timeout — playing with partial buffer', 'warn');
        this.dismissStartup();
      }
    }, 200);
  }

  dismissStartup() {
    if (!this.startupActive) return;
    this.startupActive = false;
    
    if (this.startupMonitor) {
      clearInterval(this.startupMonitor);
      this.startupMonitor = null;
    }
    
    this.startupOverlay.classList.add('hidden');
    
    // Unmute video on user click dismiss/skip
    this.video.muted = false;
    
    // Force play
    this.video.play().catch(e => {
      this.log('autoplay blocked after startup: ' + e.message, 'warn');
      // Show play overlay button if browser still blocks it
      this.video.muted = true;
      this.video.play().catch(() => {});
    });
    
    this.setStatus('live', 'ok');
    this.hideLoading();
    
    this.log('startup complete — playing 360p', 'ok');
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
    
    // Dynamic target buffer: 360p only needs 3s start buffer, 480p+ needs 10s startup buffer
    const isLowRes = this.currentUrl.includes('/3/');
    const targetBuffer = isLowRes ? 3 : 10;
    
    const progress = Math.min(95, 30 + (bufferedSec / targetBuffer) * 65);
    
    if (bufferedSec < 0) {
      this.loadingText.textContent = 'rebuffering... (buffer empty)';
      this.updateLoadingProgress(30);
      this.setStatus('rebuffering', 'warn');
      return;
    }
    
    this.updateLoadingProgress(progress);
    this.loadingText.textContent = 'buffering... ' + bufferedSec.toFixed(1) + 's / ' + targetBuffer + 's';
    
    if (bufferedSec >= targetBuffer) {
      this.hideLoading();
      this.setStatus('live', 'ok');
      
      // Dynamic playback rate — slow down to let download catch up
      this.adjustPlaybackRate(bufferedSec);
      
      if (this.video.paused) {
        this.video.play().catch(e => {
          this.log('autoplay blocked: ' + e.message, 'warn');
        });
      }
    }
  }
  
  // Imperceptible playback rate adjustment to prevent buffer stalls
  adjustPlaybackRate(bufferedSec) {
    const v = this.video;
    if (!v || v.paused) return;
    
    if (bufferedSec < 3) {
      v.playbackRate = 0.92; // 8% slower — imperceptible but buys time
    } else if (bufferedSec < 6) {
      v.playbackRate = 0.95; // 5% slower
    } else if (bufferedSec < 10) {
      v.playbackRate = 0.98; // 2% slower
    } else {
      v.playbackRate = 1.0;  // normal — buffer is healthy
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

  // Prefetch helper using standard browser fetch (hits memory/disk cache)
  async prefetchSegment(url) {
    if (this.prefetchedUrls.has(url)) return;
    this.prefetchedUrls.add(url);

    // Limit cache history size
    if (this.prefetchedUrls.size > 20) {
      const firstVal = this.prefetchedUrls.values().next().value;
      this.prefetchedUrls.delete(firstVal);
    }

    try {
      let fetchUrl = url;
      if (this.useProxy && this.PROXY_URL) {
        fetchUrl = this.PROXY_URL + encodeURIComponent(url);
      }

      // Fetch silently with CORS + cache options
      await fetch(fetchUrl, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        headers: {
          'Accept': '*/*'
        }
      });
    } catch (e) {
      // ignore
    }
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
    this.prefetchedUrls.clear();
    
    this.setStatus('loading', 'loading');
    this.showLoading('connecting to stream...');
    this.log('connecting: ' + rawUrl, 'info');
    if (this.useProxy) this.log('via proxy: ' + this.PROXY_URL.split('?')[0], 'info');

    // Cleanup prior HLS instance
    this.cleanup();

    // DYNAMIC CONFIG BASED ON RESOLUTION:
    // If it's 360p (level 3), use low latency. 
    // If it's 480p (level 2) or higher, use a larger live sync buffer to build a bigger "grey bar" (buffered range)
    const isLowRes = rawUrl.includes('/3/');
    const liveSyncCount = isLowRes ? 3 : 7; // 3 segments for 360p (~6s latency), 7 segments for 480p+ (~14s buffer zone)
    const maxBufLength = isLowRes ? 15 : 45; // smaller target for 360p, larger for 480p+
    
    this.log('dynamic sync: ' + liveSyncCount + ' segments delay, max buffer ' + maxBufLength + 's', 'info');

    if (Hls.isSupported()) {
      this.hls = new Hls({
        enableWorker: false,
        debug: false,
        
        // Live stream config — dynamic based on quality to sustain the "grey bar"
        liveSyncDurationCount: liveSyncCount,
        liveMaxLatencyDurationCount: liveSyncCount * 3,
        maxLiveSyncPlaybackRate: isLowRes ? 1.0 : 0.95, // scale playback speed on high res
        
        // Buffer tuning
        maxBufferLength: maxBufLength,
        maxMaxBufferLength: maxBufLength * 2,
        backBufferLength: 0,
        
        // Gap handling
        maxBufferHole: 0.8,
        highBufferWatchdogPeriod: 2,
        nudgeMaxRetry: 15,
        
        // Network retry
        manifestLoadingTimeOut: 15000,
        manifestLoadingMaxRetry: 5,
        manifestLoadingRetryDelay: 1000,
        
        levelLoadingTimeOut: 15000,
        levelLoadingMaxRetry: 5,
        levelLoadingRetryDelay: 1000,
        
        fragLoadingTimeOut: 30000,
        fragLoadingMaxRetry: 8,
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
        
        this.video.play().catch(e => {
          this.log('autoplay blocked: ' + e.message, 'warn');
        });
      });

      // === LEVEL_LOADED (Initial Prefetch Burst) ===
      this.hls.on(Hls.Events.LEVEL_LOADED, (_, data) => {
        try {
          const frags = data.details?.fragments;
          if (!frags || frags.length === 0) return;

          // Prefetch first 5 via Service Worker
          this.prefetchViaSW(frags.slice(0, 5));
          // Also prefetch via direct fetch as fallback
          frags.slice(0, 5).forEach(f => {
            if (f.url) this.prefetchSegment(f.url);
          });
          this.log('pre-fetching 5 initial segments', 'debug');
        } catch (e) {}
      });

      // === FRAG_LOADED (Trigger Prefetch for next 4 segments via SW) ===
      this.hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
        try {
          const details = this.hls?.levels?.[this.hls.currentLevel]?.details;
          if (!details || !details.fragments) return;

          const frags = details.fragments;
          const currentSn = data.frag?.sn;
          if (typeof currentSn !== 'number') return;

          const nextFrags = [];
          for (let i = 1; i <= 4; i++) {
            const nextFrag = frags.find(f => f.sn === currentSn + i);
            if (nextFrag?.url) nextFrags.push(nextFrag);
          }

          // Send to SW for parallel prefetch
          this.prefetchViaSW(nextFrags);
          
          // Also direct fetch as fallback
          nextFrags.forEach(f => this.prefetchSegment(f.url));

          if (nextFrags.length > 0) {
            this.log('pre-fetched ' + nextFrags.length + ' segments ahead of seg ' + currentSn, 'debug');
          }
        } catch (e) {
          this.log('prefetch error: ' + e.message, 'debug');
        }
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

      this.video.addEventListener('playing', () => {
        this.log('playback resumed', 'ok');
        this.setStatus('live', 'ok');
        this.hideLoading();
        this.stallRecoveryAttempts = 0;
        
        // Reset playback rate when playing starts/resumes
        const buffered = this.video.buffered;
        if (buffered.length > 0) {
          const bufferedSec = buffered.end(buffered.length - 1) - this.video.currentTime;
          this.adjustPlaybackRate(bufferedSec);
        }
      });

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
