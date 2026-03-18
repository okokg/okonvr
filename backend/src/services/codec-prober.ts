import { execFileSync } from 'child_process';
import { CodecInfo } from '../providers';
import { db, stmts } from '../db';
import { registry } from './camera-registry';

const codecCache = new Map<string, CodecInfo>();

/**
 * Probe video and audio codecs of a camera's main stream.
 * Uses registry to find the correct provider for the camera.
 */
export function probeCodecs(cameraId: string): CodecInfo {
  if (codecCache.has(cameraId)) return codecCache.get(cameraId)!;

  const row = stmts.getCodecs.get(cameraId) as any;
  if (row?.main_codec && row?.main_audio) {
    const result: CodecInfo = { video: row.main_codec, audio: row.main_audio };
    codecCache.set(cameraId, result);
    console.log(`[probe] ${cameraId}: cached → ${result.video}/${result.audio}`);
    return result;
  }

  const entry = registry.getEntry(cameraId);
  if (!entry) {
    console.log(`[probe] ${cameraId}: not in registry`);
    return { video: 'unknown', audio: 'none' };
  }

  const probeUrl = entry.provider.getProbeUrl(entry.camera);
  let video: CodecInfo['video'] = 'unknown';
  let audio: CodecInfo['audio'] = 'none';

  try {
    const vResult = execFileSync('ffprobe', [
      '-v', 'quiet', '-rtsp_transport', 'tcp',
      '-show_entries', 'stream=codec_name',
      '-select_streams', 'v:0', '-of', 'csv=p=0',
      probeUrl
    ], { timeout: 10000 }).toString().trim().split('\n')[0];

    video = (vResult === 'hevc' || vResult === 'h265') ? 'hevc'
          : vResult === 'h264' ? 'h264' : 'unknown';
  } catch (e: any) {
    console.log(`[probe] ${cameraId}: video probe failed — ${e.message?.substring(0, 80)}`);
  }

  try {
    const aResult = execFileSync('ffprobe', [
      '-v', 'quiet', '-rtsp_transport', 'tcp',
      '-show_entries', 'stream=codec_name',
      '-select_streams', 'a:0', '-of', 'csv=p=0',
      probeUrl
    ], { timeout: 10000 }).toString().trim().split('\n')[0];

    if (aResult) {
      const a = aResult.toLowerCase();
      audio = a.includes('pcm_mulaw') || a.includes('pcmu') ? 'pcmu'
            : a.includes('pcm_alaw') || a.includes('pcma') ? 'pcma'
            : a.includes('aac') ? 'aac'
            : a.includes('g722') ? 'g7221'
            : a || 'none';
    }
  } catch (e: any) {
    console.log(`[probe] ${cameraId}: audio probe failed — ${e.message?.substring(0, 80)}`);
  }

  // IMPORTANT: parameter order must match SQL: (id, main_codec, main_audio)
  stmts.setCodecs.run(cameraId, video, audio);
  const result: CodecInfo = { video, audio };
  codecCache.set(cameraId, result);
  console.log(`[probe] ${cameraId}: ${video}/${audio}`);
  return result;
}

export function clearCodecCache() {
  codecCache.clear();
}
