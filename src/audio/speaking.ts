export type SpeakingMonitorOptions = {
  /** RMS threshold (0-128 scale) above which the stream counts as speaking. */
  threshold?: number;
  /** How long the stream must stay quiet before "stopped speaking" fires (ms). */
  releaseMs?: number;
};

// A single shared AudioContext backs every speaking monitor. AudioContexts are
// a scarce browser resource (Chromium caps concurrent contexts), and the mic
// pipeline already owns one, so detection must not spin up more per stream.
let sharedContext: AudioContext | null = null;

function getSharedContext(): AudioContext | null {
  if (sharedContext && sharedContext.state !== 'closed') return sharedContext;
  try {
    sharedContext = new AudioContext();
  } catch {
    sharedContext = null;
  }
  return sharedContext;
}

/**
 * Watch a media stream's audio level and report speaking start/stop, Discord
 * "active speaker" style. Runs entirely locally off a WebAudio AnalyserNode, so
 * it needs no signaling and works the same for local and remote streams.
 *
 * A muted/disabled track emits silence, so it naturally reports "not speaking".
 * Never throws: if WebAudio is unavailable the monitor is simply inert.
 */
export function createSpeakingMonitor(
  stream: MediaStream,
  onChange: (speaking: boolean) => void,
  options: SpeakingMonitorOptions = {},
): () => void {
  const threshold = options.threshold ?? 10;
  const releaseMs = options.releaseMs ?? 260;

  const context = getSharedContext();
  if (!context || !stream.getAudioTracks().length) {
    return () => undefined;
  }

  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  try {
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
  } catch {
    return () => undefined;
  }

  const samples = new Uint8Array(analyser.frequencyBinCount);
  let speaking = false;
  let quietSince = 0;
  let raf = 0;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const centered = samples[i] - 128;
      sum += centered * centered;
    }
    const rms = Math.sqrt(sum / samples.length);
    const now = performance.now();
    if (rms > threshold) {
      quietSince = 0;
      if (!speaking) {
        speaking = true;
        onChange(true);
      }
    } else if (speaking) {
      if (!quietSince) {
        quietSince = now;
      } else if (now - quietSince > releaseMs) {
        speaking = false;
        onChange(false);
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    try { source.disconnect(); } catch { /* already gone */ }
    try { analyser.disconnect(); } catch { /* already gone */ }
    // The shared context is intentionally left open for reuse.
  };
}
