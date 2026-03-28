/**
 * QualityFeature — SD/HD stream switching with loading animation.
 *
 * Manages HD player lifecycle, quality state, resolution badge
 * in both fullscreen and grid HUD.
 */

import { Feature } from '../core/feature.js';
import { CamPlayer } from '../core/camera-player.js';

export class QualityFeature extends Feature {
  attach(view) {
    super.attach(view);

    // State slice
    if (!view._state.quality) {
      view._state.quality = {
        current: 'sd',     // 'sd' | 'hd'
        loading: null,     // null | 'sd' | 'hd'
        pending: null,     // null | 'sd' | 'hd'
        playbackRes: null, // null | 'original' | '1080p' etc
      };
    }

    this._hdPlayer = null;
    this._hdStream = null;

    this._injectDOM();
    this._cacheDom();
    this._bindEvents();
    this._render();
  }

  // ── Feature hooks ──

  onStreamReady() {
    this._finalize();
  }

  onWirePlayer(player, mode) {
    if (mode === 'hd') {
      // HD connection failed → auto-fallback to SD
      player.onConnectionError = () => {
        console.warn(`[camera-view] ${this._view.id}: HD connection error, falling back to SD`);
        this._hdPlayer?.disable();
        this._hdPlayer = null;
        const failedStream = this._hdStream;
        this._hdStream = null;
        this._view._state.quality.current = 'sd';
        this._view._state.quality.loading = null;
        this._view._state.quality.pending = null;
        this._view._switchPlayer(this._view.player);
        this._render();
        if (this._view.onHdError) this._view.onHdError(this._view, failedStream);
      };
      player.onStreamNotFound = () => {
        player.onConnectionError();
      };
    }
  }

  onDisable() {
    if (this._hdPlayer) {
      this._hdPlayer.disable();
      this._hdPlayer = null;
      this._hdStream = null;
    }
  }

  getState() {
    const q = this._view._state.quality;
    if (q.current === 'sd' && !q.playbackRes) return {};
    return {
      quality: {
        current: q.current,
        playbackRes: q.playbackRes,
      },
    };
  }

  restoreState(state) {
    // HD restore requires app-level coordination (API call) — not done here
  }

  // ── Public API ──

  get isHd() { return !!this._hdStream; }
  get hdStreamName() { return this._hdStream; }

  startHd(streamName, forceMSE = false) {
    const view = this._view;
    if (this._hdPlayer) {
      this._hdPlayer.disable();
      this._hdPlayer = null;
    }

    this._hdStream = streamName;
    view._showLoading('switching to hd');

    this._hdPlayer = new CamPlayer(view.video, streamName, { preferH265: forceMSE });
    view._wirePlayer(this._hdPlayer, 'hd');

    const useMSE = forceMSE && !CamPlayer.h265WebRTCSupported;
    view._switchPlayer(this._hdPlayer, useMSE ? 'mse' : 'start');

    view._state.quality.pending = 'hd';
    this._render();
  }

  stopHd() {
    const view = this._view;
    if (this._hdPlayer) {
      this._hdPlayer.disable();
      this._hdPlayer = null;
    }
    this._hdStream = null;

    view._showLoading('switching to sd');
    view._switchPlayer(view.player);

    view._state.quality.pending = 'sd';
    this._render();
  }

  setLoading(target) {
    this._view._state.quality.loading = target;
    this._render();
  }

  cancelLoading() {
    this._view._state.quality.loading = null;
    this._view._state.quality.pending = null;
    this._render();
  }

  /** Set playback resolution label (called by PlaybackFeature). */
  setPlaybackResolution(res) {
    this._view._state.quality.playbackRes = res;
    this._render();
  }

  /** Switch quality toggle to playback mode (show resolution instead of SD/HD). */
  enterPlaybackMode(resolution) {
    const toggle = this._dom.qualityToggle;
    if (toggle) {
      toggle.dataset.mode = 'playback';
      toggle.innerHTML = `<span class="quality-res">${resolution === 'original' ? 'SRC' : resolution}</span>`;
      this._recacheDom();
    }
    this._view._state.quality.playbackRes = resolution;
    this._render();
  }

  /** Restore SD/HD toggle after leaving playback. */
  exitPlaybackMode() {
    const toggle = this._dom.qualityToggle;
    if (toggle) {
      toggle.dataset.mode = '';
      toggle.innerHTML = '<span class="quality-opt quality-sd active">SD</span><span class="quality-opt quality-hd">HD</span>';
      this._recacheDom();
    }
    const q = this._view._state.quality;
    q.current = 'sd';
    q.loading = null;
    q.pending = null;
    q.playbackRes = null;
    this._render();
  }

