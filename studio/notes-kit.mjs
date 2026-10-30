/**
 * 学习笔记（v0.4）纯函数工具：可在浏览器与 node:test 中直接使用。
 *
 * - 视频身份（video.id 稳定，重开同一视频能看到历史笔记）
 * - 迷你 Markdown 渲染（安全转义，零依赖：标题/列表/粗体/链接/代码块/引用/图片）
 * - 时间戳格式、导出 Markdown（YAML front matter + 时间戳 anchor）、课程大纲
 * - 编辑器辅助：光标插入、标签解析、搜索过滤、快捷键判定
 */

// -------------------------------------------------------------------- 通用

/** FNV-1a 32 位十六进制（稳定、跨浏览器一致，不需要 crypto.subtle） */
export function fnv1aHex(input) {
  const text = String(input ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function safeString(value, maxLength = 2000) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function normalizeUrlForId(rawUrl) {
  const value = String(rawUrl ?? '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    // 忽略 hash（同一视频不同时间锚点视为同一身份）
    url.hash = '';
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return value;
  }
}

/**
 * 生成稳定的 video.id：
 * - 本地文件：name + size（+ 未知 size 时用 duration）hash -> `local-<hex>`
 * - 远程 URL：去掉 hash 的 URL hash -> `url-<hex>`
 * 同一视频重复打开得到相同 id，从而读取历史笔记。
 */
export function makeVideoId({ url = '', name = '', size = null, durationMs = null } = {}) {
  const fileSize = Number.isFinite(Number(size)) && Number(size) >= 0 ? Number(size) : null;
  const fileDuration = Number.isFinite(Number(durationMs)) && Number(durationMs) > 0 ? Math.round(Number(durationMs)) : null;
  const fileName = safeString(name, 300).trim();
  const remote = normalizeUrlForId(url);
  if (fileName && (fileSize != null || !remote)) {
    const basis = `local:${fileName}:${fileSize != null ? fileSize : `dur:${fileDuration ?? 0}`}`;
    return `local-${fnv1aHex(basis)}`;
  }
  if (remote) return `url-${fnv1aHex(remote)}`;
  if (fileName) return `local-${fnv1aHex(`local:${fileName}:${fileDuration ?? 0}`)}`;
  return `unknown-${fnv1aHex('livedub-unknown-video')}`;
}

/** 视频标题：文件名 / URL 最后一段 / fallback */
export function videoTitleFrom({ url = '', name = '' } = {}) {
  const fileName = safeString(name, 300).trim();
  if (fileName) return fileName.length > 120 ? `${fileName.slice(0, 119)}…` : fileName;
  const rawUrl = safeString(url, 2000).trim();
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      const base = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '');
      if (base) return base.length > 120 ? `${base.slice(0, 119)}…` : base;
      return parsed.hostname || '未命名视频';
    } catch {
      const base = rawUrl.split('/').pop() ?? '';
      if (base) return base;
    }
  }
  return '未命名视频';
}

/** 构造 VideoRef（服务端 Notes API 的 video 字段） */
export function buildVideoRef({ id, title, url = '', durationMs = null } = {}) {
  const videoId = safeString(id, 200).trim() || makeVideoId({ url, name: title });
  const video = { id: videoId, title: safeString(title, 300).trim() || videoId };
  const hostUrl = safeString(url, 2000).trim();
  if (hostUrl) video.url = hostUrl;
  const duration = Number(durationMs);
  if (Number.isFinite(duration) && duration > 0) video.durationMs = Math.round(duration);
  return video;
}

// ---------------------------------------------------------------- 时间戳

/** HH:MM:SS */
export function formatNoteTimestamp(ms) {
  return formatClockParts(ms).full;
}

/** MM:SS（列表里更紧凑） */
export function formatShortTimestamp(ms) {
  return formatClockParts(ms).short;
}

