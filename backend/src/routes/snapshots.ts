import { FastifyInstance } from 'fastify';
import { getSnapshot } from '../services/snapshot-cache';

export async function snapshotRoutes(fastify: FastifyInstance) {
  // GET /snapshot/:cameraId — serve cached JPEG snapshot
  fastify.get('/snapshot/:cameraId', async (req, reply) => {
    const { cameraId } = req.params as { cameraId: string };
    const snap = getSnapshot(cameraId);

    if (!snap) {
      return reply.code(404).send({ error: 'no snapshot available' });
    }

    reply
      .header('Content-Type', 'image/jpeg')
      .header('Cache-Control', 'no-cache, max-age=30')
      .header('X-Snapshot-Age', snap.ts > 0 ? String(Math.round((Date.now() - snap.ts) / 1000)) : 'stale')
      .send(snap.jpeg);
  });
}
