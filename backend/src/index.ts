import Fastify from 'fastify';
import { loadConfig, OkoConfig } from './config';
import { initDb, ensureCameraRows } from './db';
import { createProvider, NvrEntry } from './providers';
import { registry } from './services/camera-registry';
import { initStreamManager, cleanupAllInternal, reapOrphanStreams, ensureBaseStreams } from './services/stream-manager';
import { generateGo2rtcConfig } from './services/go2rtc-config';
import { startConfigWatcher } from './services/config-watcher';
import { probeCodecs, clearCodecCache } from './services/codec-prober';
import { setActivity, clearActivity } from './services/server-activity';
import { setUiConfig, setClientExtras } from './services/config-store';
import { startNvrHealth, onNvrOnline } from './services/nvr-health';
import { startSnapshotCache } from './services/snapshot-cache';
import { initSmartEvents } from './services/smart-events';
import { cameraRoutes } from './routes/cameras';
import { playbackRoutes } from './routes/playback';
import { hdStreamRoutes } from './routes/hd-stream';
import { transcodeRoutes } from './routes/transcode';
import { healthRoutes } from './routes/health';
import { statsRoutes } from './routes/stats';
import { snapshotRoutes } from './routes/snapshots';
import { talkbackRoutes } from './routes/talkback';
import { playbackThumbnailRoutes } from './routes/playback-thumbnail';
import { eventRoutes } from './routes/events';

/** Run auto-discovery for a single NVR. Pure function — caller manages activities. */
async function discoverNvr(nvr: NvrEntry): Promise<boolean> {
  if (!nvr.discover) return false;

  const excludeStr = nvr.exclude.length > 0 ? ` (exclude: ${nvr.exclude.join(', ')})` : '';
  console.log(`[${nvr.name}] Auto-discovering from ${nvr.config.provider} @ ${nvr.config.host}${excludeStr}...`);

  const provider = createProvider(nvr.config);
  try {
    const discovered = await provider.discoverChannels();
    if (!discovered || discovered.length === 0) {
      console.warn(`[${nvr.name}] ✗ Discovery returned 0 cameras.`);
      return false;
    }

    const excludeSet = new Set(nvr.exclude);
    const filtered = discovered.filter(d => !excludeSet.has(d.channel));

    nvr.cameras = filtered.map(d => ({
      id: `${nvr.id_prefix}${d.channel}`,
      channel: d.channel,
      label: d.name,
      ip: d.ip,
      model: d.model,
      mac: d.mac,
      firmware: d.firmware,
      serial: d.serial,
    }));

    const excluded = discovered.length - filtered.length;
    console.log(`[${nvr.name}] ✓ Discovered ${discovered.length} cameras${excluded > 0 ? `, excluded ${excluded}` : ''} → ${filtered.length} active`);
    return true;
  } catch (e: any) {
    console.warn(`[${nvr.name}] ✗ Discovery error: ${e.message}`);
    return false;
  }
}

/** Re-discover cameras for a specific NVR (e.g. after it comes back online). */
async function rediscoverNvr(nvrName: string, config: OkoConfig) {
  const nvr = registry.getNvrEntry(nvrName);
  if (!nvr) {
    console.log(`[rediscovery] NVR "${nvrName}" not found in registry`);
    return;
  }

  setActivity('rediscovery', `Re-discovering ${nvrName}...`);
  const hadCameras = nvr.cameras.length;
  const ok = await discoverNvr(nvr);
  if (!ok && hadCameras > 0) {
    console.log(`[rediscovery] ${nvrName}: discovery failed but keeping ${hadCameras} existing cameras`);
    clearActivity('rediscovery');
    return;
  }
  if (!ok) { clearActivity('rediscovery'); return; }

  // Update registry
  const newIds = registry.updateNvr(nvrName, nvr.cameras);
  console.log(`[rediscovery] ${nvrName}: registry updated (${nvr.cameras.length} cameras, ${newIds.length} new)`);
  setActivity('rediscovery', `${nvrName}: updating streams...`);

  // Update DB rows
  const cameraEntries = nvr.cameras.map(cam => ({ id: cam.id, group: nvr.name, label: cam.label }));
  ensureCameraRows(cameraEntries);

  // Regenerate go2rtc config and ensure streams
  generateGo2rtcConfig(config);
  const ids = registry.allIds();
  ensureBaseStreams(ids, (id) => {
    const entry = registry.getEntry(id);
    if (!entry) return null;
    return entry.provider.getLiveUrl(entry.camera);
  });

  console.log(`[rediscovery] ${nvrName}: go2rtc config + streams updated`);
  clearActivity('rediscovery');

  // Re-probe codecs for all cameras of this NVR (10s delay for streams to connect)
  const camIds = nvr.cameras.map(c => c.id);
  setTimeout(() => probeNvrCodecs(camIds), 10000);
}

