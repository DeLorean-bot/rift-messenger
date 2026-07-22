import createRNNWasmModuleSync from '@jitsi/rnnoise-wasm/dist/rnnoise-sync.js';
import { RNNOISE_FRAME_SIZE, RnnoiseProcessor, type RnnoiseModule } from './rnnoise-processor';

declare const registerProcessor: (name: string, processor: typeof AudioWorkletProcessor) => void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const WORKLET_BLOCK_SIZE = 128;
const BUFFER_SIZE = 1920; // least common multiple of 128 and RNNoise's 480 samples

class RiftRnnoiseWorklet extends AudioWorkletProcessor {
  private readonly processor = new RnnoiseProcessor(createRNNWasmModuleSync() as RnnoiseModule);
  private readonly buffer = new Float32Array(BUFFER_SIZE);
  private inputLength = 0;
  private processedLength = 0;
  private outputIndex = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type === 'destroy') this.processor.destroy();
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output) return true;

    this.buffer.set(input, this.inputLength);
    this.inputLength += input.length;

    while (this.processedLength + RNNOISE_FRAME_SIZE <= this.inputLength) {
      this.processor.process(this.buffer.subarray(this.processedLength, this.processedLength + RNNOISE_FRAME_SIZE));
      this.processedLength += RNNOISE_FRAME_SIZE;
    }

    const available = this.outputIndex > this.processedLength
      ? BUFFER_SIZE - this.outputIndex
      : this.processedLength - this.outputIndex;
    if (available >= WORKLET_BLOCK_SIZE) {
      output.set(this.buffer.subarray(this.outputIndex, this.outputIndex + output.length));
      this.outputIndex += output.length;
    }

    if (this.outputIndex === BUFFER_SIZE) this.outputIndex = 0;
    if (this.inputLength === BUFFER_SIZE) {
      this.inputLength = 0;
      this.processedLength = 0;
    }
    return true;
  }
}

registerProcessor('rift-rnnoise', RiftRnnoiseWorklet);

