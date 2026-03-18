import net from 'net';
import { registry } from './camera-registry';
import { getUiConfig } from './config-store';

interface NvrStatus {
  name: string;
  host: string;
  port: number;
  status: 'online' | 'offline' | 'unknown';
  cameras: number;
  failures: number;
  since: string | null;    // ISO timestamp when status changed
  lastCheck: string | null;
}

const statusMap = new Map<string, NvrStatus>();
let healthTimer: ReturnType<typeof setInterval> | null = null;

/** TCP connect check with timeout. */
function tcpPing(host: string, port: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    socket.connect(port, host, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

/** Run health check for all NVRs. */
async function checkAllNvrs() {
  const config = getUiConfig();
  const maxFailures = config.nvr_health_failures || 3;
  const nvrs = registry.getNvrs();
  const now = new Date().toISOString();

  for (const nvr of nvrs) {
    let status = statusMap.get(nvr.name);
    if (!status) {
      status = {
        name: nvr.name,
        host: nvr.host,
        port: nvr.port,
        status: 'unknown',
        cameras: nvr.cameraCount,
        failures: 0,
        since: null,
        lastCheck: null,
      };
      statusMap.set(nvr.name, status);
    }

    status.cameras = nvr.cameraCount;
    status.lastCheck = now;

    const reachable = await tcpPing(nvr.host, nvr.port);

    if (reachable) {
      if (status.status !== 'online') {
        console.log(`[health] ${nvr.name} (${nvr.host}:${nvr.port}): ONLINE`);
        status.since = now;
      }
      status.status = 'online';
      status.failures = 0;
    } else {
      status.failures++;
      if (status.failures >= maxFailures && status.status !== 'offline') {
        console.log(`[health] ${nvr.name} (${nvr.host}:${nvr.port}): OFFLINE (${status.failures} failures)`);
        status.status = 'offline';
        status.since = now;
      } else if (status.status !== 'offline') {
        console.log(`[health] ${nvr.name} (${nvr.host}:${nvr.port}): unreachable (${status.failures}/${maxFailures})`);
      }
    }
  }

  // Remove stale entries for NVRs no longer in config
  const nvrNames = new Set(nvrs.map(n => n.name));
  for (const key of statusMap.keys()) {
    if (!nvrNames.has(key)) statusMap.delete(key);
  }
}

/** Start periodic health checks. */
export function startNvrHealth() {
  const config = getUiConfig();
  const intervalMs = config.nvr_health_interval || 30000;

  // Initial check after 5s (let streams connect first)
  setTimeout(() => checkAllNvrs(), 5000);

  // Periodic
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(() => checkAllNvrs(), intervalMs);

  console.log(`[health] NVR health check every ${intervalMs / 1000}s, offline after ${config.nvr_health_failures} failures`);
}

/** Get status of all NVRs. */
export function getNvrStatuses(): NvrStatus[] {
  return Array.from(statusMap.values());
}

/** Get status of a specific NVR by name. */
export function getNvrStatus(name: string): NvrStatus | undefined {
  return statusMap.get(name);
}

/** Check if an NVR is currently offline. */
export function isNvrOffline(nvrName: string): boolean {
  const status = statusMap.get(nvrName);
  return status?.status === 'offline';
}
