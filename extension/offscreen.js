/**
 * livedub Chrome MV3 扩展 —— offscreen document（隐藏页面）。
 *
 * 为什么需要它：MV3 的 service worker 没有 DOM / Web Audio / getUserMedia，
 * 所以标签页抓音、PCM 分片、WebSocket、配音播放都放在 offscreen document 里，
 * 由 background 通过 chrome.runtime 消息驱动。
 *
 * 音频链路（docs/CONTRACTS.md §3）：
 *   tabCapture streamId
 *     -> navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource:'tab', ... } } })
 *     -> AudioContext({ sampleRate: 16000 }) + AudioWorklet（100ms 分片，兜底重采样到 16k）
 *     -> 二进制 WS 帧 [0x01 | float64BE tMs | s16le]
 *     <- 引擎事件：partial / segment / translation / dub / status / metrics / voice / error
 *
 * 注意：tabCapture 抓走声音后标签页本身会被静音，所以这里同时用默认采样率的
 * AudioContext 把原声重放给用户（音质比 16k 好）；content script 通过压低
 * video/audio.volume 实现的「压音」作用在这个被重放的信号上。
 */

import {
  MSG,
  DEFAULT_ENGINE_URL,
  DEFAULT_SETTINGS,
  OFFSCREEN_JUSTIFICATION,
  OFFSCREEN_REASONS,
} from './lib/constants.js';
import { encodeAudioFrame, buildHelloMessage, base64ToFloat32, computeDubPlayhead } from './lib/pcm.js';

const LOG_PREFIX = '[livedub:offscreen]';
const log = (...args) => console.debug(LOG_PREFIX, ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** ASR 输入采样率（docs/CONTRACTS.md §3） */
const CAPTURE_SAMPLE_RATE = 16000;
/** 分片时长：每 100ms 一帧 */
const CHUNK_MS = 100;
/** WS 未 ready 时最多缓存多少帧（6s），超出丢最旧的，避免内存膨胀和延迟堆积 */
const MAX_PENDING_CHUNKS = 60;
/** 停止时给引擎 control stop 留一点发送时间 */
const STOP_CONTROL_WAIT_MS = 80;
/** 断线重连指数退避 */
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 10000];
/** 单位：16k 采样，1 秒 = 16000 个 */
const MS_PER_SECOND = 1000;

const runtime = {
  running: false,
  starting: false,
  stopping: false,
  streamId: null,
  engineUrl: '',
  session: null,
  settings: { ...DEFAULT_SETTINGS },
  tabId: null,
  stream: null,
  captureCtx: null,
  monitorCtx: null,
  captureSource: null,
  monitorSource: null,
  monitorGain: null,
  silentGain: null,
  workletNode: null,
  ws: null,
  epoch: null,
  epochSeq: 0,
  reconnectTimer: null,
  reconnectAttempts: 0,
  dubSources: new Set(),
};

chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_HELLO, url: location.href }).catch(() => {});

// ---------------------------------------------------------------------------
// 消息路由（background -> offscreen）
// ---------------------------------------------------------------------------

