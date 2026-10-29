/**
 * livedub 本地工作台（studio）主逻辑。
 *
 * 链路：视频元素 -> Web Audio（MediaElementSource -> AudioWorklet 16k 重采样）
 *      -> 每 100ms 二进制帧（0x01 + float64BE tMs + s16le）-> WS /ws
 *      -> 引擎事件（partial/segment/translation/dub/metrics/...）-> 双语字幕 + 配音队列 + HUD。
 *
 * 另有「演示回放」模式（?sim=<session.jsonl>&t=<ms>[&video=...]）：不连引擎，
 * 用会话 JSONL 驱动同一套 UI，用于离线演示与无头截图。
 */
import {
  buildSrt,
  decodePcmBase64,
  downloadTextFile,
  fetchSessionJsonl,
  formatClock,
  formatMs,
  parseSessionJsonl,
  stateAt,
} from './session-parse.mjs';

// ------------------------------------------------------------------ DOM 引用

const $ = (id) => document.getElementById(id);

const els = {
  connBadge: $('connBadge'),
  connText: $('connText'),
  hudAsr: $('hudAsr'),
  hudMt: $('hudMt'),
  hudTts: $('hudTts'),
  hudE2e: $('hudE2e'),
  btnReconnect: $('btnReconnect'),
  btnStart: $('btnStart'),
  btnStop: $('btnStop'),

  stage: $('stage'),
  stageEmpty: $('stageEmpty'),
  video: $('video'),
  videoLabel: $('videoLabel'),
  captureChip: $('captureChip'),
  stageClock: $('stageClock'),
  dragOverlay: $('dragOverlay'),
  subs: $('subs'),
  subsSrc: $('subsSrc'),
  subsDst: $('subsDst'),
  subsSmaller: $('subsSmaller'),
  subsBigger: $('subsBigger'),
  subsHide: $('subsHide'),

  btnPlay: $('btnPlay'),
  btnStopVideo: $('btnStopVideo'),
  timeCurrent: $('timeCurrent'),
  timeDuration: $('timeDuration'),
  seek: $('seek'),
  volume: $('volume'),
  levelBar: $('levelBar'),
  fileInput: $('fileInput'),
  urlInput: $('urlInput'),
  btnLoadUrl: $('btnLoadUrl'),
  emptyUrl: $('emptyUrl'),
  btnEmptyLoad: $('btnEmptyLoad'),
  toggleSubs: $('toggleSubs'),
  toggleDub: $('toggleDub'),
  toggleDuck: $('toggleDuck'),

  transcriptList: $('transcriptList'),
  transcriptCount: $('transcriptCount'),
  btnExportSrt: $('btnExportSrt'),

  sessionModeTag: $('sessionModeTag'),
  sessionState: $('sessionState'),
  sessionId: $('sessionId'),
  sessionLangs: $('sessionLangs'),
  audioStat: $('audioStat'),
  engineModeTag: $('engineModeTag'),
  pvAsr: $('pvAsr'),
  pvMt: $('pvMt'),
  pvTts: $('pvTts'),
  voiceId: $('voiceId'),
  voiceMode: $('voiceMode'),
  voiceNote: $('voiceNote'),
  latAsr: $('latAsr'),
  latMt: $('latMt'),
  latTts: $('latTts'),
  latE2e: $('latE2e'),
  barAsr: $('barAsr'),
  barMt: $('barMt'),
  barTts: $('barTts'),
  barE2e: $('barE2e'),
  glossaryInput: $('glossaryInput'),
  glossaryCount: $('glossaryCount'),
  glossaryHint: $('glossaryHint'),
  btnGlossary: $('btnGlossary'),
  btnGlossaryReset: $('btnGlossaryReset'),
  eventLog: $('eventLog'),
  btnClearLog: $('btnClearLog'),

  engineVersion: $('engineVersion'),
  whisperState: $('whisperState'),
  demoTag: $('demoTag'),
  toasts: $('toasts'),
};

// -------------------------------------------------------------------- 常量

const STORAGE_KEY = 'livedub.studio.v1';
const TARGET_SAMPLE_RATE = 16000;
const STATUS_META = {
  idle: { tone: 'idle', label: '空闲' },
  initializing: { tone: 'busy', label: '引擎初始化中…' },
  listening: { tone: 'ok', label: '聆听中' },
  translating: { tone: 'busy', label: '翻译中' },
  speaking: { tone: 'accent', label: '配音中' },
  paused: { tone: 'warn', label: '已暂停' },
  error: { tone: 'err', label: '错误' },
};
const LANG_LABELS = { en: '英语', zh: '中文', ja: '日语', ko: '韩语', fr: '法语', de: '德语', es: '西班牙语' };
const HUD_FIELDS = [
  { key: 'asrFinalMs', hud: 'hudAsr', lat: 'latAsr', bar: 'barAsr', warn: 600, bad: 1600 },
  { key: 'mtFirstMs', hud: 'hudMt', lat: 'latMt', bar: 'barMt', warn: 700, bad: 2000 },
  { key: 'ttsFirstMs', hud: 'hudTts', lat: 'latTts', bar: 'barTts', warn: 1200, bad: 3000 },
  { key: 'e2eLagMs', hud: 'hudE2e', lat: 'latE2e', bar: 'barE2e', warn: 1600, bad: 4000 },
];

// -------------------------------------------------------------------- 状态

const savedSettings = readSettings();

const state = {
  ws: null,
  wsReady: false,
  helloSent: false,
  sessionActive: false,
  sessionReady: false,
  reconnectAttempts: 0,
  reconnectTimer: null,
  maxEndMs: 0,

  config: null,
  engineInfo: null,
  providers: null,
  voice: { mode: 'preset', voiceId: '' },
  status: 'idle',
  metrics: null,

  media: { name: '', url: '', objectUrl: null, isFile: false },
  audioSeconds: 0,
  lastAudioStatAt: 0,
  lastSentTMs: -100,

  capture: { ctx: null, source: null, node: null, silentGain: null, dubGain: null, ready: false },
  sending: false,

  segments: new Map(),
  transcriptEls: new Map(),
  currentSegmentId: null,
  currentSubId: null,
  subtitleHideTimer: null,
  lastLevelAt: 0,

  dub: { active: new Set(), ducking: false, unduckTimer: null, seen: new Set() },

  sim: { active: false, parsed: null, clock: 0, raf: null, playedDubs: new Set(), frozen: false },

  settings: {
    subsVisible: savedSettings.subsVisible ?? true,
    fontSize: clamp(Number(savedSettings.fontSize) || 1, 0.7, 1.9),
    dubEnabled: savedSettings.dubEnabled ?? true,
    duckEnabled: savedSettings.duckEnabled ?? true,
    volume: Number.isFinite(Number(savedSettings.volume)) ? clamp(Number(savedSettings.volume), 0, 1) : 1,
    voiceMode: savedSettings.voiceMode ?? '',
    glossaryText: savedSettings.glossaryText ?? '',
    subsPos: savedSettings.subsPos ?? null,
  },
};

// ------------------------------------------------------------------ 小工具

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function readSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  } catch {
    /* localStorage 不可用时静默 */
  }
}

function shorten(text, max = 20) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function filenameFromUrl(url) {
  try {
    const parsed = new URL(url, location.href);
    const base = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '');
    return base || 'video';
  } catch {
    return String(url ?? 'video').split('/').pop() || 'video';
  }
}

function mediaTitle() {
  return state.media.name || 'livedub studio';
}

function toast(message, tone = 'info', timeout = 4200) {
  const node = document.createElement('div');
  node.className = `toast ${tone}`;
  node.textContent = String(message);
  els.toasts.appendChild(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 240);
  }, timeout);
}

