import { FastifyInstance } from 'fastify';
import { db, stmts } from '../db';
import { checkHealth, cleanupSessionStreams } from '../services/stream-manager';
import { clearCodecCache } from '../services/codec-prober';
import { getUiConfig } from '../services/config-store';
import { getNvrStatuses } from '../services/nvr-health';

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get('/health', async () => {
    const go2rtcOk = await checkHealth();
    const cameras = (stmts.getAll.all() as any[]).length;
    return {
      status: 'ok',
      version: '0.1.0',
      go2rtc: go2rtcOk ? 'connected' : 'unreachable',
      cameras,
    };
  });

  /** NVR health status — circuit breaker state for each NVR. */
  fastify.get('/health/nvrs', async () => getNvrStatuses());

  /** UI configuration from oko.yaml. */
  fastify.get('/config/ui', async () => getUiConfig());

  /** Reset all cached codec info — forces re-probe on next playback. */
  fastify.post('/reset-codecs', async () => {
    db.exec("UPDATE cameras SET main_codec = '', main_audio = ''");
    clearCodecCache();
    const affected = db.prepare('SELECT changes() as n').get() as any;
    console.log(`[reset-codecs] Cleared codec cache for all cameras`);
    return { ok: true, cleared: affected?.n || 0 };
  });

  /** Cleanup all client-session streams (HD, playback, transcode). Called on tab close via sendBeacon. */
  fastify.post('/cleanup-session', async () => {
    await cleanupSessionStreams();
    return { ok: true };
  });
}
