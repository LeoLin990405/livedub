/**
 * livedub 线协议 v1 —— 浏览器扩展 / 本地工作台 <-> 本地引擎。
 *
 * 设计目标：
 * - 客户端只负责「抓一段 16k 单声道 PCM + 播放引擎返回的事件」，不关心重采样以外的任何音频细节；
 * - 引擎负责 VAD 切分、ASR、增量翻译、TTS、调度与降级；所有事件都带 session 时间轴（毫秒）；
 * - 时间轴 tMs：以客户端第一段音频的时间戳为 0；客户端自己定义（视频 currentTime 或采集启动时刻）。
 *
 * 传输：WebSocket。文本帧承载 JSON 事件；二进制帧承载音频（见 encodeAudioFrame）。
 * 权威文档：docs/CONTRACTS.md。改协议必须同步改本文件 + 文档 + 使用方。
 */

export const PROTOCOL_VERSION = 1;

/** ASR 输入采样率（引擎内部统一按此处理） */
export const AUDIO_INPUT_SAMPLE_RATE = 16000;

/** 二进制音频帧魔数：首字节 */
export const AUDIO_FRAME_TAG = 0x01;
/** 单帧上限，防止异常客户端打爆内存 */
export const MAX_AUDIO_FRAME_BYTES = 256 * 1024;

/** 语音识别输入推荐分片（客户端每 100ms 发一帧） */
export const AUDIO_FRAME_MS = 100;

export const MSG = Object.freeze({
  // client -> server
  HELLO: 'hello',
  AUDIO: 'audio', // JSON 兜底形态；常规走二进制帧
  CONTROL: 'control',
  CONFIG: 'config',
  GLOSSARY: 'glossary',
  PING: 'ping',
  BYE: 'bye',
  // server -> client
  READY: 'ready',
  STATUS: 'status',
  PARTIAL: 'partial',
  SEGMENT: 'segment',
  TRANSLATION: 'translation',
  DUB: 'dub',
  METRICS: 'metrics',
  VOICE: 'voice',
  ERROR: 'error',
  PONG: 'pong',
  LOG: 'log',
});

export const CONTROL_ACTIONS = Object.freeze(['pause', 'resume', 'stop', 'seek', 'flush']);

export const DEFAULT_SESSION_OPTIONS = Object.freeze({
  source: 'studio', // extension | studio | batch | test
  title: '',
  url: '',
  langFrom: 'en',
  langTo: 'zh',
  tMsBase: null, // null = 以第一段音频为 0；数字 = 客户端声明的会话起点
  /** 会话级配置覆盖（同 config/livedub.config.json 结构，深合并） */
  overrides: {},
});

/**
 * 编码一段 16k mono s16le PCM 为二进制 WS 帧。
 * 布局：[0]=0x01, [1..8]=float64BE tMs, [9..]=s16le PCM
 * @param {number} tMs 会话时间轴毫秒
 * @param {Buffer} pcm s16le little-endian, 16kHz, mono
 * @returns {Buffer}
 */
export function encodeAudioFrame(tMs, pcm) {
  if (!Buffer.isBuffer(pcm)) throw new TypeError('pcm must be a Buffer');
  if (pcm.length === 0 || pcm.length % 2 !== 0) throw new RangeError('pcm must be non-empty s16le (even bytes)');
  if (!Number.isFinite(tMs) || tMs < 0) throw new RangeError('tMs must be a finite non-negative number');
  if (pcm.length + 9 > MAX_AUDIO_FRAME_BYTES) throw new RangeError('audio frame too large');
  const buf = Buffer.allocUnsafe(9 + pcm.length);
  buf[0] = AUDIO_FRAME_TAG;
  buf.writeDoubleBE(tMs, 1);
  pcm.copy(buf, 9);
  return buf;
}

/**
 * 解析二进制音频帧；非法返回 {ok:false,error}。
 * @param {Buffer} buf
 */
