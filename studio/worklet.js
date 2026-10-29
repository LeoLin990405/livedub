/**
 * livedub 采集 AudioWorklet：把视频原声降到 16kHz 单声道 s16le，每 100ms 发一帧。
 *
 * - 线性重采样（足够语音识别；带相位余量，跨 process 块不丢样本）；
 * - 每帧 postMessage 一个 Int16Array 的 buffer（transferable，避免主线程拷贝）；
 * - 顺带算 RMS 电平，用于工作台输入电平条。
 *
 * 由 studio/app.mjs 通过 audioWorklet.addModule(new URL('./worklet.js', import.meta.url)) 加载。
 */

const TARGET_SAMPLE_RATE = 16000;
const FRAME_MS = 100;

class LivedubCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options?.processorOptions ?? {};
    const inputRate = Number(opts.inputSampleRate) || (typeof sampleRate === 'number' ? sampleRate : 48000);
    const targetRate = Number(opts.targetSampleRate) || TARGET_SAMPLE_RATE;
    const frameMs = Number(opts.frameMs) || FRAME_MS;

    this.ratio = inputRate / targetRate;
    this.frameSamples = Math.max(1, Math.round((frameMs / 1000) * targetRate));
    this.out = new Int16Array(this.frameSamples);
    this.outLen = 0;
    this.inBuf = new Float32Array(0);
    this.inPos = 0;
    this.sumSq = 0;
    this.stopped = false;

    this.port.onmessage = (event) => {
      if (event?.data?.type === 'stop') this.stopped = true;
    };
  }

  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0];
    const channels = input?.length ?? 0;
    if (channels === 0) return true;
    const frames = input[0]?.length ?? 0;
    if (frames === 0) return true;

    // 多声道 -> 单声道
    let mono;
    if (channels === 1) {
      mono = input[0];
    } else {
      mono = new Float32Array(frames);
      for (let ch = 0; ch < channels; ch += 1) {
        const data = input[ch];
        if (!data) continue;
        for (let i = 0; i < frames; i += 1) mono[i] += data[i];
      }
      for (let i = 0; i < frames; i += 1) mono[i] /= channels;
    }

    // 追加到内部缓冲（保留 1 个样本用于跨块插值）
    const merged = new Float32Array(this.inBuf.length + mono.length);
    merged.set(this.inBuf, 0);
    merged.set(mono, this.inBuf.length);
    this.inBuf = merged;

    const step = this.ratio;
    let produced = 0;
    while (this.inPos + 1 < this.inBuf.length) {
      const i0 = Math.floor(this.inPos);
      const frac = this.inPos - i0;
      const sample = this.inBuf[i0] * (1 - frac) + this.inBuf[i0 + 1] * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.out[this.outLen] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
      this.outLen += 1;
      this.sumSq += clamped * clamped;
      produced += 1;

      if (this.outLen >= this.frameSamples) {
        const level = Math.sqrt(this.sumSq / this.frameSamples);
        const frame = this.out;
        this.port.postMessage({ type: 'pcm', pcm: frame.buffer, level, samples: this.frameSamples }, [frame.buffer]);
        this.out = new Int16Array(this.frameSamples);
        this.outLen = 0;
        this.sumSq = 0;
      }
      this.inPos += step;
    }

    // 丢弃已消费的整数样本，保留小数相位
    const consume = Math.floor(this.inPos);
    if (consume > 0) {
      this.inBuf = this.inBuf.slice(consume);
      this.inPos -= consume;
    }

    if (produced === 0) {
      // 输入不足一帧：静默（不返回 false，保持 process 存活）
    }
    return true;
  }
}

registerProcessor('livedub-capture', LivedubCaptureProcessor);
