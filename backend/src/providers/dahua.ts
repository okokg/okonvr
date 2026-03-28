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
  readonly auth: { username: string; password: string };

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

  getSnapshotUrl(camera: CameraConfig): string {
    return `${this.httpBase}/cgi-bin/snapshot.cgi?channel=${camera.channel}`;
  }

  getPlaybackSnapshotUrl(_camera: CameraConfig, _time: Date): null {
    return null; // Dahua has no single-frame archive snapshot API
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

  /** Per-camera direct connection info (populated by detectTalkback or discoverChannels). */
  private cameraDirectInfo = new Map<number, { ip: string; user: string; pass: string; port: number }>();

  /** Fetch RemoteDevice info from NVR. Returns map of 0-based index → props. */
  private async fetchRemoteDeviceInfo(): Promise<Map<number, Map<string, string>>> {
    const cameras = new Map<number, Map<string, string>>();
    try {
      const url = `${this.httpBase}/cgi-bin/configManager.cgi?action=getConfig&name=RemoteDevice`;
      const { status, body } = await httpGet(url, this.auth);
      if (status !== 200 || !body) return cameras;

      for (const line of body.split('\n')) {
        const m = line.match(/NETCAMERA_INFO_(\d+)\.(\w+)=(.*)/);
        if (!m) continue;
        const idx = parseInt(m[1]);
        if (!cameras.has(idx)) cameras.set(idx, new Map());
        cameras.get(idx)!.set(m[2], m[3].trim());
      }
    } catch {}
    return cameras;
  }

  /**
   * Detect two-way audio channels.
   *
   * Primary: GET RemoteDevice → parse DeviceType for speaker indicators:
   *   -AS- = Audio+Speaker (built-in speaker)
   *   -PV- = Active Deterrence (siren+strobe, has speaker)
   *   -AS-PV- = both
   *
   * Also stores per-camera IP/creds for direct talkback connection
   * (NVR does not proxy RTSP backchannel).
   */
  async detectTalkback(): Promise<Set<number>> {
    const result = new Set<number>();
    this.cameraDirectInfo.clear();

    try {
      const cameras = await this.fetchRemoteDeviceInfo();
      console.log(`    RemoteDevice: ${cameras.size} cameras`);

      for (const [idx, props] of cameras) {
        const channel = idx + 1; // 0-based → 1-based
        const model = props.get('DeviceType') || '';
        const ip = props.get('Address') || '';
        const user = props.get('UserName') || '';
        const pass = props.get('Password') || '';
        const rtspPort = parseInt(props.get('RtspPort') || '0') || 554;

        if (ip && user) {
          this.cameraDirectInfo.set(channel, { ip, user, pass, port: rtspPort });
        }

        if (/-AS[-\s]|-PV[-\s]/i.test(model)) {
          result.add(channel);
          console.log(`    ch${channel}: ${model} @ ${ip} → speaker`);
        }
      }

      if (result.size === 0) {
        console.log(`    RemoteDevice: 0 cameras with speaker model`);
      }
    } catch (e: any) {
      console.log(`    RemoteDevice: ${e.message}`);
    }

    // Fallback: Speak config (works on some standalone cameras)
    if (result.size === 0) {
      try {
        const url = `${this.httpBase}/cgi-bin/configManager.cgi?action=getConfig&name=Speak`;
        const { status, body } = await httpGet(url, this.auth);
        if (status === 200 && body && body.includes('table.Speak')) {
          for (const line of body.split('\n')) {
            const m = line.match(/table\.Speak\[(\d+)\]\.Enable=true/i);
            if (m) result.add(parseInt(m[1]) + 1);
          }
          if (result.size > 0) console.log(`    Speak: ${result.size} channels`);
        }
      } catch {}
    }

    return result;
  }

  getTalkbackSource(camera: CameraConfig): string | null {
    // Talkback requires direct connection to camera (NVR doesn't proxy backchannel)
    // and proto=Onvif for Dahua to advertise the sendonly backchannel track
    const info = this.cameraDirectInfo.get(camera.channel);
    if (info && info.ip) {
      const port = info.port || 554;
      console.log(`[talkback] ${camera.id}: direct → ${info.ip}:${port}`);
      return `rtsp://${this.auth.username}:${this.auth.password}@${info.ip}:${port}/cam/realmonitor?channel=1&subtype=0&unicast=true&proto=Onvif#backchannel=1`;
    }

    // Fallback: try through NVR (unlikely to work for backchannel)
    console.log(`[talkback] ${camera.id}: no direct IP, falling back to NVR`);
    return `${this.rtspBase}/cam/realmonitor?channel=${camera.channel}&subtype=0&unicast=true&proto=Onvif#backchannel=1`;
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

      // Enrich with IP/model/mac/serial/firmware from RemoteDevice
      const remoteInfo = await this.fetchRemoteDeviceInfo();
      for (const cam of cameras) {
        const props = remoteInfo.get(cam.channel - 1); // 0-based index
        if (props) {
          cam.ip = props.get('Address') || undefined;
          cam.model = props.get('DeviceType') || undefined;
          cam.mac = props.get('Mac') || undefined;
          cam.serial = props.get('SerialNo') || undefined;
          cam.firmware = props.get('Version') || props.get('SoftwareVersion') || undefined;
        }
      }

      cameras.forEach(c => {
        const parts = [`ch${c.channel}: ${c.name || '(no name)'}`];
        if (c.ip) parts.push(`@ ${c.ip}`);
        if (c.model) parts.push(`[${c.model}]`);
        if (c.mac) parts.push(c.mac);
        console.log(`  ${parts.join(' ')}`);
      });
      return cameras.sort((a, b) => a.channel - b.channel);
    } catch (e: any) {
      console.warn(`Dahua CGI discovery failed: ${e.message}`);
      return null;
    }
  }
}
