/**
 * livedub v0.5 视觉能力层：本地 OCR + 视觉大模型（OpenAI 兼容 image_url）+ 文本总结。
 *
 * 契约（docs/CONTRACTS.md v1 + task-20）：
 *   createVisionService({ config, log, fetchImpl, spawnImpl }) -> {
 *     ocr({ png, timeoutMs })
 *       -> Promise<{ text, lines: [{text, confidence?}], provider, ms }>          // 本地，快（~0.7-1.3s/帧）
 *     analyze({ png, mode: 'ocr'|'vision'|'both', prompt?, maxTokens?, timeoutMs? })
 *       -> Promise<{ mode, ocr?, caption?: {text, provider, model, ms}, provider, model?, ms, warnings? }>
 *     analyzeSheet({ png, prompt?, maxTokens? })                                 // 2x3 拼图一次理解（供多帧批量）
 *     summarize({ title, transcript, visuals, lang })
 *       -> Promise<{ summary, keyPoints, provider, model, ms, input }>            // 文本 LLM（deepseek）
 *     health() -> { ocr: {ok, provider, bin, ...}, vision: {configured, provider, model, ...}, ready }
 *     dispose(): Promise<{ ok: true }>
 *   }
 *
 * 设计要点：
 * - **零 npm 依赖**：Node 内置 fs/child_process + 系统 OCR（macOS Vision 编译出的 data/bin/ocr-macos）+ 可选 tesseract；
 * - OCR 优先 macOS Vision（accurate，中英混排实测可用）；二进制缺失时**懒编译一次**（scripts/build-ocr.sh）；
 *   编译失败/OCR 失败自动回退 tesseract（本机仅 eng，会在返回里注明语言限制）；
 * - VLM 走 OpenAI 兼容 chat/completions：`messages[].content` 里放 `{type:'image_url', image_url:{url:'data:image/png;base64,...'}}`；
 *   慢（单帧 ~21s、6 帧拼图 ~28-30s），只用于按需/后台批量，不参与实时链路；
 * - summarize 有字符预算裁剪（transcript/OCR 截断，保留首尾，防止超长又省钱）；
 * - **绝不打印 apiKey / 不把图片 base64 写日志**；日志一律走传入的 log()；
 * - fetchImpl / spawnImpl 可注入，tests/vision.test.mjs 用 fake 覆盖成功/失败/超时/回退，不联网。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

import { deepMerge, projectPath, resolveProvider } from '../config.mjs';

/* ------------------------------------------------------------------ *
 * 默认配置（Lead 会在 config/livedub.config.json 写 vision.*；这里内置默认值）
 * ------------------------------------------------------------------ */

const DEFAULT_VISION_PROMPT = [
  '你是教学视频的画面理解助手。请用中文描述这张视频画面里**真实可见**的内容，输出简洁的分点结构：',
  '1) 画面类型（幻灯片 / 代码 / 图表 / 公式 / 终端 / 网页或其他）；',
  '2) 画面标题与关键文字（原样保留英文术语、公式、代码标识符）；',
  '3) 图表/公式/代码在表达什么（如坐标轴、趋势、算法步骤、变量含义）；',
  '4) 用 2-4 句话概括这一页在讲什么。',
  '只描述画面中能看到的信息，看不清就写“不清晰”，不要编造不存在的文字。总长度控制在 300 字以内。',
].join('\n');

const DEFAULT_SHEET_PROMPT = [
  '这是一张由多张视频关键帧按网格拼成的图（从左到右、从上到下按时间顺序）。',
  '请用中文逐格描述每一格的画面（标题/关键文字/图表或代码要点），并在最后用 2-3 句话概括这几帧合起来在讲什么。',
  '英文术语、公式、代码标识符保留原文；看不清的格子写“不清晰”。总长度控制在 500 字以内。',
].join('\n');

const DEFAULT_SUMMARY_SYSTEM_PROMPT = [
  '你是课程笔记助手，擅长把教学视频的字幕和画面信息整理成可复习的中文结构化总结。',
  '必须只输出一个严格 JSON 对象，不要 markdown 代码围栏、不要额外解释：',
  '{"summary":"150-300 字的中文总结","keyPoints":["要点1","要点2","要点3"],"links":[{"relation":"visual_prompts_speech","evidence":"输入里的原词","cause":"因的原句片段","effect":"果的原句片段"}]}',
  'keyPoints 要 3-6 条、每条 15-60 字，包含关键术语/公式/代码名/数字，具体可复习；不要空泛套话，不要编造输入里没有的内容。',
  'links 是口播和画面的因果关系，0-6 条。relation 只能是 visual_prompts_speech（画面先出现，随后口播才讲）、speech_prompts_visual（口播先讲，随后画面才出现）、speech_explains_visual（口播在解释画面）、speech_derives_visual（口播推出画面上的结论）、speech_refers_visual（口播明确指向画面）。',
  'evidence、cause、effect 必须是输入里的原词或原句片段，不能改写。只是时间靠近但内容对不上时，links 用空数组。',
].join('\n');

export const DEFAULT_VISION_CONFIG = Object.freeze({
  /** 视觉大模型 provider（~/.sayless/config.json 里的名字），默认 ark-plan */
  provider: 'ark-plan',
  model: 'doubao-seed-2-1-turbo-260628',
  maxTokens: 800,
  /** VLM 很慢：单帧 ~21s、拼图 ~28-30s，超时给足 */
  timeoutMs: 90000,
  prompt: DEFAULT_VISION_PROMPT,
  ocr: {
    provider: 'macos-vision',
    bin: 'data/bin/ocr-macos',
    /** 单次 spawn 超时（负载/冷启动时可能较慢，30s）；serve 单帧超时默认同样跟随此值 */
    timeoutMs: 30000,
    /** tesseract 兜底超时（20s，仅英文） */
    tesseractTimeoutMs: 20000,
    /** 实测：中英混排截图 zh-Hans 优先比 en-US 优先后多识别出中文行（demo 里中文副标题只在 zh-Hans 优先时出现） */
    languages: ['zh-Hans', 'en-US'],
    minConfidence: 0,
    fallback: ['tesseract'],
    /** 二进制缺失时允许懒编译一次（scripts/build-ocr.sh） */
    lazyBuild: true,
    buildScript: 'scripts/build-ocr.sh',
    /** tesseract 兜底语言；本机只有 eng（无 chi_sim），会在结果里注明 */
    tesseractLanguages: ['eng'],
    /**
     * 常驻 serve 子进程：逐帧 OCR 时复用同一进程（Vision/框架只初始化一次），
     * 实测单次 spawn 进程启动 1-6s，serve 第 2 帧起 <1.5s。
     */
    serve: {
      enabled: true,
      /** 等 ready 行（进程启动 + Vision 框架初始化） */
      startupTimeoutMs: 15000,
      /** 单帧请求超时；不设则跟随 vision.ocr.timeoutMs（默认 30s）。超时会重启 serve 并重试一次 */
      timeoutMs: null,
      /** 崩溃后自动重启次数上限；超过则本会话停用 serve 回退单次 spawn */
      maxRestarts: 1,
    },
  },
  summary: {
    provider: 'deepseek',
    model: 'deepseek-flash',
    maxTokens: 900,
    timeoutMs: 60000,
    /** 输入预算（字符数，约 2 字符/token 的粗估）：transcript 与画面文字总长上限 */
    maxInputChars: 12000,
  },
  keyframe: {
    intervalMs: 6000,
    minChange: 0.035,
    maxFrames: 24,
  },
});

