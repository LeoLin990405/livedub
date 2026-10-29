/**
 * livedub Chrome MV3 扩展 —— background service worker（module）。
 *
 * 职责：
 * 1. 用户点击扩展图标（popup 内按钮 / 快捷键 Alt+Shift+L / action.onClicked）时
 *    在用户手势内调用 chrome.tabCapture.getMediaStreamId({ targetTabId })，拿到 streamId；
 * 2. 创建（或复用）offscreen document，把 streamId + engineUrl + 会话信息交给它；
 * 3. 转发 offscreen 收到的引擎事件给 content script（浮层）与 popup（状态）；
 * 4. 维护扩展运行态（popup 关闭 / SW 被浏览器回收后仍能恢复）；
 * 5. 停止时通知 offscreen 收尾并关闭 offscreen document。
 *
 * 关键约束（docs/CONTRACTS.md §8）：
 * - tabCapture.getMediaStreamId 必须在用户手势内调用 —— popup 的点击回调是手势，
 *   快捷键/action 点击也是；普通消息链（content -> SW）不是，失败时给可读错误；
 * - offscreen document 只使用 chrome.runtime API，所以引擎事件统一经 SW 转发；
 * - MV3 service worker 可能被回收：运行态写 chrome.storage.session，恢复时校验 offscreen 是否还在。
 */

import {
  DEFAULT_ENGINE_URL,
  DEFAULT_SETTINGS,
  MSG,
  OFFSCREEN_DOCUMENT_URL,
  OFFSCREEN_JUSTIFICATION,
  OFFSCREEN_REASONS,
  STORAGE_KEYS,
  isCapturablePage,
  normalizeEngineUrl,
} from './lib/constants.js';
import { pickLatencyMs } from './lib/pcm.js';
import { buildSrtFromCaptions, suggestSrtFilename } from './lib/srt.js';

const LOG_PREFIX = '[livedub:bg]';
const log = (...args) => console.debug(LOG_PREFIX, ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** offscreen 文档绝对 URL（用于 runtime.getContexts 校验是否已存在） */
const OFFSCREEN_ABSOLUTE_URL = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_URL);

/** 本 SW 处理的消息类型（其余广播消息忽略） */
const BACKGROUND_MESSAGE_TYPES = new Set([
  MSG.GET_STATE,
  MSG.START,
  MSG.STOP,
  MSG.CONTENT_READY,
  MSG.CONTENT_TOGGLE,
  MSG.SET_SETTINGS,
  MSG.CONFIG_PATCH,
  MSG.GET_SRT,
  MSG.RECONNECT,
  MSG.OFFSCREEN_HELLO,
  MSG.OFFSCREEN_STATE,
  MSG.OFFSCREEN_EVENT,
  MSG.OFFSCREEN_STOPPED,
]);

/** 运行态（会写 chrome.storage.session，SW 回收后尽量恢复） */
function emptyState(engineUrl = DEFAULT_ENGINE_URL) {
  return {
    phase: 'idle', // idle | starting | running | stopping | error
    connection: 'closed', // closed | connecting | open
    engineState: 'idle', // idle | listening | translating | speaking | paused | error
    engineUrl,
    tabId: null,
    tabTitle: '',
    /** 本次会话元信息（popup 展示语言方向 / 标题） */
    session: null, // {title, url, langFrom, langTo}
    startedAt: null,
    /** 已累积的字幕条数（导出 SRT 用） */
    captionCount: 0,
    ready: null, // 引擎 ready 事件摘要 {protocol, providers, voice, limits}
    voice: null, // {mode, voiceId, degraded?, reason?}
    metrics: null, // 最近一条 metrics
    latencyMs: null,
    dubActive: false,
    capture: null, // {sampleRate, targetRate}
    error: null, // {scope, message, code?, recoverable?}
    notice: '', // 一次性提示（重连 / 引擎地址变更 / 已停止...）
    updatedAt: Date.now(),
  };
}

let settings = { ...DEFAULT_SETTINGS };
let bgState = emptyState(settings.engineUrl);
let initPromise = null;
let offscreenCreating = null;
let persistTimer = null;
let broadcastTimer = null;
let dubActiveTimer = null;
let finishedStop = true;

// ---------------------------------------------------------------------------
// 字幕累积（客户端 segment + translation -> 导出 SRT）
// ---------------------------------------------------------------------------

