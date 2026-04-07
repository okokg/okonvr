# OKO NVR — AI Models

Drop `.onnx` YOLO model files here. They'll appear in the Watch Mode model selector.

## Export from Google Colab

```python
!pip install ultralytics
from ultralytics import YOLO
model = YOLO("yolo11s.pt")  # or yolov8s, yolo11m, etc.
model.export(format="onnx", opset=12, simplify=True)
# Download the .onnx file
```

## Recommended

| Model   | File           | Size | mAP  | Speed   |
|---------|----------------|------|------|---------|
| YOLO11s | yolo11s.onnx   | 18MB | 46%  | ~350ms  |
| YOLOv8s | yolov8s.onnx   | 23MB | 44%  | ~400ms  |
| YOLO11m | yolo11m.onnx   | 39MB | 51%  | ~800ms  |
