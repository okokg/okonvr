# OKO Embed Player

Standalone WebRTC/MSE live stream player for embedding OKO camera streams on external websites.
Zero dependencies, single file (~490 lines, ~12KB).

## Features

- **WebRTC** with automatic **MSE fallback** over WebSocket
- **Auto-reconnect** with exponential backoff (3s → 15s max)
- **ICE disconnect** grace period (5s before reconnect)
- **Decode check** — if no video after 5s, falls back to MSE
- **Stale stream detection** — 30s without data triggers reconnect
- **Snapshot background** during loading and reconnect
- **Fullscreen** — button, double-click, ESC to exit
- **Click to mute/unmute**
- **Stream switching** without DOM recreation via `switch()` method

## Files

```
web/embed/
├── oko-embed.js          # Standalone player (no dependencies)
├── oko-cams.js           # Integration shim for Vorota admin panel
├── index.html            # Demo page (test against local OKO)
├── nginx-example.conf    # Generic nginx config for external sites
└── vorota-nginx.conf     # Vorota-specific nginx mappings
```

## Quick Start

### 1. HTML

```html
<script src="/embed/oko-embed.js"></script>
<div id="cam" style="width:640px"></div>
<script>
  OkoEmbed.create('#cam', {
    webrtcUrl: '/cam/gate/webrtc',
    wsUrl:     '/cam/gate/ws',
    snapshot:  '/cam/gate/snapshot',
  });
</script>
```

### 2. nginx on external site

Map public URLs to OKO go2rtc streams. Each camera needs 3 endpoints:

```nginx
# WebRTC signaling (HTTP POST)
location /cam/gate/webrtc {
    proxy_pass http://oko-server/api/webrtc?src=M1;
    proxy_buffering off;
    proxy_http_version 1.1;
    proxy_set_header Authorization "Basic <base64>";
}

# MSE WebSocket fallback
location /cam/gate/ws {
    proxy_pass http://oko-server/api/ws?src=M1;
    proxy_buffering off;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Authorization "Basic <base64>";
    proxy_read_timeout 86400s;
}

# Snapshot
location /cam/gate/snapshot {
    proxy_pass http://oko-server/backend/snapshot/M1;
    proxy_set_header Authorization "Basic <base64>";
}
```

Generate the base64 auth string:
```bash
echo -n 'user:password' | base64
```

## API

### `OkoEmbed.create(container, options)`

Creates a new player instance.

| Parameter | Type | Description |
|-----------|------|-------------|
| `container` | `string \| Element` | CSS selector or DOM element |
| `options.webrtcUrl` | `string` | WebRTC signaling endpoint (POST) |
| `options.wsUrl` | `string` | MSE WebSocket endpoint |
| `options.snapshot` | `string` | Optional snapshot URL for background |

Returns an `EmbedPlayer` instance.

### `player.switch(options)`

Switch to a different camera stream without recreating the player DOM.

```js
player.switch({
  webrtcUrl: '/cam/street/webrtc',
  wsUrl:     '/cam/street/ws',
  snapshot:  '/cam/street/snapshot',
});
```

### `player.stop()`

Stop playback and disconnect.

### `player.start()`

Restart playback after `stop()`.

### `player.destroy()`

Stop, remove all DOM elements, clean up event listeners.

## Security Model

The external site never sees real camera IDs. nginx maps public names to internal stream IDs:

```
Browser → /cam/gate/webrtc → nginx → /api/webrtc?src=M1 → go2rtc
```

- Adding a camera = add 3 nginx locations
- Removing a camera = remove 3 nginx locations
- No tokens, no API keys — access control via nginx routing
- OKO basic auth passed via `proxy_set_header Authorization`

## Vorota Integration (oko-cams.js)

Drop-in replacement for `cams.js` + `flv.js` in the Vorota admin panel.

### What it does

`vorotaState.js` dynamically builds camera table rows with onclick handlers:
```js
showCamVideo('/live/2602.flv', window.cam_container)
```

`oko-cams.js` provides a shim `window.showCamVideo` that:
1. Parses the FLV URI → extracts channel name (`2602`)
2. Builds WebRTC/WS/snapshot URLs (`/live/2602/webrtc`, etc.)
3. First call creates `OkoEmbed` player, subsequent calls use `switch()`

### Setup

Replace in the page template:
```html
<!-- REMOVE: -->
<script src="https://unpkg.com/flv.js@1.5.0/dist/flv.js"></script>
<script src="/js/cams.js"></script>

<!-- ADD: -->
<script src="/js/oko/oko-embed.js"></script>
<script src="/js/oko/oko-cams.js"></script>
```

Keep `reconnecting-websocket.min.js` (needed by `vorotaState.js`).
Keep `vorotaState.js` unchanged — the shim intercepts `showCamVideo` calls.

Keep the original `showCamVideo()` call at the bottom of the template:
```html
<script>
  window.cam_container = "vorota-cam";
  vorotaState("/ws/vorota_toktogula");
</script>
<script src="/js/oko/oko-cams.js"></script>
<script>
  showCamVideo("/live/toktogula.flv", window.cam_container);
</script>
```

### nginx for Vorota

Use `include media-server_params` for shared proxy settings:

```nginx
# media-server_params
proxy_set_header Authorization "Basic <base64>";
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_buffering off;
proxy_http_version 1.1;
```

Each camera:
```nginx
location /live/toktogula/webrtc { proxy_pass http://192.168.0.240:80/api/webrtc?src=D3; include media-server_params; }
location /live/toktogula/ws     { proxy_pass http://192.168.0.240:80/api/ws?src=D3;     include media-server_params; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_read_timeout 86400s; }
location /live/toktogula/snap   { proxy_pass http://192.168.0.240:80/backend/snapshot/D3; include media-server_params; }
```

## Shared Streams

The embed player connects to the same go2rtc streams as the OKO NVR UI.
go2rtc multiplexes one RTSP source to multiple consumers — no additional
NVR load from embed viewers.
