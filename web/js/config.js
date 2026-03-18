/**
 * Application constants and configuration.
 */

export const STAGGER_MS = 500;
export const RETRY_BASE_MS = 3000;
export const RETRY_MAX_MS = 15000;
export const TIMELINE_HOURS = 24;
export const BITRATE_INTERVAL_MS = 2000;
export const BUFFER_SYNC_INTERVAL_MS = 3000;
export const BUFFER_MAX_SECONDS = 10;
export const BUFFER_TRIM_TO = 5;
export const ICE_TIMEOUT_MS = 5000;
export const ICE_GATHER_TIMEOUT_MS = 2000;
export const SEARCH_DEBOUNCE_MS = 400;
export const ORDER_SAVE_DEBOUNCE_MS = 500;
export const TIMELINE_RENDER_INTERVAL_MS = 10000;
export const SWIPE_THRESHOLD_PX = 60;

export const BACKEND_URL = '/backend';
export const STUN_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
