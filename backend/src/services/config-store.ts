import { UiConfig } from '../config';

let _uiConfig: UiConfig = {
  title: 'OKO NVR',
  locale: 'en',
  default_grid: 'auto',
  theme: 'dark',
  compact: false,
  stagger_ms: 500,
  bitrate_interval: 5000,
  sync_interval: 15000,
};

export function setUiConfig(config: UiConfig) {
  _uiConfig = config;
}

export function getUiConfig(): UiConfig {
  return _uiConfig;
}
