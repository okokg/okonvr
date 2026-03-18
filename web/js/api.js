/**
 * Client for the backend REST API.
 * Handles camera list fetching and metadata persistence.
 */

import { BACKEND_URL } from './config.js';

(window._oko = window._oko || {}).api = 'i1f0';

export class ApiClient {
  /**
   * Fetch camera list from backend (go2rtc streams + stored metadata).
   * @returns {Promise<Array<{id: string, label: string, group: string, sort_order: number}>>}
   */
  async getCameras() {
    const res = await fetch(`${BACKEND_URL}/cameras`);
    if (!res.ok) throw new Error(`GET /cameras failed: ${res.status}`);
    return res.json();
  }

  /**
   * Update label and/or group for a camera.
   * @param {string} id - Camera ID
   * @param {object} data - { label?, group? }
   */
  async updateCamera(id, data) {
    const res = await fetch(`${BACKEND_URL}/cameras/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`PUT /cameras/${id} failed: ${res.status}`);
    return res.json();
  }

  /**
   * Save camera display order.
   * @param {string[]} order - Array of camera IDs in display order
   */
  async saveOrder(order) {
    const res = await fetch(`${BACKEND_URL}/cameras/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    });
    if (!res.ok) throw new Error(`PUT /cameras/order failed: ${res.status}`);
  }

  /**
   * Health check.
   */
  async health() {
    const res = await fetch(`${BACKEND_URL}/health`);
    return res.json();
  }

  /**
   * Create a playback stream for a camera.
   * @param {string} camera - Camera ID (e.g. "D1")
   * @param {string} start - ISO datetime (e.g. "2026-03-15T06:00")
   * @param {string} end - ISO datetime (e.g. "2026-03-15T07:00")
   * @param {string} resolution - "original"|"1080p"|"720p"|"480p"|"360p"
   * @returns {Promise<{stream, camera, codec, resolution, forceMSE}>}
   */
  async createPlayback(camera, start, end, resolution = 'original') {
    const res = await fetch(`${BACKEND_URL}/playback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ camera, start, end, resolution }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Playback failed: ${res.status}`);
    }
    return res.json();
  }

  /**
   * Delete a playback stream.
   * @param {string} stream - Playback stream name
   */
  async deletePlayback(stream) {
    await fetch(`${BACKEND_URL}/playback/${encodeURIComponent(stream)}`, {
      method: 'DELETE',
    }).catch(() => {});
  }

  /**
   * Cleanup ALL playback streams.
   */
  async cleanupPlaybacks() {
    await fetch(`${BACKEND_URL}/playback`, {
      method: 'DELETE',
    }).catch(() => {});
  }

  /** Create HD (main-stream) for a camera. Returns { stream, forceMSE, codec, audio }. */
  async createHdStream(cameraId) {
    const res = await fetch(`${BACKEND_URL}/hd-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ camera: cameraId }),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  /** Delete HD stream for a camera. */
  async deleteHdStream(cameraId) {
    await fetch(`${BACKEND_URL}/hd-stream/${encodeURIComponent(cameraId)}`, {
      method: 'DELETE',
    }).catch(() => {});
  }

  /** Get UI configuration from oko.yaml. */
  async getUiConfig() {
    const res = await fetch(`${BACKEND_URL}/config/ui`);
    if (!res.ok) return null;
    return res.json();
  }

  /** Create a transcoded H.264 stream for a camera (when client can't decode H.265). */
  async createTranscodeStream(cameraId) {
    const res = await fetch(`${BACKEND_URL}/transcode-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ camera: cameraId }),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  /** Get NVR health status. */
  async getNvrHealth() {
    const res = await fetch(`${BACKEND_URL}/health/nvrs`);
    if (!res.ok) return [];
    return res.json();
  }

  /** Get server statistics (streams, connections, NVR status). */
  async getStats() {
    const res = await fetch(`${BACKEND_URL}/stats`);
    if (!res.ok) return null;
    return res.json();
  }

  /** Report NVR failure (mass 500s detected by frontend). */
  async reportNvrFailure(nvrName) {
    fetch(`${BACKEND_URL}/health/nvr-failure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nvr: nvrName }),
    }).catch(() => {});
  }
}
