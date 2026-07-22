export const RNNOISE_FRAME_SIZE = 480;

const PCM_SCALE = 32768;

export type RnnoiseModule = {
  HEAPF32: Float32Array;
  _free(pointer: number): void;
  _malloc(size: number): number;
  _rnnoise_create(): number;
  _rnnoise_destroy(context: number): void;
  _rnnoise_process_frame(context: number, output: number, input: number): number;
};

export class RnnoiseProcessor {
  private readonly context: number;
  private readonly framePointer: number;
  private readonly frameOffset: number;
  private destroyed = false;

  constructor(private readonly module: RnnoiseModule) {
    this.framePointer = module._malloc(RNNOISE_FRAME_SIZE * Float32Array.BYTES_PER_ELEMENT);
    if (!this.framePointer) throw new Error('RNNoise could not allocate its audio buffer');
    this.frameOffset = this.framePointer >> 2;
    this.context = module._rnnoise_create();
    if (!this.context) {
      module._free(this.framePointer);
      throw new Error('RNNoise could not create a processing context');
    }
  }

  process(frame: Float32Array) {
    if (frame.length !== RNNOISE_FRAME_SIZE) throw new Error('RNNoise frame must contain 480 samples');
    const heap = this.module.HEAPF32;
    for (let index = 0; index < RNNOISE_FRAME_SIZE; index += 1) {
      heap[this.frameOffset + index] = frame[index] * PCM_SCALE;
    }
    this.module._rnnoise_process_frame(this.context, this.framePointer, this.framePointer);
    for (let index = 0; index < RNNOISE_FRAME_SIZE; index += 1) {
      frame[index] = heap[this.frameOffset + index] / PCM_SCALE;
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.module._rnnoise_destroy(this.context);
    this.module._free(this.framePointer);
  }
}

