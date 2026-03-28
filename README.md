# OKO NVR PLAYER

Zero-storage WebRTC surveillance viewer with NVR archive playback.

## Overview

OKO NVR PLAYER connects to Hikvision and Dahua NVRs via RTSP, streams live video through WebRTC to the browser, and provides interactive archive playback with a seek timeline. No local recording — all video comes directly from the NVR.

**Key features:**
- WebRTC live streaming with sub-stream (SD) and main-stream (HD) switching
- Native H.265/HEVC WebRTC support — no transcoding on Chrome 136+, Safari 18+
- Automatic MSE fallback for browsers without H.265 WebRTC (Firefox)
- NVR archive playback with 24h seek timeline, thumbnail preview, day navigation
- Two-way audio (talkback/intercom) — push-to-talk and toggle modes
- Auto-discovery of cameras from Hikvision ISAPI and Dahua CGI APIs
- Multi-NVR support with per-NVR grouping and filtering
- Audio support (PCMU/PCMA native, AAC via MSE)
- Digital zoom (2×–4×) with minimap and pan
- Hot reload — edit `oko.yaml`, cameras update without restart
- Full keyboard navigation — no mouse required
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
cp oko.yaml.example oko.yaml
cp .env.example .env
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

Open `http://YOUR_SERVER_IP` in browser.

## Architecture

```
Browser ──TCP:80──► nginx (basic auth) ──► go2rtc:1984 (signaling)
Browser ──UDP:8555──► go2rtc (WebRTC media, DTLS encrypted)
nginx ──► backend:3000 (cameras API, config)
```

Three Docker containers:
- **backend** — TypeScript/Fastify, manages NVR connections, generates go2rtc config
- **go2rtc** — WebRTC/MSE media server, connects to NVRs via RTSP
- **nginx** — reverse proxy with basic auth, serves static frontend

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

## Keyboard Shortcuts

See [docs/keyboard-shortcuts.md](docs/keyboard-shortcuts.md) for full reference.

| Key | Action |
|-----|--------|
| ←→↑↓ | Navigate cameras in grid |
| Enter / Space | Open / close camera |
| H | Toggle SD/HD stream |
| F | Native fullscreen |
| M | Mute / unmute |
| V | Toggle intercom |
| P | Playback panel |
| +/- | Digital zoom |
| Z | Reset zoom |
| C | Compact mode |

## Documentation

- [Configuration Reference](docs/configuration.md) — oko.yaml, .env, all settings
- [Keyboard Shortcuts](docs/keyboard-shortcuts.md) — full hotkey reference
- [Architecture](docs/architecture.md) — technical details, provider pattern, API
- [Deployment](docs/deployment.md) — Docker setup, SSL, auth, production tips
- [NVR Setup](docs/nvr-setup.md) — Hikvision/Dahua optimal settings

## Supported NVRs

| Provider | Live | Playback | Discovery | Audio | Talkback | Tested |
|----------|------|----------|-----------|-------|----------|--------|
| Hikvision | ✓ | ✓ | ISAPI | PCMU/PCMA | ISAPI | DS-7732NI-K4 |
| Dahua | ✓ | ✓ | CGI API | PCMU/PCMA/AAC | Direct RTSP | DHI-NVR5216-EI |
| Generic | ✓ | ✓ | Manual | Depends | — | — |

## License

MIT
