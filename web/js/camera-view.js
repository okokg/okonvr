/**
 * CameraView — manages the DOM element and UI state for a single camera.
 *
 * Responsibilities:
 * - Render the camera tile (video, overlays, badges)
 * - Wire up CamPlayer events to DOM updates
 * - Track online/offline timeline
 * - Expose drag-and-drop data
 */

import { CamPlayer } from './player.js';

(window._oko = window._oko || {}).cameraView = 'v6a0';

export class CameraView {
  /**
   * @param {object} config - { id, label, group, sort_order, has_audio }
   */
  constructor(config) {
    this.id = config.id;
    this.label = config.label || '';
    this.group = config.group || '';
    this.codec = config.codec || null;
    this.hasAudio = !!config.has_audio;
    this.timeline = [];

    this.el = this._createElement();
    this.video = this.el.querySelector('video');
    this.player = new CamPlayer(this.video, this.id);

    /** The CamPlayer currently owning video.src. Only _switchPlayer changes this. */
    this._activePlayer = null;

    // cache DOM refs
    this._statusDot = this.el.querySelector('.cam-status');
    this._loading = this.el.querySelector('.cam-loading');
    this._loadingText = this.el.querySelector('.cam-loading-text');
    this._audioIcon = this.el.querySelector('.cam-audio-wrap');
    this._modeBadge = this.el.querySelector('.cam-mode');
    this._bitrateEl = this.el.querySelector('.cam-bitrate');
    this._timelineCanvas = this.el.querySelector('.cam-timeline canvas');
    this._qualityToggle = this.el.querySelector('.cam-quality-toggle');
    this._infoTooltip = this.el.querySelector('.cam-info-tooltip');
    this._snapshot = this.el.querySelector('.cam-snapshot');

    // Snapshot preload logging
    if (this._snapshot) {
      this._snapshot.onload = () => {
        console.log(`[snapshot] ${this.id}: loaded (${this._snapshot.naturalWidth}×${this._snapshot.naturalHeight})`);
      };
      this._snapshot.onerror = () => {
        console.warn(`[snapshot] ${this.id}: failed to load`);
        this._snapshot.style.display = 'none';
      };
    } else {
      console.log(`[snapshot] ${this.id}: disabled (snapshots_enabled=${window.__okoConfig?.snapshots_enabled})`);
    }

    // HD state
    this._hdPlayer = null;
    this._hdStream = null;

    // Digital zoom state
    this._zoom = { scale: 1, tx: 0, ty: 0 };
    this._zoomDragging = false;

    // Set audio availability from backend
    if (this.hasAudio) {
      this._audioIcon.classList.add('has-audio');
    }

    this._bindPlayerEvents();
    this._bindDOMEvents();
    this._bindZoomEvents();
  }

  // ── Public ──

  /** Start streaming. Transcode is triggered reactively if codec mismatch detected. */
  start() {
    // Already running with SD player — don't restart (kills MSE connection)
    if (this._activePlayer === this.player && this.player.enabled) {
      return;
    }
    // Don't interrupt active playback or HD
    if (this._activePlayer && this._activePlayer !== this.player && this._activePlayer.enabled) {
      return;
    }
    this._switchPlayer(this.player);
    if (!this.isPlayback) this._startGhudLive();
  }

  /** Stop ALL streaming (SD + HD + playback) and mark disabled. */
  disable() {
    clearInterval(this._nowMarkerTimer);
    if (this._hdPlayer) {
      this._hdPlayer.disable();
      this._hdPlayer = null;
      this._hdStream = null;
    }
    if (this._playbackPlayer) {
      this._playbackPlayer.disable();
      this._playbackPlayer = null;
    }
    this._switchPlayer(null); // disables active player + resets video
    this._stopRenderCheck();
  }

  // ── Video ownership ──

  /**
   * Atomic player switch — the ONLY place that manages video ownership.
   *
   * Does NOT call video.load() when switching between players. Each player's
   * connect method sets its own source (video.src for MSE, video.srcObject
   * for WebRTC), which implicitly triggers the load algorithm. Explicit
   * load() on an empty element puts it in NETWORK_EMPTY → Chrome doesn't
   * repaint when srcObject is set later → black screen with decoded frames.
   *
   * @param {CamPlayer|null} newPlayer - player to activate, or null to stop all
   * @param {'start'|'mse'} [method='start'] - how to start the new player
   */
  _switchPlayer(newPlayer, method = 'start') {
    const old = this._activePlayer;
    if (old && old !== newPlayer) {
      old.disable();
    }

    // Full reset of video element: clear both source types + load() to reset decoder
    // removeAttribute('src') + load() resets to HAVE_NOTHING state cleanly
    // (Note: video.src='' + load() is DIFFERENT — empty string = relative URL = error)
    this.video.pause();
    this.video.srcObject = null;
    this.video.removeAttribute('src');
    this.video.load(); // reset H.265 hardware decoder pipeline
    this._activePlayer = newPlayer;

    if (newPlayer) {
      if (method === 'mse') newPlayer.startMSE();
      else newPlayer.start();
    }
  }

  /** @returns {boolean} Whether the camera is currently connected. */
  get isConnected() {
    const p = this._activePlayer || this.player;
    return p.connected;
  }

  /** @returns {boolean} Whether the player is enabled (SD, HD, or playback). */
  get isEnabled() {
    const p = this._activePlayer || this.player;
    return p.enabled;
  }

  /** Show/hide the camera tile. */
  setVisible(visible) {
    this.el.classList.toggle('hidden', !visible);
  }

  /** Clear time lock button state. */
  /** @returns {boolean} Whether camera is selected for investigation. */
  get isSelected() { return this.el.classList.contains('cam-selected'); }

  /** Toggle selection state. */
  toggleSelect() {
    const selected = this.el.classList.toggle('cam-selected');
    if (this.onSelect) this.onSelect(this, selected);
  }

  /** Set selection state. */
  setSelected(val) {
    this.el.classList.toggle('cam-selected', val);
  }

  /** Toggle video pause. Live = freeze frame. Archive = real pause (stream destroyed). */
  togglePause() {
    const v = this.video;
    if (!v) return;
    const isPaused = this.el.classList.contains('paused');

    if (isPaused) {
      // Resume
      this.el.classList.remove('paused');
      this._showPauseIndicator('play');
      if (this._pausedPosition && this.onPlaybackResume) {
        const resumeTime = new Date(this._pausedPosition.getTime() - 1000);
        this.onPlaybackResume(this, resumeTime);
        this._pausedPosition = null;
      } else {
        this._clearFreezeFrame();
        v.play();
      }
    } else {
      // Pause
      this.el.classList.add('paused');
      this._showPauseIndicator('pause');
      if (this.isPlayback) {
        this._captureFrame();       // capture BEFORE pause — video definitely has decoded frame
        v.pause();
        this.stopPlaybackTimer();
        const position = this.playbackPosition;
        const hasFreezeFrame = this.el.querySelector('.cam-freeze')?.classList.contains('visible');
        if (hasFreezeFrame) {
          this._pausedPosition = position;
          if (this.onPlaybackPause) this.onPlaybackPause(this);
        }
      } else {
        this._captureFrame();       // freeze-frame for live pause too
        v.pause();
      }
    }
    // Refresh info tooltip to show/hide PAUSED
    const p = this._activePlayer || this.player;
    if (p) this._updateInfoTooltip(p, p.bitrate || 0);
  }

