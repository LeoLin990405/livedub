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
 *   - 'minimax-cloud'：MiniMax 云端 ASR（asr-1.0，HTTP 上传 WAV；失败自动降级 asr.fallback 本地 provider，
 *       连续失败熔断；见 ./minimax-cloud.mjs）
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
import { createMinimaxCloudAsr } from './minimax-cloud.mjs';
import { cleanAsrText, truncate } from './text.mjs';
import { closeSharedServer, getSharedWhisperServer, listSharedServers } from './whisper-server.mjs';

export { cleanAsrText, closeSharedServer, listSharedServers };

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

/**
 * 估算 speculative final 省下的时间（相对「静音确认后才开始推理」的基线）。
 * 实际 final 时间 = max(静音确认时刻, 推测推理完成时刻)；基线 = 静音确认时刻 + 推理耗时。
 */
function estimateSpeculationSavedMs(spec, confirmWall) {
  const infer = Number.isFinite(spec?.inferMs) ? spec.inferMs : 0;
  if (!Number.isFinite(confirmWall) || !Number.isFinite(spec?.finishedWall)) return 0;
  const actual = Math.max(confirmWall, spec.finishedWall);
  const baseline = confirmWall + infer;
  return Math.max(0, Math.round(baseline - actual));
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
  // speculative final：**默认关闭**（v0.2 实测：大模型推理 ~1.4s 时收益不稳定、取消的在途请求还会污染
  // whisper 串行队列）。只有显式 `speculativeFinal: true` 才开启，且默认再叠加推理耗时门限。
  const speculativeEnabled = whisper.speculativeFinal === true;
  const speculativeAfterMs = Number.isFinite(Number(whisper.vad?.speculativeAfterMs))
    ? Number(whisper.vad.speculativeAfterMs)
    : Number.isFinite(Number(whisper.speculativeAfterMs))
      ? Number(whisper.speculativeAfterMs)
      : 120;
  // 只有当最近一次 final 推理耗时 <= 该值时才继续推测（0 = 不限制；首次无测量时允许一次）
  const speculationMinInferenceMs = Number.isFinite(Number(whisper.speculativeMinInferenceMs))
    ? Number(whisper.speculativeMinInferenceMs)
    : 250;
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
  /** @type {null | object} 当前在途的推测收句（同一时刻最多一个） */
  let activeSpeculation = null;
  let trailingSilence = false; // 是否处于「尾部静音 / 推测中」：期间跳过 partial
  let speculationCancelsWithoutStart = 0;
  let inferenceMsEma = null; // 最近 final 推理耗时 EMA（用于 speculative 门限）
  let speculationGateLogged = false;

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
    // speculative final
    speculations: 0,
    speculationHits: 0,
    speculationCancels: 0,
    speculationFailed: 0,
    speculationMisses: 0,
    speculationSavedMs: 0,
    lastSpeculationSavedMs: null,
    speculationGateBlocked: 0,
    speculationAborts: 0,
    skippedPartialsTail: 0,
  };

  function emit(ev) {
    if (closed || !ev) return;
    try {
      onEvent(ev);
    } catch (err) {
      log(`[asr] onEvent 回调抛错：${err?.message ?? err}`);
    }
  }

  /** final 推理耗时 EMA（只统计真正产出 final 的推理，含推测复用的那次） */
  function updateInferenceMs(inferMs) {
    if (!Number.isFinite(inferMs) || inferMs <= 0) return;
    inferenceMsEma = inferenceMsEma == null ? inferMs : inferenceMsEma * 0.6 + inferMs * 0.4;
  }

  /**
   * speculative 门限：只有 opt-in 且实测推理足够快（<= speculativeMinInferenceMs）才继续推测。
   * 没有测量值时允许一次（用户已显式 opt-in）；之后按实测推理耗时决定，避免大模型白白占用串行队列。
   */
  function speculationGateOpen() {
    if (!speculativeEnabled) return false;
    if (speculationMinInferenceMs <= 0) return true;
    if (inferenceMsEma == null) return true;
    return inferenceMsEma <= speculationMinInferenceMs;
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
        else if (job.type === 'speculate') await runSpeculation(job);
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
    const confirmedWall = Date.now();
    const active = activeSpeculation;
    let reuseSpec = null;
    if (active) {
      if (ev.speculated && active.id === ev.speculationId) {
        reuseSpec = active; // 静音确认 -> 直接复用这次推测的推理结果
        active.claimed = true;
      } else {
        // final 与推测不匹配（时间轴重置等异常路径）：作废，避免结果泄漏
        active.canceled = true;
        active.canceledWall = confirmedWall;
        active.claimed = true;
        sessionStats.speculationCancels += 1;
        log(`[asr] 推测 id=${active.id} 未等到收句确认，作废`);
      }
    }
    activeSpeculation = null;
    trailingSilence = false;
    queue.push({ type: 'final', t0Ms: ev.t0Ms, t1Ms: ev.t1Ms, pcm: ev.pcm, reuseSpec, confirmedWall });
    schedulePump();
  }

  function enqueuePartial(ev) {
    if (closed || !partialEnabled || !ev?.pcm?.length) return;
    // 尾部静音 / 推测中：partial 已无意义，别抢推理资源
    if (trailingSilence || activeSpeculation) {
      sessionStats.skippedPartialsTail += 1;
      return;
    }
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

  // ---- speculative final ----

  /** 尾部静音开始：把当前句提前送去 whisper（高于 partial 的优先级；final 排队时排在推测之后） */
  function onSpeculationStart(ev) {
    if (closed || !speculativeEnabled || !ev?.pcm?.length) return;
    if (!speculationGateOpen()) {
      sessionStats.speculationGateBlocked += 1;
      if (!speculationGateLogged) {
        speculationGateLogged = true;
        log(
          `[asr] speculative final 已按推理耗时关闭（EMA=${Math.round(inferenceMsEma ?? 0)}ms > speculativeMinInferenceMs=${speculationMinInferenceMs}ms）；` +
            `本会话后续不再推测，如需强制可设 speculativeMinInferenceMs=0`,
        );
      }
      return;
    }
    if (activeSpeculation) {
      // 防御：同一时刻只保留一个推测（正常不会发生）
      activeSpeculation.canceled = true;
      sessionStats.speculationCancels += 1;
    }
    let resolveDone = null;
    const donePromise = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const spec = {
      id: ev.id,
      t0Ms: ev.t0Ms,
      t1Ms: ev.t1Ms,
      pcm: ev.pcm,
      status: 'queued', // queued | running | done | failed | skipped
      text: null,
      inferMs: null,
      audioMs: null,
      error: null,
      canceled: false,
      claimed: false,
      queuedWall: Date.now(),
      startedWall: null,
      finishedWall: null,
      canceledWall: null,
      donePromise,
      _resolveDone: () => resolveDone?.(),
    };
    activeSpeculation = spec;
    trailingSilence = true;
    sessionStats.speculations += 1;
    // 尾部静音开始：清掉仍在排队的 partial，让推测先跑
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (queue[i]?.type === 'partial') queue.splice(i, 1);
    }
    queue.unshift({ type: 'speculate', spec });
    schedulePump();
    log(
      `[asr] 推测收句开始 id=${spec.id} ${spec.t0Ms}-${spec.t1Ms}ms（${pcmDurationMs(spec.pcm, sampleRate)}ms 音频）`,
    );
  }

  /** 推测作废（语音恢复）：丢弃在途结果，不发任何事件 */
  function onSpeculationCancel(ev) {
    const spec = activeSpeculation;
    if (!spec || (ev?.id != null && spec.id !== ev.id)) return;
    activeSpeculation = null;
    trailingSilence = false;
    spec.canceled = true;
    spec.canceledWall = Date.now();
    sessionStats.speculationCancels += 1;
    // 在途请求真正 abort：立刻释放本会话的队列，不让作废的推测阻塞后续 final
    if (spec.status === 'running' && spec.controller && !spec.controller.signal.aborted) {
      sessionStats.speculationAborts += 1;
      spec.abortedWall = Date.now();
      try {
        spec.controller.abort();
      } catch {
        /* ignore */
      }
    }
    log(`[asr] 推测作废 id=${spec.id}（${ev?.reason ?? 'speech resumed'}${spec.status === 'running' ? '，已 abort 在途请求' : ''}）`);
  }

  async function runSpeculation(job) {
    const spec = job.spec;
    if (spec.canceled) {
      // 还没开始推理就作废了：直接跳过（不浪费一次推理）
      spec.status = 'skipped';
      speculationCancelsWithoutStart += 1;
      spec._resolveDone?.();
      log(`[asr] 推测 id=${spec.id} 开始前已作废，跳过推理`);
      return;
    }
    spec.status = 'running';
    spec.startedWall = Date.now();
    spec.controller = job.controller;
    try {
      const res = await server.transcribe({
        pcm: spec.pcm,
        sampleRate,
        language: requestLanguage,
        timeoutMs: requestTimeoutMs,
        signal: job.controller.signal,
        kind: 'speculate',
      });
      spec.finishedWall = Date.now();
      if (res?.skipped) {
        spec.status = 'failed';
        spec.error = new Error(res.reason ?? 'speculative inference skipped');
        sessionStats.speculationFailed += 1;
        log(`[asr] 推测 id=${spec.id} 被跳过：${spec.error.message}`);
        return;
      }
      spec.inferMs = res.inferMs ?? null;
      spec.audioMs = res.audioMs ?? pcmDurationMs(spec.pcm, sampleRate);
      spec.text = cleanAsrText(res.text);
      spec.status = 'done';
      if (spec.canceled) {
        log(`[asr] 推测 id=${spec.id} 在途作废，丢弃结果（${spec.audioMs}ms 音频，${spec.inferMs}ms 推理）`);
      } else {
        log(`[asr] 推测 id=${spec.id} 完成（${spec.audioMs}ms 音频，${spec.inferMs}ms 推理）`);
      }
    } catch (err) {
      spec.finishedWall = Date.now();
      spec.error = err;
      if (isAbortError(err) && spec.canceled) {
        // 语音恢复后主动 abort：不计失败、不产生事件
        spec.status = 'aborted';
        log(`[asr] 推测 id=${spec.id} 已 abort（作废后释放队列）`);
      } else {
        spec.status = 'failed';
        sessionStats.speculationFailed += 1;
        if (!closed && !isAbortError(err)) log(`[asr] 推测 id=${spec.id} 失败：${err?.message ?? err}`);
      }
    } finally {
      spec._resolveDone?.();
    }
  }

  // ---- 识别任务 ----

  async function runFinal(job) {
    let res = null;
    let reused = false;
    if (job.reuseSpec) {
      const spec = job.reuseSpec;
      if (spec.status === 'queued' || spec.status === 'running') {
        try {
          await spec.donePromise;
        } catch {
          /* ignore */
        }
      }
      if (spec.status === 'done' && spec.text) {
        res = { text: spec.text, inferMs: spec.inferMs, audioMs: spec.audioMs, reused: true };
        reused = true;
        sessionStats.speculationHits += 1;
        const savedMs = estimateSpeculationSavedMs(spec, job.confirmedWall);
        sessionStats.speculationSavedMs += savedMs;
        sessionStats.lastSpeculationSavedMs = savedMs;
        log(`[asr] 推测命中 id=${spec.id}，预计节省 ≈${savedMs}ms（${spec.inferMs}ms 推理已提前启动）`);
      } else {
        sessionStats.speculationMisses += 1;
        log(`[asr] 推测未命中 id=${spec.id}（status=${spec.status}），回退普通推理`);
      }
    }
    if (!res) {
      res = await server.transcribe({
        pcm: job.pcm,
        sampleRate,
        language: requestLanguage,
        timeoutMs: requestTimeoutMs,
        signal: job.controller.signal,
        kind: 'final',
      });
    }
    if (closed) return;
    if (res?.skipped) return;
    const inferMs = res.inferMs ?? 0;
    updateInferenceMs(inferMs);
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
      `[asr] final #${sessionStats.finals} ${t0Ms}-${t1Ms}ms（音频 ${audioMs}ms，推理 ${inferMs}ms${reused ? '，推测复用' : ''}）-> "${truncate(text, 90)}"`,
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
    config: {
      ...(whisper.vad ?? {}),
      speculative: speculativeEnabled,
      speculativeAfterMs,
    },
    partial,
    sampleRate,
    log,
    onEvent: (ev) => {
      if (closed) return;
      if (ev.type === 'final') enqueueFinal(ev);
      else if (ev.type === 'partial') enqueuePartial(ev);
      else if (ev.type === 'speculate') onSpeculationStart(ev);
      else if (ev.type === 'speculateCancel') onSpeculationCancel(ev);
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
      if (activeSpeculation) {
        activeSpeculation.canceled = true;
        activeSpeculation._resolveDone?.();
        activeSpeculation = null;
      }
      trailingSilence = false;
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
        speculative: {
          enabled: speculativeEnabled,
          afterMs: speculativeAfterMs,
          minInferenceMs: speculationMinInferenceMs,
          gateOpen: speculationGateOpen(),
          emaInferMs: inferenceMsEma == null ? null : Math.round(inferenceMsEma),
          gateBlocked: sessionStats.speculationGateBlocked,
          aborts: sessionStats.speculationAborts,
          activeId: activeSpeculation?.id ?? null,
          trailingSilence,
          cancelsWithoutStart: speculationCancelsWithoutStart,
          hitRate:
            sessionStats.speculations > 0
              ? Math.round((sessionStats.speculationHits / sessionStats.speculations) * 1000) / 1000
              : null,
        },
        ...sessionStats,
        server: server.stats(),
      };
    },
  };
}

