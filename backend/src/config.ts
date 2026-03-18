import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { NvrConfig, NvrEntry, CameraConfig } from './providers';

export interface UiConfig {
  title: string;
  locale: string;
  default_grid: string;
  theme: string;
  compact: boolean;
  stagger_ms: number;
  bitrate_interval: number;
  sync_interval: number;
  nvr_health_interval: number;
  nvr_health_failures: number;
}

export interface OkoConfig {
  server: {
    port: number;
    timezone?: string;
  };
  go2rtc: {
    api: string;
    webrtc_port: number;
    candidates: string[];
  };
  nvrs: NvrEntry[];
  ffmpeg: {
    timeout: number;
    playback_input: string;
  };
  ui: UiConfig;
}

const CONFIG_PATHS = [
  process.env.OKO_CONFIG || '',
  '/config/oko.yaml',
  path.join(process.cwd(), 'oko.yaml'),
  '/data/oko.yaml',
];

export function loadConfig(): OkoConfig {
  let configPath = '';
  for (const p of CONFIG_PATHS) {
    if (p && fs.existsSync(p) && fs.statSync(p).isFile()) {
      configPath = p;
      break;
    }
  }

  if (!configPath) {
    throw new Error(
      'No oko.yaml found. Create one from oko.yaml.example.\n' +
      `Searched: ${CONFIG_PATHS.filter(Boolean).join(', ')}`
    );
  }

  console.log(`Loading config from ${configPath}`);
  const raw = fs.readFileSync(configPath, 'utf8');
  const yaml = YAML.parse(raw);

  return normalizeConfig(yaml);
}

/** Normalize YAML config, support both old (single nvr:) and new (nvrs:[]) format. */
function normalizeConfig(yaml: any): OkoConfig {
  const serverIps = (process.env.SERVER_IP || '').split(',').map(s => s.trim()).filter(Boolean);
  const webrtcPort = parseInt(process.env.WEBRTC_PORT || '') || yaml.go2rtc?.webrtc_port || 8555;

  // Parse NVRs — support both formats
  let nvrs: NvrEntry[];
  if (Array.isArray(yaml.nvrs)) {
    nvrs = yaml.nvrs
      .filter((n: any) => n.enabled !== false)
      .map((n: any) => parseNvrEntry(n));
  } else if (yaml.nvr) {
    nvrs = [parseLegacyNvr(yaml)];
  } else {
    throw new Error('Config must have either "nvrs:" (array) or "nvr:" (single) section');
  }

  // Log disabled NVRs
  if (Array.isArray(yaml.nvrs)) {
    const disabled = yaml.nvrs.filter((n: any) => n.enabled === false);
    for (const n of disabled) {
      console.log(`[${n.name || n.host}] Disabled — skipping`);
    }
  }

  return {
    server: {
      port: yaml.server?.port || 3000,
      timezone: yaml.server?.timezone,
    },
    go2rtc: {
      api: yaml.go2rtc?.api || 'http://go2rtc:1984',
      webrtc_port: webrtcPort,
      candidates: yaml.go2rtc?.candidates?.length
        ? yaml.go2rtc.candidates
        : (serverIps.length ? serverIps.map((ip: string) => `${ip}:${webrtcPort}`) : []),
    },
    nvrs,
    ffmpeg: {
      timeout: yaml.ffmpeg?.timeout || 30,
      playback_input: yaml.ffmpeg?.playback_input ||
        '-fflags nobuffer -flags low_delay -buffer_size 1 -rtsp_transport tcp -timeout 30 -i {input}',
    },
    ui: {
      title: yaml.ui?.title ?? 'OKO NVR',
      locale: yaml.ui?.locale ?? 'en',
      default_grid: yaml.ui?.default_grid ?? 'auto',
      theme: yaml.ui?.theme ?? 'dark',
      compact: yaml.ui?.compact ?? false,
      stagger_ms: yaml.ui?.stagger_ms ?? 500,
      bitrate_interval: yaml.ui?.bitrate_interval ?? 5000,
      sync_interval: yaml.ui?.sync_interval ?? 15000,
      nvr_health_interval: yaml.ui?.nvr_health_interval ?? 30000,
      nvr_health_failures: yaml.ui?.nvr_health_failures ?? 3,
    },
  };
}