  /** Capture current video frame to overlay img (reliable across all browsers). */
  _captureFrame() {
    const v = this.video;
    const img = this.el.querySelector('.cam-freeze');
    if (!v || !v.videoWidth || !img) return false;
    try {
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(v, 0, 0);

      // Detect black frame: H.265 hardware decoder can't be captured to canvas.
      // Sample 8 pixels across the frame — real video always has some noise/variation.
      const w = c.width, h = c.height;
      const points = [[w*.25,h*.25],[w*.5,h*.25],[w*.75,h*.25],[w*.5,h*.5],
                       [w*.25,h*.75],[w*.5,h*.75],[w*.75,h*.75],[w*.1,h*.1]];
      let allBlack = true;
      for (const [x, y] of points) {
        const d = ctx.getImageData(x|0, y|0, 1, 1).data;
        if (d[0] > 0 || d[1] > 0 || d[2] > 0) { allBlack = false; break; }
      }
      if (allBlack) return false; // hardware decode → let paused <video> show last frame

      img.src = c.toDataURL('image/jpeg', 0.85);
      img.classList.add('visible');
      img.style.transform = v.style.transform;
      img.style.transformOrigin = v.style.transformOrigin;
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Capture frame with retry — videoWidth can be 0 briefly after v.pause(). */
  _captureFrameWithRetry(onSuccess, attempt = 0) {
    if (this._captureFrame()) {
      if (onSuccess) onSuccess();
      return Promise.resolve(true);
    }
    if (attempt < 5) {
      return new Promise(resolve => {
        setTimeout(() => {
          this._captureFrameWithRetry(onSuccess, attempt + 1).then(resolve);
        }, 50);
      });
    }
    // All retries failed — still fire callback so stream gets destroyed
    console.log(`[camera-view] ${this.id}: freeze-frame capture failed after ${attempt} retries`);
    if (onSuccess) onSuccess();
    return Promise.resolve(false);
  }

  /** Hide freeze-frame overlay. */
  _clearFreezeFrame() {
    const img = this.el.querySelector('.cam-freeze');
    if (img) {
      img.classList.remove('visible');
      img.src = '';
    }
  }

  /** @type {Date|null} Position saved when archive was paused. */
  _pausedPosition = null;

  _showPauseIndicator(state) {
    const ind = this.el.querySelector('.cam-pause-indicator');
    if (!ind) return;
    // Update icon
    ind.innerHTML = state === 'pause'
      ? '<svg viewBox="0 0 24 24" width="32" height="32" fill="white"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="32" height="32" fill="white"><path d="M8 5v14l11-7z"/></svg>';
    ind.classList.add('visible');
    clearTimeout(this._pauseIndicatorTimer);
    if (state === 'play') {
      this._pauseIndicatorTimer = setTimeout(() => ind.classList.remove('visible'), 800);
    }
    // else pause: keep visible until resume
  }

  /** Enter in-page fullscreen mode. */
  enterFullscreen() {
    this.el.classList.add('fullscreen');
    if (!CameraView.globalMute) {
      this._tryUnmute();
    }
    // Show info tooltip immediately
    const p = this._activePlayer || this.player;
    if (p) this._updateInfoTooltip(p, p.bitrate || 0);

    // Populate fullscreen HUD info row
    const fsName = this.el.querySelector('.seek-info-name');
    if (fsName) fsName.textContent = this.id;

    if (!this.isPlayback) {
      // LIVE mode: green accent, update time
      this.el.classList.add('fs-live');
      this._seekCursorFraction = undefined;
      const recDot = this.el.querySelector('.seek-info-rec-dot');
      const recText = this.el.querySelector('.seek-info-rec-text');
      if (recText) recText.textContent = 'LIVE';
      this._updateFsLiveTime();
      this._fsLiveTimer = setInterval(() => this._updateFsLiveTime(), 1000);
    } else {
      this.el.classList.remove('fs-live');
    }

    // Restore playback panel if it was open before
    if (this._panelWasOpen) {
      const panel = this.el.querySelector('.cam-playback-panel');
      if (panel) panel.classList.add('open');
      this._panelWasOpen = false;
    }

    // Restore per-camera zoom if previously zoomed
    if (this._zoom.scale > 1) {
      this._clampPan();
      this._applyZoom();
    }

    // Restore pause indicator if camera was paused
    if (this.el.classList.contains('paused')) {
      this._showPauseIndicator('pause');
    }
  }

  /** Update LIVE time in fullscreen HUD + seek bar position. */
  _updateFsLiveTime() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const fsTime = this.el.querySelector('.seek-info-time');
    const fsDate = this.el.querySelector('.seek-info-date-full');
    if (fsTime) fsTime.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    if (fsDate) fsDate.textContent = `${pad(now.getDate())}.${pad(now.getMonth()+1)}.${now.getFullYear()}`;

    // Update seek bar to show day progress
    const seconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const fraction = seconds / 86400;
    const fill = this.el.querySelector('.seek-fill');
    const cursor = this.el.querySelector('.seek-cursor');
    if (fill) fill.style.width = `${fraction * 100}%`;
    if (cursor) cursor.style.left = `${fraction * 100}%`;
  }

  /** Start LIVE grid HUD — update bar + time every second. */
  _startGhudLive() {
    this._stopGhudLive();
    // Set initial labels
    const recLabel = this.el.querySelector('.ghud-rec-label');
    if (recLabel) recLabel.textContent = 'LIVE';
    this._updateGhudLive();
    this._ghudLiveTimer = setInterval(() => this._updateGhudLive(), 1000);
  }

  /** Stop LIVE grid HUD timer. */
  _stopGhudLive() {
    clearInterval(this._ghudLiveTimer);
    this._ghudLiveTimer = null;
  }

  /** Update LIVE grid HUD bar position + time. */
  _updateGhudLive() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const seconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const fraction = seconds / 86400;
    const fill = this.el.querySelector('.ghud-fill');
    const cursor = this.el.querySelector('.ghud-cursor');
    const time = this.el.querySelector('.ghud-time');
    if (fill) fill.style.width = `${fraction * 100}%`;
    if (cursor) cursor.style.left = `${fraction * 100}%`;
    if (time) time.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  /** Exit in-page fullscreen mode. */
  exitFullscreen({ keepZoom = false } = {}) {
    this.el.classList.remove('fullscreen');
    this.el.classList.remove('fs-live');
    clearInterval(this._fsLiveTimer);
    // Save and close playback panel
    const panel = this.el.querySelector('.cam-playback-panel');
    this._panelWasOpen = panel && panel.classList.contains('open');
    if (panel) panel.classList.remove('open');
    const pbBtn = this.el.querySelector('.cam-playback-btn');
    if (pbBtn) pbBtn.classList.remove('active');

    // Pause: always preserve state. Resume only via explicit togglePause.
    // Just hide the indicator (enterFullscreen will restore it).
    const ind = this.el.querySelector('.cam-pause-indicator');
    if (ind) ind.classList.remove('visible');

    this.video.muted = true;
    this._audioIcon.classList.remove('unmuted');
    this._infoTooltip.classList.remove('visible');
    if (keepZoom) {
      // Hide zoom visuals but preserve _zoom state for later
      this.video.style.transform = '';
      this.video.style.transformOrigin = '';
      const freeze = this.el.querySelector('.cam-freeze');
      if (freeze) { freeze.style.transform = ''; freeze.style.transformOrigin = ''; }
      this.el.classList.remove('cam-zoomed');
      clearInterval(this._minimapTimer);
      this._minimapTimer = null;
      const mm = this.el.querySelector('.cam-minimap');
      if (mm) mm.classList.remove('visible');
    } else {
      this._resetZoom();
    }
  }

  /** @returns {boolean} */
  get isFullscreen() {
    return this.el.classList.contains('fullscreen');
  }

  /** Enter native browser fullscreen. */
  enterNativeFullscreen() {
    this.el.requestFullscreen().catch(() => {});
  }

  /** Start HD (main-stream) player. */
  startHd(streamName, forceMSE = false) {
    if (this._hdPlayer) {
      this._hdPlayer.disable();
      this._hdPlayer = null;
    }

    this._hdStream = streamName;
    this._showLoading('switching to hd');

    this._hdPlayer = new CamPlayer(this.video, streamName, { preferH265: forceMSE });
    this._hdPlayer.onStatusChange = (online) => {
      this._statusDot.classList.toggle('live', online);
    };
    this._hdPlayer.onModeChange = (mode) => {
      this._modeBadge.textContent = `${mode.toUpperCase()} ●LIVE HD`;
      this._modeBadge.className = `cam-mode ${mode}`;
    };
    this._hdPlayer.onStage = (stage) => {
      if (stage === 'playing') {
        this._hideLoading();
      } else {
        this._showLoading(stage);
      }
    };

    const useMSE = forceMSE && !CamPlayer.h265WebRTCSupported;
    this._switchPlayer(this._hdPlayer, useMSE ? 'mse' : 'start');

    // Update toggle state
    this._qualityToggle.querySelector('.quality-sd').classList.remove('active');
    this._qualityToggle.querySelector('.quality-hd').classList.add('active');
    this._qualityToggle.classList.add('hd-active');
  }

  /** Stop HD and return to SD (sub-stream). */
  stopHd() {
    if (this._hdPlayer) {
      this._hdPlayer.disable();
      this._hdPlayer = null;
    }
    this._hdStream = null;

    this._showLoading('switching to sd');
    this._switchPlayer(this.player);

    // Update toggle state
    this._qualityToggle.querySelector('.quality-hd').classList.remove('active');
    this._qualityToggle.querySelector('.quality-sd').classList.add('active');
    this._qualityToggle.classList.remove('hd-active');
  }

  /** Whether currently in HD mode. */
  get isHd() { return !!this._hdStream; }

  /** Toggle playback panel open/closed. */
  togglePlaybackPanel() {
    this.el.querySelector('.cam-playback-btn').click();
  }

  /** Switch live stream to a different go2rtc stream (e.g. transcoded). */
  switchToStream(newStreamName) {
    this._transcodeStream = newStreamName;
    this.player = new CamPlayer(this.video, newStreamName);
    this._bindPlayerEvents();
    this._switchPlayer(this.player);
  }

  /** Show loading spinner with status text. */
  _showLoading(text) {
    this._loadingText.textContent = text;
    this._loading.style.display = 'flex';

    // Show snapshot overlay while reconnecting — but NOT during archive playback
    // (snapshot is a live frame; showing it during archive seek is confusing)
    if (this._snapshot && this._snapshot.classList.contains('loaded') && !this.isPlayback) {
      this._snapshot.classList.remove('loaded');
      this._snapshot.style.display = '';
      this._snapshot.src = `/backend/snapshot/${this.id}?t=${Date.now()}`;
      console.log(`[snapshot] ${this.id}: re-showing (stream reconnecting)`);
    }

    // Set loading stage dots: 1=connecting, 2=negotiating/buffering, 3=decoding
    const dots = this._loading.querySelector('.cam-loading-dots');
    if (dots) {
      const t = (text || '').toLowerCase();
      let stage = 1;
      if (t.includes('buffer') || t.includes('keyframe') || t.includes('waiting')) stage = 2;
      if (t.includes('codec') && !t.includes('fallback')) stage = 2;
      if (t.includes('playing')) stage = 3;
      const spans = dots.querySelectorAll('span');
      spans.forEach((s, i) => s.classList.toggle('active', i < stage));
    }

    // Poll for video render: check BOTH sd player and playback player
    const activePlayer = this._activePlayer || this.player;
    if (activePlayer.enabled) this._startRenderCheck();
  }

  /** Hide loading spinner. */
  _hideLoading() {
    this._loading.style.display = 'none';
    this._stopRenderCheck();
    this._clearFreezeFrame();
    // Fade out snapshot overlay once real video is playing
    if (this._snapshot && !this._snapshot.classList.contains('loaded')) {
      this._snapshot.classList.add('loaded');
      console.log(`[snapshot] ${this.id}: fading out (video playing)`);
    }
    // Restore audio if in fullscreen — WebRTC ontrack always sets muted=true for autoplay policy.
    if (this.el.classList.contains('fullscreen') && !CameraView.globalMute && !this._awaitingUserPlay) {
      this._tryUnmute();
    }
  }

  /**
   * Pause video and show play overlay — waits for user click to unmute + play.
   * Used for deep links where there's no prior user interaction (autoplay policy).
   */
  awaitUserPlay() {
    this._awaitingUserPlay = true;
    // Wait for video to actually have data, then pause
    const waitAndPause = () => {
      if (!this._awaitingUserPlay) return;
      if (this.video.readyState >= 2) { // HAVE_CURRENT_DATA
        this.video.pause();
        this._showPauseIndicator('pause');
      } else {
        setTimeout(waitAndPause, 200);
      }
    };
    setTimeout(waitAndPause, 500);

    // One-time click on the camera element → unmute + play
    // Must use capture + stopImmediatePropagation because fullscreen toggle
    // is also on this.el — stopPropagation alone doesn't block sibling handlers
    const handler = (e) => {
      e.stopImmediatePropagation();
      e.preventDefault();
      if (!this._awaitingUserPlay) return;
      this._awaitingUserPlay = false;
      this.video.muted = false;
      this.video.play().catch(() => {});
      this._audioIcon.classList.toggle('unmuted', this._audioIcon.classList.contains('has-audio'));
      this._showPauseIndicator('play');
    };
    this.el.addEventListener('click', handler, { once: true, capture: true });
  }

  /** Try to unmute; if autoplay policy blocks it, defer to first user click. */
  _tryUnmute() {
    const hasAudio = this._audioIcon.classList.contains('has-audio');
    if (!hasAudio) return;

    this.video.muted = false;
    const p = this.video.play();
    if (p && p.catch) {
      p.catch(() => {
        // Autoplay policy: no user interaction yet — stay muted, unmute on first click
        this.video.muted = true;
        this._audioIcon.classList.remove('unmuted');
        const unlock = () => {
          document.removeEventListener('click', unlock, { capture: true });
          document.removeEventListener('keydown', unlock, { capture: true });
          if (this.el.classList.contains('fullscreen') && !CameraView.globalMute) {
            this.video.muted = false;
            this.video.play().catch(() => {});
            this._audioIcon.classList.add('unmuted');
          }
        };
        document.addEventListener('click', unlock, { capture: true, once: true });
        document.addEventListener('keydown', unlock, { capture: true, once: true });
      });
    }
    this._audioIcon.classList.toggle('unmuted', !this.video.muted);
  }

  /** Poll until video actually has frames, then hide loading. */
  _startRenderCheck() {
    this._stopRenderCheck();
    this._renderCheckTimer = setInterval(() => {
      if (this.video.videoWidth > 0 && this.video.videoHeight > 0) {
        const hasFreezeFrame = this.el.querySelector('.cam-freeze')?.classList.contains('visible');
        if (hasFreezeFrame) {
          // Resuming from pause: videoWidth>0 means decoder has rendered a frame.
          // Short delay for paint, then reveal.
          clearInterval(this._renderCheckTimer);
          this._renderCheckTimer = null;
          this._loading.style.display = 'none';
          this._renderBufferTimer = setTimeout(() => {
            this._clearFreezeFrame();
          }, 150);
        } else {
          this._hideLoading();
        }
      }
    }, 200);
  }

  _stopRenderCheck() {
    if (this._renderCheckTimer) {
      clearInterval(this._renderCheckTimer);
      this._renderCheckTimer = null;
    }
    if (this._renderBufferTimer) {
      clearTimeout(this._renderBufferTimer);
      this._renderBufferTimer = null;
    }
  }

  /** Update bitrate display. Call periodically. */
  async updateBitrate() {
    // Use whichever player is active
    const p = this._activePlayer || this.player;
    await p.updateBitrate();
    const kbps = p.bitrate || 0;

    // Grid mode: top-left bitrate number
    this._bitrateEl.textContent = kbps > 0 ? `${kbps} kbps` : '';

    // Update info tooltip (shown on hover in grid, always in fullscreen)
    this._updateInfoTooltip(p, kbps);

    return kbps;
  }

  /** Refresh the info tooltip with current stats. */
  _updateInfoTooltip(player, kbps) {
    if (!player) return;
    const p = player;
    const full = this.el.classList.contains('fullscreen');
    const parts = full ? [] : [];

    if (!full) {
      // Grid: compact format
      if (p.mode) parts.push(p.mode.toUpperCase().replace('WEBRTC', 'WR'));
      if (kbps > 0) parts.push(`${kbps} kbps`);
      const v = this.video;
      if (v.videoWidth) parts.push(`${v.videoWidth}p`);
      if (this.codec) parts.push(this.codec === 'hevc' ? 'H265' : 'H264');
      if (this.el.classList.contains('paused')) parts.push('PAUSED');
      this._infoTooltip.textContent = parts.join('·');
    } else {
      // Fullscreen: verbose format into inline element
      if (p.mode) parts.push(p.mode.toUpperCase());
      if (kbps > 0) parts.push(`${kbps} kbps`);
      const v = this.video;
      if (v.videoWidth) parts.push(`${v.videoWidth}×${v.videoHeight}`);
      if (this.codec) parts.push(this.codec === 'hevc' ? 'H.265' : 'H.264');
      if (this._zoom.scale > 1) parts.push(`${this._zoom.scale.toFixed(1)}×`);
      if (this.el.classList.contains('paused')) parts.push('PAUSED');
      const text = parts.join(' · ');
      this._infoTooltip.textContent = text;
      const infoInline = this.el.querySelector('.cam-info-inline');
      if (infoInline) infoInline.textContent = text;
    }

    // In fullscreen, always visible
    if (full) {
      this._infoTooltip.classList.add('visible');
    }
  }

  /** Render the online/offline timeline bar. */
  renderTimeline() {
    const canvas = this._timelineCanvas;
    const ctx = canvas.getContext('2d');
    const w = canvas.width = canvas.offsetWidth * 2;
    const h = canvas.height = 6;
    ctx.clearRect(0, 0, w, h);

    const now = Date.now();
    const windowStart = now - 24 * 3600 * 1000;
    const events = this.timeline.filter(e => e.time >= windowStart);

    if (events.length === 0) {
      ctx.fillStyle = this.player.connected ? '#00d4aa44' : '#ff475744';
      ctx.fillRect(0, 0, w, h);
      return;
    }

    let lastX = 0;
    let lastOnline = events[0].online;

    for (const event of events) {
      const x = Math.round(((event.time - windowStart) / (now - windowStart)) * w);
      ctx.fillStyle = lastOnline ? '#00d4aa66' : '#ff475766';
      ctx.fillRect(lastX, 0, x - lastX, h);
      lastX = x;
      lastOnline = event.online;
    }

    ctx.fillStyle = lastOnline ? '#00d4aa66' : '#ff475766';
    ctx.fillRect(lastX, 0, w - lastX, h);
  }

  /** Sync MSE buffer to prevent lag buildup. */
  /** Sync MSE buffer — prevent live drift. Called periodically. */
  syncBuffer() {
    const p = this._activePlayer || this.player;
    // Only sync for MSE live streams, not playback (archive)
    if (p.mode !== 'mse' || this.isPlayback) return;

    const v = this.video;
    if (!v.buffered.length) return;

    const end = v.buffered.end(v.buffered.length - 1);
    const lag = end - v.currentTime;

    if (lag > 5) {
      // Way behind — hard seek
      v.currentTime = end - 0.3;
      v.playbackRate = 1.0;
    } else if (lag > 1.5) {
      // Drifting — speed up to catch up smoothly
      v.playbackRate = 1.05;
    } else if (lag < 0.5 && v.playbackRate !== 1.0) {
      // Caught up — normal speed
      v.playbackRate = 1.0;
    }
  }

  // ── Callbacks (set by CameraGrid) ──

  /** @type {(camera: CameraView) => void} */
  onClick = null;

  /** @type {(camera: CameraView) => void} */
  onDoubleClick = null;

  /** @type {(camera: CameraView, online: boolean) => void} */
  onStatusChange = null;

  /** @type {(fromId: string, toCamera: CameraView) => void} */
  onDrop = null;

  /**
   * Called when user requests playback.
   * @type {(camera: CameraView, start: string, end: string, resolution: string) => void}
   */
  onPlaybackRequest = null;

  /**
   * Called when user returns to live.
   * @type {(camera: CameraView) => void}
   */
  onLiveRequest = null;

  /**
   * Called when user seeks to a new time on the timeline.
   * @type {(camera: CameraView, seekTime: Date) => void}
   */
  onPlaybackSeek = null;

  /**
   * Called when camera needs H.265→H.264 transcode (client has no H.265).
   * @type {(camera: CameraView) => void}
   */
  onNeedTranscode = null;

  /**
   * Called when user quick-seeks by offset.
   * @type {(camera: CameraView, seekTime: Date) => void}
   */
  onQuickSeek = null;

  /**
   * Called when NVR connection error detected (dial tcp, i/o timeout, etc).
   * @type {(camera: CameraView) => void}
   */
  onConnectionError = null;

  /**
   * Called when go2rtc lost stream definition (needs recovery).
   * @type {(camera: CameraView) => void}
   */
  onStreamNotFound = null;

  /**
   * Called when archive playback is paused (stream should be destroyed).
   * @type {(camera: CameraView) => void}
   */
  onPlaybackPause = null;

  /**
   * Called when archive playback should resume from saved position.
   * @type {(camera: CameraView, position: Date) => void}
   */
  onPlaybackResume = null;

  /**
   * Called when camera is selected/deselected for investigation.
   * @type {(camera: CameraView, selected: boolean) => void}
   */
  onSelect = null;

  // ── Playback ──

  _playbackStream = null;
  _playbackPlayer = null;
  _playbackDate = null;    // Date object for the playback day (midnight)
  _playbackStart = null;   // Date when playback stream started
  _playbackOffset = 0;     // seconds from midnight that playback starts
  _positionTimer = null;

  /**
   * Switch to playback mode.
   * @param {string} streamName - go2rtc stream name
   * @param {Date} startTime - playback start time
   * @param {Date} endTime - playback end time
   * @param {boolean} forceMSE - force MSE instead of WebRTC (for HEVC)
   * @param {string} resolution - current resolution setting
   */
  startPlayback(streamName, startTime, endTime, forceMSE = false, resolution = 'original') {
    this.stopPlaybackTimer();
    this._clearPendingChange();
    // NOTE: freeze frame preserved here — cleared in _hideLoading when real frames arrive

    // Clean up previous playback player
    if (this._playbackPlayer) {
      this._playbackPlayer.disable();
      this._playbackPlayer = null;
    }
    // Clean up HD if active
    if (this._hdPlayer) {
      this._hdPlayer.disable();
      this._hdPlayer = null;
      this._hdStream = null;
    }

    this._playbackStream = streamName;
    this._playbackResolution = resolution;

    // track position
    this._playbackDate = new Date(startTime);
    this._playbackDate.setHours(0, 0, 0, 0); // midnight of that day
    this._playbackOffset = (startTime - this._playbackDate) / 1000;
    this._playbackStart = new Date();
    this._updateDateLabel();

    this._showLoading('loading archive');
    this._playbackPlayer = new CamPlayer(this.video, streamName, { preferH265: forceMSE });
    this._playbackPlayer.onStatusChange = (online) => {
      this._statusDot.classList.toggle('live', online);
    };
    this._playbackPlayer.onModeChange = (mode) => {
      this._modeBadge.className = 'cam-mode playback';
      this._updatePlaybackBadge(mode);
    };
    this._playbackPlayer.onStage = (stage) => {
      if (stage === 'playing') {
        this._hideLoading();
      } else {
        this._showLoading(stage);
      }
    };

    // HEVC streams: use MSE when browser lacks H.265 WebRTC support.
    // CamPlayer.globalForceMSE (config) is handled inside start() for all streams.
    const useMSE = forceMSE && !CamPlayer.h265WebRTCSupported;

    // Atomic switch: stops old player, starts playback
    this._switchPlayer(this._playbackPlayer, useMSE ? 'mse' : 'start');

    this.el.classList.add('playback-mode');

    // Stop LIVE grid timer, switch to archive labels
    this._stopGhudLive();
    const ghudRecLabel = this.el.querySelector('.ghud-rec-label');
    if (ghudRecLabel) ghudRecLabel.textContent = 'REC';

    // Switch fullscreen HUD from LIVE to ARCHIVE mode
    this.el.classList.remove('fs-live');
    clearInterval(this._fsLiveTimer);
    const fsName = this.el.querySelector('.seek-info-name');
    if (fsName) fsName.textContent = this.id;
    const fsRecText = this.el.querySelector('.seek-info-rec-text');
    if (fsRecText) fsRecText.textContent = 'REC';

    // Real-time now marker update (moves the "now" line on today's timeline)
    clearInterval(this._nowMarkerTimer);
    this._nowMarkerTimer = setInterval(() => this._updateSeekAvailability(), 30000);

    // Show resolution instead of SD/HD toggle
    this._qualityToggle.dataset.mode = 'playback';
    this._qualityToggle.innerHTML = `<span class="quality-res">${resolution === 'original' ? 'Original' : resolution}</span>`;

    // Update button states: Play=active(green "Stop"), Live=hint(pulsing "go live")
    const goBtn = this.el.querySelector('.playback-go');
    const liveBtn = this.el.querySelector('.playback-live');
    goBtn.innerHTML = '&#9632; Stop';
    goBtn.classList.add('active');
    liveBtn.classList.remove('active');
    liveBtn.classList.add('return-hint');
    liveBtn.innerHTML = '&#9654; Live';

    // restore resolution dropdown and datetime picker to current values
    const select = this.el.querySelector('.playback-resolution');
    if (select) select.value = resolution;

    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const startInput = this.el.querySelector('.playback-start');
    const endInput = this.el.querySelector('.playback-end');
    if (startInput) startInput.value = fmt(startTime);
    if (endInput) endInput.value = fmt(endTime);

    // show seek timeline and start updating position
    this.el.querySelector('.cam-seek-timeline').classList.add('active');
    this._startPositionTimer();
  }

  /** Switch back to live. */
  stopPlayback() {
    this._awaitingUserPlay = false;
    this.stopPlaybackTimer();
    clearInterval(this._nowMarkerTimer);
    this._clearFreezeFrame();
    this._pausedPosition = null;
    this.el.classList.remove('paused');
    const ind = this.el.querySelector('.cam-pause-indicator');
    if (ind) ind.classList.remove('visible');
    if (this._playbackPlayer) {
      this._playbackPlayer.disable();
      this._playbackPlayer = null;
    }
    this._playbackStream = null;
    this._playbackDate = null;
    this._playbackStart = null;
    this.el.classList.remove('playback-mode');
    this.el.querySelector('.cam-seek-timeline').classList.remove('active');

    // Restore fullscreen HUD to LIVE mode if in fullscreen
    if (this.el.classList.contains('fullscreen')) {
      this.el.classList.add('fs-live');
      const recText = this.el.querySelector('.seek-info-rec-text');
      if (recText) recText.textContent = 'LIVE';
      this._updateFsLiveTime();
      this._fsLiveTimer = setInterval(() => this._updateFsLiveTime(), 1000);
    }

    // Restore SD/HD toggle
    this._qualityToggle.dataset.mode = '';
    this._qualityToggle.innerHTML = '<span class="quality-opt quality-sd active">SD</span><span class="quality-opt quality-hd">HD</span>';

    // Reset button states: Play=default, Live=active(green)
    const goBtn = this.el.querySelector('.playback-go');
    const liveBtn = this.el.querySelector('.playback-live');
    goBtn.innerHTML = '&#9654; Play';
    goBtn.classList.remove('active');
    liveBtn.classList.remove('return-hint');
    liveBtn.classList.add('active');
    liveBtn.innerHTML = '&#9673; Live';

    // Atomic switch back to SD live
    this._switchPlayer(this.player);

    // Restart LIVE grid HUD timer
    this._startGhudLive();

    // Reset quality toggle to SD
    this._qualityToggle.querySelector('.quality-hd').classList.remove('active');
    this._qualityToggle.querySelector('.quality-sd').classList.add('active');
    this._qualityToggle.classList.remove('hd-active');
  }  stopPlaybackTimer() {
    if (this._positionTimer) {
      clearInterval(this._positionTimer);
      this._positionTimer = null;
    }
  }

  /** Get current playback position as Date. */
  get playbackPosition() {
    if (!this._playbackDate || !this._playbackStart) return null;
    const elapsed = (Date.now() - this._playbackStart.getTime()) / 1000;
    const totalSeconds = this._playbackOffset + elapsed;
    return new Date(this._playbackDate.getTime() + totalSeconds * 1000);
  }

  get isPlayback() { return !!this._playbackStream; }
  get playbackStreamName() { return this._playbackStream; }
  get playbackResolution() { return this._playbackResolution || 'original'; }

  _startPositionTimer() {
    this._positionTimer = setInterval(() => this._updateSeekPosition(), 500);
    this._updateSeekPosition();
  }

  _updateSeekPosition() {
    const pos = this.playbackPosition;
    if (!pos) return;

    const secondsInDay = 24 * 3600;
    const currentSeconds = pos.getHours() * 3600 + pos.getMinutes() * 60 + pos.getSeconds();
    const fraction = Math.min(currentSeconds / secondsInDay, 1);
    this._seekCursorFraction = fraction;

    const fill = this.el.querySelector('.seek-fill');
    const cursor = this.el.querySelector('.seek-cursor');
    const cursorLine = this.el.querySelector('.seek-cursor-line');
    const cursorTime = this.el.querySelector('.seek-cursor-time');
    fill.style.width = `${fraction * 100}%`;
    cursor.style.left = `${fraction * 100}%`;
    cursorLine.style.left = `${fraction * 100}%`;
    cursorTime.style.left = `${fraction * 100}%`;

    // Update now marker + unavailable zone (only for today)
    this._updateSeekAvailability();

    // Update cursor time label
    const pad = (n) => String(n).padStart(2, '0');
    const timeStr = `${pad(pos.getHours())}:${pad(pos.getMinutes())}:${pad(pos.getSeconds())}`;
    cursorTime.textContent = timeStr;
    const dateStr = `${pad(pos.getDate())}.${pad(pos.getMonth() + 1)}`;
    this._modeBadge.innerHTML = `<span class="rec-dot">● REC</span><span class="rec-time">${timeStr}</span><span class="rec-date">${dateStr}</span>`;
    this._modeBadge.className = 'cam-mode playback';

    // Update fullscreen HUD info row
    const fsTime = this.el.querySelector('.seek-info-time');
    const fsDateFull = this.el.querySelector('.seek-info-date-full');
    if (fsTime) fsTime.textContent = timeStr;
    if (fsDateFull) fsDateFull.textContent = `${pad(pos.getDate())}.${pad(pos.getMonth() + 1)}.${pos.getFullYear()}`;

    // Update grid HUD
    const ghudFill = this.el.querySelector('.ghud-fill');
    const ghudCursor = this.el.querySelector('.ghud-cursor');
    const ghudTime = this.el.querySelector('.ghud-time');
    if (ghudFill) ghudFill.style.width = `${fraction * 100}%`;
    if (ghudCursor) ghudCursor.style.left = `${fraction * 100}%`;
    if (ghudTime) ghudTime.textContent = timeStr;
  }

  /** Update the date label on the seek timeline. */
  _updateDateLabel() {
    const pad = (n) => String(n).padStart(2, '0');
    const d = this._playbackDate;
    const now = new Date();
    const isToday = d && d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate();
    const days = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'];

    // Fullscreen seek-timeline date label
    const label = this.el.querySelector('.seek-date-label');
    if (label) {
      if (!d) { label.innerHTML = ''; }
      else {
        const weekday = days[d.getDay()];
        label.innerHTML = `<span class="seek-date-weekday">${weekday}</span>${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
        label.classList.toggle('is-today', isToday);
      }
    }
    const nextBtn = this.el.querySelector('.seek-day-next');
    if (nextBtn) nextBtn.classList.toggle('disabled', isToday);

    // Grid HUD date label
    const ghudDate = this.el.querySelector('.ghud-date');
    if (ghudDate) {
      if (!d) { ghudDate.textContent = ''; }
      else {
        const weekday = days[d.getDay()];
        ghudDate.textContent = `${weekday} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
        ghudDate.classList.toggle('is-today', isToday);
      }
    }
    const ghudNext = this.el.querySelector('.ghud-day-next');
    if (ghudNext) ghudNext.classList.toggle('disabled', isToday);
  }

  /** Show/hide unavailable zone and now marker based on playback date. */
  _updateSeekAvailability() {
    // Fullscreen seek-timeline elements
    const unavailable = this.el.querySelector('.seek-unavailable');
    const nowMarker = this.el.querySelector('.seek-now');
    const nowLabel = this.el.querySelector('.seek-now-label');
    // Grid HUD elements
    const ghudUnavail = this.el.querySelector('.ghud-unavailable');
    const ghudNow = this.el.querySelector('.ghud-now');

    const hideAll = () => {
      if (unavailable) unavailable.style.display = 'none';
      if (nowMarker) nowMarker.style.display = 'none';
      if (ghudUnavail) ghudUnavail.style.display = 'none';
      if (ghudNow) ghudNow.style.display = 'none';
    };

    if (!this._playbackDate) { hideAll(); return; }

    const now = new Date();
    const pbDate = this._playbackDate;
    const isToday = now.getFullYear() === pbDate.getFullYear()
      && now.getMonth() === pbDate.getMonth()
      && now.getDate() === pbDate.getDate();

    if (!isToday) { hideAll(); return; }

    const bufferMinutes = 1;
    const availableUntil = new Date(now.getTime() - bufferMinutes * 60 * 1000);
    const availSeconds = availableUntil.getHours() * 3600 + availableUntil.getMinutes() * 60 + availableUntil.getSeconds();
    const availFraction = Math.min(availSeconds / (24 * 3600), 1);

    const nowSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const nowFraction = Math.min(nowSeconds / (24 * 3600), 1);

    // Fullscreen seek-timeline
    if (unavailable) {
      unavailable.style.display = 'block';
      unavailable.style.left = `${availFraction * 100}%`;
      unavailable.style.right = '0';
    }
    if (nowMarker) {
      nowMarker.style.display = 'block';
      nowMarker.style.left = `${nowFraction * 100}%`;
    }
    this._seekNowFraction = nowFraction;

    if (nowLabel) {
      const cursorDist = Math.abs((this._seekCursorFraction || 0) - nowFraction);
      nowLabel.style.opacity = cursorDist < 0.04 ? '0' : '';
      const pad = (n) => String(n).padStart(2, '0');
      nowLabel.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    }

    // Grid HUD
    if (ghudUnavail) {
      ghudUnavail.style.display = 'block';
      ghudUnavail.style.left = `${availFraction * 100}%`;
      ghudUnavail.style.right = '0';
    }
    if (ghudNow) {
      ghudNow.style.display = 'block';
      ghudNow.style.left = `${nowFraction * 100}%`;
    }
  }

  /** Check if a seek time falls in the unavailable zone (future on today). */
  _isSeekUnavailable(seekDate) {
    if (!this._playbackDate) return false;
    const now = new Date();

    // Only today's playback has an unavailable zone
    const isSeekToday = now.getFullYear() === seekDate.getFullYear()
      && now.getMonth() === seekDate.getMonth()
      && now.getDate() === seekDate.getDate();
    if (!isSeekToday) return false;

    const bufferMinutes = 1;
    const availableUntil = new Date(now.getTime() - bufferMinutes * 60 * 1000);
    return seekDate > availableUntil;
  }

  /** Update badge during playback with mode info. */
  _updatePlaybackBadge(mode) {
    const pos = this.playbackPosition;
    const pad = (n) => String(n).padStart(2, '0');
    if (pos) {
      const timeStr = `${pad(pos.getHours())}:${pad(pos.getMinutes())}`;
      const dateStr = `${pad(pos.getDate())}.${pad(pos.getMonth() + 1)}`;
      this._modeBadge.innerHTML = `<span class="rec-dot">● REC</span><span class="rec-time">${timeStr}</span><span class="rec-date">${dateStr}</span>`;
    } else {
      this._modeBadge.innerHTML = `<span class="rec-dot">● REC</span>`;
    }
    this._modeBadge.className = 'cam-mode playback';
  }

  /** When datetime/resolution changes during archive: revert Play button, highlight changed control + Play. */
  _markPendingChange(changedEl) {
    if (!this.isPlayback) return;

    // Revert Stop → Play
    const goBtn = this.el.querySelector('.playback-go');
    goBtn.innerHTML = '&#9654; Play';
    goBtn.classList.remove('active');
    goBtn.classList.add('pending');

    // Highlight changed input
    changedEl.classList.add('pending');
  }

  /** Clear all pending highlights (called when Play is clicked). */
  _clearPendingChange() {
    this.el.querySelectorAll('.pending').forEach(el => el.classList.remove('pending'));
  }

  // ── Digital zoom ──
  //
  // Model: transform-origin: 0 0; transform: translate(tx, ty) scale(S)
  // tx, ty are in CSS pixels (screen space). At scale=1: tx=ty=0.
  // Drag: tx += dx (screen pixels, 1:1).
  // Zoom to cursor: keep image content under cursor fixed.

  _applyZoom() {
    const { scale, tx, ty } = this._zoom;
    const transform = scale <= 1 ? '' : `translate(${tx}px, ${ty}px) scale(${scale})`;
    const origin = scale <= 1 ? '' : '0 0';

    // Apply to both video and freeze frame
    this.video.style.transform = transform;
    this.video.style.transformOrigin = origin;
    const freeze = this.el.querySelector('.cam-freeze');
    if (freeze) {
      freeze.style.transform = transform;
      freeze.style.transformOrigin = origin;
    }

    this.el.classList.toggle('cam-zoomed', scale > 1);

    // Zoom level badge in top bar
    const badge = this.el.querySelector('.cam-zoom-badge');
    if (badge) {
      badge.textContent = scale <= 1 ? '' : `${scale.toFixed(1)}×`;
      badge.classList.toggle('visible', scale > 1);
    }

    // Update info-inline with zoom factor
    if (this.isFullscreen) {
      const p = this._activePlayer || this.player;
      if (p) this._updateInfoTooltip(p, p.bitrate || 0);
    }

    // Minimap
    this._updateMinimap();
  }

  _updateMinimap() {
    const minimap = this.el.querySelector('.cam-minimap');
    if (!minimap) return;

    const { scale, tx, ty } = this._zoom;
    if (scale <= 1) {
      minimap.classList.remove('visible');
      clearInterval(this._minimapTimer);
      this._minimapTimer = null;
      return;
    }
    minimap.classList.add('visible');

    // Start periodic canvas refresh (video is live)
    if (!this._minimapTimer) {
      this._minimapTimer = setInterval(() => this._drawMinimapFrame(), 1000);
    }
    this._drawMinimapFrame();

    // Viewport rectangle
    const vp = minimap.querySelector('.cam-minimap-viewport');
    const rect = this.el.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const canvas = minimap.querySelector('.cam-minimap-canvas');
    const mw = canvas.width;
    const mh = canvas.height;

    const vx = -tx / scale;
    const vy = -ty / scale;
    const vw = w / scale;
    const vh = h / scale;

    vp.style.left = `${Math.max(0, (vx / w) * mw)}px`;
    vp.style.top = `${Math.max(0, (vy / h) * mh)}px`;
    vp.style.width = `${Math.min(mw, (vw / w) * mw)}px`;
    vp.style.height = `${Math.min(mh, (vh / h) * mh)}px`;
  }

  _drawMinimapFrame() {
    const canvas = this.el.querySelector('.cam-minimap-canvas');
    if (!canvas || !this.video.videoWidth) return;
    const ctx = canvas.getContext('2d');
    const mw = canvas.width = 120;
    const mh = canvas.height = Math.round(120 * (this.video.videoHeight / this.video.videoWidth));
    canvas.style.height = `${mh}px`;
    canvas.parentElement.style.height = `${mh + 2}px`;
    try { ctx.drawImage(this.video, 0, 0, mw, mh); } catch {}
  }

  _resetZoom() {
    this._zoom = { scale: 1, tx: 0, ty: 0 };
    clearInterval(this._minimapTimer);
    this._minimapTimer = null;
    // Reset minimap position to default (top-right)
    const mm = this.el.querySelector('.cam-minimap');
    if (mm) { mm.style.left = ''; mm.style.right = ''; mm.style.top = ''; }
    this._applyZoom();
  }

  /** Zoom to newScale keeping the screen point (cursorX, cursorY) px fixed. */
  _setZoom(newScale, cursorX, cursorY) {
    const s = this._zoom.scale;
    newScale = Math.max(1, Math.min(8, newScale));
    if (newScale <= 1) {
      this._zoom = { scale: 1, tx: 0, ty: 0 };
    } else {
      // Keep content under cursor stationary:
      // tx_new = cursorX * (1 - S2/S1) + tx_old * (S2/S1)
      const ratio = newScale / s;
      this._zoom.tx = cursorX * (1 - ratio) + this._zoom.tx * ratio;
      this._zoom.ty = cursorY * (1 - ratio) + this._zoom.ty * ratio;
      this._zoom.scale = newScale;
      this._clampPan();
    }
    this._applyZoom();
  }

  _clampPan() {
    const { scale } = this._zoom;
    if (scale <= 1) { this._zoom.tx = 0; this._zoom.ty = 0; return; }
    const rect = this.el.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    // tx range: [-(scale-1)*w, 0]
    this._zoom.tx = Math.max(-(scale - 1) * w, Math.min(0, this._zoom.tx));
    this._zoom.ty = Math.max(-(scale - 1) * h, Math.min(0, this._zoom.ty));
  }

  _bindZoomEvents() {
    // Wheel zoom (fullscreen only)
    this.el.addEventListener('wheel', (e) => {
      if (!this.isFullscreen) return;
      e.preventDefault();
      const rect = this.el.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;
      const raw = -e.deltaY * 0.005;
      const clamped = Math.max(-0.25, Math.min(0.25, raw));
      this._setZoom(this._zoom.scale * (1 + clamped), cursorX, cursorY);
    }, { passive: false });

    // Mouse drag pan (fullscreen + zoomed)
    this.el.addEventListener('mousedown', (e) => {
      if (!this.isFullscreen || this._zoom.scale <= 1) return;
      if (e.target.closest('.cam-seek-timeline, .cam-overlay, .cam-playback-panel, .cam-top-right, .cam-quality-toggle')) return;
      this._zoomDragging = true;
      this._zoomDragMoved = false;
      this._zoomDragLast = { x: e.clientX, y: e.clientY };
      this.el.classList.add('cam-zoom-dragging');
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!this._zoomDragging) return;
      this._zoomDragMoved = true;
      // Direct 1:1 screen-pixel panning
      this._zoom.tx += e.clientX - this._zoomDragLast.x;
      this._zoom.ty += e.clientY - this._zoomDragLast.y;
      this._zoomDragLast = { x: e.clientX, y: e.clientY };
      this._clampPan();
      this._applyZoom();
    });
    document.addEventListener('mouseup', () => {
      if (this._zoomDragging) {
        this._zoomDragging = false;
        this.el.classList.remove('cam-zoom-dragging');
        if (this._zoomDragMoved) {
          const suppress = (e) => { e.stopPropagation(); e.preventDefault(); };
          this.el.addEventListener('click', suppress, { capture: true, once: true });
        }
      }
    });

    // Touch pinch-to-zoom + pan
    let lastPinchDist = 0;
    let lastTouchCenter = null;
    this.el.addEventListener('touchstart', (e) => {
      if (!this.isFullscreen) return;
      if (e.touches.length === 2) {
        const [a, b] = [e.touches[0], e.touches[1]];
        lastPinchDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const rect = this.el.getBoundingClientRect();
        lastTouchCenter = {
          x: (a.clientX + b.clientX) / 2 - rect.left,
          y: (a.clientY + b.clientY) / 2 - rect.top
        };
      } else if (e.touches.length === 1 && this._zoom.scale > 1) {
        lastTouchCenter = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
    }, { passive: true });

    this.el.addEventListener('touchmove', (e) => {
      if (!this.isFullscreen) return;
      if (e.touches.length === 2 && lastPinchDist) {
        // Pinch zoom
        const [a, b] = [e.touches[0], e.touches[1]];
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const rect = this.el.getBoundingClientRect();
        const cx = (a.clientX + b.clientX) / 2 - rect.left;
        const cy = (a.clientY + b.clientY) / 2 - rect.top;
        this._setZoom(this._zoom.scale * (dist / lastPinchDist), cx, cy);
        lastPinchDist = dist;
        lastTouchCenter = { x: cx, y: cy };
        e.preventDefault();
      } else if (e.touches.length === 1 && this._zoom.scale > 1 && lastTouchCenter) {
        // Single-finger pan when zoomed
        const t = e.touches[0];
        this._zoom.tx += t.clientX - lastTouchCenter.x;
        this._zoom.ty += t.clientY - lastTouchCenter.y;
        lastTouchCenter = { x: t.clientX, y: t.clientY };
        this._clampPan();
        this._applyZoom();
        e.preventDefault();
      }
    }, { passive: false });

    this.el.addEventListener('touchend', () => {
      if (lastPinchDist) lastPinchDist = 0;
      lastTouchCenter = null;
    }, { passive: true });

    // Double-tap to toggle zoom (mobile)
    let lastTapTime = 0;
    this.el.addEventListener('touchend', (e) => {
      if (!this.isFullscreen || e.touches.length > 0) return;
      const now = Date.now();
      if (now - lastTapTime < 300) {
        e.preventDefault();
        if (this._zoom.scale > 1) {
          this._resetZoom();
        } else {
          const rect = this.el.getBoundingClientRect();
          const t = e.changedTouches[0];
          this._setZoom(3, t.clientX - rect.left, t.clientY - rect.top);
        }
        lastTapTime = 0;
      } else {
        lastTapTime = now;
      }
    });

    // Minimap: drag to reposition widget, click to pan viewport
    const minimap = this.el.querySelector('.cam-minimap');
    if (minimap) {
      let mmDragging = false;
      let mmMoved = false;
      let mmStart = { x: 0, y: 0, left: 0, top: 0 };

      minimap.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        mmDragging = true;
        mmMoved = false;
        const style = minimap.getBoundingClientRect();
        const parent = this.el.getBoundingClientRect();
        // Convert from right-positioned to left-positioned for dragging
        minimap.style.left = `${style.left - parent.left}px`;
        minimap.style.right = 'auto';
        mmStart = {
          x: e.clientX, y: e.clientY,
          left: style.left - parent.left,
          top: style.top - parent.top
        };
      });

      document.addEventListener('mousemove', (e) => {
        if (!mmDragging) return;
        const dx = e.clientX - mmStart.x;
        const dy = e.clientY - mmStart.y;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) mmMoved = true;
        if (mmMoved) {
          minimap.style.left = `${mmStart.left + dx}px`;
          minimap.style.top = `${mmStart.top + dy}px`;
        }
      });

