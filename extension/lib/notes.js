/**
 * livedub 扩展「边看边写笔记」纯函数库（浏览器 + Node 双端可用，零依赖）。
 *
 * 覆盖：
 * - VideoRef 身份：url 规范化 + (url,title,duration) 稳定 videoId（跨会话/多标签一致）；
 * - quick note 请求体（POST /api/notes/quick）与本地 Markdown 生成（时间戳/双语引用/URL）；
 * - 断网失败队列（可注入 localStorage / chrome.storage 适配器，最多 50 条，重连 flush）；
 * - 今日笔记计数（本地统计，离线也可用）、时间格式化、Notes API URL、toast 文案。
 *
 * 契约见 docs/CONTRACTS.md §7.6（Notes API，三端共用）：
 *   POST /api/notes/quick {video,tMs,text,quotes?,tags?,source} -> {ok,path,markdown}
 *   POST /api/notes/assets raw PNG -> {ok,url}
 *   POST /api/notes/export {videoId} -> {ok,path}
 */

import { sanitizeEventText } from './pcm.js';

/** 离线队列默认上限（契约：最多 50 条） */
export const NOTE_QUEUE_LIMIT = 50;
/** 单条笔记 text 上限（与引擎字段白名单一致，宽松截断） */
export const NOTE_TEXT_LIMIT = 2000;
/** 单条引用文本上限 */
export const NOTE_QUOTE_TEXT_LIMIT = 500;
/** 截图 PNG 上限 4MB（契约） */
export const NOTE_ASSET_MAX_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 时间格式
// ---------------------------------------------------------------------------

/**
 * 毫秒 -> 人类可读时间码：mm:ss；>=1h 为 h:mm:ss。
 * @param {number} ms
 * @returns {string}
 */
