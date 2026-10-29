/** 测试共享 helper（不包含 node:test 用例本身） */
import { silencePcm, float32ToS16le, pcmDurationMs } from '../engine/audio.mjs';

export { silencePcm, float32ToS16le, pcmDurationMs };

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 生成一段可被识别为「有声音」的 PCM（供 VAD 相关测试用） */
export function tonePcm(durationMs, sampleRate = 16000, freq = 220, amplitude = 0.3) {
  const n = Math.round((durationMs / 1000) * sampleRate);
  const f32 = new Float32Array(n);
  for (let i = 0; i < n; i++) f32[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amplitude;
  return float32ToS16le(f32);
}

export function makeTonePcm(durationMs, sampleRate = 24000, freq = 392) {
  return tonePcm(durationMs, sampleRate, freq, 0.18);
}
