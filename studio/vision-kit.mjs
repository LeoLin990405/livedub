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

/** 口播和画面之间的因果关系。只是时间靠近、内容对不上，不算。 */
export const CAUSAL_RELATIONS = Object.freeze({
  visual_prompts_speech: '画面引出讲解',
  speech_prompts_visual: '讲解引出画面',
  speech_explains_visual: '讲解解释画面',
  speech_derives_visual: '讲解推出画面上的结论',
  speech_refers_visual: '口播指向画面',
});

const CAUSAL_STRENGTH = Object.freeze({
  speech_derives_visual: 5,
  speech_explains_visual: 4,
  speech_refers_visual: 3,
  visual_prompts_speech: 2,
  speech_prompts_visual: 2,
});

const CAUSAL_STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'what', 'when', 'where', 'which', 'there', 'their', 'about',
  'into', 'your', 'they', 'them', 'then', 'than', 'will', 'just', 'like', 'some', 'more', 'also', 'been',
  'were', 'would', 'could', 'should', 'because', 'slide', 'shown', 'look', 'means', 'called', 'defined',
  'therefore', 'thus', 'hence', 'here', 'each', 'step', 'size', 'take', 'takes', 'using', 'used',
  '这个', '我们', '一个', '可以', '就是', '如果', '因为', '所以', '然后', '这里', '那个', '没有', '什么',
  '怎么', '以及', '或者', '不是', '已经', '进行', '通过', '当前', '画面', '幻灯',
]);

