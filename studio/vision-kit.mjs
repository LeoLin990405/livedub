/**
 * v0.5 图文笔记纯函数：关键帧抽取 / 画面差异 / 拼图布局 / 图文 Markdown 组装。
 * 浏览器与 node:test 共用（无 DOM 依赖；像素处理由调用方传入 RGBA/Uint8 数组）。
 */
import { formatNoteTimestamp, renderMarkdown, timestampAnchor } from './notes-kit.mjs';

export const VISION_DEFAULTS = Object.freeze({
  intervalMs: 6000,
  minChange: 0.035,
  maxFrames: 12,
  sheetSize: 6,
  sheetCols: 2,
  sheetRows: 3,
  sampleWidth: 64,
  sampleHeight: 36,
});

/** 从 /api/config 的 config.vision.keyframe 合并默认关键帧参数（服务端未提供时用默认值） */
export function resolveKeyframeOptions(config) {
  const kf = config?.vision?.keyframe ?? {};
  const positive = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  };
  const maxFrames = Math.min(120, Math.max(1, Math.round(positive(kf.maxFrames, VISION_DEFAULTS.maxFrames))));
  return {
    intervalMs: Math.min(120000, Math.max(1000, Math.round(positive(kf.intervalMs, VISION_DEFAULTS.intervalMs)))),
    minChange: Number.isFinite(Number(kf.minChange)) && Number(kf.minChange) >= 0 ? Number(kf.minChange) : VISION_DEFAULTS.minChange,
    maxFrames,
    sheetSize: Math.min(12, Math.max(2, Math.round(positive(kf.sheetSize, VISION_DEFAULTS.sheetSize)))),
    sampleWidth: VISION_DEFAULTS.sampleWidth,
    sampleHeight: VISION_DEFAULTS.sampleHeight,
  };
}

/** RGBA 像素（长度为 w*h*4）-> 0..255 灰度数组（未给 alpha 时按不透明处理） */
export function toGrayscale(rgba, width, height) {
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  const pixels = rgba ?? [];
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const r = Number(pixels[i * 4] ?? 0);
    const g = Number(pixels[i * 4 + 1] ?? r);
    const b = Number(pixels[i * 4 + 2] ?? r);
    out[i] = Math.max(0, Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b)));
  }
  return out;
}

/** 两帧灰度图的平均差异（0..1）；长度不同时取较短长度比较，空帧返回 1 */
export function frameChangeRatio(previousGray, nextGray) {
  if (!previousGray || !nextGray || previousGray.length === 0 || nextGray.length === 0) return 1;
  const length = Math.min(previousGray.length, nextGray.length);
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += Math.abs(Number(nextGray[i]) - Number(previousGray[i]));
  return sum / length / 255;
}

/** 明显变化的像素占比（|diff| > threshold/255），用于识别幻灯片/画面切换 */
export function changedPixelRatio(previousGray, nextGray, threshold = 24) {
  if (!previousGray || !nextGray || previousGray.length === 0 || nextGray.length === 0) return 1;
  const length = Math.min(previousGray.length, nextGray.length);
  const limit = Math.max(0, Number(threshold) || 0);
  let changed = 0;
  for (let i = 0; i < length; i += 1) {
    if (Math.abs(Number(nextGray[i]) - Number(previousGray[i])) > limit) changed += 1;
  }
  return changed / length;
}

/**
 * 去重判定：第一帧总是接受；之后满足任一条件即接受：
 * - 平均灰度差异 >= minChange（默认 3.5%）
 * - 或明显变化像素占比 >= structuralMin（默认 3%，用于识别暗色幻灯片切换）
 */
export function shouldAcceptFrame(previousGray, nextGray, minChange = VISION_DEFAULTS.minChange, { structuralMin = 0.03 } = {}) {
  if (!previousGray) return true;
  if (frameChangeRatio(previousGray, nextGray) >= Number(minChange)) return true;
  return changedPixelRatio(previousGray, nextGray) >= Math.max(0.005, Number(structuralMin) || 0.03);
}

/**
 * 生成候选采样时间点（含首尾）：每 intervalMs 一个，最多 maxCandidates 个。
 * 超出时自动增大步长，避免长视频产生上千次 seek。
 */
export function sampleTimes({ startMs = 0, endMs = 0, intervalMs = VISION_DEFAULTS.intervalMs, maxCandidates = 96 } = {}) {
  const start = Math.max(0, Math.round(Number(startMs) || 0));
  const end = Math.max(start, Math.round(Number(endMs) || 0));
  const interval = Math.max(500, Math.round(Number(intervalMs) || VISION_DEFAULTS.intervalMs));
  const cap = Math.max(2, Math.round(Number(maxCandidates) || 96));
  const total = end - start;
  if (total <= 0) return [start];
  const rough = Math.floor(total / interval) + 1;
  const step = rough > cap ? total / (cap - 1) : interval;
  const times = [];
  for (let t = start; t < end && times.length < cap - 1; t += step) times.push(Math.round(t));
  times.push(end);
  return times;
}

