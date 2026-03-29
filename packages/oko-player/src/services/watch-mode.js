/**
 * WatchMode — motion detection + AI classification orchestrator.
 *
 * Two-stage pipeline:
 *   Stage 1: MotionDetector (frame diff, cheap, runs on all cameras every 1s)
 *   Stage 2: ObjectClassifier (MediaPipe AI, runs only on cameras with motion)
 *
 * Key behavior: type checkboxes control HIGHLIGHTING, not just filtering.
 *   Motion ☑ → border on any frame change (wind, shadows, etc.)
 *   Motion ☐, Human ☑ → border ONLY when AI confirms a person
 *   This means: if Motion is off, wind-blown trees = no border.
 *
 * Usage:
 *   const wm = new WatchMode(grid.cameras);
 *   wm.onMotionUpdate = (count, ids, summary) => updateBadge(count);
 *   wm.start();
 *   wm.sensitivity = 5;
 *   wm.typeFilter = { motion: false, human: true, vehicle: true, animal: false };
 *   wm.motionFilter = true;  // "Detected only" — hide non-matching cameras
 *   wm.stop();
 */

import { MotionDetector } from './motion-detector.js';
import { ObjectClassifier } from './object-classifier.js';

const SCAN_INTERVAL = 1000;
const COOLDOWN_MS = 15000;
const SCORE_THRESHOLDS = [
  20, 15, 12, 9, 7, 5, 4, 3, 2, 1
];

export class WatchMode {
  constructor(cameras) {
    this._cameras = cameras;
    this._detectors = new Map();
    this._state = new Map();
    this._scanTimer = null;
    this._active = false;
    this._sensitivity = 5;
    this._motionFilter = false;
    this._typeFilter = { motion: true, human: true, vehicle: true, animal: true };
    this._gridEl = null;
    this._classifier = new ObjectClassifier();
    this._classifyQueue = null;

    this.onMotionUpdate = null;
    this.onClassifierReady = null;
  }

  // ── Properties ──

  get sensitivity() { return this._sensitivity; }
  set sensitivity(val) { this._sensitivity = Math.max(1, Math.min(10, Math.round(val))); }

  get motionFilter() { return this._motionFilter; }
  set motionFilter(val) { this._motionFilter = !!val; this._applyVisibility(); }

  get typeFilter() { return { ...this._typeFilter }; }
  set typeFilter(val) {
    this._typeFilter = {
      motion: val.motion ?? true, human: val.human ?? true,
      vehicle: val.vehicle ?? true, animal: val.animal ?? true,
    };
    this._reapplyAllHighlights();
    this._applyVisibility();
    this._emitUpdate();
  }

  get isActive() { return this._active; }

  get activeCameraIds() {
    const ids = [];
    for (const [id, st] of this._state) {
      if (this._isVisible(st)) ids.push(id);
    }
    return ids;
  }

  get detectionSummary() {
    let humans = 0, vehicles = 0, animals = 0, unknown = 0;
    for (const [, st] of this._state) {
      if (st.status === 'idle') continue;
      if (!this._isVisible(st)) continue;
      const type = st.confirmedType;
      if (type === 'human') humans++;
      else if (type === 'vehicle') vehicles++;
      else if (type === 'animal') animals++;
      else unknown++;
    }
    return { humans, vehicles, animals, unknown };
  }

