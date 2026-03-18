/**
 * Camera stream player.
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
  BUFFER_TRIM_TO,
} from './config.js';

export class CamPlayer {
  /** @param {HTMLVideoElement} video  @param {string} name - stream ID */
  constructor(video, name) {
    this.video = video;
    this.name = name;

    // connection state
    this.pc = null;
    this.ws = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.bufferQueue = [];

    this.mode = null;       // 'webrtc' | 'mse' | null
    this.enabled = false;
    this.connected = false;

    // retry
    this._retryTimer = null;
    this._iceTimeout = null;
    this._webrtcRetried = false;
    this.retryDelay = RETRY_BASE_MS;

    // bitrate tracking
    this.bitrate = 0;
    this._prevBytes = 0;
    this._prevBitrateTime = 0;

    // callbacks
    this.onStatusChange = null;  // (online: boolean) => void
    this.onAudioTrack = null;    // () => void
    this.onModeChange = null;    // (mode: string) => void
  }

  // ── Public API ──

  start() {
    this.enabled = true;
    this._connectWebRTC();
  }

  /** Start directly with MSE, skipping WebRTC. Use for HEVC playback. */
  startMSE() {
    this.enabled = true;
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
    this._closePeerConnection();
    this._closeWebSocket();
    this._resetVideo();
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.bufferQueue = [];
    this.mode = null;
    this.connected = false;
    this.bitrate = 0;
    this._webrtcRetried = false;
  }

  /** Measure current bitrate. Call periodically. */
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
  }

  // ── WebRTC ──

  async _connectWebRTC() {
    this.stop();
    if (!this.enabled) return;

    this.mode = 'webrtc';
    this._emitMode('webrtc');

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
        // retry once after a short delay before giving up on WebRTC
        if (!this._webrtcRetried) {
          this._webrtcRetried = true;
          this._closePeerConnection();
          setTimeout(() => this._connectWebRTC(), 2000);
          return;
        }
        this._webrtcRetried = false;
        this._connectMSE();
        return;
      }

      this._webrtcRetried = false;

      const answerSdp = await response.text();
      await this.pc.setRemoteDescription(
        new RTCSessionDescription({ type: 'answer', sdp: answerSdp })
      );

      // fallback if no media arrives
      this._iceTimeout = setTimeout(() => {
        if (this.mode === 'webrtc' && !this.connected) {
          this._connectMSE();
        }
      }, ICE_TIMEOUT_MS);

    } catch (err) {
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
      if (event.track.kind === 'audio' && this.onAudioTrack) {
        this.onAudioTrack();
      }
      if (event.streams?.[0]) {
        this.video.srcObject = event.streams[0];
        this.video.play().catch(() => {});
        clearTimeout(this._iceTimeout);
        this._emitStatus(true);
        this.retryDelay = RETRY_BASE_MS;
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      if (!this.pc) return;
      const state = this.pc.iceConnectionState;
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

    // force H264 in SDP offer (fixes Firefox which defaults to VP8)
    if (videoTransceiver.setCodecPreferences) {
      const allCodecs = RTCRtpReceiver.getCapabilities('video').codecs;
      const h264Codecs = allCodecs.filter(c => c.mimeType === 'video/H264');
      if (h264Codecs.length > 0) {
        videoTransceiver.setCodecPreferences(h264Codecs);
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

    this.mode = 'mse';
    this._emitMode('mse');
    this._prevBytes = 0;
    this._prevBitrateTime = Date.now();

    try {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${protocol}://${location.host}/api/ws?src=${this.name}`;
      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
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

      this.ws.onerror = () => {};
      this.ws.onclose = () => {
        this._emitStatus(false);
        this._scheduleRetry();
      };
    } catch (err) {
      this._emitStatus(false);
      this._scheduleRetry();
    }
  }

  _initMediaSource(mimeType) {
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
        // codec not supported
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
      setTimeout(() => this._connectMSE(), 1000);
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

    const reconnect = this.mode === 'mse'
      ? () => this._connectMSE()
      : () => this._connectWebRTC();

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
    if (this.onStatusChange) this.onStatusChange(online);
  }

  _emitMode(mode) {
    if (this.onModeChange) this.onModeChange(mode);
  }
}
