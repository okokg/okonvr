/**
 * CameraGrid — manages the camera grid container.
 *
 * Responsibilities:
 * - Build camera views from config list
 * - Manage filtering (search, online/offline, group)
 * - Control which cameras stream (filter-driven)
 * - Handle fullscreen navigation and swipe
 * - Handle drag-and-drop reordering
 * - Periodic bitrate/timeline/buffer updates
 */

import { CameraView } from './camera-view.js';
import {
  STAGGER_MS, BITRATE_INTERVAL_MS, BUFFER_SYNC_INTERVAL_MS,
  TIMELINE_RENDER_INTERVAL_MS, SWIPE_THRESHOLD_PX,
} from './config.js';

(window._oko = window._oko || {}).grid = 'g2d2';

export class CameraGrid {
  /**
   * @param {HTMLElement} gridEl - Grid container element
   * @param {ApiClient} api - Backend API client
   */
  constructor(gridEl, api) {
    this.gridEl = gridEl;
    this.api = api;

    /** @type {CameraView[]} */
    this.cameras = [];

    // filter state
    this.searchQuery = '';
    this.statusFilter = 'all';  // 'all' | 'online' | 'offline'
    this.groupFilter = '';
    this.autoFit = true; // auto grid by default

    // fullscreen state
    this._fullscreenCamera = null;
    this._touchStartX = 0;

    // keyboard focus state
    this._focusedIndex = -1;

    // Recalculate auto grid on resize
    window.addEventListener('resize', () => {
      if (this.autoFit) this._applyAutoFit();
    });

    /** @type {(online: number, offline: number) => void} */
    this.onStatsChange = null;

    /** @type {(groups: string[]) => void} */
    this.onGroupsDiscovered = null;

    /** @type {(cam: CameraView, start: string, end: string, resolution: string) => void} */
    this.onPlaybackRequest = null;

    /** @type {(cam: CameraView) => void} */
    this.onLiveRequest = null;

    /** @type {(cam: CameraView, seekTime: Date) => void} */
    this.onPlaybackSeek = null;

    /** @type {(cam: CameraView) => void} */
    this.onNeedTranscode = null;

    this._bindSwipe();
    this._startPeriodicTasks();
  }

  // ── Public ──

  /**
   * Build camera views from backend data.
   * @param {Array<{id, label, group, sort_order}>} cameraConfigs
   */
  build(cameraConfigs) {
    this.gridEl.innerHTML = '';
    this.cameras = [];

    for (const config of cameraConfigs) {
      const view = new CameraView(config);

      view.onClick = (cam) => this._handleClick(cam);
      view.onDoubleClick = (cam) => this._handleDoubleClick(cam);
      view.onStatusChange = () => this._updateStats();
      view.onDrop = (fromId, toCam) => this._handleDrop(fromId, toCam);
      view.onPlaybackRequest = (cam, start, end, resolution) => {
        if (this.onPlaybackRequest) this.onPlaybackRequest(cam, start, end, resolution);
      };
      view.onLiveRequest = (cam) => {
        if (this.onLiveRequest) this.onLiveRequest(cam);
      };
      view.onPlaybackSeek = (cam, seekTime) => {
        if (this.onPlaybackSeek) this.onPlaybackSeek(cam, seekTime);
      };
      view.onQuickSeek = (cam, seekTime) => {
        if (this.onPlaybackSeek) this.onPlaybackSeek(cam, seekTime);
      };
      view.onHdToggle = (cam, wantHd) => {
        if (this.onHdToggle) this.onHdToggle(cam, wantHd);
      };
      view.onNeedTranscode = (cam) => {
        if (this.onNeedTranscode) this.onNeedTranscode(cam);
      };
      view.onConnectionError = (cam) => {
        if (this.onConnectionError) this.onConnectionError(cam);
      };
      view.onTimeLock = (cam, locked, start, end, resolution) => {
        if (this.onTimeLock) this.onTimeLock(cam, locked, start, end, resolution);
      };
      view.onPlaybackPause = (cam) => {
        if (this.onPlaybackPause) this.onPlaybackPause(cam);
      };
      view.onPlaybackResume = (cam, pos) => {
        if (this.onPlaybackResume) this.onPlaybackResume(cam, pos);
      };

      this.cameras.push(view);
      this.gridEl.appendChild(view.el);
    }

    // discover unique groups — show filter only when 2+ groups
    const groups = [...new Set(cameraConfigs.map(c => c.group).filter(Boolean))];

    // Assign group colors
    this._assignGroupColors(groups);

    if (groups.length > 1 && this.onGroupsDiscovered) {
      this.onGroupsDiscovered(groups);
    }
  }

