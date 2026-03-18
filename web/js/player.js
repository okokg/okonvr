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
  MSE_OPEN_TIMEOUT_MS, STALE_STREAM_MS,
} from './config.js';

(window._oko = window._oko || {}).player = 'p4b2';

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

    // retry
    this._retryTimer = null;
    this._iceTimeout = null;
    this._videoDecodeCheck = null;
    this._videoDecodeAttempts = 0;
    this._webrtcRetried = false;
    this.retryDelay = RETRY_BASE_MS;

    // bitrate + health tracking
    this.bitrate = 0;
    this._prevBytes = 0;
    this._prevBitrateTime = 0;
    this._lastBytesGrowth = 0;

    // callbacks
    this.onStatusChange = null;  // (online: boolean) => void
    this.onAudioTrack = null;    // () => void
    this.onModeChange = null;    // (mode: string) => void
    this.onNeedTranscode = null; // (streamName: string) => void
    this.onStage = null;         // (stage: string) => void — loading stage updates
    this.onConnectionError = null; // (streamName: string) => void — NVR unreachable
  }

  // ── Public API ──

  start() {
    this.enabled = true;
    if (this._codecMismatch) {
      this._connectMSE();
    } else {
      this._connectWebRTC();
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
    this.stop();
    this._emitStatus(false);
  }

  stop() {
    clearTimeout(this._retryTimer);
    clearTimeout(this._iceTimeout);
    clearTimeout(this._videoDecodeCheck);
    this._videoDecodeAttempts = 0;
    this._closePeerConnection();
    this._closeWebSocket();
    this._resetVideo();
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.bufferQueue = [];
    this.mode = null;
    this.connected = false;
    this.bitrate = 0;
    this._lastBytesGrowth = 0;
    this._webrtcRetried = false;
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
    if (this._codecMismatch || this.mode === 'mse') {
      this._connectMSE();
    } else {
      this._connectWebRTC();
    }
  }

  // ── WebRTC ──

  async _connectWebRTC() {
    this.stop();
    if (!this.enabled) return;

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
        // Codec mismatch (e.g. H.265 source, no H.265 WebRTC)
        if (errorText.includes('codecs not matched')) {
          this._codecMismatch = true;
          this._closePeerConnection();
          this._emitStage('codec fallback');

          if (CamPlayer.h265MSESupported) {
            console.log(`[player] ${this.name}: codec mismatch, switching to MSE`);
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
          setTimeout(() => this._connectWebRTC(), WEBRTC_RETRY_MS);
          return;
        }
        this._webrtcRetried = false;
        this._connectMSE();
        return;
      }

      this._webrtcRetried = false;

      const answerSdp = await response.text();

      // Debug: log negotiated codec from SDP answer
      const codecMatch = answerSdp.match(/a=rtpmap:\d+ (H26[45]|VP[89]|AV1)\//i);
      const negotiatedCodec = codecMatch ? codecMatch[1] : 'unknown';
      console.log(`[player] ${this.name}: WebRTC answer codec=${negotiatedCodec}`);
      this._emitStage(`codec ${negotiatedCodec}`);

      await this.pc.setRemoteDescription(
        new RTCSessionDescription({ type: 'answer', sdp: answerSdp })
      );

      // fallback if no media arrives
      this._iceTimeout = setTimeout(() => {
        if (this.mode === 'webrtc' && !this.connected) {
          console.log(`[player] ${this.name}: ICE timeout (${ICE_TIMEOUT_MS}ms), falling back to MSE`);
          this._connectMSE();
        }
      }, ICE_TIMEOUT_MS);

    } catch (err) {
      console.log(`[player] ${this.name}: WebRTC error: ${err.message}`);
      if (!this.connected && this.mode === 'webrtc') {
        this._connectMSE();
      } else {
        this._emitStatus(false);
        this._scheduleRetry();
      }
    }
  }

  _setupPeerConnectionHandlers() {
    this.pc.ontrack = (event) => {
      console.log(`[player] ${this.name}: ontrack kind=${event.track.kind} readyState=${event.track.readyState}`);

      if (event.track.kind === 'audio' && this.onAudioTrack) {
        this.onAudioTrack();
      }
      if (event.streams?.[0]) {
        this.video.srcObject = event.streams[0];
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
          console.log(`[player] ${this.name}: decode check #${this._videoDecodeAttempts} videoWidth=${w} mode=${this.mode}`);

          if (w > 0) {
            this._emitStage('playing');
            return;
          }
          if (this.mode !== 'webrtc') return;

          this._emitStage(`keyframe ${this._videoDecodeAttempts}/${maxAttempts}`);

          if (this._videoDecodeAttempts < maxAttempts) {
            this._videoDecodeCheck = setTimeout(checkDecode, checkInterval);
            return;
          }

          // All attempts failed — codec truly unsupported
          console.log(`[player] ${this.name}: WebRTC no decode after ${maxAttempts} checks — fallback`);
          this._emitStage('codec fallback');
          this._codecMismatch = true;
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
      console.log(`[player] ${this.name}: ICE state=${state}`);
      if (state === 'failed') {
        this._connectMSE();
      } else if (state === 'disconnected' || state === 'closed') {
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

  _connectMSE() {
    this.stop();
    if (!this.enabled) return;

    console.log(`[player] ${this.name}: connecting MSE...`);
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
        console.log(`[player] ${this.name}: WS open`);
        this._emitStage('mse buffering');
        this.ws.send(JSON.stringify({ type: 'mse', value: '' }));
      };

      this.ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          const msg = JSON.parse(event.data);
          if (msg.type === 'mse') this._initMediaSource(msg.value);
        } else {
          this._prevBytes += event.data.byteLength;
          this._appendToBuffer(new Uint8Array(event.data));
        }
      };

      this.ws.onerror = () => {
        console.log(`[player] ${this.name}: WS error`);
      };
      this.ws.onclose = (e) => {
        console.log(`[player] ${this.name}: WS close (code=${e.code})`);
        this._emitStatus(false);
        this._scheduleRetry();
      };
    } catch (err) {
      console.log(`[player] ${this.name}: MSE connect error: ${err.message}`);
      this._emitStatus(false);
      this._scheduleRetry();
    }
  }

  _initMediaSource(mimeType) {
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
    this.video.src = URL.createObjectURL(this.mediaSource);
    this.bufferQueue = [];
    this.sourceBuffer = null;

    this.mediaSource.addEventListener('sourceopen', () => {
      try {
        this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
        this.sourceBuffer.mode = 'segments';

        this.sourceBuffer.addEventListener('updateend', () => {
          this._trimBuffer();
          this._flushBufferQueue();
        });

        this._emitStatus(true);
        this.retryDelay = RETRY_BASE_MS;

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

    this.video.play().catch(() => {});
  }

  _appendToBuffer(data) {
    this.bufferQueue.push(data);
    this._flushBufferQueue();
  }

  _flushBufferQueue() {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || this.bufferQueue.length === 0) return;

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
      // quota exceeded — reconnect
      setTimeout(() => this._connectMSE(), MSE_OPEN_TIMEOUT_MS);
    }
  }

  _trimBuffer() {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || sb.buffered.length === 0) return;

    const start = sb.buffered.start(0);
    const end = sb.buffered.end(0);
    if (end - start > BUFFER_MAX_SECONDS) {
      try {
        sb.remove(start, end - BUFFER_TRIM_TO);
      } catch (err) { /* ignore */ }
    }
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
  }

  // ── Retry logic ──

  _scheduleRetry() {
    if (!this.enabled) return;

    clearTimeout(this._retryTimer);

    // Always MSE if codec mismatch was detected
    const useMSE = this.mode === 'mse' || this._codecMismatch;
    const reconnect = useMSE
      ? () => this._connectMSE()
      : () => this._connectWebRTC();

    console.log(`[player] ${this.name}: retry in ${this.retryDelay}ms (${useMSE ? 'MSE' : 'WebRTC'})`);
    this._emitStage('reconnecting');
    this._retryTimer = setTimeout(reconnect, this.retryDelay);

    if (this.retryDelay < RETRY_MAX_MS) {
      this.retryDelay = Math.min(this.retryDelay + 2000, RETRY_MAX_MS);
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
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  _resetVideo() {
    this.video.srcObject = null;
    this.video.src = '';
    this.video.load();
  }

  // ── Event emitters ──

  _emitStatus(online) {
    if (this.connected === online) return;
    this.connected = online;
    if (online) {
      this._lastBytesGrowth = Date.now();
    }
    console.log(`[player] ${this.name}: ${online ? 'CONNECTED' : 'DISCONNECTED'} (${this.mode})`);
    if (this.onStatusChange) this.onStatusChange(online);
  }

  _emitMode(mode) {
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