function formatClockParts(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const short = `${String(minutes + hours * 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  const full = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return { full, short };
}

/** Markdown 内的时间戳 anchor：[00:12:34](?t=754000) */
export function timestampAnchor(ms) {
  const value = Math.max(0, Math.round(Number(ms) || 0));
  return `[${formatNoteTimestamp(value)}](?t=${value})`;
}

function localDateString(date = new Date()) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ------------------------------------------------------------- Markdown 渲染

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function safeLinkUrl(url) {
  const value = String(url ?? '').trim();
  if (!value) return null;
  if (/^(https?:|mailto:|\/|#|\?t=|\?time=)/i.test(value) || /^[A-Za-z0-9._/-]+$/.test(value)) return value;
  return null;
}

function inlineMarkdown(text) {
  const escaped = escapeHtml(text);
  // 先处理行内代码，避免其中的 * / [ ] 被再次解析（占位保护）
  const codeSlots = [];
  let html = escaped.replace(/`([^`\n]+)`/g, (_, code) => {
    const token = `\u0000CODE${codeSlots.length}\u0000`;
    codeSlots.push(`<code>${code}</code>`);
    return token;
  });
  html = html.replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))*)\)/g, (match, alt, url) => {
    const safe = safeLinkUrl(url);
    if (!safe) return escapeHtml(match);
    return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(alt)}" loading="lazy" />`;
  });
  html = html.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))*)\)/g, (match, label, url) => {
    const safe = safeLinkUrl(url);
    if (!safe) return escapeHtml(label);
    return `<a href="${escapeHtml(safe)}" rel="noopener noreferrer" target="_blank">${label}</a>`;
  });
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/(^|[^~])~~([^~\n]+)~~/g, '$1<del>$2</del>');
  html = html.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => codeSlots[Number(index)] ?? '');
  return html;
}

/**
 * 迷你 Markdown -> HTML（先整体转义，再白名单渲染；零依赖、防 XSS）。
 * 支持：标题、无序/有序列表、粗体/斜体/删除线/行内代码、链接、图片、代码块、引用、分隔线。
 */
export function renderMarkdown(markdown) {
  const source = String(markdown ?? '').replace(/\r\n?/g, '\n');
  if (!source.trim()) return '';
  const lines = source.split('\n');
  const out = [];
  let index = 0;
  let currentList = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${paragraph.map((line) => inlineMarkdown(line.trim())).join('<br />')}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (currentList) {
      out.push(`</${currentList}>`);
      currentList = null;
    }
  };
  const closeLists = closeList;
  const openList = (tag) => {
    if (currentList && currentList !== tag) closeList();
    if (!currentList) {
      out.push(`<${tag}>`);
      currentList = tag;
    }
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      flushParagraph();
      closeLists();
      const lang = trimmed.slice(3).trim().split(/\s+/)[0] ?? '';
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      index += 1; // 跳过结束 fence
      out.push(`<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      closeLists();
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      closeLists();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^([-*_])\s*(\1\s*){2,}$/.test(trimmed)) {
      flushParagraph();
      closeLists();
      out.push('<hr />');
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      flushParagraph();
      closeLists();
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      out.push(`<blockquote>${quoteLines.map((line) => `<p>${inlineMarkdown(line)}</p>`).join('')}</blockquote>`);
      continue;
    }

    const unordered = /^[-*+]\s+(.*)$/.exec(trimmed);
    const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (unordered || ordered) {
      flushParagraph();
      const tag = unordered ? 'ul' : 'ol';
      openList(tag);
      out.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`);
      index += 1;
      continue;
    }

    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  closeLists();
  return out.join('\n');
}

// --------------------------------------------------------------- 笔记内容

/** 解析标签输入（逗号/顿号/分号/换行分隔，去重、限长） */
export function parseTags(text, { maxTags = 20, maxLength = 40 } = {}) {
  const out = [];
  const seen = new Set();
  for (const part of String(text ?? '').split(/[,，、;\n]/)) {
    const tag = part.trim();
    if (!tag) continue;
    const clipped = tag.slice(0, maxLength);
    if (seen.has(clipped)) continue;
    seen.add(clipped);
    out.push(clipped);
    if (out.length >= maxTags) break;
  }
  return out;
}

