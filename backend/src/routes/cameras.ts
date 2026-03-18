import { FastifyInstance } from 'fastify';
import { db, stmts } from '../db';
import { fetchStreams } from '../services/stream-manager';

export async function cameraRoutes(fastify: FastifyInstance) {
  // GET /cameras — list all cameras (go2rtc streams + DB metadata)
  fastify.get('/cameras', async () => {
    const allStreams = await fetchStreams();
    // Filter out temporary streams (hd_, playback_)
    const streamIds = allStreams.filter(id => !id.startsWith('hd_') && !id.startsWith('playback_'));
    const dbRows = stmts.getAll.all() as any[];

    // Ensure all streams have a DB row
    const dbIds = new Set(dbRows.map((r: any) => r.id));
    const insertMany = db.transaction((ids: string[]) => {
      ids.forEach((id, i) => stmts.insertIgnore.run(id, i));
    });
    const newIds = streamIds.filter(id => !dbIds.has(id));
    if (newIds.length > 0) insertMany(newIds);

    // Merge and sort
    const allRows = stmts.getAll.all() as any[];
    const dbMap = new Map(allRows.map((r: any) => [r.id, r]));
    const cameras = streamIds.map((id, i) => {
      const meta = dbMap.get(id);
      const audio = meta?.main_audio || '';
      const codec = meta?.main_codec || '';
      return {
        id,
        label: meta?.label || '',
        group: meta?.group || '',
        sort_order: meta?.sort_order ?? i,
        codec: codec || null,
        has_audio: !!(audio && audio !== 'none' && audio !== 'unknown' && audio !== ''),
      };
    });
    cameras.sort((a, b) => a.sort_order - b.sort_order);
    return cameras;
  });

  // PUT /cameras/:id — update label and/or group
  fastify.put('/cameras/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { label, group } = (req.body || {}) as any;

    const existing = stmts.get.get(id) as any;
    if (!existing) return reply.code(404).send({ error: 'Camera not found' });

    stmts.updateMeta.run({
      id,
      label: label !== undefined ? label : existing.label,
      group: group !== undefined ? group : existing.group,
    });
    return stmts.get.get(id);
  });

  // PUT /cameras/order — save camera order
  fastify.put('/cameras/order', async (req, reply) => {
    const { order } = (req.body || {}) as { order?: string[] };
    if (!Array.isArray(order)) {
      return reply.code(400).send({ error: 'order must be an array of camera IDs' });
    }
    const updateMany = db.transaction((ids: string[]) => {
      ids.forEach((id, i) => stmts.updateOrder.run(i, id));
    });
    updateMany(order);
    return { ok: true };
  });
}
