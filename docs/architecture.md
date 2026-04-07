# Architecture

## System Overview

```
┌──────────────────────────────────────────────────────────────────┐
│ Browser                                                           │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │ Frontend (ES Modules)                                      │   │
│  │  app.js → CameraGrid → CameraView → CamPlayer            │   │
│  │           WatchMode → MotionDetector + ObjectClassifier    │   │
│  └──────┬───────────────────┬───────────────┬────────────────┘   │
│         │ REST              │ WebRTC/MSE     │ WebSocket         │
└─────────┼───────────────────┼───────────────┼────────────────────┘
          │ TCP :80           │ UDP :8555      │ /backend/ws
┌─────────▼───────────────────▼───────────────▼────────────────────┐
│ Docker Compose                                                    │
│                                                                   │
│  ┌──────────┐   ┌───────────┐   ┌────────────────────────┐      │
│  │  nginx   │──►│  backend  │   │       go2rtc            │      │
│  │  :80     │   │  :3000    │   │  :1984 (API)            │      │
│  │          │──►│  (Fastify) │   │  :8555 (WebRTC)         │      │
│  └──────────┘   └─────┬─────┘   └───────────┬────────────┘      │
│                       │                       │                   │
│                  ┌────▼─────┐          ┌─────▼──────────┐        │
│                  │ SQLite   │          │ RTSP to NVRs   │        │
│                  │ /data/   │          │ (live+playback) │        │
│                  └──────────┘          └────────────────┘        │
│                                                                   │
│  ┌──────────────────────────────────────────┐  optional          │
│  │  detect (--profile coral)                 │                    │
│  │  :3001 — Coral TPU inference              │                    │
│  │  → POST /internal/detect → WS broadcast   │                    │
│  └──────────────────────────────────────────┘                    │
└───────────────────────────────────────────────────────────────────┘
```

Four Docker containers (detect is optional — requires `--profile coral`):
- **backend** — TypeScript/Fastify: NVR management, config, codec probing, WS hub
- **go2rtc** — WebRTC/MSE media server, RTSP connections to NVRs
- **nginx** — reverse proxy with basic auth, static frontend
- **detect** — Python + Google Coral TPU object detection (optional)

## Backend (TypeScript / Fastify)

```
backend/src/
├── index.ts                 # bootstrap, discovery, probe, talkback detection
├── config.ts                # YAML loader, channel parser, snapshot/playback config
├── db.ts                    # SQLite setup + migrations
├── providers/
│   ├── types.ts             # NvrProvider interface, CameraConfig, CodecInfo
│   ├── index.ts             # createProvider() factory
│   ├── hikvision.ts         # ISAPI discovery, TwoWayAudio, snapshot URLs
│   ├── dahua.ts             # CGI discovery, direct camera RTSP for talkback
│   └── generic.ts           # User-defined URLs
├── services/
│   ├── camera-registry.ts   # Camera ID → provider map, detectAllTalkback()
│   ├── stream-manager.ts    # go2rtc stream lifecycle (create/delete/reap)
│   ├── codec-prober.ts      # ffprobe + SQLite cache
│   ├── go2rtc-config.ts     # Generates go2rtc.yaml from oko.yaml
│   ├── config-watcher.ts    # Hot reload (fs.watch on oko.yaml)
│   ├── config-store.ts      # UI config singleton
│   ├── nvr-health.ts        # NVR connectivity monitoring + auto-rediscovery
│   ├── snapshot-cache.ts    # Snapshot preloading (native NVR API or go2rtc)
│   ├── smart-events.ts      # SMD event queries (Dahua RPC2)
│   ├── server-activity.ts   # Server activity tracking (startup phases)
│   ├── ws-hub.ts            # Central WebSocket hub (detect + stats + events)
│   ├── detect-ws.ts         # Raw WS implementation for detect (legacy)
│   └── detect-sse.ts        # SSE stream for detect results (alternative)
├── routes/
│   ├── cameras.ts           # GET /cameras, PUT /cameras/:id, PUT /cameras/order
│   ├── playback.ts          # POST/DELETE/GET /playback
│   ├── hd-stream.ts         # POST/DELETE /hd-stream
│   ├── talkback.ts          # POST /talkback/:camera/start, DELETE .../stop
│   ├── playback-thumbnail.ts # GET /playback-thumbnail/:cameraId
│   ├── snapshots.ts         # GET /snapshot/:cameraId
│   ├── events.ts            # GET /events/:cameraId?date=YYYY-MM-DD
│   ├── models.ts            # GET /models, GET /models/:filename
│   ├── detect.ts            # GET/POST /detect/* (proxy to Python service)
│   ├── stats.ts             # GET /stats (streams, system, WS hub)
│   └── health.ts            # GET /health, /config/ui, POST /reset-codecs
└── utils/
    ├── http-client.ts       # HTTP with Basic + Digest auth
    ├── dahua-rpc.ts         # Dahua RPC2 client (SmdDataFinder)
    ├── onnx-metadata.ts     # ONNX model metadata parser
    └── url-encoder.ts       # go2rtc URL encoding
```

