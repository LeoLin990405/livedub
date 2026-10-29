/**
 * livedub AudioWorklet PCM 处理器（classic worklet script，由 offscreen.js 通过
 * audioWorklet.addModule 加载）。
 *
 * 职责：把 AudioContext 的 Float32 采样按固定时长（默认 100ms）切块，
 * 需要时线性重采样到 16kHz，转成 s16le（int16）后 postMessage 给 offscreen 主线程。
 *
 * 为什么重采样放在 worklet 里：offscreen 侧为了音质会创建默认采样率（常见 48k）
 * 的监听 AudioContext；采集 AudioContext 优先请求 16000Hz（见 offscreen.js），
 * 但不同 Chrome / 设备可能给出别的采样率，这里兜底保证送进引擎的永远是 16k。
 *
 * 消息协议（worklet -> offscreen）：
 *   { type: 'pcm', pcm: ArrayBuffer(int16 小端), frames: number, sourceRate: number }
 */

const DEFAULT_TARGET_RATE = 16000;
const DEFAULT_CHUNK_MS = 100;

class LivedubPcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = Number(opts.targetRate) > 0 ? Number(opts.targetRate) : DEFAULT_TARGET_RATE;
    this.chunkMs = Number(opts.chunkMs) > 0 ? Number(opts.chunkMs) : DEFAULT_CHUNK_MS;
    // AudioWorkletGlobalScope 提供全局 sampleRate（= 当前 AudioContext 采样率）
    this.sourceRate = typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : this.targetRate;
    this.sourceChunk = Math.max(64, Math.round((this.sourceRate * this.chunkMs) / 1000));
    this.buffer = new Float32Array(this.sourceChunk * 2);
    this.filled = 0;
    this.framesSent = 0;
    this.port.onmessage = (event) => {
      const data = event && event.data;
      if (!data) return;
      if (data.type === 'flush') this._emitRemaining();
    };
  }

  _resample(input) {
    if (this.sourceRate === this.targetRate) return input;
    const ratio = this.sourceRate / this.targetRate;
    const outLen = Math.max(1, Math.floor(input.length / ratio));
    const out = new Float32Array(outLen);
    const last = input.length - 1;
    for (let i = 0; i < outLen; i += 1) {
      const pos = i * ratio;
      const i0 = Math.min(last, Math.floor(pos));
      const frac = pos - i0;
      const a = input[i0];
      const b = i0 < last ? input[i0 + 1] : a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }

  _emitChunk(chunk) {
    const resampled = this._resample(chunk);
    const int16 = new Int16Array(resampled.length);
    for (let i = 0; i < resampled.length; i += 1) {
      const value = resampled[i];
      let scaled = value < 0 ? value * 0x8000 : value * 0x7fff;
      if (!Number.isFinite(scaled)) scaled = 0;
      if (scaled >= 32767) scaled = 32767;
      else if (scaled <= -32768) scaled = -32768;
      int16[i] = Math.round(scaled);
    }
    if (int16.length === 0) return;
    this.framesSent += int16.length;
    this.port.postMessage({ type: 'pcm', pcm: int16.buffer, frames: int16.length, sourceRate: this.sourceRate }, [
      int16.buffer,
    ]);
  }

  _emitRemaining() {
    if (this.filled <= 0) return;
    const chunk = this.buffer.slice(0, this.filled);
    this.filled = 0;
    this._emitChunk(chunk);
  }

  process(inputs) {
    const input = inputs && inputs[0];
    const channel = input && input[0];
    if (!channel || channel.length === 0) return true;
    let src = channel;
    while (src.length > 0) {
      const space = this.buffer.length - this.filled;
      const take = Math.min(space, src.length);
      this.buffer.set(src.subarray(0, take), this.filled);
      this.filled += take;
      src = src.subarray(take);
      if (this.filled >= this.sourceChunk) {
        const chunk = this.buffer.slice(0, this.sourceChunk);
        this.buffer.copyWithin(0, this.sourceChunk, this.filled);
        this.filled -= this.sourceChunk;
        this._emitChunk(chunk);
      }
    }
    return true;
  }
}

registerProcessor('livedub-pcm', LivedubPcmProcessor);