/** 单次会话最多累积多少条（防止超长视频内存膨胀；SRT 导出取最近 400 句） */
const CAPTION_LIMIT = 400;
/** @type {Array<{id:string, t0Ms:number|null, t1Ms:number|null, src:string, dst:string, final:boolean, updatedAt:number}>} */
let captionItems = [];
let captionSessionKey = null;
let captionPersistTimer = null;

/** 新会话开始时清空字幕累积 */
function resetCaptions(sessionKey = null) {
  captionItems = [];
  captionSessionKey = sessionKey;
  persistCaptionsNow();
  if (bgState.captionCount !== 0) updateState({ captionCount: 0 });
}

function persistCaptionsNow() {
  if (captionPersistTimer) {
    clearTimeout(captionPersistTimer);
    captionPersistTimer = null;
  }
  chrome.storage.session
    .set({ [STORAGE_KEYS.captions]: { sessionKey: captionSessionKey, items: captionItems } })
    .catch(() => {});
}

function persistCaptionsSoon(delay = 800) {
  if (captionPersistTimer) return;
  captionPersistTimer = setTimeout(() => {
    captionPersistTimer = null;
    persistCaptionsNow();
  }, delay);
}

/** segment / translation 事件 -> 字幕条目（同一 id 合并） */
function upsertCaption(patch) {
  const id = patch && patch.id != null ? String(patch.id) : '';
  if (!id) return;
  let item = captionItems.find((caption) => caption.id === id);
  if (!item) {
    if (captionItems.length >= CAPTION_LIMIT) captionItems = captionItems.slice(-(CAPTION_LIMIT - 1));
    item = { id, t0Ms: null, t1Ms: null, src: '', dst: '', final: false, updatedAt: 0 };
    captionItems.push(item);
  }
  if (Number.isFinite(patch.t0Ms) && patch.t0Ms >= 0) item.t0Ms = Math.round(patch.t0Ms);
  if (Number.isFinite(patch.t1Ms) && patch.t1Ms >= 0) item.t1Ms = Math.round(patch.t1Ms);
  if (typeof patch.src === 'string') item.src = patch.src.slice(0, 800);
  if (typeof patch.dst === 'string') item.dst = patch.dst.slice(0, 800);
  if (patch.final != null) item.final = patch.final === true;
  item.updatedAt = Date.now();
  persistCaptionsSoon();
  if (bgState.captionCount !== captionItems.length) updateState({ captionCount: captionItems.length });
}

/** 组装导出结果（纯函数渲染在 lib/srt.js） */
function buildSrtPayload() {
  const result = buildSrtFromCaptions(captionItems, { bilingual: true, maxCharsPerLine: 24, maxLines: 2 });
  const title = bgState.tabTitle || (bgState.session && bgState.session.title) || 'livedub';
  const filename = suggestSrtFilename({ title, startedAt: bgState.startedAt || Date.now() });
  return { srt: result.srt, count: result.count, filename };
}

// ---------------------------------------------------------------------------
// 初始化 / 状态持久化
// ---------------------------------------------------------------------------

async function init() {
  try {
    const stored = await chrome.storage.local.get({ [STORAGE_KEYS.settings]: null });
    const storedSettings = stored[STORAGE_KEYS.settings];
    settings = { ...DEFAULT_SETTINGS, ...(storedSettings && typeof storedSettings === 'object' ? storedSettings : {}) };
    settings.engineUrl = normalizeEngineUrl(settings.engineUrl) || DEFAULT_ENGINE_URL;
    bgState.engineUrl = settings.engineUrl;

    // 恢复本次会话累积的字幕（导出 SRT 在 SW 回收后依然可用）
    const captionsStored = await chrome.storage.session.get({ [STORAGE_KEYS.captions]: null });
    const captionsSnapshot = captionsStored[STORAGE_KEYS.captions];
    if (captionsSnapshot && Array.isArray(captionsSnapshot.items)) {
      captionItems = captionsSnapshot.items.slice(-CAPTION_LIMIT);
      captionSessionKey = captionsSnapshot.sessionKey ?? null;
    }

    // 恢复被回收前的运行态；先确认 offscreen 还活着
    const sessionStored = await chrome.storage.session.get({ [STORAGE_KEYS.bgState]: null });
    const previous = sessionStored[STORAGE_KEYS.bgState];
    const wasActive =
      previous && typeof previous === 'object' && ['starting', 'running', 'stopping'].includes(previous.phase);
    if (wasActive) {
      const alive = await contextExists();
      if (alive) {
        bgState = { ...emptyState(settings.engineUrl), ...previous, engineUrl: settings.engineUrl };
        finishedStop = false; // 允许用户之后正常 stop 收尾
        try {
          const offscreenState = await sendToOffscreen({ type: MSG.OFFSCREEN_PING, from: 'background-restore' }, { timeoutMs: 1500 });
          if (offscreenState && offscreenState.running === false) {
            bgState = emptyState(settings.engineUrl);
            bgState.notice = '抓音会话已结束，请重新点击开始';
            await chrome.storage.session.remove(STORAGE_KEYS.bgState);
          }
        } catch (err) {
          log('restore: offscreen ping failed', err && err.message);
        }
      } else {
        bgState = emptyState(settings.engineUrl);
        bgState.notice = '浏览器回收了后台页面，抓音已停止；请重新点击开始';
        await chrome.storage.session.remove(STORAGE_KEYS.bgState);
      }
    }
  } catch (err) {
    log('init failed', err && err.message);
  }
  if (bgState && typeof bgState === 'object') bgState.captionCount = captionItems.length;
}