/**
 * 2x3（可配）拼图布局：返回每个格子的像素矩形与标签锚点。
 * 用于 canvas 画 contact sheet，再把拼图交给 VLM 理解。
 */
export function contactSheetLayout(count, { cols = VISION_DEFAULTS.sheetCols, rows = VISION_DEFAULTS.sheetRows, width = 1280, height = 960, gap = 8, labelHeight = 22 } = {}) {
  const total = Math.max(0, Math.round(Number(count) || 0));
  const columns = Math.max(1, Math.round(Number(cols) || 2));
  const rowCount = Math.max(1, Math.ceil(total / columns));
  const sheetWidth = Math.max(64, Math.round(Number(width) || 1280));
  const sheetHeight = Math.max(48, Math.round(Number(height) || 960));
  const spacing = Math.max(0, Math.round(Number(gap) || 0));
  const cellWidth = Math.floor((sheetWidth - spacing * (columns + 1)) / columns);
  const cellHeight = Math.floor((sheetHeight - spacing * (rowCount + 1)) / rowCount);
  const slots = [];
  for (let index = 0; index < total; index += 1) {
    const col = index % columns;
    const row = Math.floor(index / columns);
    slots.push({
      index,
      x: spacing + col * (cellWidth + spacing),
      y: spacing + row * (cellHeight + spacing),
      width: cellWidth,
      height: Math.max(1, cellHeight - labelHeight),
      labelHeight,
      labelY: spacing + row * (cellHeight + spacing) + cellHeight - labelHeight + 16,
    });
  }
  return {
    cols: columns,
    rows: rowCount,
    width: sheetWidth,
    height: sheetHeight,
    cellWidth,
    cellHeight,
    slots,
  };
}

/** 取与 tMs 重叠/最近的 segment（图文时间线引用该时段双语字幕） */
export function nearestSegment(segments, tMs) {
  const list = (segments ?? []).filter((segment) => segment && (segment.text || segment.translation));
  if (list.length === 0) return null;
  const target = Number(tMs) || 0;
  let best = null;
  let bestDistance = Infinity;
  for (const segment of list) {
    const t0 = Number(segment.t0Ms) || 0;
    const t1 = Number(segment.t1Ms) || t0;
    const distance = target < t0 ? t0 - target : target > t1 ? target - t1 : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = segment;
    }
  }
  return best;
}

/** 图文笔记 tags：至少含「图文笔记」；VLM 开启时额外标记 */
export function visualNoteTags({ vlm = false, extra = [] } = {}) {
  const tags = ['图文笔记'];
  if (vlm) tags.push('画面理解');
  for (const tag of Array.isArray(extra) ? extra : []) {
    const value = String(tag ?? '').trim();
    if (value && !tags.includes(value)) tags.push(value);
    if (tags.length >= 20) break;
  }
  return tags;
}

/**
 * 组装 kind:'visual' 的图文笔记 Markdown：
 * - 不重复 YAML front matter（Notes 导出时由服务端统一生成）
 * - 本节总结 + 要点列表 + 按时间的画面时间线（截图/画面文字/画面理解/双语引用）
 */
