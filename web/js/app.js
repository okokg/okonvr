/**
 * App — main application entry point.
 *
 * Orchestrates:
 * - Fetching camera list from backend
 * - Building the camera grid
 * - Wiring controls (grid size, filters, search, refresh)
 * - Keyboard shortcuts
 * - Clock
 * - Notifications
 */

import { ApiClient } from './api.js';
import { CameraGrid } from './grid.js';
import { CameraView } from './camera-view.js';
import { CamPlayer } from './player.js';
import { NotificationManager } from './notifications.js';
import { SEARCH_DEBOUNCE_MS, VERSION } from './config.js';

(window._oko = window._oko || {}).app = 'a5e7';

export class App {
  constructor() {
    this.api = new ApiClient();
    this.notifications = new NotificationManager();
    this.grid = new CameraGrid(document.getElementById('grid'), this.api);

    // DOM refs
    this._onlineEl = document.getElementById('count-online');
    this._offlineEl = document.getElementById('count-offline');
    this._bandwidthEl = document.getElementById('bandwidth');
    this._clockEl = document.getElementById('clock');
    this._searchInput = document.getElementById('search');
    this._searchClear = document.getElementById('search-clear');
    this._kbdHint = document.getElementById('kbd-hint');
    this._kbdHintTimer = null;
  }

  /** Start the application. */
  async start() {
    // Log version and file hashes
    const mods = Object.entries(window._oko || {}).map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(`%c[oko] v${VERSION}%c ${mods}`, 'color: #00d4aa; font-weight: bold', 'color: inherit');

    // Load UI config from backend (oko.yaml)
    this._uiConfig = await this.api.getUiConfig().catch(() => null) || {};
    this._applyUiConfig();

    this.notifications.requestPermission();

    // Detect H.265 support early (cached for lifetime)
    const h265rtc = CamPlayer.h265WebRTCSupported;
    const h265mse = CamPlayer.h265MSESupported;
    const needsTranscode = CamPlayer.needsH265Transcode;
    console.log(`[app] H.265: WebRTC=${h265rtc}, MSE=${h265mse}, needsTranscode=${needsTranscode}`);
    if (h265rtc) {
      document.getElementById('h265-sep').style.display = '';
      document.getElementById('h265-badge').style.display = '';
    }
    this._bindGridCallbacks();
    this._bindControls();
    this._bindKeyboard();
    this._bindPageUnload();
    this._startClock();

    // cleanup stale playback streams from previous session
    await this.api.cleanupPlaybacks().catch(() => {});

    await this._loadCameras();

    // Sync camera list periodically (detects oko.yaml hot reload)
    const syncMs = this._uiConfig.sync_interval || 15000;
    this._syncInterval = setInterval(() => this._syncCameras(), syncMs);

    // Server stats to devtools console
    this._logServerStats(); // first call immediately
    this._statsInterval = setInterval(() => this._logServerStats(), 10000);
  }

  /** Fetch and log server stats to browser console. */
  async _logServerStats() {
    try {
      const s = await this.api.getStats();
      if (!s) { console.warn('[server] stats: null response'); return; }
      if (s.error) { console.warn('[server] stats error:', s.error); return; }

      const st = s.streams;
      const sys = s.system;

      // NVR: "ТСЖ(✓32/32) Дача(✗0/16)"
      const nvrParts = s.nvrs.map(n => {
        const icon = n.status === 'online' ? '✓' : n.status === 'offline' ? '✗' : '?';
        return `${n.name}(${icon}${n.streams}/${n.cameras})`;
      });

      // Session streams: "__hd_M2[1→1]"
      const activeParts = (s.active || [])
        .map(a => `${a.name}[${a.producers}→${a.consumers}]`)
        .join(' ');

      console.log(
        `%c[server]%c ` +
        `cpu:${sys.host_cpu || '?'} load:${sys.load} mem:${sys.host_mem} | ` +
        `backend: cpu=${sys.backend_cpu} rss=${sys.backend_rss} heap=${sys.backend_heap} up=${sys.uptime} | ` +
        `streams: ${st.sd}sd ${st.hd}hd ${st.playback}pb ${st.transcode}tc | ` +
        `NVR: ${nvrParts.join(' ')}` +
        (activeParts ? ` | ${activeParts}` : ''),
        'color: #00d4aa; font-weight: bold',
        'color: inherit'
      );
    } catch (err) {
      console.warn('[server] stats failed:', err.message);
    }
  }

