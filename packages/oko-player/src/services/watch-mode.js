/**
 * WatchMode — motion detection orchestrator for camera grid.
 *
 * Scans visible cameras periodically, detects frame changes,
 * manages per-camera motion state with cooldown, and optionally
 * filters grid to show only cameras with activity.
 *
 * Architecture:
 *   WatchMode (1)  ←→  MotionDetector (N, one per camera)
 *       ↓
 *   CSS classes on camera elements (.watch-motion, .watch-cooldown)
 *       ↓
 *   Callbacks: onMotionUpdate(count, cameras[])
 *
 * Usage:
 *   const wm = new WatchMode(grid.cameras);
 *   wm.onMotionUpdate = (count, activeCams) => updateBadge(count);
 *   wm.start();
 *   wm.sensitivity = 5;       // 1–10
 *   wm.motionFilter = true;   // show only active cameras
 *   wm.stop();
 */

import { MotionDetector } from './motion-detector.js';

const SCAN_INTERVAL = 1000;    // ms between scans
const COOLDOWN_MS = 15000;     // how long to keep motion highlight after last detection
const SCORE_THRESHOLDS = [
  20, 15, 12, 9, 7, 5, 4, 3, 2, 1 // sensitivity 1–10 → % of changed pixels needed
];

export class WatchMode {
  /**
   * @param {Array<import('../core/camera-view.js').CameraView>} cameras
   */
  constructor(cameras) {
    this._cameras = cameras;
    this._detectors = new Map();  // cameraId → MotionDetector
    this._state = new Map();     // cameraId → { status: 'idle'|'motion'|'cooldown', lastMotion: number }
    this._scanTimer = null;
    this._active = false;
    this._sensitivity = 5;      // 1–10
    this._motionFilter = false;
    this._gridEl = null;

    /** Callback: (activeCount: number, activeCameraIds: string[]) => void */
    this.onMotionUpdate = null;
  }

  /** Current sensitivity (1–10). */
  get sensitivity() { return this._sensitivity; }
  set sensitivity(val) {
    this._sensitivity = Math.max(1, Math.min(10, Math.round(val)));
  }

  /** Whether to filter grid to motion-only cameras. */
  get motionFilter() { return this._motionFilter; }
  set motionFilter(val) {
    this._motionFilter = !!val;
    this._applyFilter();
  }

  /** Whether watch mode is running. */
  get isActive() { return this._active; }

  /** Currently active camera IDs (in motion or cooldown). */
  get activeCameraIds() {
    const ids = [];
    for (const [id, st] of this._state) {
      if (st.status !== 'idle') ids.push(id);
    }
    return ids;
  }

  /** Set the grid container element (for filter mode CSS class). */
  set gridElement(el) { this._gridEl = el; }

  /**
   * Update camera list (e.g. after discovery adds new cameras).
   * @param {Array} cameras
   */
  updateCameras(cameras) {
    this._cameras = cameras;
    if (this._active) this._syncDetectors();
  }

  // ── Lifecycle ──

  start() {
    if (this._active) return;
    this._active = true;
    this._syncDetectors();
    this._scanTimer = setInterval(() => this._scan(), SCAN_INTERVAL);
    console.log(`[watch] Started — scanning ${this._detectors.size} cameras, sensitivity=${this._sensitivity}`);
  }

  stop() {
    if (!this._active) return;
    this._active = false;
    clearInterval(this._scanTimer);
    this._scanTimer = null;

    // Clear all states and CSS
    for (const [id, det] of this._detectors) {
      det.destroy();
    }
    this._detectors.clear();

    for (const cam of this._cameras) {
      cam.el.classList.remove('watch-motion', 'watch-cooldown', 'watch-hidden');
      this._removeHudDot(cam);
    }
    this._state.clear();

    if (this._gridEl) {
      this._gridEl.classList.remove('watch-filter-mode');
      this._gridEl.style.removeProperty('--watch-cols');
    }
    this._emitUpdate();
    console.log('[watch] Stopped');
  }

  destroy() {
    this.stop();
    this.onMotionUpdate = null;
    this._cameras = null;
  }

  // ── Internal: detector management ──

