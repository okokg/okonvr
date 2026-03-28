# oko-player — План разреза camera-view.js

## Карта текущего файла (3159 строк)

```
Строки    Блок                              → Куда уходит
──────    ─────                              ───────────────
1-38      Module utils (_pad, _hms, etc)     → core/utils.js (shared)
39-53     Constructor: base fields           → core/camera-view.js
54-145    Constructor: _dom cache            → core + features inject свои refs
146-159   Constructor: aliases               → удалить (перейти на _dom.xxx)
160-172   Constructor: snapshot preload      → core
173-176   Constructor: HD state              → features/quality.js
178-196   Constructor: _state object         → core (base) + features добавляют slices
198-203   Constructor: talkback state        → features/talkback.js
205-206   Constructor: zoom state            → features/zoom.js
208-215   Constructor: init render + wire    → core (features auto-render at attach)

217-255   _renderQuality()                   → features/quality.js
257-273   _renderAudio(), _setAudioUnmuted   → core (audio есть всегда)
275-461   Talkback block (render, start,     → features/talkback.js (~190 строк)
          stop, toggle, cleanup, timer)
463-497   Quality loading/finalize/cancel    → features/quality.js (~35 строк)

499-567   start(), disable(), _switchPlayer  → core/camera-view.js
569-599   isConnected, isEnabled, setVisible → core
          isSelected, toggleSelect
601-722   togglePause, _captureFrame,        → core (pause/freeze is fundamental)
          _clearFreezeFrame, _showPause
723-840   enterFullscreen, exitFullscreen    → core (но вызывает feature hooks)
          _updateLiveTime, _startLiveTimer
842-927   startHd, stopHd, isHd,            → features/quality.js (~85 строк)
          destroyPlaybackPlayer, resetZoom,
          togglePlaybackPanel, switchToStream
929-1095  _showLoading, _hideLoading,        → core
          awaitUserPlay, _tryUnmute,
          restoreAudio, _recacheQualityDom,
          _startRenderCheck, _stopRenderCheck
1097-1207 updateBitrate, _updateInfoTooltip, → core
          renderTimeline, syncBuffer
1209-1295 Callback definitions (onClick,     → core (feature callbacks добавляются
          onPlaybackRequest, etc)               через feature.attach)
1296-1475 Playback: start, stop, position,  → features/playback.js (~180 строк)
          timer, _updateSeekPosition
1477-1675 Playback UI: _updateDateLabel,     → features/playback.js (~200 строк)
          _updateSeekAvailability,
          _renderPlaybackBadge,
          _markPendingChange
1676-1975 Digital zoom: _applyZoom,          → features/zoom.js (~300 строк)
          _updateMinimap, _drawMinimap,
          _resetZoom, _setZoom, _clampPan,
          _bindZoomEvents (wheel, mouse,
          touch, pinch, minimap drag)
1977-2028 Quick menu (long-press touch)      → core (generic UI)
2030-2241 _createElement() — HTML template   → core (base) + features inject DOM
2246-2318 _wirePlayer()                      → core (feature-specific parts via hooks)
2320-2365 _bindDOMEvents: click, dblclick    → core
2366-2416 _bindDOMEvents: audio, mic, PTT    → core(audio) + features/talkback.js
2418-2428 _bindDOMEvents: SD/HD toggle       → features/quality.js
2430-2520 _bindDOMEvents: playback panel,    → features/playback.js
          seek buttons
2522-2534 _bindDOMEvents: info tooltip hover  → core
2536-2845 _bindDOMEvents: seek timeline,     → features/playback.js (~310 строк)
          thumbnail preview, day nav
2847-2913 Grid HUD: LIVE button              → features/playback.js
2915-2987 Grid HUD: bar hover/click          → features/playback.js
2989-3011 Grid HUD: day navigation           → features/playback.js
3013-3031 Grid HUD: audio/mic icons          → core(audio) + features/talkback.js
3033-3043 Grid HUD: SD/HD toggle             → features/quality.js
3045-3089 Fullscreen HUD: seek buttons,      → features/playback.js
          time btn, more toggle
3091-3118 Drag-and-drop                      → core
3120-3154 matchesQuery()                     → core
3157-3159 Static globalMute                  → core
```

## Итоговое распределение

| Модуль | Строки (прим.) | Что делает |
|--------|-------|------------|
| **core/camera-view.js** | ~850 | Video element, _switchPlayer, loading/freeze, audio, HUD base, enter/exit fullscreen, pause, bitrate, timeline, drag-drop, search |
| **core/utils.js** | ~40 | _pad, _hms, _hm, _dm, _dmy, _fmtInput, _fmtFull, _daySeconds |
| **features/playback.js** | ~900 | Playback panel, seek timeline (fullscreen + grid HUD), day navigation, position tracking, thumbnail preview, live/archive switching |
| **features/zoom.js** | ~300 | Digital zoom, wheel/pinch/mouse drag, pan clamping, minimap, double-tap |
| **features/talkback.js** | ~250 | PTT button, mic management, WebRTC backchannel, timer, connecting state |
| **features/quality.js** | ~180 | SD/HD switching, resolution badge, loading wipe, HD player lifecycle |
| **Итого** | ~2520 | (vs 3159 — сокращение за счёт удаления дублей и aliases) |

