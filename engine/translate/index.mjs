/**
 * 增量翻译：OpenAI 兼容的流式 chat/completions（deepseek 主用，minimax / mimo-plan 降级）。
 *
 * 契约（docs/CONTRACTS.md §4）：
 *   createTranslator({ config, log, fetchImpl = globalThis.fetch }) -> {
 *     name,                                                  // 实际使用的 provider 名称（主 provider）
 *     translate({ text, context, glossary, signal, onPartial })
 *       -> Promise<{ text, model?, provider? }>
 *   }
 *   - text: 待翻译的一句原文（英文教学视频的 ASR final 结果）
 *   - context: [{ src, dst }] 最近若干句的双语上下文（只帮助理解，不要重译）
 *   - glossary: [{ src, dst }] 术语表（强约束，出现即必须用 dst 译法）
 *   - signal: AbortSignal（客户端停止/超时；收到即抛 AbortError，不再降级）
 *   - onPartial(textSoFar): 流式增量回调，textSoFar 是「清洗后的累计译文」（节流调用）
 *
 * 设计要点：
 * - 零依赖、纯 ESM；fetch 可注入（tests/translate.test.mjs 用 fake fetch，禁止真网络）。
 * - SSE 增量解析容忍任意 chunk 边界（半行、多行、UTF-8 被切开都会缓冲后重组）。
 * - 超时用 AbortController 触发；超时属于可降级错误，用户中断（signal.aborted）不可降级。
 * - 降级链按 config.translate.chain 顺序尝试，全部失败抛「可读 + 带下一步建议」的错误。
 * - 最终文本清洗：去「译文：」前缀、包裹引号、Markdown 粗体/代码围栏、尾部解释性括号。
 * - v0.2 增量子句提取器 createClauseExtractor：翻译还在流式输出时，把已稳定子句提前交给 TTS
 *   （见下方「增量子句提取器」大段契约注释；Lead 在 pipeline 里动态 import 集成）。
 * - v0.3 ASR 草稿翻译复用工具 normalizeForMatch / draftTranslationReusable / draftTranslationCache：
 *   用于「ASR partial 先翻译草稿、final 确认后复用」，避免重复翻译、压低云端 ASR 场景 e2e。
 * - 不在库代码里 console.*；日志一律走传入的 log()，且绝不打印 apiKey。
 */
import { sanitizeGlossary } from '../protocol.mjs';
import { resolveProvider } from '../config.mjs';
import { createMockTranslator } from '../mock.mjs';

/** 支持 OpenAI 兼容流式协议的 provider（名称来自 config.translate.provider / chain） */
const OPENAI_COMPATIBLE_PROVIDERS = Object.freeze(['deepseek', 'minimax', 'mimo-plan']);
/** 翻译层支持的全部 provider 名称（未知名称按契约抛 unknown provider） */
const SUPPORTED_PROVIDERS = new Set([...OPENAI_COMPATIBLE_PROVIDERS, 'mock']);

const DEFAULT_CHAIN = Object.freeze(['deepseek', 'minimax', 'mimo-plan']);
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_PARTIAL_THROTTLE_MS = 80;
const DEFAULT_MAX_TOKENS = 360;
const DEFAULT_MAX_INPUT_CHARS = 4000;
const MAX_PROMPT_GLOSSARY = 60;
const MAX_CONTEXT_ENTRY_CHARS = 400;

/* ------------------------------------------------------------------ *
 * 错误工具
 * ------------------------------------------------------------------ */

function makeAbortError(message = '翻译已被中断') {
  if (typeof DOMException === 'function') {
    try {
      return new DOMException(message, 'AbortError');
    } catch {
      /* 某些运行时限制 DOMException 参数，退回普通 Error */
    }
  }
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function isAbortError(err) {
  return err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
}

/** 标记「已经带可读信息、不需要再包装」的错误，避免降级日志重复套娃 */
function readableError(message, cause) {
  const err = cause === undefined ? new Error(message) : new Error(message, { cause });
  err.livedubReadable = true;
  return err;
}

/* ------------------------------------------------------------------ *
 * Prompt 构建（导出以便单测断言术语/上下文是否进入 prompt）
 * ------------------------------------------------------------------ */

const LANG_NAMES = {
  en: '英文',
  zh: '中文',
  ja: '日文',
  ko: '韩文',
  es: '西班牙文',
  fr: '法文',
  de: '德文',
};

function langName(code, fallback) {
  const key = String(code ?? '').trim().toLowerCase();
  return LANG_NAMES[key] ?? (key ? key : fallback);
}

function oneLine(value, maxChars = MAX_CONTEXT_ENTRY_CHARS) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}

/** 取出 config 里的 translate 段与根配置（兼容「只传 translate 段」的调用方） */
function splitTranslateConfig(config) {
  if (!config || typeof config !== 'object') return { cfg: {}, root: {}, providers: {} };
  const cfg = config.translate && typeof config.translate === 'object' ? config.translate : config;
  const root = config.translate && typeof config.translate === 'object' ? config : cfg;
  const providers = config.providers && typeof config.providers === 'object' ? config.providers : {};
  return { cfg, root, providers };
}

/** 合并 config.glossary 与调用方传入的 glossary（调用方/会话级优先），并去重/限流 */
export function mergeGlossary(config, glossary, { maxTerms = MAX_PROMPT_GLOSSARY } = {}) {
  const rootGlossary = Array.isArray(config?.glossary) ? config.glossary : [];
  const sessionGlossary = Array.isArray(glossary) ? glossary : [];
  // sanitizeGlossary 保留首次出现的条目：把会话级（调用方）放前面，才能覆盖项目默认译法
  return sanitizeGlossary([...sessionGlossary, ...rootGlossary], { maxTerms }).slice(0, maxTerms);
}

/** 把最近若干句双语上下文整理成 prompt 行；最多取 contextSegments 条 */
export function formatContext(context, { contextSegments = 3 } = {}) {
  if (!Array.isArray(context) || context.length === 0) return [];
  const limit = Math.max(0, Math.floor(Number(contextSegments) || 0)) || 3;
  const lines = [];
  for (const item of context.slice(-limit)) {
    if (!item || typeof item !== 'object') continue;
    const src = oneLine(item.src ?? item.text ?? '');
    const dst = oneLine(item.dst ?? item.translation ?? '');
    if (!src && !dst) continue;
    if (src) lines.push(`EN: ${src}`);
    if (dst) lines.push(`ZH: ${dst}`);
  }
  return lines;
}

/**
 * 构建送进 OpenAI 兼容 chat/completions 的消息数组（纯函数）。
 * 教学同传风格 + 术语表强约束 + 最近双语上下文。
 */