export function decodeAudioFrame(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 11) return { ok: false, error: 'frame too short' };
  if (buf[0] !== AUDIO_FRAME_TAG) return { ok: false, error: 'bad tag' };
  if ((buf.length - 9) % 2 !== 0) return { ok: false, error: 'odd pcm bytes' };
  const tMs = buf.readDoubleBE(1);
  if (!Number.isFinite(tMs) || tMs < 0) return { ok: false, error: 'bad tMs' };
  return { ok: true, tMs, pcm: buf.subarray(9) };
}

function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 清洗术语表：去空、去重（按 src）、限制长度与数量 */
export function sanitizeGlossary(list, { maxTerms = 500, maxLen = 120 } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!isObject(item)) continue;
    const src = typeof item.src === 'string' ? item.src.trim() : '';
    const dst = typeof item.dst === 'string' ? item.dst.trim() : '';
    if (!src || !dst) continue;
    if (src.length > maxLen || dst.length > maxLen) continue;
    const key = src.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ src, dst, note: typeof item.note === 'string' ? item.note.slice(0, 200) : undefined });
    if (out.length >= maxTerms) break;
  }
  return out;
}

/** 解析一条客户端文本消息；未知类型原样返回，由 session 决定忽略或报错 */
export function parseClientMessage(text) {
  if (typeof text !== 'string' || text.length === 0) return { ok: false, error: 'empty message' };
  if (text.length > 1024 * 1024) return { ok: false, error: 'message too large' };
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return { ok: false, error: 'invalid json' };
  }
  if (!isObject(msg) || typeof msg.type !== 'string') return { ok: false, error: 'missing type' };
  return { ok: true, msg };
}

/** 校验 hello 消息，返回规范化后的会话选项 */
export function normalizeHello(msg) {
  if (!isObject(msg) || msg.type !== MSG.HELLO) return { ok: false, error: 'not hello' };
  const pv = msg.protocol ?? PROTOCOL_VERSION;
  if (pv !== PROTOCOL_VERSION) return { ok: false, error: `protocol mismatch: got ${pv}, want ${PROTOCOL_VERSION}` };
  const raw = isObject(msg.session) ? msg.session : {};
  const options = {
    ...DEFAULT_SESSION_OPTIONS,
    ...pick(raw, ['source', 'title', 'url', 'langFrom', 'langTo', 'tMsBase', 'overrides']),
  };
  if (!['extension', 'studio', 'batch', 'test'].includes(options.source)) options.source = 'studio';
  for (const k of ['title', 'url']) options[k] = String(options[k] ?? '').slice(0, 500);
  for (const k of ['langFrom', 'langTo']) options[k] = String(options[k] ?? '').slice(0, 20) || DEFAULT_SESSION_OPTIONS[k];
  if (options.tMsBase != null && (!Number.isFinite(options.tMsBase) || options.tMsBase < 0)) options.tMsBase = null;
  options.overrides = isObject(options.overrides) ? msg.session.overrides : {};
  if (msg.glossary) options.glossary = sanitizeGlossary(msg.glossary);
  return { ok: true, options };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** 服务端事件编码（JSON + 末尾换行便于调试） */
export function encodeEvent(event) {
  return JSON.stringify(event);
}

/** 统一生成 error 事件（scope: asr|translate|tts|voice|session|server） */
export function errorEvent(scope, message, extra = {}) {
  return {
    type: MSG.ERROR,
    scope,
    message: String(message ?? 'unknown error').slice(0, 800),
    recoverable: extra.recoverable !== false,
    ...(extra.segmentId != null ? { segmentId: extra.segmentId } : {}),
    ...(extra.code != null ? { code: extra.code } : {}),
    tsMs: extra.tsMs,
  };
}

/** 统一生成 status 事件 */
export function statusEvent(state, detail = '', tsMs = undefined) {
  return { type: MSG.STATUS, state, ...(detail ? { detail } : {}), ...(tsMs != null ? { tsMs } : {}) };
}