async function main() {
  const config = loadConfig();
  initDb();
  setUiConfig(config.ui);
  setClientExtras(config.snapshots, config.playback);

  // Auto-discover cameras from all NVRs
  for (const nvr of config.nvrs) {
    if (nvr.discover) {
      setActivity('discovery', `Discovering ${nvr.name}...`);
      await discoverNvr(nvr);
    } else {
      console.log(`[${nvr.name}] ${nvr.cameras.length} cameras from config`);
    }
  }
  clearActivity('discovery');

  const totalCameras = config.nvrs.reduce((n, nvr) => n + nvr.cameras.length, 0);
  console.log(`\nOKO NVR v0.1.0 — ${config.nvrs.length} NVR(s), ${totalCameras} cameras\n`);

  for (const nvr of config.nvrs) {
    const sorted = [...nvr.cameras].sort((a, b) => a.channel - b.channel);

    // Column definitions: [header, getter, maxWidth]
    const colDefs: [string, (c: typeof sorted[0]) => string, number][] = [
      ['ID',    c => c.id,                              6],
      ['CH',    c => String(c.channel),                 3],
      ['Label', c => c.label?.trim() || '—',           20],
      ['IP',    c => c.ip?.trim() || '—',              15],
      ['Model', c => c.model?.trim() || '(OEM)',       24],
      ['MAC',   c => c.mac?.trim() || '—',             17],
      ['S/N',   c => c.serial?.trim() || '—',          40],
      ['FW',    c => c.firmware?.trim() || '—',        22],
    ];

    // Calculate widths
    const W = colDefs.map(([hdr, get, max]) =>
      Math.min(max, Math.max(hdr.length, ...sorted.map(c => get(c).length)))
    );

    const cell = (w: number) => w + 2;
    const hdr = ` ${nvr.name}  ·  ${nvr.config.provider} @ ${nvr.config.host}:${nvr.config.port}  ·  ${sorted.length} cameras `;

    // Expand last column if header wider
    const tableW = W.reduce((s, w) => s + cell(w), 0) + W.length - 1;
    if (hdr.length > tableW) W[W.length - 1] += hdr.length - tableW;

    const innerW = W.reduce((s, w) => s + cell(w), 0) + W.length - 1;

    const sep = (l: string, m: string, r: string) =>
      l + W.map(w => '─'.repeat(cell(w))).join(m) + r;

    console.log(`┌${'─'.repeat(innerW)}┐`);
    console.log(`│${hdr.padEnd(innerW)}│`);
    console.log(sep('├', '┬', '┤'));
    console.log('│ ' + colDefs.map(([h], i) => h.padEnd(W[i])).join(' │ ') + ' │');
    console.log(sep('├', '┼', '┤'));

    for (const cam of sorted) {
      const vals = colDefs.map(([, get, _], i) => get(cam).substring(0, W[i]).padEnd(W[i]));
      console.log('│ ' + vals.join(' │ ') + ' │');
    }

    console.log(sep('└', '┴', '┘'));
  }
  console.log('');
  clearActivity('discovery');
  setActivity('startup', 'Initializing streams...');

  registry.init(config.nvrs);

  // Create DB rows with NVR name as group + labels from discovery
  const cameraEntries = config.nvrs.flatMap(nvr =>
    nvr.cameras.map(cam => ({ id: cam.id, group: nvr.name, label: cam.label }))
  );
  ensureCameraRows(cameraEntries);
  generateGo2rtcConfig(config);
  initStreamManager(config.go2rtc.api);

  const fastify = Fastify({ logger: true });
  await fastify.register(cameraRoutes);
  await fastify.register(playbackRoutes);
  await fastify.register(hdStreamRoutes);
  await fastify.register(transcodeRoutes);
  await fastify.register(healthRoutes);
  await fastify.register(statsRoutes);
  await fastify.register(snapshotRoutes);
  await fastify.register(playbackThumbnailRoutes);
  await fastify.register(talkbackRoutes);
  await fastify.register(eventRoutes);

  await fastify.listen({ port: config.server.port, host: '0.0.0.0' });
  console.log(`Backend listening on port ${config.server.port}`);
  clearActivity('startup');

  // Watch oko.yaml for live changes
  startConfigWatcher(config);
  startNvrHealth();
  startSnapshotCache(config.snapshots, config.go2rtc.api);
  initSmartEvents();

  // Wire NVR online callback → re-discover cameras
  onNvrOnline((nvrName) => {
    console.log(`[health] ${nvrName} came online — triggering re-discovery`);
    rediscoverNvr(nvrName, config).catch(err =>
      console.error(`[rediscovery] ${nvrName} failed:`, err.message)
    );
  });

  setTimeout(() => cleanupAllInternal(), 3000);

  // Reap orphaned HD/playback/transcode streams every 15s (30s TTL)
  setInterval(() => reapOrphanStreams(30000), 15000);

  // Auto-recover base streams if go2rtc lost them (crash/restart) — check every 15s
  setInterval(() => {
    const ids = registry.allIds();
    ensureBaseStreams(ids, (id) => {
      const entry = registry.getEntry(id);
      if (!entry) return null;
      return entry.provider.getLiveUrl(entry.camera);
    });
  }, 15000);

  // Background: probe codecs for all cameras (detects audio)
  setTimeout(() => probeAllCodecs(), 10000);

  // Background: detect talkback capability
  setTimeout(async () => {
    console.log('[talkback] Timer fired, calling detectAllTalkback...');
    try {
      await registry.detectAllTalkback();
    } catch (e: any) {
      console.error('[talkback] FATAL:', e.message, e.stack);
    }
  }, 5000);

  // Re-probe all codecs every 6 hours (picks up NVR config changes)
  setInterval(() => probeAllCodecs(true), 6 * 60 * 60 * 1000);
}

