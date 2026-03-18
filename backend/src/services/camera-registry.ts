import { NvrProvider, NvrEntry, NvrConfig, CameraConfig } from '../providers';
import { createProvider } from '../providers';

interface CameraEntry {
  camera: CameraConfig;
  provider: NvrProvider;
  nvrName: string;
}

/**
 * Central registry: maps camera ID → its NVR provider.
 * Supports multiple NVRs, each with their own cameras.
 */
class CameraRegistry {
  private map = new Map<string, CameraEntry>();
  private providers: { name: string; provider: NvrProvider; cameras: CameraConfig[]; config: NvrConfig }[] = [];

  /** Initialize from NVR entries (parsed from oko.yaml). */
  init(nvrs: NvrEntry[]) {
    this.map.clear();
    this.providers = [];

    for (const nvr of nvrs) {
      const provider = createProvider(nvr.config);
      this.providers.push({ name: nvr.name, provider, cameras: nvr.cameras, config: nvr.config });

      for (const cam of nvr.cameras) {
        if (this.map.has(cam.id)) {
          console.warn(`Duplicate camera ID "${cam.id}" in NVR "${nvr.name}" — skipped`);
          continue;
        }
        this.map.set(cam.id, { camera: cam, provider, nvrName: nvr.name });
      }
    }

    console.log(`Camera registry: ${this.map.size} cameras across ${nvrs.length} NVR(s)`);
  }

  /** Get provider for a camera ID. */
  getProvider(cameraId: string): NvrProvider | undefined {
    return this.map.get(cameraId)?.provider;
  }

  /** Get camera config by ID. */
  getCamera(cameraId: string): CameraConfig | undefined {
    return this.map.get(cameraId)?.camera;
  }

  /** Get entry (camera + provider + nvrName). */
  getEntry(cameraId: string): CameraEntry | undefined {
    return this.map.get(cameraId);
  }

  /** Check if camera exists. */
  has(cameraId: string): boolean {
    return this.map.has(cameraId);
  }

  /** All camera IDs. */
  allIds(): string[] {
    return Array.from(this.map.keys());
  }

  /** All cameras. */
  allCameras(): CameraConfig[] {
    return Array.from(this.map.values()).map(e => e.camera);
  }

  /** All NVR info for health checks. */
  getNvrs(): { name: string; host: string; port: number; cameraCount: number }[] {
    return this.providers.map(p => ({
      name: p.name,
      host: p.config.host,
      port: p.config.port,
      cameraCount: p.cameras.length,
    }));
  }

  /** Generate go2rtc streams config from all NVRs. */
  generateAllStreams(): Record<string, string> {
    const streams: Record<string, string> = {};
    for (const { provider, cameras } of this.providers) {
      Object.assign(streams, provider.generateStreamConfig(cameras));
    }
    return streams;
  }
}

/** Singleton registry. */
export const registry = new CameraRegistry();
