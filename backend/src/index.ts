import Fastify from 'fastify';
import { loadConfig } from './config';
import { initDb, ensureCameraRows } from './db';
import { createProvider } from './providers';
import { registry } from './services/camera-registry';
import { initStreamManager, cleanupAllInternal, reapOrphanStreams, ensureBaseStreams } from './services/stream-manager';
import { generateGo2rtcConfig } from './services/go2rtc-config';
import { startConfigWatcher } from './services/config-watcher';
import { probeCodecs } from './services/codec-prober';
import { setUiConfig, setClientExtras } from './services/config-store';
import { startNvrHealth } from './services/nvr-health';
import { startSnapshotCache } from './services/snapshot-cache';
import { cameraRoutes } from './routes/cameras';
import { playbackRoutes } from './routes/playback';
import { hdStreamRoutes } from './routes/hd-stream';
import { transcodeRoutes } from './routes/transcode';
import { healthRoutes } from './routes/health';
import { statsRoutes } from './routes/stats';
import { snapshotRoutes } from './routes/snapshots';

async function main() {
  const config = loadConfig();
  initDb();
  setUiConfig(config.ui);
  setClientExtras(config.snapshots, config.playback);

  // Auto-discover or use configured channels
  for (const nvr of config.nvrs) {
    if (nvr.discover) {
      const excludeStr = nvr.exclude.length > 0 ? ` (exclude: ${nvr.exclude.join(', ')})` : '';
      console.log(`[${nvr.name}] Auto-discovering from ${nvr.config.provider} @ ${nvr.config.host}${excludeStr}...`);
      const provider = createProvider(nvr.config);
      try {
        const discovered = await provider.discoverChannels();
        if (discovered && discovered.length > 0) {
          // Apply exclusions
          const excludeSet = new Set(nvr.exclude);
          const filtered = discovered.filter(d => !excludeSet.has(d.channel));

          nvr.cameras = filtered.map(d => ({
            id: `${nvr.id_prefix}${d.channel}`,
            channel: d.channel,
            label: d.name,
          }));

          const excluded = discovered.length - filtered.length;
          console.log(`[${nvr.name}] ✓ Discovered ${discovered.length} cameras${excluded > 0 ? `, excluded ${excluded}` : ''} → ${filtered.length} active`);
        } else {
          console.warn(`[${nvr.name}] ✗ Discovery returned 0 cameras. Use channels: "1-32" in oko.yaml.`);
        }
      } catch (e: any) {
        console.warn(`[${nvr.name}] ✗ Discovery error: ${e.message}. Use channels: "1-32" in oko.yaml.`);
      }
    } else {
      console.log(`[${nvr.name}] ${nvr.cameras.length} cameras from config`);
    }
  }

  const totalCameras = config.nvrs.reduce((n, nvr) => n + nvr.cameras.length, 0);
  console.log(`OKO NVR v0.1.0 — ${config.nvrs.length} NVR(s), ${totalCameras} cameras`);
  for (const nvr of config.nvrs) {
    console.log(`  ${nvr.name}: ${nvr.config.provider} @ ${nvr.config.host} (${nvr.cameras.length} cameras)`);
  }

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

  await fastify.listen({ port: config.server.port, host: '0.0.0.0' });
  console.log(`Backend listening on port ${config.server.port}`);

  // Watch oko.yaml for live changes
  startConfigWatcher(config);
  startNvrHealth();
  startSnapshotCache(config.snapshots, config.go2rtc.api);

  setTimeout(() => cleanupAllInternal(), 3000);

  // Reap orphaned HD/playback/transcode streams every 15s (30s TTL)
  setInterval(() => reapOrphanStreams(30000), 15000);

  // Auto-recover base streams if go2rtc lost them (crash/restart) — check every 60s
  setInterval(() => {
    const ids = registry.allIds();
    ensureBaseStreams(ids, (id) => {
      const entry = registry.getEntry(id);
      if (!entry) return null;
      return entry.provider.getLiveUrl(entry.camera);
    });
  }, 60000);

  // Background: probe codecs for all cameras (detects audio)
  setTimeout(() => probeAllCodecs(), 10000);
}

/** Probe codecs for all cameras in background. Sequential to avoid NVR overload. */
async function probeAllCodecs() {
  const ids = registry.allIds();
  console.log(`[probe] Starting background codec probe for ${ids.length} cameras...`);
  let probed = 0;
  let withAudio = 0;

  for (const id of ids) {
    try {
      const codecs = probeCodecs(id);
      probed++;
      if (codecs.audio && codecs.audio !== 'none' && codecs.audio !== 'unknown') {
        withAudio++;
      }
    } catch {}
    // Small delay between probes
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`[probe] Done: ${probed}/${ids.length} probed, ${withAudio} with audio`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
