/**
 * TalkbackFeature — two-way audio (push-to-talk / toggle intercom).
 *
 * Controls: PTT button (hold=speak, dblclick=lock), mic status icon,
 * grid HUD mic icon, keyboard V toggle.
 *
 * Audio path: browser mic → WebRTC → go2rtc → RTSP direct to camera IP.
 */

import { Feature } from '../core/feature.js';

export class TalkbackFeature extends Feature {
  attach(view) {
    super.attach(view);

    // State slice
    if (!view._state.talkback) {
      view._state.talkback = {
        available: view.hasTalkback,
        connecting: false,
        active: false,
        locked: false,
      };
    }

    this._pc = null;
    this._stream = null;       // go2rtc stream name (__tb_xxx)
    this._startTime = null;
    this._timerInterval = null;

    this._injectDOM();
    this._cacheDom();
    this._bindEvents();
    this._render();
  }

  // ── Feature hooks ──

  onExitFullscreen() {
    const view = this._view;
    const tb = view._state.talkback;
    // Keep audio unmuted if talkback active
    if (tb.active || tb.locked) {
      view.video.muted = false;
      view._setAudioUnmuted(true);
    }
  }

  onDisable() {
    this._cleanup();
  }

  getState() {
    const tb = this._view._state.talkback;
    if (!tb.active && !tb.locked) return {};
    return { talkback: { active: tb.active, locked: tb.locked } };
  }

  restoreState(state) {
    if (state.talkback?.active || state.talkback?.locked) {
      this.start(!!state.talkback.locked);
    }
  }

  // ── Public API ──

  get isActive() {
    const tb = this._view._state.talkback;
    return tb.active || tb.locked;
  }

  get isAvailable() {
    return this._view._state.talkback.available;
  }

  toggle() {
    const tb = this._view._state.talkback;
    if (tb.active || tb.locked) {
      this.stop(true);
    } else {
      this.start(true);
    }
  }

