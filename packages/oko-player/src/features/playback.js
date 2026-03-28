/**
 * PlaybackFeature — archive playback with seek timeline.
 *
 * Manages: playback panel (datetime inputs, resolution, play/live buttons),
 * seek timeline (fullscreen + grid HUD), thumbnail preview, day navigation,
 * position tracking, LIVE button (grid HUD), seek buttons.
 */

import { Feature } from '../core/feature.js';
import { CamPlayer } from '../core/camera-player.js';
import { SeekThumbnail } from './seek-thumbnail.js';
import { pad, hms, hm, dm, dmy, fmtInput, fmtFull, daySeconds } from '../core/utils.js';

export class PlaybackFeature extends Feature {
  attach(view) {
    super.attach(view);

    this._player = null;
    this._stream = null;
    this._date = null;        // Date: midnight of playback day
    this._startWall = null;   // Date: wall-clock when playback started
    this._offset = 0;         // seconds from midnight
    this._positionTimer = null;
    this._nowMarkerTimer = null;
    this._seekCursorFraction = undefined;
    this._seekNowFraction = 0;
    this._panelWasOpen = false;
    this._seekThumbnail = null;
    this._events = [];        // Smart motion events [{start, end, type}]
    this._eventsDate = null;  // Date string of cached events
    this._activeEventIdx = -1; // Index of event at current playback position
    this._liveEventsTimer = null; // Refresh timer for live mode events

    this._injectDOM();
    this._cacheDom();
    this._bindEvents();
  }

  // ── Feature hooks ──

  onEnterFullscreen() {
    const view = this._view;
    // Populate name
    if (this._dom.seekInfoName) this._dom.seekInfoName.textContent = view.id;

    if (!this.isActive) {
      // LIVE mode — set seek info
      if (this._dom.seekInfoRecText) this._dom.seekInfoRecText.textContent = 'LIVE';
      // Fetch SMD events for today
      this._startLiveEventsRefresh();
    } else {
      view.el.classList.remove('fs-live');
    }

    // Restore playback panel if was open
    if (this._panelWasOpen) {
      this._dom.playbackPanel?.classList.add('open');
      this._panelWasOpen = false;
    }
  }

  onExitFullscreen() {
    // Save and close playback panel
    const panel = this._dom.playbackPanel;
    this._panelWasOpen = panel?.classList.contains('open');
    panel?.classList.remove('open');
    this._dom.playbackBtn?.classList.remove('active');
    // Stop live event refresh (will restart on next fullscreen enter)
    this._stopLiveEventsRefresh();
  }

  onLiveTimeUpdate(now, pct, timeStr) {
    // Update fullscreen seek info when in LIVE mode
    if (this._dom.seekInfoTime) this._dom.seekInfoTime.textContent = timeStr;
    if (this._dom.seekInfoDate) this._dom.seekInfoDate.textContent = dmy(now);
    if (this._dom.seekFill) this._dom.seekFill.style.width = pct;
    if (this._dom.seekCursor) this._dom.seekCursor.style.left = pct;
  }

  onPlaybackModeChange(transport) {
    this._updateBadge(transport);
  }

  onPause() {
    this.stopTimer();
  }

  onWirePlayer(player, mode) {
    if (mode === 'playback') {
      player.onConnectionError = () => {
        console.warn(`[camera-view] ${this._view.id}: playback connection error`);
        this._view._showLoading('connection error');
      };
    }
  }

  onDisable() {
    this.stopTimer();
    this._stopLiveEventsRefresh();
    clearInterval(this._nowMarkerTimer);
    if (this._player) {
      this._player.disable();
      this._player = null;
    }
    this._stream = null;
  }

  getState() {
    if (!this.isActive) return {};
    const pos = this.position;
    return {
      playback: {
        active: true,
        day: this._date?.toISOString(),
        time: pos?.toISOString(),
        resolution: this._view._state.quality?.playbackRes || 'original',
      },
    };
  }

  restoreState(state) {
    // Requires app-level coordination (API call to create stream) — not done here
  }

  // ── Public API ──

  get isActive() { return !!this._stream; }
  get streamName() { return this._stream; }
  get resolution() { return this._view._state.quality?.playbackRes || 'original'; }

  get position() {
    if (!this._date || !this._startWall) return null;
    const elapsed = (Date.now() - this._startWall.getTime()) / 1000;
    const totalSeconds = this._offset + elapsed;
    return new Date(this._date.getTime() + totalSeconds * 1000);
  }

  togglePanel() {
    const d = this._dom;
    if (!d.playbackPanel) return;
    d.playbackPanel.classList.toggle('open');
    d.playbackBtn?.classList.toggle('active', d.playbackPanel.classList.contains('open'));
  }

  /**
   * Start archive playback.
   */
  start(streamName, startTime, endTime, forceMSE = false, resolution = 'original') {
    // Debounce: ignore rapid repeated calls
    if (this._startDebounce) return;
    this._startDebounce = true;
    setTimeout(() => { this._startDebounce = false; }, 1000);

    const view = this._view;
    this.stopTimer();
    this._stopLiveEventsRefresh();
    this._clearPendingChange();

    // Stop talkback if active
    for (const f of view._features) {
      if (f.constructor.name === 'TalkbackFeature' && f.isActive) {
        f.stop(true);
      }
    }

    // Clean previous
    if (this._player) { this._player.disable(); this._player = null; }

    // Clean HD via quality feature
    const qf = view._features.find(f => f.constructor.name === 'QualityFeature');
    if (qf?.isHd) qf.stopHd();

    this._stream = streamName;
    view._playbackStream = streamName; // core needs this for isPlayback

    // Track position
    this._date = new Date(startTime);
    this._date.setHours(0, 0, 0, 0);
    this._offset = (startTime - this._date) / 1000;
    this._startWall = new Date();
    this._updateDateLabel();
    this._fetchEvents(); // Load smart events for timeline

    view._showLoading('loading archive');
    this._player = new CamPlayer(view.video, streamName, { preferH265: forceMSE });
    view._wirePlayer(this._player, 'playback');

    const useMSE = forceMSE && !CamPlayer.h265WebRTCSupported;
    view._switchPlayer(this._player, useMSE ? 'mse' : 'start');

    view.el.classList.add('playback-mode');
    view._stopLiveTimer();

    // Grid HUD
    if (view._dom.ghudRecLabel) view._dom.ghudRecLabel.textContent = 'REC';

    // Fullscreen HUD
    view.el.classList.remove('fs-live');
    if (this._dom.seekInfoName) this._dom.seekInfoName.textContent = view.id;
    if (this._dom.seekInfoRecText) this._dom.seekInfoRecText.textContent = 'REC';

    clearInterval(this._nowMarkerTimer);
    this._nowMarkerTimer = setInterval(() => this._updateSeekAvailability(), 30000);

    // Quality feature: switch to playback mode
    if (qf) qf.enterPlaybackMode(resolution);

    // Panel buttons
    const goBtn = this._dom.pbGo;
    const liveBtn = this._dom.pbLive;
    if (goBtn) { goBtn.innerHTML = '&#9632; Stop'; goBtn.classList.add('active'); }
    if (liveBtn) { liveBtn.classList.remove('active'); liveBtn.classList.add('return-hint'); liveBtn.innerHTML = '&#9654; Live'; }

    // Restore datetime inputs
    if (this._dom.pbResolution) this._dom.pbResolution.value = resolution;
    if (this._dom.pbStart) this._dom.pbStart.value = fmtInput(startTime);
    if (this._dom.pbEnd) this._dom.pbEnd.value = fmtInput(endTime);

    // Show seek timeline
    this._dom.seekTimeline?.classList.add('active');
    this._startPositionTimer();
  }

