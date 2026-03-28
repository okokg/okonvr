/**
 * Camera stream player.
 * @version 0.4.0
 *
 * Tries WebRTC first for low-latency playback.
 * Falls back to MSE (Media Source Extensions) over WebSocket
 * when WebRTC fails (e.g. codec mismatch in Firefox, ICE failure).
 *
 * Emits callbacks: onStatusChange, onAudioTrack, onModeChange.
 */

import {
  RETRY_BASE_MS, RETRY_MAX_MS, ICE_TIMEOUT_MS,
  ICE_GATHER_TIMEOUT_MS, STUN_SERVERS, BUFFER_MAX_SECONDS,
  BUFFER_TRIM_TO, WEBRTC_RETRY_MS, VIDEO_DECODE_CHECK_MS,
  MSE_OPEN_TIMEOUT_MS, STALE_STREAM_MS, MSE_CACHE_TTL_MS,
} from '../config.js';

(window._oko = window._oko || {}).player = 'p6a0';

export class CamPlayer {
  /**
   * Check if browser supports H.265/HEVC in WebRTC.
   * Cached after first call.
   * @returns {boolean}
   */
  static get h265WebRTCSupported() {
    if (CamPlayer._h265cached !== undefined) return CamPlayer._h265cached;
    try {
      const caps = RTCRtpReceiver.getCapabilities('video');
      const codecs = caps?.codecs || [];
      const found = codecs.some(c =>
        c.mimeType === 'video/H265' || c.mimeType === 'video/H.265' ||
        c.mimeType === 'video/HEVC' || c.mimeType?.toLowerCase().includes('h265') ||
        c.mimeType?.toLowerCase().includes('hevc')
      );
      CamPlayer._h265cached = found;
    } catch (e) {
      CamPlayer._h265cached = false;
    }
    console.log(`[player] H.265 WebRTC: ${CamPlayer._h265cached ? 'supported' : 'not supported'}`);
    return CamPlayer._h265cached;
  }

  /** Check if browser can decode H.265 via MSE. */
  static get h265MSESupported() {
    if (CamPlayer._h265MSEcached !== undefined) return CamPlayer._h265MSEcached;
    try {
      CamPlayer._h265MSEcached =
        typeof MediaSource !== 'undefined' &&
        MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L153.B0"');
    } catch {
      CamPlayer._h265MSEcached = false;
    }
    console.log(`[player] H.265 MSE: ${CamPlayer._h265MSEcached ? 'supported' : 'not supported'}`);
    return CamPlayer._h265MSEcached;
  }

  /** No H.265 at all — needs server transcode. */
  static get needsH265Transcode() {
    return !CamPlayer.h265WebRTCSupported && !CamPlayer.h265MSESupported;
  }

  /** MSE mode cache: cameraId → last MSE timestamp. Skip WebRTC if recent. */
  static _mseCache = new Map();
  static MSE_CACHE_TTL = MSE_CACHE_TTL_MS; // default from config.js, overridden by server config

  /**
   * Extract camera ID from any stream name:
   *   'D28'              → 'D28'   (SD live)
   *   'hd_D28'           → 'D28'   (HD)
   *   '__pb_D28_17345...' → 'D28'   (playback)
   */
  static _getCameraId(streamName) {
    if (streamName.startsWith('__pb_')) {
      const rest = streamName.slice(5); // after '__pb_'
      const lastUnderscore = rest.lastIndexOf('_');
      return lastUnderscore > 0 ? rest.slice(0, lastUnderscore) : rest;
    }
    if (streamName.startsWith('hd_')) {
      return streamName.slice(3);
    }
    return streamName;
  }

  /** Global MSE mode — disables WebRTC entirely. Set from config. */
  static globalForceMSE = false;

  // ── MSE Connection Pool ──
  // Chrome limits concurrent MediaSource video buffer (~150MB shared).
  // Pool ensures only MAX cameras connect simultaneously; rest wait in queue.
  // Staggered start prevents burst memory pressure that evicts existing streams.
  static _msePool = {
    active: new Set(),
    queue: [],
    MAX: 75,             // Chrome desktop limit; 46 cameras fits fine
    _flushTimer: null,
    STAGGER_MS: 200,     // small stagger to avoid burst WS connections
  };

  /** Whether this player is waiting in MSE queue (not stuck — just waiting for slot). */
  get isInMseQueue() {
    return CamPlayer._msePool.queue.indexOf(this) >= 0;
  }

  /** Request an MSE slot. */
  static _mseEnqueue(player) {
    const pool = CamPlayer._msePool;
    if (pool.active.has(player)) return;
    if (pool.queue.indexOf(player) >= 0) return;
    pool.queue.push(player);
    player._emitStage('mse queued');
    CamPlayer._mseFlush();
  }

  /** Release MSE slot. */
  static _mseRelease(player) {
    const pool = CamPlayer._msePool;
    const wasActive = pool.active.delete(player);
    const idx = pool.queue.indexOf(player);
    if (idx >= 0) pool.queue.splice(idx, 1);
    if (wasActive) CamPlayer._mseFlush();
  }