/** Parse new-format NVR entry. */
function parseNvrEntry(n: any): NvrEntry {
  const config: NvrConfig = {
    provider: n.provider || 'hikvision',
    host: n.host,
    port: n.port || 554,
    http_port: n.http_port,
    username: n.username,
    password: n.password,
    sub_stream_suffix: n.sub_stream_suffix,
    main_stream_suffix: n.main_stream_suffix,
  };

  const prefix = n.id_prefix || 'D';
  const channelsStr = n.channels ? String(n.channels).trim() : '';

  // Detect discovery mode: no channels, or channels contains "*"
  const hasWildcard = channelsStr === '' || channelsStr.includes('*');

  if (hasWildcard) {
    // Parse exclusions from "*, !12, !32"
    const exclude = parseExclusions(channelsStr);
    return {
      name: n.name || config.host, config, cameras: [],
      id_prefix: prefix, discover: true, exclude,
    };
  }

  // Manual channels: "1-31, !12" — parsed fully including exclusions
  const cameras = parseChannelsExpr(channelsStr, prefix);
  return {
    name: n.name || config.host, config, cameras,
    id_prefix: prefix, discover: false, exclude: [],
  };
}

/** Extract exclusion numbers from channels string: "*, !12, !32" → [12, 32] */
function parseExclusions(expr: string): number[] {
  const exclude: number[] = [];
  for (const part of expr.split(',')) {
    const trimmed = part.trim();
    if (trimmed.startsWith('!')) {
      for (const n of expandNumbers(trimmed.slice(1).trim())) {
        exclude.push(n);
      }
    }
  }
  return exclude;
}

/** Parse old single-NVR format for backward compat. */
function parseLegacyNvr(yaml: any): NvrEntry {
  const config: NvrConfig = {
    provider: yaml.nvr?.provider || 'hikvision',
    host: yaml.nvr?.host,
    port: yaml.nvr?.port || 554,
    username: yaml.nvr?.username,
    password: yaml.nvr?.password,
    sub_stream_suffix: yaml.nvr?.sub_stream_suffix,
    main_stream_suffix: yaml.nvr?.main_stream_suffix,
  };

  const cameras = parseCamerasLegacy(yaml.cameras, 'D');
  return { name: 'default', config, cameras, id_prefix: 'D', discover: cameras.length === 0, exclude: [] };
}

/**
 * Parse channels expression string.
 *
 * Syntax:
 *   "1-32"           → channels 1 through 32
 *   "1,5,8,13"       → specific channels
 *   "1-10, 15-20"    → two ranges
 *   "1-32, !12, !32" → all except 12 and 32
 *   "1-10, 13, 25-31, !7" → mix with exclusion
 */
function parseChannelsExpr(expr: string, prefix: string): CameraConfig[] {
  const include = new Set<number>();
  const exclude = new Set<number>();

  for (const part of expr.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('!')) {
      // Exclusion: !12 or !5-8
      const inner = trimmed.slice(1).trim();
      for (const n of expandNumbers(inner)) {
        exclude.add(n);
      }
    } else {
      // Inclusion: 5 or 1-32
      for (const n of expandNumbers(trimmed)) {
        include.add(n);
      }
    }
  }

  // Remove exclusions
  for (const n of exclude) {
    include.delete(n);
  }

  // Sort and build cameras
  const sorted = Array.from(include).sort((a, b) => a - b);
  return sorted.map(ch => ({ id: `${prefix}${ch}`, channel: ch }));
}

/** Expand "5" → [5], "1-10" → [1,2,...,10] */
function expandNumbers(s: string): number[] {
  const dashIdx = s.indexOf('-');
  if (dashIdx > 0) {
    const from = parseInt(s.slice(0, dashIdx));
    const to = parseInt(s.slice(dashIdx + 1));
    if (isNaN(from) || isNaN(to)) return [];
    const result: number[] = [];
    const [lo, hi] = [Math.min(from, to), Math.max(from, to)];
    for (let i = lo; i <= hi; i++) result.push(i);
    return result;
  }
  const n = parseInt(s);
  return isNaN(n) ? [] : [n];
}

/** Legacy cameras section parser (backward compat). */
function parseCamerasLegacy(section: any, prefix: string): CameraConfig[] {
  if (!section) return [];

  // Explicit array: [{id, channel, label, group}, ...]
  if (Array.isArray(section)) {
    return section.filter((c: any) => c.id && c.channel != null);
  }

  // Object with channels string
  if (section.channels && typeof section.channels === 'string') {
    return parseChannelsExpr(section.channels, section.id_prefix || prefix);
  }

  // Object with channels array [1,2,3]
  if (section.channels && Array.isArray(section.channels)) {
    const p = section.id_prefix || prefix;
    return section.channels.map((ch: number) => ({ id: `${p}${ch}`, channel: ch }));
  }

  // Auto-discover from range
  if (section.auto_discover || section.channel_range) {
    const range = section.channel_range || [1, 32];
    const p = section.id_prefix || prefix;
    return parseChannelsExpr(`${range[0]}-${range[1]}`, p);
  }

  return [];
}
