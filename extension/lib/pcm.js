/**
 * livedub 扩展的音频 / 文本纯函数库。
 *
 * 约束：
 * - 不依赖 Node API、不依赖 Chrome API —— 同一个文件在浏览器扩展页面（ESM）和
 *   Node 测试（ESM import）里都能跑；
 * - 音频格式与 docs/CONTRACTS.md §3 完全一致：s16le little-endian, mono, 16kHz；
 * - 二进制帧布局与 engine/protocol.mjs 的 encodeAudioFrame 一致：
 *   [0]=0x01 | [1..8]=float64BE tMs | [9..]=s16le；
 * - 仅供 offscreen / popup / 测试使用；content script 是 classic script，不 import 本文件。
 */

/** 线协议版本（必须与 engine/protocol.mjs 一致） */
export const PROTOCOL_VERSION = 1;
/** 二进制音频帧首字节魔数 */
export const AUDIO_FRAME_TAG = 0x01;
/** 帧头长度：1 字节 tag + 8 字节 float64BE tMs */
export const AUDIO_FRAME_HEADER_BYTES = 9;
/** 单帧上限（与 engine/protocol.mjs 对齐），防止异常数据打爆引擎 */
export const MAX_AUDIO_FRAME_BYTES = 256 * 1024;
/** ASR 输入采样率 */
export const TARGET_SAMPLE_RATE = 16000;
/** 推荐分片长度（毫秒） */
export const CHUNK_MS = 100;

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

// ---------------------------------------------------------------------------
// 类型转换小工具
// ---------------------------------------------------------------------------

/** @param {any} input @returns {Float32Array} */
function toFloat32Array(input) {
  if (input instanceof Float32Array) return input;
  if (Array.isArray(input)) return Float32Array.from(input);
  if (ArrayBuffer.isView(input)) return Float32Array.from(input);
  if (input instanceof ArrayBuffer) return new Float32Array(input.slice(0));
  throw new TypeError('expected Float32Array / number[] / ArrayBuffer');
}

/** @param {any} data @returns {Uint8Array} */
function toUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('expected Uint8Array / ArrayBuffer / TypedArray');
}

/**
 * 把「任意 PCM 输入」统一成 s16le 字节：
 * Int16Array / number[] 视为采样点；Float32Array 视为 [-1,1] 浮点采样；
 * Uint8Array / ArrayBuffer 视为已经是 s16le 字节。
 * @param {Int16Array|Uint8Array|ArrayBuffer|Float32Array|number[]} pcm
 * @returns {Uint8Array}
 */
function resolveS16leBytes(pcm) {
  if (pcm == null) throw new TypeError('pcm is required');
  if (pcm instanceof Int16Array) return s16leFromInt16(pcm);
  if (Array.isArray(pcm)) return s16leFromInt16(Int16Array.from(pcm));
  if (pcm instanceof Float32Array || pcm instanceof Float64Array) {
    return s16leFromInt16(float32ToInt16(pcm));
  }
  if (pcm instanceof Uint8Array) return pcm;
  if (pcm instanceof ArrayBuffer) return new Uint8Array(pcm);
  if (ArrayBuffer.isView(pcm)) return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  throw new TypeError('unsupported pcm type');
}

// ---------------------------------------------------------------------------
// 采样格式转换
// ---------------------------------------------------------------------------

/**
 * float32 [-1,1] -> int16（带饱和裁剪）。
 * 负数用 0x8000、正数用 0x7fff，保证 -1 -> -32768、1 -> 32767。
 * @param {Float32Array|number[]} input
 * @returns {Int16Array}
 */
export function float32ToInt16(input) {
  const src = toFloat32Array(input);
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = floatToS16(src[i]);
  return out;
}

/** @param {number} value @returns {number} */
function floatToS16(value) {
  if (!Number.isFinite(value)) return 0;
  const scaled = value < 0 ? value * 0x8000 : value * 0x7fff;
  if (scaled >= 32767) return 32767;
  if (scaled <= -32768) return -32768;
  return Math.round(scaled);
}

/**
 * int16 采样 -> float32 [-1,1]
 * @param {Int16Array|number[]} input
 * @returns {Float32Array}
 */
export function int16ToFloat32(input) {
  const src = input instanceof Int16Array ? input : Int16Array.from(input);
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] / 32768;
  return out;
}