export function formatTimecode(ms) {
  const value = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
  const totalSeconds = Math.floor(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (num) => String(num).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** 本地日期 key：YYYY-MM-DD（今日计数用） */
export function toDateKey(dateLike = new Date()) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const valid = Number.isFinite(date.getTime()) ? date : new Date();
  const pad = (num) => String(num).padStart(2, '0');
  return `${valid.getFullYear()}-${pad(valid.getMonth() + 1)}-${pad(valid.getDate())}`;
}

// ---------------------------------------------------------------------------
// 视频身份（VideoRef）
// ---------------------------------------------------------------------------

/** 需要从 URL 查询串里剔除的追踪/会话参数（保持 videoId 稳定） */
const TRACKING_PARAM = /^(?:utm_[a-z_]+|spm(?:_[a-z_]+)?|fbclid|gclid|dclid|msclkid|vd_source|share_[a-z_]+|ref|ref_|from|si|feature|t|start|end)$/i;

/**
 * 规范化视频 URL：去掉 hash、追踪参数，查询参数排序；host 小写、去 path 尾部斜杠。
 * 解析失败时原样 trim 返回（截断 500 字符）。
 * @param {unknown} url
 * @returns {string}
 */
export function normalizeVideoUrl(url) {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!parsed.hostname) return raw.slice(0, 500);
    const params = [...parsed.searchParams.entries()]
      .filter(([key]) => !TRACKING_PARAM.test(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const query = params.length > 0 ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
    let path = parsed.pathname || '/';
    if (path.length > 1) path = path.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${query}`;
  } catch {
    return raw.slice(0, 500);
  }
}

function fnv1a(text, seed = 0x811c9dc5) {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function hex8(value) {
  return (value >>> 0).toString(16).padStart(8, '0');
}

/**
 * 生成稳定 videoId：ext-<16 hex>，输入 = 规范化 url + title + 时长(秒)。
 * 同一视频多次调用结果一致；时长未就绪时（0）也能得到稳定 id（与有时长时不同，
 * 因此扩展在首次拿到 duration 后才会写入，避免 id 漂移——见 background 的 context 约定）。
 * @param {{url?:string, title?:string, durationMs?:number}} [video]
 * @returns {string}
 */
export function computeVideoId({ url = '', title = '', durationMs = null } = {}) {
  const normalizedUrl = normalizeVideoUrl(url);
  const durationSec = Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs / 1000) : 0;
  const seed = `${normalizedUrl}\n${String(title || '').trim()}\n${durationSec}`;
  const a = fnv1a(seed, 0x811c9dc5);
  const b = fnv1a(seed, 0x9e3779b9 ^ 0x01000193);
  return `ext-${hex8(a)}${hex8(b)}`;
}

/**
 * VideoRef（引擎契约 {id,title,url?,durationMs?}）。
 * @param {{url?:string, title?:string, durationMs?:number}} [video]
 * @returns {{id:string,title:string,url?:string,durationMs?:number}}
 */
export function buildVideoIdentity({ url = '', title = '', durationMs = null } = {}) {
  const identity = {
    id: computeVideoId({ url, title, durationMs }),
    title: sanitizeEventText(title, { maxLen: 200 }) || '未知视频',
  };
  const normalizedUrl = normalizeVideoUrl(url);
  if (normalizedUrl) identity.url = normalizedUrl.slice(0, 2000);
  const duration = Number(durationMs);
  if (Number.isFinite(duration) && duration > 0) identity.durationMs = Math.round(duration);
  return identity;
}

// ---------------------------------------------------------------------------
// Quick note（POST /api/notes/quick）
// ---------------------------------------------------------------------------

function normalizeQuote(quote) {
  if (!quote || typeof quote !== 'object') return null;
  const t0Ms = Number(quote.t0Ms);
  const t1Ms = Number(quote.t1Ms);
  const src = sanitizeEventText(quote.src, { maxLen: NOTE_QUOTE_TEXT_LIMIT });
  const dst = sanitizeEventText(quote.dst, { maxLen: NOTE_QUOTE_TEXT_LIMIT });
  if (!src && !dst) return null;
  const out = {};
  if (Number.isFinite(t0Ms) && t0Ms >= 0) out.t0Ms = Math.round(t0Ms);
  if (Number.isFinite(t1Ms) && t1Ms >= 0) out.t1Ms = Math.round(t1Ms);
  if (src) out.src = src;
  if (dst) out.dst = dst;
  return out;
}

/**
 * 构造 POST /api/notes/quick 的请求体。
 * @param {{video:object, tMs?:number, text?:string, quotes?:Array<object>, tags?:string[]}} input
 * @returns {object}
 */
export function buildQuickNoteRequest({ video = {}, tMs = 0, text = '', quotes = [], tags = [] } = {}) {
  const videoRef = buildVideoIdentity({
    url: video.url || '',
    title: video.title || '',
    durationMs: video.durationMs,
  });
  const time = Number(tMs);
  const body = {
    video: videoRef,
    tMs: Number.isFinite(time) && time >= 0 ? Math.round(time) : 0,
    text: sanitizeEventText(text, { maxLen: NOTE_TEXT_LIMIT }) || '（无字幕）',
    source: 'extension',
  };
  const normalizedQuotes = Array.isArray(quotes) ? quotes.map(normalizeQuote).filter(Boolean).slice(0, 3) : [];
  if (normalizedQuotes.length > 0) body.quotes = normalizedQuotes;
  const normalizedTags = Array.isArray(tags)
    ? tags
        .map((tag) => sanitizeEventText(tag, { maxLen: 32 }))
        .filter(Boolean)
        .slice(0, 10)
    : [];
  if (normalizedTags.length > 0) body.tags = normalizedTags;
  return body;
}

/**
 * 本地 quick note Markdown（引擎不可用时用于预览/本地兜底；正常以引擎返回的 markdown 为准）。
 * @param {{video?:object, tMs?:number, text?:string, quotes?:Array<object>}} payload
 * @returns {string}
 */
export function buildQuickNoteMarkdown({ video = {}, tMs = 0, text = '', quotes = [] } = {}) {
  const timecode = formatTimecode(tMs);
  const videoTitle = sanitizeEventText(video.title, { maxLen: 200 }) || '未知视频';
  const lines = [`- [ ] **${timecode}** ${sanitizeEventText(text, { maxLen: NOTE_TEXT_LIMIT }) || '（无字幕）'}`];
  const normalizedQuotes = Array.isArray(quotes) ? quotes.map(normalizeQuote).filter(Boolean).slice(0, 3) : [];
  for (const quote of normalizedQuotes) {
    if (quote.src) lines.push(`  - 原声：${quote.src}`);
    if (quote.dst) lines.push(`  - 译文：${quote.dst}`);
  }
  if (video.url) lines.push(`  - 视频：[${videoTitle}](${video.url})`);
  else lines.push(`  - 视频：${videoTitle}`);
  return `${lines.join('\n')}\n`;
}

/**
 * toast 文案：成功/排队/截图失败提示。
 * @param {{tMs?:number, queued?:boolean, queueSize?:number, imageSkipped?:boolean}} result
 * @returns {string}
 */
export function buildNoteToastText({ tMs = 0, queued = false, queueSize = 0, imageSkipped = false } = {}) {
  const stamp = formatTimecode(tMs);
  const base = queued ? `引擎未连接，已排队（${queueSize}）@ ${stamp}` : `已记笔记 @ ${stamp}`;
  return imageSkipped ? `${base}（截图失败，已存无图笔记）` : base;
}

// ---------------------------------------------------------------------------
// Notes API URL / 响应解析
// ---------------------------------------------------------------------------

/**
 * Notes API URL：httpBase 形如 http://127.0.0.1:8787。
 * @param {string} httpBase
 * @param {'list'|'quick'|'assets'|'export'|'exportMd'} kind
 * @returns {string}
 */
export function notesEndpoint(httpBase, kind) {
  const base = String(httpBase || '').replace(/\/+$/, '');
  const suffixes = {
    list: '/api/notes',
    quick: '/api/notes/quick',
    assets: '/api/notes/assets',
    export: '/api/notes/export',
    exportMd: '/api/notes/export.md',
  };
  const suffix = suffixes[kind];
  if (!suffix) throw new Error(`unknown notes endpoint: ${kind}`);
  return `${base}${suffix}`;
}

/**
 * 把引擎返回的资产相对路径解析成可下载的绝对地址。
 * @param {string} httpBase
 * @param {string} url
 * @returns {string}
 */
export function resolveAssetUrl(httpBase, url) {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = String(httpBase || '').replace(/\/+$/, '');
  if (!base) return raw;
  return raw.startsWith('/') ? `${base}${raw}` : `${base}/${raw}`;
}

/**
 * 兼容解析 GET /api/notes 的响应（契约 {ok,videos,notes}；也接受数组/items 形态）。
 * @param {unknown} response
 * @returns {Array<object>}
 */
export function parseNotesListResponse(response) {
  if (Array.isArray(response)) return response;
  if (!response || typeof response !== 'object') return [];
  if (Array.isArray(response.notes)) return response.notes;
  if (Array.isArray(response.items)) return response.items;
  if (response.data && Array.isArray(response.data.notes)) return response.data.notes;
  return [];
}

// ---------------------------------------------------------------------------
// 今日笔记计数（本地统计，离线可用）
// ---------------------------------------------------------------------------

/**
 * 今日计数 +1（跨天自动归零）。
 * @param {{date?:string,count?:number}|null|undefined} current
 * @param {Date|number|string} [dateLike]
 * @returns {{date:string,count:number}}
 */
export function nextDailyStats(current, dateLike = new Date()) {
  const date = toDateKey(dateLike);
  const count = current && current.date === date && Number.isFinite(Number(current.count)) ? Number(current.count) : 0;
  return { date, count: count + 1 };
}

/**
 * 读取「今日」计数（跨天返回 0）。
 * @param {{date?:string,count?:number}|null|undefined} current
 * @param {Date|number|string} [dateLike]
 * @returns {number}
 */
export function readDailyCount(current, dateLike = new Date()) {
  const date = toDateKey(dateLike);
  if (!current || current.date !== date) return 0;
  const count = Number(current.count);
  return Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
}

// ---------------------------------------------------------------------------
// 离线队列（失败重试；可注入 localStorage / chrome.storage 适配器）
// ---------------------------------------------------------------------------

function deserializeQueue(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((entry) => entry && entry.payload);
  if (raw && typeof raw === 'object' && Array.isArray(raw.entries)) {
    return raw.entries.filter((entry) => entry && entry.payload);
  }
  return [];
}

function serializeQueue(entries) {
  return { v: 1, entries };
}

/**
 * 创建笔记离线队列。
 *
 * storage 适配器接口（同步/异步均可）：
 *   getItem(key) -> value | Promise<value>
 *   setItem(key, value) -> void | Promise<void>
 *
 * @param {{storage?:object|null, maxNotes?:number, key?:string, now?:()=>number}} [opts]
 */
export function createNoteQueue({ storage = null, maxNotes = NOTE_QUEUE_LIMIT, key = 'livedub:note-queue', now = () => Date.now() } = {}) {
  const limit = Number.isFinite(maxNotes) && maxNotes > 0 ? Math.floor(maxNotes) : NOTE_QUEUE_LIMIT;
  let entries = [];
  let loaded = false;
  let seq = 0;

  async function persist() {
    if (!storage) return;
    try {
      await storage.setItem(key, serializeQueue(entries));
    } catch {
      /* 存储失败不影响内存队列 */
    }
  }

  async function load() {
    if (loaded) return entries;
    if (storage) {
      try {
        entries = deserializeQueue(await storage.getItem(key)).slice(-limit);
      } catch {
        entries = [];
      }
    }
    loaded = true;
    return entries;
  }

  return {
    async load() {
      await load();
      return entries;
    },
    /** 当前队列（浅拷贝） */
    list() {
      return entries.slice();
    },
    async size() {
      await load();
      return entries.length;
    },
    /**
     * 入队；超过上限丢最旧记录。
     * @param {object} payload POST /api/notes/quick 请求体
     */
    async enqueue(payload) {
      await load();
      seq += 1;
      const entry = { id: `note-${now()}-${seq}`, payload, createdAt: now(), attempts: 0 };
      entries.push(entry);
      let dropped = 0;
      while (entries.length > limit) {
        entries.shift();
        dropped += 1;
      }
      await persist();
      return { id: entry.id, size: entries.length, dropped };
    },
    /** 出队最旧一条（不落盘；一般用 flush） */
    shift() {
      return entries.shift() || null;
    },
    /**
     * 尝试发送队列（最旧优先）；某条失败即停止，保留剩余等待下次重连。
     * @param {{send:(payload:object)=>Promise<any>, limit?:number}} opts
     * @returns {Promise<{sent:number,failed:number,remaining:number}>}
     */
    async flush({ send, limit: flushLimit = limit } = {}) {
      await load();
      if (typeof send !== 'function') throw new TypeError('flush requires send(payload)');
      const max = Number.isFinite(flushLimit) && flushLimit > 0 ? Math.floor(flushLimit) : limit;
      let sent = 0;
      let failed = 0;
      for (let i = 0; i < max && entries.length > 0; i += 1) {
        const entry = entries[0];
        entry.attempts = (entry.attempts || 0) + 1;
        try {
          await send(entry.payload);
          entries.shift();
          sent += 1;
        } catch {
          failed += 1;
          break;
        }
      }
      await persist();
      return { sent, failed, remaining: entries.length };
    },
    async clear() {
      entries = [];
      loaded = true;
      await persist();
    },
  };
}