function ensureInit() {
  if (!initPromise) initPromise = init().catch((err) => log('init failed', err && err.message));
  return initPromise;
}

function schedulePersist(delay = 250) {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    chrome.storage.session.set({ [STORAGE_KEYS.bgState]: bgState }).catch(() => {});
  }, delay);
}

function scheduleBroadcast(delay = 60) {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcastState();
  }, delay);
}

/** 广播给 popup（关闭时 sendMessage 会 reject，吞掉即可） */
function broadcastState() {
  const state = publicState();
  chrome.runtime.sendMessage({ type: MSG.STATE, state, settings: { ...settings } }).catch(() => {});
  if (bgState.tabId != null) pushToContent(bgState.tabId, { type: MSG.STATE, state });
}

function publicState() {
  return { ...bgState };
}

function updateState(patch, { broadcast = true, persist = true } = {}) {
  bgState = { ...bgState, ...patch, updatedAt: Date.now() };
  if (Object.prototype.hasOwnProperty.call(patch, 'metrics')) bgState.latencyMs = pickLatencyMs(bgState.metrics);
  if (broadcast) scheduleBroadcast();
  if (persist) schedulePersist();
}

/** 给 content script 发消息（标签页关闭 / 内容脚本未注入时静默失败） */
function pushToContent(tabId, payload) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, payload).catch(() => {});
}

// ---------------------------------------------------------------------------
// offscreen document 生命周期
// ---------------------------------------------------------------------------

async function contextExists() {
  try {
    if (typeof chrome.runtime.getContexts === 'function') {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [OFFSCREEN_ABSOLUTE_URL],
      });
      return Array.isArray(contexts) && contexts.length > 0;
    }
  } catch (err) {
    log('contextExists failed', err && err.message);
  }
  return false;
}

async function ensureOffscreen() {
  if (await contextExists()) return;
  if (offscreenCreating) return offscreenCreating;
  offscreenCreating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_DOCUMENT_URL,
      reasons: [...OFFSCREEN_REASONS],
      justification: OFFSCREEN_JUSTIFICATION,
    })
    .catch((err) => {
      const message = String((err && err.message) || err);
      // 并发创建时 Chrome 报 "Only a single offscreen document may be created"，视为已存在
      if (!/single offscreen/i.test(message)) throw err;
    })
    .finally(() => {
      offscreenCreating = null;
    });
  return offscreenCreating;
}

async function closeOffscreen() {
  try {
    if (await contextExists()) await chrome.offscreen.closeDocument();
  } catch (err) {
    log('closeOffscreen failed', err && err.message);
  }
}

/**
 * 给 offscreen 发消息。offscreen 刚创建时脚本可能还没注册监听，所以这里带重试。
 * @param {object} message
 * @param {{timeoutMs?:number}} [opts]
 */
async function sendToOffscreen(message, { timeoutMs = 6000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (response && typeof response === 'object' && typeof response.ok === 'boolean') return response;
      lastError = new Error('offscreen 未返回有效响应');
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) throw lastError || new Error('offscreen 无响应');
    await sleep(120);
  }
}

// ---------------------------------------------------------------------------
// 抓音开始 / 停止
// ---------------------------------------------------------------------------

async function getActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs && tabs.length > 0) return tabs[0];
    const again = await chrome.tabs.query({ active: true });
    return again && again.length > 0 ? again[0] : null;
  } catch (err) {
    log('getActiveTab failed', err && err.message);
    return null;
  }
}

