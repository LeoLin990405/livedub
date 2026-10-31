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
  buildCourseOverviewMarkdown,
  computeChapters,
} from './notes-kit.mjs';
import {
  buildVisualContextPayload,
  describeVisualContext,
  normalizeVisualContextText,
  shouldSendVisualContext,
} from './context-kit.mjs';
import {
  availableCourseModels,
  formatTranslationMarkdown,
  mergeCausalVotes,
  mergeNoteDrafts,
  planCourseRun,
  translateSubtitleCues,
} from './jobs-kit.mjs';
import {
  chooseSubtitleTrack,
  cuesForSession,
  isDirectMediaUrl,
  isLoadableVideo,
} from './page-kit.mjs';
import {
  applyModelCausalLinks,
  buildVisualNoteMarkdown,
  collectTranscript,
  formatCausalBullet,
  linkSpeechAndVisuals,
  contactSheetLayout,
  changedPixelRatio,
  extractImageUrls,
  frameChangeRatio,
  normalizeVisionHealth,
  resolveKeyframeOptions,
  sampleTimes,
  shouldAcceptFrame,
  toGrayscale,
  visualNoteTags,
} from './vision-kit.mjs';
import {
  groupNotesForDisplay,
  matchesNoteFilter,
} from './notes-kit.mjs';
import {
  buildNoteExportFilename,
  buildNotesMarkdown,
  buildOutlineMarkdown,
  buildQuoteMarkdown,
  buildVideoRef,
  filterNotes,
  formatNoteTimestamp,
  formatShortTimestamp,
  insertAtCursor,
  localNotesKey,
  makeQuote,
  makeVideoId,
  noteExcerpt,
  parseTags,
  renderMarkdown,
  resolveEditorShortcut,
  sortNotesByTime,
  timestampAnchor,
  videoTitleFrom,
} from './notes-kit.mjs';
import {
  buildEventJsonl,
  buildSessionMeta,
  buildSrt,
  decodePcmBase64,
  downloadTextFile,
  fetchSessionJsonl,
  formatClock,
  formatMs,
  parseSessionJsonl,
  stateAt,
} from './session-parse.mjs';
import {
  DEFAULT_SUBS_STYLE,
  SUBS_SIZES,
  SUBS_SIZE_LABELS,
  SUBS_SIZE_SCALE,
  asrEngineLabel,
  asrPrivacyCopy,
  buildSparkline,
  canStartPlayback,
  defaultVoiceLabel,
  desktopAppInstructions,
  isEditableTarget,
  mergeSettingsSnapshot,
  normalizeAsrEngine,
  normalizeSubsStyle,
  normalizeTheme,
  filterCommands,
  nextTabIndex,
  progressStepStates,
  resolveShortcut,
} from './ui-kit.mjs';

// ------------------------------------------------------------------ DOM 引用

const $ = (id) => document.getElementById(id);

const els = {
  connBadge: $('connBadge'),
  btnCommands: $('btnCommands'),
  btnHelpShortcuts: $('btnHelpShortcuts'),
  commandPalette: $('commandPalette'),
  commandInput: $('commandInput'),
  commandList: $('commandList'),
  commandCount: $('commandCount'),
  shortcutHelp: $('shortcutHelp'),
  helpGrid: $('helpGrid'),
  btnHelpClose: $('btnHelpClose'),
  imageLightbox: $('imageLightbox'),
  lightboxImage: $('lightboxImage'),
  btnLightboxClose: $('btnLightboxClose'),
  dockTabSubtitles: $('dockTabSubtitles'),
  dockTabNotes: $('dockTabNotes'),
  dockTabSettings: $('dockTabSettings'),
  btnDockCollapse: $('btnDockCollapse'),
  dockNotesDot: $('dockNotesDot'),
  dockPanelSubtitles: $('dockPanelSubtitles'),
  dockPanelNotes: $('dockPanelNotes'),
  dockPanelSettings: $('dockPanelSettings'),
  subtitleHeroSrc: $('subtitleHeroSrc'),
  subtitleHeroDst: $('subtitleHeroDst'),
  subtitleHeroTime: $('subtitleHeroTime'),
  notesFilters: $('notesFilters'),
  visualSteps: $('visualSteps'),
  connText: $('connText'),
  hudAsr: $('hudAsr'),
  hudMt: $('hudMt'),
  hudTts: $('hudTts'),
  hudE2e: $('hudE2e'),
  btnReconnect: $('btnReconnect'),
  btnStart: $('btnStart'),
  btnStop: $('btnStop'),
  btnTheme: $('btnTheme'),
  btnNotes: $('btnNotes'),
  notesCountBadge: $('notesCountBadge'),
  btnPip: $('btnPip'),
  notesDrawer: $('notesDrawer'),
  notesVideoTitle: $('notesVideoTitle'),
  notesCount: $('notesCount'),
  btnNotesNew: $('btnNotesNew'),
  btnNotesOutline: $('btnNotesOutline'),
  btnNotesVisual: $('btnNotesVisual'),
  btnCaptureVisual: $('btnCaptureVisual'),
  visualModal: $('visualModal'),
  visualVideoTitle: $('visualVideoTitle'),
  visualVisionBadge: $('visualVisionBadge'),
  visualMode: $('visualMode'),
  visualRange: $('visualRange'),
  visualVlm: $('visualVlm'),
  jobTranslate: $('jobTranslate'),
  jobNotes: $('jobNotes'),
  jobCausal: $('jobCausal'),
  courseSource: $('courseSource'),
  courseSourceRow: $('courseSourceRow'),
  courseModels: $('courseModels'),
  visualPlan: $('visualPlan'),
  visualProgress: $('visualProgress'),
  visualProgressBar: $('visualProgressBar'),
  visualProgressText: $('visualProgressText'),
  visualError: $('visualError'),
  btnVisualClose: $('btnVisualClose'),
  btnVisualCancel: $('btnVisualCancel'),
  btnVisualStart: $('btnVisualStart'),
  visualFootHint: $('visualFootHint'),
  obsidianDot: $('obsidianDot'),
  obsidianStatusText: $('obsidianStatusText'),
  btnObsidianSync: $('btnObsidianSync'),
  toggleVisualContext: $('toggleVisualContext'),
  visualContextStatus: $('visualContextStatus'),
  btnNotesClose: $('btnNotesClose'),
  notesExportMenu: $('notesExportMenu'),
  notesOfflineBanner: $('notesOfflineBanner'),
  btnNotesRetry: $('btnNotesRetry'),
  notesSearch: $('notesSearch'),
  notesSaveStatus: $('notesSaveStatus'),
  notesTabEdit: $('notesTabEdit'),
  notesTabPreview: $('notesTabPreview'),
  notesNoteTime: $('notesNoteTime'),
  notesEditor: $('notesEditor'),
  notesPreview: $('notesPreview'),
  notesTagsInput: $('notesTagsInput'),
  notesTagsValue: $('notesTagsValue'),
  notesList: $('notesList'),
  notesListCount: $('notesListCount'),
  btnInsertQuote: $('btnInsertQuote'),
  btnInsertTimestamp: $('btnInsertTimestamp'),
  btnInsertCode: $('btnInsertCode'),
  btnInsertScreenshot: $('btnInsertScreenshot'),
  privacyChip: $('privacyChip'),
  privacyChipText: $('privacyChipText'),

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
  captureHint: $('captureHint'),

  transcriptList: $('transcriptList'),
  transcriptCount: $('transcriptCount'),
  btnExportSrt: $('btnExportSrt'),
  btnExportEvents: $('btnExportEvents'),
  connHelp: $('connHelp'),
  btnConnRetry: $('btnConnRetry'),
  subsSize: $('subsSize'),
  subsPosition: $('subsPosition'),
  subsOpacity: $('subsOpacity'),
  subsOpacityValue: $('subsOpacityValue'),
  btnSubsOnly: $('btnSubsOnly'),
  btnSubsReset: $('btnSubsReset'),
  btnSubsOnlyExit: $('btnSubsOnlyExit'),
  btnPanelsShow: $('btnPanelsShow'),
  sparkSvg: $('sparkSvg'),
  sparkCount: $('sparkCount'),
  sparkAsr: $('sparkAsr'),
  sparkMt: $('sparkMt'),
  sparkTts: $('sparkTts'),
  sparkE2e: $('sparkE2e'),
  asrSettingsTag: $('asrSettingsTag'),
  asrPrivacy: $('asrPrivacy'),
  asrPrivacyTitle: $('asrPrivacyTitle'),
  asrPrivacyDetail: $('asrPrivacyDetail'),
  asrPendingHint: $('asrPendingHint'),
  engineCloudNote: $('engineCloudNote'),
  asrSessionValue: $('asrSessionValue'),
  desktopBadge: $('desktopBadge'),
  desktopHint: $('desktopHint'),
  desktopCommand: $('desktopCommand'),
  btnCopyDesktopCmd: $('btnCopyDesktopCmd'),
  footerPrivacy: $('footerPrivacy'),

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

/** v0.1 只存了 fontSize（0.7~1.9），v0.2 迁移成 S/M/L/XL 预设 */
function migrateLegacySubsStyle(legacy) {
  if (legacy && legacy.subsStyle) return normalizeSubsStyle(legacy.subsStyle);
  const fontSize = Number(legacy?.fontSize);
  if (!Number.isFinite(fontSize)) return { ...DEFAULT_SUBS_STYLE };
  const size = fontSize <= 0.9 ? 's' : fontSize <= 1.12 ? 'm' : fontSize <= 1.38 ? 'l' : 'xl';
  return normalizeSubsStyle({ ...DEFAULT_SUBS_STYLE, size });
}

const state = {
  ws: null,
  wsReady: false,
  helloSent: false,
  sessionActive: false,
  sessionReady: false,
  asrReady: false,
  reconnectAttempts: 0,
  reconnectTimer: null,
  maxEndMs: 0,

  config: null,
  engineInfo: null,
  engineOnline: null,
  providers: null,
  sessionProviders: null,
  uiSettings: null,
  uiSettingsSaving: false,
  serverReachable: null,
  desktopApp: null,
  engineEvents: [],
  metricsHistory: [],
  panelsHidden: false,
  subsOnly: { active: false, previousDub: true, previousStyle: null },
  voice: { mode: 'preset', voiceId: '' },
  status: 'idle',
  metrics: null,

  dock: { tab: 'subtitles', collapsed: false, mobileOpen: false },
  ui: { commandOpen: false, commandIndex: 0, commandResults: [], helpOpen: false, lightboxOpen: false },
  media: { name: '', url: '', objectUrl: null, isFile: false, size: null },
  pageCues: [],
  page: null,
  // v0.4：当前视频身份（Notes API 的 VideoRef 基础）+ 学习笔记状态
  video: null,
  vision: { available: null, health: null, checkedAt: null, checking: false },
  visual: { open: false, running: false, cancelled: false, sampling: false, phase: 'idle', debug: {}, mode: 'single', range: 'rest', vlm: false, translateSource: 'video', plan: null, abort: null, lastError: null },
  course: { liveChain: null },
  obsidian: {
    loaded: false,
    loading: false,
    enabled: false,
    configured: false,
    dir: '',
    dirRaw: '',
    exists: false,
    autoExport: true,
    assetsSubdir: 'livedub-assets',
    lastSyncedAt: null,
    lastPath: null,
    indexPath: null,
    lastError: null,
    syncing: false,
    statusTimer: null,
  },
  visualContext: {
    enabled: false,
    timer: null,
    sending: false,
    lastText: '',
    lastGray: null,
    lastTMs: null,
    lastChars: 0,
    lastSentAt: 0,
    noSocketLogged: false,
    errorsLogged: 0,
  },
  notes: {
    open: false,
    loadedFor: null,
    items: [],
    currentId: null,
    draft: '',
    noteKind: 'note',
    quotes: [],
    tags: [],
    imageUrl: '',
    dirty: false,
    saving: false,
    saveTimer: null,
    status: '',
    lastSavedAt: null,
    offline: false,
    offlineToastShown: false,
    apiAvailable: null,
    loading: false,
    query: '',
    filter: 'all',
    tab: 'edit',
    localOnlyCount: 0,
    syncing: false,
  },
  audioSeconds: 0,
  lastAudioStatAt: 0,
  lastSentTMs: -100,

  capture: { ctx: null, source: null, node: null, silentGain: null, dubGain: null, ready: false },
  sending: false,
  captureSilence: { warned: false, quietSince: 0, peak: 0 },

  segments: new Map(),
  transcriptEls: new Map(),
  currentSegmentId: null,
  currentSubId: null,
  subtitleHideTimer: null,
  lastLevelAt: 0,

  dub: { active: new Set(), ducking: false, unduckTimer: null, seen: new Set() },

  sim: { active: false, parsed: null, clock: 0, raf: null, playedDubs: new Set(), frozen: false },

  settings: {
    theme: normalizeTheme(savedSettings.theme),
    subsVisible: savedSettings.subsVisible ?? true,
    subsStyle: normalizeSubsStyle(savedSettings.subsStyle ?? migrateLegacySubsStyle(savedSettings)),
    dubEnabled: savedSettings.dubEnabled ?? true,
    duckEnabled: savedSettings.duckEnabled ?? true,
    volume: Number.isFinite(Number(savedSettings.volume)) ? clamp(Number(savedSettings.volume), 0, 1) : 1,
    voiceMode: savedSettings.voiceMode ?? '',
    asrProvider: savedSettings.asrProvider ?? '',
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
  node.setAttribute('role', tone === 'err' ? 'alert' : 'status');
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = String(message);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', '关闭提示');
  close.textContent = '×';
  const dismiss = () => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 240);
  };
  close.addEventListener('click', dismiss);
  node.append(text, close);
  els.toasts.appendChild(node);
  setTimeout(dismiss, timeout);
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
      state.engineOnline = true;
      state.desktopApp = health.desktopApp ?? state.desktopApp;
      renderDesktopApp();
      showConnHelp(false);
      logEvent(
        'engine',
        `健康检查通过：${health.url ?? ''}（mode=${health.mode}，会话 ${health.activeSessions ?? 0}/${health.sessions?.max ?? '?'}，whisper ${health.whisper?.server?.running ? '运行中' : '未启动'}）`,
        'ok',
      );
    } else {
      state.engineOnline = false;
      showConnHelp(true);
      logEvent('engine', `/health 返回 HTTP ${healthRes.status}`, 'err');
    }
    if (configRes.ok) {
      const payload = await configRes.json();
      state.config = payload.config ?? null;
      const config = state.config;
      if (config) {
        renderCourseModels();
        if (!state.settings.voiceMode) state.settings.voiceMode = config.tts?.voiceMode ?? 'clone-first';
        if (!state.settings.glossaryText && Array.isArray(config.glossary) && config.glossary.length > 0) {
          state.settings.glossaryText = config.glossary.map((term) => `${term.src}=${term.dst}`).join('\n');
        }
        updateSessionLangs(config.session?.langFrom ?? 'en', config.session?.langTo ?? 'zh');
        if (Array.isArray(config.glossary)) updateGlossaryCount();
      }
    }
  } catch (err) {
    state.engineOnline = false;
    state.serverReachable = false;
    logEvent('engine', `无法读取引擎信息：${err.message}`, 'err');
    els.engineVersion.textContent = '引擎未启动';
    renderAsrEngine();
    renderDesktopApp();
    showConnHelp(true);
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
    state.asrReady = false;
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
      // 引擎可能已经退出：重新探测 /health，失败则展示「启动命令 + 重试」引导
      if (!state.sim.active) void loadEngineInfo();
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
  if (Array.isArray(state.course.liveChain) && state.course.liveChain.length > 0) {
    overrides.translate = { provider: state.course.liveChain[0], chain: state.course.liveChain.slice() };
  }
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
  if (event && typeof event === 'object') {
    state.engineEvents.push(event);
    if (state.engineEvents.length === 1) els.btnExportEvents.disabled = false;
  }
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
  state.asrReady = event.asrReady !== false;
  state.providers = event.providers ?? null;
  state.sessionProviders = event.providers ?? null;
  renderAsrEngine();
  if (state.providers) renderProviders(state.providers);
  if (event.voice) applyVoice(event.voice);
  els.sessionId.textContent = shorten(String(event.sessionId ?? '—'), 18);
  els.sessionId.title = String(event.sessionId ?? '');
  setSessionState('已就绪');
  setBadge('ok', '已连接');
  if (event.limits?.langFrom) updateSessionLangs(event.limits.langFrom, event.limits.langTo);
  logEvent('session', `会话就绪 ${event.sessionId ?? ''}`, 'ok');
  if (state.sessionActive && canStartPlayback({ sessionReady: state.sessionReady, asrReady: state.asrReady })) beginStreaming();
  else if (state.sessionActive) logEvent('session', '会话已连接，等待语音识别就绪后再播放', 'mt');
  else toast('引擎已就绪，点击「开始同传」即可开始', 'ok', 3000);
}

function onStatus(event) {
  if (event.asrReady === true || event.detail === 'asr-ready') state.asrReady = true;
  const meta = STATUS_META[event.state] ?? { tone: 'ok', label: String(event.state ?? '未知') };
  state.status = event.state;
  setSessionState(meta.label, meta.tone);
  setBadge(meta.tone, meta.label);
  if (event.detail) logEvent('status', event.detail, meta.tone === 'err' ? 'err' : 'mt');
  else logEvent('status', meta.label, meta.tone === 'err' ? 'err' : 'mt');
  if (state.sessionActive && !state.sending && canStartPlayback({ sessionReady: state.sessionReady, asrReady: state.asrReady })) {
    beginStreaming();
  }
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
  pushMetricsHistory(event);
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
  state.sessionProviders = null;
  updateSessionButtons();
  renderAsrEngine();
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
  state.engineEvents = [];
  state.metricsHistory = [];
  state.metrics = null;
  els.btnExportEvents.disabled = true;
  resetMetricsHud();
  renderSparklines();
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
    if (canStartPlayback({ sessionReady: state.sessionReady, asrReady: state.asrReady })) beginStreaming();
    else toast('正在等待语音识别就绪…', 'info', 4000);
    return;
  }
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) connect();
  else if (!state.helloSent) sendHello();
  toast('正在连接本地引擎并初始化会话（首次 whisper 冷启动约 20-30 秒）…', 'info', 6000);
}

