/**
 * MiniMax 云端 ASR provider（`minimax-cloud`，模型 `asr-1.0`）。
 *
 * 能力与约束（2026-10 官方文档 + 本机实测）：
 * - POST `${baseUrl}/speech_to_text`，multipart：`model=asr-1.0` + `file=WAV(16k mono)`；
 *   `Authorization: Bearer <providers.minimax.apiKey>`；可选 header `language: en`（`languageHeader`）。
 * - 非流式 JSON：`{ text, duration, trace_id }`；流式：form 里加 `stream=true`，SSE `data: {...}`
 *   事件字段 `index/delta/finish/duration`，delta 为**增量**文本（需客户端累计）。
 * - **不支持音频流式输入**：仍由本地 VAD（engine/segmenter.mjs）切句，每个 final 段一次请求。
 * - 降级：网络/401/超时/空文本等失败时，本段用本地 fallback provider（如 whisper-local）兜底；
 *   连续失败达到 `circuitBreakerFailures` 后本会话熔断、后续直接走本地，不再打云端。
 *
 * 契约（docs/CONTRACTS.md §4）：createAsr 返回 { name, push, flush, close, warmup?, stats? }，
 * final 事件 t0Ms/t1Ms 用**音频时间轴**且严格有序、不重叠。
 *
 * 测试注入：`fetchImpl`（假云端）、`fallbackFactory`（假本地 provider）。
 * 安全：apiKey 只在 Authorization header 中出现，不写日志/不落盘/不放进 stats。
 */
import { pcmDurationMs, wavFromPcm } from '../audio.mjs';
import { resolveProvider } from '../config.mjs';
import { createSegmenter } from '../segmenter.mjs';
import { cleanAsrText, truncate } from './text.mjs';

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_MODEL = 'asr-1.0';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_CIRCUIT_BREAKER_FAILURES = 3;
const CLOSE_DRAIN_TIMEOUT_MS = 3000;
const PARTIAL_DEFAULTS = Object.freeze({ enabled: false, mode: 'final-only', intervalMs: 600, minChars: 4 });

function sleep(ms) {
  return new Promise((resolve) => {
    // 不 unref：该 sleep 会在 await 路径上使用（重试/收尾），必须保持事件循环
    setTimeout(resolve, Math.max(0, ms));
  });
}