/** 把 Chrome 的原始错误翻译成「下一步怎么办」 */
function captureErrorFrom(err) {
  const raw = String((err && err.message) || err || 'unknown error');
  let code = 'CAPTURE_FAILED';
  let message;
  if (/gesture|not been invoked|activeTab|user.*invok/i.test(raw)) {
    code = 'NEED_GESTURE';
    message = 'Chrome 要求用户手势才能抓音：请点击工具栏的 livedub 图标，在弹窗里点「开始同传」（或用快捷键 Alt+Shift+L）。';
  } else if (/chrome:\/\/|cannot be captured|cannot capture|not allowed|extensions gallery/i.test(raw)) {
    code = 'RESTRICTED_PAGE';
    message = '当前页面不支持抓音（chrome://、扩展商店等页面无法被捕获），请切换到视频页面后重试。';
  } else if (/permission/i.test(raw)) {
    code = 'PERMISSION';
    message = '扩展缺少抓音权限：请在 chrome://extensions 中检查 livedub 已启用 tabCapture 权限。';
  } else {
    message = `抓音失败：${raw}。请确认视频页面正在播放、扩展已启用后重试。`;
  }
  return { scope: 'capture', code, message, raw };
}

function failState(error, { tabId = null, tabTitle = '', engineUrl = settings.engineUrl } = {}) {
  return { ...emptyState(engineUrl), phase: 'error', error, tabId, tabTitle };
}

/**
 * 开始抓音。
 * @param {{tab?:chrome.tabs.Tab|null, tabId?:number|null, streamId?:string|null, engineUrl?:string|null, source?:string}} opts
 */
async function startCapture({ tab = null, tabId = null, streamId = null, engineUrl = null, source = 'unknown' } = {}) {
  await ensureInit();
  if (['running', 'starting', 'stopping'].includes(bgState.phase)) {
    return { ok: true, alreadyRunning: bgState.phase !== 'stopping', state: publicState() };
  }

  let targetTab = tab;
  if (!targetTab) {
    try {
      targetTab = tabId != null ? await chrome.tabs.get(tabId) : await getActiveTab();
    } catch (err) {
      log('resolve tab failed', err && err.message);
      targetTab = null;
    }
  }
  if (!targetTab || targetTab.id == null) {
    const error = { scope: 'capture', code: 'NO_TAB', message: '没有可抓取的标签页：请先切换到正在播放的视频页面。' };
    updateState({ ...failState(error), tabId: null });
    return { ok: false, error };
  }
  if (targetTab.url && !isCapturablePage(targetTab.url)) {
    const error = captureErrorFrom(new Error(`cannot capture ${targetTab.url}`));
    updateState({ ...failState(error, { tabId: targetTab.id, tabTitle: targetTab.title || '' }) });
    return { ok: false, error };
  }

  const targetEngineUrl = normalizeEngineUrl(engineUrl || settings.engineUrl) || DEFAULT_ENGINE_URL;
  finishedStop = false;
  if (dubActiveTimer) {
    clearTimeout(dubActiveTimer);
    dubActiveTimer = null;
  }
  const startedAt = Date.now();
  const sessionInfo = {
    title: targetTab.title || '',
    url: targetTab.url || '',
    langFrom: settings.langFrom,
    langTo: settings.langTo,
  };
  updateState({
    ...emptyState(targetEngineUrl),
    phase: 'starting',
    connection: 'connecting',
    tabId: targetTab.id,
    tabTitle: targetTab.title || '',
    engineUrl: targetEngineUrl,
    session: sessionInfo,
    startedAt,
  });
  resetCaptions(startedAt);

  try {
    // 1) 拿 streamId —— 必须在用户手势链内，尽量放在最前面（见文件头注释）
    let id = streamId;
    if (!id) id = await captureTabStreamId(targetTab.id);
    // 2) 确保浮层已注入，避免引擎事件无人接收
    await ensureContentScript(targetTab.id);
    // 3) 创建/复用 offscreen document，让它消费 streamId 并连引擎
    await ensureOffscreen();
    const session = { source: 'extension', ...sessionInfo };
    const response = await sendToOffscreen(
      {
        type: MSG.OFFSCREEN_START,
        streamId: id,
        engineUrl: targetEngineUrl,
        session,
        settings: { ...settings },
        tabId: targetTab.id,
      },
      { timeoutMs: 15000 },
    );
    if (!response || response.ok !== true) {
      const reason =
        response && response.error
          ? typeof response.error === 'string'
            ? response.error
            : response.error.message || 'offscreen 拒绝启动抓音'
          : 'offscreen 拒绝启动抓音';
      throw new Error(reason);
    }
    updateState({ phase: 'running', connection: 'connecting', error: null, notice: '' });
    await pushToContent(targetTab.id, { type: MSG.CONTENT_SETTINGS, settings: { ...settings } });
    log('capture started', { source, tabId: targetTab.id, engineUrl: targetEngineUrl });
    return { ok: true, state: publicState() };
  } catch (err) {
    const error = captureErrorFrom(err);
    log('startCapture failed', error.raw);
    try {
      await sendToOffscreen({ type: MSG.OFFSCREEN_STOP, reason: 'start-failed' }, { timeoutMs: 1200 });
    } catch {
      /* ignore */
    }
    await closeOffscreen();
    updateState(failState(error, { tabId: targetTab.id, tabTitle: targetTab.title || '', engineUrl: targetEngineUrl }));
    // 保持 finishedStop=false：用户点「停止」时 finalizeStop 才能把 phase 复位到 idle
    // （stopCapture 在 error 状态下会跳过给 offscreen 发 STOP，直接收尾）
    return { ok: false, error };
  }
}

