/**
 * CameraView — core camera tile component.
 *
 * Manages the DOM element, video ownership, loading state,
 * audio, live timer, freeze frame, and feature plugins.
 *
 * Features (playback, zoom, talkback, quality) are attached
 * via .use(feature) and inject their own DOM/events/state.
 */

import { CamPlayer } from './camera-player.js';
import { pad, hms, hm, dm, dmy, fmtInput, daySeconds } from './utils.js';

export { pad, hms, hm, dm, dmy, fmtInput, daySeconds };

export class CameraView {
  /**
   * @param {object} config - { id, label, group, sort_order, has_audio, has_talkback, codec }
   */
  constructor(config) {
    this.id = config.id;
    this.label = config.label || '';
    this.group = config.group || '';
    this.codec = config.codec || null;
    this.hasAudio = !!config.has_audio;
    this.hasTalkback = !!config.has_talkback;
    this.timeline = [];

    /** @type {Feature[]} */
    this._features = [];

    this.el = this._createElement();
    this.video = this.el.querySelector('video');
    this.player = new CamPlayer(this.video, this.id);

    /** The CamPlayer currently owning video.src. Only _switchPlayer changes this. */
    this._activePlayer = null;

    // Cache core DOM refs
    const el = this.el;
    this._dom = {
      audioIcon:      el.querySelector('.cam-audio-wrap'),
      bitrateEl:      el.querySelector('.cam-bitrate'),
      freeze:         el.querySelector('.cam-freeze'),
      ghudAudio:      el.querySelector('.ghud-audio-wrap'),
      ghudBar:        el.querySelector('.ghud-bar'),
      ghudCursor:     el.querySelector('.ghud-cursor'),
      ghudFill:       el.querySelector('.ghud-fill'),
      ghudTime:       el.querySelector('.ghud-time'),
      ghudTooltip:    el.querySelector('.ghud-tooltip'),
      ghudRecLabel:   el.querySelector('.ghud-rec-label'),
      ghudInfo:       el.querySelector('.ghud-info'),
      infoInline:     el.querySelector('.cam-info-inline'),
      infoTooltip:    el.querySelector('.cam-info-tooltip'),
      loading:        el.querySelector('.cam-loading'),
      loadingDots:    el.querySelector('.cam-loading-dots'),
      loadingText:    el.querySelector('.cam-loading-text'),
      modeBadge:      el.querySelector('.cam-mode'),
      pauseIndicator: el.querySelector('.cam-pause-indicator'),
      selectBadge:    el.querySelector('.cam-select'),
      snapshot:       el.querySelector('.cam-snapshot'),
      statusDot:      el.querySelector('.cam-status'),
      timelineCanvas: el.querySelector('.cam-timeline canvas'),
    };

    // Snapshot preload
    if (this._dom.snapshot) {
      this._dom.snapshot.onload = () => {
        console.log(`[snapshot] ${this.id}: loaded (${this._dom.snapshot.naturalWidth}×${this._dom.snapshot.naturalHeight})`);
      };
      this._dom.snapshot.onerror = () => {
        console.warn(`[snapshot] ${this.id}: failed to load`);
      };
    }

    // ── UI State ──
    this._state = {
      audio: {
        available: !!config.has_audio,
        unmuted: false,
      },
    };

    this._renderAudio();
    this._wirePlayer(this.player, 'sd');
    this._bindCoreDOMEvents();
  }

  // ── Feature plugin system ──

  /**
   * Add a feature plugin to this view.
   * @param {import('./feature.js').Feature} feature
   * @returns {this} for chaining
   */
  use(feature) {
    feature.attach(this);
    this._features.push(feature);
    return this;
  }

  /**
   * Get a feature by constructor/class.
   * @param {Function} FeatureClass
   * @returns {Feature|undefined}
   */
  getFeature(FeatureClass) {
    return this._features.find(f => f instanceof FeatureClass);
  }

  /**
   * Serialize full state (core + all features) for deep links.
   * @returns {object}
   */
  getState() {
    const state = { camera: this.id, audio: this._state.audio.unmuted };
    for (const f of this._features) {
      Object.assign(state, f.getState());
    }
    return state;
  }