export function buildTranslationMessages({ text, context = [], glossary = [], config = {}, langFrom, langTo } = {}) {
  const { cfg, root } = splitTranslateConfig(config);
  const from = String(langFrom ?? root?.session?.langFrom ?? 'en');
  const to = String(langTo ?? root?.session?.langTo ?? 'zh');
  const style = String(cfg.style ?? root?.translate?.style ?? 'teaching');
  const contextSegments = Math.max(0, Math.floor(Number(cfg.contextSegments ?? 3)));
  const terms = mergeGlossary(root, glossary);
  const contextLines = formatContext(context, { contextSegments });
  const srcText = String(text ?? '').trim();

  const targetLang = langName(to, '中文');
  const serviceLine =
    style === 'teaching'
      ? `你是英文技术课的同声传译，把讲师的话译成${targetLang}。`
      : `你是一名资深的同声传译员，正在把${langName(from, '原文语言')}实时翻译成${targetLang}。`;

  // v0.3 首 token 优化：system prompt 从 ~330 字压到 ~180 字（保留术语/公式/代码约束与口语化要求），
  // 减少 prefill 输入 token、缩短首字延迟；关键约束词同时被单测锁定。
  const system = [
    serviceLine,
    '要求：',
    '1. 忠实：不增删、不总结、不解释。',
    '2. 口语化：用短句，像老师现场讲，可直接 TTS 朗读；不要书面连接词（如「首先/其次」）。',
    '3. 公式、变量名、函数名、代码标识符、URL 原样保留：不改写、不加空格、不改大小写。',
    '4. 术语表是强约束：出现 src 必须逐字用 dst。',
    '5. 只输出译文本身，不要前缀、引号或解释。',
  ].join('\n');

  const userSections = [];
  if (terms.length) {
    userSections.push(
      ['【术语表（必须使用左列译法，不得改写）】', ...terms.map((t) => `- ${t.src} = ${t.dst}`)].join('\n'),
    );
  }
  if (contextLines.length) {
    userSections.push(
      ['【最近上下文（只用于理解语境，不要重译、不要输出）】', ...contextLines].join('\n'),
    );
  }
  userSections.push(['【待翻译文本（只输出这一句的译文）】', srcText].join('\n'));

  return [
    { role: 'system', content: system },
    { role: 'user', content: userSections.join('\n\n') },
  ];
}

/* ------------------------------------------------------------------ *
 * 最终文本清洗（导出以便单测）
 * ------------------------------------------------------------------ */

/** 模型可能加的中文/英文前缀，形如「译文：」「翻译如下：」「Translation:」 */
const PREFIX_RE =
  /^(?:中文译文|中文翻译|译文如下|翻译如下|译文结果|翻译结果|英文原文|原文如下|译文|翻译|中文|Translation|Translated text|Chinese translation)\s*[:：]\s*/i;

