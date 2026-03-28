/**
 * ZoomFeature — digital zoom with minimap.
 *
 * Controls: wheel zoom, mouse drag pan, touch pinch-to-zoom,
 * double-tap toggle, minimap viewport click, minimap drag reposition.
 *
 * Model: transform-origin: 0 0; transform: translate(tx, ty) scale(S)
 * tx, ty are in CSS pixels (screen space). At scale=1: tx=ty=0.
 */

import { Feature } from '../core/feature.js';

export class ZoomFeature extends Feature {
  attach(view) {
    super.attach(view);
    this._zoom = { scale: 1, tx: 0, ty: 0 };
    this._dragging = false;
    this._minimapTimer = null;
    this._injectDOM();
    this._cacheDom();
    this._bindEvents();
  }

  // ── Feature hooks ──

  onEnterFullscreen() {
    if (this._zoom.scale > 1) {
      this._clampPan();
      this._applyZoom();
    }
  }

  onExitFullscreen({ keepZoom = false } = {}) {
    if (keepZoom) {
      // Hide zoom visuals but preserve state for later
      this._view.video.style.transform = '';
      this._view.video.style.transformOrigin = '';
      const freeze = this._view._dom.freeze;
      if (freeze) { freeze.style.transform = ''; freeze.style.transformOrigin = ''; }
      this._view.el.classList.remove('cam-zoomed');
      clearInterval(this._minimapTimer);
      this._minimapTimer = null;
      if (this._dom.minimap) this._dom.minimap.classList.remove('visible');
    } else {
      this.reset();
    }
  }

  onDisable() {
    this.reset();
  }

  getState() {
    if (this._zoom.scale <= 1) return {};
    return {
      zoom: {
        scale: this._zoom.scale,
        tx: this._zoom.tx,
        ty: this._zoom.ty,
      },
    };
  }

  restoreState(state) {
    if (state.zoom && state.zoom.scale > 1) {
      this._zoom = { ...state.zoom };
      this._clampPan();
      this._applyZoom();
    }
  }

  getInfoTooltipParts({ full }) {
    if (this._zoom.scale > 1) {
      return [`${this._zoom.scale.toFixed(1)}×`];
    }
    return null;
  }

  // ── Public API ──

  get scale() { return this._zoom.scale; }

  reset() {
    this._zoom = { scale: 1, tx: 0, ty: 0 };
    clearInterval(this._minimapTimer);
    this._minimapTimer = null;
    if (this._dom.minimap) {
      this._dom.minimap.style.left = '';
      this._dom.minimap.style.right = '';
      this._dom.minimap.style.top = '';
    }
    this._applyZoom();
  }

  /** Zoom in/out by step (keyboard +/- support). */
  zoomBy(delta, centerX, centerY) {
    const rect = this._view.el.getBoundingClientRect();
    const cx = centerX ?? rect.width / 2;
    const cy = centerY ?? rect.height / 2;
    this._setZoom(this._zoom.scale * (1 + delta), cx, cy);
  }

  // ── DOM injection ──

  _injectDOM() {
    const el = this._view.el;

    // Minimap
    const minimap = document.createElement('div');
    minimap.className = 'cam-minimap';
    minimap.innerHTML = `
      <canvas class="cam-minimap-canvas"></canvas>
      <div class="cam-minimap-viewport"></div>
    `;
    // Insert before .cam-overlay
    const overlay = el.querySelector('.cam-overlay');
    el.insertBefore(minimap, overlay);

    // Zoom badge in top-right
    const topRight = el.querySelector('.cam-top-right');
    if (topRight) {
      const badge = document.createElement('span');
      badge.className = 'cam-zoom-badge';
      topRight.insertBefore(badge, topRight.firstChild);
    }
  }

  _cacheDom() {
    const el = this._view.el;
    this._dom = {
      minimap: el.querySelector('.cam-minimap'),
      minimapCanvas: el.querySelector('.cam-minimap-canvas'),
      minimapViewport: el.querySelector('.cam-minimap-viewport'),
      zoomBadge: el.querySelector('.cam-zoom-badge'),
    };
  }

