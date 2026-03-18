# OKO NVR PLAYER

Zero-storage WebRTC surveillance viewer with NVR archive playback.

## Overview

OKO NVR PLAYER connects to Hikvision and Dahua NVRs via RTSP, streams live video through WebRTC to the browser, and provides interactive archive playback with a seek timeline. No local recording — all video comes directly from the NVR.

**Key features:**
- WebRTC live streaming with sub-stream (SD) and main-stream (HD) switching
- NVR archive playback with 24h seek timeline and quick seek buttons
- Auto-discovery of cameras from Hikvision ISAPI and Dahua CGI APIs
- Multi-NVR support with per-NVR grouping and filtering
- Codec detection (H.264/H.265) with automatic transcoding for WebRTC
- Audio support (PCMU/PCMA native, AAC via MSE)
- Hot reload — edit `oko.yaml`, cameras update without restart
- Full keyboard navigation
- Dark/light theme, compact mode, auto-fit grid

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

## Configuration

Single config file: `oko.yaml`. See [docs/configuration.md](docs/configuration.md) for full reference.

Minimal config:

```yaml
nvrs:
  - name: office
    provider: hikvision
    host: 192.168.0.2
    username: admin
    password: changeme
    id_prefix: "D"
```

Cameras auto-discovered from NVR. No channels needed.

## Keyboard Shortcuts

See [docs/keyboard-shortcuts.md](docs/keyboard-shortcuts.md) for full reference.

| Key | Action |
|-----|--------|
| ←→↑↓ | Navigate cameras in grid |
| Enter / Space | Open / close camera |
| H | Toggle SD/HD stream |
| F | Native fullscreen |
| M | Mute / unmute |
| P | Playback panel (in fullscreen) |
| C | Compact mode |
| Esc | Exit fullscreen |

## Documentation

- [Configuration Reference](docs/configuration.md) — oko.yaml, .env, all settings
- [Keyboard Shortcuts](docs/keyboard-shortcuts.md) — full hotkey reference
- [Architecture](docs/architecture.md) — technical details, provider pattern, API
- [Deployment](docs/deployment.md) — Docker setup, SSL, auth, production tips
- [NVR Setup](docs/nvr-setup.md) — Hikvision/Dahua optimal settings

## Supported NVRs

| Provider | Live | Playback | Discovery | Audio | Tested |
|----------|------|----------|-----------|-------|--------|
| Hikvision | ✓ | ✓ | ISAPI (Digest auth) | PCMU/PCMA | DS-7732NI-K4 |
| Dahua | ✓ | ✓ | CGI API (Digest auth) | PCMU/PCMA/AAC | DHI-NVR5216-EI |
| Generic | ✓ | ✓ | Manual | Depends | — |

## License

MIT
