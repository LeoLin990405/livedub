/**
 * studio 共享的「回放 / 演示」解析工具（浏览器端，零依赖）。
 *
 * 支持两种来源：
 *  1) 引擎录制的会话 JSONL：每行一个引擎事件 JSON（第一行可为 {"type":"meta"}），字段与 WS 下发完全一致；
 *  2) 兼容包装：{ "event": {...} }、{ "events": [...] }、整份 JSON 数组。
 *
 * 时间轴：segment/partial 用 t0Ms/t1Ms，dub 用 startMs，其余事件按顺序继承上一个时间点；
 * 翻译事件本身不带时间戳（与引擎一致），因此继承同句 segment 的 t1Ms。
 */

/** 事件时间（毫秒）：优先显式字段，否则返回 null 由调用方继承 */
function explicitEventMs(event) {
  for (const key of ['atMs', 'tMs', 'tsMs', 't1Ms', 'startMs', 't0Ms']) {
    const value = Number(event?.[key]);
    if (Number.isFinite(value)) return Math.max(0, Math.round(value));
  }
  return null;
}

/** 给事件序列补 atMs（单调递增），返回新数组，不修改入参 */
export function annotateTimeline(events) {
  const out = [];
  let cursor = 0;
  for (const event of events ?? []) {
    if (!event || typeof event !== 'object') continue;
    const explicit = explicitEventMs(event);
    const atMs = explicit != null ? explicit : cursor;
    cursor = Math.max(cursor, atMs);
    // inferred=true 表示事件本身没带时间戳（例如线上 translation），由顺序继承；
    // parseSessionJsonl 会用同句 segment.t1Ms 再对齐一次。
    out.push({ ...event, atMs, inferred: explicit == null });
  }
  return out;
}

function expandLineObject(obj) {
  if (!obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj.events)) return obj.events.filter((e) => e && typeof e === 'object');
  if (obj.event && typeof obj.event === 'object') return [obj.event];
  return [obj];
}

/**
 * 解析会话 JSONL 文本。
 * @returns {{meta: object|null, ready: object|null, events: object[], segments: Map<string, object>, dubs: object[], eventsWithTimeline: object[]}}
 */
export function parseSessionJsonl(text) {
  const rawEvents = [];
  let meta = null;
  const source = String(text ?? '');
  const trimmed = source.trim();
  if (!trimmed) {
    return { meta, ready: null, events: [], eventsWithTimeline: [], segments: new Map(), dubs: [] };
  }

  // 整份 JSON（数组或 {events:[]}）
  if (trimmed.startsWith('[') || (trimmed.startsWith('{') && !trimmed.includes('\n'))) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) rawEvents.push(...parsed);
      else if (parsed && Array.isArray(parsed.events)) rawEvents.push(...parsed.events);
      else if (parsed && typeof parsed === 'object') {
        if (parsed.type === 'meta') meta = parsed;
        else rawEvents.push(parsed);
      }
    } catch {
      /* 落到 JSONL 解析 */
    }
  }

  if (rawEvents.length === 0) {
    for (const line of source.split('\n')) {
      const row = line.trim();
      if (!row || row.startsWith('#') || row.startsWith('//')) continue;
      let obj;
      try {
        obj = JSON.parse(row);
      } catch {
        continue;
      }
      for (const item of expandLineObject(obj)) {
        if (!item || typeof item !== 'object' || typeof item.type !== 'string') continue;
        if (item.type === 'meta') {
          meta = { ...(meta ?? {}), ...item };
          continue;
        }
        rawEvents.push(item);
      }
    }
  }

  const events = rawEvents.filter((event) => event && typeof event === 'object' && typeof event.type === 'string');
  const eventsWithTimeline = annotateTimeline(events);
  const segments = new Map();
  const dubs = [];
  let ready = null;

  // 事件按时间顺序应用，合并同一句的 segment/translation
  for (const event of eventsWithTimeline) {
    switch (event.type) {
      case 'ready':
        ready = event;
        break;
      case 'segment': {
        const id = String(event.id);
        segments.set(id, {
          id,
          t0Ms: Math.max(0, Math.round(Number(event.t0Ms) || 0)),
          t1Ms: Math.max(0, Math.round(Number(event.t1Ms) || 0)),
          text: String(event.text ?? ''),
          lang: String(event.lang ?? 'en'),
          translation: '',
          translationFinal: false,
        });
        break;
      }
      case 'translation': {
        const id = String(event.id);
        let segment = segments.get(id);
        if (!segment) {
          segment = { id, t0Ms: 0, t1Ms: event.atMs, text: '', lang: 'en', translation: '', translationFinal: false };
          segments.set(id, segment);
        }
        segment.translation = String(event.text ?? '');
        segment.translationFinal = Boolean(event.final);
        break;
      }
      case 'dub': {
        const pcm = String(event.pcm ?? '');
        if (!pcm) break; // 空 pcm 是引擎的收尾标记
        dubs.push({
          ...event,
          id: String(event.id ?? ''),
          startMs: Math.max(0, Math.round(Number(event.startMs) || 0)),
          sampleRate: Number(event.sampleRate) || 24000,
          durationMs: Math.max(0, Math.round(Number(event.durationMs) || 0)),
          atMs: event.atMs,
        });
        break;
      }
      default:
        break;
    }
  }

  // 真实 batch 产物里 translation/metrics 没有显式时间戳（与线上 WS 一致），
  // 这里绑定到同句 segment 的 t1Ms，使回放/演示的时间轴与字幕对齐；
  // 排序后 stateAt 的顺序遍历才能正确 break。
  const enriched = eventsWithTimeline.map((event) => {
    if (event.type !== 'translation' && event.type !== 'metrics') return event;
    if (!event.inferred) return event;
    const segment = segments.get(String(event.id));
    const t1Ms = Number(segment?.t1Ms);
    if (!Number.isFinite(t1Ms) || t1Ms <= 0) return event;
    return { ...event, atMs: Math.round(t1Ms) };
  });
  enriched.sort((a, b) => a.atMs - b.atMs);
  return { meta, ready, events, eventsWithTimeline: enriched, segments, dubs };
}

