/**
 * 字幕处理纯函数：SRT 渲染、CPS/行长断行、双语排版、cue 合并去重、时间轴格式化。
 *
 * 全部是纯函数（无 I/O、无状态、不依赖配置加载），便于单测与在浏览器/服务端复用。
 * 字幕 cue 的规范形状（宽松输入，内部统一成这个形状）：
 *   {
 *     startMs: number,   // 会话时间轴毫秒（0 = 客户端第一段音频）
 *     endMs: number,
 *     src?: string,      // 原文（英文）
 *     dst?: string,      // 译文（中文）
 *     final?: boolean,   // false/partial=true 表示 ASR/翻译中间结果（默认 true）
 *     id?: string|number // 同一 id 的多次更新以后到的为准
 *   }
 * 输入也接受 pipeline 事件里的别名：t0Ms/t1Ms、text、translation、original 等。
 *
 * 主要导出：
 *   formatSrtTime(ms) -> 'HH:MM:SS,mmm'
 *   formatSrt(cues, opts) -> string                 // 毫秒时间轴 -> SRT
 *   countChars(text) / cueCps(text, durationMs)
 *   splitCps(text, opts) -> string[]                // 按 CPS 预算断行（英文按词、中文按字）
 *   wrapLines(text, opts) -> string[]
 *   wrapBilingual(opts | src, dst, opts) -> string  // 原文行 + 译文行
 *   dedupeCues(cues, opts) / normalizeCues(cues, opts)
 *   mergeCues(cues, opts)
 */