/** 深拷贝默认值后合并用户的 config.vision（数组整体替换） */
export function mergeVisionConfig(config) {
  const base = typeof structuredClone === 'function' ? structuredClone(DEFAULT_VISION_CONFIG) : JSON.parse(JSON.stringify(DEFAULT_VISION_CONFIG));
  const override = config && typeof config.vision === 'object' && config.vision !== null ? config.vision : {};
  return deepMerge(base, override);
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const MAX_TRANSCRIPT_ITEMS = 200;
const MAX_VISUAL_ITEMS = 80;
const MAX_PROCESS_STDOUT = 8 * 1024 * 1024;
const MAX_PROCESS_STDERR = 64 * 1024;
const MAX_ERROR_BODY = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readableError(message, cause) {
  const err = cause === undefined ? new Error(message) : new Error(message, { cause });
  err.livedubReadable = true;
  return err;
}

function isAbortError(err) {
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
}

function positiveNumber(value, fallback, hardFallback = 0) {
  const v = Number(value);
  if (Number.isFinite(v) && v > 0) return v;
  const f = Number(fallback);
  if (Number.isFinite(f) && f > 0) return f;
  return hardFallback;
}

function absify(p) {
  if (typeof p !== 'string' || !p) return p;
  return path.isAbsolute(p) ? p : projectPath(p);
}

function safeExists(p) {
  try {
    return Boolean(p) && fs.existsSync(p);
  } catch {
    return false;
  }
}

function executableExists(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 判断 buffer 是 PNG 还是 JPEG（写临时文件时用正确扩展名） */
function imageMimeOf(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mime: 'image/png', ext: '.png', ok: true };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', ext: '.jpg', ok: true };
  }
  return { mime: 'application/octet-stream', ext: '.png', ok: false };
}

/**
 * 把调用方传的「图片」规整成 Buffer。
 * 支持：Buffer / Uint8Array / ArrayBuffer / data URL / base64 字符串 / 本地文件路径。
 * 拒绝空值与不认识的内容（错误信息说明下一步怎么传）。
 */
function normalizeImageInput(input) {
  if (Buffer.isBuffer(input)) {
    if (!input.length) throw readableError('图片为空：请传入非空 PNG/JPEG 数据（canvas.toBlob 或 fs.readFileSync 的结果）');
    return input;
  }
  if (input instanceof Uint8Array) {
    if (!input.length) throw readableError('图片为空：请传入非空 PNG/JPEG 数据');
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) {
    if (!input.byteLength) throw readableError('图片为空：请传入非空 PNG/JPEG 数据');
    return Buffer.from(input);
  }
  if (typeof input === 'string' && input.trim()) {
    const value = input.trim();
    const dataUrl = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(value);
    if (dataUrl) {
      const buf = Buffer.from(dataUrl[2], 'base64');
      if (!buf.length) throw readableError('图片 data URL 解码为空：请检查 base64 内容是否完整');
      return buf;
    }
    if (safeExists(value)) return fs.readFileSync(value);
    // 无前缀的 base64：仅当解码后是 PNG/JPEG 时接受，避免把普通字符串误当图片
    if (/^[A-Za-z0-9+/=\s]+$/.test(value) && value.length >= 32) {
      const buf = Buffer.from(value.replace(/\s+/g, ''), 'base64');
      if (buf.length && imageMimeOf(buf).ok) return buf;
    }
    throw readableError(`无法识别图片输入（既不是存在的文件，也不是 base64/data URL）：${value.slice(0, 80)}；请传 PNG Buffer 或本地文件路径`);
  }
  throw readableError('ocr({png}) / analyze({png}) 需要 PNG/JPEG：传 Buffer、Uint8Array、data URL、base64 或本地文件路径');
}

/** 毫秒 -> [mm:ss] / [hh:mm:ss] */
export function formatClock(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function truncateChars(text, maxChars) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!maxChars || value.length <= maxChars) return value;
  return value.slice(0, Math.max(0, maxChars - 1)) + '…';
}

/** 从进程 stdout 里提取第一个 JSON 对象（容忍前后杂讯） */
function extractJsonObject(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 从 OpenAI 兼容返回里拿 content（字符串或 content parts 数组） */
export function extractChatContent(data) {
  const choice = data?.choices?.[0];
  const message = choice?.message ?? choice?.delta ?? null;
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

function extractApiError(data) {
  if (!data || typeof data !== 'object') return '';
  const error = data.error;
  if (error && typeof error === 'object') {
    const code = error.code ?? error.type ?? '';
    const message = error.message ?? error.msg ?? JSON.stringify(error).slice(0, MAX_ERROR_BODY);
    return `${code ? `${code}: ` : ''}${message}`;
  }
  if (typeof error === 'string') return error;
  if (typeof data.message === 'string') return data.message;
  if (typeof data.__raw === 'string') return data.__raw.slice(0, MAX_ERROR_BODY);
  return '';
}

function friendlyHttpError(label, status, apiMessage) {
  const detail = apiMessage ? `（服务端：${apiMessage.slice(0, MAX_ERROR_BODY)}）` : '';
  if (status === 401 || status === 403) {
    return readableError(`${label}鉴权失败（HTTP ${status}）${detail}；请检查 ~/.sayless/config.json 里对应 provider 的 apiKey 是否有效（或设置 LIVEDUB_PROVIDER_<NAME>_API_KEY），不要在日志/截图里暴露 Key`);
  }
  if (status === 404) {
    return readableError(`${label}接口或模型不存在（HTTP 404）${detail}；请检查 config.vision.model 与 provider 的 baseUrl/chatPath 是否与官方文档一致`);
  }
  if (status === 429) {
    return readableError(`${label}被限流（HTTP 429）${detail}；稍等几秒重试，或改用批量模式（拼图一次分析多帧）`);
  }
  if (status >= 500) {
    return readableError(`${label}服务端错误（HTTP ${status}）${detail}；稍后重试，若持续失败检查 provider 状态页`);
  }
  return readableError(`${label}请求失败（HTTP ${status || 'unknown'}）${detail}`);
}

/* ------------------------------------------------------------------ *
 * summarize 输入构建 / 输出解析（导出给单测）
 * ------------------------------------------------------------------ */

/**
 * 按字符预算裁剪一组已格式化的行：保留首尾（课程总结需要开头背景 + 结尾结论），从中间抽掉。
 * @returns {{ lines: string[], truncated: boolean, removed: number }}
 */
function fitLinesToBudget(lines, budget) {
  const totalChars = (list) => list.reduce((sum, line) => sum + line.length + 1, 0);
  if (totalChars(lines) <= budget) return { lines, truncated: false, removed: 0 };
  const kept = [...lines];
  let removed = 0;
  while (kept.length > 2 && totalChars(kept) + 40 > budget) {
    const mid = Math.floor(kept.length / 2);
    kept.splice(mid, 1);
    removed += 1;
  }
  if (removed > 0) {
    const marker = `…（中间省略 ${removed} 条，保留首尾）…`;
    kept.splice(Math.floor(kept.length / 2), 0, marker);
  }
  return { lines: kept, truncated: removed > 0, removed };
}

/**
 * 构建 summarize 的输入消息与裁剪统计（纯函数，便于单测断言预算裁剪）。
 *
 * @param {{title?: string, transcript?: Array, visuals?: Array, lang?: string,
 *          maxInputChars?: number, systemPrompt?: string}} options
 * @returns {{ messages: Array<{role:string,content:string}>, stats: object }}
 */
export function buildSummaryInput({
  title = '',
  transcript = [],
  visuals = [],
  lang = 'zh',
  maxInputChars = DEFAULT_VISION_CONFIG.summary.maxInputChars,
  systemPrompt = DEFAULT_SUMMARY_SYSTEM_PROMPT,
} = {}) {
  const budget = positiveNumber(maxInputChars, DEFAULT_VISION_CONFIG.summary.maxInputChars);
  const language = String(lang || 'zh');
  const chinese = !/^en/i.test(language);

  const transcriptLines = [];
  for (const item of Array.isArray(transcript) ? transcript.slice(0, MAX_TRANSCRIPT_ITEMS) : []) {
    if (!item || typeof item !== 'object') continue;
    const src = truncateChars(item.src, 300);
    const dst = truncateChars(item.dst, 300);
    if (!src && !dst) continue;
    const clock = formatClock(item.t0Ms ?? 0);
    const end = item.t1Ms != null ? `-${formatClock(item.t1Ms)}` : '';
    transcriptLines.push(`[${clock}${end}] ${src}${dst ? ` → ${dst}` : ''}`);
  }

  const visualLines = [];
  for (const item of Array.isArray(visuals) ? visuals.slice(0, MAX_VISUAL_ITEMS) : []) {
    if (!item || typeof item !== 'object') continue;
    const ocrText = truncateChars(item.ocrText, 500).replace(/\s+/g, ' ');
    const caption = truncateChars(item.caption ?? item.captionText, 400).replace(/\s+/g, ' ');
    if (!ocrText && !caption) continue;
    const clock = formatClock(item.tMs ?? 0);
    const parts = [];
    if (ocrText) parts.push(`画面文字：${ocrText}`);
    if (caption) parts.push(`画面理解：${caption}`);
    visualLines.push(`[${clock}] ${parts.join(' | ')}`);
  }

  // 预算：固定说明文字先扣掉，剩余按 65% 字幕 / 35% 画面分配
  const header = [
    `## 视频标题`,
    truncateChars(title, 200) || '（未提供）',
    '',
    `## 双语字幕（按时间，src=原声 → dst=中文）`,
  ].join('\n');
  const visualsHeader = '\n\n## 画面文字 / 画面理解（按时间）\n';
  const fixedChars = systemPrompt.length + header.length + visualsHeader.length + 400;
  const remaining = Math.max(500, budget - fixedChars);
  const transcriptBudget = visualLines.length ? Math.floor(remaining * 0.65) : remaining;
  const visualBudget = visualLines.length ? Math.floor(remaining * 0.35) : 0;

  const transcriptFit = fitLinesToBudget(transcriptLines, transcriptBudget);
  const visualFit = fitLinesToBudget(visualLines, visualBudget);

  const user = [
    header,
    transcriptFit.lines.join('\n') || '（无字幕）',
    visualsHeader,
    visualFit.lines.join('\n') || '（无画面信息）',
    '',
    chinese
      ? '请根据以上材料输出严格 JSON：summary（150-300 字中文总结）+ keyPoints（3-6 条中文要点）+ links（0-6 条口播与画面的因果关系；没有把握就给空数组）。'
      : 'Please output strict JSON: summary (150-300 words) + keyPoints (3-6 items) + links (0-6 causal relations between speech and visuals; use an empty array when unsure).',
  ].join('\n');

  const stats = {
    transcriptItems: transcriptLines.length,
    visualItems: visualLines.length,
    transcriptKept: transcriptFit.lines.length,
    visualKept: visualFit.lines.length,
    truncated: transcriptFit.truncated || visualFit.truncated,
    chars: user.length,
    maxInputChars: budget,
  };

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: user },
    ],
    stats,
  };
}