  /** Stop playback, return to live. */
  stop() {
    const view = this._view;
    view._awaitingUserPlay = false;
    this.stopTimer();
    clearInterval(this._nowMarkerTimer);
    view._clearFreezeFrame();
    view._pausedPosition = null;
    view.el.classList.remove('paused');
    const ind = view._dom.pauseIndicator;
    if (ind) ind.classList.remove('visible');

    if (this._player) { this._player.disable(); this._player = null; }
    this._stream = null;
    view._playbackStream = null;
    this._date = null;
    this._startWall = null;
    view.el.classList.remove('playback-mode');
    this._dom.seekTimeline?.classList.remove('active');

    // Reset inline display styles set by _updateSeekAvailability()
    // CSS !important should handle this, but belt-and-suspenders
    if (this._dom.seekUnavailable) this._dom.seekUnavailable.style.display = '';
    if (this._dom.seekNow) this._dom.seekNow.style.display = '';
    if (this._dom.ghudUnavailable) this._dom.ghudUnavailable.style.display = '';
    if (this._dom.ghudNow) this._dom.ghudNow.style.display = '';

    // Clear smart event markers & UI
    this._activeEventIdx = -1;
    if (this._dom.smdBadge) { this._dom.smdBadge.innerHTML = ''; this._dom.smdBadge.classList.remove('visible'); }
    if (this._dom.smdNav) this._dom.smdNav.style.display = 'none';
    if (this._dom.smdTooltip) this._dom.smdTooltip.classList.remove('visible');
    const ghudSmd = this._view._dom.ghudInfo?.querySelector('.ghud-smd');
    if (ghudSmd) ghudSmd.remove();

    // If returning to live in fullscreen — keep events, restart refresh
    // Otherwise clear everything
    if (view.isFullscreen) {
      this._eventsDate = null; // force refetch on next cycle
      this._startLiveEventsRefresh();
    } else {
      if (this._dom.seekEvents) this._dom.seekEvents.innerHTML = '';
      if (this._dom.ghudEvents) this._dom.ghudEvents.innerHTML = '';
      this._events = [];
      this._eventsDate = null;
    }

    // Reset seek cursor positions
    if (this._dom.seekFill) this._dom.seekFill.style.width = '';
    if (this._dom.seekCursor) this._dom.seekCursor.style.left = '';
    if (this._dom.seekCursorLine) this._dom.seekCursorLine.style.left = '';
    if (this._dom.seekCursorTime) { this._dom.seekCursorTime.style.left = ''; this._dom.seekCursorTime.textContent = ''; }

    if (view.isFullscreen) {
      view.el.classList.add('fs-live');
      if (this._dom.seekInfoRecText) this._dom.seekInfoRecText.textContent = 'LIVE';
    }

    // Quality feature: restore SD/HD toggle
    const qf = view._features.find(f => f.constructor.name === 'QualityFeature');
    if (qf) qf.exitPlaybackMode();

    // Panel buttons
    const goBtn = this._dom.pbGo;
    const liveBtn = this._dom.pbLive;
    if (goBtn) { goBtn.innerHTML = '&#9654; Play'; goBtn.classList.remove('active'); }
    if (liveBtn) { liveBtn.classList.remove('return-hint'); liveBtn.classList.add('active'); liveBtn.innerHTML = '&#9673; Live'; }

    view._switchPlayer(view.player);
    view._startLiveTimer();
  }

  stopTimer() {
    clearInterval(this._positionTimer);
    this._positionTimer = null;
  }

  destroyPlayer() {
    if (this._player) { this._player.disable(); this._player = null; }
    this._stream = null;
    this._view._playbackStream = null;
  }

  // ── Grid HUD bar hover (called by core) ──

  onGhudBarHover(hours, minutes, fraction, ghudTooltip) {
    let isUnavailable = false;
    if (this._date) {
      const hoverDate = new Date(this._date);
      hoverDate.setHours(hours, minutes, 0, 0);
      isUnavailable = this._isUnavailable(hoverDate);
    } else {
      const now = new Date();
      const hoverDate = new Date(now);
      hoverDate.setHours(hours, minutes, 0, 0);
      isUnavailable = hoverDate > now;
    }
    if (isUnavailable) {
      ghudTooltip.textContent = '▶ LIVE';
      ghudTooltip.classList.add('visible', 'live');
      ghudTooltip.classList.remove('unavailable');
    } else {
      ghudTooltip.textContent = `${pad(hours)}:${pad(minutes)}`;
      ghudTooltip.classList.add('visible');
      ghudTooltip.classList.remove('unavailable', 'live');
    }
    ghudTooltip.style.left = `${fraction * 100}%`;
  }

  // ── Timeline click handler (called by core) ──

  onTimelineClick(hours, minutes) {
    const view = this._view;
    if (!this._date && view.onPlaybackRequest) {
      // LIVE mode → start archive
      const now = new Date();
      const seekTime = new Date(now);
      seekTime.setHours(hours, minutes, 0, 0);
      if (seekTime > now) return;
      const endOfDay = new Date(now);
      endOfDay.setHours(23, 59, 59, 0);
      const resolution = this._dom.pbResolution?.value || 'original';
      view.onPlaybackRequest(view, fmtFull(seekTime), fmtFull(endOfDay), resolution);
    } else if (this._date && view.onPlaybackSeek) {
      const seekTime = new Date(this._date);
      seekTime.setHours(hours, minutes, 0, 0);
      if (this._isUnavailable(seekTime)) {
        this._dom.pbLive?.click();
        return;
      }
      view.onPlaybackSeek(view, seekTime);
    }
  }

