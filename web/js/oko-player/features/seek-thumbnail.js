/**
 * SeekThumbnail — thumbnail preview on seek timeline hover.
 *
 * State machine: idle → loading → pinned
 *   idle:    mouse moving, waiting 500ms pause on same minute
 *   loading: dot visible, XHR fetching thumbnail from backend
 *   pinned:  thumbnail image visible, click → seek to that time
 *
 * Usage:
 *   const thumb = new SeekThumbnail({ seekBar, dom, cameraId, getBaseDate, onSeek });
 *   // in seekBar mousemove:
 *   thumb.update(fraction, hours, minutes, isUnavailable);
 *   // in seekBar mouseleave:
 *   thumb.dismiss(e);
 *   // cleanup:
 *   thumb.destroy();
 */

import { pad, fmtFull } from '../core/utils.js';

export class SeekThumbnail {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.seekBar — seek bar element (for width calculations)
   * @param {object} opts.dom — DOM refs: seekThumbDot, seekRingFill, seekThumbnail,
   *   seekThumbImg, seekThumbTime, seekThumbProgress, seekThumbSpinner, seekThumbMarker
   * @param {string} opts.cameraId — camera ID for API call
   * @param {() => Date} opts.getBaseDate — returns midnight of current day
   * @param {(hours: number, minutes: number) => void} opts.onSeek — called when thumbnail clicked
   */
  constructor({ seekBar, dom, cameraId, getBaseDate, onSeek }) {
    this._seekBar = seekBar;
    this._dom = dom;
    this._cameraId = cameraId;
    this._getBaseDate = getBaseDate;
    this._onSeek = onSeek;

    this._state = 'idle'; // idle | loading | pinned
    this._lastKey = '';
    this._pinnedTime = null;
    this._dotTimer = null;
    this._xhr = null;

    this._bindThumbnailClick();
    this._bindThumbnailLeave();
  }

  /**
   * Update thumbnail on mouse move. Call from seekBar mousemove handler.
   * @param {number} fraction — 0..1 position on bar
   * @param {number} hours
   * @param {number} minutes
   * @param {boolean} isUnavailable — true if hovering over future/unavailable zone
   */
  update(fraction, hours, minutes, isUnavailable) {
    const d = this._dom;
    if (!d.seekThumbDot || !d.seekThumbnail) return;

    // In unavailable zone: hide thumbnail unless pinned
    if (isUnavailable) {
      if (this._state !== 'pinned') {
        d.seekThumbDot.classList.remove('visible');
        d.seekThumbnail.classList.remove('visible', 'pinned');
        d.seekThumbMarker?.classList.remove('visible');
        this._cancelTimers();
        this._state = 'idle';
      }
      return;
    }

    const key = `${this._cameraId}_${pad(hours)}${pad(minutes)}`;
    const pct = `${fraction * 100}%`;

    // When pinned: thumbnail stays at fixed position, only dot follows cursor
    if (this._state === 'pinned') {
      d.seekThumbDot.style.left = pct;
      return;
    }

    // Position follows cursor
    d.seekThumbDot.style.left = pct;
    this._clampThumbnailPosition(fraction);

    if (key === this._lastKey) return; // same minute, timer already running

    // New minute — reset cycle
    this._lastKey = key;
    this._state = 'idle';
    this._resetVisuals();
    this._cancelTimers();

    const thisHours = hours, thisMinutes = minutes;

    // 500ms pause → show dot + start fetch
    this._dotTimer = setTimeout(() => {
      if (this._lastKey !== key) return;
      this._state = 'loading';
      this._showDot(pct, thisHours, thisMinutes);
      this._fetchThumbnail(key, pct, thisHours, thisMinutes);
    }, 500);
  }

  /**
   * Handle mouseleave from seekBar.
   * @param {MouseEvent} e
   */
  dismiss(e) {
    // Don't dismiss if mouse moved to the pinned thumbnail itself
    if (this._state === 'pinned' && this._dom.seekThumbnail?.contains(e?.relatedTarget)) return;
    this._fullDismiss();
  }

  /** Force dismiss regardless of state. */
  _fullDismiss() {
    const d = this._dom;
    d.seekThumbDot?.classList.remove('visible');
    d.seekThumbnail?.classList.remove('visible', 'pinned');
    d.seekThumbMarker?.classList.remove('visible');
    this._cancelTimers();
    if (this._xhr) { this._xhr.abort(); this._xhr = null; }
    this._lastKey = '';
    this._state = 'idle';
    this._pinnedTime = null;
  }

  /** Cleanup on destroy. */
  destroy() {
    this._fullDismiss();
    this._seekBar = null;
    this._dom = null;
  }

  // ── Internal: visuals ──

  _resetVisuals() {
    const d = this._dom;
    d.seekThumbDot.classList.remove('visible');
    d.seekThumbnail.classList.remove('visible', 'pinned');
    d.seekThumbMarker?.classList.remove('visible');
    if (d.seekRingFill) {
      d.seekRingFill.style.transition = 'none';
      d.seekRingFill.style.strokeDashoffset = '53.4';
    }
    if (d.seekThumbProgress) {
      d.seekThumbProgress.style.transition = 'none';
      d.seekThumbProgress.style.width = '0';
    }
    if (d.seekThumbSpinner) d.seekThumbSpinner.style.display = '';
    if (d.seekThumbImg) d.seekThumbImg.style.opacity = '0';
  }