function logEvent(type, message, tone = 'mt') {
  const empty = els.eventLog.querySelector('.log-empty');
  if (empty) empty.remove();
  const line = document.createElement('div');
  line.className = 'log-line';
  const stamp = new Date().toISOString().slice(11, 19);
  line.innerHTML = `<span class="lg-time">${stamp}</span><span class="lg-type ${tone}">${escapeHtml(String(type))}</span><span class="lg-msg">${escapeHtml(String(message))}</span>`;
  els.eventLog.appendChild(line);
  while (els.eventLog.children.length > 140) els.eventLog.firstElementChild.remove();
  els.eventLog.scrollTop = els.eventLog.scrollHeight;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function setBadge(tone, label) {
  els.connBadge.dataset.tone = tone;
  els.connText.textContent = label;
}

function setSessionState(text, tone = '') {
  els.sessionState.textContent = text;
  els.sessionState.style.color = tone === 'err' ? 'var(--err)' : tone === 'warn' ? 'var(--warn)' : '';
}

function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws`;
}

function sendJson(payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
  try {
    state.ws.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    logEvent('ws', `发送失败：${err.message}`, 'err');
    return false;
  }
}

// ------------------------------------------------------------------ HTTP 信息

async function loadEngineInfo() {
  try {
    const [healthRes, configRes] = await Promise.all([fetch('/health', { cache: 'no-store' }), fetch('/api/config', { cache: 'no-store' })]);
    if (healthRes.ok) {
      const health = await healthRes.json();
      state.engineInfo = health;
      els.engineVersion.textContent = `引擎 v${health.version ?? '?'} · ${modeLabel(health.mode)}`;
      els.whisperState.textContent = health.whisper?.found ? 'whisper 已就绪' : 'whisper 未找到';
      if (!health.whisper?.found) {
        toast('未找到 whisper 模型，实时识别不可用（可运行 npm run doctor 检查）', 'warn', 7000);
      }
      els.engineModeTag.textContent = modeLabel(health.mode);
      if (health.mode === 'demo') {
        els.engineModeTag.classList.add('warn');
        logEvent('engine', '当前为内置演示会话（pipeline 未接入），字幕为 mock 数据', 'warn');
      }
      renderProviders({
        asr: health.providers?.asr,
        translate: health.providers?.translate,
        tts: { provider: health.providers?.tts, model: health.providers?.ttsModel, voiceMode: health.providers?.voiceMode },
      });
      logEvent('engine', `健康检查通过：${health.url ?? ''}（mode=${health.mode}）`, 'ok');
    } else {
      logEvent('engine', `/health 返回 HTTP ${healthRes.status}`, 'err');
    }
    if (configRes.ok) {
      const payload = await configRes.json();
      state.config = payload.config ?? null;
      const config = state.config;
      if (config) {
        if (!state.settings.voiceMode) state.settings.voiceMode = config.tts?.voiceMode ?? 'clone-first';
        if (!state.settings.glossaryText && Array.isArray(config.glossary) && config.glossary.length > 0) {
          state.settings.glossaryText = config.glossary.map((term) => `${term.src}=${term.dst}`).join('\n');
        }
        updateSessionLangs(config.session?.langFrom ?? 'en', config.session?.langTo ?? 'zh');
        if (Array.isArray(config.glossary)) updateGlossaryCount();
      }
    }
  } catch (err) {
    logEvent('engine', `无法读取引擎信息：${err.message}`, 'err');
    els.engineVersion.textContent = '引擎未启动';
    toast('无法连接本地引擎服务，请确认已运行 node engine/server.mjs', 'err', 7000);
  }
  syncSettingsUi();
}

function modeLabel(mode) {
  if (mode === 'pipeline') return '真实会话';
  if (mode === 'demo') return '演示会话';
  if (mode === 'injected') return '测试会话';
  return `模式 ${mode ?? '?'}`;
}

function providerName(value) {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return String(value.provider ?? value.name ?? value.model ?? '—');
  return String(value);
}

function renderProviders(providers) {
  if (!providers) return;
  state.providers = providers;
  els.pvAsr.textContent = shorten(providerName(providers.asr), 18);
  els.pvMt.textContent = shorten(providerName(providers.translate), 18);
  const tts = providers.tts;
  const ttsName = providerName(tts);
  const ttsModel = tts && typeof tts === 'object' ? tts.model : '';
  els.pvTts.textContent = shorten(ttsModel ? `${ttsName} · ${ttsModel}` : ttsName, 18);
  els.pvAsr.title = String(providerName(providers.asr));
  els.pvMt.title = String(providerName(providers.translate));
  els.pvTts.title = String(ttsModel ? `${ttsName} · ${ttsModel}` : ttsName);
}

function updateSessionLangs(from = 'en', to = 'zh') {
  const fromLabel = LANG_LABELS[from] ?? from;
  const toLabel = LANG_LABELS[to] ?? to;
  els.sessionLangs.textContent = `${fromLabel} → ${toLabel}`;
}

// ------------------------------------------------------------------ WebSocket

function connect({ silent = false } = {}) {
  if (state.sim.active) return;
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  let socket;
  try {
    socket = new WebSocket(wsUrl());
  } catch (err) {
    setBadge('err', '连接失败');
    toast(`无法连接本地引擎：${err.message}`, 'err', 7000);
    return;
  }
  state.ws = socket;
  state.helloSent = false;
  if (!silent) setBadge('busy', '连接中…');
  setSessionState('连接中…');
  logEvent('ws', `连接 ${wsUrl()}`, 'mt');

  socket.addEventListener('open', () => {
    state.wsReady = true;
    state.reconnectAttempts = 0;
    logEvent('ws', 'WebSocket 已连接', 'ok');
    sendHello();
  });

  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    let parsed;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }
    if (parsed && typeof parsed === 'object') handleEngineEvent(parsed);
  });

  socket.addEventListener('error', () => {
    logEvent('ws', 'WebSocket 出错', 'err');
  });

  socket.addEventListener('close', (event) => {
    const wasActive = state.sessionActive;
    state.ws = null;
    state.wsReady = false;
    state.helloSent = false;
    state.sessionReady = false;
    state.sending = false;
    updateSessionButtons();
    els.captureChip.dataset.on = 'false';
    els.captureChip.lastElementChild.textContent = '音频未采集';
    if (wasActive) {
      setBadge('err', '连接断开');
      setSessionState('连接断开', 'err');
      logEvent('ws', `连接断开（code=${event.code}）`, 'err');
      if (!silent) toast('与本地引擎的连接断开，正在尝试重连…', 'err', 5000);
      scheduleReconnect();
    } else {
      setBadge('idle', '未连接');
      setSessionState('未开始');
      logEvent('ws', `连接已关闭（code=${event.code}）`, 'warn');
    }
  });
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  if (!state.sessionActive) return;
  if (state.reconnectAttempts >= 8) {
    state.sessionActive = false;
    state.sending = false;
    updateSessionButtons();
    setBadge('err', '重连失败');
    setSessionState('连接失败，请手动重连', 'err');
    toast('多次重连失败：请确认本地引擎仍在运行，然后点击「重连」', 'err', 8000);
    return;
  }
  const attempt = Math.min(8, (state.reconnectAttempts += 1));
  const delay = Math.min(8000, 400 * 2 ** (attempt - 1));
  state.reconnectTimer = setTimeout(() => {
    if (!state.sessionActive) return;
    logEvent('ws', `第 ${attempt} 次重连…`, 'warn');
    connect({ silent: true });
  }, delay);
}

function sendHello() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN || state.helloSent) return;
  state.helloSent = true;
  const terms = parseGlossaryText(els.glossaryInput.value);
  const overrides = {};
  if (state.settings.voiceMode) overrides.tts = { voiceMode: state.settings.voiceMode };
  const payload = {
    type: 'hello',
    protocol: 1,
    session: {
      source: 'studio',
      title: mediaTitle(),
      url: state.media.isFile ? '' : state.media.url,
      langFrom: 'en',
      langTo: 'zh',
      overrides,
    },
    glossary: terms,
  };
  sendJson(payload);
  logEvent('session', `发送 hello（术语表 ${terms.length} 条，音色 ${state.settings.voiceMode || '默认'}）`, 'mt');
  setBadge('busy', '引擎初始化中…');
  setSessionState('引擎初始化中…（首次约 20-30 秒）');
}

function disconnectSilently() {
  if (state.ws) {
    try {
      state.ws.close(1000, 'studio disconnect');
    } catch {
      /* ignore */
    }
  }
  state.ws = null;
  state.wsReady = false;
  state.helloSent = false;
}

// ------------------------------------------------------------- 引擎事件处理

function handleEngineEvent(event) {
  switch (event.type) {
    case 'ready':
      onReady(event);
      break;
    case 'status':
      onStatus(event);
      break;
    case 'partial':
      onPartial(event);
      break;
    case 'segment':
      onSegment(event);
      break;
    case 'translation':
      onTranslation(event);
      break;
    case 'dub':
      onDub(event);
      break;
    case 'voice':
      applyVoice(event);
      break;
    case 'metrics':
      onMetrics(event);
      break;
    case 'error':
      onEngineError(event);
      break;
    case 'bye':
      onBye(event);
      break;
    case 'pong':
      logEvent('ws', `pong t=${event.t ?? '?'}`, 'mt');
      break;
    default:
      logEvent(event.type ?? 'event', '收到未知事件', 'mt');
      break;
  }
}

function onReady(event) {
  state.sessionReady = true;
  state.providers = event.providers ?? null;
  if (state.providers) renderProviders(state.providers);
  if (event.voice) applyVoice(event.voice);
  els.sessionId.textContent = shorten(String(event.sessionId ?? '—'), 18);
  els.sessionId.title = String(event.sessionId ?? '');
  setSessionState('已就绪');
  setBadge('ok', '已连接');
  if (event.limits?.langFrom) updateSessionLangs(event.limits.langFrom, event.limits.langTo);
  logEvent('session', `会话就绪 ${event.sessionId ?? ''}`, 'ok');
  if (state.sessionActive) beginStreaming();
  else toast('引擎已就绪，点击「开始同传」即可开始', 'ok', 3000);
}

function onStatus(event) {
  const meta = STATUS_META[event.state] ?? { tone: 'ok', label: String(event.state ?? '未知') };
  state.status = event.state;
  setSessionState(meta.label, meta.tone);
  setBadge(meta.tone, meta.label);
  if (event.detail) logEvent('status', event.detail, meta.tone === 'err' ? 'err' : 'mt');
  else logEvent('status', meta.label, meta.tone === 'err' ? 'err' : 'mt');
}

function onPartial(event) {
  const text = String(event.text ?? '').trim();
  if (!text) return;
  state.currentSegmentId = null;
  state.currentSubId = `partial:${event.id}`;
  if (state.settings.subsVisible) renderCurrentSubtitle({ src: text, dst: '', translating: false });
}

function onSegment(event) {
  const id = String(event.id);
  const segment = state.segments.get(id) ?? { id, translation: '', translationFinal: false };
  segment.t0Ms = Math.max(0, Math.round(Number(event.t0Ms) || 0));
  segment.t1Ms = Math.max(0, Math.round(Number(event.t1Ms) || segment.t0Ms));
  segment.text = String(event.text ?? '');
  segment.lang = String(event.lang ?? 'en');
  state.segments.set(id, segment);
  state.currentSegmentId = id;
  state.currentSubId = id;
  state.maxEndMs = Math.max(state.maxEndMs, segment.t1Ms);
  upsertTranscript(segment);
  els.btnExportSrt.disabled = state.segments.size === 0;
  if (state.settings.subsVisible) {
    renderCurrentSubtitle({ src: segment.text, dst: segment.translation, translating: true });
  }
}

function onTranslation(event) {
  const id = String(event.id);
  let segment = state.segments.get(id);
  if (!segment) {
    segment = { id, t0Ms: 0, t1Ms: 0, text: '', lang: 'en', translation: '', translationFinal: false };
    state.segments.set(id, segment);
  }
  segment.translation = String(event.text ?? '');
  segment.translationFinal = Boolean(event.final);
  upsertTranscript(segment);
  if (state.currentSegmentId === id && state.settings.subsVisible) {
    renderCurrentSubtitle({ src: segment.text, dst: segment.translation, translating: !event.final });
    if (event.final) scheduleSubtitleHide(6500);
  }
  if (event.final) logEvent('translation', `${segment.text.slice(0, 24)} → ${String(event.text ?? '').slice(0, 26)}`, 'ok');
}

function onMetrics(event) {
  state.metrics = event;
  updateMetricsHud(event);
  logEvent(
    'metrics',
    `ASR ${formatMs(event.asrFinalMs)} · MT ${formatMs(event.mtFirstMs)} · TTS ${formatMs(event.ttsFirstMs)} · E2E ${formatMs(event.e2eLagMs)}`,
    'mt',
  );
}

function onEngineError(event) {
  const scope = event.scope ?? 'server';
  const message = String(event.message ?? '未知错误');
  logEvent('error', `[${scope}] ${message}`, 'err');
  toast(message, event.recoverable === false ? 'err' : 'warn', 6500);
  if (event.recoverable === false) {
    setBadge('err', '错误');
    setSessionState('错误', 'err');
  }
}

function onBye(event) {
  logEvent('session', `会话结束：${event.reason ?? ''}`, 'warn');
  state.sessionReady = false;
  state.sending = false;
  state.sessionActive = false;
  updateSessionButtons();
  setBadge('idle', '会话结束');
  setSessionState('会话结束');
  els.captureChip.dataset.on = 'false';
  els.captureChip.lastElementChild.textContent = '音频未采集';
  hideSubtitle();
  setTimeout(() => disconnectSilently(), 120);
}

// ---------------------------------------------------------------- 会话控制

async function startSession() {
  if (state.sim.active) return;
  if (state.sessionActive) return;
  if (!els.video.src) {
    toast('请先打开本地视频或输入视频链接，再开始同传', 'warn');
    els.stageEmpty.style.outline = '1px dashed rgba(94,234,212,.4)';
    setTimeout(() => (els.stageEmpty.style.outline = ''), 1200);
    return;
  }
  state.sessionActive = true;
  state.maxEndMs = 0;
  updateSessionButtons();
  setSessionState('准备采集音频…');
  setBadge('busy', '启动中…');
  logEvent('session', '开始同传', 'ok');

  try {
    await ensureCapture();
    if (state.capture.ctx?.state === 'suspended') await state.capture.ctx.resume();
  } catch (err) {
    logEvent('capture', `音频采集初始化失败：${err.message}`, 'err');
    toast(`无法启动音频采集：${err.message}`, 'err', 7000);
    state.sessionActive = false;
    updateSessionButtons();
    setSessionState('未开始');
    setBadge('idle', '未连接');
    return;
  }

  if (state.sessionReady && state.wsReady) {
    beginStreaming();
    return;
  }
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) connect();
  else if (!state.helloSent) sendHello();
  toast('正在连接本地引擎并初始化会话（首次 whisper 冷启动约 20-30 秒）…', 'info', 6000);
}

function beginStreaming() {
  state.sending = true;
  state.audioSeconds = 0;
  state.lastSentTMs = -100;
  state.maxEndMs = 0;
  els.captureChip.dataset.on = 'true';
  els.captureChip.lastElementChild.textContent = '采集中 16 kHz';
  els.sessionModeTag.textContent = '同传中';
  els.sessionModeTag.classList.add('accent');
  updateSessionButtons();
  logEvent('session', '开始发送 16kHz 音频帧', 'ok');
  if (els.video.paused) {
    els.video.play().catch((err) => {
      logEvent('player', `自动播放被拦截：${err.message}`, 'warn');
      toast('浏览器拦截了自动播放，请手动点击播放按钮', 'warn', 6000);
    });
  }
}

function stopSession({ silent = false } = {}) {
  if (!state.sessionActive) return;
  state.sessionActive = false;
  state.sessionReady = false;
  state.sending = false;
  state.lastSentTMs = -100;
  els.captureChip.dataset.on = 'false';
  els.captureChip.lastElementChild.textContent = '音频未采集';
  els.sessionModeTag.textContent = '已停止';
  els.sessionModeTag.classList.remove('accent');
  try {
    els.video.pause();
  } catch {
    /* ignore */
  }
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    sendJson({ type: 'control', action: 'stop' });
    setTimeout(() => disconnectSilently(), 220);
  }
  updateSessionButtons();
  setBadge('idle', '已停止');
  setSessionState('已停止');
  hideSubtitle();
  if (!silent) toast('已停止同传会话', 'info');
  logEvent('session', '停止同传', 'warn');
}

function reconnect() {
  if (state.sim.active) return;
  logEvent('ws', '手动重连', 'mt');
  disconnectSilently();
  state.helloSent = false;
  setBadge('busy', '连接中…');
  connect();
}

function updateSessionButtons() {
  const active = state.sessionActive;
  els.btnStart.disabled = active || state.sim.active;
  els.btnStop.disabled = !active || state.sim.active;
  els.btnReconnect.disabled = state.sim.active;
  els.btnStart.classList.toggle('is-active', active);
}

// ---------------------------------------------------------------- 媒体加载

function resetMediaState() {
  state.segments.clear();
  state.transcriptEls.clear();
  els.transcriptList.innerHTML = '<div class="list-empty">开始播放视频并开启同传后，识别出的句子会出现在这里。</div>';
  els.transcriptCount.textContent = '0 句';
  els.btnExportSrt.disabled = true;
  state.currentSegmentId = null;
  state.currentSubId = null;
  state.audioSeconds = 0;
  state.maxEndMs = 0;
  els.audioStat.textContent = '0.0s';
  hideSubtitle();
  clearTranscriptActive();
}

function setMedia(src, label, { isFile = false, objectUrl = null } = {}) {
  if (state.media.objectUrl) {
    try {
      URL.revokeObjectURL(state.media.objectUrl);
    } catch {
      /* ignore */
    }
  }
  state.media = { name: label || filenameFromUrl(src), url: src, objectUrl, isFile };
  els.stage.classList.add('has-media');
  els.stage.classList.remove('sim-stage');
  els.videoLabel.lastElementChild.textContent = shorten(state.media.name, 40);
  els.videoLabel.title = state.media.name;
  els.video.muted = false;
  els.video.volume = state.settings.volume;
  els.video.src = src;
  els.video.load();
  els.btnPlay.disabled = false;
  els.btnStopVideo.disabled = false;
  els.seek.disabled = false;
  els.urlInput.value = isFile ? '' : src;
  els.emptyUrl.value = isFile ? '' : src;
  resetMediaState();
  updatePlayButton();
  logEvent('player', `载入媒体：${state.media.name}`, 'ok');
  toast(`已载入：${state.media.name}`, 'ok');
  if (state.sessionActive) toast('媒体已切换，建议停止后重新开始同传', 'warn', 5000);
}

function loadMediaFromFile(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  setMedia(url, file.name, { isFile: true, objectUrl: url });
}

function loadVideoUrl(url) {
  const value = String(url ?? '').trim();
  if (!value) {
    toast('请输入视频 / 音频 URL', 'warn');
    return;
  }
  try {
    // 允许 http(s)/同源相对路径；其它协议直接拒绝
    const parsed = new URL(value, location.href);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只支持 http(s) 地址');
    if (parsed.origin !== location.origin && !/^https?:$/.test(parsed.protocol)) throw new Error('协议不受支持');
    setMedia(parsed.href, filenameFromUrl(parsed.href), { isFile: false });
  } catch (err) {
    toast(`URL 无效：${err.message}`, 'err');
  }
}

// ---------------------------------------------------------------- 播放器 UI

function updatePlayButton() {
  const icon = els.btnPlay.querySelector('use');
  const paused = els.video.paused;
  icon.setAttribute('href', paused ? '#i-play' : '#i-pause');
  els.btnPlay.title = paused ? '播放' : '暂停';
}

function updateTimeUi() {
  const current = els.video.currentTime || 0;
  const duration = Number.isFinite(els.video.duration) ? els.video.duration : 0;
  els.timeCurrent.textContent = formatClock(current * 1000);
  els.timeDuration.textContent = duration > 0 ? formatClock(duration * 1000) : '--:--';
  els.stageClock.textContent = `${formatClock(current * 1000)} / ${duration > 0 ? formatClock(duration * 1000) : '--:--'}`;
  if (duration > 0) {
    const progress = clamp((current / duration) * 100, 0, 100);
    els.seek.style.setProperty('--seek-progress', `${progress}%`);
    els.seek.value = String(Math.round(progress * 10));
    els.seek.max = '1000';
  }
  state.maxEndMs = Math.max(state.maxEndMs, Math.round(current * 1000));
}

function videoPlayPause() {
  if (!els.video.src) return;
  if (els.video.paused) {
    els.video.play().catch((err) => toast(`播放失败：${err.message}`, 'err'));
  } else {
    els.video.pause();
  }
}

function stopVideo() {
  els.video.pause();
  els.video.currentTime = 0;
  hideSubtitle();
  clearTranscriptActive();
}

// ---------------------------------------------------------------- 音频采集

function getAudioContext() {
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) throw new Error('当前浏览器不支持 Web Audio');
  if (!state.capture.ctx) {
    state.capture.ctx = new Context({ latencyHint: 'interactive' });
    state.capture.dubGain = state.capture.ctx.createGain();
    state.capture.dubGain.gain.value = 1;
    state.capture.dubGain.connect(state.capture.ctx.destination);
  }
  return state.capture.ctx;
}

async function ensureCapture() {
  if (state.capture.ready) return;
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  if (!state.capture.source) {
    state.capture.source = ctx.createMediaElementSource(els.video);
    state.capture.source.connect(ctx.destination);
  }
  await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
  const node = new AudioWorkletNode(ctx, 'livedub-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { inputSampleRate: ctx.sampleRate, targetSampleRate: TARGET_SAMPLE_RATE, frameMs: 100 },
  });
  // AudioWorkletNode 需要接到 destination 才会被持续驱动；用静音 gain 避免重复输出声音
  const silentGain = ctx.createGain();
  silentGain.gain.value = 0;
  state.capture.source.connect(node);
  node.connect(silentGain);
  silentGain.connect(ctx.destination);
  state.capture.node = node;
  state.capture.silentGain = silentGain;
  state.capture.ready = true;
  node.port.onmessage = (event) => handleCapturedFrame(event.data);
  node.port.start?.();
  logEvent('capture', `音频采集就绪（采样率 ${ctx.sampleRate}Hz → 16kHz）`, 'ok');
}

function handleCapturedFrame(data) {
  if (!data || data.type !== 'pcm') return;
  if (typeof data.level === 'number') updateLevelMeter(data.level);
  if (!state.sending || !state.sessionReady || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  const bytes = new Uint8Array(data.pcm);
  if (bytes.byteLength < 2) return;
  const frame = new ArrayBuffer(9 + bytes.byteLength);
  const view = new DataView(frame);
  view.setUint8(0, 0x01);
  // 正常播放时 tMs 跟随 video.currentTime；媒体卡住/加载失败时用上一帧 +100ms 兜底，
  // 避免整段音频都挤在同一个时间点把 VAD/字幕时间轴卡死。
  const rawTMs = Math.max(0, Math.round((els.video.currentTime || 0) * 1000) - 100);
  const tMs = Math.max(rawTMs, (state.lastSentTMs ?? -100) + 100);
  state.lastSentTMs = tMs;
  view.setFloat64(1, tMs);
  new Uint8Array(frame, 9).set(bytes);
  try {
    state.ws.send(frame);
  } catch (err) {
    logEvent('capture', `发送音频帧失败：${err.message}`, 'err');
    return;
  }
  state.audioSeconds += bytes.byteLength / 2 / TARGET_SAMPLE_RATE;
  const now = performance.now();
  if (now - state.lastAudioStatAt > 200) {
    state.lastAudioStatAt = now;
    els.audioStat.textContent = `${state.audioSeconds.toFixed(1)}s`;
  }
}

function updateLevelMeter(level) {
  const width = clamp(Math.sqrt(level) * 220, 0, 100);
  els.levelBar.style.width = `${width.toFixed(0)}%`;
}

// ------------------------------------------------------------------ 配音播放

function applyVolume() {
  if (!state.dub.ducking) els.video.volume = state.settings.volume;
}

function duckOriginal(active) {
  if (!state.settings.duckEnabled || !els.video.src) return;
  if (active) {
    if (!state.dub.ducking) {
      state.dub.ducking = true;
      els.video.volume = Math.min(state.settings.volume, 0.18);
    }
    clearTimeout(state.dub.unduckTimer);
  } else {
    clearTimeout(state.dub.unduckTimer);
    state.dub.unduckTimer = setTimeout(() => {
      state.dub.ducking = false;
      applyVolume();
    }, 220);
  }
}

function onDub(event) {
  if (!event.pcm) return; // 空 pcm = 引擎的收尾标记
  if (!state.settings.dubEnabled) return;
  const key = `${event.id}:${event.seq}`;
  if (state.dub.seen.has(key)) return;
  state.dub.seen.add(key);
  if (state.dub.seen.size > 2000) state.dub.seen.clear();
  playDubEvent(event, { nowMs: Math.round((els.video.currentTime || 0) * 1000) });
}

function playDubEvent(event, { nowMs }) {
  let pcm;
  try {
    pcm = decodePcmBase64(String(event.pcm ?? ''));
  } catch (err) {
    logEvent('dub', `配音解码失败：${err.message}`, 'err');
    return;
  }
  if (!pcm.length) return;
  let ctx;
  try {
    ctx = getAudioContext();
  } catch (err) {
    logEvent('dub', err.message, 'err');
    return;
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const sampleRate = Number(event.sampleRate) || 24000;
  const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 32768;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(state.capture.dubGain);
  const delaySec = Math.max(0, (Number(event.startMs) - nowMs) / 1000);
  const when = ctx.currentTime + Math.min(delaySec, 30) + 0.02;
  try {
    source.start(when);
  } catch (err) {
    logEvent('dub', `配音调度失败：${err.message}`, 'err');
    return;
  }
  state.dub.active.add(source);
  duckOriginal(true);
  source.onended = () => {
    state.dub.active.delete(source);
    if (state.dub.active.size === 0) duckOriginal(false);
  };
  logEvent('dub', `播放配音 #${event.seq ?? '?'}（startMs=${event.startMs ?? '?'}，${formatMs(event.durationMs)}）`, 'ok');
}