/** 单独抽出来，方便注释「用户手势内调用」并让测试静态校验 */
async function captureTabStreamId(tabId) {
  // chrome.tabCapture.getMediaStreamId 必须在用户手势内调用（docs/CONTRACTS.md §8）
  return chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
}

async function stopCapture(reason = 'user') {
  await ensureInit();
  if (bgState.phase === 'idle' && bgState.tabId == null) {
    return { ok: true, alreadyStopped: true, state: publicState() };
  }
  if (bgState.phase === 'stopping') return { ok: true, state: publicState() };
  const wasError = bgState.phase === 'error';
  updateState({ phase: 'stopping' });
  if (!wasError) {
    try {
      await sendToOffscreen({ type: MSG.OFFSCREEN_STOP, reason }, { timeoutMs: 2500 });
    } catch (err) {
      log('stop: offscreen not reachable', err && err.message);
    }
  }
  await finalizeStop(reason);
  return { ok: true, state: publicState() };
}

/** 幂等收尾：清状态、通知浮层恢复音量、关闭 offscreen */
async function finalizeStop(reason = 'user') {
  if (finishedStop) return;
  finishedStop = true;
  if (dubActiveTimer) {
    clearTimeout(dubActiveTimer);
    dubActiveTimer = null;
  }
  const tabId = bgState.tabId;
  const keepError = reason === 'start-failed' ? bgState.error : null;
  bgState = emptyState(settings.engineUrl);
  bgState.captionCount = captionItems.length; // 结束后仍可导出本次 SRT
  if (keepError) {
    bgState.phase = 'error';
    bgState.error = keepError;
  }
  scheduleBroadcast(0);
  schedulePersist(0);
  if (tabId != null) pushToContent(tabId, { type: MSG.STATE, state: publicState() });
  await sleep(120);
  await closeOffscreen();
  log('capture stopped', { reason });
}

// ---------------------------------------------------------------------------
// content script（浮层）
// ---------------------------------------------------------------------------