/**
 * 把引擎事件序列化为可回放的 JSONL 文本：首行可选 meta，其余每行一个事件。
 * 内部标注字段 atMs 会被剔除；空输入返回空串。
 * @param {object[]} events
 * @param {{meta?: object|null}} [options]
 */
export function buildEventJsonl(events, { meta = null } = {}) {
  const lines = [];
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    lines.push(JSON.stringify({ type: 'meta', ...meta }));
  }
  for (const event of events ?? []) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    const copy = { ...event };
    delete copy.atMs;
    delete copy.inferred;
    lines.push(JSON.stringify(copy));
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/** 生成会话 meta 行（导出事件 JSONL 时用） */
export function buildSessionMeta({
  sessionId = null,
  title = '',
  video = '',
  langFrom = 'en',
  langTo = 'zh',
  durationMs = 0,
  source = 'studio',
  generatedAt = null,
  extra = {},
} = {}) {
  return {
    sessionId: sessionId ?? null,
    title: String(title ?? ''),
    video: String(video ?? ''),
    langFrom: String(langFrom ?? 'en'),
    langTo: String(langTo ?? 'zh'),
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    source: String(source ?? 'studio'),
    generatedAt: generatedAt ?? new Date().toISOString(),
    ...extra,
  };
}

/**
 * 计算「回放到 tMs 时刻」的界面状态：当前字幕、最新 metrics/voice/status。
 */
export function stateAt(parsed, tMs) {
  const limit = Math.max(0, Math.round(Number(tMs) || 0));
  const state = {
    current: null,
    metrics: null,
    voice: null,
    status: null,
    ready: parsed?.ready ?? null,
    segmentsSoFar: [],
  };
  let current = null;
  const events = parsed?.eventsWithTimeline ?? [];
  for (const event of events) {
    if (event.atMs > limit) break;
    switch (event.type) {
      case 'partial': {
        current = {
          id: `partial:${event.id}`,
          src: String(event.text ?? ''),
          dst: '',
          t0Ms: Math.max(0, Math.round(Number(event.t0Ms) || 0)),
          t1Ms: Math.max(0, Math.round(Number(event.t1Ms) || 0)),
          translating: false,
          partial: true,
        };
        break;
      }
      case 'segment': {
        current = {
          id: String(event.id),
          src: String(event.text ?? ''),
          dst: '',
          t0Ms: Math.max(0, Math.round(Number(event.t0Ms) || 0)),
          t1Ms: Math.max(0, Math.round(Number(event.t1Ms) || 0)),
          translating: true,
          partial: false,
        };
        break;
      }
      case 'translation': {
        if (current && current.id === String(event.id)) {
          current.dst = String(event.text ?? '');
          current.translating = !event.final;
        }
        break;
      }
      case 'metrics':
        state.metrics = event;
        break;
      case 'voice':
        state.voice = event;
        break;
      case 'status':
        state.status = event;
        break;
      case 'segment-final':
        break;
      default:
        break;
    }
  }
  state.current = current;
  for (const segment of parsed?.segments?.values?.() ?? []) {
    if (segment.t0Ms <= limit) state.segmentsSoFar.push(segment);
  }
  state.segmentsSoFar.sort((a, b) => a.t0Ms - b.t0Ms);
  return state;
}

// ------------------------------------------------------------------ 时间/文本

export function formatClock(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatMs(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '—';
  return `${Math.round(value)}ms`;
}

export function formatSrtTime(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

/**
 * 生成 SRT 文本（双语：原文一行、译文一行；没有译文时只输出原文）。
 * @param {Iterable<{t0Ms:number,t1Ms:number,text:string,translation?:string}>} segments
 */
export function buildSrt(segments) {
  const list = [...(segments ?? [])]
    .filter((segment) => segment && String(segment.text ?? '').trim())
    .sort((a, b) => (Number(a.t0Ms) || 0) - (Number(b.t0Ms) || 0));
  const blocks = list.map((segment, index) => {
    const start = Math.max(0, Math.round(Number(segment.t0Ms) || 0));
    const end = Math.max(start + 500, Math.round(Number(segment.t1Ms) || start + 1500));
    const lines = [String(segment.text).trim()];
    const translation = String(segment.translation ?? '').trim();
    if (translation) lines.push(translation);
    return `${index + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${lines.join('\n')}`;
  });
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

/** base64 s16le -> Int16Array（浏览器） */
export function decodePcmBase64(base64) {
  if (typeof base64 !== 'string' || base64.length === 0) return new Int16Array(0);
  const binary = atob(base64);
  const length = binary.length - (binary.length % 2);
  const out = new Int16Array(length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    let value = (hi << 8) | lo;
    if (value & 0x8000) value -= 0x10000;
    out[i] = value;
  }
  return out;
}

/** 触发浏览器下载文本文件 */
export function downloadTextFile(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** 从 URL 抓取会话 JSONL（失败抛可读错误） */
export async function fetchSessionJsonl(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`加载会话失败：HTTP ${response.status}（${url}）`);
  return response.text();
}
