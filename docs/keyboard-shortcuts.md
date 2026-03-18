# Keyboard Shortcuts

OKO NVR PLAYER is fully navigable without a mouse.

## Global (work everywhere)

| Key | Action |
|-----|--------|
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

| Key | Action |
|-----|--------|
| `←` `→` | Switch to previous/next camera |
| `Enter` / `Space` | Exit to grid (focus stays on this camera) |
| `Esc` | Exit to grid |
| `H` | Toggle SD/HD stream quality |
| `F` | Toggle native browser fullscreen |
| `P` | Open/close archive playback panel |
| `M` | Mute/unmute this camera |

## Mute Behavior

| Action | Result |
|--------|--------|
| `M` (mute) | All cameras muted, global mute ON |
| `M` (unmute) in fullscreen | Only the open camera unmutes |
| `M` (unmute) in grid | Only the focused camera (white border) unmutes |
| Click audio icon | Unmutes that camera, clears global mute |
| Enter fullscreen | Audio auto-unmutes (if not globally muted) |
| Exit fullscreen | Audio muted |

## Modifier Keys

All single-key shortcuts ignore `Ctrl` and `Cmd` to avoid conflicts with browser shortcuts:

| Combo | Browser action (not intercepted) |
|-------|--------------------------------|
| `Ctrl+C` | Copy |
| `Ctrl+R` | Reload page |
| `Ctrl+T` | New tab |
| `Ctrl+F` | Browser find |
| `Ctrl+H` | Browser history |
| `Ctrl+P` | Print |

## Search Field

When the search input is focused, all keyboard shortcuts are disabled — typing works normally. Click outside or press `Esc` to return to shortcut mode.