function beginStreaming() {
  if (!canStartPlayback({ sessionReady: state.sessionReady, asrReady: state.asrReady })) return;
  state.sending = true;
  state.audioSeconds = 0;
  state.lastSentTMs = -100;
  state.maxEndMs = 0;
  state.captureSilence = { warned: false, quietSince: 0, peak: 0 };
  els.captureHint.hidden = true;
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
  state.asrReady = false;
  state.sending = false;
  state.lastSentTMs = -100;
  els.captureHint.hidden = true;
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
  state.sessionProviders = null;
  renderAsrEngine();
  hideSubtitle();
  if (state.visualContext.enabled || state.visualContext.timer) stopVisualContextLoop({ clearState: true });
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

function clearPageCues() {
  state.pageCues = [];
  state.page = null;
}

function pageCueEndMs() {
  let end = 0;
  for (const cue of state.pageCues ?? []) end = Math.max(end, Number(cue.t1Ms) || 0);
  return end;
}

function storePageCues(page) {
  const track = chooseSubtitleTrack(page?.subtitles);
  state.pageCues = cuesForSession(page);
  state.page = {
    url: String(page?.finalUrl || page?.url || ''),
    title: String(page?.title || '').trim(),
    site: page?.site || 'generic',
    lang: track?.lang || '',
    warning: String(page?.warning || ''),
    cueCount: state.pageCues.length,
  };
}

function setMedia(src, label, { isFile = false, objectUrl = null, size = null } = {}) {
  clearPageCues();
  if (state.media.objectUrl) {
    try {
      URL.revokeObjectURL(state.media.objectUrl);
    } catch {
      /* ignore */
    }
  }
  state.media = { name: label || filenameFromUrl(src), url: src, objectUrl, isFile, size };
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
  onVideoChanged();
  if (state.visualContext.enabled || state.visualContext.timer) stopVisualContextLoop({ clearState: true });
  updatePlayButton();
  logEvent('player', `载入媒体：${state.media.name}`, 'ok');
  toast(`已载入：${state.media.name}`, 'ok');
  if (state.sessionActive) toast('媒体已切换，建议停止后重新开始同传', 'warn', 5000);
}

function loadMediaFromFile(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  setMedia(url, file.name, { isFile: true, objectUrl: url, size: file.size });
}

let pageLoadSeq = 0;

function releaseMediaElement() {
  if (state.media.objectUrl) {
    try {
      URL.revokeObjectURL(state.media.objectUrl);
    } catch {
      /* ignore */
    }
  }
  try {
    els.video.pause();
    els.video.removeAttribute('src');
    els.video.load();
  } catch {
    /* ignore */
  }
}

function adoptPageWithoutMedia({ title, url }) {
  releaseMediaElement();
  state.media = { name: title || filenameFromUrl(url), url, objectUrl: null, isFile: false, size: null };
  els.stage.classList.add('has-media');
  els.stage.classList.remove('sim-stage');
  els.videoLabel.lastElementChild.textContent = shorten(state.media.name, 40);
  els.videoLabel.title = state.media.name;
  els.btnPlay.disabled = true;
  els.btnStopVideo.disabled = true;
  els.seek.disabled = true;
  els.urlInput.value = url;
  els.emptyUrl.value = url;
  resetMediaState();
  onVideoChanged();
  updatePlayButton();
}

function applyParsedPage(page) {
  const cues = cuesForSession(page);
  const video = (Array.isArray(page?.videos) ? page.videos : []).find((item) => isLoadableVideo(item)) ?? null;
  const title = String(page?.title || '').trim();
  const pageUrl = String(page?.finalUrl || page?.url || '');
  if (video) {
    setMedia(video.url, title || filenameFromUrl(video.url), { isFile: false });
    storePageCues(page);
    if (title && state.video) {
      state.video.title = title;
      state.media.name = title;
      els.videoLabel.lastElementChild.textContent = shorten(title, 40);
      els.videoLabel.title = title;
      renderNotesAll();
    }
    setTranslateSource('video');
    let crossOrigin = true;
    try {
      crossOrigin = new URL(video.url, location.href).origin !== location.origin;
    } catch {
      crossOrigin = true;
    }
    if (crossOrigin) toast('跨域视频无法读取画面，笔记和因果的截图不可用；同传和字幕可以', 'warn', 7000);
    if (state.pageCues.length) toast(`已读入 ${state.pageCues.length} 条带时间轴的字幕`, 'ok');
    else if (page?.warning) toast(page.warning, 'warn', 7000);
    return;
  }
  if (cues.length > 0) {
    adoptPageWithoutMedia({ title: title || '课程页面', url: pageUrl });
    storePageCues(page);
    if (state.video) state.video.durationMs = pageCueEndMs();
    setTranslateSource('subtitles');
    const warning = page?.warning ? ` ${page.warning}` : '';
    toast(`已读入 ${cues.length} 条带时间轴的字幕，可以用「已有字幕」翻译。${warning}`.trim(), 'ok', 8000);
    return;
  }
  toast(page?.warning || '没有从这一页解析出可播放的视频或带时间轴的字幕', 'warn', 7000);
}

async function loadVideoUrl(url) {
  const value = String(url ?? '').trim();
  if (!value) {
    toast('请输入课程页或视频 URL', 'warn');
    return;
  }
  let parsed;
  try {
    parsed = new URL(value, location.href);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只支持 http(s) 地址');
  } catch (err) {
    toast(`URL 无效：${err.message}`, 'err');
    return;
  }
  if (isDirectMediaUrl(parsed.href)) {
    setTranslateSource('video');
    setMedia(parsed.href, filenameFromUrl(parsed.href), { isFile: false });
    return;
  }
  const seq = ++pageLoadSeq;
  toast('正在解析页面…', 'info', 1600);
  try {
    const response = await fetch('/api/page/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: parsed.href }),
    });
    const payload = await response.json().catch(() => ({}));
    if (seq !== pageLoadSeq) return;
    if (!response.ok || payload.ok === false) throw new Error(payload.message || `HTTP ${response.status}`);
    applyParsedPage(payload);
  } catch (err) {
    if (seq !== pageLoadSeq) return;
    toast(`页面解析失败：${err.message}`, 'err', 7000);
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
  if (state.sessionActive && !canStartPlayback({ sessionReady: state.sessionReady, asrReady: state.asrReady })) {
    toast('语音识别尚未就绪，请稍候再播放', 'warn');
    return;
  }
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
  if (typeof data.level === 'number') {
    updateLevelMeter(data.level);
    detectSilentCapture(data.level);
  }
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

/** 采集开始后连续 3s 峰值仍接近 0，提示用户排查静音/权限（每会话一次） */
function detectSilentCapture(level) {
  if (!state.sending || state.captureSilence.warned) return;
  const value = Number(level) || 0;
  state.captureSilence.peak = Math.max(state.captureSilence.peak, value);
  if (value > 0.0025 || state.captureSilence.peak > 0.0025) {
    state.captureSilence.quietSince = 0;
    return;
  }
  if (!state.captureSilence.quietSince) {
    state.captureSilence.quietSince = performance.now();
    return;
  }
  if (performance.now() - state.captureSilence.quietSince < 3000) return;
  state.captureSilence.warned = true;
  els.captureHint.hidden = false;
  els.captureChip.dataset.on = 'false';
  els.captureChip.lastElementChild.textContent = '未检测到音频';
  logEvent('capture', '连续 3 秒没有检测到音频：请检查视频静音 / 系统音量 / 音轨是否存在', 'warn');
  toast('没有检测到音频：请确认视频没有静音、系统音量正常，或换一个带音轨的视频', 'warn', 8000);
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
  updateSubtitleHero({ src: sourceText, dst: destText || (translating ? '…' : '') });
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
  updateSubtitleHero({ src: '', dst: '' });
}

function setSubsVisible(visible) {
  state.settings.subsVisible = Boolean(visible);
  els.toggleSubs.checked = state.settings.subsVisible;
  els.toggleSubs.setAttribute('aria-checked', String(state.settings.subsVisible));
  saveSettings();
  if (!visible) hideSubtitle();
}

// ---------------------------------------------------------- 主题 / 字幕样式

function applyTheme(theme, { persist = true } = {}) {
  state.settings.theme = normalizeTheme(theme, state.settings.theme);
  document.documentElement.dataset.theme = state.settings.theme;
  els.btnTheme.title = state.settings.theme === 'light' ? '切换到暗色主题' : '切换到亮色主题';
  els.btnTheme.setAttribute('aria-pressed', String(state.settings.theme === 'light'));
  if (persist) saveSettings();
}

function toggleTheme() {
  const next = state.settings.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  toast(next === 'light' ? '已切换到亮色主题' : '已切换到暗色主题', 'info', 1800);
}

function markerButtons(container, attribute, activeValue) {
  for (const button of container.querySelectorAll('button')) {
    const active = button.dataset[attribute] === activeValue;
    button.dataset.active = String(active);
    button.setAttribute('aria-pressed', String(active));
  }
}

/** 把 settings.subsStyle 应用到字幕层（字号/位置/背景不透明度/自定义拖拽位置） */
function applySubsStyle() {
  const style = normalizeSubsStyle(state.settings.subsStyle);
  state.settings.subsStyle = style;
  const scale = SUBS_SIZE_SCALE[style.size] ?? 1;
  document.documentElement.style.setProperty('--subs-scale', String(scale));
  els.subs.style.setProperty('--subs-scale', String(scale));
  els.subs.style.setProperty('--subs-bg-alpha', String(style.opacity));
  els.subs.dataset.position = style.position;
  els.subsOpacity.value = String(Math.round(style.opacity * 100));
  els.subsOpacityValue.textContent = `${Math.round(style.opacity * 100)}%`;
  markerButtons(els.subsSize, 'size', style.size);
  markerButtons(els.subsPosition, 'position', style.position);
  if (state.settings.subsPos) {
    els.subs.style.left = state.settings.subsPos.left;
    els.subs.style.top = state.settings.subsPos.top;
    els.subs.style.bottom = 'auto';
    els.subs.style.transform = 'none';
    els.subs.classList.add('custom-position');
  } else {
    els.subs.style.left = '';
    els.subs.style.top = '';
    els.subs.style.bottom = '';
    els.subs.style.transform = '';
    els.subs.classList.remove('custom-position');
  }
}

function setSubsSize(size, { persist = true } = {}) {
  if (!SUBS_SIZES.includes(size)) return;
  state.settings.subsStyle = normalizeSubsStyle({ ...state.settings.subsStyle, size });
  applySubsStyle();
  if (persist) saveSettings();
  toast(`字幕字号：${SUBS_SIZE_LABELS[size] ?? size}`, 'info', 1400);
}

function setSubsPosition(position, { persist = true } = {}) {
  state.settings.subsStyle = normalizeSubsStyle({ ...state.settings.subsStyle, position });
  state.settings.subsPos = null;
  applySubsStyle();
  if (persist) saveSettings();
}

function setSubsOpacity(value, { persist = true } = {}) {
  state.settings.subsStyle = normalizeSubsStyle({ ...state.settings.subsStyle, opacity: Number(value) / 100 });
  applySubsStyle();
  if (persist) saveSettings();
}

/** 兼容旧按钮：在 S/M/L/XL 档位间步进 */
function adjustSubtitleFont(delta) {
  const current = SUBS_SIZES.indexOf(state.settings.subsStyle.size);
  const next = clamp((current < 0 ? 1 : current) + Math.sign(delta), 0, SUBS_SIZES.length - 1);
  setSubsSize(SUBS_SIZES[next]);
}

// ------------------------------------------------------ 仅字幕 / 面板模式

const appRoot = document.querySelector('.app');

function setPanelsHidden(hidden) {
  state.panelsHidden = Boolean(hidden);
  appRoot.classList.toggle('panels-hidden', state.panelsHidden);
  els.btnPanelsShow.hidden = !(state.panelsHidden && !state.subsOnly.active);
}

function enterSubsOnly() {
  if (state.subsOnly.active) return;
  state.subsOnly.active = true;
  state.subsOnly.previousDub = state.settings.dubEnabled;
  state.subsOnly.previousStyle = { ...state.settings.subsStyle };
  setPanelsHidden(false);
  appRoot.classList.add('subs-only');
  els.btnSubsOnlyExit.hidden = false;
  els.btnPanelsShow.hidden = true;
  setDubEnabled(false, { persist: false, persistToServer: false });
  state.settings.subsStyle = normalizeSubsStyle({ ...state.settings.subsStyle, size: 'xl' });
  applySubsStyle();
  setSubsVisible(true);
  saveSettings();
  logEvent('ui', '进入仅字幕模式（Esc 退出）', 'ok');
  toast('已进入仅字幕模式：放大字幕、关闭配音；按 Esc 退出', 'info', 3200);
}

function exitSubsOnly() {
  if (!state.subsOnly.active) return;
  state.subsOnly.active = false;
  appRoot.classList.remove('subs-only');
  els.btnSubsOnlyExit.hidden = true;
  setDubEnabled(state.subsOnly.previousDub, { persist: false, persistToServer: false });
  state.settings.subsStyle = normalizeSubsStyle(state.subsOnly.previousStyle ?? state.settings.subsStyle);
  applySubsStyle();
  saveSettings();
}

// ------------------------------------------------------------ 延迟 sparkline

function renderSparklines(metricsList = state.metricsHistory) {
  const list = Array.isArray(metricsList) ? metricsList : [];
  const series = {
    asr: list.map((metrics) => metrics?.asrFinalMs),
    mt: list.map((metrics) => metrics?.mtFirstMs),
    tts: list.map((metrics) => metrics?.ttsFirstMs),
    e2e: list.map((metrics) => metrics?.e2eLagMs),
  };
  const lines = {
    asr: buildSparkline(series.asr, { width: 260, height: 96, pad: 6 }),
    mt: buildSparkline(series.mt, { width: 260, height: 96, pad: 6 }),
    tts: buildSparkline(series.tts, { width: 260, height: 96, pad: 6 }),
    e2e: buildSparkline(series.e2e, { width: 260, height: 96, pad: 6 }),
  };
  els.sparkAsr.setAttribute('points', lines.asr.points);
  els.sparkMt.setAttribute('points', lines.mt.points);
  els.sparkTts.setAttribute('points', lines.tts.points);
  els.sparkE2e.setAttribute('points', lines.e2e.points);
  const count = Math.max(lines.asr.count, lines.mt.count, lines.tts.count, lines.e2e.count);
  els.sparkCount.textContent = count > 0 ? `最近 ${count} 句` : '等待数据';
  els.sparkSvg.setAttribute(
    'aria-label',
    count > 0
      ? `最近 ${count} 句延迟趋势：ASR 最新 ${formatMs(lines.asr.last)}，翻译 ${formatMs(lines.mt.last)}，TTS ${formatMs(lines.tts.last)}，端到端 ${formatMs(lines.e2e.last)}`
      : '还没有延迟数据',
  );
  // 单句时 polyline 只有一个点，补一个极小线段让趋势可见
  for (const [key, line] of Object.entries(lines)) {
    if (line.count === 1) {
      const [x, y] = line.points.split(',');
      els[`spark${key === 'asr' ? 'Asr' : key === 'mt' ? 'Mt' : key === 'tts' ? 'Tts' : 'E2e'}`].setAttribute(
        'points',
        `${x},${y} ${Number(x) + 0.8},${y}`,
      );
    }
  }
}

function pushMetricsHistory(metrics) {
  if (!metrics || typeof metrics !== 'object') return;
  state.metricsHistory.push(metrics);
  while (state.metricsHistory.length > 30) state.metricsHistory.shift();
  renderSparklines();
}

// ------------------------------------------------------- 事件 JSONL 导出

function currentSessionMeta() {
  const durationMs = Number.isFinite(els.video.duration) && els.video.duration > 0 ? els.video.duration * 1000 : state.maxEndMs;
  return buildSessionMeta({
    sessionId: els.sessionId.textContent === '—' ? null : els.sessionId.textContent,
    title: mediaTitle(),
    video: state.media.isFile ? '' : state.media.url || '',
    langFrom: 'en',
    langTo: 'zh',
    durationMs,
    source: state.sim.active ? 'replay' : 'studio',
    extra: { exportedBy: 'livedub-studio', engineMode: state.engineInfo?.mode ?? null },
  });
}

function exportEventsJsonl() {
  const events = state.sim.active ? state.sim.parsed?.events ?? [] : state.engineEvents;
  if (!Array.isArray(events) || events.length === 0) {
    toast('还没有收到可导出的事件，先开始同传或载入回放', 'warn');
    return;
  }
  const meta = state.sim.active
    ? { ...(state.sim.parsed?.meta ?? {}), exportedAt: new Date().toISOString() }
    : currentSessionMeta();
  const jsonl = buildEventJsonl(events, { meta });
  if (!jsonl.trim()) {
    toast('没有可导出的事件', 'warn');
    return;
  }
  const base = mediaTitle().replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_') || 'livedub';
  const stamp = new Date().toISOString().slice(0, 10);
  downloadTextFile(`${base}-${stamp}-events.jsonl`, jsonl, 'application/x-ndjson;charset=utf-8');
  logEvent('export', `导出事件 JSONL（${events.length} 个事件）`, 'ok');
  toast(`事件 JSONL 已导出（${events.length} 个事件，可直接给回放页）`, 'ok', 4200);
}

// ---------------------------------------------------------- 连接引导 / 配音

function showConnHelp(show) {
  els.connHelp.hidden = !show;
}

function setDubEnabled(enabled, { announce = false, persist = true, persistToServer = true } = {}) {
  const changed = state.settings.dubEnabled !== Boolean(enabled);
  state.settings.dubEnabled = Boolean(enabled);
  els.toggleDub.checked = state.settings.dubEnabled;
  els.toggleDub.setAttribute('aria-checked', String(state.settings.dubEnabled));
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
  if (persist) saveSettings();
  if (changed && persistToServer) void saveUiSettingsPatch({ dub: { enabled: state.settings.dubEnabled } }, { label: '配音开关' });
  if (announce) toast(`配音${state.settings.dubEnabled ? '已开启' : '已关闭'}`, 'info', 1800);
}

// ------------------------------------------------ v0.3 ASR 引擎 / 隐私 / 桌面 App

/** 把 /api/settings 快照应用到工作台状态（不触发二次保存） */
function applyUiSettingsSnapshot(snapshot) {
  if (!snapshot) return;
  state.uiSettings = snapshot;
  state.settings.asrProvider = normalizeAsrEngine(snapshot.asrProvider);
  state.settings.voiceMode = snapshot.ttsVoiceMode;
  setVoiceModeButtons(snapshot.ttsVoiceMode);
  state.settings.dubEnabled = Boolean(snapshot.dubEnabled);
  els.toggleDub.checked = state.settings.dubEnabled;
  els.toggleDub.setAttribute('aria-checked', String(state.settings.dubEnabled));
  if (!state.settings.dubEnabled) duckOriginal(false);
  renderAsrEngine();
  renderPrivacyChrome();
}

/** GET /api/settings：读取持久化的 UI 设置（失败则保留本地默认并提示） */
async function loadUiSettings() {
  try {
    const response = await fetch('/api/settings', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    state.serverReachable = true;
    const merged = mergeSettingsSnapshot(body, state.config?.asr?.provider ?? 'whisper-local');
    applyUiSettingsSnapshot(merged);
    if (body.desktopApp) {
      state.desktopApp = body.desktopApp;
      renderDesktopApp();
    }
    if (Array.isArray(body.warnings) && body.warnings.length > 0) {
      logEvent('settings', `UI 设置 warning：${body.warnings.join('；')}`, 'warn');
    }
    logEvent(
      'settings',
      `UI 设置：ASR=${asrEngineLabel(merged.asrProvider)}${merged.fileExists ? '（data/ui-settings.json）' : '（默认，未保存）'}`,
      'mt',
    );
    return true;
  } catch (err) {
    state.serverReachable = false;
    logEvent('settings', `读取 /api/settings 失败：${err.message}（使用默认设置）`, 'warn');
    renderAsrEngine();
    renderPrivacyChrome();
    renderDesktopApp();
    return false;
  }
}

/** PUT /api/settings：只提交白名单字段；成功返回 true */
async function saveUiSettingsPatch(patch, { label = '设置' } = {}) {
  if (!patch || Object.keys(patch).length === 0) return false;
  if (state.uiSettingsSaving) return false;
  state.uiSettingsSaving = true;
  renderAsrEngine();
  try {
    const response = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: patch }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
    state.serverReachable = true;
    const merged = mergeSettingsSnapshot(body, state.settings.asrProvider);
    applyUiSettingsSnapshot(merged);
    if (body.desktopApp) {
      state.desktopApp = body.desktopApp;
      renderDesktopApp();
    }
    logEvent('settings', `${label}已保存 → data/ui-settings.json（下次会话生效）`, 'ok');
    return true;
  } catch (err) {
    logEvent('settings', `保存 ${label} 失败：${err.message}`, 'err');
    toast(`保存设置失败：${err.message}`, 'err', 5200);
    return false;
  } finally {
    state.uiSettingsSaving = false;
    renderAsrEngine();
  }
}

/** 切换 ASR 引擎：乐观更新 UI，失败回滚；明确提示「当前会话不变」 */
async function selectAsrEngine(provider) {
  const next = normalizeAsrEngine(provider);
  if (next === normalizeAsrEngine(state.settings.asrProvider) || state.uiSettingsSaving) return;
  const previous = state.settings.asrProvider;
  state.settings.asrProvider = next;
  renderAsrEngine({ pending: true });
  const ok = await saveUiSettingsPatch({ asr: { provider: next } }, { label: `ASR 引擎（${asrEngineLabel(next)}）` });
  if (!ok) {
    state.settings.asrProvider = previous;
    renderAsrEngine();
    return;
  }
  const privacy = asrPrivacyCopy(next);
  toast(
    `ASR 引擎已保存：${asrEngineLabel(next)}。当前会话不变，重连 / 新建会话后生效。`,
    privacy.cloud ? 'warn' : 'ok',
    5600,
  );
  renderAsrEngine({ pending: true });
}

/** 渲染识别引擎面板：按钮选中态、隐私文案、当前会话、待生效提示 */
function renderAsrEngine({ pending = false } = {}) {
  const provider = normalizeAsrEngine(state.settings.asrProvider);
  const privacy = asrPrivacyCopy(provider);
  for (const button of document.querySelectorAll('.engine-choice[data-asr-provider]')) {
    const checked = button.dataset.asrProvider === provider;
    button.setAttribute('aria-checked', String(checked));
    button.disabled = state.uiSettingsSaving;
  }
  els.asrPrivacy.dataset.tone = privacy.tone;
  els.asrPrivacyTitle.textContent = privacy.title;
  els.asrPrivacyDetail.textContent = privacy.detail;
  const privacyUse = els.asrPrivacy.querySelector('use');
  if (privacyUse) privacyUse.setAttribute('href', privacy.cloud ? '#i-cloud' : '#i-lock');

  const snapshot = state.uiSettings;
  if (state.uiSettingsSaving) els.asrSettingsTag.textContent = '保存中…';
  else if (!snapshot) els.asrSettingsTag.textContent = '引擎离线';
  else if (snapshot.fileExists) els.asrSettingsTag.textContent = '已保存 · data/ui-settings.json';
  else els.asrSettingsTag.textContent = '默认（未保存）';
  els.asrSettingsTag.classList.toggle('warn', !snapshot || state.uiSettingsSaving);

  const sessionProvider = state.sessionActive || state.sim.active ? state.sessionProviders?.asr ?? null : null;
  els.asrSessionValue.textContent = sessionProvider
    ? `${state.sim.active && !state.sessionActive ? '录制时 · ' : ''}${asrEngineLabel(sessionProvider)}`
    : '未开始';

  const mismatch = Boolean(sessionProvider) && sessionProvider !== provider;
  const savedButPrestart = Boolean(snapshot?.overrides?.asr?.provider) && !state.sessionReady;
  els.engineCloudNote.hidden = !privacy.cloud;
  els.asrPendingHint.hidden = !(pending || mismatch || savedButPrestart);
  els.asrPendingHint.textContent = mismatch
    ? `已选择 ${asrEngineLabel(provider)}：当前会话仍是 ${asrEngineLabel(sessionProvider)}，重连 / 新建会话后生效`
    : '已保存 · 当前会话不变，重连 / 新建会话后生效';
  renderPrivacyChrome(provider);
}

/** 顶栏隐私胶囊 + footer 隐私文案（云端 ASR 用警示色） */
function renderPrivacyChrome(provider = state.settings.asrProvider) {
  const privacy = asrPrivacyCopy(provider);
  const chipUse = els.privacyChip.querySelector('use');
  els.privacyChip.dataset.tone = privacy.tone;
  els.privacyChipText.textContent = privacy.title;
  els.privacyChip.title = privacy.detail;
  if (chipUse) chipUse.setAttribute('href', privacy.cloud ? '#i-cloud' : '#i-lock');
  els.footerPrivacy.textContent = privacy.cloud
    ? '云端 ASR：音频会上传到 MiniMax · 字幕不写入磁盘'
    : '音频不离开本机 · 字幕不写入磁盘';
  els.footerPrivacy.classList.toggle('privacy-cloud', privacy.cloud);
}

/** 渲染桌面 App 面板（apps/macos/build/livedub.app 检测结果来自 /health 或 /api/settings） */
function renderDesktopApp() {
  const instructions = desktopAppInstructions(state.desktopApp ?? { available: false });
  els.desktopBadge.textContent = instructions.badge;
  els.desktopBadge.className = `tag ${instructions.tone === 'ok' ? 'ok' : 'warn'}`;
  const appPath = state.desktopApp?.appPath ? ` 路径：${state.desktopApp.appPath}` : '';
  els.desktopHint.textContent = `${instructions.hint}${instructions.available ? appPath : ''}`;
  els.desktopCommand.textContent = instructions.command;
  els.desktopCommand.title = instructions.command;
  els.btnCopyDesktopCmd.title = `复制${instructions.commandLabel}`;
}

async function copyText(text, successMessage = '已复制') {
  const value = String(text ?? '');
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    toast(successMessage, 'ok', 1800);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand?.('copy');
    textarea.remove();
    toast(successMessage, 'ok', 1800);
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
    applySubsStyle();
    saveSettings();
    logEvent('ui', '字幕已自定义位置（双击或「重置位置」恢复预设）', 'mt');
  };
  els.subs.addEventListener('pointerup', finish);
  els.subs.addEventListener('pointercancel', finish);
  els.subs.addEventListener('dblclick', () => {
    state.settings.subsPos = null;
    applySubsStyle();
    saveSettings();
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
  const previous = `${state.voice.mode}/${state.voice.voiceId}/${Boolean(info.degraded)}`;
  const next = `${info.mode ?? 'preset'}/${info.voiceId ?? ''}/${Boolean(info.degraded)}`;
  state.voice = { mode: info.mode ?? 'preset', voiceId: info.voiceId ?? '' };
  els.voiceId.textContent = state.voice.voiceId || '—';
  els.voiceId.title = state.voice.voiceId || '';
  const mode = state.voice.mode === 'clone' ? 'clone-first' : 'preset';
  setVoiceModeButtons(mode);
  const label = defaultVoiceLabel({ mode: state.voice.mode, degraded: info.degraded, voiceId: state.voice.voiceId });
  if (!label) {
    els.voiceNote.textContent = '已使用克隆音色';
    els.voiceNote.title = '';
  } else if (info.degraded && info.reason) {
    els.voiceNote.textContent = `${label} · 已降级：${info.reason}`;
    els.voiceNote.title = String(info.reason);
  } else {
    els.voiceNote.textContent = label;
    els.voiceNote.title = label;
  }
  if (previous !== next) {
    logEvent('voice', `音色 ${state.voice.mode} / ${state.voice.voiceId}${info.degraded ? '（降级）' : ''}`, 'ok');
  }
}

function setVoiceModeButtons(mode) {
  for (const button of els.voiceMode.querySelectorAll('button')) {
    const active = button.dataset.mode === mode;
    button.dataset.active = String(active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function setVoiceMode(mode) {
  const next = mode === 'preset' ? 'preset' : 'clone-first';
  state.settings.voiceMode = next;
  saveSettings();
  setVoiceModeButtons(next);
  // 三处设置（asr/tts/dub）统一持久化到 data/ui-settings.json，下次会话由服务端注入
  if (state.serverReachable !== false && state.uiSettings?.ttsVoiceMode !== next) {
    void saveUiSettingsPatch({ tts: { voiceMode: next } }, { label: '音色模式' });
  }
  els.voiceNote.textContent = next === 'clone-first' ? '克隆优先：会先尝试克隆讲师音色，失败后使用讲师男声' : '预设音色：讲师男声';
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
  applyTheme(state.settings.theme, { persist: false });
  els.toggleSubs.checked = state.settings.subsVisible;
  els.toggleSubs.setAttribute('aria-checked', String(state.settings.subsVisible));
  els.toggleDub.checked = state.settings.dubEnabled;
  els.toggleDub.setAttribute('aria-checked', String(state.settings.dubEnabled));
  els.toggleDuck.checked = state.settings.duckEnabled;
  els.toggleDuck.setAttribute('aria-checked', String(state.settings.duckEnabled));
  els.volume.value = String(Math.round(state.settings.volume * 100));
  els.video.volume = state.settings.volume;
  els.glossaryInput.value = state.settings.glossaryText || '';
  updateGlossaryCount();
  applySubsStyle();
  if (state.settings.voiceMode) setVoiceModeButtons(state.settings.voiceMode);
  if (!state.settings.subsVisible) hideSubtitle();
  renderSparklines();
  els.btnExportEvents.disabled = state.engineEvents.length === 0;
  renderAsrEngine();
  renderPrivacyChrome();
  renderDesktopApp();
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
  els.btnStart.disabled = true;
  els.btnStop.disabled = true;
  els.engineVersion.textContent = '离线回放（未连接引擎）';
  els.whisperState.textContent = '演示数据';
  showConnHelp(false);
  logEvent('demo', '进入演示回放模式（不连接引擎）', 'ok');

  try {
    const text = await fetchSessionJsonl(sessionUrl);
    const parsed = parseSessionJsonl(text);
    state.sim.parsed = parsed;
    state.engineEvents = parsed.events;
    state.sim.playedDubs.clear();
    els.btnExportEvents.disabled = parsed.events.length === 0;

    // 视频：优先 ?video=，否则用会话 meta.video（真实 demo 会话自带 /demo/original.mp4）
    const videoUrl = params.get('video') || parsed.meta?.video || '';
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
    logEvent('demo', `载入回放 ${parsed.events.length} 个事件、${parsed.segments.size} 句字幕、${parsed.dubs.length} 段配音`, 'ok');
    toast(`演示回放：${parsed.meta?.title ?? sessionUrl}`, 'info', 5000);
  } catch (err) {
    logEvent('demo', `加载回放失败：${err.message}`, 'err');
    toast(`加载回放失败：${err.message}`, 'err', 7000);
    els.transcriptList.innerHTML = `<div class="list-empty">${escapeHtml(err.message)}</div>`;
    els.captureHint.hidden = true;
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
  els.engineModeTag.textContent = '录制时';
  els.engineModeTag.classList.remove('warn');
  els.captureChip.lastElementChild.textContent = '离线回放';
  els.captureChip.dataset.on = 'false';
  if (Array.isArray(meta.glossary) && meta.glossary.length > 0) {
    state.settings.glossaryText = meta.glossary.map((term) => `${term.src}=${term.dst}`).join('\n');
    els.glossaryInput.value = state.settings.glossaryText;
    updateGlossaryCount();
  }
  if (meta.title) {
    els.videoLabel.lastElementChild.textContent = shorten(String(meta.title), 40);
    if (state.video) state.video.title = String(meta.title).slice(0, 300);
  }
  if (meta.langFrom) updateSessionLangs(meta.langFrom, meta.langTo ?? 'zh');
  let end = Number(meta.durationMs) || 0;
  for (const segment of parsed.segments.values()) end = Math.max(end, segment.t1Ms);
  for (const dub of parsed.dubs) end = Math.max(end, dub.startMs + (dub.durationMs || 0));
  state.sim.maxMs = end;
  els.transcriptCount.textContent = '0 句';
  state.engineEvents = parsed.events;
  els.btnExportEvents.disabled = parsed.events.length === 0;
  state.sessionProviders = parsed.ready?.providers ?? null;
  renderAsrEngine();
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
  if (els.subtitleHeroTime) els.subtitleHeroTime.textContent = formatClock(tMs);
  renderTranscriptsFrozen(snapshot.segmentsSoFar, snapshot.current?.id && !snapshot.current.partial ? snapshot.current.id : null);
  if (snapshot.metrics) updateMetricsHud(snapshot.metrics);
  if (snapshot.voice) applyVoice(snapshot.voice);
  if (snapshot.status) {
    const meta = STATUS_META[snapshot.status.state] ?? { label: snapshot.status.state };
    setSessionState(`回放 · ${meta.label}`);
  }
  // sparkline 只展示当前时间点之前已经发生的 metrics
  const metricsSoFar = (parsed.eventsWithTimeline ?? []).filter((event) => event.type === 'metrics' && event.atMs <= tMs);
  state.metricsHistory = metricsSoFar;
  renderSparklines(metricsSoFar);
  // 冻结模式：把视频 seek 到对应帧（首帧/poster 对截图很重要）
  if (state.sim.frozen && els.video.src && Number.isFinite(els.video.duration) && els.video.duration > 0) {
    const target = Math.min(els.video.duration, Math.max(0, tMs / 1000));
    if (Math.abs(els.video.currentTime - target) > 0.08) {
      try {
        els.video.currentTime = target;
      } catch {
        /* ignore */
      }
    }
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

// =============================================================== v0.4 学习笔记

/** 把相对/绝对 URL 归一成绝对地址，保证同一视频的 video.id / url 稳定 */
function resolvedMediaUrl() {
  if (state.media.isFile || !state.media.url) return '';
  try {
    return new URL(state.media.url, location.href).href;
  } catch {
    return state.media.url;
  }
}

function currentVideoRef() {
  if (!state.video) return null;
  return buildVideoRef({
    id: state.video.id,
    title: state.video.title,
    url: state.media.isFile ? '' : resolvedMediaUrl(),
    durationMs: state.video.durationMs,
  });
}

/** 载入新媒体后重建视频身份（同一视频重开 -> 相同 video.id -> 历史笔记可见） */
function onVideoChanged() {
  clearTimeout(state.notes.saveTimer);
  const mediaUrl = resolvedMediaUrl();
  const videoId = makeVideoId({
    name: state.media.isFile ? state.media.name : '',
    size: state.media.size,
    url: mediaUrl,
  });
  const title = state.media.isFile
    ? videoTitleFrom({ name: state.media.name })
    : videoTitleFrom({ url: mediaUrl });
  state.video = { id: videoId, title, url: mediaUrl, durationMs: 0 };
  Object.assign(state.notes, {
    loadedFor: null,
    items: [],
    currentId: null,
    draft: '',
    noteKind: 'note',
    quotes: [],
    tags: [],
    imageUrl: '',
    dirty: false,
    saving: false,
    saveTimer: null,
    status: '',
    lastSavedAt: null,
    offline: false,
    offlineToastShown: false,
    apiAvailable: null,
    loading: false,
    query: '',
    filter: 'all',
    tab: 'edit',
    localOnlyCount: 0,
  });
  els.notesSearch.value = '';
  els.notesTagsInput.value = '';
  els.notesEditor.value = '';
  els.btnPip.disabled = false;
  setNotesTab('edit');
  renderNotesAll();
  updateNotesBadge(0);
  renderVisionAvailability();
  if (videoId) void refreshNotes({ silent: true });
}

function setNotesStatus(text, tone = '') {
  state.notes.status = text;
  els.notesSaveStatus.textContent = text;
  els.notesSaveStatus.className = `notes-status ${tone}`.trim();
}

function updateNotesBadge(count) {
  const total = Math.max(0, Number(count) || 0);
  els.notesCountBadge.hidden = total === 0;
  els.notesCountBadge.textContent = total > 99 ? '99+' : String(total);
}

function currentNote() {
  return state.notes.items.find((note) => note.id === state.notes.currentId) ?? null;
}

function isLocalNoteId(id) {
  return String(id ?? '').startsWith('local_');
}

// ------------------------------------------------------------ Notes API client

async function notesFetch(pathname, { method = 'GET', body, rawBody = null, headers = {}, signal = null } = {}) {
  const requestHeaders = { ...headers };
  let requestBody;
  if (rawBody !== null) {
    requestBody = rawBody;
  } else if (body !== undefined) {
    requestHeaders['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }
  const response = await fetch(pathname, { method, headers: requestHeaders, body: requestBody, cache: 'no-store', ...(signal ? { signal } : {}) });
  const contentType = String(response.headers.get('content-type') ?? '');
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(data?.message ?? data?.error ?? `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}

// --------------------------------------------------------- localStorage 回退

function loadLocalNotes(videoId) {
  if (!videoId) return [];
  try {
    const raw = localStorage.getItem(localNotesKey(videoId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((note) => note && typeof note.id === 'string') : [];
  } catch {
    return [];
  }
}

function saveLocalNotes(videoId, notes) {
  if (!videoId) return;
  try {
    localStorage.setItem(localNotesKey(videoId), JSON.stringify(Array.isArray(notes) ? notes : []));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

function persistLocalNote(note) {
  if (!note || !state.video) return;
  const local = loadLocalNotes(state.video.id).filter((item) => item.id !== note.id);
  local.push(note);
  saveLocalNotes(state.video.id, local);
  state.notes.localOnlyCount = local.length;
}

function markNotesOffline(error, { toastOnce = true } = {}) {
  state.notes.offline = true;
  state.notes.apiAvailable = false;
  els.notesOfflineBanner.hidden = false;
  setNotesStatus('离线 · localStorage 暂存', 'offline');
  if (toastOnce && !state.notes.offlineToastShown) {
    state.notes.offlineToastShown = true;
    toast(`笔记 API 不可用，已回退到浏览器 localStorage 暂存${error?.message ? `：${error.message}` : ''}`, 'warn', 6000);
    logEvent('notes', `API 不可用，localStorage 回退：${error?.message ?? 'unknown'}`, 'warn');
  }
}

// ------------------------------------------------------------------ 加载/刷新

async function refreshNotes({ silent = false } = {}) {
  const video = state.video;
  if (!video) return;
  const videoId = video.id;
  state.notes.loading = true;
  renderNotesAll();
  try {
    const payload = await notesFetch(`/api/notes?videoId=${encodeURIComponent(videoId)}&limit=500`);
    if (state.video?.id !== videoId) return;
    state.notes.apiAvailable = true;
    state.notes.offline = false;
    els.notesOfflineBanner.hidden = true;
    const local = loadLocalNotes(videoId);
    state.notes.localOnlyCount = local.length;
    const items = Array.isArray(payload.notes) ? [...payload.notes] : [];
    for (const localNote of local) {
      if (!items.some((note) => note.id === localNote.id)) items.push(localNote);
    }
    state.notes.items = items;
    state.notes.loadedFor = videoId;
    if (state.notes.offlineToastShown) {
      state.notes.offlineToastShown = false;
      toast('笔记 API 已恢复，本地暂存可点「重试同步」', 'ok', 5000);
    }
    if (!silent) logEvent('notes', `已加载 ${items.length} 条笔记（${videoId}）`, 'ok');
  } catch (error) {
    if (state.video?.id !== videoId) return;
    state.notes.items = loadLocalNotes(videoId);
    state.notes.loadedFor = videoId;
    markNotesOffline(error, { toastOnce: !silent });
  } finally {
    state.notes.loading = false;
    renderNotesAll();
    scheduleObsidianStatusRefresh();
  }
}

// -------------------------------------------------------------- 抽屉开关

async function openNotesDrawer({ create = false, allowNoVideo = false } = {}) {
  if (!state.video && !allowNoVideo) {
    toast('请先载入视频，再写学习笔记', 'warn');
    return;
  }
  state.notes.open = true;
  els.notesDrawer.classList.add('open');
  els.notesDrawer.setAttribute('aria-hidden', 'false');
  els.btnNotes.setAttribute('aria-expanded', 'true');
  setDockTab('notes');
  if (state.vision.checkedAt == null || Date.now() - state.vision.checkedAt > 30_000) void loadVisionHealth();
  if (!state.video) {
    renderNotesAll();
    setNotesStatus('等待视频…');
    return;
  }
  if (state.notes.loadedFor !== state.video.id) await refreshNotes({ silent: true });
  renderNotesAll();
  if (create) {
    await createNoteAtCurrentTime();
  } else if (!currentNote()) {
    const ordered = sortNotesByTime(state.notes.items);
    if (ordered.length > 0) selectNote(ordered[ordered.length - 1].id);
    else focusNotesEditor();
  } else {
    focusNotesEditor();
  }
}

function closeNotesDrawer() {
  void flushNotesSave();
  state.notes.open = false;
  els.notesDrawer.classList.remove('open');
  els.notesDrawer.setAttribute('aria-hidden', 'true');
  els.btnNotes.setAttribute('aria-expanded', 'false');
  closeDockMobile();
  setDockTab('subtitles');
}

function focusNotesEditor() {
  setNotesTab('edit');
  requestAnimationFrame(() => els.notesEditor.focus({ preventScroll: false }));
}

// -------------------------------------------------------------- 新建/选择

function makeLocalNote({ video, tMs, body = '', kind = 'note', quotes = [], tags = [], imageUrl = '' }) {
  const now = new Date().toISOString();
  return {
    id: `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    video,
    tMs,
    body,
    kind,
    source: 'studio',
    createdAt: now,
    updatedAt: now,
    ...(quotes.length > 0 ? { quotes } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(imageUrl ? { imageUrl } : {}),
  };
}

async function createNoteAtCurrentTime({ body = '', kind = 'note' } = {}) {
  const video = currentVideoRef();
  if (!video) {
    toast('请先载入视频', 'warn');
    return null;
  }
  await flushNotesSave();
  const tMs = Math.max(0, Math.round((els.video.currentTime || 0) * 1000));
  if (state.notes.apiAvailable === false) {
    const note = makeLocalNote({ video, tMs, body, kind });
    state.notes.items.push(note);
    persistLocalNote(note);
    selectNote(note.id);
    renderNotesAll();
    setNotesStatus('已保存到 localStorage', 'offline');
    return note;
  }
  try {
    const payload = await notesFetch('/api/notes', { method: 'POST', body: { video, tMs, body, kind, source: 'studio' } });
    if (!payload?.note) throw new Error('响应缺少 note');
    state.notes.items.push(payload.note);
    state.notes.apiAvailable = true;
    state.notes.offline = false;
    els.notesOfflineBanner.hidden = true;
    selectNote(payload.note.id);
    renderNotesAll();
    logEvent('notes', `新建笔记 @ ${formatNoteTimestamp(tMs)}`, 'ok');
    return payload.note;
  } catch (error) {
    markNotesOffline(error, { toastOnce: false });
    toast(`笔记 API 不可用，已在本地暂存：${error.message}`, 'warn', 6000);
    const note = makeLocalNote({ video, tMs, body, kind });
    state.notes.items.push(note);
    persistLocalNote(note);
    selectNote(note.id);
    renderNotesAll();
    return note;
  }
}

function selectNote(id) {
  if (!id) return;
  void flushNotesSave();
  const note = state.notes.items.find((item) => item.id === id);
  if (!note) return;
  state.notes.currentId = note.id;
  state.notes.draft = String(note.body ?? '');
  state.notes.noteKind = note.kind ?? 'note';
  state.notes.quotes = Array.isArray(note.quotes) ? [...note.quotes] : [];
  state.notes.tags = Array.isArray(note.tags) ? [...note.tags] : [];
  state.notes.imageUrl = String(note.imageUrl ?? '');
  state.notes.dirty = false;
  els.notesEditor.value = state.notes.draft;
  els.notesTagsInput.value = state.notes.tags.join(', ');
  setNotesStatus(note.updatedAt ? `已保存 · ${formatShortTimestamp(note.tMs)}` : '—');
  renderNotesAll();
}

function seekToNote(note) {
  if (!note) return;
  const tMs = Math.max(0, Math.round(Number(note.tMs) || 0));
  if (state.sim.active) {
    state.sim.clock = tMs;
    if (Number.isFinite(els.video.duration) && els.video.duration > 0) {
      try {
        els.video.currentTime = Math.min(els.video.duration, tMs / 1000);
      } catch {
        /* ignore */
      }
    }
    applySimAt(tMs);
  } else {
    if (Number.isFinite(els.video.duration) && els.video.duration > 0) {
      els.video.currentTime = Math.min(els.video.duration, tMs / 1000);
    }
    if (state.sessionActive && state.sessionReady) sendJson({ type: 'control', action: 'seek', tMs });
  }
  logEvent('notes', `跳转到笔记 ${formatNoteTimestamp(tMs)}`, 'mt');
}

async function deleteNoteById(id) {
  const note = state.notes.items.find((item) => item.id === id);
  if (!note) return;
  const label = noteExcerpt(note, 36);
  if (!window.confirm(`删除这条笔记？\n\n${formatShortTimestamp(note.tMs)} · ${label}`)) return;
  const previousItems = [...state.notes.items];
  // 乐观删除
  state.notes.items = state.notes.items.filter((item) => item.id !== id);
  if (state.notes.currentId === id) {
    state.notes.currentId = null;
    state.notes.draft = '';
    els.notesEditor.value = '';
  }
  renderNotesAll();
  const local = loadLocalNotes(state.video?.id ?? '');
  saveLocalNotes(state.video?.id ?? '', local.filter((item) => item.id !== id));
  if (isLocalNoteId(id) || state.notes.apiAvailable === false) {
    toast('笔记已删除', 'ok', 1800);
    return;
  }
  try {
    await notesFetch(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('笔记已删除', 'ok', 1800);
    logEvent('notes', `删除笔记 ${id}`, 'warn');
  } catch (error) {
    state.notes.items = previousItems;
    renderNotesAll();
    toast(`删除失败：${error.message}`, 'err');
  }
}

// ---------------------------------------------------------------- 自动保存

function scheduleNotesSave() {
  if (!state.notes.currentId) return;
  state.notes.dirty = true;
  setNotesStatus('编辑中…');
  clearTimeout(state.notes.saveTimer);
  state.notes.saveTimer = setTimeout(() => void flushNotesSave(), 600);
}

function collectNotePatch(note) {
  const patch = {
    body: state.notes.draft,
    tMs: Math.max(0, Math.round(Number(note?.tMs) || 0)),
    tags: state.notes.tags,
    quotes: state.notes.quotes,
    kind: state.notes.noteKind,
  };
  if (state.notes.imageUrl) patch.imageUrl = state.notes.imageUrl;
  return patch;
}

async function flushNotesSave() {
  clearTimeout(state.notes.saveTimer);
  state.notes.saveTimer = null;
  const note = currentNote();
  if (!note) return;
  if (!state.notes.dirty) return;
  const patch = collectNotePatch(note);
  Object.assign(note, {
    body: patch.body,
    tMs: patch.tMs,
    tags: patch.tags,
    quotes: patch.quotes,
    kind: patch.kind,
    updatedAt: new Date().toISOString(),
    ...(patch.imageUrl ? { imageUrl: patch.imageUrl } : {}),
  });
  state.notes.dirty = false;
  renderNotesList();
  if (isLocalNoteId(note.id) || state.notes.apiAvailable === false) {
    persistLocalNote(note);
    setNotesStatus('已保存到 localStorage', 'offline');
    els.notesOfflineBanner.hidden = false;
    return;
  }
  state.notes.saving = true;
  setNotesStatus('保存中…', 'saving');
  try {
    const payload = await notesFetch(`/api/notes/${encodeURIComponent(note.id)}`, { method: 'PUT', body: patch });
    if (payload?.note) Object.assign(note, payload.note);
    state.notes.lastSavedAt = Date.now();
    setNotesStatus(`已保存 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`, 'saved');
    scheduleObsidianStatusRefresh();
  } catch (error) {
    markNotesOffline(error, { toastOnce: false });
    persistLocalNote(note);
    setNotesStatus('离线暂存（localStorage）', 'offline');
    toast(`保存失败，已暂存到 localStorage：${error.message}`, 'warn', 6000);
  } finally {
    state.notes.saving = false;
    renderNotesEditorChrome();
  }
}

async function syncLocalNotes() {
  if (!state.video || state.notes.syncing) return;
  state.notes.syncing = true;
  setNotesStatus('同步中…', 'saving');
  try {
    await notesFetch(`/api/notes?videoId=${encodeURIComponent(state.video.id)}&limit=1`);
    const local = loadLocalNotes(state.video.id);
    let synced = 0;
    for (const note of local) {
      try {
        if (isLocalNoteId(note.id)) {
          await notesFetch('/api/notes', {
            method: 'POST',
            body: { video: note.video, tMs: note.tMs, body: note.body, kind: note.kind, source: note.source ?? 'studio', quotes: note.quotes, tags: note.tags, imageUrl: note.imageUrl },
          });
        } else {
          await notesFetch(`/api/notes/${encodeURIComponent(note.id)}`, {
            method: 'PUT',
            body: { body: note.body, tMs: note.tMs, tags: note.tags, quotes: note.quotes, kind: note.kind, imageUrl: note.imageUrl },
          });
        }
        synced += 1;
      } catch {
        /* 单条失败保留在 localStorage */
      }
    }
    if (synced >= local.length) saveLocalNotes(state.video.id, []);
    state.notes.localOnlyCount = Math.max(0, local.length - synced);
    state.notes.offline = state.notes.localOnlyCount > 0;
    els.notesOfflineBanner.hidden = !state.notes.offline;
    await refreshNotes({ silent: true });
    toast(`已同步 ${synced} 条本地笔记到引擎`, 'ok');
    logEvent('notes', `localStorage 同步：${synced}/${local.length} 条`, 'ok');
  } catch (error) {
    markNotesOffline(error, { toastOnce: true });
  } finally {
    state.notes.syncing = false;
    renderNotesAll();
  }
}

// ------------------------------------------------------------ 编辑器插入

function insertIntoNotesEditor(insertion) {
  const textarea = els.notesEditor;
  const result = insertAtCursor(state.notes.draft, insertion, textarea.selectionStart, textarea.selectionEnd);
  state.notes.draft = result.value;
  textarea.value = result.value;
  textarea.focus();
  try {
    textarea.setSelectionRange(result.selectionStart, result.selectionEnd);
  } catch {
    /* ignore */
  }
  scheduleNotesSave();
  if (state.notes.tab === 'preview') renderNotesPreview();
}

function getCurrentBilingual() {
  if (state.sim.active && state.sim.parsed) {
    const snapshot = stateAt(state.sim.parsed, state.sim.clock || 0);
    const current = snapshot.current;
    if (current) return makeQuote({ src: current.src, dst: current.dst, t0Ms: current.t0Ms, t1Ms: current.t1Ms });
  }
  if (state.currentSegmentId) {
    const segment = state.segments.get(state.currentSegmentId);
    if (segment) return makeQuote({ src: segment.text, dst: segment.translation, t0Ms: segment.t0Ms, t1Ms: segment.t1Ms });
  }
  const segments = [...state.segments.values()].sort((a, b) => a.t0Ms - b.t0Ms);
  const last = segments[segments.length - 1];
  if (last) return makeQuote({ src: last.text, dst: last.translation, t0Ms: last.t0Ms, t1Ms: last.t1Ms });
  return null;
}

function insertCurrentQuote() {
  const quote = getCurrentBilingual();
  if (!quote) {
    toast('当前没有可插入的字幕：先播放视频并开启同传（演示回放模式也可）', 'warn');
    return;
  }
  const key = `${quote.t0Ms ?? ''}:${quote.src ?? ''}`;
  if (!state.notes.quotes.some((item) => `${item.t0Ms ?? ''}:${item.src ?? ''}` === key)) {
    state.notes.quotes.push(quote);
  }
  const block = `${buildQuoteMarkdown(quote)}\n`;
  insertIntoNotesEditor(block);
  renderNotesEditorChrome();
  toast('已插入当前双语字幕', 'ok', 1800);
}

function insertCurrentTimestamp() {
  const tMs = state.sim.active && state.sim.frozen ? state.sim.clock : Math.round((els.video.currentTime || 0) * 1000);
  insertIntoNotesEditor(`${timestampAnchor(tMs)} `);
}

function insertCodeBlock() {
  const textarea = els.notesEditor;
  const selected = state.notes.draft.slice(textarea.selectionStart, textarea.selectionEnd);
  insertIntoNotesEditor(`\`\`\`\n${selected}\n\`\`\`\n`);
}

async function captureVideoFrame() {
  const width = els.video.videoWidth;
  const height = els.video.videoHeight;
  if (!width || !height) throw new Error('视频还没有可截取的画面');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.drawImage(els.video, 0, 0, width, height);
  return await new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('生成 PNG 失败'))), 'image/png');
    } catch (error) {
      reject(error);
    }
  });
}

async function insertScreenshot() {
  try {
    const blob = await captureVideoFrame();
    const response = await fetch('/api/notes/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: blob,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.url) throw new Error(data.message ?? data.error ?? `HTTP ${response.status}`);
    state.notes.imageUrl = data.url;
    insertIntoNotesEditor(`![截图 @ ${formatNoteTimestamp(els.video.currentTime * 1000)}](${data.url})\n`);
    toast('截图已保存到笔记 assets 并插入正文', 'ok', 3200);
    logEvent('notes', `截图已上传 ${data.url}`, 'ok');
  } catch (error) {
    toast(`截图失败：${error.message}（跨域视频无法读取画面；本地文件/同源视频可用）`, 'err', 7000);
    logEvent('notes', `截图失败：${error.message}`, 'err');
  }
}

function applyNotesTagsFromInput() {
  state.notes.tags = parseTags(els.notesTagsInput.value);
  els.notesTagsInput.value = state.notes.tags.join(', ');
  els.notesTagsValue.textContent = state.notes.tags.length > 0 ? `标签：${state.notes.tags.join('、')}` : '无标签';
  scheduleNotesSave();
}

/** 写入当前笔记正文并立即保存（供调试/自动化使用） */
async function writeCurrentNoteBody(body) {
  if (!currentNote()) await createNoteAtCurrentTime();
  state.notes.draft = String(body ?? '');
  els.notesEditor.value = state.notes.draft;
  state.notes.dirty = true;
  await flushNotesSave();
  renderNotesAll();
}

// ---------------------------------------------------------------- 大纲/导出

function getSessionSegments() {
  if (state.sim.active && state.sim.parsed) {
    return [...state.sim.parsed.segments.values()].map((segment) => ({
      t0Ms: segment.t0Ms,
      t1Ms: segment.t1Ms,
      text: segment.text,
      translation: segment.translation,
    }));
  }
  const live = [...state.segments.values()]
    .sort((a, b) => a.t0Ms - b.t0Ms)
    .map((segment) => ({ t0Ms: segment.t0Ms, t1Ms: segment.t1Ms, text: segment.text, translation: segment.translation }));
  if (live.length > 0) return live;
  return (state.pageCues ?? []).map((cue) => ({
    t0Ms: cue.t0Ms,
    t1Ms: cue.t1Ms,
    text: cue.text,
    translation: cue.translation ?? '',
  }));
}

async function generateOutlineNote() {
  const video = currentVideoRef();
  if (!video) {
    toast('请先载入视频', 'warn');
    return;
  }
  const segments = getSessionSegments().filter((segment) => segment.text || segment.translation);
  if (segments.length === 0) {
    toast('还没有字幕可生成大纲：先播放并同传，或载入带字幕的课程页', 'warn', 5200);
    return;
  }
  const body = buildOutlineMarkdown({ video, segments, langFrom: 'en', langTo: 'zh' });
  const note = await createNoteAtCurrentTime({ body, kind: 'outline' });
  if (note) {
    toast(`已生成课程大纲（${segments.length} 段字幕），可直接编辑`, 'ok', 4200);
    logEvent('notes', `生成课程大纲笔记（${segments.length} 段）`, 'ok');
    focusNotesEditor();
  }
}

async function getNotesExportMarkdown() {
  const video = currentVideoRef();
  if (!video) return '';
  if (state.notes.apiAvailable) {
    try {
      const response = await fetch(`/api/notes/export.md?videoId=${encodeURIComponent(video.id)}`, { cache: 'no-store' });
      if (response.ok) return await response.text();
    } catch {
      /* fall through */
    }
  }
  return buildNotesMarkdown({ video, notes: state.notes.items, langFrom: 'en', langTo: 'zh' });
}

async function exportNotes(kind) {
  const video = currentVideoRef();
  if (!video) {
    toast('请先载入视频', 'warn');
    return;
  }
  if (kind === 'obsidian') {
    els.notesExportMenu.open = false;
    await syncCurrentVideoToObsidian();
    return;
  }
  await flushNotesSave();
  try {
    if (kind === 'write') {
      const payload = await notesFetch('/api/notes/export', { method: 'POST', body: { videoId: video.id } });
      toast(`已写入 ${payload.path}`, 'ok', 6500);
      logEvent('notes', `导出到 ${payload.path}`, 'ok');
      return;
    }
    const markdown = await getNotesExportMarkdown();
    if (!markdown.trim()) {
      toast('导出内容为空', 'warn');
      return;
    }
    if (kind === 'copy') {
      await copyText(markdown, 'Markdown 已复制到剪贴板');
    } else {
      downloadTextFile(buildNoteExportFilename(video.title), markdown, 'text/markdown;charset=utf-8');
      toast('Markdown 已下载', 'ok');
    }
  } catch (error) {
    toast(`导出失败：${error.message}`, 'err', 5200);
    logEvent('notes', `导出失败：${error.message}`, 'err');
  } finally {
    els.notesExportMenu.open = false;
  }
}

// ---------------------------------------------------------------- 画中画

async function togglePip() {
  if (!state.video) {
    toast('请先载入视频', 'warn');
    return;
  }
  if (!document.pictureInPictureEnabled || typeof els.video.requestPictureInPicture !== 'function') {
    toast('当前浏览器不支持画中画（需要 Chrome/Edge 等桌面浏览器）', 'warn', 5000);
    return;
  }
  try {
    if (document.pictureInPictureElement === els.video) {
      await document.exitPictureInPicture();
    } else {
      await els.video.requestPictureInPicture();
      logEvent('player', '已进入画中画（可边看边在外部编辑器写代码）', 'ok');
    }
  } catch (error) {
    toast(`画中画失败：${error.message}`, 'err', 5000);
  }
}

// ================================================= v0.5 图文笔记（OCR/VLM/关键帧）

async function loadVisionHealth({ silent = true } = {}) {
  state.vision.checking = true;
  renderVisionAvailability();
  try {
    const response = await fetch('/api/vision/health', { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message ?? payload.error ?? `HTTP ${response.status}`);
    const normalized = normalizeVisionHealth(payload);
    state.vision = { available: normalized.available, health: normalized, checkedAt: Date.now(), checking: false, error: '' };
    if (!silent) logEvent('vision', `视觉健康：OCR ${normalized.ocrAvailable ? '可用' : '不可用'} · VLM ${normalized.visionAvailable ? '可用' : '不可用'}`, normalized.available ? 'ok' : 'warn');
  } catch (error) {
    state.vision = {
      available: false,
      health: normalizeVisionHealth({ ok: false, message: error.message }),
      checkedAt: Date.now(),
      checking: false,
      error: error.message,
    };
    if (!silent) logEvent('vision', `视觉引擎未就绪：${error.message}`, 'warn');
  }
  renderVisionAvailability();
  return state.vision;
}

function renderVisionAvailability() {
  const available = state.vision.available === true;
  const visionAvailable = Boolean(state.vision.health?.visionAvailable);
  const ocrAvailable = Boolean(state.vision.health?.ocrAvailable);
  if (els.btnNotesVisual) {
    els.btnNotesVisual.disabled = !state.video;
    els.btnNotesVisual.title = !state.video
      ? '先载入视频'
      : available
        ? '翻译、笔记、因果可以一起做'
        : '视觉引擎未就绪时仍可只做翻译';
  }
  if (els.visualVlm) {
    els.visualVlm.disabled = !available || !visionAvailable;
    if (!visionAvailable) els.visualVlm.checked = false;
  }
  if (els.visualVisionBadge) {
    els.visualVisionBadge.textContent = state.vision.checking
      ? '视觉引擎检测中…'
      : available
        ? `OCR ${ocrAvailable ? '可用' : '不可用'} · VLM ${visionAvailable ? '可用' : '不可用'}`
        : '视觉引擎未就绪';
    els.visualVisionBadge.className = `tag ${available ? (visionAvailable ? 'ok' : '') : 'warn'}`.trim();
  }
  if (els.btnVisualStart) {
    const blocked = visualStartBlocked();
    els.btnVisualStart.disabled = blocked;
    els.btnVisualStart.title = blocked ? '笔记和因果需要视觉引擎（/api/vision 返回 503）。可以只做翻译' : '按勾选的任务处理这段课';
  }
  if (els.visualFootHint) {
    els.visualFootHint.textContent = !available
      ? '视觉引擎未就绪：笔记和因果先不可用，翻译可以做'
      : visionAvailable
        ? '视频语音按顺序备胎；已有字幕、笔记、因果会问过每个勾选的模型'
        : '默认仅 OCR（快）；VLM 未配置，无法开启';
  }
  renderVisualPlan();
}

function visualDurationMs() {
  if (Number.isFinite(els.video.duration) && els.video.duration > 0) return Math.round(els.video.duration * 1000);
  if (state.sim.parsed && state.sim.maxMs > 0) return state.sim.maxMs;
  return Math.max(1000, state.maxEndMs, pageCueEndMs(), Math.round((els.video.currentTime || 0) * 1000));
}

function computeVisualRange() {
  const durationMs = visualDurationMs();
  const nowMs =
    state.sim.active && state.sim.frozen ? Math.round(state.sim.clock || 0) : Math.round((els.video.currentTime || 0) * 1000);
  if (state.visual.range === 'all') return { startMs: 0, endMs: durationMs };
  const startMs = Math.max(0, Math.min(durationMs - 1000, nowMs));
  return { startMs, endMs: durationMs };
}

function setVisualMode(mode) {
  state.visual.mode = mode === 'chapters' ? 'chapters' : 'single';
  for (const button of els.visualMode.querySelectorAll('button[data-mode]')) {
    const active = button.dataset.mode === state.visual.mode;
    button.setAttribute('aria-pressed', String(active));
    button.dataset.active = String(active);
  }
  renderVisualPlan();
}

function estimateChapterCount(range) {
  const segments = getSessionSegments().filter((segment) => segment.t1Ms >= range.startMs && segment.t0Ms <= range.endMs);
  const chapters = computeChapters(segments, [], { minGapMs: 2500, minChapterMs: 20000, maxChapterMs: 180000, maxChapters: 30 });
  return Math.max(1, chapters.length);
}

function setVisualRange(range) {
  state.visual.range = range === 'all' ? 'all' : 'rest';
  for (const button of els.visualRange.querySelectorAll('button[data-range]')) {
    const active = button.dataset.range === state.visual.range;
    button.setAttribute('aria-pressed', String(active));
    button.dataset.active = String(active);
  }
  renderVisualPlan();
}

function renderVisualPlan() {
  if (!els.visualPlan) return;
  const options = resolveKeyframeOptions(state.config);
  const range = computeVisualRange();
  const candidates = sampleTimes({
    startMs: range.startMs,
    endMs: range.endMs,
    intervalMs: options.intervalMs,
    maxCandidates: options.maxFrames * 6,
  }).length;
  const vlm = Boolean(state.visual.vlm && state.vision.health?.visionAvailable);
  const parts = [
    `范围 ${formatNoteTimestamp(range.startMs)} – ${formatNoteTimestamp(range.endMs)}（${((range.endMs - range.startMs) / 1000).toFixed(1)}s）`,
    `每 ${(options.intervalMs / 1000).toFixed(0)}s 采样 ${candidates} 个候选点`,
    `差异阈值 ${(options.minChange * 100).toFixed(1)}%`,
    vlm ? `VLM 画面理解（每 ${options.sheetSize} 帧一批，较慢）` : '仅 OCR（快、离线、免费）',
  ];
  if (state.visual.mode === 'chapters') {
    const estimated = estimateChapterCount(range);
    parts.splice(1, 0, `按章节 · 预计 ${estimated} 章 · 每章最多 6 帧`);
    parts.push(`全部章节完成后自动生成课程总览（kind:outline）`);
  } else {
    parts.splice(2, 0, `最多 ${options.maxFrames} 个关键帧`);
  }
  const plan = readCoursePlan();
  const jobs = [
    plan.jobs.translate ? (plan.translateSource === 'subtitles' ? '翻译已有字幕' : '翻译视频语音') : '',
    plan.jobs.notes ? '笔记' : '',
    plan.jobs.causal ? '因果' : '',
  ].filter(Boolean);
  const modelText = (plan.liveChain ?? plan.models.translate).join(' → ');
  parts.unshift(jobs.join(' + ') || '未选任务');
  if (modelText) parts.push(plan.liveChain ? `同传备胎 ${modelText}` : `模型 ${modelText}`);
  els.visualPlan.textContent = parts.join(' · ');
}

function setVisualProgress(text, percent) {
  els.visualProgress.hidden = false;
  els.visualProgressText.textContent = text;
  els.visualProgressBar.style.width = `${clamp(percent, 0, 100)}%`;
  const step = visualStepForText(text);
  if (step) applyVisualSteps(step);
}

function openVisualModal() {
  if (!state.video) {
    toast('请先载入视频，再生成图文笔记', 'warn');
    return;
  }
  state.visual.open = true;
  els.visualModal.hidden = false;
  els.visualModal.setAttribute('aria-hidden', 'false');
  els.visualVideoTitle.textContent = state.video.title;
  els.visualError.hidden = true;
  els.visualVlm.checked = Boolean(state.visual.vlm && state.vision.health?.visionAvailable);
  applyVisualSteps(null);
  for (const button of els.visualMode.querySelectorAll('button[data-mode]')) {
    const active = button.dataset.mode === state.visual.mode;
    button.setAttribute('aria-pressed', String(active));
    button.dataset.active = String(active);
  }
  setVisualRange(state.visual.range);
  renderCourseModels();
  setTranslateSource(state.visual.translateSource);
  if (state.vision.checkedAt == null || Date.now() - state.vision.checkedAt > 30_000) void loadVisionHealth({ silent: false });
  else renderVisionAvailability();
}

function closeVisualModal({ force = false } = {}) {
  if (state.visual.running && !force) {
    toast('正在生成图文笔记：可以先取消或等待完成', 'warn');
    return;
  }
  state.visual.open = false;
  els.visualModal.hidden = true;
  els.visualModal.setAttribute('aria-hidden', 'true');
}

function checkVisualCancel() {
  if (state.visual.cancelled) {
    const error = new Error('cancelled');
    error.name = 'AbortError';
    throw error;
  }
}

function cancelVisualRun() {
  if (!state.visual.running) return;
  state.visual.cancelled = true;
  try {
    state.visual.abort?.abort();
  } catch {
    /* ignore */
  }
  setVisualProgress('正在取消…', 0);
}

// ---------------------------------------------------------- 画面采样/截图

/** 等待视频把 seek 后的新帧呈现出来（rVFC 优先，其次 rAF 双帧），避免 canvas 拿到旧帧 */
function waitForVideoFramePresented(video, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(300, timeoutMs));
    try {
      if (typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(() => finish());
        return;
      }
    } catch {
      /* fall through */
    }
    requestAnimationFrame(() => requestAnimationFrame(finish));
  });
}

/** seek 到指定时间并等 seeked（超时 best-effort resolve） */
function seekVideoForCapture(tMs, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const duration = Number.isFinite(els.video.duration) && els.video.duration > 0 ? els.video.duration : 0;
    if (duration <= 0) {
      reject(new Error('视频尚未加载完成（需要先播放/等待元数据）'));
      return;
    }
    const targetSeconds = Math.max(0, Math.min(duration, (Number(tMs) || 0) / 1000));
    if (Math.abs(els.video.currentTime - targetSeconds) < 0.02) {
      waitForVideoFramePresented(els.video).then(resolve);
      return;
    }
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      els.video.removeEventListener('seeked', onSeeked);
      if (error) reject(error);
      else waitForVideoFramePresented(els.video).then(resolve);
    };
    const onSeeked = () => finish();
    const timer = setTimeout(() => finish(), Math.max(1000, timeoutMs));
    els.video.addEventListener('seeked', onSeeked, { once: true });
    try {
      els.video.currentTime = targetSeconds;
    } catch (error) {
      finish(error);
    }
  });
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('画面图片加载失败'));
    };
    image.src = url;
  });
}