  /** Sync detectors to current camera list. Create/remove as needed. */
  _syncDetectors() {
    const currentIds = new Set(this._cameras.map(c => c.id));

    // Remove detectors for cameras that no longer exist
    for (const [id, det] of this._detectors) {
      if (!currentIds.has(id)) {
        det.destroy();
        this._detectors.delete(id);
        this._state.delete(id);
      }
    }

    // Create detectors for new cameras
    for (const cam of this._cameras) {
      if (!this._detectors.has(cam.id)) {
        this._detectors.set(cam.id, new MotionDetector(cam.video));
        this._state.set(cam.id, { status: 'idle', lastMotion: 0 });
      }
    }
  }

  // ── Internal: scan loop ──

  _scan() {
    if (!this._active) return;
    const now = Date.now();
    const threshold = SCORE_THRESHOLDS[this._sensitivity - 1] ?? 4;
    let changed = false;

    for (const cam of this._cameras) {
      const det = this._detectors.get(cam.id);
      if (!det) continue;

      const st = this._state.get(cam.id);
      const score = det.analyze();

      // Skip cameras with no video (-1 = not playing)
      if (score < 0) continue;

      if (score >= threshold) {
        // Motion detected
        const wasIdle = st.status === 'idle';
        st.status = 'motion';
        st.lastMotion = now;
        if (wasIdle) {
          cam.el.classList.add('watch-motion');
          cam.el.classList.remove('watch-cooldown');
          this._addHudDot(cam);
          changed = true;
        }
      } else if (st.status === 'motion') {
        // Was in motion, now quiet → enter cooldown
        const elapsed = now - st.lastMotion;
        if (elapsed > SCAN_INTERVAL * 2) {
          st.status = 'cooldown';
          cam.el.classList.remove('watch-motion');
          cam.el.classList.add('watch-cooldown');
          changed = true;
        }
      } else if (st.status === 'cooldown') {
        // In cooldown — check if expired
        const elapsed = now - st.lastMotion;
        if (elapsed >= COOLDOWN_MS) {
          st.status = 'idle';
          cam.el.classList.remove('watch-cooldown');
          this._removeHudDot(cam);
          changed = true;
        }
      }
    }

    if (changed) {
      this._applyFilter();
      this._emitUpdate();
    }
  }

  // ── Internal: UI helpers ──

  _addHudDot(cam) {
    const info = cam._dom?.ghudInfo;
    if (!info || info.querySelector('.watch-dot')) return;
    const dot = document.createElement('span');
    dot.className = 'watch-dot';
    // Insert after ghud-pill (camera name)
    const pill = info.querySelector('.ghud-pill');
    if (pill) pill.after(dot);
    else info.prepend(dot);
  }

  _removeHudDot(cam) {
    const dot = cam._dom?.ghudInfo?.querySelector('.watch-dot');
    if (dot) dot.remove();
  }

  /** Apply motion-only filter: hide idle cameras when filter is on. */
  _applyFilter() {
    if (!this._motionFilter) {
      // Remove all watch-hidden and restore grid
      for (const cam of this._cameras) {
        cam.el.classList.remove('watch-hidden');
      }
      if (this._gridEl) {
        this._gridEl.classList.remove('watch-filter-mode');
        this._gridEl.style.removeProperty('--watch-cols');
      }
      return;
    }

    if (this._gridEl) this._gridEl.classList.add('watch-filter-mode');

    let visibleCount = 0;
    for (const cam of this._cameras) {
      const st = this._state.get(cam.id);
      const visible = st && st.status !== 'idle';
      cam.el.classList.toggle('watch-hidden', !visible);
      if (visible) visibleCount++;
    }

    // Dynamic columns: optimize tile size based on visible count
    let cols;
    if (visibleCount <= 1) cols = 1;
    else if (visibleCount <= 2) cols = 2;
    else if (visibleCount <= 4) cols = 2;
    else if (visibleCount <= 6) cols = 3;
    else if (visibleCount <= 9) cols = 3;
    else if (visibleCount <= 12) cols = 4;
    else cols = Math.ceil(Math.sqrt(visibleCount));

    if (this._gridEl) {
      this._gridEl.style.setProperty('--watch-cols', cols);
    }
  }

  _emitUpdate() {
    const ids = this.activeCameraIds;
    if (this.onMotionUpdate) this.onMotionUpdate(ids.length, ids);
  }
}