/**
 * int16 采样 -> s16le 字节
 * @param {Int16Array|number[]} input
 * @returns {Uint8Array}
 */
export function s16leFromInt16(input) {
  const src = input instanceof Int16Array ? input : Int16Array.from(input);
  const bytes = new Uint8Array(src.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < src.length; i++) view.setInt16(i * 2, src[i], true);
  return bytes;
}

/**
 * s16le 字节 -> int16 采样（字节数必须是偶数）
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} data
 * @returns {Int16Array}
 */
export function int16FromS16le(data) {
  const bytes = toUint8Array(data);
  if (bytes.byteLength % 2 !== 0) throw new RangeError('s16le bytes length must be even');
  const out = new Int16Array(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

// ---------------------------------------------------------------------------
// 重采样（线性插值，够 48k->16k 的 ASR 输入用）
// ---------------------------------------------------------------------------

/**
 * 线性插值重采样。
 * @param {Float32Array|number[]} input
 * @param {number} fromRate 输入采样率
 * @param {number} toRate 目标采样率
 * @returns {Float32Array}
 */
export function resampleLinear(input, fromRate, toRate) {
  const src = toFloat32Array(input);
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) {
    throw new RangeError('fromRate/toRate must be positive finite numbers');
  }
  if (fromRate === toRate) return Float32Array.from(src);
  if (src.length === 0) return new Float32Array(0);
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(src.length / ratio));
  const out = new Float32Array(outLen);
  const last = src.length - 1;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.min(last, Math.floor(pos));
    const frac = pos - i0;
    const a = src[i0];
    const b = i0 < last ? src[i0 + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** 顺手用的 48k -> 16k */
export function downsample48kTo16k(input) {
  return resampleLinear(input, 48000, 16000);
}

/** 重采样到 16k（fromRate 已是 16k 时返回拷贝） */
export function resampleTo16k(input, fromRate) {
  return resampleLinear(input, fromRate, TARGET_SAMPLE_RATE);
}

// ---------------------------------------------------------------------------
// 二进制音频帧（必须与 engine/protocol.mjs 字节级一致）
// ---------------------------------------------------------------------------

/**
 * 编码一段 16k mono s16le PCM 为 WS 二进制帧：
 * [0]=0x01, [1..8]=float64BE tMs, [9..]=s16le 字节
 * @param {number} tMs 会话时间轴毫秒（非负有限数）
 * @param {Int16Array|Uint8Array|ArrayBuffer|Float32Array|number[]} pcm
 * @returns {Uint8Array}
 */
export function encodeAudioFrame(tMs, pcm) {
  if (typeof tMs !== 'number' || !Number.isFinite(tMs) || tMs < 0) {
    throw new RangeError('tMs must be a finite non-negative number');
  }
  const bytes = resolveS16leBytes(pcm);
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
    throw new RangeError('pcm must be non-empty s16le (even bytes)');
  }
  if (bytes.byteLength + AUDIO_FRAME_HEADER_BYTES > MAX_AUDIO_FRAME_BYTES) {
    throw new RangeError('audio frame too large');
  }
  const frame = new Uint8Array(AUDIO_FRAME_HEADER_BYTES + bytes.byteLength);
  frame[0] = AUDIO_FRAME_TAG;
  new DataView(frame.buffer).setFloat64(1, tMs, false);
  frame.set(bytes, AUDIO_FRAME_HEADER_BYTES);
  return frame;
}

/**
 * 解析二进制音频帧；非法返回 {ok:false, error}，不抛异常。
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} data
 * @returns {{ok:true,tMs:number,pcm:Uint8Array}|{ok:false,error:string}}
 */
export function decodeAudioFrame(data) {
  let bytes;
  try {
    bytes = toUint8Array(data);
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
  if (bytes.byteLength < AUDIO_FRAME_HEADER_BYTES + 2) return { ok: false, error: 'frame too short' };
  if (bytes[0] !== AUDIO_FRAME_TAG) return { ok: false, error: 'bad tag' };
  if ((bytes.byteLength - AUDIO_FRAME_HEADER_BYTES) % 2 !== 0) return { ok: false, error: 'odd pcm bytes' };
  const tMs = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(1, false);
  if (!Number.isFinite(tMs) || tMs < 0) return { ok: false, error: 'bad tMs' };
  return { ok: true, tMs, pcm: bytes.subarray(AUDIO_FRAME_HEADER_BYTES) };
}

/**
 * 便捷函数：把任意采样率 float32 采样编译成 16k 音频帧。
 * @param {number} tMs
 * @param {Float32Array|number[]} samples
 * @param {number} [sampleRate]
 * @returns {Uint8Array}
 */
export function buildAudioFrame(tMs, samples, sampleRate = TARGET_SAMPLE_RATE) {
  const resampled = sampleRate === TARGET_SAMPLE_RATE ? toFloat32Array(samples) : resampleTo16k(samples, sampleRate);
  return encodeAudioFrame(tMs, float32ToInt16(resampled));
}

// ---------------------------------------------------------------------------
// base64（引擎 dub 事件的 pcm 是 base64(s16le)）
// ---------------------------------------------------------------------------

/**
 * Uint8Array -> base64（纯 JS 实现，不依赖 atob/btoa/Buffer）
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} data
 * @returns {string}
 */
export function bytesToBase64(data) {
  const src = toUint8Array(data);
  let out = '';
  for (let i = 0; i < src.length; i += 3) {
    const b0 = src[i];
    const has1 = i + 1 < src.length;
    const has2 = i + 2 < src.length;
    const b1 = has1 ? src[i + 1] : 0;
    const b2 = has2 ? src[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += has1 ? B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += has2 ? B64_ALPHABET[b2 & 0x3f] : '=';
  }
  return out;
}

/**
 * base64 -> Uint8Array；非法输入抛 TypeError（调用方决定是否吞掉）。
 * @param {string} b64
 * @returns {Uint8Array}
 */
export function base64ToBytes(b64) {
  if (typeof b64 !== 'string') throw new TypeError('base64 must be a string');
  let src = b64.replace(/\s+/g, '');
  if (src.length === 0) return new Uint8Array(0);
  if (src.length % 4 !== 0) throw new TypeError('invalid base64: length must be multiple of 4');
  let pad = 0;
  if (src.endsWith('==')) pad = 2;
  else if (src.endsWith('=')) pad = 1;
  const out = new Uint8Array((src.length / 4) * 3 - pad);
  let outIndex = 0;
  for (let i = 0; i < src.length; i += 4) {
    const c0 = B64_LOOKUP[src.charCodeAt(i)];
    const c1 = B64_LOOKUP[src.charCodeAt(i + 1)];
    const c2char = src.charCodeAt(i + 2);
    const c3char = src.charCodeAt(i + 3);
    const c2 = c2char === 61 /* '=' */ ? 0 : B64_LOOKUP[c2char];
    const c3 = c3char === 61 ? 0 : B64_LOOKUP[c3char];
    // 注意：B64_LOOKUP 是定长 Int16Array，越界读取会得到 undefined，
    // 所以用 !(x >= 0) 而不是 x < 0 判断非法字符。
    if (!(c0 >= 0) || !(c1 >= 0) || !(c2 >= 0) || !(c3 >= 0)) {
      throw new TypeError('invalid base64: bad character');
    }
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (outIndex < out.length) out[outIndex++] = (triple >> 16) & 0xff;
    if (outIndex < out.length) out[outIndex++] = (triple >> 8) & 0xff;
    if (outIndex < out.length) out[outIndex++] = triple & 0xff;
  }
  return out;
}

/**
 * base64(s16le) -> Int16Array
 * @param {string} b64
 * @returns {Int16Array}
 */
export function base64ToInt16(b64) {
  return int16FromS16le(base64ToBytes(b64));
}

/**
 * base64(s16le) -> Float32Array（[-1,1]，用于 Web Audio 播放）
 * @param {string} b64
 * @returns {Float32Array}
 */
export function base64ToFloat32(b64) {
  return int16ToFloat32(base64ToInt16(b64));
}

// ---------------------------------------------------------------------------
// hello 消息（必须能被 engine/protocol.mjs#normalizeHello 接受）
// ---------------------------------------------------------------------------

/**
 * 构造客户端 hello（docs/CONTRACTS.md §3.1）。
 * @param {object} [opts]
 * @param {string} [opts.title]
 * @param {string} [opts.url]
 * @param {string} [opts.langFrom]
 * @param {string} [opts.langTo]
 * @param {string} [opts.source]
 * @param {number|null} [opts.tMsBase]
 * @param {object} [opts.overrides]
 * @param {Array<{src:string,dst:string}>} [opts.glossary]
 * @returns {object}
 */
export function buildHelloMessage({
  title = '',
  url = '',
  langFrom = 'en',
  langTo = 'zh',
  source = 'extension',
  tMsBase = null,
  overrides = {},
  glossary = [],
} = {}) {
  return {
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    session: {
      source,
      title: String(title ?? '').slice(0, 500),
      url: String(url ?? '').slice(0, 500),
      langFrom: String(langFrom || 'en').slice(0, 20),
      langTo: String(langTo || 'zh').slice(0, 20),
      tMsBase: Number.isFinite(tMsBase) && tMsBase >= 0 ? tMsBase : null,
      overrides: overrides && typeof overrides === 'object' ? overrides : {},
    },
    glossary: Array.isArray(glossary) ? glossary : [],
  };
}

/**
 * 计算一个 dub 音频块应该何时开始播放（offscreen 用，抽成纯函数便于单测）。
 *
 * 语义（docs/CONTRACTS.md §3.2）：`startMs` 是会话时间轴上的目标时刻；
 * 落后（来不及）就立即播；提前则排在未来。返回 AudioContext 时间轴上的绝对时间。
 *
 * @param {{startMs?:number, sessionNowMs?:number, currentTime:number, earlyBufferSec?:number}} opts
 * @returns {number}
 */
export function computeDubPlayhead({ startMs, sessionNowMs, currentTime, earlyBufferSec = 0.03 } = {}) {
  const current = Number.isFinite(currentTime) ? currentTime : 0;
  const buffer = Number.isFinite(earlyBufferSec) && earlyBufferSec >= 0 ? earlyBufferSec : 0.03;
  if (!Number.isFinite(startMs) || !Number.isFinite(sessionNowMs)) return current + buffer;
  const delaySec = (startMs - sessionNowMs) / 1000;
  const leadSec = delaySec > 0 ? delaySec : 0;
  // 最多提前 30s 排期，避免异常 startMs 把音频排到很久以后
  return current + Math.min(leadSec, 30) + buffer;
}

// ---------------------------------------------------------------------------
// 事件文本清洗 / 展示辅助
// ---------------------------------------------------------------------------

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * 清洗引擎事件文本：去控制字符、换行/制表归并成空格、压缩空白、截断。
 * @param {unknown} text
 * @param {{maxLen?:number}} [opts]
 * @returns {string}
 */
export function sanitizeEventText(text, { maxLen = 400 } = {}) {
  if (text == null) return '';
  const clean = String(text)
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(/[\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, Math.max(1, maxLen - 1))}…`;
}

/**
 * 双语字幕换行：按 maxCharsPerLine / maxLines 折叠，超出行数用 … 截断。
 * 中英混排都 OK（中文按字切，英文优先按空格切）。
 * @param {unknown} text
 * @param {{maxCharsPerLine?:number, maxLines?:number}} [opts]
 * @returns {string}
 */
export function wrapSubtitleLines(text, { maxCharsPerLine = 24, maxLines = 2 } = {}) {
  const lineChars = Math.max(4, Math.floor(maxCharsPerLine) || 24);
  const lineCount = Math.max(1, Math.floor(maxLines) || 2);
  const clean = sanitizeEventText(text, { maxLen: lineChars * lineCount * 4 });
  if (!clean) return '';
  const words = clean.split(' ');
  const lines = [];
  let line = '';
  const hardWrap = (word) => {
    for (let i = 0; i < word.length; i += lineChars) lines.push(word.slice(i, i + lineChars));
  };
  for (const word of words) {
    if (!word) continue;
    if (word.length > lineChars) {
      if (line) {
        lines.push(line);
        line = '';
      }
      hardWrap(word);
      continue;
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= lineChars) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  let out = lines.length > 0 ? lines : [clean];
  if (out.length > lineCount) {
    out = out.slice(0, lineCount);
    const last = out[lineCount - 1];
    out[lineCount - 1] = last.length >= lineChars ? `${last.slice(0, lineChars - 1)}…` : `${last}…`;
  }
  return out.join('\n');
}

/**
 * 延迟展示：<1000ms 显示整数毫秒，否则秒保留一位小数。
 * @param {number|null|undefined} ms
 * @returns {string}
 */
export function formatLatency(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const value = Math.max(0, ms);
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

/** 引擎 status.state / 扩展 phase 的中文标签 */
export function formatStateLabel(state) {
  const map = {
    idle: '空闲',
    stopped: '已停止',
    starting: '连接中',
    connecting: '连接中',
    running: '运行中',
    stopping: '停止中',
    listening: '收听中',
    translating: '翻译中',
    speaking: '配音中',
    paused: '已暂停',
    error: '异常',
    closed: '未连接',
    open: '已连接',
  };
  return map[state] ?? String(state ?? '未知');
}

/**
 * 从 metrics 事件里挑一个最适合展示的端到端延迟。
 * @param {object|null|undefined} metrics
 * @returns {number|null}
 */
export function pickLatencyMs(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  if (typeof metrics.e2eLagMs === 'number' && Number.isFinite(metrics.e2eLagMs)) return metrics.e2eLagMs;
  const parts = [metrics.asrFinalMs, metrics.mtDoneMs, metrics.ttsFirstMs].filter(
    (v) => typeof v === 'number' && Number.isFinite(v),
  );
  if (parts.length === 0) return null;
  return parts.reduce((sum, v) => sum + v, 0);
}

// ---------------------------------------------------------------------------
// 压音（ducking）状态机 —— 纯函数 + 显式时间，便于单测
// ---------------------------------------------------------------------------

function clampRatio(value, fallback = 0.18) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(1, Math.max(0.02, num));
}

/**
 * 压音状态机：content script 用它决定页面 media 音量。
 *
 * 语义（与 content.js 里的内联实现一致）：
 * - speak(tMs)：进入压音；持续收到活动事件时保持；
 * - idle(tMs)：标记「说话已结束」，从这一刻起 idleMs 后恢复；
 * - activity(tMs)：任意配音音频块到达，续命；
 * - tick(tMs)：推进时间，返回是否需要切换状态（changed）；
 * - 若 speak 后长时间（idleMs）没有任何事件，也会自动恢复，避免卡在压音。
 *
 * @param {{duckRatio?:number, idleMs?:number}} [opts]
 */
export function createDuckStateMachine({ duckRatio = 0.18, idleMs = 800 } = {}) {
  const idleDelay = Number.isFinite(idleMs) && idleMs >= 0 ? idleMs : 800;
  let ratio = clampRatio(duckRatio);
  let ducking = false;
  let idleSinceMs = null;
  let lastActivityMs = Number.NEGATIVE_INFINITY;

  const snapshot = (changed = false) => ({ ducking, changed, ratio });
  return {
    get ducking() {
      return ducking;
    },
    get ratio() {
      return ratio;
    },
    setRatio(value) {
      ratio = clampRatio(value, ratio);
      return ratio;
    },
    /** 开始/继续压音；返回 changed 表示是否需要立即改音量 */
    speak(tMs) {
      const changed = !ducking;
      ducking = true;
      idleSinceMs = null;
      lastActivityMs = Number.isFinite(tMs) ? tMs : lastActivityMs;
      return snapshot(changed);
    },
    /** 配音音频块到达（续命，不改变 ducking 状态） */
    activity(tMs) {
      if (!ducking) return snapshot(false);
      idleSinceMs = null;
      lastActivityMs = Number.isFinite(tMs) ? tMs : lastActivityMs;
      return snapshot(false);
    },
    /** 说话结束：从 tMs 起算 idleMs 后恢复 */
    idle(tMs) {
      if (!ducking) return snapshot(false);
      if (idleSinceMs == null) idleSinceMs = Number.isFinite(tMs) ? tMs : lastActivityMs;
      return snapshot(false);
    },
    /** 推进时间；返回 changed=true 时调用方应恢复音量 */
    tick(tMs) {
      if (!ducking || !Number.isFinite(tMs)) return snapshot(false);
      if (idleSinceMs != null) {
        if (tMs - idleSinceMs >= idleDelay) {
          ducking = false;
          idleSinceMs = null;
          return snapshot(true);
        }
        return snapshot(false);
      }
      if (tMs - lastActivityMs >= idleDelay) {
        ducking = false;
        return snapshot(true);
      }
      return snapshot(false);
    },
    /** 硬复位（stop / 切标签页） */
    reset() {
      const changed = ducking;
      ducking = false;
      idleSinceMs = null;
      lastActivityMs = Number.NEGATIVE_INFINITY;
      return snapshot(changed);
    },
  };
}
