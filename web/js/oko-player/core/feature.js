/**
 * Base class for CameraView features (plugins).
 *
 * Features extend CameraView with optional capabilities:
 * playback, zoom, talkback, quality switching.
 *
 * Lifecycle:
 *   1. attach(view)         — called once when feature is added to a view
 *   2. onEnterFullscreen()  — view entered fullscreen
 *   3. onExitFullscreen()   — view exited fullscreen
 *   4. onWirePlayer(p,mode) — player connected (sd/hd/playback)
 *   5. onDisable()          — view.disable() called, cleanup
 *   6. destroy()            — feature removed permanently
 */
export class Feature {
  constructor() {
    /** @type {import('./camera-view.js').CameraView|null} */
    this._view = null;
  }

  /**
   * Attach this feature to a CameraView instance.
   * Subclasses override to inject DOM, cache refs, bind events, init state.
   * Always call super.attach(view) first.
   * @param {import('./camera-view.js').CameraView} view
   */
  attach(view) {
    this._view = view;
  }

  /** Called when view enters in-page fullscreen. */
  onEnterFullscreen() {}

  /** Called when view exits in-page fullscreen. */
  onExitFullscreen(opts) {}

  /**
   * Called when a CamPlayer is wired to the view.
   * Feature can hook into player callbacks.
   * @param {import('./camera-player.js').CamPlayer} player
   * @param {'sd'|'hd'|'playback'} mode
   */
  onWirePlayer(player, mode) {}

  /** Called when _hideLoading fires (video has frames). */
  onStreamReady() {}

  /** Called on view.disable() — stop timers, release resources. */
  onDisable() {}

  /**
   * Return serializable state for deep links / state restore.
   * @returns {object}
   */
  getState() { return {}; }

  /**
   * Restore state from deep link data.
   * @param {object} state
   */
  restoreState(state) {}

  /** Permanently destroy — remove DOM, listeners. */
  destroy() {
    this._view = null;
  }
}