/** 在光标处插入文本，返回新值与新的光标位置 */
export function insertAtCursor(text, insertion, selectionStart = null, selectionEnd = null) {
  const source = String(text ?? '');
  const insert = String(insertion ?? '');
  const start = Number.isFinite(Number(selectionStart)) ? Math.max(0, Math.min(source.length, Math.floor(Number(selectionStart)))) : source.length;
  const end = Number.isFinite(Number(selectionEnd)) ? Math.max(start, Math.min(source.length, Math.floor(Number(selectionEnd)))) : start;
  const before = source.slice(0, start);
  const after = source.slice(end);
  const needLeading = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
  const needTrailing = after.length > 0 && !after.startsWith('\n') ? '\n' : '';
  const value = `${before}${needLeading}${insert}${needTrailing}${after}`;
  const caret = start + needLeading.length + insert.length;
  return { value, selectionStart: caret, selectionEnd: caret };
}

/** 生成双语引用块（插入当前句时用） */
export function buildQuoteMarkdown(quote) {
  const lines = [];
  if (quote?.src) lines.push(`> 原文：${String(quote.src).trim()}`);
  if (quote?.dst) lines.push(`> 译文：${String(quote.dst).trim()}`);
  return lines.join('\n');
}

/** 从当前字幕/segment 生成 quote 对象（含时间轴） */
export function makeQuote({ src = '', dst = '', t0Ms = null, t1Ms = null } = {}) {
  const quote = {};
  if (Number.isFinite(Number(t0Ms))) quote.t0Ms = Math.max(0, Math.round(Number(t0Ms)));
  if (Number.isFinite(Number(t1Ms))) quote.t1Ms = Math.max(0, Math.round(Number(t1Ms)));
  if (typeof src === 'string' && src.trim()) quote.src = src.slice(0, 2000);
  if (typeof dst === 'string' && dst.trim()) quote.dst = dst.slice(0, 2000);
  return Object.keys(quote).length > 0 ? quote : null;
}

