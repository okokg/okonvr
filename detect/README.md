# OKO Detect — AI Object Detection Service

Server-side detection with auto-backend selection:
TensorRT (Jetson) → CUDA → Coral TPU → CPU.

## Quick Start

### Jetson (recommended)

```bash
# Place model
cp yolo11n.pt models/

# Start (first run exports to TensorRT — takes ~5 min, then cached)
docker compose --profile jetson up -d --build

# Verify
curl http://localhost:8888/backend/detect/health
# → {"status":"ok","backend":"tensorrt","ready":true}
```

### Coral USB

```bash
# Export + compile model for Edge TPU
# (see "Model Export" below)
cp yolo11n_int8_edgetpu.tflite models/

docker compose --profile coral up -d --build
```

### Performance

| Backend         | Inference | FPS    | 46 cameras? |
|----------------|-----------|--------|-------------|
| TensorRT (Orin) | ~3ms      | 30 fps | Yes, all    |
| CUDA (Jetson)   | ~15ms     | 15 fps | Yes         |
| Coral USB       | ~8ms      | 15 fps | 1 at a time |
| CPU fallback    | ~200ms    | 5 fps  | 1 at a time |

## Model Export

### For Jetson (easiest)

Just place a `.pt` file — auto-exports to TensorRT on first run:
```bash
cp yolo11n.pt models/
# First inference triggers: .pt → .engine (TensorRT FP16)
```

Or pre-export in Colab:
```python
from ultralytics import YOLO
YOLO("yolo11n.pt").export(format="engine", half=True, device=0)
```

### For Coral

```python
from ultralytics import YOLO
YOLO("yolo11n.pt").export(format="tflite", int8=True, imgsz=320)
```
Then compile: `edgetpu_compiler yolo11n_int8.tflite`

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/backend/detect/status` | GET | Backend + availability |
| `/backend/detect/health` | GET | Health check |
| `/backend/detect/start`  | POST | `{"camera":"D26"}` |
| `/backend/detect/stop`   | POST | Stop detection |
| `/backend/detect/results` | GET | Latest detections + FPS |

## Running OKO on Jetson

Full NVR on Jetson Orin Nano (8GB):

| Component | RAM | Notes |
|-----------|-----|-------|
| go2rtc    | ~200M | 46 RTSP streams |
| backend   | ~120M | Node.js API |
| nginx     | ~10M  | Static + proxy |
| oko-detect| ~800M | YOLO11n TensorRT |
| **Total** | **~1.3G** | Fits in 8GB easily |