  /**
   * Apply current filters: show/hide cameras and start/stop streams.
   * Cameras start sequentially to avoid overwhelming the NVR.
   */
  applyFilters() {
    const toStart = [];

    for (const cam of this.cameras) {
      const shouldShow = this._matchesAllFilters(cam);
      cam.setVisible(shouldShow);

      if (shouldShow) {
        if (!cam.isEnabled) {
          toStart.push(cam);
        } else if (cam.isEnabled && !cam.isConnected) {
          cam.player.stop();
          toStart.push(cam);
        }
      } else if (cam.isEnabled) {
        cam.disable();
      }
    }

    this._startSequential(toStart);
    this._updateStats();
    if (this.autoFit) this._applyAutoFit();
  }

  /**
   * Start cameras one by one, waiting for each to connect (or timeout)
   * before starting the next. Prevents NVR overload.
   */
  async _startSequential(camsToStart) {
    for (const cam of camsToStart) {
      cam.start();
      // wait until connected or stagger delay, whichever comes first
      await new Promise(resolve => {
        const staggerMs = window.__okoConfig?.stagger_ms || STAGGER_MS;
        const timer = setTimeout(resolve, staggerMs);
        const interval = setInterval(() => {
          if (cam.isConnected || !cam.isEnabled) {
            clearInterval(interval);
            clearTimeout(timer);
            resolve();
          }
        }, 50);
      });
    }
  }

  /**
   * Update visibility only (no stream start/stop). Used on status change.
   */
  updateVisibility() {
    for (const cam of this.cameras) {
      cam.setVisible(this._matchesAllFilters(cam));
    }
  }

  /**
   * Stop all cameras and re-apply filters.
   */
  /**
   * Stop all cameras and re-apply filters.
   * Resets status filter to 'all' since all cameras restart.
   */
  refresh() {
    this.statusFilter = 'all';
    // Update UI: deactivate status filter buttons
    document.querySelectorAll('.filter-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.filter === 'all');
    });

