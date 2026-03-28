/**
 * MotionDetector — client-side frame diff analysis.
 *
 * Downscales video frames to a small canvas, computes pixel luminance diff
 * between consecutive frames. Returns a motion score (0–100).
 *
 * Pure utility — no timers, no UI, no side effects.
 * One instance per camera video element.
 */
export class MotionDetector {
  /**
   * @param {HTMLVideoElement} video
   * @param {number} width  — analysis resolution width (default 80)
   * @param {number} height — analysis resolution height (default 45)
   */
  constructor(video, width = 80, height = 45) {
    this._video = video;
    this._w = width;
    this._h = height;
    this._canvas = new OffscreenCanvas(width, height);
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    this._prev = null; // Uint8Array of previous frame luminance
  }

  /**
   * Capture current frame, compare with previous, return motion score.
   *
   * Algorithm: count pixels where luminance diff exceeds per-pixel threshold,
   * return percentage of changed pixels. This ignores OSD timestamps (small
   * localized changes) and compression noise while detecting real motion
   * (large area changes).
   *
   * @returns {number} 0–100, percentage of pixels that changed significantly.
   *                   Returns -1 if video has no frames.
   */
  analyze() {
    const v = this._video;
    if (!v || v.readyState < 2 || v.videoWidth === 0 || v.paused) {
      return -1;
    }

    this._ctx.drawImage(v, 0, 0, this._w, this._h);
    const data = this._ctx.getImageData(0, 0, this._w, this._h).data;

    const pixels = this._w * this._h;
    const lum = new Uint8Array(pixels);
    for (let i = 0; i < pixels; i++) {
      const off = i * 4;
      lum[i] = (data[off] + data[off + 1] + data[off + 1] + data[off + 2]) >> 2;
    }

    if (!this._prev) {
      this._prev = lum;
      return 0;
    }

    // Count pixels where diff exceeds per-pixel threshold.
    // This filters out: compression noise (diff ~5-15), OSD digits (small area).
    // Real motion affects large areas with significant per-pixel change.
    const PX_THRESHOLD = 20;
    let changedPixels = 0;
    for (let i = 0; i < pixels; i++) {
      if (Math.abs(lum[i] - this._prev[i]) > PX_THRESHOLD) {
        changedPixels++;
      }
    }
    this._prev = lum;

    // Return percentage of significantly changed pixels
    return Math.round((changedPixels / pixels) * 100);
  }

  /** Reset stored frame (e.g. after camera reconnect to avoid false spike). */
  reset() {
    this._prev = null;
  }

  /** Release resources. */
  destroy() {
    this._prev = null;
    this._ctx = null;
    this._canvas = null;
    this._video = null;
  }
}