const CJK_CHAR_RE = /[\u2e80-\u2fff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u;
const CJK_OR_PUNCT_RE =
  /[\u2e80-\u2fff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef，。！？；：、,.!?;:]/u;

/** 断行时不应出现在行首的收尾标点（宁可让当前行超 1 个字符，也不要标点打头） */
const CLOSING_PUNCT = new Set([...'，。！？；：、,.!?;:）)】》」』”’…—·%']);

/** 拉丁词内允许的连接字符（fine-tuning / 3.14 / snake_case / x+y 等整体成 token） */
const WORD_INNER_CHAR_RE = /[._'’+\-/@#$%]/;

/* ------------------------------------------------------------------ *
 * 字符统计 / 时间轴
 * ------------------------------------------------------------------ */

/** 可见字符数（去空白；CJK 每字算 1，emoji 等按 code point 算 1） */
export function countChars(text) {
  return Array.from(String(text ?? '').replace(/\s+/g, '')).length;
}

/** 每秒字符数（CPS）；durationMs <= 0 时返回 0 */
export function cueCps(text, durationMs) {
  const seconds = Number(durationMs) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return countChars(text) / seconds;
}

function padStart2(value, width) {
  return String(Math.max(0, Math.trunc(value))).padStart(width, '0');
}

/**
 * 毫秒 -> SRT 时间戳 `HH:MM:SS,mmm`；负值/非法值按 0 处理。
 * @param {number} ms
 * @returns {string}
 */
export function formatSrtTime(ms) {
  let value = Number(ms);
  if (!Number.isFinite(value) || value < 0) value = 0;
  value = Math.round(value);
  const hours = Math.floor(value / 3600000);
  const minutes = Math.floor((value % 3600000) / 60000);
  const seconds = Math.floor((value % 60000) / 1000);
  const millis = value % 1000;
  return `${padStart2(hours, 2)}:${padStart2(minutes, 2)}:${padStart2(seconds, 2)},${padStart2(millis, 3)}`;
}

function isCjkChar(ch) {
  return ch != null && CJK_CHAR_RE.test(ch);
}

function isCjkOrPunct(ch) {
  return ch != null && CJK_OR_PUNCT_RE.test(ch);
}

/** 两个字符串片段拼接时是否需要补空格（中文/标点边界不补，英文词边界补 1 个） */
function joinFragments(left, right) {
  const a = String(left ?? '').trimEnd();
  const b = String(right ?? '').trimStart();
  if (!a) return b;
  if (!b) return a;
  const before = Array.from(a).pop();
  const after = Array.from(b)[0];
  if (isCjkOrPunct(before) || isCjkOrPunct(after)) return `${a}${b}`;
  if (/[\s]$/.test(a)) return `${a}${b}`;
  return `${a} ${b}`;
}

/* ------------------------------------------------------------------ *
 * 断行：英文按词，中文按字
 * ------------------------------------------------------------------ */

/**
 * 把文本切成「不可再拆」的排版 token，并带上「前面是否有空白」信息。
 * 拉丁词/数字/标识符整体成 token（英文按词断行）；CJK 每字一个 token（中文按字断行）；
 * 其余标点各自成 token。
 */
function tokenizeForWrap(text) {
  const source = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
  if (!source) return [];
  const tokens = [];
  let word = '';
  let pendingSpace = false;

  const flushWord = () => {
    if (!word) return;
    tokens.push({ text: word, space: pendingSpace });
    word = '';
    pendingSpace = false;
  };

  for (const ch of Array.from(source)) {
    if (/\s/.test(ch)) {
      flushWord();
      pendingSpace = true;
      continue;
    }
    if (/[A-Za-z0-9]/.test(ch)) {
      word += ch;
      continue;
    }
    if (word && WORD_INNER_CHAR_RE.test(ch)) {
      word += ch;
      continue;
    }
    flushWord();
    tokens.push({ text: ch, space: pendingSpace });
    pendingSpace = false;
  }
  flushWord();
  return tokens;
}

function tokenWidth(token) {
  return Array.from(String(token ?? '')).length;
}

/** 把一个「超长单词」（如长 URL/标识符）硬拆成每行 maxChars 的块 */
function splitLongToken(token, maxChars) {
  const chars = Array.from(token);
  const chunks = [];
  for (let i = 0; i < chars.length; i += maxChars) {
    chunks.push(chars.slice(i, i + maxChars).join(''));
  }
  return chunks;
}

function packTokens(tokens, maxChars) {
  const lines = [];
  let line = '';

  const pushLine = () => {
    const trimmed = line.replace(/\s+$/g, '');
    if (trimmed) lines.push(trimmed);
    line = '';
  };

  for (const token of tokens) {
    const raw = token.text;
    const firstChar = Array.from(raw)[0];
    const needSpace = line !== '' && token.space && !CLOSING_PUNCT.has(firstChar);
    const cost = (needSpace ? 1 : 0) + tokenWidth(raw);

    if (line !== '' && tokenWidth(line) + cost > maxChars && !CLOSING_PUNCT.has(firstChar)) {
      pushLine();
    }

    if (line === '' && tokenWidth(raw) > maxChars) {
      const chunks = splitLongToken(raw, maxChars);
      for (let i = 0; i < chunks.length - 1; i += 1) lines.push(chunks[i]);
      line = chunks[chunks.length - 1] ?? '';
      continue;
    }

    line += `${line !== '' && needSpace ? ' ' : ''}${raw}`;
  }
  pushLine();
  return lines;
}

/**
 * 按行长断行（英文按词、中文按字；收尾标点不落到行首）。
 * @param {string} text
 * @param {{maxCharsPerLine?: number}} [options]
 * @returns {string[]} 行数组（文本全部保留，不会截断）
 */
export function wrapLines(text, { maxCharsPerLine = 24 } = {}) {
  const source = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
  if (!source) return [];
  const maxChars = Math.max(1, Math.min(200, Math.floor(Number(maxCharsPerLine) || 24)));
  return packTokens(tokenizeForWrap(source), maxChars);
}

/** 给定时长，一行最多能放多少个字符（CPS 预算与行长上限取小） */
export function effectiveCharsPerLine({ maxCps = 9, maxCharsPerLine = 24, durationMs = 0 } = {}) {
  const lineCap = Math.max(1, Math.floor(Number(maxCharsPerLine) || 24));
  const cps = Number(maxCps);
  const duration = Number(durationMs);
  if (!Number.isFinite(cps) || cps <= 0 || !Number.isFinite(duration) || duration <= 0) return lineCap;
  const cpsBudget = Math.max(4, Math.floor((cps * duration) / 1000));
  return Math.max(1, Math.min(lineCap, cpsBudget));
}

function fitLines(lines, maxLines) {
  const list = Array.isArray(lines) ? lines.filter(Boolean) : [];
  const limit = Math.floor(Number(maxLines) || 0);
  if (limit <= 0 || list.length <= limit) return list;
  const head = list.slice(0, limit - 1);
  const tail = list.slice(limit - 1).reduce((acc, line) => joinFragments(acc, line), '');
  return [...head, tail].filter(Boolean);
}

/**
 * 按 CPS + 行长断行：时长越短，一行允许的字符越少（避免字幕一闪而过）。
 * @param {string} text
 * @param {{maxCps?: number, maxCharsPerLine?: number, durationMs?: number, maxLines?: number}} [options]
 * @returns {string[]} 行数组（文本全部保留；maxLines > 0 时超出部分并入最后一行）
 */
export function splitCps(text, { maxCps = 9, maxCharsPerLine = 24, durationMs = 0, maxLines = 0 } = {}) {
  const lengthCap = effectiveCharsPerLine({ maxCps, maxCharsPerLine, durationMs });
  const lines = wrapLines(text, { maxCharsPerLine: lengthCap });
  return maxLines > 0 ? fitLines(lines, maxLines) : lines;
}

/* ------------------------------------------------------------------ *
 * 双语排版
 * ------------------------------------------------------------------ */

/**
 * 双语字幕排版：原文行（小字）在前，译文行在后。
 * 兼容两种调用：wrapBilingual({ src, dst, ... }) 或 wrapBilingual(src, dst, opts)。
 * @returns {string} 用 '\n' 连接的多行文本（仅供字幕渲染；SRT 也直接可用）
 */
export function wrapBilingual(input = {}, maybeDst, maybeOptions) {
  let src = '';
  let dst = '';
  let options = {};
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    src = String(input.src ?? input.original ?? input.source ?? input.text ?? '');
    dst = String(input.dst ?? input.translation ?? input.target ?? '');
    options = input;
  } else {
    src = String(input ?? '');
    dst = String(maybeDst ?? '');
    options = maybeOptions && typeof maybeOptions === 'object' ? maybeOptions : {};
  }

  const maxCharsPerLine = Math.max(1, Math.floor(Number(options.maxCharsPerLine) || 24));
  const maxLines = Math.max(1, Math.floor(Number(options.maxLines) || 2));
  const bilingual = options.bilingual !== false && Boolean(src) && Boolean(dst);

  if (!bilingual) {
    const only = dst || src;
    if (!only.trim()) return '';
    const lines = wrapLines(only, { maxCharsPerLine });
    return (maxLines > 0 ? fitLines(lines, maxLines) : lines).join('\n');
  }

  const srcLines = fitLines(wrapLines(src, { maxCharsPerLine }), 1);
  const dstLines = fitLines(wrapLines(dst, { maxCharsPerLine }), Math.max(1, maxLines - 1));
  return [...srcLines, ...dstLines].join('\n');
}

/* ------------------------------------------------------------------ *
 * Cue 规范化 / 去重 / 合并 / SRT
 * ------------------------------------------------------------------ */

function toMs(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function toText(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

/**
 * 内部用：宽松读取 cue -> 规范 cue（返回 null 表示无效）。
 * 支持别名：startMs/t0Ms/start/fromMs/beginMs，endMs/t1Ms/end/toMs，
 * src/original/source/sourceText，dst/translation/translated/target/targetText，
 * text（无 src/dst 时当原文），final/partial，id/segmentId/cueId。
 */
function normalizeCue(raw, { maxCps = 9 } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const startMs = Math.max(0, toMs(raw.startMs ?? raw.t0Ms ?? raw.start ?? raw.fromMs ?? raw.beginMs ?? 0, 0));
  let src = toText(raw.src ?? raw.original ?? raw.source ?? raw.sourceText ?? '');
  let dst = toText(raw.dst ?? raw.translation ?? raw.translated ?? raw.target ?? raw.targetText ?? '');
  const textOnly = toText(raw.text ?? raw.content ?? '');
  if (!src && !dst && textOnly) {
    // 只有一个 text 时按原文处理；调用方可用 dst/bilingual=false 控制显示哪一侧
    src = textOnly;
  }
  const final = raw.final !== false && raw.partial !== true;
  const id = raw.id ?? raw.segmentId ?? raw.cueId ?? null;
  let endMs = toMs(raw.endMs ?? raw.t1Ms ?? raw.end ?? raw.toMs ?? null, null);
  if (endMs == null || endMs <= startMs) {
    const chars = Math.max(countChars(src), countChars(dst));
    const cps = Number(maxCps) > 0 ? Number(maxCps) : 9;
    endMs = startMs + Math.max(400, Math.ceil((chars / cps) * 1000));
  }
  return { startMs, endMs, src, dst, final, id };
}

function cueKey(cue) {
  return `${cue.startMs}|${cue.endMs}|${cue.src}|${cue.dst}`;
}

/**
 * 规范化 + 去重：
 *   - 同一 id 的多次更新只保留最后一条（partial 覆盖式）
 *   - (start,end,src,dst) 完全相同的重复 cue 去掉
 *   - 按 startMs 升序
 * @param {Array} cues
 * @param {{includePartial?: boolean, maxCps?: number}} [options] includePartial=false 时丢弃 final=false 的中间结果
 * @returns {Array}
 */
export function dedupeCues(cues, { includePartial = true, maxCps = 9 } = {}) {
  if (!Array.isArray(cues)) return [];
  const byId = new Map();
  const withoutId = [];
  for (const raw of cues) {
    const cue = normalizeCue(raw, { maxCps });
    if (!cue) continue;
    if (!includePartial && cue.final === false) continue;
    if (!cue.src && !cue.dst) continue;
    if (cue.id != null) byId.set(String(cue.id), cue);
    else withoutId.push(cue);
  }
  const seen = new Set();
  const out = [];
  for (const cue of [...byId.values(), ...withoutId]) {
    const key = cueKey(cue);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cue);
  }
  out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return out;
}

/** normalizeCues 是 dedupeCues 的别名（语义：把任意 cue 输入变成规范、有序、去重的列表） */
export function normalizeCues(cues, options) {
  return dedupeCues(cues, options);
}

/**
 * 合并相邻短 cue（同一句话被 VAD 切成两半、或连续 partial 遗留下来的碎片）。
 * 合并条件：时间不重叠且间隔 <= maxGapMs、final 状态一致、合并后字符数 <= maxCharsPerCue。
 * @param {Array} cues
 * @param {{maxGapMs?: number, maxCharsPerCue?: number, includePartial?: boolean}} [options]
 * @returns {Array}
 */
export function mergeCues(cues, { maxGapMs = 150, maxCharsPerCue = 48, includePartial = true } = {}) {
  const list = dedupeCues(cues, { includePartial });
  const gapLimit = Math.max(0, Number(maxGapMs) || 0);
  const charLimit = Math.max(0, Number(maxCharsPerCue) || 0);
  const merged = [];
  for (const cue of list) {
    const prev = merged[merged.length - 1];
    if (!prev) {
      merged.push({ ...cue });
      continue;
    }
    const gap = cue.startMs - prev.endMs;
    const sameFinal = prev.final === cue.final;
    const combinedSrc = joinFragments(prev.src, cue.src);
    const combinedDst = joinFragments(prev.dst, cue.dst);
    const chars = Math.max(countChars(combinedSrc), countChars(combinedDst));
    const withinChars = charLimit === 0 || chars <= charLimit;
    const shouldMerge = gap >= 0 && gap <= gapLimit && sameFinal && withinChars;
    if (shouldMerge) {
      prev.endMs = Math.max(prev.endMs, cue.endMs);
      prev.src = combinedSrc;
      prev.dst = combinedDst;
      if (prev.id == null) prev.id = cue.id;
    } else {
      merged.push({ ...cue });
    }
  }
  return merged;
}

function formatCueText(cue, { bilingual, maxCps, maxCharsPerLine, maxLines }) {
  const durationMs = Math.max(1, cue.endMs - cue.startMs);
  const lengthCap = effectiveCharsPerLine({ maxCps, maxCharsPerLine, durationMs });
  const linesPerLanguage = Math.max(1, Math.floor(maxLines) || 1);
  if (bilingual !== false && cue.src && cue.dst) {
    // SRT 导出：原文、译文各自最多 maxLines 行（默认 2 行 / 语种），优先保留全部内容
    const srcLines = fitLines(wrapLines(cue.src, { maxCharsPerLine: lengthCap }), linesPerLanguage);
    const dstLines = fitLines(wrapLines(cue.dst, { maxCharsPerLine: lengthCap }), linesPerLanguage);
    return [...srcLines, ...dstLines].join('\n');
  }
  const only = cue.dst || cue.src;
  if (!only) return '';
  return fitLines(wrapLines(only, { maxCharsPerLine: lengthCap }), linesPerLanguage).join('\n');
}

/**
 * 毫秒时间轴 cue 列表 -> SRT 文本。
 * - 默认只导出 final cue（includePartial=false）；需要预览中间结果时传 true。
 * - 同一 cue 的重复更新先按 id 去重（后到覆盖先到），再按 startMs 排序。
 * - 默认不合并相邻 cue（管线里每句一条，合并会破坏「一句一字幕」）；需要合并碎片时传 merge=true。
 * - 时间重叠的 cue 会被顺延到上一条结束（clampOverlaps=true），避免播放器行为异常。
 * @param {Array} cues
 * @param {object} [options]
 * @param {boolean} [options.bilingual=true] 双语导出（原文行 + 译文行）
 * @param {boolean} [options.includePartial=false] 是否导出 final=false 的中间结果
 * @param {number} [options.maxCps=9] 每秒字符预算（用于随时长收紧行长）
 * @param {number} [options.maxCharsPerLine=24] 每行最大字符数
 * @param {number} [options.maxLines=2] 每个语种最多行数（双语时原文/译文各自适用）
 * @param {number} [options.minDurationMs=1] 单条字幕最短时长
 * @param {boolean} [options.clampOverlaps=true] 是否把重叠 cue 顺延
 * @param {boolean} [options.merge=false] 是否合并相邻碎片 cue
 * @param {number} [options.maxGapMs=150] merge=true 时的合并间隔阈值
 * @param {number} [options.maxCharsPerCue=48] merge=true 时的合并字符上限
 * @returns {string} SRT 文本（每条以空行分隔，末尾带换行；无可用 cue 返回 ''）
 */
export function formatSrt(cues, options = {}) {
  const {
    bilingual = true,
    includePartial = false,
    maxCps = 9,
    maxCharsPerLine = 24,
    maxLines = 2,
    minDurationMs = 1,
    clampOverlaps = true,
    merge = false,
    maxGapMs = 150,
    maxCharsPerCue = 48,
  } = options;

  const minDuration = Math.max(1, Math.floor(Number(minDurationMs) || 1));
  let list = dedupeCues(cues, { includePartial, maxCps });
  if (merge) list = mergeCues(list, { maxGapMs, maxCharsPerCue, includePartial });

  const blocks = [];
  let previousEnd = -1;
  for (const cue of list) {
    let start = cue.startMs;
    let end = cue.endMs;
    if (end - start < minDuration) end = start + minDuration;
    if (clampOverlaps && start < previousEnd) {
      start = previousEnd;
      if (end - start < minDuration) end = start + minDuration;
    }
    const text = formatCueText(cue, { bilingual, maxCps, maxCharsPerLine, maxLines });
    if (!text) continue;
    previousEnd = end;
    blocks.push(`${blocks.length + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${text}`);
  }
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}
