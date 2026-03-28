/**
 * Application constants and configuration.
 */
export const VERSION = '0.4.0-20260318';
(window._oko = window._oko || {}).config = 'c1a0';

// ── Stream connection ──
export const STAGGER_MS = 500;              // delay between camera connections at startup
export const RETRY_BASE_MS = 3000;          // initial retry delay after disconnect
export const RETRY_MAX_MS = 15000;          // max retry delay (exponential backoff cap)
export const WEBRTC_RETRY_MS = 2000;        // delay before retrying WebRTC on non-codec errors
export const VIDEO_DECODE_CHECK_MS = 5000;  // time to wait for first decoded frame (H.265 check)
export const STALE_STREAM_MS = 30000;       // no new bytes for this long = stale, reconnect

// ── ICE / WebRTC ──
export const ICE_TIMEOUT_MS = 5000;         // fallback to MSE if no media arrives
export const ICE_GATHER_TIMEOUT_MS = 2000;  // max time to gather ICE candidates

// ── MSE buffer ──
export const BUFFER_SYNC_INTERVAL_MS = 2000;
export const BUFFER_MAX_SECONDS = 10;       // max buffered duration before trimming
export const BUFFER_TRIM_TO = 5;            // trim buffer to this duration
export const MSE_OPEN_TIMEOUT_MS = 1000;    // delay before retrying MSE after ws close
export const MSE_CACHE_TTL_MS = 60_000;     // remember MSE mode per camera — skip WebRTC on reconnect/seek

// ── Bitrate / UI updates ──
export const BITRATE_INTERVAL_MS = 10000;   // bitrate measurement interval
export const TIMELINE_HOURS = 24;
export const TIMELINE_RENDER_INTERVAL_MS = 10000;

// ── UI ──
export const SEARCH_DEBOUNCE_MS = 400;
export const ORDER_SAVE_DEBOUNCE_MS = 500;
export const NVR_HEALTH_POLL_MS = 15000;    // how often frontend checks NVR health (via sync cycle)
export const SWIPE_THRESHOLD_PX = 60;

// ── Backend ──
export const BACKEND_URL = '/backend';
export const STUN_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