  // ── Position tracking ──

  _startPositionTimer() {
    this._positionTimer = setInterval(() => this._updatePosition(), 500);
    this._updatePosition();
  }

  _updatePosition() {
    const pos = this.position;
    if (!pos) return;

    const fraction = Math.min(daySeconds(pos) / 86400, 1);
    this._seekCursorFraction = fraction;
    const pct = `${fraction * 100}%`;
    const timeStr = hms(pos);
    const dateStr = dm(pos);

    // Fullscreen seek bar
    if (this._dom.seekFill) this._dom.seekFill.style.width = pct;
    if (this._dom.seekCursor) this._dom.seekCursor.style.left = pct;
    if (this._dom.seekCursorLine) this._dom.seekCursorLine.style.left = pct;
    if (this._dom.seekCursorTime) {
      this._dom.seekCursorTime.style.left = pct;
      this._dom.seekCursorTime.textContent = timeStr;
    }

    this._updateSeekAvailability();
    this._renderBadge(timeStr, dateStr);

    // Fullscreen info row
    if (this._dom.seekInfoTime) this._dom.seekInfoTime.textContent = timeStr;
    if (this._dom.seekInfoDate) this._dom.seekInfoDate.textContent = dmy(pos);

    // Grid HUD
    const ghudFill = this._view._dom.ghudFill;
    const ghudCursor = this._view._dom.ghudCursor;
    const ghudTime = this._view._dom.ghudTime;
    if (ghudFill) ghudFill.style.width = pct;
    if (ghudCursor) ghudCursor.style.left = pct;
    if (ghudTime) ghudTime.textContent = timeStr;

    // Smart event tracking
    this._updateActiveEvent();
  }

  _updateDateLabel() {
    const d = this._date;
    const now = new Date();
    const isToday = d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    const days = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'];

    if (this._dom.seekDateLabel) {
      if (!d) this._dom.seekDateLabel.innerHTML = '';
      else {
        const wd = days[d.getDay()];
        this._dom.seekDateLabel.innerHTML = `<span class="seek-date-weekday">${wd}</span>${dm(d)}`;
        this._dom.seekDateLabel.classList.toggle('is-today', isToday);
      }
    }
    if (this._dom.seekDayNext) this._dom.seekDayNext.classList.toggle('disabled', isToday);

    // Grid HUD
    if (this._dom.ghudDate) {
      if (!d) this._dom.ghudDate.textContent = '';
      else {
        this._dom.ghudDate.textContent = `${days[d.getDay()]} ${dm(d)}`;
        this._dom.ghudDate.classList.toggle('is-today', isToday);
      }
    }
    if (this._dom.ghudDayNext) this._dom.ghudDayNext.classList.toggle('disabled', isToday);
  }

  _updateSeekAvailability() {
    const unavail = this._dom.seekUnavailable;
    const nowMarker = this._dom.seekNow;
    const nowLabel = this._dom.seekNowLabel;
    const ghudUnavail = this._dom.ghudUnavailable;
    const ghudNow = this._dom.ghudNow;

    const hideAll = () => {
      if (unavail) unavail.style.display = 'none';
      if (nowMarker) nowMarker.style.display = 'none';
      if (ghudUnavail) ghudUnavail.style.display = 'none';
      if (ghudNow) ghudNow.style.display = 'none';
    };

    if (!this._date) { hideAll(); return; }
    const now = new Date();
    const isToday = now.getFullYear() === this._date.getFullYear() && now.getMonth() === this._date.getMonth() && now.getDate() === this._date.getDate();
    if (!isToday) { hideAll(); return; }

    const bufferMin = 1;
    const availUntil = new Date(now.getTime() - bufferMin * 60000);
    const availFrac = Math.min(daySeconds(availUntil) / 86400, 1);
    const nowFrac = Math.min(daySeconds(now) / 86400, 1);
    this._seekNowFraction = nowFrac;

    if (unavail) { unavail.style.display = 'block'; unavail.style.left = `${availFrac * 100}%`; unavail.style.right = '0'; }
    if (nowMarker) { nowMarker.style.display = 'block'; nowMarker.style.left = `${nowFrac * 100}%`; }
    if (nowLabel) {
      const dist = Math.abs((this._seekCursorFraction || 0) - nowFrac);
      nowLabel.style.opacity = dist < 0.04 ? '0' : '';
      nowLabel.textContent = hm(now);
    }
    if (ghudUnavail) { ghudUnavail.style.display = 'block'; ghudUnavail.style.left = `${availFrac * 100}%`; ghudUnavail.style.right = '0'; }
    if (ghudNow) { ghudNow.style.display = 'block'; ghudNow.style.left = `${nowFrac * 100}%`; }
  }

  _isUnavailable(seekDate) {
    if (!this._date) return false;
    const now = new Date();
    const isToday = now.getFullYear() === seekDate.getFullYear() && now.getMonth() === seekDate.getMonth() && now.getDate() === seekDate.getDate();
    if (!isToday) return false;
    return seekDate > new Date(now.getTime() - 60000);
  }

  _renderBadge(timeStr, dateStr) {
    const badge = this._view._dom.modeBadge;
    if (!badge) return;
    if (timeStr && dateStr) {
      badge.innerHTML = `<span class="rec-dot">● REC</span><span class="rec-time">${timeStr}</span><span class="rec-date">${dateStr}</span>`;
    } else {
      badge.innerHTML = `<span class="rec-dot">● REC</span>`;
    }
    badge.className = 'cam-mode playback';
  }

  _updateBadge(mode) {
    const pos = this.position;
    this._renderBadge(pos ? hm(pos) : null, pos ? dm(pos) : null);
  }

  _markPendingChange(changedEl) {
    if (!this.isActive) return;
    const goBtn = this._dom.pbGo;
    if (goBtn) { goBtn.innerHTML = '&#9654; Play'; goBtn.classList.remove('active'); goBtn.classList.add('pending'); }
    changedEl.classList.add('pending');
  }

  _clearPendingChange() {
    this._view.el.querySelectorAll('.pending').forEach(el => el.classList.remove('pending'));
  }

  // ── DOM injection ──

