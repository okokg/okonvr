# Keyboard Shortcuts

OKO NVR PLAYER is fully navigable without a mouse.

## Global (work everywhere)

| Key | Action |
|-----|--------|
| `W` | Toggle Watch Mode (motion detection + AI) |
| `F` | Toggle native browser fullscreen |
| `R` | Refresh — reconnect all cameras |
| `C` | Toggle compact mode (hides header & controls) |
| `T` | Toggle dark/light theme |
| `M` | Mute/unmute (mutes all; unmutes only active camera) |
| `Esc` | Exit camera fullscreen → return to grid |
| `Ctrl+`` | Auto-fit grid |
| `Ctrl+1` | Grid 1× (1 camera per row) |
| `Ctrl+2` | Grid 2× |
| `Ctrl+3` | Grid 4× |
| `Ctrl+4` | Grid 6× |
| `Ctrl+5` | Grid 8× (visible when >36 cameras) |
| `Ctrl+6` | Grid 10× (visible when >64 cameras) |

## Grid View (camera list)

| Key | Action |
|-----|--------|
| `←` `→` `↑` `↓` | Move focus between cameras (white border) |
| `Enter` / `Space` | Open focused camera in fullscreen |
| `1`–`9` | Open camera by position (1st, 2nd, ... 9th visible) |

Focus is set on the first camera at page load. Arrow keys work immediately.

## Camera Fullscreen

### Navigation & Playback

| Key | Action |
|-----|--------|
| `←` `→` | Switch to previous/next camera |
| `Enter` | Exit to grid (focus stays on this camera) |
| `Esc` | Exit to grid |
| `Space` | Pause / resume video |
| `H` | Toggle SD/HD stream quality |
| `P` | Open/close archive playback panel |
| `L` | Return to live (if in playback) or open playback panel |
| `J` | Seek backward 30s in archive (or start archive at now-30s) |
| `K` | Seek forward 30s in archive (or start archive at now-30s) |
| `Shift+J` | Seek backward 5 minutes |
| `Shift+K` | Seek forward 5 minutes |
| `E` | Jump to next smart event on timeline |
| `Shift+E` | Jump to previous smart event on timeline |

### Audio & Intercom

| Key | Action |
|-----|--------|
| `M` | Mute/unmute this camera |
| `↑` `↓` | Volume up/down (10% steps) |
| `V` | Toggle intercom / talkback (lock mode) |

### Zoom

| Key | Action |
|-----|--------|
| `+` / `=` | Zoom in (2× → 3× → 4×) |
| `-` | Zoom out (4× → 3× → 2× → 1×) |
| `Z` | Reset zoom to 1× |
| `1` `2` `3` `4` | Zoom presets (1× 2× 3× 4×, centered) |
| Mouse wheel | Zoom in/out centered on cursor |
| Click + drag | Pan the zoomed view |

A minimap appears in the corner when zoomed showing the visible area.

### Other

| Key | Action |
|-----|--------|
| `F` | Toggle native browser fullscreen |
| `?` or `/` | Show keyboard shortcuts help overlay |

## Intercom (Talkback)

| Action | Result |
|--------|--------|
| `V` in fullscreen | Toggle intercom on/off (lock mode) |
| Click mic icon (status bar) | Toggle intercom on/off |
| Hold PTT button (right side) | Push-to-talk (hold mode) |
| Double-click PTT button | Lock intercom on (toggle mode) |

When intercom is active: camera audio auto-enables, red border appears around camera cell, mic icons turn red.

## Watch Mode

| Action | Result |
|--------|--------|
| `W` | Toggle Watch Mode on/off |
| Click Watch button (header) | Toggle + show settings popup |
| Sensitivity slider | Adjust motion detection threshold (1–10) |
| Type checkboxes | Filter: Motion / Human / Vehicle / Animal |
| "Detected only" checkbox | Hide cameras without detections |

In fullscreen with Watch Mode active: AI overlay draws bounding boxes over detected objects. Badge shows detection engine (CORAL TPU or EfficientNet).

## Mute Behavior

| Action | Result |
|--------|--------|
| `M` (mute) | All cameras muted, global mute ON |
| `M` (unmute) in fullscreen | Only the open camera unmutes |
| `M` (unmute) in grid | Only the focused camera (white border) unmutes |
| Click audio icon | Unmutes that camera, clears global mute |
| Enter fullscreen | Audio auto-unmutes (if not globally muted) |
| Exit fullscreen | Audio muted (unless intercom is active) |

## Modifier Keys

All single-key shortcuts ignore `Ctrl` and `Cmd` to avoid conflicts with browser shortcuts. Layout-independent: uses `event.code` (physical key position) not `event.key` (character), so shortcuts work on any keyboard layout (QWERTY, AZERTY, Cyrillic, etc).