function finiteNum(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function abortError(message = '操作已取消') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function isAbortError(err) {
  return err?.name === 'AbortError' || err?.name === 'TimeoutError';
}

function tagError(err, code, extra = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  if (!e.code) e.code = code;
  Object.assign(e, extra);
  return e;
}

/** 给可能不响应 AbortSignal 的 promise 加兜底超时（测试注入的 fetchImpl 也能兜住） */
function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(tagError(new Error(message), 'CLOUD_TIMEOUT', { retryable: true }));
    }, Math.max(0, ms));
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function sanitizeBody(text) {
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * 解析/归一化 minimax-cloud 配置（不打印密钥）。
 * @param {object} config 完整配置
 */
export function resolveMinimaxCloudConfig(config = {}) {
  const asr = config?.asr ?? {};
  const whisper = asr.whisper ?? {};
  const cloud = asr.minimaxCloud ?? {};
  const partial = cloud.partial ?? {};
  const provider = resolveProvider(config, 'minimax');
  const baseUrl = String(cloud.baseUrl || provider.baseUrl || 'https://api.minimaxi.com/v1').replace(/\/+$/, '');
  const language = String(cloud.language || whisper.language || config?.session?.langFrom || 'en');
  const languageHeaderCfg = cloud.languageHeader;
  let languageHeader = null;
  if (languageHeaderCfg === true) languageHeader = language && language !== 'auto' ? language : null;
  else if (typeof languageHeaderCfg === 'string' && languageHeaderCfg.trim()) languageHeader = languageHeaderCfg.trim();
  // false / null / 未配置 -> 不发 language header（由模型自动检测）
  const fallbackProviderRaw = asr.fallback;
  const fallbackProvider =
    typeof fallbackProviderRaw === 'string' && fallbackProviderRaw.trim() ? fallbackProviderRaw.trim() : null;
  return {
    apiKey: String(provider.apiKey || ''),
    baseUrl,
    endpoint: `${baseUrl}/speech_to_text`,
    model: String(cloud.model || DEFAULT_MODEL),
    timeoutMs: finiteNum(cloud.timeoutMs, DEFAULT_TIMEOUT_MS, { min: 500, max: 120000 }),
    language,
    languageHeader,
    partialEnabled: partial.enabled === true,
    partialMode: partial.mode === 'stream' ? 'stream' : 'final-only',
    partialIntervalMs: finiteNum(partial.intervalMs, PARTIAL_DEFAULTS.intervalMs, { min: 0, max: 60000 }),
    partialMinChars: finiteNum(partial.minChars, PARTIAL_DEFAULTS.minChars, { min: 1, max: 200 }),
    circuitBreakerFailures: finiteNum(
      cloud.circuitBreakerFailures ?? asr.circuitBreakerFailures,
      DEFAULT_CIRCUIT_BREAKER_FAILURES,
      { min: 1, max: 100 },
    ),
    fallbackProvider: fallbackProvider === 'minimax-cloud' ? null : fallbackProvider,
    // 可选：会话开始就后台预热本地 fallback（默认 false，避免为云端失败白白加载 574MB 模型）
    prewarmFallback: cloud.prewarmFallback === true,
    sampleRate: finiteNum(
      cloud.sampleRate ?? whisper.sampleRate ?? config?.session?.sampleRate,
      DEFAULT_SAMPLE_RATE,
      { min: 8000, max: 48000 },
    ),
  };
}

// ---------------------------------------------------------------- HTTP / SSE

/** 解析一行 SSE；非 data 行/坏 JSON 返回 null */
function parseSseLine(line) {
  const s = String(line ?? '').trim();
  if (!s || s.startsWith(':')) return null;
  if (!s.startsWith('data:')) return null;
  const payload = s.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/** 逐行消费 SSE：累计 delta、测首 delta/finish 时间（相对请求发出时刻）、回调 onDelta(accumulatedText) */
async function readSseStream({ res, onDelta, requestStartedAt = Date.now() }) {
  const bodyStartedAt = Date.now();
  const startedAt = requestStartedAt;
  const bodyPhaseMs = () => Date.now() - bodyStartedAt;
  let accumulated = '';
  let firstDeltaMs = null; // 相对请求发出时刻（含 header 等待）
  let finishMs = null;
  let bodyFinishMs = null; // 仅 body 读取阶段
  let duration = null;
  let sawFinish = false;

  const handleEvent = (ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (typeof ev.delta === 'string' && ev.delta) {
      if (firstDeltaMs == null) firstDeltaMs = Date.now() - startedAt;
      accumulated += ev.delta;
      try {
        onDelta?.(accumulated);
      } catch {
        /* 调用方回调错误不影响识别 */
      }
    }
    if (ev.finish === true || ev.finish === 1) {
      sawFinish = true;
      finishMs = Date.now() - startedAt;
      bodyFinishMs = bodyPhaseMs();
      if (Number.isFinite(Number(ev.duration))) duration = Number(ev.duration);
    }
  };

  const body = res?.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          handleEvent(parseSseLine(line));
        }
        if (sawFinish) break;
      }
      if (!sawFinish && buffer) handleEvent(parseSseLine(buffer));
    } finally {
      try {
        await reader.cancel().catch?.(() => {});
      } catch {
        /* ignore */
      }
    }
  } else {
    // 某些测试替身没有 ReadableStream body：退化为整段文本解析
    const raw = await res.text();
    for (const line of raw.split('\n')) handleEvent(parseSseLine(line));
  }

  return { text: accumulated, firstDeltaMs, finishMs, bodyFinishMs, duration, sawFinish };
}