const EXPLAIN_CUES = [
  /\b(means|is called|defined as|stands for|refers to|that is)\b/i,
  /是指|叫做|称为|也就是|意思是|定义为|用来表示|表示的是/,
];
const DERIVE_CUES = [
  /\b(therefore|thus|hence)\b/i,
  /所以|因此|于是|从而|可得|由此可见/,
];
const REFER_CUES = [
  /\b(this slide|this figure|this diagram|this chart|as shown|shown here|look at the|look at this|on the slide|on the screen)\b/i,
  /如图|这一页|这张图|这幅图|见图|看这页|幻灯片上/,
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clipText(text, max = 90) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function includesTerm(text, term) {
  const hay = String(text ?? '');
  const needle = String(term ?? '').trim();
  if (!needle) return false;
  if (/[\u4e00-\u9fff]/.test(needle)) return hay.includes(needle);
  return new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegExp(needle)}(?:$|[^A-Za-z0-9])`, 'i').test(hay);
}

function hasCue(text, patterns) {
  return patterns.some((pattern) => pattern.test(String(text ?? '')));
}

function contentTerms(text) {
  const raw = String(text ?? '');
  const terms = [];
  const seen = new Set();
  const add = (term) => {
    const clean = String(term ?? '').trim();
    if (clean.length < 2 || clean.length > 40) return;
    const key = clean.toLowerCase();
    if (CAUSAL_STOPWORDS.has(key) || seen.has(key) || /^\d+$/.test(clean)) return;
    seen.add(key);
    terms.push(clean);
  };
  const words = raw.match(/[A-Za-z][A-Za-z0-9_+-]{2,}/g) ?? [];
  for (const word of words) {
    if (word.length >= 4) add(word);
  }
  for (let index = 0; index < words.length - 1; index += 1) {
    const left = words[index];
    const right = words[index + 1];
    if (left.length >= 4 && right.length >= 4) add(`${left} ${right}`);
  }
  for (const chunk of raw.match(/[\u4e00-\u9fff]{2,8}/g) ?? []) add(chunk);
  return terms;
}

function sharedTerms(leftText, rightText) {
  const found = [];
  const seen = new Set();
  for (const term of [...contentTerms(leftText), ...contentTerms(rightText)]) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (includesTerm(leftText, term) && includesTerm(rightText, term)) found.push(term);
  }
  found.sort((left, right) => right.length - left.length);
  return found;
}

function speechText(segment) {
  if (!segment || typeof segment !== 'object') return '';
  return [segment.text, segment.src, segment.translation, segment.dst].filter(Boolean).join('\n');
}

function speechStart(segment) {
  return Math.max(0, Math.round(Number(segment?.t0Ms ?? segment?.tMs) || 0));
}

function speechEnd(segment) {
  const start = speechStart(segment);
  const end = Number(segment?.t1Ms);
  return Number.isFinite(end) ? Math.max(start, Math.round(end)) : start;
}

function visualText(frame) {
  if (!frame || typeof frame !== 'object') return '';
  return [frame.ocrText, frame.caption].filter(Boolean).join('\n');
}

function visualTime(frame) {
  return Math.max(0, Math.round(Number(frame?.tMs) || 0));
}

function makeCausalLink({
  relation,
  evidence = '',
  frame,
  segment,
  distance = 0,
}) {
  const frameTMs = visualTime(frame);
  const segmentT0Ms = speechStart(segment);
  const speechCause = relation !== 'visual_prompts_speech';
  const causeSource = speechCause ? speechText(segment) : visualText(frame);
  const effectSource = speechCause ? visualText(frame) : speechText(segment);
  const sentences = {
    visual_prompts_speech: '画面先出现这个内容，随后口播才讲到它。',
    speech_prompts_visual: '口播先讲到这个内容，随后画面才出现它。',
    speech_explains_visual: '口播在解释画面上的这个内容。',
    speech_derives_visual: '口播推出了画面上的这个结论。',
    speech_refers_visual: '口播明确指向当时的画面。',
  };
  return {
    relation,
    label: CAUSAL_RELATIONS[relation],
    evidence,
    tMs: speechCause ? segmentT0Ms : frameTMs,
    frameTMs,
    segmentT0Ms,
    distance,
    causeKind: speechCause ? 'speech' : 'visual',
    effectKind: speechCause ? 'visual' : 'speech',
    causeText: clipText(causeSource),
    effectText: clipText(effectSource),
    causeSource,
    effectSource,
    sentence: sentences[relation],
    source: 'timeline',
  };
}

/**
 * 从关键帧和字幕里找出因果关系。
 * 画面先出现、口播后讲到同一内容，记为画面引出讲解；方向相反则是讲解引出画面。
 * 解释、推导、指着画面，还要有对应的用语，不能只靠时间靠近。
 */
export function linkSpeechAndVisuals({ frames = [], segments = [], maxLinks = 8 } = {}) {
  const frameList = [...(frames ?? [])]
    .filter((frame) => frame && Number.isFinite(Number(frame.tMs)) && visualText(frame).trim())
    .sort((left, right) => visualTime(left) - visualTime(right));
  const segmentList = [...(segments ?? [])]
    .filter((segment) => speechText(segment).trim())
    .sort((left, right) => speechStart(left) - speechStart(right));
  const candidates = [];

  const termOnEarlierSpeech = (term, frameTMs) => segmentList.some((segment) => (
    speechEnd(segment) < frameTMs - 200 && includesTerm(speechText(segment), term)
  ));
  const termOnEarlierFrame = (term, frameTMs) => frameList.some((frame) => (
    visualTime(frame) < frameTMs - 200 && includesTerm(visualText(frame), term)
  ));

  for (const frame of frameList) {
    const frameTMs = visualTime(frame);
    const seen = visualText(frame);
    for (const segment of segmentList) {
      const start = speechStart(segment);
      const spoken = speechText(segment);
      const shared = sharedTerms(seen, spoken);
      const term = shared[0] ?? '';
      const gap = Math.abs(frameTMs - start);

      if (term && hasCue(spoken, DERIVE_CUES) && gap <= 30000) {
        candidates.push(makeCausalLink({ relation: 'speech_derives_visual', evidence: term, frame, segment, distance: gap }));
      }
      if (term && hasCue(spoken, EXPLAIN_CUES) && gap <= 30000) {
        candidates.push(makeCausalLink({ relation: 'speech_explains_visual', evidence: term, frame, segment, distance: gap }));
      }
      if (hasCue(spoken, REFER_CUES) && gap <= 12000) {
        candidates.push(makeCausalLink({
          relation: 'speech_refers_visual',
          evidence: term,
          frame,
          segment,
          distance: gap,
        }));
      }
      if (term && start >= frameTMs + 400 && start <= frameTMs + 45000 && !termOnEarlierSpeech(term, frameTMs)) {
        candidates.push(makeCausalLink({ relation: 'visual_prompts_speech', evidence: term, frame, segment, distance: start - frameTMs }));
      }
      if (term && frameTMs >= start + 400 && frameTMs <= start + 45000 && !termOnEarlierFrame(term, frameTMs)) {
        candidates.push(makeCausalLink({ relation: 'speech_prompts_visual', evidence: term, frame, segment, distance: frameTMs - start }));
      }
    }
  }

  const refers = new Map();
  const rest = [];
  for (const link of candidates) {
    if (link.relation !== 'speech_refers_visual') {
      rest.push(link);
      continue;
    }
    const previous = refers.get(link.segmentT0Ms);
    if (!previous || link.distance < previous.distance || (link.distance === previous.distance && link.evidence && !previous.evidence)) {
      refers.set(link.segmentT0Ms, link);
    }
  }

  const earliest = [];
  const seenPrompt = new Set();
  const ordered = [...rest, ...refers.values()].sort((left, right) => left.distance - right.distance || left.tMs - right.tMs);
  for (const link of ordered) {
    if (link.relation === 'visual_prompts_speech' || link.relation === 'speech_prompts_visual') {
      const key = `${link.relation}|${link.relation === 'visual_prompts_speech' ? link.frameTMs : link.segmentT0Ms}|${link.evidence.toLowerCase()}`;
      if (seenPrompt.has(key)) continue;
      seenPrompt.add(key);
    }
    earliest.push(link);
  }

  const byPair = new Map();
  for (const link of earliest) {
    const key = `${link.frameTMs}|${link.segmentT0Ms}`;
    const previous = byPair.get(key);
    if (!previous || CAUSAL_STRENGTH[link.relation] > CAUSAL_STRENGTH[previous.relation]) byPair.set(key, link);
  }

  const cap = Math.max(1, Math.min(12, Math.round(Number(maxLinks) || 8)));
  return [...byPair.values()]
    .sort((left, right) => left.tMs - right.tMs || left.frameTMs - right.frameTMs)
    .slice(0, cap);
}

/** 模型给的因果句只有在原话里能对上，并且规则已经认出同一条关系时才采用。 */
export function applyModelCausalLinks(links, modelLinks) {
  const models = Array.isArray(modelLinks) ? modelLinks : [];
  return (links ?? []).map((link) => {
    const match = models.find((item) => {
      if (!item || item.relation !== link.relation) return false;
      const evidence = String(item.evidence ?? '').trim().toLowerCase();
      return evidence && evidence === String(link.evidence ?? '').trim().toLowerCase();
    });
    if (!match) return link;
    const cause = String(match.cause ?? '').trim();
    const effect = String(match.effect ?? '').trim();
    if (!cause || !effect) return link;
    if (!includesTerm(link.causeSource, cause) && !String(link.causeSource).toLowerCase().includes(cause.toLowerCase())) return link;
    if (!includesTerm(link.effectSource, effect) && !String(link.effectSource).toLowerCase().includes(effect.toLowerCase())) return link;
    return {
      ...link,
      causeText: clipText(cause),
      effectText: clipText(effect),
      source: 'model',
    };
  });
}

export function formatCausalBullet(link) {
  const when = timestampAnchor(link.tMs);
  const evidence = link.evidence ? `「${link.evidence}」` : '';
  const causeLabel = link.causeKind === 'visual' ? '画面' : '口播';
  const effectLabel = link.effectKind === 'visual' ? '画面' : '口播';
  return [
    `- ${when} **${link.label}**${evidence ? `：${evidence}` : ''}。${link.sentence}`,
    `  - 因（${causeLabel}）：${link.causeText}`,
    `  - 果（${effectLabel}）：${link.effectText}`,
  ].join('\n');
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
 * - 本节总结 + 要点列表 + 口播与画面的因果关系 + 按时间的画面时间线
 * - includeNotes / includeCausal 默认都开。关掉笔记时不写总结、要点和时间线；关掉因果时不写因果关系。
 * - causalLinks 传入时直接使用（调用方已经按多模型投票合并过），不再重算。
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
  chapter = null,
  modelLinks = [],
  includeNotes = true,
  includeCausal = true,
  causalLinks = null,
  extraNote = '',
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
  if (chapter && Number.isFinite(Number(chapter.index))) {
    lines.push(`> 第 ${Math.max(1, Math.round(Number(chapter.index)))}/${Math.max(1, Math.round(Number(chapter.total) || Number(chapter.index)))} 章 · 范围 ${formatNoteTimestamp(startMs)} – ${formatNoteTimestamp(endMs)}`);
  }
  const noteLine = String(extraNote ?? '').trim();
  if (noteLine) lines.push(`> ${noteLine}`);
  lines.push('');

  if (includeNotes) {
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
  }

  const links = includeCausal
    ? (Array.isArray(causalLinks)
      ? causalLinks
      : applyModelCausalLinks(linkSpeechAndVisuals({ frames: framesList, segments }), modelLinks))
    : [];
  if (includeCausal) {
    lines.push('## 因果关系');
    lines.push('');
    if (links.length === 0) {
      lines.push('（没有识别出口播和画面之间的因果关系。只是时间上挨在一起，不算因果。）');
      lines.push('');
    } else {
      for (const link of links) {
        lines.push(formatCausalBullet(link));
        lines.push('');
      }
    }
  }

  if (!includeNotes) return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;

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
    const frameLinks = links.filter((link) => link.frameTMs === tMs);
    if (frameLinks.length > 0) {
      lines.push(`**因果**：${frameLinks.map((link) => `${link.label}${link.evidence ? `（${link.evidence}）` : ''}`).join('；')}`);
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
