/**
 * MotionDetector — client-side video frame difference analysis.
 *
 * Pure analysis class, no UI or DOM manipulation.
 * Compares consecutive video frames via canvas downscale + luminance diff.
 *
 * Usage:
 *   const detector = new MotionDetector();
 *   const score = detector.analyze(videoElement); // 0.0 - 1.0
 *   const hasMotion = score > detector.threshold;
 */

const SAMPLE_W = 80;
const SAMPLE_H = 45;
const PIXEL_COUNT = SAMPLE_W * SAMPLE_H;

export class MotionDetector {
  constructor() {
    this._canvas = null;
    this._ctx = null;
    this._prevFrame = null;
    this._threshold = 0.04;  // default, overridden by sensitivity
  }

  /** Sensitivity 1-10 → threshold. Higher sensitivity = lower threshold. */
  set sensitivity(val) {
    // sensitivity 1 → threshold 0.10 (insensitive)
    // sensitivity 5 → threshold 0.04 (default)
    // sensitivity 10 → threshold 0.008 (very sensitive)
    const clamped = Math.max(1, Math.min(10, val));
    this._threshold = 0.12 * Math.pow(0.75, clamped - 1);
  }

  get threshold() { return this._threshold; }

  /**
   * Analyze a video element for motion.
   * @param {HTMLVideoElement} video — must be playing with videoWidth > 0
   * @returns {number} diff score 0.0-1.0, or -1 if unable to analyze
   */
  analyze(video) {
    if (!video || video.videoWidth === 0 || video.paused) return -1;

    // Lazy-init offscreen canvas
    if (!this._canvas) {
      this._canvas = document.createElement('canvas');
      this._canvas.width = SAMPLE_W;
      this._canvas.height = SAMPLE_H;
      this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    }

    // Draw downscaled frame
    this._ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
    const frame = this._ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;

    if (!this._prevFrame) {
      this._prevFrame = new Uint8Array(frame);
      return -1; // first frame, no comparison
    }

    // Compute luminance diff
    let totalDiff = 0;
    for (let i = 0; i < frame.length; i += 4) {
      // Approximate luminance: 0.299R + 0.587G + 0.114B
      const lumCur  = frame[i] * 0.299 + frame[i + 1] * 0.587 + frame[i + 2] * 0.114;
      const lumPrev = this._prevFrame[i] * 0.299 + this._prevFrame[i + 1] * 0.587 + this._prevFrame[i + 2] * 0.114;
      totalDiff += Math.abs(lumCur - lumPrev);
    }

    // Save current frame
    this._prevFrame.set(frame);

    // Normalize: max possible diff = 255 per pixel
    return totalDiff / (PIXEL_COUNT * 255);
  }

  /** Reset stored frame (e.g. on stream reconnect). */
  reset() {
    this._prevFrame = null;
  }

  /** Release canvas resources. */
  destroy() {
    this._canvas = null;
    this._ctx = null;
    this._prevFrame = null;
  }
}