    for (const cam of this.cameras) cam.disable();
    this.applyFilters();
  }

  /** @returns {CameraView[]} Cameras currently visible. */
  get visibleCameras() {
    // Use DOM order (reflects drag-and-drop reordering)
    const domOrder = [...this.gridEl.children];
    return this.cameras
      .filter(c => !c.el.classList.contains('hidden'))
      .sort((a, b) => domOrder.indexOf(a.el) - domOrder.indexOf(b.el));
  }

  // ── Fullscreen ──

  get fullscreenCamera() { return this._fullscreenCamera; }

  enterFullscreen(cam) {
    const prev = this._fullscreenCamera;
    if (prev && prev !== cam) {
      prev.exitFullscreen();
      if (this.onFullscreenExit) this.onFullscreenExit(prev);
    }
    cam.enterFullscreen();
    this._fullscreenCamera = cam;
    this.clearFocus();
    this._syncHash();
    if (this.onFullscreenEnter) this.onFullscreenEnter(cam);
  }

  exitFullscreen() {
    if (this._fullscreenCamera) {
      const cam = this._fullscreenCamera;
      cam.exitFullscreen();
      this._fullscreenCamera = null;
      this._updateHash('');
      if (this.onFullscreenExit) this.onFullscreenExit(cam);
      this.focusOnCamera(cam);
    }
  }

  navigateFullscreen(direction) {
    if (!this._fullscreenCamera) return;
    const visible = this.visibleCameras;
    const idx = visible.indexOf(this._fullscreenCamera);
    const next = visible[idx + direction];
    if (!next) return;

    const prev = this._fullscreenCamera;
    next.enterFullscreen();
    prev.exitFullscreen();
    this._fullscreenCamera = next;
    this._syncHash();

    if (this.onFullscreenExit) this.onFullscreenExit(prev);
    if (this.onFullscreenEnter) this.onFullscreenEnter(next);
  }

  /** Sync URL hash with current fullscreen + playback state. */
  _syncHash() {
    const cam = this._fullscreenCamera;
    if (!cam) { this._updateHash(''); return; }

    if (cam.isPlayback && cam.playbackPosition) {
      const pos = cam.playbackPosition;
      const pad = (n) => String(n).padStart(2, '0');
      const timeStr = `${pos.getFullYear()}-${pad(pos.getMonth()+1)}-${pad(pos.getDate())}T${pad(pos.getHours())}:${pad(pos.getMinutes())}`;
      const res = cam.playbackResolution;
      let hash = `cam=${cam.id}&playback=${timeStr}`;
      if (res && res !== 'original') hash += `&res=${res}`;
      this._updateHash(hash);
    } else {
      this._updateHash(`cam=${cam.id}`);
    }
  }

  /** Update hash after seek. Call from app after starting playback. */
  updatePlaybackHash() {
    this._syncHash();
  }

  /**
   * Parse URL hash.
   * @returns {{ camId: string, playbackTime: string|null, resolution: string } | null}
   */
  parseHash() {
    const hash = location.hash;
    if (!hash || hash === '#') return null;

    const params = new URLSearchParams(hash.substring(1));
    const camId = params.get('cam');
    if (!camId) return null;

    return {
      camId,
      playbackTime: params.get('playback') || null,
      resolution: params.get('res') || 'original',
    };
  }

  /**
   * Open camera from URL hash.
   * @returns {{ cam: CameraView, playbackTime: string|null, resolution: string } | null}
   */
  openFromHash() {
    const parsed = this.parseHash();
    if (!parsed) return null;

    const cam = this.cameras.find(c => c.id === parsed.camId);
    if (!cam) return null;

    if (!cam.isEnabled) cam.start();
    setTimeout(() => this.enterFullscreen(cam), 500);

    return { cam, playbackTime: parsed.playbackTime, resolution: parsed.resolution };
  }

  /** Open camera by index (1-based, from visible list). */
  openByIndex(index) {
    const visible = this.visibleCameras;
    if (visible[index]) this.enterFullscreen(visible[index]);
  }

  // ── Keyboard focus navigation ──

  /** Get currently focused camera. */
  get focusedCamera() {
    const visible = this.visibleCameras;
    return visible[this._focusedIndex] || null;
  }

  /** Move focus by direction. cols = current grid columns for up/down. */
  moveFocus(direction) {
    const visible = this.visibleCameras;
    if (visible.length === 0) return;

    // First focus
    if (this._focusedIndex < 0) {
      this._setFocus(0);
      return;
    }

    const cols = this._getCurrentCols();
    let next = this._focusedIndex;

    switch (direction) {
      case 'left':  next = Math.max(0, next - 1); break;
      case 'right': next = Math.min(visible.length - 1, next + 1); break;
      case 'up':    next = Math.max(0, next - cols); break;
      case 'down':  next = Math.min(visible.length - 1, next + cols); break;
    }

    this._setFocus(next);
  }

  /** Open focused camera in fullscreen. */
  openFocused() {
    const cam = this.focusedCamera;
    if (cam) this.enterFullscreen(cam);
  }

  /** Clear focus highlight. */
  clearFocus() {
    this.cameras.forEach(c => c.el.classList.remove('kbd-focus'));
    // Keep _focusedIndex so returning from fullscreen remembers position
  }

  /** Set focus on a specific camera after exiting fullscreen. */
  focusOnCamera(cam) {
    const visible = this.visibleCameras;
    const idx = visible.indexOf(cam);
    if (idx >= 0) {
      this._setFocus(idx);
    }
  }

  /** @private */
  _setFocus(index) {
    const visible = this.visibleCameras;
    if (index < 0 || index >= visible.length) return;

    // Remove old focus
    this.cameras.forEach(c => c.el.classList.remove('kbd-focus'));

    this._focusedIndex = index;
    visible[index].el.classList.add('kbd-focus');

    // Scroll into view if needed
    visible[index].el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /** @private Get current number of columns from grid style. */
  _getCurrentCols() {
    const style = getComputedStyle(this.gridEl);
    const cols = style.gridTemplateColumns.split(' ').length;
    return cols || 4;
  }

  // ── Private: event handlers ──

  _handleClick(cam) {
    if (cam.isFullscreen) {
      this.exitFullscreen();
    } else {
      this.enterFullscreen(cam);
    }
  }

  _handleDoubleClick(cam) {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      cam.enterNativeFullscreen();
    }
  }

  _handleDrop(fromId, toCam) {
    const fromCam = this.cameras.find(c => c.id === fromId);
    if (!fromCam) return;

    const children = [...this.gridEl.children];
    const fromIdx = children.indexOf(fromCam.el);
    const toIdx = children.indexOf(toCam.el);

    if (fromIdx < toIdx) {
      this.gridEl.insertBefore(fromCam.el, toCam.el.nextSibling);
    } else {
      this.gridEl.insertBefore(fromCam.el, toCam.el);
    }

    this._saveOrder();
  }

  // ── Private: filtering ──

  _matchesAllFilters(cam) {
    const matchesSearch = cam.matchesQuery(this.searchQuery);
    const matchesStatus =
      this.statusFilter === 'all'
      || (this.statusFilter === 'online' && cam.isConnected)
      || (this.statusFilter === 'offline' && !cam.isConnected);
    const matchesGroup = !this.groupFilter || cam.group === this.groupFilter;

    return matchesSearch && matchesStatus && matchesGroup;
  }

  // ── Private: stats ──

  _updateStats() {
    const nvrOffline = this.cameras.filter(c => c.el.classList.contains('nvr-offline')).length;
    const active = this.cameras.filter(c => !c.el.classList.contains('nvr-offline'));
    const online = active.filter(c => c.isConnected).length;
    const offline = active.filter(c => c.isEnabled && !c.isConnected).length + nvrOffline;
    if (this.onStatsChange) this.onStatsChange(online, offline);
    this.updateVisibility();
  }

  // ── Private: order persistence ──

  _orderTimer = null;

  _saveOrder() {
    clearTimeout(this._orderTimer);
    this._orderTimer = setTimeout(() => {
      const order = [...this.gridEl.children].map(el => el.dataset.id);
      this.api.saveOrder(order).catch(() => {});
    }, 500);
  }

  // ── Private: URL hash ──

  _updateHash(hashContent) {
    const url = hashContent ? `#${hashContent}` : location.pathname;
    history.replaceState(null, '', url);
  }

  // ── Private: swipe ──

  _bindSwipe() {
    document.addEventListener('touchstart', (e) => {
      if (this._fullscreenCamera) {
        this._touchStartX = e.touches[0].clientX;
      }
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
      if (!this._fullscreenCamera) return;
      const dx = e.changedTouches[0].clientX - this._touchStartX;
      if (Math.abs(dx) > SWIPE_THRESHOLD_PX) {
        this.navigateFullscreen(dx < 0 ? 1 : -1);
      }
    }, { passive: true });

    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && this._fullscreenCamera) {
        this.exitFullscreen();
      }
    });
  }

  // ── Private: auto-fit grid ──

  /**
   * Calculate optimal columns to fit all visible cameras on screen without scrolling.
   * Finds minimum columns (= biggest cameras) that still fit vertically.
   */
  _applyAutoFit() {
    const count = this.visibleCameras.length;
    if (count === 0) return;

    const gridRect = this.gridEl.getBoundingClientRect();
    const availW = gridRect.width;
    const availH = window.innerHeight - gridRect.top;
    const gap = 2;
    const aspect = 16 / 9;

    let bestCols = Math.ceil(Math.sqrt(count)); // fallback

    for (let cols = 1; cols <= 20; cols++) {
      const rows = Math.ceil(count / cols);
      const cellW = (availW - gap * (cols - 1)) / cols;
      const cellH = cellW / aspect;
      const totalH = rows * cellH + gap * (rows - 1);

      if (totalH <= availH) {
        bestCols = cols;
        break; // first fit = minimum columns = biggest cameras
      }
    }

    this.gridEl.style.setProperty('--auto-cols', String(bestCols));
  }

  // ── Private: group colors ──

  /** Color palette for NVR groups — distinct, visible on dark background. */
  static GROUP_COLORS = [
    { base: 'rgba(0, 200, 83, 0.1)',   border: 'rgba(0, 200, 83, 0.4)',   bright: '#00c853', sep: 'rgba(0, 200, 83, 0.3)',   label: 'rgba(0, 200, 83, 0.6)' },
    { base: 'rgba(41, 121, 255, 0.1)', border: 'rgba(41, 121, 255, 0.4)', bright: '#64b5f6', sep: 'rgba(41, 121, 255, 0.3)', label: 'rgba(41, 121, 255, 0.6)' },
    { base: 'rgba(255, 171, 0, 0.1)',  border: 'rgba(255, 171, 0, 0.4)',  bright: '#ffab00', sep: 'rgba(255, 171, 0, 0.3)',  label: 'rgba(255, 171, 0, 0.6)' },
    { base: 'rgba(213, 0, 249, 0.1)',  border: 'rgba(213, 0, 249, 0.4)',  bright: '#d500f9', sep: 'rgba(213, 0, 249, 0.3)',  label: 'rgba(213, 0, 249, 0.6)' },
    { base: 'rgba(0, 191, 165, 0.1)',  border: 'rgba(0, 191, 165, 0.4)',  bright: '#00bfa5', sep: 'rgba(0, 191, 165, 0.3)',  label: 'rgba(0, 191, 165, 0.6)' },
    { base: 'rgba(255, 61, 0, 0.1)',   border: 'rgba(255, 61, 0, 0.4)',   bright: '#ff3d00', sep: 'rgba(255, 61, 0, 0.3)',   label: 'rgba(255, 61, 0, 0.6)' },
    { base: 'rgba(100, 181, 246, 0.1)',border: 'rgba(100, 181, 246, 0.4)',bright: '#64b5f6', sep: 'rgba(100, 181, 246, 0.3)',label: 'rgba(100, 181, 246, 0.6)' },
    { base: 'rgba(255, 214, 0, 0.1)', border: 'rgba(255, 214, 0, 0.4)', bright: '#ffd600', sep: 'rgba(255, 214, 0, 0.3)', label: 'rgba(255, 214, 0, 0.6)' },
  ];

  /**
   * Assign border colors to cameras based on their group.
   * Only applies when there are 2+ groups.
   */
  _assignGroupColors(groups) {
    if (groups.length < 2) return;

    const colorMap = new Map();
    groups.forEach((g, i) => {
      colorMap.set(g, CameraGrid.GROUP_COLORS[i % CameraGrid.GROUP_COLORS.length]);
    });

    for (const cam of this.cameras) {
      const color = colorMap.get(cam.group);
      if (color) {
        const nameWrap = cam.el.querySelector('.cam-name-wrap');
        if (nameWrap) {
          nameWrap.style.setProperty('--group-bg', color.base);
          nameWrap.style.setProperty('--group-border', color.border);
          nameWrap.style.setProperty('--group-text', color.bright);
          nameWrap.style.setProperty('--group-sep', color.sep);
          nameWrap.style.setProperty('--group-label', color.label);
        }
      }
    }

    this._groupColorMap = colorMap;
  }

  // ── Private: periodic tasks ──

  _startPeriodicTasks() {
    // bitrate + total bandwidth
    const bitrateMs = window.__okoConfig?.bitrate_interval || BITRATE_INTERVAL_MS;

    setInterval(async () => {
      let total = 0;
      for (const cam of this.cameras) {
        const kbps = await cam.updateBitrate();
        total += kbps;
      }
      if (this.onBandwidthUpdate) this.onBandwidthUpdate(total);
    }, bitrateMs);

    // timeline
    setInterval(() => this.cameras.forEach(c => c.renderTimeline()), TIMELINE_RENDER_INTERVAL_MS);
    setTimeout(() => this.cameras.forEach(c => c.renderTimeline()), 2000);

    // MSE buffer sync
    setInterval(() => this.cameras.forEach(c => c.syncBuffer()), BUFFER_SYNC_INTERVAL_MS);
  }
}
