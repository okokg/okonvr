import { FastifyInstance } from 'fastify';
import { registry } from '../services/camera-registry';
import { createStream, deleteStream } from '../services/stream-manager';

/** Active transcode streams: streamName → cameraId */
const activeTranscodeStreams = new Map<string, string>();

export async function transcodeRoutes(fastify: FastifyInstance) {
  /**
   * POST /transcode-stream — create a temporary H.264 transcoded sub-stream.
   * Used when client can't decode H.265 (no GPU, Firefox, etc).
   * Body: { camera: "M4" }
   * Returns: { stream, camera }
   */
  fastify.post('/transcode-stream', async (req, reply) => {
    const { camera: cameraId } = (req.body || {}) as any;

    if (!cameraId) {
      return reply.code(400).send({ error: 'camera required' });
    }

    const entry = registry.getEntry(cameraId);
    if (!entry) {
      return reply.code(400).send({ error: 'unknown camera ID' });
    }

    const streamName = `t_${cameraId}`;

    // Already exists
    if (activeTranscodeStreams.has(streamName)) {
      return { stream: streamName, camera: cameraId };
    }

    // Create ffmpeg transcode: H.265 sub-stream → H.264
    const liveUrl = entry.provider.getLiveUrl(entry.camera);
    const source = `ffmpeg:${liveUrl}#video=h264`;

    fastify.log.info(`Transcode stream ${cameraId}: ${liveUrl} → H.264`);

    try {
      await createStream(streamName, source);
      activeTranscodeStreams.set(streamName, cameraId);
      return { stream: streamName, camera: cameraId };
    } catch (e: any) {
      fastify.log.error(`Transcode stream create failed: ${e.message}`);
      return reply.code(500).send({ error: e.message });
    }
  });

  /** DELETE /transcode-stream/:camera — remove transcode stream. */
  fastify.delete('/transcode-stream/:camera', async (req) => {
    const { camera: cameraId } = req.params as { camera: string };
    const streamName = `t_${cameraId}`;

    await deleteStream(streamName).catch(() => {});
    activeTranscodeStreams.delete(streamName);

    return { ok: true };
  });
}