/** 尾部解释性括号（只删「注/说明/意译/直译」这类元信息，正常括号内容保留） */
const TAIL_PAREN_RES = [
  /\s*[（(]\s*(?:注|备注|说明|意译|直译|音译|原文|字面意思|Note|Translator'?s? note|Literal translation|Translated by)\s*[:：][^）)]*[）)]\s*$/iu,
  /\s*[（(]\s*(?:注|备注|说明|意译|直译)\s*[）)]\s*$/u,
];

const QUOTE_PAIRS = Object.freeze([
  ['"', '"'],
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
  ["'", "'"],
  ['‘', '’'],
]);

const CJK_CHAR_RE = /[\u2e80-\u2fff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u;

function stripWrappedQuotes(text) {
  for (const [start, end] of QUOTE_PAIRS) {
    if (text.length > start.length + end.length && text.startsWith(start) && text.endsWith(end)) {
      return text.slice(start.length, -end.length).trim();
    }
  }
  return text;
}

function joinModelLines(text) {
  // 模型偶尔把一句译文拆成多行：CJK 相邻直接拼接，其余用空格，避免把英文单词粘在一起
  return text.replace(/(\S)\s*\n+\s*(\S)/gu, (m, before, after) => {
    const glue = CJK_CHAR_RE.test(before) && CJK_CHAR_RE.test(after) ? '' : ' ';
    return `${before}${glue}${after}`;
  });
}

/**
 * 清洗模型输出：去前缀、去包裹引号、去 Markdown 装饰、去尾部解释性括号、合并断行。
 * @param {string} raw
 * @returns {string}
 */
export function cleanTranslation(raw) {
  let s = String(raw ?? '');
  if (!s) return '';
  s = s.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!s) return '';

  // Markdown 代码围栏 / 粗体包裹
  s = s.replace(/^```[A-Za-z0-9_-]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  s = s.replace(/^\*\*([\s\S]*)\*\*$/, '$1').trim();

  // 前缀 -> 引号 -> 尾部括号，做两轮（模型可能「译文：“…”（注：…）」叠加）
  for (let pass = 0; pass < 2; pass += 1) {
    const before = s;
    s = s.replace(PREFIX_RE, '').trim();
    s = stripWrappedQuotes(s);
    for (const re of TAIL_PAREN_RES) {
      s = s.replace(re, '').trim();
    }
    if (s === before) break;
  }

  s = joinModelLines(s);
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/\s+$/g, '').trim();
  return s;
}

/* ------------------------------------------------------------------ *
 * 增量子句提取器（v0.2）：翻译还在流式输出时，把已稳定的子句提前交给 TTS。
 *
 * 契约（Lead 动态 import 使用，签名固定）：
 *   createClauseExtractor({ minClauseChars = 8, maxChunkChars = 80, stabilityMs = 250 } = {})
 *     -> { push(cumulativeText) -> string[], flush(finalText?) -> string[], reset() -> void }
 *
 * 语义：
 * - push 每次收到「当前累计译文」（partial 覆盖式传入），返回本次新确认的稳定子句（0~N 个）。
 * - 确认条件：子句以中英句末标点（。！？；;.!?…）结尾、长度 >= minClauseChars，
 *   且「从游标到该标点」的前缀内容连续 stabilityMs 没有被改写（后续追加不影响稳定性判定）。
 * - 已确认发出的内容不会重复发、不会回退；累计文本变短（清理）或前缀被改写时，
 *   内部游标安全回退到公共前缀，已发内容保留，只提取改写后的新尾巴。
 * - 数字（1,000 / 3.14 / 50%）、代码标识符（msToSamples / node.js）、URL 内的标点不算句末，
 *   不会在中间切断。
 * - 子句超过 maxChunkChars 时按标点/空格兜底切块（超长单词/URL 才硬拆）。
 * - flush 输出剩余未发内容，保证「push 发出的 + flush 的」覆盖最终译文（允许空白/标点级差异）。
 * - options.now 是测试注入钩子（默认 Date.now），生产调用方不需要传。
 * ------------------------------------------------------------------ */

/** 句末标点：只有这些字符出现才可能确认子句（逗号/顿号/冒号不算） */
const CLAUSE_SENTENCE_END = new Set(['。', '！', '？', '；', ';', '!', '?', '…']);
/** 软标点：切块时优先在这里断，不单独成块 */
const CLAUSE_SOFT_PUNCT = new Set(['，', '、', '：', ':', ',', '—', '–', '·']);
/** 括号内的句号不当作子句边界 */
const CLAUSE_OPEN_BRACKETS = new Set(['（', '(', '【', '[', '《', '「', '『', '〈', '{']);
const CLAUSE_CLOSE_BRACKETS = new Set(['）', ')', '】', ']', '》', '」', '』', '〉', '}']);
/** URL 末尾附带的 ASCII 标点要还给句子，不能算进 URL token */
const CLAUSE_URL_TAIL = '.,;:!?)]}\'"';
/** 出现在 URL 后直接结束 URL 的中文标点 */
const CLAUSE_CJK_TERMINATORS = new Set(['，', '。', '！', '？', '；', '：', '、', '）', '】', '》', '」', '』', '…']);

function cpLength(text) {
  return Array.from(String(text ?? '')).length;
}

function isDigitChar(ch) {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isAlnumUnderscore(ch) {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

function isLatinLetter(ch) {
  return ch !== undefined && /[A-Za-z]/.test(ch);
}

/** 位置 i 是否是一个 URL 的开头（http://、https://、www.） */
function isUrlStart(chars, index) {
  const rest = chars.slice(index, index + 8).join('').toLowerCase();
  return rest.startsWith('http://') || rest.startsWith('https://') || rest.startsWith('www.');
}

/** '.' 之后的下一个「有效字符」（跳过空白与收尾引号/括号） */
function nextSignificantChar(chars, index) {
  for (let i = index; i < chars.length; i += 1) {
    const ch = chars[i];
    if (/\s/.test(ch)) continue;
    if ('”’」』）)】》'.includes(ch)) continue;
    return ch;
  }
  return null;
}

/**
 * 子句 tokenizer：把文本切成不可再分的 token（word/数字/URL 整体、CJK 逐字、标点、空白）。
 * 结果带 code point 下标，便于做「游标到哪里」与「哪个标点是句末」的判断。
 */
function tokenizeClauseText(text) {
  const chars = Array.from(String(text ?? ''));
  const tokens = [];
  let i = 0;
  let bracketDepth = 0;

  const add = (type, start, end, extra = {}) => {
    tokens.push({ type, text: chars.slice(start, end).join(''), start, end, sentenceEnd: false, ...extra });
  };

  while (i < chars.length) {
    const ch = chars[i];

    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < chars.length && /\s/.test(chars[j])) j += 1;
      add('space', i, j);
      i = j;
      continue;
    }

    // URL 整体保护（内部的 . / : ? & = 等都不算标点）
    if (isUrlStart(chars, i)) {
      let j = i;
      while (
        j < chars.length &&
        !/\s/.test(chars[j]) &&
        !CJK_CHAR_RE.test(chars[j]) &&
        !CLAUSE_CJK_TERMINATORS.has(chars[j])
      ) {
        j += 1;
      }
      while (j > i && CLAUSE_URL_TAIL.includes(chars[j - 1])) j -= 1; // 句末标点还给句子
      if (j <= i) j = i + 1;
      add('word', i, j);
      i = j;
      continue;
    }

    // 数字整体保护（1,000 / 3.14 / 50% / 1.2.3）
    if (isDigitChar(ch)) {
      let j = i + 1;
      for (;;) {
        if (isDigitChar(chars[j])) {
          j += 1;
          continue;
        }
        if ((chars[j] === ',' || chars[j] === '.') && isDigitChar(chars[j + 1])) {
          j += 2;
          continue;
        }
        break;
      }
      if (chars[j] === '%') j += 1;
      add('word', i, j);
      i = j;
      continue;
    }

    // 拉丁词/代码标识符整体保护（msToSamples / node.js / api.deepseek.com/v1 / fine-tuning）
    if (isLatinLetter(ch) || ch === '_' || ch === '$') {
      let j = i + 1;
      for (;;) {
        const c = chars[j];
        if (isAlnumUnderscore(c)) {
          j += 1;
          continue;
        }
        if (c !== undefined && '._/:@-+'.includes(c) && isAlnumUnderscore(chars[j + 1])) {
          j += 2;
          continue;
        }
        break;
      }
      add('word', i, j);
      i = j;
      continue;
    }

    if (CLAUSE_OPEN_BRACKETS.has(ch)) {
      add('punct', i, i + 1);
      bracketDepth += 1;
      i += 1;
      continue;
    }
    if (CLAUSE_CLOSE_BRACKETS.has(ch)) {
      add('punct', i, i + 1);
      bracketDepth = Math.max(0, bracketDepth - 1);
      i += 1;
      continue;
    }

    // 中文句末标点（连续标点如「？！」「……」合并为一个 token）
    if (CLAUSE_SENTENCE_END.has(ch)) {
      let j = i + 1;
      while (j < chars.length && CLAUSE_SENTENCE_END.has(chars[j])) j += 1;
      add('punct', i, j, { sentenceEnd: bracketDepth === 0 });
      i = j;
      continue;
    }

    // 英文句点：数字/标识符/URL 内部已在上面消费；剩下的按「后面是否像新句子开头」判断
    if (ch === '.') {
      const prev = chars[i - 1];
      const nextSignificant = nextSignificantChar(chars, i + 1);
      const nextIsWordChar = chars[i + 1] !== undefined && /[A-Za-z0-9_]/.test(chars[i + 1]);
      const prevIsDigit = isDigitChar(prev);
      const sentenceEnd =
        bracketDepth === 0 &&
        !prevIsDigit &&
        !nextIsWordChar &&
        (nextSignificant === null || CJK_CHAR_RE.test(nextSignificant) || /[A-Z0-9]/.test(nextSignificant));
      add('punct', i, i + 1, { sentenceEnd });
      i += 1;
      continue;
    }

    if (CLAUSE_SOFT_PUNCT.has(ch)) {
      add('punct', i, i + 1);
      i += 1;
      continue;
    }

    add('other', i, i + 1);
    i += 1;
  }
  return tokens;
}

/** 从游标 from 开始，收集所有「长度 >= minClauseChars 的句末标点」作为候选子句边界 */
function collectClauseBoundaries(tokens, chars, from, minClauseChars) {
  const out = [];
  for (const token of tokens) {
    if (!token.sentenceEnd || token.end <= from) continue;
    const raw = chars.slice(from, token.end).join('');
    const text = raw.trim();
    if (cpLength(text) < minClauseChars) continue;
    out.push({ end: token.end, text, raw });
  }
  return out;
}

/**
 * 子句超长时兜底切块：优先在标点/空格处断，数字/代码/URL token 不拆；
 * 只有单个 token 自身超过 maxChunkChars（如超长 URL）才硬拆。
 */
function chunkClauseText(text, maxChunkChars) {
  const source = String(text ?? '').trim();
  if (!source) return [];
  const max = Math.max(4, Math.floor(Number(maxChunkChars) || 80));
  const chars = Array.from(source);
  if (chars.length <= max) return [source];

  const tokens = tokenizeClauseText(source);
  const chunks = [];
  let buffer = '';
  let bufferLen = 0;
  /** buffer 内最近一次标点/空格之后的切点（用于优先在标点处断块） */
  let punctBreak = -1;
  let spaceBreak = -1;

  const resetBreaks = () => {
    punctBreak = -1;
    spaceBreak = -1;
  };
  const pushBuffer = () => {
    const trimmed = buffer.trim();
    if (trimmed) chunks.push(trimmed);
    buffer = '';
    bufferLen = 0;
    resetBreaks();
  };
  const append = (piece, pieceLen) => {
    buffer += piece;
    bufferLen += pieceLen;
  };
  const splitBufferAt = (at) => {
    const head = Array.from(buffer).slice(0, at).join('');
    const tail = Array.from(buffer).slice(at).join('').trimStart();
    const trimmed = head.trim();
    if (trimmed) chunks.push(trimmed);
    buffer = tail;
    bufferLen = Array.from(tail).length;
    resetBreaks();
  };

  for (const token of tokens) {
    const piece = token.text;
    const pieceLen = Array.from(piece).length;
    if (token.type === 'space' && bufferLen === 0) continue;

    if (bufferLen > 0 && bufferLen + pieceLen > max) {
      // 标点悬挂：句末/软标点不单独落到下一块（允许超 1-2 字符）
      const hanging = token.type === 'punct' && bufferLen + pieceLen <= max + 2;
      if (hanging) {
        append(piece, pieceLen);
        punctBreak = bufferLen;
        continue;
      }
      // 兜底切块优先断在标点，其次空格；太靠前（< 40% max）就按长度断
      const minChunk = Math.max(4, Math.floor(max * 0.4));
      const at = punctBreak >= minChunk ? punctBreak : spaceBreak >= minChunk ? spaceBreak : -1;
      if (at > 0 && at < bufferLen) splitBufferAt(at);
      else pushBuffer();
    }
    // 切分后仍放不下（剩余尾巴+新 token 超限）：先把尾巴收掉
    if (bufferLen > 0 && bufferLen + pieceLen > max) pushBuffer();

    if (pieceLen > max) {
      // 超长单词/URL：只能硬拆兜底
      if (bufferLen > 0) pushBuffer();
      const atom = Array.from(piece);
      for (let i = 0; i < atom.length; i += max) {
        const part = atom.slice(i, i + max).join('');
        if (i + max < atom.length) chunks.push(part);
        else append(part, Array.from(part).length);
      }
      continue;
    }

    append(piece, pieceLen);
    if (token.type === 'punct') punctBreak = bufferLen;
    else if (token.type === 'space') spaceBreak = bufferLen;
  }
  pushBuffer();
  return chunks;
}

/**
 * 创建增量子句提取器（契约见上方大段注释）。
 * @param {object} [options]
 * @param {number} [options.minClauseChars=8] 子句最短字符数（含标点，trim 后计）
 * @param {number} [options.maxChunkChars=80] 单块最大字符数（超长兜底切块）
 * @param {number} [options.stabilityMs=250] 子句前缀需要连续稳定多久才确认
 * @param {() => number} [options.now] 测试注入时钟（默认 Date.now），生产不传
 */
export function createClauseExtractor(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const rawMin = Number(opts.minClauseChars);
  const rawMax = Number(opts.maxChunkChars);
  const rawStability = Number(opts.stabilityMs);
  const minClauseChars = Number.isFinite(rawMin) && rawMin >= 1 ? Math.floor(rawMin) : 8;
  const maxChunkChars = Number.isFinite(rawMax) && rawMax >= 4 ? Math.floor(rawMax) : 80;
  const stabilityMs = Number.isFinite(rawStability) && rawStability >= 0 ? Math.floor(rawStability) : 250;
  const nowFn = typeof opts.now === 'function' ? opts.now : Date.now;

  /** 已发出的累计原文前缀（游标 = 其 code point 长度） */
  let emittedRaw = '';
  let cursorLen = 0;
  /** 最近一次 push/flush 看到的累计译文 */
  let lastText = '';
  /** 候选边界观察时间：`end|子句文本` -> 首次被看到的时间 */
  let seen = new Map();

  const now = () => {
    const value = Number(nowFn());
    return Number.isFinite(value) ? value : Date.now();
  };

  function reset() {
    emittedRaw = '';
    cursorLen = 0;
    lastText = '';
    seen = new Map();
  }

  /**
   * 把内部游标与新的累计文本对齐：
   * - 正常增长：游标不动；
   * - 纯截断（新文本是已发内容的旧前缀，通常是清洗剥掉了尾部注释）：游标不回退；
   * - 前缀被改写：游标回退到公共前缀，已发出的内容不重发，观察记录清空。
   */
  function syncCursor(chars) {
    const emittedChars = Array.from(emittedRaw);
    const emittedLen = emittedChars.length;
    if (emittedLen === 0) {
      cursorLen = 0;
      return 0;
    }
    const compareLen = Math.min(emittedLen, chars.length);
    let same = true;
    for (let i = 0; i < compareLen; i += 1) {
      if (chars[i] !== emittedChars[i]) {
        same = false;
        break;
      }
    }
    if (same) {
      cursorLen = emittedLen;
      return emittedLen; // 正常增长，或纯截断：都保持游标
    }
    let common = 0;
    while (common < compareLen && chars[common] === emittedChars[common]) common += 1;
    emittedRaw = emittedChars.slice(0, common).join('');
    cursorLen = common;
    seen = new Map();
    return common;
  }

  function pruneSeen(validKeys) {
    for (const key of [...seen.keys()]) {
      if (!validKeys.has(key)) seen.delete(key);
    }
  }

  /**
   * 输入当前累计译文，返回本次新确认的稳定子句（可能 0~N 个）。
   * @param {string} cumulativeText
   * @returns {string[]}
   */
  function push(cumulativeText) {
    const text = String(cumulativeText ?? '');
    const t = now();
    lastText = text;
    const chars = Array.from(text);
    cursorLen = syncCursor(chars);
    if (cursorLen > chars.length) {
      // 纯截断：还没有新内容可提取
      seen = new Map();
      return [];
    }

    const tokens = tokenizeClauseText(text);
    const out = [];
    for (;;) {
      const boundaries = collectClauseBoundaries(tokens, chars, cursorLen, minClauseChars);
      const validKeys = new Set();
      let emitIndex = -1;
      for (let index = 0; index < boundaries.length; index += 1) {
        const boundary = boundaries[index];
        const key = `${boundary.end}\u0000${boundary.text}`;
        validKeys.add(key);
        if (!seen.has(key)) seen.set(key, t);
        if (emitIndex < 0 && t - seen.get(key) >= stabilityMs) emitIndex = index;
      }
      pruneSeen(validKeys);
      if (emitIndex < 0) break;

      const target = boundaries[emitIndex];
      emittedRaw += target.raw;
      cursorLen = cpLength(emittedRaw);
      out.push(...chunkClauseText(target.text, maxChunkChars));
      // 已消费边界之前的观察记录可以丢掉
      for (const key of [...seen.keys()]) {
        const end = Number(key.split('\u0000')[0]);
        if (end <= cursorLen) seen.delete(key);
      }
    }
    return out;
  }

  /**
   * 翻译结束：输出剩余未发内容（按标点/长度兜底切块）。
   * @param {string} [finalText] 最终译文；不传则用最近一次 push 的累计文本
   * @returns {string[]}
   */
  function flush(finalText) {
    const text = finalText === undefined || finalText === null ? lastText : String(finalText);
    lastText = text;
    const chars = Array.from(text);
    cursorLen = syncCursor(chars);
    const start = Math.min(cursorLen, chars.length);
    const remaining = chars.slice(start).join('').trim();
    // 用最终文本覆盖游标：重复 flush 返回空数组
    emittedRaw = chars.join('');
    cursorLen = chars.length;
    seen = new Map();
    if (!remaining) return [];
    return chunkClauseText(remaining, maxChunkChars);
  }

  return { push, flush, reset };
}

/* ------------------------------------------------------------------ *
 * SSE / OpenAI 兼容响应解析
 * ------------------------------------------------------------------ */

/**
 * 解析一行 SSE。返回：
 *   { done: true }                  -> 收到 [DONE]
 *   { delta, model }                -> 一段增量文本
 *   null                            -> 注释 / keep-alive / 无内容
 * 抛 readableError 表示上游返回了 error 结构。
 */
function parseSseLine(line, providerName) {
  const raw = String(line ?? '').replace(/\r$/, '');
  if (!raw.trim()) return null;
  if (raw.startsWith(':')) return null; // SSE 注释/心跳
  if (!raw.startsWith('data:')) return null; // event:/id:/retry: 等字段忽略
  const payload = raw.slice(5).trim();
  if (!payload) return null;
  if (payload === '[DONE]') return { done: true };
  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    return null; // 非 JSON 心跳（部分网关会发 data: ping），忽略
  }
  if (data?.error) {
    const detail = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
    throw readableError(`provider "${providerName}" 流式返回错误：${String(detail).slice(0, 300)}`);
  }
  const model = typeof data?.model === 'string' ? data.model : '';
  const choices = data?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0] ?? {};
  const delta =
    choice?.delta?.content ??
    choice?.delta?.text ??
    (typeof choice?.text === 'string' ? choice.text : null) ??
    choice?.message?.content ??
    null;
  if (typeof delta !== 'string' || delta.length === 0) return null;
  return { delta, model };
}

/** 把流式响应帧喂给状态机（测试可直接用，但主要通过 fake fetch 走 translate） */
function createStreamAccumulator({ providerName, onPartial, throttleMs, log = () => {} }) {
  let text = '';
  let model = '';
  let lastEmitAt = -Infinity;
  let lastEmittedText = '';

  function emit(force) {
    if (typeof onPartial !== 'function') return;
    const visible = cleanTranslation(text);
    if (!visible || visible === lastEmittedText) return;
    const nowMs = Date.now();
    if (!force && nowMs - lastEmitAt < throttleMs) return;
    lastEmitAt = nowMs;
    lastEmittedText = visible;
    try {
      onPartial(visible);
    } catch (err) {
      // UI 回调异常不能影响翻译主流程
      log(`onPartial 回调异常（已忽略）：${err?.message ?? err}`);
    }
  }

  function applyDelta(delta, chunkModel) {
    if (chunkModel) model = chunkModel;
    const chunk = String(delta ?? '');
    if (!chunk) return;

    // 兼容 1：累计式快照 —— 部分 OpenAI 兼容网关（如 MiniMax M2.x 语义）每帧回传
    // 「截至目前的全部文本」而不是增量；此时用新快照替换旧文本，否则会重复。
    if (text && chunk.length > text.length && chunk.startsWith(text)) {
      text = chunk;
      emit(false);
      return;
    }

    // 兼容 2：整段重复 —— 个别网关在 [DONE] 前把最终全量快照再发一遍；
    // 与已累计文本完全一致（忽略首尾空白）时忽略，避免译文翻倍。
    if (text) {
      const chunkTrimmed = chunk.trim();
      const textTrimmed = text.trim();
      if (chunkTrimmed && chunkTrimmed === textTrimmed && Array.from(textTrimmed).length >= 2) return;
    }

    text += chunk;
    emit(false);
  }

  function begin() {
    text = '';
    model = '';
    lastEmitAt = -Infinity;
    lastEmittedText = '';
  }

  return {
    begin,
    applyDelta,
    emit,
    get text() {
      return text;
    },
    get model() {
      return model;
    },
  };
}

async function readJsonCompletion(response, providerName) {
  let raw = '';
  try {
    raw = await response.text();
  } catch (err) {
    throw readableError(`provider "${providerName}" 响应读取失败：${err?.message ?? err}`, err);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw readableError(`provider "${providerName}" 返回的不是合法 JSON（检查 baseUrl/chatPath 是否指向 OpenAI 兼容端点）`);
  }
  return extractCompletionData(data, providerName);
}

function extractCompletionData(data, providerName) {
  if (data?.error) {
    const detail = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
    throw readableError(`provider "${providerName}" 返回错误：${String(detail).slice(0, 300)}`);
  }
  const choices = data?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw readableError(`provider "${providerName}" 响应缺少 choices（检查模型名与 chatPath 是否为 OpenAI 兼容接口）`);
  }
  const choice = choices[0] ?? {};
  const content = choice?.message?.content ?? choice?.text ?? '';
  return { text: String(content ?? ''), model: typeof data?.model === 'string' ? data.model : '' };
}

/**
 * 消费一次 chat/completions 响应：优先 SSE 流式，退化到整包 JSON。
 * @returns {Promise<{text: string, model: string}>}
 */
async function consumeChatCompletion({ response, providerName, onPartial, throttleMs, signal, log }) {
  const contentType = String(response?.headers?.get?.('content-type') ?? '').toLowerCase();
  const body = response?.body;

  if (!body || (contentType.includes('application/json') && !contentType.includes('event-stream'))) {
    return readJsonCompletion(response, providerName);
  }

  const acc = createStreamAccumulator({ providerName, onPartial, throttleMs, log });
  acc.begin();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawDone = false;

  try {
    while (!sawDone) {
      if (signal?.aborted) throw makeAbortError('翻译流已被中断');
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while (!sawDone && (newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const event = parseSseLine(line, providerName);
        if (!event) continue;
        if (event.done) {
          sawDone = true;
          break;
        }
        acc.applyDelta(event.delta, event.model);
      }
    }
    // 收尾：flush TextDecoder + 处理最后一行没有换行符的 data
    buffer += decoder.decode();
    if (!sawDone && buffer.trim()) {
      const event = parseSseLine(buffer, providerName);
      if (event && !event.done) acc.applyDelta(event.delta, event.model);
    }
    if (signal?.aborted) throw makeAbortError('翻译流已被中断');
  } finally {
    try {
      await reader.cancel?.();
    } catch {
      /* 已结束的流 cancel 会抛，忽略 */
    }
  }

  acc.emit(true);
  return { text: acc.text, model: acc.model };
}

/* ------------------------------------------------------------------ *
 * 工厂
 * ------------------------------------------------------------------ */

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function normalizeChain(cfg, primary) {
  if (primary === 'mock') return ['mock'];
  const configured = Array.isArray(cfg.chain) ? cfg.chain : [];
  const chain = configured.map((name) => String(name ?? '').trim()).filter(Boolean);
  if (chain.length === 0) chain.push(...DEFAULT_CHAIN);
  if (!chain.includes(primary)) chain.unshift(primary);
  return [...new Set(chain)];
}

function assertSupportedProviders(names) {
  for (const name of names) {
    if (!SUPPORTED_PROVIDERS.has(name)) {
      throw new Error(
        `unknown provider: ${name}（翻译支持 ${[...SUPPORTED_PROVIDERS].join(' / ')}；检查 config/livedub.config.json 的 translate.provider / translate.chain）`,
      );
    }
  }
}

function buildChatUrl(provider) {
  const baseUrl = String(provider.baseUrl ?? '').replace(/\/+$/, '');
  const chatPath = String(provider.chatPath ?? '/chat/completions');
  return `${baseUrl}${chatPath.startsWith('/') ? chatPath : `/${chatPath}`}`;
}

function buildRequestBody({ model, messages, cfg }) {
  const temperature = Number(cfg.temperature);
  const body = {
    model,
    messages,
    stream: true,
    temperature: Number.isFinite(temperature) ? temperature : 0,
    max_tokens: positiveInt(cfg.maxTokens, DEFAULT_MAX_TOKENS),
  };
  return body;
}

/**
 * 创建翻译器。
 * @param {object} options
 * @param {object} [options.config] 完整配置（含 translate / glossary / session）；也接受只传 translate 段
 * @param {(msg: string) => void} [options.log]
 * @param {typeof fetch} [options.fetchImpl] 测试注入点；默认 globalThis.fetch
 */
export function createTranslator({ config = {}, log = () => {}, fetchImpl = globalThis.fetch } = {}) {
  if (typeof log !== 'function') log = () => {};
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('createTranslator 需要 fetch：请在 Node >= 22 运行，或注入 fetchImpl（测试用）');
  }

  const { cfg, root } = splitTranslateConfig(config);
  const primary = String(cfg.provider ?? '').trim() || DEFAULT_CHAIN[0];
  const chain = normalizeChain(cfg, primary);
  assertSupportedProviders(chain);

  const partialThrottleMs = (() => {
    const n = Number(cfg.partialThrottleMs);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PARTIAL_THROTTLE_MS;
  })();
  const maxInputChars = positiveInt(cfg.maxInputChars, DEFAULT_MAX_INPUT_CHARS);
  const mockTranslator = chain.includes('mock') ? createMockTranslator({ config: root, log }) : null;

  async function translateWithMock({ text, signal, onPartial }) {
    if (!mockTranslator) throw readableError('mock 翻译器未初始化');
    const result = await mockTranslator.translate({ text, signal, onPartial });
    return { text: String(result?.text ?? ''), model: String(result?.model ?? 'mock'), provider: 'mock' };
  }

  async function translateWithProvider(providerName, { text, context, glossary, signal, onPartial }) {
    const provider = resolveProvider(root, providerName);
    if (!provider.apiKey) {
      throw readableError(
        `provider "${providerName}" 缺少 apiKey（检查 ~/.sayless/config.json 的 providers.${providerName}.apiKey 或环境变量 LIVEDUB_PROVIDER_${providerName
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, '_')}_API_KEY）`,
      );
    }

    const messages = buildTranslationMessages({ text, context, glossary, config: root });
    const body = buildRequestBody({ model: provider.model, messages, cfg });
    const url = buildChatUrl(provider);
    // 契约：config.translate.timeoutMs 优先；未配置时退回 provider.timeoutMs / 默认值
    const providerTimeoutMs = positiveNumber(cfg.timeoutMs, positiveNumber(provider.timeoutMs, DEFAULT_TIMEOUT_MS));

    const controller = new AbortController();
    let timedOut = false;
    let timer = null;
    const onExternalAbort = () => controller.abort();
    if (signal?.aborted) throw makeAbortError('翻译开始前已被中断');
    signal?.addEventListener?.('abort', onExternalAbort, { once: true });
    if (providerTimeoutMs > 0) {
      // 注意：这里不能 unref。若事件循环里没有其它 ref（例如测试注入的 fetch 是一个挂起 Promise），
      // 定时器被 unref 会导致 Node 22 直接排空事件循环、超时永远不触发（CI 中表现为 cancelledByParent）。
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, providerTimeoutMs);
    }

    try {
      let response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            authorization: `Bearer ${provider.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        if (timedOut) {
          throw readableError(
            `翻译超时（provider "${providerName}"，${providerTimeoutMs}ms）：可调大 config.translate.timeoutMs 或检查网络`,
            err,
          );
        }
        if (signal?.aborted || isAbortError(err)) throw makeAbortError(`翻译已被中断（provider "${providerName}"）`);
        throw readableError(
          `请求 provider "${providerName}" 失败：${err?.message ?? err}（检查网络、baseUrl 或代理设置）`,
          err,
        );
      }

      if (!response || typeof response !== 'object') {
        throw readableError(`provider "${providerName}" 未返回合法响应对象`);
      }
      if (response.ok === false) {
        let detail = '';
        try {
          detail = String(await response.text()).slice(0, 300);
        } catch {
          /* 响应体读不出来就只报状态码 */
        }
        throw readableError(
          `provider "${providerName}" HTTP ${response.status} ${response.statusText ?? ''}${detail ? `：${detail}` : ''}（检查 apiKey 是否有效、模型名是否正确）`,
        );
      }

      const { text: rawText, model } = await consumeChatCompletion({
        response,
        providerName,
        onPartial,
        throttleMs: partialThrottleMs,
        signal: controller.signal,
        log,
      });

      if (timedOut) {
        throw readableError(`翻译超时（provider "${providerName}"，${providerTimeoutMs}ms）：可调大 config.translate.timeoutMs 或检查网络`);
      }
      const cleaned = cleanTranslation(rawText);
      if (!cleaned) {
        throw readableError(`provider "${providerName}" 返回空译文（检查模型名 "${provider.model}" 与 maxTokens/内容过滤设置）`);
      }
      return { text: cleaned, model: model || provider.model, provider: providerName };
    } catch (err) {
      if (err?.livedubReadable) throw err;
      if (timedOut) {
        throw readableError(`翻译超时（provider "${providerName}"，${providerTimeoutMs}ms）：可调大 config.translate.timeoutMs 或检查网络`, err);
      }
      if (signal?.aborted) throw makeAbortError(`翻译已被中断（provider "${providerName}"）`);
      if (isAbortError(err)) throw makeAbortError(`翻译已被中断（provider "${providerName}"）`);
      throw readableError(`provider "${providerName}" 翻译失败：${err?.message ?? err}`, err);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onExternalAbort);
    }
  }

  return {
    /** 主 provider 名称（给 ready 事件展示；单次调用的实际 provider 见返回值） */
    name: primary,
    provider: primary,
    /** 降级链（只读快照，便于排查） */
    chain: chain.slice(),

    /**
     * 翻译一句文本。
     * @returns {Promise<{text: string, model?: string, provider?: string}>}
     */
    async translate({ text, context = [], glossary = [], signal, onPartial } = {}) {
      if (signal?.aborted) throw makeAbortError('翻译开始前已被中断');
      let input = String(text ?? '').trim();
      if (!input) return { text: '', model: '', provider: primary };

      const inputChars = Array.from(input).length;
      if (inputChars > maxInputChars) {
        input = Array.from(input).slice(0, maxInputChars).join('');
        log(`translate 输入超长（${inputChars} > ${maxInputChars} 字符），已截断后翻译`);
      }

      const failures = [];
      for (let index = 0; index < chain.length; index += 1) {
        const providerName = chain[index];
        if (signal?.aborted) throw makeAbortError('翻译已被中断');
        try {
          const result =
            providerName === 'mock'
              ? await translateWithMock({ text: input, signal, onPartial })
              : await translateWithProvider(providerName, {
                  text: input,
                  context,
                  glossary,
                  signal,
                  onPartial,
                });
          if (!result.text) throw readableError(`provider "${providerName}" 返回空译文`);
          if (providerName !== primary) log(`translate 使用备胎 provider "${providerName}" 成功`);
          return result;
        } catch (err) {
          if (isAbortError(err) || signal?.aborted) throw err;
          failures.push(`${providerName}: ${err?.message ?? err}`);
          const next = chain[index + 1];
          if (next) log(`translate provider "${providerName}" 失败（${err?.message ?? err}），降级尝试 "${next}"`);
          else log(`translate provider "${providerName}" 失败（${err?.message ?? err}），没有更多备胎`);
        }
      }

      throw new Error(
        `翻译全部 provider 失败：${failures.join('；')}。下一步：检查网络/API Key（~/.sayless/config.json），或把 config.translate.provider 换成可用的 provider（mock 可离线演示）。`,
      );
    },
  };
}