      document.addEventListener('mouseup', () => {
        if (!mmDragging) return;
        mmDragging = false;
        // Suppress click after drag (prevents fullscreen exit)
        if (mmMoved) {
          const suppress = (e) => { e.stopPropagation(); e.preventDefault(); };
          this.el.addEventListener('click', suppress, { capture: true, once: true });
        }
      });

      // Click on minimap (no drag) → pan viewport to that point
      minimap.addEventListener('click', (e) => {
        e.stopPropagation(); // always prevent bubbling to cam click handler
        if (mmMoved || this._zoom.scale <= 1) return;
        const canvas = minimap.querySelector('.cam-minimap-canvas');
        const mr = canvas.getBoundingClientRect();
        const fx = (e.clientX - mr.left) / mr.width;
        const fy = (e.clientY - mr.top) / mr.height;
        const rect = this.el.getBoundingClientRect();
        const s = this._zoom.scale;
        this._zoom.tx = -(fx * rect.width * s - rect.width / 2);
        this._zoom.ty = -(fy * rect.height * s - rect.height / 2);
        this._clampPan();
        this._applyZoom();
      });
    }

    // Long-press quick actions menu (grid thumbnails only)
    let longPressTimer = null;
    this.el.addEventListener('touchstart', (e) => {
      if (this.isFullscreen || e.touches.length !== 1) return;
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        this._showQuickMenu();
      }, 500);
    }, { passive: true });
    this.el.addEventListener('touchmove', () => { clearTimeout(longPressTimer); }, { passive: true });
    this.el.addEventListener('touchend', () => { clearTimeout(longPressTimer); }, { passive: true });
  }

  _showQuickMenu() {
    this._hideQuickMenu();
    const menu = document.createElement('div');
    menu.className = 'cam-quick-menu';
    const actions = [
      { label: '⛶', text: 'Open', action: () => { this._hideQuickMenu(); if (this.onClick) this.onClick(this); }},
      { label: this.isPlayback ? '●' : '▶', text: this.isPlayback ? 'LIVE' : 'Archive', action: () => {
        this._hideQuickMenu();
        if (this.isPlayback) { if (this.onLiveRequest) this.onLiveRequest(this); }
        else { this.togglePlaybackPanel(); }
      }},
      { label: this.video.muted ? '🔇' : '🔊', text: 'Audio', action: () => {
        this._hideQuickMenu();
        this.video.muted = !this.video.muted;
        this._audioIcon.classList.toggle('unmuted', !this.video.muted);
      }},
      { label: '☑', text: 'Select', action: () => { this._hideQuickMenu(); this.toggleSelect(); }},
    ];
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.className = 'cam-quick-btn';
      btn.innerHTML = `<span style="font-size:16px">${a.label}</span>${a.text}`;
      btn.addEventListener('click', (e) => { e.stopPropagation(); a.action(); });
      menu.appendChild(btn);
    }
    this.el.appendChild(menu);
    // Auto-hide after 4s
    this._quickMenuTimer = setTimeout(() => this._hideQuickMenu(), 4000);
    // Dismiss on outside tap
    const dismiss = (e) => {
      if (!menu.contains(e.target)) { this._hideQuickMenu(); document.removeEventListener('touchstart', dismiss); }
    };
    setTimeout(() => document.addEventListener('touchstart', dismiss), 100);
  }

  _hideQuickMenu() {
    clearTimeout(this._quickMenuTimer);
    this.el.querySelector('.cam-quick-menu')?.remove();
  }

  // ── Private: DOM creation ──

  _createElement() {
    const el = document.createElement('div');
    el.className = 'cam';
    el.dataset.id = this.id;
    el.dataset.label = this.label;
    el.dataset.group = this.group;
    el.draggable = true;

    el.innerHTML = `
      <div class="cam-loading">
        <svg class="cam-spinner" viewBox="0 0 36 36">
          <circle cx="18" cy="18" r="14" fill="none" stroke="rgba(255,171,0,0.15)" stroke-width="3"/>
          <circle cx="18" cy="18" r="14" fill="none" stroke="var(--warn)" stroke-width="3" stroke-dasharray="22 66" stroke-linecap="round"/>
        </svg>
        <span class="cam-loading-text">connecting</span>
        <div class="cam-loading-dots"><span></span><span></span><span></span></div>
      </div>
      <video muted autoplay playsinline></video>
      ${window.__okoConfig?.snapshots_enabled !== false ? `<img class="cam-snapshot" src="/backend/snapshot/${this.id}" alt="" loading="lazy">` : ''}
      <img class="cam-freeze" alt="">
      <div class="cam-pause-indicator">
        <svg viewBox="0 0 24 24" width="32" height="32" fill="white"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
      </div>
      <div class="cam-bitrate"></div>
      <div class="cam-minimap">
        <canvas class="cam-minimap-canvas"></canvas>
        <div class="cam-minimap-viewport"></div>
      </div>
      <div class="cam-select" title="Select for investigation (Ctrl+Click)">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
      <div class="cam-info-tooltip"></div>
      <div class="cam-overlay">
        <div class="cam-name-wrap">
          <span class="cam-name">${this.id}</span>
          ${this.label ? `<span class="cam-name-sep"></span><span class="cam-label">${this.label}</span>` : ''}
        </div>
        <div class="cam-info-inline"></div>
        <div class="cam-top-right">
          <span class="cam-zoom-badge"></span>
          <div class="cam-quality-toggle" title="Toggle SD/HD stream (H)">
            <span class="quality-opt quality-sd active">SD</span>
            <span class="quality-opt quality-hd">HD</span>
          </div>
          <svg class="cam-playback-btn" viewBox="0 0 24 24" fill="white" title="Archive playback panel">
            <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/>
          </svg>
        </div>
        <div class="cam-badges">
          <div class="cam-audio-wrap" title="Toggle audio — click to unmute">
            <svg class="cam-audio" viewBox="0 0 24 24" fill="white">
              <path d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77zM16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM3 9v6h4l5 5V4L7 9H3z"/>
            </svg>
          </div>
          <span class="cam-mode"></span>
          <div class="cam-status"></div>
        </div>
      </div>
      <div class="cam-playback-panel">
        <div class="playback-row">
          <input type="datetime-local" class="playback-start" title="Playback start time">
          <span class="playback-sep">&rarr;</span>
          <input type="datetime-local" class="playback-end" title="Playback end time">
        </div>
        <div class="playback-row">
          <select class="playback-resolution" title="Video resolution for playback">
            <option value="original">Original</option>
            <option value="1080p">1080p</option>
            <option value="720p">720p</option>
            <option value="480p">480p</option>
            <option value="360p">360p</option>
          </select>
          <button class="playback-go" title="Start archive playback">&#9654; Play</button>
          <button class="playback-live" title="Return to live stream">&#9673; Live</button>
        </div>
        <div class="playback-row playback-seek-btns">
          <button class="seek-btn" data-offset="-3600" title="Jump 1 hour back">-1h</button>
          <button class="seek-btn" data-offset="-900" title="Jump 15 min back">-15m</button>
          <button class="seek-btn" data-offset="-300" title="Jump 5 min back">-5m</button>
          <button class="seek-btn" data-offset="300" title="Jump 5 min forward">+5m</button>
          <button class="seek-btn" data-offset="900" title="Jump 15 min forward">+15m</button>
          <button class="seek-btn" data-offset="3600" title="Jump 1 hour forward">+1h</button>
        </div>
      </div>
      <div class="cam-seek-timeline">
        <div class="seek-info-row">
          <span class="seek-info-name"></span>
          <span class="seek-info-status">
            <span class="seek-info-rec-dot"><span class="seek-info-rec-inner"></span></span>
            <span class="seek-info-rec-text">REC</span>
          </span>
          <button class="seek-info-time-btn" title="Open archive panel (P)">
            <span class="seek-info-time"></span>
            <span class="seek-info-time-arrow">▾</span>
          </button>
          <span class="seek-info-date-full"></span>
          <span class="seek-info-spacer"></span>
          <div class="seek-info-seek-btns">
            <button class="fs-seek-btn" data-offset="-3600">-1h</button>
            <button class="fs-seek-btn" data-offset="-900">-15m</button>
            <button class="fs-seek-btn" data-offset="-300">-5m</button>
            <button class="fs-seek-btn" data-offset="-60">-1m</button>
            <button class="fs-seek-btn fs-seek-fwd" data-offset="60">+1m</button>
            <button class="fs-seek-btn fs-seek-fwd" data-offset="300">+5m</button>
            <button class="fs-seek-btn fs-seek-fwd" data-offset="900">+15m</button>
            <button class="fs-seek-btn fs-seek-fwd" data-offset="3600">+1h</button>
            <button class="fs-seek-more" title="More seek options">⋯</button>
            <div class="fs-seek-extra">
              <button class="fs-seek-btn" data-offset="-21600">-6h</button>
              <button class="fs-seek-btn" data-offset="-1800">-30m</button>
              <button class="fs-seek-btn fs-seek-fwd" data-offset="1800">+30m</button>
              <button class="fs-seek-btn fs-seek-fwd" data-offset="21600">+6h</button>
            </div>
          </div>
          <div class="seek-date-nav">
            <button class="seek-day-btn seek-day-prev" title="Previous day">◂</button>
            <span class="seek-date-label"></span>
            <button class="seek-day-btn seek-day-next" title="Next day">▸</button>
          </div>
        </div>
        <div class="seek-bar-wrap">
        <div class="seek-bar">
          <div class="seek-ticks"><span></span><span></span><span></span><span></span><span></span><span></span></div>
          <div class="seek-fill"></div>
          <div class="seek-cursor"></div>
          <div class="seek-cursor-line"></div>
          <div class="seek-cursor-time"></div>
          <div class="seek-cursor-detail"></div>
          <div class="seek-unavailable"></div>
          <div class="seek-now"><span class="seek-now-label"></span></div>
        </div>
        <div class="seek-labels">
          <span>00:00</span><span>04:00</span><span>08:00</span><span>12:00</span><span>16:00</span><span>20:00</span><span>24:00</span>
        </div>
        <div class="seek-time-tooltip"></div>
        <div class="seek-live-pill">▶ LIVE</div>
        </div>
      </div>
      <div class="cam-timeline"><canvas height="3"></canvas></div>
      <button class="ghud-live-btn">
        ▶ LIVE
        <span class="ghud-live-progress"></span>
      </button>
      <div class="cam-grid-hud">
        <div class="ghud-info">
          <span class="ghud-name">${this.id}</span>
          <span class="ghud-status">
            <span class="ghud-rec-dot"></span>
            <span class="ghud-rec-label">REC</span>
            <span class="ghud-time"></span>
          </span>
          <span class="ghud-spacer"></span>
          <button class="ghud-day-prev">◂</button>
          <span class="ghud-date"></span>
          <button class="ghud-day-next">▸</button>
        </div>
        <div class="ghud-bar">
          <div class="ghud-fill"></div>
          <div class="ghud-cursor"></div>
          <div class="ghud-unavailable"></div>
          <div class="ghud-now"></div>
        </div>
        <div class="ghud-tooltip"></div>
      </div>
    `;

    return el;
  }

  // ── Private: event binding ──

  _bindPlayerEvents() {
    this.player.onStatusChange = (online) => {
      this._statusDot.classList.toggle('live', online);
      this.timeline.push({ time: Date.now(), online });
      if (this.onStatusChange) this.onStatusChange(this, online);
    };

    this.player.onModeChange = (mode) => {
      this._modeBadge.textContent = `${mode.toUpperCase()} ●LIVE`;
      this._modeBadge.className = `cam-mode ${mode}`;
    };

    this.player.onStage = (stage) => {
      if (stage === 'playing') {
        this._hideLoading();
      } else {
        this._showLoading(stage);
      }
    };

    this.player.onNeedTranscode = () => {
      if (this.onNeedTranscode) this.onNeedTranscode(this);
    };

    this.player.onConnectionError = (name) => {
      if (this.onConnectionError) this.onConnectionError(this);
    };

    this.player.onStreamNotFound = (name) => {
      if (this.onStreamNotFound) this.onStreamNotFound(this);
    };
  }

  _bindDOMEvents() {
    // click → fullscreen toggle (or Ctrl+click → select for investigation)
    this.el.addEventListener('click', (e) => {
      if (e.target.closest('.cam-quality-toggle')) return;
      if (e.target.closest('.cam-playback-btn')) return;
      if (e.target.closest('.cam-playback-panel')) return;
      if (e.target.closest('.cam-audio-wrap')) return;
      if (e.target.closest('.cam-select')) return;
      if (e.target.closest('.cam-grid-hud')) return;
      if (e.target.closest('.ghud-live-btn')) return;
      if (e.target.closest('.seek-info-row')) return;
      if ((e.ctrlKey || e.metaKey) && !this.el.classList.contains('fullscreen')) {
        this.toggleSelect();
        return;
      }
      if (this.onClick) this.onClick(this);
    });

    // Checkbox click → toggle selection
    this.el.querySelector('.cam-select').addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleSelect();
    });

    // double-click → native fullscreen (grid), pause (in-page fullscreen)
    this.el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (e.target.closest('.cam-playback-panel')) return;
      if (e.target.closest('.cam-grid-hud')) return;
      if (e.target.closest('.ghud-live-btn')) return;
      if (e.target.closest('.seek-info-row')) return;
      if (this.el.classList.contains('fullscreen')) {
        this.togglePause();
      } else if (this.onDoubleClick) {
        this.onDoubleClick(this);
      }
    });

    // Audio icon — toggle mute (only if camera has audio)
    this._audioIcon.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this._audioIcon.classList.contains('has-audio')) return;
      if (CameraView.globalMute) CameraView.globalMute = false;
      this.video.muted = !this.video.muted;
      this._audioIcon.classList.toggle('unmuted', !this.video.muted);
    });

    // SD/HD quality toggle
    this._qualityToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.isPlayback) return; // don't switch during archive playback
      if (this.onHdToggle) this.onHdToggle(this, !this.isHd);
    });

    // Playback button — toggle panel
    const playbackBtn = this.el.querySelector('.cam-playback-btn');
    // Stop mousedown on entire playback panel to prevent fullscreen toggle on long press
    this.el.querySelector('.cam-playback-panel').addEventListener('mousedown', (e) => e.stopPropagation());
    playbackBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const panel = this.el.querySelector('.cam-playback-panel');
      panel.classList.toggle('open');
      playbackBtn.classList.toggle('active', panel.classList.contains('open'));

      // pre-fill: start = 1 hour ago, end = 23:59 same day
      if (panel.classList.contains('open')) {
        const now = new Date();
        const ago = new Date(now.getTime() - 3600 * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const endOfDay = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T23:59`;
        panel.querySelector('.playback-start').value = fmt(ago);
        panel.querySelector('.playback-end').value = endOfDay(ago);
      }
    });

    // auto-set end to 23:59 of same day when start changes
    this.el.querySelector('.playback-start').addEventListener('change', (e) => {
      e.stopPropagation();
      const val = e.target.value;
      if (val) {
        const d = new Date(val);
        const pad = (n) => String(n).padStart(2, '0');
        this.el.querySelector('.playback-end').value =
          `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T23:59`;
      }
      this._markPendingChange(e.target);
    });

    this.el.querySelector('.playback-end').addEventListener('change', (e) => {
      e.stopPropagation();
      this._markPendingChange(e.target);
    });

    this.el.querySelector('.playback-resolution').addEventListener('change', (e) => {
      e.stopPropagation();
      this._markPendingChange(e.target);
      // Update resolution label in quality toggle
      if (this._qualityToggle.dataset.mode === 'playback') {
        const val = e.target.value;
        this._qualityToggle.querySelector('.quality-res').textContent = val === 'original' ? 'Original' : val;
      }
    });

    // Play button
    this.el.querySelector('.playback-go').addEventListener('click', (e) => {
      e.stopPropagation();
      this._clearPendingChange();
      const start = this.el.querySelector('.playback-start').value;
      const end = this.el.querySelector('.playback-end').value;
      const resolution = this.el.querySelector('.playback-resolution').value;
      if (start && end && this.onPlaybackRequest) {
        this.onPlaybackRequest(this, start, end, resolution);
      }
    });

    // Live button
    const liveBtn = this.el.querySelector('.playback-live');
    liveBtn.classList.add('active'); // live by default
    liveBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    liveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.onLiveRequest) this.onLiveRequest(this);
    });

    // Quick seek buttons (-1h, -15m, etc.)
    this.el.querySelectorAll('.seek-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const offset = parseInt(btn.dataset.offset);

        if (this.isPlayback) {
          // Archive mode: seek relative to current position
          const pos = this.playbackPosition;
          if (pos && this.onQuickSeek) {
            let seekTime = new Date(pos.getTime() + offset * 1000);
            if (this._isSeekUnavailable(seekTime)) return;
            this.onQuickSeek(this, seekTime);
          }
        } else if (offset < 0 && this.onPlaybackRequest) {
          // Live mode + negative offset: start archive from now+offset
          const seekTime = new Date(Date.now() + offset * 1000);
          const pad = (n) => String(n).padStart(2, '0');
          const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
          const endOfDay = new Date(seekTime);
          endOfDay.setHours(23, 59, 59, 0);
          const resolution = this.el.querySelector('.playback-resolution').value;
          this.onPlaybackRequest(this, fmt(seekTime), fmt(endOfDay), resolution);
        }
      });
    });

    // Info tooltip on hover (grid mode)
    this.el.addEventListener('mouseenter', () => {
      if (this.el.classList.contains('fullscreen')) return;
      const p = this._activePlayer || this.player;
      if (!p || !p.connected) return;
      this._updateInfoTooltip(p, p.bitrate || 0);
      this._infoTooltip.classList.add('visible');
    });
    this.el.addEventListener('mouseleave', () => {
      if (!this.el.classList.contains('fullscreen')) {
        this._infoTooltip.classList.remove('visible');
      }
    });

    // Seek timeline — click to seek
    const seekBar = this.el.querySelector('.seek-bar');
    const seekTooltip = this.el.querySelector('.seek-time-tooltip');
    const livePill = this.el.querySelector('.seek-live-pill');
    const cursorDetail = this.el.querySelector('.seek-cursor-detail');

    const getSeekTime = (e) => {
      const rect = seekBar.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const totalSeconds = fraction * 24 * 3600;
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      return { fraction, hours, minutes };
    };

    seekBar.addEventListener('mousemove', (e) => {
      e.stopPropagation();
      const { fraction, hours, minutes } = getSeekTime(e);
      const pad = (n) => String(n).padStart(2, '0');
      const timeText = `${pad(hours)}:${pad(minutes)}`;
      const cursorTime = this.el.querySelector('.seek-cursor-time');
      const full = this.el.classList.contains('fullscreen');

      const cursorDist = Math.abs(fraction - (this._seekCursorFraction || -1));

      // Fullscreen: show cursor-detail when hovering near cursor (archive only)
      if (full && cursorDetail && !this.el.classList.contains('fs-live')) {
        if (cursorDist < 0.03 && this._seekCursorFraction !== undefined) {
          const pos = this.playbackPosition;
          if (pos) {
            const ct = `${pad(pos.getHours())}:${pad(pos.getMinutes())}`;
            const now = new Date();
            const diffMs = now - pos;
            const diffMin = Math.floor(Math.abs(diffMs) / 60000);
            const dH = Math.floor(diffMin / 60);
            const dM = diffMin % 60;
            const delta = dH > 0 ? `-${dH}h${pad(dM)}m` : `-${dM}m`;
            cursorDetail.innerHTML = `<span class="scd-time">${ct}</span><span class="scd-delta">${delta}</span>`;
          }
          cursorDetail.style.left = `${(this._seekCursorFraction) * 100}%`;
          cursorDetail.classList.add('visible');
        } else {
          cursorDetail.classList.remove('visible');
        }
      }

      // Check if hovering over unavailable zone
      let isUnavailable = false;
      if (this._playbackDate) {
        const hoverDate = new Date(this._playbackDate);
        hoverDate.setHours(hours, minutes, 0, 0);
        isUnavailable = this._isSeekUnavailable(hoverDate);
      } else {
        // LIVE mode: future time is unavailable
        const now = new Date();
        const hoverDate = new Date(now);
        hoverDate.setHours(hours, minutes, 0, 0);
        isUnavailable = hoverDate > now;
      }
      // Unavailable zone: show LIVE pill, hide green tooltip
      if (isUnavailable) {
        seekTooltip.classList.remove('visible');
        livePill.style.left = `${fraction * 100}%`;
        livePill.classList.add('visible');
        return;
      }
      livePill.classList.remove('visible');
      seekTooltip.textContent = timeText;
      seekTooltip.classList.remove('unavailable');
      seekTooltip.style.left = `${fraction * 100}%`;
      seekTooltip.classList.add('visible');
    });

    seekBar.addEventListener('mouseleave', () => {
      seekTooltip.classList.remove('visible');
      livePill.classList.remove('visible');
      if (cursorDetail) cursorDetail.classList.remove('visible');
    });

    seekBar.addEventListener('click', (e) => {
      e.stopPropagation();
      const { hours, minutes } = getSeekTime(e);

      // LIVE mode: click on bar → start archive at clicked time
      if (!this._playbackDate && this.onPlaybackRequest) {
        const now = new Date();
        const seekTime = new Date(now);
        seekTime.setHours(hours, minutes, 0, 0);
        if (seekTime > now) return; // future
        const pad = (n) => String(n).padStart(2, '0');
        const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        const endOfDay = new Date(now);
        endOfDay.setHours(23, 59, 59, 0);
        const resolution = this.el.querySelector('.playback-resolution')?.value || 'original';
        this.onPlaybackRequest(this, fmt(seekTime), fmt(endOfDay), resolution);
        return;
      }

      if (!this._playbackDate || !this.onPlaybackSeek) return;
      const seekTime = new Date(this._playbackDate);
      seekTime.setHours(hours, minutes, 0, 0);
      // Click in unavailable zone → go to live
      if (this._isSeekUnavailable(seekTime)) {
        const liveBtn = this.el.querySelector('.playback-live');
        if (liveBtn) liveBtn.click();
        return;
      }
      this.onPlaybackSeek(this, seekTime);
    });

    // Day navigation (◀ ▶) on seek timeline
    this.el.querySelector('.seek-day-prev').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this._playbackDate || !this.onPlaybackSeek) return;
      const pos = this.playbackPosition;
      const timeOfDay = pos ? (pos.getHours() * 3600 + pos.getMinutes() * 60 + pos.getSeconds()) : 0;
      const prevDay = new Date(this._playbackDate.getTime() - 86400000);
      prevDay.setHours(0, 0, 0, 0);
      const seekTime = new Date(prevDay.getTime() + timeOfDay * 1000);
      this.onPlaybackSeek(this, seekTime);
    });

    this.el.querySelector('.seek-day-next').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this._playbackDate || !this.onPlaybackSeek) return;
      const nextDay = new Date(this._playbackDate.getTime() + 86400000);
      nextDay.setHours(0, 0, 0, 0);
      const now = new Date();
      if (nextDay > now) return; // entire day is in future
      const pos = this.playbackPosition;
      const timeOfDay = pos ? (pos.getHours() * 3600 + pos.getMinutes() * 60 + pos.getSeconds()) : 0;
      let seekTime = new Date(nextDay.getTime() + timeOfDay * 1000);
      // If time-of-day hasn't arrived yet on target day, clamp to 00:00
      if (this._isSeekUnavailable(seekTime)) seekTime = new Date(nextDay);
      this.onPlaybackSeek(this, seekTime);
    });

    // ── Grid HUD: LIVE button (long-press) ──
    const ghudLiveBtn = this.el.querySelector('.ghud-live-btn');
    let livePressTimer = null;
    let liveTriggered = false;
    const LIVE_HOLD_MS = 500;

    ghudLiveBtn.addEventListener('mousedown', (e) => {
      e.stopImmediatePropagation();
      e.preventDefault();
      liveTriggered = false;
      this._ghudLivePressing = true; // flag to suppress click on this.el
      ghudLiveBtn.classList.add('pressing');
      livePressTimer = setTimeout(() => {
        liveTriggered = true;
        ghudLiveBtn.classList.remove('pressing');
        ghudLiveBtn.classList.add('triggered');
        const playbackLive = this.el.querySelector('.playback-live');
        if (playbackLive) playbackLive.click();
        setTimeout(() => ghudLiveBtn.classList.remove('triggered'), 300);
      }, LIVE_HOLD_MS);
    });

    const cancelLivePress = (e) => {
      e.stopImmediatePropagation();
      e.preventDefault();
      clearTimeout(livePressTimer);
      ghudLiveBtn.classList.remove('pressing');
      // Suppress the next click on this.el (mouse may have drifted off button)
      if (this._ghudLivePressing) {
        this._ghudLivePressing = false;
        const suppress = (ev) => { ev.stopImmediatePropagation(); ev.preventDefault(); };
        this.el.addEventListener('click', suppress, { capture: true, once: true });
      }
    };
    ghudLiveBtn.addEventListener('mouseup', cancelLivePress);
    ghudLiveBtn.addEventListener('mouseleave', cancelLivePress);
    ghudLiveBtn.addEventListener('click', (e) => {
      e.stopImmediatePropagation();
      e.preventDefault();
    });

    // ── Grid HUD events ──
    const ghudBar = this.el.querySelector('.ghud-bar');
    const ghudTooltip = this.el.querySelector('.ghud-tooltip');

    const getGhudTime = (e) => {
      const rect = ghudBar.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const totalSeconds = fraction * 24 * 3600;
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      return { fraction, hours, minutes };
    };

    ghudBar.addEventListener('click', (e) => {
      e.stopPropagation();
      const { hours, minutes } = getGhudTime(e);

      // LIVE mode: click on bar → start archive at clicked time
      if (!this._playbackDate && this.onPlaybackRequest) {
        const now = new Date();
        const seekTime = new Date(now);
        seekTime.setHours(hours, minutes, 0, 0);
        if (seekTime > now) return; // future
        const pad = (n) => String(n).padStart(2, '0');
        const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        const endOfDay = new Date(now);
        endOfDay.setHours(23, 59, 59, 0);
        const resolution = this.el.querySelector('.playback-resolution')?.value || 'original';
        this.onPlaybackRequest(this, fmt(seekTime), fmt(endOfDay), resolution);
        return;
      }

      if (!this._playbackDate || !this.onPlaybackSeek) return;
      const seekTime = new Date(this._playbackDate);
      seekTime.setHours(hours, minutes, 0, 0);
      if (this._isSeekUnavailable(seekTime)) {
        const liveBtn = this.el.querySelector('.playback-live');
        if (liveBtn) liveBtn.click();
        return;
      }
      this.onPlaybackSeek(this, seekTime);
    });

    ghudBar.addEventListener('mousemove', (e) => {
      e.stopPropagation();
      const { fraction, hours, minutes } = getGhudTime(e);
      const pad = (n) => String(n).padStart(2, '0');
      const timeText = `${pad(hours)}:${pad(minutes)}`;

      let isUnavailable = false;
      if (this._playbackDate) {
        const hoverDate = new Date(this._playbackDate);
        hoverDate.setHours(hours, minutes, 0, 0);
        isUnavailable = this._isSeekUnavailable(hoverDate);
      } else {
        // LIVE mode: future = unavailable
        const now = new Date();
        const hoverDate = new Date(now);
        hoverDate.setHours(hours, minutes, 0, 0);
        isUnavailable = hoverDate > now;
      }
      if (isUnavailable) {
        ghudTooltip.textContent = '▶ LIVE';
        ghudTooltip.classList.add('visible', 'live');
        ghudTooltip.classList.remove('unavailable');
      } else {
        ghudTooltip.textContent = timeText;
        ghudTooltip.classList.add('visible');
        ghudTooltip.classList.remove('unavailable', 'live');
      }
      ghudTooltip.style.left = `${fraction * 100}%`;
    });

    ghudBar.addEventListener('mouseleave', () => {
      ghudTooltip.classList.remove('visible', 'live');
    });

    // Grid HUD day navigation
    this.el.querySelector('.ghud-day-prev').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this._playbackDate || !this.onPlaybackSeek) return;
      const pos = this.playbackPosition;
      const timeOfDay = pos ? (pos.getHours() * 3600 + pos.getMinutes() * 60 + pos.getSeconds()) : 0;
      const prevDay = new Date(this._playbackDate.getTime() - 86400000);
      prevDay.setHours(0, 0, 0, 0);
      this.onPlaybackSeek(this, new Date(prevDay.getTime() + timeOfDay * 1000));
    });

    this.el.querySelector('.ghud-day-next').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this._playbackDate || !this.onPlaybackSeek) return;
      const nextDay = new Date(this._playbackDate.getTime() + 86400000);
      nextDay.setHours(0, 0, 0, 0);
      if (nextDay > new Date()) return; // entire day is in future
      const pos = this.playbackPosition;
      const timeOfDay = pos ? (pos.getHours() * 3600 + pos.getMinutes() * 60 + pos.getSeconds()) : 0;
      let seekTime = new Date(nextDay.getTime() + timeOfDay * 1000);
      if (this._isSeekUnavailable(seekTime)) seekTime = new Date(nextDay);
      this.onPlaybackSeek(this, seekTime);
    });

    // ── Fullscreen HUD: seek buttons ──
    this.el.querySelectorAll('.fs-seek-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const offset = parseInt(btn.dataset.offset);
        if (this.isPlayback) {
          const pos = this.playbackPosition;
          if (pos && this.onPlaybackSeek) {
            let seekTime = new Date(pos.getTime() + offset * 1000);
            if (this._isSeekUnavailable(seekTime)) return;
            this.onPlaybackSeek(this, seekTime);
          }
        } else if (offset < 0 && this.onPlaybackRequest) {
          // LIVE: start archive from now+offset
          const seekTime = new Date(Date.now() + offset * 1000);
          const pad = (n) => String(n).padStart(2, '0');
          const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
          const endOfDay = new Date(seekTime);
          endOfDay.setHours(23, 59, 59, 0);
          const resolution = this.el.querySelector('.playback-resolution').value;
          this.onPlaybackRequest(this, fmt(seekTime), fmt(endOfDay), resolution);
        }
      });
    });

    // ── Fullscreen HUD: time button → toggle playback panel ──
    this.el.querySelector('.seek-info-time-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const panel = this.el.querySelector('.cam-playback-panel');
      const pbBtn = this.el.querySelector('.cam-playback-btn');
      panel.classList.toggle('open');
      if (pbBtn) pbBtn.classList.toggle('active', panel.classList.contains('open'));
      if (panel.classList.contains('open')) {
        const now = new Date();
        const ago = new Date(now.getTime() - 3600 * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const endOfDay = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T23:59`;
        panel.querySelector('.playback-start').value = fmt(ago);
        panel.querySelector('.playback-end').value = endOfDay(ago);
      }
    });

    // ── Fullscreen HUD: ⋯ more seek buttons toggle ──
    this.el.querySelector('.fs-seek-more').addEventListener('click', (e) => {
      e.stopPropagation();
      const extra = this.el.querySelector('.fs-seek-extra');
      if (extra) extra.classList.toggle('open');
    });

    // drag-and-drop
    this.el.addEventListener('dragstart', (e) => {
      this.el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', this.id);
    });

    this.el.addEventListener('dragend', () => {
      this.el.classList.remove('dragging');
    });

    this.el.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.el.classList.add('drag-over');
    });

    this.el.addEventListener('dragleave', () => {
      this.el.classList.remove('drag-over');
    });

    this.el.addEventListener('drop', (e) => {
      e.preventDefault();
      this.el.classList.remove('drag-over');
      const fromId = e.dataTransfer.getData('text/plain');
      if (fromId !== this.id && this.onDrop) {
        this.onDrop(fromId, this);
      }
    });
  }

  /**
   * Check if camera matches a search/filter query.
   * Supports:
   *   - Text search: "D1", "entrance" (matches id or label)
   *   - Number list: "25,26" (matches D25, D26)
   *   - Number range: "25-30" (matches D25 through D30)
   *   - Mixed: "1,25-28,31" (matches D1, D25, D26, D27, D28, D31)
   */
  matchesQuery(query) {
    if (!query) return true;

    // detect number list/range pattern: only digits, commas, dashes, spaces
    if (/^[\d,\-\s]+$/.test(query.trim())) {
      const camNum = parseInt(this.id.replace(/\D/g, ''));
      const nums = new Set();
      for (const part of query.split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const range = trimmed.split('-').map(s => parseInt(s.trim()));
        if (range.length === 2 && !isNaN(range[0]) && !isNaN(range[1])) {
          const [from, to] = [Math.min(range[0], range[1]), Math.max(range[0], range[1])];
          for (let i = from; i <= to; i++) nums.add(i);
        } else if (!isNaN(range[0])) {
          nums.add(range[0]);
        }
      }
      return nums.has(camNum);
    }

    // fallback: text search
    const q = query.toLowerCase();
    return this.id.toLowerCase().includes(q)
      || this.label.toLowerCase().includes(q);
  }
}

/** Global mute state — when true, entering fullscreen won't unmute. */
CameraView.globalMute = false;
