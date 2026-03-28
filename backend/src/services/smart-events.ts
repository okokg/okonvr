/**
 * Smart Events service — fetches and caches SMD events from Dahua NVRs.
 *
 * Cache strategy:
 *   - Today: always fresh (events still accumulating)
 *   - Past days: cached permanently (day is closed, events won't change)
 */

import { DahuaRpc, DahuaRpcConfig, SmdEvent } from '../utils/dahua-rpc';
import { registry } from './camera-registry';

interface CameraEvent {
  start: number;   // seconds from midnight (0-86400)
  end: number;
  type: 'human' | 'vehicle';
}

/** Cache key: "nvrName:YYYY-MM-DD" → events per channel */
const cache = new Map<string, Map<number, CameraEvent[]>>();

/** RPC2 clients per NVR name */
const rpcClients = new Map<string, DahuaRpc>();

/** Initialize RPC2 clients for all Dahua NVRs. Call after registry.init(). */
export function initSmartEvents(): void {
  const nvrs = registry.getNvrs();
  for (const nvr of nvrs) {
    const entry = registry.getNvrEntry(nvr.name);
    if (!entry || entry.config.provider !== 'dahua') continue;

    const config: DahuaRpcConfig = {
      host: entry.config.host,
      port: entry.config.http_port || 80,
      username: entry.config.username,
      password: entry.config.password,
    };

    rpcClients.set(nvr.name, new DahuaRpc(config));
    console.log(`[smart-events] RPC2 client for ${nvr.name} @ ${config.host}:${config.port}`);
  }

  if (rpcClients.size === 0) {
    console.log('[smart-events] No Dahua NVRs found, smart events disabled');
  }
}

/** Parse "2026-03-26 04:01:37" → seconds from midnight */
function timeToSeconds(timeStr: string): number {
  const timePart = timeStr.split(' ')[1];
  if (!timePart) return 0;
  const [h, m, s] = timePart.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

/** Get today's date string in YYYY-MM-DD */
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Get smart events for a camera on a specific date.
 *
 * @param cameraId - e.g. "M1"
 * @param date - "YYYY-MM-DD"
 * @returns Array of events with start/end in seconds from midnight
 */
export async function getSmartEvents(cameraId: string, date: string): Promise<CameraEvent[]> {
  const entry = registry.getEntry(cameraId);
  if (!entry) return [];

  const nvrName = entry.nvrName;
  const rpc = rpcClients.get(nvrName);
  if (!rpc) return []; // Not a Dahua NVR or not initialized

  const channel = entry.camera.channel - 1; // 1-based → 0-based for RPC2
  const cacheKey = `${nvrName}:${date}`;
  const isToday = date === todayStr();

  // Check cache (skip for today — always fresh)
  if (!isToday && cache.has(cacheKey)) {
    return cache.get(cacheKey)!.get(channel) || [];
  }

  // Fetch from NVR (all channels at once)
  try {
    console.log(`[smart-events] Fetching ${nvrName} date=${date}${isToday ? ' (fresh)' : ''}`);
    const events = await rpc.querySmdEvents(-1, date); // -1 = all channels

    // Group by channel
    const byChannel = new Map<number, CameraEvent[]>();
    for (const e of events) {
      const ch = e.channel;
      if (!byChannel.has(ch)) byChannel.set(ch, []);
      byChannel.get(ch)!.push({
        start: timeToSeconds(e.startTime),
        end: timeToSeconds(e.endTime),
        type: e.type,
      });
    }

    // Cache (only past days are permanent)
    cache.set(cacheKey, byChannel);
    console.log(`[smart-events] ${nvrName} ${date}: ${events.length} events across ${byChannel.size} channels`);

    return byChannel.get(channel) || [];
  } catch (e: any) {
    console.error(`[smart-events] ${nvrName} ${date} error: ${e.message}`);
    return [];
  }
}

/** Get supported NVR names (for /api/cameras response enrichment). */
export function getSmartEventNvrs(): string[] {
  return Array.from(rpcClients.keys());
}