/** 抓取某一时刻的整帧 PNG + 64x36 灰度签名（用于关键帧去重） */
async function grabFrameAt(tMs) {
  await seekVideoForCapture(tMs);
  const decodeStarted = performance.now();
  while (els.video.readyState < 2 && performance.now() - decodeStarted < 800) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const width = els.video.videoWidth;
  const height = els.video.videoHeight;
  if (!width || !height) throw new Error('视频还没有可读取的画面（先播放一下或等待加载）');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.drawImage(els.video, 0, 0, width, height);
  const blob = await new Promise((resolve, reject) => {
    try {
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('生成画面 PNG 失败'))), 'image/png');
    } catch (error) {
      reject(error);
    }
  });
  const small = document.createElement('canvas');
  small.width = 64;
  small.height = 36;
  const smallContext = small.getContext('2d');
  smallContext.drawImage(canvas, 0, 0, 64, 36);
  const gray = toGrayscale(smallContext.getImageData(0, 0, 64, 36).data, 64, 36);
  return { blob, gray };
}

/** 2x3 拼图（关键帧批次 -> VLM 单次理解） */
async function buildContactSheet(frames) {
  const layout = contactSheetLayout(frames.length, { width: 1280, height: 960 });
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const context = canvas.getContext('2d');
  context.fillStyle = '#0b0f18';
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (const slot of layout.slots) {
    const frame = frames[slot.index];
    if (!frame) continue;
    try {
      const image = await blobToImage(frame.blob);
      context.drawImage(image, slot.x, slot.y, slot.width, slot.height);
    } catch {
      context.fillStyle = '#1a2030';
      context.fillRect(slot.x, slot.y, slot.width, slot.height);
    }
    context.fillStyle = 'rgba(8, 12, 20, 0.88)';
    context.fillRect(slot.x, slot.y + slot.height, slot.width, slot.labelHeight);
    context.fillStyle = '#7ff0df';
    context.font = '13px monospace';
    context.fillText(`${formatNoteTimestamp(frame.tMs)} · 帧 ${frame.index ?? slot.index + 1}`, slot.x + 6, slot.y + slot.height + 16);
  }
  return await new Promise((resolve, reject) => {
    try {
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('拼图生成失败'))), 'image/png');
    } catch (error) {
      reject(error);
    }
  });
}

