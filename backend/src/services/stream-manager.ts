import { encodeGo2rtcSource } from '../utils/url-encoder';

let go2rtcApi = 'http://go2rtc:1984';

/** Active playback streams: { streamName: { camera, created } } */
const activePlaybacks = new Map<string, { camera: string; created: number }>();

export function initStreamManager(apiUrl: string) {
  go2rtcApi = apiUrl;
}

/** Fetch all stream IDs from go2rtc (excluding playback_ streams). */
export async function fetchStreams(): Promise<string[]> {
  try {
    const res = await fetch(`${go2rtcApi}/api/streams`);
    if (!res.ok) throw new Error(`go2rtc HTTP ${res.status}`);
    const data = await res.json() as Record<string, unknown>;
    return Object.keys(data).filter(id => !id.startsWith('playback_'));
  } catch {
    return [];
  }
}

/** Create a go2rtc dynamic stream via PUT /api/streams. */
export async function createStream(name: string, source: string): Promise<void> {
  const encoded = encodeGo2rtcSource(source);
  const url = `${go2rtcApi}/api/streams?name=${encodeURIComponent(name)}&src=${encoded}`;
  const res = await fetch(url, { method: 'PUT' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`go2rtc PUT failed: ${res.status} ${body}`);
  }
}

/** Delete a go2rtc stream (tries both param names for compatibility). */
export async function deleteStream(name: string): Promise<void> {
  await fetch(`${go2rtcApi}/api/streams?src=${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {});
  await fetch(`${go2rtcApi}/api/streams?name=${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {});
}

/** Track a new playback stream. */
export function trackPlayback(streamName: string, cameraId: string) {
  activePlaybacks.set(streamName, { camera: cameraId, created: Date.now() });
}

/** Remove playback tracking. */
export function untrackPlayback(streamName: string) {
  activePlaybacks.delete(streamName);
}

/** Get all tracked playbacks. */
export function getActivePlaybacks() {
  return Array.from(activePlaybacks.entries()).map(([name, info]) => ({
    stream: name, ...info
  }));
}

/** Cleanup ALL stale playback streams from go2rtc. */
export async function cleanupAllPlaybacks(): Promise<void> {
  try {
    const res = await fetch(`${go2rtcApi}/api/streams`);
    if (!res.ok) return;
    const data = await res.json() as Record<string, unknown>;
    const playbackStreams = Object.keys(data).filter(id => id.startsWith('playback_'));
    for (const name of playbackStreams) {
      await deleteStream(name);
    }
    activePlaybacks.clear();
  } catch {}
}

/** Check if go2rtc is reachable. */
export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${go2rtcApi}/api/streams`);
    return res.ok;
  } catch {
    return false;
  }
}
