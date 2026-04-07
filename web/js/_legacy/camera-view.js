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

/** Zero-pad number to 2 digits. */
const _pad = (n) => String(n).padStart(2, '0');

/** Format Date as HH:MM:SS. */
const _hms = (d) => `${_pad(d.getHours())}:${_pad(d.getMinutes())}:${_pad(d.getSeconds())}`;

/** Format Date as HH:MM. */
const _hm = (d) => `${_pad(d.getHours())}:${_pad(d.getMinutes())}`;

/** Format Date as DD.MM. */
const _dm = (d) => `${_pad(d.getDate())}.${_pad(d.getMonth() + 1)}`;

/** Format Date as DD.MM.YYYY. */
const _dmy = (d) => `${_dm(d)}.${d.getFullYear()}`;

/** Format Date as YYYY-MM-DDTHH:MM (for datetime-local input). */
const _fmtInput = (d) => `${d.getFullYear()}-${_pad(d.getMonth()+1)}-${_pad(d.getDate())}T${_hm(d)}`;

/** Format Date as YYYY-MM-DDTHH:MM:SS (for playback API). */
const _fmtFull = (d) => `${_fmtInput(d)}:${_pad(d.getSeconds())}`;

/** Seconds since midnight for a Date. */
const _daySeconds = (d) => d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();

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
    this.hasTalkback = !!config.has_talkback;
    this.timeline = [];

    this.el = this._createElement();
    this.video = this.el.querySelector('video');
    this.player = new CamPlayer(this.video, this.id);

    /** The CamPlayer currently owning video.src. Only _switchPlayer changes this. */
    this._activePlayer = null;

    // Cache all DOM refs once — no querySelector in methods
    const el = this.el;
    this._dom = {
      audioIcon: el.querySelector('.cam-audio-wrap'),
      micStatus: el.querySelector('.cam-mic-status'),
      bitrateEl: el.querySelector('.cam-bitrate'),
      freeze: el.querySelector('.cam-freeze'),
      fsSeekExtra: el.querySelector('.fs-seek-extra'),
      fsSeekMore: el.querySelector('.fs-seek-more'),
      ghudAudio: el.querySelector('.ghud-audio-wrap'),
      ghudMic: el.querySelector('.ghud-mic-wrap'),
      ghudBar: el.querySelector('.ghud-bar'),
      ghudCursor: el.querySelector('.ghud-cursor'),
      ghudDate: el.querySelector('.ghud-date'),
      ghudDayNext: el.querySelector('.ghud-day-next'),
      ghudDayPrev: el.querySelector('.ghud-day-prev'),
      ghudFill: el.querySelector('.ghud-fill'),
      ghudLiveBtn: el.querySelector('.ghud-live-btn'),
      ghudNow: el.querySelector('.ghud-now'),
      ghudQHd: el.querySelector('.ghud-q-hd'),
      ghudQRes: el.querySelector('.ghud-q-res'),
      ghudQSd: el.querySelector('.ghud-q-sd'),
      ghudQuality: el.querySelector('.ghud-quality'),
      ghudRecLabel: el.querySelector('.ghud-rec-label'),
      ghudTime: el.querySelector('.ghud-time'),
      ghudTooltip: el.querySelector('.ghud-tooltip'),
      ghudUnavailable: el.querySelector('.ghud-unavailable'),
      infoInline: el.querySelector('.cam-info-inline'),
      infoTooltip: el.querySelector('.cam-info-tooltip'),
      loading: el.querySelector('.cam-loading'),
      loadingDots: el.querySelector('.cam-loading-dots'),
      loadingText: el.querySelector('.cam-loading-text'),
      minimap: el.querySelector('.cam-minimap'),
      minimapCanvas: el.querySelector('.cam-minimap-canvas'),
      minimapViewport: el.querySelector('.cam-minimap-viewport'),
      modeBadge: el.querySelector('.cam-mode'),
      pauseIndicator: el.querySelector('.cam-pause-indicator'),
      pbEnd: el.querySelector('.playback-end'),
      pbGo: el.querySelector('.playback-go'),
      pbLive: el.querySelector('.playback-live'),
      pbResolution: el.querySelector('.playback-resolution'),
      pbStart: el.querySelector('.playback-start'),
      ptt: el.querySelector('.cam-ptt'),
      pttCircle: el.querySelector('.cam-ptt-circle'),
      pttTimer: el.querySelector('.cam-ptt-timer'),
      playbackBtn: el.querySelector('.cam-playback-btn'),
      playbackPanel: el.querySelector('.cam-playback-panel'),
      qualityHd: el.querySelector('.quality-hd'),
      qualityRes: el.querySelector('.quality-res'),
      qualitySd: el.querySelector('.quality-sd'),
      qualityToggle: el.querySelector('.cam-quality-toggle'),
      quickMenu: el.querySelector('.cam-quick-menu'),
      seekBar: el.querySelector('.seek-bar'),
      seekCursor: el.querySelector('.seek-cursor'),
      seekCursorDetail: el.querySelector('.seek-cursor-detail'),
      seekCursorLine: el.querySelector('.seek-cursor-line'),
      seekCursorTime: el.querySelector('.seek-cursor-time'),
      seekDateLabel: el.querySelector('.seek-date-label'),
      seekDayNext: el.querySelector('.seek-day-next'),
      seekDayPrev: el.querySelector('.seek-day-prev'),
      seekFill: el.querySelector('.seek-fill'),
      seekInfoDate: el.querySelector('.seek-info-date-full'),
      seekInfoName: el.querySelector('.seek-info-name'),
      seekInfoRecDot: el.querySelector('.seek-info-rec-dot'),
      seekInfoRecText: el.querySelector('.seek-info-rec-text'),
      seekInfoTime: el.querySelector('.seek-info-time'),
      seekInfoTimeBtn: el.querySelector('.seek-info-time-btn'),
      seekLivePill: el.querySelector('.seek-live-pill'),
      seekNow: el.querySelector('.seek-now'),
      seekNowLabel: el.querySelector('.seek-now-label'),
      seekRingFill: el.querySelector('.seek-ring-fill'),
      seekThumbDot: el.querySelector('.seek-thumb-dot'),
      seekThumbImg: el.querySelector('.seek-thumbnail img'),
      seekThumbMarker: el.querySelector('.seek-thumb-marker'),
      seekThumbProgress: el.querySelector('.seek-thumb-progress'),
      seekThumbSpinner: el.querySelector('.seek-thumb-spinner'),
      seekThumbTime: el.querySelector('.seek-thumb-time'),
      seekThumbnail: el.querySelector('.seek-thumbnail'),
      seekTimeline: el.querySelector('.cam-seek-timeline'),
      seekTooltip: el.querySelector('.seek-time-tooltip'),
      seekUnavailable: el.querySelector('.seek-unavailable'),
      selectBadge: el.querySelector('.cam-select'),
      snapshot: el.querySelector('.cam-snapshot'),
      statusDot: el.querySelector('.cam-status'),
      timelineCanvas: el.querySelector('.cam-timeline canvas'),
      zoomBadge: el.querySelector('.cam-zoom-badge'),
    };

    // Aliases for backward compat (used in app.js / grid.js)
    this._audioIcon = this._dom.audioIcon;
    this._ghudAudio = this._dom.ghudAudio;
    this._qualityToggle = this._dom.qualityToggle;
    this._ghudQuality = this._dom.ghudQuality;
    this._statusDot = this._dom.statusDot;
    this._loading = this._dom.loading;
    this._loadingText = this._dom.loadingText;
    this._modeBadge = this._dom.modeBadge;
    this._bitrateEl = this._dom.bitrateEl;
    this._timelineCanvas = this._dom.timelineCanvas;
    this._infoTooltip = this._dom.infoTooltip;
    this._snapshot = this._dom.snapshot;

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

    // ── UI State — single source of truth for HUD rendering ──
    this._state = {
      quality: {
        current: 'sd',     // 'sd' | 'hd'
        loading: null,     // null | 'sd' | 'hd' (fill-wipe target)
        pending: null,     // null | 'sd' | 'hd' (finalized in _hideLoading)
        playbackRes: null, // null | 'original' | '1080p' | '720p' etc
      },
      audio: {
        available: !!config.has_audio,
        unmuted: false,    // user intent
      },
      talkback: {
        available: !!config.has_talkback,
        connecting: false, // backend + mic + WebRTC in progress
        active: false,     // PTT held down
        locked: false,     // toggle mode (always-on)
      },
    };

    // Talkback WebRTC connection (separate from video player)
    this._talkbackPc = null;
    this._talkbackStream = null;  // go2rtc stream name (__tb_xxx)
    this._talkbackStartTime = null;
    this._talkbackTimerInterval = null;

    // Digital zoom state
    this._zoom = { scale: 1, tx: 0, ty: 0 };
    this._zoomDragging = false;

    // Initial render of state → DOM
    this._renderAudio();
    this._renderTalkback();

    this._wirePlayer(this.player, 'sd');
    this._bindDOMEvents();
    this._bindZoomEvents();
  }

  // ── State → DOM render methods ──

  /** Render quality state to all HUD elements (fullscreen + grid). */
  _renderQuality() {
    const { current, loading, pending, playbackRes } = this._state.quality;
    const inPlayback = this.isPlayback;

    // ── Fullscreen HUD: .quality-sd / .quality-hd / .quality-res ──
    if (this._dom.qualitySd) {
      this._dom.qualitySd.classList.toggle('active', !inPlayback && current === 'sd' && !loading);
      this._dom.qualitySd.classList.toggle('loading', loading === 'sd');
    }
    if (this._dom.qualityHd) {
      this._dom.qualityHd.classList.toggle('active', !inPlayback && current === 'hd');
      this._dom.qualityHd.classList.toggle('loading', loading === 'hd');
    }
    this._qualityToggle.classList.toggle('hd-active', current === 'hd' && !inPlayback);

    // ── Grid HUD: .ghud-q-sd / .ghud-q-hd / .ghud-q-res ──
    if (this._dom.ghudQSd) {
      this._dom.ghudQSd.style.display = inPlayback ? 'none' : '';
      this._dom.ghudQSd.classList.toggle('active', !inPlayback && current === 'sd' && !loading);
      this._dom.ghudQSd.classList.toggle('loading', loading === 'sd');
    }
    if (this._dom.ghudQHd) {
      this._dom.ghudQHd.style.display = inPlayback ? 'none' : '';
      this._dom.ghudQHd.classList.toggle('active', !inPlayback && current === 'hd');
      this._dom.ghudQHd.classList.toggle('loading', loading === 'hd');
    }
    if (this._dom.ghudQRes) {
      if (inPlayback) {
        const res = playbackRes || 'original';
        this._dom.ghudQRes.textContent = res === 'original' ? 'SRC' : res;
        this._dom.ghudQRes.style.display = 'inline-block';
      } else {
        this._dom.ghudQRes.style.display = 'none';
      }
    }
  }

  /** Render audio state to all HUD elements (fullscreen + grid). */
  _renderAudio() {
    const { available, unmuted } = this._state.audio;
    this._audioIcon.classList.toggle('has-audio', available);
    this._audioIcon.classList.toggle('unmuted', unmuted);
    this._ghudAudio?.classList.toggle('has-audio', available);
    this._ghudAudio?.classList.toggle('unmuted', unmuted);
  }

  /** Update audio state and re-render. */
  _setAudioUnmuted(on) {
    this._state.audio.unmuted = on;
    this._renderAudio();
  }

  /** Get audio intent. */
  get audioUnmuted() { return this._state.audio.unmuted; }

  // ── Talkback (push-to-talk) ──

  /** Render PTT button visibility based on talkback state. */
  _renderTalkback() {
    const { available, connecting, active, locked } = this._state.talkback;
    const isOn = active || locked;

    // Large PTT overlay button
    const ptt = this._dom.ptt;
    if (ptt) {
      ptt.classList.toggle('has-talkback', available);
      ptt.classList.toggle('connecting', connecting);
      ptt.classList.toggle('active', active && !locked);
      ptt.classList.toggle('locked', locked);
    }

    // Red border on cam cell
    this.el.classList.toggle('ptt-active', isOn);

    // Top-right mic status indicator (visible in both grid + fullscreen)
    const micStatus = this._dom.micStatus;
    if (micStatus) {
      micStatus.classList.toggle('has-talkback', available);
      micStatus.classList.toggle('connecting', connecting);
      micStatus.classList.toggle('active', isOn);
    }

    // Grid HUD mic indicator
    const ghudMic = this._dom.ghudMic;
    if (ghudMic) {
      ghudMic.classList.toggle('has-talkback', available);
      ghudMic.classList.toggle('connecting', connecting);
      ghudMic.classList.toggle('active', isOn);
    }
  }

  /** Start PTT timer display. */
  _startPttTimer() {
    this._talkbackStartTime = Date.now();
    const timer = this._dom.pttTimer;
    if (!timer) return;
    timer.textContent = '0:00';
    this._talkbackTimerInterval = setInterval(() => {
      const sec = Math.floor((Date.now() - this._talkbackStartTime) / 1000);
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      timer.textContent = `${m}:${String(s).padStart(2, '0')}`;
    }, 500);
  }

  /** Stop PTT timer. */
  _stopPttTimer() {
    clearInterval(this._talkbackTimerInterval);
    this._talkbackTimerInterval = null;
    this._talkbackStartTime = null;
  }

  /**
   * Start push-to-talk: get mic, create WebRTC to go2rtc backchannel stream.
   * Called on mousedown/touchstart of PTT button, or toggle via hotkey/dblclick.
   * @param {boolean} lock - if true, stay on until explicitly stopped (toggle mode)
   */
  async startTalkback(lock = false) {
    if (this._state.talkback.active || this._state.talkback.connecting || !this._state.talkback.available) return;

    // Show connecting spinner immediately
    this._state.talkback.connecting = true;
    this._renderTalkback();

    // 1. Request stream from backend
    if (!this.onTalkbackStart) { this._resetTalkbackState(); return; }
    let streamName;
    try {
      streamName = await this.onTalkbackStart(this);
    } catch (e) {
      console.error(`[talkback] ${this.id}: backend start failed:`, e.message);
      this._resetTalkbackState();
      return;
    }
    if (!streamName) { this._resetTalkbackState(); return; }
    this._talkbackStream = streamName;

    // 2. Get microphone
    let micStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (e) {
      console.error(`[talkback] ${this.id}: mic access denied:`, e.message);
      if (this.onTalkbackStop) this.onTalkbackStop(this);
      this._talkbackStream = null;
      this._resetTalkbackState();
      return;
    }

    // 3. Create WebRTC peer connection to go2rtc
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      this._talkbackPc = pc;

      for (const track of micStream.getAudioTracks()) {
        pc.addTrack(track, micStream);
      }
      pc.addTransceiver('video', { direction: 'recvonly' });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      if (pc.iceGatheringState !== 'complete') {
        await new Promise((resolve) => {
          const check = () => { if (pc.iceGatheringState === 'complete') resolve(); };
          pc.onicegatheringstatechange = check;
          setTimeout(resolve, 3000);
        });
      }

      const go2rtcApi = window.__okoConfig?.go2rtc_api || '/api';
      const res = await fetch(`${go2rtcApi}/webrtc?src=${encodeURIComponent(streamName)}`, {
        method: 'POST',
        body: pc.localDescription.sdp,
      });
      if (!res.ok) throw new Error(`go2rtc ${res.status}`);
      const sdp = await res.text();
      await pc.setRemoteDescription({ type: 'answer', sdp });

      // Connected
      this._state.talkback.connecting = false;
      this._state.talkback.active = true;
      this._state.talkback.locked = lock;
      this._renderTalkback();
      this._startPttTimer();

      // Auto-enable camera audio so user hears the other side
      if (this._state.audio.available && !this._state.audio.unmuted) {
        this.video.muted = false;
        this._setAudioUnmuted(true);
      }

      console.log(`[talkback] ${this.id}: active${lock ? ' (locked)' : ''} → ${streamName}`);

    } catch (e) {
      console.error(`[talkback] ${this.id}: WebRTC failed:`, e.message);
      this._cleanupTalkback();
    }
  }

  /** Reset connecting state without full cleanup. */
  _resetTalkbackState() {
    this._state.talkback.connecting = false;
    this._renderTalkback();
  }

  /** Toggle talkback on/off (lock mode). */
  toggleTalkback() {
    if (this._state.talkback.active || this._state.talkback.locked) {
      this.stopTalkback(true);
    } else {
      this.startTalkback(true);
    }
  }

  /** Stop push-to-talk: close WebRTC, stop mic, cleanup backend stream.
   *  @param {boolean} force - stop even if locked (used by toggle and disable) */
  stopTalkback(force = false) {
    // In locked mode, only stop if forced (toggle/disable/hotkey)
    if (this._state.talkback.locked && !force) return;
    if (!this._state.talkback.active && !this._state.talkback.connecting && !this._talkbackPc) return;
    console.log(`[talkback] ${this.id}: stopping`);
    this._cleanupTalkback();
    if (this.onTalkbackStop) this.onTalkbackStop(this);
  }

  /** Internal cleanup — close PC, stop mic tracks, reset all state. */
  _cleanupTalkback() {
    this._stopPttTimer();
    if (this._talkbackPc) {
      for (const sender of this._talkbackPc.getSenders()) {
        sender.track?.stop();
      }
      this._talkbackPc.close();
      this._talkbackPc = null;
    }
    this._talkbackStream = null;
    this._state.talkback.connecting = false;
    this._state.talkback.active = false;
    this._state.talkback.locked = false;
    this._renderTalkback();
  }

  /** Set quality loading state (called on click, before API). */
  _setQualityLoading(target) {
    this._state.quality.loading = target; // 'sd' | 'hd'
    this._renderQuality();
  }

  /** Finalize quality after stream connects (called from _hideLoading). */
  _finalizeQuality() {
    const { pending } = this._state.quality;
    if (pending) {
      this._state.quality.current = pending;
      this._state.quality.pending = null;
    }
    this._state.quality.loading = null;

    // Defensive: sync state with actual active player.
    // Catches any race condition where pending was lost/consumed prematurely.
    if (!this.isPlayback) {
      const actualHd = this._activePlayer === this._hdPlayer;
      if (actualHd && this._state.quality.current !== 'hd') {
        this._state.quality.current = 'hd';
      } else if (!actualHd && this._state.quality.current !== 'sd') {
        this._state.quality.current = 'sd';
      }
    }

    this._renderQuality();
  }

  /** Cancel loading animation on error — revert to current quality. */
  cancelQualityLoading() {
    this._state.quality.loading = null;
    this._state.quality.pending = null;
    this._renderQuality();
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
    if (!this.isPlayback) this._startLiveTimer();
  }

  /** Stop ALL streaming (SD + HD + playback) and mark disabled. */
  disable() {
    clearInterval(this._nowMarkerTimer);
    this._stopLiveTimer();
    this.stopPlaybackTimer();
    this._cleanupTalkback();
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
        const hasFreezeFrame = this._dom.freeze?.classList.contains('visible');
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
    const img = this._dom.freeze;
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
    const img = this._dom.freeze;
    if (img) {
      img.classList.remove('visible');
      img.src = '';
    }
  }

  /** @type {Date|null} Position saved when archive was paused. */
  _pausedPosition = null;

  _showPauseIndicator(state) {
    const ind = this._dom.pauseIndicator;
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
    const fsName = this._dom.seekInfoName;
    if (fsName) fsName.textContent = this.id;

    if (!this.isPlayback) {
      // LIVE mode: green accent, update time
      this.el.classList.add('fs-live');
      this._seekCursorFraction = undefined;
      const recText = this._dom.seekInfoRecText;
      if (recText) recText.textContent = 'LIVE';
      this._updateLiveTime(); // immediate update — timer already running from grid
    } else {
      this.el.classList.remove('fs-live');
    }

    // Restore playback panel if it was open before
    if (this._panelWasOpen) {
      const panel = this._dom.playbackPanel;
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

  /**
   * Update LIVE time for both grid and fullscreen HUD.
   * Single timer drives both — no duplicate new Date()/daySeconds.
   */
  _updateLiveTime() {
    const now = new Date();
    const pct = `${_daySeconds(now) / 86400 * 100}%`;
    const timeStr = _hms(now);

    // Grid HUD (always active in LIVE mode)
    if (this._dom.ghudFill) this._dom.ghudFill.style.width = pct;
    if (this._dom.ghudCursor) this._dom.ghudCursor.style.left = pct;
    if (this._dom.ghudTime) this._dom.ghudTime.textContent = timeStr;

    // Fullscreen HUD (only when in fullscreen)
    if (this._dom.seekInfoTime) this._dom.seekInfoTime.textContent = timeStr;
    if (this._dom.seekInfoDate) this._dom.seekInfoDate.textContent = _dmy(now);
    if (this._dom.seekFill) this._dom.seekFill.style.width = pct;
    if (this._dom.seekCursor) this._dom.seekCursor.style.left = pct;
  }

  /** Start LIVE timer — drives both grid and fullscreen HUD. */
  _startLiveTimer() {
    this._stopLiveTimer();
    const recLabel = this._dom.ghudRecLabel;
    if (recLabel) recLabel.textContent = 'LIVE';
    this._updateLiveTime();
    this._liveTimer = setInterval(() => this._updateLiveTime(), 1000);
  }

  /** Stop LIVE timer. */
  _stopLiveTimer() {
    clearInterval(this._liveTimer);
    this._liveTimer = null;
  }

  /** Exit in-page fullscreen mode. */
  exitFullscreen({ keepZoom = false } = {}) {
    this.el.classList.remove('fullscreen');
    this.el.classList.remove('fs-live');
    // Note: _liveTimer keeps running — grid HUD still needs updates
    // Save and close playback panel
    const panel = this._dom.playbackPanel;
    this._panelWasOpen = panel && panel.classList.contains('open');
    if (panel) panel.classList.remove('open');
    const pbBtn = this._dom.playbackBtn;
    if (pbBtn) pbBtn.classList.remove('active');

    // Pause: always preserve state. Resume only via explicit togglePause.
    // Just hide the indicator (enterFullscreen will restore it).
    const ind = this._dom.pauseIndicator;
    if (ind) ind.classList.remove('visible');

    // Mute audio on exit — unless talkback is active (need to hear the other side)
    if (!this._state.talkback.active && !this._state.talkback.locked) {
      this.video.muted = true;
      this._setAudioUnmuted(false);
    }
    this._infoTooltip.classList.remove('visible');
    if (keepZoom) {
      // Hide zoom visuals but preserve _zoom state for later
      this.video.style.transform = '';
      this.video.style.transformOrigin = '';
      const freeze = this._dom.freeze;
      if (freeze) { freeze.style.transform = ''; freeze.style.transformOrigin = ''; }
      this.el.classList.remove('cam-zoomed');
      clearInterval(this._minimapTimer);
      this._minimapTimer = null;
      const mm = this._dom.minimap;
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
    this._wirePlayer(this._hdPlayer, 'hd');

    const useMSE = forceMSE && !CamPlayer.h265WebRTCSupported;
    this._switchPlayer(this._hdPlayer, useMSE ? 'mse' : 'start');

    // State: pending HD, will finalize in _hideLoading
    this._state.quality.pending = 'hd';
    this._renderQuality();
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

    // State: pending SD, will finalize in _hideLoading
    this._state.quality.pending = 'sd';
    this._renderQuality();
  }

  /** Whether currently in HD mode. */
  get isHd() { return !!this._hdStream; }

  /** @returns {string|null} HD stream name (for backend cleanup). */
  get hdStreamName() { return this._hdStream; }

  /** @returns {Date|null} Position where playback was paused. */
  get pausedPosition() { return this._pausedPosition; }

  /** @param {Date|null} val */
  set pausedPosition(val) { this._pausedPosition = val; }

  /**
   * Destroy playback player and stream ref — video stays on freeze frame.
   * Called from app.js when archive paused (stream destroyed to free NVR resources).
   */
  destroyPlaybackPlayer() {
    if (this._playbackPlayer) {
      this._playbackPlayer.disable();
      this._playbackPlayer = null;
    }
    this._playbackStream = null;
  }

  /** Reset digital zoom to 1x. */
  resetZoom() { this._resetZoom(); }

  /** Toggle playback panel open/closed. */
  togglePlaybackPanel() {
    this._dom.playbackBtn.click();
  }

  /** Switch live stream to a different go2rtc stream (e.g. transcoded). */
  switchToStream(newStreamName) {
    this._transcodeStream = newStreamName;
    this.player = new CamPlayer(this.video, newStreamName);
    this._wirePlayer(this.player, 'sd');
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
    const dots = this._dom.loadingDots;
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
    this._finalizeQuality();
    // Fade out snapshot overlay once real video is playing
    if (this._snapshot && !this._snapshot.classList.contains('loaded')) {
      this._snapshot.classList.add('loaded');
      console.log(`[snapshot] ${this.id}: fading out (video playing)`);
    }
    // Restore audio to match HUD state after stream reconnect
    this.restoreAudio();
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
      this._setAudioUnmuted(this._state.audio.available);
      this._showPauseIndicator('play');
    };
    this.el.addEventListener('click', handler, { once: true, capture: true });
  }

  /** Try to unmute; if autoplay policy blocks it, defer to first user click. */
  _tryUnmute() {
    const hasAudio = this._state.audio.available;
    if (!hasAudio) return;

    this.video.muted = false;
    const p = this.video.play();
    if (p && p.catch) {
      p.catch(() => {
        // Autoplay policy: no user interaction yet — stay muted, unmute on first click
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

  /**
   * Restore audio to match HUD state after stream reconnect.
   * Called from _hideLoading — new player always sets muted=true.
   */
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

  /** Re-cache quality DOM refs after innerHTML rebuild (playback mode transitions). */
  _recacheQualityDom() {
    this._dom.qualitySd = this._qualityToggle.querySelector('.quality-sd');
    this._dom.qualityHd = this._qualityToggle.querySelector('.quality-hd');
    this._dom.qualityRes = this._qualityToggle.querySelector('.quality-res');
  }

  /** Poll until video actually has frames, then hide loading. */
  _startRenderCheck() {
    this._stopRenderCheck();
    this._renderCheckTimer = setInterval(() => {
      if (this.video.videoWidth > 0 && this.video.videoHeight > 0) {
        const hasFreezeFrame = this._dom.freeze?.classList.contains('visible');
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
      const infoInline = this._dom.infoInline;
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
  onHdError = null;

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

  /**
   * Called when PTT button pressed. Should call api.startTalkback() and return stream name.
   * @type {(camera: CameraView) => Promise<string>}
   */
  onTalkbackStart = null;

  /**
   * Called when PTT button released. Should call api.stopTalkback().
   * @type {(camera: CameraView) => void}
   */
  onTalkbackStop = null;

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
    // Stop intercom — not available in archive mode
    if (this._state.talkback.active || this._state.talkback.locked) {
      this.stopTalkback(true);
    }
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

    // track position
    this._playbackDate = new Date(startTime);
    this._playbackDate.setHours(0, 0, 0, 0); // midnight of that day
    this._playbackOffset = (startTime - this._playbackDate) / 1000;
    this._playbackStart = new Date();
    this._updateDateLabel();

    this._showLoading('loading archive');
    this._playbackPlayer = new CamPlayer(this.video, streamName, { preferH265: forceMSE });
    this._wirePlayer(this._playbackPlayer, 'playback');

    // HEVC streams: use MSE when browser lacks H.265 WebRTC support.
    // CamPlayer.globalForceMSE (config) is handled inside start() for all streams.
    const useMSE = forceMSE && !CamPlayer.h265WebRTCSupported;

    // Atomic switch: stops old player, starts playback
    this._switchPlayer(this._playbackPlayer, useMSE ? 'mse' : 'start');

    this.el.classList.add('playback-mode');

    // Stop LIVE grid timer, switch to archive labels
    this._stopLiveTimer();
    const ghudRecLabel = this._dom.ghudRecLabel;
    if (ghudRecLabel) ghudRecLabel.textContent = 'REC';

    // Switch fullscreen HUD from LIVE to ARCHIVE mode
    this.el.classList.remove('fs-live');
    const fsName = this._dom.seekInfoName;
    if (fsName) fsName.textContent = this.id;
    const fsRecText = this._dom.seekInfoRecText;
    if (fsRecText) fsRecText.textContent = 'REC';

    // Real-time now marker update (moves the "now" line on today's timeline)
    clearInterval(this._nowMarkerTimer);
    this._nowMarkerTimer = setInterval(() => this._updateSeekAvailability(), 30000);

    // Show resolution instead of SD/HD toggle
    this._qualityToggle.dataset.mode = 'playback';
    this._qualityToggle.innerHTML = `<span class="quality-res">${resolution === 'original' ? 'SRC' : resolution}</span>`;
    this._recacheQualityDom();
    this._state.quality.playbackRes = resolution;
    this._renderQuality();

    // Update button states: Play=active(green "Stop"), Live=hint(pulsing "go live")
    const goBtn = this._dom.pbGo;
    const liveBtn = this._dom.pbLive;
    goBtn.innerHTML = '&#9632; Stop';
    goBtn.classList.add('active');
    liveBtn.classList.remove('active');
    liveBtn.classList.add('return-hint');
    liveBtn.innerHTML = '&#9654; Live';

    // restore resolution dropdown and datetime picker to current values
    const select = this._dom.pbResolution;
    if (select) select.value = resolution;

    const startInput = this._dom.pbStart;
    const endInput = this._dom.pbEnd;
    if (startInput) startInput.value = _fmtInput(startTime);
    if (endInput) endInput.value = _fmtInput(endTime);

    // show seek timeline and start updating position
    this._dom.seekTimeline.classList.add('active');
    this._startPositionTimer();
    this._renderQuality();
  }

  /** Switch back to live. */
  stopPlayback() {
    this._awaitingUserPlay = false;
    this.stopPlaybackTimer();
    clearInterval(this._nowMarkerTimer);
    this._clearFreezeFrame();
    this._pausedPosition = null;
    this.el.classList.remove('paused');
    const ind = this._dom.pauseIndicator;
    if (ind) ind.classList.remove('visible');
    if (this._playbackPlayer) {
      this._playbackPlayer.disable();
      this._playbackPlayer = null;
    }
    this._playbackStream = null;
    this._playbackDate = null;
    this._playbackStart = null;
    this.el.classList.remove('playback-mode');
    this._dom.seekTimeline.classList.remove('active');

    // Restore fullscreen HUD to LIVE mode if in fullscreen
    if (this.el.classList.contains('fullscreen')) {
      this.el.classList.add('fs-live');
      const recText = this._dom.seekInfoRecText;
      if (recText) recText.textContent = 'LIVE';
    }

    // Restore SD/HD toggle
    this._qualityToggle.dataset.mode = '';
    this._qualityToggle.innerHTML = '<span class="quality-opt quality-sd active">SD</span><span class="quality-opt quality-hd">HD</span>';
    this._recacheQualityDom();

    // Reset button states: Play=default, Live=active(green)
    const goBtn = this._dom.pbGo;
    const liveBtn = this._dom.pbLive;
    goBtn.innerHTML = '&#9654; Play';
    goBtn.classList.remove('active');
    liveBtn.classList.remove('return-hint');
    liveBtn.classList.add('active');
    liveBtn.innerHTML = '&#9673; Live';

    // Atomic switch back to SD live
    this._switchPlayer(this.player);

    // Restart LIVE grid HUD timer
    this._startLiveTimer();

    // Reset quality state to SD
    this._state.quality.current = 'sd';
    this._state.quality.loading = null;
    this._state.quality.pending = null;
    this._state.quality.playbackRes = null;
    this._renderQuality();
  }

  stopPlaybackTimer() {
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
  get playbackResolution() { return this._state.quality.playbackRes || 'original'; }

  _startPositionTimer() {
    this._positionTimer = setInterval(() => this._updateSeekPosition(), 500);
    this._updateSeekPosition();
  }

  _updateSeekPosition() {
    const pos = this.playbackPosition;
    if (!pos) return;

    const secondsInDay = 24 * 3600;
    const currentSeconds = _daySeconds(pos);
    const fraction = Math.min(currentSeconds / secondsInDay, 1);
    this._seekCursorFraction = fraction;

    const fill = this._dom.seekFill;
    const cursor = this._dom.seekCursor;
    const cursorLine = this._dom.seekCursorLine;
    const cursorTime = this._dom.seekCursorTime;
    fill.style.width = `${fraction * 100}%`;
    cursor.style.left = `${fraction * 100}%`;
    cursorLine.style.left = `${fraction * 100}%`;
    cursorTime.style.left = `${fraction * 100}%`;

    // Update now marker + unavailable zone (only for today)
    this._updateSeekAvailability();

    // Update cursor time label
    const timeStr = _hms(pos);
    cursorTime.textContent = timeStr;
    const dateStr = _dm(pos);
    this._renderPlaybackBadge(timeStr, dateStr);

    // Update fullscreen HUD info row
    const fsTime = this._dom.seekInfoTime;
    const fsDateFull = this._dom.seekInfoDate;
    if (fsTime) fsTime.textContent = timeStr;
    if (fsDateFull) fsDateFull.textContent = _dmy(pos);

    // Update grid HUD
    const ghudFill = this._dom.ghudFill;
    const ghudCursor = this._dom.ghudCursor;
    const ghudTime = this._dom.ghudTime;
    if (ghudFill) ghudFill.style.width = `${fraction * 100}%`;
    if (ghudCursor) ghudCursor.style.left = `${fraction * 100}%`;
    if (ghudTime) ghudTime.textContent = timeStr;
  }

  /** Update the date label on the seek timeline. */
  _updateDateLabel() {
    const d = this._playbackDate;
    const now = new Date();
    const isToday = d && d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate();
    const days = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'];

    // Fullscreen seek-timeline date label
    const label = this._dom.seekDateLabel;
    if (label) {
      if (!d) { label.innerHTML = ''; }
      else {
        const weekday = days[d.getDay()];
        label.innerHTML = `<span class="seek-date-weekday">${weekday}</span>${_dm(d)}`;
        label.classList.toggle('is-today', isToday);
      }
    }
    const nextBtn = this._dom.seekDayNext;
    if (nextBtn) nextBtn.classList.toggle('disabled', isToday);

    // Grid HUD date label
    const ghudDate = this._dom.ghudDate;
    if (ghudDate) {
      if (!d) { ghudDate.textContent = ''; }
      else {
        const weekday = days[d.getDay()];
        ghudDate.textContent = `${weekday} ${_dm(d)}`;
        ghudDate.classList.toggle('is-today', isToday);
      }
    }
    const ghudNext = this._dom.ghudDayNext;
    if (ghudNext) ghudNext.classList.toggle('disabled', isToday);
  }

  /** Show/hide unavailable zone and now marker based on playback date. */
  _updateSeekAvailability() {
    // Fullscreen seek-timeline elements
    const unavailable = this._dom.seekUnavailable;
    const nowMarker = this._dom.seekNow;
    const nowLabel = this._dom.seekNowLabel;
    // Grid HUD elements
    const ghudUnavail = this._dom.ghudUnavailable;
    const ghudNow = this._dom.ghudNow;

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
    const availSeconds = _daySeconds(availableUntil);
    const availFraction = Math.min(availSeconds / (24 * 3600), 1);

    const nowSeconds = _daySeconds(now);
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
      nowLabel.textContent = _hm(now);
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

  /** Render playback mode badge with optional time/date. */
  _renderPlaybackBadge(timeStr, dateStr) {
    if (timeStr && dateStr) {
      this._modeBadge.innerHTML = `<span class="rec-dot">● REC</span><span class="rec-time">${timeStr}</span><span class="rec-date">${dateStr}</span>`;
    } else {
      this._modeBadge.innerHTML = `<span class="rec-dot">● REC</span>`;
    }
    this._modeBadge.className = 'cam-mode playback';
  }

  /** Update badge during playback with mode info. */
  _updatePlaybackBadge(mode) {
    const pos = this.playbackPosition;
    this._renderPlaybackBadge(pos ? _hm(pos) : null, pos ? _dm(pos) : null);
  }

  /** When datetime/resolution changes during archive: revert Play button, highlight changed control + Play. */
  _markPendingChange(changedEl) {
    if (!this.isPlayback) return;

    // Revert Stop → Play
    const goBtn = this._dom.pbGo;
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
    const freeze = this._dom.freeze;
    if (freeze) {
      freeze.style.transform = transform;
      freeze.style.transformOrigin = origin;
    }

    this.el.classList.toggle('cam-zoomed', scale > 1);

    // Zoom level badge in top bar
    const badge = this._dom.zoomBadge;
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
    const minimap = this._dom.minimap;
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
    const vp = this._dom.minimapViewport;
    const rect = this.el.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const canvas = this._dom.minimapCanvas;
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
    const canvas = this._dom.minimapCanvas;
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
    const mm = this._dom.minimap;
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
    const minimap = this._dom.minimap;
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
        const canvas = this._dom.minimapCanvas;
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
    this._dom.quickMenu?.remove();
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
          <div class="cam-audio-wrap" title="Toggle audio — click to unmute">
            <svg class="cam-audio" viewBox="0 0 24 24" fill="white">
              <path d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77zM16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM3 9v6h4l5 5V4L7 9H3z"/>
            </svg>
          </div>
          <div class="cam-mic-status" title="Intercom — click to toggle (T)">
            <svg viewBox="0 0 24 24" fill="white">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
            </svg>
          </div>
          <div class="cam-quality-toggle" title="Toggle SD/HD stream (H)">
            <span class="quality-opt quality-sd active">SD</span>
            <span class="quality-opt quality-hd">HD</span>
          </div>
          <svg class="cam-playback-btn" viewBox="0 0 24 24" fill="white" title="Archive playback panel">
            <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/>
          </svg>
        </div>
        <div class="cam-badges">
          <span class="cam-mode"></span>
          <div class="cam-status"></div>
        </div>
      </div>
      <div class="cam-ptt" title="Push to talk — hold to speak">
        <div class="cam-ptt-circle">
          <svg viewBox="0 0 24 24" fill="white">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
          </svg>
        </div>
        <span class="cam-ptt-timer">0:00</span>
      </div>
      <div class="cam-playback-panel">
        <div class="playback-row">
          <input type="datetime-local" class="playback-start" title="Playback start time">
          <span class="playback-sep">&rarr;</span>
          <input type="datetime-local" class="playback-end" title="Playback end time">
        </div>
        <div class="playback-row">
          <select class="playback-resolution" title="Video resolution for playback">
            <option value="original">SRC</option>
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
        <div class="seek-thumb-dot">
          <svg class="seek-thumb-ring" viewBox="0 0 20 20">
            <circle cx="10" cy="10" r="8.5" class="seek-ring-bg"/>
            <circle cx="10" cy="10" r="8.5" class="seek-ring-fill"/>
          </svg>
        </div>
        <div class="seek-thumbnail">
          <div class="seek-thumb-progress"></div>
          <img alt="">
          <div class="seek-thumb-spinner"><div></div></div>
          <div class="seek-thumb-time"></div>
        </div>
        <div class="seek-thumb-marker"></div>
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
          <span class="ghud-pill">
            <span class="ghud-name">${this.id}</span>
            <div class="ghud-audio-wrap">
              <svg class="ghud-audio" viewBox="0 0 24 24" fill="white">
                <path d="M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77zM16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM3 9v6h4l5 5V4L7 9H3z"/>
              </svg>
            </div>
            <div class="ghud-mic-wrap">
              <svg class="ghud-mic" viewBox="0 0 24 24" fill="white">
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
              </svg>
            </div>
          </span>
          <span class="ghud-status">
            <span class="ghud-rec-dot"></span>
            <span class="ghud-rec-label">REC</span>
            <span class="ghud-time"></span>
          </span>
          <span class="ghud-spacer"></span>
          <button class="ghud-day-prev">◂</button>
          <span class="ghud-date"></span>
          <button class="ghud-day-next">▸</button>
          <div class="ghud-quality">
            <span class="ghud-q-sd active">SD</span>
            <span class="ghud-q-hd">HD</span>
            <span class="ghud-q-res"></span>
          </div>
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

  /**
   * Wire CamPlayer callbacks to CameraView DOM updates.
   * Called for SD, HD, and Playback players — mode determines badge text.
   * @param {CamPlayer} player
   * @param {'sd'|'hd'|'playback'} mode
   */
  _wirePlayer(player, mode) {
    player.onStatusChange = (online) => {
      this._statusDot.classList.toggle('live', online);
      if (mode === 'sd') {
        this.timeline.push({ time: Date.now(), online });
        if (this.onStatusChange) this.onStatusChange(this, online);
      }
    };

    player.onModeChange = (transport) => {
      if (mode === 'playback') {
        this._modeBadge.className = 'cam-mode playback';
        this._updatePlaybackBadge(transport);
      } else {
        const suffix = mode === 'hd' ? ' HD' : '';
        this._modeBadge.textContent = `${transport.toUpperCase()} ●LIVE${suffix}`;
        this._modeBadge.className = `cam-mode ${transport}`;
      }
    };

    player.onStage = (stage) => {
      if (stage === 'playing') {
        this._hideLoading();
      } else {
        this._showLoading(stage);
      }
    };

    // Error/recovery callbacks
    if (mode === 'sd') {
      player.onNeedTranscode = () => {
        if (this.onNeedTranscode) this.onNeedTranscode(this);
      };
      player.onConnectionError = () => {
        if (this.onConnectionError) this.onConnectionError(this);
      };
      player.onStreamNotFound = () => {
        if (this.onStreamNotFound) this.onStreamNotFound(this);
      };
    } else if (mode === 'hd') {
      // HD connection failed — auto-fallback to SD, notify app to clean up backend stream
      player.onConnectionError = () => {
        console.warn(`[camera-view] ${this.id}: HD connection error, falling back to SD`);
        this._hdPlayer?.disable();
        this._hdPlayer = null;
        const failedStream = this._hdStream;
        this._hdStream = null;
        this._state.quality.current = 'sd';
        this._state.quality.loading = null;
        this._state.quality.pending = null;
        this._switchPlayer(this.player);
        this._renderQuality();
        if (this.onHdError) this.onHdError(this, failedStream);
      };
      player.onStreamNotFound = () => {
        console.warn(`[camera-view] ${this.id}: HD stream lost, falling back to SD`);
        player.onConnectionError();
      };
    } else if (mode === 'playback') {
      player.onConnectionError = () => {
        console.warn(`[camera-view] ${this.id}: playback connection error`);
        this._showLoading('connection error');
      };
    }
  }

  _bindDOMEvents() {
    // click → fullscreen toggle (or Ctrl+click → select for investigation)
    this.el.addEventListener('click', (e) => {
      if (e.target.closest('.cam-quality-toggle')) return;
      if (e.target.closest('.cam-playback-btn')) return;
      if (e.target.closest('.cam-playback-panel')) return;
      if (e.target.closest('.cam-audio-wrap')) return;
      if (e.target.closest('.cam-mic-status')) return;
      if (e.target.closest('.cam-ptt')) return;
      if (e.target.closest('.cam-select')) return;
      if (e.target.closest('.cam-grid-hud')) return;
      if (e.target.closest('.ghud-live-btn')) return;
      if (e.target.closest('.ghud-audio-wrap')) return;
      if (e.target.closest('.ghud-mic-wrap')) return;
      if (e.target.closest('.seek-info-row')) return;
      if ((e.ctrlKey || e.metaKey) && !this.el.classList.contains('fullscreen')) {
        this.toggleSelect();
        return;
      }
      if (this.onClick) this.onClick(this);
    });

    // Checkbox click → toggle selection
    this._dom.selectBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleSelect();
    });

    // double-click → native fullscreen (grid), pause (in-page fullscreen)
    this.el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (e.target.closest('.cam-playback-panel')) return;
      if (e.target.closest('.cam-grid-hud')) return;
      if (e.target.closest('.cam-ptt')) return;
      if (e.target.closest('.cam-mic-status')) return;
      if (e.target.closest('.ghud-live-btn')) return;
      if (e.target.closest('.ghud-audio-wrap')) return;
      if (e.target.closest('.ghud-mic-wrap')) return;
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
      if (!this._state.audio.available) return;
      if (CameraView.globalMute) CameraView.globalMute = false;
      this.video.muted = !this.video.muted;
      this._setAudioUnmuted(!this.video.muted);
    });

    // Top-right mic status — click to toggle intercom
    const micStatus = this._dom.micStatus;
    if (micStatus) {
      micStatus.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this._state.talkback.available) return;
        this.toggleTalkback();
      });
      micStatus.addEventListener('mousedown', (e) => { e.stopPropagation(); });
      micStatus.addEventListener('dblclick', (e) => { e.stopPropagation(); });
    }

    // PTT (push-to-talk) — hold to speak, double-click to lock
    const ptt = this._dom.ptt;
    if (ptt) {
      const pttDown = (e) => {
        e.stopPropagation();
        e.preventDefault();
        // If locked, any press stops it
        if (this._state.talkback.locked) {
          this.stopTalkback(true);
          return;
        }
        this.startTalkback(false);
      };
      const pttUp = (e) => {
        e.stopPropagation();
        this.stopTalkback(); // respects locked — won't stop if locked
      };
      ptt.addEventListener('mousedown', pttDown);
      ptt.addEventListener('touchstart', pttDown, { passive: false });
      ptt.addEventListener('mouseup', pttUp);
      ptt.addEventListener('mouseleave', pttUp);
      ptt.addEventListener('touchend', pttUp);
      ptt.addEventListener('touchcancel', pttUp);
      // Double-click: toggle lock mode
      ptt.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.toggleTalkback();
      });
    }

    // SD/HD quality toggle
    this._qualityToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.isPlayback) return;
      const clickedOpt = e.target.closest('.quality-opt');
      if (!clickedOpt) return;
      const wantHd = clickedOpt.classList.contains('quality-hd');
      if (wantHd === (this._state.quality.current === 'hd')) return;
      this._setQualityLoading(wantHd ? 'hd' : 'sd');
      if (this.onHdToggle) this.onHdToggle(this, wantHd);
    });

    // Playback button — toggle panel
    const playbackBtn = this._dom.playbackBtn;
    // Stop mousedown on entire playback panel to prevent fullscreen toggle on long press
    this._dom.playbackPanel.addEventListener('mousedown', (e) => e.stopPropagation());
    playbackBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const panel = this._dom.playbackPanel;
      panel.classList.toggle('open');
      playbackBtn.classList.toggle('active', panel.classList.contains('open'));

      // pre-fill: start = 1 hour ago, end = 23:59 same day
      if (panel.classList.contains('open')) {
        const now = new Date();
        const ago = new Date(now.getTime() - 3600 * 1000);
        const endOfDay = (d) => `${d.getFullYear()}-${_pad(d.getMonth()+1)}-${_pad(d.getDate())}T23:59`;
        this._dom.pbStart.value = _fmtInput(ago);
        this._dom.pbEnd.value = endOfDay(ago);
      }
    });

    // auto-set end to 23:59 of same day when start changes
    this._dom.pbStart.addEventListener('change', (e) => {
      e.stopPropagation();
      const val = e.target.value;
      if (val) {
        const d = new Date(val);
        this._dom.pbEnd.value =
          `${d.getFullYear()}-${_pad(d.getMonth()+1)}-${_pad(d.getDate())}T23:59`;
      }
      this._markPendingChange(e.target);
    });

    this._dom.pbEnd.addEventListener('change', (e) => {
      e.stopPropagation();
      this._markPendingChange(e.target);
    });

    this._dom.pbResolution.addEventListener('change', (e) => {
      e.stopPropagation();
      this._markPendingChange(e.target);
      if (this.isPlayback) {
        this._state.quality.playbackRes = e.target.value;
        this._renderQuality();
      }
    });

    // Play button
    this._dom.pbGo.addEventListener('click', (e) => {
      e.stopPropagation();
      this._clearPendingChange();
      const start = this._dom.pbStart.value;
      const end = this._dom.pbEnd.value;
      const resolution = this._dom.pbResolution.value;
      if (start && end && this.onPlaybackRequest) {
        this.onPlaybackRequest(this, start, end, resolution);
      }
    });

    // Live button
    const liveBtn = this._dom.pbLive;
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
          const endOfDay = new Date(seekTime);
          endOfDay.setHours(23, 59, 59, 0);
          const resolution = this._dom.pbResolution.value;
          this.onPlaybackRequest(this, _fmtFull(seekTime), _fmtFull(endOfDay), resolution);
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
    const seekBar = this._dom.seekBar;
    const seekTooltip = this._dom.seekTooltip;
    const seekDot = this._dom.seekThumbDot;
    const seekRingFill = this._dom.seekRingFill;
    const seekThumb = this._dom.seekThumbnail;
    const seekThumbImg = this._dom.seekThumbImg;
    const seekThumbTime = this._dom.seekThumbTime;
    const seekThumbProgress = this._dom.seekThumbProgress;
    const seekThumbSpinner = this._dom.seekThumbSpinner;
    const seekMarker = this._dom.seekThumbMarker;
    const livePill = this._dom.seekLivePill;
    const cursorDetail = this._dom.seekCursorDetail;
    let thumbDotTimer = null;
    let thumbFetchTimer = null;
    let thumbLastKey = '';
    let thumbState = 'idle';     // idle → dot → loading → pinned
    let thumbPinnedTime = null;  // { hours, minutes } of pinned thumbnail
    let thumbPinnedPct = '';     // CSS left% of pinned position

    const dismissThumb = () => {
      seekDot?.classList.remove('visible');
      seekThumb?.classList.remove('visible', 'pinned');
      seekMarker?.classList.remove('visible');
      clearTimeout(thumbDotTimer);
      clearTimeout(thumbFetchTimer);
      if (this._thumbXHR) { this._thumbXHR.abort(); this._thumbXHR = null; }
      thumbLastKey = '';
      thumbState = 'idle';
      thumbPinnedTime = null;
    };

    // Click thumbnail → seek to that time
    if (seekThumb) {
      seekThumb.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!thumbPinnedTime) return;
        const baseDate = this._playbackDate || (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })();
        const seekDate = new Date(baseDate);
        seekDate.setHours(thumbPinnedTime.hours, thumbPinnedTime.minutes, 0, 0);
        dismissThumb();
        if (this.isPlayback && this.onPlaybackSeek) {
          this.onPlaybackSeek(this, seekDate);
        } else if (this.onPlaybackRequest) {
          const endOfDay = new Date(seekDate); endOfDay.setHours(23, 59, 59, 0);
          this.onPlaybackRequest(this, _fmtFull(seekDate), _fmtFull(endOfDay), 'original');
        }
      });
    }

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
      const timeText = `${_pad(hours)}:${_pad(minutes)}`;
      const cursorTime = this._dom.seekCursorTime;
      const full = this.el.classList.contains('fullscreen');

      const cursorDist = Math.abs(fraction - (this._seekCursorFraction || -1));

      // Fullscreen: show cursor-detail when hovering near cursor (archive only)
      if (full && cursorDetail && !this.el.classList.contains('fs-live')) {
        if (cursorDist < 0.03 && this._seekCursorFraction !== undefined) {
          const pos = this.playbackPosition;
          if (pos) {
            const ct = _hm(pos);
            const now = new Date();
            const diffMs = now - pos;
            const diffMin = Math.floor(Math.abs(diffMs) / 60000);
            const dH = Math.floor(diffMin / 60);
            const dM = diffMin % 60;
            const delta = dH > 0 ? `-${dH}h${_pad(dM)}m` : `-${dM}m`;
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
        if (thumbState !== 'pinned') {
          seekDot?.classList.remove('visible');
          seekThumb?.classList.remove('visible', 'pinned');
          seekMarker?.classList.remove('visible');
          clearTimeout(thumbDotTimer); clearTimeout(thumbFetchTimer);
          thumbState = 'idle';
        }
        livePill.style.left = `${fraction * 100}%`;
        livePill.classList.add('visible');
        return;
      }
      livePill.classList.remove('visible');
      seekTooltip.textContent = timeText;
      seekTooltip.classList.remove('unavailable');
      seekTooltip.style.left = `${fraction * 100}%`;
      seekTooltip.classList.add('visible');

      // Thumbnail preview: works on LIVE (past time = archive) and playback timeline
      const thumbDate0 = this._playbackDate || (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })();
      if (seekDot && seekThumb && !isUnavailable) {
        const key = `${this.id}_${_pad(hours)}${_pad(minutes)}`;
        const pct = `${fraction * 100}%`;

        // When pinned: thumbnail stays at fixed position, only dot/tooltip follow cursor
        if (thumbState === 'pinned') {
          seekDot.style.left = pct;
          // Don't reset — thumb stays at thumbPinnedPct
          return;
        }

        // Position follows cursor for non-pinned states
        seekDot.style.left = pct;
        // Clamp thumbnail so it doesn't overflow seekbar edges
        const barW = seekBar.offsetWidth;
        const thumbW = seekThumb.offsetWidth || 200;
        const halfThumb = thumbW / 2;
        const cursorPx = fraction * barW;
        const clampedPx = Math.max(halfThumb, Math.min(barW - halfThumb, cursorPx));
        seekThumb.style.left = `${clampedPx}px`;

        if (key !== thumbLastKey) {
          // New minute — reset cycle
          thumbLastKey = key;
          thumbState = 'idle';
          seekDot.classList.remove('visible');
          seekThumb.classList.remove('visible', 'pinned');
          seekMarker?.classList.remove('visible');
          if (seekRingFill) { seekRingFill.style.transition = 'none'; seekRingFill.style.strokeDashoffset = '53.4'; }
          if (seekThumbProgress) { seekThumbProgress.style.transition = 'none'; seekThumbProgress.style.width = '0'; }
          if (seekThumbSpinner) seekThumbSpinner.style.display = '';
          if (seekThumbImg) seekThumbImg.style.opacity = '0';
          clearTimeout(thumbDotTimer);
          clearTimeout(thumbFetchTimer);
          if (this._thumbXHR) { this._thumbXHR.abort(); this._thumbXHR = null; }

          const thisHours = hours, thisMinutes = minutes;
          const clampedLeft = seekThumb.style.left; // already clamped

          // 500ms pause → show dot + start fetch immediately (ring = real progress)
          thumbDotTimer = setTimeout(() => {
            if (thumbLastKey !== key) return;
            thumbState = 'loading';
            seekDot.classList.add('visible');
            if (seekThumbTime) seekThumbTime.textContent = `${_pad(thisHours)}:${_pad(thisMinutes)}`;

            // Show marker dot on timeline
            if (seekMarker) {
              seekMarker.style.left = pct;
              seekMarker.classList.add('visible');
            }

            // Reset ring to full offset (empty)
            if (seekRingFill) {
              seekRingFill.style.transition = 'none';
              seekRingFill.style.strokeDashoffset = '53.4';
            }

            // Start fetch
            const thumbDate = new Date(thumbDate0);
            thumbDate.setHours(thisHours, thisMinutes, 0, 0);
            const iso = _fmtFull(thumbDate);

            const xhr = new XMLHttpRequest();
            this._thumbXHR = xhr;
            xhr.open('GET', `/backend/playback-thumbnail/${this.id}?t=${iso}`);
            xhr.responseType = 'blob';

            // Ring progress driven by XHR
            let ringStarted = false;
            xhr.onprogress = (evt) => {
              if (thumbLastKey !== key) return;
              if (evt.lengthComputable && seekRingFill) {
                const p = evt.loaded / evt.total;
                seekRingFill.style.transition = 'stroke-dashoffset 0.2s';
                seekRingFill.style.strokeDashoffset = `${53.4 * (1 - p)}`;
              } else if (!ringStarted && seekRingFill) {
                // No Content-Length — animate ring over 3s as estimate
                ringStarted = true;
                seekRingFill.style.transition = 'stroke-dashoffset 3s linear';
                seekRingFill.style.strokeDashoffset = '5'; // leave 10% gap
              }
            };

            // If no progress events after 100ms, start indeterminate ring
            const ringFallback = setTimeout(() => {
              if (thumbLastKey !== key || ringStarted) return;
              ringStarted = true;
              if (seekRingFill) {
                seekRingFill.style.transition = 'stroke-dashoffset 3s linear';
                seekRingFill.style.strokeDashoffset = '5';
              }
            }, 100);

            xhr.onload = () => {
              clearTimeout(ringFallback);
              this._thumbXHR = null;
              if (thumbLastKey !== key || xhr.status !== 200) return;
              thumbState = 'pinned';
              thumbPinnedTime = { hours: thisHours, minutes: thisMinutes };
              thumbPinnedPct = pct;

              // Complete ring
              if (seekRingFill) {
                seekRingFill.style.transition = 'stroke-dashoffset 0.15s';
                seekRingFill.style.strokeDashoffset = '0';
              }

              // After ring completes → show thumbnail
              setTimeout(() => {
                if (thumbLastKey !== key) return;
                seekDot.classList.remove('visible');
                if (seekThumbSpinner) seekThumbSpinner.style.display = 'none';
                if (seekThumbProgress) { seekThumbProgress.style.transition = 'none'; seekThumbProgress.style.width = '100%'; }
                seekThumb.classList.add('visible', 'pinned');
                const url = URL.createObjectURL(xhr.response);
                if (seekThumbImg) {
                  seekThumbImg.onload = () => URL.revokeObjectURL(url);
                  seekThumbImg.src = url;
                  seekThumbImg.style.opacity = '1';
                }
              }, 200);
            };

            xhr.onerror = () => {
              clearTimeout(ringFallback);
              this._thumbXHR = null;
              if (thumbLastKey !== key) return;
              seekDot.classList.remove('visible');
              seekMarker?.classList.remove('visible');
              thumbState = 'idle';
            };

            xhr.send();
          }, 500);
        }
      }
    });

    seekBar.addEventListener('mouseleave', (e) => {
      // Don't dismiss if mouse moved to the pinned thumbnail
      if (thumbState === 'pinned' && seekThumb?.contains(e.relatedTarget)) return;
      seekTooltip.classList.remove('visible');
      dismissThumb();
      livePill.classList.remove('visible');
      if (cursorDetail) cursorDetail.classList.remove('visible');
    });

    // When mouse leaves thumbnail back to seekbar or away — dismiss
    if (seekThumb) {
      seekThumb.addEventListener('mouseleave', (e) => {
        if (thumbState !== 'pinned') return;
        // If going back to seekbar, let seekbar handle it — don't dismiss yet
        if (seekBar.contains(e.relatedTarget)) return;
        dismissThumb();
      });
    }

    seekBar.addEventListener('click', (e) => {
      e.stopPropagation();
      const { hours, minutes } = getSeekTime(e);

      // LIVE mode: click on bar → start archive at clicked time
      if (!this._playbackDate && this.onPlaybackRequest) {
        const now = new Date();
        const seekTime = new Date(now);
        seekTime.setHours(hours, minutes, 0, 0);
        if (seekTime > now) return; // future
        const endOfDay = new Date(now);
        endOfDay.setHours(23, 59, 59, 0);
        const resolution = this._dom.pbResolution?.value || 'original';
        this.onPlaybackRequest(this, _fmtFull(seekTime), _fmtFull(endOfDay), resolution);
        return;
      }

      if (!this._playbackDate || !this.onPlaybackSeek) return;
      const seekTime = new Date(this._playbackDate);
      seekTime.setHours(hours, minutes, 0, 0);
      // Click in unavailable zone → go to live
      if (this._isSeekUnavailable(seekTime)) {
        const liveBtn = this._dom.pbLive;
        if (liveBtn) liveBtn.click();
        return;
      }
      this.onPlaybackSeek(this, seekTime);
    });

    // Day navigation (◀ ▶) on seek timeline
    this._dom.seekDayPrev.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this._playbackDate || !this.onPlaybackSeek) return;
      const pos = this.playbackPosition;
      const timeOfDay = pos ? (_daySeconds(pos)) : 0;
      const prevDay = new Date(this._playbackDate.getTime() - 86400000);
      prevDay.setHours(0, 0, 0, 0);
      const seekTime = new Date(prevDay.getTime() + timeOfDay * 1000);
      this.onPlaybackSeek(this, seekTime);
    });

    this._dom.seekDayNext.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this._playbackDate || !this.onPlaybackSeek) return;
      const nextDay = new Date(this._playbackDate.getTime() + 86400000);
      nextDay.setHours(0, 0, 0, 0);
      const now = new Date();
      if (nextDay > now) return; // entire day is in future
      const pos = this.playbackPosition;
      const timeOfDay = pos ? (_daySeconds(pos)) : 0;
      let seekTime = new Date(nextDay.getTime() + timeOfDay * 1000);
      // If time-of-day hasn't arrived yet on target day, clamp to 00:00
      if (this._isSeekUnavailable(seekTime)) seekTime = new Date(nextDay);
      this.onPlaybackSeek(this, seekTime);
    });

    // ── Grid HUD: LIVE button (long-press) ──
    const ghudLiveBtn = this._dom.ghudLiveBtn;
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
        const playbackLive = this._dom.pbLive;
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
    const ghudBar = this._dom.ghudBar;
    const ghudTooltip = this._dom.ghudTooltip;

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
        const endOfDay = new Date(now);
        endOfDay.setHours(23, 59, 59, 0);
        const resolution = this._dom.pbResolution?.value || 'original';
        this.onPlaybackRequest(this, _fmtFull(seekTime), _fmtFull(endOfDay), resolution);
        return;
      }

      if (!this._playbackDate || !this.onPlaybackSeek) return;
      const seekTime = new Date(this._playbackDate);
      seekTime.setHours(hours, minutes, 0, 0);
      if (this._isSeekUnavailable(seekTime)) {
        const liveBtn = this._dom.pbLive;
        if (liveBtn) liveBtn.click();
        return;
      }
      this.onPlaybackSeek(this, seekTime);
    });

    ghudBar.addEventListener('mousemove', (e) => {
      e.stopPropagation();
      const { fraction, hours, minutes } = getGhudTime(e);
      const timeText = `${_pad(hours)}:${_pad(minutes)}`;

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
    this._dom.ghudDayPrev.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this._playbackDate || !this.onPlaybackSeek) return;
      const pos = this.playbackPosition;
      const timeOfDay = pos ? (_daySeconds(pos)) : 0;
      const prevDay = new Date(this._playbackDate.getTime() - 86400000);
      prevDay.setHours(0, 0, 0, 0);
      this.onPlaybackSeek(this, new Date(prevDay.getTime() + timeOfDay * 1000));
    });

    this._dom.ghudDayNext.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this._playbackDate || !this.onPlaybackSeek) return;
      const nextDay = new Date(this._playbackDate.getTime() + 86400000);
      nextDay.setHours(0, 0, 0, 0);
      if (nextDay > new Date()) return; // entire day is in future
      const pos = this.playbackPosition;
      const timeOfDay = pos ? (_daySeconds(pos)) : 0;
      let seekTime = new Date(nextDay.getTime() + timeOfDay * 1000);
      if (this._isSeekUnavailable(seekTime)) seekTime = new Date(nextDay);
      this.onPlaybackSeek(this, seekTime);
    });

    // Ghud audio icon — sync with main audio toggle
    this._ghudAudio?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this._state.audio.available) return;
      if (CameraView.globalMute) CameraView.globalMute = false;
      this.video.muted = !this.video.muted;
      this._setAudioUnmuted(!this.video.muted);
    });
    this._ghudAudio?.addEventListener('mousedown', (e) => { e.stopPropagation(); });
    this._ghudAudio?.addEventListener('dblclick', (e) => { e.stopPropagation(); });

    // Ghud mic icon — toggle talkback
    this._dom.ghudMic?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this._state.talkback.available) return;
      this.toggleTalkback();
    });
    this._dom.ghudMic?.addEventListener('mousedown', (e) => { e.stopPropagation(); });
    this._dom.ghudMic?.addEventListener('dblclick', (e) => { e.stopPropagation(); });

    // Ghud SD/HD quality toggle
    this._ghudQuality?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.isPlayback) return;
      const clickedOpt = e.target.closest('.ghud-q-sd, .ghud-q-hd');
      if (!clickedOpt) return;
      const wantHd = clickedOpt.classList.contains('ghud-q-hd');
      if (wantHd === (this._state.quality.current === 'hd')) return;
      this._setQualityLoading(wantHd ? 'hd' : 'sd');
      if (this.onHdToggle) this.onHdToggle(this, wantHd);
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
          const endOfDay = new Date(seekTime);
          endOfDay.setHours(23, 59, 59, 0);
          const resolution = this._dom.pbResolution.value;
          this.onPlaybackRequest(this, _fmtFull(seekTime), _fmtFull(endOfDay), resolution);
        }
      });
    });

    // ── Fullscreen HUD: time button → toggle playback panel ──
    this._dom.seekInfoTimeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const panel = this._dom.playbackPanel;
      const pbBtn = this._dom.playbackBtn;
      panel.classList.toggle('open');
      if (pbBtn) pbBtn.classList.toggle('active', panel.classList.contains('open'));
      if (panel.classList.contains('open')) {
        const now = new Date();
        const ago = new Date(now.getTime() - 3600 * 1000);
        const endOfDay = (d) => `${d.getFullYear()}-${_pad(d.getMonth()+1)}-${_pad(d.getDate())}T23:59`;
        this._dom.pbStart.value = _fmtInput(ago);
        this._dom.pbEnd.value = endOfDay(ago);
      }
    });

    // ── Fullscreen HUD: ⋯ more seek buttons toggle ──
    this._dom.fsSeekMore.addEventListener('click', (e) => {
      e.stopPropagation();
      const extra = this._dom.fsSeekExtra;
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