/** 单次异步操作超时（OCR 首帧本地 Vision 初始化可能 ~6s；15s 兜底，失败跳过该帧） */
function timeoutAfter(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label}超时（${Math.round(timeoutMs / 1000)} 秒）`);
      error.name = 'TimeoutError';
      reject(error);
    }, Math.max(1000, Math.round(timeoutMs) || 15000));
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function uploadVisualAsset(blob, signal = null) {
  const payload = await notesFetch('/api/notes/assets', {
    method: 'POST',
    rawBody: blob,
    headers: { 'Content-Type': 'image/png' },
    signal,
  });
  if (!payload?.url) throw new Error('上传截图失败（响应缺少 url）');
  return payload.url;
}

async function visionOcrAsset(imageUrl, signal = null) {
  return await notesFetch('/api/vision/ocr', { method: 'POST', body: { imageUrl }, signal });
}

async function visionAnalyzeSheet(blob, signal = null) {
  return await notesFetch('/api/vision/analyze?mode=vision', {
    method: 'POST',
    rawBody: blob,
    headers: { 'Content-Type': 'image/png' },
    signal,
  });
}

async function visionSummarize(payload, signal = null) {
  return await notesFetch('/api/vision/summarize', { method: 'POST', body: payload, signal });
}

function selectedCourseModels() {
  if (!els.courseModels) return [];
  return [...els.courseModels.querySelectorAll('input[type="checkbox"][data-model]')]
    .filter((input) => input.checked)
    .map((input) => input.dataset.model)
    .filter(Boolean);
}

function readCoursePlan() {
  const available = availableCourseModels(state.config);
  const selected = selectedCourseModels();
  const shared = selected.length ? selected : available;
  return planCourseRun({
    jobs: {
      translate: els.jobTranslate ? els.jobTranslate.checked : true,
      notes: els.jobNotes ? els.jobNotes.checked : true,
      causal: els.jobCausal ? els.jobCausal.checked : true,
    },
    translateSource: state.visual.translateSource === 'subtitles' ? 'subtitles' : 'video',
    models: shared,
    availableModels: available.length ? available : shared,
  });
}

function visualStartBlocked() {
  const plan = readCoursePlan();
  const needsVision = plan.jobs.notes || plan.jobs.causal;
  if (!needsVision) return false;
  return state.vision.available !== true;
}

function renderCourseModels() {
  if (!els.courseModels) return;
  const models = availableCourseModels(state.config);
  const signature = models.join('|');
  if (els.courseModels.dataset.signature === signature && els.courseModels.childElementCount > 0) return;
  const previous = new Set(
    [...els.courseModels.querySelectorAll('input[data-model]')].filter((input) => input.checked).map((input) => input.dataset.model),
  );
  const keep = previous.size > 0;
  els.courseModels.replaceChildren();
  els.courseModels.dataset.signature = signature;
  if (models.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'muted';
    empty.textContent = '引擎配置里还没有翻译模型';
    els.courseModels.append(empty);
    return;
  }
  for (const name of models) {
    const label = document.createElement('label');
    label.className = 'toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.model = name;
    input.checked = keep ? previous.has(name) : true;
    const text = document.createElement('span');
    text.textContent = name;
    label.append(input, text);
    els.courseModels.append(label);
  }
}

function syncCourseForm() {
  if (els.courseSourceRow) els.courseSourceRow.hidden = Boolean(els.jobTranslate && !els.jobTranslate.checked);
  renderVisionAvailability();
}

function setTranslateSource(source) {
  state.visual.translateSource = source === 'subtitles' ? 'subtitles' : 'video';
  if (els.courseSource) {
    for (const button of els.courseSource.querySelectorAll('button[data-source]')) {
      const active = button.dataset.source === state.visual.translateSource;
      button.setAttribute('aria-pressed', String(active));
      button.dataset.active = String(active);
    }
  }
  syncCourseForm();
}

async function beginVideoTranslation(plan) {
  if (!plan.jobs.translate || plan.translateSource !== 'video') return;
  state.course.liveChain = plan.models.translate.slice();
  const chainText = plan.models.translate.join(' → ');
  if (state.sim.active) {
    toast('演示回放没有实时语音。翻译来源请改成「已有字幕」', 'warn', 5500);
    return;
  }
  if (!plan.models.translate.length) {
    toast('没有可用的翻译模型。请确认引擎配置里的 translate.chain', 'warn', 5500);
    return;
  }
  if (state.sessionActive) {
    toast(`同传已在进行。模型顺序 ${chainText} 从下次开始同传生效`, 'info', 5500);
    return;
  }
  await startSession();
  if (state.sessionActive) toast(`同传已开始。翻译按 ${chainText} 做备胎，第一家成功就用`, 'info', 6000);
}

async function translateRange(plan, segments, range, signal) {
  const models = plan.models.translate;
  if (!models.length) {
    toast('没有可用的翻译模型。请确认引擎配置里的 translate.chain', 'warn', 5500);
    return [];
  }
  const pool = segments.filter((segment) => segment.t1Ms >= range.startMs && segment.t0Ms <= range.endMs && String(segment.text ?? '').trim());
  const cues = pool.slice(0, 40).map((segment) => ({
    id: String(segment.t0Ms),
    t0Ms: segment.t0Ms,
    t1Ms: segment.t1Ms,
    text: segment.text,
  }));
  if (pool.length > cues.length) toast(`字幕超过 ${cues.length} 句，这次只翻译前 ${cues.length} 句`, 'info', 5000);
  if (cues.length === 0) return [];
  setVisualProgress(`翻译已有字幕（${models.length} 个模型）…`, 70);
  return translateSubtitleCues({
    cues,
    models,
    signal,
    translate: ({ text, provider, signal: inner }) => notesFetch('/api/translate', {
      method: 'POST',
      body: { text, provider },
      signal: inner,
    }),
  });
}

function overlayTranslations(segments, cues) {
  const byId = new Map((cues ?? []).filter((cue) => cue.text).map((cue) => [String(cue.t0Ms), cue.text]));
  if (byId.size === 0) return segments;
  return segments.map((segment) => {
    const text = byId.get(String(segment.t0Ms));
    return text ? { ...segment, translation: text } : segment;
  });
}

async function summarizeCourseDrafts({ title, transcript, visuals, plan, signal }) {
  const models = plan.jobs.notes ? plan.models.notes : plan.models.causal;
  const targets = models.length ? models : [''];
  const drafts = [];
  const errors = [];
  for (let index = 0; index < targets.length; index += 1) {
    checkVisualCancel();
    const provider = targets[index];
    setVisualProgress(`总结 ${provider || '默认模型'}（${index + 1}/${targets.length}）…`, 78);
    try {
      const result = await visionSummarize({
        title,
        transcript,
        visuals,
        lang: 'zh',
        ...(provider ? { provider } : {}),
      }, signal);
      drafts.push({
        provider: String(result?.provider ?? provider ?? 'model'),
        summary: String(result?.summary ?? ''),
        keyPoints: Array.isArray(result?.keyPoints) ? result.keyPoints : [],
        links: Array.isArray(result?.links) ? result.links : [],
      });
    } catch (error) {
      if (state.visual.cancelled || error?.name === 'AbortError') throw error;
      errors.push(`${provider || '模型'}：${error.message}`);
    }
  }
  return { drafts, errors };
}

function courseNoteParts({ plan, drafts, frames, segments }) {
  const merged = mergeNoteDrafts(drafts);
  const deterministic = linkSpeechAndVisuals({ frames, segments });
  const voted = plan.jobs.causal
    ? mergeCausalVotes({
      deterministic,
      modelSets: drafts.map((draft) => ({ provider: draft.provider, links: draft.links })),
    })
    : [];
  return {
    summary: plan.jobs.notes ? merged.summary : '',
    keyPoints: plan.jobs.notes ? merged.keyPoints : [],
    includeNotes: plan.jobs.notes,
    includeCausal: plan.jobs.causal,
    causalLinks: plan.jobs.causal ? applyModelCausalLinks(deterministic, voted) : [],
    extraNote: plan.jobs.translate && plan.translateSource === 'subtitles'
      ? '译文由勾选的模型分别生成：说法一致时采用多数，对不上时采用主模型（列表第一个）。实时同传不在这里合并。'
      : '',
  };
}

function finishVisualButtons() {
  if (!els.btnVisualStart) return;
  els.btnVisualStart.disabled = visualStartBlocked();
  els.btnVisualStart.textContent = '开始处理';
  if (els.btnVisualCancel) els.btnVisualCancel.hidden = true;
}

// ---------------------------------------------------------- 图文笔记生成

async function runSubtitleTranslation(plan, range) {
  state.visual.running = true;
  state.visual.cancelled = false;
  state.visual.lastError = null;
  state.visual.abort = new AbortController();
  const signal = state.visual.abort.signal;
  els.btnVisualStart.disabled = true;
  els.btnVisualStart.textContent = '处理中…';
  els.btnVisualCancel.hidden = false;
  els.visualError.hidden = true;
  els.visualProgress.hidden = false;
  try {
    const segments = getSessionSegments();
    const cues = await translateRange(plan, segments, range, signal);
    if (cues.length === 0) {
      toast('范围内还没有字幕。先播放并同传，或载入带字幕的课程页', 'warn', 5500);
      setVisualProgress('没有可翻译的字幕', 0);
      return;
    }
    setVisualProgress('保存字幕翻译…', 90);
    const markdown = formatTranslationMarkdown({ title: state.video.title, cues });
    const payload = await notesFetch('/api/notes', {
      method: 'POST',
      signal,
      body: {
        video: currentVideoRef(),
        tMs: range.startMs,
        body: markdown,
        kind: 'note',
        tags: ['字幕翻译'],
        source: 'studio',
      },
    });
    if (!payload?.note) throw new Error('保存字幕翻译失败（响应缺少 note）');
    await refreshNotes({ silent: true });
    selectNote(payload.note.id);
    await openNotesDrawer();
    setVisualProgress('完成 ✓', 100);
    toast(`字幕翻译已保存：${cues.length} 句，${plan.models.translate.length} 个模型`, 'ok', 6000);
    notifyObsidianAutoSync();
    setTimeout(() => closeVisualModal({ force: true }), 700);
  } catch (error) {
    if (state.visual.cancelled || error?.name === 'AbortError') {
      setVisualProgress('已取消', 0);
      toast('已取消字幕翻译', 'info');
    } else {
      els.visualError.hidden = false;
      els.visualError.textContent = `翻译失败：${error.message}`;
      setVisualProgress(`失败：${error.message}`, 0);
      toast(`字幕翻译失败：${error.message}`, 'err', 7000);
    }
  } finally {
    state.visual.running = false;
    state.visual.abort = null;
    finishVisualButtons();
  }
}

async function runVisualPipeline() {
  if (state.visual.running) return;
  const plan = readCoursePlan();
  state.visual.plan = plan;
  if (!plan.jobs.translate && !plan.jobs.notes && !plan.jobs.causal) {
    toast('请至少选择翻译、笔记、因果中的一项', 'warn');
    return;
  }
  if (!state.video) {
    toast('请先载入视频', 'warn');
    return;
  }
  await beginVideoTranslation(plan);
  const framesNeeded = Boolean(plan.jobs.notes || plan.jobs.causal);
  if (!plan.batchTranslate && !framesNeeded) return;
  if (framesNeeded && state.vision.available !== true) {
    toast('笔记和因果需要视觉引擎。/api/vision 返回 503 时，可以只做翻译', 'warn', 6500);
    return;
  }
  const range = computeVisualRange();
  if (range.endMs - range.startMs < 1000) {
    toast('范围太短（至少 1 秒），请切换范围或稍后再试', 'warn');
    return;
  }
  if (!framesNeeded && plan.batchTranslate) {
    await runSubtitleTranslation(plan, range);
    return;
  }
  if (state.visual.mode === 'chapters') return runChaptersPipeline();
  const options = resolveKeyframeOptions(state.config);
  state.visual.running = true;
  state.visual.cancelled = false;
  state.visual.lastError = null;
  state.visual.phase = 'sampling';
  state.visual.debug = { times: [], grabbed: 0, accepted: 0, ocrDone: 0, ocrFailed: 0, vlmDone: 0, summaryDone: false, saved: false };
  state.visual.abort = new AbortController();
  const signal = state.visual.abort.signal;
  els.btnVisualStart.disabled = true;
  els.btnVisualStart.textContent = '处理中…';
  els.btnVisualCancel.hidden = false;
  els.visualError.hidden = true;
  els.visualProgress.hidden = false;
  const wasPaused = els.video.paused;
  const originalTime = Number(els.video.currentTime) || 0;
  try {
    if (!wasPaused) els.video.pause();
    state.visual.sampling = true;
    setVisualProgress('采样关键帧…', 2);
    const times = sampleTimes({
      startMs: range.startMs,
      endMs: range.endMs,
      intervalMs: options.intervalMs,
      maxCandidates: options.maxFrames * 6,
    });
    state.visual.debug.times = times;
    const frames = [];
    let previousGray = null;
    for (let index = 0; index < times.length; index += 1) {
      checkVisualCancel();
      setVisualProgress(`采样中 ${index + 1}/${times.length}（已选 ${frames.length} 帧）`, 2 + ((index + 1) / times.length) * 18);
      const grab = await grabFrameAt(times[index]);
      state.visual.debug.grabbed += 1;
      if (frames.length === 0 || shouldAcceptFrame(previousGray, grab.gray, options.minChange)) {
        frames.push({ tMs: times[index], index: frames.length + 1, blob: grab.blob, imageUrl: '', ocrText: '', caption: '', lines: [] });
        previousGray = grab.gray;
        state.visual.debug.accepted = frames.length;
      }
      if (frames.length >= options.maxFrames) break;
    }
    state.visual.sampling = false;
    if (frames.length === 0) throw new Error('没有抽取到关键帧（可能范围太短或画面没有变化）');

    state.visual.phase = 'ocr';
    // 1) 本地 OCR（串行，避免把 OCR helper 打满；单帧 15s 超时，失败跳过继续）
    let ocrFailure = '';
    const ocrStartAt = Date.now();
    for (let index = 0; index < frames.length; index += 1) {
      checkVisualCancel();
      setVisualProgress(`识别中 ${index + 1}/${frames.length}…`, 20 + ((index + 1) / frames.length) * 35);
      const frame = frames[index];
      const frameStartedAt = Date.now();
      try {
        frame.imageUrl = await timeoutAfter(uploadVisualAsset(frame.blob, signal), 20_000, '上传截图');
        const result = await timeoutAfter(visionOcrAsset(frame.imageUrl, signal), 15_000, 'OCR 识别');
        frame.ocrText = String(result?.text ?? '');
        frame.lines = Array.isArray(result?.lines) ? result.lines : [];
        state.visual.debug.ocrDone += 1;
      } catch (error) {
        if (state.visual.cancelled || error?.name === 'AbortError') throw error;
        state.visual.debug.ocrFailed += 1;
        ocrFailure = ocrFailure || error.message;
      }
      const elapsed = Date.now() - frameStartedAt;
      if (index === 0 && elapsed > 5000) {
        toast('首次 OCR 引擎加载较慢（本地 Vision 首次初始化约 6s），后续帧会更快', 'info', 5000);
      }
    }
    if (ocrFailure) logEvent('vision', `部分帧 OCR 失败/超时已跳过：${ocrFailure}`, 'warn');
    logEvent('vision', `OCR 完成 ${frames.length} 帧，用时 ${Date.now() - ocrStartAt}ms`, 'mt');

    // 2) 可选 VLM：关键帧拼 2x3 图 -> 一次画面理解（每批 6 帧）
    const useVlm = Boolean(state.visual.vlm && state.vision.health?.visionAvailable);
    state.visual.phase = useVlm ? 'vlm' : 'summarize';
    if (useVlm) {
      const batches = [];
      for (let index = 0; index < frames.length; index += options.sheetSize) batches.push(frames.slice(index, index + options.sheetSize));
      let vlmFailure = '';
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        checkVisualCancel();
        setVisualProgress(`画面理解中（批次 ${batchIndex + 1}/${batches.length}，VLM 较慢）…`, 55 + ((batchIndex + 1) / batches.length) * 20);
        try {
          const sheet = await buildContactSheet(batches[batchIndex]);
          const analysis = await visionAnalyzeSheet(sheet, signal);
          const caption = String(analysis?.caption?.text ?? analysis?.caption?.summary ?? '').trim();
          if (caption) for (const frame of batches[batchIndex]) frame.caption = caption;
          state.visual.debug.vlmDone += 1;
        } catch (error) {
          if (state.visual.cancelled || error?.name === 'AbortError') throw error;
          vlmFailure = vlmFailure || error.message;
        }
      }
      if (vlmFailure) state.visual.lastError = `画面理解部分失败：${vlmFailure}`;
    }

    // 3) 已有字幕：每个模型都翻，再合并进笔记引用
    const coursePlan = state.visual.plan ?? readCoursePlan();
    let noteSegments = getSessionSegments();
    if (coursePlan.batchTranslate) {
      const cues = await translateRange(coursePlan, noteSegments, range, signal);
      noteSegments = overlayTranslations(noteSegments, cues);
      if (cues.length === 0) state.visual.lastError = state.visual.lastError ?? '范围内没有可翻译的字幕';
    }

    // 4) 笔记和因果：每个勾选的模型各总结一次，再合并
    state.visual.phase = 'summarize';
    const transcript = collectTranscript(noteSegments, { startMs: range.startMs, endMs: range.endMs, limit: 200 });
    const visuals = frames.map((frame) => ({
      tMs: frame.tMs,
      ocrText: frame.ocrText,
      ...(frame.caption ? { caption: frame.caption } : {}),
    }));
    let drafts = [];
    if (coursePlan.jobs.notes || coursePlan.jobs.causal) {
      const summarized = await summarizeCourseDrafts({ title: state.video.title, transcript, visuals, plan: coursePlan, signal });
      drafts = summarized.drafts;
      if (summarized.errors.length) state.visual.lastError = `总结部分失败（已保留成功的模型）：${summarized.errors.join('；')}`;
      if (drafts.length > 0) state.visual.debug.summaryDone = true;
      else if (!state.visual.lastError) state.visual.lastError = '总结失败（已保留 OCR 时间线）';
    }
    const noteParts = courseNoteParts({ plan: coursePlan, drafts, frames, segments: noteSegments });

    // 5) 组装 Markdown 并保存为 kind:'visual' 笔记
    state.visual.phase = 'save';
    setVisualProgress('组装并保存图文笔记…', 90);
    const markdown = buildVisualNoteMarkdown({
      title: state.video.title,
      summary: noteParts.summary,
      keyPoints: noteParts.keyPoints,
      frames,
      segments: noteSegments,
      range,
      langFrom: 'en',
      langTo: 'zh',
      generatedAt: new Date(),
      vlm: useVlm,
      includeNotes: noteParts.includeNotes,
      includeCausal: noteParts.includeCausal,
      causalLinks: noteParts.includeCausal ? noteParts.causalLinks : null,
      extraNote: noteParts.extraNote,
    });
    const payload = await notesFetch('/api/notes', {
      method: 'POST',
      signal,
      body: {
        video: currentVideoRef(),
        tMs: range.startMs,
        body: markdown,
        kind: 'visual',
        tags: visualNoteTags({
          vlm: useVlm,
          extra: ['OCR', ...((coursePlan.jobs.notes || coursePlan.jobs.causal) && (coursePlan.models.notes.length > 1 || coursePlan.models.causal.length > 1) ? ['多模型'] : [])],
        }),
        source: 'studio',
        ...(frames[0]?.imageUrl ? { imageUrl: frames[0].imageUrl } : {}),
      },
    });
    if (!payload?.note) throw new Error('保存图文笔记失败（响应缺少 note）');
    state.visual.debug.saved = true;
    await refreshNotes({ silent: true });
    selectNote(payload.note.id);
    await openNotesDrawer();
    setVisualProgress('完成 ✓', 100);
    const degraded = [
      ocrFailure ? `OCR 失败：${ocrFailure}` : '',
      state.visual.lastError ?? '',
    ].filter(Boolean);
    toast(
      `图文笔记已生成：${frames.length} 个关键帧、${transcript.length} 句字幕${useVlm ? ' + VLM 画面理解' : ''}${degraded.length ? '（部分降级）' : ''}`,
      degraded.length ? 'warn' : 'ok',
      6000,
    );
    logEvent('vision', `图文笔记 ${payload.note.id}：${frames.length} 帧 · ${markdown.length} 字符`, 'ok');
    if (degraded.length) logEvent('vision', degraded.join('；'), 'warn');
    notifyObsidianAutoSync();
    setTimeout(() => closeVisualModal({ force: true }), 700);
  } catch (error) {
    state.visual.phase = state.visual.cancelled ? 'cancelled' : 'error';
    if (state.visual.cancelled || error?.name === 'AbortError') {
      setVisualProgress('已取消', 0);
      toast('已取消图文笔记生成', 'info');
    } else {
      state.visual.lastError = error.message;
      els.visualError.hidden = false;
      els.visualError.textContent = `生成失败：${error.message}`;
      setVisualProgress(`失败：${error.message}`, 0);
      toast(`图文笔记生成失败：${error.message}`, 'err', 7000);
      logEvent('vision', `图文笔记生成失败：${error.message}`, 'err');
    }
  } finally {
    if (state.visual.phase !== 'error' && state.visual.phase !== 'cancelled') state.visual.phase = 'done';
    state.visual.running = false;
    state.visual.sampling = false;
    state.visual.abort = null;
    finishVisualButtons();
    try {
      els.video.currentTime = Math.min(Number.isFinite(els.video.duration) ? els.video.duration : originalTime, originalTime);
    } catch {
      /* ignore */
    }
    if (state.sim.active && state.sim.frozen) {
      state.sim.clock = Math.round(originalTime * 1000);
      applySimAt(state.sim.clock);
    } else if (!wasPaused) {
      els.video.play().catch(() => {});
    }
  }
}

/** 章节图文笔记：采样候选 -> computeChapters -> 逐章 OCR/总结/保存 -> 课程总览 */
async function runChaptersPipeline() {
  if (state.visual.running) return;
  if (!state.video) {
    toast('请先载入视频', 'warn');
    return;
  }
  if (state.vision.available !== true) {
    toast('视觉引擎未就绪：/api/vision 返回 503（需要 engine/vision/index.mjs 与本地 OCR 依赖）', 'warn', 6000);
    return;
  }
  const range = computeVisualRange();
  if (range.endMs - range.startMs < 1000) {
    toast('范围太短（至少 1 秒），请切换范围或稍后再试', 'warn');
    return;
  }
  const options = resolveKeyframeOptions(state.config);
  const perChapterMaxFrames = 6;
  state.visual.running = true;
  state.visual.cancelled = false;
  state.visual.lastError = null;
  state.visual.phase = 'sampling';
  state.visual.debug = { times: [], grabbed: 0, accepted: 0, chapters: 0, chapterNotes: 0, ocrDone: 0, ocrFailed: 0, vlmDone: 0, overview: false };
  state.visual.abort = new AbortController();
  const signal = state.visual.abort.signal;
  els.btnVisualStart.disabled = true;
  els.btnVisualStart.textContent = '处理中…';
  els.btnVisualCancel.hidden = false;
  els.visualError.hidden = true;
  els.visualProgress.hidden = false;
  const wasPaused = els.video.paused;
  const originalTime = Number(els.video.currentTime) || 0;
  let ocrFailure = '';
  try {
    if (!wasPaused) els.video.pause();
    state.visual.sampling = true;
    setVisualProgress('采样关键帧（章节模式）…', 2);
    const times = sampleTimes({
      startMs: range.startMs,
      endMs: range.endMs,
      intervalMs: options.intervalMs,
      maxCandidates: options.maxFrames * 6,
    });
    state.visual.debug.times = times;
    const frames = [];
    const candidates = [];
    let previousGray = null;
    for (let index = 0; index < times.length; index += 1) {
      checkVisualCancel();
      setVisualProgress(`采样中 ${index + 1}/${times.length}（候选 ${candidates.length}）`, 2 + ((index + 1) / times.length) * 14);
      const grab = await grabFrameAt(times[index]);
      state.visual.debug.grabbed += 1;
      const meanDiff = previousGray ? frameChangeRatio(previousGray, grab.gray) : 1;
      const structuralDiff = previousGray ? changedPixelRatio(previousGray, grab.gray) : 1;
      candidates.push({ tMs: times[index], changeRatio: Math.max(meanDiff, structuralDiff) });
      if (frames.length === 0 || shouldAcceptFrame(previousGray, grab.gray, options.minChange)) {
        frames.push({ tMs: times[index], index: frames.length + 1, blob: grab.blob, gray: grab.gray, imageUrl: '', ocrText: '', caption: '' });
        previousGray = grab.gray;
        state.visual.debug.accepted = frames.length;
      }
    }
    state.visual.sampling = false;
    const coursePlan = state.visual.plan ?? readCoursePlan();
    let noteSegments = getSessionSegments();
    if (coursePlan.batchTranslate) {
      const cues = await translateRange(coursePlan, noteSegments, range, signal);
      noteSegments = overlayTranslations(noteSegments, cues);
      if (cues.length === 0) state.visual.lastError = state.visual.lastError ?? '范围内没有可翻译的字幕';
    }
    const inRangeSegments = noteSegments.filter((segment) => segment.t1Ms >= range.startMs && segment.t0Ms <= range.endMs);
    let chapters = computeChapters(inRangeSegments, candidates, {
      minGapMs: 2500,
      minChapterMs: 20000,
      maxChapterMs: 180000,
      maxChapters: 30,
      changeThreshold: 0.035,
      snapMs: 2000,
    })
      .map((chapter) => ({
        ...chapter,
        startMs: Math.max(range.startMs, chapter.startMs),
        endMs: Math.min(range.endMs, chapter.endMs),
      }))
      .filter((chapter) => chapter.endMs > chapter.startMs)
      .map((chapter, index) => ({ ...chapter, index: index + 1 }));
    if (chapters.length === 0) {
      chapters = [{ index: 1, startMs: range.startMs, endMs: range.endMs, title: `第 1 章 · ${formatNoteTimestamp(range.startMs)}` }];
    }
    state.visual.debug.chapters = chapters.length;
    const useVlm = Boolean(state.visual.vlm && state.vision.health?.visionAvailable);
    const chapterNotes = [];
    const total = chapters.length;

    for (let chapterIndex = 0; chapterIndex < total; chapterIndex += 1) {
      checkVisualCancel();
      const chapter = chapters[chapterIndex];
      const chapterRange = { startMs: chapter.startMs, endMs: chapter.endMs };
      const prefix = `章节 ${chapterIndex + 1}/${total}`;
      let chapterFrames = frames.filter((frame) => frame.tMs >= chapter.startMs && frame.tMs <= chapter.endMs);
      if (chapterFrames.length === 0) {
        const targetMs = Math.min(chapter.endMs, chapter.startMs + Math.max(1000, (chapter.endMs - chapter.startMs) / 2));
        const grab = await grabFrameAt(targetMs);
        chapterFrames = [{ tMs: targetMs, index: 1, blob: grab.blob, gray: grab.gray, imageUrl: '', ocrText: '', caption: '' }];
      }
      if (chapterFrames.length > perChapterMaxFrames) {
        const picked = [];
        for (let slot = 0; slot < perChapterMaxFrames; slot += 1) {
          const index = Math.round((slot * (chapterFrames.length - 1)) / (perChapterMaxFrames - 1));
          picked.push(chapterFrames[index]);
        }
        chapterFrames = [...new Set(picked)];
      }

      for (let frameIndex = 0; frameIndex < chapterFrames.length; frameIndex += 1) {
        checkVisualCancel();
        setVisualProgress(
          `${prefix} · 识别中 ${frameIndex + 1}/${chapterFrames.length}`,
          16 + (chapterIndex / total) * 64 + (frameIndex / chapterFrames.length) * (64 / total),
        );
        const frame = chapterFrames[frameIndex];
        try {
          frame.imageUrl = await timeoutAfter(uploadVisualAsset(frame.blob, signal), 20_000, '上传截图');
          const result = await timeoutAfter(visionOcrAsset(frame.imageUrl, signal), 15_000, 'OCR 识别');
          frame.ocrText = String(result?.text ?? '');
          state.visual.debug.ocrDone += 1;
        } catch (error) {
          if (state.visual.cancelled || error?.name === 'AbortError') throw error;
          state.visual.debug.ocrFailed += 1;
          ocrFailure = ocrFailure || error.message;
        }
      }

      const firstOcrLine = chapterFrames
        .map((frame) => String(frame.ocrText ?? '').split('\n').map((line) => line.trim()).find(Boolean))
        .find(Boolean);
      if (firstOcrLine && /^第 \d+ 章/.test(String(chapter.title ?? ''))) {
        chapter.title = firstOcrLine.replace(/^#+\s*/, '').slice(0, 48);
      }

      if (useVlm) {
        const batches = [];
        for (let index = 0; index < chapterFrames.length; index += options.sheetSize) batches.push(chapterFrames.slice(index, index + options.sheetSize));
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
          checkVisualCancel();
          setVisualProgress(`${prefix} · 画面理解（批次 ${batchIndex + 1}/${batches.length}）…`, 16 + (chapterIndex / total) * 64 + 50 / total);
          try {
            const sheet = await buildContactSheet(batches[batchIndex]);
            const analysis = await visionAnalyzeSheet(sheet, signal);
            const caption = String(analysis?.caption?.text ?? analysis?.caption?.summary ?? '').trim();
            if (caption) for (const frame of batches[batchIndex]) frame.caption = caption;
            state.visual.debug.vlmDone += 1;
          } catch (error) {
            if (state.visual.cancelled || error?.name === 'AbortError') throw error;
            state.visual.lastError = `画面理解部分失败：${error.message}`;
          }
        }
      }

      setVisualProgress(`${prefix} · 总结中…`, 80 + (chapterIndex / total) * 10);
      const transcript = collectTranscript(noteSegments, { startMs: chapter.startMs, endMs: chapter.endMs, limit: 200 });
      const visuals = chapterFrames.map((frame) => ({
        tMs: frame.tMs,
        ocrText: frame.ocrText,
        ...(frame.caption ? { caption: frame.caption } : {}),
      }));
      let drafts = [];
      if (coursePlan.jobs.notes || coursePlan.jobs.causal) {
        const summarized = await summarizeCourseDrafts({
          title: `${state.video.title} · ${prefix} ${chapter.title}`,
          transcript,
          visuals,
          plan: coursePlan,
          signal,
        });
        drafts = summarized.drafts;
        if (summarized.errors.length && !state.visual.lastError) {
          state.visual.lastError = `第 ${chapterIndex + 1} 章总结部分失败：${summarized.errors.join('；')}`;
        }
      }
      const noteParts = courseNoteParts({ plan: coursePlan, drafts, frames: chapterFrames, segments: noteSegments });

      const markdown = buildVisualNoteMarkdown({
        title: state.video.title,
        summary: noteParts.summary,
        keyPoints: noteParts.keyPoints,
        frames: chapterFrames,
        segments: noteSegments,
        range: chapterRange,
        chapter: { index: chapterIndex + 1, total },
        langFrom: 'en',
        langTo: 'zh',
        generatedAt: new Date(),
        vlm: useVlm,
        includeNotes: noteParts.includeNotes,
        includeCausal: noteParts.includeCausal,
        causalLinks: noteParts.includeCausal ? noteParts.causalLinks : null,
        extraNote: noteParts.extraNote,
      });
      const payload = await notesFetch('/api/notes', {
        method: 'POST',
        signal,
        body: {
          video: currentVideoRef(),
          tMs: chapter.startMs,
          body: markdown,
          kind: 'visual',
          tags: visualNoteTags({
            vlm: useVlm,
            extra: ['章节', 'OCR', ...((coursePlan.jobs.notes || coursePlan.jobs.causal) && (coursePlan.models.notes.length > 1 || coursePlan.models.causal.length > 1) ? ['多模型'] : [])],
          }),
          source: 'studio',
          ...(chapterFrames[0]?.imageUrl ? { imageUrl: chapterFrames[0].imageUrl } : {}),
        },
      });
      if (!payload?.note) throw new Error(`第 ${chapterIndex + 1} 章保存失败（响应缺少 note）`);
      chapterNotes.push({ ...chapter, noteId: payload.note.id });
      state.visual.debug.chapterNotes = chapterNotes.length;
      logEvent('vision', `第 ${chapterIndex + 1}/${total} 章已保存 ${payload.note.id}`, 'ok');
    }

    // 课程总览：已有课程总览则更新，否则新建
    state.visual.phase = 'overview';
    setVisualProgress('生成课程总览…', 92);
    await refreshNotes({ silent: true });
    const overviewBody = buildCourseOverviewMarkdown({ video: currentVideoRef(), chapters: chapterNotes, generatedAt: new Date() });
    const existingOverview = state.notes.items.find(
      (note) => note?.kind === 'outline' && Array.isArray(note.tags) && note.tags.includes('课程总览') && note.video?.id === state.video.id,
    );
    let overviewId = null;
    if (existingOverview) {
      const payload = await notesFetch(`/api/notes/${encodeURIComponent(existingOverview.id)}`, {
        method: 'PUT',
        signal,
        body: { body: overviewBody, tags: ['课程总览'] },
      });
      overviewId = payload?.note?.id ?? existingOverview.id;
      logEvent('vision', `课程总览已更新 ${overviewId}`, 'ok');
    } else {
      const payload = await notesFetch('/api/notes', {
        method: 'POST',
        signal,
        body: { video: currentVideoRef(), tMs: range.startMs, body: overviewBody, kind: 'outline', tags: ['课程总览'], source: 'studio' },
      });
      overviewId = payload?.note?.id;
      if (!overviewId) throw new Error('课程总览保存失败（响应缺少 note）');
      logEvent('vision', `课程总览已创建 ${overviewId}`, 'ok');
    }
    state.visual.debug.overview = true;
    await refreshNotes({ silent: true });
    selectNote(overviewId);
    await openNotesDrawer();
    setVisualProgress('完成 ✓', 100);
    const degraded = [ocrFailure ? `OCR 失败：${ocrFailure}` : '', state.visual.lastError ?? ''].filter(Boolean);
    toast(
      `已生成 ${total} 章图文笔记 + 课程总览${useVlm ? '（含 VLM 画面理解）' : ''}${degraded.length ? '（部分降级）' : ''}`,
      degraded.length ? 'warn' : 'ok',
      7500,
    );
    logEvent('vision', `章节图文笔记完成：${total} 章 + 总览（${chapterNotes.length} 篇）`, 'ok');
    notifyObsidianAutoSync();
    setTimeout(() => closeVisualModal({ force: true }), 900);
  } catch (error) {
    state.visual.phase = state.visual.cancelled ? 'cancelled' : 'error';
    if (state.visual.cancelled || error?.name === 'AbortError') {
      setVisualProgress('已取消', 0);
      toast('已取消章节图文笔记生成（已完成的章节笔记会保留）', 'info');
    } else {
      state.visual.lastError = error.message;
      els.visualError.hidden = false;
      els.visualError.textContent = `生成失败：${error.message}`;
      setVisualProgress(`失败：${error.message}`, 0);
      toast(`章节图文笔记生成失败：${error.message}`, 'err', 7000);
      logEvent('vision', `章节图文笔记失败：${error.message}`, 'err');
    }
  } finally {
    if (state.visual.phase !== 'error' && state.visual.phase !== 'cancelled') state.visual.phase = 'done';
    state.visual.running = false;
    state.visual.sampling = false;
    state.visual.abort = null;
    finishVisualButtons();
    try {
      els.video.currentTime = Math.min(Number.isFinite(els.video.duration) ? els.video.duration : originalTime, originalTime);
    } catch {
      /* ignore */
    }
    if (state.sim.active && state.sim.frozen) {
      state.sim.clock = Math.round(originalTime * 1000);
      applySimAt(state.sim.clock);
    } else if (!wasPaused) {
      els.video.play().catch(() => {});
    }
  }
}

/** 图文笔记生成后：若启用了 Obsidian 自动同步，刷新状态并提示最终路径 */
function notifyObsidianAutoSync() {
  if (!state.obsidian.enabled || !state.obsidian.autoExport) return;
  setTimeout(async () => {
    await loadObsidianStatus({ silent: true });
    if (state.obsidian.lastPath) toast(`已自动同步到 Obsidian：${state.obsidian.lastPath}`, 'ok', 6500);
  }, 1400);
}

// ==================================================== v0.6 Obsidian 同步

function shortObsidianDir(status) {
  const raw = String(status?.dirRaw ?? '').trim();
  if (raw) return raw;
  const dir = String(status?.dir ?? '');
  return dir.length > 52 ? `…${dir.slice(-50)}` : dir;
}

function formatObsidianSyncAt(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return '—';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function renderObsidianStatus() {
  if (!els.obsidianStatusText) return;
  const obsidian = state.obsidian;
  const enabled = obsidian.loaded && obsidian.enabled && obsidian.configured;
  els.btnObsidianSync.disabled = !enabled || !state.video || obsidian.syncing;
  els.btnObsidianSync.title = enabled
    ? '把当前视频笔记同步到 Obsidian 目录（含截图与索引）'
    : 'Obsidian 未启用：在 config/livedub.config.json 的 notes.obsidian 中配置 enabled 与 dir';
  els.obsidianDot.className = 'notes-obsidian-dot';
  if (!obsidian.loaded) {
    els.obsidianStatusText.textContent = 'Obsidian：检测中…';
    return;
  }
  if (!obsidian.enabled) {
    els.obsidianDot.classList.add('off');
    els.obsidianStatusText.textContent = 'Obsidian：未启用（notes.obsidian.enabled=false）';
    return;
  }
  if (!obsidian.configured) {
    els.obsidianDot.classList.add('error');
    els.obsidianStatusText.textContent = `Obsidian：配置无效 · ${obsidian.reason || '检查 notes.obsidian.dir'}`;
    return;
  }
  els.obsidianDot.classList.add('on');
  const syncText = obsidian.syncing
    ? '同步中…'
    : obsidian.lastError
      ? `上次失败：${obsidian.lastError}`
      : obsidian.lastSyncedAt
        ? `最近同步 ${formatObsidianSyncAt(obsidian.lastSyncedAt)}`
        : '尚未同步';
  els.obsidianStatusText.textContent = `Obsidian：已启用 → ${shortObsidianDir(obsidian)} · ${syncText}${obsidian.autoExport ? ' · 自动同步开' : ''}`;
  els.obsidianStatusText.title = obsidian.lastPath ? `最近文件：${obsidian.lastPath}` : '';
}

async function loadObsidianStatus({ silent = true } = {}) {
  if (state.obsidian.loading) return;
  state.obsidian.loading = true;
  try {
    const payload = await notesFetch('/api/notes/obsidian/status');
    Object.assign(state.obsidian, payload, { loaded: true, loading: false });
  } catch (error) {
    Object.assign(state.obsidian, {
      loaded: true,
      loading: false,
      enabled: false,
      configured: false,
      lastError: error.message,
    });
    if (!silent) logEvent('notes', `Obsidian 状态读取失败：${error.message}`, 'warn');
  }
  renderObsidianStatus();
}

function scheduleObsidianStatusRefresh() {
  if (!state.notes.open) return;
  clearTimeout(state.obsidian.statusTimer);
  state.obsidian.statusTimer = setTimeout(() => void loadObsidianStatus({ silent: true }), 450);
}

async function syncCurrentVideoToObsidian() {
  const video = currentVideoRef();
  if (!video) {
    toast('请先载入视频', 'warn');
    return;
  }
  await flushNotesSave();
  state.obsidian.syncing = true;
  renderObsidianStatus();
  try {
    const payload = await notesFetch('/api/notes/export', { method: 'POST', body: { videoId: video.id, target: 'obsidian' } });
    toast(`已同步到 Obsidian：${payload.path}（${payload.assetsCopied ?? 0} 张截图）`, 'ok', 8000);
    logEvent('notes', `Obsidian 同步 ${payload.path}`, 'ok');
  } catch (error) {
    if (error.status === 409) toast(`Obsidian 未配置：${error.message}`, 'warn', 9000);
    else toast(`同步 Obsidian 失败：${error.message}`, 'err', 7000);
    logEvent('notes', `Obsidian 同步失败：${error.message}`, 'warn');
  } finally {
    state.obsidian.syncing = false;
    await loadObsidianStatus({ silent: true });
  }
}

// ============================================ v0.6 翻译参考画面文字（WS）

function renderVisualContextStatus() {
  if (!els.visualContextStatus) return;
  const context = state.visualContext;
  let text = describeVisualContext({
    enabled: context.enabled,
    lastTMs: context.lastTMs,
    lastChars: context.lastChars,
    pending: context.sending,
  });
  if (context.enabled && state.sim.active) text += ' · 回放模式仅本地识别';
  else if (context.enabled && state.sessionActive && !state.sessionReady) text += ' · 等待会话';
  els.visualContextStatus.textContent = text;
  els.visualContextStatus.classList.toggle('active', context.enabled);
  els.toggleVisualContext.checked = context.enabled;
}

/** 取当前画面（不 seek，直接读 video 当前帧） */
async function captureContextFrame() {
  const width = els.video.videoWidth;
  const height = els.video.videoHeight;
  if (!width || !height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.drawImage(els.video, 0, 0, width, height);
  const blob = await new Promise((resolve, reject) => {
    try {
      canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('画面导出失败'))), 'image/png');
    } catch (error) {
      reject(error);
    }
  });
  const small = document.createElement('canvas');
  small.width = 64;
  small.height = 36;
  const smallContext = small.getContext('2d');
  smallContext.drawImage(canvas, 0, 0, 64, 36);
  const gray = toGrayscale(smallContext.getImageData(0, 0, 64, 36).data, 64, 36);
  return { blob, gray };
}

async function tickVisualContext() {
  const context = state.visualContext;
  if (!context.enabled || context.sending) return;
  if (document.visibilityState === 'hidden') return;
  const simPlaying = state.sim.active && !state.sim.frozen && !(state.sim.maxMs > 0 && (state.sim.clock || 0) >= state.sim.maxMs);
  const realPlaying = !state.sim.active && state.sessionActive && state.sessionReady && !els.video.paused;
  if (!simPlaying && !realPlaying) return;
  context.sending = true;
  renderVisualContextStatus();
  try {
    const frame = await captureContextFrame();
    if (!frame) return;
    const diff = context.lastGray ? frameChangeRatio(context.lastGray, frame.gray) : 1;
    context.lastGray = frame.gray;
    if (diff < 0.02) return; // 轻量去重：画面几乎没变，不 OCR
    const response = await fetch('/api/vision/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: frame.blob,
      signal: AbortSignal.timeout?.(15000) ?? undefined,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.message ?? payload.error ?? `HTTP ${response.status}`);
    }
    const payload = await response.json();
    const text = normalizeVisualContextText(payload.text);
    if (!text) return;
    const tMs = state.sim.active ? Math.round(state.sim.clock || 0) : Math.round((els.video.currentTime || 0) * 1000);
    const decision = shouldSendVisualContext({
      enabled: true,
      text,
      lastText: context.lastText,
      changeRatio: diff,
      nowMs: Date.now(),
      lastSentAt: context.lastSentAt,
      minSendIntervalMs: 8000,
    });
    if (!decision.send) {
      if (decision.reason === 'duplicate' && !context.noSocketLogged) {
        context.noSocketLogged = true;
        logEvent('vision', '画面上下文：文字未变化，已去重', 'mt');
      }
      return;
    }
    const message = buildVisualContextPayload({ text: decision.text, tMs, capturedAtMs: Date.now() });
    if (!message) return;
    const sent = sendJson(message);
    context.lastText = decision.text;
    context.lastSentAt = Date.now();
    context.lastTMs = tMs;
    context.lastChars = decision.text.length;
    if (sent) {
      logEvent('vision', `画面上下文已发送 ${decision.text.length} 字 @ ${formatNoteTimestamp(tMs)}`, 'mt');
    } else if (!context.noSocketLogged) {
      context.noSocketLogged = true;
      logEvent('vision', '画面上下文：当前没有引擎连接（回放模式仅本地识别，不发送）', 'warn');
    }
    renderVisualContextStatus();
  } catch (error) {
    if (context.errorsLogged < 3) {
      context.errorsLogged += 1;
      logEvent('vision', `画面上下文失败（静默）：${error.message}`, 'warn');
    }
  } finally {
    context.sending = false;
    renderVisualContextStatus();
  }
}

function startVisualContextLoop() {
  const context = state.visualContext;
  if (!context.enabled) return;
  clearInterval(context.timer);
  context.timer = setInterval(() => void tickVisualContext(), 9000);
  context.timer.unref?.();
  renderVisualContextStatus();
}

function stopVisualContextLoop({ clearState = false } = {}) {
  const context = state.visualContext;
  clearInterval(context.timer);
  context.timer = null;
  if (clearState) {
    context.lastText = '';
    context.lastGray = null;
    context.lastTMs = null;
    context.lastChars = 0;
    context.lastSentAt = 0;
  }
  renderVisualContextStatus();
}

function setVisualContextEnabled(enabled) {
  const context = state.visualContext;
  context.enabled = Boolean(enabled);
  context.noSocketLogged = false;
  context.errorsLogged = 0;
  if (context.enabled) {
    startVisualContextLoop();
    toast('翻译参考画面文字已开启：每 8-10s 取画面 OCR 作为翻译语境（画面文字不会被翻译）', 'info', 6500);
    logEvent('vision', '画面上下文已开启', 'ok');
  } else {
    stopVisualContextLoop({ clearState: true });
    toast('翻译参考画面文字已关闭', 'info');
    logEvent('vision', '画面上下文已关闭', 'mt');
  }
  renderVisualContextStatus();
}

/** 调试用：只采样关键帧并返回帧间差异（不 OCR/不保存） */
async function debugSampleFrames({ limit = 7 } = {}) {
  const range = computeVisualRange();
  const options = resolveKeyframeOptions(state.config);
  const times = sampleTimes({
    startMs: range.startMs,
    endMs: range.endMs,
    intervalMs: options.intervalMs,
    maxCandidates: options.maxFrames * 6,
  }).slice(0, Math.max(1, limit));
  const wasPaused = els.video.paused;
  const originalTime = els.video.currentTime || 0;
  state.visual.sampling = true;
  if (!wasPaused) els.video.pause();
  const out = [];
  let previous = null;
  try {
    for (const tMs of times) {
      const grab = await grabFrameAt(tMs);
      const diff = previous ? frameChangeRatio(previous, grab.gray) : 1;
      const changed = previous ? changedPixelRatio(previous, grab.gray) : 1;
      out.push({ tMs, diff: Number(diff.toFixed(4)), changed: Number(changed.toFixed(4)) });
      previous = grab.gray;
    }
  } finally {
    state.visual.sampling = false;
    try {
      els.video.currentTime = Math.min(els.video.duration || Infinity, originalTime);
    } catch {
      /* ignore */
    }
    if (state.sim.active && state.sim.frozen) {
      state.sim.clock = Math.round(originalTime * 1000);
      applySimAt(state.sim.clock);
    } else if (!wasPaused) {
      els.video.play().catch(() => {});
    }
  }
  return { times, results: out, threshold: options.minChange };
}

// ------------------------------------------------ 捕获当前画面（插入笔记）

async function captureCurrentVisual() {
  if (!state.video) {
    toast('请先载入视频', 'warn');
    return;
  }
  if (!currentNote()) {
    const note = await createNoteAtCurrentTime();
    if (!note) return;
  }
  const tMs = state.sim.active && state.sim.frozen ? Math.round(state.sim.clock || 0) : Math.round((els.video.currentTime || 0) * 1000);
  try {
    const grab = await grabFrameAt(tMs);
    const imageUrl = await uploadVisualAsset(grab.blob);
    let ocrText = '';
    if (state.vision.available) {
      try {
        const result = await visionOcrAsset(imageUrl);
        ocrText = String(result?.text ?? '').trim();
      } catch (error) {
        toast(`画面 OCR 失败：${error.message}`, 'warn', 5000);
      }
    }
    let caption = '';
    if (state.visual.vlm && state.vision.health?.visionAvailable) {
      try {
        const analysis = await visionAnalyzeSheet(grab.blob);
        caption = String(analysis?.caption?.text ?? '').trim();
      } catch (error) {
        toast(`画面理解失败：${error.message}`, 'warn', 5000);
      }
    }
    if (!state.notes.imageUrl) state.notes.imageUrl = imageUrl;
    const parts = [`![画面 ${formatNoteTimestamp(tMs)}](${imageUrl})`];
    if (ocrText) parts.push('', '**画面文字（OCR）**', '', '```text', ...ocrText.split('\n').slice(0, 40), '```');
    if (caption) parts.push('', '**画面理解（VLM）**', '', caption);
    const quote = getCurrentBilingual();
    if (quote) {
      const existed = state.notes.quotes.some((item) => item.src === quote.src && item.t0Ms === quote.t0Ms);
      if (!existed) state.notes.quotes.push(quote);
      parts.push('', buildQuoteMarkdown(quote));
    }
    const causal = applyModelCausalLinks(linkSpeechAndVisuals({
      frames: [{ tMs, ocrText, caption }],
      segments: quote ? [{ t0Ms: quote.t0Ms, t1Ms: quote.t1Ms, text: quote.src, translation: quote.dst }] : [],
    }), []);
    if (causal.length > 0) parts.push('', '**因果关系**', '', formatCausalBullet(causal[0]));
    insertIntoNotesEditor(`${parts.join('\n')}\n`);
    await flushNotesSave();
    toast(ocrText ? '已捕获当前画面（截图 + OCR + 当前句）' : '已插入当前画面截图（OCR 不可用，仅截图）', 'ok', 4200);
    logEvent('vision', `捕获当前画面 @ ${formatNoteTimestamp(tMs)}${ocrText ? '' : '（OCR 不可用）'}`, 'ok');
  } catch (error) {
    toast(`捕获画面失败：${error.message}${/taint|Security|CORS/i.test(error.message) ? '（跨域视频无法读取画面）' : ''}`, 'err', 7000);
    logEvent('vision', `捕获画面失败：${error.message}`, 'err');
  }
}

// ---------------------------------------------------------------- 渲染

function renderNotesAll() {
  els.notesVideoTitle.textContent = state.video ? state.video.title : '未加载视频';
  els.notesCount.textContent = `${state.notes.items.length} 条`;
  updateNotesBadge(state.notes.items.length);
  if (els.dockNotesDot) els.dockNotesDot.hidden = state.notes.items.length === 0;
  els.btnNotesNew.disabled = !state.video;
  els.btnNotesOutline.disabled = !state.video;
  els.notesOfflineBanner.hidden = !state.notes.offline;
  renderNotesList();
  renderNotesEditorChrome();
}

function noteKindLabel(kind) {
  return { note: '笔记', outline: '大纲', quick: '摘录', marker: '标记', visual: '图文' }[kind] ?? '笔记';
}

function renderNotesList() {
  const query = state.notes.query;
  const filtered = filterNotes(sortNotesByTime(state.notes.items), query);
  const groups = groupNotesForDisplay(filtered, state.notes.filter);
  const total = groups.reduce((sum, group) => sum + group.notes.length, 0);
  els.notesList.textContent = '';
  els.notesListCount.textContent = `${total} 条`;
  if (total === 0) {
    const empty = document.createElement('div');
    empty.className = 'notes-empty-rich';
    empty.innerHTML = query
      ? '没有匹配的笔记，换个关键词试试'
      : '按 <kbd>N</kbd> 新建笔记，或用「图文笔记」按章节生成图文笔记<br />选中的笔记会显示在右侧编辑器';
    els.notesList.appendChild(empty);
    return;
  }
  for (const group of groups) {
    if (state.notes.filter === 'all') {
      const head = document.createElement('div');
      head.className = 'notes-group-head';
      head.textContent = `${group.title} · ${group.notes.length}`;
      els.notesList.appendChild(head);
    }
  for (const note of group.notes) {
    const item = document.createElement('div');
    item.className = `notes-item${note.id === state.notes.currentId ? ' active' : ''}`;
    item.dataset.noteId = note.id;
    item.setAttribute('role', 'button');
    item.tabIndex = 0;

    const time = document.createElement('span');
    time.className = 'notes-item-time';
    time.textContent = formatShortTimestamp(note.tMs);
    item.appendChild(time);

    const body = document.createElement('div');
    body.className = 'notes-item-body';
    const excerpt = document.createElement('span');
    excerpt.className = 'notes-item-excerpt';
    excerpt.textContent = noteExcerpt(note, 90);
    body.appendChild(excerpt);
    const meta = document.createElement('div');
    meta.className = 'notes-item-meta';
    const kind = document.createElement('span');
    kind.className = `notes-kind ${note.kind ?? 'note'}`;
    kind.textContent = noteKindLabel(note.kind);
    meta.appendChild(kind);
    const visualImages = note.kind === 'visual' ? extractImageUrls(note.body) : [];
    if (note.kind === 'visual' && visualImages.length > 0) {
      const imageBadge = document.createElement('span');
      imageBadge.textContent = `${visualImages.length} 图`;
      meta.appendChild(imageBadge);
    }
    if (Array.isArray(note.quotes) && note.quotes.length > 0) {
      const quoteBadge = document.createElement('span');
      quoteBadge.textContent = `${note.quotes.length} 条引用`;
      meta.appendChild(quoteBadge);
    }
    if (Array.isArray(note.tags) && note.tags.length > 0) {
      const tags = document.createElement('span');
      tags.textContent = note.tags.slice(0, 3).join(' · ');
      meta.appendChild(tags);
    }
    if (isLocalNoteId(note.id)) {
      const localBadge = document.createElement('span');
      localBadge.className = 'notes-kind marker';
      localBadge.textContent = '本地';
      meta.appendChild(localBadge);
    }
    body.appendChild(meta);
    item.appendChild(body);

    const thumbUrls = (visualImages.length > 0 ? visualImages : note.imageUrl ? [note.imageUrl] : []).slice(0, 3);
    if (thumbUrls.length > 1) {
      const thumbs = document.createElement('div');
      thumbs.className = 'notes-thumbs';
      for (const url of thumbUrls) {
        const thumb = document.createElement('img');
        thumb.src = url;
        thumb.alt = '画面截图';
        thumb.loading = 'lazy';
        thumbs.appendChild(thumb);
      }
      item.appendChild(thumbs);
    } else if (thumbUrls.length === 1) {
      const thumb = document.createElement('img');
      thumb.className = 'notes-thumb';
      thumb.src = thumbUrls[0];
      thumb.alt = '笔记截图';
      thumb.loading = 'lazy';
      item.appendChild(thumb);
    } else {
      const spacer = document.createElement('span');
      item.appendChild(spacer);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'notes-item-del';
    del.title = '删除这条笔记';
    del.setAttribute('aria-label', `删除 ${formatShortTimestamp(note.tMs)} 的笔记`);
    del.innerHTML = '<svg class="icon"><use href="#i-trash"/></svg>';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      void deleteNoteById(note.id);
    });
    item.appendChild(del);

    item.addEventListener('click', () => {
      selectNote(note.id);
      seekToNote(note);
    });
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectNote(note.id);
        seekToNote(note);
      }
    });
    els.notesList.appendChild(item);
  }
  }
}

function renderNotesPreview() {
  els.notesPreview.innerHTML = renderMarkdown(state.notes.draft);
}

function renderNotesPreviewIfVisible() {
  if (state.notes.tab === 'preview') renderNotesPreview();
}

function renderNotesEditorChrome() {
  const note = currentNote();
  const hasNote = Boolean(note);
  els.notesEditor.disabled = !hasNote;
  els.notesEditor.placeholder = hasNote
    ? '用 Markdown 记录：\n# 本节要点\n- 反方向走一小步'
    : '按 N 或点「新建」创建第一条笔记';
  if (!hasNote) {
    if (state.notes.draft !== '') state.notes.draft = '';
    els.notesEditor.value = '';
    els.notesNoteTime.textContent = '—';
    els.notesTagsValue.textContent = '无标签';
    els.notesTagsInput.value = '';
    if (state.notes.tab === 'preview') renderNotesPreview();
    return;
  }
  if (document.activeElement !== els.notesEditor) {
    els.notesEditor.value = state.notes.draft;
  }
  els.notesNoteTime.textContent = `${formatNoteTimestamp(note.tMs)} · ${noteKindLabel(state.notes.noteKind)}`;
  els.notesTagsValue.textContent = state.notes.tags.length > 0 ? `标签：${state.notes.tags.join('、')}` : '无标签';
  if (state.notes.tab === 'preview') renderNotesPreview();
}

function setNotesTab(tab) {
  state.notes.tab = tab === 'preview' ? 'preview' : 'edit';
  const preview = state.notes.tab === 'preview';
  els.notesEditor.hidden = preview;
  els.notesPreview.hidden = !preview;
  els.notesTabEdit.setAttribute('aria-selected', String(!preview));
  els.notesTabPreview.setAttribute('aria-selected', String(preview));
  if (preview) renderNotesPreview();
  else els.notesEditor.focus({ preventScroll: true });
}

// ==================================================== v0.7 dock / 命令面板 / 帮助

const DOCK_TABS = ['subtitles', 'notes', 'settings'];

function setDockTab(tab, { focus = false, openMobile = true } = {}) {
  const target = DOCK_TABS.includes(tab) ? tab : 'subtitles';
  state.dock.tab = target;
  for (const button of [els.dockTabSubtitles, els.dockTabNotes, els.dockTabSettings]) {
    const active = button?.dataset.dockTab === target;
    button?.classList.toggle('is-active', active);
    button?.setAttribute('aria-selected', String(active));
    button?.setAttribute('tabindex', active ? '0' : '-1');
  }
  for (const panel of [els.dockPanelSubtitles, els.dockPanelNotes, els.dockPanelSettings]) {
    if (!panel) continue;
    panel.hidden = panel.id !== `dockPanel${target[0].toUpperCase()}${target.slice(1)}`;
  }
  if (openMobile && window.matchMedia?.('(max-width: 1100px)').matches) document.querySelector('.app')?.classList.add('dock-mobile-open');
  if (focus) {
    const activeTab = document.querySelector(`.dock-tab[data-dock-tab="${target}"]`);
    activeTab?.focus();
  }
}

function closeDockMobile() {
  document.querySelector('.app')?.classList.remove('dock-mobile-open');
}

function setDockCollapsed(collapsed) {
  state.dock.collapsed = Boolean(collapsed);
  document.querySelector('.app')?.classList.toggle('dock-collapsed', state.dock.collapsed);
  els.btnDockCollapse?.setAttribute('aria-pressed', String(state.dock.collapsed));
}

function openShortcutHelp() {
  if (!els.shortcutHelp) return;
  state.ui.helpOpen = true;
  els.shortcutHelp.hidden = false;
  els.shortcutHelp.setAttribute('aria-hidden', 'false');
  if (els.helpGrid && els.helpGrid.childElementCount === 0) {
    const rows = [
      ['Space', '播放 / 暂停'],
      ['S', '显示 / 隐藏字幕'],
      ['D', '开启 / 关闭配音'],
      ['N', '新建笔记 / 打开笔记'],
      ['Esc', '关闭弹层 / 面板'],
      ['⌘K / Ctrl+K', '打开命令面板'],
      ['?', '打开本帮助'],
      ['Alt+1/2/3', '切换 dock：字幕 / 笔记 / 设置'],
      ['Ctrl/⌘+Enter', '保存当前笔记'],
      ['Ctrl/⌘+Shift+C', '插入代码块'],
      ['↑ / ↓', '命令面板内选择'],
      ['Enter', '执行选中的命令'],
    ];
    for (const [keys, label] of rows) {
      const row = document.createElement('div');
      row.className = 'help-row';
      const kbd = document.createElement('kbd');
      kbd.textContent = keys;
      const span = document.createElement('span');
      span.textContent = label;
      row.append(kbd, span);
      els.helpGrid.appendChild(row);
    }
  }
  els.btnHelpShortcuts?.setAttribute('aria-expanded', 'true');
}

function closeShortcutHelp() {
  state.ui.helpOpen = false;
  if (els.shortcutHelp) {
    els.shortcutHelp.hidden = true;
    els.shortcutHelp.setAttribute('aria-hidden', 'true');
  }
  els.btnHelpShortcuts?.setAttribute('aria-expanded', 'false');
}

const COMMANDS = [
  { id: 'start', title: '开始同传', keywords: 'start session 开始 连接', icon: 'i-wand', action: () => els.btnStart.click() },
  { id: 'play', title: '播放 / 暂停', keywords: 'play pause space 播放 暂停', icon: 'i-play', action: () => els.btnPlay.click() },
  { id: 'stop', title: '停止同传', keywords: 'stop 停止', icon: 'i-stop', action: () => els.btnStop.click() },
  { id: 'notes', title: '打开笔记工作区', keywords: 'notes 笔记 打开', icon: 'i-note', action: () => void openNotesDrawer() },
  { id: 'visual', title: '课程处理（翻译 / 笔记 / 因果）', keywords: 'visual 图文 生成 ocr 翻译 字幕 因果 模型', icon: 'i-image', action: () => { openVisualModal(); setVisualMode('single'); } },
  { id: 'chapters', title: '按章节做笔记和因果', keywords: 'chapter 章节 分段 总览 笔记 因果', icon: 'i-list', action: () => { openVisualModal(); setVisualMode('chapters'); } },
  { id: 'quote', title: '插入当前句到笔记', keywords: 'quote 当前句 插入 字幕', icon: 'i-subtitles', action: () => void (async () => { await openNotesDrawer(); if (!currentNote()) await createNoteAtCurrentTime(); insertCurrentQuote(); })() },
  { id: 'capture', title: '捕获当前画面', keywords: 'capture 画面 截图 ocr', icon: 'i-camera', action: () => void (async () => { await openNotesDrawer(); await captureCurrentVisual(); })() },
  { id: 'obsidian', title: '同步到 Obsidian', keywords: 'obsidian sync 同步 笔记', icon: 'i-sync', action: () => void syncCurrentVideoToObsidian() },
  { id: 'theme', title: '切换暗色 / 亮色主题', keywords: 'theme 主题 亮色 暗色', icon: 'i-sun', action: () => toggleTheme() },
  { id: 'pip', title: '画中画', keywords: 'pip picture 画中画', icon: 'i-pip', action: () => void togglePip() },
  { id: 'export', title: '下载笔记 Markdown', keywords: 'export 导出 markdown 下载', icon: 'i-download', action: () => void exportNotes('download') },
  { id: 'subtitles', title: '打开字幕 dock', keywords: 'subtitle 字幕 历史', icon: 'i-subtitles', action: () => setDockTab('subtitles') },
  { id: 'settings', title: '打开设置 dock', keywords: 'settings 设置 引擎 声音', icon: 'i-settings', action: () => setDockTab('settings') },
  { id: 'dock', title: '收起 / 展开右侧 dock', keywords: 'dock 收起 展开 布局', icon: 'i-expand', action: () => setDockCollapsed(!state.dock.collapsed) },
  { id: 'help', title: '快捷键帮助', keywords: 'help 快捷键 帮助 ?', icon: 'i-keyboard', action: () => openShortcutHelp() },
];

function setCommandActive(index) {
  const list = els.commandList?.querySelectorAll('.command-item') ?? [];
  if (list.length === 0) return;
  const target = Math.max(0, Math.min(list.length - 1, index));
  state.ui.commandIndex = target;
  list.forEach((node, nodeIndex) => {
    node.classList.toggle('is-active', nodeIndex === target);
    node.setAttribute('aria-selected', String(nodeIndex === target));
  });
  list[target].scrollIntoView({ block: 'nearest' });
}

function renderCommandList(query = '') {
  if (!els.commandList) return;
  const results = filterCommands(COMMANDS, query);
  state.ui.commandResults = results;
  state.ui.commandIndex = 0;
  els.commandList.textContent = '';
  els.commandCount.textContent = `${results.length} 条命令`;
  if (results.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'command-empty';
    empty.textContent = '没有匹配的命令，换个关键词试试';
    els.commandList.appendChild(empty);
    return;
  }
  results.forEach((command, index) => {
    const item = document.createElement('div');
    item.className = `command-item${index === 0 ? ' is-active' : ''}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === 0));
    item.dataset.commandId = command.id;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'icon');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${command.icon ?? 'i-dot'}`);
    icon.appendChild(use);
    const title = document.createElement('span');
    title.textContent = command.title;
    const hint = document.createElement('small');
    hint.textContent = 'Enter ↵';
    item.append(icon, title, hint);
    item.addEventListener('click', () => runCommand(index));
    item.addEventListener('mousemove', () => setCommandActive(index));
    els.commandList.appendChild(item);
  });
}

function runCommand(index) {
  const command = state.ui.commandResults[index];
  closeCommandPalette();
  if (!command) return;
  try {
    command.action();
  } catch (error) {
    toast(`命令执行失败：${error.message}`, 'err', 5000);
  }
}

function openCommandPalette() {
  if (!els.commandPalette) return;
  state.ui.commandOpen = true;
  els.commandPalette.hidden = false;
  els.commandPalette.setAttribute('aria-hidden', 'false');
  els.btnCommands?.setAttribute('aria-expanded', 'true');
  if (els.commandInput) els.commandInput.value = '';
  renderCommandList('');
  requestAnimationFrame(() => els.commandInput?.focus());
}

function closeCommandPalette() {
  state.ui.commandOpen = false;
  if (els.commandPalette) {
    els.commandPalette.hidden = true;
    els.commandPalette.setAttribute('aria-hidden', 'true');
  }
  els.btnCommands?.setAttribute('aria-expanded', 'false');
}

function toggleCommandPalette() {
  if (state.ui.commandOpen) closeCommandPalette();
  else openCommandPalette();
}

function openLightbox(src) {
  if (!src || !els.imageLightbox) return;
  state.ui.lightboxOpen = true;
  els.lightboxImage.src = src;
  els.imageLightbox.hidden = false;
  els.imageLightbox.setAttribute('aria-hidden', 'false');
}

function closeLightbox() {
  state.ui.lightboxOpen = false;
  if (els.imageLightbox) {
    els.imageLightbox.hidden = true;
    els.imageLightbox.setAttribute('aria-hidden', 'true');
  }
  if (els.lightboxImage) els.lightboxImage.removeAttribute('src');
}

// ------------------------------------------------ 字幕 hero / 分步进度

function updateSubtitleHero({ src = '', dst = '', timeMs = null } = {}) {
  if (!els.subtitleHeroSrc) return;
  els.subtitleHeroSrc.textContent = src || '等待字幕…';
  els.subtitleHeroDst.textContent = dst || '打开视频并开始同传后，这里显示实时双语字幕。';
  const tMs = Number.isFinite(Number(timeMs))
    ? Number(timeMs)
    : state.sim.active
      ? state.sim.clock || 0
      : (els.video?.currentTime || 0) * 1000;
  els.subtitleHeroTime.textContent = formatClock(tMs);
}

function visualStepForText(text) {
  const value = String(text ?? '');
  if (/完成|取消|失败/.test(value)) return 'done';
  if (/采样/.test(value)) return 'sample';
  if (/识别|OCR/i.test(value)) return 'ocr';
  if (/画面理解|VLM/.test(value)) return 'vlm';
  if (/翻译/.test(value)) return 'translate';
  if (/总结|总览/.test(value)) return 'summary';
  if (/保存|组装|整理/.test(value)) return 'save';
  return null;
}

const COURSE_STEPS = ['sample', 'ocr', 'vlm', 'translate', 'summary', 'save'];

function applyVisualSteps(activeStep) {
  if (!els.visualSteps) return;
  const states = activeStep === 'done'
    ? progressStepStates(null, COURSE_STEPS).map((entry) => ({ ...entry, state: 'done' }))
    : progressStepStates(activeStep, COURSE_STEPS);
  for (const item of els.visualSteps.querySelectorAll('li[data-step]')) {
    const entry = states.find((value) => value.step === item.dataset.step);
    item.dataset.state = entry?.state ?? 'pending';
    item.setAttribute('aria-current', entry?.state === 'active' ? 'step' : 'false');
  }
}

// ---------------------------------------------------------------- 事件绑定

/** 键盘快捷键动作分发（纯函数 resolveShortcut 决定动作，这里只做副作用） */
function handleShortcut(action) {
  switch (action) {
    case 'toggle-play':
      if (!els.video.src) {
        toast('先载入视频后再播放', 'warn', 1800);
        return;
      }
      if (state.sim.active && state.sim.frozen) {
        startSimPlayback(state.sim.clock);
        toast('演示回放：开始播放', 'info', 1600);
        return;
      }
      videoPlayPause();
      return;
    case 'toggle-subs': {
      const next = !state.settings.subsVisible;
      setSubsVisible(next);
      toast(`字幕${next ? '已显示' : '已隐藏'}（S）`, 'info', 1500);
      return;
    }
    case 'toggle-dub':
      setDubEnabled(!state.settings.dubEnabled, { announce: true });
      return;
    case 'new-note':
      void openNotesDrawer({ create: true });
      return;
    case 'escape':
      if (state.notes.open) {
        closeNotesDrawer();
        return;
      }
      if (state.subsOnly.active) exitSubsOnly();
      else {
        setPanelsHidden(!state.panelsHidden);
        toast(state.panelsHidden ? '面板已隐藏，按 Esc 恢复（仅字幕按钮可进入专注模式）' : '面板已显示', 'info', 1600);
      }
      return;
    default:
      return;
  }
}

function bindEvents() {
  // v0.7 dock 切换（role=tablist，左右箭头键盘）
  const dockTabs = [els.dockTabSubtitles, els.dockTabNotes, els.dockTabSettings];
  for (const tab of dockTabs) {
    tab.addEventListener('click', () => {
      if (tab.dataset.dockTab === 'notes') void openNotesDrawer({ allowNoVideo: true });
      else setDockTab(tab.dataset.dockTab, { focus: false });
    });
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = DOCK_TABS.indexOf(state.dock.tab);
      const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      let next = event.key === 'Home' ? 0 : event.key === 'End' ? DOCK_TABS.length - 1 : nextTabIndex(current, DOCK_TABS.length, delta);
      setDockTab(DOCK_TABS[next], { focus: true });
    });
  }
  els.btnDockCollapse.addEventListener('click', () => {
    if (window.matchMedia?.('(max-width: 1100px)').matches) closeDockMobile();
    else setDockCollapsed(!state.dock.collapsed);
  });

  // v0.7 命令面板 / 快捷键帮助 / lightbox
  els.btnCommands.addEventListener('click', openCommandPalette);
  els.commandInput.addEventListener('input', () => renderCommandList(els.commandInput.value));
  els.commandInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCommandActive(state.ui.commandIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCommandActive(state.ui.commandIndex - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runCommand(state.ui.commandIndex);
    }
  });
  els.commandList.addEventListener('mousemove', (event) => {
    const item = event.target.closest('.command-item');
    if (!item) return;
    const siblings = [...els.commandList.querySelectorAll('.command-item')];
    const index = siblings.indexOf(item);
    if (index >= 0 && index !== state.ui.commandIndex) setCommandActive(index);
  });
  els.commandPalette.addEventListener('click', (event) => {
    if (event.target === els.commandPalette) closeCommandPalette();
  });
  els.btnHelpShortcuts.addEventListener('click', openShortcutHelp);
  els.btnHelpClose.addEventListener('click', closeShortcutHelp);
  els.shortcutHelp.addEventListener('click', (event) => {
    if (event.target === els.shortcutHelp) closeShortcutHelp();
  });
  els.btnLightboxClose.addEventListener('click', closeLightbox);
  els.imageLightbox.addEventListener('click', (event) => {
    if (event.target === els.imageLightbox) closeLightbox();
  });
  els.notesPreview.addEventListener('click', (event) => {
    const image = event.target.closest('img');
    if (image) openLightbox(image.currentSrc || image.src);
  });

  // v0.7 全局快捷键：命令面板 / ? 帮助 / Esc 关闭弹层优先
  document.addEventListener(
    'keydown',
    (event) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.shiftKey && !event.altKey && event.code === 'KeyK') {
        event.preventDefault();
        toggleCommandPalette();
        return;
      }
      if (!mod && !event.altKey && (event.key === '?' || (event.shiftKey && event.code === 'Slash'))) {
        if (!isEditableTarget(event.target)) {
          event.preventDefault();
          openShortcutHelp();
          return;
        }
      }
      if (event.altKey && ['Digit1', 'Digit2', 'Digit3'].includes(event.code)) {
        event.preventDefault();
        setDockTab(['subtitles', 'notes', 'settings'][Number(event.code.slice(-1)) - 1], { focus: true });
        return;
      }
      if (event.key === 'Escape') {
        if (state.ui.lightboxOpen) {
          event.preventDefault();
          closeLightbox();
          return;
        }
        if (state.ui.helpOpen) {
          event.preventDefault();
          closeShortcutHelp();
          return;
        }
        if (state.ui.commandOpen) {
          event.preventDefault();
          closeCommandPalette();
          return;
        }
        if (window.matchMedia?.('(max-width: 1100px)').matches && document.querySelector('.app.dock-mobile-open')) {
          event.preventDefault();
          closeDockMobile();
        }
      }
    },
    true,
  );

  // v0.7 笔记过滤 chips
  els.notesFilters.addEventListener('click', (event) => {
    const chip = event.target.closest('button[data-note-filter]');
    if (!chip) return;
    state.notes.filter = chip.dataset.noteFilter;
    for (const button of els.notesFilters.querySelectorAll('button[data-note-filter]')) {
      const active = button.dataset.noteFilter === state.notes.filter;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    renderNotesList();
  });

  // 顶栏
  els.btnStart.addEventListener('click', () => void startSession());
  els.btnStop.addEventListener('click', () => stopSession());
  els.btnReconnect.addEventListener('click', reconnect);
  els.btnTheme.addEventListener('click', toggleTheme);
  for (const button of document.querySelectorAll('.engine-choice[data-asr-provider]')) {
    button.addEventListener('click', () => void selectAsrEngine(button.dataset.asrProvider));
  }
  els.btnCopyDesktopCmd.addEventListener('click', () => copyText(els.desktopCommand.textContent, '已复制桌面 App 命令'));
  els.btnConnRetry.addEventListener('click', async () => {
    toast('正在重试连接本地引擎…', 'info', 2000);
    await loadEngineInfo();
    if (state.engineOnline) {
      showConnHelp(false);
      if (state.sessionActive && !state.wsReady) reconnect();
    }
  });

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
    if (state.video && Number.isFinite(els.video.duration) && els.video.duration > 0) {
      state.video.durationMs = Math.round(els.video.duration * 1000);
      if (state.notes.open) renderNotesAll();
    }
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
    if (state.visual.sampling) return; // 图文笔记采样期间由采样器控制播放头
    if (state.sim.active) {
      // 回放/演示模式：seek 是为了显示对应帧，不能把字幕清掉
      if (state.sim.frozen) applySimAt(state.sim.clock);
      return;
    }
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
  els.subsSmaller.addEventListener('click', () => adjustSubtitleFont(-1));
  els.subsBigger.addEventListener('click', () => adjustSubtitleFont(1));
  els.subsHide.addEventListener('click', () => setSubsVisible(false));
  els.toggleDub.addEventListener('change', () => setDubEnabled(els.toggleDub.checked, { announce: true }));
  els.toggleDuck.addEventListener('change', () => {
    state.settings.duckEnabled = els.toggleDuck.checked;
    els.toggleDuck.setAttribute('aria-checked', String(state.settings.duckEnabled));
    if (!state.settings.duckEnabled && state.dub.ducking) {
      state.dub.ducking = false;
      applyVolume();
    }
    saveSettings();
  });

  // 字幕样式预设（字号 / 位置 / 背景不透明度）+ 仅字幕模式
  els.subsSize.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-size]');
    if (button) setSubsSize(button.dataset.size);
  });
  els.subsPosition.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-position]');
    if (button) {
      state.settings.subsPos = null;
      setSubsPosition(button.dataset.position);
    }
  });
  els.subsOpacity.addEventListener('input', () => setSubsOpacity(els.subsOpacity.value, { persist: false }));
  els.subsOpacity.addEventListener('change', () => setSubsOpacity(els.subsOpacity.value));
  els.btnSubsReset.addEventListener('click', () => {
    state.settings.subsPos = null;
    applySubsStyle();
    saveSettings();
    toast('字幕位置已重置', 'info', 1600);
  });
  els.btnSubsOnly.addEventListener('click', enterSubsOnly);
  els.btnSubsOnlyExit.addEventListener('click', exitSubsOnly);
  els.btnPanelsShow.addEventListener('click', () => setPanelsHidden(false));

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

  // 学习笔记（v0.4）
  els.btnNotes.addEventListener('click', () => {
    const mobile = window.matchMedia?.('(max-width: 1100px)').matches;
    if (state.notes.open && state.dock.tab === 'notes' && mobile) closeNotesDrawer();
    else void openNotesDrawer();
  });
  els.btnNotesClose.addEventListener('click', closeNotesDrawer);
  els.btnNotesNew.addEventListener('click', () => void openNotesDrawer({ create: true }));
  els.btnNotesOutline.addEventListener('click', () => void generateOutlineNote());
  els.btnNotesVisual.addEventListener('click', openVisualModal);
  els.btnVisualClose.addEventListener('click', () => closeVisualModal());
  els.btnVisualStart.addEventListener('click', () => void runVisualPipeline());
  els.btnVisualCancel.addEventListener('click', cancelVisualRun);
  els.visualMode.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]');
    if (button) setVisualMode(button.dataset.mode);
  });
  els.visualRange.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-range]');
    if (button) setVisualRange(button.dataset.range);
  });
  els.btnObsidianSync.addEventListener('click', () => void syncCurrentVideoToObsidian());
  els.toggleVisualContext.addEventListener('change', () => setVisualContextEnabled(els.toggleVisualContext.checked));
  els.visualVlm.addEventListener('change', () => {
    state.visual.vlm = Boolean(els.visualVlm.checked);
    renderVisualPlan();
  });
  for (const input of [els.jobTranslate, els.jobNotes, els.jobCausal]) {
    input?.addEventListener('change', () => syncCourseForm());
  }
  els.courseSource?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-source]');
    if (button) setTranslateSource(button.dataset.source);
  });
  els.courseModels?.addEventListener('change', () => renderVisualPlan());
  els.btnCaptureVisual.addEventListener('click', () => void captureCurrentVisual());
  els.btnNotesRetry.addEventListener('click', () => void syncLocalNotes());
  els.notesSearch.addEventListener('input', () => {
    state.notes.query = els.notesSearch.value;
    renderNotesList();
  });
  for (const tab of [els.notesTabEdit, els.notesTabPreview]) {
    tab.addEventListener('click', () => setNotesTab(tab.dataset.tab));
  }
  els.notesEditor.addEventListener('input', () => {
    state.notes.draft = els.notesEditor.value;
    state.notes.dirty = true;
    scheduleNotesSave();
    renderNotesPreviewIfVisible();
  });
  els.notesEditor.addEventListener('blur', () => void flushNotesSave());
  els.notesEditor.addEventListener('keydown', (event) => {
    const action = resolveEditorShortcut(event);
    if (!action) return;
    event.preventDefault();
    if (action === 'save') {
      void flushNotesSave().then(() => toast('笔记已保存', 'ok', 1600));
    } else if (action === 'codeblock') {
      insertCodeBlock();
    }
  });
  els.notesTagsInput.addEventListener('change', applyNotesTagsFromInput);
  els.notesTagsInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyNotesTagsFromInput();
      els.notesTagsInput.blur();
    }
  });
  els.btnInsertQuote.addEventListener('click', insertCurrentQuote);
  els.btnInsertTimestamp.addEventListener('click', insertCurrentTimestamp);
  els.btnInsertCode.addEventListener('click', insertCodeBlock);
  els.btnInsertScreenshot.addEventListener('click', () => void insertScreenshot());
  for (const button of els.notesExportMenu.querySelectorAll('button[data-export]')) {
    button.addEventListener('click', () => void exportNotes(button.dataset.export));
  }
  els.btnPip.addEventListener('click', () => void togglePip());
  els.video.addEventListener('play', () => {
    if (state.visualContext.enabled) startVisualContextLoop();
  });
  els.video.addEventListener('pause', () => {
    if (state.visualContext.timer) stopVisualContextLoop({ clearState: false });
  });
  els.video.addEventListener('ended', () => {
    if (state.visualContext.enabled) stopVisualContextLoop({ clearState: true });
  });
  els.video.addEventListener('enterpictureinpicture', () => {
    els.btnPip.setAttribute('aria-pressed', 'true');
    els.btnPip.title = '退出画中画';
  });
  els.video.addEventListener('leavepictureinpicture', () => {
    els.btnPip.setAttribute('aria-pressed', 'false');
    els.btnPip.title = '画中画（边看边写笔记）';
  });

  // 导出 / 日志
  els.btnExportSrt.addEventListener('click', exportSrt);
  els.btnExportEvents.addEventListener('click', exportEventsJsonl);
  els.btnClearLog.addEventListener('click', () => {
    els.eventLog.innerHTML = '<div class="log-empty">日志已清空</div>';
  });

  // 键盘快捷键：Space 播放/暂停、S 字幕、D 配音、Esc 面板（输入框内不触发）
  document.addEventListener('keydown', (event) => {
    const action = resolveShortcut(event, { editable: isEditableTarget(event.target) });
    if (!action) return;
    event.preventDefault();
    handleShortcut(action);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.notes.dirty) void flushNotesSave();
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
  setDockTab('subtitles', { openMobile: false });
  applyVisualSteps(null);
  updateSubtitleHero({});
  setupSubtitleDrag();
  updateSessionButtons();
  resetMetricsHud();
  applySubsStyle();
  updatePlayButton();
  renderSparklines();
  els.btnExportEvents.disabled = true;

  const params = new URLSearchParams(location.search);
  // ?theme=light|dark 允许临时覆盖持久化主题（截图/分享用，不写回 localStorage）
  const themeParam = params.get('theme');
  if (themeParam) applyTheme(normalizeTheme(themeParam), { persist: false });
  else applyTheme(state.settings.theme, { persist: false });

  const simMode = await setupSimMode(params);
  // 调试入口（本地工作台，无敏感信息；便于自动化截图/排查）
  globalThis.__livedubStudio = {
    state,
    applySimAt,
    renderSparklines,
    renderAsrEngine,
    renderDesktopApp,
    selectAsrEngine,
    version: '0.7.0',
    notes: {
      state: state.notes,
      open: (options) => openNotesDrawer(options ?? {}),
      close: closeNotesDrawer,
      create: (options) => createNoteAtCurrentTime(options ?? {}),
      write: writeCurrentNoteBody,
      select: selectNote,
      seek: seekToNote,
      insertQuote: insertCurrentQuote,
      insertTimestamp: insertCurrentTimestamp,
      insertCode: insertCodeBlock,
      screenshot: insertScreenshot,
      refresh: refreshNotes,
      outline: generateOutlineNote,
      exportNotes,
      syncLocal: syncLocalNotes,
      delete: deleteNoteById,
    },
    obsidian: {
      state: state.obsidian,
      load: loadObsidianStatus,
      sync: syncCurrentVideoToObsidian,
    },
    visualContext: {
      state: state.visualContext,
      setEnabled: setVisualContextEnabled,
      tick: tickVisualContext,
    },
    ui: {
      state: state.ui,
      dock: state.dock,
      commands: COMMANDS,
      openCommands: openCommandPalette,
      closeCommands: closeCommandPalette,
      openHelp: openShortcutHelp,
      closeHelp: closeShortcutHelp,
      setDockTab,
      setDockCollapsed,
      openLightbox,
      closeLightbox,
      setProgress: setVisualProgress,
      openVisual: openVisualModal,
      setVisualMode,
    },
    vision: {
      state: state.vision,
      visual: state.visual,
      health: () => loadVisionHealth({ silent: false }),
      openModal: openVisualModal,
      closeModal: closeVisualModal,
      run: runVisualPipeline,
      cancel: cancelVisualRun,
      captureCurrent: captureCurrentVisual,
      debugSample: debugSampleFrames,
      setRange: setVisualRange,
      setMode: setVisualMode,
      runChapters: runChaptersPipeline,
      setVlm: (value) => {
        state.visual.vlm = Boolean(value);
        els.visualVlm.checked = state.visual.vlm;
        renderVisualPlan();
      },
    },
  };
  if (!simMode) {
    await loadEngineInfo();
    await loadUiSettings();
    syncSettingsUi();
    renderAsrEngine();
    renderDesktopApp();
    const videoParam = params.get('video');
    if (videoParam) loadVideoUrl(videoParam);
    const autoPlay = params.get('autoplay') === '1';
    if (autoPlay && els.video.src) {
      void startSession();
    }
  } else {
    await loadUiSettings();
    syncSettingsUi();
    renderAsrEngine();
    renderDesktopApp();
  }

  void loadVisionHealth({ silent: true });
  void loadObsidianStatus({ silent: true });
  renderVisualContextStatus();

  // 扩展 / macOS App 的「打开笔记本」会链到 /studio/?notes=1
  if (params.get('notes') === '1') {
    await openNotesDrawer({ allowNoVideo: true });
  }
}

bootstrap().catch((err) => {
  console.error(err);
  toast(`工作台初始化失败：${err.message}`, 'err', 8000);
});
