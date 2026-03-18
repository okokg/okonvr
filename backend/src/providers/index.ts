import { NvrProvider, NvrConfig } from './types';
import { HikvisionProvider } from './hikvision';
import { DahuaProvider } from './dahua';
import { GenericProvider } from './generic';

export function createProvider(config: NvrConfig): NvrProvider {
  switch (config.provider) {
    case 'hikvision': return new HikvisionProvider(config);
    case 'dahua':     return new DahuaProvider(config);
    case 'generic':   return new GenericProvider(config);
    default:
      throw new Error(`Unknown NVR provider: ${config.provider}`);
  }
}

export { NvrProvider, NvrConfig, NvrEntry, CameraConfig, CodecInfo, PlaybackOptions, PlaybackResult, DiscoveredCamera, RESOLUTIONS } from './types';