/* ------------------------------------------------------------------ *
 * v0.3 ASR 草稿翻译复用工具（云端 ASR partial 先翻译、final 确认后复用）
 *
 * 场景：云端 ASR 的 partial 文本先送翻译（草稿），final 到达时若 finalSource 与
 * draftSource 足够一致，就直接复用草稿译文，省掉一次完整翻译（~0.8-1s），把 e2e 压下来。
 *
 * 契约（Lead 动态 import 使用，签名固定）：
 *   normalizeForMatch(text) -> string
 *     去空白/标点/符号/大小写差异（NFKC 归一全角->半角），保留数字与标识符字母数字；
 *     仅用于相似度比较——数字/代码标识符的差异由 draftTranslationReusable 内的硬规则保护。
 *   draftTranslationReusable({ draftSource, finalSource, threshold = 0.82 }) -> boolean
 *     数字 token 或代码标识符 token 不一致 => 直接 false（绝不复用会译错内容的草稿）；
 *     草稿只是 final 的纯前缀/纯尾部（增删 > 3 字符）=> false（草稿译文缺内容/多内容）；
 *     否则：normalized 完全相同 => true；相似度 = 字符级相似度 * (0.8 + 0.2*前缀比例)
 *     （前缀比例 = 公共前缀 / 较短文本长度），>= threshold => true。
 *   createDraftTranslationCache({ maxEntries = 32 } = {})
 *     -> { set(key, { draftSource, text }), get(key), delete(key), stats() }  （LRU，key 由调用方给）
 *     stats: { size, maxEntries, hits, misses, sets, evictions, deletes, hitRate }
 *   draftTranslationScore({ draftSource, finalSource }) -> number  // 诊断辅助（Lead 打日志/调阈值用）
 *
 * 阈值建议：默认 0.82。偏保守（宁可重译）用 0.85-0.88；追求复用率且能接受偶发小偏差用 0.78-0.80。
 * ------------------------------------------------------------------ */

