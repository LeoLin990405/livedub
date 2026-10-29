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
    throw ttsError('config.tts.provider 未配置（可选 minimax | macos-say | mock）', { code: 'missing_provider' });
  }
  let base;
  if (provider === 'minimax') base = createMinimaxTts({ config, log, fetchImpl });
  else if (provider === 'macos-say') base = createMacosSayTts({ config, log });
  else if (provider === 'mock') base = createMockTts({ config, log });
  else throw new Error(`unknown provider: ${provider}（tts.provider 仅支持 minimax | macos-say | mock）`);
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
