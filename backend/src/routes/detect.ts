import { FastifyInstance } from 'fastify';
import { startDetection, stopDetection } from '../services/detect-sse';

const DETECT_URL = process.env.DETECT_URL || 'http://detect:3001';

async function proxyGet(url: string): Promise<any> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return null;
    return await resp.json();
  } catch { return null; }
}

export async function detectRoutes(fastify: FastifyInstance) {
  // GET /detect/status — is Coral detect service running?
  fastify.get('/detect/status', async (_req, reply) => {
    const data = await proxyGet(`${DETECT_URL}/status`);
    if (!data) return reply.send({ available: false, camera: null, running: false, backend: null, coral: false });
    return reply.send({ available: true, ...data });
  });

  // GET /detect/results — latest detections (kept for backward compat / debug)
  fastify.get('/detect/results', async (_req, reply) => {
    const data = await proxyGet(`${DETECT_URL}/results`);
    if (!data) return reply.send({ camera: null, detections: [], ts: 0, inferenceMs: 0 });
    return reply.send(data);
  });

  // POST /detect/start — start detecting on a camera (also starts SSE push)
  fastify.post('/detect/start', async (req, reply) => {
    const { camera } = req.body as { camera: string };
    if (!camera) return reply.code(400).send({ error: 'camera required' });
    const data = await startDetection(camera);
    if (!data) return reply.code(503).send({ error: 'detect service unavailable' });
    return reply.send(data);
  });

  // POST /detect/stop — stop detection (also stops SSE push)
  fastify.post('/detect/stop', async (_req, reply) => {
    await stopDetection();
    return reply.send({ ok: true });
  });

  // GET /detect/health — health check
  fastify.get('/detect/health', async (_req, reply) => {
    const data = await proxyGet(`${DETECT_URL}/health`);
    if (!data) return reply.send({ status: 'unavailable' });
    return reply.send(data);
  });

  // GET /detect/debug — diagnostic info (top confidences, tensor shape, quant params)
  fastify.get('/detect/debug', async (_req, reply) => {
    const data = await proxyGet(`${DETECT_URL}/debug`);
    if (!data) return reply.send({ error: 'unavailable' });
    return reply.send(data);
  });
}