## Самая сложная часть: _createElement()

Сейчас `_createElement()` генерирует ВСЮ разметку (строки 2030-2241).
Нужно разбить: core создаёт скелет, features инжектят свои блоки при attach().

### Core skeleton (camera-view.js)
```html
<div class="cam">
  <div class="cam-loading">...</div>
  <video muted autoplay playsinline></video>
  <img class="cam-snapshot">
  <img class="cam-freeze">
  <div class="cam-pause-indicator">...</div>
  <div class="cam-bitrate"></div>
  <div class="cam-select">...</div>
  <div class="cam-info-tooltip"></div>
  <div class="cam-overlay">
    <div class="cam-name-wrap">...</div>
    <div class="cam-info-inline"></div>
    <div class="cam-top-right">
      <!-- features inject here: audio, mic, quality, playback btn -->
    </div>
    <div class="cam-badges">
      <span class="cam-mode"></span>
      <div class="cam-status"></div>
    </div>
  </div>
  <!-- features inject here: PTT, playback panel, seek timeline, minimap -->
  <div class="cam-timeline"><canvas height="3"></canvas></div>
  <!-- features inject here: grid HUD extensions -->
  <div class="cam-grid-hud">
    <div class="ghud-info">
      <span class="ghud-pill">
        <span class="ghud-name">...</span>
        <!-- features inject: audio/mic icons, quality toggle -->
      </span>
      <span class="ghud-status">...</span>
      <!-- features inject: day nav, quality badges -->
    </div>
    <div class="ghud-bar">
      <div class="ghud-fill"></div>
      <div class="ghud-cursor"></div>
      <!-- features inject: unavailable, now marker -->
    </div>
    <div class="ghud-tooltip"></div>
  </div>
</div>
```

### Feature injection API
```javascript
class Feature {
  /** Called when feature is attached to a CameraView. */
  attach(view) {
    this._view = view;
    this._injectDOM();     // add DOM elements to view.el
    this._cacheDom();      // cache own querySelector refs
    this._bindEvents();    // bind own event handlers
    this._initState();     // add state slice to view._state
  }

  /** Injection points — features know where to inject. */
  _injectDOM() {
    // Example: playback feature injects seek timeline
    const timeline = document.createElement('div');
    timeline.className = 'cam-seek-timeline';
    timeline.innerHTML = `...`;
    this._view.el.insertBefore(timeline, this._view.el.querySelector('.cam-timeline'));
  }

  /** Called when view enters fullscreen. */
  onEnterFullscreen() {}

  /** Called when view exits fullscreen. */
  onExitFullscreen() {}

  /** Called from _wirePlayer — feature can hook into player events. */
  onWirePlayer(player, mode) {}

  /** Return serializable state for deep links. */
  getState() { return {}; }

  /** Restore state from deep link. */
  restoreState(state) {}

  /** Cleanup on view.disable(). */
  destroy() {}
}
```

## CSS разделение

Из styles.css (2680 строк) нужно выделить:

| Файл | Селекторы | Строки (прим.) |
|------|-----------|-------|
| **player.css** | `.cam`, `.cam-*`, `.ghud-*`, `.fs-*`, `.seek-*`, `.quality-*`, `.playback-*`, `.cam-ptt*`, `.cam-grid-hud` | ~1800 |
| **app.css** | `.header*`, `.controls*`, `.grid`, `.kbd-hint`, `.search-*`, `.ctrl-btn`, `.server-activity*`, `:root` (CSS vars) | ~880 |

CSS variables определяются в app.css (`:root { --bg, --text, ... }`),
player.css их использует но не определяет → работает в любом shell.

## Порядок реализации

### Phase 1: Подготовка (не ломаем ничего)
1. Создать `packages/oko-player/` directory structure
2. Скопировать utils, config.js, api.js, player.js as-is
3. Скопировать grid.js as-is
4. Выделить core/camera-view.js — скелет без features
5. Проверить что всё компилируется

### Phase 2: Feature extraction (по одной, тестируя каждую)
1. **features/zoom.js** — самая изолированная, минимум зависимостей от core
2. **features/quality.js** — тоже изолированная (SD/HD switching)
3. **features/talkback.js** — изолированная (своя WebRTC, свой state)
4. **features/playback.js** — самая большая, много связей с core (seek, HUD, timers)

### Phase 3: CSS split
1. Разрезать styles.css → player.css + app.css
2. Проверить оба shell-а

### Phase 4: Package API
1. index.js — public exports
2. package.json
3. README.md

### Phase 5: Wire shells
1. web/js/app.js → import from oko-player, assemble features
2. Проверить что всё работает как раньше

## Критерий готовности Phase 2

Один unit test: собрать CameraView с zero features →
видео элемент, loading, snapshot, name badge, online/offline, bitrate.
Добавить все 4 features → полный функционал как сейчас.