  _injectDOM() {
    const el = this._view.el;
    const view = this._view;

    // Playback button in top-right
    const topRight = el.querySelector('.cam-top-right');
    if (topRight) {
      const btn = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      btn.setAttribute('class', 'cam-playback-btn');
      btn.setAttribute('viewBox', '0 0 24 24');
      btn.setAttribute('fill', 'white');
      btn.setAttribute('title', 'Archive playback panel');
      btn.innerHTML = '<path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/>';
      topRight.appendChild(btn);
    }

    // Playback panel
    const panel = document.createElement('div');
    panel.className = 'cam-playback-panel';
    panel.innerHTML = `
      <div class="playback-row">
        <input type="datetime-local" class="playback-start" title="Playback start time">
        <span class="playback-sep">&rarr;</span>
        <input type="datetime-local" class="playback-end" title="Playback end time">
      </div>
      <div class="playback-row">
        <select class="playback-resolution" title="Video resolution for playback">
          <option value="original">SRC</option><option value="1080p">1080p</option><option value="720p">720p</option><option value="480p">480p</option><option value="360p">360p</option>
        </select>
        <button class="playback-go" title="Start archive playback">&#9654; Play</button>
        <button class="playback-live" title="Return to live stream">&#9673; Live</button>
      </div>
      <div class="playback-row playback-seek-btns">
        <button class="seek-btn" data-offset="-3600" title="-1h">-1h</button>
        <button class="seek-btn" data-offset="-900" title="-15m">-15m</button>
        <button class="seek-btn" data-offset="-300" title="-5m">-5m</button>
        <button class="seek-btn" data-offset="300" title="+5m">+5m</button>
        <button class="seek-btn" data-offset="900" title="+15m">+15m</button>
        <button class="seek-btn" data-offset="3600" title="+1h">+1h</button>
      </div>
    `;
    const overlay = el.querySelector('.cam-overlay');
    if (overlay) overlay.after(panel);

    // Seek timeline (fullscreen)
    const timeline = document.createElement('div');
    timeline.className = 'cam-seek-timeline';
    timeline.innerHTML = `
      <div class="seek-info-row">
        <span class="seek-info-name"></span>
        <span class="seek-info-status"><span class="seek-info-rec-dot"><span class="seek-info-rec-inner"></span></span><span class="seek-info-rec-text">REC</span></span>
        <button class="seek-info-time-btn" title="Open archive panel (P)"><span class="seek-info-time"></span><span class="seek-info-time-arrow">▾</span></button>
        <span class="seek-info-date-full"></span>
        <span class="smd-badge"></span>
        <div class="smd-nav"><button class="smd-nav-prev" title="Previous event (Shift+E)">◂</button><span class="smd-nav-pos">—</span><button class="smd-nav-next" title="Next event (E)">▸</button></div>
        <span class="seek-info-spacer"></span>
        <div class="seek-info-seek-btns">
          <button class="fs-seek-btn" data-offset="-3600">-1h</button><button class="fs-seek-btn" data-offset="-900">-15m</button><button class="fs-seek-btn" data-offset="-300">-5m</button><button class="fs-seek-btn" data-offset="-60">-1m</button>
          <button class="fs-seek-btn fs-seek-fwd" data-offset="60">+1m</button><button class="fs-seek-btn fs-seek-fwd" data-offset="300">+5m</button><button class="fs-seek-btn fs-seek-fwd" data-offset="900">+15m</button><button class="fs-seek-btn fs-seek-fwd" data-offset="3600">+1h</button>
          <button class="fs-seek-more" title="More seek options">⋯</button>
          <div class="fs-seek-extra"><button class="fs-seek-btn" data-offset="-21600">-6h</button><button class="fs-seek-btn" data-offset="-1800">-30m</button><button class="fs-seek-btn fs-seek-fwd" data-offset="1800">+30m</button><button class="fs-seek-btn fs-seek-fwd" data-offset="21600">+6h</button></div>
        </div>
        <div class="seek-date-nav"><button class="seek-day-btn seek-day-prev" title="Previous day">◂</button><span class="seek-date-label"></span><button class="seek-day-btn seek-day-next" title="Next day">▸</button></div>
      </div>
      <div class="seek-bar-wrap">
        <div class="seek-bar">
          <div class="seek-ticks"><span></span><span></span><span></span><span></span><span></span><span></span></div>
          <div class="seek-fill"></div><div class="seek-cursor"></div><div class="seek-cursor-line"></div><div class="seek-cursor-time"></div><div class="seek-cursor-detail"></div>
          <div class="seek-unavailable"></div><div class="seek-now"><span class="seek-now-label"></span></div>
          <div class="seek-events"></div>
        </div>
        <div class="seek-labels"><span>00:00</span><span>04:00</span><span>08:00</span><span>12:00</span><span>16:00</span><span>20:00</span><span>24:00</span></div>
        <div class="seek-time-tooltip"></div>
        <div class="seek-thumb-dot"><svg class="seek-thumb-ring" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.5" class="seek-ring-bg"/><circle cx="10" cy="10" r="8.5" class="seek-ring-fill"/></svg></div>
        <div class="seek-thumbnail"><div class="seek-thumb-progress"></div><img alt=""><div class="seek-thumb-spinner"><div></div></div><div class="seek-thumb-time"></div></div>
        <div class="seek-thumb-marker"></div>
        <div class="seek-live-pill">▶ LIVE</div>
        <div class="smd-tooltip"></div>
      </div>
    `;
    const camTimeline = el.querySelector('.cam-timeline');
    if (camTimeline) el.insertBefore(timeline, camTimeline);

    // Grid HUD: spacer + day nav — insert AFTER ghud-status, BEFORE quality badge
    const ghudInfo = el.querySelector('.ghud-info');
    const ghudStatus = el.querySelector('.ghud-status');
    if (ghudInfo && ghudStatus) {
      const spacer = document.createElement('span');
      spacer.className = 'ghud-spacer';

      const prevBtn = document.createElement('button');
      prevBtn.className = 'ghud-day-prev';
      prevBtn.textContent = '◂';

      const dateEl = document.createElement('span');
      dateEl.className = 'ghud-date';

      const nextBtn = document.createElement('button');
      nextBtn.className = 'ghud-day-next';
      nextBtn.textContent = '▸';

      // Insert all after ghud-status — keeps quality badge (if any) at end
      ghudStatus.after(spacer, prevBtn, dateEl, nextBtn);
    }

    // Grid HUD: unavailable + now marker + events in ghud-bar
    const ghudBar = this._view._dom.ghudBar;
    if (ghudBar) {
      const unavail = document.createElement('div');
      unavail.className = 'ghud-unavailable';
      ghudBar.appendChild(unavail);
      const nowEl = document.createElement('div');
      nowEl.className = 'ghud-now';
      ghudBar.appendChild(nowEl);
      const eventsEl = document.createElement('div');
      eventsEl.className = 'ghud-events';
      ghudBar.appendChild(eventsEl);
    }

    // LIVE button (before grid HUD)
    const ghud = el.querySelector('.cam-grid-hud');
    if (ghud) {
      const liveBtn = document.createElement('button');
      liveBtn.className = 'ghud-live-btn';
      liveBtn.innerHTML = '▶ LIVE<span class="ghud-live-progress"></span>';
      el.insertBefore(liveBtn, ghud);
    }
  }

