import { FastifyInstance } from 'fastify';
import { registry } from '../services/camera-registry';
import { createStream, deleteStream } from '../services/stream-manager';

/** Active talkback streams: streamName → cameraId */
const activeTalkback = new Map<string, string>();

export async function talkbackRoutes(fastify: FastifyInstance) {
  /**
   * POST /talkback/:camera/start — create a go2rtc stream with backchannel.
   * Frontend connects to this stream via WebRTC with mic audio track.
   * Returns: { stream, camera }
   */
  fastify.post('/talkback/:camera/start', async (req, reply) => {
    const { camera: cameraId } = req.params as { camera: string };

    if (!registry.has(cameraId)) {
      return reply.code(404).send({ error: 'unknown camera' });
    }

    if (!registry.hasTalkback(cameraId)) {
      return reply.code(400).send({ error: 'camera does not support talkback' });
    }

    const entry = registry.getEntry(cameraId);
    if (!entry) {
      return reply.code(500).send({ error: 'camera entry not found' });
    }

    const source = entry.provider.getTalkbackSource(entry.camera);
    if (!source) {
      return reply.code(400).send({ error: 'talkback source not available for this provider' });
    }

    // Clean up previous talkback for this camera
    const prevStream = `__tb_${cameraId}`;
    if (activeTalkback.has(prevStream)) {
      await deleteStream(prevStream).catch(() => {});
      activeTalkback.delete(prevStream);
    }

    const streamName = `__tb_${cameraId}`;

    try {
      await createStream(streamName, source);
      activeTalkback.set(streamName, cameraId);
      fastify.log.info(`Talkback started: ${cameraId} → ${streamName}`);
      return { stream: streamName, camera: cameraId };
    } catch (e: any) {
      fastify.log.error(`Talkback create failed for ${cameraId}: ${e.message}`);
      return reply.code(500).send({ error: e.message });
    }
  });

  /**
   * DELETE /talkback/:camera/stop — remove talkback stream.
   */
  fastify.delete('/talkback/:camera/stop', async (req) => {
    const { camera: cameraId } = req.params as { camera: string };
    const streamName = `__tb_${cameraId}`;

    await deleteStream(streamName).catch(() => {});
    activeTalkback.delete(streamName);
    fastify.log.info(`Talkback stopped: ${cameraId}`);

    return { ok: true };
  });

  /**
   * GET /talkback/active — list active talkback sessions.
   */
  fastify.get('/talkback/active', async () => {
    return Array.from(activeTalkback.entries()).map(([stream, camera]) => ({
      stream, camera,
    }));
  });
}