  // ── Internal ──

  _finalize() {
    const q = this._view._state.quality;
    if (q.pending) {
      q.current = q.pending;
      q.pending = null;
    }
    q.loading = null;

    // Defensive: sync with actual active player
    if (!this._view.isPlayback) {
      const actualHd = this._view._activePlayer === this._hdPlayer;
      if (actualHd && q.current !== 'hd') q.current = 'hd';
      else if (!actualHd && q.current !== 'sd') q.current = 'sd';
    }
    this._render();
  }

  _render() {
    const { current, loading, pending, playbackRes } = this._view._state.quality;
    const inPlayback = this._view.isPlayback;

    // Fullscreen HUD
    if (this._dom.qualitySd) {
      this._dom.qualitySd.classList.toggle('active', !inPlayback && current === 'sd' && !loading);
      this._dom.qualitySd.classList.toggle('loading', loading === 'sd');
    }
    if (this._dom.qualityHd) {
      this._dom.qualityHd.classList.toggle('active', !inPlayback && current === 'hd');
      this._dom.qualityHd.classList.toggle('loading', loading === 'hd');
    }
    if (this._dom.qualityToggle) {
      this._dom.qualityToggle.classList.toggle('hd-active', current === 'hd' && !inPlayback);
    }

    // Grid HUD
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

  // ── DOM ──

  _injectDOM() {
    const el = this._view.el;

    // Quality toggle in top-right
    const topRight = el.querySelector('.cam-top-right');
    if (topRight) {
      const toggle = document.createElement('div');
      toggle.className = 'cam-quality-toggle';
      toggle.title = 'Toggle SD/HD stream (H)';
      toggle.innerHTML = '<span class="quality-opt quality-sd active">SD</span><span class="quality-opt quality-hd">HD</span>';
      topRight.appendChild(toggle);
    }

    // Grid HUD quality badges
    const ghudInfo = el.querySelector('.ghud-info');
    if (ghudInfo) {
      const wrap = document.createElement('div');
      wrap.className = 'ghud-quality';
      wrap.innerHTML = '<span class="ghud-q-sd active">SD</span><span class="ghud-q-hd">HD</span><span class="ghud-q-res"></span>';
      ghudInfo.appendChild(wrap);
    }
  }

  _cacheDom() {
    const el = this._view.el;
    this._dom = {
      qualityToggle: el.querySelector('.cam-quality-toggle'),
      qualitySd: el.querySelector('.quality-sd'),
      qualityHd: el.querySelector('.quality-hd'),
      qualityRes: el.querySelector('.quality-res'),
      ghudQSd: el.querySelector('.ghud-q-sd'),
      ghudQHd: el.querySelector('.ghud-q-hd'),
      ghudQRes: el.querySelector('.ghud-q-res'),
    };
  }

  _recacheDom() {
    const toggle = this._dom.qualityToggle;
    if (toggle) {
      this._dom.qualitySd = toggle.querySelector('.quality-sd');
      this._dom.qualityHd = toggle.querySelector('.quality-hd');
      this._dom.qualityRes = toggle.querySelector('.quality-res');
    }
  }

  _bindEvents() {
    const view = this._view;

    // Fullscreen quality toggle click
    this._dom.qualityToggle?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (view.isPlayback) return;
      const clickedOpt = e.target.closest('.quality-opt');
      if (!clickedOpt) return;
      const wantHd = clickedOpt.classList.contains('quality-hd');
      if (wantHd === (view._state.quality.current === 'hd')) return;
      this.setLoading(wantHd ? 'hd' : 'sd');
      if (view.onHdToggle) view.onHdToggle(view, wantHd);
    });

    // Grid HUD quality toggle click
    const ghudQuality = this._view.el.querySelector('.ghud-quality');
    ghudQuality?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (view.isPlayback) return;
      const clickedOpt = e.target.closest('.ghud-q-sd, .ghud-q-hd');
      if (!clickedOpt) return;
      const wantHd = clickedOpt.classList.contains('ghud-q-hd');
      if (wantHd === (view._state.quality.current === 'hd')) return;
      this.setLoading(wantHd ? 'hd' : 'sd');
      if (view.onHdToggle) view.onHdToggle(view, wantHd);
    });
  }

  destroy() {
    if (this._hdPlayer) {
      this._hdPlayer.disable();
      this._hdPlayer = null;
    }
    this._dom.qualityToggle?.remove();
    this._view.el.querySelector('.ghud-quality')?.remove();
    super.destroy();
  }
}
