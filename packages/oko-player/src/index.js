/**
 * oko-player — Camera surveillance player component.
 *
 * Core:
 *   CameraView  — single camera tile (video, HUD, loading, audio)
 *   CamPlayer   — WebRTC/MSE stream player
 *   CameraGrid  — grid layout, filtering, fullscreen nav
 *   ApiClient   — backend REST client
 *   Feature     — base class for plugins
 *
 * Features (attach via view.use()):
 *   PlaybackFeature  — archive seek timeline, day nav, thumbnails
 *   ZoomFeature      — digital zoom, minimap, pinch/wheel/drag
 *   TalkbackFeature  — push-to-talk, mic management
 *   QualityFeature   — SD/HD switching, resolution badge
 *
 * Usage:
 *   import { CameraView, CameraGrid, PlaybackFeature, ZoomFeature } from 'oko-player';
 *
 *   const cam = new CameraView({ id: 'D1', label: 'Entrance' })
 *     .use(new PlaybackFeature())
 *     .use(new ZoomFeature());
 */

// Core
export { CameraView } from './core/camera-view.js';
export { CamPlayer } from './core/camera-player.js';
export { CameraGrid } from './core/camera-grid.js';
export { Feature } from './core/feature.js';
export { ApiClient } from './api.js';

// Utilities
export { pad, hms, hm, dm, dmy, fmtInput, fmtFull, daySeconds } from './core/utils.js';

// Config
export * from './config.js';

// Features
export { ZoomFeature } from './features/zoom.js';
export { TalkbackFeature } from './features/talkback.js';
export { QualityFeature } from './features/quality.js';
export { PlaybackFeature } from './features/playback.js';

// Services
export { WatchMode } from './services/watch-mode.js';
export { MotionDetector } from './services/motion-detector.js';
export { ObjectClassifier } from './services/object-classifier.js';