### NVR Provider Pattern

All NVR-specific logic is behind the `NvrProvider` interface:

```typescript
interface NvrProvider {
  getLiveUrl(camera): string              // sub-stream RTSP
  getProbeUrl(camera): string             // main-stream RTSP (for ffprobe)
  getPlaybackUrl(camera, start, end): string
  getSnapshotUrl(camera): string          // HTTP JPEG snapshot
  buildPlaybackSource(options): PlaybackResult
  generateStreamConfig(cameras): Record<string, string>
  discoverChannels(): Promise<DiscoveredCamera[] | null>
  detectTalkback(): Promise<Set<number>>  // channels with two-way audio
  getTalkbackSource(camera): string | null // backchannel RTSP URL
}
```

Adding a new NVR vendor: create `providers/vendor.ts`, implement the interface, register in `providers/index.ts`.

### Playback Strategy (codec-aware)

| Video | Resolution | Browser H.265 | Strategy | Protocol |
|-------|-----------|---------------|----------|----------|
| H.264 | Original | — | Raw RTSP passthrough | WebRTC |
| H.264 | 720p etc | — | ffmpeg resize | WebRTC |
| H.265 | Original | ✓ (Chrome 136+) | Raw RTSP passthrough | WebRTC |
| H.265 | Original | ✗ (Firefox etc) | Raw RTSP passthrough | MSE |
| H.265 | 720p etc | — | ffmpeg transcode H.265→H.264 | WebRTC |

H.265 WebRTC support is auto-detected via `RTCRtpReceiver.getCapabilities('video')`. Requires hardware decoder (GPU). Supported on Chrome 136+, Safari 18+. Not supported on Firefox.

Audio: PCMU/PCMA → `#audio=copy`, AAC → MSE only, G.722/unknown → dropped.

### Codec Negotiation (SDP)

The player sets codec preferences in the SDP offer based on browser capabilities:
- H.265 supported → order: `H.265, H.264` — go2rtc matches source codec automatically
- H.265 not supported → order: `H.264` only — HEVC sources fall back to MSE

Both H.264 and H.265 sources work seamlessly through a single WebRTC connection on modern browsers. No per-camera configuration needed.

### Stream Lifecycle

**Live (SD):** Created at startup in `go2rtc.yaml`. Permanent. Reaper checks every 15s.

**Live (HD):** Created on demand via `POST /hd-stream`. Uses main-stream RTSP. Deleted on SD switch or page unload. 30s TTL reaper.

**Playback:** Created on demand via `POST /playback`. Uses archive RTSP with time parameters. Deleted on live switch, seek (re-created), or page unload. 30s TTL reaper.

### WebSocket Hub

Central WS at `/ws` (via nginx: `/backend/ws`) handles:
- **detect** channel — Coral detection results push (from Python → browser)
- **stats** channel — reserved for live stats
- **event** channel — reserved for real-time events

Clients subscribe to channels: `{ch: "subscribe", channels: ["detect"]}`.
Detect service POSTs results to `/internal/detect` → broadcast to subscribers.

## Frontend (ES Modules)

```
packages/oko-player/src/           ← source of truth (npm package structure)
├── core/
│   ├── camera-player.js           — CamPlayer: WebRTC + MSE, connection pool
│   ├── camera-view.js             — CameraView: video ownership, UI state, HUD
│   ├── camera-grid.js             — CameraGrid: layout, filtering, drag-drop, lazy
│   ├── feature.js                 — Feature base class (attach/detach lifecycle)
│   └── utils.js                   — Shared utilities (_pad, _hms)
├── features/
│   ├── playback.js                — Archive playback, seek timeline, SMD events
│   ├── quality.js                 — SD/HD switching
│   ├── talkback.js                — Two-way audio (PTT + lock modes)
│   ├── zoom.js                    — Digital zoom with minimap
│   ├── seek-thumbnail.js          — Thumbnail preview on timeline hover
│   └── motion-detector.js         — Per-camera motion detection (feature adapter)
├── services/
│   ├── watch-mode.js              — Motion + AI orchestrator (grid-wide)
│   ├── motion-detector.js         — Frame diff motion detector (canvas-based)
│   └── object-classifier.js       — AI classification (YOLO ONNX + MediaPipe)
├── embed/
│   └── oko-embed.js               — Standalone embed player (zero deps)
├── api.js                         — ApiClient (REST wrapper)
├── config.js                      — Constants
└── index.js                       — Package exports

web/js/oko-player → ../../packages/oko-player/src  (symlink in git, copy in zip)
web/js/app.js                      — OkoApp: config, NVR recovery, keyboard, WatchMode
web/css/
├── styles.css                     — Global styles, themes, header
├── player.css                     — Camera tiles, HUD, SMD markers
└── app.css                        — App shell, watch mode panel
```

### Data Flow