async function requestCloud({ pcm, cfg, fetchImpl, signal, onDelta }) {
  const streaming = cfg.partialEnabled && cfg.partialMode === 'stream';
  const wav = wavFromPcm(pcm, cfg.sampleRate);
  const form = new FormData();
  form.append('model', cfg.model);
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'segment.wav');
  if (streaming) form.append('stream', 'true');
  const headers = { Authorization: `Bearer ${cfg.apiKey}` };
  if (cfg.languageHeader) headers.language = cfg.languageHeader;

  const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const startedAt = Date.now();
  let res;
  try {
    res = await withTimeout(
      Promise.resolve(fetchImpl(cfg.endpoint, { method: 'POST', headers, body: form, signal: combined })),
      cfg.timeoutMs + 1000,
      `MiniMax ASR 请求超时（${cfg.timeoutMs}ms）`,
    );
  } catch (err) {
    if (signal?.aborted) throw abortError();
    if (isAbortError(err) || err?.code === 'CLOUD_TIMEOUT') {
      throw tagError(new Error(`MiniMax ASR 请求超时（${cfg.timeoutMs}ms）`), 'CLOUD_TIMEOUT', { retryable: true });
    }
    throw tagError(new Error(`MiniMax ASR 网络错误：${err?.message ?? err}`), 'CLOUD_NETWORK', { retryable: true });
  }

  const headersMs = Date.now() - startedAt;

  if (!res || !res.ok) {
    let body = '';
    try {
      body = sanitizeBody(await res.text());
    } catch {
      /* ignore */
    }
    const status = res?.status ?? 0;
    throw tagError(
      new Error(`MiniMax ASR HTTP ${status}：${body || '无响应体'}`),
      `CLOUD_HTTP_${status}`,
      { retryable: status === 429 || status >= 500, status },
    );
  }

  if (!streaming) {
    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw tagError(new Error(`MiniMax ASR 返回非 JSON：${err?.message ?? err}`), 'CLOUD_PARSE', { retryable: true });
    }
    const text = cleanAsrText(data?.text ?? data?.data?.text ?? data?.result?.text ?? '');
    const finishedAt = Date.now();
    return {
      text,
      streaming: false,
      headersMs,
      requestMs: finishedAt - startedAt,
      firstDeltaMs: null,
      firstDeltaTotalMs: null,
      finishMs: finishedAt - startedAt,
      finishTotalMs: finishedAt - startedAt,
      duration: Number.isFinite(Number(data?.duration)) ? Number(data.duration) : null,
    };
  }

  const sse = await readSseStream({ res, onDelta, requestStartedAt: startedAt });
  const finishedAt = Date.now();
  return {
    text: cleanAsrText(sse.text),
    streaming: true,
    headersMs,
    requestMs: finishedAt - startedAt,
    firstDeltaMs: sse.firstDeltaMs,
    firstDeltaTotalMs: sse.firstDeltaMs,
    finishMs: sse.bodyFinishMs,
    finishTotalMs: sse.finishMs,
    duration: sse.duration,
    sawFinish: sse.sawFinish,
  };
}

// ---------------------------------------------------------------- session

/**
 * 创建 `minimax-cloud` ASR 会话（由 engine/asr/index.mjs 的 createAsr 调用；测试可直接用）。
 *
 * @param {object} opts
 * @param {object} opts.config 完整配置（含 asr.minimaxCloud / asr.fallback / asr.whisper.vad）
 * @param {(msg:string)=>void} [opts.log]
 * @param {(ev:object)=>void} [opts.onEvent] partial/final 事件
 * @param {typeof fetch} [opts.fetchImpl] 测试注入（假云端）
 * @param {Function} [opts.fallbackFactory] 测试注入：async ({onEvent}) => localSession
 * @param {(info:object)=>void} [opts.onError] 可恢复错误上报（Session 转成 error(scope:"asr")）
 */
