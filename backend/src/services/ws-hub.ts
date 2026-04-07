/**
 * ws-hub.ts — Central WebSocket hub for OKO NVR.
 *
 * Endpoints:
 *   GET  /ws                — WebSocket for browser clients
 *   POST /internal/detect   — Push endpoint for Python detect service (no polling)
 *
 * Flow: detect inference → POST /internal/detect → broadcast to WS subscribers
 * Latency: ~5ms instead of ~66ms polling interval
 */

import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';

const DETECT_URL = process.env.DETECT_URL || 'http://detect:3001';

// ── Client tracking ──

interface WsClient {
  socket: WebSocket;
  channels: Set<string>;
}

const clients = new Set<WsClient>();

// ── Detect state ──

let activeCamera: string | null = null;

// ── Helpers ──

function send(client: WsClient, msg: object): boolean {
  if (client.socket.readyState !== WebSocket.OPEN) return false;
  try {
    client.socket.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

function broadcast(channel: string, data: any) {
  const msg = { ch: channel, data };
  for (const c of [...clients]) {
    if (!c.channels.has(channel)) continue;
    if (!send(c, msg)) removeClient(c);
  }
}

function removeClient(client: WsClient) {
  if (!clients.delete(client)) return;
  try { client.socket.close(); } catch {}
  console.log(`[ws-hub] Client disconnected (${clients.size} left)`);
}

function subscriberCount(channel: string): number {
  let n = 0;
  for (const c of clients) {
    if (c.channels.has(channel)) n++;
  }
  return n;
}

// ── Command handlers ──

async function handleDetectStart(client: WsClient, camera: string) {
  activeCamera = camera;
  try {
    const r = await fetch(`${DETECT_URL}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ camera }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await r.json();
    console.log(`[ws-hub] Detection started on ${camera}`);
    send(client, { ch: 'detect', data: { type: 'started', camera, ...data } });
  } catch (e: any) {
    console.log(`[ws-hub] Detect start failed: ${e.message}`);
    send(client, { ch: 'detect', data: { type: 'error', error: e.message } });
  }
}

async function handleDetectStop(client: WsClient) {
  activeCamera = null;
  try {
    await fetch(`${DETECT_URL}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
  broadcast('detect', { type: 'stopped' });
}

async function handleDetectStatus(client: WsClient) {
  try {
    const r = await fetch(`${DETECT_URL}/status`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const data = await r.json();
      send(client, { ch: 'detect', data: { type: 'status', available: true, ...data } });
    } else {
      send(client, { ch: 'detect', data: { type: 'status', available: false } });
    }
  } catch {
    send(client, { ch: 'detect', data: { type: 'status', available: false } });
  }
}

// ── Message router ──

function handleMessage(client: WsClient, raw: string) {
  let msg: any;
  try { msg = JSON.parse(raw); } catch { return; }

  const { ch, cmd, channels, camera } = msg;

  if (ch === 'subscribe' && Array.isArray(channels)) {
    client.channels = new Set(channels);
    send(client, { ch: 'subscribed', data: { channels } });
    console.log(`[ws-hub] Client subscribed: [${channels.join(', ')}]`);

    if (client.channels.has('detect') && activeCamera) {
      send(client, { ch: 'detect', data: { type: 'started', camera: activeCamera } });
    }
    return;
  }

  if (ch === 'detect') {
    if (cmd === 'start' && camera) handleDetectStart(client, camera);
    else if (cmd === 'stop') handleDetectStop(client);
    else if (cmd === 'status') handleDetectStatus(client);
    return;
  }
}

// ── Fastify plugin ──

export async function wsHubPlugin(fastify: FastifyInstance) {
  // WebSocket endpoint for browser clients
  fastify.get('/ws', { websocket: true }, (socket: WebSocket, req) => {
    const client: WsClient = { socket, channels: new Set() };
    clients.add(client);
    console.log(`[ws-hub] Client connected (${clients.size} total)`);

    send(client, {
      ch: 'welcome',
      data: {
        version: '1.0',
        channels: ['detect', 'stats', 'event'],
        activeCamera,
      },
    });

    socket.on('message', (raw: Buffer | string) => {
      const str = typeof raw === 'string' ? raw : raw.toString('utf-8');
      handleMessage(client, str);
    });

    socket.on('close', () => removeClient(client));
    socket.on('error', () => removeClient(client));
  });

  // Push endpoint — Python detect POSTs results here after each inference
  fastify.post('/internal/detect', async (req, reply) => {
    const data = req.body as any;
    if (data && subscriberCount('detect') > 0) {
      broadcast('detect', data);
    }
    return reply.code(204).send();
  });
}

// ── Public API for other backend services ──

export function wsEmit(channel: string, data: any) {
  broadcast(channel, data);
}

export function wsHubStats() {
  return {
    clients: clients.size,
    activeCamera,
    subscribers: {
      detect: subscriberCount('detect'),
      stats: subscriberCount('stats'),
      event: subscriberCount('event'),
    },
  };
}
