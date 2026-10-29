/**
 * 音频工具：PCM s16le little-endian 单声道为项目内统一格式。
 * 所有函数零依赖、纯函数，便于单测。
 */

export const BYTES_PER_SAMPLE = 2;
export const INPUT_SAMPLE_RATE = 16000;

/** PCM 时长（毫秒） */
export function pcmDurationMs(pcm, sampleRate) {
  return Math.round(((pcm.length / BYTES_PER_SAMPLE) / sampleRate) * 1000);
}

/** 毫秒 -> 采样点数 */
export function msToSamples(ms, sampleRate) {
  return Math.max(0, Math.round((ms / 1000) * sampleRate));
}

/** Float32 [-1,1] -> s16le Buffer（自动 clamp） */
export function float32ToS16le(f32) {
  const out = Buffer.allocUnsafe(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i] ?? 0));
    out.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
  }
  return out;
}

/** s16le Buffer -> Float32Array [-1,1] */
export function s16leToFloat32(pcm) {
  const n = Math.floor(pcm.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 0x8000;
  return out;
}

/**
 * 线性重采样（够用、无依赖；TTS 24k -> 16k 等场景）。
 * 生产环境若要更高音质可换 wsola/ffmpeg，接口不变。
 */
export function resamplePcm(pcm, fromRate, toRate) {
  if (fromRate === toRate) return Buffer.from(pcm);
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) {
    throw new RangeError('bad sample rates');
  }
  const src = s16leToFloat32(pcm);
  const dstLen = Math.max(1, Math.round((src.length * toRate) / fromRate));
  const out = new Float32Array(dstLen);
  const ratio = (src.length - 1) / Math.max(1, dstLen - 1);
  for (let i = 0; i < dstLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(src.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = src[i0] * (1 - frac) + src[i1] * frac;
  }
  return float32ToS16le(out);
}

/** 构造 WAV 容器（用于 ASR / TTS 上传） */
export function wavFromPcm(pcm, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** 解析 WAV（PCM 16bit），返回 {pcm, sampleRate, channels}；不支持的格式抛错 */
export function pcmFromWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = buf.subarray(pos + 8, Math.min(buf.length, pos + 8 + size));
    if (id === 'fmt ') fmt = body;
    else if (id === 'data') data = body;
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('missing fmt/data chunk');
  const format = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const sampleRate = fmt.readUInt32LE(4);
  const bits = fmt.readUInt16LE(14);
  if (format !== 1 || bits !== 16) throw new Error(`unsupported wav format=${format} bits=${bits}`);
  return { pcm: data, sampleRate, channels };
}

/** 静音 PCM */
export function silencePcm(ms, sampleRate) {
  return Buffer.alloc(msToSamples(ms, sampleRate) * BYTES_PER_SAMPLE);
}

/** 拼接多段 PCM */
export function concatPcm(list) {
  return Buffer.concat(list.filter((b) => Buffer.isBuffer(b) && b.length > 0));
}

/** RMS（0..1） */
export function rms(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 0x8000;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

/** 峰值（0..1） */
export function peak(pcm) {
  const n = Math.floor(pcm.length / 2);
  let p = 0;
  for (let i = 0; i < n; i++) p = Math.max(p, Math.abs(pcm.readInt16LE(i * 2)) / 0x8000);
  return p;
}

/** 增益（可>1，自动 clamp） */
export function gainPcm(pcm, gain) {
  const out = Buffer.allocUnsafe(pcm.length);
  const g = Number.isFinite(gain) ? gain : 1;
  for (let i = 0; i < pcm.length; i += 2) {
    const v = Math.round(pcm.readInt16LE(i) * g);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i);
  }
  return out;
}

/**
 * 把 source 混入 target（target 需足够长），offsetSamples 为起始采样点。
 * 返回新的 Buffer，不修改入参。
 */
export function mixPcmInto(target, source, gain = 1, offsetSamples = 0) {
  const out = Buffer.from(target);
  const src = Buffer.from(source);
  const off = Math.max(0, Math.round(offsetSamples)) * BYTES_PER_SAMPLE;
  const n = Math.min(src.length, Math.max(0, out.length - off));
  for (let i = 0; i + 1 < n; i += 2) {
    const v = out.readInt16LE(off + i) + Math.round(src.readInt16LE(i) * gain);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), off + i);
  }
  return out;
}

/** base64 编解码（TTS 音频走 JSON 事件时使用） */
export function base64Pcm(pcm) {
  return pcm.toString('base64');
}
export function pcmFromBase64(str) {
  if (typeof str !== 'string' || str.length === 0) return Buffer.alloc(0);
  return Buffer.from(str, 'base64');
}

/** 按字节切块（流式输出用） */
export function chunkPcm(pcm, bytesPerChunk = 4096) {
  const chunks = [];
  for (let i = 0; i < pcm.length; i += bytesPerChunk) chunks.push(pcm.subarray(i, i + bytesPerChunk));
  return chunks;
}

/** 把 PCM 补零/裁剪到指定采样数 */
export function fitPcmSamples(pcm, samples) {
  const need = Math.max(0, Math.round(samples)) * BYTES_PER_SAMPLE;
  if (pcm.length === need) return Buffer.from(pcm);
  if (pcm.length > need) return pcm.subarray(0, need);
  return Buffer.concat([pcm, Buffer.alloc(need - pcm.length)]);
}