// ---------------------------------------------------------------- fallback

/**
 * minimax-cloud 的本地兜底工厂：按 `asr.fallback` 懒创建本地 provider
 * （默认 whisper-local；测试里可用 `mock`）。避免 minimax-cloud → minimax-cloud 递归。
 */
function makeCloudFallbackFactory({ config, log, fetchImpl, spawnImpl, onError }) {
  return async ({ onEvent }) => {
    const fallbackProvider = config?.asr?.fallback;
    if (!fallbackProvider || fallbackProvider === 'minimax-cloud') {
      throw new Error(`minimax-cloud: asr.fallback 配置无效（${fallbackProvider ?? '空'}，不能是 minimax-cloud）`);
    }
    const fallbackConfig = {
      ...config,
      asr: { ...(config?.asr ?? {}), provider: fallbackProvider },
    };
    return createAsr({ config: fallbackConfig, log, onEvent, fetchImpl, spawnImpl, onError });
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
  if (provider === 'minimax-cloud') {
    return createMinimaxCloudAsr({
      config,
      log,
      onEvent,
      onError,
      fetchImpl,
      spawnImpl,
      fallbackFactory: makeCloudFallbackFactory({ config, log, fetchImpl, spawnImpl, onError }),
    });
  }
  throw new Error(
    `unknown provider: ${provider}（asr 支持 whisper-local | minimax-cloud | mock；请检查 config.asr.provider）`,
  );
}
