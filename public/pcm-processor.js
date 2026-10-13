/**
 * AudioWorklet: downmixes to mono, resamples to the target rate (16 kHz) with
 * linear interpolation, and posts 100 ms chunks of 16-bit PCM to the main thread.
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const targetRate = options.processorOptions?.targetRate ?? 16000;
    this.ratio = sampleRate / targetRate;
    this.chunkSize = Math.round(targetRate / 10);
    this.out = new Float32Array(this.chunkSize);
    this.outIdx = 0;
    this.pending = new Float32Array(0);
    this.pos = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const n = channels[0].length;

    const merged = new Float32Array(this.pending.length + n);
    merged.set(this.pending);
    for (let c = 0; c < channels.length; c++) {
      const d = channels[c];
      for (let i = 0; i < n; i++) merged[this.pending.length + i] += d[i] / channels.length;
    }

    let i = this.pos;
    while (i + 1 < merged.length) {
      const i0 = Math.floor(i);
      const frac = i - i0;
      this.out[this.outIdx++] = merged[i0] * (1 - frac) + merged[i0 + 1] * frac;
      if (this.outIdx === this.chunkSize) this.flush();
      i += this.ratio;
    }
    const keepFrom = Math.min(Math.floor(i), merged.length);
    this.pending = merged.slice(keepFrom);
    this.pos = i - keepFrom;
    return true;
  }

  flush() {
    const pcm = new Int16Array(this.outIdx);
    for (let i = 0; i < this.outIdx; i++) {
      const s = Math.max(-1, Math.min(1, this.out[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    this.outIdx = 0;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
