# OKO NVR

Zero-storage WebRTC surveillance viewer with NVR archive playback.

## Overview

OKO NVR connects to Hikvision and Dahua NVRs via RTSP, streams live video through WebRTC to the browser, and provides interactive archive playback with a seek timeline. No local recording — all video comes directly from the NVR.

**Key features:**
- WebRTC live streaming with sub-stream (SD) and main-stream (HD) switching
- Native H.265/HEVC WebRTC support — no transcoding on Chrome 136+, Safari 18+
- Automatic MSE fallback for browsers without H.265 WebRTC (Firefox)
- NVR archive playback with 24h seek timeline, thumbnail preview, day navigation
- Smart motion events on timeline (Dahua SMD — human/vehicle markers)
- Watch Mode — motion detection + AI object classification (human/vehicle/animal)
- Server-side detection via Google Coral TPU (optional) with browser-side fallback
- Two-way audio (talkback/intercom) — push-to-talk and toggle modes
- Auto-discovery of cameras from Hikvision ISAPI and Dahua CGI APIs
- Multi-NVR support with per-NVR grouping and filtering
- NVR health monitoring with auto-rediscovery on reconnect
- Snapshot preloading — camera previews before video connects
- Audio support (PCMU/PCMA native, AAC via MSE)
- Digital zoom (2×–4×) with minimap and pan
- Embeddable player — single-file WebRTC player for external sites
- Hot reload — edit `oko.yaml`, cameras update without restart
- Full keyboard navigation — 30+ shortcuts, no mouse required
- Dark/light theme, compact mode, auto-fit grid

## H.265/HEVC Support

Automatically detects browser H.265 capability and streams HEVC directly without transcoding.

| Browser | H.265 WebRTC | Fallback |
|---------|-------------|----------|
| Chrome 136+ | ✓ (hardware decode required) | — |
| Safari 18+ | ✓ | — |
| Firefox | ✗ | MSE (auto) |
| Edge 136+ | ✓ (Chromium-based) | — |

## Quick Start

```bash
git clone https://github.com/okokg/okonvr.git
cd okonvr
./setup.sh
```

Edit `oko.yaml` with your NVR credentials:

```yaml
nvrs:
  - name: office
    provider: hikvision
    host: 192.168.0.2
    username: admin
    password: your_password
    id_prefix: "D"
```

Edit `.env` with your server IP:

```env
SERVER_IP=192.168.0.240
HTTP_PORT=80
WEBRTC_PORT=8555
```

Start:

```bash
docker compose up -d
```

With Google Coral TPU (optional):

```bash
docker compose --profile coral up -d
```

Open `http://YOUR_SERVER_IP` in browser.

## Architecture

```
Browser ──TCP:80──► nginx (basic auth) ──► go2rtc:1984 (signaling)
Browser ──UDP:8555──► go2rtc (WebRTC media, DTLS encrypted)
nginx ──► backend:3000 (cameras API, config, WebSocket hub)
detect ──► backend /internal/detect (Coral results push, optional)
```

Three Docker containers (+ optional detect with `--profile coral`):
- **backend** — TypeScript/Fastify, NVR management, go2rtc config, WebSocket hub
- **go2rtc** — WebRTC/MSE media server, connects to NVRs via RTSP
- **nginx** — reverse proxy with basic auth, serves static frontend
- **detect** — Python + Google Coral TPU object detection (optional, `--profile coral`)

## Talkback (Two-Way Audio)

Push-to-talk intercom for cameras with built-in speakers. Works via direct RTSP connection to camera IP (bypasses NVR).

**Supported cameras:** Dahua models with `-AS-` (speaker) or `-PV-` (active deterrence) in model name, Hikvision cameras with TwoWayAudio channels.

**Usage:**
- Press `V` in fullscreen to toggle intercom
- Click mic icon in status bar
- Hold PTT button (right side) for push-to-talk
- Double-click PTT to lock (hands-free mode)

Auto-detection from NVR API, or manual override:
```yaml
nvrs:
  - name: cameras
    provider: dahua
    talkback_channels: [5, 8, 10]
```

## Watch Mode (Motion + AI Detection)

Real-time motion detection and AI object classification across all cameras.

**Two-stage pipeline:**
1. Motion detector (frame diff) scans all grid cameras every 1s
2. AI classifier runs only on cameras with motion — identifies humans, vehicles, animals

**Detection engines:**
- **Google Coral TPU** — server-side, ~8ms inference (requires `--profile coral`)
- **MediaPipe EfficientDet** — browser-side WASM fallback (no hardware needed)
- Automatic fallback: if Coral is unavailable, browser-side detection activates

**Usage:** Press `W` or click the Watch button in the header. Adjust sensitivity (1–10), filter by type (Human/Vehicle/Animal/Motion). In fullscreen, AI overlay draws bounding boxes over detected objects.

## Keyboard Shortcuts

See [docs/keyboard-shortcuts.md](docs/keyboard-shortcuts.md) for full reference (30+ shortcuts).

| Key | Action |
|-----|--------|
| ←→↑↓ | Navigate cameras in grid |
| Enter / Space | Open / close camera |
| W | Toggle Watch Mode |
| H | Toggle SD/HD stream |
| F | Native fullscreen |
| M | Mute / unmute |
| V | Toggle intercom |
| P | Playback panel |
| J / K | Seek ±30s in archive (Shift = ±5m) |
| L | Return to live |
| E | Next smart event (Shift = previous) |
| +/- | Digital zoom |
| Z | Reset zoom |
| C | Compact mode |

## Embed Player

Standalone player for embedding OKO camera streams on external websites. WebRTC + MSE fallback, fullscreen, auto-reconnect — single file, zero dependencies.

```html
<script src="/embed/oko-embed.js"></script>
<div id="cam"></div>
<script>
  OkoEmbed.create('#cam', {
    webrtcUrl: '/cam/gate/webrtc',
    wsUrl:     '/cam/gate/ws',
    snapshot:  '/cam/gate/snapshot',
  });
</script>
```

Security via nginx mapping — external site never sees real camera IDs. See [Embed documentation](docs/embed.md).

## Documentation

- [Configuration Reference](docs/configuration.md) — oko.yaml, .env, all settings
- [Keyboard Shortcuts](docs/keyboard-shortcuts.md) — full hotkey reference
- [Architecture](docs/architecture.md) — technical details, provider pattern, API
- [Deployment](docs/deployment.md) — Docker setup, SSL, auth, production tips
- [NVR Setup](docs/nvr-setup.md) — Hikvision/Dahua optimal settings
- [Embed Player](docs/embed.md) — standalone player for external sites

## Supported NVRs

| Provider | Live | Playback | Discovery | Audio | Talkback | Tested |
|----------|------|----------|-----------|-------|----------|--------|
| Hikvision | ✓ | ✓ | ISAPI | PCMU/PCMA | ISAPI | DS-7732NI-K4 |
| Dahua | ✓ | ✓ | CGI API | PCMU/PCMA/AAC | Direct RTSP | DHI-NVR5216-EI |
| Generic | ✓ | ✓ | Manual | Depends | — | — |

## License

MIT
