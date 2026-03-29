/**
 * ObjectClassifier — MediaPipe-based object detection for surveillance cameras.
 *
 * Lazy-loads the model on first use (~4MB download, cached by browser).
 * Detects: person, car, truck, bus, motorcycle, cat, dog.
 *
 * Design: singleton — one model shared across all cameras.
 * Stage 2 in the detection pipeline: only called when MotionDetector (Stage 1)
 * has already detected frame changes, so inference runs rarely.
 *
 * Usage:
 *   const classifier = new ObjectClassifier();
 *   const results = await classifier.detect(videoElement);
 *   // [{label: 'person', score: 0.82, box: {x, y, w, h}}]
 */

const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float16/latest/efficientdet_lite2.tflite';

/** Classes relevant to surveillance — ignore everything else */
const SURVEILLANCE_CLASSES = new Set([
  'person', 'car', 'truck', 'bus', 'motorcycle', 'cat', 'dog'
]);

/** Map verbose COCO names to concise labels */
const LABEL_MAP = {
  person: 'human',
  car: 'vehicle',
  truck: 'vehicle',
  bus: 'vehicle',
  motorcycle: 'vehicle',
  cat: 'animal',
  dog: 'animal',
};

export class ObjectClassifier {
  constructor() {
    this._detector = null;
    this._loading = null;
    this._ready = false;
    this._loadError = null;
    this._lastTimestamp = 0;
  }

  /** Whether model is loaded and ready. */
  get isReady() { return this._ready; }

  /** Load error message if init failed, null otherwise. */
  get error() { return this._loadError; }

  /**
   * Initialize the detector. Lazy — call anytime, loads only once.
   * Returns true if ready, false if failed.
   */
  async init() {
    if (this._ready) return true;
    if (this._loadError) return false;
    if (this._loading) return this._loading;

    this._loading = this._doInit();
    const ok = await this._loading;
    this._loading = null;
    return ok;
  }

  async _doInit() {
    try {
      console.log('[classifier] Loading MediaPipe ObjectDetector...');
      const t0 = performance.now();

      // Dynamic import from CDN
      console.log('[classifier] Step 1: importing vision_bundle.mjs...');
      const vision = await import(
        /* webpackIgnore: true */
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs'
      );

      const { ObjectDetector, FilesetResolver } = vision;
      console.log('[classifier] Step 2: loading WASM fileset...');

      const fileset = await FilesetResolver.forVisionTasks(WASM_CDN);
      console.log('[classifier] Step 3: creating detector with model...');

      this._detector = await ObjectDetector.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: MODEL_URL,
        },
        runningMode: 'VIDEO',
        maxResults: 10,
        scoreThreshold: 0.3,
      });

      this._ready = true;
      this._lastTimestamp = 0;
      const ms = Math.round(performance.now() - t0);
      console.log(`[classifier] Ready in ${ms}ms`);
      return true;
    } catch (err) {
      this._loadError = err.message || String(err);
      console.error('[classifier] Failed to load:', err);
      return false;
    }
  }

  /**
   * Detect objects in a video frame.
   *
   * @param {HTMLVideoElement} video — must be playing with decoded frames
   * @returns {Array<{label: string, className: string, score: number, box: {x:number, y:number, w:number, h:number}}>}
   *          label: 'human'|'vehicle'|'animal'
   *          className: original COCO class (e.g. 'person', 'car', 'dog')
   *          score: confidence 0–1
   *          box: bounding box in pixels
   *          Returns empty array if not ready or no detections.
   */
  detect(video) {
    if (!this._ready || !this._detector) return [];
    if (!video || video.readyState < 2 || video.videoWidth === 0) return [];

    try {
      // Ensure strictly monotonically increasing timestamps
      let ts = Math.round(performance.now());
      if (ts <= this._lastTimestamp) ts = this._lastTimestamp + 1;
      this._lastTimestamp = ts;

      const result = this._detector.detectForVideo(video, ts);
      if (!result?.detections?.length) return [];

      const filtered = [];
      for (const det of result.detections) {
        const cat = det.categories?.[0];
        if (!cat) continue;

        const name = cat.categoryName;
        if (!SURVEILLANCE_CLASSES.has(name)) continue;

        filtered.push({
          label: LABEL_MAP[name] || name,
          className: name,
          score: Math.round(cat.score * 100) / 100,
          box: det.boundingBox
            ? { x: det.boundingBox.originX, y: det.boundingBox.originY,
                w: det.boundingBox.width, h: det.boundingBox.height }
            : null,
        });
      }

      return filtered;
    } catch (err) {
      // Silently skip detection errors (e.g. video not ready)
      return [];
    }
  }

  /** Release model resources. */
  destroy() {
    if (this._detector) {
      this._detector.close();
      this._detector = null;
    }
    this._ready = false;
    this._loading = null;
    this._loadError = null;
  }
}