```
oko.yaml → backend → GET /config/ui → app.js._applyUiConfig()
                    → GET /cameras   → grid.build() → CameraView[]
                                                     → CamPlayer (WebRTC)
                                                     → go2rtc (RTSP)
                    → GET /events/:id → playback timeline markers
                    → WS /ws         → detect results → WatchMode overlay
```

### Feature System

CameraView uses a plugin architecture. Features extend `Feature` base class:

```javascript
class PlaybackFeature extends Feature {
  attach(view)  { /* wire DOM, subscribe events */ }
  detach(view)  { /* cleanup */ }
}
```

Features are registered per-view: `view._features = [PlaybackFeature, QualityFeature, ...]`.
Each feature manages its own state slice in `view._state`.

### Watch Mode (Motion + AI Detection)

Two-stage pipeline orchestrated by `WatchMode`:

1. **MotionDetector** — frame diff on canvas, runs on all grid cameras every 1s
2. **ObjectClassifier** — AI classification, runs only on cameras with motion

When a camera is opened fullscreen with Watch Mode active:
- Server-side: WS → backend → Coral TPU inference (if `--profile coral`)
- Browser-side fallback: MediaPipe EfficientDet-Lite2 (WASM, CDN)
- Overlay canvas draws bounding boxes with tracking

Type filtering controls highlighting: Human ☑ Vehicle ☑ Animal ☑ Motion ☑.
If Coral is unavailable (no `--profile coral`), falls back to browser-side automatically.

### Auto-fit Grid

Calculates optimal columns to fit all visible cameras on screen:
1. Count visible cameras
2. For columns 1→20, calculate if `rows × cellHeight ≤ availableHeight`
3. First match = minimum columns = largest cameras
4. Recalculates on: window resize, filter change, compact toggle

## API Endpoints

All endpoints are under `/backend/` via nginx proxy.

### Cameras

| Method | Path | Description |
|--------|------|-------------|
| GET | `/cameras` | List cameras with metadata, codec info, talkback flag |
| PUT | `/cameras/:id` | Update label and/or group |
| PUT | `/cameras/order` | Save camera sort order |

### Streaming

| Method | Path | Description |
|--------|------|-------------|
| POST | `/hd-stream` | Create HD (main-stream) for a camera |
| DELETE | `/hd-stream/:camera` | Stop HD stream |
| POST | `/playback` | Create archive playback stream |
| DELETE | `/playback/:stream` | Stop specific playback stream |
| DELETE | `/playback` | Stop all playback streams |
| GET | `/playback` | List active playback streams |

### Media

| Method | Path | Description |
|--------|------|-------------|
| GET | `/snapshot/:cameraId` | Camera snapshot (JPEG, cached) |
| GET | `/playback-thumbnail/:cameraId` | Archive thumbnail at timestamp |
| GET | `/events/:cameraId?date=YYYY-MM-DD` | Smart motion events for timeline |

### Talkback

| Method | Path | Description |
|--------|------|-------------|
| POST | `/talkback/:camera/start` | Start two-way audio session |
| DELETE | `/talkback/:camera/stop` | Stop talkback |
| GET | `/talkback/active` | List active talkback sessions |

### AI Models

| Method | Path | Description |
|--------|------|-------------|
| GET | `/models` | List available .onnx/.tflite models |
| GET | `/models/:filename` | Download model file (streaming) |

### Detection (optional, requires `--profile coral`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/detect/status` | Coral service availability |
| POST | `/detect/start` | Start detection on a camera |
| POST | `/detect/stop` | Stop detection |
| GET | `/detect/results` | Latest detection results |

### System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check + version |
| GET | `/health/nvrs` | NVR connectivity status |
| GET | `/config/ui` | UI configuration from oko.yaml |
| GET | `/stats` | Streams, system metrics, WS hub stats |
| POST | `/reset-codecs` | Clear codec cache, force re-probe |
| POST | `/cleanup-session` | Clean orphaned session streams |
| POST | `/recover-streams` | Re-create missing base streams |

### WebSocket

| Path | Description |
|------|-------------|
| `/ws` | Central WebSocket hub (detect/stats/events channels) |
| `/internal/detect` | POST endpoint — detect service pushes results here |

## Database (SQLite)

Single table `cameras`:

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | Camera ID (D1, M4...) |
| label | TEXT | User-set label |
| group | TEXT | NVR name (auto-set) |
| sort_order | INTEGER | Grid position |
| main_codec | TEXT | h264 / hevc (from probe) |
| main_audio | TEXT | pcmu / pcma / aac / none |

Codec data persists across restarts. Background probe runs 10s after startup, re-probes every 6 hours.

## Docker Volumes

| Volume | Mount | Purpose |
|--------|-------|---------|
| backend-data | /data | SQLite database |
| go2rtc-config | /config/go2rtc | Generated go2rtc.yaml |

Host mounts: `oko.yaml` (ro), `models/` (ro), `web/` (static), `packages/oko-player/src/` (ro).

Dev mode: `backend/src/` mounted read-only, tsx watch auto-reloads.
