/**
 * whisper-server 进程管理 + /inference HTTP 适配（whisper.cpp 的 server 示例）。
 *
 * 职责：
 * - 共享进程单例：同一 (bin, model, host, port) 只拉起一个 server，多会话复用；
 *   会话 close() 不会杀共享进程，测试/引擎收尾用 closeSharedServer()。
 * - 启动：先探测是否已有可用 server（跨进程复用），否则 spawn；随后轮询 GET /health，
 *   超时 startupTimeoutMs（默认 120s，沙箱里 Metal 冷启动约 20-25s）。
 * - 健康检查：启动期轮询 + 空闲期低频 /health 探测；异常时下次请求惰性重启。
 * - 崩溃重启：child 'exit' 记为 dead，下一次请求自动重新拉起；请求失败重试一次。
 * - 串行化：whisper-server 同一时刻只应跑一个推理，所以请求在 manager 内排队；
 *   partial 请求可 skipIfBusy=true，忙时直接跳过（不排队）。
 * - 识别：把 PCM 写成 /tmp 下 WAV（16k mono s16le），POST /inference（multipart
 *   file/language/response_format=json），解析 {text}；临时文件用完即删。
 *
 * 不打印任何密钥（本层不接触密钥）。日志走注入的 log()。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pcmDurationMs, wavFromPcm } from '../audio.mjs';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 18765;
const DEFAULT_STARTUP_TIMEOUT_MS = 120000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60000;
const HEALTH_POLL_MS = 250;
const HEALTH_IDLE_INTERVAL_MS = 30000;
const REQUEST_RETRIES = 1;
const STDERR_TAIL_BYTES = 6000;
const STDOUT_TAIL_BYTES = 2000;

// ---------------------------------------------------------------- 小工具

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

function abortError(message = '操作已取消') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function isAbortError(err) {
  return err?.name === 'AbortError' || err?.name === 'TimeoutError';
}

/** 给可能不响应 AbortSignal 的 promise 加兜底超时（测试注入的 fetchImpl 也能兜住） */
function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message);
      err.code = 'WHISPER_TIMEOUT';
      err.retryable = true;
      reject(err);
    }, Math.max(0, ms));
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function tagError(err, code, retryable = false) {
  const e = err instanceof Error ? err : new Error(String(err));
  if (!e.code) e.code = code;
  if (e.retryable == null) e.retryable = retryable;
  return e;
}

function tailAppend(current, chunk, maxBytes) {
  const next = current + chunk.toString('utf8');
  return next.length > maxBytes ? next.slice(-maxBytes) : next;
}

function sanitizeLogLine(line) {
  // 单行化 + 去控制字符，避免把 server 的进度条/ANSI 刷进日志
  // eslint-disable-next-line no-control-regex
  return String(line).replace(/\u001b\[[0-9;]*m/g, '').replace(/[\r\n]+/g, ' ').trim();
}

// ---------------------------------------------------------------- 共享单例

/** @type {Map<string, ReturnType<typeof createServerManager>>} */
const sharedServers = new Map();
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // 正常 process.exit / 事件循环结束时兜底杀子进程，避免留下孤儿 server 占端口。
  // 注意：SIGINT/SIGTERM 需要引擎显式调用 closeSharedServer()。
  process.once('exit', () => {
    for (const manager of sharedServers.values()) {
      try {
        manager.killNow();
      } catch {
        /* ignore */
      }
    }
  });
}

function serverKey({ bin, modelPath, host, port }) {
  return `${bin}|${modelPath}|${host}:${port}`;
}

/**
 * 取得（或创建）共享 whisper-server manager。
 * 同一 key 多次调用返回同一对象，refs 递增；会话应成对调用 acquire/release。
 */
export function getSharedWhisperServer(opts = {}) {
  const bin = String(opts.bin || 'whisper-server');
  if (!opts.modelPath) throw new Error('whisper-server 缺少 modelPath（检查 config.asr.whisper.models）');
  const modelPath = String(opts.modelPath);
  const host = String(opts.host || DEFAULT_HOST);
  const port = Number.isFinite(Number(opts.port)) ? Number(opts.port) : DEFAULT_PORT;
  const key = serverKey({ bin, modelPath, host, port });
  let manager = sharedServers.get(key);
  if (!manager) {
    manager = createServerManager({ key, bin, modelPath, host, port, ...opts });
    sharedServers.set(key, manager);
  }
  manager.acquire();
  installExitHook();
  return manager;
}