  _clampThumbnailPosition(fraction) {
    const barW = this._seekBar.offsetWidth;
    const thumbW = this._dom.seekThumbnail.offsetWidth || 200;
    const halfThumb = thumbW / 2;
    const cursorPx = fraction * barW;
    const clampedPx = Math.max(halfThumb, Math.min(barW - halfThumb, cursorPx));
    this._dom.seekThumbnail.style.left = `${clampedPx}px`;
  }

  _showDot(pct, hours, minutes) {
    const d = this._dom;
    d.seekThumbDot.classList.add('visible');
    if (d.seekThumbTime) d.seekThumbTime.textContent = `${pad(hours)}:${pad(minutes)}`;
    if (d.seekThumbMarker) {
      d.seekThumbMarker.style.left = pct;
      d.seekThumbMarker.classList.add('visible');
    }
    if (d.seekRingFill) {
      d.seekRingFill.style.transition = 'none';
      d.seekRingFill.style.strokeDashoffset = '53.4';
    }
  }

  // ── Internal: fetch ──

  _fetchThumbnail(key, pct, hours, minutes) {
    const d = this._dom;
    const baseDate = this._getBaseDate();
    const thumbDate = new Date(baseDate);
    thumbDate.setHours(hours, minutes, 0, 0);
    const iso = fmtFull(thumbDate);

    const xhr = new XMLHttpRequest();
    this._xhr = xhr;
    xhr.open('GET', `/backend/playback-thumbnail/${this._cameraId}?t=${iso}`);
    xhr.responseType = 'blob';

    // Ring progress driven by XHR
    let ringStarted = false;
    xhr.onprogress = (evt) => {
      if (this._lastKey !== key) return;
      if (evt.lengthComputable && d.seekRingFill) {
        const p = evt.loaded / evt.total;
        d.seekRingFill.style.transition = 'stroke-dashoffset 0.2s';
        d.seekRingFill.style.strokeDashoffset = `${53.4 * (1 - p)}`;
      } else if (!ringStarted && d.seekRingFill) {
        ringStarted = true;
        d.seekRingFill.style.transition = 'stroke-dashoffset 3s linear';
        d.seekRingFill.style.strokeDashoffset = '5';
      }
    };

    // Indeterminate ring fallback if no progress events
    const ringFallback = setTimeout(() => {
      if (this._lastKey !== key || ringStarted) return;
      ringStarted = true;
      if (d.seekRingFill) {
        d.seekRingFill.style.transition = 'stroke-dashoffset 3s linear';
        d.seekRingFill.style.strokeDashoffset = '5';
      }
    }, 100);

    xhr.onload = () => {
      clearTimeout(ringFallback);
      this._xhr = null;
      if (this._lastKey !== key || xhr.status !== 200) return;

      this._state = 'pinned';
      this._pinnedTime = { hours, minutes };

      // Complete ring animation
      if (d.seekRingFill) {
        d.seekRingFill.style.transition = 'stroke-dashoffset 0.15s';
        d.seekRingFill.style.strokeDashoffset = '0';
      }

      // After ring completes → reveal thumbnail image
      setTimeout(() => {
        if (this._lastKey !== key) return;
        d.seekThumbDot.classList.remove('visible');
        if (d.seekThumbSpinner) d.seekThumbSpinner.style.display = 'none';
        if (d.seekThumbProgress) {
          d.seekThumbProgress.style.transition = 'none';
          d.seekThumbProgress.style.width = '100%';
        }
        d.seekThumbnail.classList.add('visible', 'pinned');
        const url = URL.createObjectURL(xhr.response);
        if (d.seekThumbImg) {
          d.seekThumbImg.onload = () => URL.revokeObjectURL(url);
          d.seekThumbImg.src = url;
          d.seekThumbImg.style.opacity = '1';
        }
      }, 200);
    };

    xhr.onerror = () => {
      clearTimeout(ringFallback);
      this._xhr = null;
      if (this._lastKey !== key) return;
      d.seekThumbDot.classList.remove('visible');
      d.seekThumbMarker?.classList.remove('visible');
      this._state = 'idle';
    };

    xhr.send();
  }

  // ── Internal: events ──

  _bindThumbnailClick() {
    const thumb = this._dom.seekThumbnail;
    if (!thumb) return;
    thumb.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this._pinnedTime) return;
      const { hours, minutes } = this._pinnedTime;
      this._fullDismiss();
      if (this._onSeek) this._onSeek(hours, minutes);
    });
  }

  _bindThumbnailLeave() {
    const thumb = this._dom.seekThumbnail;
    if (!thumb) return;
    thumb.addEventListener('mouseleave', (e) => {
      if (this._state !== 'pinned') return;
      if (this._seekBar.contains(e.relatedTarget)) return;
      this._fullDismiss();
    });
  }

  _cancelTimers() {
    clearTimeout(this._dotTimer);
    this._dotTimer = null;
  }
}
