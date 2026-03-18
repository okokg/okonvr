import {
  NvrProvider, NvrConfig, CameraConfig, CodecInfo,
  PlaybackOptions, PlaybackResult, DiscoveredCamera, RESOLUTIONS
} from './types';
import { httpGet } from '../utils/http-client';

/**
 * Dahua NVR provider.
 */
export class DahuaProvider implements NvrProvider {
  readonly type = 'dahua';
  readonly rtspBase: string;
  readonly httpBase: string;
  private auth: { username: string; password: string };

  constructor(config: NvrConfig) {
    this.rtspBase = `rtsp://${config.username}:${config.password}@${config.host}:${config.port}`;
    this.httpBase = `http://${config.host}:${config.http_port || 80}`;
    this.auth = { username: config.username, password: config.password };
  }

  getLiveUrl(camera: CameraConfig): string {
    return `${this.rtspBase}/cam/realmonitor?channel=${camera.channel}&subtype=1`;
  }

  getProbeUrl(camera: CameraConfig): string {
    return `${this.rtspBase}/cam/realmonitor?channel=${camera.channel}&subtype=0`;
  }

  getPlaybackUrl(camera: CameraConfig, start: Date, end: Date): string {
    const st = this.formatTime(start);
    const et = this.formatTime(end);
    return `${this.rtspBase}/cam/playback?channel=${camera.channel}&starttime=${st}&endtime=${et}`;
  }

  /** Dahua time format: YYYY-MM-DD-HH-MM-SS */
  /** Dahua time format: YYYY_MM_DD_HH_MM_SS */
  formatTime(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}_${pad(date.getMonth() + 1)}_${pad(date.getDate())}_${pad(date.getHours())}_${pad(date.getMinutes())}_${pad(date.getSeconds())}`;
  }

  buildPlaybackSource(options: PlaybackOptions): PlaybackResult {
    const { camera, start, end, resolution, codecs } = options;
    const rtspUrl = this.getPlaybackUrl(camera, start, end);
    const codec = codecs.video;

    const canCopyAudio = ['pcmu', 'pcma'].includes(codecs.audio);
    const audioFlags = canCopyAudio ? '#audio=copy' : '#raw=-an';

    if (resolution === 'original') {
      return { source: rtspUrl, forceMSE: codec !== 'h264' };
    }

    const width = RESOLUTIONS[resolution];
    if (codec !== 'h264') {
      return {
        source: `ffmpeg:${rtspUrl}#input=playback#video=h264#width=${width}${audioFlags}`,
        forceMSE: false,
      };
    }

    return {
      source: `ffmpeg:${rtspUrl}#video=h264#width=${width}${audioFlags}`,
      forceMSE: false,
    };
  }

  generateStreamConfig(cameras: CameraConfig[]): Record<string, string> {
    const streams: Record<string, string> = {};
    for (const cam of cameras) {
      streams[cam.id] = this.getLiveUrl(cam);
    }
    return streams;
  }

  validateCameraId(id: string): boolean {
    return /^[A-Za-z]\w{0,15}$/.test(id);
  }

  /**
   * Discover cameras via CGI: GET /cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle
   * Supports both Basic and Digest auth automatically.
   */
  async discoverChannels(): Promise<DiscoveredCamera[] | null> {
    const url = `${this.httpBase}/cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle`;
    console.log(`Dahua discovery: ${this.httpBase}`);

    try {
      const { status, body } = await httpGet(url, this.auth);

      if (status !== 200) {
        console.warn(`Dahua CGI returned ${status}`);
        return null;
      }

      // Parse: table.ChannelTitle[0].Name=CAM1 (0-based → 1-based)
      const cameras: DiscoveredCamera[] = [];
      const seen = new Set<number>();
      const lines = body.split('\n');
      for (const line of lines) {
        const indexMatch = line.match(/table\.ChannelTitle\[(\d+)\]\.Name=(.*)/);
        if (indexMatch) {
          const ch = parseInt(indexMatch[1]) + 1;
          const name = indexMatch[2]?.trim() || undefined;
          if (!seen.has(ch)) {
            cameras.push({ channel: ch, name });
            seen.add(ch);
          }
        }
      }

      if (cameras.length === 0) {
        console.warn(`Dahua CGI: parsed 0 cameras from ${body.length} bytes`);
        return null;
      }

      console.log(`Dahua CGI: found ${cameras.length} cameras`);
      cameras.forEach(c => console.log(`  ch${c.channel}: ${c.name || '(no name)'}`));
      return cameras.sort((a, b) => a.channel - b.channel);
    } catch (e: any) {
      console.warn(`Dahua CGI discovery failed: ${e.message}`);
      return null;
    }
  }
}