/** 用于相似度比较时忽略的字符：标点、符号、空白、零宽字符（数字/字母保留） */
const MATCH_STRIP_RE = /[\p{P}\p{S}\s\u200b-\u200f\u2028\u2029\ufeff]/gu;
/** 数字 token：1,000 / 3.14 / 50% / 1.2.3 */
const NUMBER_TOKEN_RE = /\d+(?:[.,]\d+)*\s*%?/g;
/** 标识符 token：msToSamples / node.js / api.deepseek.com/v1 / foo_bar / x+y */
const CODE_TOKEN_RE = /[A-Za-z_$][A-Za-z0-9_$]*(?:[._/:@+][A-Za-z0-9_$]+)*/g;
/** 纯尾部增删超过这么多字符，就认为草稿译文会缺内容/多内容，不复用 */
const MAX_TAIL_GAP = 3;

function nfkcText(text) {
  const s = String(text ?? '');
  try {
    return s.normalize('NFKC');
  } catch {
    return s;
  }
}

function codePointsOf(text) {
  return Array.from(String(text ?? ''));
}

function isCodeLikeToken(token) {
  // 内部连接符（node.js / foo_bar / a/b / x+y）或 camelCase（msToSamples）
  return /[._/:@+]/.test(token) || /[a-z][A-Z]/.test(token);
}

