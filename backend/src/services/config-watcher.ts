import fs from 'fs';
import { loadConfig, OkoConfig } from '../config';
import { createProvider } from '../providers';
import { CameraConfig } from '../providers/types';
import { registry } from './camera-registry';
import { ensureCameraRows } from '../db';
import { generateGo2rtcConfig } from './go2rtc-config';
import { setUiConfig } from './config-store';
import { createStream, deleteStream, fetchStreams } from './stream-manager';

let currentConfig: OkoConfig | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

const CONFIG_PATHS = [
  process.env.OKO_CONFIG || '',
  '/config/oko.yaml',
];

/**
 * Start watching oko.yaml for changes.
 * On change: reload config, re-discover, diff streams, update go2rtc live.
 */
export function startConfigWatcher(initialConfig: OkoConfig) {
  currentConfig = initialConfig;

  for (const configPath of CONFIG_PATHS) {
    if (!configPath || !fs.existsSync(configPath)) continue;

    try {
      fs.watch(configPath, (eventType) => {
        if (eventType !== 'change') return;

        // Debounce: wait 1s for editor to finish writing
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => handleConfigChange(), 1000);
      });
      console.log(`[watcher] Watching ${configPath} for changes`);
      return;
    } catch (e: any) {
      console.warn(`[watcher] Cannot watch ${configPath}: ${e.message}`);
    }
  }

  console.warn('[watcher] No config file found to watch');
}

async function handleConfigChange() {
  console.log('[watcher] oko.yaml changed, reloading...');

  let newConfig: OkoConfig;
  try {
    newConfig = loadConfig();
  } catch (e: any) {
    console.error(`[watcher] Failed to parse config: ${e.message}`);
    return;
  }

  // Run discovery for NVRs that need it
  for (const nvr of newConfig.nvrs) {
    if (nvr.discover) {
      console.log(`[watcher] Discovering cameras for ${nvr.name}...`);
      const provider = createProvider(nvr.config);
      try {
        const discovered = await provider.discoverChannels();
        if (discovered && discovered.length > 0) {
          const excludeSet = new Set(nvr.exclude);
          const filtered = discovered.filter(d => !excludeSet.has(d.channel));
          nvr.cameras = filtered.map(d => ({
            id: `${nvr.id_prefix}${d.channel}`,
            channel: d.channel,
            label: d.name,
          }));
          console.log(`[watcher] ${nvr.name}: ${filtered.length} cameras`);
        }
      } catch (e: any) {
        console.warn(`[watcher] ${nvr.name}: discovery failed: ${e.message}`);
      }
    }
  }

  // Diff: old cameras vs new cameras
  const oldIds = new Set(registry.allIds());
  const newCameras = new Map<string, { camera: CameraConfig; rtspUrl: string }>();

  for (const nvr of newConfig.nvrs) {
    const provider = createProvider(nvr.config);
    for (const cam of nvr.cameras) {
      newCameras.set(cam.id, { camera: cam, rtspUrl: provider.getLiveUrl(cam) });
    }
  }

  const newIds = new Set(newCameras.keys());
  const toAdd = [...newIds].filter(id => !oldIds.has(id));
  const toRemove = [...oldIds].filter(id => !newIds.has(id));
  const unchanged = [...newIds].filter(id => oldIds.has(id));

  console.log(`[watcher] Cameras: +${toAdd.length} new, -${toRemove.length} removed, ${unchanged.length} unchanged`);

  // Remove old streams from go2rtc
  for (const id of toRemove) {
    console.log(`[watcher] Removing stream: ${id}`);
    await deleteStream(id);
  }

  // Add new streams to go2rtc
  for (const id of toAdd) {
    const entry = newCameras.get(id)!;
    console.log(`[watcher] Adding stream: ${id} → ${entry.rtspUrl.replace(/\/\/[^@]+@/, '//***@')}`);
    try {
      await createStream(id, entry.rtspUrl);
    } catch (e: any) {
      console.warn(`[watcher] Failed to add ${id}: ${e.message}`);
    }
  }

  // Re-init registry with new config
  registry.init(newConfig.nvrs);

  // Update DB rows with NVR groups + labels from discovery
  const cameraEntries = newConfig.nvrs.flatMap(nvr =>
    nvr.cameras.map(cam => ({ id: cam.id, group: nvr.name, label: cam.label }))
  );
  ensureCameraRows(cameraEntries);

  // Regenerate go2rtc.yaml (for next restart)
  generateGo2rtcConfig(newConfig);

  currentConfig = newConfig;
  setUiConfig(newConfig.ui);

  const total = newConfig.nvrs.reduce((n, nvr) => n + nvr.cameras.length, 0);
  console.log(`[watcher] ✓ Reload complete: ${total} cameras active`);
}