async function handleOffscreenMessage(message) {
  switch (message.type) {
    case MSG.OFFSCREEN_START:
      return handleStart(message);
    case MSG.OFFSCREEN_STOP:
      return handleStop(message);
    case MSG.OFFSCREEN_CONFIG:
      return handleConfigPatch(message.patch);
    case MSG.OFFSCREEN_PING:
      return {
        ok: true,
        running: runtime.running,
        starting: runtime.starting,
        connection: runtime.ws && runtime.ws.readyState === WebSocket.OPEN ? 'open' : 'closed',
        engineUrl: runtime.engineUrl,
        tabId: runtime.tabId,
        epochFrames: runtime.epoch ? runtime.epoch.framesSent : 0,
      };
    default:
      return { ok: false, error: `unknown offscreen message: ${message.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string' || !message.type.startsWith('livedub:offscreen-')) {
    return false;
  }
  handleOffscreenMessage(message).then(
    (response) => sendResponse(response ?? { ok: true }),
    (error) => sendResponse({ ok: false, error: String((error && error.message) || error) }),
  );
  return true;
});

// ---------------------------------------------------------------------------
// 启动 / 停止
// ---------------------------------------------------------------------------

/**
 * @param {{streamId:string, engineUrl:string, session:object, settings:object, tabId?:number}} message
 */
async function handleStart(message) {
  if (runtime.running || runtime.starting) await stopInternal('restart');
  const streamId = message.streamId;
  if (typeof streamId !== 'string' || !streamId) {
    return { ok: false, error: '缺少 tabCapture streamId（需要在用户手势内调用 getMediaStreamId）' };
  }
  runtime.starting = true;
  runtime.stopping = false;
  runtime.streamId = streamId;
  runtime.engineUrl = message.engineUrl || DEFAULT_ENGINE_URL;
  runtime.session = message.session && typeof message.session === 'object' ? message.session : {};
  runtime.settings = { ...DEFAULT_SETTINGS, ...(message.settings && typeof message.settings === 'object' ? message.settings : {}) };
  runtime.tabId = message.tabId ?? null;
  runtime.reconnectAttempts = 0;
  postState({ phase: 'starting', notice: '', error: null });
  try {
    await startAudioPipeline(streamId);
    if (runtime.stopping) {
      // start 过程中用户/background 已经要求停止
      await teardown();
      return { ok: false, error: '启动已被取消' };
    }
    runtime.running = true;
    runtime.starting = false;
    connectEngine();
    postState({
      phase: 'running',
      connection: 'connecting',
      capture: {
        sampleRate: runtime.captureCtx ? runtime.captureCtx.sampleRate : 0,
        targetRate: CAPTURE_SAMPLE_RATE,
        chunkMs: CHUNK_MS,
      },
    });
    log('capture pipeline started', { engineUrl: runtime.engineUrl, tabId: runtime.tabId });
    return { ok: true, capture: { sampleRate: runtime.captureCtx.sampleRate, chunkMs: CHUNK_MS } };
  } catch (err) {
    runtime.starting = false;
    runtime.running = false;
    const error = translateCaptureError(err);
    log('start failed', error.raw);
    await teardown();
    postState({ phase: 'error', connection: 'closed', error });
    return { ok: false, error: error.message, code: error.code };
  }
}

async function handleStop(message) {
  await stopInternal(typeof message.reason === 'string' ? message.reason : 'user');
  return { ok: true, stopped: true, connection: 'closed' };
}

async function stopInternal(reason = 'user', { notifyBackground = false } = {}) {
  if (runtime.stopping) return;
  runtime.stopping = true;
  try {
    if (runtime.ws && runtime.ws.readyState === WebSocket.OPEN) {
      try {
        runtime.ws.send(JSON.stringify({ type: 'control', action: 'stop', tMs: Math.round(getSessionNowMs()) }));
      } catch {
        /* ignore */
      }
      await sleep(STOP_CONTROL_WAIT_MS);
    }
  } finally {
    runtime.running = false;
    runtime.starting = false;
    await teardown();
    runtime.stopping = false;
    postState({ phase: 'idle', connection: 'closed' });
    if (notifyBackground) {
      chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_STOPPED, reason }).catch(() => {});
    }
    log('capture stopped', { reason });
  }
}

/** 释放所有音频/连接资源；可重复调用 */
async function teardown() {
  if (runtime.reconnectTimer) {
    clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = null;
  }
  try {
    runtime.workletNode && runtime.workletNode.port && runtime.workletNode.port.postMessage({ type: 'flush' });
  } catch {
    /* ignore */
  }
  try {
    runtime.workletNode && runtime.workletNode.disconnect();
  } catch {
    /* ignore */
  }
  try {
    runtime.captureSource && runtime.captureSource.disconnect();
  } catch {
    /* ignore */
  }
  try {
    runtime.monitorSource && runtime.monitorSource.disconnect();
  } catch {
    /* ignore */
  }
  try {
    runtime.monitorGain && runtime.monitorGain.disconnect();
  } catch {
    /* ignore */
  }
  try {
    runtime.silentGain && runtime.silentGain.disconnect();
  } catch {
    /* ignore */
  }
  for (const source of runtime.dubSources) {
    try {
      source.stop();
    } catch {
      /* ignore */
    }
  }
  runtime.dubSources.clear();
  try {
    if (runtime.stream && runtime.stream.getTracks) runtime.stream.getTracks().forEach((track) => track.stop());
  } catch {
    /* ignore */
  }
  const ws = runtime.ws;
  if (ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close(1000, 'livedub stop');
    } catch {
      /* ignore */
    }
  }
  try {
    if (runtime.monitorCtx) await runtime.monitorCtx.close();
  } catch {
    /* ignore */
  }
  try {
    if (runtime.captureCtx) await runtime.captureCtx.close();
  } catch {
    /* ignore */
  }
  runtime.ws = null;
  runtime.epoch = null;
  runtime.stream = null;
  runtime.captureCtx = null;
  runtime.monitorCtx = null;
  runtime.captureSource = null;
  runtime.monitorSource = null;
  runtime.monitorGain = null;
  runtime.silentGain = null;
  runtime.workletNode = null;
  runtime.streamId = null;
  runtime.reconnectAttempts = 0;
}

// ---------------------------------------------------------------------------
// 音频采集（tabCapture -> 16k PCM 分片）
// ---------------------------------------------------------------------------

async function startAudioPipeline(streamId) {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    throw new Error('当前环境不支持 getUserMedia：offscreen document 未正确创建');
  }
  // 1) 消费 background 传来的 tabCapture streamId（Chrome 固定写法）
  runtime.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });
  const audioTracks = runtime.stream.getAudioTracks ? runtime.stream.getAudioTracks() : [];
  if (!audioTracks || audioTracks.length === 0) {
    throw new Error('没有拿到标签页音轨：页面可能没有声音，请先让视频开始播放');
  }
  const [track] = audioTracks;
  if (track && typeof track.addEventListener === 'function') {
    track.addEventListener('ended', () => {
      if (runtime.running) {
        postState({ notice: '标签页音轨已结束（停止共享/标签页关闭），抓音停止' });
        stopInternal('track-ended', { notifyBackground: true }).catch(() => {});
      }
    });
  }

  // 2) 监听重放：tabCapture 抓走后标签页本地声音被静音，必须在这里播回去
  runtime.monitorCtx = new AudioContext();
  runtime.monitorSource = runtime.monitorCtx.createMediaStreamSource(runtime.stream);
  runtime.monitorGain = runtime.monitorCtx.createGain();
  runtime.monitorGain.gain.value = 1;
  runtime.monitorSource.connect(runtime.monitorGain).connect(runtime.monitorCtx.destination);
  await runtime.monitorCtx.resume().catch(() => {});

  // 3) 采集：优先请求 16000Hz 的 AudioContext（浏览器会做内部重采样）；
  //    个别环境不支持指定采样率时退回默认采样率，由 worklet 负责重采样到 16k。
  runtime.captureCtx = await createCaptureContext();
  await runtime.captureCtx.audioWorklet.addModule(chrome.runtime.getURL('worklet/pcm-worklet.js'));
  runtime.captureSource = runtime.captureCtx.createMediaStreamSource(runtime.stream);
  runtime.workletNode = new AudioWorkletNode(runtime.captureCtx, 'livedub-pcm', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { targetRate: CAPTURE_SAMPLE_RATE, chunkMs: CHUNK_MS },
  });
  runtime.workletNode.port.onmessage = (event) => handleWorkletMessage(event.data);
  runtime.workletNode.port.onmessageerror = () => log('worklet message error');
  // 接一个 0 增益到 destination：保证音频图持续被渲染（worklet 只负责产出 PCM）
  runtime.silentGain = runtime.captureCtx.createGain();
  runtime.silentGain.gain.value = 0;
  runtime.captureSource.connect(runtime.workletNode);
  runtime.workletNode.connect(runtime.silentGain).connect(runtime.captureCtx.destination);
  await resumeContexts();
  log('audio pipeline ready', {
    captureSampleRate: runtime.captureCtx.sampleRate,
    monitorSampleRate: runtime.monitorCtx.sampleRate,
  });
}

/** 尽量拿到 16000Hz 的采集 AudioContext；失败则回退默认采样率（worklet 会重采样） */
async function createCaptureContext() {
  try {
    const context = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
    if (typeof context.sampleRate === 'number' && context.sampleRate > 0) return context;
    await context.close().catch(() => {});
  } catch (err) {
    log('16000Hz AudioContext unavailable, fallback to default sample rate', err && err.message);
  }
  return new AudioContext();
}

/**
 * 确保采集/监听两个 AudioContext 处于 running。
 * offscreen document 通常不受页面 autoplay 限制，但个别 Chrome/设备会先给 suspended，
 * 这里重试几次并记录日志；仍失败时提示用户（原声会听不到，但字幕仍可用）。
 */
async function resumeContexts() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const captureRunning = !runtime.captureCtx || runtime.captureCtx.state === 'running';
    const monitorRunning = !runtime.monitorCtx || runtime.monitorCtx.state === 'running';
    if (captureRunning && monitorRunning) return true;
    try {
      if (runtime.captureCtx && runtime.captureCtx.state !== 'running') await runtime.captureCtx.resume();
    } catch {
      /* ignore */
    }
    try {
      if (runtime.monitorCtx && runtime.monitorCtx.state !== 'running') await runtime.monitorCtx.resume();
    } catch {
      /* ignore */
    }
    await sleep(200);
  }
  postState({ notice: '浏览器未允许 offscreen 播放音频：原声/配音可能无声（字幕仍可用），可尝试重新开始。' });
  return false;
}

/** worklet -> 主线程：{type:'pcm', pcm:ArrayBuffer(int16), frames} */
function handleWorkletMessage(data) {
  if (!data || data.type !== 'pcm' || !data.pcm) return;
  let pcm;
  try {
    pcm = new Int16Array(data.pcm);
  } catch {
    return;
  }
  if (pcm.length === 0) return;
  enqueuePcm(pcm);
}

function enqueuePcm(pcm) {
  const epoch = runtime.epoch;
  // 断线重连期间没有 epoch：直接丢弃（实时同传不值得缓存过久音频）
  if (!epoch) return;
  if (epoch.ready && runtime.ws && runtime.ws.readyState === WebSocket.OPEN) {
    sendPcmFrame(epoch, pcm);
    return;
  }
  epoch.pending.push(pcm);
  while (epoch.pending.length > MAX_PENDING_CHUNKS) {
    epoch.pending.shift();
    epoch.dropped += 1;
    if (epoch.dropped % 10 === 1) {
      postState({ notice: `引擎尚未就绪，已丢弃约 ${((epoch.dropped * CHUNK_MS) / MS_PER_SECOND).toFixed(1)}s 音频` });
    }
  }
}

function sendPcmFrame(epoch, pcm) {
  const ws = runtime.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const tMs = Math.round((epoch.sentSamples * MS_PER_SECOND) / CAPTURE_SAMPLE_RATE);
  if (epoch.t0Perf == null) epoch.t0Perf = performance.now();
  try {
    ws.send(encodeAudioFrame(tMs, pcm));
  } catch (err) {
    log('send audio frame failed', err && err.message);
    return;
  }
  epoch.sentSamples += pcm.length;
  epoch.framesSent += 1;
}

function flushPending(epoch) {
  if (!epoch.pending.length) return;
  const queued = epoch.pending;
  epoch.pending = [];
  for (const pcm of queued) sendPcmFrame(epoch, pcm);
}

// ---------------------------------------------------------------------------
// WebSocket <-> 引擎
// ---------------------------------------------------------------------------

function connectEngine() {
  if (runtime.stopping) return;
  disconnectWs();
  const epoch = {
    id: (runtime.epochSeq += 1),
    ready: false,
    t0Perf: null,
    sentSamples: 0,
    framesSent: 0,
    pending: [],
    dropped: 0,
  };
  runtime.epoch = epoch;
  postState({ connection: 'connecting' });
  let ws;
  try {
    ws = new WebSocket(runtime.engineUrl);
  } catch (err) {
    log('new WebSocket failed', err && err.message);
    postState({ connection: 'closed', notice: `引擎地址无效：${runtime.engineUrl}` });
    scheduleReconnect({ code: 'invalid-url' });
    return;
  }
  runtime.ws = ws;
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    if (runtime.stopping || runtime.ws !== ws) return;
    postState({ connection: 'open' });
    // 第一条必须是 hello（docs/CONTRACTS.md §3.1）
    const hello = buildHelloMessage({
      title: runtime.session ? runtime.session.title : '',
      url: runtime.session ? runtime.session.url : '',
      langFrom: runtime.settings.langFrom,
      langTo: runtime.settings.langTo,
      source: 'extension',
      overrides: buildOverrides(),
    });
    try {
      ws.send(JSON.stringify(hello));
    } catch (err) {
      log('send hello failed', err && err.message);
    }
  };
  ws.onmessage = (event) => {
    if (typeof event.data !== 'string') return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (runtime.epoch !== epoch) return;
    handleEngineMessage(message, epoch);
  };
  ws.onerror = () => {
    log('engine ws error', runtime.engineUrl);
  };
  ws.onclose = (event) => {
    if (runtime.ws === ws) runtime.ws = null;
    if (runtime.stopping) return;
    postState({ connection: 'closed' });
    scheduleReconnect({ code: event && event.code });
  };
}

function disconnectWs() {
  const ws = runtime.ws;
  if (!ws) return;
  ws.onopen = null;
  ws.onmessage = null;
  ws.onerror = null;
  ws.onclose = null;
  try {
    ws.close(1000, 'livedub reconnect');
  } catch {
    /* ignore */
  }
  runtime.ws = null;
  runtime.epoch = null;
}

/** 发给引擎的会话级 overrides（hello.session.overrides，深合并到引擎 config） */
function buildOverrides() {
  return {
    dub: { enabled: runtime.settings.dubEnabled !== false },
    tts: { voiceMode: runtime.settings.voiceMode || 'clone-first' },
  };
}

function scheduleReconnect(info = {}) {
  if (runtime.stopping || runtime.reconnectTimer) return;
  const attempt = runtime.reconnectAttempts;
  const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
  runtime.reconnectAttempts = attempt + 1;
  postState({
    connection: 'closed',
    notice: `引擎连接断开（${(info && info.code) ?? 'no code'}），${(delay / MS_PER_SECOND).toFixed(1)}s 后重连（第 ${attempt + 1} 次）`,
  });
  runtime.reconnectTimer = setTimeout(() => {
    runtime.reconnectTimer = null;
    if (runtime.stopping || !runtime.running) return;
    connectEngine();
  }, delay);
}

function getSessionNowMs() {
  const epoch = runtime.epoch;
  if (!epoch || epoch.t0Perf == null) return 0;
  return Math.max(0, performance.now() - epoch.t0Perf);
}

function sendEngineJson(message) {
  const ws = runtime.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch (err) {
    log('send engine json failed', err && err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 引擎事件
// ---------------------------------------------------------------------------

function handleEngineMessage(message, epoch) {
  if (!message || typeof message.type !== 'string') return;
  switch (message.type) {
    case 'ready':
      epoch.ready = true;
      runtime.reconnectAttempts = 0;
      flushPending(epoch);
      postState({ connection: 'open', notice: '' });
      forwardEvent({ type: 'ready', protocol: message.protocol, providers: message.providers, voice: message.voice, limits: message.limits });
      break;
    case 'pong':
      return;
    case 'dub':
      if (runtime.settings.dubEnabled !== false) scheduleDub(message);
      forwardEvent({
        type: 'dub',
        id: message.id,
        seq: message.seq,
        startMs: message.startMs,
        durationMs: message.durationMs,
        final: !!message.final,
      });
      break;
    case 'bye':
      forwardEvent({ type: 'bye', reason: message.reason });
      postState({ connection: 'closed', notice: `引擎关闭了本次会话（${message.reason || 'bye'}），抓音已停止` });
      stopInternal('engine-bye', { notifyBackground: true }).catch(() => {});
      break;
    case 'partial':
    case 'segment':
    case 'translation':
    case 'status':
    case 'metrics':
    case 'voice':
    case 'error':
      forwardEvent(message);
      break;
    default:
      // 未知事件原样转发，浮层可忽略；便于协议演进时排查
      forwardEvent(message);
      break;
  }
}

/**
 * 配音播放：引擎 dub 事件带 base64(s16le) + startMs（会话时间轴）。
 * 按 startMs 排期；落后（来不及）立即播（docs/CONTRACTS.md §3.2）。
 * 播放使用监听用的默认采样率 AudioContext，音质比 16k 好。
 */
function scheduleDub(event) {
  const context = runtime.monitorCtx;
  if (!context || typeof event.pcm !== 'string' || !event.pcm) return;
  let samples;
  try {
    samples = base64ToFloat32(event.pcm);
  } catch (err) {
    log('dub decode failed', err && err.message);
    return;
  }
  if (!samples || samples.length === 0) return;
  const sampleRate = Number.isFinite(event.sampleRate) && event.sampleRate > 0 ? event.sampleRate : 24000;
  let buffer;
  try {
    buffer = context.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
  } catch (err) {
    log('dub buffer failed', err && err.message);
    return;
  }
  let source;
  try {
    source = context.createBufferSource();
    source.buffer = buffer;
  } catch (err) {
    log('dub source failed', err && err.message);
    return;
  }
  const gain = context.createGain();
  gain.gain.value = 1;
  source.connect(gain).connect(context.destination);
  const startAt = computeDubStartTime(context, event.startMs);
  runtime.dubSources.add(source);
  source.onended = () => {
    runtime.dubSources.delete(source);
    try {
      gain.disconnect();
    } catch {
      /* ignore */
    }
  };
  try {
    source.start(startAt);
  } catch (err) {
    log('dub start failed', err && err.message);
    runtime.dubSources.delete(source);
  }
}

function computeDubStartTime(context, startMs) {
  const epoch = runtime.epoch;
  // 没有会话时间轴信息时立即播（+30ms 抵消解码/调度抖动）
  const sessionNowMs = epoch && epoch.t0Perf != null ? performance.now() - epoch.t0Perf : null;
  return computeDubPlayhead({ startMs, sessionNowMs, currentTime: context.currentTime });
}

function handleConfigPatch(patch) {
  if (!patch || typeof patch !== 'object') return { ok: false, error: 'invalid config patch' };
  if (patch.dub && typeof patch.dub.enabled === 'boolean') {
    runtime.settings = { ...runtime.settings, dubEnabled: patch.dub.enabled };
  }
  if (patch.tts && typeof patch.tts.voiceMode === 'string') {
    runtime.settings = { ...runtime.settings, voiceMode: patch.tts.voiceMode };
  }
  const sent = sendEngineJson({ type: 'config', patch });
  return { ok: true, forwarded: sent };
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function postState(patch) {
  chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_STATE, patch }).catch(() => {});
}

function forwardEvent(event) {
  chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_EVENT, event }).catch(() => {});
}

function translateCaptureError(err) {
  const raw = String((err && err.message) || err || 'unknown error');
  let code = 'CAPTURE_FAILED';
  let message;
  if (/permission|not allowed|denied|NotAllowedError/i.test(raw)) {
    code = 'PERMISSION';
    message = '标签页音频抓取被拒绝：请确认当前页面正在播放声音、扩展已启用，然后点击扩展图标重新开始。';
  } else if (/没有拿到标签页音轨|audio track/i.test(raw)) {
    code = 'NO_AUDIO';
    message = '没有拿到标签页音轨：请先让视频开始播放（有声音），再点击开始。';
  } else if (/stream|streamId|InvalidStateError|NotFoundError/i.test(raw)) {
    code = 'BAD_STREAM';
    message = 'tabCapture streamId 已失效：请重新点击扩展图标开始（streamId 必须在用户手势内获取并尽快使用）。';
  } else {
    message = `抓音初始化失败：${raw}`;
  }
  return { scope: 'capture', code, message, raw };
}

// 暴露少量只读信息，方便 chrome://inspect 调试 offscreen document
Object.defineProperty(globalThis, '__livedubOffscreen', {
  value: {
    status() {
      return {
        running: runtime.running,
        stopping: runtime.stopping,
        engineUrl: runtime.engineUrl,
        tabId: runtime.tabId,
        captureSampleRate: runtime.captureCtx ? runtime.captureCtx.sampleRate : null,
        monitorSampleRate: runtime.monitorCtx ? runtime.monitorCtx.sampleRate : null,
        pendingChunks: runtime.epoch ? runtime.epoch.pending.length : 0,
        framesSent: runtime.epoch ? runtime.epoch.framesSent : 0,
        reconnectAttempts: runtime.reconnectAttempts,
        reasons: [...OFFSCREEN_REASONS],
        justification: OFFSCREEN_JUSTIFICATION,
      };
    },
  },
  enumerable: false,
});