  /** Start ONE queued player if slot available, schedule next with stagger. */
  static _mseFlush() {
    const pool = CamPlayer._msePool;
    clearTimeout(pool._flushTimer);
    if (pool.active.size >= pool.MAX || pool.queue.length === 0) return;

    // Start one player
    while (pool.queue.length > 0) {
      const player = pool.queue.shift();
      if (!player.enabled) continue;
      pool.active.add(player);
      player._doConnectMSE();
      break;
    }

    // Schedule next with stagger delay
    if (pool.active.size < pool.MAX && pool.queue.length > 0) {
      pool._flushTimer = setTimeout(() => CamPlayer._mseFlush(), pool.STAGGER_MS);
    }
  }

  /** @param {HTMLVideoElement} video  @param {string} name - stream ID  @param {Object} [opts] */
  constructor(video, name, opts = {}) {
    this.video = video;
    this.name = name;
    this.preferH265 = opts.preferH265 || false;

    // connection state
    this.pc = null;
    this.ws = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.bufferQueue = [];

    this.mode = null;       // 'webrtc' | 'mse' | null
    this.enabled = false;
    this.connected = false;
    this._codecMismatch = false;  // true after codec mismatch 500 — use MSE only

    // WebRTC recovery: when MSE fallback was due to network (not codec),
    // periodically probe WebRTC to try switching back.
    this._fallbackReason = null;  // 'codec' | 'network' | null

    // retry
    this._retryTimer = null;
    this._iceTimeout = null;
    this._iceDisconnectTimer = null;  // grace period before reconnect on ICE "disconnected"
    this._videoDecodeCheck = null;
    this._videoDecodeAttempts = 0;
    this._webrtcRetried = false;
    this.retryDelay = RETRY_BASE_MS;

    // bitrate + health tracking
    this.bitrate = 0;
    this._prevBytes = 0;
    this._prevBitrateTime = 0;
    this._lastBytesGrowth = 0;

    // timing
    this._connectStartTime = 0;
    this._mseFirstData = false;

    // callbacks
    this.onStatusChange = null;  // (online: boolean) => void
    this.onAudioTrack = null;    // () => void
    this.onModeChange = null;    // (mode: string) => void
    this.onNeedTranscode = null; // (streamName: string) => void
    this.onStage = null;         // (stage: string) => void — loading stage updates
    this.onConnectionError = null; // (streamName: string) => void — NVR unreachable
    this.onStreamNotFound = null;  // (streamName: string) => void — go2rtc lost stream
  }

  /** Elapsed ms since connect start, formatted. */
  _elapsed() {
    return this._connectStartTime ? ` +${Date.now() - this._connectStartTime}ms` : '';
  }

  // ── Public API ──

  start() {
    this.enabled = true;

    // Global MSE mode — skip WebRTC entirely
    if (CamPlayer.globalForceMSE) {
      this._connectMSE();
      return;
    }

    if (this._codecMismatch) {
      this._connectMSE();
    } else {
      // Check MSE cache: if this camera used MSE within TTL, skip WebRTC
      const camId = CamPlayer._getCameraId(this.name);
      const lastMse = CamPlayer._mseCache.get(camId);
      if (lastMse && (Date.now() - lastMse) < CamPlayer.MSE_CACHE_TTL) {
        console.log(`[player] ${this.name}: MSE cache hit for ${camId} (${Math.round((Date.now() - lastMse) / 1000)}s ago), skipping WebRTC`);
        this._codecMismatch = true;
        // Preserve existing fallback reason (network or codec from previous session)
        if (!this._fallbackReason) this._fallbackReason = 'network';
        this._connectMSE();
      } else {
        this._connectWebRTC();
      }
    }
  }

  /** Start directly with MSE, skipping WebRTC. Use for HEVC playback. */
  startMSE() {
    this.enabled = true;
    this._codecMismatch = true;
    this._connectMSE();
  }

  disable() {
    this.enabled = false;
    CamPlayer._probeWaiters.delete(this);
    CamPlayer._mseRelease(this);
    this.stop();
    this._emitStatus(false);
  }

  stop() {
    clearTimeout(this._retryTimer);
    clearTimeout(this._iceTimeout);
    clearTimeout(this._iceDisconnectTimer);
    this._iceDisconnectTimer = null;
    clearTimeout(this._videoDecodeCheck);
    this._videoDecodeAttempts = 0;
    this._closePeerConnection();
    this._closeWebSocket();
    // Revoke old blob URL to prevent ERR_FILE_NOT_FOUND on orphaned MediaSource
    if (this._blobUrl) { URL.revokeObjectURL(this._blobUrl); this._blobUrl = null; }
    // NOTE: deliberately does NOT reset video.src — CameraView owns video lifecycle
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.bufferQueue = [];
    this.mode = null;
    this.connected = false;
    this.bitrate = 0;
    this._lastBytesGrowth = 0;
    this._webrtcRetried = false;
    // Don't release pool here — _doConnectMSE calls stop() before reconnecting
    // Pool release happens in disable() and detach handler
  }

