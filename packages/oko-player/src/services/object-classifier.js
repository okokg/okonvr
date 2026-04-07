/**
 * ObjectClassifier — AI object detection for surveillance cameras.
 *
 * Supports two engines:
 *   1. yolo-onnx  — YOLO models (.onnx) served from backend /backend/models/
 *   2. mediapipe  — EfficientDet via MediaPipe CDN (default fallback)
 *
 * Models are managed by placing .onnx files in the project's /models/ directory.
 * Backend API: GET /backend/models → list, GET /backend/models/:file → download.
 *
 * API:
 *   const c = new ObjectClassifier();
 *   await c.init();                    // loads default (mediapipe)
 *   await c.loadModel('yolo11s.onnx'); // switch to YOLO model from backend
 *   c.detect(videoEl);                 // → [{label, className, score, box}]
 *   c.isReady / c.error / c.engine / c.modelName
 */

// ── COCO 80 class names (YOLO order) ──
const COCO_NAMES = [
  'person','bicycle','car','motorcycle','airplane','bus','fire hydrant','stop sign',
  'parking meter','bench','bird','elephant','bear','zebra','giraffe','backpack',
  'umbrella','handbag','tie','suitcase','frisbee','skis','snowboard','sports ball',
  'kite','baseball bat','baseball glove','skateboard','surfboard','tennis racket',
  'bottle','wine glass','cup','fork','knife','spoon','bowl','banana','apple',
  'sandwich','orange','broccoli','carrot','hot dog','pizza','donut','cake','chair',
  'couch','potted plant','bed','dining table','toilet','tv','laptop','mouse',
  'remote','keyboard','cell phone','microwave','oven','toaster','sink',
  'refrigerator','book','clock','vase','scissors','teddy bear','hair drier','toothbrush'
];

/** COCO indices relevant to surveillance */
const SURVEILLANCE_IDS = new Set([0,1,2,3,5,7,14,15,16,17]);

/** Map COCO class names → surveillance labels */
const LABEL_MAP = {
  person: 'human',
  car: 'vehicle', truck: 'vehicle', bus: 'vehicle',
  motorcycle: 'vehicle', bicycle: 'vehicle',
  cat: 'animal', dog: 'animal', bird: 'animal', horse: 'animal',
};

// ── MediaPipe fallback constants ──
const MP_WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
const MP_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float16/latest/efficientdet_lite2.tflite';
const MP_CLASSES = new Set(['person','car','truck','bus','motorcycle','cat','dog']);

// ── Thresholds ──
const CONF_THRESHOLD = 0.45;
const IOU_THRESHOLD = 0.5;

export class ObjectClassifier {
  constructor() {
    this._ready = false;
    this._loadError = null;
    this._engine = null;      // 'yolo-onnx' | 'mediapipe'
    this._modelName = null;   // display name

    // YOLO ONNX
    this._session = null;
    this._inputName = null;
    this._outputName = null;
    this._inputSize = 640;
    this._letterbox = { scale: 1, padX: 0, padY: 0 };
    this._prepCanvas = null;
    this._prepCtx = null;
    this._yoloRunning = false;
    this._lastResult = [];

    // MediaPipe
    this._mpDetector = null;
    this._lastTimestamp = 0;
  }

  get isReady()   { return this._ready; }
  get error()     { return this._loadError; }
  get engine()    { return this._engine; }
  get modelName() { return this._modelName; }

  // ═══════════════════════════════════════════
  // Init — default MediaPipe
  // ═══════════════════════════════════════════

  async init() {
    try {
      await this._initMediaPipe();
      return true;
    } catch (err) {
      this._loadError = err.message || String(err);
      console.error('[classifier] Failed to init:', err);
      return false;
    }
  }

  // ═══════════════════════════════════════════
  // Model loading — called from UI
  // ═══════════════════════════════════════════

  /** Fetch available models from backend. */
  static async listModels() {
    try {
      const resp = await fetch('/backend/models');
      if (!resp.ok) return { models: [], builtin: { name: 'EfficientDet-Lite2 (CDN)', engine: 'mediapipe' } };
      return await resp.json();
    } catch {
      return { models: [], builtin: { name: 'EfficientDet-Lite2 (CDN)', engine: 'mediapipe' } };
    }
  }

  /**
   * Switch to a different model.
   * @param {string} modelKey — 'mediapipe' or filename like 'yolo11s.onnx'
   */
  async loadModel(modelKey, meta = {}) {
    // Tear down current engine
    this._teardown();

    try {
      if (modelKey === 'mediapipe') {
        await this._initMediaPipe();
      } else {
        await this._initYolo(modelKey, meta);
      }
      return true;
    } catch (err) {
      this._loadError = err.message || String(err);
      this._ready = false;
      console.error('[classifier] Failed to load model:', err);
      return false;
    }
  }

