import { FastifyInstance } from 'fastify';
import { getSmartEvents } from '../services/smart-events';

export async function eventRoutes(fastify: FastifyInstance) {
  /**
   * GET /events/:cameraId?date=YYYY-MM-DD
   *
   * Returns smart motion detection events for a camera on a given date.
   * Each event has start/end in seconds from midnight and type (human/vehicle).
   *
   * Response: { events: [{start, end, type}], date: "YYYY-MM-DD" }
   */
  fastify.get('/events/:cameraId', async (req, reply) => {
    const { cameraId } = req.params as { cameraId: string };
    const { date } = req.query as { date?: string };

    // Default to today
    const d = new Date();
    const dateStr = date || `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return reply.code(400).send({ error: 'Invalid date format, use YYYY-MM-DD' });
    }

    try {
      const events = await getSmartEvents(cameraId, dateStr);
      reply
        .header('Cache-Control', date === dateStr ? 'no-cache' : 'max-age=86400')
        .send({ events, date: dateStr });
    } catch (e: any) {
      reply.code(500).send({ error: e.message });
    }
  });
}
