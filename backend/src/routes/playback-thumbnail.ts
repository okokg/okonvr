import { FastifyInstance } from 'fastify';
import { execFile } from 'child_process';
import { registry } from '../services/camera-registry';

/** LRU cache for playback thumbnails: key → { jpeg, ts } */
const cache = new Map<string, { jpeg: Buffer; ts: number }>();
const MAX_CACHE = 200;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** In-flight requests: avoid duplicate ffmpeg for same key */
const inflight = new Map<string, Promise<Buffer | null>>();

function cacheKey(cameraId: string, t: Date): string {
  // Round to 30-second intervals for cache hits on nearby hovers
  const rounded = new Date(Math.round(t.getTime() / 30000) * 30000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${cameraId}_${rounded.getFullYear()}${pad(rounded.getMonth()+1)}${pad(rounded.getDate())}T${pad(rounded.getHours())}${pad(rounded.getMinutes())}${pad(rounded.getSeconds())}`;
}

function evictOld() {
  // Remove expired entries
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.ts > CACHE_TTL) cache.delete(k);
  }
  // If still over limit, remove oldest
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
}

function grabFrame(rtspUrl: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const args = [
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
      '-vframes', '1',
      '-f', 'image2',
      '-q:v', '6',
      '-vf', 'scale=320:-1',
      '-y',
      'pipe:1',
    ];

    const proc = execFile('ffmpeg', args, {
      encoding: 'buffer',
      timeout: 8000,
      maxBuffer: 2 * 1024 * 1024,
    }, (err, stdout) => {
      if (err || !stdout || stdout.length < 500) {
        resolve(null);
      } else {
        resolve(stdout);
      }
    });

    // Suppress stderr noise
    proc.stderr?.resume();
  });
}

export async function playbackThumbnailRoutes(fastify: FastifyInstance) {
  // GET /playback-thumbnail/:cameraId?t=2026-03-21T12:30:00
  fastify.get('/playback-thumbnail/:cameraId', async (req, reply) => {
    const { cameraId } = req.params as { cameraId: string };
    const { t } = req.query as { t?: string };

    if (!t) {
      return reply.code(400).send({ error: 't (ISO timestamp) required' });
    }

    const seekTime = new Date(t);
    if (isNaN(seekTime.getTime())) {
      return reply.code(400).send({ error: 'invalid timestamp' });
    }

    const entry = registry.getEntry(cameraId);
    if (!entry) {
      return reply.code(404).send({ error: 'unknown camera' });
    }

    // Check cache
    const key = cacheKey(cameraId, seekTime);
    const cached = cache.get(key);
    if (cached) {
      return reply
        .header('Content-Type', 'image/jpeg')
        .header('Cache-Control', 'public, max-age=300')
        .header('X-Thumbnail-Cache', 'hit')
        .send(cached.jpeg);
    }

    // Deduplicate in-flight requests
    if (inflight.has(key)) {
      const jpeg = await inflight.get(key);
      if (jpeg) {
        return reply
          .header('Content-Type', 'image/jpeg')
          .header('Cache-Control', 'public, max-age=300')
          .send(jpeg);
      }
      return reply.code(404).send({ error: 'thumbnail generation failed' });
    }

    // Build RTSP playback URL for 10-second window
    const start = new Date(seekTime.getTime());
    const end = new Date(seekTime.getTime() + 10000);
    const rtspUrl = entry.provider.getPlaybackUrl(entry.camera, start, end);

    // Grab frame
    const promise = grabFrame(rtspUrl);
    inflight.set(key, promise);

    try {
      const jpeg = await promise;
      inflight.delete(key);

      if (!jpeg) {
        return reply.code(404).send({ error: 'no frame available' });
      }

      // Cache it
      evictOld();
      cache.set(key, { jpeg, ts: Date.now() });

      return reply
        .header('Content-Type', 'image/jpeg')
        .header('Cache-Control', 'public, max-age=300')
        .header('X-Thumbnail-Cache', 'miss')
        .send(jpeg);
    } catch {
      inflight.delete(key);
      return reply.code(500).send({ error: 'thumbnail generation error' });
    }
  });
}
