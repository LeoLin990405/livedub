/**
 * ASR 层工厂（契约见 docs/CONTRACTS.md §4）。
 *
 *   createAsr({ config, log, onEvent, fetchImpl?, spawnImpl?, onError? }) -> {
 *     name, push(pcm, tMs), flush(), close(),
 *     // 额外（非契约必需）：warmup()/stats() 便于测试与观测
 *   }
 *
 * provider：
 *   - 'whisper-local'：本地常驻 whisper-server（共享进程，见 ./whisper-server.mjs）
 *       - VAD 切句 + 滚动 partial（engine/segmenter.mjs）
 *       - final / partial 的 t0Ms/t1Ms 全部来自音频时间轴（不是墙钟）
 *       - final 严格按时间顺序、不重叠；识别失败重试一次（必要时重启 server）
 *       - 会话 close() 只释放自己，不杀共享 server；测试/引擎收尾用 closeSharedServer()
 *   - 'mock'：复用 engine/mock.mjs 的 createMockAsr（契约完全一致）
 *   - 其它名称：抛 `unknown provider: ...`（不静默回退）
 *
 * 注意：createAsr 是 async 工厂（pipeline 里 `await deps.createAsr(...)`）；
 * whisper-local 在创建后会在后台预热 server（不阻塞 ready 事件），首次识别等待预热完成。
 */
import { pcmDurationMs } from '../audio.mjs';
import { resolveWhisperModel } from '../config.mjs';
import { createMockAsr } from '../mock.mjs';
import { createSegmenter } from '../segmenter.mjs';
import { closeSharedServer, getSharedWhisperServer, listSharedServers } from './whisper-server.mjs';

export { closeSharedServer, listSharedServers };

const DEFAULT_SAMPLE_RATE = 16000;
const PARTIAL_TIMEOUT_MS = 20000;
const CLOSE_DRAIN_TIMEOUT_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

function isAbortError(err) {
  return err?.name === 'AbortError';
}

function truncate(text, max = 80) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

// `[00:00:00.000 --> 00:00:02.500]` 这类时间戳（whisper 某些输出格式会带）
const TIMESTAMP_MARKER =
  /\[\s*\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\s*\]/g;
// 非语音标记：可整块删除（whisper 对静音/噪声常输出这类 token）
const NON_SPEECH_BRACKET =
  /\[\s*(?:blank_?audio|silence|music|applause|laughter|inaudible|noise|sound|background\s+music|breathing|sighs?|coughs?|music\s+playing)\s*\]/gi;
const NON_SPEECH_PAREN =
  /\(\s*(?:music|silence|applause|laughter|inaudible|noise|sound|background\s+music|music\s+playing)\s*\)/gi;
const NON_SPEECH_CJK = /[\[（(【]\s*(?:音乐|掌声|笑声|静音|背景音乐)\s*[\]）)】]/g;
const MUSIC_NOTES = /[♪♫♬♩]+/g;
const PUNCT_ONLY = /^[\s\p{P}\p{S}]+$/u;

/**
 * 清洗 whisper 输出：去非语音标记/时间戳、折叠空白、纯标点视为空串。
 * @param {unknown} text
 * @returns {string}
 */
export function cleanAsrText(text) {
  let s = String(text ?? '');
  if (!s) return '';
  s = s
    .replace(TIMESTAMP_MARKER, ' ')
    .replace(NON_SPEECH_BRACKET, ' ')
    .replace(NON_SPEECH_PAREN, ' ')
    .replace(NON_SPEECH_CJK, ' ')
    .replace(MUSIC_NOTES, ' ')
    .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || PUNCT_ONLY.test(s)) return '';
  return s;
}

// ---------------------------------------------------------------- mock

function createMockAsrSession({ config, log, onEvent }) {
  const inner = createMockAsr({ config, log, onEvent });
  return inner;
}

// ---------------------------------------------------------------- whisper-local