  async start(lock = false) {
    const view = this._view;
    const tb = view._state.talkback;
    if (tb.active || tb.connecting || !tb.available) return;

    tb.connecting = true;
    this._render();

    // 1. Request stream from backend
    if (!view.onTalkbackStart) { this._resetState(); return; }
    let streamName;
    try {
      streamName = await view.onTalkbackStart(view);
    } catch (e) {
      console.error(`[talkback] ${view.id}: backend start failed:`, e.message);
      this._resetState();
      return;
    }
    if (!streamName) { this._resetState(); return; }
    this._stream = streamName;

    // 2. Get microphone
    let micStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (e) {
      console.error(`[talkback] ${view.id}: mic access denied:`, e.message);
      if (view.onTalkbackStop) view.onTalkbackStop(view);
      this._stream = null;
      this._resetState();
      return;
    }

    // 3. WebRTC peer connection
    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      this._pc = pc;

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
      tb.connecting = false;
      tb.active = true;
      tb.locked = lock;
      this._render();
      this._startTimer();

      // Auto-enable camera audio
      if (view._state.audio.available && !view._state.audio.unmuted) {
        view.video.muted = false;
        view._setAudioUnmuted(true);
      }

      console.log(`[talkback] ${view.id}: active${lock ? ' (locked)' : ''} → ${streamName}`);
    } catch (e) {
      console.error(`[talkback] ${view.id}: WebRTC failed:`, e.message);
      this._cleanup();
    }
  }

  stop(force = false) {
    const tb = this._view._state.talkback;
    if (tb.locked && !force) return;
    if (!tb.active && !tb.connecting && !this._pc) return;
    console.log(`[talkback] ${this._view.id}: stopping`);
    this._cleanup();
    if (this._view.onTalkbackStop) this._view.onTalkbackStop(this._view);
  }

  // ── Internal ──

  _resetState() {
    this._view._state.talkback.connecting = false;
    this._render();
  }

  _cleanup() {
    this._stopTimer();
    if (this._pc) {
      for (const sender of this._pc.getSenders()) {
        sender.track?.stop();
      }
      this._pc.close();
      this._pc = null;
    }
    this._stream = null;
    const tb = this._view._state.talkback;
    tb.connecting = false;
    tb.active = false;
    tb.locked = false;
    this._render();
  }

  _startTimer() {
    this._startTime = Date.now();
    const timer = this._dom.pttTimer;
    if (!timer) return;
    timer.textContent = '0:00';
    this._timerInterval = setInterval(() => {
      const sec = Math.floor((Date.now() - this._startTime) / 1000);
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      timer.textContent = `${m}:${String(s).padStart(2, '0')}`;
    }, 500);
  }

  _stopTimer() {
    clearInterval(this._timerInterval);
    this._timerInterval = null;
    this._startTime = null;
  }

  // ── Render ──

  _render() {
    const { available, connecting, active, locked } = this._view._state.talkback;
    const isOn = active || locked;

    // PTT button
    const ptt = this._dom.ptt;
    if (ptt) {
      ptt.classList.toggle('has-talkback', available);
      ptt.classList.toggle('connecting', connecting);
      ptt.classList.toggle('active', active && !locked);
      ptt.classList.toggle('locked', locked);
    }

    // Red border on cam cell
    this._view.el.classList.toggle('ptt-active', isOn);

    // Top-right mic status
    const micStatus = this._dom.micStatus;
    if (micStatus) {
      micStatus.classList.toggle('has-talkback', available);
      micStatus.classList.toggle('connecting', connecting);
      micStatus.classList.toggle('active', isOn);
    }

    // Grid HUD mic
    const ghudMic = this._dom.ghudMic;
    if (ghudMic) {
      ghudMic.classList.toggle('has-talkback', available);
      ghudMic.classList.toggle('connecting', connecting);
      ghudMic.classList.toggle('active', isOn);
    }
  }

  // ── DOM ──

  _injectDOM() {
    const el = this._view.el;

    // Mic status icon in top-right
    const topRight = el.querySelector('.cam-top-right');
    if (topRight) {
      const mic = document.createElement('div');
      mic.className = 'cam-mic-status';
      mic.title = 'Intercom — click to toggle (V)';
      mic.innerHTML = `<svg viewBox="0 0 24 24" fill="white"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>`;
      // Insert after audio icon
      const audioWrap = topRight.querySelector('.cam-audio-wrap');
      if (audioWrap) audioWrap.after(mic);
      else topRight.insertBefore(mic, topRight.firstChild);
    }

    // PTT overlay button
    const ptt = document.createElement('div');
    ptt.className = 'cam-ptt';
    ptt.title = 'Push to talk — hold to speak';
    ptt.innerHTML = `
      <div class="cam-ptt-circle">
        <svg viewBox="0 0 24 24" fill="white">
          <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
        </svg>
      </div>
      <span class="cam-ptt-timer">0:00</span>
    `;
    const overlay = el.querySelector('.cam-overlay');
    el.insertBefore(ptt, overlay?.nextSibling);

    // Grid HUD mic icon
    const ghudPill = el.querySelector('.ghud-pill');
    if (ghudPill) {
      const ghudMic = document.createElement('div');
      ghudMic.className = 'ghud-mic-wrap';
      ghudMic.innerHTML = `<svg class="ghud-mic" viewBox="0 0 24 24" fill="white"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>`;
      ghudPill.appendChild(ghudMic);
    }
  }

  _cacheDom() {
    const el = this._view.el;
    this._dom = {
      ptt: el.querySelector('.cam-ptt'),
      pttCircle: el.querySelector('.cam-ptt-circle'),
      pttTimer: el.querySelector('.cam-ptt-timer'),
      micStatus: el.querySelector('.cam-mic-status'),
      ghudMic: el.querySelector('.ghud-mic-wrap'),
    };
  }

  _bindEvents() {
    const view = this._view;

    // Top-right mic icon → toggle
    const micStatus = this._dom.micStatus;
    if (micStatus) {
      micStatus.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!view._state.talkback.available) return;
        this.toggle();
      });
      micStatus.addEventListener('mousedown', (e) => e.stopPropagation());
      micStatus.addEventListener('dblclick', (e) => e.stopPropagation());
    }

    // PTT button — hold to speak, dblclick to lock
    const ptt = this._dom.ptt;
    if (ptt) {
      const pttDown = (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (view._state.talkback.locked) {
          this.stop(true);
          return;
        }
        this.start(false);
      };
      const pttUp = (e) => {
        e.stopPropagation();
        this.stop();
      };
      ptt.addEventListener('mousedown', pttDown);
      ptt.addEventListener('touchstart', pttDown, { passive: false });
      ptt.addEventListener('mouseup', pttUp);
      ptt.addEventListener('mouseleave', pttUp);
      ptt.addEventListener('touchend', pttUp);
      ptt.addEventListener('touchcancel', pttUp);
      ptt.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.toggle();
      });
    }

    // Grid HUD mic → toggle
    this._dom.ghudMic?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!view._state.talkback.available) return;
      this.toggle();
    });
    this._dom.ghudMic?.addEventListener('mousedown', (e) => e.stopPropagation());
    this._dom.ghudMic?.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  destroy() {
    this._cleanup();
    this._dom.ptt?.remove();
    this._dom.micStatus?.remove();
    this._dom.ghudMic?.remove();
    super.destroy();
  }
}