/** Guard against parallel probe runs. */
let probeRunning = false;

/** Probe codecs for all cameras in background. Sequential to avoid NVR overload.
 * @param force - bypass cache, re-probe from RTSP
 */
async function probeAllCodecs(force = false) {
  if (probeRunning) {
    console.log('[probe] Skipped — another probe is already running');
    return;
  }
  probeRunning = true;
  try {
    const ids = registry.allIds();
    if (ids.length === 0) { console.log('[probe] No cameras to probe'); return; }
    const t0 = Date.now();
    console.log(`[probe] ── Starting ${force ? 'FORCED ' : ''}probe for ${ids.length} cameras ──`);
    setActivity('probe', `Probing codecs...`, `0/${ids.length}`);

    let probed = 0, failed = 0;
    const codecs: Record<string, number> = {};
    const audioTypes: Record<string, number> = {};

    for (const id of ids) {
      try {
        const result = probeCodecs(id, force);
        probed++;
        codecs[result.video] = (codecs[result.video] || 0) + 1;
        audioTypes[result.audio] = (audioTypes[result.audio] || 0) + 1;
      } catch (e: any) {
        failed++;
        console.log(`[probe] ${id}: EXCEPTION — ${e.message?.substring(0, 80)}`);
      }
      setActivity('probe', `Probing codecs...`, `${probed + failed}/${ids.length}`);
      await new Promise(r => setTimeout(r, 200));
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const codecStr = Object.entries(codecs).map(([k, v]) => `${k}:${v}`).join(' ');
    const audioStr = Object.entries(audioTypes).map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(`[probe] ── Done in ${elapsed}s: ${probed}/${ids.length} ok, ${failed} failed ──`);
    console.log(`[probe]    Video: ${codecStr}`);
    console.log(`[probe]    Audio: ${audioStr}`);
  } finally {
    probeRunning = false;
    clearActivity('probe');
  }
}

/** Probe codecs for specific cameras (e.g. after NVR rediscovery). */
async function probeNvrCodecs(cameraIds: string[]) {
  if (probeRunning) {
    console.log(`[probe] Skipped rediscovery probe — main probe running`);
    return;
  }
  probeRunning = true;
  try {
    const t0 = Date.now();
    console.log(`[probe] Re-probing ${cameraIds.length} cameras: ${cameraIds.slice(0, 5).join(', ')}${cameraIds.length > 5 ? '...' : ''}`);
    setActivity('probe', `Re-probing codecs...`, `0/${cameraIds.length}`);
    clearCodecCache(cameraIds);
    let ok = 0, fail = 0;
    for (const id of cameraIds) {
      try { probeCodecs(id, true); ok++; } catch { fail++; }
      setActivity('probe', `Re-probing codecs...`, `${ok + fail}/${cameraIds.length}`);
      await new Promise(r => setTimeout(r, 200));
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[probe] Rediscovery probe done in ${elapsed}s: ${ok} ok, ${fail} failed`);
  } finally {
    probeRunning = false;
    clearActivity('probe');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