// -------------------------------------------------------------------- 字幕

function renderCurrentSubtitle({ src, dst, translating }) {
  if (!state.settings.subsVisible) return;
  const sourceText = String(src ?? '').trim();
  const destText = String(dst ?? '').trim();
  if (!sourceText && !destText) {
    hideSubtitle();
    return;
  }
  els.subs.hidden = false;
  els.subsSrc.textContent = sourceText;
  els.subsDst.textContent = destText || (translating ? '…' : '');
  els.subsDst.classList.toggle('pending', !destText && Boolean(translating));
  scheduleSubtitleHide(0);
}

function scheduleSubtitleHide(ms) {
  clearTimeout(state.subtitleHideTimer);
  if (ms <= 0) return;
  state.subtitleHideTimer = setTimeout(() => hideSubtitle(), ms);
}

function hideSubtitle() {
  clearTimeout(state.subtitleHideTimer);
  els.subs.hidden = true;
  els.subsSrc.textContent = '';
  els.subsDst.textContent = '';
  els.subsDst.classList.remove('pending');
}

function setSubsVisible(visible) {
  state.settings.subsVisible = Boolean(visible);
  els.toggleSubs.checked = state.settings.subsVisible;
  saveSettings();
  if (!visible) hideSubtitle();
}

function adjustSubtitleFont(delta) {
  state.settings.fontSize = clamp(Math.round((state.settings.fontSize + delta) * 10) / 10, 0.7, 1.9);
  applySubtitleSettings();
  saveSettings();
  toast(`字幕字号 ${Math.round(state.settings.fontSize * 100)}%`, 'info', 1600);
}