  set gridElement(el) { this._gridEl = el; }

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
    this._classifier.init().then(ok => {
      if (ok) {
        console.log('[watch] AI classifier ready — Stage 2 enabled');
        if (this.onClassifierReady) this.onClassifierReady(true);
      } else {
        console.warn('[watch] AI classifier failed:', this._classifier.error);
        if (this.onClassifierReady) this.onClassifierReady(false, this._classifier.error);
      }
    }).catch(err => {
      console.error('[watch] AI classifier exception:', err);
      if (this.onClassifierReady) this.onClassifierReady(false, String(err));
    });
    console.log(`[watch] Started — ${this._detectors.size} cameras, sensitivity=${this._sensitivity}`);
  }

  stop() {
    if (!this._active) return;
    this._active = false;
    clearInterval(this._scanTimer);
    this._scanTimer = null;
    for (const [, det] of this._detectors) det.destroy();
    this._detectors.clear();
    for (const cam of this._cameras) {
      cam.el.classList.remove('watch-motion', 'watch-cooldown', 'watch-hidden', 'watch-human', 'watch-vehicle', 'watch-animal');
      this._removeHudDot(cam);
    }
    this._state.clear();
    if (this._gridEl) {
      this._gridEl.classList.remove('watch-filter-mode');
    }
    this._emitUpdate();
    console.log('[watch] Stopped');
  }

  destroy() {
    this.stop();
    this.onMotionUpdate = null;
    this.onClassifierReady = null;
    this._cameras = null;
  }

  // ── Detector management ──

  _syncDetectors() {
    const currentIds = new Set(this._cameras.map(c => c.id));
    for (const [id, det] of this._detectors) {
      if (!currentIds.has(id)) { det.destroy(); this._detectors.delete(id); this._state.delete(id); }
    }
    for (const cam of this._cameras) {
      if (!this._detectors.has(cam.id)) {
        this._detectors.set(cam.id, new MotionDetector(cam.video));
        this._state.set(cam.id, this._freshState());
      }
    }
  }

  _freshState() {
    return {
      status: 'idle', lastMotion: 0, lastClassified: 0,
      detections: [], pendingType: null, confirmCount: 0,
      confirmedType: null, finalCheckDone: false,
    };
  }

  // ── Scan loop ──

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
      if (score < 0) continue;

      if (score >= threshold) {
        // Stage 1: motion detected
        const wasIdle = st.status === 'idle' || st.status === 'cooldown';
        st.status = 'motion';
        st.lastMotion = now;
        st.finalCheckDone = false;
        if (wasIdle) {
          this._applyHighlight(cam, st);
          changed = true;
        }
        // Queue for AI classification
        if (this._classifier.isReady && (!st.lastClassified || now - st.lastClassified > 3000)) {
          if (!this._classifyQueue) this._classifyQueue = [];
          this._classifyQueue.push(cam);
        }
      } else if (st.status === 'motion') {
        if (now - st.lastMotion > SCAN_INTERVAL * 2) {
          st.status = 'cooldown';
          cam.el.classList.remove('watch-motion');
          cam.el.classList.add('watch-cooldown');
          changed = true;
        }
      } else if (st.status === 'cooldown') {
        if (now - st.lastMotion >= COOLDOWN_MS) {
          // Before going idle: final AI check on current frame
          if (this._classifier.isReady && !st.finalCheckDone) {
            st.finalCheckDone = true;
            const finalCam = cam;
            const finalSt = st;
            setTimeout(() => {
              if (!this._active || finalSt.status !== 'cooldown') return;
              const objects = this._classifier.detect(finalCam.video);
              const motionDet = this._detectors.get(finalCam.id);
              const region = motionDet?.motionRegion;
              const filtered = region
                ? objects.filter(o => o.box && this._boxOverlapsRegion(o.box, region, finalCam.video))
                : objects;
              if (filtered.length > 0) {
                // Object still in frame — extend cooldown
                finalSt.lastMotion = Date.now();
                finalSt.finalCheckDone = false;
                const primary = this._getPrimaryType(filtered);
                finalSt.detections = filtered;
                finalSt.confirmedType = primary;
                this._applyHighlight(finalCam, finalSt);
                this._applyVisibility();
                this._emitUpdate();
              } else {
                // Nothing found — go idle
                finalSt.status = 'idle';
                finalSt.detections = [];
                finalSt.lastClassified = 0;
                finalSt.pendingType = null;
                finalSt.confirmCount = 0;
                finalSt.confirmedType = null;
                finalSt.finalCheckDone = false;
                finalCam.el.classList.remove('watch-motion', 'watch-cooldown', 'watch-human', 'watch-vehicle', 'watch-animal');
                this._removeHudDot(finalCam);
                this._applyVisibility();
                this._emitUpdate();
              }
            }, 0);
          } else if (!this._classifier.isReady) {
            // No AI available — go idle immediately
            st.status = 'idle';
            st.detections = [];
            st.lastClassified = 0;
            st.pendingType = null;
            st.confirmCount = 0;
            st.confirmedType = null;
            cam.el.classList.remove('watch-motion', 'watch-cooldown', 'watch-human', 'watch-vehicle', 'watch-animal');
            this._removeHudDot(cam);
            changed = true;
          }
          // If finalCheckDone is true, we wait for the async result
        }
      }
    }

    if (changed) { this._applyVisibility(); this._emitUpdate(); }

    // Stage 2: classify one camera per cycle (non-blocking)
    if (this._classifyQueue?.length) {
      const cam = this._classifyQueue.shift();
      this._classifyQueue = null;
      const st = this._state.get(cam.id);
      if (st && st.status === 'motion') {
        st.lastClassified = Date.now();
        setTimeout(() => {
          if (!this._active) return;
          const objects = this._classifier.detect(cam.video);
          const motionDet = this._detectors.get(cam.id);
          const region = motionDet?.motionRegion;
          const filtered = region
            ? objects.filter(o => o.box && this._boxOverlapsRegion(o.box, region, cam.video))
            : objects;

          if (filtered.length > 0) {
            const primary = this._getPrimaryType(filtered);
            if (primary === st.pendingType) {
              st.confirmCount = (st.confirmCount || 0) + 1;
            } else {
              st.pendingType = primary;
              st.confirmCount = 1;
            }
            if (st.confirmCount >= 2) {
              st.detections = filtered;
              st.confirmedType = primary;
              // AI confirmed — re-evaluate highlight (may show border that was hidden)
              this._applyHighlight(cam, st);
              this._applyVisibility();
              this._emitUpdate();
            }
          } else {
            st.pendingType = null;
            st.confirmCount = 0;
          }
        }, 0);
      }
    }
  }

  // ── Highlight logic ──

  /**
   * Should this camera be visually highlighted?
   * Based on internal status + confirmedType + typeFilter checkboxes.
   */
  _isVisible(st) {
    if (st.status === 'idle') return false;
    const tf = this._typeFilter;
    const type = st.confirmedType;
    if (type === 'human') return tf.human;
    if (type === 'vehicle') return tf.vehicle;
    if (type === 'animal') return tf.animal;
    // No AI classification yet — show only if Motion checkbox is on
    return tf.motion;
  }

  /**
   * Apply or remove CSS border/dot for a camera based on _isVisible().
   */
  _applyHighlight(cam, st) {
    const show = this._isVisible(st);
    if (show) {
      cam.el.classList.add('watch-motion');
      cam.el.classList.remove('watch-cooldown');
      this._addHudDot(cam);
      cam.el.classList.remove('watch-human', 'watch-vehicle', 'watch-animal');
      if (st.confirmedType && st.confirmedType !== 'unknown') {
        cam.el.classList.add(`watch-${st.confirmedType}`);
        this._updateHudDotType(cam, st.confirmedType, st.detections);
      }
    } else {
      cam.el.classList.remove('watch-motion', 'watch-cooldown', 'watch-human', 'watch-vehicle', 'watch-animal');
      this._removeHudDot(cam);
    }
  }

  /** Re-evaluate all cameras after typeFilter change. */
  _reapplyAllHighlights() {
    for (const cam of this._cameras) {
      const st = this._state.get(cam.id);
      if (!st || st.status === 'idle') continue;
      this._applyHighlight(cam, st);
    }
  }

  // ── Grid filter ("Detected only") ──

  _applyVisibility() {
    if (!this._motionFilter) {
      for (const cam of this._cameras) cam.el.classList.remove('watch-hidden');
      if (this._gridEl) this._gridEl.classList.remove('watch-filter-mode');
      return;
    }
    if (this._gridEl) this._gridEl.classList.add('watch-filter-mode');
    for (const cam of this._cameras) {
      const st = this._state.get(cam.id);
      // Fullscreen camera is always visible — guard can keep watching
      const visible = cam.isFullscreen || (st ? this._isVisible(st) : false);
      cam.el.classList.toggle('watch-hidden', !visible);
    }
  }

  // ── UI helpers ──

  _addHudDot(cam) {
    const info = cam._dom?.ghudInfo;
    if (!info || info.querySelector('.watch-dot')) return;
    const dot = document.createElement('span');
    dot.className = 'watch-dot';
    const pill = info.querySelector('.ghud-pill');
    if (pill) pill.after(dot); else info.prepend(dot);
  }

  _removeHudDot(cam) {
    const dot = cam._dom?.ghudInfo?.querySelector('.watch-dot');
    if (dot) dot.remove();
  }

  _updateHudDotType(cam, type, detections) {
    const dot = cam._dom?.ghudInfo?.querySelector('.watch-dot');
    if (!dot) return;
    dot.className = 'watch-dot';
    if (type !== 'unknown') dot.classList.add(`watch-dot-${type}`);
    const count = detections?.length || 0;
    dot.textContent = count > 1 ? count : '';
    dot.title = (detections || []).map(d => `${d.className} (${Math.round(d.score * 100)}%)`).join(', ');
  }

  // ── Detection helpers ──

  _getPrimaryType(detections) {
    if (!detections?.length) return 'unknown';
    for (const d of detections) if (d.label === 'human') return 'human';
    for (const d of detections) if (d.label === 'vehicle') return 'vehicle';
    for (const d of detections) if (d.label === 'animal') return 'animal';
    return 'unknown';
  }

  _boxOverlapsRegion(box, region, video) {
    const vw = video.videoWidth || 1, vh = video.videoHeight || 1;
    const bx = box.x / vw, by = box.y / vh, bw = box.w / vw, bh = box.h / vh;
    return !(bx + bw < region.x || bx > region.x + region.w ||
             by + bh < region.y || by > region.y + region.h);
  }

  _emitUpdate() {
    const ids = this.activeCameraIds;
    const summary = this.detectionSummary;
    if (this.onMotionUpdate) this.onMotionUpdate(ids.length, ids, summary);
  }
}
