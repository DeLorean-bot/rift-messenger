import rnnoiseWorkletUrl from './rnnoise-worklet.ts?worker&url';

export type RnnoiseHandle = {
  track: MediaStreamTrack;
  stop: () => void;
};

export async function createRnnoiseTrack(sourceTrack: MediaStreamTrack): Promise<RnnoiseHandle> {
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

