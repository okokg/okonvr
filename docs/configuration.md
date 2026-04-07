# Configuration Reference

OKO NVR uses two configuration files:
- `oko.yaml` — main config (NVRs, cameras, playback, snapshots, UI)
- `.env` — infrastructure only (server IP, ports)

Both files are NOT committed to git. Templates: `oko.yaml.example`, `.env.example`.

## oko.yaml

### server

```yaml
server:
  port: 3000          # backend API port (internal, Docker only)
  timezone: "Asia/Bishkek"  # optional, for playback time display
```

### go2rtc

```yaml
go2rtc:
  api: http://go2rtc:1984    # go2rtc API URL (Docker service name)
  webrtc_port: 8555           # WebRTC UDP/TCP port
```

WebRTC candidates are set via `SERVER_IP` in `.env`.

### playback

```yaml
playback:
  timeout: 30                    # FFmpeg timeout for archive streams (seconds)
  playback_input: "-fflags nobuffer -flags low_delay -buffer_size 1 -rtsp_transport tcp -timeout 30 -i {input}"
  mse_cache_ttl: 60              # remember MSE mode per camera (seconds)
  force_mse: false               # always use MSE for archive playback
```

| Setting | Default | Description |
|---------|---------|-------------|
| `timeout` | `30` | Seconds before ffmpeg gives up on archive stream. Increase for slow NVRs. |
| `playback_input` | (see above) | Custom ffmpeg input profile. `{input}` = RTSP URL. |
| `mse_cache_ttl` | `60` | After MSE fallback, skip WebRTC for this camera for N seconds. |
| `force_mse` | `false` | `true` = MSE for all archives (avoids keyframe delays). `false` = try WebRTC first. |

Legacy: `ffmpeg:` section is still supported as fallback (reads `ffmpeg.timeout`, `ffmpeg.playback_input`).

### snapshots

```yaml
snapshots:
  enabled: true                  # enable/disable snapshot preloading
  source: auto                   # auto | native | go2rtc
  interval: 30                   # refresh interval in seconds
  delay: 200                     # delay between sequential camera fetches (ms)
  timeout: 8000                  # per-snapshot fetch timeout (ms)
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Show snapshot backgrounds before video stream connects. |
| `source` | `auto` | `auto` = try NVR HTTP API first, fallback to go2rtc. `native` = NVR API only (fast ~100ms). `go2rtc` = frame.jpeg only (slower ~1-2s). |
| `interval` | `30` | Seconds between snapshot refreshes. |
| `delay` | `200` | Milliseconds between sequential camera fetches (prevents NVR overload). |
| `timeout` | `8000` | Per-snapshot fetch timeout in ms. |

### ui

```yaml
ui:
  title: "OKO NVR"               # header title and browser tab
  default_grid: "auto"           # auto | 1 | 2 | 4 | 6 | 8 | 10
  theme: "dark"                  # dark | light (default for new users)
  compact: false                 # start in compact mode
  stagger_ms: 500                # delay between camera connections (ms)
  bitrate_interval: 5000         # bitrate refresh interval (ms)
  sync_interval: 15000           # camera list sync interval (ms)
  nvr_health_interval: 30000     # NVR health check interval (ms)
  nvr_health_failures: 3         # failures before marking NVR offline
```

| Setting | Default | Description |
|---------|---------|-------------|
| `title` | `OKO NVR` | Shown in header and browser tab. Hot-reloadable. |
| `default_grid` | `auto` | Grid layout on page load. `auto` fits all cameras on screen. |
| `theme` | `dark` | Default theme. User can toggle with T key, stored in localStorage. |
| `compact` | `false` | Start in compact mode (hides header and controls). |
| `stagger_ms` | `500` | Milliseconds between starting each camera stream. Prevents NVR overload on cold start. Increase for slow NVRs. |
| `bitrate_interval` | `5000` | How often to update bitrate display (ms). Lower = more CPU. |
| `sync_interval` | `15000` | How often to check for config changes (ms). Controls hot-reload responsiveness. |
| `nvr_health_interval` | `30000` | How often to check NVR connectivity (ms). |
| `nvr_health_failures` | `3` | Consecutive failures before marking NVR offline and triggering re-discovery on recovery. |

User preferences (theme, compact) in localStorage override config defaults. Config only sets the initial state for new browsers.

### nvrs

```yaml
nvrs:
  - name: office                   # NVR name (used as camera group)
    enabled: true                  # set false to disable without removing
    provider: hikvision            # hikvision | dahua | generic
    host: 192.168.0.2             # NVR IP address
    port: 554                      # RTSP port (default 554)
    http_port: 80                  # HTTP API port for discovery (default 80)
    username: admin
    password: changeme
    id_prefix: "D"                 # camera ID prefix: D1, D2, D3...
    channels: "*, !12, !32"        # channel selection (see below)
    sub_stream_suffix: "02"        # sub-stream suffix (default 02)
    main_stream_suffix: "01"       # main-stream suffix (default 01)
    talkback_channels: [5, 8]      # manual talkback override (optional)