/**
 * 归一化文本用于相似度比较：NFKC + 小写 + 去空白/标点/符号。
 * 注意：数字与代码标识符的「硬约束」不在本函数里，由 draftTranslationReusable 用原始文本校验。
 * @param {string} text
 * @returns {string}
 */
export function normalizeForMatch(text) {
  const source = nfkcText(text);
  if (!source) return '';
  return source.toLowerCase().replace(MATCH_STRIP_RE, '');
}

function extractNumberTokens(text) {
  const tokens = [];
  for (const match of nfkcText(text).matchAll(NUMBER_TOKEN_RE)) {
    tokens.push(match[0].replace(/\s+/g, '').replace(/,/g, '').toLowerCase());
  }
  return tokens.sort();
}

function extractCodeTokens(text) {
  const tokens = [];
  for (const match of nfkcText(text).matchAll(CODE_TOKEN_RE)) {
    const token = match[0];
    if (isCodeLikeToken(token)) tokens.push(token);
  }
  return tokens.sort();
}

function sameTokenMultiset(left, right) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function commonPrefixLength(left, right) {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) index += 1;
  return index;
}

function levenshteinDistance(left, right) {
  const a = left;
  const b = right;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = new Array(b.length + 1);
  let current = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = current[j - 1] + 1;
      const deletion = previous[j] + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length];
}