function applySubtitleSettings() {
  document.documentElement.style.setProperty('--subs-scale', String(state.settings.fontSize));
  els.subs.style.setProperty('--subs-scale', String(state.settings.fontSize));
  if (state.settings.subsPos) {
    els.subs.style.left = state.settings.subsPos.left;
    els.subs.style.top = state.settings.subsPos.top;
    els.subs.style.transform = 'none';
  }
}

function setupSubtitleDrag() {
  let drag = null;
  els.subs.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    if (!state.settings.subsVisible) return;
    const stageRect = els.stage.getBoundingClientRect();
    const rect = els.subs.getBoundingClientRect();
    if (!state.settings.subsPos) {
      els.subs.style.left = `${Math.round(rect.left - stageRect.left)}px`;
      els.subs.style.top = `${Math.round(rect.top - stageRect.top)}px`;
      els.subs.style.transform = 'none';
    }
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: parseFloat(els.subs.style.left) || 0,
      originTop: parseFloat(els.subs.style.top) || 0,
    };
    els.subs.classList.add('dragging');
    try {
      els.subs.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    event.preventDefault();
  });
  els.subs.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const stageRect = els.stage.getBoundingClientRect();
    const maxLeft = Math.max(0, stageRect.width - els.subs.offsetWidth);
    const maxTop = Math.max(0, stageRect.height - els.subs.offsetHeight);
    const left = clamp(drag.originLeft + (event.clientX - drag.startX), 0, maxLeft);
    const top = clamp(drag.originTop + (event.clientY - drag.startY), 0, maxTop);
    els.subs.style.left = `${left}px`;
    els.subs.style.top = `${top}px`;
  });
  const finish = () => {
    if (!drag) return;
    drag = null;
    els.subs.classList.remove('dragging');
    state.settings.subsPos = { left: els.subs.style.left, top: els.subs.style.top };
    saveSettings();
  };
  els.subs.addEventListener('pointerup', finish);
  els.subs.addEventListener('pointercancel', finish);
  els.subs.addEventListener('dblclick', () => {
    state.settings.subsPos = null;
    saveSettings();
    els.subs.style.left = '';
    els.subs.style.top = '';
    els.subs.style.transform = '';
    toast('字幕位置已重置', 'info', 1600);
  });
}

