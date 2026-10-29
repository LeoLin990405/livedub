/**
 * TTS provider 工厂 + 低延迟文本切块。
 *
 * 契约见 docs/CONTRACTS.md §4：
 *   createTts({ config, log, fetchImpl }) -> {
 *     name,
 *     synthesize({ text, voiceId, speed, signal }) -> { pcm, sampleRate, format:'s16le', durationMs, voiceId },
 *     synthesizeStream?(...) -> AsyncIterable<{ pcm, sampleRate, format:'s16le', durationMs }>,
 *     listVoices() -> [{ id, label, gender?, cloned? }],
 *     cloneVoice({ pcm, sampleRate, name, signal }) -> { voiceId, mode:'clone', provider, name },
 *   }
 *
 * provider：
 *   - minimax    : MiniMax t2a_v2（PCM 24k 直出；SSE 流式；失败自动退非流式；克隆走 files/upload + voice_clone）
 *   - volcengine : 火山引擎（豆包语音）TTS v3 流式 + 声音复刻 v3（真正原声克隆；需控制台 UUID Key）
 *   - macos-say  : macOS `say` 合成 AIFF + ffmpeg 转 s16le（无 Key / 断网兜底）
 *   - mock       : engine/mock.mjs 的确定性正弦波实现（离线测试/演示）
 *
 * 另外导出 splitForTts(text, { minClauseChars, maxChunkChars })：
 *   pipeline 用它把译文按「子句」切成小段，逐段合成以降低首包延迟。
 *   规则：中英标点都会切；短子句会合并；超长兜底；不切断数字（1,000 / 3.14）与代码标识符（msToSamples / node.js）。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveProvider } from '../config.mjs';
import { wavFromPcm, pcmDurationMs } from '../audio.mjs';
import { createMockTts } from '../mock.mjs';

// ---------------------------------------------------------------------------
// 错误与通用小工具
// ---------------------------------------------------------------------------

function ttsError(message, { code, provider = 'tts', hint, cause } = {}) {
  const suffix = hint ? `；下一步：${hint}` : '';
  const err = new Error(`[tts:${provider}] ${message}${suffix}`);
  if (code !== undefined) err.code = code;
  err.provider = provider;
  if (cause) err.cause = cause;
  return err;
}

function abortError() {
  return new DOMException('tts aborted', 'AbortError');
}

function isAbortLike(err) {
  return err?.name === 'AbortError' || err?.code === 'aborted' || err?.code === 'ABORT_ERR';
}

function positiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clampSpeed(speed) {
  const n = Number(speed);
  if (!Number.isFinite(n)) return 1;
  return Math.min(2, Math.max(0.5, Math.round(n * 100) / 100));
}

const MAX_TTS_CHARS = 5000;

function normalizeText(text, { maxChars = MAX_TTS_CHARS } = {}) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) throw ttsError('文本为空，无需合成', { code: 'empty_text' });
  if (s.length > maxChars) {
    throw ttsError(`文本过长（${s.length} 字 > ${maxChars}）：先用 splitForTts() 切成小段再逐段合成`, { code: 'text_too_long' });
  }
  return s;
}

// ---------------------------------------------------------------------------
// v0.2：LRU 音频缓存 / 参数校验 / 预热（Lead 在 session ready 时调用 tts.warmup?.()）
// ---------------------------------------------------------------------------

const CACHE_DEFAULTS = Object.freeze({
  enabled: true,
  maxEntries: 64, // 最多缓存 64 条短语（教学视频重复短语/术语很多）
  maxTextChars: 120, // 只缓存短文本；长句缓存收益低且占内存
  maxBytes: 32 * 1024 * 1024, // 额外内存上限（防御性，正常远达不到）
});
const DEFAULT_VOICE_LIST_TTL_MS = 300000; // listVoices 短 TTL：5 分钟
const SPEED_MIN = 0.5;
const SPEED_MAX = 2;
const MAX_VOICE_ID_CHARS = 128;

/** 读 config.tts.cache（缺省即启用，符合 v0.2 默认行为） */
function resolveCacheConfig(ttsCfg) {
  const raw = ttsCfg?.cache ?? {};
  const num = (value, fallback) => {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    enabled: raw.enabled === undefined ? CACHE_DEFAULTS.enabled : Boolean(raw.enabled),
    maxEntries: num(raw.maxEntries, CACHE_DEFAULTS.maxEntries),
    maxTextChars: num(raw.maxTextChars, CACHE_DEFAULTS.maxTextChars),
    maxBytes: num(raw.maxBytes, CACHE_DEFAULTS.maxBytes),
  };
}

/** voiceId 归一化 + 校验：空/未传 -> presetVoices.default；非法值给出可操作错误 */
function resolveVoiceId(ttsCfg, voiceId) {
  const fallback = typeof ttsCfg?.presetVoices?.default === 'string' ? ttsCfg.presetVoices.default : null;
  if (voiceId == null) return fallback;
  if (typeof voiceId !== 'string') {
    throw ttsError(`voiceId 必须是字符串（收到 ${typeof voiceId}），例如 "male-qn-qingse"`, { code: 'bad_voice_id' });
  }
  const raw = voiceId.trim();
  if (!raw) return fallback;
  if (raw.length > MAX_VOICE_ID_CHARS) {
    throw ttsError(`voiceId 过长（${raw.length} > ${MAX_VOICE_ID_CHARS}）：检查 config.tts.presetVoices / 克隆音色 ID`, {
      code: 'bad_voice_id',
    });
  }
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw ttsError('voiceId 含控制字符：请传 MiniMax 音色 ID（如 male-qn-qingse）或 macOS 音色名（如 Tingting）', {
      code: 'bad_voice_id',
    });
  }
  return raw;
}

/** 进程内 LRU 音频缓存（key = voiceId + speed + text，value = 整段 PCM） */
class TtsAudioCache {
  constructor({ config, log = () => {} }) {
    this.config = config;
    this.log = log;
    this.map = new Map();
    this.bytes = 0;
    this.lookups = 0;
    this.hits = 0;
    this.misses = 0;
    this.stores = 0;
    this.evictions = 0;
    this.skipped = 0;
  }

  /** 该文本是否值得缓存（关闭 / 空 / 超长 都不缓存） */
  eligible(text) {
    return (
      this.config.enabled &&
      this.config.maxEntries > 0 &&
      typeof text === 'string' &&
      text.length > 0 &&
      text.length <= this.config.maxTextChars
    );
  }

  get(key) {
    this.lookups += 1;
    const entry = this.map.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    // LRU：命中后移到 Map 队尾
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits += 1;
    return entry;
  }

  set(key, entry) {
    if (!this.config.enabled || this.config.maxEntries <= 0) return false;
    if (this.map.has(key)) {
      this.bytes -= this.map.get(key).bytes;
      this.map.delete(key);
    }
    this.map.set(key, entry);
    this.bytes += entry.bytes;
    this.stores += 1;
    while (this.map.size > this.config.maxEntries || (this.config.maxBytes > 0 && this.bytes > this.config.maxBytes)) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      const evicted = this.map.get(oldestKey);
      this.map.delete(oldestKey);
      this.bytes -= evicted.bytes;
      this.evictions += 1;
    }
    return true;
  }

  clear() {
    this.map.clear();
    this.bytes = 0;
  }

  stats() {
    return {
      enabled: this.config.enabled,
      maxEntries: this.config.maxEntries,
      maxTextChars: this.config.maxTextChars,
      maxBytes: this.config.maxBytes,
      entries: this.map.size,
      bytes: this.bytes,
      lookups: this.lookups,
      hits: this.hits,
      misses: this.misses,
      stores: this.stores,
      evictions: this.evictions,
      skipped: this.skipped,
      hitRate: this.lookups > 0 ? Math.round((this.hits / this.lookups) * 1000) / 1000 : 0,
    };
  }
}

