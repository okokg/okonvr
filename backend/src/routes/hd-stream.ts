import { FastifyInstance } from 'fastify';
import { probeCodecs } from '../services/codec-prober';
import { registry } from '../services/camera-registry';
import { createStream, deleteStream } from '../services/stream-manager';

/** Active HD streams: streamName → cameraId */
const activeHdStreams = new Map<string, string>();

export async function hdStreamRoutes(fastify: FastifyInstance) {
  /**
   * POST /hd-stream — create a temporary HD (main-stream 01) in go2rtc.
   * Body: { camera: "D28" }
   * Returns: { stream, camera, codec, audio, forceMSE }
   */
  fastify.post('/hd-stream', async (req, reply) => {
    const { camera: cameraId } = (req.body || {}) as any;

    if (!cameraId) {
      return reply.code(400).send({ error: 'camera required' });
    }

    const entry = registry.getEntry(cameraId);
    if (!entry) {
      return reply.code(400).send({ error: 'unknown camera ID' });
    }

    // Clean up previous HD stream for this camera
    for (const [name, id] of activeHdStreams) {
      if (id === cameraId) {
        await deleteStream(name).catch(() => {});
        activeHdStreams.delete(name);
      }
    }

    const streamName = `hd_${cameraId}`;
    const codecs = probeCodecs(cameraId);
    const source = entry.provider.getProbeUrl(entry.camera);

    // HEVC main-stream → needs MSE (WebRTC doesn't support HEVC)
    const forceMSE = codecs.video === 'hevc';

    fastify.log.info(`HD stream ${cameraId}: ${codecs.video}, audio=${codecs.audio}${forceMSE ? ' (MSE)' : ''}`);

    try {
      await createStream(streamName, source);
      activeHdStreams.set(streamName, cameraId);
      return {
        stream: streamName,
        camera: cameraId,
        codec: codecs.video,
        audio: codecs.audio,
        forceMSE,
      };
    } catch (e: any) {
      fastify.log.error(`HD stream create failed: ${e.message}`);
      return reply.code(500).send({ error: e.message });
    }
  });

  /** DELETE /hd-stream/:camera — remove HD stream for a camera. */
  fastify.delete('/hd-stream/:camera', async (req) => {
    const { camera: cameraId } = req.params as { camera: string };
    const streamName = `hd_${cameraId}`;

    await deleteStream(streamName).catch(() => {});
    activeHdStreams.delete(streamName);

    return { ok: true };
  });
}
