/**
 * livedub 扩展 SRT 导出纯函数（浏览器 + Node 双端可用，零依赖）。
 *
 * 数据来源：引擎事件流里的 `segment`（ASR 最终句，带 t0Ms/t1Ms）与
 * `translation`（同 id 的译文增量/final），由 background 在客户端累积；
 * 本文件把它们转成标准 SRT（双语：原文一行 + 译文一行）。
 *
 * 时间轴：与引擎会话时间轴一致（第一段音频为 0），单位毫秒。
 */

import { sanitizeEventText, wrapSubtitleLines } from './pcm.js';

/** 某句没有 t1Ms 时的兜底时长 */
export const DEFAULT_CUE_MS = 2400;

/**
 * 毫秒 -> SRT 时间戳：HH:MM:SS,mmm（小时可超过 99）。
 * @param {number} ms
 * @returns {string}
 */
export function formatSrtTimestamp(ms) {
  const value = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
  const hours = Math.floor(value / 3600000);
  const minutes = Math.floor((value % 3600000) / 60000);
  const seconds = Math.floor((value % 60000) / 1000);
  const millis = value % 1000;
  const pad = (num, width) => String(num).padStart(width, '0');
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
}

/**
 * 把客户端累积的 caption 条目整理成 SRT cue 列表。
 * 规则：
 * - 只保留有文本的条目（原文或译文任一存在即可）；
 * - 按开始时间排序；缺失/非法 t0Ms 用上一句结束时间兜底；
 * - 缺失/非法 t1Ms 用 DEFAULT_CUE_MS 兜底；
 * - 保证 cue 不重叠（start >= 上一句 end）；
 * - 双语：原文行 + 译文行，各自按 maxCharsPerLine/maxLines 折行。
 *
 * @param {Array<{id?:string|number, t0Ms?:number, t1Ms?:number, src?:string, dst?:string}>} captions
 * @param {{bilingual?:boolean, maxCharsPerLine?:number, maxLines?:number, defaultCueMs?:number}} [opts]
 * @returns {Array<{index:number, startMs:number, endMs:number, text:string, src:string, dst:string}>}
 */
export function normalizeCaptionCues(
  captions,
  { bilingual = true, maxCharsPerLine = 24, maxLines = 2, defaultCueMs = DEFAULT_CUE_MS } = {},
) {
  if (!Array.isArray(captions)) return [];
  const lineChars = Number.isFinite(maxCharsPerLine) && maxCharsPerLine >= 4 ? Math.floor(maxCharsPerLine) : 24;
  const lineCount = Number.isFinite(maxLines) && maxLines >= 1 ? Math.floor(maxLines) : 2;
  const fallbackMs = Number.isFinite(defaultCueMs) && defaultCueMs > 0 ? defaultCueMs : DEFAULT_CUE_MS;

  const prepared = [];
  for (const caption of captions) {
    if (!caption || typeof caption !== 'object') continue;
    const src = sanitizeEventText(caption.src, { maxLen: 600 });
    const dst = sanitizeEventText(caption.dst, { maxLen: 600 });
    if (!src && !dst) continue;
    let start = Number.isFinite(caption.t0Ms) && caption.t0Ms >= 0 ? Math.round(caption.t0Ms) : null;
    let end = Number.isFinite(caption.t1Ms) && caption.t1Ms > 0 ? Math.round(caption.t1Ms) : null;
    prepared.push({ src, dst, start, end, order: prepared.length });
  }
  if (prepared.length === 0) return [];
  prepared.sort((a, b) => {
    const sa = a.start == null ? Number.POSITIVE_INFINITY : a.start;
    const sb = b.start == null ? Number.POSITIVE_INFINITY : b.start;
    if (sa !== sb) return sa - sb;
    return a.order - b.order;
  });

  const cues = [];
  let previousEnd = 0;
  for (const item of prepared) {
    let start = item.start == null ? previousEnd : item.start;
    if (start < previousEnd) start = previousEnd;
    let end = item.end == null ? start + fallbackMs : item.end;
    if (end <= start) end = start + 200;
    const srcText = item.src ? wrapSubtitleLines(item.src, { maxCharsPerLine: lineChars, maxLines: lineCount }) : '';
    const dstText = item.dst ? wrapSubtitleLines(item.dst, { maxCharsPerLine: lineChars, maxLines: lineCount }) : '';
    let text;
    if (bilingual && srcText && dstText && srcText !== dstText) text = `${srcText}\n${dstText}`;
    else text = dstText || srcText;
    cues.push({ index: cues.length + 1, startMs: start, endMs: end, text, src: srcText, dst: dstText });
    previousEnd = end;
  }
  return cues;
}

/**
 * cue 列表 -> SRT 字符串（块之间空行结尾）。
 * @param {Array<{startMs:number,endMs:number,text:string}>} cues
 * @returns {string}
 */
export function buildSrt(cues) {
  if (!Array.isArray(cues) || cues.length === 0) return '';
  const blocks = cues.map(
    (cue, index) =>
      `${index + 1}\n${formatSrtTimestamp(cue.startMs)} --> ${formatSrtTimestamp(cue.endMs)}\n${String(cue.text || '').trim()}\n`,
  );
  return `${blocks.join('\n')}\n`;
}

/**
 * 一步到位：caption 条目 -> { srt, cues, count }。
 * @param {Array<object>} captions
 * @param {object} [opts] 同 normalizeCaptionCues
 */
export function buildSrtFromCaptions(captions, opts = {}) {
  const cues = normalizeCaptionCues(captions, opts);
  return { srt: buildSrt(cues), cues, count: cues.length };
}

/**
 * 安全文件名字段：去掉路径/非法字符，空白折叠成 -。
 * @param {unknown} value
 * @param {{maxLen?:number, fallback?:string}} [opts]
 * @returns {string}
 */
export function sanitizeFilenamePart(value, { maxLen = 48, fallback = 'session' } = {}) {
  const raw = sanitizeEventText(value, { maxLen: 240 });
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, Math.max(1, maxLen))
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned || fallback;
}

/**
 * 文件名时间戳：YYYYMMDD-HHMMSS（本地时区，便于用户辨认）。
 * @param {Date|number|string} [dateLike]
 * @returns {string}
 */
export function formatFileTimestamp(dateLike = Date.now()) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const valid = Number.isFinite(date.getTime()) ? date : new Date();
  const pad = (num) => String(num).padStart(2, '0');
  return `${valid.getFullYear()}${pad(valid.getMonth() + 1)}${pad(valid.getDate())}-${pad(valid.getHours())}${pad(
    valid.getMinutes(),
  )}${pad(valid.getSeconds())}`;
}

/**
 * 建议的 SRT 文件名：livedub-<视频标题>-<时间戳>.srt。
 * @param {{title?:string, startedAt?:Date|number|string|null}} [opts]
 * @returns {string}
 */
export function suggestSrtFilename({ title = '', startedAt = null } = {}) {
  const part = sanitizeFilenamePart(title || 'session', { maxLen: 48 });
  const stamp = formatFileTimestamp(startedAt == null ? Date.now() : startedAt);
  return `livedub-${part}-${stamp}.srt`;
}