```

#### talkback_channels

By default, talkback-capable cameras are auto-detected from the NVR API:
- **Dahua:** `RemoteDevice` → model name contains `-AS-` (speaker) or `-PV-` (siren/deterrence)
- **Hikvision:** ISAPI `/System/TwoWayAudio/channels` → channel IDs with TwoWayAudio support

`talkback_channels` overrides are **merged** with auto-detected channels (union). Use this when auto-detection misses a camera, or to manually add channels.

#### Channel syntax

| Expression | Result |
|-----------|--------|
| *(omitted)* | Auto-discover all cameras from NVR |
| `"*"` | Same as omitted |
| `"*, !12, !32"` | Discover all, exclude channels 12 and 32 |
| `"*, !5-8"` | Discover all, exclude range 5 through 8 |
| `"1-31"` | Manual range, no discovery |
| `"1,5,8,13"` | Specific channels only |
| `"1-10, 15-20, !7"` | Mixed ranges with exclusion |

#### Auto-discovery

When channels is omitted or contains `*`, the backend queries the NVR's HTTP API:

| Provider | API endpoint | Auth |
|----------|-------------|------|
| Hikvision | `/ISAPI/ContentMgmt/InputProxy/channels` | Digest |
| Hikvision (fallback) | `/ISAPI/Streaming/channels` | Digest |
| Dahua | `/cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle` | Digest |
| Generic | Not supported | — |

Discovery also retrieves camera names, IPs, models, MACs, firmware, and serial numbers from the NVR.

#### Provider URL patterns

**Hikvision:**
```
Live sub:   rtsp://user:pass@host:554/Streaming/Channels/{ch}02
Live main:  rtsp://user:pass@host:554/Streaming/Channels/{ch}01
Playback:   rtsp://user:pass@host:554/Streaming/tracks/{ch}01/?starttime=YYYYMMDDTHHMMSSZ&endtime=...
```
Channel mapping: camera 1 → 101/102, camera 24 → 2401/2402.

**Dahua:**
```
Live sub:   rtsp://user:pass@host:554/cam/realmonitor?channel={ch}&subtype=1
Live main:  rtsp://user:pass@host:554/cam/realmonitor?channel={ch}&subtype=0
Playback:   rtsp://user:pass@host:554/cam/playback?channel={ch}&starttime=YYYY_MM_DD_HH_MM_SS&endtime=...
```

#### Enabling/disabling NVRs

```yaml
nvrs:
  - name: office
    provider: hikvision
    host: 192.168.0.2
    # ... active

  - name: warehouse
    enabled: false          # disabled, config preserved
    provider: dahua
    host: 192.168.1.10
    # ...
```

Hot-reloadable: remove `enabled: false` → NVR activates within seconds.

## .env

```env
SERVER_IP=192.168.0.240,cams.example.com    # WebRTC candidates (comma-separated)
WEBRTC_PORT=8555                              # WebRTC UDP/TCP port
HTTP_PORT=80                                  # nginx HTTP port
```

`SERVER_IP` can be multiple addresses (LAN IP + public domain). Each becomes a WebRTC ICE candidate.

## Hot Reload

The backend watches `oko.yaml` for changes. When the file is modified:

1. Config is re-parsed
2. NVR discovery runs (if `*` channels)
3. Camera diff: added cameras get new go2rtc streams, removed cameras are cleaned up
4. UI config updated (title, intervals)
5. Frontend picks up changes via sync cycle

No container restart needed for config changes. Backend restart needed only for TypeScript code changes (tsx watch handles this in dev mode).

## Files NOT in git

```
oko.yaml          # credentials
.env              # infrastructure
.htpasswd         # nginx auth
go2rtc.yaml       # auto-generated
*.db              # SQLite database
```
