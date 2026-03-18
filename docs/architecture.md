# Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│ Browser                                                      │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Frontend (ES Modules)                                │    │
│  │  app.js → grid.js → camera-view.js → player.js     │    │
│  └────────┬───────────────────────────────┬────────────┘    │
│           │ REST API                       │ WebRTC/MSE      │
└───────────┼───────────────────────────────┼──────────────────┘
            │ TCP :80                        │ UDP :8555
┌───────────▼───────────────────────────────▼──────────────────┐
│ Docker Compose                                                │
│                                                               │
│  ┌──────────┐    ┌──────────┐    ┌──────────────────────┐   │
│  │  nginx   │───►│ backend  │    │      go2rtc          │   │
│  │  :80     │    │ :3000    │    │  :1984 (API)         │   │
│  │          │───►│ (Fastify)│    │  :8555 (WebRTC)      │   │
│  └──────────┘    └────┬─────┘    └──────────┬───────────┘   │
│                       │                      │               │
│                  ┌────▼─────┐          ┌─────▼──────────┐   │
│                  │ SQLite   │          │ RTSP to NVRs   │   │
│                  │ /data/   │          │ (live+playback)│   │
│                  └──────────┘          └────────────────┘   │
└───────────────────────────────────────────────────────────────┘
```

## Backend (TypeScript / Fastify)

```
backend/src/
├── index.ts                 # bootstrap, discovery, probe
├── config.ts                # YAML loader, channel parser
├── db.ts                    # SQLite setup + migrations
├── providers/
│   ├── types.ts             # NvrProvider interface
│   ├── index.ts             # createProvider() factory
│   ├── hikvision.ts         # Hikvision URLs + ISAPI discovery
│   ├── dahua.ts             # Dahua URLs + CGI discovery
│   └── generic.ts           # User-defined URLs
├── services/
│   ├── camera-registry.ts   # Maps camera ID → provider
│   ├── stream-manager.ts    # go2rtc stream lifecycle
│   ├── codec-prober.ts      # ffprobe + SQLite cache
│   ├── go2rtc-config.ts     # Generates go2rtc.yaml
│   ├── config-watcher.ts    # Hot reload (fs.watch)
│   └── config-store.ts      # UI config singleton
├── routes/
│   ├── cameras.ts           # GET/PUT cameras
│   ├── playback.ts          # POST/DELETE playback streams
│   ├── hd-stream.ts         # POST/DELETE HD streams
│   └── health.ts            # Health, config, reset-codecs
└── utils/
    ├── url-encoder.ts       # go2rtc URL encoding
    └── http-client.ts       # HTTP with Basic+Digest auth
```

### NVR Provider Pattern

All NVR-specific logic is behind the `NvrProvider` interface:

```typescript
interface NvrProvider {
  getLiveUrl(camera): string           // sub-stream RTSP
  getProbeUrl(camera): string          // main-stream RTSP (for ffprobe)
  getPlaybackUrl(camera, start, end): string  // archive RTSP
  buildPlaybackSource(options): { source, forceMSE }
  generateStreamConfig(cameras): Record<string, string>
  discoverChannels(): Promise<DiscoveredCamera[] | null>
}
```

Adding a new NVR vendor: create `providers/vendor.ts`, implement the interface, register in `providers/index.ts`.

### Playback Strategy (codec-aware)

| Video | Resolution | Strategy | Protocol |
|-------|-----------|----------|----------|
| H.264 | Original | Raw RTSP passthrough | WebRTC |
| H.264 | 720p etc | ffmpeg resize | WebRTC |
| H.265 | Original | Raw RTSP passthrough | MSE |
| H.265 | 720p etc | ffmpeg transcode H.265→H.264 | WebRTC |

Audio: PCMU/PCMA → `#audio=copy`, AAC → MSE only, G.722/unknown → dropped.

### Stream Lifecycle

**Live (SD):** Created at startup in `go2rtc.yaml`. Permanent.

**Live (HD):** Created on demand via `POST /hd-stream`. Uses main-stream RTSP. Deleted on SD switch or page unload.

**Playback:** Created on demand via `POST /playback`. Uses archive RTSP with time parameters. Deleted on live switch, seek (re-created), or page unload.

## Frontend (ES Modules)

```
web/
├── index.html           # HTML shell
├── css/styles.css       # All styles, themes
└── js/
    ├── config.js        # Constants
    ├── api.js           # ApiClient (REST)
    ├── player.js        # CamPlayer (WebRTC + MSE)
    ├── camera-view.js   # CameraView (DOM, playback, HD, audio)
    ├── grid.js          # CameraGrid (layout, filters, keyboard nav)
    ├── notifications.js # Browser notifications
    └── app.js           # App orchestrator
```

### Data Flow

```
oko.yaml → backend → GET /config/ui → app.js._applyUiConfig()
                    → GET /cameras   → grid.build() → CameraView[]
                                                     → CamPlayer (WebRTC)
                                                     → go2rtc (RTSP)
```

### Auto-fit Grid

The auto grid calculates optimal columns to fit all visible cameras on screen:

1. Count visible cameras
2. For columns 1→20, calculate if `rows × cellHeight ≤ availableHeight`
3. First match = minimum columns = largest cameras
4. Recalculates on: window resize, filter change, compact toggle

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/cameras` | List cameras with metadata |
| PUT | `/cameras/:id` | Update label/group |
| PUT | `/cameras/order` | Save camera order |
| POST | `/playback` | Create archive playback stream |
| DELETE | `/playback/:stream` | Stop playback stream |
| POST | `/hd-stream` | Create HD (main-stream) |
| DELETE | `/hd-stream/:camera` | Stop HD stream |
| GET | `/config/ui` | UI configuration from oko.yaml |
| GET | `/health` | Health check |
| POST | `/reset-codecs` | Clear codec cache, force re-probe |

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

Codec data persists across restarts. Background probe runs 10s after startup.

## Docker Volumes

| Volume | Mount | Purpose |
|--------|-------|---------|
| backend-data | /data | SQLite database |
| go2rtc-config | /config/go2rtc | Generated go2rtc.yaml |

`oko.yaml` mounted read-only from host: `./oko.yaml:/config/oko.yaml:ro`

Dev mode: `backend/src/` mounted read-only, tsx watch auto-reloads.
