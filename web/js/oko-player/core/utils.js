/**
 * Shared formatting utilities for oko-player.
 * Extracted from camera-view.js module-level functions.
 */

/** Zero-pad number to 2 digits. */
export const pad = (n) => String(n).padStart(2, '0');

/** Format Date as HH:MM:SS. */
export const hms = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/** Format Date as HH:MM. */
export const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Format Date as DD.MM. */
export const dm = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;

/** Format Date as DD.MM.YYYY. */
export const dmy = (d) => `${dm(d)}.${d.getFullYear()}`;

/** Format Date as YYYY-MM-DDTHH:MM (for datetime-local input). */
export const fmtInput = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${hm(d)}`;

/** Format Date as YYYY-MM-DDTHH:MM:SS (for playback API). */
export const fmtFull = (d) => `${fmtInput(d)}:${pad(d.getSeconds())}`;

/** Seconds since midnight for a Date. */
export const daySeconds = (d) => d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