  // ── Zoom logic ──

  _applyZoom() {
    const view = this._view;
    const { scale, tx, ty } = this._zoom;
    const transform = scale <= 1 ? '' : `translate(${tx}px, ${ty}px) scale(${scale})`;
    const origin = scale <= 1 ? '' : '0 0';

    view.video.style.transform = transform;
    view.video.style.transformOrigin = origin;
    const freeze = view._dom.freeze;
    if (freeze) {
      freeze.style.transform = transform;
      freeze.style.transformOrigin = origin;
    }

    view.el.classList.toggle('cam-zoomed', scale > 1);

    const badge = this._dom.zoomBadge;
    if (badge) {
      badge.textContent = scale <= 1 ? '' : `${scale.toFixed(1)}×`;
      badge.classList.toggle('visible', scale > 1);
    }

    if (view.isFullscreen) {
      const p = view._activePlayer || view.player;
      if (p) view._updateInfoTooltip(p, p.bitrate || 0);
    }

    this._updateMinimap();
  }

  _setZoom(newScale, cursorX, cursorY) {
    const s = this._zoom.scale;
    newScale = Math.max(1, Math.min(8, newScale));
    if (newScale <= 1) {
      this._zoom = { scale: 1, tx: 0, ty: 0 };
    } else {
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
    const rect = this._view.el.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    this._zoom.tx = Math.max(-(scale - 1) * w, Math.min(0, this._zoom.tx));
    this._zoom.ty = Math.max(-(scale - 1) * h, Math.min(0, this._zoom.ty));
  }

  // ── Minimap ──

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

    if (!this._minimapTimer) {
      this._minimapTimer = setInterval(() => this._drawMinimapFrame(), 1000);
    }
    this._drawMinimapFrame();

    const vp = this._dom.minimapViewport;
    const rect = this._view.el.getBoundingClientRect();
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
    const video = this._view.video;
    if (!canvas || !video.videoWidth) return;
    const ctx = canvas.getContext('2d');
    const mw = canvas.width = 120;
    const mh = canvas.height = Math.round(120 * (video.videoHeight / video.videoWidth));
    canvas.style.height = `${mh}px`;
    canvas.parentElement.style.height = `${mh + 2}px`;
    try { ctx.drawImage(video, 0, 0, mw, mh); } catch {}
  }

  // ── Event binding ──

  _bindEvents() {
    const el = this._view.el;

    // Wheel zoom (fullscreen only)
    el.addEventListener('wheel', (e) => {
      if (!this._view.isFullscreen) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;
      const raw = -e.deltaY * 0.005;
      const clamped = Math.max(-0.25, Math.min(0.25, raw));
      this._setZoom(this._zoom.scale * (1 + clamped), cursorX, cursorY);
    }, { passive: false });

    // Mouse drag pan (fullscreen + zoomed)
    el.addEventListener('mousedown', (e) => {
      if (!this._view.isFullscreen || this._zoom.scale <= 1) return;
      if (e.target.closest('.cam-seek-timeline, .cam-overlay, .cam-playback-panel, .cam-top-right, .cam-quality-toggle')) return;
      this._dragging = true;
      this._dragMoved = false;
      this._dragLast = { x: e.clientX, y: e.clientY };
      el.classList.add('cam-zoom-dragging');
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!this._dragging) return;
      this._dragMoved = true;
      this._zoom.tx += e.clientX - this._dragLast.x;
      this._zoom.ty += e.clientY - this._dragLast.y;
      this._dragLast = { x: e.clientX, y: e.clientY };
      this._clampPan();
      this._applyZoom();
    });
    document.addEventListener('mouseup', () => {
      if (this._dragging) {
        this._dragging = false;
        el.classList.remove('cam-zoom-dragging');
        if (this._dragMoved) {
          const suppress = (e) => { e.stopPropagation(); e.preventDefault(); };
          el.addEventListener('click', suppress, { capture: true, once: true });
        }
      }
    });

    // Touch pinch-to-zoom + pan
    let lastPinchDist = 0;
    let lastTouchCenter = null;