async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: MSG.PING });
    if (pong && pong.ok) return true;
  } catch {
    /* content script 尚未注入（扩展加载前就打开的标签页 / 页面刚导航） */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await sleep(40);
    return true;
  } catch (err) {
    log('inject content script failed', err && err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 引擎事件处理（offscreen -> background -> content/popup）
// ---------------------------------------------------------------------------

function clearDubActiveSoon() {
  if (dubActiveTimer) clearTimeout(dubActiveTimer);
  dubActiveTimer = setTimeout(() => {
    dubActiveTimer = null;
    if (bgState.dubActive) updateState({ dubActive: false });
  }, 400);
}

function handleEngineEvent(event) {
  if (!event || typeof event.type !== 'string') return;
  switch (event.type) {
    case 'ready':
      updateState({
        connection: 'open',
        ready: {
          protocol: event.protocol ?? null,
          providers: event.providers || null,
          voice: event.voice || null,
          limits: event.limits || null,
        },
        notice: '',
      });
      break;
    case 'status':
      updateState({ engineState: event.state || 'idle' });
      if (event.state === 'speaking') updateState({ dubActive: true });
      else clearDubActiveSoon();
      break;
    case 'metrics':
      updateState({ metrics: event });
      break;
    case 'segment':
      // ASR 最终句：SRT 的原文与时间轴
      upsertCaption({ id: event.id, t0Ms: event.t0Ms, t1Ms: event.t1Ms, src: event.text });
      break;
    case 'translation':
      // 同一 id 的译文（增量覆盖 / final）
      upsertCaption({ id: event.id, dst: event.text, final: event.final !== false });
      break;
    case 'voice':
      updateState({
        voice: { mode: event.mode || 'preset', voiceId: event.voiceId || '', degraded: !!event.degraded, reason: event.reason || '' },
      });
      break;
    case 'error':
      updateState({
        error: {
          scope: event.scope || 'session',
          message: String(event.message || '未知错误'),
          code: event.code || '',
          recoverable: event.recoverable !== false,
        },
      });
      break;
    case 'dub':
      updateState({ dubActive: true });
      clearDubActiveSoon();
      break;
    case 'pong':
      return;
    case 'bye':
      updateState({ connection: 'closed', notice: '引擎关闭了本次会话，抓音已停止。' });
      // offscreen 收到 bye 后也会自行收尾并发 OFFSCREEN_STOPPED，这里不重复发 STOP
      break;
    default:
      break;
  }
  forwardEngineEventToContent(event);
}

function forwardEngineEventToContent(event) {
  const tabId = bgState.tabId;
  if (tabId == null) return;
  let payload = event;
  if (event.type === 'dub') {
    // 不把 base64 PCM 转发给 content（浮层只需要知道「现在在配音」）
    payload = {
      type: 'dub',
      id: event.id,
      seq: event.seq,
      startMs: event.startMs,
      durationMs: event.durationMs,
      final: !!event.final,
    };
  } else if (event.type === 'ready') {
    payload = { type: 'ready', providers: event.providers || null, voice: event.voice || null };
  }
  pushToContent(tabId, { type: MSG.ENGINE_EVENT, event: payload });
}

function handleOffscreenState(patch) {
  if (!patch || typeof patch !== 'object') return;
  const next = {};
  if (typeof patch.connection === 'string') next.connection = patch.connection;
  if (typeof patch.notice === 'string' && patch.notice) next.notice = patch.notice;
  if (patch.error && typeof patch.error === 'object') next.error = patch.error;
  if (patch.capture && typeof patch.capture === 'object') next.capture = patch.capture;
  if (patch.phase === 'error') next.phase = 'error';
  if (Object.keys(next).length > 0) updateState(next);
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

function sanitizeSettingsPatch(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  if (typeof patch.engineUrl === 'string') {
    const normalized = normalizeEngineUrl(patch.engineUrl);
    if (normalized) out.engineUrl = normalized;
  }
  if (typeof patch.voiceMode === 'string') out.voiceMode = patch.voiceMode === 'preset' ? 'preset' : 'clone-first';
  for (const key of ['dubEnabled', 'showOriginal', 'hidden', 'captureReplay', 'globalDuck', 'fullscreenWorkaround']) {
    if (typeof patch[key] === 'boolean') out[key] = patch[key];
  }
  if (patch.duckRecoverMs != null) {
    const recover = Number(patch.duckRecoverMs);
    if (Number.isFinite(recover)) out.duckRecoverMs = Math.round(Math.min(3000, Math.max(300, recover)));
  }
  if (patch.duckRatio != null) {
    const ratio = Number(patch.duckRatio);
    if (Number.isFinite(ratio)) out.duckRatio = Math.min(1, Math.max(0.02, ratio));
  }
  if (patch.fontSize != null) {
    const size = Number(patch.fontSize);
    if (Number.isFinite(size)) out.fontSize = Math.min(32, Math.max(14, Math.round(size)));
  }
  if (typeof patch.langFrom === 'string' && patch.langFrom.trim()) out.langFrom = patch.langFrom.trim().slice(0, 20);
  if (typeof patch.langTo === 'string' && patch.langTo.trim()) out.langTo = patch.langTo.trim().slice(0, 20);
  if (patch.subsPos === null || (patch.subsPos && typeof patch.subsPos === 'object')) out.subsPos = patch.subsPos;
  return out;
}

function broadcastSettings() {
  chrome.runtime.sendMessage({ type: MSG.STATE, state: publicState(), settings: { ...settings } }).catch(() => {});
  if (bgState.tabId != null) pushToContent(bgState.tabId, { type: MSG.CONTENT_SETTINGS, settings: { ...settings } });
}

async function updateSettings(patch) {
  const sanitized = sanitizeSettingsPatch(patch);
  if (Object.keys(sanitized).length === 0) return { ok: false, error: { message: '没有可保存的设置字段' } };
  const previous = { ...settings };
  settings = { ...settings, ...sanitized };
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  if (sanitized.engineUrl) {
    if (['running', 'starting'].includes(bgState.phase)) {
      updateState({ notice: '引擎地址已保存，本次会话继续使用旧地址；重新开始后生效。' });
    } else {
      updateState({ engineUrl: settings.engineUrl });
    }
  }
  await syncEngineConfig(previous, settings);
  broadcastSettings();
  return { ok: true, settings: { ...settings }, state: publicState() };
}

/** 配音开关 / 音色模式变化时，通过 config 消息实时同步给运行中的引擎 */
async function syncEngineConfig(previous, next) {
  if (!['running', 'starting'].includes(bgState.phase)) return;
  // 引擎侧配置（dub/voiceMode 走 config 消息）
  const patch = {};
  if (previous.dubEnabled !== next.dubEnabled) patch.dub = { enabled: !!next.dubEnabled };
  if (previous.voiceMode !== next.voiceMode) patch.tts = { voiceMode: next.voiceMode };
  // v0.3 offscreen 本地音频设置（原声重放 / 全局限定压音 / 恢复延迟）
  const audioSettings = {};
  for (const key of ['captureReplay', 'globalDuck', 'duckRatio', 'duckRecoverMs']) {
    if (previous[key] !== next[key]) audioSettings[key] = next[key];
  }
  if (Object.keys(patch).length === 0 && Object.keys(audioSettings).length === 0) return;
  const message = { type: MSG.OFFSCREEN_CONFIG };
  if (Object.keys(patch).length > 0) message.patch = patch;
  if (Object.keys(audioSettings).length > 0) message.settings = audioSettings;
  try {
    await sendToOffscreen(message, { timeoutMs: 1500 });
  } catch (err) {
    log('syncEngineConfig failed', err && err.message);
  }
}

// ---------------------------------------------------------------------------
// 消息路由
// ---------------------------------------------------------------------------

async function handleMessage(message, sender) {
  switch (message.type) {
    case MSG.GET_STATE: {
      // SW 可能在别处被回收后重启：顺手校验 offscreen 是否还在
      if (['running', 'starting'].includes(bgState.phase)) {
        const alive = await contextExists();
        if (!alive) {
          bgState = emptyState(settings.engineUrl);
          bgState.notice = '抓音会话已结束（offscreen 已关闭），请重新开始';
          finishedStop = true;
          schedulePersist(0);
        }
      }
      return { ok: true, state: publicState(), settings: { ...settings }, studioUrl: null };
    }
    case MSG.START:
      return startCapture({
        tabId: message.tabId ?? null,
        streamId: message.streamId ?? null,
        engineUrl: message.engineUrl ?? null,
        source: 'popup',
      });
    case MSG.STOP:
      return stopCapture(typeof message.reason === 'string' ? message.reason : 'user');
    case MSG.CONTENT_READY: {
      const tabId = (sender && sender.tab && sender.tab.id) ?? bgState.tabId;
      if (tabId != null) {
        pushToContent(tabId, { type: MSG.STATE, state: publicState() });
        pushToContent(tabId, { type: MSG.CONTENT_SETTINGS, settings: { ...settings } });
      }
      return { ok: true, state: publicState(), settings: { ...settings } };
    }
    case MSG.CONTENT_TOGGLE: {
      if (['running', 'starting'].includes(bgState.phase)) return stopCapture('overlay');
      const tabId = (sender && sender.tab && sender.tab.id) ?? null;
      return startCapture({ tabId, source: 'overlay' });
    }
    case MSG.SET_SETTINGS:
      return updateSettings(message.patch);
    case MSG.CONFIG_PATCH: {
      if (!['running', 'starting'].includes(bgState.phase)) {
        return { ok: false, error: { message: '引擎尚未连接，配置将在重新开始后生效' } };
      }
      try {
        const response = await sendToOffscreen({ type: MSG.OFFSCREEN_CONFIG, patch: message.patch }, { timeoutMs: 1500 });
        return response || { ok: true };
      } catch (err) {
        return { ok: false, error: { message: String((err && err.message) || err) } };
      }
    }
    case MSG.GET_SRT: {
      const payload = buildSrtPayload();
      if (payload.count === 0) {
        return {
          ok: false,
          error: {
            code: 'NO_CAPTIONS',
            message: '本次会话还没有可导出的字幕：先开始同传，让视频说几句话后再试。',
          },
        };
      }
      return { ok: true, ...payload };
    }
    case MSG.RECONNECT: {
      if (!['running', 'starting'].includes(bgState.phase)) {
        return {
          ok: false,
          error: { code: 'NOT_RUNNING', message: '还没有开始抓音：请点击工具栏 livedub 图标，在弹窗里点「开始同传」。' },
        };
      }
      try {
        const response = await sendToOffscreen({ type: MSG.OFFSCREEN_RECONNECT }, { timeoutMs: 1500 });
        if (response && response.ok) {
          updateState({ notice: '已触发立即重连引擎…' });
          return { ok: true, reconnecting: true };
        }
        return response || { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: { code: 'NO_OFFSCREEN', message: `采集页面未响应（${String((err && err.message) || err)}），请停止后重新开始。` },
        };
      }
    }
    case MSG.OFFSCREEN_HELLO:
      return { ok: true, state: publicState() };
    case MSG.OFFSCREEN_STATE:
      handleOffscreenState(message.patch);
      return { ok: true };
    case MSG.OFFSCREEN_EVENT:
      handleEngineEvent(message.event);
      return { ok: true };
    case MSG.OFFSCREEN_STOPPED: {
      if (message.error) updateState({ error: message.error });
      if (!finishedStop) await finalizeStop(typeof message.reason === 'string' ? message.reason : 'offscreen');
      return { ok: true };
    }
    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string' || !BACKGROUND_MESSAGE_TYPES.has(message.type)) return false;
  handleMessage(message, sender).then(
    (response) => sendResponse(response ?? { ok: true }),
    (error) => sendResponse({ ok: false, error: { message: String((error && error.message) || error) } }),
  );
  return true;
});

// ---------------------------------------------------------------------------
// 入口事件（点击图标 / 快捷键 / 生命周期）
// ---------------------------------------------------------------------------

/** 点击图标/快捷键统一入口：在用户手势内开始或停止 */
async function toggleFromUserGesture(tab) {
  await ensureInit();
  if (['running', 'starting'].includes(bgState.phase)) return stopCapture('action');
  return startCapture({
    tab: tab && typeof tab.id === 'number' ? tab : null,
    tabId: tab && typeof tab.id === 'number' ? tab.id : null,
    source: 'action',
  });
}

chrome.action.onClicked.addListener((tab) => {
  // 注意：manifest 声明了 default_popup 时 Chrome 不会触发这个回调；
  // 这里保留「无 popup 构建 / 未来改为点击直接切换」的路径，逻辑与 popup 按钮一致。
  toggleFromUserGesture(tab).catch((err) => log('action toggle failed', err && err.message));
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-capture') return;
  // 快捷键触发属于用户手势链，可以直接调用 tabCapture.getMediaStreamId
  toggleFromUserGesture(tab).catch((err) => log('command toggle failed', err && err.message));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (bgState.tabId === tabId && !finishedStop) stopCapture('tab-closed').catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== bgState.tabId) return;
  if (changeInfo.status !== 'complete') return;
  // 页面导航 / SPA 整页刷新后：重新确认浮层在，并把最新状态补发一次
  ensureContentScript(tabId)
    .then(() => {
      pushToContent(tabId, { type: MSG.STATE, state: publicState() });
      pushToContent(tabId, { type: MSG.CONTENT_SETTINGS, settings: { ...settings } });
    })
    .catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[STORAGE_KEYS.settings]) return;
  const previous = { ...settings };
  const raw = changes[STORAGE_KEYS.settings].newValue;
  settings = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  settings.engineUrl = normalizeEngineUrl(settings.engineUrl) || DEFAULT_ENGINE_URL;
  if (bgState.phase === 'idle') updateState({ engineUrl: settings.engineUrl });
  broadcastSettings();
  syncEngineConfig(previous, settings).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  ensureInit()
    .then(async () => {
      const stored = await chrome.storage.local.get({ [STORAGE_KEYS.settings]: null });
      if (!stored[STORAGE_KEYS.settings]) {
        await chrome.storage.local.set({ [STORAGE_KEYS.settings]: { ...DEFAULT_SETTINGS } });
      }
    })
    .catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureInit().catch(() => {});
});

// SW 启动即恢复运行态（不阻塞监听器注册）
ensureInit();