function createWhisperAsrSession({ config = {}, log = () => {}, onEvent = () => {}, fetchImpl, spawnImpl, onError } = {}) {
  const whisper = config?.asr?.whisper && typeof config.asr.whisper === 'object' ? config.asr.whisper : {};
  const modelPath = resolveWhisperModel(config);
  if (!modelPath) {
    throw new Error(
      'whisper-local: 找不到本地 whisper 模型。请在 config.asr.whisper.models 候选中放一个已存在的 ggml 模型（如 models/ggml-large-v3-turbo-q5_0.bin），或设置 LIVEDUB_WHISPER_MODEL=<绝对路径>；可运行 npm run doctor 查看候选路径',
    );
  }

  const sampleRate = Number.isFinite(Number(whisper.sampleRate))
    ? Number(whisper.sampleRate)
    : Number(config?.session?.sampleRate) || DEFAULT_SAMPLE_RATE;
  const requestTimeoutMs = Number.isFinite(Number(whisper.requestTimeoutMs))
    ? Math.max(1000, Number(whisper.requestTimeoutMs))
    : 60000;
  const partial = whisper.partial && typeof whisper.partial === 'object' ? whisper.partial : {};
  const partialEnabled = partial.enabled !== false;
  const minPartialChars = Number.isFinite(Number(partial.minChars)) ? Math.max(1, Number(partial.minChars)) : 6;
  const skipWhileBusy = partial.skipWhileBusy !== false;
  const requestLanguage = String(whisper.language || 'en');
  const finalLang =
    requestLanguage === 'auto' ? String(config?.session?.langFrom ?? 'en') : requestLanguage;

  const server = getSharedWhisperServer({
    bin: whisper.bin || 'whisper-server',
    modelPath,
    host: whisper.host || '127.0.0.1',
    port: Number.isFinite(Number(whisper.port)) ? Number(whisper.port) : 18765,
    threads: whisper.threads,
    language: requestLanguage,
    prompt: whisper.prompt,
    startupTimeoutMs: whisper.startupTimeoutMs,
    requestTimeoutMs,
    log,
    fetchImpl,
    spawnImpl,
  });

  let closed = false;
  /** @type {Array<object>} FIFO：final 必跑，partial 可被丢弃 */
  const queue = [];
  let currentJob = null;
  let pumpPromise = null;
  let lastFinalT1Ms = 0;
  let lastPartialText = '';
  let warmPromise = null;

  const sessionStats = {
    finals: 0,
    partials: 0,
    skippedPartials: 0,
    emptyFinals: 0,
    errors: 0,
    lastFinalInferMs: null,
    avgFinalInferMs: null,
    finalSamples: 0,
    totalFinalInferMs: 0,
  };

  function emit(ev) {
    if (closed || !ev) return;
    try {
      onEvent(ev);
    } catch (err) {
      log(`[asr] onEvent 回调抛错：${err?.message ?? err}`);
    }
  }

  function reportError(job, err) {
    sessionStats.errors += 1;
    if (closed || isAbortError(err)) return;
    log(`[asr] ${job?.type ?? 'job'} 处理失败（${job?.t0Ms ?? '?'}-${job?.t1Ms ?? '?'}ms）：${err?.message ?? err}`);
    if (typeof onError === 'function') {
      try {
        onError({
          scope: 'asr',
          kind: job?.type ?? 'unknown',
          message: String(err?.message ?? err),
          recoverable: true,
          t0Ms: job?.t0Ms,
          t1Ms: job?.t1Ms,
          error: err,
        });
      } catch {
        /* ignore */
      }
    }
  }

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
        if (job.type === 'final') await runFinal(job);
        else if (job.type === 'partial') await runPartial(job);
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

  // ---- 事件入队 ----

  function enqueueFinal(ev) {
    if (closed || !ev?.pcm?.length) return;
    queue.push({ type: 'final', t0Ms: ev.t0Ms, t1Ms: ev.t1Ms, pcm: ev.pcm });
    schedulePump();
  }

  function enqueuePartial(ev) {
    if (closed || !partialEnabled || !ev?.pcm?.length) return;
    const busy = Boolean(currentJob) || queue.length > 0;
    // partial 只是中间态：skipWhileBusy=true 时忙则跳过；=false 时允许排队（final 之后到达的会被丢弃）
    if (busy) {
      if (skipWhileBusy) {
        sessionStats.skippedPartials += 1;
        return;
      }
      if (!currentJob && queue.length > 0) {
        // 队列里已有更晚的 partial 就不重复入队
        const last = queue[queue.length - 1];
        if (last?.type === 'partial' && last.t1Ms >= ev.t1Ms) return;
      }
    }
    queue.push({ type: 'partial', t0Ms: ev.t0Ms, t1Ms: ev.t1Ms, pcm: ev.pcm });
    schedulePump();
  }

  // ---- 识别任务 ----

  async function runFinal(job) {
    const res = await server.transcribe({
      pcm: job.pcm,
      sampleRate,
      language: requestLanguage,
      timeoutMs: requestTimeoutMs,
      signal: job.controller.signal,
      kind: 'final',
    });
    if (closed) return;
    if (res?.skipped) return;
    const inferMs = res.inferMs ?? 0;
    sessionStats.lastFinalInferMs = inferMs;
    sessionStats.totalFinalInferMs += inferMs;
    sessionStats.finalSamples += 1;
    sessionStats.avgFinalInferMs = Math.round(sessionStats.totalFinalInferMs / sessionStats.finalSamples);

    const text = cleanAsrText(res?.text);
    const audioMs = res?.audioMs ?? pcmDurationMs(job.pcm, sampleRate);
    if (!text) {
      sessionStats.emptyFinals += 1;
      log(`[asr] final ${job.t0Ms}-${job.t1Ms}ms 未识别出文本（${audioMs}ms 音频，${inferMs}ms 推理）`);
      return;
    }
    // 防御性 clamp：保证 final 不重叠、t1 与音频时长严格一致
    const durMs = pcmDurationMs(job.pcm, sampleRate);
    let t0Candidate = Math.round(job.t0Ms);
    if (t0Candidate < lastFinalT1Ms - 500) {
      // 时间轴大幅回退（seek / 新视频段）：视为新时间轴，不沿用旧的 lastFinalT1
      lastFinalT1Ms = 0;
      lastPartialText = '';
    }
    const t0Ms = Math.max(0, t0Candidate, Math.round(lastFinalT1Ms));
    const t1Ms = t0Ms + durMs;
    lastFinalT1Ms = t1Ms;
    lastPartialText = '';
    sessionStats.finals += 1;
    emit({ type: 'final', text, t0Ms, t1Ms, lang: finalLang });
    log(
      `[asr] final #${sessionStats.finals} ${t0Ms}-${t1Ms}ms（音频 ${audioMs}ms，推理 ${inferMs}ms）-> "${truncate(text, 90)}"`,
    );
  }

  async function runPartial(job) {
    const res = await server.transcribe({
      pcm: job.pcm,
      sampleRate,
      language: requestLanguage,
      timeoutMs: Math.min(requestTimeoutMs, PARTIAL_TIMEOUT_MS),
      signal: job.controller.signal,
      skipIfBusy: skipWhileBusy,
      kind: 'partial',
    });
    if (closed) return;
    if (res?.skipped) {
      if (res.reason === 'busy') sessionStats.skippedPartials += 1;
      return;
    }
    // 该 partial 的窗口已经被某个 final 覆盖 -> 丢弃，避免 UI 倒退
    if (job.t1Ms <= lastFinalT1Ms) return;
    const text = cleanAsrText(res?.text);
    if (!text || text.length < minPartialChars) return;
    if (text === lastPartialText) return;
    lastPartialText = text;
    sessionStats.partials += 1;
    emit({ type: 'partial', text, t0Ms: Math.round(job.t0Ms), t1Ms: Math.round(job.t1Ms) });
  }

  // ---- 生命周期 ----

  function warmup() {
    if (!warmPromise) {
      warmPromise = server.ensureReady().catch((err) => {
        warmPromise = null;
        log(`[asr] whisper-server 预热失败（识别时会自动重试）：${err?.message ?? err}`);
        throw err;
      });
    }
    return warmPromise;
  }

  const segmenter = createSegmenter({
    config: whisper.vad ?? {},
    partial,
    sampleRate,
    log,
    onEvent: (ev) => {
      if (closed) return;
      if (ev.type === 'final') enqueueFinal(ev);
      else if (ev.type === 'partial') enqueuePartial(ev);
    },
  });

  // 后台预热：不阻塞 session ready（首次识别会 await 同一个 startPromise）
  void warmup().catch(() => {});

  return {
    name: 'whisper-local',
    sampleRate,

    push(pcm, tMs) {
      if (closed) return Promise.resolve();
      try {
        segmenter.push(pcm, tMs);
      } catch (err) {
        log(`[asr] segmenter.push 异常：${err?.message ?? err}`);
      }
      return Promise.resolve();
    },

    async flush() {
      if (closed) return;
      segmenter.flush(); // 同步回调：把当前语音落成 final 入队
      // flush 时还在排队的 partial 没有意义（final 覆盖），直接丢弃
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (queue[i]?.type === 'partial') queue.splice(i, 1);
      }
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
      server.release(); // 只释放会话引用；共享 server 进程保留给下一个会话
      log('[asr] whisper-local 会话已关闭（共享 whisper-server 保留）');
    },

    /** 额外：等待 server 预热完成（测试/doctor 用；失败会 throw） */
    warmup,

    /** 额外：诊断信息 */
    stats() {
      return {
        name: 'whisper-local',
        closed,
        queued: queue.length,
        busy: Boolean(currentJob),
        lastFinalT1Ms,
        ...sessionStats,
        server: server.stats(),
      };
    },
  };
}

// ---------------------------------------------------------------- 工厂

/**
 * 创建 ASR provider。
 * @param {object} opts
 * @param {object} opts.config 完整配置（config/livedub.config.json 结构 + overrides）
 * @param {(msg: string) => void} [opts.log]
 * @param {(ev: object) => void} [opts.onEvent] partial/final 事件
 * @param {typeof fetch} [opts.fetchImpl] 测试注入
 * @param {typeof import('node:child_process').spawn} [opts.spawnImpl] 测试注入
 * @param {(info: object) => void} [opts.onError] 额外：可恢复错误的观测回调（不影响契约）
 */
export async function createAsr({ config = {}, log = () => {}, onEvent = () => {}, fetchImpl, spawnImpl, onError } = {}) {
  const provider = config?.asr?.provider ?? 'whisper-local';
  if (provider === 'mock') {
    return createMockAsrSession({ config, log, onEvent });
  }
  if (provider === 'whisper-local') {
    return createWhisperAsrSession({ config, log, onEvent, fetchImpl, spawnImpl, onError });
  }
  throw new Error(`unknown provider: ${provider}（asr 支持 whisper-local | mock；请检查 config.asr.provider）`);
}