    el.addEventListener('touchstart', (e) => {
      if (!this._view.isFullscreen) return;
      if (e.touches.length === 2) {
        const [a, b] = [e.touches[0], e.touches[1]];
        lastPinchDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const rect = el.getBoundingClientRect();
        lastTouchCenter = {
          x: (a.clientX + b.clientX) / 2 - rect.left,
          y: (a.clientY + b.clientY) / 2 - rect.top,
        };
      } else if (e.touches.length === 1 && this._zoom.scale > 1) {
        lastTouchCenter = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
      if (!this._view.isFullscreen) return;
      if (e.touches.length === 2 && lastPinchDist) {
        const [a, b] = [e.touches[0], e.touches[1]];
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const rect = el.getBoundingClientRect();
        const cx = (a.clientX + b.clientX) / 2 - rect.left;
        const cy = (a.clientY + b.clientY) / 2 - rect.top;
        this._setZoom(this._zoom.scale * (dist / lastPinchDist), cx, cy);
        lastPinchDist = dist;
        lastTouchCenter = { x: cx, y: cy };
        e.preventDefault();
      } else if (e.touches.length === 1 && this._zoom.scale > 1 && lastTouchCenter) {
        const t = e.touches[0];
        this._zoom.tx += t.clientX - lastTouchCenter.x;
        this._zoom.ty += t.clientY - lastTouchCenter.y;
        lastTouchCenter = { x: t.clientX, y: t.clientY };
        this._clampPan();
        this._applyZoom();
        e.preventDefault();
      }
    }, { passive: false });

    el.addEventListener('touchend', () => {
      if (lastPinchDist) lastPinchDist = 0;
      lastTouchCenter = null;
    }, { passive: true });

    // Double-tap to toggle zoom (mobile)
    let lastTapTime = 0;
    el.addEventListener('touchend', (e) => {
      if (!this._view.isFullscreen || e.touches.length > 0) return;
      const now = Date.now();
      if (now - lastTapTime < 300) {
        e.preventDefault();
        if (this._zoom.scale > 1) {
          this.reset();
        } else {
          const rect = el.getBoundingClientRect();
          const t = e.changedTouches[0];
          this._setZoom(3, t.clientX - rect.left, t.clientY - rect.top);
        }
        lastTapTime = 0;
      } else {
        lastTapTime = now;
      }
    });

    // Minimap events
    this._bindMinimapEvents();
  }

  _bindMinimapEvents() {
    const minimap = this._dom.minimap;
    if (!minimap) return;

    let mmDragging = false;
    let mmMoved = false;
    let mmStart = { x: 0, y: 0, left: 0, top: 0 };

    minimap.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      mmDragging = true;
      mmMoved = false;
      const style = minimap.getBoundingClientRect();
      const parent = this._view.el.getBoundingClientRect();
      minimap.style.left = `${style.left - parent.left}px`;
      minimap.style.right = 'auto';
      mmStart = {
        x: e.clientX, y: e.clientY,
        left: style.left - parent.left,
        top: style.top - parent.top,
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
      if (mmMoved) {
        const suppress = (e) => { e.stopPropagation(); e.preventDefault(); };
        this._view.el.addEventListener('click', suppress, { capture: true, once: true });
      }
    });

    // Click on minimap → pan viewport to that point
    minimap.addEventListener('click', (e) => {
      e.stopPropagation();
      if (mmMoved || this._zoom.scale <= 1) return;
      const canvas = this._dom.minimapCanvas;
      const mr = canvas.getBoundingClientRect();
      const fx = (e.clientX - mr.left) / mr.width;
      const fy = (e.clientY - mr.top) / mr.height;
      const rect = this._view.el.getBoundingClientRect();
      const s = this._zoom.scale;
      this._zoom.tx = -(fx * rect.width * s - rect.width / 2);
      this._zoom.ty = -(fy * rect.height * s - rect.height / 2);
      this._clampPan();
      this._applyZoom();
    });
  }

  destroy() {
    clearInterval(this._minimapTimer);
    this._dom.minimap?.remove();
    this._dom.zoomBadge?.remove();
    super.destroy();
  }
}
