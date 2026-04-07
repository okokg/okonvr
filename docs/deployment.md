# Deployment

## Prerequisites

- Docker + Docker Compose v2.22+
- NVR accessible via RTSP (port 554) and HTTP (port 80) from Docker host
- UDP port for WebRTC (default 8555) open on firewall

## Initial Setup

```bash
git clone https://github.com/okokg/okonvr.git
cd okonvr

# Create config files from templates
./setup.sh

# Set your NVR credentials
nano oko.yaml

# Set server IP and ports
nano .env

# Set nginx password (optional, default: demo/demo)
./gen-htpasswd.sh admin yourpassword
```

## Docker Compose

```bash
# Start all services
docker compose up -d

# Start with Google Coral TPU detection (optional)
docker compose --profile coral up -d

# View logs
docker compose logs -f

# Restart after config changes
docker compose restart backend go2rtc

# Full rebuild (after code changes)
docker compose up -d --build
```

### Services

| Service | Image | Ports | Purpose |
|---------|-------|-------|---------|
| backend | node:20-alpine + ffmpeg | 3000 (internal) | API, config, codec probing |
| go2rtc | alexxit/go2rtc | 8555 TCP+UDP | WebRTC/RTSP media |
| nginx | nginx:alpine | 80 (configurable) | Reverse proxy, auth, static |
| detect | debian:11-slim + pycoral | 3001 (internal) | Coral TPU AI detection (optional, `--profile coral`) |

### Google Coral TPU (optional)

The detect service runs YOLOv8n inference on a Google Coral USB Accelerator. It is optional — without it, Watch Mode uses browser-side MediaPipe WASM detection automatically.

```bash
# With Coral
docker compose --profile coral up -d

# Without Coral (default — browser-side detection fallback)
docker compose up -d
```

Requires: Coral USB Accelerator, `/dev/bus/usb` accessible, `privileged: true`.
Place `.tflite` models in `./models/`.

### Dev Mode

`docker-compose.override.yml` enables tsx watch (auto-reload on .ts changes):

```bash
# Dev (auto-reload)
docker compose up -d --build backend

# Production (no override)
docker compose -f docker-compose.yml up -d --build
```

## Network Requirements

### Ports

| Port | Protocol | Direction | Purpose |
|------|----------|-----------|---------|
| 80 (HTTP_PORT) | TCP | Inbound | Web interface + API |
| 8555 (WEBRTC_PORT) | TCP + UDP | Inbound | WebRTC media |
| 554 | TCP | Backend → NVR | RTSP streams |
| 80 | TCP | Backend → NVR | API discovery |

### WebRTC Candidates

```env
# .env
SERVER_IP=192.168.0.240,cams.example.com
```

Each IP/hostname becomes a WebRTC ICE candidate. Include:
- LAN IP for local access
- Public domain/IP for remote access

### Firewall

```bash
# Allow WebRTC
ufw allow 8555/tcp
ufw allow 8555/udp

# Allow HTTP
ufw allow 80/tcp
```

## SSL / HTTPS

For HTTPS, put a reverse proxy (Caddy, Traefik, nginx) in front:

```
Internet → Caddy (:443, HTTPS) → nginx (:80) → backend/go2rtc
```

Caddy example:

```
cams.example.com {
    reverse_proxy localhost:80
}
```

WebRTC port (8555) stays UDP direct — no HTTPS needed, DTLS encrypts media.

## Basic Auth

nginx is configured with `.htpasswd`:

```bash
# Create user
htpasswd -c .htpasswd admin

# Add user
htpasswd .htpasswd viewer
```

## Monitoring

```bash
# Health check
curl http://localhost/backend/health

# Camera list
curl http://localhost/backend/cameras | jq

# Active playback streams
curl http://localhost/backend/playback

# Reset codec cache (forces re-probe)
curl -X POST http://localhost/backend/reset-codecs
```

## Troubleshooting

### Cameras not connecting

```bash
# Check go2rtc streams
docker compose exec go2rtc wget -qO- http://localhost:1984/api/streams | jq

# Test RTSP directly
docker compose exec backend ffprobe -v error -rtsp_transport tcp \
  "rtsp://admin:pass@NVR_IP:554/Streaming/Channels/102"
```

### NVR overload (connection reset)

Increase `stagger_ms` in oko.yaml:

```yaml
ui:
  stagger_ms: 1000    # 1 second between cameras
```

### No audio

```bash
# Check codec detection
curl http://localhost/backend/cameras | jq '.[] | select(.has_audio) | .id'

# Reset and re-probe
curl -X POST http://localhost/backend/reset-codecs
docker compose restart backend
```

Audio codec must be G.711Mu (PCMU) or G.711A (PCMA) for WebRTC. AAC works only via MSE (HD mode with H.265). Configure in NVR web interface.

### H.265 playback issues

On Chrome 136+ with hardware decoder (GPU), H.265 streams play via WebRTC natively. Check the green **H.265** badge in header — if present, no issues expected.

On Firefox or browsers without H.265 WebRTC, the player automatically falls back to MSE. If MSE playback doesn't start, increase ffmpeg timeout:

```yaml
ffmpeg:
  timeout: 60
```

Check `chrome://gpu` → "Video Acceleration Information" to verify HEVC decode is listed.

### Hot reload not working

```bash
# Check watcher is running
docker compose logs backend | grep watcher

# Verify oko.yaml is mounted
docker compose exec backend cat /config/oko.yaml | head -5
```

## Backup

Only these files need backup:
- `oko.yaml` — NVR credentials and config
- `.env` — server settings
- `.htpasswd` — auth credentials
- `/data/oko.db` — camera metadata, codec cache, sort order (Docker volume `backend-data`)
- `models/` — AI model files (if using Coral or custom ONNX models)

## Resource Usage

Typical for 30 cameras on sub-stream:

| Resource | Usage |
|----------|-------|
| CPU | ~5% (backend idle, go2rtc passthrough) |
| RAM | ~200MB (backend ~80MB, go2rtc ~100MB, nginx ~20MB) |
| Network | ~15 Mbps inbound (from NVRs), ~15 Mbps outbound (to browsers) |
| Disk | ~50MB (no recording, SQLite only) |

HD mode adds ~5-8 Mbps per camera. Playback adds ~4-6 Mbps per camera.