  /**
   * Restore state from deep link data.
   * @param {object} state
   */
  restoreState(state) {
    if (state.audio) this._setAudioUnmuted(true);
    for (const f of this._features) {
      f.restoreState(state);
    }
  }

  // ── Audio state ──

  _renderAudio() {
    const { available, unmuted } = this._state.audio;
    this._dom.audioIcon?.classList.toggle('has-audio', available);
    this._dom.audioIcon?.classList.toggle('unmuted', unmuted);
    this._dom.ghudAudio?.classList.toggle('has-audio', available);
    this._dom.ghudAudio?.classList.toggle('unmuted', unmuted);
  }

  _setAudioUnmuted(on) {
    this._state.audio.unmuted = on;
    this._renderAudio();
  }

  get audioUnmuted() { return this._state.audio.unmuted; }

  // ── Video ownership (the ONLY place that manages video.src) ──

  /**
   * @param {CamPlayer|null} newPlayer
   * @param {'start'|'mse'} [method='start']
   */
  _switchPlayer(newPlayer, method = 'start') {
    const old = this._activePlayer;
    if (old && old !== newPlayer) {
      old.disable();
    }
    this.video.pause();
    this.video.srcObject = null;
    this.video.removeAttribute('src');
    this.video.load();
    this._activePlayer = newPlayer;

    if (newPlayer) {
      if (method === 'mse') newPlayer.startMSE();
      else newPlayer.start();
    }
  }

  // ── Public API ──

  start() {
    if (this._activePlayer === this.player && this.player.enabled) return;
    if (this._activePlayer && this._activePlayer !== this.player && this._activePlayer.enabled) return;
    this._switchPlayer(this.player);
    if (!this.isPlayback) this._startLiveTimer();
  }

  disable() {
    clearInterval(this._nowMarkerTimer);
    this._stopLiveTimer();
    // Let features clean up
    for (const f of this._features) f.onDisable();
    this._switchPlayer(null);
    this._stopRenderCheck();

    // Show snapshot immediately so video area is never black
    const snap = this._dom.snapshot;
    if (snap && !this.isPlayback) {
      snap.classList.remove('loaded');
      snap.style.display = '';
    }
  }

  get isConnected() {
    const p = this._activePlayer || this.player;
    return p.connected;
  }

  get isEnabled() {
    const p = this._activePlayer || this.player;
    return p.enabled;
  }

  setVisible(visible) {
    this.el.classList.toggle('hidden', !visible);
  }

  get isSelected() { return this.el.classList.contains('cam-selected'); }

  toggleSelect() {
    const selected = this.el.classList.toggle('cam-selected');
    if (this.onSelect) this.onSelect(this, selected);
  }

  setSelected(val) {
    this.el.classList.toggle('cam-selected', val);
  }

  get isFullscreen() {
    return this.el.classList.contains('fullscreen');
  }

  /** Whether camera is in playback mode. Features can set this via _playbackStream. */
  get isPlayback() { return !!this._playbackStream; }

  // ── Pause / Freeze frame ──

  togglePause() {
    const v = this.video;
    if (!v) return;
    const isPaused = this.el.classList.contains('paused');

    if (isPaused) {
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
      this.el.classList.add('paused');
      this._showPauseIndicator('pause');
      if (this.isPlayback) {
        this._captureFrame();
        v.pause();
        // Let playback feature handle timer stop
        for (const f of this._features) {
          if (f.onPause) f.onPause();
        }
        const position = this.playbackPosition;
        const hasFreezeFrame = this._dom.freeze?.classList.contains('visible');
        if (hasFreezeFrame) {
          this._pausedPosition = position;
          if (this.onPlaybackPause) this.onPlaybackPause(this);
        }
      } else {
        this._captureFrame();
        v.pause();
      }
    }
    const p = this._activePlayer || this.player;
    if (p) this._updateInfoTooltip(p, p.bitrate || 0);
  }

