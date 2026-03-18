import {
  NvrProvider, NvrConfig, CameraConfig,
  PlaybackOptions, PlaybackResult, DiscoveredCamera, RESOLUTIONS
} from './types';

/**
 * Generic RTSP provider — user supplies full URLs per camera.
 * Used when NVR vendor is unknown or cameras are standalone.
 */
export class GenericProvider implements NvrProvider {
  readonly type = 'generic';
  readonly rtspBase: string;
  readonly httpBase: string;

  constructor(config: NvrConfig) {
    this.rtspBase = `rtsp://${config.username}:${config.password}@${config.host}:${config.port}`;
    this.httpBase = `http://${config.host}:${config.http_port || 80}`;
  }

  getLiveUrl(camera: CameraConfig): string {
    return camera.live_url || this.rtspBase;
  }

  getProbeUrl(camera: CameraConfig): string {
    return camera.probe_url || camera.live_url || this.rtspBase;
  }

  getPlaybackUrl(camera: CameraConfig, start: Date, end: Date): string {
    if (!camera.playback_url) return '';
    // Replace {start} and {end} placeholders if present
    return camera.playback_url
      .replace('{start}', this.formatTime(start))
      .replace('{end}', this.formatTime(end));
  }

  /** ISO 8601 format by default */
  formatTime(date: Date): string {
    return date.toISOString();
  }

  buildPlaybackSource(options: PlaybackOptions): PlaybackResult {
    const { camera, start, end, resolution, codecs } = options;
    const rtspUrl = this.getPlaybackUrl(camera, start, end);
    if (!rtspUrl) {
      throw new Error(`Camera ${camera.id} has no playback URL configured`);
    }

    const codec = codecs.video;
    const canCopyAudio = ['pcmu', 'pcma'].includes(codecs.audio);
    const audioFlags = canCopyAudio ? '#audio=copy' : '#raw=-an';

    if (resolution === 'original') {
      return { source: rtspUrl, forceMSE: codec !== 'h264' };
    }

    const width = RESOLUTIONS[resolution];
    return {
      source: `ffmpeg:${rtspUrl}#video=h264#width=${width}${audioFlags}`,
      forceMSE: false,
    };
  }

  generateStreamConfig(cameras: CameraConfig[]): Record<string, string> {
    const streams: Record<string, string> = {};
    for (const cam of cameras) {
      if (cam.live_url) {
        streams[cam.id] = cam.live_url;
      }
    }
    return streams;
  }

  validateCameraId(id: string): boolean {
    return /^[A-Za-z]\w{0,31}$/.test(id);
  }

  async discoverChannels(): Promise<DiscoveredCamera[] | null> {
    return null;
  }
}
