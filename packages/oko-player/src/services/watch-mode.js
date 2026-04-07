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
// Sensitivity 1→10 maps to % of changed pixels needed to trigger motion
// Night cameras with H.265 noise change ~2-3% pixels every frame
// so minimum threshold must be above that (>=3) to avoid false positives
const SCORE_THRESHOLDS = [
  25, 20, 16, 12, 9, 7, 6, 5, 4, 3
];

export class WatchMode {
  constructor(cameras) {
    this._cameras = cameras;
    this._detectors = new Map();
    this._state = new Map();
    this._scanTimer = null;
    this._active = false;
    this._sensitivity = 10;
    this._motionFilter = false;
    this._typeFilter = { motion: true, human: true, vehicle: true, animal: true };
    this._gridEl = null;
    this._classifier = new ObjectClassifier();

    this.onMotionUpdate = null;
    this.onClassifierReady = null;

    // Fullscreen AI overlay state
    this._fsCam = null;
    this._fsCanvas = null;
    this._fsCtx = null;
    this._fsRafId = null;
    this._fsLastDetect = 0;
    this._fsDetections = [];
    this._fsDebounce = null;
    this._fsDebounceCam = null;
    this._serverDetect = false;
    this._serverBackend = null;
    this._ws = null;
    this._wsReconnectTimer = null;
    this._activeDetector = null; // 'coral' | 'effnet' | null
    this._fsPanel = null;
    this._fsPanelList = null;
    this._fsPanelHeader = null;
    this._tracked = new Map(); // id → { cls, label, score, box, smoothBox, lastSeen, firstSeen, cropUrl, nextCropAt }
    this._trackIdCounter = 0;
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

    // Connect WebSocket to backend hub
    this._connectWs();

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
    if (this._fsDebounce) { clearTimeout(this._fsDebounce); this._fsDebounce = null; this._fsDebounceCam = null; }
    this._disconnectWs();
    this._stopFsOverlay();
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
      confirmedType: null,
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

      // Archive playback: run normal frame diff on decoded frames
      // Static archive scenes produce stable pixels, frame diff works correctly

      const score = det.analyze();
      if (score < 0) continue;

      if (score >= threshold) {
        // Stage 1: motion detected
        const wasIdle = st.status === 'idle' || st.status === 'cooldown';
        st.status = 'motion';
        st.lastMotion = now;
        if (wasIdle) {
          this._applyHighlight(cam, st);
          changed = true;
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
          // Cooldown expired — go idle
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
      }
    }

    if (changed) { this._applyVisibility(); this._emitUpdate(); }

    // Check fullscreen AI overlay
    this._checkFullscreenOverlay();

    // Note: AI classification only runs in fullscreen overlay (_fsLoop).
    // Grid scan uses only MotionDetector (frame diff) — fast, never blocks main thread.
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
      // Fullscreen or playback camera is always visible
      const visible = cam.isFullscreen || cam.isPlayback || (st ? this._isVisible(st) : false);
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

  // ═══════════════════════════════════════════════════════════════
  // ── Fullscreen AI Overlay (investigation mode) ──
  // Runs AI detection on every frame of the fullscreen camera
  // (live or archive). Draws bounding boxes overlay on canvas.
  // ═══════════════════════════════════════════════════════════════

  static FS_DETECT_INTERVAL = 500; // ms between AI detections
  static FS_COLORS = {
    human: '#ff4757', vehicle: '#ffa502', animal: '#00d4aa', unknown: '#378ADD'
  };

  /** Called from _scan — detect fullscreen changes. */
  _checkFullscreenOverlay() {
    const fsCam = this._cameras.find(c => c.isFullscreen);

    if (fsCam && (!this._fsCam || fsCam.id !== this._fsCam.id)) {
      // New fullscreen camera — start overlay (debounce to survive reconnects)
      if (this._fsDebounce && this._fsDebounceCam?.id === fsCam.id) return; // already debouncing for this cam
      if (this._fsDebounce) clearTimeout(this._fsDebounce);
      this._fsDebounceCam = fsCam;
      this._fsDebounce = setTimeout(() => {
        this._fsDebounce = null;
        this._fsDebounceCam = null;
        const stillFs = this._cameras.find(c => c.isFullscreen);
        if (stillFs && stillFs.id === fsCam.id) {
          this._stopFsOverlay();
          this._startFsOverlay(stillFs);
        }
      }, 300);
    } else if (fsCam && this._fsCam && fsCam.id === this._fsCam.id && fsCam !== this._fsCam) {
      // Same camera but new object reference (updateCameras) — update ref
      this._fsCam = fsCam;
    } else if (!fsCam && this._fsCam) {
      // Camera exited fullscreen — but only stop if WS detect isn't active
      if (this._activeDetector === 'coral') {
        // WS detect is running — check again next scan, don't kill it
        return;
      }
      if (this._fsDebounce) { clearTimeout(this._fsDebounce); this._fsDebounce = null; this._fsDebounceCam = null; }
      this._stopFsOverlay();
    }
  }

  _startFsOverlay(cam) {
    this._fsCam = cam;
    this._fsDetections = [];
    this._fsLastDetect = 0;

    // Create canvas overlay
    const canvas = document.createElement('canvas');
    canvas.className = 'watch-ai-overlay';
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10;';
    cam.el.appendChild(canvas);
    this._fsCanvas = canvas;
    this._fsCtx = canvas.getContext('2d');

    // Create A3 side panel for detection crops
    const panel = document.createElement('div');
    panel.className = 'watch-detect-panel';
    panel.style.cssText = 'position:absolute;top:0;right:0;width:200px;height:100%;background:rgba(0,0,0,0.85);z-index:11;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:6px;font-family:-apple-system,sans-serif;';
    const header = document.createElement('div');
    header.className = 'watch-detect-panel-header';
    header.style.cssText = 'font-size:11px;color:#888;font-weight:500;padding:2px 4px;';
    header.textContent = 'Detections';
    panel.appendChild(header);
    const list = document.createElement('div');
    list.className = 'watch-detect-panel-list';
    list.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    panel.appendChild(list);
    cam.el.appendChild(panel);
    this._fsPanel = panel;
    this._fsPanelList = list;
    this._fsPanelHeader = header;

    // Start detection — server-side (Coral) via WS or browser-side
    if (this._serverDetect) {
      this._startCoralDetect(cam.id);
    } else {
      this._activeDetector = 'effnet';
      this._fsLoop();
      console.log(`[watch] Browser overlay (effnet) started on ${cam.id}`);
    }
  }

  _stopFsOverlay() {
    if (this._fsRafId) {
      clearTimeout(this._fsRafId);
      this._fsRafId = null;
    }
    if (this._fsCanvas) {
      this._fsCanvas.remove();
      this._fsCanvas = null;
      this._fsCtx = null;
    }
    if (this._fsPanel) {
      this._fsPanel.remove();
      this._fsPanel = null;
      this._fsPanelList = null;
      this._fsPanelHeader = null;
    }
    if (this._fsCam) {
      if (this._serverDetect) {
        this._stopCoralDetect();
      }
      this._activeDetector = null;
      console.log(`[watch] AI overlay stopped on ${this._fsCam.id}`);
    }
    this._fsCam = null;
    this._fsDetections = [];
    this._tracked.clear();
    this._trackIdCounter = 0;
  }

  _fsLoop() {
    if (!this._active || !this._fsCam) {
      this._stopFsOverlay();
      return;
    }

    // Camera lost fullscreen — stop overlay
    if (!this._fsCam.isFullscreen) {
      const stillFs = this._cameras.find(c => c.isFullscreen && c.id === this._fsCam.id);
      if (stillFs) {
        this._fsCam = stillFs;
      } else {
        this._stopFsOverlay();
        return;
      }
    }

    // Browser-side only — server-side uses _coralWs push
    this._fsLoopLocal();
  }

  _fsLoopLocal() {
    const video = this._fsCam.video;
    if (this._classifier.isReady && video && video.readyState >= 2 && video.videoWidth > 0) {
      const rawDets = this._classifier.detect(video);
      // Browser-side classifiers output pixel coords — normalize to [0,1]
      const vw = video.videoWidth, vh = video.videoHeight;
      this._fsDetections = rawDets.map(d => {
        if (!d.box) return d;
        return {
          ...d,
          box: {
            x: d.box.x / vw,
            y: d.box.y / vh,
            w: d.box.w / vw,
            h: d.box.h / vh,
          }
        };
      });
      this._activeDetector = 'effnet';
      this._fsDrawOverlay();
    }
    this._fsRafId = setTimeout(() => this._fsLoop(), WatchMode.FS_DETECT_INTERVAL);
  }

  // ── WebSocket connection to backend hub ──

  _connectWs() {
    this._disconnectWs();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/backend/ws`;
    const ws = new WebSocket(url);
    this._ws = ws;

    ws.onopen = () => {
      console.log('[watch] WS connected');
      ws.send(JSON.stringify({ ch: 'subscribe', channels: ['detect'] }));
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        this._onWsMessage(msg);
      } catch {}
    };

    ws.onclose = () => {
      this._ws = null;
      this._serverDetect = false;
      // Reconnect if still active
      if (this._active && !this._wsReconnectTimer) {
        this._wsReconnectTimer = setTimeout(() => {
          this._wsReconnectTimer = null;
          if (this._active) this._connectWs();
        }, 3000);
      }
    };

    ws.onerror = () => {}; // onclose will fire
  }

  _disconnectWs() {
    if (this._wsReconnectTimer) {
      clearTimeout(this._wsReconnectTimer);
      this._wsReconnectTimer = null;
    }
    if (this._ws) {
      // Stop detection before closing
      if (this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({ ch: 'detect', cmd: 'stop' }));
      }
      this._ws.close();
      this._ws = null;
    }
    this._serverDetect = false;
    this._activeDetector = null;
  }

  _wsSend(msg) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  }

  _onWsMessage(msg) {
    if (msg.ch === 'welcome') {
      // Backend connected — query actual detect availability (don't assume Coral is there)
      this._serverDetect = false;
      this._wsSend({ ch: 'detect', cmd: 'status' });
      console.log('[watch] WS connected, checking server-side detection...');
      return;
    }

    if (msg.ch === 'detect' && msg.data) {
      const data = msg.data;

      if (data.type === 'started') {
        console.log(`[watch] WS: detection started on ${data.camera}`);
        this._activeDetector = 'coral';
        return;
      }
      if (data.type === 'stopped') {
        this._activeDetector = null;
        return;
      }
      if (data.type === 'error') {
        console.warn(`[watch] WS: detect error — ${data.error}`);
        // Coral unavailable — fallback to browser-side detection
        this._serverDetect = false;
        this._activeDetector = null;
        if (this._fsCam) {
          console.log('[watch] Falling back to browser-side detection (effnet)');
          this._activeDetector = 'effnet';
          this._fsLoop();
        }
        return;
      }
      if (data.type === 'status') {
        this._serverDetect = !!data.available;
        if (data.available) {
          this._serverBackend = 'coral';
          console.log('[watch] Server-side detection (Coral) available');
        } else {
          console.log('[watch] Server-side detection unavailable, using browser-side');
        }
        return;
      }

      // Detection results
      if (data.camera === this._fsCam?.id && data.detections) {
        this._fsDetections = data.detections;
        this._activeDetector = 'coral';
        this._fsDrawOverlay();
      }
    }
  }

  // ── Server-side detect control (via WS) ──

  _startCoralDetect(cameraId) {
    this._wsSend({ ch: 'detect', cmd: 'start', camera: cameraId });
    // Don't set _activeDetector here — wait for 'started' confirmation or 'error' fallback
    console.log(`[watch] Requesting server detection on ${cameraId} via WS`);
  }

  _stopCoralDetect() {
    this._wsSend({ ch: 'detect', cmd: 'stop' });
    this._activeDetector = null;
  }

  _fsDrawOverlay() {
    const canvas = this._fsCanvas;
    const ctx = this._fsCtx;
    const video = this._fsCam?.video;
    if (!canvas || !ctx || !video || video.videoWidth === 0) return;

    const vw = video.videoWidth, vh = video.videoHeight;
    canvas.width = vw;
    canvas.height = vh;
    ctx.clearRect(0, 0, vw, vh);

    const colors = WatchMode.FS_COLORS;
    const dets = this._fsDetections;

    for (const det of dets) {
      const b = det.box;
      if (!b) continue;
      const color = colors[det.label] || colors.unknown;

      // Normalized [0,1] → pixel coords
      const px = b.x * vw, py = b.y * vh;
      const pw = b.w * vw, ph = b.h * vh;

      // Bounding box
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(px, py, pw, ph);

      // Label background
      const label = `${det.className} ${Math.round(det.score * 100)}%`;
      ctx.font = '13px -apple-system, sans-serif';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.8;
      ctx.fillRect(px, py - 20, tw + 10, 20);
      ctx.globalAlpha = 1;

      // Label text
      ctx.fillStyle = '#fff';
      ctx.fillText(label, px + 5, py - 5);
    }

    // Detector indicator badge (top-left)
    const detector = this._activeDetector;
    if (detector) {
      const badgeText = detector === 'coral' ? 'CORAL TPU' : 'EfficientNet';
      const badgeColor = detector === 'coral' ? '#00c853' : '#ffa502';
      const fontSize = Math.max(12, Math.round(vw / 120));
      ctx.font = `bold ${fontSize}px -apple-system, sans-serif`;
      const bw = ctx.measureText(badgeText).width;
      const bh = fontSize + 8;
      const bx = 8, by = 8;

      ctx.fillStyle = badgeColor;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.roundRect(bx, by, bw + 12, bh, 4);
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.fillStyle = '#000';
      ctx.fillText(badgeText, bx + 6, by + fontSize + 2);
    }

    // Update A3 side panel with cropped thumbnails
    this._updateDetectPanel(dets, video, vw, vh);
  }

  _updateDetectPanel(dets, video, vw, vh) {
    const list = this._fsPanelList;
    const header = this._fsPanelHeader;
    if (!list || !header) return;

    const now = Date.now();
    const PERSIST_MS = 3000;
    const CROP_INTERVAL = 500;
    const IOU_THRESH = 0.25;
    const SMOOTH = 0.3; // EMA alpha for box smoothing

    // ── Match new detections to tracked objects ──
    const matched = new Set();
    const matchedTracks = new Set();

    for (const det of dets) {
      let bestId = null, bestIou = IOU_THRESH;
      for (const [id, tr] of this._tracked) {
        if (tr.cls !== det.className) continue;
        if (matchedTracks.has(id)) continue;
        const iou = this._boxIou(det.box, tr.smoothBox);
        if (iou > bestIou) { bestIou = iou; bestId = id; }
      }
      if (bestId !== null) {
        // Update existing track
        const tr = this._tracked.get(bestId);
        tr.score = tr.score * 0.7 + det.score * 0.3; // EMA — reflects current state
        tr.lastSeen = now;
        tr.box = det.box;
        // Smooth box position (EMA)
        tr.smoothBox = {
          x: tr.smoothBox.x * (1 - SMOOTH) + det.box.x * SMOOTH,
          y: tr.smoothBox.y * (1 - SMOOTH) + det.box.y * SMOOTH,
          w: tr.smoothBox.w * (1 - SMOOTH) + det.box.w * SMOOTH,
          h: tr.smoothBox.h * (1 - SMOOTH) + det.box.h * SMOOTH,
        };
        matched.add(det);
        matchedTracks.add(bestId);
      }
    }

    // New tracks for unmatched detections
    for (const det of dets) {
      if (matched.has(det)) continue;
      const id = ++this._trackIdCounter;
      this._tracked.set(id, {
        cls: det.className,
        label: det.label,
        score: det.score,
        box: det.box,
        smoothBox: { ...det.box },
        firstSeen: now,
        lastSeen: now,
        cropUrl: null,
        nextCropAt: 0,
        el: null,
      });
    }

    // Remove stale tracks (snapshot to avoid delete-during-iterate)
    const staleIds = [];
    for (const [id, tr] of this._tracked) {
      if (now - tr.lastSeen > PERSIST_MS) staleIds.push(id);
    }
    for (const id of staleIds) {
      const tr = this._tracked.get(id);
      if (tr?.el) tr.el.remove();
      this._tracked.delete(id);
    }

    // ── Update crops (throttled) ──
    for (const [, tr] of this._tracked) {
      if (now >= tr.nextCropAt && now - tr.lastSeen < 500) {
        tr.cropUrl = this._captureCrop(video, tr.smoothBox, vw, vh);
        tr.nextCropAt = now + CROP_INTERVAL;
      }
    }

    // ── Update header ──
    const counts = {};
    for (const [, tr] of this._tracked) {
      counts[tr.label] = (counts[tr.label] || 0) + 1;
    }
    const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ');
    header.textContent = this._tracked.size > 0 ? summary : 'No detections';

    // ── Update cards ──
    const sorted = [...this._tracked.entries()].sort((a, b) => b[1].score - a[1].score);

    for (const [id, tr] of sorted) {
      if (!tr.el) {
        tr.el = this._createTrackedCard(id, tr);
        list.appendChild(tr.el);
      }
      this._updateTrackedCard(tr);
    }

    // Remove orphaned DOM elements
    for (const child of [...list.children]) {
      const id = parseInt(child.dataset.trackId);
      if (isNaN(id) || !this._tracked.has(id)) child.remove();
    }
  }

  _boxIou(a, b) {
    if (!a || !b) return 0;
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a.w * a.h + b.w * b.h - inter;
    return union > 0 ? inter / union : 0;
  }

  _captureCrop(video, box, vw, vh) {
    if (!box || !video || vw === 0) return null;
    const c = document.createElement('canvas');
    const sx = Math.max(0, Math.round(box.x * vw));
    const sy = Math.max(0, Math.round(box.y * vh));
    const sw = Math.min(Math.round(box.w * vw), vw - sx);
    const sh = Math.min(Math.round(box.h * vh), vh - sy);
    if (sw <= 0 || sh <= 0) return null;
    c.width = Math.min(200, sw);
    c.height = Math.round(c.width * sh / sw);
    try {
      c.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.7);
    } catch { return null; }
  }

  _createTrackedCard(id, tr) {
    const color = WatchMode.FS_COLORS[tr.label] || WatchMode.FS_COLORS.unknown;
    const card = document.createElement('div');
    card.dataset.trackId = String(id);
    card.style.cssText = `background:#111;border-radius:6px;overflow:hidden;border:1px solid ${color}40;transition:opacity 0.5s;`;

    const img = document.createElement('img');
    img.className = 'detect-crop';
    img.style.cssText = 'width:100%;display:block;min-height:40px;object-fit:cover;background:#222;';
    if (tr.cropUrl) img.src = tr.cropUrl;
    card.appendChild(img);

    const info = document.createElement('div');
    info.className = 'detect-info';
    info.style.cssText = `padding:4px 8px;display:flex;justify-content:space-between;align-items:center;background:${color}20;`;
    info.innerHTML = `<span style="font-size:12px;font-weight:500;color:#eee;">${tr.cls}</span>`
      + `<span class="detect-conf" style="font-size:11px;color:${color};font-weight:500;">${Math.round(tr.score * 100)}%</span>`;
    card.appendChild(info);

    return card;
  }

  _updateTrackedCard(tr) {
    if (!tr.el) return;
    const now = Date.now();
    const age = now - tr.lastSeen;

    // Fade if not seen recently
    tr.el.style.opacity = age > 1500 ? Math.max(0.3, 1 - (age - 1500) / 1500).toFixed(2) : '1';

    // Update crop image
    const img = tr.el.querySelector('.detect-crop');
    if (img && tr.cropUrl && img.src !== tr.cropUrl) {
      img.src = tr.cropUrl;
    }

    // Update confidence
    const conf = tr.el.querySelector('.detect-conf');
    if (conf) conf.textContent = `${Math.round(tr.score * 100)}%`;
  }
}