  /** Apply UI settings from oko.yaml. localStorage overrides config. */
  _applyUiConfig() {
    const c = this._uiConfig;

    // Title
    if (c.title) {
      document.querySelector('.header-left h1').textContent = c.title;
      document.title = c.title;
    }

    // Theme: localStorage overrides config
    const storedTheme = localStorage.getItem('theme');
    const theme = storedTheme || c.theme || 'dark';
    if (theme === 'light') {
      document.body.classList.add('light-theme');
    }

    // Compact: localStorage overrides config
    const storedCompact = localStorage.getItem('compact');
    const compact = storedCompact !== null ? storedCompact === '1' : (c.compact || false);
    if (compact) {
      document.body.classList.add('compact-mode');
    }

    // Default grid
    if (c.default_grid) {
      const btn = document.querySelector(`.grid-btn[data-cols="${c.default_grid}"]`);
      if (btn) {
        document.querySelectorAll('.grid-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.grid.gridEl.className = `grid cols-${c.default_grid}`;
        this.grid.autoFit = (c.default_grid === 'auto');
      }
    }

    // Store intervals for grid.js
    window.__okoConfig = {
      stagger_ms: c.stagger_ms || 500,
      bitrate_interval: c.bitrate_interval || 5000,
    };
  }

  /** Sync UI config changes from hot reload (only updates what changed). */
  _syncUiConfig(newUi) {
    const old = this._uiConfig;

    // Title
    if (newUi.title && newUi.title !== old.title) {
      document.querySelector('.header-left h1').textContent = newUi.title;
      document.title = newUi.title;
    }

    // Update stored config
    this._uiConfig = newUi;
    window.__okoConfig = {
      stagger_ms: newUi.stagger_ms || 500,
      bitrate_interval: newUi.bitrate_interval || 5000,
    };
  }

  /** Apply NVR health status to cameras and NVR buttons. */
  _applyNvrHealth(statuses) {
    if (!statuses || statuses.length === 0) return;

    // Combine: backend offline + frontend circuit breaker
    const backendOffline = new Set();
    for (const s of statuses) {
      if (s.status === 'offline') backendOffline.add(s.name);
    }

    // Frontend CB offline = groups disabled by connection error detection
    const frontendOffline = this._frontendOfflineNvrs || new Set();

    // Clear frontend CB for groups that backend says are online
    // (TCP is up → let cameras try again; they'll re-trigger CB if RTSP still fails)
    for (const group of [...frontendOffline]) {
      if (!backendOffline.has(group)) {
        console.log(`[app] NVR "${group}": backend says online, clearing frontend circuit breaker`);
        frontendOffline.delete(group);
      }
    }
    this._frontendOfflineNvrs = frontendOffline;

    // Merged: offline if EITHER backend or frontend says so
    const offlineNvrs = new Set([...backendOffline, ...frontendOffline]);

    const wasOffline = this._offlineNvrs || new Set();
    this._offlineNvrs = offlineNvrs;

    // Update NVR buttons
    for (const s of statuses) {
      const btn = document.querySelector(`.group-btn[data-group="${s.name}"]`);
      if (btn) {
        const isOff = offlineNvrs.has(s.name);
        btn.classList.toggle('nvr-offline', isOff);
        if (isOff) {
          const source = backendOffline.has(s.name) ? 'health check' : 'stream errors';
          btn.title = `${s.name} — OFFLINE (${source})`;
        } else {
          btn.title = `Show only ${s.name} cameras (click again to show all)`;
        }
      }
    }

    // Cameras in offline NVRs: force-stop on EVERY cycle. Online: staggered restart.
    const toRestart = [];

    for (const cam of this.grid.cameras) {
      const isOffline = offlineNvrs.has(cam.group);
      const wasOff = wasOffline.has(cam.group);

      if (isOffline) {
        // Force-stop every cycle — catches cameras that started retrying
        cam.el.classList.add('nvr-offline');
        cam.disable();
        cam._showLoading('nvr offline');
      } else if (!isOffline && wasOff) {
        // NVR came back — queue for staggered restart
        cam.el.classList.remove('nvr-offline');
        toRestart.push(cam);
      } else if (!isOffline && !cam.player.connected && cam.player.enabled
        && !cam.el.classList.contains('hidden')
        && !cam.el.classList.contains('playback-mode')
        && !cam.isHd) {
        // Stuck camera: enabled but not connected, NVR is online
        // Skip cameras in playback/HD mode — their SD player is intentionally stopped
        toRestart.push(cam);
      }
    }

    // Update header counters
    this.grid._updateStats();

    // Staggered restart to avoid NVR overload
    if (toRestart.length > 0) {
      const staggerMs = window.__okoConfig?.stagger_ms || 500;
      console.log(`[app] NVR recovery: restarting ${toRestart.length} cameras (stagger ${staggerMs}ms)`);
      toRestart.forEach((cam, i) => {
        setTimeout(() => {
          if (cam.player.connected) return; // connected in the meantime
          console.log(`[app] ${cam.id}: restarting (${i + 1}/${toRestart.length})`);
          cam.player.stop();
          cam.start();
        }, i * staggerMs);
      });
    }
  }

  // ── Camera loading ──

  async _loadCameras() {
    let configs = [];
    try {
      configs = await this.api.getCameras();
    } catch (err) {
      console.error('Failed to load cameras:', err);
      document.getElementById('grid').innerHTML =
        '<div style="padding:40px;text-align:center;color:var(--text-dim);font-family:var(--mono)">'
        + 'No cameras found. Check backend connection.</div>';
      return;
    }

    this.grid.build(configs);
    this._updateGridButtons(configs.length);

    // wire notification on offline
    for (const cam of this.grid.cameras) {
      const originalHandler = cam.onStatusChange;
      cam.onStatusChange = (camera, online) => {
        if (originalHandler) originalHandler(camera, online);
        if (!online && camera.isEnabled) {
          this.notifications.cameraOffline(camera.id, camera.label);
        }
      };
    }

    // delay to let go2rtc finish RTSP probes triggered by /api/streams
    await new Promise(r => setTimeout(r, 500));

    this.grid.applyFilters();

    // Set keyboard focus on first camera
    this.grid._setFocus(0);

    // Ensure page has keyboard focus (delay for browser render)
    document.body.tabIndex = -1;
    setTimeout(() => document.body.focus(), 100);

    // handle URL hash: open camera, optionally start playback
    const hashResult = this.grid.openFromHash();
    if (hashResult?.playbackTime) {
      const { cam, playbackTime, resolution } = hashResult;
      // wait for camera to connect, then start playback
      setTimeout(async () => {
        const seekTime = new Date(playbackTime);
        const endOfDay = new Date(seekTime);
        endOfDay.setHours(23, 59, 59, 0);
        const pad = (n) => String(n).padStart(2, '0');
        const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        await this._startPlayback(cam, fmt(seekTime), fmt(endOfDay), resolution);
      }, 1500);
    }
  }

  /** Periodically check if camera list changed (oko.yaml hot reload). */
  async _syncCameras() {
    try {
      // Sync UI config
      const newUi = await this.api.getUiConfig().catch(() => null);
      if (newUi) this._syncUiConfig(newUi);

      // Sync NVR health
      const nvrHealth = await this.api.getNvrHealth().catch(() => []);
      this._applyNvrHealth(nvrHealth);

      const configs = await this.api.getCameras();

      // Compare sorted ID lists — only rebuild if cameras added/removed
      const newKey = configs.map(c => c.id).sort().join(',');
      const oldKey = this.grid.cameras.map(c => c.id).sort().join(',');

      if (newKey === oldKey) {
        // IDs same — just update has_audio and codec without rebuild
        const metaMap = new Map(configs.map(c => [c.id, c]));
        for (const cam of this.grid.cameras) {
          const meta = metaMap.get(cam.id);
          if (!meta) continue;
          if (meta.has_audio !== cam.hasAudio) {
            cam.hasAudio = meta.has_audio;
            cam._audioIcon.classList.toggle('has-audio', meta.has_audio);
          }
          if (meta.codec && meta.codec !== cam.codec) {
            cam.codec = meta.codec;
          }
        }
        return;
      }

      console.log(`Camera list changed: ${oldKey.split(',').length} → ${newKey.split(',').length}`);

      // Remember fullscreen and HD states
      const fsId = this.grid.fullscreenCamera?.id;

      // Rebuild grid
      this.grid.build(configs);
      this._updateGridButtons(configs.length);

      // Re-wire notification handlers
      for (const cam of this.grid.cameras) {
        const originalHandler = cam.onStatusChange;
        cam.onStatusChange = (camera, online) => {
          if (originalHandler) originalHandler(camera, online);
          if (!online && camera.isEnabled) {
            this.notifications.cameraOffline(camera.id, camera.label);
          }
        };
      }

      this.grid.applyFilters();

      // Restore fullscreen if camera still exists
      if (fsId) {
        const cam = this.grid.cameras.find(c => c.id === fsId);
        if (cam) this.grid.enterFullscreen(cam);
      }
    } catch {}
  }

  // ── Grid callbacks ──

  _bindGridCallbacks() {
    this.grid.onStatsChange = (online, offline) => {
      this._onlineEl.textContent = online;
      this._offlineEl.textContent = offline;
    };

    this.grid.onBandwidthUpdate = (totalKbps) => {
      if (totalKbps >= 1000) {
        this._bandwidthEl.textContent = `${(totalKbps / 1000).toFixed(1)} Mbps`;
      } else {
        this._bandwidthEl.textContent = `${totalKbps} kbps`;
      }
    };

    this.grid.onGroupsDiscovered = (groups) => {
      this._buildGroupButtons(groups);
    };

    this.grid.onPlaybackRequest = (cam, start, end, resolution) => {
      this._startPlayback(cam, start, end, resolution);
    };

    this.grid.onLiveRequest = (cam) => {
      this._stopPlayback(cam);
    };

    this.grid.onPlaybackSeek = (cam, seekTime) => {
      this._seekPlayback(cam, seekTime);
    };

    this.grid.onHdToggle = (cam, wantHd) => {
      this._toggleHd(cam, wantHd);
    };

    this.grid.onNeedTranscode = async (cam) => {
      try {
        console.log(`[app] ${cam.id}: requesting H.265→H.264 transcode`);
        const result = await this.api.createTranscodeStream(cam.id);
        cam.switchToStream(result.stream);
        this._showHint(`${cam.id} → transcoding H.264`);
      } catch (err) {
        console.error(`[app] Transcode failed for ${cam.id}:`, err);
      }
    };

    // Track connection errors per NVR group → frontend circuit breaker
    // Sliding window: store timestamps of each error, check multiple tiers
    this._groupErrorLog = {}; // { groupName: [timestamp, timestamp, ...] }

    this.grid.onConnectionError = (cam) => {
      const group = cam.group;
      if (!group) return;
      // Already tripped
      if (this._offlineNvrs && this._offlineNvrs.has(group)) return;

      const now = Date.now();
      if (!this._groupErrorLog[group]) this._groupErrorLog[group] = [];
      this._groupErrorLog[group].push(now);

      // Trim old entries (older than 60s)
      this._groupErrorLog[group] = this._groupErrorLog[group].filter(t => now - t < 60000);

      const errors = this._groupErrorLog[group];
      const last10s = errors.filter(t => now - t < 10000).length;
      const last15s = errors.filter(t => now - t < 15000).length;
      const last30s = errors.filter(t => now - t < 30000).length;

      // Multi-tier detection: trip on whichever fires first
      const tripped = (last10s >= 5) || (last15s >= 8) || (last30s >= 12);

      if (!tripped) {
        console.log(`[app] ${cam.id}: NVR "${group}" connection error (10s:${last10s} 15s:${last15s} 30s:${last30s})`);
        return;
      }

      console.log(`[app] NVR "${group}": circuit breaker tripped (10s:${last10s} 15s:${last15s} 30s:${last30s})`);
      this._groupErrorLog[group] = []; // reset

      // Mark group as frontend-offline (will be merged with backend health in _applyNvrHealth)
      if (!this._frontendOfflineNvrs) this._frontendOfflineNvrs = new Set();
      this._frontendOfflineNvrs.add(group);

      // Also update _offlineNvrs immediately so the force-stop loop works
      if (!this._offlineNvrs) this._offlineNvrs = new Set();
      this._offlineNvrs.add(group);

      for (const c of this.grid.cameras) {
        if (c.group === group) {
          c.el.classList.add('nvr-offline');
          c.disable();
          c._showLoading('nvr offline');
        }
      }

      // Update NVR button
      const btn = document.querySelector(`.group-btn[data-group="${group}"]`);
      if (btn) {
        btn.classList.add('nvr-offline');
        btn.title = `${group} — OFFLINE (detected from stream errors)`;
      }

      this.grid._updateStats();
    };
  }

  // ── Controls ──

  _bindControls() {
    // grid size buttons
    document.querySelectorAll('.grid-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.grid-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const cols = btn.dataset.cols;
        this.grid.autoFit = (cols === 'auto');
        this.grid.gridEl.className = `grid cols-${cols}`;
        if (cols === 'auto') this.grid._applyAutoFit();
      });
    });

    // filter buttons (all / online / offline)
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.grid.statusFilter = btn.dataset.filter;
        this.grid.applyFilters();
        this._markControlPending(btn);
      });
    });

    // search input (debounced)
    let searchTimer = null;
    this._searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        this.grid.searchQuery = this._searchInput.value.trim();
        this.grid.applyFilters();
      }, SEARCH_DEBOUNCE_MS);

      this._searchClear.classList.toggle('visible', this._searchInput.value.length > 0);
      this._markControlPending(this._searchInput);
    });

    // search clear button
    this._searchClear.addEventListener('click', () => {
      this._searchInput.value = '';
      this._searchClear.classList.remove('visible');
      this.grid.searchQuery = '';
      this.grid.applyFilters();
      this._clearControlPending();
    });

    // refresh button
    document.getElementById('refresh-btn').addEventListener('click', () => {
      this._clearControlPending();
      this.grid.refresh();
    });

    // theme toggle
    document.getElementById('theme-btn').addEventListener('click', () => {
      const isLight = document.body.classList.toggle('light-theme');
      localStorage.setItem('theme', isLight ? 'light' : 'dark');
    });

    // compact mode toggle
    document.getElementById('compact-btn').addEventListener('click', () => {
      const isCompact = document.body.classList.toggle('compact-mode');
      localStorage.setItem('compact', isCompact ? '1' : '0');
      if (isCompact) this._showHint('Compact ON — press C to exit');
      // Recalculate auto grid after layout change
      setTimeout(() => { if (this.grid.autoFit) this.grid._applyAutoFit(); }, 50);
    });
  }

  _buildGroupButtons(groups) {
    // Remove existing group buttons
    document.querySelectorAll('.group-btn, .group-sep, .group-label').forEach(el => el.remove());

    const controls = document.getElementById('controls');
    const searchWrap = document.querySelector('.search-wrap');

    const sep = document.createElement('div');
    sep.className = 'controls-sep group-sep';
    controls.insertBefore(sep, searchWrap);

    const label = document.createElement('span');
    label.className = 'controls-label group-label';
    label.textContent = 'NVR:';
    controls.insertBefore(label, searchWrap);

    for (const group of groups) {
      const btn = document.createElement('button');
      btn.className = 'ctrl-btn group-btn';
      btn.dataset.group = group;
      btn.textContent = group;
      btn.title = `Show only ${group} cameras (click again to show all)`;

      // Apply group color as button border
      const colorMap = this.grid._groupColorMap;
      if (colorMap && colorMap.has(group)) {
        const color = colorMap.get(group);
        btn.style.border = `1px solid ${color.bright}`;
        btn.style.color = color.bright;
      }

      btn.addEventListener('click', () => {
        const isActive = btn.classList.contains('active');
        // Reset all group buttons to outline style
        document.querySelectorAll('.group-btn').forEach(b => {
          b.classList.remove('active');
          b.style.background = '';
          const g = b.dataset.group;
          if (colorMap && colorMap.has(g)) {
            b.style.color = colorMap.get(g).bright;
          }
        });

        if (!isActive) {
          btn.classList.add('active');
          this.grid.groupFilter = group;
          // Fill with group color when active
          if (colorMap && colorMap.has(group)) {
            btn.style.background = colorMap.get(group).bright;
            btn.style.color = '#fff';
          }
        } else {
          this.grid.groupFilter = '';
        }
        this.grid.applyFilters();
      });

      controls.insertBefore(btn, searchWrap);
    }
  }

  // ── Control pending highlights ──

  /** Add/remove 8× and 10× grid buttons based on camera count. */
  _updateGridButtons(cameraCount) {
    const extra = [
      { cols: 8, min: 37, hotkey: 'Ctrl+5' },
      { cols: 10, min: 65, hotkey: 'Ctrl+6' },
    ];

    for (const { cols, min, hotkey } of extra) {
      const existing = document.querySelector(`.grid-btn[data-cols="${cols}"]`);
      if (cameraCount > min && !existing) {
        const btn = document.createElement('button');
        btn.className = 'ctrl-btn grid-btn';
        btn.dataset.cols = String(cols);
        btn.title = `${cols} cameras per row (${hotkey})`;
        btn.textContent = `${cols}×`;
        btn.addEventListener('click', () => {
          document.querySelectorAll('.grid-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.grid.autoFit = false;
          this.grid.gridEl.className = `grid cols-${cols}`;
        });
        // Insert after last grid-btn
        const lastBtn = [...document.querySelectorAll('.grid-btn')].pop();
        lastBtn.parentNode.insertBefore(btn, lastBtn.nextSibling);
      } else if (cameraCount <= min && existing) {
        existing.remove();
      }
    }
  }

  _markControlPending(changedEl) {
    changedEl.classList.add('pending');
    document.getElementById('refresh-btn').classList.add('pending');
  }

  _clearControlPending() {
    document.getElementById('controls').querySelectorAll('.pending').forEach(el => el.classList.remove('pending'));
  }

  // ── Keyboard shortcuts ──

  _bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      // ignore when typing in search
      if (e.target.tagName === 'INPUT') return;

      // Ctrl+` → auto grid
      if (e.ctrlKey && (e.key === '`' || e.key === '~')) {
        e.preventDefault();
        const btn = document.querySelector('.grid-btn-auto');
        if (btn) {
          btn.click();
          this._showHint('Grid Auto');
        }
        return;
      }

      // Ctrl+1-6 → grid size
      if (e.ctrlKey && e.key >= '1' && e.key <= '6') {
        e.preventDefault();
        const gridMap = { '1': 1, '2': 2, '3': 4, '4': 6, '5': 8, '6': 10 };
        const cols = gridMap[e.key];
        const btn = document.querySelector(`.grid-btn[data-cols="${cols}"]`);
        if (btn) {
          btn.click();
          this._showHint(`Grid ${cols}×`);
        }
        return;
      }

      // Esc → exit fullscreen
      if (e.key === 'Escape') {
        this.grid.exitFullscreen();
        return;
      }

      // R → refresh
      if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        this._clearControlPending();
        this.grid.refresh();
        this._showHint('Refreshed');
        return;
      }

      // C → compact mode (not Ctrl+C)
      if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey) {
        document.getElementById('compact-btn').click();
        if (!document.body.classList.contains('compact-mode')) {
          this._showHint('Compact OFF');
        }
        return;
      }

      // T → toggle theme
      if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey) {
        document.getElementById('theme-btn').click();
        return;
      }

      // M → mute/unmute
      if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey) {
        CameraView.globalMute = !CameraView.globalMute;
        const muted = CameraView.globalMute;

        if (muted) {
          // Mute all
          document.querySelectorAll('video').forEach(v => v.muted = true);
          this.grid.cameras.forEach(c => c._audioIcon.classList.remove('unmuted'));
          this._showHint('Muted all');
        } else {
          // Unmute only active camera (fullscreen or focused)
          const activeCam = this.grid.fullscreenCamera || this.grid.focusedCamera;
          if (activeCam && activeCam.hasAudio) {
            activeCam.video.muted = false;
            activeCam._audioIcon.classList.add('unmuted');
            this._showHint(`Unmuted ${activeCam.id}`);
          } else {
            this._showHint('Unmuted');
          }
        }
        return;
      }

      // F → native browser fullscreen (anywhere)
      if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        } else if (this.grid.fullscreenCamera) {
          this.grid.fullscreenCamera.el.requestFullscreen().catch(() => {});
        } else {
          document.documentElement.requestFullscreen().catch(() => {});
        }
        return;
      }

      // fullscreen-only shortcuts
      if (this.grid.fullscreenCamera) {
        if (e.key === 'ArrowRight') { e.preventDefault(); this.grid.navigateFullscreen(1); return; }
        if (e.key === 'ArrowLeft') { e.preventDefault(); this.grid.navigateFullscreen(-1); return; }
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.grid.exitFullscreen(); return; }
        if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey) {
          const cam = this.grid.fullscreenCamera;
          if (!cam.isPlayback) this._toggleHd(cam, !cam.isHd);
          return;
        }
        if ((e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.metaKey) {
          this.grid.fullscreenCamera.togglePlaybackPanel();
          return;
        }
        return; // don't process grid navigation while in fullscreen
      }

      // ── Grid keyboard navigation (no camera open) ──

      // Arrow keys → move focus
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        const dirMap = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
        this.grid.moveFocus(dirMap[e.key]);
        return;
      }

      // Enter / Space → open focused camera
      if ((e.key === 'Enter' || e.key === ' ') && this.grid.focusedCamera) {
        e.preventDefault();
        this.grid.openFocused();
        return;
      }

      // 1-9 → open camera by index
      const num = parseInt(e.key);
      if (num >= 1 && num <= 9) {
        this.grid.openByIndex(num - 1);
      }
    });
  }

  // ── HD Stream ──

  async _toggleHd(cam, wantHd) {
    if (wantHd) {
      try {
        console.log(`[app] ${cam.id}: HD stream requested`);
        const result = await this.api.createHdStream(cam.id);
        console.log(`[app] ${cam.id}: HD stream=${result.stream} codec=${result.codec} forceMSE=${result.forceMSE}`);
        cam.startHd(result.stream, result.forceMSE);
        this._showHint(`${cam.id} → HD`);
      } catch (err) {
        console.error(`[app] ${cam.id}: HD failed: ${err.message}`);
        this._showHint(`HD error: ${err.message}`);
      }
    } else {
      console.log(`[app] ${cam.id}: HD stream stopped`);
      await this.api.deleteHdStream(cam.id);
      cam.stopHd();
      this._showHint(`${cam.id} → SD`);
    }
  }

  // ── Playback ──

  async _startPlayback(cam, start, end, resolution = 'original') {
    try {
      if (cam.isPlayback) {
        await this.api.deletePlayback(cam.playbackStreamName);
        await new Promise(r => setTimeout(r, 300));
      }

      console.log(`[app] ${cam.id}: playback ${start} → ${end} (${resolution})`);
      const result = await this.api.createPlayback(cam.id, start, end, resolution);
      console.log(`[app] ${cam.id}: playback stream=${result.stream} codec=${result.codec} forceMSE=${result.forceMSE}`);
      cam.startPlayback(result.stream, new Date(start), new Date(end), result.forceMSE, resolution);
      this.grid.updatePlaybackHash();
      this._showHint(`Playback: ${cam.id} ${resolution !== 'original' ? resolution : ''}`);
    } catch (err) {
      console.error(`[app] ${cam.id}: playback failed: ${err.message}`);
      this._showHint(`Playback error: ${err.message}`);
    }
  }

  async _seekPlayback(cam, seekTime) {
    try {
      const resolution = cam.playbackResolution;

      if (cam.isPlayback) {
        await this.api.deletePlayback(cam.playbackStreamName);
        await new Promise(r => setTimeout(r, 300));
      }

      const endOfDay = new Date(seekTime);
      endOfDay.setHours(23, 59, 59, 0);

      const pad = (n) => String(n).padStart(2, '0');
      const fmtLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

      const result = await this.api.createPlayback(cam.id, fmtLocal(seekTime), fmtLocal(endOfDay), resolution);
      cam.startPlayback(result.stream, seekTime, endOfDay, result.forceMSE, resolution);
      this.grid.updatePlaybackHash();

      const timeStr = `${pad(seekTime.getHours())}:${pad(seekTime.getMinutes())}`;
      this._showHint(`Seek: ${cam.id} → ${timeStr}`);
    } catch (err) {
      console.error(`Seek failed for ${cam.id}:`, err);
      this._showHint(`Seek error: ${err.message}`);
    }
  }

  async _stopPlayback(cam) {
    if (cam.isPlayback) {
      const streamName = cam.playbackStreamName;
      cam.stopPlayback();
      await this.api.deletePlayback(streamName).catch(() => {});
      this.grid.updatePlaybackHash();
      this._showHint(`${cam.id} → Live`);
    }
  }

  /** Cleanup all playback streams on page unload. */
  _bindPageUnload() {
    // Clean up HD/playback/transcode streams on tab close
    const cleanup = () => navigator.sendBeacon?.('/backend/cleanup-session', '');

    window.addEventListener('beforeunload', cleanup);
    // pagehide fires more reliably on mobile than beforeunload
    window.addEventListener('pagehide', cleanup);
  }

  // ── Clock ──

  _startClock() {
    const update = () => {
      const now = new Date();
      this._clockEl.textContent =
        now.toLocaleDateString('en-GB') + ' ' + now.toLocaleTimeString('en-GB');
    };
    update();
    setInterval(update, 1000);
  }

  // ── Keyboard hint ──

  _showHint(text) {
    this._kbdHint.innerHTML = text;
    this._kbdHint.classList.add('show');
    clearTimeout(this._kbdHintTimer);
    this._kbdHintTimer = setTimeout(() => {
      this._kbdHint.classList.remove('show');
    }, 3000);
  }
}
