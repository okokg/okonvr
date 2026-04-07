/**
 * detect-sse.ts — Server-Sent Events stream for Coral detection results.
 *
 * Regular HTTP response with text/event-stream — works through ANY proxy.
 * No WebSocket upgrade needed. Browser auto-reconnects via EventSource API.
 *
 * Polls Python detect service internally (Docker network, fast),
 * pushes results to connected SSE clients.
 * Polling only runs when at least one client is connected.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

const DETECT_URL = process.env.DETECT_URL || 'http://detect:3001';
const POLL_INTERVAL = 66; // ~15fps internal poll

// ── Connected clients ──

interface SseClient {
  reply: FastifyReply;
  id: number;
}

let nextId = 0;
const clients = new Map<number, SseClient>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastJson = '';  // dedup: only send when data changes
let activeCamera: string | null = null;

// ── SSE helpers ──

function sendEvent(reply: FastifyReply, data: string, event?: string): boolean {
  try {
    const raw = reply.raw;
    if (raw.destroyed || raw.writableEnded) return false;
    if (event) raw.write(`event: ${event}\n`);
    raw.write(`data: ${data}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function broadcast(data: string, event?: string) {
  for (const [id, client] of [...clients]) {
    if (!sendEvent(client.reply, data, event)) {
      removeClient(id);
    }
  }
}

// ── Client management ──

function addClient(reply: FastifyReply): number {
  const id = ++nextId;
  clients.set(id, { reply, id });
  console.log(`[detect-sse] Client ${id} connected (${clients.size} total)`);

  // If detection is already running, start polling for this client
  if (activeCamera && !pollTimer) {
    startPolling();
  }

  return id;
}

function removeClient(id: number) {
  const client = clients.get(id);
  if (!client) return;
  clients.delete(id);
  try { client.reply.raw.end(); } catch {}
  console.log(`[detect-sse] Client ${id} disconnected (${clients.size} remaining)`);
  if (clients.size === 0) {
    stopPolling();
  }
}

// ── Internal polling (detect service → SSE clients) ──

let pollInFlight = false;

async function pollDetect() {
  if (pollInFlight || clients.size === 0) return;
  pollInFlight = true;
  try {
    const resp = await fetch(`${DETECT_URL}/results`, { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return;
    const json = await resp.text();

    // Dedup: only broadcast if data changed
    if (json !== lastJson) {
      lastJson = json;
      broadcast(json);
    }
  } catch {
    // detect service unreachable — skip silently
  } finally {
    pollInFlight = false;
  }
}

function startPolling() {
  if (pollTimer) return;
  console.log(`[detect-sse] Starting poll (${POLL_INTERVAL}ms, camera=${activeCamera})`);
  lastJson = '';
  pollTimer = setInterval(pollDetect, POLL_INTERVAL);
  pollDetect(); // first poll immediately
}

function stopPolling() {
  if (!pollTimer) return;
  console.log('[detect-sse] Stopping poll');
  clearInterval(pollTimer);
  pollTimer = null;
  lastJson = '';
}

// ── Detection control (called from detect routes) ──

export async function startDetection(camera: string): Promise<any> {
  activeCamera = camera;
  try {
    const resp = await fetch(`${DETECT_URL}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ camera }),
      signal: AbortSignal.timeout(3000),
    });
    const data = await resp.json();
    console.log(`[detect-sse] Detection started on ${camera}`);
    broadcast(JSON.stringify({ type: 'started', camera, ...data }), 'control');
    // Start polling when detection starts and clients are connected
    if (clients.size > 0) startPolling();
    return data;
  } catch (e: any) {
    console.log(`[detect-sse] Start failed: ${e.message}`);
    // Start polling anyway — detect service might become available
    if (clients.size > 0) startPolling();
    return null;
  }
}

export async function stopDetection(): Promise<void> {
  activeCamera = null;
  stopPolling();
  try {
    await fetch(`${DETECT_URL}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
  broadcast(JSON.stringify({ type: 'stopped' }), 'control');
}

// ── Fastify route ──

export async function detectSseRoute(fastify: FastifyInstance) {
  /**
   * GET /detect/stream — SSE endpoint for detection results.
   * Browser connects with EventSource, receives push updates.
   */
  fastify.get('/detect/stream', async (req, reply) => {
    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    });

    // Send initial comment to establish connection
    reply.raw.write(': ok\n\n');

    const clientId = addClient(reply);

    // Send current state
    if (activeCamera) {
      sendEvent(reply, JSON.stringify({ type: 'started', camera: activeCamera }), 'control');
    }

    // Clean up on client disconnect
    req.raw.on('close', () => {
      removeClient(clientId);
    });

    // Keep the response open (don't call reply.send)
    // Fastify needs to know we're handling this ourselves
    reply.hijack();
  });
}

/** Get current SSE stats. */
export function getDetectSseStats() {
  return {
    clients: clients.size,
    polling: pollTimer !== null,
    camera: activeCamera,
  };
}