// ---------------------------------------------------------------- 字幕列表

function upsertTranscript(segment) {
  let node = state.transcriptEls.get(segment.id);
  if (!node) {
    const empty = els.transcriptList.querySelector('.list-empty');
    if (empty) empty.remove();
    node = document.createElement('article');
    node.className = 'transcript-item';
    node.dataset.id = segment.id;
    node.innerHTML = '<span class="t-time"></span><div class="t-body"><div class="t-src"></div><div class="t-dst"></div></div>';
    node.addEventListener('click', () => {
      const target = state.segments.get(segment.id);
      if (!target) return;
      if (els.video.src && Number.isFinite(els.video.duration) && els.video.duration > 0) {
        els.video.currentTime = clamp(target.t0Ms / 1000, 0, els.video.duration);
        if (state.sessionActive && state.sessionReady) sendJson({ type: 'control', action: 'seek', tMs: target.t0Ms });
      }
      setActiveTranscript(segment.id);
    });
    els.transcriptList.appendChild(node);
    state.transcriptEls.set(segment.id, node);
  }
  node.querySelector('.t-time').textContent = formatClock(segment.t0Ms);
  node.querySelector('.t-src').textContent = segment.text || '…';
  const dstNode = node.querySelector('.t-dst');
  if (segment.translation) {
    dstNode.textContent = segment.translation;
    dstNode.classList.remove('pending');
  } else {
    dstNode.textContent = '翻译中…';
    dstNode.classList.add('pending');
  }
  els.transcriptCount.textContent = `${state.segments.size} 句`;
  updateTranscriptAutoScroll();
}

