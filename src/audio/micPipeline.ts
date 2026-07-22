import rnnoiseWorkletUrl from './rnnoise-worklet.ts?worker&url';

export type MicPipeline = {
  /** Processed track to send over WebRTC. Stable across RNNoise/gain changes. */
  track: MediaStreamTrack;
  /** Linear gain multiplier applied after (optional) RNNoise. 1 = unchanged. */
  setGain: (value: number) => void;
  /** Enable/disable RNNoise live without swapping the output track. */
  setRnnoise: (enabled: boolean) => Promise<void>;
  /** Whether RNNoise is currently in the graph (false if the worklet failed). */
  rnnoiseActive: () => boolean;
  stop: () => void;
};

export type MicPipelineOptions = {
  rnnoise: boolean;
  gain: number;
  /** Bound RNNoise worklet startup; 0 disables the timeout. */
  rnnoiseTimeoutMs?: number;
};

function addModuleBounded(context: AudioContext, url: string, timeoutMs: number): Promise<void> {
  const load = context.audioWorklet.addModule(url);
  if (!timeoutMs) return load;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('rnnoise-init-timeout'));
    }, timeoutMs);
    load.then(
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } },
      (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } },
    );
  });
}

/**
 * Build the send-side microphone graph:
 *   source -> [RNNoise worklet] -> gain -> destination
 * The output track is created once and stays stable while RNNoise is toggled or
 * the gain is adjusted, so no WebRTC renegotiation is needed for those changes.
 *
 * If RNNoise is requested but the WASM worklet fails to come up (slow WebView /
 * underpowered machine), the pipeline degrades to a plain gain passthrough and
 * reports `rnnoiseActive() === false` so the caller can fall back to browser
 * noise suppression instead of failing the whole call.
 */
export async function createMicPipeline(
  sourceTrack: MediaStreamTrack,
  options: MicPipelineOptions,
): Promise<MicPipeline> {
  const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  try {
    if (context.state === 'suspended') await context.resume();
    const source = context.createMediaStreamSource(new MediaStream([sourceTrack]));
    const gainNode = context.createGain();
    gainNode.gain.value = options.gain;
    const destination = context.createMediaStreamDestination();
    gainNode.connect(destination);

    let worklet: AudioWorkletNode | null = null;
    let rnnoiseOn = false;

    const rewire = () => {
      try { source.disconnect(); } catch { /* not connected yet */ }
      if (worklet) {
        try { worklet.disconnect(); } catch { /* not connected yet */ }
      }
      if (rnnoiseOn && worklet) {
        source.connect(worklet);
        worklet.connect(gainNode);
      } else {
        source.connect(gainNode);
      }
    };

    const ensureWorklet = async () => {
      if (worklet) return;
      await addModuleBounded(context, rnnoiseWorkletUrl, options.rnnoiseTimeoutMs ?? 0);
      worklet = new AudioWorkletNode(context, 'rift-rnnoise', {
        channelCount: 1,
        channelCountMode: 'explicit',
        outputChannelCount: [1],
      });
    };

    if (options.rnnoise) {
      try {
        await ensureWorklet();
        rnnoiseOn = true;
      } catch {
        rnnoiseOn = false; // degrade to passthrough; caller decides on browser NS
      }
    }
    rewire();

    const track = destination.stream.getAudioTracks()[0];

    return {
      track,
      setGain: (value: number) => {
        gainNode.gain.value = value;
      },
      setRnnoise: async (enabled: boolean) => {
        if (enabled && !worklet) {
          await ensureWorklet();
        }
        rnnoiseOn = enabled && Boolean(worklet);
        rewire();
      },
      rnnoiseActive: () => rnnoiseOn,
      stop: () => {
        worklet?.port.postMessage({ type: 'destroy' });
        try { source.disconnect(); } catch { /* already gone */ }
        try { worklet?.disconnect(); } catch { /* already gone */ }
        try { gainNode.disconnect(); } catch { /* already gone */ }
        destination.stream.getTracks().forEach((item) => item.stop());
        void context.close();
      },
    };
  } catch (error) {
    void context.close();
    throw error;
  }
}
