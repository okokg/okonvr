/**
 * detect-ws.ts — WebSocket hub for Coral detection results.
 *
 * Raw WebSocket implementation (zero dependencies).
 * Polls Python detect service internally (Docker network, fast),
 * broadcasts results to all connected browser clients via WS.
 *
 * Key: polling starts only AFTER client sends {type:"start"} —
 * never polls without an active camera target.
 */

import { createHash } from 'crypto';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';

const DETECT_URL = process.env.DETECT_URL || 'http://detect:3001';
const POLL_INTERVAL = 66; // ~15fps internal poll
const PING_INTERVAL = 30000; // 30s keepalive ping

// ── Connected clients ──

const clients = new Set<Duplex>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let lastJson = '';  // dedup: only send when data changes
let activeCamera: string | null = null;  // currently detecting camera

// ── Raw WebSocket helpers ──

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-5AB5DC65F5B0';

function acceptKey(key: string): string {
  return createHash('sha1').update(key + WS_MAGIC).digest('base64');
}

/** Send a text frame (server→client, unmasked). */
function sendFrame(socket: Duplex, data: string): boolean {
  if (socket.destroyed) return false;
  const payload = Buffer.from(data, 'utf-8');
  const len = payload.length;
  let header: Buffer;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text opcode
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  try {
    socket.write(Buffer.concat([header, payload]));
    return true;
  } catch (e: any) {
    console.log(`[detect-ws] sendFrame error: ${e.message}`);
    return false;
  }
}

/** Parse a single WS frame from buffer. Returns { opcode, payload, consumed } or null. */
function parseFrame(buf: Buffer): { opcode: number; payload: Buffer; consumed: number } | null {
  if (buf.length < 2) return null;

  const byte0 = buf[0];
  const byte1 = buf[1];
  const opcode = byte0 & 0x0f;
  const masked = (byte1 & 0x80) !== 0;
  let payloadLen = byte1 & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  if (masked) {
    if (buf.length < offset + 4 + payloadLen) return null;
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = buf[offset + i] ^ mask[i & 3];
    }
    return { opcode, payload, consumed: offset + payloadLen };
  } else {
    if (buf.length < offset + payloadLen) return null;
    return { opcode, payload: buf.subarray(offset, offset + payloadLen), consumed: offset + payloadLen };
  }
}

/** Send a pong frame in response to ping. */
function sendPong(socket: Duplex, payload: Buffer) {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x8a; // FIN + pong
    header[1] = len;
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x8a;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  }
  try { socket.write(Buffer.concat([header, payload])); } catch {}
}

/** Send a ping frame (keepalive). */
function sendPing(socket: Duplex) {
  if (socket.destroyed) return;
  try { socket.write(Buffer.from([0x89, 0x00])); } catch {}
}

/** Send a close frame. */
function sendClose(socket: Duplex) {
  try { socket.write(Buffer.from([0x88, 0x00])); } catch {}
}

// ── Client management ──

function addClient(socket: Duplex) {
  clients.add(socket);
  console.log(`[detect-ws] Client connected (${clients.size} total)`);

  // Handle incoming frames (ping/pong/close/text)
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const frame = parseFrame(buf);
      if (!frame) break;
      buf = buf.subarray(frame.consumed);

      if (frame.opcode === 0x09) {
        // Ping → pong
        sendPong(socket, frame.payload);
      } else if (frame.opcode === 0x0a) {
        // Pong — keepalive response, ignore
      } else if (frame.opcode === 0x08) {
        // Close
        console.log(`[detect-ws] Client sent close frame`);
        sendClose(socket);
        removeClient(socket);
        return;
      } else if (frame.opcode === 0x01) {
        // Text frame — client commands
        try {
          const msg = JSON.parse(frame.payload.toString('utf-8'));
          console.log(`[detect-ws] Client message: ${JSON.stringify(msg)}`);
          handleClientMessage(socket, msg);
        } catch (e: any) {
          console.log(`[detect-ws] Bad client message: ${e.message}`);
        }
      }
    }
  });

  socket.on('close', () => {
    console.log(`[detect-ws] Socket close event`);
    removeClient(socket);
  });
  socket.on('error', (err: any) => {
    console.log(`[detect-ws] Socket error: ${err.message}`);
    removeClient(socket);
  });

  // DON'T start polling here — wait for client to send {type:"start"}
  // This ensures the WS is fully established and the camera target is known.

  // Start keepalive pings
  startPing();
}

function removeClient(socket: Duplex) {
  if (!clients.has(socket)) return;
  clients.delete(socket);
  try { socket.destroy(); } catch {}
  console.log(`[detect-ws] Client disconnected (${clients.size} remaining)`);
  if (clients.size === 0) {
    stopPolling();
    stopPing();
    activeCamera = null;
  }
}

function broadcast(json: string) {
  for (const client of [...clients]) {
    if (!sendFrame(client, json)) {
      removeClient(client);
    }
  }
}

/** Handle text message from client (start/stop detection). */
function handleClientMessage(_socket: Duplex, msg: any) {
  if (msg.type === 'start' && msg.camera) {
    activeCamera = msg.camera;

    // Start detection on Python detect service
    fetch(`${DETECT_URL}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ camera: msg.camera }),
      signal: AbortSignal.timeout(3000),
    }).then(r => r.json()).then(data => {
      console.log(`[detect-ws] Detection started on ${msg.camera}`);
      broadcast(JSON.stringify({ type: 'started', camera: msg.camera, ...data }));
      // Start polling AFTER Python confirms start
      startPolling();
    }).catch((e) => {
      console.log(`[detect-ws] Start failed: ${e.message}`);
      // Start polling anyway — detect service might become available
      startPolling();
    });

  } else if (msg.type === 'stop') {
    activeCamera = null;
    stopPolling();
    fetch(`${DETECT_URL}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
    broadcast(JSON.stringify({ type: 'stopped' }));
  }
}

// ── Internal polling (detect service → WS clients) ──

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
  console.log(`[detect-ws] Starting poll (${POLL_INTERVAL}ms, camera=${activeCamera})`);
  lastJson = '';
  pollTimer = setInterval(pollDetect, POLL_INTERVAL);
  // First poll immediately
  pollDetect();
}

function stopPolling() {
  if (!pollTimer) return;
  console.log('[detect-ws] Stopping poll');
  clearInterval(pollTimer);
  pollTimer = null;
  lastJson = '';
}

// ── Keepalive ping ──

function startPing() {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    for (const client of [...clients]) {
      sendPing(client);
    }
  }, PING_INTERVAL);
}

function stopPing() {
  if (!pingTimer) return;
  clearInterval(pingTimer);
  pingTimer = null;
}

// ── Public API ──

/**
 * Handle HTTP upgrade request for /detect/ws.
 * Called from index.ts: server.on('upgrade', ...)
 */
export function handleDetectWsUpgrade(req: IncomingMessage, socket: Duplex, _head: Buffer) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = acceptKey(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  // Disable Nagle for low-latency push
  if ('setNoDelay' in socket) {
    (socket as any).setNoDelay(true);
  }

  addClient(socket);
}

/** Get current WS stats. */
export function getDetectWsStats() {
  return {
    clients: clients.size,
    polling: pollTimer !== null,
    camera: activeCamera,
  };
}
