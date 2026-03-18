import { encodeGo2rtcSource } from '../utils/url-encoder';

let go2rtcApi = 'http://go2rtc:1984';

/** Active playback streams: { streamName: { camera, created } } */
const activePlaybacks = new Map<string, { camera: string; created: number }>();

export function initStreamManager(apiUrl: string) {
  go2rtcApi = apiUrl;
}

/** Get go2rtc API base URL. */
export function getGo2rtcApi(): string {
  return go2rtcApi;
}

/** Fetch all stream IDs from go2rtc. */
export async function fetchStreams(): Promise<string[]> {
  try {
    const res = await fetch(`${go2rtcApi}/api/streams`);
    if (!res.ok) throw new Error(`go2rtc HTTP ${res.status}`);
    const data = await res.json() as Record<string, unknown>;
    return Object.keys(data);
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

/** Cleanup stale playback streams from go2rtc. Called from frontend on page load. */
export async function cleanupPlaybackStreams(): Promise<void> {
  try {
    const res = await fetch(`${go2rtcApi}/api/streams`);
    if (!res.ok) return;
    const data = await res.json() as Record<string, unknown>;
    const stale = Object.keys(data).filter(id =>
      id.startsWith('__pb_') || id.startsWith('playback_')
    );
    for (const name of stale) {
      await deleteStream(name);
    }
    activePlaybacks.clear();
    if (stale.length > 0) {
      console.log(`[cleanup] Removed ${stale.length} playback streams`);
    }
  } catch {}
}

/** Cleanup ALL internal streams from go2rtc. Called on backend startup only. */
export async function cleanupAllInternal(): Promise<void> {
  try {
    const res = await fetch(`${go2rtcApi}/api/streams`);
    if (!res.ok) return;
    const data = await res.json() as Record<string, unknown>;
    const stale = Object.keys(data).filter(id =>
      id.startsWith('__') ||
      id.startsWith('playback_') || id.startsWith('hd_') || id.startsWith('t_')
    );
    for (const name of stale) {
      await deleteStream(name);
    }
    activePlaybacks.clear();
    if (stale.length > 0) {
      console.log(`[cleanup] Startup: removed ${stale.length} internal streams`);
    }
  } catch {}
}

/** Cleanup ALL client-session streams (HD, playback, transcode) from go2rtc. */
export async function cleanupSessionStreams(): Promise<void> {
  try {
    const res = await fetch(`${go2rtcApi}/api/streams`);
    if (!res.ok) return;
    const data = await res.json() as Record<string, unknown>;
    const stale = Object.keys(data).filter(id =>
      id.startsWith('__hd_') || id.startsWith('__pb_') || id.startsWith('__t_')
    );
    for (const name of stale) {
      await deleteStream(name);
    }
    activePlaybacks.clear();
    if (stale.length > 0) {
      console.log(`[cleanup] Session: removed ${stale.length} streams (${stale.join(', ')})`);
    }
  } catch {}
}

/** Reap orphaned session streams — those with 0 consumers for longer than TTL. */
const orphanSeen = new Map<string, number>(); // streamName → first seen with 0 consumers

export async function reapOrphanStreams(ttlMs = 30000): Promise<void> {
  try {
    const res = await fetch(`${go2rtcApi}/api/streams`);
    if (!res.ok) return;
    const data = await res.json() as Record<string, unknown>;
    const sessionStreams = Object.keys(data).filter(id =>
      id.startsWith('__hd_') || id.startsWith('__pb_') || id.startsWith('__t_')
    );

    if (sessionStreams.length === 0) {
      orphanSeen.clear();
      return;
    }

    const now = Date.now();

    for (const name of sessionStreams) {
      try {
        const sRes = await fetch(`${go2rtcApi}/api/streams?src=${encodeURIComponent(name)}`);
        if (!sRes.ok) continue;
        const info = await sRes.json() as { producers?: any[]; consumers?: any[] };
        const producers = info.producers?.length || 0;
        const consumers = info.consumers?.length || 0;

        // A stream is orphaned if it has no consumers (WebRTC/MSE clients)
        // OR if it only has producers but no one watching
        const isOrphan = consumers === 0;

        console.log(`[reaper] ${name}: producers=${producers} consumers=${consumers} orphan=${isOrphan}`);

        if (!isOrphan) {
          orphanSeen.delete(name);
        } else {
          if (!orphanSeen.has(name)) {
            orphanSeen.set(name, now);
          }
          const age = now - orphanSeen.get(name)!;
          if (age >= ttlMs) {
            console.log(`[reaper] ${name}: removing (0 consumers for ${Math.round(age / 1000)}s)`);
            await deleteStream(name);
            orphanSeen.delete(name);
          }
        }
      } catch {}
    }

    // Clean stale entries
    for (const name of orphanSeen.keys()) {
      if (!sessionStreams.includes(name)) orphanSeen.delete(name);
    }
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