  /** Measure current bitrate and detect stale streams. Call periodically. */
  async updateBitrate() {
    if (!this.connected) {
      this.bitrate = 0;
      return;
    }

    if (this.mode === 'webrtc' && this.pc) {
      await this._measureWebRTCBitrate();
    } else if (this.mode === 'mse') {
      this._measureMSEBitrate();
    }

    // Proactive health: detect stale stream (no new bytes)
    this._checkStaleStream();
  }

  /** Detect if stream stopped receiving data and reconnect. */
  _checkStaleStream() {
    if (!this.connected || !this.enabled) return;

    const now = Date.now();

    if (this.bitrate > 0) {
      this._lastBytesGrowth = now;
      return;
    }

    // First time with zero bitrate — start tracking
    if (!this._lastBytesGrowth) {
      this._lastBytesGrowth = now;
      return;
    }

    const staleDuration = now - this._lastBytesGrowth;
    if (staleDuration >= STALE_STREAM_MS) {
      console.log(`[player] ${this.name}: stale stream (${Math.round(staleDuration / 1000)}s no data), reconnecting`);
      this._lastBytesGrowth = now; // reset to avoid rapid retrigger
      this._reconnect();
    }
  }

  /** Reconnect using appropriate method (WebRTC or MSE). */
  _reconnect() {
    if (!this.enabled) return;
    this._emitStatus(false);
    if (CamPlayer.globalForceMSE || this._codecMismatch || this.mode === 'mse') {
      this._connectMSE();
    } else {
      this._connectWebRTC();
    }
  }

  // ── WebRTC ──