/** 笔记列表过滤（搜索 body/quotes/tags） */
export function filterNotes(notes, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return [...(notes ?? [])];
  return (notes ?? []).filter((note) => {
    const haystack = [
      note?.body ?? '',
      ...(Array.isArray(note?.quotes) ? note.quotes.flatMap((quote) => [quote?.src ?? '', quote?.dst ?? '']) : []),
      ...(Array.isArray(note?.tags) ? note.tags : []),
    ]
      .join('\n')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

/** 按时间轴排序（同时间按创建顺序） */
export function sortNotesByTime(notes) {
  return [...(notes ?? [])].sort((a, b) => {
    const delta = (Number(a?.tMs) || 0) - (Number(b?.tMs) || 0);
    if (delta !== 0) return delta;
    return String(a?.createdAt ?? '').localeCompare(String(b?.createdAt ?? ''));
  });
}

/** 笔记摘要（列表显示） */
export function noteExcerpt(note, maxLength = 120) {
  const rawBody = String(note?.body ?? '');
  // 跳过导出/大纲笔记的 YAML front matter，列表里只显示正文
  const body = rawBody
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .replace(/```[\s\S]*?```/g, ' [代码块] ')
    .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    .replace(/[#>*_`~[\]()!-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (body) return body.length > maxLength ? `${body.slice(0, maxLength - 1)}…` : body;
  const quote = note?.quotes?.[0];
  if (quote?.dst) return quote.dst;
  if (quote?.src) return quote.src;
  return '（空笔记）';
}

/** localStorage key（离线回退） */
export function localNotesKey(videoId) {
  return `livedub.notes.v1:${String(videoId ?? 'unknown')}`;
}

/** 从 videoId 推导 assets 相对路径（导出 Markdown 用） */
export function assetFileName(imageUrl) {
  const match = /\/([A-Za-z0-9._-]+\.png)(?:\?.*)?$/.exec(String(imageUrl ?? ''));
  return match ? match[1] : '';
}

/** 生成单条笔记的 Markdown 片段（导出/插入正文用） */
export function buildNoteMarkdown(note) {
  const lines = [];
  const kindLabels = { note: '笔记', outline: '课程大纲', quick: '快速摘录', marker: '标记', visual: '图文笔记' };
  lines.push(`## ${timestampAnchor(note?.tMs ?? 0)} · ${kindLabels[note?.kind] ?? '笔记'}`);
  lines.push('');
  const body = String(note?.body ?? '').trim();
  lines.push(body || '（空笔记）');
  lines.push('');
  const quotes = Array.isArray(note?.quotes) ? note.quotes : [];
  for (const quote of quotes) {
    const block = buildQuoteMarkdown(quote);
    if (block) lines.push(block);
  }
  if (quotes.length > 0) lines.push('');
  if (Array.isArray(note?.tags) && note.tags.length > 0) lines.push(`标签：${note.tags.join('、')}`);
  if (note?.imageUrl) lines.push(`![截图](${note.imageUrl})`);
  lines.push('');
  return lines.join('\n');
}

/**
 * 生成导出 Markdown：YAML front matter（title/url/date/lang/notes）+ 每条笔记（时间戳 anchor）。
 */
export function buildNotesMarkdown({ video = {}, notes = [], langFrom = 'en', langTo = 'zh', date = new Date() } = {}) {
  const title = String(video?.title ?? video?.id ?? 'livedub 笔记');
  const ordered = sortNotesByTime(notes);
  const lines = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `videoId: ${JSON.stringify(String(video?.id ?? ''))}`,
    ...(video?.url ? [`url: ${JSON.stringify(String(video.url))}`] : []),
    `date: ${localDateString(date)}`,
    `langFrom: ${JSON.stringify(langFrom)}`,
    `langTo: ${JSON.stringify(langTo)}`,
    `notes: ${ordered.length}`,
    `generatedBy: ${JSON.stringify('livedub-studio')}`,
    '---',
    '',
    `# ${title}`,
    '',
  ];
  if (video?.url) lines.push(`> 视频：${video.url}`);
  if (video?.durationMs) lines.push(`> 时长：${formatNoteTimestamp(video.durationMs)}`);
  if (video?.url || video?.durationMs) lines.push('');
  if (ordered.length === 0) {
    lines.push('（还没有笔记）', '');
  } else {
    for (const note of ordered) lines.push(buildNoteMarkdown(note));
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

/** 生成课程大纲（用本次会话 segments + translations；每句一个带时间戳的条目） */
export function buildOutlineMarkdown({ video = {}, segments = [], langFrom = 'en', langTo = 'zh', date = new Date() } = {}) {
  const title = String(video?.title ?? video?.id ?? '未命名视频');
  const list = [...(segments ?? [])]
    .filter((segment) => segment && (segment.text || segment.translation))
    .sort((a, b) => (Number(a.t0Ms) || 0) - (Number(b.t0Ms) || 0));
  const lines = [
    '---',
    `title: ${JSON.stringify(`${title} · 课程大纲`)}`,
    `videoId: ${JSON.stringify(String(video?.id ?? ''))}`,
    ...(video?.url ? [`url: ${JSON.stringify(String(video.url))}`] : []),
    `date: ${localDateString(date)}`,
    `langFrom: ${JSON.stringify(langFrom)}`,
    `langTo: ${JSON.stringify(langTo)}`,
    `segments: ${list.length}`,
    `generatedBy: ${JSON.stringify('livedub-studio')}`,
    '---',
    '',
    `# ${title} · 课程大纲`,
    '',
  ];
  if (list.length === 0) {
    lines.push('（本次会话还没有可用于生成大纲的字幕——先播放视频并开启同传）', '');
    return lines.join('\n');
  }
  let section = 0;
  for (const segment of list) {
    section += 1;
    const start = Math.max(0, Math.round(Number(segment.t0Ms) || 0));
    lines.push(`## ${section}. ${timestampAnchor(start)}`);
    lines.push('');
    if (segment.text) lines.push(`- 原文：${String(segment.text).trim()}`);
    if (segment.translation) lines.push(`- 译文：${String(segment.translation).trim()}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** 导出文件名：<title>-notes-YYYY-MM-DD.md（去掉文件系统非法字符） */
export function buildNoteExportFilename(title, date = new Date(), suffix = 'notes') {
  const base = String(title ?? 'livedub')
    .replace(/\.[^.]+$/, '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'livedub';
  return `${base}-${suffix}-${localDateString(date)}.md`;
}

/** 编辑器快捷键：Ctrl/Cmd+Enter 保存、Ctrl/Cmd+Shift+C 插入代码块（输入框内也可用） */
export function resolveEditorShortcut(event) {
  if (!event) return null;
  const ctrl = Boolean(event.ctrlKey || event.metaKey);
  if (!ctrl || event.altKey) return null;
  if (event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter') return 'save';
  if ((event.shiftKey && (event.code === 'KeyC' || String(event.key ?? '').toLowerCase() === 'c'))) return 'codeblock';
  return null;
}

// ==================================================== v0.6 章节分段 / 课程总览

const CHAPTER_DEFAULTS = Object.freeze({
  minGapMs: 2500,
  minChapterMs: 20000,
  maxChapterMs: 180000,
  maxChapters: 30,
  changeThreshold: 0.035,
  snapMs: 2000,
});

function chapterNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function chapterClamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 章标题：该章范围内第一个有 OCR 的候选帧首行，否则「第 N 章 · hh:mm:ss」 */
function chapterTitleFor(intervals, index, candidates, startMs) {
  const candidatesInRange = candidates.filter((candidate) => candidate.tMs >= startMs && candidate.tMs <= intervals.endMs && String(candidate.ocrText ?? '').trim());
  const first = candidatesInRange[0];
  if (first) {
    const line = String(first.ocrText)
      .split('\n')
      .map((text) => text.trim().replace(/^#+\s*/, '').replace(/[`*_>]/g, '').trim())
      .find(Boolean);
    if (line) return line.slice(0, 48);
  }
  return `第 ${index} 章 · ${formatNoteTimestamp(startMs)}`;
}

/**
 * v0.6 按章节自动分段：
 * - 字幕间隙 > minGapMs（默认 2.5s）处切分；
 * - 关键帧画面变化点（changeRatio >= changeThreshold，默认 0.035）吸附到 ±snapMs 内最近的段边界切分；
 * - 章节最短 minChapterMs（20s，过短合并）、最长 maxChapterMs（180s，按段边界再切）、最多 maxChapters（30）；
 * - 输出 [{index,startMs,endMs,title}]，保证升序、不重叠、覆盖完整范围。
 */
export function computeChapters(segments = [], keyframeCandidates = [], opts = {}) {
  const minGapMs = chapterNumber(opts.minGapMs, CHAPTER_DEFAULTS.minGapMs);
  const minChapterMs = chapterNumber(opts.minChapterMs, CHAPTER_DEFAULTS.minChapterMs);
  const maxChapterMs = Math.max(minChapterMs, chapterNumber(opts.maxChapterMs, CHAPTER_DEFAULTS.maxChapterMs));
  const maxChapters = Math.max(1, Math.round(chapterNumber(opts.maxChapters, CHAPTER_DEFAULTS.maxChapters)));
  const changeThreshold = Number.isFinite(Number(opts.changeThreshold)) ? Number(opts.changeThreshold) : CHAPTER_DEFAULTS.changeThreshold;
  const snapMs = chapterNumber(opts.snapMs, CHAPTER_DEFAULTS.snapMs);

  const segs = (Array.isArray(segments) ? segments : [])
    .filter((segment) => segment && Number.isFinite(Number(segment.t0Ms)))
    .map((segment) => {
      const t0Ms = Math.max(0, Math.round(Number(segment.t0Ms) || 0));
      const t1Ms = Math.max(t0Ms, Math.round(Number(segment.t1Ms) || t0Ms));
      return { t0Ms, t1Ms, text: String(segment.text ?? segment.src ?? ''), translation: String(segment.translation ?? segment.dst ?? '') };
    })
    .sort((a, b) => a.t0Ms - b.t0Ms);

  const candidates = (Array.isArray(keyframeCandidates) ? keyframeCandidates : [])
    .filter((candidate) => candidate && Number.isFinite(Number(candidate.tMs)))
    .map((candidate) => ({
      tMs: Math.max(0, Math.round(Number(candidate.tMs) || 0)),
      changeRatio: Number(candidate.changeRatio) || 0,
      ocrText: String(candidate.ocrText ?? ''),
      imageUrl: candidate.imageUrl ? String(candidate.imageUrl) : '',
    }))
    .sort((a, b) => a.tMs - b.tMs);

  let startMs = 0;
  let endMs = 0;
  if (segs.length > 0) {
    startMs = segs[0].t0Ms;
    endMs = segs.reduce((max, segment) => Math.max(max, segment.t1Ms), segs[0].t1Ms);
  } else if (candidates.length > 0) {
    startMs = candidates[0].tMs;
    endMs = candidates.reduce((max, candidate) => Math.max(max, candidate.tMs), candidates[0].tMs);
  } else {
    return [];
  }
  if (endMs < startMs) endMs = startMs;

  const cuts = new Set();
  for (let index = 1; index < segs.length; index += 1) {
    const gap = segs[index].t0Ms - segs[index - 1].t1Ms;
    if (gap > minGapMs) {
      const cut = chapterClamp(segs[index].t0Ms, startMs, endMs);
      if (cut > startMs && cut < endMs) cuts.add(cut);
    }
  }
  for (const candidate of candidates) {
    if (candidate.changeRatio < changeThreshold) continue;
    let snapped = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const segment of segs) {
      const distance = Math.abs(segment.t0Ms - candidate.tMs);
      if (distance <= snapMs && distance < bestDistance) {
        bestDistance = distance;
        snapped = segment.t0Ms;
      }
    }
    const cut = chapterClamp(snapped ?? candidate.tMs, startMs, endMs);
    if (cut > startMs && cut < endMs) cuts.add(cut);
  }

  let intervals = [{ startMs, endMs }];
  for (const cut of [...cuts].sort((a, b) => a - b)) {
    const last = intervals[intervals.length - 1];
    if (cut > last.startMs && cut < last.endMs) {
      last.endMs = cut;
      intervals.push({ startMs: cut, endMs });
    }
  }

  // 归一化：只保留同时满足左右最短长度的切分（从起点贪心）。
  // 示例：52s 视频在 12/23.36/31.44/40.98s 都有切分时，直接合并会塌成 1 章；
  // 这里保留 23.36s 这一刀 -> 两章（≥20s），其余邻接过短的切分丢弃。
  const selectedIntervals = [];
  let chapterCursor = startMs;
  for (const cut of [...cuts].sort((a, b) => a - b)) {
    if (cut - chapterCursor < minChapterMs) continue;
    if (endMs - cut < minChapterMs) continue;
    selectedIntervals.push({ startMs: chapterCursor, endMs: cut });
    chapterCursor = cut;
  }
  selectedIntervals.push({ startMs: chapterCursor, endMs });
  intervals = selectedIntervals;

  // 拆分超长章节：优先用区间内的字幕段边界，否则按 maxChapterMs 硬切
  const segmentStarts = segs.map((segment) => segment.t0Ms);
  const splitIntervals = [];
  for (const interval of intervals) {
    let cursor = interval.startMs;
    while (interval.endMs - cursor > maxChapterMs) {
      const boundaryCandidates = segmentStarts.filter((t0) => t0 > cursor + minChapterMs && t0 <= cursor + maxChapterMs);
      const cut = boundaryCandidates.length > 0 ? Math.max(...boundaryCandidates) : cursor + maxChapterMs;
      splitIntervals.push({ startMs: cursor, endMs: cut });
      cursor = cut;
    }
    if (interval.endMs > cursor) splitIntervals.push({ startMs: cursor, endMs: interval.endMs });
  }
  intervals = splitIntervals;
  // 超长切分产生的过短尾章并回前一章
  while (intervals.length > 1) {
    const last = intervals[intervals.length - 1];
    if (last.endMs - last.startMs >= minChapterMs) break;
    intervals[intervals.length - 2].endMs = last.endMs;
    intervals.splice(intervals.length - 1, 1);
  }

  // 最多 maxChapters：合并最短章节（优先与后一章合并）
  while (intervals.length > maxChapters) {
    let shortestIndex = 0;
    let shortestLength = Number.POSITIVE_INFINITY;
    for (let index = 0; index < intervals.length; index += 1) {
      const length = intervals[index].endMs - intervals[index].startMs;
      if (length < shortestLength) {
        shortestLength = length;
        shortestIndex = index;
      }
    }
    if (shortestIndex + 1 < intervals.length) {
      intervals[shortestIndex].endMs = intervals[shortestIndex + 1].endMs;
      intervals.splice(shortestIndex + 1, 1);
    } else {
      intervals[shortestIndex - 1].endMs = intervals[shortestIndex].endMs;
      intervals.splice(shortestIndex, 1);
    }
  }

  return intervals.map((interval, index) => ({
    index: index + 1,
    startMs: interval.startMs,
    endMs: interval.endMs,
    title: chapterTitleFor(interval, index + 1, candidates, interval.startMs),
  }));
}

/** 课程总览（kind:'outline'）Markdown：章节时间锚点列表 */
export function buildCourseOverviewMarkdown({ video = {}, chapters = [], generatedAt = new Date() } = {}) {
  const title = String(video?.title ?? video?.id ?? 'livedub 课程');
  const stamp = generatedAt instanceof Date && !Number.isNaN(generatedAt.getTime()) ? generatedAt : new Date();
  const dateText = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')} ${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`;
  const lines = [];
  lines.push(`# ${title} · 课程总览`);
  lines.push('');
  lines.push(`> 视频：${video?.url ? String(video.url) : `\`${String(video?.id ?? '')}\``}`);
  if (video?.durationMs) lines.push(`> 时长：${formatNoteTimestamp(video.durationMs)}`);
  lines.push(`> 共 ${chapters.length} 章 · 生成于 ${dateText} · 每章一篇图文笔记（kind:visual）`);
  lines.push('');
  lines.push('## 章节');
  lines.push('');
  if (chapters.length === 0) {
    lines.push('（还没有章节：先在工作台「图文笔记」里选择「按章节」生成）');
    lines.push('');
  }
  for (const chapter of chapters) {
    const startMs = Math.max(0, Math.round(Number(chapter?.startMs) || 0));
    const endMs = Math.max(startMs, Math.round(Number(chapter?.endMs) || startMs));
    lines.push(`- [${formatNoteTimestamp(startMs)}](?t=${startMs}) · 第 ${chapter?.index ?? 0} 章 ${String(chapter?.title ?? '').trim()}（至 ${formatNoteTimestamp(endMs)}）`);
  }
  lines.push('');
  lines.push('> 点时间锚点可回到视频对应位置；每章图文笔记可在工作台笔记列表搜索「章节」，或在 `/studio/?notes=1` 打开笔记本。');
  lines.push('');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

// ==================================================== v0.7 笔记过滤 / 分组

/** 笔记过滤 chip：all | visual | chapter | overview | quick */
export function matchesNoteFilter(note, filter = 'all') {
  const value = String(filter ?? 'all');
  const tags = Array.isArray(note?.tags) ? note.tags : [];
  if (value === 'all') return true;
  if (value === 'visual') return note?.kind === 'visual';
  if (value === 'chapter') return note?.kind === 'visual' && tags.includes('章节');
  if (value === 'overview') return note?.kind === 'outline' && tags.includes('课程总览');
  if (value === 'quick') return note?.kind === 'quick';
  return true;
}

/**
 * 笔记工作区分组（课程总览 → 章节 → 其他图文 → 快捷 → 其他），空组不输出。
 * 返回 [{id,title,notes}]，每组内按 tMs 升序。
 */
export function groupNotesForDisplay(notes, filter = 'all') {
  const list = (Array.isArray(notes) ? notes : []).filter((note) => note && typeof note === 'object');
  const groups = {
    overview: { id: 'overview', title: '课程总览', notes: [] },
    chapters: { id: 'chapters', title: '章节图文', notes: [] },
    visual: { id: 'visual', title: '图文笔记', notes: [] },
    quick: { id: 'quick', title: '快捷摘录', notes: [] },
    notes: { id: 'notes', title: '其他笔记', notes: [] },
  };
  for (const note of list) {
    if (!matchesNoteFilter(note, filter)) continue;
    const tags = Array.isArray(note.tags) ? note.tags : [];
    if (note.kind === 'outline' && tags.includes('课程总览')) groups.overview.notes.push(note);
    else if (note.kind === 'visual' && tags.includes('章节')) groups.chapters.notes.push(note);
    else if (note.kind === 'visual') groups.visual.notes.push(note);
    else if (note.kind === 'quick') groups.quick.notes.push(note);
    else groups.notes.notes.push(note);
  }
  const order = filter === 'all' ? ['overview', 'chapters', 'visual', 'quick', 'notes'] : Object.keys(groups).filter((key) => groups[key].notes.length > 0);
  const result = [];
  for (const key of order) {
    const group = groups[key];
    if (group.notes.length === 0) continue;
    group.notes.sort((a, b) => (Number(a.tMs) || 0) - (Number(b.tMs) || 0));
    result.push({ id: group.id, title: group.title, notes: group.notes });
  }
  return result;
}
