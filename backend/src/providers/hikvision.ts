import {
  NvrProvider, NvrConfig, CameraConfig, CodecInfo,
  PlaybackOptions, PlaybackResult, DiscoveredCamera, RESOLUTIONS
} from './types';
import { httpGet } from '../utils/http-client';

/**
 * Hikvision NVR provider.
 *
 * Discovery endpoints (tried in order):
 *   1. /ISAPI/ContentMgmt/InputProxy/channels — NVR with IP cameras (has names)
 *   2. /ISAPI/Streaming/channels — streaming channel list (fallback)
 *
 * URL patterns:
 *   Live sub:   /Streaming/Channels/{ch}02
 *   Live main:  /Streaming/Channels/{ch}01
 *   Playback:   /Streaming/tracks/{ch}01/?starttime=YYYYMMDDTHHMMSSZ&endtime=...
 */
export class HikvisionProvider implements NvrProvider {
  readonly type = 'hikvision';
  readonly rtspBase: string;
  readonly httpBase: string;
  readonly auth: { username: string; password: string };
  private subSuffix: string;
  private mainSuffix: string;

  constructor(config: NvrConfig) {
    this.rtspBase = `rtsp://${config.username}:${config.password}@${config.host}:${config.port}`;
    this.httpBase = `http://${config.host}:${config.http_port || 80}`;
    this.auth = { username: config.username, password: config.password };
    this.subSuffix = config.sub_stream_suffix || '02';
    this.mainSuffix = config.main_stream_suffix || '01';
  }

  private channelToTrack(channel: number, suffix: string): string {
    return `${channel * 100 + parseInt(suffix)}`;
  }

  getLiveUrl(camera: CameraConfig): string {
    const track = this.channelToTrack(camera.channel, this.subSuffix);
    return `${this.rtspBase}/Streaming/Channels/${track}`;
  }

  getProbeUrl(camera: CameraConfig): string {
    const track = this.channelToTrack(camera.channel, this.mainSuffix);
    return `${this.rtspBase}/Streaming/Channels/${track}`;
  }

  getSnapshotUrl(camera: CameraConfig): string {
    const track = this.channelToTrack(camera.channel, this.mainSuffix);
    return `${this.httpBase}/ISAPI/Streaming/channels/${track}/picture`;
  }

  getPlaybackSnapshotUrl(camera: CameraConfig, time: Date): string {
    const track = this.channelToTrack(camera.channel, this.mainSuffix);
    const t = this.formatTime(time);
    return `${this.httpBase}/ISAPI/ContentMgmt/StreamingProxy/channels/${track}/picture?starttime=${t}`;
  }

  getPlaybackUrl(camera: CameraConfig, start: Date, end: Date): string {
    const track = this.channelToTrack(camera.channel, this.mainSuffix);
    const st = this.formatTime(start);
    const et = this.formatTime(end);
    return `${this.rtspBase}/Streaming/tracks/${track}/?starttime=${st}&endtime=${et}`;
  }

  formatTime(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}Z`;
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
   * Auto-discover cameras from Hikvision NVR.
   * Tries InputProxy (NVR with IP cameras) first, then Streaming channels.
   */
  async discoverChannels(): Promise<DiscoveredCamera[] | null> {
    console.log(`Hikvision discovery: ${this.httpBase}`);

    // Try 1: InputProxy (NVR) — has camera names
    const inputProxy = await this.fetchAndParse(
      '/ISAPI/ContentMgmt/InputProxy/channels',
      'InputProxy',
      (body) => {
        const cameras: DiscoveredCamera[] = [];
        const blocks = body.match(/<InputProxyChannel>[\s\S]*?<\/InputProxyChannel>/g) || [];
        for (const block of blocks) {
          const idMatch = block.match(/<id>(\d+)<\/id>/);
          const nameMatch = block.match(/<name>(.*?)<\/name>/);
          if (idMatch) {
            cameras.push({
              channel: parseInt(idMatch[1]),
              name: nameMatch?.[1] || undefined,
            });
          }
        }
        return cameras;
      }
    );
    if (inputProxy && inputProxy.length > 0) return inputProxy;

    // Try 2: Streaming channels (fallback) — no names, parse track IDs
    const streaming = await this.fetchAndParse(
      '/ISAPI/Streaming/channels',
      'Streaming',
      (body) => {
        const channels = new Set<number>();
        const idMatches = body.matchAll(/<id>(\d+)<\/id>/g);
        for (const m of idMatches) {
          const streamId = parseInt(m[1]);
          // Main streams: 101, 201, 301... (suffix 01)
          if (streamId >= 100 && streamId % 100 === 1) {
            channels.add(Math.floor(streamId / 100));
          }
        }
        return Array.from(channels)
          .sort((a, b) => a - b)
          .map(ch => ({ channel: ch }));
      }
    );
    if (streaming && streaming.length > 0) return streaming;

    console.warn('  All discovery endpoints failed');
    return null;
  }

  /** Fetch an ISAPI endpoint and parse with a custom parser. */
  private async fetchAndParse(
    path: string,
    label: string,
    parser: (body: string) => DiscoveredCamera[]
  ): Promise<DiscoveredCamera[] | null> {
    const url = `${this.httpBase}${path}`;
    console.log(`  Trying ${label}: ${path}`);

    try {
      const { status, body } = await httpGet(url, this.auth);
      if (status !== 200 || !body) {
        console.log(`  ${label}: HTTP ${status}`);
        return null;
      }

      const cameras = parser(body);
      if (cameras.length === 0) {
        console.log(`  ${label}: parsed 0 cameras from ${body.length} bytes`);
        return null;
      }

      console.log(`  ${label}: found ${cameras.length} cameras`);
      cameras.forEach(c => console.log(`    ch${c.channel}: ${c.name || '(no name)'}`));
      return cameras;
    } catch (e: any) {
      console.log(`  ${label}: error — ${e.message}`);
      return null;
    }
  }
}