function updateTranscriptAutoScroll() {
  const list = els.transcriptList;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

function setActiveTranscript(id) {
  for (const [key, node] of state.transcriptEls) node.classList.toggle('active', key === id);
}

function clearTranscriptActive() {
  for (const node of state.transcriptEls.values()) node.classList.remove('active');
}

function renderTranscriptsFrozen(segments, activeId) {
  els.transcriptList.innerHTML = '';
  state.transcriptEls.clear();
  if (!segments.length) {
    els.transcriptList.innerHTML = '<div class="list-empty">这段回放还没有识别出句子</div>';
    els.transcriptCount.textContent = '0 句';
    return;
  }
  for (const segment of segments) {
    upsertTranscript(segment);
  }
  els.transcriptCount.textContent = `${segments.length} 句`;
  if (activeId) setActiveTranscript(activeId);
  else clearTranscriptActive();
  els.transcriptList.scrollTop = els.transcriptList.scrollHeight;
}

// ------------------------------------------------------------------ SRT 导出

function exportSrt() {
  const srt = buildSrt(state.segments.values());
  if (!srt) {
    toast('还没有可导出的字幕', 'warn');
    return;
  }
  const base = mediaTitle().replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_') || 'livedub';
  const stamp = new Date().toISOString().slice(0, 10);
  downloadTextFile(`${base}-${stamp}.srt`, srt, 'application/x-subrip;charset=utf-8');
  logEvent('srt', `导出 ${state.segments.size} 句字幕`, 'ok');
  toast('SRT 已导出（双语）', 'ok');
}

// ------------------------------------------------------------------ 延迟 HUD

function latencyTone(value, warn, bad) {
  if (!Number.isFinite(Number(value))) return '';
  const num = Number(value);
  if (num >= bad) return 'bad';
  if (num >= warn) return 'mid';
  return 'good';
}

function updateMetricsHud(metrics) {
  for (const field of HUD_FIELDS) {
    const value = metrics?.[field.key];
    const text = formatMs(value);
    const tone = latencyTone(value, field.warn, field.bad);
    const hudNode = els[field.hud];
    hudNode.textContent = text;
    hudNode.className = tone;
    const latNode = els[field.lat];
    latNode.textContent = text;
    latNode.className = `mono ${tone}`.trim();
    const bar = els[field.bar];
    if (Number.isFinite(Number(value))) {
      bar.style.width = `${clamp((Number(value) / (field.bad * 1.2)) * 100, 3, 100).toFixed(1)}%`;
      bar.className = tone === 'bad' ? 'bad' : tone === 'mid' ? 'mid' : '';
    }
  }
}

function resetMetricsHud() {
  for (const field of HUD_FIELDS) {
    els[field.hud].textContent = '—';
    els[field.hud].className = '';
    els[field.lat].textContent = '—';
    els[field.lat].className = 'mono';
    els[field.bar].style.width = '0%';
    els[field.bar].className = '';
  }
}

// ------------------------------------------------------------------ 音色模式

function applyVoice(info) {
  if (!info) return;
  state.voice = { mode: info.mode ?? 'preset', voiceId: info.voiceId ?? '' };
  els.voiceId.textContent = state.voice.voiceId || '—';
  els.voiceId.title = state.voice.voiceId || '';
  const mode = state.voice.mode === 'clone' ? 'clone-first' : 'preset';
  setVoiceModeButtons(mode);
  if (info.degraded && info.reason) {
    els.voiceNote.textContent = `已降级：${info.reason}`;
  } else if (state.voice.mode === 'clone') {
    els.voiceNote.textContent = '已使用克隆音色';
  } else {
    els.voiceNote.textContent = '';
  }
  logEvent('voice', `音色 ${state.voice.mode} / ${state.voice.voiceId}${info.degraded ? '（降级）' : ''}`, 'ok');
}

function setVoiceModeButtons(mode) {
  for (const button of els.voiceMode.querySelectorAll('button')) {
    button.dataset.active = String(button.dataset.mode === mode);
  }
}

function setVoiceMode(mode) {
  const next = mode === 'preset' ? 'preset' : 'clone-first';
  state.settings.voiceMode = next;
  saveSettings();
  setVoiceModeButtons(next);
  els.voiceNote.textContent = next === 'clone-first' ? '克隆优先：会先尝试克隆讲师音色，失败自动降级并记住原因' : '预设音色：使用配置里的系统音色';
  if (state.wsReady) {
    sendJson({ type: 'config', patch: { tts: { voiceMode: next } } });
    logEvent('voice', `切换音色模式：${next}（已通知引擎）`, 'mt');
    toast(`音色模式：${next === 'clone-first' ? '克隆优先' : '预设音色'}`, 'info');
  } else {
    toast(`音色模式：${next === 'clone-first' ? '克隆优先' : '预设音色'}（下次会话建立时生效）`, 'info');
  }
}

// -------------------------------------------------------------------- 术语表

function parseGlossaryText(text) {
  const terms = [];
  for (const line of String(text ?? '').split('\n')) {
    const row = line.trim();
    if (!row || row.startsWith('#')) continue;
    const index = row.indexOf('=');
    if (index <= 0) continue;
    const src = row.slice(0, index).trim();
    const dst = row.slice(index + 1).trim();
    if (src && dst) terms.push({ src, dst });
  }
  return terms;
}

function updateGlossaryCount() {
  const terms = parseGlossaryText(els.glossaryInput.value);
  els.glossaryCount.textContent = `${terms.length} 条`;
  return terms;
}

function applyGlossary({ announce = true } = {}) {
  const terms = updateGlossaryCount();
  state.settings.glossaryText = els.glossaryInput.value;
  saveSettings();
  if (state.wsReady) {
    sendJson({ type: 'glossary', terms });
    logEvent('glossary', `发送 ${terms.length} 条术语`, 'ok');
    if (announce) toast(`术语表已更新（${terms.length} 条）`, 'ok');
  } else if (announce) {
    toast(`术语表已保存（${terms.length} 条），会话建立时会自动发送`, 'info');
  }
}

function resetGlossary() {
  const glossary = state.config?.glossary;
  if (!Array.isArray(glossary) || glossary.length === 0) {
    toast('配置里没有默认术语表', 'warn');
    return;
  }
  els.glossaryInput.value = glossary.map((term) => `${term.src}=${term.dst}`).join('\n');
  updateGlossaryCount();
  applyGlossary({ announce: false });
  toast('已恢复默认术语表', 'ok');
}

// --------------------------------------------------------------- 设置同步

function syncSettingsUi() {
  els.toggleSubs.checked = state.settings.subsVisible;
  els.toggleDub.checked = state.settings.dubEnabled;
  els.toggleDuck.checked = state.settings.duckEnabled;
  els.volume.value = String(Math.round(state.settings.volume * 100));
  els.video.volume = state.settings.volume;
  els.glossaryInput.value = state.settings.glossaryText || '';
  updateGlossaryCount();
  applySubtitleSettings();
  if (state.settings.voiceMode) setVoiceModeButtons(state.settings.voiceMode);
  if (!state.settings.subsVisible) hideSubtitle();
}

// -------------------------------------------------------------- 演示回放模式

function demoBadge(show) {
  els.demoTag.hidden = !show;
}

async function setupSimMode(params) {
  const sessionUrl = params.get('sim');
  if (!sessionUrl) return false;
  state.sim.active = true;
  demoBadge(true);
  state.sessionActive = false;
  updateSessionButtons();
  setBadge('accent', '演示回放');
  setSessionState('演示回放');
  els.sessionModeTag.textContent = '回放';
  els.sessionModeTag.classList.add('accent');
  els.stage.classList.add('sim-stage');
  els.btnReconnect.disabled = true;
  els.engineVersion.textContent = '离线回放（未连接引擎）';
  els.whisperState.textContent = '演示数据';
  logEvent('demo', '进入演示回放模式（不连接引擎）', 'ok');

  const videoUrl = params.get('video');
  if (videoUrl) {
    try {
      els.video.muted = true;
      els.video.volume = 0;
      setMedia(videoUrl, filenameFromUrl(videoUrl), { isFile: false });
      els.stage.classList.add('has-media');
      els.stage.classList.remove('sim-stage');
    } catch (err) {
      logEvent('demo', `视频载入失败：${err.message}`, 'warn');
    }
  }

  try {
    const text = await fetchSessionJsonl(sessionUrl);
    const parsed = parseSessionJsonl(text);
    state.sim.parsed = parsed;
    state.sim.playedDubs.clear();
    applyParsedSession(parsed);
    const tParam = Number(params.get('t'));
    const autoplay = params.get('autoplay') === '1';
    if (Number.isFinite(tParam) && !autoplay) {
      state.sim.frozen = true;
      state.sim.clock = tParam;
      applySimAt(tParam);
    } else {
      startSimPlayback(Number.isFinite(tParam) ? tParam : 0);
    }
    logEvent('demo', `载入回放 ${parsed.events.length} 个事件、${parsed.segments.size} 句字幕`, 'ok');
    toast(`演示回放：${parsed.meta?.title ?? sessionUrl}`, 'info', 5000);
  } catch (err) {
    logEvent('demo', `加载回放失败：${err.message}`, 'err');
    toast(`加载回放失败：${err.message}`, 'err', 7000);
    els.transcriptList.innerHTML = `<div class="list-empty">${escapeHtml(err.message)}</div>`;
  }
  return true;
}

function applyParsedSession(parsed) {
  const ready = parsed.ready;
  if (ready) {
    renderProviders(ready.providers);
    if (ready.voice) applyVoice(ready.voice);
    els.sessionId.textContent = shorten(String(ready.sessionId ?? 'demo'), 18);
    if (ready.limits?.langFrom) updateSessionLangs(ready.limits.langFrom, ready.limits.langTo);
  } else {
    els.pvAsr.textContent = '回放';
    els.pvMt.textContent = '回放';
    els.pvTts.textContent = '回放';
  }
  const meta = parsed.meta ?? {};
  if (Array.isArray(meta.glossary) && meta.glossary.length > 0) {
    state.settings.glossaryText = meta.glossary.map((term) => `${term.src}=${term.dst}`).join('\n');
    els.glossaryInput.value = state.settings.glossaryText;
    updateGlossaryCount();
  }
  if (meta.title) els.videoLabel.lastElementChild.textContent = shorten(String(meta.title), 40);
  if (meta.langFrom) updateSessionLangs(meta.langFrom, meta.langTo ?? 'zh');
  let end = Number(meta.durationMs) || 0;
  for (const segment of parsed.segments.values()) end = Math.max(end, segment.t1Ms);
  for (const dub of parsed.dubs) end = Math.max(end, dub.startMs + (dub.durationMs || 0));
  state.sim.maxMs = end;
  els.transcriptCount.textContent = '0 句';
}

function applySimAt(tMs) {
  const parsed = state.sim.parsed;
  if (!parsed) return;
  const snapshot = stateAt(parsed, tMs);
  state.status = snapshot.status?.state ?? 'listening';
  if (snapshot.current && snapshot.current.src) {
    renderCurrentSubtitle({
      src: snapshot.current.src,
      dst: snapshot.current.dst,
      translating: snapshot.current.translating,
    });
  } else {
    hideSubtitle();
  }
  renderTranscriptsFrozen(snapshot.segmentsSoFar, snapshot.current?.id && !snapshot.current.partial ? snapshot.current.id : null);
  if (snapshot.metrics) updateMetricsHud(snapshot.metrics);
  if (snapshot.voice) applyVoice(snapshot.voice);
  if (snapshot.status) {
    const meta = STATUS_META[snapshot.status.state] ?? { label: snapshot.status.state };
    setSessionState(`回放 · ${meta.label}`);
  }
  const durationSec = Number.isFinite(els.video.duration) && els.video.duration > 0 ? els.video.duration : state.sim.maxMs / 1000;
  els.stageClock.textContent = `${formatClock(tMs)} / ${formatClock(durationSec * 1000)}`;
  els.timeCurrent.textContent = formatClock(tMs);
  els.timeDuration.textContent = formatClock(durationSec * 1000);
}

function startSimPlayback(startMs) {
  state.sim.frozen = false;
  updateSessionButtons();
  const startedAt = performance.now();
  const tick = () => {
    if (!state.sim.active) return;
    let t = startMs + (performance.now() - startedAt);
    if (els.video.src && !els.video.paused && Number.isFinite(els.video.duration) && els.video.duration > 0) {
      t = els.video.currentTime * 1000;
    }
    state.sim.clock = t;
    applySimAt(t);
    playSimDubsUpTo(t);
    if (t < state.sim.maxMs) {
      state.sim.raf = requestAnimationFrame(tick);
    } else {
      state.sim.raf = null;
      setBadge('idle', '回放结束');
    }
  };
  state.sim.raf = requestAnimationFrame(tick);
}

function playSimDubsUpTo(tMs) {
  if (!state.settings.dubEnabled) return;
  for (const dub of state.sim.parsed?.dubs ?? []) {
    if (state.sim.playedDubs.has(`${dub.id}:${dub.seq}`)) continue;
    if (dub.startMs > tMs) continue;
    if (tMs - dub.startMs > 2500) {
      state.sim.playedDubs.add(`${dub.id}:${dub.seq}`);
      continue;
    }
    state.sim.playedDubs.add(`${dub.id}:${dub.seq}`);
    playDubEvent(dub, { nowMs: tMs });
  }
}

// ---------------------------------------------------------------- 事件绑定

function bindEvents() {
  // 顶栏
  els.btnStart.addEventListener('click', () => void startSession());
  els.btnStop.addEventListener('click', () => stopSession());
  els.btnReconnect.addEventListener('click', reconnect);

  // 媒体
  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files?.[0];
    if (file) loadMediaFromFile(file);
    els.fileInput.value = '';
  });
  els.btnLoadUrl.addEventListener('click', () => loadVideoUrl(els.urlInput.value));
  els.urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') loadVideoUrl(els.urlInput.value);
  });
  els.btnEmptyLoad.addEventListener('click', () => loadVideoUrl(els.emptyUrl.value));
  els.emptyUrl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') loadVideoUrl(els.emptyUrl.value);
  });
  // 拖拽打开
  let dragDepth = 0;
  els.stage.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    els.stage.classList.add('drag-over');
  });
  els.stage.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  els.stage.addEventListener('dragleave', (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) els.stage.classList.remove('drag-over');
  });
  els.stage.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    els.stage.classList.remove('drag-over');
    const file = event.dataTransfer?.files?.[0];
    if (file) loadMediaFromFile(file);
    else {
      const url = event.dataTransfer?.getData('text/uri-list') || event.dataTransfer?.getData('text/plain');
      if (url) loadVideoUrl(url.split('\n')[0]);
    }
  });

  // 播放器
  els.btnPlay.addEventListener('click', videoPlayPause);
  els.btnStopVideo.addEventListener('click', stopVideo);
  els.seek.addEventListener('input', () => {
    const duration = Number.isFinite(els.video.duration) ? els.video.duration : 0;
    if (duration <= 0) return;
    const target = (Number(els.seek.value) / 1000) * duration;
    els.timeCurrent.textContent = formatClock(target * 1000);
    els.seek.style.setProperty('--seek-progress', `${Number(els.seek.value) / 10}%`);
  });
  els.seek.addEventListener('change', () => {
    const duration = Number.isFinite(els.video.duration) ? els.video.duration : 0;
    if (duration <= 0) return;
    const target = (Number(els.seek.value) / 1000) * duration;
    els.video.currentTime = target;
    if (state.sessionActive && state.sessionReady) sendJson({ type: 'control', action: 'seek', tMs: Math.round(target * 1000) });
  });
  els.volume.addEventListener('input', () => {
    state.settings.volume = Number(els.volume.value) / 100;
    applyVolume();
    saveSettings();
  });

  // 视频事件
  els.video.addEventListener('loadedmetadata', () => {
    updateTimeUi();
    if (state.sim.frozen && state.sim.clock > 0) {
      try {
        els.video.currentTime = Math.min(els.video.duration, state.sim.clock / 1000);
      } catch {
        /* ignore */
      }
    }
  });
  els.video.addEventListener('durationchange', updateTimeUi);
  els.video.addEventListener('timeupdate', updateTimeUi);
  els.video.addEventListener('play', () => {
    updatePlayButton();
    if (state.sessionActive && state.sessionReady) {
      state.sending = true;
      sendJson({ type: 'control', action: 'resume', tMs: Math.round(els.video.currentTime * 1000) });
      logEvent('player', '继续播放，恢复送音频', 'ok');
    }
  });
  els.video.addEventListener('pause', () => {
    updatePlayButton();
    if (state.sessionActive && state.sessionReady) {
      state.sending = false;
      sendJson({ type: 'control', action: 'pause', tMs: Math.round(els.video.currentTime * 1000) });
      logEvent('player', '暂停播放，暂停送音频', 'warn');
    }
  });
  els.video.addEventListener('seeked', () => {
    hideSubtitle();
    clearTranscriptActive();
    state.lastSentTMs = -100;
    if (state.sessionActive && state.sessionReady) {
      sendJson({ type: 'control', action: 'seek', tMs: Math.round(els.video.currentTime * 1000) });
    }
  });
  els.video.addEventListener('ended', () => {
    logEvent('player', '视频播放结束', 'warn');
    hideSubtitle();
    if (state.sessionActive && state.sessionReady) sendJson({ type: 'control', action: 'flush' });
  });
  els.video.addEventListener('error', () => {
    const error = els.video.error;
    if (!error) return;
    logEvent('player', `媒体错误（code=${error.code}）：${error.message || '无法解码'}`, 'err');
    toast('视频加载失败：请检查文件格式或 URL 是否可访问', 'err', 6000);
  });

  // 字幕控制
  els.toggleSubs.addEventListener('change', () => setSubsVisible(els.toggleSubs.checked));
  els.subsSmaller.addEventListener('click', () => adjustSubtitleFont(-0.1));
  els.subsBigger.addEventListener('click', () => adjustSubtitleFont(0.1));
  els.subsHide.addEventListener('click', () => setSubsVisible(false));
  els.toggleDub.addEventListener('change', () => {
    state.settings.dubEnabled = els.toggleDub.checked;
    if (!state.settings.dubEnabled) {
      for (const source of state.dub.active) {
        try {
          source.stop();
        } catch {
          /* ignore */
        }
      }
      state.dub.active.clear();
      duckOriginal(false);
    }
    saveSettings();
    toast(`配音${state.settings.dubEnabled ? '已开启' : '已关闭'}`, 'info', 1800);
  });
  els.toggleDuck.addEventListener('change', () => {
    state.settings.duckEnabled = els.toggleDuck.checked;
    if (!state.settings.duckEnabled && state.dub.ducking) {
      state.dub.ducking = false;
      applyVolume();
    }
    saveSettings();
  });

  // 音色模式
  els.voiceMode.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]');
    if (!button) return;
    setVoiceMode(button.dataset.mode);
  });

  // 术语表
  els.btnGlossary.addEventListener('click', () => applyGlossary());
  els.btnGlossaryReset.addEventListener('click', resetGlossary);
  els.glossaryInput.addEventListener('input', () => {
    updateGlossaryCount();
    els.glossaryHint.textContent = '未应用的修改';
  });

  // 导出 / 日志
  els.btnExportSrt.addEventListener('click', exportSrt);
  els.btnClearLog.addEventListener('click', () => {
    els.eventLog.innerHTML = '<div class="log-empty">日志已清空</div>';
  });

  // 键盘：空格播放/暂停（输入框内不拦截）
  document.addEventListener('keydown', (event) => {
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || event.target?.isContentEditable) return;
    if (event.code === 'Space') {
      event.preventDefault();
      if (state.sim.active) return;
      videoPlayPause();
    }
  });

  // 离开页面：优雅关闭会话
  window.addEventListener('beforeunload', () => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      try {
        state.ws.send(JSON.stringify({ type: 'bye' }));
      } catch {
        /* ignore */
      }
    }
  });
}

// -------------------------------------------------------------------- 启动

async function bootstrap() {
  bindEvents();
  setupSubtitleDrag();
  updateSessionButtons();
  resetMetricsHud();
  applySubtitleSettings();
  updatePlayButton();

  const params = new URLSearchParams(location.search);
  const simMode = await setupSimMode(params);
  if (!simMode) {
    await loadEngineInfo();
    syncSettingsUi();
    const videoParam = params.get('video');
    if (videoParam) loadVideoUrl(videoParam);
    const autoPlay = params.get('autoplay') === '1';
    if (autoPlay && els.video.src) {
      void startSession();
    }
  } else {
    syncSettingsUi();
  }
}

bootstrap().catch((err) => {
  console.error(err);
  toast(`工作台初始化失败：${err.message}`, 'err', 8000);
});
