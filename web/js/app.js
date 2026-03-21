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

(window._oko = window._oko || {}).app = 'a7a4';

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

    // Log config from server
    const sc = this._uiConfig;
    console.log(`[config] title="${sc.title}" snapshots=${sc.snapshots_enabled !== false} mse_cache_ttl=${sc.mse_cache_ttl ?? 60}s force_mse=${!!sc.playback_force_mse}`);

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

    // Expose debug helpers to devtools: window._okoDebug.snapshots() / .mseCache()
    window._okoDebug = {
      snapshots: () => {
        const cams = this.grid.cameras;
        const rows = cams.map(c => {
          const snap = c.el.querySelector('.cam-snapshot');
          return {
            id: c.id,
            hasElement: !!snap,
            loaded: snap?.classList.contains('loaded') ?? false,
            hidden: snap?.style.display === 'none',
            src: snap?.src?.replace(location.origin, '') || '—',
            size: snap ? `${snap.naturalWidth}×${snap.naturalHeight}` : '—',
          };
        });
        console.table(rows);
        const active = rows.filter(r => r.hasElement && !r.hidden).length;
        const loaded = rows.filter(r => r.loaded).length;
        console.log(`[snapshot] ${active} active, ${loaded} faded (video playing), ${rows.length - active} disabled/hidden`);
        return rows;
      },
      mseCache: () => {
        const entries = Array.from(CamPlayer._mseCache.entries()).map(([id, ts]) => ({
          camera: id,
          age: `${Math.round((Date.now() - ts) / 1000)}s`,
          expires: `${Math.max(0, Math.round((ts + CamPlayer.MSE_CACHE_TTL - Date.now()) / 1000))}s`,
        }));
        console.table(entries);
        console.log(`[mse-cache] ${entries.length} entries, TTL=${CamPlayer.MSE_CACHE_TTL / 1000}s`);
        return entries;
      },
      config: () => {
        console.log('[config]', window.__okoConfig);
        return window.__okoConfig;
      },
    };
    console.log(`[app] Debug: window._okoDebug.snapshots() / .mseCache() / .config()`);

    // Sync camera list periodically (detects oko.yaml hot reload)
    const syncMs = this._uiConfig.sync_interval || 15000;
    this._syncInterval = setInterval(() => this._syncCameras(), syncMs);

    // Server stats to devtools console
    this._logServerStats(); // first call immediately
    this._statsInterval = setInterval(() => this._logServerStats(), 10000);

    // Also poll activities more frequently during startup (every 3s for first 2 minutes)
    this._activityFastPoll = setInterval(() => this._pollActivities(), 3000);
    setTimeout(() => clearInterval(this._activityFastPoll), 120000);
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

    // Poll server activities
    this._pollActivities();
  }

  async _pollActivities() {
    try {
      const h = await this.api.health();
      const acts = h.activities || {};
      const bar = document.getElementById('server-activity');
      if (!bar) return;

      const keys = Object.keys(acts);
      if (keys.length === 0) {
        bar.classList.remove('visible');
        bar.innerHTML = '';
        return;
      }

      bar.innerHTML = keys.map(name => {
        const a = acts[name];
        const progress = a.progress ? `<span class="activity-progress">${a.progress}</span>` : '';
        const elapsed = a.elapsed > 2 ? `<span class="activity-elapsed">${a.elapsed}s</span>` : '';
        return `<div class="server-activity-item">
          <div class="activity-spinner"></div>
          <span>${a.status}</span>
          ${progress}${elapsed}
        </div>`;
      }).join('');
      bar.classList.add('visible');
    } catch {}
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
        this.grid.setColumns(c.default_grid);
        this.grid.autoFit = (c.default_grid === 'auto');
      }
    }

    // Store intervals for grid.js
    window.__okoConfig = {
      stagger_ms: c.stagger_ms || 500,
      bitrate_interval: c.bitrate_interval || 5000,
      snapshots_enabled: c.snapshots_enabled !== false,
      mse_cache_ttl: (c.mse_cache_ttl || 60) * 1000,
    };

    // Apply MSE cache TTL from server config
    if (c.mse_cache_ttl != null) {
      CamPlayer.MSE_CACHE_TTL = c.mse_cache_ttl * 1000;
    }

    // Global force MSE — disables WebRTC entirely
    CamPlayer.globalForceMSE = !!c.playback_force_mse;
  }

  /** Sync UI config changes from hot reload (only updates what changed). */
  _syncUiConfig(newUi) {
    const old = this._uiConfig;

    // Title
    if (newUi.title && newUi.title !== old.title) {
      document.querySelector('.header-left h1').textContent = newUi.title;
      document.title = newUi.title;
    }

    // MSE cache TTL
    if (newUi.mse_cache_ttl != null) {
      CamPlayer.MSE_CACHE_TTL = newUi.mse_cache_ttl * 1000;
    }

    // Update stored config
    this._uiConfig = newUi;
    window.__okoConfig = {
      stagger_ms: newUi.stagger_ms || 500,
      bitrate_interval: newUi.bitrate_interval || 5000,
      snapshots_enabled: newUi.snapshots_enabled !== false,
      mse_cache_ttl: (newUi.mse_cache_ttl || 60) * 1000,
    };

    // Global force MSE — hot-reloadable
    CamPlayer.globalForceMSE = !!newUi.playback_force_mse;
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
        const dot = btn.querySelector('.nvr-dot');
        const countEl = btn.querySelector('.nvr-count');
        if (dot) dot.style.background = isOff ? 'var(--danger)' : '';
        if (isOff) {
          const source = backendOffline.has(s.name) ? 'health check' : 'stream errors';
          btn.title = `${s.name} — OFFLINE (${source})`;
          if (countEl) {
            const total = this.grid.cameras.filter(c => c.group === s.name).length;
            countEl.textContent = `0/${total}`;
          }
        } else {
          btn.title = `Show only ${s.name} cameras (click again to show all)`;
          if (countEl) {
            const online = this.grid.cameras.filter(c => c.group === s.name && c.isConnected).length;
            countEl.textContent = String(online);
          }
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
        && !cam.isHd
        && !cam.player.isInMseQueue   // waiting for MSE slot — not stuck
        && !CamPlayer._msePool.active.has(cam.player)  // connecting MSE — not stuck
        && !cam.player._retryTimer) {  // has pending retry — not stuck
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
        + 'Cannot reach backend. Check connection.</div>';
      return;
    }

    if (configs.length === 0) {
      document.getElementById('grid').innerHTML =
        '<div style="padding:40px;text-align:center;color:var(--text-dim);font-family:var(--mono)">'
        + 'No cameras found. Waiting for NVR discovery...<br>'
        + '<span style="font-size:10px;opacity:0.5">Will auto-refresh when cameras appear</span></div>';
      // Retry in 10s — NVR might still be booting
      setTimeout(() => this._loadCameras(), 10000);
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
        // Deep link: no prior user interaction → pause and wait for click to unmute
        cam.awaitUserPlay();
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
      // Investigation mode: sync start to all selected
      if (this.grid._investigationMode) {
        this._syncStartToSelected(cam, start, end, resolution);
      }
    };

    this.grid.onLiveRequest = (cam) => {
      this._stopPlayback(cam);
      // Investigation mode: sync LIVE to all selected
      if (this.grid._investigationMode) {
        this._syncLiveToSelected(cam);
      }
    };

    this.grid.onPlaybackSeek = (cam, seekTime) => {
      this._seekPlayback(cam, seekTime);
      // Investigation mode: sync seek to all selected
      if (this.grid._investigationMode) {
        this._syncSeekToSelected(cam, seekTime);
      }
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

    // Stream not found in go2rtc — debounced recovery
    this._streamRecoveryTimer = null;
    this._streamRecoveryPending = new Set();
    this._streamRecoveryCooldown = 0; // timestamp of last recovery
    this.grid.onStreamNotFound = (cam) => {
      // Cooldown: ignore if recovery happened within last 30s
      if (Date.now() - this._streamRecoveryCooldown < 30000) return;

      this._streamRecoveryPending.add(cam.id);

      // Debounce: wait 2s for all cameras to report, then recover once
      if (this._streamRecoveryTimer) clearTimeout(this._streamRecoveryTimer);
      this._streamRecoveryTimer = setTimeout(() => this._recoverStreams(), 2000);
    };

    // Archive pause: destroy stream, keep freeze frame
    this.grid.onPlaybackPause = async (cam) => {
      if (!cam.isPlayback) return;
      const streamName = cam.playbackStreamName;
      console.log(`[app] ${cam.id}: archive paused at ${cam._pausedPosition?.toLocaleTimeString()}, destroying ${streamName}`);
      if (cam._playbackPlayer) {
        cam._playbackPlayer.disable(); // img overlay covers video — safe to fully reset
        cam._playbackPlayer = null;
      }
      cam._playbackStream = null;
      await this.api.deletePlayback(streamName).catch(() => {});
      // Investigation mode: sync pause to all selected
      if (this.grid._investigationMode) {
        this._syncPauseToSelected(cam);
      }
    };

    // Archive resume: seek to saved position
    this.grid.onPlaybackResume = (cam, position) => {
      console.log(`[app] ${cam.id}: archive resume from ${position.toLocaleTimeString()}`);
      this._seekPlayback(cam, position);
      // Investigation mode: sync resume to all selected
      if (this.grid._investigationMode) {
        this._syncResumeToSelected(cam, position);
      }
    };

    // ── Investigation mode (multi-cam sync) ──

    this._selectedCams = new Set();

    this.grid.onSelect = (cam, selected) => {
      if (selected) {
        this._selectedCams.add(cam.id);
      } else {
        this._selectedCams.delete(cam.id);
      }
      this._updateSelectionBadge();
    };
  }

  _bindControls() {
    // grid size buttons
    document.querySelectorAll('.grid-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.grid-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const cols = btn.dataset.cols;
        this.grid.autoFit = (cols === 'auto');
        this.grid.setColumns(cols);
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
      const camCount = this.grid.cameras.filter(c => c.group === group).length;
      btn.innerHTML = `<span class="nvr-dot"></span><span class="nvr-name">${group}</span><span class="nvr-count">${camCount}</span>`;
      btn.title = `Show only ${group} cameras (click again to show all)`;

      // Apply group color as button border
      const colorMap = this.grid._groupColorMap;
      if (colorMap && colorMap.has(group)) {
        const color = colorMap.get(group);
        btn.style.border = `1px solid ${color.bright}`;
        btn.style.color = color.bright;
        btn.querySelector('.nvr-dot').style.background = color.bright;
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
          // Fill with group color when active
          if (colorMap && colorMap.has(group)) {
            btn.style.background = colorMap.get(group).bright;
            btn.style.color = '#fff';
          }
        }

        // Investigation mode: just toggle visibility of synced cameras (no stream start/stop)
        if (this.grid._investigationMode) {
          const filterGroup = isActive ? '' : group;
          for (const cam of this.grid.cameras) {
            if (cam.isSelected) {
              // synced camera: show/hide based on group filter
              const visible = !filterGroup || cam.group === filterGroup;
              cam.el.classList.toggle('inv-hidden', !visible);
            }
            // non-selected stay hidden
          }
          if (this.grid.autoFit) this.grid._applyAutoFit();
          return;
        }

        // Normal mode: full filter with stream start/stop
        this.grid.groupFilter = isActive ? '' : group;
        this.grid.applyFilters();
      });

      controls.insertBefore(btn, searchWrap);
    }
  }

  /** Update NVR button camera counts. In investigation mode: only synced cameras. */
  _updateGroupCounts() {
    document.querySelectorAll('.group-btn').forEach(btn => {
      const group = btn.dataset.group;
      const countEl = btn.querySelector('.nvr-count');
      if (!countEl) return;

      let count;
      if (this.grid._investigationMode) {
        count = this.grid.cameras.filter(c => c.group === group && c.isSelected).length;
      } else {
        count = this.grid.cameras.filter(c => c.group === group).length;
      }
      countEl.textContent = String(count);
    });
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
          this.grid.setColumns(cols);
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
      // ignore when typing in search or input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      // e.code = physical key (layout-independent, CapsLock-independent)
      const code = e.code;

      // Ctrl+Backquote → auto grid
      if (e.ctrlKey && code === 'Backquote') {
        e.preventDefault();
        const btn = document.querySelector('.grid-btn-auto');
        if (btn) {
          btn.click();
          this._showHint('Grid Auto');
        }
        return;
      }

      // Ctrl+1-6 → grid size
      if (e.ctrlKey && code >= 'Digit1' && code <= 'Digit6') {
        e.preventDefault();
        const gridMap = { Digit1: 1, Digit2: 2, Digit3: 4, Digit4: 6, Digit5: 8, Digit6: 10 };
        const cols = gridMap[code];
        const btn = document.querySelector(`.grid-btn[data-cols="${cols}"]`);
        if (btn) {
          btn.click();
          this._showHint(`Grid ${cols}×`);
        }
        return;
      }

      // Esc → exit fullscreen, then investigation mode
      if (code === 'Escape') {
        if (this.grid.fullscreenCamera) {
          this.grid.exitFullscreen();
        } else if (this.grid._investigationMode) {
          this._stopInvestigation();
        } else if (this._selectedCams.size > 0) {
          this._clearSelection();
        }
        return;
      }

      // R → refresh
      if (code === 'KeyR' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        this._clearControlPending();
        this.grid.refresh();
        this._showHint('Refreshed');
        return;
      }

      // C → compact mode (not Ctrl+C)
      if (code === 'KeyC' && !e.ctrlKey && !e.metaKey) {
        document.getElementById('compact-btn').click();
        if (!document.body.classList.contains('compact-mode')) {
          this._showHint('Compact OFF');
        }
        return;
      }

      // T → toggle theme
      if (code === 'KeyT' && !e.ctrlKey && !e.metaKey) {
        document.getElementById('theme-btn').click();
        return;
      }

      // M → mute/unmute
      if (code === 'KeyM' && !e.ctrlKey && !e.metaKey) {
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
      if (code === 'KeyF' && !e.ctrlKey && !e.metaKey) {
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
        const cam = this.grid.fullscreenCamera;

        // ←→ always navigate cameras
        if (code === 'ArrowRight') { e.preventDefault(); this.grid.navigateFullscreen(1); return; }
        if (code === 'ArrowLeft') { e.preventDefault(); this.grid.navigateFullscreen(-1); return; }

        // J/K = seek ±30s (archive), Shift+J/K = ±5m, J from LIVE → start archive
        if ((code === 'KeyJ' || code === 'KeyK') && !e.ctrlKey) {
          e.preventDefault();
          const isBack = code === 'KeyJ';
          const delta = e.shiftKey ? 300000 : 30000;

          if (cam.isPlayback) {
            const pos = cam.playbackPosition;
            if (pos) {
              const seekTime = new Date(pos.getTime() + (isBack ? -delta : delta));
              this._seekPlayback(cam, seekTime);
              if (this.grid._investigationMode) this._syncSeekToSelected(cam, seekTime);
              this._showHint(`${isBack ? '-' : '+'}${e.shiftKey ? '5m' : '30s'}`);
            }
          } else {
            // LIVE → start archive at now - delta
            const seekTime = new Date(Date.now() - delta);
            const pad = (n) => String(n).padStart(2, '0');
            const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
            const endOfDay = new Date(seekTime); endOfDay.setHours(23, 59, 59, 0);
            this._startPlayback(cam, fmt(seekTime), fmt(endOfDay), 'original');
            if (this.grid._investigationMode) this._syncStartToSelected(cam, fmt(seekTime), fmt(endOfDay), 'original');
            this._showHint(`Archive -${e.shiftKey ? '5m' : '30s'}`);
          }
          return;
        }

        if (code === 'Enter') { e.preventDefault(); this.grid.exitFullscreen(); return; }

        // Space = pause/resume
        if (code === 'Space') {
          e.preventDefault();
          cam.togglePause();
          return;
        }

        // ↑↓ volume
        if (code === 'ArrowUp' || code === 'ArrowDown') {
          e.preventDefault();
          const v = cam.video;
          v.volume = Math.max(0, Math.min(1, v.volume + (code === 'ArrowUp' ? 0.1 : -0.1)));
          if (v.muted && code === 'ArrowUp') { v.muted = false; cam._audioIcon.classList.add('unmuted'); }
          this._showHint(`Vol ${Math.round(v.volume * 100)}%`);
          return;
        }

        // L = toggle LIVE
        if (code === 'KeyL' && !e.ctrlKey) {
          if (cam.isPlayback) {
            this._stopPlayback(cam);
            if (this.grid._investigationMode) this._syncLiveToSelected(cam);
            this._showHint(`${cam.id} → LIVE`);
          } else {
            cam.togglePlaybackPanel();
          }
          return;
        }

        // H = HD toggle
        if (code === 'KeyH' && !e.ctrlKey && !e.metaKey) {
          if (!cam.isPlayback) this._toggleHd(cam, !cam.isHd);
          return;
        }

        // P = playback panel
        if (code === 'KeyP' && !e.ctrlKey && !e.metaKey) {
          cam.togglePlaybackPanel();
          return;
        }

        // Z = reset zoom
        if (code === 'KeyZ' && !e.ctrlKey) {
          cam._resetZoom();
          this._showHint('Zoom 1×');
          return;
        }

        // 1-4 = zoom presets
        if (!e.ctrlKey && !e.metaKey) {
          const zoomMap = { Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4 };
          if (zoomMap[code]) {
            const rect = cam.el.getBoundingClientRect();
            cam._setZoom(zoomMap[code], rect.width / 2, rect.height / 2);
            this._showHint(`Zoom ${zoomMap[code]}×`);
            return;
          }
        }

        // ? or / = keyboard help overlay
        if (code === 'Slash') {
          e.preventDefault();
          this._toggleKeyboardHelp();
          return;
        }

        return; // don't process grid navigation while in fullscreen
      }

      // ── Grid keyboard navigation (no camera open) ──

      // Arrow keys → move focus
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(code)) {
        e.preventDefault();
        const dirMap = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
        this.grid.moveFocus(dirMap[code]);
        return;
      }

      // Space → toggle selection on focused camera
      if (code === 'Space' && this.grid.focusedCamera) {
        e.preventDefault();
        this.grid.focusedCamera.toggleSelect();
        return;
      }

      // Enter → open focused camera
      if (code === 'Enter' && this.grid.focusedCamera) {
        e.preventDefault();
        this.grid.openFocused();
        return;
      }

      // 1-9 → open camera by index
      const digitMatch = code.match(/^Digit(\d)$/);
      if (digitMatch) {
        const num = parseInt(digitMatch[1]);
        if (num >= 1 && num <= 9) {
          this.grid.openByIndex(num - 1);
          return;
        }
      }

      // ? = keyboard help (global)
      if (code === 'Slash') {
        e.preventDefault();
        this._toggleKeyboardHelp();
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
      const fmtLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

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

  // ── Investigation mode ──

  _updateSelectionBadge() {
    document.querySelector('.selection-badge')?.remove();
    const count = this._selectedCams.size;
    if (count === 0) return;
    const controls = document.querySelector('.controls');
    if (!controls) return;
    const badge = document.createElement('div');
    badge.className = 'selection-badge';
    badge.innerHTML = `<span class="sel-count">${count} selected</span><button class="sel-start">Start</button><span class="sel-close">x</span>`;
    badge.querySelector('.sel-start').addEventListener('click', (e) => { e.stopPropagation(); this._startInvestigation(); });
    badge.querySelector('.sel-close').addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.grid._investigationMode) {
        this._stopInvestigation();
      } else {
        this._clearSelection();
      }
    });
    controls.appendChild(badge);
  }

  _startInvestigation() {
    if (this._selectedCams.size === 0) return;
    const selectedIds = [...this._selectedCams];
    console.log(`[investigation] Starting with ${selectedIds.length} cameras: ${selectedIds.join(', ')}`);

    // Stop all non-selected cameras: kill HD/playback streams on backend, then disable
    let hdCleaned = 0, pbCleaned = 0;
    for (const cam of this.grid.cameras) {
      if (!cam.isSelected) {
        // Clean up backend streams before disabling
        if (cam._hdStream) {
          this.api.deleteHdStream(cam.id).catch(() => {});
          hdCleaned++;
        }
        if (cam.isPlayback) {
          this.api.deletePlayback(cam.playbackStreamName).catch(() => {});
          pbCleaned++;
        }
        if (cam.player.enabled) cam.disable();
      }
    }
    if (hdCleaned || pbCleaned) {
      console.log(`[investigation] Cleaned ${hdCleaned} HD + ${pbCleaned} playback streams`);
    }

    this.grid.enterInvestigationMode();
    const startBtn = document.querySelector('.selection-badge .sel-start');
    if (startBtn) startBtn.remove();
    const countEl = document.querySelector('.selection-badge .sel-count');
    if (countEl) countEl.textContent = `${this._selectedCams.size} synced`;

    // Update NVR button counts to show only synced cameras
    this._updateGroupCounts();

    // Reset active group filter (investigation shows its own set)
    this.grid.groupFilter = '';
    document.querySelectorAll('.group-btn').forEach(b => {
      b.classList.remove('active');
      b.style.background = '';
      const g = b.dataset.group;
      const colorMap = this.grid._groupColorMap;
      if (colorMap && colorMap.has(g)) {
        b.style.color = colorMap.get(g).bright;
      }
    });

    // Sync playback state from first selected camera to all others
    const selected = this.grid.selectedCameras;
    const leader = selected[0];
    if (!leader) return;

    if (leader.isPlayback) {
      // Leader in archive → sync all others to same time
      const pos = leader.playbackPosition;
      if (pos) {
        const resolution = leader.playbackResolution;
        const pad = (n) => String(n).padStart(2, '0');
        const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        const endOfDay = new Date(pos);
        endOfDay.setHours(23, 59, 59, 0);
        for (const cam of selected) {
          if (cam === leader) continue;
          if (cam.isPlayback) {
            // Already in archive → seek to leader's time
            this._seekPlayback(cam, pos);
          } else {
            // In LIVE → start archive at leader's time
            this._startPlayback(cam, fmt(pos), fmt(endOfDay), resolution);
          }
        }
        this._showHint(`Investigation: ${selected.length} cameras synced to archive`);
        console.log(`[investigation] Synced ${selected.length - 1} cameras to archive at ${pos.toLocaleTimeString()}`);
      }
    } else {
      // Leader in LIVE → stop archive on all others
      for (const cam of selected) {
        if (cam === leader) continue;
        if (cam.isPlayback) {
          this._stopPlayback(cam);
        }
      }
      this._showHint(`Investigation: ${selected.length} cameras synced to LIVE`);
      console.log(`[investigation] Synced ${selected.length} cameras to LIVE`);
    }
  }

  _stopInvestigation() {
    const syncedIds = this.grid.selectedCameras.map(c => c.id);
    console.log(`[investigation] Stopping. Cameras were: ${syncedIds.join(', ')}`);
    // 1. Kill all active streams: playback + SD + HD on every camera
    for (const cam of this.grid.cameras) {
      if (cam._hdStream) this.api.deleteHdStream(cam.id).catch(() => {});
      if (cam.isPlayback || cam._pausedPosition) this._stopPlayback(cam);
      cam.disable();
    }
    // 2. Exit investigation mode (unhide all, clear selection)
    this.grid.exitInvestigationMode();
    this._selectedCams.clear();
    document.querySelector('.selection-badge')?.remove();

    // 3. Reset group filter and restore full counts
    this.grid.groupFilter = '';
    document.querySelectorAll('.group-btn').forEach(b => {
      b.classList.remove('active');
      b.style.background = '';
      const g = b.dataset.group;
      const colorMap = this.grid._groupColorMap;
      if (colorMap && colorMap.has(g)) {
        b.style.color = colorMap.get(g).bright;
      }
    });
    this._updateGroupCounts();

    // 4. Restore grid button highlighting
    const activeColsClass = [...this.grid.gridEl.classList].find(c => c.startsWith('cols-'));
    document.querySelectorAll('.grid-btn').forEach(b => {
      const match = activeColsClass === `cols-${b.dataset.cols}` ||
        (activeColsClass === 'cols-auto' && b.classList.contains('grid-btn-auto'));
      b.classList.toggle('active', match);
    });

    // 5. Restart all cameras with staggered start
    this.grid.applyFilters();
    this._showHint('Investigation ended');
  }

  _clearSelection() {
    this._selectedCams.clear();
    this.grid.clearSelection();
    document.querySelector('.selection-badge')?.remove();
  }

  _syncStartToSelected(sourceCam, start, end, resolution) {
    const targets = this.grid.selectedCameras.filter(c => c !== sourceCam);
    console.log(`[investigation] Sync archive start from ${sourceCam.id} → ${targets.map(c => c.id).join(', ')}`);
    for (const cam of targets) {
      if (cam.isPlayback) {
        this._seekPlayback(cam, new Date(start));
      } else {
        this._startPlayback(cam, start, end, resolution);
      }
    }
  }

  _syncLiveToSelected(sourceCam) {
    const targets = this.grid.selectedCameras.filter(c => c !== sourceCam && (c.isPlayback || c._pausedPosition));
    if (targets.length === 0) return;
    console.log(`[investigation] Sync LIVE from ${sourceCam.id} → ${targets.map(c => c.id).join(', ')}`);
    for (const cam of targets) {
      this._stopPlayback(cam);
    }
  }

  _syncSeekToSelected(sourceCam, seekTime) {
    const targets = this.grid.selectedCameras.filter(c => c !== sourceCam);
    console.log(`[investigation] Sync seek ${seekTime.toLocaleTimeString()} from ${sourceCam.id} → ${targets.map(c => c.id).join(', ')}`);
    for (const cam of targets) {
      if (cam.isPlayback || cam._pausedPosition) {
        this._seekPlayback(cam, seekTime);
      } else {
        const pad = (n) => String(n).padStart(2, '0');
        const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        const endOfDay = new Date(seekTime);
        endOfDay.setHours(23, 59, 59, 0);
        const resolution = sourceCam.playbackResolution || 'original';
        this._startPlayback(cam, fmt(seekTime), fmt(endOfDay), resolution);
      }
    }
  }

  async _syncPauseToSelected(sourceCam) {
    const position = sourceCam._pausedPosition;
    const targets = this.grid.selectedCameras.filter(c => c !== sourceCam && c.isPlayback);
    if (targets.length === 0) return;
    console.log(`[investigation] Sync pause from ${sourceCam.id} → ${targets.map(c => c.id).join(', ')}`);
    for (const cam of targets) {
      cam._captureFrame();          // capture BEFORE pause
      cam.video.pause();
      cam.stopPlaybackTimer();
      cam.el.classList.add('paused');
      cam._showPauseIndicator('pause');
      const hasFreezeFrame = cam.el.querySelector('.cam-freeze')?.classList.contains('visible');
      if (hasFreezeFrame) {
        cam._pausedPosition = position ? new Date(position) : cam.playbackPosition;
        const streamName = cam.playbackStreamName;
        if (cam._playbackPlayer) {
          cam._playbackPlayer.disable();
          cam._playbackPlayer = null;
        }
        cam._playbackStream = null;
        await this.api.deletePlayback(streamName).catch(() => {});
      }
    }
  }

  _syncResumeToSelected(sourceCam, position) {
    const targets = this.grid.selectedCameras.filter(c => c !== sourceCam && c._pausedPosition);
    if (targets.length === 0) return;
    console.log(`[investigation] Sync resume from ${sourceCam.id} at ${position.toLocaleTimeString()} → ${targets.map(c => c.id).join(', ')}`);
    for (const cam of targets) {
      cam.el.classList.remove('paused');
      cam._showPauseIndicator('play');
      cam._pausedPosition = null;
      this._seekPlayback(cam, position);
    }
  }

  /** Recover lost go2rtc streams and restart affected cameras. */
  async _recoverStreams() {
    const pending = this._streamRecoveryPending;
    this._streamRecoveryPending = new Set();
    this._streamRecoveryTimer = null;

    // Set cooldown immediately to block re-entry
    this._streamRecoveryCooldown = Date.now();

    console.log(`[recovery] ${pending.size} cameras lost streams, triggering go2rtc recovery (cooldown 30s)...`);

    try {
      const result = await this.api.recoverStreams();
      console.log(`[recovery] Backend re-registered ${result.cameras} streams`);
    } catch (e) {
      console.warn(`[recovery] Backend recovery failed: ${e.message}`);
      return; // don't restart cameras if backend failed
    }

    // Wait for go2rtc to connect to NVR, then restart affected cameras
    await new Promise(r => setTimeout(r, 3000));

    let restarted = 0;
    for (const cam of this.grid.cameras) {
      if (pending.has(cam.id) && !cam.isPlayback) {
        cam.player.start();
        restarted++;
        await new Promise(r => setTimeout(r, 200));
      }
    }
    console.log(`[recovery] Restarted ${restarted} cameras (next recovery available in ${Math.round((30000 - (Date.now() - this._streamRecoveryCooldown)) / 1000)}s)`);
  }

  /** Toggle keyboard shortcuts help overlay. */
  _toggleKeyboardHelp() {
    let overlay = document.getElementById('kbd-help-overlay');
    if (overlay) { overlay.remove(); return; }

    overlay = document.createElement('div');
    overlay.id = 'kbd-help-overlay';
    const isFs = !!this.grid.fullscreenCamera;
    overlay.innerHTML = `
      <div class="kbd-help-panel">
        <div class="kbd-help-title">Keyboard shortcuts</div>
        <div class="kbd-help-section">${isFs ? 'Fullscreen' : 'Grid'}</div>
        ${isFs ? `
          <div class="kbd-row"><kbd>←</kbd><kbd>→</kbd><span>Navigate cameras</span></div>
          <div class="kbd-row"><kbd>J</kbd><kbd>K</kbd><span>Seek ±30s (archive) / jump to archive (LIVE)</span></div>
          <div class="kbd-row"><kbd>Shift</kbd>+<kbd>J</kbd><kbd>K</kbd><span>Seek ±5m</span></div>
          <div class="kbd-row"><kbd>↑</kbd><kbd>↓</kbd><span>Volume up/down</span></div>
          <div class="kbd-row"><kbd>Space</kbd><span>Pause / resume</span></div>
          <div class="kbd-row"><kbd>L</kbd><span>Go to LIVE / open playback</span></div>
          <div class="kbd-row"><kbd>P</kbd><span>Playback panel</span></div>
          <div class="kbd-row"><kbd>H</kbd><span>Toggle HD</span></div>
          <div class="kbd-row"><kbd>1</kbd>-<kbd>4</kbd><span>Zoom 1×–4×</span></div>
          <div class="kbd-row"><kbd>Z</kbd><span>Reset zoom</span></div>
          <div class="kbd-row"><kbd>Scroll</kbd><span>Zoom in/out</span></div>
          <div class="kbd-row"><kbd>Drag</kbd><span>Pan (when zoomed)</span></div>
          <div class="kbd-row"><kbd>Enter</kbd><span>Exit fullscreen</span></div>
          <div class="kbd-row"><kbd>F</kbd><span>Native fullscreen</span></div>
        ` : `
          <div class="kbd-row"><kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd><span>Navigate cameras</span></div>
          <div class="kbd-row"><kbd>Enter</kbd><span>Open focused camera</span></div>
          <div class="kbd-row"><kbd>Space</kbd><span>Select for investigation</span></div>
          <div class="kbd-row"><kbd>1</kbd>-<kbd>9</kbd><span>Open camera by position</span></div>
        `}
        <div class="kbd-help-section">Global</div>
        <div class="kbd-row"><kbd>M</kbd><span>Mute / unmute</span></div>
        <div class="kbd-row"><kbd>R</kbd><span>Refresh all</span></div>
        <div class="kbd-row"><kbd>C</kbd><span>Compact mode</span></div>
        <div class="kbd-row"><kbd>T</kbd><span>Toggle theme</span></div>
        <div class="kbd-row"><kbd>F</kbd><span>Native fullscreen</span></div>
        <div class="kbd-row"><kbd>Esc</kbd><span>Back / exit</span></div>
        <div class="kbd-row"><kbd>Ctrl</kbd>+<kbd>1</kbd>-<kbd>6</kbd><span>Grid columns</span></div>
        <div class="kbd-row"><kbd>?</kbd><span>This help</span></div>
      </div>`;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
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
