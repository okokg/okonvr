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

(window._oko = window._oko || {}).cameraView = 'v3c2';

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

    // HD state
    this._hdPlayer = null;
    this._hdStream = null;

    // Set audio availability from backend
    if (this.hasAudio) {
      this._audioIcon.classList.add('has-audio');
    }

    this._bindPlayerEvents();
    this._bindDOMEvents();
  }

  // ── Public ──

  /** Start streaming. Transcode is triggered reactively if codec mismatch detected. */
  start() { this.player.start(); }

  /** Stop ALL streaming (SD + HD + playback) and mark disabled. */
  disable() {
    if (this._hdPlayer) {
      this._hdPlayer.disable();
      this._hdPlayer = null;
      this._hdStream = null;
    }
    if (this._playbackPlayer) {
      this._playbackPlayer.disable();
      this._playbackPlayer = null;
    }
    this.player.disable();
    this._stopRenderCheck();
  }

  /** @returns {boolean} Whether the camera is currently connected. */
  get isConnected() { return this.player.connected; }

  /** @returns {boolean} Whether the player is enabled. */
  get isEnabled() { return this.player.enabled; }

  /** Show/hide the camera tile. */
  setVisible(visible) {
    this.el.classList.toggle('hidden', !visible);
  }

  /** Enter in-page fullscreen mode. */
  enterFullscreen() {
    this.el.classList.add('fullscreen');
    if (!CameraView.globalMute) {
      const hasAudio = this._audioIcon.classList.contains('has-audio');
      this.video.muted = !hasAudio;
      this._audioIcon.classList.toggle('unmuted', hasAudio);
    }
    // Show info tooltip immediately
    const p = this._playbackPlayer || this._hdPlayer || this.player;
    if (p) this._updateInfoTooltip(p, p.bitrate || 0);
  }

  /** Exit in-page fullscreen mode. */
  exitFullscreen() {
    this.el.classList.remove('fullscreen');
    this.video.muted = true;
    this._audioIcon.classList.remove('unmuted');
    this._infoTooltip.classList.remove('visible');
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
    this.player.stop();
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

    if (forceMSE && !CamPlayer.h265WebRTCSupported) {
      this._hdPlayer.startMSE();
    } else {
      this._hdPlayer.start();
    }

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

    // Show loading while SD reconnects
    this._showLoading('switching to sd');

    // Restart SD player
    this.player.start();

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
    this.player.disable();
    this._transcodeStream = newStreamName;
    this.player = new CamPlayer(this.video, newStreamName);
    this._bindPlayerEvents();
    this.player.start();
  }

  /** Show loading spinner with status text. */
  _showLoading(text) {
    this._loadingText.textContent = text;
    this._loading.style.display = 'flex';
    // Don't poll for video render if camera is disabled (NVR offline)
    if (this.player.enabled) this._startRenderCheck();
  }

  /** Hide loading spinner. */
  _hideLoading() {
    this._loading.style.display = 'none';
    this._stopRenderCheck();
  }

  /** Poll until video actually has frames, then hide loading. */
  _startRenderCheck() {
    this._stopRenderCheck();
    this._renderCheckTimer = setInterval(() => {
      if (this.video.videoWidth > 0 && this.video.videoHeight > 0) {
        this._hideLoading();
      }
    }, 500);
  }

  _stopRenderCheck() {
    if (this._renderCheckTimer) {
      clearInterval(this._renderCheckTimer);
      this._renderCheckTimer = null;
    }
  }

  /** Update bitrate display. Call periodically. */
  async updateBitrate() {
    // Use whichever player is active
    const p = this._playbackPlayer || this._hdPlayer || this.player;
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
    const parts = [this.id];
    if (p.mode) parts.push(p.mode.toUpperCase());
    if (kbps > 0) parts.push(`${kbps} kbps`);
    const v = this.video;
    if (v.videoWidth) parts.push(`${v.videoWidth}×${v.videoHeight}`);
    if (this.codec) parts.push(this.codec === 'hevc' ? 'H.265' : 'H.264');
    this._infoTooltip.textContent = parts.join(' · ');

    // In fullscreen, always visible
    if (this.el.classList.contains('fullscreen')) {
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
    const p = this._playbackPlayer || this._hdPlayer || this.player;
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

    // CRITICAL: stop previous playback player to prevent retry loops
    if (this._playbackPlayer) {
      this._playbackPlayer.disable();
      this._playbackPlayer = null;
    }

    this._playbackStream = streamName;
    this._playbackResolution = resolution;

    // track position
    this._playbackDate = new Date(startTime);
    this._playbackDate.setHours(0, 0, 0, 0); // midnight of that day
    this._playbackOffset = (startTime - this._playbackDate) / 1000;
    this._playbackStart = new Date();

    this.player.stop();
    // Stop HD if active — playback uses its own player
    if (this._hdPlayer) {
      this._hdPlayer.disable();
      this._hdPlayer = null;
      this._hdStream = null;
    }
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

    // HEVC → use MSE only if browser doesn't support H.265 WebRTC
    if (forceMSE && !CamPlayer.h265WebRTCSupported) {
      this._playbackPlayer.startMSE();
    } else {
      this._playbackPlayer.start();
    }

    this.el.classList.add('playback-mode');

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
    this.stopPlaybackTimer();
    if (this._playbackPlayer) {
      this._playbackPlayer.disable();
      this._playbackPlayer = null;
    }
    this._playbackStream = null;
    this._playbackDate = null;
    this._playbackStart = null;
    this.el.classList.remove('playback-mode');
    this.el.querySelector('.cam-seek-timeline').classList.remove('active');

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

    this.player.start();

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

    const fill = this.el.querySelector('.seek-fill');
    const cursor = this.el.querySelector('.seek-cursor');
    fill.style.width = `${fraction * 100}%`;
    cursor.style.left = `${fraction * 100}%`;

    // Update now marker + unavailable zone (only for today)
    this._updateSeekAvailability();

    // Update badge with current archive time
    const pad = (n) => String(n).padStart(2, '0');
    const timeStr = `${pad(pos.getHours())}:${pad(pos.getMinutes())}:${pad(pos.getSeconds())}`;
    const mode = this._playbackPlayer?.mode?.toUpperCase() || '';
    this._modeBadge.textContent = `${mode} ● ${timeStr}`;
    this._modeBadge.className = 'cam-mode playback';
  }

  /** Show/hide unavailable zone and now marker based on playback date. */
  _updateSeekAvailability() {
    const unavailable = this.el.querySelector('.seek-unavailable');
    const nowMarker = this.el.querySelector('.seek-now');
    const nowLabel = this.el.querySelector('.seek-now-label');

    if (!this._playbackDate) {
      unavailable.style.display = 'none';
      nowMarker.style.display = 'none';
      return;
    }

    const now = new Date();
    const pbDate = this._playbackDate;
    const isToday = now.getFullYear() === pbDate.getFullYear()
      && now.getMonth() === pbDate.getMonth()
      && now.getDate() === pbDate.getDate();

    if (!isToday) {
      unavailable.style.display = 'none';
      nowMarker.style.display = 'none';
      return;
    }

    // Available up to now - 10 minutes
    const bufferMinutes = 1;
    const availableUntil = new Date(now.getTime() - bufferMinutes * 60 * 1000);
    const availSeconds = availableUntil.getHours() * 3600 + availableUntil.getMinutes() * 60 + availableUntil.getSeconds();
    const availFraction = Math.min(availSeconds / (24 * 3600), 1);

    const nowSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const nowFraction = Math.min(nowSeconds / (24 * 3600), 1);

    unavailable.style.display = 'block';
    unavailable.style.left = `${availFraction * 100}%`;
    unavailable.style.right = '0';

    nowMarker.style.display = 'block';
    nowMarker.style.left = `${nowFraction * 100}%`;

    const pad = (n) => String(n).padStart(2, '0');
    nowLabel.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }

  /** Check if a seek time falls in the unavailable zone (today only). */
  _isSeekUnavailable(hours, minutes) {
    if (!this._playbackDate) return false;
    const now = new Date();
    const pbDate = this._playbackDate;
    const isToday = now.getFullYear() === pbDate.getFullYear()
      && now.getMonth() === pbDate.getMonth()
      && now.getDate() === pbDate.getDate();
    if (!isToday) return false;

    const bufferMinutes = 1;
    const availableUntil = new Date(now.getTime() - bufferMinutes * 60 * 1000);
    const seekMinutes = hours * 60 + minutes;
    const availMinutes = availableUntil.getHours() * 60 + availableUntil.getMinutes();
    return seekMinutes > availMinutes;
  }

  /** Update badge during playback with mode info. */
  _updatePlaybackBadge(mode) {
    const pos = this.playbackPosition;
    if (pos) {
      const pad = (n) => String(n).padStart(2, '0');
      const timeStr = `${pad(pos.getHours())}:${pad(pos.getMinutes())}`;
      this._modeBadge.textContent = `${mode.toUpperCase()} ● ${timeStr}`;
    } else {
      this._modeBadge.textContent = `${mode.toUpperCase()} ● REC`;
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
      </div>
      <video muted autoplay playsinline></video>
      <div class="cam-bitrate"></div>
      <div class="cam-top-right">
        <div class="cam-quality-toggle" title="Toggle SD/HD stream (H)">
          <span class="quality-opt quality-sd active">SD</span>
          <span class="quality-opt quality-hd">HD</span>
        </div>
        <svg class="cam-playback-btn" viewBox="0 0 24 24" fill="white" title="Archive playback panel">
          <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/>
        </svg>
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
      <div class="cam-info-tooltip"></div>
      <div class="cam-overlay">
        <div class="cam-name-wrap">
          <span class="cam-name">${this.id}</span>
          ${this.label ? `<span class="cam-name-sep"></span><span class="cam-label">${this.label}</span>` : ''}
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
      <div class="cam-seek-timeline">
        <div class="seek-bar">
          <div class="seek-fill"></div>
          <div class="seek-cursor"></div>
          <div class="seek-unavailable"></div>
          <div class="seek-now"><span class="seek-now-label"></span></div>
        </div>
        <div class="seek-labels">
          <span>00:00</span><span>04:00</span><span>08:00</span><span>12:00</span><span>16:00</span><span>20:00</span><span>24:00</span>
        </div>
        <div class="seek-time-tooltip"></div>
      </div>
      <div class="cam-timeline"><canvas height="3"></canvas></div>
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
  }

  _bindDOMEvents() {
    // click → fullscreen toggle
    this.el.addEventListener('click', (e) => {
      if (e.target.closest('.cam-quality-toggle')) return;
      if (e.target.closest('.cam-playback-btn')) return;
      if (e.target.closest('.cam-playback-panel')) return;
      if (e.target.closest('.cam-audio-wrap')) return;
      if (this.onClick) this.onClick(this);
    });

    // double-click → native fullscreen
    this.el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (e.target.closest('.cam-playback-panel')) return;
      if (this.onDoubleClick) this.onDoubleClick(this);
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
    liveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.onLiveRequest) this.onLiveRequest(this);
    });

    // Quick seek buttons (-1h, -15m, etc.)
    this.el.querySelectorAll('.seek-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const offset = parseInt(btn.dataset.offset);
        const pos = this.playbackPosition;
        if (pos && this.onQuickSeek) {
          let seekTime = new Date(pos.getTime() + offset * 1000);
          // Clamp to available zone (today: now - 10min)
          if (this._isSeekUnavailable(seekTime.getHours(), seekTime.getMinutes())) return;
          this.onQuickSeek(this, seekTime);
        }
      });
    });

    // Info tooltip on hover (grid mode)
    this.el.addEventListener('mouseenter', () => {
      if (this.el.classList.contains('fullscreen')) return;
      const p = this._playbackPlayer || this._hdPlayer || this.player;
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

      // Check if hovering over unavailable zone
      const isUnavailable = this._isSeekUnavailable(hours, minutes);
      seekTooltip.textContent = isUnavailable ? `${timeText} ✗` : timeText;
      seekTooltip.classList.toggle('unavailable', isUnavailable);
      seekTooltip.style.left = `${fraction * 100}%`;
      seekTooltip.classList.add('visible');
    });

    seekBar.addEventListener('mouseleave', () => {
      seekTooltip.classList.remove('visible');
      seekTooltip.classList.remove('unavailable');
    });

    seekBar.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this._playbackDate || !this.onPlaybackSeek) return;
      const { hours, minutes } = getSeekTime(e);
      // Block clicks in unavailable zone
      if (this._isSeekUnavailable(hours, minutes)) return;
      const seekTime = new Date(this._playbackDate);
      seekTime.setHours(hours, minutes, 0, 0);
      this.onPlaybackSeek(this, seekTime);
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