/** 关闭所有共享 server（测试收尾 / 引擎退出时调用） */
export async function closeSharedServer() {
  const managers = [...sharedServers.values()];
  sharedServers.clear();
  await Promise.all(
    managers.map((manager) =>
      manager.stop().catch(() => {
        /* ignore */
      }),
    ),
  );
}

/** 共享 server 诊断快照（测试/doctor 用） */
export function listSharedServers() {
  return [...sharedServers.values()].map((manager) => manager.stats());
}

// ---------------------------------------------------------------- manager

function createServerManager(opts) {
  const bin = String(opts.bin || 'whisper-server');
  const modelPath = String(opts.modelPath);
  const host = String(opts.host || DEFAULT_HOST);
  const port = Number(opts.port) || DEFAULT_PORT;
  const threads = Number.isFinite(Number(opts.threads)) ? Math.max(1, Number(opts.threads)) : 4;
  const serverLanguage = String(opts.language || 'en');
  // 初始 prompt：给领域词/术语做偏置（whisper /inference 的 prompt 字段），显著减少教学术语错词
  const serverPrompt = typeof opts.prompt === 'string' ? opts.prompt.trim() : '';
  const startupTimeoutMs = Number.isFinite(Number(opts.startupTimeoutMs))
    ? Math.max(5000, Number(opts.startupTimeoutMs))
    : DEFAULT_STARTUP_TIMEOUT_MS;
  const requestTimeoutMs = Number.isFinite(Number(opts.requestTimeoutMs))
    ? Math.max(1000, Number(opts.requestTimeoutMs))
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;
  const spawnImpl = typeof opts.spawnImpl === 'function' ? opts.spawnImpl : nodeSpawn;
  const baseUrl = `http://${host}:${port}`;

  const state = {
    key: String(opts.key ?? serverKey({ bin, modelPath, host, port })),
    proc: null,
    owned: false,
    status: 'idle', // idle | starting | ready | dead | stopped
    startPromise: null,
    procExited: false,
    exitCode: null,
    stopping: false,
    stderrTail: '',
    stdoutTail: '',
    refs: 0,
    requests: 0,
    skipped: 0,
    inferFailures: 0,
    restarts: 0,
    startupMs: null,
    lastInferMs: null,
    totalInferMs: 0,
    inferSamples: 0,
    pendingCount: 0,
    chain: Promise.resolve(),
    healthTimer: null,
    healthMisses: 0,
    tempSeq: 0,
  };

  let serverTmpDir = null;

  function stats() {
    return {
      key: state.key,
      baseUrl,
      bin,
      modelPath,
      pid: state.proc?.pid ?? null,
      status: state.status,
      owned: state.owned,
      refs: state.refs,
      requests: state.requests,
      skipped: state.skipped,
      inferFailures: state.inferFailures,
      restarts: state.restarts,
      startupMs: state.startupMs,
      lastInferMs: state.lastInferMs,
      avgInferMs: state.inferSamples ? Math.round(state.totalInferMs / state.inferSamples) : null,
      pendingCount: state.pendingCount,
      startupTimeoutMs,
      requestTimeoutMs,
    };
  }

  function acquire() {
    state.refs += 1;
    return state.refs;
  }

  function release() {
    state.refs = Math.max(0, state.refs - 1);
    return state.refs;
  }

  // ------------------------------------------------------------ 进程生命周期

  function buildArgs() {
    const args = ['-m', modelPath, '--host', host, '--port', String(port), '-t', String(threads), '-l', serverLanguage];
    // 上传的 WAV 不需要 server 再转码；不传 --convert，避免依赖 ffmpeg 与额外临时文件。
    return args;
  }

  function captureStderr(chunk) {
    state.stderrTail = tailAppend(state.stderrTail, chunk, STDERR_TAIL_BYTES);
  }

  function captureStdout(chunk) {
    state.stdoutTail = tailAppend(state.stdoutTail, chunk, STDOUT_TAIL_BYTES);
  }

  function tailForError() {
    const tail = sanitizeLogLine(state.stderrTail || state.stdoutTail || '');
    return tail.length > 800 ? tail.slice(-800) : tail;
  }

  async function ensureTmpDir() {
    if (serverTmpDir) return serverTmpDir;
    const dir = path.join(os.tmpdir(), `livedub-whisper-${process.pid}-${port}`);
    try {
      await fs.mkdir(dir, { recursive: true });
      serverTmpDir = dir;
    } catch {
      serverTmpDir = os.tmpdir();
    }
    return serverTmpDir;
  }

  function spawnProc() {
    const args = buildArgs();
    let child = null;
    try {
      child = spawnImpl(bin, args, {
        cwd: serverTmpDir ?? os.tmpdir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      throw tagError(
        new Error(
          `无法启动 whisper-server（bin=${bin}）：${err?.message ?? err}；请确认 whisper-server 已安装并在 PATH，或修改 config.asr.whisper.bin`,
        ),
        'WHISPER_STARTUP',
      );
    }
    if (!child || typeof child.on !== 'function') {
      throw tagError(new Error(`spawn whisper-server 返回值异常（bin=${bin}）`), 'WHISPER_STARTUP');
    }
    state.proc = child;
    state.procExited = false;
    state.exitCode = null;
    state.owned = true;
    state.stderrTail = '';
    state.stdoutTail = '';
    state.stopping = false;

    child.on('error', (err) => {
      state.lastSpawnError = err;
      log(`[whisper] spawn error: ${err?.message ?? err}`);
    });
    child.on('exit', (code, signal) => {
      state.procExited = true;
      state.exitCode = code;
      state.proc = null;
      if (state.stopping) return;
      if (state.status === 'ready' || state.status === 'starting') {
        state.status = 'dead';
        log(
          `[whisper] server 意外退出（code=${code ?? 'null'} signal=${signal ?? 'null'}），下次识别请求会自动重启`,
        );
      }
    });
    child.stdout?.on?.('data', captureStdout);
    child.stderr?.on?.('data', captureStderr);
    log(`[whisper] spawn pid=${child.pid ?? '?'} port=${port} model=${path.basename(modelPath)} threads=${threads}`);
    return child;
  }

  function clearHealthTimer() {
    if (state.healthTimer) {
      clearInterval(state.healthTimer);
      state.healthTimer = null;
    }
  }

  function ensureHealthTimer() {
    if (state.healthTimer) return;
    state.healthTimer = setInterval(() => {
      if (state.stopping || state.pendingCount > 0) return;
      if (state.status !== 'ready') return;
      void probeHealth(2000).then((ok) => {
        if (state.stopping || state.pendingCount > 0 || state.status !== 'ready') return;
        if (ok) {
          state.healthMisses = 0;
          return;
        }
        state.healthMisses += 1;
        if (state.healthMisses >= 2) {
          state.healthMisses = 0;
          state.status = 'dead';
          log('[whisper] /health 连续失败，标记 server 不可用；下次识别请求会自动重启');
        }
      });
    }, HEALTH_IDLE_INTERVAL_MS);
    state.healthTimer.unref?.();
  }

  async function probeHealth(timeoutMs = 1000) {
    try {
      const res = await withTimeout(
        Promise.resolve(fetchImpl(`${baseUrl}/health`, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) })),
        timeoutMs + 500,
        'health check timeout',
      );
      return Boolean(res && res.ok);
    } catch {
      return false;
    }
  }

  async function start({ signal } = {}) {
    state.status = 'starting';
    state.stopping = false;
    await ensureTmpDir();
    // 上一次可能死掉但进程还挂着的 server（例如 /health 连续失败或请求超时）：先清掉再拉起，避免端口冲突
    if (state.proc) await stopProc();

    // 1) 已有可用 server（本进程之前的会话 / 其它进程）→ 直接复用，不重复加载模型
    if (await probeHealth(800)) {
      state.status = 'ready';
      state.owned = false;
      state.startupMs = 0;
      ensureHealthTimer();
      log(`[whisper] 复用已就绪的 server ${baseUrl}`);
      return { reused: true, startupMs: 0 };
    }

    // 2) 拉起新进程并轮询 /health
    const startedAt = Date.now();
    spawnProc();
    const deadline = startedAt + startupTimeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        await stopProc();
        throw abortError();
      }
      if (state.procExited) {
        state.status = 'dead';
        const tail = tailForError();
        throw tagError(
          new Error(
            `whisper-server 启动失败（退出码 ${state.exitCode ?? '?'}）：${tail || '无输出'}；` +
              `检查模型路径是否存在：${modelPath}，以及端口 ${port} 是否被占用`,
          ),
          'WHISPER_STARTUP',
        );
      }
      if (await probeHealth(1000)) {
        state.status = 'ready';
        state.startupMs = Date.now() - startedAt;
        ensureHealthTimer();
        log(`[whisper] server 就绪，用时 ${state.startupMs}ms（pid=${state.proc?.pid ?? '?'}）`);
        return { reused: false, startupMs: state.startupMs };
      }
      await sleep(HEALTH_POLL_MS);
    }
    await stopProc();
    state.status = 'dead';
    throw tagError(
      new Error(
        `whisper-server 启动超时（${startupTimeoutMs}ms）：检查 config.asr.whisper.startupTimeoutMs、端口 ${port} 是否被占用` +
          (tailForError() ? `；server 输出：${tailForError()}` : ''),
      ),
      'WHISPER_STARTUP',
    );
  }

  async function ensureReady({ signal } = {}) {
    if (state.status === 'ready') return { reused: state.owned === false, startupMs: state.startupMs };
    if (state.startPromise) return state.startPromise;
    state.startPromise = start({ signal }).finally(() => {
      state.startPromise = null;
    });
    return state.startPromise;
  }

  async function stopProc() {
    clearHealthTimer();
    const child = state.proc;
    if (!child) {
      state.owned = false;
      if (state.status !== 'stopped') state.status = 'idle';
      return;
    }
    state.stopping = true;
    const exited = new Promise((resolve) => {
      if (state.procExited) return resolve();
      child.once('exit', () => resolve());
      setTimeout(resolve, 3000).unref?.();
    });
    try {
      child.kill?.('SIGTERM');
    } catch {
      /* ignore */
    }
    await exited;
    if (state.proc && !state.procExited) {
      try {
        child.kill?.('SIGKILL');
      } catch {
        /* ignore */
      }
      await sleep(300);
    }
    state.proc = null;
    state.procExited = true;
    state.owned = false;
    state.status = state.status === 'stopped' ? 'stopped' : 'idle';
    state.stopping = false;
    log('[whisper] server 已停止');
  }

  async function restart() {
    log('[whisper] 重启 whisper-server…');
    state.stopping = false;
    await stopProc();
    state.status = 'idle';
    state.restarts += 1;
    return ensureReady();
  }

  function killNow() {
    const child = state.proc;
    if (!child) return;
    try {
      child.kill?.('SIGKILL');
    } catch {
      /* ignore */
    }
  }

  async function stop() {
    state.status = 'stopped';
    await stopProc();
  }

  // ------------------------------------------------------------ 推理

  async function postInference({ pcm, sampleRate, language, timeoutMs, signal }) {
    const wav = wavFromPcm(pcm, sampleRate);
    const tempFile = path.join(os.tmpdir(), `livedub-asr-${process.pid}-${state.tempSeq++}.wav`);
    const startedAt = Date.now();
    await fs.writeFile(tempFile, wav);
    try {
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'segment.wav');
      form.append('language', language || serverLanguage || 'en');
      form.append('response_format', 'json');
      form.append('temperature', '0');
      if (serverPrompt) form.append('prompt', serverPrompt);

      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      let res;
      try {
        res = await withTimeout(
          Promise.resolve(fetchImpl(`${baseUrl}/inference`, { method: 'POST', body: form, signal: combined })),
          timeoutMs + 1000,
          `whisper-server 请求超时（${timeoutMs}ms）`,
        );
      } catch (err) {
        if (signal?.aborted) throw abortError();
        if (isAbortError(err) || err?.code === 'WHISPER_TIMEOUT') {
          throw tagError(new Error(`whisper-server 请求超时（${timeoutMs}ms）`), 'WHISPER_TIMEOUT', true);
        }
        throw tagError(
          new Error(`whisper-server 连接失败（${baseUrl}/inference）：${err?.message ?? err}`),
          'WHISPER_NETWORK',
          true,
        );
      }
      const inferMs = Date.now() - startedAt;

      if (!res || !res.ok) {
        let body = '';
        try {
          body = String(await res.text()).slice(0, 500);
        } catch {
          /* ignore */
        }
        const err = new Error(`whisper-server /inference 返回 HTTP ${res?.status ?? '??'}：${sanitizeLogLine(body)}`);
        err.code = `WHISPER_HTTP_${res?.status ?? 0}`;
        err.retryable = (res?.status ?? 0) >= 500 || res?.status === 429;
        throw err;
      }

      let data = null;
      try {
        data = await res.json();
      } catch (err) {
        throw tagError(new Error(`whisper-server 返回非 JSON：${err?.message ?? err}`), 'WHISPER_PARSE', true);
      }
      const text = typeof data?.text === 'string' ? data.text : typeof data?.result === 'string' ? data.result : '';
      state.requests += 1;
      state.lastInferMs = inferMs;
      state.totalInferMs += inferMs;
      state.inferSamples += 1;
      return {
        text,
        inferMs,
        audioMs: pcmDurationMs(pcm, sampleRate),
        model: typeof data?.model === 'string' ? data.model : undefined,
      };
    } finally {
      await fs.unlink(tempFile).catch(() => {});
    }
  }

  /**
   * 转写一段 PCM。返回 { text, inferMs, audioMs } 或 { skipped: true, reason }。
   * skipIfBusy=true 时若 manager 忙（或正在冷启动）直接跳过，不排队。
   */
  function transcribe({
    pcm,
    sampleRate = 16000,
    language,
    timeoutMs = requestTimeoutMs,
    signal,
    skipIfBusy = false,
    kind = 'final',
  } = {}) {
    if (!Buffer.isBuffer(pcm) || pcm.length === 0) return Promise.resolve({ skipped: true, reason: 'empty audio' });
    if (skipIfBusy && (state.pendingCount > 0 || state.status === 'starting')) {
      state.skipped += 1;
      return Promise.resolve({ skipped: true, reason: 'busy' });
    }
    const previous = state.chain;
    state.pendingCount += 1;
    const run = previous.then(() => doTranscribe({ pcm, sampleRate, language, timeoutMs, signal, kind }));
    state.chain = run.then(
      () => {},
      () => {},
    );
    return run.finally(() => {
      state.pendingCount = Math.max(0, state.pendingCount - 1);
    });
  }

  async function doTranscribe({ pcm, sampleRate, language, timeoutMs, signal, kind }) {
    let lastErr = null;
    for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt++) {
      try {
        await ensureReady({ signal });
        return await postInference({ pcm, sampleRate, language, timeoutMs, signal });
      } catch (err) {
        if (isAbortError(err) && signal?.aborted) throw abortError();
        lastErr = tagError(err, 'WHISPER_UNKNOWN');
        state.inferFailures += 1;
        log(`[whisper] ${kind} 识别失败（第 ${attempt + 1}/${REQUEST_RETRIES + 1} 次）：${lastErr.message}`);
        const retryable = lastErr.retryable === true && lastErr.code !== 'WHISPER_STARTUP';
        if (!retryable || attempt >= REQUEST_RETRIES) break;
        // 连接失败 / 5xx / 超时：重启 server 后重试一次
        try {
          await restart();
        } catch (restartErr) {
          log(`[whisper] 自动重启失败：${restartErr?.message ?? restartErr}`);
          break;
        }
      }
    }
    throw lastErr;
  }

  return {
    key: state.key,
    baseUrl,
    port,
    modelPath,
    acquire,
    release,
    ensureReady,
    transcribe,
    checkHealth: (timeoutMs = 2000) => probeHealth(timeoutMs),
    restart,
    stop,
    killNow,
    stats,
    isBusy: () => state.pendingCount > 0,
    get status() {
      return state.status;
    },
  };
}
