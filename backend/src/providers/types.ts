/**
 * NVR Provider types and interfaces.
 * Each NVR vendor (Hikvision, Dahua, etc.) implements NvrProvider.
 */

export interface CameraConfig {
  id: string;
  channel: number;
  label?: string;
  group?: string;
  ip?: string;
  model?: string;
  mac?: string;
  firmware?: string;
  serial?: string;
  // Generic provider: user-specified URLs
  live_url?: string;
  playback_url?: string;
  probe_url?: string;
}

export interface NvrConfig {
  provider: 'hikvision' | 'dahua' | 'generic';
  host: string;
  port: number;
  http_port?: number;       // for ISAPI/CGI discovery (default 80)
  username: string;
  password: string;
  // Hikvision-specific
  sub_stream_suffix?: string;
  main_stream_suffix?: string;
}

/** One NVR with its cameras. */
export interface NvrEntry {
  name: string;
  config: NvrConfig;
  cameras: CameraConfig[];
  id_prefix: string;
  /** true = auto-discover from NVR API */
  discover: boolean;
  /** Channel numbers to exclude after discovery */
  exclude: number[];
  /** Manual talkback channel override (from oko.yaml). Empty = auto-detect only. */
  talkback_channels: number[];
}

export interface CodecInfo {
  video: 'h264' | 'hevc' | 'unknown';
  audio: 'pcmu' | 'pcma' | 'aac' | 'g7221' | 'none' | string;
}

export interface PlaybackOptions {
  camera: CameraConfig;
  start: Date;
  end: Date;
  resolution: string;
  codecs: CodecInfo;
}

export interface PlaybackResult {
  source: string;
  forceMSE: boolean;
}

export interface NvrProvider {
  readonly type: string;

  /** RTSP base URL: rtsp://user:pass@host:port */
  readonly rtspBase: string;

  /** HTTP base URL for API: http://host:http_port */
  readonly httpBase: string;

  /** Auth credentials for HTTP API. */
  readonly auth: { username: string; password: string };

  /** Get live sub-stream URL for a camera. */
  getLiveUrl(camera: CameraConfig): string;

  /** Get live main-stream URL for a camera (for probing). */
  getProbeUrl(camera: CameraConfig): string;

  /** Get playback RTSP URL for a camera + time range. */
  getPlaybackUrl(camera: CameraConfig, start: Date, end: Date): string;

  /** Format a Date for NVR playback query (vendor-specific). */
  formatTime(date: Date): string;

  /** Get HTTP snapshot URL (JPEG) for a camera. */
  getSnapshotUrl(camera: CameraConfig): string;

  /** Get HTTP snapshot URL from archive at specific time. Returns null if not supported. */
  getPlaybackSnapshotUrl?(camera: CameraConfig, time: Date): string | null;

  buildPlaybackSource(options: PlaybackOptions): PlaybackResult;

  generateStreamConfig(cameras: CameraConfig[]): Record<string, string>;

  validateCameraId(id: string): boolean;

  /**
   * Auto-discover cameras from NVR via HTTP API.
   * Returns discovered cameras with channel numbers and optional names.
   * Returns null if discovery is not supported or failed.
   */
  discoverChannels(): Promise<DiscoveredCamera[]  | null>;

  /**
   * Detect which channels support two-way audio (talkback).
   * Returns set of channel numbers that have talkback capability.
   */
  detectTalkback(): Promise<Set<number>>;

  /**
   * Get go2rtc source URL for talkback (main stream with backchannel).
   * Returns null if not supported.
   */
  getTalkbackSource(camera: CameraConfig): string | null;
}

/** Camera discovered from NVR API. */
export interface DiscoveredCamera {
  channel: number;
  name?: string;
  online?: boolean;
  ip?: string;
  model?: string;
  mac?: string;
  firmware?: string;
  serial?: string;
}

/** Resolutions available for transcoding. null = original (no transcode). */
export const RESOLUTIONS: Record<string, number | null> = {
  'original': null,
  '1080p': 1920,
  '720p': 1280,
  '480p': 854,
  '360p': 640,
};
