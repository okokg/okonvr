import { registry } from './camera-registry';
import { httpGetBuffer } from '../utils/http-client';

const GO2RTC_API = process.env.GO2RTC_API || 'http://go2rtc:1984';
const SNAPSHOT_INTERVAL = 30_000; // 30 seconds
const FETCH_DELAY = 200;         // delay between sequential fetches (native is fast)

/** In-memory cache: cameraId → { jpeg: Buffer, ts: number } */
const cache = new Map<string, { jpeg: Buffer; ts: number }>();

let running = false;

/** Get cached snapshot for a camera. Returns null if not available. */
export function getSnapshot(cameraId: string): { jpeg: Buffer; ts: number } | null {
  return cache.get(cameraId) || null;
}

/** Fetch snapshot from NVR's native HTTP API (fast: ~100-200ms). */
async function fetchNativeSnapshot(cameraId: string): Promise<Buffer | null> {
  const entry = registry.getEntry(cameraId);
  if (!entry) return null;

  const url = entry.provider.getSnapshotUrl(entry.camera);
  if (!url) return null;

  return httpGetBuffer(url, entry.provider.auth);
}

/** Fetch snapshot from go2rtc frame.jpeg API (slow: ~1-2s, needs keyframe). */
async function fetchGo2rtcSnapshot(cameraId: string): Promise<Buffer | null> {
  const url = `${GO2RTC_API}/api/frame.jpeg?src=${encodeURIComponent(cameraId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/** Run one cycle: fetch snapshots for all cameras sequentially. */
async function refreshAll(): Promise<void> {
  const ids = registry.allIds();
  let native = 0;
  let fallback = 0;
  let failed = 0;

  for (const id of ids) {
    const nativeJpeg = await fetchNativeSnapshot(id);
    if (nativeJpeg && nativeJpeg.length > 500) {
      cache.set(id, { jpeg: nativeJpeg, ts: Date.now() });
      native++;
    } else {
      const go2rtcJpeg = await fetchGo2rtcSnapshot(id);
      if (go2rtcJpeg && go2rtcJpeg.length > 500) {
        cache.set(id, { jpeg: go2rtcJpeg, ts: Date.now() });
        fallback++;
      } else {
        failed++;
      }
    }

    await new Promise(r => setTimeout(r, FETCH_DELAY));
  }

  const total = ids.length;
  console.log(`[snapshot] Refreshed ${native + fallback}/${total} (${native} native, ${fallback} go2rtc, ${failed} failed)`);
}

/** Start the background snapshot refresh loop. */
export function startSnapshotCache(): void {
  if (running) return;
  running = true;

  // First run after 5s (let go2rtc connect to cameras first)
  setTimeout(async () => {
    await refreshAll();
    setInterval(() => refreshAll(), SNAPSHOT_INTERVAL);
  }, 5000);

  console.log(`[snapshot] Cache started (interval=${SNAPSHOT_INTERVAL / 1000}s, native+go2rtc fallback)`);
}
