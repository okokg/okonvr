/**
 * OKO Embed Player — standalone WebRTC/MSE live stream viewer.
 * Zero dependencies. Works with go2rtc backend.
 *
 * Usage:
 *   <div id="cam"></div>
 *   <script src="oko-embed.js"></script>
 *   <script>
 *     OkoEmbed.create('#cam', {
 *       webrtcUrl: '/cam/gate/webrtc',
 *       wsUrl:     '/cam/gate/ws',
 *       snapshot:  '/cam/gate/snapshot',
 *     });
 *   </script>
 *
 * nginx mapping on external site:
 *   location /cam/gate/webrtc  { proxy_pass http://oko:8888/api/webrtc?src=M1; ... }
 *   location /cam/gate/ws      { proxy_pass http://oko:8888/api/ws?src=M1; ... }
 *   location /cam/gate/snapshot { proxy_pass http://oko:8888/backend/snapshot/M1; ... }
 */

(function(global) {
  'use strict';

  const STUN = [{ urls: 'stun:stun.l.google.com:19302' }];
  const ICE_TIMEOUT = 5000;
  const ICE_GATHER_TIMEOUT = 2000;
  const RETRY_BASE = 3000;
  const RETRY_MAX = 15000;
  const BUFFER_MAX = 10;
  const BUFFER_TRIM = 5;
  const DECODE_CHECK = 5000;

  class EmbedPlayer {
    constructor(container, opts) {
      this._opts = opts;
      this._retryCount = 0;
      this._retryTimer = null;
      this._decodeTimer = null;
      this._staleTimer = null;
      this._enabled = false;
      this._mode = null;     // 'webrtc' | 'mse'
      this._pc = null;
      this._ws = null;
      this._ms = null;
      this._sb = null;
      this._queue = [];

      // Build DOM
      const el = typeof container === 'string' ? document.querySelector(container) : container;
      if (!el) throw new Error('[oko-embed] Container not found: ' + container);
      el.style.position = 'relative';
      el.style.background = '#000';
      el.style.overflow = 'hidden';
      if (!el.style.aspectRatio) el.style.aspectRatio = '16/9';

      this._el = el;

      // Snapshot background
      if (opts.snapshot) {
        const img = document.createElement('img');
        img.src = opts.snapshot;
        img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:fill;z-index:0;transition:opacity 0.5s;';
        img.onerror = () => { img.style.display = 'none'; };
        el.appendChild(img);
        this._snap = img;
      }

      // Video
      const v = document.createElement('video');
      v.style.cssText = 'position:relative;width:100%;height:100%;object-fit:fill;z-index:1;background:transparent;';
      v.autoplay = true;
      v.muted = true;
      v.playsInline = true;
      el.appendChild(v);
      this._video = v;

      // Loading overlay
      const ov = document.createElement('div');
      ov.style.cssText = 'position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);transition:opacity 0.3s;';
      ov.innerHTML = '<div style="width:28px;height:28px;border:2px solid rgba(255,255,255,0.2);border-top-color:#ffa502;border-radius:50%;animation:oko-spin 1s linear infinite"></div>';
      el.appendChild(ov);
      this._overlay = ov;

      // Fullscreen button
      const fsBtn = document.createElement('div');
      fsBtn.style.cssText = 'position:absolute;bottom:8px;right:8px;z-index:3;width:28px;height:28px;cursor:pointer;opacity:0.6;transition:opacity 0.2s;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);border-radius:4px;';
      fsBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="white"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
      fsBtn.addEventListener('mouseenter', () => { fsBtn.style.opacity = '1'; });
      fsBtn.addEventListener('mouseleave', () => { fsBtn.style.opacity = '0.6'; });
      fsBtn.addEventListener('click', (e) => { e.stopPropagation(); this._toggleFullscreen(); });
      el.appendChild(fsBtn);
      this._fsBtn = fsBtn;

      // Spinner animation + fullscreen styles
      if (!document.getElementById('oko-embed-style')) {
        const style = document.createElement('style');
        style.id = 'oko-embed-style';
        style.textContent = '@keyframes oko-spin{to{transform:rotate(360deg)}}' +
          '.oko-embed-fs{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:999999!important;border-radius:0!important;aspect-ratio:auto!important;}';
        document.head.appendChild(style);
      }

      // Click to unmute
      v.addEventListener('click', () => { v.muted = !v.muted; });

      // Double-click to toggle fullscreen
      v.addEventListener('dblclick', (e) => { e.preventDefault(); this._toggleFullscreen(); });

      // ESC to exit fullscreen
      this._escHandler = (e) => {
        if (e.key === 'Escape' && this._isFs) this._exitFullscreen();
      };
      document.addEventListener('keydown', this._escHandler);

      // Auto-play on visibility
      v.addEventListener('playing', () => {
        this._hideOverlay();
        if (this._snap) this._snap.style.opacity = '0';
      });

      this._isFs = false;
      this.start();
    }

    start() {
      this._enabled = true;
      this._retryCount = 0;
      this._connectWebRTC();
    }

    /** Switch to a different camera stream without recreating the player. */
    switch(opts) {
      this.stop();
      if (opts.webrtcUrl) this._opts.webrtcUrl = opts.webrtcUrl;
      if (opts.wsUrl) this._opts.wsUrl = opts.wsUrl;
      if (opts.snapshot !== undefined) this._opts.snapshot = opts.snapshot;

      // Update snapshot
      if (this._snap && opts.snapshot) {
        this._snap.style.opacity = '1';
        this._snap.style.display = '';
        this._snap.src = opts.snapshot;
      }

      // Reset video
      this._video.srcObject = null;
      this._video.removeAttribute('src');
      this._video.load();

      this.start();
    }

    stop() {
      this._enabled = false;
      clearTimeout(this._retryTimer);
      clearTimeout(this._decodeTimer);
      clearTimeout(this._staleTimer);
      this._closePc();
      this._closeWs();
      this._closeMs();
    }

    destroy() {
      this.stop();
      if (this._escHandler) document.removeEventListener('keydown', this._escHandler);
      if (this._isFs) this._exitFullscreen();
      this._el.innerHTML = '';
    }

    // ── WebRTC ──

    async _connectWebRTC() {
      if (!this._enabled) return;
      this._closePc();
      this._closeWs();
      this._closeMs();
      this._mode = 'webrtc';
      this._showOverlay();

      try {
        const pc = new RTCPeerConnection({ iceServers: STUN });
        this._pc = pc;

        // Track handler BEFORE setRemoteDescription (race condition fix)
        const trackPromise = new Promise((resolve) => {
          pc.ontrack = (e) => {
            if (e.streams?.[0]) this._video.srcObject = e.streams[0];
            else { const ms = new MediaStream([e.track]); this._video.srcObject = ms; }
            this._video.play().catch(() => {});
            resolve();
          };
          setTimeout(() => resolve(), ICE_TIMEOUT);
        });

        // ICE state
        pc.oniceconnectionstatechange = () => {
          const s = pc.iceConnectionState;
          if (s === 'connected' || s === 'completed') {
            this._retryCount = 0;
          }
          if (s === 'disconnected') {
            // Grace period — ICE may recover
            setTimeout(() => {
              if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
                this._closePc();
                this._scheduleRetry();
              }
            }, 5000);
          }
          if (s === 'failed') {
            this._closePc();
            this._fallbackMSE();
          }
        };

        const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
        await pc.setLocalDescription(offer);
        await this._waitIceGather(pc);

        const url = this._resolve(this._opts.webrtcUrl);
        const res = await fetch(url, { method: 'POST', body: pc.localDescription.sdp });

        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          if (txt.includes('codecs not matched')) {
            this._closePc();
            this._fallbackMSE();
            return;
          }
          throw new Error(`WebRTC HTTP ${res.status}: ${txt.substring(0, 80)}`);
        }

        const answer = await res.text();
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answer }));
        await trackPromise;

        // Decode check — if no video after N seconds, fallback
        this._decodeTimer = setTimeout(() => {
          if (this._video.videoWidth === 0) {
            this._closePc();
            this._fallbackMSE();
          }
        }, DECODE_CHECK);

      } catch (e) {
        console.warn('[oko-embed] WebRTC error:', e.message);
        this._closePc();
        this._fallbackMSE();
      }
    }

    _fallbackMSE() {
      if (!this._enabled) return;
      if (typeof MediaSource === 'undefined') {
        this._scheduleRetry();
        return;
      }
      this._connectMSE();
    }

    // ── MSE ──

    _connectMSE() {
      if (!this._enabled) return;
      this._closePc();
      this._closeWs();
      this._closeMs();
      this._mode = 'mse';
      this._showOverlay();
      this._queue = [];

      try {
        const wsUrl = this._resolve(this._opts.wsUrl);
        const protocol = wsUrl.startsWith('http') ?
          wsUrl.replace(/^http/, 'ws') :
          (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + wsUrl;

        this._ws = new WebSocket(protocol);
        this._ws.binaryType = 'arraybuffer';

        this._ws.onopen = () => {
          if (!this._enabled) { this._closeWs(); return; }
          this._ws.send(JSON.stringify({ type: 'mse', value: '' }));
        };

        this._ws.onmessage = (e) => {
          if (!this._enabled) return;
          if (typeof e.data === 'string') {
            const msg = JSON.parse(e.data);
            if (msg.type === 'mse') this._initMs(msg.value);
          } else {
            this._appendBuf(new Uint8Array(e.data));
          }
        };

        this._ws.onerror = () => {};
        this._ws.onclose = () => {
          if (!this._enabled) return;
          this._scheduleRetry();
        };
      } catch (e) {
        console.warn('[oko-embed] MSE error:', e.message);
        this._scheduleRetry();
      }
    }

    _initMs(codec) {
      this._closeMs();
      const ms = new MediaSource();
      this._ms = ms;
      this._video.srcObject = null;
      this._video.src = URL.createObjectURL(ms);

      ms.addEventListener('sourceopen', () => {
        try {
          this._sb = ms.addSourceBuffer(codec);
          this._sb.mode = 'segments';
          this._sb.addEventListener('updateend', () => this._flushQueue());
          this._video.play().catch(() => {});
          this._retryCount = 0;
          // Stale detection
          this._resetStale();
        } catch (e) {
          console.warn('[oko-embed] SourceBuffer error:', e.message);
          this._closeMs();
          this._scheduleRetry();
        }
      }, { once: true });
    }

    _appendBuf(data) {
      this._resetStale();
      if (!this._sb) return;
      if (this._sb.updating || this._queue.length > 0) {
        this._queue.push(data);
        return;
      }
      try { this._sb.appendBuffer(data); }
      catch { this._queue.push(data); }
    }

    _flushQueue() {
      if (!this._sb || this._sb.updating) return;

      // Trim buffer
      try {
        const buf = this._video.buffered;
        if (buf.length > 0 && buf.end(buf.length - 1) - buf.start(0) > BUFFER_MAX) {
          this._sb.remove(buf.start(0), buf.end(buf.length - 1) - BUFFER_TRIM);
          return;
        }
      } catch {}

      if (this._queue.length > 0) {
        const chunk = this._queue.shift();
        try { this._sb.appendBuffer(chunk); }
        catch { /* skip corrupt chunk */ }
      }
    }

    _resetStale() {
      clearTimeout(this._staleTimer);
      this._staleTimer = setTimeout(() => {
        console.warn('[oko-embed] Stale stream, reconnecting');
        this._closeWs();
        this._closeMs();
        this._scheduleRetry();
      }, 30000);
    }

    // ── Retry ──

    _scheduleRetry() {
      if (!this._enabled) return;
      this._showOverlay();
      if (this._snap) { this._snap.style.opacity = '1'; }
      this._retryCount++;
      const delay = Math.min(RETRY_BASE * Math.pow(1.5, this._retryCount - 1), RETRY_MAX);
      this._retryTimer = setTimeout(() => {
        if (this._mode === 'mse') this._connectMSE();
        else this._connectWebRTC();
      }, delay);
    }

    // ── ICE gathering ──

    _waitIceGather(pc) {
      return new Promise(resolve => {
        if (pc.iceGatheringState === 'complete') { resolve(); return; }
        const timer = setTimeout(resolve, ICE_GATHER_TIMEOUT);
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
        });
      });
    }

    // ── Cleanup helpers ──

    _closePc() {
      clearTimeout(this._decodeTimer);
      if (this._pc) { try { this._pc.close(); } catch {} this._pc = null; }
    }

    _closeWs() {
      clearTimeout(this._staleTimer);
      if (this._ws) { try { this._ws.close(); } catch {} this._ws = null; }
    }

    _closeMs() {
      this._queue = [];
      this._sb = null;
      if (this._ms) {
        try { if (this._ms.readyState === 'open') this._ms.endOfStream(); } catch {}
        this._ms = null;
      }
    }

    _showOverlay() { if (this._overlay) this._overlay.style.opacity = '1'; }
    _hideOverlay() { if (this._overlay) this._overlay.style.opacity = '0'; }

    _toggleFullscreen() {
      if (this._isFs) this._exitFullscreen();
      else this._enterFullscreen();
    }

    _enterFullscreen() {
      // Try native fullscreen API first
      const el = this._el;
      if (el.requestFullscreen) {
        el.requestFullscreen().catch(() => this._cssFullscreen());
        this._setupFsListener();
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
        this._setupFsListener();
      } else {
        this._cssFullscreen();
      }
    }

    _cssFullscreen() {
      this._el.classList.add('oko-embed-fs');
      this._isFs = true;
      this._updateFsIcon();
    }

    _exitFullscreen() {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else {
        this._el.classList.remove('oko-embed-fs');
        this._isFs = false;
        this._updateFsIcon();
      }
    }

    _setupFsListener() {
      const handler = () => {
        this._isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
        if (!this._isFs) this._el.classList.remove('oko-embed-fs');
        this._updateFsIcon();
      };
      document.addEventListener('fullscreenchange', handler);
      document.addEventListener('webkitfullscreenchange', handler);
    }

    _updateFsIcon() {
      if (!this._fsBtn) return;
      this._fsBtn.innerHTML = this._isFs
        ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="white"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="16" height="16" fill="white"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
    }

    _resolve(url) {
      if (url.startsWith('http') || url.startsWith('ws')) return url;
      return location.origin + url;
    }
  }

  // ── Public API ──
  global.OkoEmbed = {
    create(container, opts) {
      return new EmbedPlayer(container, opts);
    },
    version: '1.0.0',
  };

})(window);
