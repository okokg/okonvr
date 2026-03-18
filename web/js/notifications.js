/**
 * NotificationManager — browser push notifications for camera events.
 */

export class NotificationManager {
  constructor() {
    this._supported = 'Notification' in window;
  }

  /** Request notification permission from the user. */
  requestPermission() {
    if (this._supported && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  /** @returns {boolean} Whether notifications are allowed. */
  get isEnabled() {
    return this._supported && Notification.permission === 'granted';
  }

  /**
   * Notify that a camera went offline.
   * @param {string} id - Camera ID
   * @param {string} label - Camera label (optional)
   */
  cameraOffline(id, label) {
    if (!this.isEnabled) return;
    new Notification(`Camera ${id} offline`, {
      body: label || id,
      tag: `cam-${id}`,
      silent: true,
    });
  }
}
