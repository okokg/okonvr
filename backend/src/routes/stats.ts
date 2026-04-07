import os from 'os';
import fs from 'fs';
import { FastifyInstance } from 'fastify';
import { registry } from '../services/camera-registry';
import { getNvrStatuses } from '../services/nvr-health';
import { getGo2rtcApi } from '../services/stream-manager';
import { wsHubStats } from '../services/ws-hub';

let prevCpuUsage = process.cpuUsage();
let prevCpuTime = Date.now();

/** Read /proc/stat for host CPU usage (Linux Docker). */
function getHostCpu(): { user: number; system: number; idle: number } | null {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8');
    const line = stat.split('\n')[0];
    const parts = line.split(/\s+/).slice(1).map(Number);
    return { user: parts[0] + parts[1], system: parts[2], idle: parts[3] };
  } catch { return null; }
}

let prevHostCpu: ReturnType<typeof getHostCpu> = null;

function getHostCpuPercent(): number | null {
  const cur = getHostCpu();
  if (!cur || !prevHostCpu) { prevHostCpu = cur; return null; }
  const dUser = cur.user - prevHostCpu.user;
  const dSystem = cur.system - prevHostCpu.system;
  const dIdle = cur.idle - prevHostCpu.idle;
  const total = dUser + dSystem + dIdle;
  prevHostCpu = cur;
  if (total === 0) return 0;
  return Math.round(((dUser + dSystem) / total) * 100);
}

/** Read cgroup memory (works in Docker). */
function getCgroupMemory(): { used: number; limit: number } | null {
  try {
    const used = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
    const limit = Number(fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim());
    if (!isNaN(used)) return { used, limit: isNaN(limit) ? os.totalmem() : limit };
  } catch {}
  try {
    const used = Number(fs.readFileSync('/sys/fs/cgroup/memory/memory.usage_in_bytes', 'utf8').trim());
    const limit = Number(fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim());
    if (!isNaN(used)) return { used, limit };
  } catch {}
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}M`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`;
}

export async function statsRoutes(fastify: FastifyInstance) {
  getHostCpuPercent(); // warm up baseline

  fastify.get('/stats', async () => {
    const go2rtcApi = getGo2rtcApi();
    try {
      const res = await fetch(`${go2rtcApi}/api/streams`);
      if (!res.ok) return { error: 'go2rtc unreachable' };
      const allStreams = await res.json() as Record<string, any>;
      const streamNames = Object.keys(allStreams);

      let sd = 0, hd = 0, playback = 0, transcode = 0;
      const nvrCams = new Map<string, number>();
      const registryNvrs = registry.getNvrs();
      for (const nvr of registryNvrs) nvrCams.set(nvr.name, 0);

      for (const name of streamNames) {
        if (name.startsWith('__hd_') || name.startsWith('hd_')) { hd++; continue; }
        if (name.startsWith('__pb_') || name.startsWith('playback_')) { playback++; continue; }
        if (name.startsWith('__t_') || name.startsWith('t_')) { transcode++; continue; }
        if (name.startsWith('__')) continue;
        sd++;
        const entry = registry.getEntry(name);
        if (entry) nvrCams.set(entry.nvrName, (nvrCams.get(entry.nvrName) || 0) + 1);
      }

      // Session stream detail (usually 0-3)
      const sessionStreams = streamNames.filter(n =>
        n.startsWith('__hd_') || n.startsWith('__pb_') || n.startsWith('__t_')
      );
      const active: { name: string; type: string; producers: number; consumers: number }[] = [];
      for (const name of sessionStreams) {
        try {
          const sRes = await fetch(`${go2rtcApi}/api/streams?src=${encodeURIComponent(name)}`);
          if (sRes.ok) {
            const info = await sRes.json() as { producers?: any[]; consumers?: any[] };
            const pc = info.producers?.length || 0;
            const cc = info.consumers?.length || 0;
            if (pc > 0 || cc > 0) {
              const type = name.startsWith('__hd_') ? 'hd' : name.startsWith('__pb_') ? 'playback' : 'transcode';
              active.push({ name, type, producers: pc, consumers: cc });
            }
          }
        } catch {}
      }

      // NVR health
      const nvrHealth = getNvrStatuses();
      const nvrs = registryNvrs.map(n => ({
        name: n.name,
        cameras: n.cameraCount,
        streams: nvrCams.get(n.name) || 0,
        status: nvrHealth.find(h => h.name === n.name)?.status || 'unknown',
      }));

      // System metrics
      const now = Date.now();
      const cpuUsage = process.cpuUsage(prevCpuUsage);
      const cpuElapsed = (now - prevCpuTime) * 1000;
      const backendCpu = Math.round(((cpuUsage.user + cpuUsage.system) / cpuElapsed) * 100);
      prevCpuUsage = process.cpuUsage();
      prevCpuTime = now;

      const hostCpu = getHostCpuPercent();
      const mem = process.memoryUsage();
      const cgMem = getCgroupMemory();
      const loadAvg = os.loadavg();

      const system = {
        host_cpu: hostCpu !== null ? `${hostCpu}%` : null,
        load: `${loadAvg[0].toFixed(1)} ${loadAvg[1].toFixed(1)} ${loadAvg[2].toFixed(1)}`,
        cores: os.cpus().length,
        backend_cpu: `${backendCpu}%`,
        backend_rss: formatBytes(mem.rss),
        backend_heap: `${formatBytes(mem.heapUsed)}/${formatBytes(mem.heapTotal)}`,
        host_mem: cgMem
          ? `${formatBytes(cgMem.used)}/${formatBytes(cgMem.limit)}`
          : `${formatBytes(os.totalmem() - os.freemem())}/${formatBytes(os.totalmem())}`,
        uptime: `${Math.round(process.uptime() / 60)}m`,
      };

      return { streams: { total: streamNames.length, sd, hd, playback, transcode }, nvrs, active, system, ws: wsHubStats() };
    } catch (err: any) {
      return { error: err.message };
    }
  });
}
