// Discord-style screen capture for Electron. Uses Chromium's desktop capture
// path (chromeMediaSource) so a source picked in our own UI is captured
// directly — no OS picker — with explicit resolution / frame-rate control.

export type ScreenQuality = {
  /** Target height in pixels: 480 / 720 / 1080 / 1440 / 2160. */
  height: number;
  /** Target frame rate: 15 / 30 / 60. */
  fps: number;
  /** Capture system/stream audio alongside the video. */
  audio: boolean;
};

export const RESOLUTION_PRESETS = [480, 720, 1080, 1440, 2160] as const;
export const FPS_PRESETS = [15, 30, 60] as const;

// Bitrate ceiling (bps) chosen from resolution + fps, mirroring Discord tiers.
export function bitrateForQuality(quality: ScreenQuality): number {
  const base: Record<number, number> = {
    480: 1_000_000,
    720: 2_500_000,
    1080: 4_500_000,
    1440: 8_000_000,
    2160: 16_000_000,
  };
  const bitrate = base[quality.height] ?? 2_500_000;
  return quality.fps >= 60 ? Math.round(bitrate * 1.6) : bitrate;
}

type DesktopConstraints = {
  mandatory: {
    chromeMediaSource: 'desktop';
    chromeMediaSourceId?: string;
    maxWidth?: number;
    maxHeight?: number;
    maxFrameRate?: number;
    minFrameRate?: number;
  };
};

export async function captureScreenSource(
  sourceId: string,
  quality: ScreenQuality,
): Promise<MediaStream> {
  const maxHeight = quality.height;
  const maxWidth = Math.round((maxHeight * 16) / 9);
  const video: DesktopConstraints = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: sourceId,
      maxWidth,
      maxHeight,
      maxFrameRate: quality.fps,
    },
  };
  const audio: DesktopConstraints | false = quality.audio
    ? { mandatory: { chromeMediaSource: 'desktop' } }
    : false;

  // Electron accepts the legacy `mandatory` desktop constraints on getUserMedia.
  return navigator.mediaDevices.getUserMedia({
    audio: audio as unknown as MediaTrackConstraints | false,
    video: video as unknown as MediaTrackConstraints,
  });
}