/** 把 provider 包一层：参数校验 + LRU 缓存 + listVoices TTL + warmup + stats */
function createManagedTts(provider, { config = {}, log = () => {} } = {}) {
  const ttsCfg = config?.tts ?? {};
  const cache = new TtsAudioCache({ config: resolveCacheConfig(ttsCfg), log });
  const name = provider.name ?? 'tts';
  const defaultSpeed = clampSpeed(ttsCfg.speed ?? 1);
  const voiceListTtlMs = positiveInt(ttsCfg.voiceListTtlMs, DEFAULT_VOICE_LIST_TTL_MS);
  const fallbackSampleRate = positiveInt(ttsCfg.sampleRate, positiveInt(provider.sampleRate, 24000));

  let voicesCache = null; // { list, at }
  let voiceFetches = 0;
  let warmupPromise = null;
  const warmupStats = { called: false, ok: null, elapsedMs: 0, error: null };

  /** 统一入口校验：空文本/非法 voiceId/speed 钳制 -> 内存里的请求描述 */
  function normalizeRequest(opts = {}) {
    const text = normalizeText(opts?.text);
    const speed = clampSpeed(opts?.speed ?? defaultSpeed);
    const voiceId = resolveVoiceId(ttsCfg, opts?.voiceId);
    const signal = opts?.signal ?? null;
    return { text, speed, voiceId, signal, key: `${voiceId ?? ''}\u0001${speed}\u0001${text}` };
  }

  function toResult(entry) {
    return {
      pcm: entry.pcm,
      sampleRate: entry.sampleRate,
      format: 's16le',
      durationMs: entry.durationMs,
      voiceId: entry.voiceId ?? null,
    };
  }

  function makeEntry(res, voiceId) {
    const pcm = Buffer.isBuffer(res?.pcm) ? res.pcm : Buffer.from(res?.pcm ?? []);
    const sampleRate = positiveInt(res?.sampleRate, fallbackSampleRate);
    return {
      pcm,
      sampleRate,
      format: 's16le',
      durationMs: Number.isFinite(res?.durationMs) ? res.durationMs : pcmDurationMs(pcm, sampleRate),
      voiceId: res?.voiceId ?? voiceId ?? null,
      bytes: pcm.length + 64,
      storedAt: Date.now(),
    };
  }

  async function synthesize(opts = {}) {
    const req = normalizeRequest(opts);
    if (req.signal?.aborted) throw abortError();
    const cacheable = cache.eligible(req.text);
    if (cacheable) {
      const hit = cache.get(req.key);
      if (hit) {
        log(`[tts:${name}] cache hit（${req.text.length} 字 / ${hit.durationMs}ms 音频）`);
        return toResult(hit);
      }
    } else {
      cache.skipped += 1;
    }

    const res = await provider.synthesize({ text: req.text, voiceId: req.voiceId, speed: req.speed, signal: req.signal });
    if (req.signal?.aborted) throw abortError(); // 会话已关闭：结果丢弃，且不写缓存
    const entry = makeEntry(res, req.voiceId);
    if (cacheable && entry.pcm.length > 0) {
      cache.set(req.key, entry);
      log(`[tts:${name}] cache store（${req.text.length} 字 / ${entry.durationMs}ms 音频 / entries=${cache.stats().entries}）`);
    }
    return toResult(entry);
  }

  async function* synthesizeStream(opts = {}) {
    const req = normalizeRequest(opts);
    if (req.signal?.aborted) throw abortError();
    const cacheable = cache.eligible(req.text);
    if (cacheable) {
      const hit = cache.get(req.key);
      if (hit) {
        log(`[tts:${name}] cache hit（流式直接回放缓存 ${hit.durationMs}ms）`);
        yield toResult(hit);
        return;
      }
    } else {
      cache.skipped += 1;
    }

    const parts = []; // 只有可缓存的短文本才累积，避免长文本额外占内存
    let sampleRate = fallbackSampleRate;
    if (typeof provider.synthesizeStream === 'function') {
      for await (const chunk of provider.synthesizeStream({ text: req.text, voiceId: req.voiceId, speed: req.speed, signal: req.signal })) {
        const pcm = Buffer.isBuffer(chunk?.pcm) ? chunk.pcm : Buffer.from(chunk?.pcm ?? []);
        if (pcm.length === 0) continue;
        sampleRate = positiveInt(chunk?.sampleRate, sampleRate);
        const durationMs = Number.isFinite(chunk?.durationMs) ? chunk.durationMs : pcmDurationMs(pcm, sampleRate);
        if (cacheable) parts.push(pcm);
        yield { pcm, sampleRate, format: 's16le', durationMs };
      }
    } else {
      const res = await provider.synthesize({ text: req.text, voiceId: req.voiceId, speed: req.speed, signal: req.signal });
      const entry = makeEntry(res, req.voiceId);
      if (entry.pcm.length > 0) {
        if (cacheable) parts.push(entry.pcm);
        yield toResult(entry);
      }
    }
    // 被 abort 的请求不写缓存；正常消费完才写（消费者中途 break 也不会写）
    if (cacheable && parts.length > 0 && !req.signal?.aborted) {
      const pcm = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      cache.set(req.key, {
        pcm,
        sampleRate,
        format: 's16le',
        durationMs: pcmDurationMs(pcm, sampleRate),
        voiceId: req.voiceId ?? null,
        bytes: pcm.length + 64,
        storedAt: Date.now(),
      });
      log(`[tts:${name}] cache store（流式 ${req.text.length} 字 / entries=${cache.stats().entries}）`);
    }
  }

  async function listVoices() {
    const now = Date.now();
    if (voicesCache && now - voicesCache.at < voiceListTtlMs) return voicesCache.list;
    const list = await provider.listVoices();
    voiceFetches += 1;
    voicesCache = { list, at: Date.now() };
    return list;
  }

  /** 预热：失败只 log 不 throw（Lead 在 session ready 时调用，任何异常都不能影响会话） */
  async function warmup() {
    if (warmupPromise) return warmupPromise;
    warmupStats.called = true;
    const started = Date.now();
    warmupPromise = (async () => {
      try {
        let detail = null;
        if (typeof provider.warmup === 'function') detail = await provider.warmup();
        if (Array.isArray(detail?.voices) && detail.voices.length > 0) {
          voicesCache = { list: detail.voices, at: Date.now() };
          voiceFetches += 1;
        } else if (!voicesCache) {
          // provider 没有 warmup（mock/macos-say）时顺手暖一下音色列表（本地/静态，几乎零成本）
          try {
            const list = await listVoices();
            if (Array.isArray(list) && list.length > 0) voicesCache = { list, at: Date.now() };
          } catch {
            /* 音色列表失败不影响 warmup 成功与否 */
          }
        }
        warmupStats.ok = detail?.ok !== false;
        warmupStats.elapsedMs = Date.now() - started;
        warmupStats.error = warmupStats.ok ? null : String(detail?.error ?? 'unknown');
        log(`[tts:${name}] warmup ${warmupStats.ok ? 'ok' : '失败'} ${warmupStats.elapsedMs}ms`);
        return {
          ok: warmupStats.ok,
          provider: name,
          elapsedMs: warmupStats.elapsedMs,
          voices: voicesCache?.list?.length ?? 0,
          ...(detail?.error ? { error: String(detail.error) } : {}),
        };
      } catch (err) {
        warmupStats.ok = false;
        warmupStats.elapsedMs = Date.now() - started;
        warmupStats.error = String(err?.message ?? err);
        log(`[tts:${name}] warmup 失败（不影响配音）：${warmupStats.error}`);
        return { ok: false, provider: name, elapsedMs: warmupStats.elapsedMs, error: warmupStats.error };
      }
    })();
    return warmupPromise;
  }

  function stats() {
    const now = Date.now();
    return {
      name,
      provider: name,
      cache: cache.stats(),
      voiceList: {
        cached: Boolean(voicesCache),
        entries: voicesCache?.list?.length ?? 0,
        ageMs: voicesCache ? now - voicesCache.at : null,
        ttlMs: voiceListTtlMs,
        fetches: voiceFetches,
      },
      warmup: { ...warmupStats },
    };
  }

  const managed = {
    ...provider,
    name,
    sampleRate: provider.sampleRate ?? fallbackSampleRate,
    synthesize,
    synthesizeStream,
    listVoices,
    warmup,
    stats,
    clearCache: () => cache.clear(),
  };
  if (typeof provider.cloneVoice === 'function') managed.cloneVoice = provider.cloneVoice.bind(provider);
  else delete managed.cloneVoice;
  return managed;
}

// ---------------------------------------------------------------------------
// splitForTts：按子句切块（pipeline 低延迟配音用）
// ---------------------------------------------------------------------------

const SPLIT_DEFAULTS = Object.freeze({ minClauseChars: 8, maxChunkChars: 80 });
const MIN_CHUNK_CHARS = 4;

/** 强断句标点（句号/叹号/问号/分号/省略号/换行） */
const STRONG_PUNCT = new Set(['。', '！', '？', '!', '?', '；', ';', '…', '\n']);
/** 弱断句标点（逗号/顿号/冒号）——只在需要时切，短句会合并 */
const WEAK_PUNCT = new Set(['，', ',', '、', '：', ':']);
/** 句末标点后跟随的收尾符号，应留在上一块 */
const CLOSERS = new Set([')', ']', '}', '）', '】', '」', '』', '”', '’', '"', "'"]);
const PUNCT_CHARS = new Set([...STRONG_PUNCT, ...WEAK_PUNCT, '.', '…', '—']);
const WORD_CHAR_RE = /[A-Za-z0-9_]/;

function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 判断 text[i] 是否可以作为子句边界。
 * 返回 { soft:boolean } 或 null（不切）。soft=true 表示弱标点（逗号类）。
 * 关键保护：不切断数字（1,000 / 3.14 / 2024.10）、代码标识符（node.js / v1.2.3）、URL（http://）。
 */
function boundaryAt(text, i) {
  const ch = text[i];
  const prev = text[i - 1] ?? '';
  const next = text[i + 1] ?? '';
  if (ch === '.') {
    // 3.14 / node.js / v1.2.3：两侧都是字母数字下划线时不切
    if (WORD_CHAR_RE.test(prev) && WORD_CHAR_RE.test(next)) return null;
    return { soft: false };
  }
  if (ch === ',') {
    // 1,000：两侧都是数字时不切
    if (/\d/.test(prev) && /\d/.test(next)) return null;
    return { soft: true };
  }
  if (ch === ':') {
    // http:// / :: 之类代码写法不切
    if (next === '/' || next === ':' || prev === ':') return null;
    return { soft: true };
  }
  if (ch === '?' || ch === '!') {
    // URL 查询串（a?b=1）或代码（foo!bar）里两侧都是词字符时不切
    if (WORD_CHAR_RE.test(prev) && WORD_CHAR_RE.test(next)) return null;
    return { soft: false };
  }
  if (STRONG_PUNCT.has(ch)) return { soft: false };
  if (WEAK_PUNCT.has(ch)) return { soft: true };
  return null;
}