  _teardown() {
    this._ready = false;
    this._loadError = null;
    this._lastResult = [];
    this._yoloRunning = false;

    // YOLO cleanup
    if (this._session) {
      // ort sessions don't need explicit close in web
      this._session = null;
    }
    this._prepCanvas = null;
    this._prepCtx = null;

    // MediaPipe cleanup
    if (this._mpDetector) {
      try { this._mpDetector.close(); } catch {}
      this._mpDetector = null;
    }
  }

  // ═══════════════════════════════════════════
  // YOLO ONNX Engine
  // ═══════════════════════════════════════════

  async _initYolo(filename, meta = {}) {
    const t0 = performance.now();
    console.log(`[classifier] Loading YOLO: ${filename}`, meta.description ? `(${meta.description})` : '');

    // Load onnxruntime-web if needed
    if (typeof globalThis.ort === 'undefined') {
      console.log('[classifier] Loading ONNX Runtime WASM...');
      await this._loadScript('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.min.js');
    }
    globalThis.ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';

    // Download model from backend
    const modelUrl = `/backend/models/${filename}`;
    console.log(`[classifier] Downloading: ${modelUrl}`);
    const resp = await fetch(modelUrl);
    if (!resp.ok) throw new Error(`Model fetch failed: ${resp.status} ${modelUrl}`);
    const buf = await resp.arrayBuffer();
    console.log(`[classifier] Downloaded: ${(buf.byteLength / 1e6).toFixed(1)}MB`);

    console.log('[classifier] Creating ONNX session...');
    this._session = await globalThis.ort.InferenceSession.create(buf, {
      executionProviders: ['wasm'],
    });

    this._inputName = this._session.inputNames[0];
    this._outputName = this._session.outputNames[0];

    // Use imgsz from metadata if available (Ultralytics embeds this)
    if (meta.imgsz) {
      const sz = Array.isArray(meta.imgsz) ? meta.imgsz[0] : parseInt(meta.imgsz);
      if (sz > 0) this._inputSize = sz;
    } else {
      this._inputSize = 640;
    }

    this._prepCanvas = new OffscreenCanvas(this._inputSize, this._inputSize);
    this._prepCtx = this._prepCanvas.getContext('2d');

    this._engine = 'yolo-onnx';

    // Model name: prefer description from ONNX metadata, fallback to cleaned filename
    if (meta.description) {
      this._modelName = meta.description
        .replace(/^Ultralytics\s+/i, '')
        .replace(/\s+model\s*$/i, '')
        .trim();
    } else {
      this._modelName = filename.replace(/[._]opset[=_]?\d+/i, '').replace(/\.onnx$/i, '');
    }

    this._ready = true;
    const ms = Math.round(performance.now() - t0);
    console.log(`[classifier] YOLO ready in ${ms}ms (${this._modelName}, ${this._inputSize}px, in=${this._inputName}, out=${this._outputName})`);
  }

