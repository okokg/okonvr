import { FastifyInstance } from 'fastify';
import { RESOLUTIONS } from '../providers';
import { probeCodecs } from '../services/codec-prober';
import { registry } from '../services/camera-registry';
import {
  createStream, deleteStream, trackPlayback, untrackPlayback,
  getActivePlaybacks, cleanupAllPlaybacks
} from '../services/stream-manager';

function validateDatetime(dt: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(dt) && !isNaN(new Date(dt).getTime());
}

export async function playbackRoutes(fastify: FastifyInstance) {
  // POST /playback — create a playback stream
  fastify.post('/playback', async (req, reply) => {
    const { camera: cameraId, start, end, resolution = 'original' } = (req.body || {}) as any;

    if (!cameraId || !start || !end) {
      return reply.code(400).send({ error: 'camera, start, end required' });
    }

    const entry = registry.getEntry(cameraId);
    if (!entry) {
      return reply.code(400).send({ error: 'unknown camera ID' });
    }

    if (!validateDatetime(start) || !validateDatetime(end)) {
      return reply.code(400).send({ error: 'invalid datetime format' });
    }

    if (!RESOLUTIONS.hasOwnProperty(resolution)) {
      return reply.code(400).send({ error: 'invalid resolution' });
    }

    const streamName = `playback_${cameraId}_${Date.now()}`;
    const codecs = probeCodecs(cameraId);
    const startDate = new Date(start);
    const endDate = new Date(end);

    const { source, forceMSE } = entry.provider.buildPlaybackSource({
      camera: entry.camera, start: startDate, end: endDate, resolution, codecs
    });

    fastify.log.info(`Playback ${cameraId} [${entry.nvrName}]: ${codecs.video} ${resolution}, audio=${codecs.audio}${forceMSE ? ' (MSE)' : ''}`);

    try {
      await createStream(streamName, source);
      trackPlayback(streamName, cameraId);
      return {
        stream: streamName,
        camera: cameraId,
        codec: codecs.video,
        audio: codecs.audio,
        resolution,
        forceMSE,
      };
    } catch (e: any) {
      fastify.log.error(`Playback create failed: ${e.message}`);
      return reply.code(500).send({ error: e.message });
    }
  });

  fastify.delete('/playback/:stream', async (req) => {
    const { stream } = req.params as { stream: string };
    await deleteStream(stream);
    untrackPlayback(stream);
    await deleteStream(`${stream}_raw`);
    untrackPlayback(`${stream}_raw`);
    return { ok: true };
  });

  fastify.get('/playback', async () => getActivePlaybacks());

  fastify.delete('/playback', async () => {
    await cleanupAllPlaybacks();
    return { ok: true };
  });

  fastify.post('/playback/cleanup', async () => {
    await cleanupAllPlaybacks();
    return { ok: true };
  });
}
