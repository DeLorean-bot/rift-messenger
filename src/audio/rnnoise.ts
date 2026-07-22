import rnnoiseWorkletUrl from './rnnoise-worklet.ts?worker&url';

export type RnnoiseHandle = {
  track: MediaStreamTrack;
  stop: () => void;
};

async function buildRnnoiseTrack(sourceTrack: MediaStreamTrack): Promise<RnnoiseHandle> {
  const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  try {
    if (context.state === 'suspended') await context.resume();
    await context.audioWorklet.addModule(rnnoiseWorkletUrl);
    const source = context.createMediaStreamSource(new MediaStream([sourceTrack]));
    const worklet = new AudioWorkletNode(context, 'rift-rnnoise', {
      channelCount: 1,
      channelCountMode: 'explicit',
      outputChannelCount: [1],
    });
    const destination = context.createMediaStreamDestination();
    source.connect(worklet);
    worklet.connect(destination);
    const track = destination.stream.getAudioTracks()[0];

    return {
      track,
      stop: () => {
        worklet.port.postMessage({ type: 'destroy' });
        source.disconnect();
        worklet.disconnect();
        destination.stream.getTracks().forEach((item) => item.stop());
        void context.close();
      },
    };
  } catch (error) {
    void context.close();
    throw error;
  }
}

/**
 * Build an RNNoise-processed track. When `timeoutMs` is set and the WASM
 * worklet does not come up in time (slow WebView / underpowered CI runner),
 * the pending build is torn down and the promise rejects so callers can fall
 * back to browser noise suppression instead of stalling the whole call start.
 */
export function createRnnoiseTrack(
  sourceTrack: MediaStreamTrack,
  timeoutMs = 0,
): Promise<RnnoiseHandle> {
  const build = buildRnnoiseTrack(sourceTrack);
  if (!timeoutMs) return build;

  return new Promise<RnnoiseHandle>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // If the build eventually succeeds after we gave up, release its resources.
      build.then((handle) => handle.stop()).catch(() => undefined);
      reject(new Error('rnnoise-init-timeout'));
    }, timeoutMs);
    build.then(
      (handle) => {
        if (settled) {
          handle.stop();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(handle);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