/** 从 summarize 的输出中解析 {summary, keyPoints}（容忍代码围栏/前后解释/非 JSON） */
export function parseSummaryOutput(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) return { summary: '', keyPoints: [], links: [] };

  const withoutFence = raw
    .replace(/^```(?:json|JSON)?\s*/, '')
    .replace(/\s*```$/, '')
    .trim();
  const candidate = extractJsonObject(withoutFence);
  if (candidate && typeof candidate.summary === 'string') {
    const summary = candidate.summary.trim();
    const keyPoints = normalizeKeyPoints(candidate.keyPoints);
    if (summary) return { summary, keyPoints, links: normalizeCausalLinks(candidate.links) };
  }

  // 兜底：非 JSON 时把整段当 summary，把行首为 -/*/数字的短行当要点
  const lines = withoutFence.split('\n').map((line) => line.trim());
  const bulletLines = [];
  const summaryLines = [];
  for (const line of lines) {
    if (!line) continue;
    const match = /^([-*•]|\d+[.、)])\s*(.+)$/.exec(line);
    if (match && match[2].trim().length >= 4) bulletLines.push(match[2].trim());
    else summaryLines.push(line);
  }
  let summary = summaryLines.join('\n').trim();
  summary = summary.replace(/^(总结|摘要|summary)\s*[:：]\s*/i, '').trim();
  return { summary, keyPoints: normalizeKeyPoints(bulletLines), links: [] };
}

const CAUSAL_RELATION_IDS = new Set([
  'visual_prompts_speech',
  'speech_prompts_visual',
  'speech_explains_visual',
  'speech_derives_visual',
  'speech_refers_visual',
]);