/**
 * 草稿 ASR 文本与最终 ASR 文本的匹配分（0~1，仅相似度维度，不含数字/代码硬规则）。
 * 诊断辅助：Lead 可用它打日志、按实际数据调 threshold。
 * @param {{draftSource?: string, finalSource?: string}} input
 * @returns {number}
 */
export function draftTranslationScore({ draftSource = '', finalSource = '' } = {}) {
  const draft = normalizeForMatch(draftSource);
  const final = normalizeForMatch(finalSource);
  if (!draft || !final) return 0;
  if (draft === final) return 1;
  const draftChars = codePointsOf(draft);
  const finalChars = codePointsOf(final);
  const maxLen = Math.max(draftChars.length, finalChars.length);
  const minLen = Math.min(draftChars.length, finalChars.length);
  if (maxLen === 0) return 0;
  const distance = levenshteinDistance(draftChars, finalChars);
  const similarity = Math.max(0, Math.min(1, 1 - distance / maxLen));
  const prefixRatio = commonPrefixLength(draftChars, finalChars) / Math.max(1, minLen);
  const score = similarity * (0.8 + 0.2 * prefixRatio);
  return Math.round(score * 1000) / 1000;
}

/**
 * ASR 草稿文本与最终文本是否足够一致、可以复用草稿译文（boolean，保守策略）。
 *
 * 判定顺序：
 * 1. 任一为空/只有标点 => false；
 * 2. 数字 token 不一致 => false；
 * 3. 代码标识符/URL token 不一致 => false；
 * 4. 归一化后完全相同 => true；
 * 5. 一方是另一方纯前缀且差 > MAX_TAIL_GAP 字符 => false（草稿译文缺/多内容）；
 * 6. 相似度 >= threshold => true。
 */