export function createMinimaxCloudAsr({
  config = {},
  log = () => {},
  onEvent = () => {},
  fetchImpl = globalThis.fetch,
  onError,
  fallbackFactory,
} = {}) {
  const cfg = resolveMinimaxCloudConfig(config);
  const sampleRate = cfg.sampleRate;
  const requestLanguage = cfg.language;
  const finalLang = requestLanguage === 'auto' ? String(config?.session?.langFrom ?? 'en') : requestLanguage;
  const vadConfig = { ...(config?.asr?.whisper?.vad ?? {}), speculative: false };

  let closed = false;
  /** @type {Array<object>} final 任务 FIFO */
  const queue = [];
  let currentJob = null;
  let pumpPromise = null;
  let lastFinalT1Ms = 0;
  let lastPartialText = '';

  let consecutiveFailures = 0;
  let circuitOpen = false;
  let circuitReason = null;
  /** @type {null | object} 懒创建的本地 fallback provider */
  let fallbackSession = null;
  let fallbackCreating = null;
  let fallbackCapture = null; // 本地 provider 事件捕获数组（当前兜底调用）

  const stats = {
    cloudRequests: 0,
    cloudFinals: 0,
    cloudFailures: 0,
    cloudTimeouts: 0,
    emptyTexts: 0,
    skippedByCircuit: 0,
    fallbackFinals: 0,
    fallbackErrors: 0,
    partials: 0,
    finals: 0,
    lastCloudMs: null,
    avgCloudMs: null,
    totalCloudMs: 0,
    cloudSamples: 0,
    lastFirstDeltaMs: null,
    lastStreamMs: null,
  };

  function emit(ev) {
    if (closed || !ev) return;
    try {
      onEvent(ev);
    } catch (err) {
      log(`[minimax-cloud] onEvent 回调抛错：${err?.message ?? err}`);
    }
  }

  function reportError(job, err) {
    if (closed || isAbortError(err)) return;
    log(`[minimax-cloud] 识别失败 ${job?.t0Ms ?? '?'}-${job?.t1Ms ?? '?'}ms：${err?.message ?? err}`);
    if (typeof onError === 'function') {
      try {
        onError({
          scope: 'asr',
          kind: 'final',
          message: String(err?.message ?? err),
          recoverable: true,
          t0Ms: job?.t0Ms,
          t1Ms: job?.t1Ms,
          code: err?.code,
          error: err,
        });
      } catch {
        /* ignore */
      }
    }
  }

  function updateCloudMs(ms) {
    stats.lastCloudMs = ms;
    stats.totalCloudMs += ms;
    stats.cloudSamples += 1;
    stats.avgCloudMs = Math.round(stats.totalCloudMs / stats.cloudSamples);
  }

  function markCircuitOpen() {
    if (circuitOpen) return;
    circuitOpen = true;
    circuitReason = `连续失败 ${consecutiveFailures} 次`;
    log(`[minimax-cloud] 熔断：${circuitReason}，本会话后续直接使用本地 ${cfg.fallbackProvider ?? '（无 fallback）'}`);
    // 后台预热本地 fallback，避免熔断后第一段再等冷启动
    if (cfg.fallbackProvider && fallbackFactory) void ensureFallback().catch(() => {});
  }

  // ---- 本地 fallback ----

  async function ensureFallback() {
    if (fallbackSession) return fallbackSession;
    if (!fallbackFactory) {
      throw tagError(new Error(`minimax-cloud: 未配置本地 fallback provider（asr.fallback）`), 'FALLBACK_MISSING');
    }
    if (!fallbackCreating) {
      fallbackCreating = (async () => {
        log(`[minimax-cloud] 懒创建本地 fallback provider（${cfg.fallbackProvider ?? 'custom'}）…`);
        const session = await fallbackFactory({
          onEvent: (ev) => {
            if (closed || !ev) return;
            if (ev.type === 'final' && ev.text && fallbackCapture) fallbackCapture.push(ev);
          },
        });
        if (typeof session?.warmup === 'function') {
          try {
            await session.warmup();
          } catch (err) {
            log(`[minimax-cloud] 本地 fallback 预热失败（识别时会再试）：${err?.message ?? err}`);
          }
        }
        fallbackSession = session;
        return session;
      })().finally(() => {
        fallbackCreating = null;
      });
    }
    return fallbackCreating;
  }

  /** 用本地 provider 识别该段；只取 text，时间轴仍用云端段的 t0/t1 */
  async function recognizeFallback(job) {
    let local;
    try {
      local = await ensureFallback();
    } catch (err) {
      stats.fallbackErrors += 1;
      reportError(job, err);
      return null;
    }
    fallbackCapture = [];
    try {
      await local.push(job.pcm, job.t0Ms);
      await local.flush();
      const texts = (fallbackCapture ?? [])
        .map((ev) => cleanAsrText(ev.text))
        .filter(Boolean)
        .filter((t, i, arr) => i === 0 || t !== arr[i - 1]);
      if (texts.length === 0) {
        stats.fallbackErrors += 1;
        log('[minimax-cloud] 本地 fallback 未识别出文本');
        return null;
      }
      return { text: texts.join(' ') };
    } catch (err) {
      stats.fallbackErrors += 1;
      log(`[minimax-cloud] 本地 fallback 识别失败：${err?.message ?? err}`);
      return null;
    } finally {
      fallbackCapture = null;
    }
  }

  // ---- 队列 ----

  function schedulePump() {
    if (pumpPromise) return pumpPromise;
    pumpPromise = pump().finally(() => {
      pumpPromise = null;
    });
    return pumpPromise;
  }

  async function pump() {
    while (!closed) {
      const job = queue.shift();
      if (!job) break;
      currentJob = job;
      job.controller = new AbortController();
      try {
        await runFinal(job);
      } catch (err) {
        reportError(job, err);
      } finally {
        currentJob = null;
      }
    }
  }

  async function drain() {
    while (pumpPromise || queue.length > 0) {
      if (!pumpPromise) schedulePump();
      try {
        await pumpPromise;
      } catch {
        /* pump 内部已兜住 */
      }
    }
  }

  function enqueueFinal(ev) {
    if (closed || !ev?.pcm?.length) return;
    queue.push({ type: 'final', t0Ms: ev.t0Ms, t1Ms: ev.t1Ms, pcm: ev.pcm });
    schedulePump();
  }

  // ---- 识别 ----

  function makeOnDelta(job) {
    if (!cfg.partialEnabled || cfg.partialMode !== 'stream') return null;
    let lastEmitWall = 0;
    let lastText = '';
    return (accumulated) => {
      if (closed) return;
      const text = cleanAsrText(accumulated);
      if (!text || text.length < cfg.partialMinChars) return;
      const now = Date.now();
      if (now - lastEmitWall < cfg.partialIntervalMs) return;
      if (text === lastText) return;
      lastEmitWall = now;
      lastText = text;
      lastPartialText = text;
      stats.partials += 1;
      emit({ type: 'partial', text, t0Ms: Math.round(job.t0Ms), t1Ms: Math.round(job.t1Ms) });
    };
  }

  async function runFinal(job) {
    let text = null;
    let via = 'cloud';
    let cloudErr = null;

    if (!circuitOpen) {
      try {
        const res = await requestCloud({
          pcm: job.pcm,
          cfg,
          fetchImpl,
          signal: job.controller.signal,
          onDelta: makeOnDelta(job),
        });
        stats.cloudRequests += 1;
        updateCloudMs(res.requestMs);
        stats.lastFirstDeltaMs = res.firstDeltaTotalMs ?? null;
        stats.lastStreamMs = res.finishTotalMs ?? res.finishMs;
        if (!res.text) {
          stats.emptyTexts += 1;
          throw tagError(new Error('MiniMax ASR 返回空文本'), 'CLOUD_EMPTY_TEXT');
        }
        text = res.text;
        consecutiveFailures = 0;
        stats.cloudFinals += 1;
        log(
          `[minimax-cloud] 云端识别 ${job.t0Ms}-${job.t1Ms}ms（音频 ${pcmDurationMs(job.pcm, sampleRate)}ms，` +
            `${res.requestMs}ms${res.streaming ? `，首 delta ${res.firstDeltaTotalMs ?? '?'}ms，finish ${res.finishTotalMs ?? '?'}ms` : ''}）-> "${truncate(text, 90)}"`,
        );
      } catch (err) {
        if (closed) return;
        if (isAbortError(err) && job.controller.signal.aborted) return;
        cloudErr = tagError(err, 'CLOUD_ERROR');
        stats.cloudFailures += 1;
        if (cloudErr.code === 'CLOUD_TIMEOUT') stats.cloudTimeouts += 1;
        consecutiveFailures += 1;
        log(
          `[minimax-cloud] 云端失败（${cloudErr.code ?? cloudErr.name}）：${cloudErr.message}；` +
            `本段降级 ${cfg.fallbackProvider ?? '（无 fallback）'}`,
        );
        if (cfg.fallbackProvider && consecutiveFailures >= cfg.circuitBreakerFailures) markCircuitOpen();
      }
    } else {
      stats.skippedByCircuit += 1;
    }

    if (!text) {
      if (!cfg.fallbackProvider) {
        reportError(job, cloudErr ?? new Error('minimax-cloud 不可用且未配置 fallback'));
        return;
      }
      const fb = await recognizeFallback(job);
      if (!fb?.text) return;
      text = fb.text;
      via = 'fallback';
      stats.fallbackFinals += 1;
      log(`[minimax-cloud] 本地兜底 ${job.t0Ms}-${job.t1Ms}ms -> "${truncate(text, 90)}"`);
    }

    if (closed || !text) return;

    // 防御性 clamp：final 严格有序、不重叠、t1 与音频时长一致
    const durMs = pcmDurationMs(job.pcm, sampleRate);
    let t0Candidate = Math.round(job.t0Ms);
    if (t0Candidate < lastFinalT1Ms - 500) {
      lastFinalT1Ms = 0; // 时间轴大幅回退（seek）：视为新时间轴
    }
    const t0Ms = Math.max(0, t0Candidate, Math.round(lastFinalT1Ms));
    const t1Ms = t0Ms + durMs;
    lastFinalT1Ms = t1Ms;
    lastPartialText = '';
    stats.finals += 1;
    emit({ type: 'final', text, t0Ms, t1Ms, lang: finalLang });
    log(`[minimax-cloud] final #${stats.finals} ${t0Ms}-${t1Ms}ms（via ${via}）`);
  }

  // ---- segmenter（复用本地 VAD 切句；云端不支持音频流式输入）----

  const segmenter = createSegmenter({
    config: vadConfig,
    partial: { enabled: false }, // 云端 partial 走 stream 模式，用 segmenter 窗口只会多花请求
    sampleRate,
    log,
    onEvent: (ev) => {
      if (closed) return;
      if (ev.type === 'final') enqueueFinal(ev);
      // 忽略 segmenter 的 partial / speculate：minimax-cloud 不需要
    },
  });

  // 可选：云端正常时也后台预热本地 fallback（prewarmFallback=true）
  if (!circuitOpen && cfg.prewarmFallback && cfg.fallbackProvider && fallbackFactory) {
    void ensureFallback().catch((err) => log(`[minimax-cloud] 后台预热 fallback 失败：${err?.message ?? err}`));
  }

  // 没有 Key 时：有 fallback 就整会话直接本地；没有就明确报错（不打印密钥）
  if (!cfg.apiKey) {
    if (cfg.fallbackProvider) {
      log(
        `[minimax-cloud] 缺少 MiniMax apiKey（~/.sayless providers.minimax 或 LIVEDUB_PROVIDER_MINIMAX_API_KEY），` +
          `本会话直接使用本地 ${cfg.fallbackProvider}`,
      );
      consecutiveFailures = 0;
      circuitOpen = true;
      circuitReason = '缺少 apiKey';
    } else {
      throw new Error(
        'minimax-cloud: 缺少 MiniMax apiKey。请在 ~/.sayless/config.json 的 providers.minimax.apiKey 配置，' +
          '或设置 LIVEDUB_PROVIDER_MINIMAX_API_KEY 环境变量（密钥不会打印）；也可以在 asr.fallback 配置本地兜底',
      );
    }
  }

  return {
    name: 'minimax-cloud',
    sampleRate,

    push(pcm, tMs) {
      if (closed) return Promise.resolve();
      try {
        segmenter.push(pcm, tMs);
      } catch (err) {
        log(`[minimax-cloud] segmenter.push 异常：${err?.message ?? err}`);
      }
      return Promise.resolve();
    },

    async flush() {
      if (closed) return;
      segmenter.flush();
      await drain();
      lastPartialText = '';
    },

    async close() {
      if (closed) return;
      closed = true;
      queue.length = 0;
      try {
        currentJob?.controller?.abort();
      } catch {
        /* ignore */
      }
      await Promise.race([drain().catch(() => {}), sleep(CLOSE_DRAIN_TIMEOUT_MS)]);
      segmenter.close();
      if (fallbackSession) {
        try {
          await fallbackSession.close?.();
        } catch (err) {
          log(`[minimax-cloud] 关闭本地 fallback 失败：${err?.message ?? err}`);
        }
        fallbackSession = null;
      }
      log('[minimax-cloud] 会话已关闭');
    },

    /** 可选预热：有 Key 时无需动作；缺 Key/已熔断时后台预热本地 fallback */
    async warmup() {
      if (circuitOpen && cfg.fallbackProvider && fallbackFactory) {
        await ensureFallback().catch((err) => log(`[minimax-cloud] fallback 预热失败：${err?.message ?? err}`));
      }
    },

    /** 诊断信息（绝不包含 apiKey） */
    stats() {
      return {
        name: 'minimax-cloud',
        closed,
        finals: stats.finals,
        cloudRequests: stats.cloudRequests,
        cloudFinals: stats.cloudFinals,
        cloudFailures: stats.cloudFailures,
        cloudTimeouts: stats.cloudTimeouts,
        emptyTexts: stats.emptyTexts,
        skippedByCircuit: stats.skippedByCircuit,
        fallbackFinals: stats.fallbackFinals,
        fallbackErrors: stats.fallbackErrors,
        partials: stats.partials,
        consecutiveFailures,
        circuitOpen,
        circuitReason,
        fallbackProvider: cfg.fallbackProvider,
        fallbackCreated: Boolean(fallbackSession),
        lastCloudMs: stats.lastCloudMs,
        avgCloudMs: stats.avgCloudMs,
        lastFirstDeltaMs: stats.lastFirstDeltaMs,
        lastStreamMs: stats.lastStreamMs,
        lastFinalT1Ms,
        config: {
          endpoint: cfg.endpoint,
          model: cfg.model,
          timeoutMs: cfg.timeoutMs,
          language: cfg.language,
          languageHeader: cfg.languageHeader,
          partialEnabled: cfg.partialEnabled,
          partialMode: cfg.partialMode,
          circuitBreakerFailures: cfg.circuitBreakerFailures,
          prewarmFallback: cfg.prewarmFallback,
          hasApiKey: Boolean(cfg.apiKey),
        },
      };
    },
  };
}