export function buildVisualNoteMarkdown({
  title = '',
  summary = '',
  keyPoints = [],
  frames = [],
  segments = [],
  range = { startMs: 0, endMs: 0 },
  langFrom = 'en',
  langTo = 'zh',
  generatedAt = new Date(),
  vlm = false,
} = {}) {
  const heading = String(title ?? '').trim() || '视频图文笔记';
  const framesList = [...(frames ?? [])]
    .filter((frame) => frame && Number.isFinite(Number(frame.tMs)))
    .sort((a, b) => Number(a.tMs) - Number(b.tMs));
  const points = (Array.isArray(keyPoints) ? keyPoints : []).map((point) => String(point ?? '').trim()).filter(Boolean);
  const startMs = Math.max(0, Math.round(Number(range?.startMs) || 0));
  const endMs = Math.max(startMs, Math.round(Number(range?.endMs) || 0));
  const stamp = generatedAt instanceof Date && !Number.isNaN(generatedAt.getTime()) ? generatedAt : new Date();
  const dateText = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')} ${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`;

  const lines = [];
  lines.push(`# ${heading} · 图文笔记`);
  lines.push('');
  lines.push(
    `> 时间范围 ${formatNoteTimestamp(startMs)} – ${formatNoteTimestamp(endMs)} · ${framesList.length} 个关键帧 · ${langFrom} → ${langTo} · 生成于 ${dateText}`,
  );
  lines.push('> 由 livedub 本地工作台生成：音频字幕 + 画面 OCR' + (vlm ? ' + VLM 画面理解' : '') + '，原文与截图均保存在本机。');
  lines.push('');

  lines.push('## 本节总结');
  lines.push('');
  const summaryText = String(summary ?? '').trim();
  if (summaryText) {
    lines.push(summaryText);
  } else {
    const fallback = points.length > 0 ? points.slice(0, 3).join('；') : '（视频模型未返回总结，可在此补充）';
    lines.push(fallback);
  }
  lines.push('');

  lines.push('## 要点');
  lines.push('');
  if (points.length > 0) for (const point of points) lines.push(`- ${point}`);
  else lines.push('- （暂无需点，可在此补充）');
  lines.push('');

  lines.push('## 画面时间线');
  lines.push('');
  if (framesList.length === 0) {
    lines.push('（范围内没有抽取到关键帧：可能是视频太短或画面几乎没有变化）');
    lines.push('');
  }
  for (const frame of framesList) {
    const tMs = Math.max(0, Math.round(Number(frame.tMs) || 0));
    lines.push(`### ${timestampAnchor(tMs)} · 画面`);
    lines.push('');
    if (frame.imageUrl) lines.push(`![画面 ${formatNoteTimestamp(tMs)}](${frame.imageUrl})`);
    if (frame.imageUrl) lines.push('');
    const ocrText = String(frame.ocrText ?? '').trim();
    if (ocrText) {
      lines.push('**画面文字（OCR）**');
      lines.push('');
      lines.push('```text');
      for (const line of ocrText.split('\n').slice(0, 60)) lines.push(line);
      lines.push('```');
      lines.push('');
    }
    const caption = String(frame.caption ?? '').trim();
    if (vlm && caption) {
      lines.push('**画面理解（VLM）**');
      lines.push('');
      lines.push(caption);
      lines.push('');
    }
    const segment = frame.segment ?? nearestSegment(segments, tMs);
    if (segment?.text) {
      lines.push('**双语字幕**');
      lines.push('');
      lines.push(`> 原文：${String(segment.text).trim()}`);
      if (segment.translation) lines.push(`> 译文：${String(segment.translation).trim()}`);
      lines.push('');
    }
    if (frame.tags?.length) {
      lines.push(`标签：${frame.tags.join('、')}`);
      lines.push('');
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** 从 Markdown 里提取图片 URL（图文笔记列表多图缩略图用） */
export function extractImageUrls(markdown) {
  const urls = [];
  const seen = new Set();
  for (const match of String(markdown ?? '').matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const url = match[1];
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/** 规范化 /api/vision/health 结果，供 UI 按钮可用性/提示使用 */
export function normalizeVisionHealth(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const ocr = body.ocr && typeof body.ocr === 'object' ? body.ocr : {};
  const vision = body.vision && typeof body.vision === 'object' ? body.vision : {};
  const ocrAvailable = ocr.available !== false && (ocr.available === true || Boolean(ocr.provider));
  const visionAvailable = vision.available !== false && (vision.available === true || Boolean(vision.provider));
  const available = body.ok !== false && (body.ready === true || ocrAvailable || visionAvailable);
  const provider = ocr.provider ?? vision.provider ?? null;
  return {
    available,
    ready: Boolean(body.ready ?? available),
    ocrAvailable,
    visionAvailable,
    provider,
    visionProvider: vision.provider ?? null,
    reason: String(body.reason ?? body.message ?? ''),
    raw: body,
  };
}

/** 视频范围内 transcript 收集（供 summarize 请求体） */
export function collectTranscript(segments, { startMs = 0, endMs = Number.POSITIVE_INFINITY, limit = 200 } = {}) {
  const start = Math.max(0, Number(startMs) || 0);
  const end = Math.max(start, Number(endMs) || Number.POSITIVE_INFINITY);
  const out = [];
  for (const segment of segments ?? []) {
    if (!segment || (!segment.text && !segment.translation)) continue;
    const t0 = Math.max(0, Math.round(Number(segment.t0Ms) || 0));
    const t1 = Math.max(t0, Math.round(Number(segment.t1Ms) || t0));
    if (t1 < start || t0 > end) continue;
    out.push({ t0Ms: t0, t1Ms: t1, src: String(segment.text ?? ''), dst: String(segment.translation ?? '') });
    if (out.length >= limit) break;
  }
  return out;
}

/** 标记 Markdown 的图片数量（笔记列表徽标用） */
export function countVisualImages(markdown) {
  return extractImageUrls(markdown).length;
}