  _cacheDom() {
    const el = this._view.el;
    this._dom = {
      playbackBtn:     el.querySelector('.cam-playback-btn'),
      playbackPanel:   el.querySelector('.cam-playback-panel'),
      pbStart:         el.querySelector('.playback-start'),
      pbEnd:           el.querySelector('.playback-end'),
      pbResolution:    el.querySelector('.playback-resolution'),
      pbGo:            el.querySelector('.playback-go'),
      pbLive:          el.querySelector('.playback-live'),
      seekTimeline:    el.querySelector('.cam-seek-timeline'),
      seekBar:         el.querySelector('.seek-bar'),
      seekFill:        el.querySelector('.seek-fill'),
      seekCursor:      el.querySelector('.seek-cursor'),
      seekCursorLine:  el.querySelector('.seek-cursor-line'),
      seekCursorTime:  el.querySelector('.seek-cursor-time'),
      seekCursorDetail:el.querySelector('.seek-cursor-detail'),
      seekTooltip:     el.querySelector('.seek-time-tooltip'),
      seekUnavailable: el.querySelector('.seek-unavailable'),
      seekNow:         el.querySelector('.seek-now'),
      seekNowLabel:    el.querySelector('.seek-now-label'),
      seekDateLabel:   el.querySelector('.seek-date-label'),
      seekDayPrev:     el.querySelector('.seek-day-prev'),
      seekDayNext:     el.querySelector('.seek-day-next'),
      seekThumbDot:    el.querySelector('.seek-thumb-dot'),
      seekRingFill:    el.querySelector('.seek-ring-fill'),
      seekThumbnail:   el.querySelector('.seek-thumbnail'),
      seekThumbImg:    el.querySelector('.seek-thumbnail img'),
      seekThumbTime:   el.querySelector('.seek-thumb-time'),
      seekThumbProgress:el.querySelector('.seek-thumb-progress'),
      seekThumbSpinner:el.querySelector('.seek-thumb-spinner'),
      seekThumbMarker: el.querySelector('.seek-thumb-marker'),
      seekLivePill:    el.querySelector('.seek-live-pill'),
      seekInfoName:    el.querySelector('.seek-info-name'),
      seekInfoRecText: el.querySelector('.seek-info-rec-text'),
      seekInfoTime:    el.querySelector('.seek-info-time'),
      seekInfoTimeBtn: el.querySelector('.seek-info-time-btn'),
      seekInfoDate:    el.querySelector('.seek-info-date-full'),
      fsSeekMore:      el.querySelector('.fs-seek-more'),
      fsSeekExtra:     el.querySelector('.fs-seek-extra'),
      ghudLiveBtn:     el.querySelector('.ghud-live-btn'),
      ghudDate:        el.querySelector('.ghud-date'),
      ghudDayPrev:     el.querySelector('.ghud-day-prev'),
      ghudDayNext:     el.querySelector('.ghud-day-next'),
      ghudUnavailable: el.querySelector('.ghud-unavailable'),
      ghudNow:         el.querySelector('.ghud-now'),
      seekEvents:      el.querySelector('.seek-events'),
      ghudEvents:      el.querySelector('.ghud-events'),
      smdBadge:        el.querySelector('.smd-badge'),
      smdNav:          el.querySelector('.smd-nav'),
      smdNavPos:       el.querySelector('.smd-nav-pos'),
      smdNavPrev:      el.querySelector('.smd-nav-prev'),
      smdNavNext:      el.querySelector('.smd-nav-next'),
      smdTooltip:      el.querySelector('.smd-tooltip'),
    };
  }

  // ── Event binding (abbreviated — key handlers only, full seek bar logic) ──