function normalizeCausalLinks(input) {
  if (!Array.isArray(input)) return [];
  const links = [];
  const seen = new Set();
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const relation = String(item.relation ?? '').trim();
    if (!CAUSAL_RELATION_IDS.has(relation)) continue;
    const evidence = String(item.evidence ?? '').trim().replace(/\s+/g, ' ');
    const cause = String(item.cause ?? '').trim().replace(/\s+/g, ' ');
    const effect = String(item.effect ?? '').trim().replace(/\s+/g, ' ');
    if (!evidence || !cause || !effect) continue;
    const key = `${relation}|${evidence.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({
      relation,
      evidence: evidence.length > 80 ? `${evidence.slice(0, 79)}…` : evidence,
      cause: cause.length > 180 ? `${cause.slice(0, 179)}…` : cause,
      effect: effect.length > 180 ? `${effect.slice(0, 179)}…` : effect,
    });
    if (links.length >= 6) break;
  }
  return links;
}

function normalizeKeyPoints(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const points = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const value = item.trim().replace(/^([-*•]|\d+[.、)])\s*/, '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    points.push(value.length > 120 ? value.slice(0, 119) + '…' : value);
    if (points.length >= 6) break;
  }
  return points;
}

/* ------------------------------------------------------------------ *
 * 主工厂
 * ------------------------------------------------------------------ */

/**
 * @param {{config?: object, log?: (msg: string) => void, fetchImpl?: Function, spawnImpl?: Function, env?: object}} deps
 */
export function createVisionService({ config = {}, log = () => {}, fetchImpl = globalThis.fetch, spawnImpl = nodeSpawn, env = process.env } = {}) {
  if (typeof fetchImpl !== 'function') throw readableError('createVisionService 需要 fetchImpl（Node ≥18 自带 fetch；测试请注入 fake fetch）');
  if (typeof spawnImpl !== 'function') throw readableError('createVisionService 需要 spawnImpl（默认 node:child_process.spawn；测试可注入 fake）');

  const vision = mergeVisionConfig(config);
  const ocrConfig = vision.ocr;
  const summaryConfig = vision.summary;
  const binPath = absify(ocrConfig.bin) || projectPath('data', 'bin', 'ocr-macos');
  const buildScriptPath = absify(ocrConfig.buildScript);

  let disposed = false;
  let tmpDir = null;
  let tempCounter = 0;
  let lazyBuildPromise = null;
  const activeChildren = new Set();
  const pendingControllers = new Set();

  const stats = { ocrCalls: 0, ocrFailures: 0, visionCalls: 0, visionFailures: 0, summaryCalls: 0, summaryFailures: 0, lazyBuilds: 0 };
  // 最近一次成功 OCR 的耗时/模式（health 暴露给 UI/doctor）
  const ocrRuntime = { lastOcrMs: null, lastMode: null, lastAt: null };
  // 最近一次真实 VLM 调用的探测结果（health.vision.available 用）
  const visionRuntime = { probeOk: null, probeMs: null, probeAt: null, probeError: null };

  function assertUsable() {
    if (disposed) throw readableError('视觉服务已 dispose：请重新 createVisionService() 后再调用');
  }

  function ensureTempDir() {
    if (!tmpDir) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livedub-vision-'));
    }
    return tmpDir;
  }

  function writeTempImage(bytes) {
    const mime = imageMimeOf(bytes);
    if (!mime.ok) {
      throw readableError('图片不是 PNG/JPEG（magic 校验失败）：请传 canvas 导出的 image/png 或 ffmpeg 抽出的 PNG/JPEG');
    }
    const file = path.join(ensureTempDir(), `img-${Date.now()}-${++tempCounter}${mime.ext}`);
    fs.writeFileSync(file, bytes);
    return { file, mime };
  }

  function removeQuietly(file) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* 临时文件清理失败不影响主流程 */
    }
  }

  /**
   * 跑一个子进程并收集输出；超时会 kill 并 reject 可读错误。
   * 重试/回退由调用方决定，这里只负责一次执行。
   */
  function runProcess(command, args, { timeoutMs = 20000, label = command } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        reject(readableError(`${label}启动失败：${err.message}；检查命令是否安装/路径是否正确`, err));
        return;
      }
      if (!child || typeof child.on !== 'function') {
        reject(readableError(`${label}启动失败：spawn 未返回子进程对象`));
        return;
      }
      activeChildren.add(child);

      const startedAt = Date.now();
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;

      const timer = timeoutMs > 0
        ? setTimeout(() => {
          timedOut = true;
          try {
            child.kill?.('SIGKILL');
          } catch {
            /* 已退出 */
          }
          finish(reject, readableError(`${label}超时（>${timeoutMs}ms）：可提高 timeoutMs，或检查进程是否卡住（首次编译 OCR 较慢属正常）`));
        }, timeoutMs)
        : null;

      function finish(fn, value) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        activeChildren.delete(child);
        fn(value);
      }

      child.stdout?.on?.('data', (chunk) => {
        if (stdout.length < MAX_PROCESS_STDOUT) stdout += chunk.toString();
      });
      child.stderr?.on?.('data', (chunk) => {
        if (stderr.length < MAX_PROCESS_STDERR) stderr += chunk.toString();
      });
      child.on('error', (err) => {
        if (err?.code === 'ENOENT') {
          finish(reject, readableError(`${label}未找到命令 "${command}"：请确认已安装并在 PATH 中（OCR 需要 macOS swiftc 或 tesseract）`, err));
        } else {
          finish(reject, readableError(`${label}执行失败：${err?.message ?? String(err)}`, err));
        }
      });
      child.on('close', (code) => {
        finish(resolve, { code: typeof code === 'number' ? code : -1, stdout, stderr, ms: Date.now() - startedAt, timedOut });
      });
    });
  }

  function logSafe(message) {
    try {
      log(message);
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  /* ---------------- OCR ---------------- */

  // 常驻 serve 客户端（懒启动单例；请求串行；崩溃重启一次；失败回退单次 spawn -> tesseract）
  const serveSettings = {
    enabled: ocrConfig.serve?.enabled !== false,
    startupTimeoutMs: positiveNumber(ocrConfig.serve?.startupTimeoutMs, 15000),
    timeoutMs: positiveNumber(ocrConfig.serve?.timeoutMs, positiveNumber(ocrConfig.timeoutMs, 30000)),
    maxRestarts: Number.isFinite(Number(ocrConfig.serve?.maxRestarts)) ? Math.max(0, Number(ocrConfig.serve.maxRestarts)) : 1,
  };
  const serveState = {
    client: null,
    readyPromise: null,
    readyResolve: null,
    readyReject: null,
    startupTimer: null,
    resolved: false,
    buffer: '',
    pending: new Map(),
    nextId: 1,
    spawnCount: 0,
    restarts: 0,
    requests: 0,
    failures: 0,
    disabled: false,
    disposed: false,
    lastError: null,
  };
  let serveQueue = Promise.resolve();

  function serveLangsArg() {
    return Array.isArray(ocrConfig.languages) && ocrConfig.languages.length
      ? ocrConfig.languages.join(',')
      : 'zh-Hans,en-US';
  }

  function serveRejectAll(reason) {
    if (serveState.startupTimer) {
      clearTimeout(serveState.startupTimer);
      serveState.startupTimer = null;
    }
    if (serveState.readyReject) {
      const reject = serveState.readyReject;
      serveState.readyReject = null;
      serveState.readyResolve = null;
      reject(reason);
    }
    for (const [, entry] of serveState.pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    serveState.pending.clear();
  }

  /** 常驻进程失效：清理状态，下次请求会（视重启次数）重启一次 */
  function markServeDown(reason, { kill = false } = {}) {
    const wasReady = serveState.resolved;
    serveState.resolved = false;
    serveState.readyPromise = null;
    serveState.lastError = reason;
    if (kill) {
      try {
        serveState.client?.child?.kill?.('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
    serveState.client = null;
    serveRejectAll(reason);
    if (wasReady) logSafe(`vision: OCR serve 失效：${reason instanceof Error ? reason.message : String(reason)}`);
  }

  function onServeLine(line) {
    if (!line.trim()) return;
    const message = extractJsonObject(line);
    if (!message) return;
    if (message.ready === true) {
      serveState.resolved = true;
      if (serveState.startupTimer) {
        clearTimeout(serveState.startupTimer);
        serveState.startupTimer = null;
      }
      if (serveState.readyResolve) {
        const resolve = serveState.readyResolve;
        serveState.readyResolve = null;
        serveState.readyReject = null;
        resolve(message);
      }
      return;
    }
    const entry = serveState.pending.get(message.id);
    if (!entry) return;
    serveState.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok === true) {
      entry.resolve(message);
    } else {
      entry.reject(readableError(`macOS Vision OCR 失败：${message.message || message.error || '未知错误'}；可重新运行 bash scripts/build-ocr.sh --check 自检`));
    }
  }

  function startServeProcess() {
    if (serveState.disposed) throw readableError('OCR serve 已关闭（视觉服务已 dispose）');
    if (serveState.spawnCount > 0) {
      serveState.restarts += 1;
      if (serveState.restarts > serveSettings.maxRestarts) {
        serveState.disabled = true;
        throw readableError(`OCR serve 已失败 ${serveState.restarts} 次，本会话停用常驻模式；回退单次 spawn OCR`);
      }
      logSafe(`vision: OCR serve 崩溃后重启（第 ${serveState.restarts} 次）…`);
    }
    serveState.spawnCount += 1;
    serveState.buffer = '';
    const args = ['--serve', '--langs', serveLangsArg()];
    const minConfidence = Number(ocrConfig.minConfidence);
    if (Number.isFinite(minConfidence) && minConfidence > 0) args.push('--min-confidence', String(minConfidence));

    let child;
    try {
      child = spawnImpl(binPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      serveState.disabled = true;
      throw readableError(`OCR serve 启动失败：${err.message}；检查 ${binPath}`, err);
    }
    if (!child || typeof child.on !== 'function' || typeof child.stdin?.write !== 'function') {
      try {
        child?.kill?.('SIGKILL');
      } catch {
        /* ignore */
      }
      serveState.disabled = true;
      throw readableError('OCR serve 启动失败：spawn 未返回可用的子进程（需要 stdin/stdout）');
    }
    serveState.client = { child };
    serveState.readyPromise = new Promise((resolve, reject) => {
      serveState.readyResolve = resolve;
      serveState.readyReject = reject;
    });
    serveState.startupTimer = setTimeout(() => {
      markServeDown(readableError(`OCR serve 启动超时（>${serveSettings.startupTimeoutMs}ms）：首次可能需要初始化 Vision；本帧回退单次 OCR`), { kill: true });
    }, serveSettings.startupTimeoutMs);

    let stderrBuffer = '';
    child.stdout?.on?.('data', (chunk) => {
      serveState.buffer += chunk.toString();
      let index;
      while ((index = serveState.buffer.indexOf('\n')) >= 0) {
        const line = serveState.buffer.slice(0, index);
        serveState.buffer = serveState.buffer.slice(index + 1);
        onServeLine(line);
      }
    });
    child.stderr?.on?.('data', (chunk) => {
      if (stderrBuffer.length < 4096) stderrBuffer += chunk.toString();
    });
    child.on('error', (err) => {
      if (serveState.disposed) return;
      const reason = err?.code === 'ENOENT'
        ? readableError(`OCR serve 未找到命令 "${binPath}"：请运行 bash scripts/build-ocr.sh --check 编译`, err)
        : readableError(`OCR serve 进程错误：${err?.message ?? String(err)}`, err);
      markServeDown(reason);
    });
    child.on('close', (code) => {
      if (serveState.disposed) return;
      const reason = readableError(`OCR serve 进程退出（code=${code}）${stderrBuffer ? `：${stderrBuffer.trim().slice(0, 200)}` : ''}`);
      markServeDown(reason);
    });
    return serveState.readyPromise;
  }

  function ensureServeReady() {
    if (!serveSettings.enabled || serveState.disabled) return Promise.reject(readableError('OCR serve 未启用'));
    if (serveState.resolved && serveState.client) return Promise.resolve();
    if (serveState.readyPromise) return serveState.readyPromise;
    return startServeProcess();
  }

  /** 一次 serve 请求（调用方已排队）：写 JSON 行 -> 等同 id 响应 */
  async function doServeRequest(imagePath, timeoutMs) {
    await ensureServeReady();
    const timeout = positiveNumber(timeoutMs, serveSettings.timeoutMs, 10000);
    return new Promise((resolve, reject) => {
      const id = serveState.nextId++;
      const timer = setTimeout(() => {
        serveState.pending.delete(id);
        serveState.failures += 1;
        const reason = readableError(`OCR serve 请求超时（>${timeout}ms）；将重启常驻进程，本帧回退单次 OCR`);
        markServeDown(reason, { kill: true });
        reject(reason);
      }, timeout);
      serveState.pending.set(id, { resolve, reject, timer });
      try {
        serveState.client?.child?.stdin?.write(`${JSON.stringify({ id, image: imagePath })}\n`);
        serveState.requests += 1;
      } catch (err) {
        clearTimeout(timer);
        serveState.pending.delete(id);
        serveState.failures += 1;
        reject(readableError(`OCR serve 写入请求失败：${err instanceof Error ? err.message : String(err)}；本帧回退单次 OCR`, err));
      }
    });
  }

  /** 串行队列：避免多帧同时往同一 stdin 写、保证 Vision 单进程顺序处理 */
  function serveRequest(imagePath, timeoutMs) {
    const run = serveQueue.then(
      () => doServeRequest(imagePath, timeoutMs),
      () => doServeRequest(imagePath, timeoutMs),
    );
    serveQueue = run.catch(() => {});
    return run;
  }

  function closeServe() {
    if (serveState.disposed) return;
    serveState.disposed = true;
    serveRejectAll(readableError('视觉服务已 dispose'));
    const client = serveState.client;
    serveState.client = null;
    serveState.resolved = false;
    if (client) {
      try {
        client.child?.stdin?.end?.();
      } catch {
        /* ignore */
      }
      try {
        client.child?.kill?.('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  }

  async function ensureLazyBuild() {
    if (!ocrConfig.lazyBuild) return false;
    if (safeExists(binPath)) return true;
    if (lazyBuildPromise) return lazyBuildPromise;
    if (!safeExists(buildScriptPath)) {
      logSafe(`vision: OCR 二进制不存在（${binPath}），且找不到构建脚本 ${buildScriptPath}；改用 tesseract 回退`);
      return false;
    }
    stats.lazyBuilds += 1;
    lazyBuildPromise = (async () => {
      logSafe(`vision: 本地 OCR 二进制不存在，尝试懒编译一次（scripts/build-ocr.sh，首次约 10-60s）…`);
      try {
        const result = await runProcess('bash', [buildScriptPath], { timeoutMs: 180000, label: 'OCR 懒编译' });
        if (result.code === 0 && safeExists(binPath)) {
          logSafe(`vision: OCR 懒编译成功（${result.ms}ms）：${binPath}`);
          return true;
        }
        logSafe(`vision: OCR 懒编译失败（exit=${result.code}）${result.stderr ? `：${result.stderr.trim().slice(0, 240)}` : ''}；改用 tesseract 回退`);
        return false;
      } catch (err) {
        logSafe(`vision: OCR 懒编译失败：${err.message}；改用 tesseract 回退`);
        return false;
      }
    })();
    return lazyBuildPromise;
  }

  function normalizeOcrPayload(payload) {
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const lines = Array.isArray(payload.lines)
      ? payload.lines
        .filter((line) => line && typeof line.text === 'string' && line.text.trim())
        .map((line) => ({
          text: String(line.text).trim(),
          ...(typeof line.confidence === 'number' ? { confidence: line.confidence } : {}),
          ...(typeof line.x === 'number' ? { x: line.x, y: line.y, w: line.w, h: line.h } : {}),
        }))
      : text.split('\n').filter((line) => line.trim()).map((line) => ({ text: line.trim() }));
    return {
      text,
      lines,
      provider: 'macos-vision',
      helperMs: payload.ms,
      languages: payload.languages ?? ocrConfig.languages,
    };
  }

  function visionOcrArgs(imagePath) {
    const langs = Array.isArray(ocrConfig.languages) && ocrConfig.languages.length
      ? ocrConfig.languages.join(',')
      : 'zh-Hans,en-US';
    const args = ['--image', imagePath, '--langs', langs];
    const minConfidence = Number(ocrConfig.minConfidence);
    if (Number.isFinite(minConfidence) && minConfidence > 0) args.push('--min-confidence', String(minConfidence));
    return args;
  }

  /** 单次 spawn 的 macOS Vision（serve 不可用时的兜底） */
  async function ocrSingleSpawn(imagePath, timeoutMs) {
    const result = await runProcess(binPath, visionOcrArgs(imagePath), { timeoutMs, label: 'macOS Vision OCR' });
    const payload = extractJsonObject(result.stdout);
    if (result.code !== 0 || !payload || payload.ok !== true) {
      const reason = payload?.message || payload?.error || result.stderr.trim().slice(0, MAX_ERROR_BODY) || `exit ${result.code}`;
      throw readableError(`macOS Vision OCR 失败：${reason}；可重新运行 bash scripts/build-ocr.sh --check 自检`);
    }
    return payload;
  }

  /** macOS Vision：优先 serve 常驻进程，失败/不支持时回退单次 spawn */
  async function ocrWithMacosVision(imagePath, singleTimeoutMs, serveTimeoutMs) {
    if (!safeExists(binPath)) {
      const built = await ensureLazyBuild();
      if (!built && !safeExists(binPath)) {
        throw readableError(`macOS Vision OCR 不可用：找不到 ${binPath}；下一步运行 bash scripts/build-ocr.sh --check 编译`);
      }
    }
    if (!executableExists(binPath)) {
      throw readableError(`macOS Vision OCR 不可执行：${binPath} 无执行权限；运行 bash scripts/build-ocr.sh --force 重新编译`);
    }
    const errors = [];
    if (serveSettings.enabled && !serveState.disabled) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const payload = await serveRequest(imagePath, serveTimeoutMs);
          const result = { ...normalizeOcrPayload(payload), mode: 'serve' };
          if (attempt > 1) result.serveRetried = true;
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`serve${attempt > 1 ? '（重试）' : ''}: ${message}`);
          if (attempt === 1 && !serveState.disabled) {
            // Lead 要求：serve 超时/失效后重启 serve 并重试一次（同 30s），再失败才回退单次 spawn
            logSafe(`vision: OCR serve 首次失败（${message}），重启常驻进程并重试一次…`);
            markServeDown(err instanceof Error ? err : readableError(message), { kill: true });
            continue;
          }
          logSafe(`vision: OCR serve 失败，本帧回退单次 spawn：${message}`);
        }
      }
    }
    try {
      const payload = await ocrSingleSpawn(imagePath, singleTimeoutMs);
      const result = { ...normalizeOcrPayload(payload), mode: 'spawn' };
      if (errors.length) {
        result.degraded = true;
        result.fallbackReason = errors.join('；').slice(0, 500);
      }
      return result;
    } catch (err) {
      errors.push(`spawn: ${err instanceof Error ? err.message : String(err)}`);
      throw readableError(`macOS Vision OCR 失败：${errors.join('；')}`);
    }
  }

  async function ocrWithTesseract(imagePath, timeoutMs) {
    const languages = Array.isArray(ocrConfig.tesseractLanguages) && ocrConfig.tesseractLanguages.length
      ? ocrConfig.tesseractLanguages.join('+')
      : 'eng';
    const result = await runProcess('tesseract', [imagePath, 'stdout', '-l', languages, '--psm', '3'], { timeoutMs, label: 'tesseract OCR' });
    if (result.code !== 0) {
      throw readableError(`tesseract OCR 失败（exit=${result.code}）：${result.stderr.trim().slice(0, MAX_ERROR_BODY) || '无输出'}；检查 tesseract 是否安装`);
    }
    const text = result.stdout.trim();
    return {
      text,
      lines: text.split('\n').filter((line) => line.trim()).map((line) => ({ text: line.trim() })),
      provider: 'tesseract',
      languages,
      mode: 'tesseract',
      langNote: '本机 tesseract 仅安装了 eng（无 chi_sim），中文画面文字可能丢失/错乱；建议用 macOS Vision（默认）或 brew install tesseract-lang',
    };
  }

  /**
   * 本地 OCR：优先 macOS Vision（常驻 serve -> 单次 spawn），失败按 ocr.fallback 回退 tesseract。
   * @returns {Promise<{text:string, lines:Array, provider:string, ms:number, mode:string, degraded?:boolean, fallbackReason?:string}>}
   */
  async function ocr({ png, timeoutMs } = {}) {
    assertUsable();
    stats.ocrCalls += 1;
    const startedAt = Date.now();
    const bytes = normalizeImageInput(png);
    const singleTimeout = positiveNumber(timeoutMs, ocrConfig.timeoutMs, 30000);
    const serveTimeout = positiveNumber(timeoutMs, serveSettings.timeoutMs, 30000);
    const tesseractTimeout = positiveNumber(timeoutMs, ocrConfig.tesseractTimeoutMs, 20000);
    const { file } = writeTempImage(bytes);
    const primary = ocrConfig.provider || 'macos-vision';
    const fallbacks = (Array.isArray(ocrConfig.fallback) ? ocrConfig.fallback : []).filter((provider) => provider && provider !== primary);
    const chain = [primary, ...fallbacks];
    const failures = [];

    try {
      for (const provider of chain) {
        try {
          let result;
          if (provider === 'macos-vision') {
            result = await ocrWithMacosVision(file, singleTimeout, serveTimeout);
          } else if (provider === 'tesseract') {
            result = await ocrWithTesseract(file, tesseractTimeout);
          } else {
            throw readableError(`未知 OCR provider："${provider}"；支持 macos-vision / tesseract`);
          }
          if (provider !== primary) {
            result.degraded = true;
            result.fallbackReason = failures.map((failure) => `${failure.provider}: ${failure.message}`).join('；').slice(0, 500);
            logSafe(`vision: OCR 已回退到 ${provider}（${result.fallbackReason}）`);
          }
          const finalResult = { ...result, ms: Date.now() - startedAt };
          ocrRuntime.lastOcrMs = finalResult.ms;
          ocrRuntime.lastMode = finalResult.mode;
          ocrRuntime.lastAt = new Date().toISOString();
          return finalResult;
        } catch (err) {
          stats.ocrFailures += 1;
          failures.push({ provider, message: err instanceof Error ? err.message : String(err) });
          logSafe(`vision: OCR provider ${provider} 失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const detail = failures.map((failure) => `${failure.provider}: ${failure.message}`).join('；');
      throw readableError(
        `OCR 不可用：${detail}。下一步：macOS 上运行 bash scripts/build-ocr.sh --check 编译本地 Vision OCR；或安装 tesseract（brew install tesseract tesseract-lang，仅英文可用时中文会丢失）`,
      );
    } finally {
      removeQuietly(file);
    }
  }

  /* ---------------- 视觉大模型 ---------------- */

  function resolveVisionProvider() {
    let providerConf;
    try {
      providerConf = resolveProvider(config, vision.provider, env);
    } catch (err) {
      throw readableError(`视觉 provider "${vision.provider}" 解析失败：${err.message}；检查 ~/.sayless/config.json 或 config/livedub.config.json`, err);
    }
    if (!providerConf.apiKey) {
      throw readableError(`视觉 provider "${vision.provider}" 缺少 apiKey：请在 ~/.sayless/config.json 的 providers.${vision.provider}.apiKey 配置，或用环境变量 LIVEDUB_PROVIDER_${String(vision.provider).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY 注入`);
    }
    return providerConf;
  }

  function providerHost(baseUrl) {
    try {
      return new URL(baseUrl).host || String(baseUrl).slice(0, 80);
    } catch {
      return String(baseUrl).slice(0, 80);
    }
  }

  /** OpenAI 兼容 chat/completions 的完整 URL（baseUrl + chatPath，避免重复/缺失斜杠） */
  function chatEndpoint(providerConf) {
    const base = String(providerConf.baseUrl || '').replace(/\/+$/, '');
    const chatPath = String(providerConf.chatPath || '/chat/completions');
    return `${base}${chatPath.startsWith('/') ? '' : '/'}${chatPath}`;
  }

  /** 带超时/取消的 JSON POST；返回解析后的 JSON 对象 */
  async function postJson({ url, body, timeoutMs, signal, label, apiKey = '' }) {
    const controller = new AbortController();
    const pending = { controller, label };
    pendingControllers.add(pending);
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
        reject(readableError(`${label}超时（>${timeoutMs}ms）：视觉模型较慢时可提高 timeoutMs；或改用 6 帧拼图一次分析`));
      }, timeoutMs);
    });
    const onExternalAbort = () => {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      pendingControllers.delete(pending);
      throw readableError(`${label}已取消`);
    }
    signal?.addEventListener?.('abort', onExternalAbort, { once: true });

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    let response;
    try {
      response = await Promise.race([
        Promise.resolve().then(() => fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })),
        timeoutPromise,
      ]);
    } catch (err) {
      if (err?.livedubReadable) throw err;
      if (signal?.aborted) throw readableError(`${label}已取消`);
      if (isAbortError(err)) {
        throw readableError(`${label}超时（>${timeoutMs}ms）：视觉模型较慢时可提高 timeoutMs；或改用 6 帧拼图一次分析`, err);
      }
      const networkError = readableError(`${label}网络请求失败：${err?.message ?? String(err)}；检查网络/代理/防火墙后重试`, err);
      networkError.retryable = true;
      throw networkError;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onExternalAbort);
      pendingControllers.delete(pending);
    }

    const status = Number(response?.status ?? 0);
    const ok = response?.ok === undefined ? status === 0 || (status >= 200 && status < 300) : Boolean(response.ok);
    let data = null;
    if (typeof response?.json === 'function') {
      try {
        data = await response.json();
      } catch {
        data = null;
      }
    } else if (typeof response?.text === 'function') {
      const raw = await response.text();
      try {
        data = JSON.parse(raw);
      } catch {
        data = { __raw: raw };
      }
    }
    if (!ok || status >= 400) {
      throw friendlyHttpError(label, status, extractApiError(data));
    }
    if (data && typeof data === 'object' && data.error) {
      throw readableError(`${label}返回错误：${extractApiError(data)}；检查 provider/model 配置`);
    }
    return data;
  }

  async function callVision({ png, prompt, maxTokens, timeoutMs, signal }) {
    stats.visionCalls += 1;
    const providerConf = resolveVisionProvider();
    const model = vision.model || providerConf.model;
    if (!model) throw readableError('视觉模型缺少 model：请在 config.vision.model 或 provider 配置里指定');
    const bytes = normalizeImageInput(png);
    const mime = imageMimeOf(bytes).mime;
    const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
    const timeout = positiveNumber(timeoutMs, vision.timeoutMs, 90000);
    const maxTokenValue = positiveNumber(maxTokens, vision.maxTokens, 800);
    const finalPrompt = typeof prompt === 'string' && prompt.trim() ? prompt.trim() : vision.prompt;
    const body = {
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: finalPrompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      max_tokens: maxTokenValue,
      temperature: 0.2,
      stream: false,
    };
    logSafe(`vision: VLM 调用 ${vision.provider}/${model}（图片 ${(bytes.length / 1024).toFixed(0)}KB，timeout ${timeout}ms，${providerHost(providerConf.baseUrl)}）`);
    const startedAt = Date.now();
    let data = null;
    let lastError = null;
    // 网络错误（fetch failed / ECONNRESET）重试一次；401/模型错误/超时不重试（避免重复计费）
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        data = await postJson({ url: chatEndpoint(providerConf), body, timeoutMs: timeout, signal, label: '视觉模型', apiKey: providerConf.apiKey });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (attempt === 1 && err?.retryable && !signal?.aborted) {
          logSafe(`vision: VLM 网络错误（${err.message}），600ms 后自动重试一次…`);
          await sleep(600);
          continue;
        }
        break;
      }
    }
    if (lastError) {
      stats.visionFailures += 1;
      visionRuntime.probeOk = false;
      visionRuntime.probeAt = new Date().toISOString();
      visionRuntime.probeError = lastError.message;
      if (lastError.retryable) {
        throw readableError(`${lastError.message}（已自动重试 1 次仍失败；VLM 慢/网络抖动时可稍后重试，OCR 不受影响）`, lastError);
      }
      throw lastError;
    }
    const text = extractChatContent(data);
    if (!text) {
      stats.visionFailures += 1;
      visionRuntime.probeOk = false;
      visionRuntime.probeAt = new Date().toISOString();
      visionRuntime.probeError = '视觉模型返回空内容';
      throw readableError('视觉模型返回空内容：可能是模型不支持 image_url 或图片损坏；先用 analyze({mode:"ocr"}) 验证本地 OCR，再检查 config.vision.model 是否是视觉模型');
    }
    const elapsed = Date.now() - startedAt;
    visionRuntime.probeOk = true;
    visionRuntime.probeMs = elapsed;
    visionRuntime.probeAt = new Date().toISOString();
    visionRuntime.probeError = null;
    logSafe(`vision: VLM 完成 ${vision.provider}/${model}（${elapsed}ms，${text.length} 字）`);
    return { text, provider: vision.provider, model, ms: elapsed };
  }

  function normalizeMode(mode) {
    const value = mode === undefined || mode === null || mode === '' ? 'ocr' : String(mode).toLowerCase();
    if (value === 'ocr' || value === 'vision' || value === 'both') return value;
    throw readableError(`未知 analyze mode："${mode}"；支持 ocr（仅本地 OCR，快）、vision（仅视觉模型，慢）、both（两者都要）`);
  }

  /**
   * 分析一帧画面：
   *   mode:'ocr'    -> 只跑本地 OCR（毫秒级）
   *   mode:'vision' -> 只跑视觉模型（20-30s）
   *   mode:'both'   -> 并行跑；视觉失败抛错，OCR 失败只进 warnings（有画面理解也算成功）
   */
  async function analyze({ png, mode, prompt, maxTokens, timeoutMs, signal } = {}) {
    assertUsable();
    const startedAt = Date.now();
    const normalized = normalizeMode(mode);
    const wantOcr = normalized === 'ocr' || normalized === 'both';
    const wantVision = normalized === 'vision' || normalized === 'both';
    const warnings = [];
    let ocrResult;
    let caption;

    const jobs = [];
    if (wantOcr) {
      jobs.push(
        ocr({ png })
          .then((result) => {
            ocrResult = result;
          })
          .catch((err) => {
            if (!wantVision) throw err;
            warnings.push({ scope: 'ocr', message: err instanceof Error ? err.message : String(err) });
            logSafe(`vision: analyze(both) 的 OCR 失败，仅返回画面理解：${err instanceof Error ? err.message : String(err)}`);
          }),
      );
    }
    if (wantVision) {
      jobs.push(callVision({ png, prompt, maxTokens, timeoutMs, signal }).then((result) => {
        caption = result;
      }));
    }
    await Promise.all(jobs);

    if (wantOcr && !ocrResult && !caption) {
      throw readableError('视觉分析失败：OCR 与视觉模型都没有结果；先用 analyze({mode:"ocr"}) 排查本地 OCR，再检查 VLM 配置');
    }

    return {
      mode: normalized,
      ...(ocrResult ? { ocr: ocrResult } : {}),
      ...(caption ? { caption } : {}),
      provider: caption?.provider ?? ocrResult?.provider,
      ...(caption?.model ? { model: caption.model } : {}),
      ms: Date.now() - startedAt,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  /** 拼图（多帧一次理解）：就是 vision 模式的 analyze，换默认 prompt */
  async function analyzeSheet({ png, prompt, maxTokens, timeoutMs, signal } = {}) {
    const result = await analyze({
      png,
      mode: 'vision',
      prompt: typeof prompt === 'string' && prompt.trim() ? prompt : DEFAULT_SHEET_PROMPT,
      maxTokens,
      timeoutMs,
      signal,
    });
    return { ...result, sheet: true };
  }

  /* ---------------- 文本总结 ---------------- */

  async function summarize({ title = '', transcript = [], visuals = [], lang = 'zh', provider, signal } = {}) {
    assertUsable();
    stats.summaryCalls += 1;
    const startedAt = Date.now();
    const requested = typeof provider === 'string' ? provider.trim() : '';
    const providerName = requested || summaryConfig.provider;
    let providerConf;
    try {
      providerConf = resolveProvider(config, providerName, env);
    } catch (err) {
      throw readableError(`总结 provider "${providerName}" 解析失败：${err.message}；检查 ~/.sayless/config.json 或 config/livedub.config.json`, err);
    }
    if (!providerConf.apiKey) {
      throw readableError(`总结 provider "${providerName}" 缺少 apiKey：检查 ~/.sayless/config.json 的 providers.${providerName}.apiKey`);
    }
    // 换一家模型时用那一家自己的 model，不用总结配置里的 deepseek-flash。
    const model = !requested || requested === summaryConfig.provider
      ? (summaryConfig.model || providerConf.model)
      : providerConf.model;
    if (!model) throw readableError(`总结模型 "${providerName}" 缺少 model：请在 provider 配置里指定`);

    const { messages, stats: inputStats } = buildSummaryInput({
      title,
      transcript,
      visuals,
      lang,
      maxInputChars: summaryConfig.maxInputChars,
    });
    const timeout = positiveNumber(summaryConfig.timeoutMs, 60000);
    const maxTokenValue = positiveNumber(summaryConfig.maxTokens, 900);
    const body = {
      model,
      messages,
      max_tokens: maxTokenValue,
      temperature: 0.3,
      stream: false,
    };
    logSafe(
      `vision: 总结调用 ${providerName}/${model}（字幕 ${inputStats.transcriptKept}/${inputStats.transcriptItems} 句，画面 ${inputStats.visualKept}/${inputStats.visualItems} 条，输入 ${inputStats.chars} 字${inputStats.truncated ? '，已裁剪' : ''}）`,
    );

    const url = chatEndpoint(providerConf);
    let data;
    try {
      data = await postJson({ url, body, timeoutMs: timeout, signal, label: '总结模型', apiKey: providerConf.apiKey });
    } catch (err) {
      stats.summaryFailures += 1;
      throw err;
    }
    const text = extractChatContent(data);
    if (!text) {
      stats.summaryFailures += 1;
      throw readableError('总结模型返回空内容：检查 provider/model 是否可用，或减少输入后重试');
    }
    const parsed = parseSummaryOutput(text);
    if (!parsed.summary) {
      stats.summaryFailures += 1;
      throw readableError('总结模型输出无法解析（没有 summary）：可重试一次；若持续失败检查 model 是否支持 JSON 输出');
    }
    if (!parsed.keyPoints.length) {
      parsed.keyPoints = parsed.summary
        .split(/[。；\n]/)
        .map((line) => line.trim())
        .filter((line) => line.length >= 8)
        .slice(0, 4);
    }
    const elapsed = Date.now() - startedAt;
    logSafe(`vision: 总结完成 ${providerName}/${model}（${elapsed}ms，${parsed.summary.length} 字 + ${parsed.keyPoints.length} 要点）`);
    return {
      summary: parsed.summary,
      keyPoints: parsed.keyPoints,
      links: parsed.links,
      provider: providerName,
      model,
      ms: elapsed,
      input: inputStats,
    };
  }

  /* ---------------- 健康检查 / 资源释放 ---------------- */

  function whichTesseract() {
    const candidates = ['/opt/homebrew/bin/tesseract', '/usr/local/bin/tesseract', '/usr/bin/tesseract'];
    for (const candidate of candidates) {
      if (executableExists(candidate)) return candidate;
    }
    const pathValue = String((env ?? process.env).PATH ?? '');
    for (const dir of pathValue.split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, 'tesseract');
      if (executableExists(candidate)) return candidate;
    }
    return null;
  }

  function resolveVisionHealth() {
    const result = { configured: false, provider: vision.provider, model: vision.model || '', baseUrlHost: '' };
    try {
      const providerConf = resolveProvider(config, vision.provider, env);
      result.configured = Boolean(providerConf.apiKey);
      result.model = vision.model || providerConf.model || '';
      result.baseUrlHost = providerHost(providerConf.baseUrl);
      if (!result.configured) result.reason = '缺少 apiKey（~/.sayless/config.json providers.' + vision.provider + '.apiKey）';
    } catch (err) {
      result.reason = err instanceof Error ? err.message : String(err);
    }
    return result;
  }

  function resolveSummaryHealth() {
    try {
      const providerConf = resolveProvider(config, summaryConfig.provider, env);
      return {
        configured: Boolean(providerConf.apiKey),
        provider: summaryConfig.provider,
        model: summaryConfig.model || providerConf.model || '',
      };
    } catch (err) {
      return { configured: false, provider: summaryConfig.provider, model: summaryConfig.model || '', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 同步健康检查（不编译、不发请求、不打印密钥） */
  function health() {
    const binExists = safeExists(binPath);
    const tesseractPath = whichTesseract();
    const canLazyBuild = !binExists && Boolean(ocrConfig.lazyBuild) && safeExists(buildScriptPath) && executableExists('/usr/bin/swiftc');
    const ocrOk = binExists || canLazyBuild || Boolean(tesseractPath);
    const visionHealth = resolveVisionHealth();
    const visionAvailable = Boolean(visionHealth.configured) && visionRuntime.probeOk !== false;
    const serveUsable = serveSettings.enabled && !serveState.disabled;
    // 当前生效的 OCR 模式：serve（常驻，默认）| spawn（单次进程）| tesseract（仅英文兜底）
    let ocrMode = 'unavailable';
    if (binExists || canLazyBuild) ocrMode = serveUsable ? 'serve' : 'spawn';
    else if (tesseractPath) ocrMode = 'tesseract';
    return {
      ocr: {
        ok: ocrOk,
        provider: ocrConfig.provider || 'macos-vision',
        bin: binPath,
        binExists,
        canLazyBuild,
        mode: ocrMode,
        fallback: Array.isArray(ocrConfig.fallback) ? ocrConfig.fallback : [],
        tesseract: tesseractPath || null,
        serve: {
          enabled: serveSettings.enabled,
          disabled: serveState.disabled,
          running: Boolean(serveState.resolved),
          spawnCount: serveState.spawnCount,
          restarts: serveState.restarts,
          requests: serveState.requests,
          failures: serveState.failures,
          lastError: serveState.lastError ? String(serveState.lastError.message ?? serveState.lastError) : null,
        },
        /** 最近一次成功 OCR 的墙钟耗时/模式（UI、doctor 观察用） */
        lastOcrMs: ocrRuntime.lastOcrMs,
        lastOcrMode: ocrRuntime.lastMode,
        lastOcrAt: ocrRuntime.lastAt,
        ...(ocrOk ? {} : { reason: `找不到 ${binPath}，也没有 tesseract；运行 bash scripts/build-ocr.sh --check` }),
      },
      vision: {
        ...visionHealth,
        /** 已配置且最近一次真实调用没有失败；未调用过时按已配置视为可用 */
        available: visionAvailable,
        probe: {
          ok: visionRuntime.probeOk,
          ms: visionRuntime.probeMs,
          at: visionRuntime.probeAt,
          error: visionRuntime.probeError,
        },
      },
      summary: resolveSummaryHealth(),
      ready: !disposed && (ocrOk || visionAvailable),
      keyframe: { ...vision.keyframe },
      disposed,
    };
  }

  async function dispose() {
    if (disposed) return { ok: true };
    disposed = true;
    closeServe();
    for (const pending of pendingControllers) {
      try {
        pending.controller.abort();
      } catch {
        /* ignore */
      }
    }
    pendingControllers.clear();
    for (const child of activeChildren) {
      try {
        child.kill?.('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    activeChildren.clear();
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* 清理失败不致命（/tmp 会被系统回收） */
      }
      tmpDir = null;
    }
    return { ok: true };
  }

  return { ocr, analyze, analyzeSheet, summarize, health, dispose };
}