export function draftTranslationReusable({ draftSource = '', finalSource = '', threshold = 0.82 } = {}) {
  const draftRaw = String(draftSource ?? '');
  const finalRaw = String(finalSource ?? '');
  if (!draftRaw.trim() || !finalRaw.trim()) return false;

  // 硬规则：数字/代码标识符不一致 = 草稿译文不可信（ASR 把 0.001 听成 0.01 之类）
  if (!sameTokenMultiset(extractNumberTokens(draftRaw), extractNumberTokens(finalRaw))) return false;
  if (!sameTokenMultiset(extractCodeTokens(draftRaw), extractCodeTokens(finalRaw))) return false;

  const draft = normalizeForMatch(draftRaw);
  const final = normalizeForMatch(finalRaw);
  if (!draft || !final) return false;
  if (draft === final) return true;

  // 纯尾部增删：partial 通常比 final 短，若 final 只是尾巴更长 => 草稿译文缺内容，不复用
  const draftChars = codePointsOf(draft);
  const finalChars = codePointsOf(final);
  if (finalChars.length > draftChars.length && final.startsWith(draft) && finalChars.length - draftChars.length > MAX_TAIL_GAP) {
    return false;
  }
  if (draftChars.length > finalChars.length && draft.startsWith(final) && draftChars.length - finalChars.length > MAX_TAIL_GAP) {
    return false;
  }

  const numericThreshold = Number(threshold);
  const effectiveThreshold = Number.isFinite(numericThreshold) ? Math.max(0, Math.min(1, numericThreshold)) : 0.82;
  return draftTranslationScore({ draftSource: draftRaw, finalSource: finalRaw }) >= effectiveThreshold;
}

/**
 * 草稿翻译缓存（LRU，key 由调用方给）。
 * - set(key, { draftSource, text })：写入/覆盖并刷新为最近使用；超出 maxEntries 淘汰最久未用；
 * - get(key)：命中返回 { draftSource, text } 并刷新 LRU；未命中返回 undefined；
 * - delete(key)：删除，返回是否删除成功；
 * - stats()：{ size, maxEntries, hits, misses, sets, evictions, deletes, hitRate }。
 * @param {{maxEntries?: number}} [options]
 */
export function createDraftTranslationCache({ maxEntries = 32 } = {}) {
  const requested = Number(maxEntries);
  const limit = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 32;
  const store = new Map();
  let hits = 0;
  let misses = 0;
  let sets = 0;
  let evictions = 0;
  let deletes = 0;

  return {
    set(key, value) {
      const cacheKey = String(key ?? '');
      const entry = {
        draftSource: String(value?.draftSource ?? ''),
        text: String(value?.text ?? ''),
      };
      if (store.has(cacheKey)) store.delete(cacheKey);
      store.set(cacheKey, entry);
      sets += 1;
      while (store.size > limit) {
        const oldestKey = store.keys().next().value;
        store.delete(oldestKey);
        evictions += 1;
      }
      return entry;
    },

    get(key) {
      const cacheKey = String(key ?? '');
      if (!store.has(cacheKey)) {
        misses += 1;
        return undefined;
      }
      const entry = store.get(cacheKey);
      // 刷新 LRU：删除后重新插入到队尾
      store.delete(cacheKey);
      store.set(cacheKey, entry);
      hits += 1;
      return entry;
    },

    delete(key) {
      const cacheKey = String(key ?? '');
      const deleted = store.delete(cacheKey);
      if (deleted) deletes += 1;
      return deleted;
    },

    stats() {
      const total = hits + misses;
      return {
        size: store.size,
        maxEntries: limit,
        hits,
        misses,
        sets,
        evictions,
        deletes,
        hitRate: total > 0 ? hits / total : 0,
      };
    },
  };
}