  async _connectWebRTC() {
    if (!this.enabled) return;
    this.stop();

    this._connectStartTime = Date.now();
    console.log(`[player] ${this.name}: connecting WebRTC...`);
    this.mode = 'webrtc';
    this._emitMode('webrtc');
    this._emitStage('webrtc negotiating');

    try {
      this.pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
      this._setupPeerConnectionHandlers();
      this._configureCodecPreferences();

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await this._waitForICEGathering();

      const response = await fetch(
        `${location.origin}/api/webrtc?src=${this.name}`,
        { method: 'POST', body: this.pc.localDescription.sdp }
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');

        // Stream not found in go2rtc — needs recovery
        if (response.status === 500 && (errorText.includes('not found') || errorText.includes('no source'))) {
          console.warn(`[player] ${this.name}: stream not found in go2rtc${this._elapsed()}`);
          this._closePeerConnection();
          this._emitStage('stream lost');
          this._emitStatus(false);
          if (this.onStreamNotFound) this.onStreamNotFound(this.name);
          return;
        }

        // Codec mismatch (e.g. H.265 source, no H.265 WebRTC)
        if (errorText.includes('codecs not matched')) {
          this._codecMismatch = true;
          this._fallbackReason = 'codec';
          this._closePeerConnection();
          this._emitStage('codec fallback');

          if (CamPlayer.h265MSESupported) {
            console.log(`[player] ${this.name}: codec mismatch, switching to MSE${this._elapsed()}`);
            this._connectMSE();
          } else if (this.onNeedTranscode) {
            console.log(`[player] ${this.name}: no H.265 support, requesting transcode`);
            this._emitStage('transcoding');
            this.onNeedTranscode(this.name);
          } else {
            console.log(`[player] ${this.name}: no H.265 support, no transcode handler`);
            this._emitStatus(false);
          }
          return;
        }

        // Detect NVR connection errors (dial tcp, i/o timeout, connection refused)
        const isConnectionError = CamPlayer._isConnectionError(errorText);
        if (isConnectionError) {
          console.log(`[player] ${this.name}: NVR connection error: ${errorText.substring(0, 80)}`);
          this._closePeerConnection();
          this._emitStage('nvr unreachable');
          this._emitStatus(false);
          // Don't retry — NVR is down, MSE will also fail
          // Circuit breaker in app.js will disable us and manage recovery
          if (this.onConnectionError) this.onConnectionError(this.name);
          return;
        }

        // Other errors → retry once before MSE fallback
        if (!this._webrtcRetried) {
          this._webrtcRetried = true;
          this._closePeerConnection();
          this._retryTimer = setTimeout(() => this._connectWebRTC(), WEBRTC_RETRY_MS);
          return;
        }
        this._webrtcRetried = false;
        this._fallbackReason = 'network';
        this._connectMSE();
        return;
      }

      this._webrtcRetried = false;

      const answerSdp = await response.text();

      // Debug: log negotiated codec from SDP answer
      const codecMatch = answerSdp.match(/a=rtpmap:\d+ (H26[45]|VP[89]|AV1)\//i);
      const negotiatedCodec = codecMatch ? codecMatch[1] : 'unknown';
      console.log(`[player] ${this.name}: WebRTC answer codec=${negotiatedCodec}${this._elapsed()}`);
      this._emitStage(`codec ${negotiatedCodec}`);

      await this.pc.setRemoteDescription(
        new RTCSessionDescription({ type: 'answer', sdp: answerSdp })
      );

      // fallback if no media arrives
      this._iceTimeout = setTimeout(() => {
        if (this.mode === 'webrtc' && !this.connected) {
          console.log(`[player] ${this.name}: ICE timeout (${ICE_TIMEOUT_MS}ms), falling back to MSE`);
          this._fallbackReason = 'network';
          this._connectMSE();
        }
      }, ICE_TIMEOUT_MS);

    } catch (err) {
      console.log(`[player] ${this.name}: WebRTC error: ${err.message}`);
      if (!this.connected && this.mode === 'webrtc') {
        this._fallbackReason = 'network';
        this._connectMSE();
      } else {
        this._emitStatus(false);
        this._scheduleRetry();
      }
    }
  }

  _setupPeerConnectionHandlers() {
    this.pc.ontrack = (event) => {
      if (!this.enabled) return;
      console.log(`[player] ${this.name}: ontrack kind=${event.track.kind}${this._elapsed()}`);

      if (event.track.kind === 'audio' && this.onAudioTrack) {
        this.onAudioTrack();
      }
      if (event.streams?.[0]) {
        this.video.srcObject = event.streams[0];
        // Must be muted for autoplay policy — user can unmute via audio toggle
        this.video.muted = true;
        this.video.play().catch(() => {});
        clearTimeout(this._iceTimeout);
        this._emitStatus(true);
        this._emitStage('waiting for keyframe');
        this.retryDelay = RETRY_BASE_MS;

        // Check if video actually decodes — poll multiple times before giving up
        clearTimeout(this._videoDecodeCheck);
        this._videoDecodeAttempts = 0;
        const maxAttempts = 3;
        const checkInterval = VIDEO_DECODE_CHECK_MS;

        const checkDecode = () => {
          this._videoDecodeAttempts++;
          const w = this.video.videoWidth;
          console.log(`[player] ${this.name}: decode check #${this._videoDecodeAttempts} videoWidth=${w} mode=${this.mode}${this._elapsed()}`);

          if (w > 0) {
            // WebRTC is working — clear any fallback state
            this._fallbackReason = null;
            this._codecMismatch = false;
            CamPlayer._probeWaiters.delete(this);
            CamPlayer._mseCache.delete(CamPlayer._getCameraId(this.name));
            this._emitStage('playing');
            return;
          }
          if (this.mode !== 'webrtc') return;

          this._emitStage(`keyframe ${this._videoDecodeAttempts}/${maxAttempts}`);

          if (this._videoDecodeAttempts < maxAttempts) {
            this._videoDecodeCheck = setTimeout(checkDecode, checkInterval);
            return;
          }

          // All attempts failed — but WHY?
          // If ICE never reached 'connected', UDP isn't getting through — network issue.
          // If ICE is connected but no decode — codec truly unsupported.
          const iceState = this.pc?.iceConnectionState;
          const reason = (iceState && iceState !== 'connected' && iceState !== 'completed')
            ? 'network' : 'codec';
          console.log(`[player] ${this.name}: WebRTC no decode after ${maxAttempts} checks — fallback (${reason}, ICE=${iceState})${this._elapsed()}`);
          this._emitStage(reason === 'codec' ? 'codec fallback' : 'network fallback');
          this._codecMismatch = true;
          this._fallbackReason = reason;
          this._closePeerConnection();
          if (CamPlayer.h265MSESupported) {
            this._connectMSE();
          } else if (this.onNeedTranscode) {
            this.onNeedTranscode(this.name);
          } else {
            this._emitStatus(false);
          }
        };

        this._videoDecodeCheck = setTimeout(checkDecode, checkInterval);
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      if (!this.pc) return;
      const state = this.pc.iceConnectionState;
      console.log(`[player] ${this.name}: ICE state=${state}${this._elapsed()}`);

      if (state === 'connected') {
        // ICE recovered (possibly from "disconnected") — cancel pending reconnect
        clearTimeout(this._iceDisconnectTimer);
        this._iceDisconnectTimer = null;
        if (!this.connected) this._emitStatus(true);
        // If video was playing before disconnect, restore immediately
        if (this.video.videoWidth > 0) this._emitStage('playing');
      } else if (state === 'disconnected') {
        // Transient state — ICE often auto-recovers in 2-5s.
        // Show loading overlay immediately to cover frozen/black video,
        // but wait before actually reconnecting.
        this._emitStage('ice recovering');
        if (!this._iceDisconnectTimer) {
          const grace = 5000 + Math.random() * 3000; // 5-8s jitter
          console.log(`[player] ${this.name}: ICE disconnected, waiting ${Math.round(grace / 1000)}s for recovery`);
          this._iceDisconnectTimer = setTimeout(() => {
            this._iceDisconnectTimer = null;
            if (!this.pc || !this.enabled) return;
            const current = this.pc.iceConnectionState;
            if (current === 'disconnected' || current === 'failed' || current === 'closed') {
              console.log(`[player] ${this.name}: ICE did not recover (state=${current}), reconnecting`);
              this._emitStatus(false);
              this._scheduleRetry();
            }
          }, grace);
        }
      } else if (state === 'failed') {
        clearTimeout(this._iceDisconnectTimer);
        this._iceDisconnectTimer = null;
        this._fallbackReason = 'network';
        this._connectMSE();
      } else if (state === 'closed') {
        clearTimeout(this._iceDisconnectTimer);
        this._iceDisconnectTimer = null;
        this._emitStatus(false);
        this._scheduleRetry();
      }
    };
  }

  _configureCodecPreferences() {
    const videoTransceiver = this.pc.addTransceiver('video', { direction: 'recvonly' });
    this.pc.addTransceiver('audio', { direction: 'recvonly' });

    if (videoTransceiver.setCodecPreferences) {
      const allCodecs = RTCRtpReceiver.getCapabilities('video').codecs;
      const h264 = allCodecs.filter(c => c.mimeType === 'video/H264');
      const h265 = CamPlayer.h265WebRTCSupported
        ? allCodecs.filter(c => c.mimeType === 'video/H265' || c.mimeType === 'video/HEVC')
        : [];

      // If browser supports H.265, prefer it — go2rtc will match source codec
      // H.265 source → go2rtc picks H.265 (first in list)
      // H.264 source → go2rtc picks H.264 (also in list)
      const preferred = h265.length
        ? [...h265, ...h264]
        : [...h264];

      if (preferred.length > 0) {
        videoTransceiver.setCodecPreferences(preferred);
      }
    }
  }

  _waitForICEGathering() {
    if (this.pc.iceGatheringState === 'complete') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.pc.addEventListener('icegatheringstatechange', () => {
        if (this.pc?.iceGatheringState === 'complete') resolve();
      });
      setTimeout(resolve, ICE_GATHER_TIMEOUT_MS);
    });
  }

