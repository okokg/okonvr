import { execFileSync } from 'child_process';
import { CodecInfo } from '../providers';
import { db, stmts } from '../db';
import { registry } from './camera-registry';

interface CachedCodec {
  info: CodecInfo;
  probedAt: number; // ms timestamp
}

const codecCache = new Map<string, CachedCodec>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Probe video and audio codecs of a camera's main stream.
 * Uses registry to find the correct provider for the camera.
 * @param force - bypass all caches and re-probe from RTSP
 */
export function probeCodecs(cameraId: string, force = false): CodecInfo {
  const now = Date.now();

  // Check in-memory cache (with TTL)
  if (!force) {
    const cached = codecCache.get(cameraId);
    if (cached && (now - cached.probedAt) < CACHE_TTL_MS) {
      return cached.info;
    }
  }

  // Check DB cache (with TTL — stored as epoch ms in probe_time column)
  if (!force) {
    const row = stmts.getCodecs.get(cameraId) as any;
    if (row?.main_codec && row?.main_audio && row?.probe_time) {
      const age = now - Number(row.probe_time);
      if (age < CACHE_TTL_MS) {
        const result: CodecInfo = { video: row.main_codec, audio: row.main_audio };
        codecCache.set(cameraId, { info: result, probedAt: Number(row.probe_time) });
        console.log(`[probe] ${cameraId}: cached → ${result.video}/${result.audio} (age ${Math.round(age / 60000)}m)`);
        return result;
      }
    }
  }

  const entry = registry.getEntry(cameraId);
  if (!entry) {
    console.log(`[probe] ${cameraId}: not in registry`);
    return { video: 'unknown', audio: 'none' };
  }

  const probeUrl = entry.provider.getProbeUrl(entry.camera);
  // Mask password in log
  const safeUrl = probeUrl.replace(/:([^@]+)@/, ':***@');
  console.log(`[probe] ${cameraId}: probing ${safeUrl}`);

  let video: CodecInfo['video'] = 'unknown';
  let audio: CodecInfo['audio'] = 'none';

  const t0 = Date.now();
  try {
    const vResult = execFileSync('ffprobe', [
      '-v', 'quiet', '-rtsp_transport', 'tcp',
      '-show_entries', 'stream=codec_name',
      '-select_streams', 'v:0', '-of', 'csv=p=0',
      probeUrl
    ], { timeout: 10000 }).toString().trim().split('\n')[0];

    video = (vResult === 'hevc' || vResult === 'h265') ? 'hevc'
          : vResult === 'h264' ? 'h264' : 'unknown';
    console.log(`[probe] ${cameraId}: video=${video} (raw="${vResult}") +${Date.now() - t0}ms`);
  } catch (e: any) {
    const elapsed = Date.now() - t0;
    const reason = e.status ? `exit ${e.status}` : e.killed ? 'timeout' : e.code || 'error';
    console.log(`[probe] ${cameraId}: video probe FAILED (${reason}) +${elapsed}ms — ${e.message?.substring(0, 100)}`);
  }

  const t1 = Date.now();
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
    console.log(`[probe] ${cameraId}: audio=${audio} (raw="${aResult || '(empty)'}") +${Date.now() - t1}ms`);
  } catch (e: any) {
    const elapsed = Date.now() - t1;
    const reason = e.status ? `exit ${e.status}` : e.killed ? 'timeout' : e.code || 'error';
    console.log(`[probe] ${cameraId}: audio probe FAILED (${reason}) +${elapsed}ms — ${e.message?.substring(0, 100)}`);
  }

  const totalMs = Date.now() - t0;

  // Save to DB with timestamp (wrapped — don't crash if DB schema mismatch)
  try {
    stmts.setCodecs.run(cameraId, video, audio, now);
  } catch (dbErr: any) {
    console.warn(`[probe] ${cameraId}: DB save failed — ${dbErr.message?.substring(0, 60)}`);
  }
  const result: CodecInfo = { video, audio };
  codecCache.set(cameraId, { info: result, probedAt: now });
  console.log(`[probe] ${cameraId}: ✓ ${video}/${audio} total=${totalMs}ms${force ? ' (forced)' : ''}`);
  return result;
}

/** Clear in-memory cache for specific cameras or all. */
export function clearCodecCache(cameraIds?: string[]) {
  if (cameraIds) {
    for (const id of cameraIds) codecCache.delete(id);
  } else {
    codecCache.clear();
  }
}
