import { registry } from './camera-registry';
import { httpGetBuffer } from '../utils/http-client';
import { SnapshotsConfig } from '../config';

let GO2RTC_API = 'http://go2rtc:1984';
let config: SnapshotsConfig = {
  enabled: true,
  interval: 30,
  source: 'auto',
  delay: 200,
  timeout: 8000,
};

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

  return httpGetBuffer(url, entry.provider.auth, config.timeout);
}

/** Fetch snapshot from go2rtc frame.jpeg API (slow: ~1-2s, needs keyframe). */
async function fetchGo2rtcSnapshot(cameraId: string): Promise<Buffer | null> {
  const url = `${GO2RTC_API}/api/frame.jpeg?src=${encodeURIComponent(cameraId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout);

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
    let jpeg: Buffer | null = null;

    if (config.source === 'native' || config.source === 'auto') {
      jpeg = await fetchNativeSnapshot(id);
      if (jpeg && jpeg.length > 500) {
        cache.set(id, { jpeg, ts: Date.now() });
        native++;
        await new Promise(r => setTimeout(r, config.delay));
        continue;
      }
    }

    if (config.source === 'go2rtc' || config.source === 'auto') {
      jpeg = await fetchGo2rtcSnapshot(id);
      if (jpeg && jpeg.length > 500) {
        cache.set(id, { jpeg, ts: Date.now() });
        fallback++;
        await new Promise(r => setTimeout(r, config.delay));
        continue;
      }
    }

    failed++;
    await new Promise(r => setTimeout(r, config.delay));
  }

  const total = ids.length;
  const src = config.source === 'auto' ? `${native} native, ${fallback} go2rtc` :
    config.source === 'native' ? `${native} native` : `${fallback} go2rtc`;
  console.log(`[snapshot] Refreshed ${native + fallback}/${total} (${src}, ${failed} failed)`);
}

/** Start the background snapshot refresh loop. */
export function startSnapshotCache(snapshotsConfig: SnapshotsConfig, go2rtcApi: string): void {
  if (running) return;
  config = snapshotsConfig;
  GO2RTC_API = go2rtcApi;

  if (!config.enabled) {
    console.log('[snapshot] Cache disabled in config');
    return;
  }

  running = true;
  const intervalMs = config.interval * 1000;

  // First run after 5s (let go2rtc connect to cameras first)
  setTimeout(async () => {
    await refreshAll();
    setInterval(() => refreshAll(), intervalMs);
  }, 5000);

  console.log(`[snapshot] Cache started (source=${config.source}, interval=${config.interval}s, delay=${config.delay}ms)`);
}
