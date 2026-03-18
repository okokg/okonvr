# NVR Setup Guide

Optimal NVR settings for OKO NVR PLAYER.

## Hikvision

### Video Settings

**Main stream (recording + HD mode):**

| Setting | Value | Notes |
|---------|-------|-------|
| Codec | H.265 or H.264 | H.265 saves disk, H.264 = no transcode in HD mode |
| Resolution | Max available | 4K, 2K, 1080p depending on camera |
| Frame rate | 20-25 fps | |
| Bitrate type | VBR | Adaptive, saves bandwidth |
| Bitrate | 4096-8192 kbps | Match resolution |

**Sub stream (live grid):**

| Setting | Value | Notes |
|---------|-------|-------|
| Codec | **H.264** | Required — WebRTC doesn't support H.265 |
| Resolution | 640×480 or 704×576 | Sufficient for grid, saves bandwidth |
| Frame rate | 15 fps | Enough for monitoring |
| Bitrate type | VBR | |
| Bitrate | 256-512 kbps | |

### Audio Settings

| Setting | Value |
|---------|-------|
| Audio | Enabled |
| Codec | **G.711Mu (PCMU)** |

G.711Mu is natively supported by WebRTC. G.711A (PCMA) also works. Do NOT use AAC or G.722 for sub-stream — they require transcoding.

### Network Settings

| Setting | Value |
|---------|-------|
| RTSP Port | 554 (default) |
| HTTP Port | 80 (default) |
| RTSP Authentication | digest/basic |

### Tested Models

- **DS-7732NI-K4** (firmware V4.1.70, 32ch) — full support, ISAPI discovery, playback, audio

### Discovery

Hikvision NVRs expose cameras via ISAPI. OKO uses:
1. `/ISAPI/ContentMgmt/InputProxy/channels` — returns camera list with names
2. `/ISAPI/Streaming/channels` — fallback, returns stream IDs

Older firmware may only support option 2. If discovery fails, specify channels manually:

```yaml
channels: "1-32, !12"
```

## Dahua

### Video Settings

**Main stream:**

| Setting | Value | Notes |
|---------|-------|-------|
| Codec | H.265 or H.264 | |
| Resolution | Max available | 4K, 2K, 1080p |
| Frame rate | 20 fps | |
| Bitrate type | CBR or VBR | |
| Bitrate | 4096-8192 kbps | |

**Sub stream (Доп. поток):**

| Setting | Value | Notes |
|---------|-------|-------|
| Type | Доп. поток 1 | |
| Codec | **H.264** | Required for WebRTC |
| Resolution | 640×480 (VGA) or D1 | |
| Frame rate | 15-20 fps | |
| Bitrate type | VBR | |
| Bitrate | 512 kbps | |

### Audio Settings

Set for BOTH main and sub stream:

| Setting | Value |
|---------|-------|
| Audio | Enabled |
| Codec | **G.711Mu** |

In Dahua interface: Больше → Аудио → Сжатие → G.711Mu

After changing audio settings, **reboot the NVR** for changes to take effect.

### Tested Models

- **DHI-NVR5216-EI** (16ch, 4K) — full support, CGI discovery, playback, audio (G.711Mu)

### Discovery

Dahua NVRs expose cameras via CGI API:
- `/cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle`

Returns channel names. Auth: Digest.

### Playback Time Format

Dahua uses underscores: `2026_03_18_14_30_00`

## Generic Provider

For standalone IP cameras or unsupported NVRs:

```yaml
nvrs:
  - name: doorbell
    provider: generic
    host: 192.168.1.50
    port: 554
    username: admin
    password: cam123
    id_prefix: "CAM"
    channels: "1"
```

Generic provider does not support auto-discovery. Channels must be specified.

## Common Issues

### Sub-stream shows black/green

Camera sub-stream codec is H.265 — change to H.264 in NVR settings.

### Audio not detected

1. Enable audio in NVR camera settings
2. Set codec to G.711Mu (not AAC)
3. Reboot NVR
4. Reset codec cache: `curl -X POST http://localhost/backend/reset-codecs`
5. Wait 15 seconds for re-probe

### Cameras disconnect periodically

NVR RTSP connection limit. Reduce simultaneous connections:

```yaml
ui:
  stagger_ms: 1000
```

### Playback not starting

Check NVR time zone matches. Hikvision uses UTC in RTSP URLs, Dahua uses local time. Ensure NVR time is synchronized (NTP enabled).

### HD mode shows nothing

Main stream is H.265 — go2rtc uses MSE (not WebRTC). Check browser console for MSE errors. Chrome supports H.265 MSE, Firefox may not.