  _bindEvents() {
    const view = this._view;
    const d = this._dom;

    // Playback panel mousedown — prevent fullscreen toggle
    d.playbackPanel?.addEventListener('mousedown', (e) => e.stopPropagation());

    // Playback button → toggle panel
    d.playbackBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      d.playbackPanel?.classList.toggle('open');
      d.playbackBtn?.classList.toggle('active', d.playbackPanel?.classList.contains('open'));
      if (d.playbackPanel?.classList.contains('open')) {
        const now = new Date();
        const ago = new Date(now.getTime() - 3600000);
        const endOfDay = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}T23:59`;
        if (d.pbStart) d.pbStart.value = fmtInput(ago);
        if (d.pbEnd) d.pbEnd.value = endOfDay(ago);
      }
    });

    // Auto-set end when start changes
    d.pbStart?.addEventListener('change', (e) => {
      e.stopPropagation();
      if (e.target.value) {
        const dt = new Date(e.target.value);
        if (d.pbEnd) d.pbEnd.value = `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}T23:59`;
      }
      this._markPendingChange(e.target);
    });
    d.pbEnd?.addEventListener('change', (e) => { e.stopPropagation(); this._markPendingChange(e.target); });
    d.pbResolution?.addEventListener('change', (e) => {
      e.stopPropagation();
      this._markPendingChange(e.target);
      if (this.isActive) {
        const qf = view._features.find(f => f.constructor.name === 'QualityFeature');
        if (qf) qf.setPlaybackResolution(e.target.value);
      }
    });

    // Play button
    d.pbGo?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._clearPendingChange();
      const start = d.pbStart?.value;
      const end = d.pbEnd?.value;
      const resolution = d.pbResolution?.value;
      if (start && end && view.onPlaybackRequest) view.onPlaybackRequest(view, start, end, resolution);
    });

    // Live button
    if (d.pbLive) {
      d.pbLive.classList.add('active');
      d.pbLive.addEventListener('mousedown', (e) => e.stopPropagation());
      d.pbLive.addEventListener('click', (e) => {
        e.stopPropagation();
        if (view.onLiveRequest) view.onLiveRequest(view);
      });
    }

    // Quick seek buttons (panel)
    view.el.querySelectorAll('.seek-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._handleSeekOffset(parseInt(btn.dataset.offset));
      });
    });

    // Fullscreen seek buttons
    view.el.querySelectorAll('.fs-seek-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._handleSeekOffset(parseInt(btn.dataset.offset));
      });
    });

    // Seek bar: click, mousemove, mouseleave (simplified — full thumbnail logic from original)
    this._bindSeekBar();

    // Day nav (fullscreen)
    d.seekDayPrev?.addEventListener('click', (e) => { e.stopPropagation(); this._changeDay(-1); });
    d.seekDayNext?.addEventListener('click', (e) => { e.stopPropagation(); this._changeDay(+1); });

    // Grid HUD day nav
    d.ghudDayPrev?.addEventListener('click', (e) => { e.stopPropagation(); this._changeDay(-1); });
    d.ghudDayNext?.addEventListener('click', (e) => { e.stopPropagation(); this._changeDay(+1); });

    // SMD event navigation
    d.smdNavPrev?.addEventListener('click', (e) => { e.stopPropagation(); this._navigateEvent(-1); });
    d.smdNavNext?.addEventListener('click', (e) => { e.stopPropagation(); this._navigateEvent(+1); });

    // LIVE button (grid HUD) — long-press to go live
    this._bindLiveButton();

    // Time button → toggle panel (fullscreen)
    d.seekInfoTimeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      d.playbackPanel?.classList.toggle('open');
      d.playbackBtn?.classList.toggle('active', d.playbackPanel?.classList.contains('open'));
      if (d.playbackPanel?.classList.contains('open')) {
        const now = new Date();
        const ago = new Date(now.getTime() - 3600000);
        const endOfDay = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}T23:59`;
        if (d.pbStart) d.pbStart.value = fmtInput(ago);
        if (d.pbEnd) d.pbEnd.value = endOfDay(ago);
      }
    });

    // More seek options toggle
    d.fsSeekMore?.addEventListener('click', (e) => {
      e.stopPropagation();
      d.fsSeekExtra?.classList.toggle('open');
    });
  }

  _handleSeekOffset(offset) {
    const view = this._view;
    if (this.isActive) {
      const pos = this.position;
      if (pos) {
        let seekTime = new Date(pos.getTime() + offset * 1000);
        if (this._isUnavailable(seekTime)) return;
        if (view.onPlaybackSeek) view.onPlaybackSeek(view, seekTime);
        else if (view.onQuickSeek) view.onQuickSeek(view, seekTime);
      }
    } else if (offset < 0 && view.onPlaybackRequest) {
      const seekTime = new Date(Date.now() + offset * 1000);
      const endOfDay = new Date(seekTime);
      endOfDay.setHours(23, 59, 59, 0);
      const resolution = this._dom.pbResolution?.value || 'original';
      view.onPlaybackRequest(view, fmtFull(seekTime), fmtFull(endOfDay), resolution);
    }
  }

  // ── Smart events on timeline ──

  /** Fetch events for playback mode (uses this._date) */
  async _fetchEvents() {
    if (!this._date) return;
    const dateStr = this._dateStr(this._date);
    if (this._eventsDate === dateStr) return;
    await this._doFetchEvents(dateStr);
  }

  /** Fetch events for live mode (uses today, always fresh) */
  async _fetchLiveEvents() {
    const dateStr = this._dateStr(new Date());
    await this._doFetchEvents(dateStr, true);
  }

  /** Common fetch logic */
  async _doFetchEvents(dateStr, forLive = false) {
    const id = this._view.id;
    try {
      const res = await fetch(`/backend/events/${id}?date=${dateStr}`);
      if (!res.ok) { this._events = []; this._eventsDate = dateStr; this._renderEvents(forLive); return; }
      const data = await res.json();
      this._events = data.events || [];
      this._eventsDate = dateStr;
      this._activeEventIdx = -1;
      this._renderEvents(forLive);
    } catch {
      this._events = [];
      this._eventsDate = dateStr;
      this._renderEvents(forLive);
    }
  }

  _dateStr(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** Start 60s refresh cycle for live mode events */
  _startLiveEventsRefresh() {
    this._stopLiveEventsRefresh();
    this._fetchLiveEvents();
    this._liveEventsTimer = setInterval(() => this._fetchLiveEvents(), 60000);
  }

  /** Stop live events refresh */
  _stopLiveEventsRefresh() {
    if (this._liveEventsTimer) {
      clearInterval(this._liveEventsTimer);
      this._liveEventsTimer = null;
    }
  }

  _renderEvents(forLive = false) {
    const tooltip = this._dom.smdTooltip;

    for (const container of [this._dom.seekEvents, this._dom.ghudEvents]) {
      if (!container) continue;
      container.innerHTML = '';
      const isGhud = container.classList.contains('ghud-events');

      for (let i = 0; i < this._events.length; i++) {
        const ev = this._events[i];
        const left = (ev.start / 86400) * 100;
        const width = Math.max(((ev.end - ev.start) / 86400) * 100, isGhud ? 0.25 : 0.15);
        const marker = document.createElement('div');
        marker.className = `smd-marker smd-${ev.type}`;
        marker.dataset.idx = String(i);
        marker.style.left = `${left}%`;
        marker.style.width = `${width}%`;

        // Click → seek to event start (playback) or enter archive (live)
        marker.addEventListener('click', (e) => {
          e.stopPropagation();
          const sec = ev.start;
          const view = this._view;

          if (this.isActive && view.onPlaybackSeek) {
            // Playback mode — seek within current session
            const baseDate = this._date || new Date();
            const seekDate = new Date(baseDate);
            seekDate.setHours(0, 0, 0, 0);
            seekDate.setSeconds(sec);
            view.onPlaybackSeek(view, seekDate);
          } else if (view.onPlaybackRequest) {
            // Live mode — enter archive at event time
            this._stopLiveEventsRefresh();
            const now = new Date();
            const seekDate = new Date(now);
            seekDate.setHours(0, 0, 0, 0);
            seekDate.setSeconds(sec);
            const endOfDay = new Date(now);
            endOfDay.setHours(23, 59, 59, 0);
            const resolution = this._dom.pbResolution?.value || 'original';
            view.onPlaybackRequest(view, fmtFull(seekDate), fmtFull(endOfDay), resolution);
          }
        });

        // Hover tooltip (fullscreen seek-bar only)
        if (!isGhud && tooltip) {
          marker.addEventListener('mouseenter', () => {
            const label = ev.type === 'human' ? 'Human' : 'Vehicle';
            const color = ev.type === 'human' ? 'var(--danger)' : 'var(--warn)';
            const extra = forLive ? '<span class="smd-tooltip-hint">click to view in archive</span>' : '';
            tooltip.innerHTML = `<span class="smd-tooltip-dot" style="background:${color}"></span><span class="smd-tooltip-type">${label}</span><span class="smd-tooltip-time">${this._fmtSec(ev.start)} — ${this._fmtSec(ev.end)}</span>${extra}`;
            tooltip.classList.add('visible');
            const barRect = this._dom.seekBar?.getBoundingClientRect();
            const markerRect = marker.getBoundingClientRect();
            if (barRect) {
              const cx = markerRect.left + markerRect.width / 2 - barRect.left;
              tooltip.style.left = `${cx}px`;
            }
          });
          marker.addEventListener('mouseleave', () => {
            tooltip.classList.remove('visible');
          });
        }

        container.appendChild(marker);
      }
    }

    // Update nav/badge based on mode
    if (forLive) {
      this._updateLiveEventCount();
    } else {
      this._updateEventNav();
      this._updateGhudEventBadge();
    }
  }

  /** Called from _updatePosition — check if playback is inside an event */
  _updateActiveEvent() {
    if (!this._events.length) {
      if (this._activeEventIdx !== -1) {
        this._activeEventIdx = -1;
        this._clearActiveMarker();
        this._updateEventBadge();
        this._updateEventNav();
        this._updateGhudEventBadge();
      }
      return;
    }

    const pos = this.position;
    if (!pos) return;
    const sec = daySeconds(pos);
    let found = -1;

    for (let i = 0; i < this._events.length; i++) {
      if (sec >= this._events[i].start && sec <= this._events[i].end) {
        found = i;
        break;
      }
    }

    if (found !== this._activeEventIdx) {
      this._activeEventIdx = found;
      this._highlightActiveMarker(found);
      this._updateEventBadge();
      this._updateEventNav();
      this._updateGhudEventBadge();
    }
  }

  _highlightActiveMarker(idx) {
    for (const container of [this._dom.seekEvents, this._dom.ghudEvents]) {
      if (!container) continue;
      container.querySelectorAll('.smd-marker').forEach((m, i) => {
        m.classList.toggle('smd-active', i === idx);
      });
    }
  }

  _clearActiveMarker() {
    for (const container of [this._dom.seekEvents, this._dom.ghudEvents]) {
      if (!container) continue;
      container.querySelectorAll('.smd-active').forEach(m => m.classList.remove('smd-active'));
    }
  }

  /** Update the event badge in fullscreen info row */
  _updateEventBadge() {
    const badge = this._dom.smdBadge;
    if (!badge) return;
    const idx = this._activeEventIdx;
    if (idx < 0 || !this._events[idx]) {
      badge.innerHTML = '';
      badge.classList.remove('visible');
      return;
    }
    const ev = this._events[idx];
    const label = ev.type === 'human' ? 'Human' : 'Vehicle';
    const cls = ev.type === 'human' ? 'smd-badge-human' : 'smd-badge-vehicle';
    badge.className = `smd-badge visible ${cls}`;
    badge.innerHTML = `<span class="smd-badge-dot"></span><span class="smd-badge-label">${label} · ${this._fmtSec(ev.start)} — ${this._fmtSec(ev.end)}</span>`;
  }

  /** Update the event navigator counter */
  _updateEventNav() {
    const nav = this._dom.smdNav;
    const pos = this._dom.smdNavPos;
    if (!nav || !pos) return;
    if (!this._events.length) {
      nav.style.display = 'none';
      return;
    }
    nav.style.display = '';
    const idx = this._activeEventIdx;
    pos.textContent = idx >= 0 ? `${idx + 1} / ${this._events.length}` : `— / ${this._events.length}`;
    pos.className = `smd-nav-pos${idx >= 0 ? ' smd-nav-active' : ''}`;
  }

  /** Update compact event indicator in grid HUD */
  _updateGhudEventBadge() {
    const ghudInfo = this._view._dom.ghudInfo;
    if (!ghudInfo) return;
    let badge = ghudInfo.querySelector('.ghud-smd');
    const idx = this._activeEventIdx;

    if (!this._events.length) {
      if (badge) badge.remove();
      return;
    }

    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'ghud-smd';
      ghudInfo.appendChild(badge);
    }

    if (idx >= 0 && this._events[idx]) {
      const ev = this._events[idx];
      const icon = ev.type === 'human' ? '🚶' : '🚗';
      const cls = ev.type === 'human' ? 'ghud-smd-human' : 'ghud-smd-vehicle';
      badge.className = `ghud-smd ${cls}`;
      badge.textContent = `${icon} ${idx + 1}/${this._events.length}`;
    } else {
      badge.className = 'ghud-smd';
      badge.textContent = `${this._events.length} ev`;
    }
  }

  /** Show event count in fullscreen info row (live mode) */
  _updateLiveEventCount() {
    const badge = this._dom.smdBadge;
    if (!badge) return;
    if (!this._events.length) {
      badge.innerHTML = '';
      badge.classList.remove('visible');
      return;
    }
    badge.className = 'smd-badge visible smd-badge-live';
    badge.innerHTML = `<span class="smd-badge-label">${this._events.length} events today</span>`;

    // Hide nav in live mode
    if (this._dom.smdNav) this._dom.smdNav.style.display = 'none';
  }

  /** Navigate to prev/next event */
  _navigateEvent(direction) {
    if (!this._events.length || !this._view.onPlaybackSeek) return;
    const current = this._activeEventIdx;
    let target;

    if (direction > 0) {
      // Next: if inside event, go to next one; if between, go to nearest after position
      if (current >= 0 && current < this._events.length - 1) {
        target = current + 1;
      } else if (current < 0) {
        const pos = this.position;
        const sec = pos ? daySeconds(pos) : 0;
        target = this._events.findIndex(ev => ev.start > sec);
        if (target < 0) return; // no events ahead
      } else return; // last event
    } else {
      // Prev: if inside event, go to previous; if between, go to nearest before position
      if (current > 0) {
        target = current - 1;
      } else if (current < 0) {
        const pos = this.position;
        const sec = pos ? daySeconds(pos) : 0;
        for (let i = this._events.length - 1; i >= 0; i--) {
          if (this._events[i].end < sec) { target = i; break; }
        }
        if (target === undefined) return; // no events behind
      } else return; // first event
    }

    if (target === undefined || !this._events[target]) return;
    const ev = this._events[target];
    const seekDate = new Date(this._date);
    seekDate.setHours(0, 0, 0, 0);
    seekDate.setSeconds(ev.start);
    this._view.onPlaybackSeek(this._view, seekDate);
  }

  /** Handle keyboard shortcuts for event navigation */
  handleEventKey(key, shiftKey) {
    if (!this.isActive || !this._events.length) return false;
    if (key === 'e' || key === 'E') {
      this._navigateEvent(shiftKey ? -1 : 1);
      return true;
    }
    return false;
  }

  _fmtSec(sec) {
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(Math.floor(sec % 60)).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  _changeDay(direction) {
    const view = this._view;
    if (!this._date || !view.onPlaybackSeek) return;
    const target = new Date(this._date.getTime() + direction * 86400000);
    target.setHours(0, 0, 0, 0);
    if (direction > 0 && target > new Date()) return;
    this._eventsDate = null; // force refetch for new day
    const pos = this.position;
    const timeOfDay = pos ? daySeconds(pos) : 0;
    let seekTime = new Date(target.getTime() + timeOfDay * 1000);
    if (this._isUnavailable(seekTime)) seekTime = new Date(target);
    view.onPlaybackSeek(view, seekTime);
  }

  _bindSeekBar() {
    const d = this._dom;
    const seekBar = d.seekBar;
    if (!seekBar) return;
    const view = this._view;

    // Thumbnail preview — delegated to SeekThumbnail
    this._seekThumbnail = new SeekThumbnail({
      seekBar,
      dom: {
        seekThumbDot: d.seekThumbDot,
        seekRingFill: d.seekRingFill,
        seekThumbnail: d.seekThumbnail,
        seekThumbImg: d.seekThumbImg,
        seekThumbTime: d.seekThumbTime,
        seekThumbProgress: d.seekThumbProgress,
        seekThumbSpinner: d.seekThumbSpinner,
        seekThumbMarker: d.seekThumbMarker,
      },
      cameraId: view.id,
      getBaseDate: () => this._date || (() => { const dt = new Date(); dt.setHours(0,0,0,0); return dt; })(),
      onSeek: (hours, minutes) => {
        const baseDate = this._date || (() => { const dt = new Date(); dt.setHours(0,0,0,0); return dt; })();
        const seekDate = new Date(baseDate);
        seekDate.setHours(hours, minutes, 0, 0);
        if (this.isActive && view.onPlaybackSeek) {
          view.onPlaybackSeek(view, seekDate);
        } else if (view.onPlaybackRequest) {
          const endOfDay = new Date(seekDate); endOfDay.setHours(23, 59, 59, 0);
          view.onPlaybackRequest(view, fmtFull(seekDate), fmtFull(endOfDay), 'original');
        }
      },
    });

    const getTime = (e) => {
      const rect = seekBar.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const total = fraction * 86400;
      return { fraction, hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60) };
    };

    seekBar.addEventListener('mousemove', (e) => {
      e.stopPropagation();
      const { fraction, hours, minutes } = getTime(e);
      const timeText = `${pad(hours)}:${pad(minutes)}`;
      const full = view.isFullscreen;

      const cursorDist = Math.abs(fraction - (this._seekCursorFraction || -1));

      // Fullscreen: show cursor-detail when hovering near cursor (archive only)
      if (full && d.seekCursorDetail && !view.el.classList.contains('fs-live')) {
        if (cursorDist < 0.03 && this._seekCursorFraction !== undefined) {
          const pos = this.position;
          if (pos) {
            const ct = hm(pos);
            const now = new Date();
            const diffMs = now - pos;
            const diffMin = Math.floor(Math.abs(diffMs) / 60000);
            const dH = Math.floor(diffMin / 60);
            const dM = diffMin % 60;
            const delta = dH > 0 ? `-${dH}h${pad(dM)}m` : `-${dM}m`;
            d.seekCursorDetail.innerHTML = `<span class="scd-time">${ct}</span><span class="scd-delta">${delta}</span>`;
          }
          d.seekCursorDetail.style.left = `${(this._seekCursorFraction) * 100}%`;
          d.seekCursorDetail.classList.add('visible');
        } else {
          d.seekCursorDetail.classList.remove('visible');
        }
      }

      // Check unavailable zone
      let isUnavail = false;
      const baseDate = this._date || (() => { const dt = new Date(); dt.setHours(0,0,0,0); return dt; })();
      const hoverDate = new Date(baseDate);
      hoverDate.setHours(hours, minutes, 0, 0);
      if (this._date) isUnavail = this._isUnavailable(hoverDate);
      else isUnavail = hoverDate > new Date();

      if (isUnavail) {
        d.seekTooltip?.classList.remove('visible');
        if (d.seekLivePill) { d.seekLivePill.style.left = `${fraction * 100}%`; d.seekLivePill.classList.add('visible'); }
      } else {
        d.seekLivePill?.classList.remove('visible');
        if (d.seekTooltip) {
          d.seekTooltip.textContent = timeText;
          d.seekTooltip.classList.remove('unavailable');
          d.seekTooltip.style.left = `${fraction * 100}%`;
          d.seekTooltip.classList.add('visible');
        }
      }

      // Delegate thumbnail
      this._seekThumbnail?.update(fraction, hours, minutes, isUnavail);
    });

    seekBar.addEventListener('mouseleave', (e) => {
      d.seekTooltip?.classList.remove('visible');
      d.seekLivePill?.classList.remove('visible');
      if (d.seekCursorDetail) d.seekCursorDetail.classList.remove('visible');
      this._seekThumbnail?.dismiss(e);
    });

    seekBar.addEventListener('click', (e) => {
      e.stopPropagation();
      const { hours, minutes } = getTime(e);
      this.onTimelineClick(hours, minutes);
    });
  }
  _bindLiveButton() {
    const btn = this._dom.ghudLiveBtn;
    if (!btn) return;
    const view = this._view;
    let timer = null;
    let triggered = false;
    const HOLD_MS = 500;

    btn.addEventListener('mousedown', (e) => {
      e.stopImmediatePropagation();
      e.preventDefault();
      triggered = false;
      btn.classList.add('pressing');
      timer = setTimeout(() => {
        triggered = true;
        btn.classList.remove('pressing');
        btn.classList.add('triggered');
        this._dom.pbLive?.click();
        setTimeout(() => btn.classList.remove('triggered'), 300);
      }, HOLD_MS);
    });

    const cancel = (e) => {
      e.stopImmediatePropagation();
      e.preventDefault();
      clearTimeout(timer);
      btn.classList.remove('pressing');
      const suppress = (ev) => { ev.stopImmediatePropagation(); ev.preventDefault(); };
      view.el.addEventListener('click', suppress, { capture: true, once: true });
    };
    btn.addEventListener('mouseup', cancel);
    btn.addEventListener('mouseleave', cancel);
    btn.addEventListener('click', (e) => { e.stopImmediatePropagation(); e.preventDefault(); });
  }

  destroy() {
    this.stopTimer();
    clearInterval(this._nowMarkerTimer);
    if (this._seekThumbnail) { this._seekThumbnail.destroy(); this._seekThumbnail = null; }
    this._dom.playbackPanel?.remove();
    this._dom.seekTimeline?.remove();
    this._dom.playbackBtn?.remove();
    this._dom.ghudLiveBtn?.remove();
    super.destroy();
  }
}