  _captureFrame() {
    const v = this.video;
    const img = this._dom.freeze;
    if (!v || !v.videoWidth || !img) return false;
    try {
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(v, 0, 0);

      const w = c.width, h = c.height;
      const points = [[w*.25,h*.25],[w*.5,h*.25],[w*.75,h*.25],[w*.5,h*.5],
                       [w*.25,h*.75],[w*.5,h*.75],[w*.75,h*.75],[w*.1,h*.1]];
      let allBlack = true;
      for (const [x, y] of points) {
        const d = ctx.getImageData(x|0, y|0, 1, 1).data;
        if (d[0] > 0 || d[1] > 0 || d[2] > 0) { allBlack = false; break; }
      }
      if (allBlack) return false;

      img.src = c.toDataURL('image/jpeg', 0.85);
      img.classList.add('visible');
      img.style.transform = v.style.transform;
      img.style.transformOrigin = v.style.transformOrigin;
      return true;
    } catch (e) {
      return false;
    }
  }

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
    console.log(`[camera-view] ${this.id}: freeze-frame capture failed after ${attempt} retries`);
    if (onSuccess) onSuccess();
    return Promise.resolve(false);
  }

  _clearFreezeFrame() {
    const img = this._dom.freeze;
    if (img) {
      img.classList.remove('visible');
      img.src = '';
    }
  }

  _pausedPosition = null;

  _showPauseIndicator(state) {
    const ind = this._dom.pauseIndicator;
    if (!ind) return;
    ind.innerHTML = state === 'pause'
      ? '<svg viewBox="0 0 24 24" width="32" height="32" fill="white"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="32" height="32" fill="white"><path d="M8 5v14l11-7z"/></svg>';
    ind.classList.add('visible');
    clearTimeout(this._pauseIndicatorTimer);
    if (state === 'play') {
      this._pauseIndicatorTimer = setTimeout(() => ind.classList.remove('visible'), 800);
    }
  }

  // ── Fullscreen ──

  enterFullscreen() {
    this.el.classList.add('fullscreen');
    if (!CameraView.globalMute) this._tryUnmute();

    const p = this._activePlayer || this.player;
    if (p) this._updateInfoTooltip(p, p.bitrate || 0);

    if (!this.isPlayback) {
      this.el.classList.add('fs-live');
      this._updateLiveTime();
    } else {
      this.el.classList.remove('fs-live');
    }

    if (this.el.classList.contains('paused')) {
      this._showPauseIndicator('pause');
    }

    // Notify features
    for (const f of this._features) f.onEnterFullscreen();
  }

  exitFullscreen({ keepZoom = false } = {}) {
    this.el.classList.remove('fullscreen');
    this.el.classList.remove('fs-live');

    const ind = this._dom.pauseIndicator;
    if (ind) ind.classList.remove('visible');

    // Mute on exit (features like talkback can override via onExitFullscreen)
    this.video.muted = true;
    this._setAudioUnmuted(false);

    this._dom.infoTooltip?.classList.remove('visible');

    // Notify features
    for (const f of this._features) f.onExitFullscreen({ keepZoom });
  }

  enterNativeFullscreen() {
    this.el.requestFullscreen().catch(() => {});
  }

  // ── Live timer ──

  _updateLiveTime() {
    const now = new Date();
    const pct = `${daySeconds(now) / 86400 * 100}%`;
    const timeStr = hms(now);

    if (this._dom.ghudFill) this._dom.ghudFill.style.width = pct;
    if (this._dom.ghudCursor) this._dom.ghudCursor.style.left = pct;
    if (this._dom.ghudTime) this._dom.ghudTime.textContent = timeStr;

    // Features can hook into live time updates (e.g. playback seek bar in live mode)
    for (const f of this._features) {
      if (f.onLiveTimeUpdate) f.onLiveTimeUpdate(now, pct, timeStr);
    }
  }

  _startLiveTimer() {
    this._stopLiveTimer();
    const recLabel = this._dom.ghudRecLabel;
    if (recLabel) recLabel.textContent = 'LIVE';
    this._updateLiveTime();
    this._liveTimer = setInterval(() => this._updateLiveTime(), 1000);
  }

  _stopLiveTimer() {
    clearInterval(this._liveTimer);
    this._liveTimer = null;
  }

  // ── Loading state ──

  _showLoading(text) {
    this._dom.loadingText.textContent = text;
    this._dom.loading.style.display = 'flex';

    // Show snapshot as dimmed background during loading
    const snap = this._dom.snapshot;
    if (snap && !this.isPlayback) {
      snap.classList.remove('loaded');
      snap.style.display = '';
      // Re-fetch only if we don't have a good image already
      if (!snap.naturalWidth) {
        snap.src = `/backend/snapshot/${this.id}?t=${Date.now()}`;
      }
    }

    const t = (text || '').toLowerCase();

    const dots = this._dom.loadingDots;
    if (dots) {
      let stage = 1;
      if (t.includes('buffer') || t.includes('keyframe') || t.includes('waiting')) stage = 2;
      if (t.includes('codec') && !t.includes('fallback')) stage = 2;
      if (t.includes('playing')) stage = 3;
      const spans = dots.querySelectorAll('span');
      spans.forEach((s, i) => s.classList.toggle('active', i < stage));
    }

    // Don't auto-detect frames for stages where video is known to be stale/frozen
    const isStale = t.includes('recover') || t.includes('reconnect');
    const activePlayer = this._activePlayer || this.player;
    if (activePlayer.enabled && !isStale) this._startRenderCheck();
    else this._stopRenderCheck();
  }

  _hideLoading() {
    this._dom.loading.style.display = 'none';
    this._stopRenderCheck();
    this._clearFreezeFrame();

    // Notify features (quality finalize, etc.)
    for (const f of this._features) f.onStreamReady();

    if (this._dom.snapshot && !this._dom.snapshot.classList.contains('loaded')) {
      this._dom.snapshot.classList.add('loaded');
    }
    this.restoreAudio();
  }

  _startRenderCheck() {
    this._stopRenderCheck();
    this._renderCheckTimer = setInterval(() => {
      if (this.video.videoWidth > 0 && this.video.videoHeight > 0) {
        const hasFreezeFrame = this._dom.freeze?.classList.contains('visible');
        if (hasFreezeFrame) {
          clearInterval(this._renderCheckTimer);
          this._renderCheckTimer = null;
          this._dom.loading.style.display = 'none';
          this._renderBufferTimer = setTimeout(() => this._clearFreezeFrame(), 150);
        } else {
          this._hideLoading();
        }
      }
    }, 200);
  }

  _stopRenderCheck() {
    clearInterval(this._renderCheckTimer);
    this._renderCheckTimer = null;
    clearTimeout(this._renderBufferTimer);
    this._renderBufferTimer = null;
  }

  // ── Audio ──

  awaitUserPlay() {
    this._awaitingUserPlay = true;
    const waitAndPause = () => {
      if (!this._awaitingUserPlay) return;
      if (this.video.readyState >= 2) {
        this.video.pause();
        this._showPauseIndicator('pause');
      } else {
        setTimeout(waitAndPause, 200);
      }
    };
    setTimeout(waitAndPause, 500);

    const handler = (e) => {
      e.stopImmediatePropagation();
      e.preventDefault();
      if (!this._awaitingUserPlay) return;
      this._awaitingUserPlay = false;
      this.video.muted = false;
      this.video.play().catch(() => {});
      this._setAudioUnmuted(this._state.audio.available);
      this._showPauseIndicator('play');
    };
    this.el.addEventListener('click', handler, { once: true, capture: true });
  }

  _tryUnmute() {
    if (!this._state.audio.available) return;
    this.video.muted = false;
    const p = this.video.play();
    if (p && p.catch) {
      p.catch(() => {
        this.video.muted = true;
        this._setAudioUnmuted(false);
        const unlock = () => {
          document.removeEventListener('click', unlock, { capture: true });
          document.removeEventListener('keydown', unlock, { capture: true });
          if (this.el.classList.contains('fullscreen') && !CameraView.globalMute) {
            this.video.muted = false;
            this.video.play().catch(() => {});
            this._setAudioUnmuted(true);
          }
        };
        document.addEventListener('click', unlock, { capture: true, once: true });
        document.addEventListener('keydown', unlock, { capture: true, once: true });
      });
    }
    this._setAudioUnmuted(!this.video.muted);
  }

  restoreAudio() {
    if (CameraView.globalMute || this._awaitingUserPlay) return;
    if (this._state.audio.unmuted) {
      this.video.muted = false;
      const p = this.video.play();
      if (p && p.catch) {
        p.catch(() => {
          this.video.muted = true;
          this._setAudioUnmuted(false);
        });
      }
    } else if (this.el.classList.contains('fullscreen')) {
      this._tryUnmute();
    }
  }

  // ── Bitrate / Info ──

  async updateBitrate() {
    const p = this._activePlayer || this.player;
    await p.updateBitrate();
    const kbps = p.bitrate || 0;
    this._dom.bitrateEl.textContent = kbps > 0 ? `${kbps} kbps` : '';
    this._updateInfoTooltip(p, kbps);
    return kbps;
  }

  _updateInfoTooltip(player, kbps) {
    if (!player) return;
    const full = this.isFullscreen;
    const parts = [];

    if (!full) {
      if (player.mode) parts.push(player.mode.toUpperCase().replace('WEBRTC', 'WR'));
      if (kbps > 0) parts.push(`${kbps} kbps`);
      if (this.video.videoWidth) parts.push(`${this.video.videoWidth}p`);
      if (this.codec) parts.push(this.codec === 'hevc' ? 'H265' : 'H264');
      if (this.el.classList.contains('paused')) parts.push('PAUSED');
      // Let features add info (zoom level, etc.)
      for (const f of this._features) {
        const extra = f.getInfoTooltipParts?.({ full });
        if (extra) parts.push(...extra);
      }
      this._dom.infoTooltip.textContent = parts.join('·');
    } else {
      if (player.mode) parts.push(player.mode.toUpperCase());
      if (kbps > 0) parts.push(`${kbps} kbps`);
      if (this.video.videoWidth) parts.push(`${this.video.videoWidth}×${this.video.videoHeight}`);
      if (this.codec) parts.push(this.codec === 'hevc' ? 'H.265' : 'H.264');
      for (const f of this._features) {
        const extra = f.getInfoTooltipParts?.({ full });
        if (extra) parts.push(...extra);
      }
      if (this.el.classList.contains('paused')) parts.push('PAUSED');
      const text = parts.join(' · ');
      this._dom.infoTooltip.textContent = text;
      const infoInline = this._dom.infoInline;
      if (infoInline) infoInline.textContent = text;
    }
    if (full) this._dom.infoTooltip?.classList.add('visible');
  }

  // ── Timeline ──

  renderTimeline() {
    const canvas = this._dom.timelineCanvas;
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

  syncBuffer() {
    const p = this._activePlayer || this.player;
    if (p.mode !== 'mse' || this.isPlayback) return;
    const v = this.video;
    if (!v.buffered.length) return;
    const end = v.buffered.end(v.buffered.length - 1);
    const lag = end - v.currentTime;
    if (lag > 5) {
      v.currentTime = end - 0.3;
      v.playbackRate = 1.0;
    } else if (lag > 1.5) {
      v.playbackRate = 1.05;
    } else if (lag < 0.5 && v.playbackRate !== 1.0) {
      v.playbackRate = 1.0;
    }
  }

  // ── Callbacks (set by Grid / App) ──

  /** @type {(camera: CameraView) => void} */
  onClick = null;
  onDoubleClick = null;
  onStatusChange = null;
  onDrop = null;
  onPlaybackRequest = null;
  onLiveRequest = null;
  onPlaybackSeek = null;
  onNeedTranscode = null;
  onQuickSeek = null;
  onConnectionError = null;
  onHdError = null;
  onStreamNotFound = null;
  onPlaybackPause = null;
  onPlaybackResume = null;
  onSelect = null;
  onTalkbackStart = null;
  onTalkbackStop = null;
  onHdToggle = null;

  // ── Player wiring ──

  _wirePlayer(player, mode) {
    player.onStatusChange = (online) => {
      this._dom.statusDot.classList.toggle('live', online);
      if (mode === 'sd') {
        this.timeline.push({ time: Date.now(), online });
        if (this.onStatusChange) this.onStatusChange(this, online);
      }
    };

    player.onModeChange = (transport) => {
      if (mode === 'playback') {
        this._dom.modeBadge.className = 'cam-mode playback';
        // Let playback feature update badge
        for (const f of this._features) {
          if (f.onPlaybackModeChange) f.onPlaybackModeChange(transport);
        }
      } else {
        const suffix = mode === 'hd' ? ' HD' : '';
        this._dom.modeBadge.textContent = `${transport.toUpperCase()} ●LIVE${suffix}`;
        this._dom.modeBadge.className = `cam-mode ${transport}`;
      }
    };

    player.onStage = (stage) => {
      if (stage === 'playing') this._hideLoading();
      else this._showLoading(stage);
    };

    // Error/recovery
    if (mode === 'sd') {
      player.onNeedTranscode = () => { if (this.onNeedTranscode) this.onNeedTranscode(this); };
      player.onConnectionError = () => { if (this.onConnectionError) this.onConnectionError(this); };
      player.onStreamNotFound = () => { if (this.onStreamNotFound) this.onStreamNotFound(this); };
    }

    // Let features hook into player events
    for (const f of this._features) {
      f.onWirePlayer(player, mode);
    }
  }

  // ── Quick menu (long-press touch) ──

  _showQuickMenu() {
    this._hideQuickMenu();
    const menu = document.createElement('div');
    menu.className = 'cam-quick-menu';
    const actions = [
      { label: '⛶', text: 'Open', action: () => { this._hideQuickMenu(); if (this.onClick) this.onClick(this); }},
      { label: this.isPlayback ? '●' : '▶', text: this.isPlayback ? 'LIVE' : 'Archive', action: () => {
        this._hideQuickMenu();
        if (this.isPlayback && this.onLiveRequest) this.onLiveRequest(this);
        else {
          // Let playback feature handle
          for (const f of this._features) {
            if (f.togglePanel) { f.togglePanel(); break; }
          }
        }
      }},
      { label: this.video.muted ? '🔇' : '🔊', text: 'Audio', action: () => {
        this._hideQuickMenu();
        this.video.muted = !this.video.muted;
        this._setAudioUnmuted(!this.video.muted);
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
    this._quickMenuTimer = setTimeout(() => this._hideQuickMenu(), 4000);
    const dismiss = (e) => {
      if (!menu.contains(e.target)) { this._hideQuickMenu(); document.removeEventListener('touchstart', dismiss); }
    };
    setTimeout(() => document.addEventListener('touchstart', dismiss), 100);
  }

  _hideQuickMenu() {
    clearTimeout(this._quickMenuTimer);
    this.el.querySelector('.cam-quick-menu')?.remove();
  }

  // ── DOM creation ──

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
          <div class="cam-audio-wrap" title="Toggle audio — click to unmute">
            <svg class="cam-audio" viewBox="0 0 24 24" fill="white">
              <path d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77zM16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM3 9v6h4l5 5V4L7 9H3z"/>
            </svg>
          </div>
        </div>
        <div class="cam-badges">
          <span class="cam-mode"></span>
          <div class="cam-status"></div>
        </div>
      </div>
      <div class="cam-timeline"><canvas height="3"></canvas></div>
      <div class="cam-grid-hud">
        <div class="ghud-info">
          <span class="ghud-pill">
            <span class="ghud-name">${this.id}</span>
            <div class="ghud-audio-wrap">
              <svg class="ghud-audio" viewBox="0 0 24 24" fill="white">
                <path d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77zM16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM3 9v6h4l5 5V4L7 9H3z"/>
              </svg>
            </div>
          </span>
          <span class="ghud-status">
            <span class="ghud-rec-dot"></span>
            <span class="ghud-rec-label">REC</span>
            <span class="ghud-time"></span>
          </span>
        </div>
        <div class="ghud-bar">
          <div class="ghud-fill"></div>
          <div class="ghud-cursor"></div>
        </div>
        <div class="ghud-tooltip"></div>
      </div>
    `;

    return el;
  }

  // ── Core DOM events ──

  _bindCoreDOMEvents() {
    // Click → fullscreen toggle (or Ctrl+click → select)
    this.el.addEventListener('click', (e) => {
      // Guard: let feature-injected elements handle their own clicks
      if (e.target.closest('.cam-quality-toggle, .cam-playback-btn, .cam-playback-panel, .cam-mic-status, .cam-ptt, .cam-select, .cam-grid-hud, .ghud-live-btn, .ghud-audio-wrap, .ghud-mic-wrap, .seek-info-row, .cam-minimap')) return;
      if (e.target.closest('.cam-audio-wrap')) return;
      if ((e.ctrlKey || e.metaKey) && !this.isFullscreen) {
        this.toggleSelect();
        return;
      }
      if (this.onClick) this.onClick(this);
    });

    // Checkbox → toggle selection
    this._dom.selectBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleSelect();
    });

    // Double-click → native fullscreen (grid) / pause (fullscreen)
    this.el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (e.target.closest('.cam-playback-panel, .cam-grid-hud, .cam-ptt, .cam-mic-status, .ghud-live-btn, .ghud-audio-wrap, .ghud-mic-wrap, .seek-info-row')) return;
      if (this.isFullscreen) this.togglePause();
      else if (this.onDoubleClick) this.onDoubleClick(this);
    });

    // Audio icon
    this._dom.audioIcon?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this._state.audio.available) return;
      if (CameraView.globalMute) CameraView.globalMute = false;
      this.video.muted = !this.video.muted;
      this._setAudioUnmuted(!this.video.muted);
    });

    // Grid HUD audio
    this._dom.ghudAudio?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this._state.audio.available) return;
      if (CameraView.globalMute) CameraView.globalMute = false;
      this.video.muted = !this.video.muted;
      this._setAudioUnmuted(!this.video.muted);
    });
    this._dom.ghudAudio?.addEventListener('mousedown', (e) => e.stopPropagation());
    this._dom.ghudAudio?.addEventListener('dblclick', (e) => e.stopPropagation());

    // Info tooltip on hover (grid)
    this.el.addEventListener('mouseenter', () => {
      if (this.isFullscreen) return;
      const p = this._activePlayer || this.player;
      if (!p || !p.connected) return;
      this._updateInfoTooltip(p, p.bitrate || 0);
      this._dom.infoTooltip?.classList.add('visible');
    });
    this.el.addEventListener('mouseleave', () => {
      if (!this.isFullscreen) this._dom.infoTooltip?.classList.remove('visible');
    });

    // Drag-and-drop
    this.el.addEventListener('dragstart', (e) => {
      this.el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', this.id);
    });
    this.el.addEventListener('dragend', () => this.el.classList.remove('dragging'));
    this.el.addEventListener('dragover', (e) => { e.preventDefault(); this.el.classList.add('drag-over'); });
    this.el.addEventListener('dragleave', () => this.el.classList.remove('drag-over'));
    this.el.addEventListener('drop', (e) => {
      e.preventDefault();
      this.el.classList.remove('drag-over');
      const fromId = e.dataTransfer.getData('text/plain');
      if (fromId !== this.id && this.onDrop) this.onDrop(fromId, this);
    });

    // Long-press quick menu (grid, touch)
    let longPressTimer = null;
    this.el.addEventListener('touchstart', (e) => {
      if (this.isFullscreen || e.touches.length !== 1) return;
      longPressTimer = setTimeout(() => { longPressTimer = null; this._showQuickMenu(); }, 500);
    }, { passive: true });
    this.el.addEventListener('touchmove', () => clearTimeout(longPressTimer), { passive: true });
    this.el.addEventListener('touchend', () => clearTimeout(longPressTimer), { passive: true });

    // Grid HUD bar hover (time tooltip)
    const ghudBar = this._dom.ghudBar;
    const ghudTooltip = this._dom.ghudTooltip;
    ghudBar?.addEventListener('mousemove', (e) => {
      e.stopPropagation();
      const rect = ghudBar.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const totalSeconds = fraction * 24 * 3600;
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const timeText = `${pad(hours)}:${pad(minutes)}`;

      // Delegate to features (playback checks unavailable zones)
      let handled = false;
      for (const f of this._features) {
        if (f.onGhudBarHover) {
          try {
            f.onGhudBarHover(hours, minutes, fraction, ghudTooltip);
            handled = true;
          } catch (err) {
            console.warn(`[camera-view] ${this.id}: onGhudBarHover error:`, err.message);
          }
          break;
        }
      }
      if (!handled) {
        // Fallback: check if time is in the future (LIVE zone)
        const now = new Date();
        const hoverDate = new Date(now);
        hoverDate.setHours(hours, minutes, 0, 0);
        const isFuture = hoverDate > now;

        if (isFuture) {
          ghudTooltip.textContent = '▶ LIVE';
          ghudTooltip.classList.add('visible', 'live');
          ghudTooltip.classList.remove('unavailable');
        } else {
          ghudTooltip.textContent = timeText;
          ghudTooltip.classList.add('visible');
          ghudTooltip.classList.remove('unavailable', 'live');
        }
        ghudTooltip.style.left = `${fraction * 100}%`;
      }
    });
    ghudBar?.addEventListener('mouseleave', () => ghudTooltip?.classList.remove('visible', 'live'));

    // Grid HUD bar click → features handle (playback seek or start archive)
    ghudBar?.addEventListener('click', (e) => {
      e.stopPropagation();
      const rect = ghudBar.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const totalSeconds = fraction * 24 * 3600;
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      // Delegate to features (playback handles seek/archive start)
      for (const f of this._features) {
        if (f.onTimelineClick) {
          f.onTimelineClick(hours, minutes);
          return;
        }
      }
    });
  }

  // ── Search / filter ──

  matchesQuery(query) {
    if (!query) return true;

    // Split by comma, check if camera matches ANY part
    const parts = query.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return true;

    const camId = this.id.toLowerCase();
    const camLabel = this.label.toLowerCase();
    const camNum = parseInt(this.id.replace(/\D/g, ''));

    return parts.some(part => {
      // Numeric range: "5-8"
      const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (rangeMatch) {
        const [from, to] = [parseInt(rangeMatch[1]), parseInt(rangeMatch[2])];
        const [lo, hi] = [Math.min(from, to), Math.max(from, to)];
        return camNum >= lo && camNum <= hi;
      }
      // Pure number: "5"
      if (/^\d+$/.test(part)) {
        return camNum === parseInt(part);
      }
      // Camera ID pattern (letter(s) + number): exact match against ID
      // "d1" matches "D1" only, not "D11"
      const q = part.toLowerCase();
      if (/^[a-z]+\d+$/i.test(part)) {
        return camId === q;
      }
      // Free text: substring match against ID or label
      return camId.includes(q) || camLabel.includes(q);
    });
  }

  // ── Feature proxy methods (backward compat for app.js / grid.js) ──
  // These delegate to the appropriate feature if attached.
  // If feature is not attached, they are no-ops or return safe defaults.

  /** @private Find feature by class name. */
  _f(name) { return this._features.find(f => f.constructor.name === name); }

  // Quality proxies
  get isHd() { return this._f('QualityFeature')?.isHd ?? false; }
  get hdStreamName() { return this._f('QualityFeature')?.hdStreamName ?? null; }
  startHd(stream, forceMSE) { this._f('QualityFeature')?.startHd(stream, forceMSE); }
  stopHd() { this._f('QualityFeature')?.stopHd(); }
  _setQualityLoading(target) { this._f('QualityFeature')?.setLoading(target); }
  cancelQualityLoading() { this._f('QualityFeature')?.cancelLoading(); }

  // Playback proxies
  get playbackStreamName() { return this._f('PlaybackFeature')?.streamName ?? null; }
  get playbackPosition() { return this._f('PlaybackFeature')?.position ?? null; }
  get playbackResolution() { return this._f('PlaybackFeature')?.resolution ?? 'original'; }
  startPlayback(stream, start, end, forceMSE, resolution) {
    this._f('PlaybackFeature')?.start(stream, start, end, forceMSE, resolution);
  }
  stopPlayback() { this._f('PlaybackFeature')?.stop(); }
  stopPlaybackTimer() { this._f('PlaybackFeature')?.stopTimer(); }
  destroyPlaybackPlayer() { this._f('PlaybackFeature')?.destroyPlayer(); }
  togglePlaybackPanel() { this._f('PlaybackFeature')?.togglePanel(); }

  get pausedPosition() { return this._pausedPosition; }
  set pausedPosition(val) { this._pausedPosition = val; }

  // Talkback proxies
  toggleTalkback() { this._f('TalkbackFeature')?.toggle(); }
  startTalkback(lock) { return this._f('TalkbackFeature')?.start(lock); }
  stopTalkback(force) { this._f('TalkbackFeature')?.stop(force); }

  // Zoom proxies
  resetZoom() { this._f('ZoomFeature')?.reset(); }

  // Stream switch (transcode)
  switchToStream(newStreamName) {
    this._transcodeStream = newStreamName;
    this.player = new CamPlayer(this.video, newStreamName);
    this._wirePlayer(this.player, 'sd');
    this._switchPlayer(this.player);
  }
}

CameraView.globalMute = false;