  // ── MSE (fallback) ──

  /** Request MSE connection — goes through the pool queue. */
  _connectMSE() {
    if (!this.enabled) return;

    this._mseConsecutiveFailures = (this._mseConsecutiveFailures || 0);

    // If MSE keeps failing and WebRTC is available, fall back to it
    // (but not when globalForceMSE — MSE is the only option)
    if (!CamPlayer.globalForceMSE && this._mseConsecutiveFailures >= 3 && CamPlayer.h265WebRTCSupported) {
      console.log(`[player] ${this.name}: MSE failed ${this._mseConsecutiveFailures}× — falling back to WebRTC`);
      this._mseConsecutiveFailures = 0;
      this._codecMismatch = false;
      this._connectWebRTC();
      return;
    }

    CamPlayer._mseEnqueue(this);
  }

  /** Actually connect MSE — called by pool when a slot is available. */
  _doConnectMSE() {
    if (!this.enabled) { CamPlayer._mseRelease(this); return; }
    this.stop();  // clean up any previous connection (but don't release pool slot)

    this._connectStartTime = Date.now();
    this._mseFirstData = false;

    const pool = CamPlayer._msePool;
    console.log(`[player] ${this.name}: connecting MSE (pool: ${pool.active.size}/${pool.MAX}, queue: ${pool.queue.length})${this._mseConsecutiveFailures > 0 ? ` attempt ${this._mseConsecutiveFailures + 1}` : ''}`);
    this.mode = 'mse';
    this._emitMode('mse');
    this._emitStage('mse connecting');
    this._prevBytes = 0;
    this._prevBitrateTime = Date.now();

    try {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${protocol}://${location.host}/api/ws?src=${this.name}`;
      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        if (!this.enabled) { this._closeWebSocket(); return; }
        console.log(`[player] ${this.name}: WS open${this._elapsed()}`);
        this._emitStage('mse buffering');
        this.ws.send(JSON.stringify({ type: 'mse', value: '' }));
      };

      this.ws.onmessage = (event) => {
        if (!this.enabled) return; // guard: player disabled during WS delivery
        if (typeof event.data === 'string') {
          const msg = JSON.parse(event.data);
          if (msg.type === 'mse') {
            console.log(`[player] ${this.name}: MSE codec="${msg.value}"${this._elapsed()}`);
            this._initMediaSource(msg.value);
          }
        } else {
          this._prevBytes += event.data.byteLength;
          if (!this._mseFirstData) {
            this._mseFirstData = true;
            console.log(`[player] ${this.name}: MSE first data ${event.data.byteLength}b${this._elapsed()}`);
          }
          this._appendToBuffer(new Uint8Array(event.data));
        }
      };

      this.ws.onerror = () => {
        console.log(`[player] ${this.name}: WS error`);
      };
      this.ws.onclose = (e) => {
        console.log(`[player] ${this.name}: WS close (code=${e.code})`);
        this._emitStatus(false);
        CamPlayer._mseRelease(this);
        this._scheduleRetry();
      };
    } catch (err) {
      console.log(`[player] ${this.name}: MSE connect error: ${err.message}`);
      this._emitStatus(false);
      CamPlayer._mseRelease(this);
      this._scheduleRetry();
    }
  }

  _initMediaSource(mimeType) {
    if (!this.enabled) return; // player disabled between WS message and this call

    // Check if browser supports this codec before trying
    if (!MediaSource.isTypeSupported(mimeType)) {
      console.log(`[player] ${this.name}: MSE codec not supported: ${mimeType}`);
      this._closeWebSocket();
      if (CamPlayer.needsH265Transcode && this.onNeedTranscode) {
        this.onNeedTranscode(this.name);
      } else {
        this._emitStatus(false);
      }
      return;
    }

    this.mediaSource = new MediaSource();
    // Clear any stale WebRTC srcObject — srcObject takes priority over src per spec.
    this.video.srcObject = null;
    this._blobUrl = URL.createObjectURL(this.mediaSource);
    this.video.src = this._blobUrl;
    this.bufferQueue = [];
    this.sourceBuffer = null;

    this.mediaSource.addEventListener('sourceopen', () => {
      if (!this.enabled || !this.mediaSource) return; // stale event
      try {
        console.log(`[player] ${this.name}: sourceopen${this._elapsed()}`);
        this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
        this.sourceBuffer.mode = 'segments';

        this.sourceBuffer.addEventListener('updateend', () => {
          if (!this.enabled || !this.sourceBuffer) return;
          this._trimBuffer();
          this._flushBufferQueue();
        });

        this._emitStatus(true);
        this.retryDelay = RETRY_BASE_MS;
        this._mseConsecutiveFailures = 0;

        // Schedule WebRTC recovery probe if fallback was due to network (not codec)
        if (this._fallbackReason === 'network' && !CamPlayer.globalForceMSE) {
          this._scheduleWebRtcProbe();
        }

        if (/mp4a|opus|aac/i.test(mimeType) && this.onAudioTrack) {
          this.onAudioTrack();
        }

        this._flushBufferQueue();
      } catch (err) {
        console.log(`[player] ${this.name}: addSourceBuffer failed: ${err.message}`);
        this._closeWebSocket();
        if (this.onNeedTranscode) {
          this.onNeedTranscode(this.name);
        } else {
          this._emitStatus(false);
        }
      }
    }, { once: true });

    // play() MUST be called right after setting video.src — Chrome holds the
    // promise in pending state until data arrives via appendBuffer. Moving it
    // to updateend causes Chrome to evaluate the empty buffer → "no source" → fail.
    this.video.muted = true;
    this.video.play().catch(() => {}); // rejection is non-fatal — muted satisfies autoplay
  }

  _appendToBuffer(data) {
    if (!this.enabled) return;
    this.bufferQueue.push(data);
    if (this.sourceBuffer) this._flushBufferQueue(); // flush only when ready
  }

  _flushBufferQueue() {
    const sb = this.sourceBuffer;
    if (!sb || !this.enabled || sb.updating || this.bufferQueue.length === 0) return;

    const totalSize = this.bufferQueue.reduce((sum, buf) => sum + buf.byteLength, 0);
    const merged = new Uint8Array(totalSize);
    let offset = 0;
    for (const buf of this.bufferQueue) {
      merged.set(buf, offset);
      offset += buf.byteLength;
    }
    this.bufferQueue = [];

    try {
      sb.appendBuffer(merged);
    } catch (err) {
      if (!this.enabled) return;
      // SourceBuffer detached (video.src changed, or MediaSource closed)
      if (err.name === 'InvalidStateError' || err.message?.includes('removed from the parent')) {
        this._mseConsecutiveFailures = (this._mseConsecutiveFailures || 0) + 1;
        console.log(`[player] ${this.name}: SourceBuffer detached (failure #${this._mseConsecutiveFailures}), reconnecting`);
        this._closeWebSocket();
        this.sourceBuffer = null;
        this.mediaSource = null;
        this.connected = false;
        this._emitStatus(false);
        CamPlayer._mseRelease(this);
        this._scheduleRetry(); // uses delay timer, then re-enqueues
        return;
      }
      // Quota exceeded or other → reconnect
      console.warn(`[player] ${this.name}: appendBuffer error: ${err.message} (${merged.byteLength}b)`);
      CamPlayer._mseRelease(this);
      this._scheduleRetry();
    }
  }

  _trimBuffer() {
    try {
      const sb = this.sourceBuffer;
      if (!sb || sb.updating || sb.buffered.length === 0) return;

      const start = sb.buffered.start(0);
      const end = sb.buffered.end(0);
      if (end - start > BUFFER_MAX_SECONDS) {
        sb.remove(start, end - BUFFER_TRIM_TO);
      }
    } catch { /* SourceBuffer may be detached — safe to ignore */ }
  }

  // ── Bitrate measurement ──

  async _measureWebRTCBitrate() {
    try {
      const stats = await this.pc.getStats();
      let totalBytes = 0;
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          totalBytes += report.bytesReceived || 0;
        }
      });

      const now = Date.now();
      const elapsed = (now - (this._prevBitrateTime || now)) / 1000;
      if (elapsed > 0 && this._prevBytes > 0) {
        this.bitrate = Math.round(((totalBytes - this._prevBytes) * 8) / elapsed / 1000);
      }
      this._prevBytes = totalBytes;
      this._prevBitrateTime = now;
    } catch (err) { /* stats unavailable */ }
  }

  _measureMSEBitrate() {
    const now = Date.now();
    const elapsed = (now - this._prevBitrateTime) / 1000;
    if (elapsed > 0) {
      this.bitrate = Math.round((this._prevBytes * 8) / elapsed / 1000);
      this._prevBytes = 0;
      this._prevBitrateTime = now;
    }
    // Keep MSE cache fresh while actively receiving data
    if (this.mode === 'mse') {
      CamPlayer._mseCache.set(CamPlayer._getCameraId(this.name), now);
    }
  }

  // ── Retry logic ──

  _scheduleRetry() {
    if (!this.enabled) return;

    clearTimeout(this._retryTimer);
    this._emitStage('reconnecting');

    const useMSE = CamPlayer.globalForceMSE || this.mode === 'mse' || this._codecMismatch;
    // Add jitter (±1.5s) to prevent thundering herd when many cameras reconnect simultaneously
    const jitter = Math.round((Math.random() - 0.5) * 3000);
    const delay = Math.max(1000, this.retryDelay + jitter);

    console.log(`[player] ${this.name}: retry in ${delay}ms (${useMSE ? 'MSE' : 'WebRTC'})`);

    this._retryTimer = setTimeout(() => {
      if (!this.enabled) return;
      if (useMSE) {
        CamPlayer._mseEnqueue(this);
      } else {
        this._connectWebRTC();
      }
    }, delay);

    if (this.retryDelay < RETRY_MAX_MS) {
      this.retryDelay = Math.min(this.retryDelay + 2000, RETRY_MAX_MS);
    }
  }

  // ── WebRTC recovery probe ──
  // When MSE fallback was due to network issues (WiFi switch, ICE timeout),
  // periodically try WebRTC again. Exponential backoff: 30s → 60s → 120s → 300s cap.

  // ── WebRTC recovery: global sentinel probe ──
  // One camera probes at a time. If it succeeds → all network-fallback cameras switch.
  // One probe is sufficient to answer "is UDP/WebRTC working?" — no need for 46 identical probes.

  static _probeSentinel = null;       // the CamPlayer currently probing (or null)
  static _probeWaiters = new Set();   // cameras waiting for sentinel result
  static _probeTimer = null;
  static _probeDelay = 30000;         // global backoff: 30s → 60s → 120s → 300s

  _scheduleWebRtcProbe() {
    if (!this.enabled || CamPlayer.globalForceMSE) return;
    if (this._fallbackReason !== 'network') return;

    // Don't probe session streams
    if (this.name.startsWith('__pb_') || this.name.startsWith('__hd_') || this.name.startsWith('__t_') ||
        this.name.startsWith('hd_') || this.name.startsWith('t_')) return;

    // Register as waiter
    CamPlayer._probeWaiters.add(this);

    // If no probe is scheduled, schedule one
    if (!CamPlayer._probeTimer && !CamPlayer._probeSentinel) {
      const delay = CamPlayer._probeDelay;
      // Add jitter to avoid thundering herd on page load
      const jitter = Math.round(Math.random() * 5000);
      console.log(`[player] sentinel probe scheduled in ${Math.round((delay + jitter) / 1000)}s (${CamPlayer._probeWaiters.size} cameras waiting)`);

      CamPlayer._probeTimer = setTimeout(() => {
        CamPlayer._probeTimer = null;
        CamPlayer._runSentinelProbe();
      }, delay + jitter);
    }
  }

  static _runSentinelProbe() {
    // Pick first eligible waiter as sentinel
    let sentinel = null;
    for (const cam of CamPlayer._probeWaiters) {
      if (cam.enabled && cam.mode === 'mse' && cam.connected && cam._fallbackReason === 'network') {
        sentinel = cam;
        break;
      }
    }
    if (!sentinel) {
      CamPlayer._probeWaiters.clear();
      return;
    }

    CamPlayer._probeSentinel = sentinel;
    sentinel._probeWebRtc().then((success) => {
      CamPlayer._probeSentinel = null;

      if (success) {
        // Sentinel succeeded → switch all waiters to WebRTC
        const waiters = [...CamPlayer._probeWaiters].filter(cam =>
          cam !== sentinel && cam.enabled && cam.mode === 'mse' && cam._fallbackReason === 'network'
        );
        console.log(`[player] sentinel probe ✓ — switching ${waiters.length} cameras to WebRTC`);
        CamPlayer._probeDelay = 30000; // reset backoff
        CamPlayer._probeWaiters.clear();

        // Stop MSE + start WebRTC atomically per camera, 100ms apart
        waiters.forEach((cam, i) => {
          setTimeout(() => {
            if (!cam.enabled || cam.mode !== 'mse') return;
            cam._fallbackReason = null;
            cam._codecMismatch = false;
            CamPlayer._mseCache.delete(CamPlayer._getCameraId(cam.name));
            cam.stop();
            CamPlayer._mseRelease(cam);
            cam._connectWebRTC();
          }, i * 100);
        });
      } else {
        // Sentinel failed → increase backoff, schedule next probe
        CamPlayer._probeDelay = Math.min(CamPlayer._probeDelay * 2, 300000);
        console.log(`[player] sentinel probe ✗ — next in ${Math.round(CamPlayer._probeDelay / 1000)}s`);
        CamPlayer._probeTimer = setTimeout(() => {
          CamPlayer._probeTimer = null;
          CamPlayer._runSentinelProbe();
        }, CamPlayer._probeDelay + Math.round(Math.random() * 5000));
      }
    });
  }

  /**
   * Probe WebRTC: try to switch back from MSE.
   * Creates a temporary PeerConnection to test if WebRTC works now.
   * Returns true if media received, false otherwise.
   * Sentinel caller handles switching other cameras.
   */
  async _probeWebRtc() {
    const camId = CamPlayer._getCameraId(this.name);
    console.log(`[player] ${this.name}: sentinel probing WebRTC...`);

    let probePc = null;
    try {
      probePc = new RTCPeerConnection({
        iceServers: STUN_SERVERS.length ? STUN_SERVERS : [],
      });

      const videoTransceiver = probePc.addTransceiver('video', { direction: 'recvonly' });
      probePc.addTransceiver('audio', { direction: 'recvonly' });

      if (videoTransceiver.setCodecPreferences) {
        const allCodecs = RTCRtpReceiver.getCapabilities('video').codecs;
        const h264 = allCodecs.filter(c => c.mimeType === 'video/H264');
        const h265 = CamPlayer.h265WebRTCSupported
          ? allCodecs.filter(c => c.mimeType === 'video/H265' || c.mimeType === 'video/HEVC')
          : [];
        const preferred = h265.length ? [...h265, ...h264] : [...h264];
        if (preferred.length > 0) videoTransceiver.setCodecPreferences(preferred);
      }

      const offer = await probePc.createOffer();
      await probePc.setLocalDescription(offer);

      if (probePc.iceGatheringState !== 'complete') {
        await new Promise((resolve) => {
          probePc.addEventListener('icegatheringstatechange', () => {
            if (probePc?.iceGatheringState === 'complete') resolve();
          });
          setTimeout(resolve, ICE_GATHER_TIMEOUT_MS);
        });
      }

      const go2rtcApi = window.__okoConfig?.go2rtc_api || '/api';
      const response = await fetch(
        `${go2rtcApi}/webrtc?src=${encodeURIComponent(this.name)}`,
        { method: 'POST', body: probePc.localDescription.sdp }
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        if (errorText.includes('codecs not matched')) {
          console.log(`[player] ${this.name}: probe codec mismatch — removing from waiters`);
          this._fallbackReason = 'codec';
          this._codecMismatch = true;
          CamPlayer._probeWaiters.delete(this);
          probePc.close();
          return false;
        }
        throw new Error(`probe HTTP ${response.status}`);
      }

      const answerSdp = await response.text();

      // Set up handlers BEFORE setRemoteDescription — ontrack fires DURING processing
      let resolveMedia;
      const gotMedia = new Promise((resolve) => { resolveMedia = resolve; });
      const mediaTimeout = setTimeout(() => resolveMedia(false), 10000);

      probePc.ontrack = (event) => {
        if (event.track.kind === 'video') {
          clearTimeout(mediaTimeout);
          resolveMedia(true);
        }
      };
      probePc.oniceconnectionstatechange = () => {
        if (probePc.iceConnectionState === 'failed') {
          clearTimeout(mediaTimeout);
          resolveMedia(false);
        }
      };

      await probePc.setRemoteDescription(
        new RTCSessionDescription({ type: 'answer', sdp: answerSdp })
      );

      // Wait for ontrack (already registered above)
      const success = await gotMedia;

      probePc.close();
      probePc = null;

      if (success) {
        console.log(`[player] ${this.name}: ✓ sentinel probe succeeded`);
        this._fallbackReason = null;
        this._codecMismatch = false;
        CamPlayer._mseCache.delete(camId);
        this.stop();
        CamPlayer._mseRelease(this);
        this._connectWebRTC();
        return true;
      } else {
        console.log(`[player] ${this.name}: ✗ sentinel probe failed`);
        return false;
      }

    } catch (err) {
      console.log(`[player] ${this.name}: probe error: ${err.message}`);
      if (probePc) { try { probePc.close(); } catch {} }
      return false;
    }
  }

  // ── Cleanup helpers ──

  _closePeerConnection() {
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.close();
      this.pc = null;
    }
  }

  _closeWebSocket() {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  // ── Event emitters ──

  _emitStatus(online) {
    if (this.connected === online) return;
    this.connected = online;
    if (online) {
      this._lastBytesGrowth = Date.now();
    }
    console.log(`[player] ${this.name}: ${online ? 'CONNECTED' : 'DISCONNECTED'} (${this.mode})${this._elapsed()}`);
    if (this.onStatusChange) this.onStatusChange(online);
  }

  _emitMode(mode) {
    if (mode === 'mse') {
      CamPlayer._mseCache.set(CamPlayer._getCameraId(this.name), Date.now());
    }
    if (this.onModeChange) this.onModeChange(mode);
  }

  _emitStage(stage) {
    if (this.onStage) this.onStage(stage);
  }

  /** Detect NVR connection errors vs codec/other errors. */
  static _isConnectionError(errorText) {
    const t = errorText.toLowerCase();
    return t.includes('dial tcp') ||
      t.includes('i/o timeout') ||
      t.includes('connection refused') ||
      t.includes('no route') ||
      t.includes('network is unreachable') ||
      t.includes('connection reset') ||
      t.includes('broken pipe') ||
      t.includes('eof');
  }
}
