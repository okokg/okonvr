import { UiConfig, SnapshotsConfig, PlaybackConfig } from '../config';

let _uiConfig: UiConfig = {
  title: 'OKO NVR',
  locale: 'en',
  default_grid: 'auto',
  theme: 'dark',
  compact: false,
  stagger_ms: 500,
  bitrate_interval: 5000,
  sync_interval: 15000,
  nvr_health_interval: 30000,
  nvr_health_failures: 3,
};

let _snapshotsEnabled = true;
let _mseCacheTtl = 60;
let _forceMse = true;

export function setUiConfig(config: UiConfig) {
  _uiConfig = config;
}

export function setClientExtras(snapshots: SnapshotsConfig, playback: PlaybackConfig) {
  _snapshotsEnabled = snapshots.enabled;
  _mseCacheTtl = playback.mse_cache_ttl;
  _forceMse = playback.force_mse;
}

export function getUiConfig(): UiConfig & { snapshots_enabled: boolean; mse_cache_ttl: number; playback_force_mse: boolean } {
  return {
    ..._uiConfig,
    snapshots_enabled: _snapshotsEnabled,
    mse_cache_ttl: _mseCacheTtl,
    playback_force_mse: _forceMse,
  };
}
