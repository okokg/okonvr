import { FastifyInstance } from 'fastify';
import { registry } from '../services/camera-registry';
import { getGo2rtcApi } from '../services/stream-manager';

/** LRU cache: key → { jpeg, ts } */
const cache = new Map<string, { jpeg: Buffer; ts: number }>();
const MAX_CACHE = 200;
const CACHE_TTL = 5 * 60 * 1000;

/** In-flight dedup */
const inflight = new Map<string, Promise<Buffer | null>>();

function cacheKey(cameraId: string, t: Date): string {
  // Round to 30-second intervals for cache hits on nearby hovers
  const rounded = new Date(Math.round(t.getTime() / 30000) * 30000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${cameraId}_${rounded.getFullYear()}${pad(rounded.getMonth()+1)}${pad(rounded.getDate())}T${pad(rounded.getHours())}${pad(rounded.getMinutes())}${pad(rounded.getSeconds())}`;
}

function evictOld() {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.ts > CACHE_TTL) cache.delete(k);
  }
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
}

/** Grab frame via go2rtc: pass RTSP playback URL directly to frame.jpeg */
async function fetchFrame(cameraId: string, time: Date): Promise<Buffer | null> {
  const entry = registry.getEntry(cameraId);
  if (!entry) return null;

  const start = new Date(time.getTime());
  const end = new Date(time.getTime() + 10000);
  const rtspUrl = entry.provider.getPlaybackUrl(entry.camera, start, end);
  const go2rtc = getGo2rtcApi();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(`${go2rtc}/api/frame.jpeg?src=${encodeURIComponent(rtspUrl)}`, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;

    const jpeg = Buffer.from(await res.arrayBuffer());
    return jpeg.length > 500 ? jpeg : null;
  } catch {
    return null;
  }
}

export async function playbackThumbnailRoutes(fastify: FastifyInstance) {
  fastify.get('/playback-thumbnail/:cameraId', async (req, reply) => {
    const { cameraId } = req.params as { cameraId: string };
    const { t } = req.query as { t?: string };

    if (!t) return reply.code(400).send({ error: 't (ISO timestamp) required' });

    const seekTime = new Date(t);
    if (isNaN(seekTime.getTime())) return reply.code(400).send({ error: 'invalid timestamp' });

    const entry = registry.getEntry(cameraId);
    if (!entry) return reply.code(404).send({ error: 'unknown camera' });

    // Cache check
    const key = cacheKey(cameraId, seekTime);
    const cached = cache.get(key);
    if (cached) {
      return reply
        .header('Content-Type', 'image/jpeg')
        .header('Cache-Control', 'public, max-age=300')
        .header('X-Thumbnail-Source', 'cache')
        .send(cached.jpeg);
    }

    // Dedup in-flight
    if (inflight.has(key)) {
      const jpeg = await inflight.get(key);
      if (jpeg) {
        return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'public, max-age=300').send(jpeg);
      }
      return reply.code(404).send({ error: 'thumbnail generation failed' });
    }

    // Fetch via go2rtc (no ffmpeg)
    const promise = fetchFrame(cameraId, seekTime);
    inflight.set(key, promise);

    try {
      const jpeg = await promise;
      inflight.delete(key);

      if (!jpeg) return reply.code(404).send({ error: 'no frame available' });

      evictOld();
      cache.set(key, { jpeg, ts: Date.now() });

      return reply
        .header('Content-Type', 'image/jpeg')
        .header('Cache-Control', 'public, max-age=300')
        .header('X-Thumbnail-Source', 'go2rtc')
        .send(jpeg);
    } catch {
      inflight.delete(key);
      return reply.code(500).send({ error: 'thumbnail generation error' });
    }
  });
}
