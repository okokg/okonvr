#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""oko-detect v0.6.0 — Google Coral TPU detection via RTSP stream.

Changes from v0.5.1:
  - cv2.VideoCapture(RTSP) instead of HTTP frame.jpeg (1 FPS → 10-12 FPS)
  - Coral init: 1 attempt, fail → exit(1), Docker restarts container
  - Buffer drain: grab() loop to skip to latest frame
  - Auto-reconnect on RTSP stream loss
"""

VERSION = '0.6.0'

import os, sys, time, json, signal, logging, threading, glob
import urllib.request
import numpy as np
from PIL import Image
from http.server import HTTPServer, BaseHTTPRequestHandler

try:
    import cv2
except ImportError:
    print('[detect] ERROR: opencv not installed. Add opencv-python-headless to requirements.', file=sys.stderr)
    sys.exit(1)

import tflite_runtime.interpreter as tflite

try:
    from pycoral.utils.edgetpu import list_edge_tpus, make_interpreter as coral_make_interpreter
    HAS_PYCORAL = True
except ImportError:
    HAS_PYCORAL = False

EDGETPU_SHARED_LIB = 'libedgetpu.so.1'

logging.basicConfig(level=logging.INFO, format='[detect] %(asctime)s %(message)s', datefmt='%H:%M:%S')
log = logging.getLogger('oko-detect')

# ── COCO 80 class labels (YOLOv8 order) ──

COCO = [
    'person','bicycle','car','motorcycle','airplane','bus','train','truck',
    'boat','traffic light','fire hydrant','stop sign','parking meter','bench',
    'bird','cat','dog','horse','sheep','cow','elephant','bear','zebra','giraffe',
    'backpack','umbrella','handbag','tie','suitcase','frisbee','skis','snowboard',
    'sports ball','kite','baseball bat','baseball glove','skateboard','surfboard',
    'tennis racket','bottle','wine glass','cup','fork','knife','spoon','bowl',
    'banana','apple','sandwich','orange','broccoli','carrot','hot dog','pizza',
    'donut','cake','chair','couch','potted plant','bed','dining table','toilet',
    'tv','laptop','mouse','remote','keyboard','cell phone','microwave','oven',
    'toaster','sink','refrigerator','book','clock','vase','scissors','teddy bear',
    'hair drier','toothbrush'
]

# Surveillance-relevant class IDs
SURV = {0, 1, 2, 3, 5, 7, 14, 15, 16, 17}
# person, bicycle, car, motorcycle, bus, truck, bird, cat, dog, horse

LABELS = {
    'person': 'human', 'car': 'vehicle', 'truck': 'vehicle', 'bus': 'vehicle',
    'motorcycle': 'vehicle', 'bicycle': 'vehicle',
    'cat': 'animal', 'dog': 'animal', 'bird': 'animal', 'horse': 'animal',
}


# ═══════════════════════════════════════════════════════════════
# CoralEngine — YOLOv8n INT8 inference on Edge TPU
# ═══════════════════════════════════════════════════════════════

class CoralEngine:
    def __init__(self, model_path, conf=0.3):
        self.conf = conf
        self.model_path = model_path
        self.interpreter = None
        self.input_detail = None
        self.output_detail = None
        self.input_size = 320
        self.device_count = 0
        self.model_name = os.path.basename(model_path)
        self.out_scale = 1.0
        self.out_zp = 0
        self.in_scale = 1.0
        self.in_zp = 0
        self._last_debug = {}
        self._detect_count = 0

    def init(self, device_index=0):
        """Initialize Coral TPU using pycoral make_interpreter (proper C++ OpenDevice)."""
        if not HAS_PYCORAL:
            log.error('pycoral not installed')
            return False

        tpus = list_edge_tpus()
        log.info(f'Found {len(tpus)} Edge TPU(s): {tpus}')
        if not tpus:
            log.error('No Edge TPU devices found')
            return False
        self.device_count = len(tpus)

        # Try each TPU starting from device_index
        devices_to_try = [f':{i}' for i in range(len(tpus))]
        # Put requested device first
        if device_index < len(devices_to_try):
            devices_to_try.insert(0, devices_to_try.pop(device_index))

        for device in devices_to_try:
            try:
                log.info(f'Trying make_interpreter(device={device})...')
                self.interpreter = coral_make_interpreter(self.model_path, device=device)
                self.interpreter.allocate_tensors()
                inp = self.interpreter.get_input_details()[0]
                out = self.interpreter.get_output_details()[0]
                self.output_detail = out
                self.input_detail = inp
                self.input_size = inp['shape'][1]
                self.in_scale, self.in_zp = inp['quantization']
                self.out_scale, self.out_zp = out['quantization']
                log.info(f'Coral TPU ready (device={device}): {self.model_name}, '
                         f'input={self.input_size}x{self.input_size}, dtype={inp["dtype"].__name__}, '
                         f'in_quant=({self.in_scale:.6f}, {self.in_zp}), '
                         f'out_quant=({self.out_scale:.6f}, {self.out_zp})')
                return True
            except Exception as e:
                log.warning(f'Device {device} failed: {e}')
                self.interpreter = None
                continue

        log.error('All Edge TPU devices failed')
        return False

    @property
    def ready(self):
        return self.interpreter is not None

    def detect(self, image):
        """Run YOLOv8 detection on PIL Image. Returns list of detections."""
        if not self.interpreter:
            return []
        ow, oh = image.size
        sz = self.input_size
        scale = min(sz / ow, sz / oh)
        nw, nh = int(ow * scale), int(oh * scale)
        px, py = (sz - nw) // 2, (sz - nh) // 2

        resized = image.resize((nw, nh), Image.BILINEAR)
        padded = Image.new('RGB', (sz, sz), (114, 114, 114))
        padded.paste(resized, (px, py))
        data = np.array(padded)

        # Quantize input
        if self.input_detail['dtype'] in (np.int8, np.uint8):
            data = ((data / 255.0) / self.in_scale + self.in_zp)
            data = np.clip(data, -128, 127).astype(np.int8)
        else:
            data = (data / 255.0).astype(np.float32)

        self.interpreter.set_tensor(self.input_detail['index'], np.expand_dims(data, 0))
        self.interpreter.invoke()
        # .copy() — release reference to interpreter's internal buffer
        raw = self.interpreter.get_tensor(self.output_detail['index'])[0].copy()

        # Raw stats for debug (before dequantization)
        raw_min, raw_max = int(raw.min()), int(raw.max())

        # Dequantize INT8 output
        if raw.dtype in (np.int8, np.uint8):
            raw = (raw.astype(np.float32) - self.out_zp) * self.out_scale

        # Shape: (84, 2100) → transpose to (2100, 84)
        if len(raw.shape) == 2 and raw.shape[0] < raw.shape[1]:
            raw = raw.T

        # INT8 edgetpu model outputs NORMALIZED bbox coords [0,1], not pixels.
        # (scale=0.004919 × 255 = 1.254 max — can't represent pixel values like 320)
        # Scale first 4 columns (cx, cy, w, h) to pixel coordinates.
        raw[:, :4] *= sz

        self._detect_count += 1
        top_confs = []
        valid_boxes = 0

        dets = []
        for row in raw:
            if len(row) < 6:
                continue
            cx, cy, w, h = float(row[0]), float(row[1]), float(row[2]), float(row[3])
            if w < 2 or h < 2:
                continue
            valid_boxes += 1

            probs = row[4:]
            cls = int(np.argmax(probs))
            conf = float(probs[cls])
            name = COCO[cls] if cls < len(COCO) else f'cls{cls}'
            top_confs.append((conf, cls, name))

            if conf < self.conf or cls not in SURV:
                continue

            dets.append({
                'label': LABELS.get(name, 'unknown'),
                'className': name,
                'score': round(conf, 3),
                'box': {
                    'x': round((cx - w / 2 - px) / scale / ow, 4),
                    'y': round((cy - h / 2 - py) / scale / oh, 4),
                    'w': round(w / scale / ow, 4),
                    'h': round(h / scale / oh, 4),
                }
            })

        # Diagnostic log every 10th frame
        if self._detect_count % 10 == 1:
            top_confs.sort(reverse=True)
            top5 = ', '.join(f'{n}={c:.3f}' for c, _, n in top_confs[:5])
            log.info(f'[diag] shape={raw.shape} raw=[{raw_min}..{raw_max}] '
                     f'boxes={valid_boxes} dets={len(dets)} top5: {top5}')

        # Save debug state
        top_confs.sort(reverse=True)
        self._last_debug = {
            'shape': list(raw.shape),
            'raw_range': [raw_min, raw_max],
            'valid_boxes': valid_boxes,
            'detections': len(dets),
            'image_size': [ow, oh],
            'input_size': sz,
            'top10': [{'class': n, 'cls_id': c, 'conf': round(cf, 4)}
                      for cf, c, n in top_confs[:10]],
        }

        # NMS
        dets.sort(key=lambda d: d['score'], reverse=True)
        keep = []
        for d in dets:
            if not any(d['className'] == k['className'] and _iou(d['box'], k['box']) > 0.5 for k in keep):
                keep.append(d)
        return keep


def _iou(a, b):
    x1, y1 = max(a['x'], b['x']), max(a['y'], b['y'])
    x2 = min(a['x'] + a['w'], b['x'] + b['w'])
    y2 = min(a['y'] + a['h'], b['y'] + b['h'])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    union = a['w'] * a['h'] + b['w'] * b['h'] - inter
    return inter / union if union > 0 else 0


# ═══════════════════════════════════════════════════════════════
# DetectLoop — RTSP reader thread + Coral inference thread
#
# Two threads:
#   Reader:  cap.read() continuously, stores latest frame (drains buffer)
#   Detect:  takes latest frame, runs inference, publishes results
#
# This ensures detect always works on the freshest frame,
# never processes stale buffered frames, no lag accumulation.
# ═══════════════════════════════════════════════════════════════

class DetectLoop:
    def __init__(self, engine, rtsp_base, max_fps=15, push_url=None):
        self.engine = engine
        self.rtsp_base = rtsp_base.rstrip('/')
        self.max_fps = max_fps
        self.push_url = push_url
        self.camera = None
        self._run = False
        self._detect_thread = None
        self._reader_thread = None
        self._lock = threading.Lock()
        self._last = {'camera': None, 'detections': [], 'ts': 0, 'inferenceMs': 0, 'fps': 0}
        self._fps_t = []
        self._cap = None
        self._cap_closing = False
        # Latest frame from reader thread
        self._frame = None
        self._frame_num = 0
        self._frame_lock = threading.Lock()

    @property
    def last(self):
        with self._lock:
            return dict(self._last)

    def start(self, cam):
        with self._lock:
            self.camera = cam
            if self._run:
                log.info(f'Switched to {cam}')
                return
        self._run = True
        self._detect_thread = threading.Thread(target=self._detect_loop, daemon=True)
        self._detect_thread.start()
        log.info(f'Started on {cam}')

    def stop(self):
        self._run = False
        # Wait for reader to stop before releasing cap
        if self._reader_thread and self._reader_thread.is_alive():
            self._reader_thread.join(timeout=2)
        self._reader_thread = None
        self._release_cap()
        with self._frame_lock:
            self._frame = None
            self._frame_num = 0
        with self._lock:
            self.camera = None
            self._last = {'camera': None, 'detections': [], 'ts': 0, 'inferenceMs': 0, 'fps': 0}
        log.info('Stopped')

    def _release_cap(self):
        old = self._cap
        self._cap = None
        if old:
            def _bg_release():
                try:
                    old.release()
                except:
                    pass
            threading.Thread(target=_bg_release, daemon=True).start()
            time.sleep(0.3)

    def _open_cap(self, cam):
        self._release_cap()
        url = f'{self.rtsp_base}/{cam}'
        log.info(f'RTSP connecting: {url}')
        os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = 'rtsp_transport;tcp'
        cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
        if cap.isOpened():
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 2)
            self._cap = cap
            log.info(f'RTSP connected (TCP): {url}')
            return True
        else:
            log.warning(f'RTSP failed to open: {url}')
            try:
                cap.release()
            except:
                pass
            return False

    # ── Reader thread: drains RTSP buffer, keeps latest frame ──

    def _start_reader(self):
        """Start reader thread for current cap."""
        if self._reader_thread and self._reader_thread.is_alive():
            return
        self._reader_thread = threading.Thread(target=self._reader_loop, daemon=True)
        self._reader_thread.start()

    def _reader_loop(self):
        """Continuously read frames, store only the latest."""
        cap = self._cap  # local ref — survives _release_cap setting self._cap = None
        drops = 0
        while self._run and cap and cap.isOpened() and not self._cap_closing:
            ret, frame = cap.read()
            if not ret:
                drops += 1
                if drops > 30:
                    log.warning('Reader: too many failed reads, stopping')
                    break
                time.sleep(0.01)
                continue
            drops = 0
            with self._frame_lock:
                self._frame = frame
                self._frame_num += 1
        log.info('Reader thread exited')

    def _get_latest_frame(self):
        """Get latest frame + number (non-blocking)."""
        with self._frame_lock:
            return self._frame, self._frame_num

    def _push(self, data):
        """Fire-and-forget POST to backend ws-hub."""
        try:
            body = json.dumps(data).encode()
            req = urllib.request.Request(
                self.push_url,
                data=body,
                headers={'Content-Type': 'application/json'},
                method='POST'
            )
            urllib.request.urlopen(req, timeout=1)
        except Exception:
            pass  # non-critical, don't block inference

    # ── Detect thread: inference on latest frames ──

    def _detect_loop(self):
        interval = 1.0 / self.max_fps
        reconnect_delay = 1.0
        current_cam = None
        last_processed_num = 0

        while self._run:
            with self._lock:
                cam = self.camera

            if not cam:
                time.sleep(0.1)
                continue

            # Camera changed → reconnect
            if cam != current_cam:
                # Signal reader to stop, then wait, then release cap
                self._cap_closing = True
                if self._reader_thread and self._reader_thread.is_alive():
                    self._reader_thread.join(timeout=3)
                self._reader_thread = None
                self._release_cap()
                self._cap_closing = False
                with self._frame_lock:
                    self._frame = None
                    self._frame_num = 0
                last_processed_num = 0
                current_cam = cam

            # Open RTSP if not connected
            if not self._cap or not self._cap.isOpened():
                if not self._open_cap(cam):
                    time.sleep(reconnect_delay)
                    reconnect_delay = min(reconnect_delay * 1.5, 10.0)
                    continue
                reconnect_delay = 1.0
                self._start_reader()

            t0 = time.monotonic()

            # Get latest frame from reader
            frame, num = self._get_latest_frame()

            if frame is None or num == last_processed_num:
                # No new frame yet — brief wait
                time.sleep(0.005)
                continue

            last_processed_num = num

            # Convert BGR → RGB → PIL
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            pil_img = Image.fromarray(frame_rgb)

            # Inference
            try:
                ti = time.monotonic()
                dets = self.engine.detect(pil_img)
                ms = round((time.monotonic() - ti) * 1000, 1)
                now = time.monotonic()
                self._fps_t = [t for t in self._fps_t if now - t < 1.0]
                self._fps_t.append(now)
                with self._lock:
                    self._last = {
                        'camera': cam, 'detections': dets,
                        'ts': int(time.time() * 1000),
                        'inferenceMs': ms, 'fps': len(self._fps_t),
                    }
                # Push to backend (fire-and-forget)
                if self.push_url:
                    self._push(self._last)
            except Exception as e:
                log.error(f'Detect error: {e}')
                time.sleep(0.2)

            # FPS limiter
            elapsed = time.monotonic() - t0
            if elapsed < interval:
                time.sleep(interval - elapsed)


# ═══════════════════════════════════════════════════════════════
# HTTP API — start/stop/results/debug/health
# ═══════════════════════════════════════════════════════════════

class API(BaseHTTPRequestHandler):
    loop = None
    engine = None

    def do_GET(self):
        if self.path == '/health':
            e = self.engine
            self._json(200, {
                'status': 'ok',
                'version': VERSION,
                'backend': 'coral' if e and e.ready else 'none',
                'coral_devices': e.device_count if e else 0,
                'model': e.model_name if e else None,
                'ready': e.ready if e else False,
            })
        elif self.path == '/results':
            self._json(200, self.loop.last if self.loop else {})
        elif self.path == '/debug':
            e = self.engine
            debug = dict(getattr(e, '_last_debug', {})) if e else {}
            debug['conf_thresh'] = e.conf if e else None
            debug['quant_in'] = [e.in_scale, e.in_zp] if e else None
            debug['quant_out'] = [e.out_scale, e.out_zp] if e else None
            debug['camera'] = self.loop.camera if self.loop else None
            debug['running'] = self.loop._run if self.loop else False
            self._json(200, debug)
        elif self.path == '/status':
            e = self.engine
            self._json(200, {
                'available': e.ready if e else False,
                'running': self.loop._run if self.loop else False,
                'camera': self.loop.camera if self.loop else None,
                'backend': 'coral' if e and e.ready else 'none',
                'coral': e.ready if e else False,
            })
        else:
            self._json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path == '/start':
            b = self._body()
            cam = b.get('camera')
            if not cam:
                return self._json(400, {'error': 'camera required'})
            if not self.engine or not self.engine.ready:
                return self._json(503, {'error': 'coral not ready'})
            self.loop.start(cam)
            self._json(200, {'ok': True, 'camera': cam})
        elif self.path == '/stop':
            if self.loop:
                self.loop.stop()
            self._json(200, {'ok': True})
        else:
            self._json(404, {'error': 'not found'})

    def _body(self):
        n = int(self.headers.get('Content-Length', 0))
        if n == 0:
            return {}
        try:
            return json.loads(self.rfile.read(n))
        except:
            return {}

    def _json(self, code, data):
        b = json.dumps(data).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(b))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *a):
        pass


# ═══════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════

def find_model():
    for pattern in ['*_edgetpu.tflite', '*.tflite']:
        found = sorted(glob.glob(f'/models/{pattern}'))
        if found:
            return found[0]
    return None


def main():
    rtsp_base = os.environ.get('GO2RTC_RTSP', 'rtsp://go2rtc:8554')
    model     = os.environ.get('MODEL_PATH', '') or find_model()
    max_fps   = int(os.environ.get('MAX_FPS', '15'))
    conf      = float(os.environ.get('CONF_THRESH', '0.3'))
    port      = int(os.environ.get('DETECT_PORT', '3001'))
    dev_idx   = int(os.environ.get('CORAL_DEVICE', '0'))
    push_url  = os.environ.get('BACKEND_PUSH_URL', 'http://backend:3000/internal/detect')

    log.info(f'oko-detect v{VERSION}')
    log.info(f'  rtsp:    {rtsp_base}')
    log.info(f'  model:   {model or "(none)"}')
    log.info(f'  max_fps: {max_fps}, conf: {conf}')
    log.info(f'  push:    {push_url}')

    if not model:
        log.error('No model file in /models/. Exiting.')
        sys.exit(1)

    engine = CoralEngine(model, conf)
    ok = engine.init(dev_idx)
    if not ok:
        log.error('Coral init failed. Container will restart for DFU→APP retry.')
        sys.exit(1)

    loop = DetectLoop(engine, rtsp_base, max_fps, push_url=push_url)
    API.loop = loop
    API.engine = engine

    server = HTTPServer(('0.0.0.0', port), API)
    log.info(f'API on :{port} — ready')

    def shutdown(sig, frame):
        log.info('Shutting down...')
        loop.stop()
        server.shutdown()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    server.serve_forever()


if __name__ == '__main__':
    main()