/** 切出「原始子句」：标点跟着上一句；连续的标点/收尾引号合并处理 */
function rawClauses(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const info = boundaryAt(text, i);
    if (!info) continue;
    let end = i + 1;
    // 连续标点（如 "?!"、"。。。"）一起留在句尾
    while (end < text.length && PUNCT_CHARS.has(text[end])) end += 1;
    // 句末收尾引号/括号一起留在句尾
    while (end < text.length && CLOSERS.has(text[end])) end += 1;
    const piece = text.slice(start, end).trim();
    if (piece) out.push(piece);
    start = end;
    i = end - 1;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** 合并两个子句：中英混排时按需补一个空格 */
function joinClauses(a, b) {
  if (!a) return b;
  if (!b) return a;
  const aTail = a.slice(-1);
  const bHead = b.slice(0, 1);
  const asciiEnd = /[A-Za-z0-9_)\]}"']/.test(aTail);
  const asciiStart = /[A-Za-z0-9_("'\[]/.test(bHead);
  return asciiEnd && asciiStart ? `${a} ${b}` : `${a}${b}`;
}

/** 在超长块里找一个安全的切点（<= max），尽量不切断单词/数字 */
function findSafeCut(s, max) {
  const half = Math.max(1, Math.floor(max / 2));
  const upper = Math.min(max, s.length - 1);
  // 1) 优先在空白处切（英文/代码最常见）
  for (let i = upper; i >= half; i--) {
    if (/\s/.test(s[i])) return i;
  }
  // 2) 其次在标点后切（切点 <= max）；两侧都是词字符时视为代码/URL 内部，不切
  for (let i = Math.min(max, s.length) - 1; i >= half; i--) {
    if (!PUNCT_CHARS.has(s[i])) continue;
    const prev = s[i - 1] ?? '';
    const next = s[i + 1] ?? '';
    if (WORD_CHAR_RE.test(prev) && WORD_CHAR_RE.test(next)) continue;
    return i + 1;
  }
  // 3) 硬切：向前避让最多 12 个字符，避免切断标识符/数字
  let cut = Math.min(max, s.length);
  for (let k = 0; k < 12 && cut > 1; k++) {
    const a = s[cut - 1];
    const b = s[cut] ?? '';
    if (!(WORD_CHAR_RE.test(a) && WORD_CHAR_RE.test(b))) break;
    cut -= 1;
  }
  if (cut < Math.max(1, max - 12)) cut = Math.min(max, s.length); // 避让过头就硬切
  // 不要从代理对（emoji）中间切开
  if (cut < s.length) {
    const code = s.charCodeAt(cut);
    if (code >= 0xdc00 && code <= 0xdfff) cut += 1;
  }
  return Math.max(1, Math.min(cut, s.length));
}

function sliceLongChunk(text, maxChunkChars) {
  const out = [];
  let rest = text;
  while (rest.length > maxChunkChars) {
    const cut = findSafeCut(rest, maxChunkChars);
    const head = rest.slice(0, cut).trim();
    if (head) out.push(head);
    rest = rest.slice(cut).trimStart();
  }
  const tail = rest.trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * 把译文切成适合 TTS 的小块（保证每块 <= maxChunkChars）。
 *
 * @param {string} text
 * @param {{minClauseChars?:number, maxChunkChars?:number}} [options]
 * @returns {string[]}
 */
export function splitForTts(text, options = {}) {
  const raw = typeof text === 'string' ? text : String(text ?? '');
  const requestedMin = clampInt(options?.minClauseChars, SPLIT_DEFAULTS.minClauseChars, 1, 4000);
  const maxChunkChars = clampInt(options?.maxChunkChars, SPLIT_DEFAULTS.maxChunkChars, MIN_CHUNK_CHARS, 8000);
  const minClauseChars = Math.min(requestedMin, maxChunkChars);

  // 行内多空格压成一个空格；换行保留为强断句
  const normalized = raw.replace(/[ \t\u00a0]+/g, ' ').trim();
  if (!normalized) return [];

  const clauses = rawClauses(normalized);

  // 1) 合并短子句，避免把「好的。」这种 3 个字单独发一次 TTS
  const merged = [];
  let buf = '';
  const flush = () => {
    if (buf) merged.push(buf);
    buf = '';
  };
  for (const clause of clauses) {
    if (!clause) continue;
    if (!buf) {
      buf = clause;
      continue;
    }
    const joined = joinClauses(buf, clause);
    if (joined.length > maxChunkChars) {
      flush();
      buf = clause;
      continue;
    }
    if (buf.length >= minClauseChars) {
      flush();
      buf = clause;
      continue;
    }
    buf = joined;
  }
  flush();

  // 2) 超长兜底拆分
  const chunks = [];
  for (const chunk of merged) {
    if (chunk.length <= maxChunkChars) chunks.push(chunk);
    else chunks.push(...sliceLongChunk(chunk, maxChunkChars));
  }

  // 3) 过滤纯标点/空白（对 TTS 无意义）
  return chunks.map((c) => c.trim()).filter((c) => c.length > 0 && /[\p{L}\p{N}]/u.test(c));
}

// ---------------------------------------------------------------------------
// createTts 工厂
// ---------------------------------------------------------------------------

/**
 * @param {{config?:object, log?:Function, fetchImpl?:Function}} [opts]
 */
export async function createTts({ config = {}, log = () => {}, fetchImpl = globalThis.fetch } = {}) {
  const provider = config?.tts?.provider;
  if (!provider) {
    throw ttsError('config.tts.provider 未配置（可选 minimax | volcengine | macos-say | mock）', { code: 'missing_provider' });
  }
  let base;
  if (provider === 'minimax') base = createMinimaxTts({ config, log, fetchImpl });
  else if (provider === 'volcengine') base = createVolcengineTts({ config, log, fetchImpl });
  else if (provider === 'macos-say') base = createMacosSayTts({ config, log });
  else if (provider === 'mock') base = createMockTts({ config, log });
  else throw new Error(`unknown provider: ${provider}（tts.provider 支持 minimax | volcengine | macos-say | mock）`);
  // v0.2：统一加 LRU 缓存 / 预热 / 参数校验 / listVoices TTL（契约外的可选扩展，只增不减）
  return createManagedTts(base, { config, log });
}

/**
 * 带降级链的 TTS 装配（可选便捷入口）：按 config.tts.provider -> config.tts.fallbacks 顺序
 * 依次尝试创建 provider；合成时主 provider 失败自动切下一个（当前仓库默认链：
 * minimax -> macos-say），用于「无 Key / 断网 / 克隆套餐不支持」兜底。
 *
 * registry 想启用只需把 createTts 换成 createTtsWithFallback：
 *   const factory = ttsMod.createTtsWithFallback ?? ttsMod.createTts;
 *   return factory({ config, log });
 *
 * 单 provider 语义仍以 createTts 为准（契约 §4），本函数只是组合层，失败仍会 throw。
 */
export async function createTtsWithFallback({ config = {}, log = () => {}, fetchImpl = globalThis.fetch } = {}) {
  const ttsCfg = config?.tts ?? {};
  const primaryProvider = ttsCfg.provider ?? 'mock';
  const fallbackEntries = Array.isArray(ttsCfg.fallbacks) ? ttsCfg.fallbacks : [];
  const order = [];
  for (const name of [primaryProvider, ...fallbackEntries.map((f) => f?.provider)]) {
    if (!name || order.includes(name)) continue;
    order.push(name);
  }

  // 创建失败的 provider 只记日志（例如 minimax 没有 Key），不阻塞其余降级候选。
  const instances = [];
  const createFailures = [];
  for (const provider of order) {
    try {
      const cfg = provider === primaryProvider ? config : { ...config, tts: { ...ttsCfg, provider } };
      const inst = await createTts({ config: cfg, log, fetchImpl });
      instances.push(inst);
      if (provider !== primaryProvider) log(`[tts] fallback provider 就绪：${provider}`);
    } catch (err) {
      createFailures.push(`${provider}: ${err?.message ?? err}`);
      log(`[tts] provider ${provider} 不可用，跳过：${err?.message ?? err}`);
    }
  }
  if (instances.length === 0) {
    throw ttsError(`没有可用的 TTS provider（尝试顺序 ${order.join(' -> ')}）：${createFailures.join('；')}`, {
      code: 'no_tts_provider',
      hint: '检查 ~/.sayless/config.json 的 providers.*.apiKey，或把 config.tts.provider 设为 macos-say / mock',
    });
  }

  const primary = instances[0];
  let lastError = null;

  const providerError = () =>
    ttsError(`所有 TTS provider 都失败（${instances.map((i) => i.name).join(' -> ')}）：${lastError?.message ?? 'unknown'}`, {
      code: 'all_tts_providers_failed',
      cause: lastError ?? undefined,
    });

  async function synthesize(opts = {}) {
    for (const inst of instances) {
      try {
        return await inst.synthesize(opts);
      } catch (err) {
        lastError = err;
        if (isAbortLike(err) || opts?.signal?.aborted) throw err;
        log(`[tts] ${inst.name} synthesize 失败，尝试下一个 provider：${err?.message ?? err}`);
      }
    }
    throw providerError();
  }

  async function* synthesizeStream(opts = {}) {
    for (const inst of instances) {
      let yielded = 0;
      try {
        if (typeof inst.synthesizeStream === 'function') {
          for await (const chunk of inst.synthesizeStream(opts)) {
            yielded += 1;
            yield chunk;
          }
        } else {
          const res = await inst.synthesize(opts);
          if (res?.pcm?.length) {
            yielded += 1;
            yield { pcm: res.pcm, sampleRate: res.sampleRate, format: 's16le', durationMs: res.durationMs };
          }
        }
        if (yielded > 0) return;
        log(`[tts] ${inst.name} 流式没有音频，尝试下一个 provider`);
      } catch (err) {
        if (isAbortLike(err) || opts?.signal?.aborted) throw err;
        lastError = err;
        // 已经发出音频后失败不能换 provider 重放（会造成重复播放），直接抛给 pipeline
        if (yielded > 0) throw err;
        log(`[tts] ${inst.name} 流式失败，尝试下一个 provider：${err?.message ?? err}`);
      }
    }
    throw providerError();
  }

  return {
    name: primary.name,
    providers: instances.map((i) => i.name),
    sampleRate: primary.sampleRate,
    synthesize,
    synthesizeStream,
    listVoices: (...args) => primary.listVoices(...args),
    cloneVoice: (...args) => {
      if (typeof primary.cloneVoice !== 'function') {
        throw ttsError(`主 provider ${primary.name} 不支持 cloneVoice`, { code: 'clone_unsupported' });
      }
      return primary.cloneVoice(...args);
    },
    // v0.2：链上所有 provider 并发预热（各自失败不致命），主 provider 优先
    async warmup() {
      const results = await Promise.all(
        instances.map((inst) =>
          typeof inst.warmup === 'function'
            ? inst.warmup().catch((err) => ({ ok: false, provider: inst.name, error: String(err?.message ?? err) }))
            : Promise.resolve({ ok: true, provider: inst.name, noop: true })
        )
      );
      return { ok: Boolean(results[0]?.ok), primary: results[0] ?? null, providers: results };
    },
    stats() {
      return {
        name: primary.name,
        providers: instances.map((inst) => (typeof inst.stats === 'function' ? inst.stats() : { name: inst.name })),
      };
    },
    clearCache() {
      for (const inst of instances) {
        try {
          inst.clearCache?.();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// MiniMax t2a_v2
// ---------------------------------------------------------------------------

function minimaxHint(code) {
  switch (Number(code)) {
    case 1002:
      return '触发限流，稍后重试或降低并发';
    case 1004:
      return '鉴权失败，检查 ~/.sayless/config.json 的 providers.minimax.apiKey';
    case 1008:
      return '账户额度不足，充值或把 tts.provider 改为 macos-say 兜底';
    case 2013:
      return '请求参数不合法，检查 tts.model / voiceId / 文本长度';
    case 2061:
      return '当前 Token Plan 不支持该模型（voice_clone），已降级为预设音色；升级套餐后可启用克隆';
    default:
      return code ? `MiniMax 错误码 ${code}：检查 MiniMax 控制台与文档` : '';
  }
}

function assertBaseResp(json, scope) {
  const br = json?.base_resp;
  const code = Number(br?.status_code ?? 0);
  if (Number.isFinite(code) && code !== 0) {
    throw ttsError(`${scope} 失败：${br?.status_msg || 'unknown error'} (base_resp.status_code=${code})`, {
      provider: 'minimax',
      code,
      hint: minimaxHint(code),
    });
  }
}

/** MiniMax 音频字段是 hex（不是 base64）；容忍首尾空白，拒绝奇数长度/非法字符 */
function decodeAudioHex(hex, scope) {
  if (typeof hex !== 'string' || hex.length === 0) return Buffer.alloc(0);
  const clean = hex.trim();
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw ttsError(`${scope}：data.audio 不是合法 hex（长度=${clean.length}），可能是 base64 或接口协议变更`, {
      provider: 'minimax',
      code: 'bad_audio_hex',
    });
  }
  return Buffer.from(clean, 'hex');
}

function inferGender(voiceId) {
  const id = String(voiceId ?? '').toLowerCase();
  if (id.includes('female') || id.includes('woman') || id.includes('girl')) return 'female';
  if (id.includes('male') || id.includes('man') || id.includes('boy')) return 'male';
  return 'unknown';
}

function dedupeVoices(list) {
  const seen = new Set();
  const out = [];
  for (const v of list) {
    if (!v?.id || seen.has(v.id)) continue;
    seen.add(v.id);
    out.push(v);
  }
  return out;
}

/**
 * 逐事件解析 SSE（text/event-stream）。
 * MiniMax 每个事件是单行 `data: {...}`，事件之间空行分隔；这里按标准 SSE 处理，
 * 兼容跨 TCP chunk 的半个 JSON、CRLF、末尾无空行、`data: [DONE]`。
 */
async function* parseSseJson(body) {
  if (!body) throw ttsError('响应没有 body，无法流式读取', { provider: 'minimax', code: 'no_stream_body' });
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines = [];
  let finished = false;

  const takeEvent = () => {
    if (dataLines.length === 0) return null;
    const rawData = dataLines.join('\n').trim();
    dataLines = [];
    if (!rawData) return null;
    if (rawData === '[DONE]') return 'done';
    try {
      return JSON.parse(rawData);
    } catch {
      return null;
    }
  };

  const consumeLine = (line) => {
    // 返回 'event' | 'done' | null
    if (line === '') {
      const evt = takeEvent();
      if (evt === 'done') return 'done';
      return evt ?? null;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    return null;
  };

  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const evt = consumeLine(line);
      if (evt === 'done') {
        finished = true;
        break;
      }
      if (evt) yield evt;
    }
    if (finished) return;
  }
  // 收尾：flush 解码器 + 处理最后一行/最后事件
  buffer += decoder.decode();
  if (buffer) {
    const evt = consumeLine(buffer.replace(/\r$/, ''));
    if (evt === 'done') return;
    if (evt) yield evt;
  }
  const last = takeEvent();
  if (last && last !== 'done') yield last;
}

function createMinimaxTts({ config = {}, log = () => {}, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw ttsError('fetchImpl 不可用（Node >= 22 应自带全局 fetch）', { provider: 'minimax', code: 'no_fetch' });
  }
  const ttsCfg = config?.tts ?? {};
  const provider = resolveProvider(config, 'minimax');
  if (!provider.apiKey) {
    throw ttsError(
      '缺少 MiniMax apiKey：检查 ~/.sayless/config.json 的 providers.minimax.apiKey 或环境变量 LIVEDUB_PROVIDER_MINIMAX_API_KEY；' +
        '无 Key 时可把 config.tts.provider 改为 macos-say 兜底',
      { provider: 'minimax', code: 'missing_api_key' }
    );
  }

  const baseUrl = provider.baseUrl;
  const t2aPath = provider.ttsChatPath || '/t2a_v2';
  const model = String(ttsCfg.model || 'speech-2.8-hd');
  const requestedSampleRate = positiveInt(ttsCfg.sampleRate, 24000);
  const defaultVoiceId = String(ttsCfg.presetVoices?.default || 'male-qn-qingse');
  const defaultSpeed = clampSpeed(ttsCfg.speed ?? 1);
  const timeoutMs = positiveInt(ttsCfg.timeoutMs, provider.timeoutMs || 20000);
  const cloneCfg = ttsCfg.clone ?? {};
  const cloneTimeoutMs = Math.max(timeoutMs, positiveInt(cloneCfg?.timeoutMs, 60000));
  const authHeaders = { Authorization: `Bearer ${provider.apiKey}` };

  async function readJson(res, scope) {
    let text;
    try {
      text = await res.text();
    } catch (err) {
      throw ttsError(`${scope}：读取响应失败：${err?.message ?? err}`, { provider: 'minimax', code: 'read_failed', cause: err });
    }
    const httpOk = res.ok !== false && !(typeof res.status === 'number' && res.status >= 400);
    if (!httpOk) {
      throw ttsError(`${scope}：HTTP ${res.status} ${String(text).slice(0, 200)}`.trim(), {
        provider: 'minimax',
        code: `http_${res.status}`,
      });
    }
    try {
      return JSON.parse(text);
    } catch {
      throw ttsError(`${scope}：响应不是合法 JSON（HTTP ${res.status}）：${String(text).slice(0, 200)}`, {
        provider: 'minimax',
        code: 'bad_json',
      });
    }
  }

  /**
   * 底层请求：统一超时/取消/网络错误文案。
   * keepOpen=true 用于流式响应：fetch 只解析到响应头就返回，但「外部 signal -> 内部 controller」
   * 的桥接与超时计时器必须保持到 body 读完，否则流中途 stall / 会话 close 时无法真正中断。
   * 调用方在 finally 里执行 res.__livedubCleanup?.() 释放。
   */
  async function requestRaw(url, { method = 'POST', headers = {}, body, signal, timeout, keepOpen = false } = {}) {
    const tmo = positiveInt(timeout, timeoutMs);
    const controller = new AbortController();
    let timedOut = false;
    let handedOff = false;
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, tmo);
    timer.unref?.();
    const onAbort = () => {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    };
    if (signal) {
      if (signal.aborted) {
        cleanup();
        throw abortError();
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const res = await fetchImpl(url, { method, headers, body, signal: controller.signal });
      if (keepOpen && res && typeof res === 'object') {
        handedOff = true;
        try {
          res.__livedubCleanup = cleanup;
        } catch {
          /* 某些 Response 实现是 frozen 的，退化为立即清理 */
          cleanup();
        }
        return res;
      }
      return res;
    } catch (err) {
      if (timedOut) {
        throw ttsError(`请求超时（>${tmo}ms）：${url}；检查网络/代理，或调大 config.tts.timeoutMs`, {
          provider: 'minimax',
          code: 'timeout',
          cause: err,
        });
      }
      if (signal?.aborted || isAbortLike(err)) throw abortError();
      throw ttsError(`网络请求失败：${err?.message ?? err}（baseUrl=${baseUrl}；检查网络/代理/证书）`, {
        provider: 'minimax',
        code: 'network',
        cause: err,
      });
    } finally {
      if (!handedOff) cleanup();
    }
  }

  async function postJson(apiPath, payload, opts = {}) {
    const url = /^https?:\/\//.test(apiPath) ? apiPath : `${baseUrl}${apiPath}`;
    const res = await requestRaw(url, {
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify(payload),
      signal: opts.signal,
      timeout: opts.timeout,
    });
    const json = await readJson(res, opts.label || 'minimax');
    assertBaseResp(json, opts.label || 'minimax');
    return json;
  }

  function buildT2aBody({ text, stream, voiceId, speed }) {
    return {
      model,
      text,
      stream: Boolean(stream),
      voice_setting: {
        voice_id: String(voiceId || defaultVoiceId),
        speed: clampSpeed(speed ?? defaultSpeed),
        vol: 1,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: requestedSampleRate,
        format: 'pcm',
        channel: 1,
      },
      language_boost: 'auto',
    };
  }

  async function synthesize({ text, voiceId, speed, signal } = {}) {
    const clean = normalizeText(text);
    const payload = buildT2aBody({ text: clean, stream: false, voiceId, speed });
    const started = Date.now();
    const json = await postJson(t2aPath, payload, { signal, label: 'minimax synthesize' });
    const pcm = decodeAudioHex(json?.data?.audio, 'minimax synthesize');
    if (pcm.length === 0) {
      throw ttsError('返回音频为空（data.audio 为空）：检查文本/音色，或稍后重试', { provider: 'minimax', code: 'empty_audio' });
    }
    const sampleRate = positiveInt(json?.extra_info?.audio_sample_rate, requestedSampleRate);
    const durationMs = pcmDurationMs(pcm, sampleRate);
    log(`[tts:minimax] synthesize ${clean.length} 字 -> ${durationMs}ms@${sampleRate}Hz（HTTP ${Date.now() - started}ms）`);
    return { pcm, sampleRate, format: 's16le', durationMs, voiceId: String(voiceId || defaultVoiceId) };
  }

  async function* synthesizeStream({ text, voiceId, speed, signal } = {}) {
    const clean = normalizeText(text);
    const payload = buildT2aBody({ text: clean, stream: true, voiceId, speed });
    const started = Date.now();
    let yielded = 0;
    let firstChunkMs = null;
    let streamRes = null;
    try {
      const res = await requestRaw(`${baseUrl}${t2aPath}`, {
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(payload),
        signal,
        timeout: timeoutMs,
        keepOpen: true,
      });
      streamRes = res;
      if (res.ok === false || (typeof res.status === 'number' && res.status >= 400)) {
        let detail = '';
        try {
          detail = String(await res.text()).slice(0, 200);
        } catch {
          /* ignore */
        }
        throw ttsError(`流式请求 HTTP ${res.status} ${detail}`.trim(), {
          provider: 'minimax',
          code: `http_${res.status}`,
        });
      }
      if (!res.body) throw ttsError('流式响应缺少 body', { provider: 'minimax', code: 'no_stream_body' });

      for await (const event of parseSseJson(res.body)) {
        if (signal?.aborted) throw abortError();
        const status = Number(event?.data?.status);
        const br = event?.base_resp;
        if (br && Number(br.status_code) !== 0) {
          throw ttsError(`流式返回错误：${br.status_msg || 'unknown'} (base_resp.status_code=${br.status_code})`, {
            provider: 'minimax',
            code: br.status_code,
            hint: minimaxHint(br.status_code),
          });
        }
        const rawAudio = event?.data?.audio;
        if (typeof rawAudio === 'string' && rawAudio.length > 0) {
          const pcm = decodeAudioHex(rawAudio, 'minimax stream');
          if (status === 2) {
            // 实测（2026-10-29）：结束包 status=2 携带的是「整段音频」，增量块已经逐块 yield，
            // 这里跳过，避免把整段音频重复播放一遍。若服务端某天只给结束包，则兜底 yield 一次。
            if (yielded === 0 && pcm.length > 0) {
              if (firstChunkMs == null) firstChunkMs = Date.now() - started;
              yield { pcm, sampleRate: requestedSampleRate, format: 's16le', durationMs: pcmDurationMs(pcm, requestedSampleRate) };
              yielded += 1;
            } else if (pcm.length > 0) {
              log(`[tts:minimax] 流式结束包为全量音频（${pcm.length}B），已逐块输出，跳过避免重复`);
            }
          } else if (pcm.length > 0) {
            if (firstChunkMs == null) firstChunkMs = Date.now() - started;
            yield { pcm, sampleRate: requestedSampleRate, format: 's16le', durationMs: pcmDurationMs(pcm, requestedSampleRate) };
            yielded += 1;
          }
        }
        if (status === 2) break;
      }
      if (yielded === 0) throw ttsError('流式响应没有任何音频块（SSE 协议可能变更）', { provider: 'minimax', code: 'empty_stream' });
      log(`[tts:minimax] stream ${clean.length} 字：首包 ${firstChunkMs}ms，共 ${yielded} 块`);
    } catch (err) {
      if (isAbortLike(err) || signal?.aborted) throw abortError();
      if (yielded > 0) throw err; // 已经发出音频，不能整段重放（由 pipeline 决定降级/跳过）
      log(`[tts:minimax] 流式失败，自动回退非流式：${err?.message ?? err}`);
      const full = await synthesize({ text: clean, voiceId, speed, signal });
      yield { pcm: full.pcm, sampleRate: full.sampleRate, format: 's16le', durationMs: full.durationMs };
    } finally {
      // 流式 body 读完后释放 abort 桥接与超时计时器
      try {
        streamRes?.__livedubCleanup?.();
      } catch {
        /* ignore */
      }
    }
  }

  let voicesInFlight = null;

  function staticVoices() {
    const ids = new Set([
      defaultVoiceId,
      'male-qn-qingse',
      'female-shaonv',
      'male-qn-jingying',
      'female-tianmei',
      'presenter_male',
      'presenter_female',
    ]);
    for (const v of Object.values(ttsCfg.presetVoices ?? {})) {
      if (typeof v === 'string' && v) ids.add(v);
    }
    return [...ids].map((id) => ({ id, label: id, gender: inferGender(id), cloned: false }));
  }

  /** 真请求 get_voice（失败会 throw，由调用方决定回退） */
  async function fetchVoicesStrict() {
    const json = await postJson('/get_voice', { voice_type: 'all' }, { timeout: Math.min(timeoutMs, 15000), label: 'minimax listVoices' });
    const system = Array.isArray(json?.system_voice) ? json.system_voice : [];
    const cloning = Array.isArray(json?.voice_cloning) ? json.voice_cloning : [];
    const list = [];
    for (const v of system) {
      if (!v?.voice_id) continue;
      list.push({ id: v.voice_id, label: v.voice_name || v.voice_id, gender: inferGender(v.voice_id), cloned: false });
    }
    for (const v of cloning) {
      if (!v?.voice_id) continue;
      list.push({ id: v.voice_id, label: v.voice_name || `克隆音色 ${v.voice_id}`, gender: inferGender(v.voice_id), cloned: true });
    }
    if (list.length === 0) throw ttsError('get_voice 返回空列表', { provider: 'minimax', code: 'empty_voice_list' });
    log(`[tts:minimax] listVoices: ${list.length} 个（system=${system.length} cloned=${cloning.length}）`);
    return dedupeVoices(list);
  }

  async function listVoices() {
    if (voicesInFlight) return voicesInFlight;
    voicesInFlight = fetchVoicesStrict()
      .catch((err) => {
        log(`[tts:minimax] listVoices 失败，回退静态预设列表：${err?.message ?? err}`);
        return staticVoices();
      })
      .finally(() => {
        voicesInFlight = null;
      });
    return voicesInFlight;
  }

  /**
   * v0.2 预热：一次轻量 get_voice（不计 TTS 字符），顺带建立/复用 HTTP 连接（keep-alive），
   * 让会话里第一条 synthesizeStream 少一次 DNS/TLS/连接建立；同时把音色列表交给 wrapper 的 TTL 缓存。
   */
  async function warmup() {
    const started = Date.now();
    const voices = await fetchVoicesStrict();
    const elapsedMs = Date.now() - started;
    log(`[tts:minimax] warmup: get_voice ok ${elapsedMs}ms（${voices.length} 个音色）`);
    return { ok: true, provider: 'minimax', elapsedMs, voices };
  }

  function buildVoiceId(name) {
    const base = String(name ?? 'livedub')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 16);
    const rand = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    let id = `${base || 'livedub'}${rand}`;
    if (!/^[a-z]/.test(id)) id = `v${id}`;
    return id.slice(0, 64);
  }

  async function cloneVoice({ pcm, sampleRate: sr, name = 'session-speaker', signal } = {}) {
    if (!Buffer.isBuffer(pcm) || pcm.length < 2) {
      throw ttsError('cloneVoice 需要非空 s16le PCM 样本', { provider: 'minimax', code: 'bad_sample' });
    }
    const rate = positiveInt(sr, 16000);
    const durationSec = pcm.length / 2 / rate;
    if (durationSec < 9.8) {
      throw ttsError(`样本过短：${durationSec.toFixed(1)}s，MiniMax 声音克隆要求 10s-5min；继续累积讲师语音（tts.clone.minSampleSec）`, {
        provider: 'minimax',
        code: 'sample_too_short',
      });
    }
    if (durationSec > 305) {
      throw ttsError(`样本过长：${durationSec.toFixed(0)}s，MiniMax 声音克隆上限 5min；截取一部分再试`, {
        provider: 'minimax',
        code: 'sample_too_long',
      });
    }

    // 1) 上传样本（WAV，purpose=voice_clone）
    const wav = wavFromPcm(pcm, rate);
    const form = new FormData();
    form.set('purpose', 'voice_clone');
    form.set('file', new Blob([wav], { type: 'audio/wav' }), 'livedub-voice-sample.wav');
    const uploadRes = await requestRaw(`${baseUrl}/files/upload`, {
      headers: { ...authHeaders },
      body: form,
      signal,
      timeout: cloneTimeoutMs,
    });
    const uploadJson = await readJson(uploadRes, 'minimax 文件上传');
    assertBaseResp(uploadJson, 'minimax 文件上传');
    const fileId = uploadJson?.file?.file_id ?? uploadJson?.file_id ?? uploadJson?.file?.id;
    if (fileId == null || fileId === '') {
      throw ttsError('文件上传成功但响应缺少 file_id（MiniMax 协议可能变更）', { provider: 'minimax', code: 'missing_file_id' });
    }

    // 2) 克隆（当前 Token Plan 会返回 base_resp.status_code=2061，由 voice manager 捕获降级）
    const voiceId = buildVoiceId(name);
    const cloneJson = await postJson('/voice_clone', { file_id: fileId, voice_id: voiceId }, { signal, timeout: cloneTimeoutMs, label: 'minimax voice_clone' });
    assertBaseResp(cloneJson, 'minimax voice_clone');
    const finalVoiceId = String(cloneJson?.voice_id || voiceId);
    log(`[tts:minimax] voice clone 成功：${finalVoiceId}（样本 ${durationSec.toFixed(1)}s@${rate}Hz）`);
    return { voiceId: finalVoiceId, mode: 'clone', provider: 'minimax', name };
  }

  return {
    name: 'minimax',
    sampleRate: requestedSampleRate,
    synthesize,
    synthesizeStream,
    listVoices,
    cloneVoice,
    warmup,
  };
}

// ---------------------------------------------------------------------------
// 火山引擎（豆包语音）TTS v3 + 声音复刻 v3
// ---------------------------------------------------------------------------
//
// 参考 API（2026-10，豆包语音控制台 UUID Key）：
//   TTS  : POST {baseUrl}/api/v3/tts/unidirectional
//          headers: X-Api-Key / X-Api-Resource-Id / X-Api-Request-Id
//          body   : { req_params: { text, speaker, audio_params: { format:'pcm', sample_rate:24000 } } }
//          响应   : 逐行 JSON { code, message, data }，data 是 base64 音频块，拼接解码即 PCM。
//   复刻 : POST {baseUrl}/api/v3/tts/voice_clone
//          body   : { speaker_id, audio:{data:<base64 WAV>,format:'wav'}, text?, language:1, extra_params{...} }
//          响应   : { code, message, status, speaker_id }，status 2/4 可用、1 训练中。
//
// 凭据：豆包语音控制台 → API Key 管理 的 UUID Key（不是方舟 ark- Key）。
//       providers.volcengine.apiKey / ~/.sayless providers.volcengine /
//       env VOLCENGINE_SPEECH_API_KEY | ARS_SPEECH_API_KEY | ARK_SPEECH_API_KEY。

const VOLC_DEFAULT_BASE_URL = 'https://openspeech.bytedance.com';
const VOLC_TTS_PATH = '/api/v3/tts/unidirectional';
const VOLC_CLONE_PATH = '/api/v3/tts/voice_clone';
const VOLC_CLONE_STATUS_PATH = '/api/v3/tts/voice_clone';
const VOLC_MAX_CLONE_AUDIO_BYTES = 10 * 1024 * 1024; // 声音复刻音频 <= 10MB
const VOLC_SPEECH_KEY_ENVS = Object.freeze(['VOLCENGINE_SPEECH_API_KEY', 'ARS_SPEECH_API_KEY', 'ARK_SPEECH_API_KEY']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 示例公版音色（以控制台实际列表为准；配置 tts.volcengine.voices 可覆盖/追加） */
const VOLC_STATIC_VOICES = Object.freeze([
  { id: 'zh_male_wennuanahu_moon_bigtts', label: '温暖阿虎（公版中文男声）', gender: 'male' },
  { id: 'zh_male_shaonianzixin_moon_bigtts', label: '少年梓辛（公版中文男声）', gender: 'male' },
  { id: 'zh_female_shuangkuaisisi_moon_bigtts', label: '爽快思思（公版中文女声）', gender: 'female' },
  { id: 'zh_female_wanwanxiaohe_moon_bigtts', label: '湾湾小何（公版中文女声）', gender: 'female' },
  { id: 'en_male_adam_mars_bigtts', label: 'Adam（公版英文男声）', gender: 'male' },
]);

/** 火山语音错误码 -> 可操作提示 */
function volcHint(code) {
  switch (Number(code)) {
    case 45000010:
      return 'X-Api-Key 无效：到火山「豆包语音」控制台 → API Key 管理 重新创建 UUID Key（不是方舟 ark- Key）';
    case 45000030:
      return 'Key 没有 openspeech 权限或服务未开通：确认使用豆包语音控制台 UUID Key，并在控制台开通「语音合成大模型 / 声音复刻」';
    case 55000000:
      return 'speaker 与 X-Api-Resource-Id 不匹配：S_ 复刻音色需 seed-icl-2.0；公版音色用 volc.service_type.10029；检查 voiceId 与音色类型';
    case 45000002:
      return '请求参数不合法：检查 text / speaker / audio_params（pcm 24k mono）';
    case 45000003:
      return '文本过长或含非法字符：用 splitForTts() 切块后逐段合成';
    case 45100000:
      return '账户欠费或资源包用尽：到豆包语音控制台充值/购买语音合成资源包';
    default:
      return code ? `火山语音错误码 ${code}：对照控制台「错误码」文档检查 Key / 资源 / 参数` : '';
  }
}

function volcError(scope, code, message) {
  return ttsError(`${scope}失败：${message || 'unknown error'}（code=${code}）`, {
    provider: 'volcengine',
    code,
    hint: volcHint(code),
  });
}

/** 解析火山语音配置（config.mjs 已内置 providers.volcengine baseUrl；env 支持多种 Key 变量名） */
function resolveVolcengineConfig(config, env = process.env) {
  const ttsCfg = config?.tts ?? {};
  const volcCfg = ttsCfg?.volcengine ?? {};
  let resolved = null;
  try {
    resolved = resolveProvider(config, 'volcengine', env);
  } catch {
    resolved = null;
  }
  const envKey = VOLC_SPEECH_KEY_ENVS.map((name) => env?.[name]).find((v) => typeof v === 'string' && v.trim()) ?? '';
  return {
    apiKey: String(envKey || resolved?.apiKey || '').trim(),
    baseUrl: String(volcCfg.baseUrl || resolved?.baseUrl || VOLC_DEFAULT_BASE_URL).replace(/\/+$/, ''),
    sampleRate: positiveInt(volcCfg.sampleRate, positiveInt(ttsCfg.sampleRate, 24000)),
    timeoutMs: positiveInt(volcCfg.timeoutMs, positiveInt(ttsCfg.timeoutMs, 30000)),
    cloneTimeoutMs: positiveInt(volcCfg.cloneTimeoutMs, Math.max(60000, positiveInt(ttsCfg.timeoutMs, 30000))),
    resourceId: typeof volcCfg.resourceId === 'string' && volcCfg.resourceId.trim() ? volcCfg.resourceId.trim() : '',
    cloneStatusPath: typeof volcCfg.cloneStatusPath === 'string' && volcCfg.cloneStatusPath ? volcCfg.cloneStatusPath : VOLC_CLONE_STATUS_PATH,
  };
}

/** UUID Key 校验：缺 Key / ark- Key / 非 UUID 都给出开通步骤提示（绝不打印 Key 内容） */
function assertVolcSpeechKey(apiKey) {
  if (!apiKey) {
    throw ttsError('缺少火山引擎（豆包语音）API Key', {
      provider: 'volcengine',
      code: 'missing_api_key',
      hint:
        '开通步骤：火山引擎控制台 → 豆包语音（语音技术）→ 开通「语音合成大模型 / 声音复刻」→ API Key 管理创建 UUID Key；' +
        '然后配置 providers.volcengine.apiKey 或环境变量 VOLCENGINE_SPEECH_API_KEY（方舟 ark- Key 不能用于 openspeech）',
    });
  }
  if (/^ark[-_]/i.test(apiKey)) {
    throw ttsError('检测到 ark- 开头的火山方舟 Key：它不能调用豆包语音 openspeech（没有语音权限，会 401 / 45000030）', {
      provider: 'volcengine',
      code: 'ark_key_not_supported',
      hint: '到豆包语音控制台 → API Key 管理 创建 UUID Key，配置 providers.volcengine.apiKey 或 VOLCENGINE_SPEECH_API_KEY',
    });
  }
  if (!UUID_RE.test(apiKey)) {
    throw ttsError(`X-Api-Key 格式不正确：豆包语音控制台 Key 应为 UUID（xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx），当前长度 ${apiKey.length}`, {
      provider: 'volcengine',
      code: 'bad_api_key_format',
      hint: '不要用方舟 ark- Key；到豆包语音控制台复制 UUID Key（8-4-4-4-12）',
    });
  }
}

/** 按音色类型推断 X-Api-Resource-Id（config 可覆盖） */
function volcResourceIdFor(voiceId, override = '') {
  if (override) return override;
  const id = String(voiceId ?? '');
  if (id.startsWith('S_')) return 'seed-icl-2.0'; // 复刻/自定义音色
  if (id.includes('uranus')) return 'seed-tts-2.0';
  return 'volc.service_type.10029';
}

function buildVolcSpeakerId(voiceId) {
  if (voiceId != null) {
    const id = String(voiceId).trim();
    if (id) {
      if (!/^S_[A-Za-z0-9_]{1,200}$/.test(id)) {
        throw ttsError(`speaker_id 非法（复刻音色 ID 必须以 S_ 开头，可用字母/数字/下划线）：${id.slice(0, 40)}`, {
          provider: 'volcengine',
          code: 'bad_speaker_id',
          hint: '不传 voiceId 时引擎会自动生成 S_ 唯一 ID；显式指定时用控制台返回的 S_xxx',
        });
      }
      return id;
    }
  }
  return `S_livedub${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 8)}`.slice(0, 200);
}

/** 逐行解析火山语音 JSON 响应（也容忍 SSE data: 前缀与 
） */
async function* parseVolcJsonLines(body) {
  if (!body) throw ttsError('火山语音响应没有 body', { provider: 'volcengine', code: 'no_stream_body' });
  const decoder = new TextDecoder();
  let buffer = '';
  const parseLine = (line) => {
    let text = String(line).trim();
    if (!text) return null;
    if (text.startsWith('data:')) text = text.slice(5).trim();
    if (!text || text === '[DONE]') return null;
    try {
      return JSON.parse(text);
    } catch {
      return null; // 忽略心跳/非 JSON 行（例如空行、注释）
    }
  };
  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const json = parseLine(line);
      if (json) yield json;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const json = parseLine(buffer);
    if (json) yield json;
  }
}

function createVolcengineTts({ config = {}, log = () => {}, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw ttsError('fetchImpl 不可用（Node >= 22 应自带全局 fetch）', { provider: 'volcengine', code: 'no_fetch' });
  }
  const ttsCfg = config?.tts ?? {};
  const volcCfg = ttsCfg.volcengine ?? {};
  const cloneCfg = ttsCfg.clone ?? {};
  const info = resolveVolcengineConfig(config);
  assertVolcSpeechKey(info.apiKey); // 创建期 fail-fast（fallback 链会捕获并跳过）
  const sampleRate = info.sampleRate;
  const timeoutMs = info.timeoutMs;
  const cloneTimeoutMs = info.cloneTimeoutMs;
  const defaultVoice = String(volcCfg.defaultVoice || ttsCfg.presetVoices?.default || '').trim();
  const cloneExtraParams =
    volcCfg.cloneExtraParams && typeof volcCfg.cloneExtraParams === 'object' ? { ...volcCfg.cloneExtraParams } : {};
  if (typeof volcCfg.cloneDemoText === 'string' && volcCfg.cloneDemoText.trim()) {
    cloneExtraParams.demo_text = volcCfg.cloneDemoText.trim();
  }

  function authHeaders(resourceIdForVoice) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Api-Key': info.apiKey, // 只在内存里用；日志永不打印
      'X-Api-Request-Id': randomUUID(),
    };
    const resourceId = resourceIdForVoice != null ? volcResourceIdFor(resourceIdForVoice, info.resourceId) : '';
    if (resourceId) headers['X-Api-Resource-Id'] = resourceId;
    return headers;
  }

  async function safeText(res) {
    try {
      return String(await res.text()).slice(0, 400);
    } catch {
      return '';
    }
  }

  async function readJsonBody(res, scope) {
    let text;
    try {
      text = await res.text();
    } catch (err) {
      throw ttsError(`${scope}：读取响应失败：${err?.message ?? err}`, { provider: 'volcengine', code: 'read_failed', cause: err });
    }
    try {
      return JSON.parse(text);
    } catch {
      throw ttsError(`${scope}：响应不是合法 JSON（HTTP ${res.status}）：${String(text).slice(0, 200)}`, {
        provider: 'volcengine',
        code: 'bad_json',
      });
    }
  }

  async function assertHttpOk(res, scope) {
    const httpOk = res.ok !== false && !(typeof res.status === 'number' && res.status >= 400);
    if (httpOk) return;
    const detail = await safeText(res);
    if (res.status === 401 || res.status === 403) {
      throw ttsError(`${scope}鉴权失败（HTTP ${res.status}）：X-Api-Key 无效或没有语音权限${detail ? `：${detail.slice(0, 200)}` : ''}`, {
        provider: 'volcengine',
        code: res.status,
        hint: '到豆包语音控制台 → API Key 管理 创建 UUID Key，并确认已开通「语音合成大模型 / 声音复刻」；方舟 ark- Key 不可用',
      });
    }
    throw ttsError(`${scope} HTTP ${res.status}${detail ? `：${detail.slice(0, 200)}` : ''}`, {
      provider: 'volcengine',
      code: `http_${res.status}`,
      hint: '检查网络/网关，或到豆包语音控制台确认服务状态',
    });
  }

  /** 底层 fetch（统一超时/取消/网络错误；流式响应 keepOpen 保持 abort 桥接到 body 读完） */
  async function request(url, { method = 'POST', headers = {}, body, signal, timeout, keepOpen = false } = {}) {
    const tmo = positiveInt(timeout, timeoutMs);
    const controller = new AbortController();
    let timedOut = false;
    let handedOff = false;
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, tmo);
    timer.unref?.();
    const onAbort = () => {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    };
    if (signal) {
      if (signal.aborted) {
        cleanup();
        throw abortError();
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const res = await fetchImpl(url, { method, headers, body, signal: controller.signal });
      if (keepOpen && res && typeof res === 'object') {
        handedOff = true;
        try {
          res.__livedubCleanup = cleanup;
        } catch {
          cleanup();
        }
        return res;
      }
      return res;
    } catch (err) {
      if (timedOut) {
        throw ttsError(`火山语音请求超时（>${tmo}ms）：${url}`, { provider: 'volcengine', code: 'timeout', cause: err });
      }
      if (signal?.aborted || isAbortLike(err)) throw abortError();
      throw ttsError(`火山语音网络请求失败：${err?.message ?? err}（${url}）`, {
        provider: 'volcengine',
        code: 'network',
        cause: err,
      });
    } finally {
      if (!handedOff) cleanup();
    }
  }

  async function* synthesizeStream({ text, voiceId, speed, signal } = {}) {
    const clean = normalizeText(text);
    const speaker = String(voiceId || defaultVoice || '').trim();
    if (!speaker) {
      throw ttsError('缺少音色 ID（speaker）：配置 tts.presetVoices.default 或 tts.volcengine.defaultVoice（S_ 开头为复刻音色）', {
        provider: 'volcengine',
        code: 'missing_speaker',
        hint: '公版音色可填控制台音色名；复刻音色用 S_xxx。TTS v3 不消费 speed 参数，语速用音色/后处理控制',
      });
    }
    if (signal?.aborted) throw abortError();
    const payload = {
      req_params: {
        text: clean,
        speaker,
        audio_params: { format: 'pcm', sample_rate: sampleRate },
      },
    };
    const started = Date.now();
    const res = await request(`${info.baseUrl}${VOLC_TTS_PATH}`, {
      headers: authHeaders(speaker),
      body: JSON.stringify(payload),
      signal,
      timeout: timeoutMs,
      keepOpen: true,
    });
    try {
      await assertHttpOk(res, '火山语音 TTS ');
      let yielded = 0;
      let firstChunkMs = null;
      for await (const event of parseVolcJsonLines(res.body)) {
        if (signal?.aborted) throw abortError();
        // 有的错误响应把 code/message 嵌在 header 里（实测 HTTP 401 body: {"header":{"code":45000010}}）
        const code = Number(event?.code ?? event?.header?.code ?? 0);
        if (code !== 0) throw volcError('火山语音 TTS ', code, event?.message ?? event?.header?.message);
        const data = event?.data;
        if (typeof data === 'string' && data.length > 0) {
          const pcm = Buffer.from(data, 'base64');
          if (pcm.length === 0) continue;
          if (firstChunkMs == null) firstChunkMs = Date.now() - started;
          yielded += 1;
          yield { pcm, sampleRate, format: 's16le', durationMs: pcmDurationMs(pcm, sampleRate) };
        }
      }
      if (yielded === 0) {
        throw ttsError('火山语音返回了 0 字节音频：检查 speaker（音色是否存在/已训练完成）与 text', {
          provider: 'volcengine',
          code: 'empty_audio',
        });
      }
      log(`[tts:volcengine] stream ${clean.length} 字：首包 ${firstChunkMs}ms，共 ${yielded} 块`);
    } finally {
      try {
        res?.__livedubCleanup?.();
      } catch {
        /* ignore */
      }
    }
  }

  async function synthesize(opts = {}) {
    const chunks = [];
    let rate = sampleRate;
    for await (const chunk of synthesizeStream(opts)) {
      chunks.push(chunk.pcm);
      rate = chunk.sampleRate;
    }
    const pcm = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    if (pcm.length === 0) throw ttsError('火山语音合成结果为空', { provider: 'volcengine', code: 'empty_audio' });
    const durationMs = pcmDurationMs(pcm, rate);
    const voiceId = String(opts?.voiceId || defaultVoice || '').trim();
    log(`[tts:volcengine] synthesize ${pcmDurationMs(pcm, rate)}ms@${rate}Hz（${pcm.length}B）`);
    return { pcm, sampleRate: rate, format: 's16le', durationMs, voiceId };
  }

  async function cloneVoice({ pcm, sampleRate: sr, name = 'session-speaker', voiceId, signal } = {}) {
    if (!Buffer.isBuffer(pcm) || pcm.length < 2) {
      throw ttsError('cloneVoice 需要非空 s16le PCM 样本', { provider: 'volcengine', code: 'bad_sample' });
    }
    const rate = positiveInt(sr, 16000);
    const durationSec = pcm.length / 2 / rate;
    if (durationSec < 10) {
      throw ttsError(`声音复刻样本过短：${durationSec.toFixed(1)}s，火山 v3 要求 10s–5min；继续累积讲师语音（tts.clone.minSampleSec）`, {
        provider: 'volcengine',
        code: 'sample_too_short',
        hint: '默认 tts.clone.minSampleSec=12 已满足；若手动调小请保持 >=10s',
      });
    }
    const wav = wavFromPcm(pcm, rate);
    if (wav.length > VOLC_MAX_CLONE_AUDIO_BYTES) {
      throw ttsError(`声音复刻音频过大（${(wav.length / 1024 / 1024).toFixed(1)}MB > 10MB）：缩短样本（tts.clone.maxSampleSec）后重试`, {
        provider: 'volcengine',
        code: 'audio_too_large',
      });
    }
    const speakerId = buildVolcSpeakerId(voiceId);
    const body = {
      speaker_id: speakerId,
      audio: { data: wav.toString('base64'), format: 'wav' },
      language: 1,
      extra_params: { enable_audio_denoise: true, ...cloneExtraParams },
    };
    if (signal?.aborted) throw abortError();
    const res = await request(`${info.baseUrl}${VOLC_CLONE_PATH}`, {
      headers: authHeaders(), // 复刻只带 X-Api-Key + X-Api-Request-Id
      body: JSON.stringify(body),
      signal,
      timeout: cloneTimeoutMs,
    });
    await assertHttpOk(res, '火山语音声音复刻 ');
    const json = await readJsonBody(res, '火山语音声音复刻 ');
    const code = Number(json?.code ?? json?.header?.code ?? 0);
    if (code !== 0) throw volcError('火山语音声音复刻 ', code, json?.message ?? json?.header?.message);
    const status = Number(json?.status ?? 0);
    const finalVoiceId = String(json?.speaker_id || speakerId);
    if (status === 2 || status === 4) {
      log(`[tts:volcengine] 声音复刻成功：${finalVoiceId}（status=${status}，样本 ${(pcm.length / 2 / rate).toFixed(1)}s@${rate}Hz）`);
      return { voiceId: finalVoiceId, mode: 'clone', provider: 'volcengine', name, status };
    }
    if (status === 1) {
      throw ttsError(`声音复刻训练中（status=1）：音色 ${finalVoiceId} 尚未可用`, {
        provider: 'volcengine',
        code: 'voice_clone_training',
        hint: '训练通常需要几十秒到几分钟：稍后重试克隆或调用 tts.voiceCloneStatus(speakerId) 查询；本次会话会降级为预设音色',
      });
    }
    throw ttsError(`声音复刻失败（status=${status}）：${json?.message || 'unknown error'}`, {
      provider: 'volcengine',
      code: status !== 0 ? status : 'voice_clone_failed',
      hint: '检查样本质量（讲师人声、无背景音乐、10s 以上）与音频格式；重试仍失败请到控制台查看复刻任务',
    });
  }

  /** 尽力而为的状态查询：v3 状态接口未公开文档化，失败时返回 {ok:false} 而不抛 */
  async function voiceCloneStatus(speakerId, { signal } = {}) {
    const id = String(speakerId ?? '').trim();
    if (!id) return { ok: false, speakerId: null, error: 'speakerId required' };
    try {
      const url = `${info.baseUrl}${info.cloneStatusPath}?speaker_id=${encodeURIComponent(id)}`;
      const res = await request(url, { method: 'GET', headers: authHeaders(), signal, timeout: Math.min(timeoutMs, 15000) });
      const httpStatus = typeof res.status === 'number' ? res.status : 200;
      if (res.ok === false || httpStatus >= 400) {
        return { ok: false, speakerId: id, httpStatus, supported: false, error: `状态查询接口不可用（HTTP ${httpStatus}）` };
      }
      const json = await readJsonBody(res, '火山语音复刻状态 ');
      const code = Number(json?.code ?? 0);
      if (code !== 0) return { ok: false, speakerId: id, code, supported: false, error: json?.message || `code=${code}` };
      const rawStatus = Number(json?.status ?? NaN);
      const ready = rawStatus === 2 || rawStatus === 4;
      return {
        ok: ready,
        speakerId: String(json?.speaker_id || id),
        status: Number.isFinite(rawStatus) ? rawStatus : null,
        statusText: rawStatus === 1 ? 'training' : ready ? 'ready' : 'unknown',
        supported: true,
      };
    } catch (err) {
      return { ok: false, speakerId: id, supported: false, error: String(err?.message ?? err) };
    }
  }

  async function listVoices() {
    const out = [];
    const seen = new Set();
    const add = (item, clonedDefault = false) => {
      if (!item) return;
      const id = typeof item === 'string' ? item.trim() : String(item.id ?? item.voiceId ?? '').trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      const label =
        typeof item === 'object' && (item.label || item.name) ? String(item.label || item.name) : `${id}`;
      out.push({
        id,
        label,
        gender: (typeof item === 'object' && item.gender) || inferGender(id),
        cloned: typeof item === 'object' && item.cloned != null ? Boolean(item.cloned) : clonedDefault,
      });
    };
    for (const v of Array.isArray(volcCfg.voices) ? volcCfg.voices : []) add(v, false);
    for (const v of Array.isArray(volcCfg.clonedVoices) ? volcCfg.clonedVoices : []) add(v, true);
    for (const v of Array.isArray(cloneCfg.voices) ? cloneCfg.voices : []) add(v, true);
    for (const v of [ttsCfg.presetVoices?.default, ttsCfg.presetVoices?.male, ttsCfg.presetVoices?.female, ttsCfg.presetVoices?.narrator]) {
      if (typeof v === 'string' && /^(S_|zh_|en_)/.test(v)) add({ id: v, label: `预设音色 ${v}` }, false);
    }
    for (const v of VOLC_STATIC_VOICES) add(v, false);
    return out;
  }

  /** 预热：纯本地检查（不发请求，避免无意义 401/计费噪音） */
  async function warmup() {
    const started = Date.now();
    const resourceHint = info.resourceId || '按音色自动选择（S_→seed-icl-2.0 / uranus→seed-tts-2.0 / 其它→volc.service_type.10029）';
    log(`[tts:volcengine] warmup: 本地就绪（UUID Key 已配置；X-Api-Resource-Id ${resourceHint}）`);
    return { ok: true, provider: 'volcengine', elapsedMs: Date.now() - started, noop: true };
  }

  return {
    name: 'volcengine',
    sampleRate,
    synthesize,
    synthesizeStream,
    listVoices,
    cloneVoice,
    voiceCloneStatus,
    warmup,
  };
}

// ---------------------------------------------------------------------------
// macOS say（无 Key / 断网兜底）
// ---------------------------------------------------------------------------

/** 运行外部命令并收集 stderr；支持超时与 AbortSignal */
function runCommand(command, args, { timeoutMs = 20000, signal, provider = 'macos-say' } = {}) {
  return new Promise((resolve, reject) => {
    let child = null;
    let timer = null;
    let stderr = '';
    let settled = false;

    const onAbort = () => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(reject, abortError());
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    try {
      child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      finish(reject, ttsError(`无法启动 ${command}：${err?.message ?? err}`, { provider, code: 'spawn_failed', cause: err }));
      return;
    }
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(reject, ttsError(`${command} 执行超时（>${timeoutMs}ms）`, { provider, code: 'timeout' }));
    }, timeoutMs);
    timer.unref?.();

    child.stderr?.on('data', (d) => {
      stderr = (stderr + String(d)).slice(-4000);
    });
    child.on('error', (err) => {
      finish(
        reject,
        ttsError(`无法启动 ${command}：${err?.message ?? err}（确认 macOS 自带 ${command} 在 PATH 中）`, {
          provider,
          code: 'spawn_failed',
          cause: err,
        })
      );
    });
    child.on('close', (code) => {
      if (code === 0) finish(resolve, { stderr });
      else
        finish(
          reject,
          ttsError(`${command} 退出码 ${code}：${stderr.trim().slice(0, 300) || '（无 stderr）'}`, {
            provider,
            code: 'command_failed',
          })
        );
    });
  });
}