  _loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Script load failed: ${src}`));
      document.head.appendChild(s);
    });
  }

  _preprocessYolo(video) {
    const size = this._inputSize;
    const vw = video.videoWidth, vh = video.videoHeight;
    const scale = Math.min(size / vw, size / vh);
    const nw = Math.round(vw * scale), nh = Math.round(vh * scale);
    const padX = (size - nw) / 2, padY = (size - nh) / 2;
    this._letterbox = { scale, padX, padY };

    const ctx = this._prepCtx;
    ctx.fillStyle = '#727272';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(video, padX, padY, nw, nh);

    const imgData = ctx.getImageData(0, 0, size, size).data;
    const pixels = size * size;
    const float32 = new Float32Array(3 * pixels);
    for (let i = 0; i < pixels; i++) {
      const off = i * 4;
      float32[i]              = imgData[off]     / 255;
      float32[pixels + i]     = imgData[off + 1] / 255;
      float32[2 * pixels + i] = imgData[off + 2] / 255;
    }
    return new globalThis.ort.Tensor('float32', float32, [1, 3, size, size]);
  }

  _postprocessYolo(output, imgW, imgH) {
    const data = output.data;
    const rows = output.dims[1];
    const cols = output.dims[2];
    const { scale, padX, padY } = this._letterbox;
    const boxes = [];

    for (let i = 0; i < cols; i++) {
      let maxProb = 0, maxCls = 0;
      for (let c = 4; c < rows; c++) {
        const p = data[c * cols + i];
        if (p > maxProb) { maxProb = p; maxCls = c - 4; }
      }
      if (maxProb < CONF_THRESHOLD) continue;
      if (!SURVEILLANCE_IDS.has(maxCls)) continue;

      const cx = data[0 * cols + i];
      const cy = data[1 * cols + i];
      const w  = data[2 * cols + i];
      const h  = data[3 * cols + i];

      const x1 = (cx - w / 2 - padX) / scale;
      const y1 = (cy - h / 2 - padY) / scale;
      const bw = w / scale;
      const bh = h / scale;

      const name = COCO_NAMES[maxCls] || 'unknown';
      boxes.push({
        label: LABEL_MAP[name] || 'unknown',
        className: name,
        score: maxProb,
        box: { x: x1, y: y1, w: bw, h: bh },
        _cls: maxCls,
      });
    }
    return this._nms(boxes);
  }

  _nms(boxes) {
    boxes.sort((a, b) => b.score - a.score);
    const keep = [];
    const used = new Set();
    for (let i = 0; i < boxes.length; i++) {
      if (used.has(i)) continue;
      keep.push(boxes[i]);
      for (let j = i + 1; j < boxes.length; j++) {
        if (used.has(j)) continue;
        if (boxes[i]._cls === boxes[j]._cls && this._iou(boxes[i].box, boxes[j].box) > IOU_THRESHOLD) {
          used.add(j);
        }
      }
    }
    return keep;
  }

  _iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a.w * a.h + b.w * b.h - inter;
    return union > 0 ? inter / union : 0;
  }

  // ═══════════════════════════════════════════
  // MediaPipe Engine (default)
  // ═══════════════════════════════════════════

  async _initMediaPipe() {
    const t0 = performance.now();
    console.log('[classifier] Loading MediaPipe ObjectDetector...');
    console.log('[classifier] Step 1: importing vision_bundle.mjs...');
    const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs');
    console.log('[classifier] Step 2: loading WASM fileset...');
    const fileset = await vision.FilesetResolver.forVisionTasks(MP_WASM_CDN);
    console.log('[classifier] Step 3: creating detector...');

    this._mpDetector = await vision.ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MP_MODEL_URL },
      runningMode: 'VIDEO',
      maxResults: 10,
      scoreThreshold: CONF_THRESHOLD,
    });

    this._engine = 'mediapipe';
    this._modelName = 'EfficientDet-Lite2';
    this._ready = true;
    this._lastTimestamp = 0;
    const ms = Math.round(performance.now() - t0);
    console.log(`[classifier] MediaPipe ready in ${ms}ms`);
  }

  // ═══════════════════════════════════════════
  // Detect — unified API
  // ═══════════════════════════════════════════

  detect(videoEl) {
    if (!this._ready) return [];
    try {
      if (this._engine === 'yolo-onnx') return this._detectYolo(videoEl);
      return this._detectMediaPipe(videoEl);
    } catch (err) {
      console.warn('[classifier] detect error:', err.message);
      return [];
    }
  }

  _detectYolo(video) {
    if (!this._session || !video || video.readyState < 2 || video.videoWidth === 0) return [];

    if (!this._yoloRunning) {
      this._yoloRunning = true;
      const input = this._preprocessYolo(video);
      const feeds = { [this._inputName]: input };
      this._session.run(feeds).then(results => {
        const output = results[this._outputName];
        this._lastResult = this._postprocessYolo(output, video.videoWidth, video.videoHeight);
        this._yoloRunning = false;
      }).catch(e => {
        console.warn('[classifier] YOLO inference error:', e.message);
        this._yoloRunning = false;
      });
    }
    return this._lastResult;
  }

  _detectMediaPipe(video) {
    if (!this._mpDetector || !video || video.readyState < 2 || video.videoWidth === 0) return [];
    const ts = performance.now();
    if (ts <= this._lastTimestamp) return [];
    this._lastTimestamp = ts;

    const result = this._mpDetector.detectForVideo(video, ts);
    if (!result?.detections) return [];

    return result.detections
      .filter(d => d.categories?.[0] && MP_CLASSES.has(d.categories[0].categoryName))
      .map(d => {
        const cat = d.categories[0];
        const bb = d.boundingBox;
        const name = cat.categoryName;
        return {
          label: LABEL_MAP[name] || 'unknown',
          className: name,
          score: cat.score,
          box: bb ? { x: bb.originX, y: bb.originY, w: bb.width, h: bb.height } : null,
        };
      });
  }
}
