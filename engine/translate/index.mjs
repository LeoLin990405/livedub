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

  const serviceLine =
    style === 'teaching'
      ? '你是一名资深的同声传译员，正在为中文观众实时翻译英文教学视频（公开课 / 技术课程）。'
      : `你是一名资深的同声传译员，正在把${langName(from, '原文语言')}实时翻译成${langName(to, '目标语言')}。`;

  const system = [
    serviceLine,
    '请严格遵守以下要求：',
    '1. 忠实：只翻译说话人实际说出的内容，不增删、不总结、不解释、不扩写，不添加任何评论、旁白或提示。',
    '2. 口语化：译文要像老师现场讲中文一样自然，句子短、可直接被 TTS 朗读；避免书面腔、文言和翻译腔。',
    '3. 保留原文：数学公式、变量名、函数名、代码标识符、命令行、URL、产品名与专有名词保持原样，不翻译、不改写、不加音译。',
    '4. 术语表是强约束：原文出现术语表中的 src 时，必须使用对应的 dst 译法，不得改写、另译或省略。',
    '5. 只输出译文本身：不要输出原文、拼音、注释或解释性括号；不要以「译文：」等前缀开头，不要用引号包裹整句。',
    `6. 输出简体中文（如果目标语言是${langName(to, '目标语言')}）；中文与英文术语混排时保持自然。`,
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
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, providerTimeoutMs);
      timer.unref?.();
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