const MACOS_KNOWN_VOICES = Object.freeze([
  { id: 'Tingting', label: 'Tingting（中文女声）', gender: 'female' },
  { id: 'Meijia', label: 'Meijia（中文女声·台湾）', gender: 'female' },
  { id: 'Sinji', label: 'Sinji（中文女声·香港）', gender: 'female' },
  { id: 'Li-mu', label: 'Li-mu（中文男声）', gender: 'male' },
]);

function createMacosSayTts({ config = {}, log = () => {} } = {}) {
  const ttsCfg = config?.tts ?? {};
  const fallback = (Array.isArray(ttsCfg.fallbacks) ? ttsCfg.fallbacks : []).find((f) => f?.provider === 'macos-say');
  const voice = String(ttsCfg.macosSay?.voice || fallback?.voice || 'Tingting');
  const requestedSampleRate = positiveInt(ttsCfg.sampleRate, 24000);
  const timeoutMs = positiveInt(ttsCfg.macosSay?.timeoutMs, Math.max(12000, positiveInt(ttsCfg.timeoutMs, 20000)));
  // say -r 单位是「词/分」；中文按字近似。默认约 175，乘以语速倍率。
  const baseWpm = 175;

  async function synthesize({ text, speed, signal } = {}) {
    const clean = normalizeText(text);
    if (process.platform !== 'darwin') {
      throw ttsError(`macos-say 只能在 macOS 上使用（当前 ${process.platform}），请改用 minimax 或 mock`, {
        provider: 'macos-say',
        code: 'unsupported_platform',
      });
    }
    const wpm = Math.min(500, Math.max(80, Math.round(baseWpm * clampSpeed(speed ?? ttsCfg.speed ?? 1))));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'livedub-say-'));
    const aiffPath = path.join(dir, 'out.aiff');
    const pcmPath = path.join(dir, 'out.pcm');
    try {
      // say 不支持 --data-format（实测 "Opening output file failed: fmt?"），所以先 AIFF 再 ffmpeg 转 PCM。
      await runCommand('say', ['-v', voice, '-r', String(wpm), '-o', aiffPath, '--', clean], { timeoutMs, signal });
      await runCommand(
        'ffmpeg',
        ['-v', 'error', '-y', '-i', aiffPath, '-ac', '1', '-ar', String(requestedSampleRate), '-f', 's16le', '-acodec', 'pcm_s16le', pcmPath],
        { timeoutMs, signal }
      );
      let pcm;
      try {
        pcm = await fs.readFile(pcmPath);
      } catch (err) {
        throw ttsError(`ffmpeg 没有产出 PCM 文件：${err?.message ?? err}`, { provider: 'macos-say', code: 'no_output', cause: err });
      }
      if (pcm.length < 2) {
        throw ttsError('合成结果为空（0 字节 PCM）：检查音色名与文本', { provider: 'macos-say', code: 'empty_audio' });
      }
      if (pcm.length % 2 !== 0) pcm = pcm.subarray(0, pcm.length - 1); // s16le 对齐
      const durationMs = pcmDurationMs(pcm, requestedSampleRate);
      log(`[tts:macos-say] ${clean.length} 字 -> ${durationMs}ms@${requestedSampleRate}Hz voice=${voice}`);
      return { pcm: Buffer.from(pcm), sampleRate: requestedSampleRate, format: 's16le', durationMs, voiceId: voice };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function* synthesizeStream(opts = {}) {
    // say 不是真流式：按整段合成后一次性交付（接口与 minimax 保持一致）。
    const result = await synthesize(opts);
    yield { pcm: result.pcm, sampleRate: result.sampleRate, format: 's16le', durationMs: result.durationMs };
  }

  /** v0.2 预热：本地检查（不 spawn say、不产生任何 API 调用） */
  async function warmup() {
    const started = Date.now();
    if (process.platform !== 'darwin') {
      return { ok: false, provider: 'macos-say', elapsedMs: Date.now() - started, error: `unsupported platform: ${process.platform}` };
    }
    try {
      await fs.access('/usr/bin/say');
    } catch (err) {
      return { ok: false, provider: 'macos-say', elapsedMs: Date.now() - started, error: `/usr/bin/say 不可用：${err?.message ?? err}` };
    }
    return { ok: true, provider: 'macos-say', elapsedMs: Date.now() - started, voice, noop: true };
  }

  return {
    name: 'macos-say',
    sampleRate: requestedSampleRate,
    synthesize,
    synthesizeStream,
    listVoices: async () => MACOS_KNOWN_VOICES.map((v) => ({ ...v, cloned: false })),
    async cloneVoice() {
      throw ttsError('macos-say 不支持声音克隆；请用 minimax 克隆或保持预设音色', {
        provider: 'macos-say',
        code: 'clone_unsupported',
      });
    },
    warmup,
  };
}
