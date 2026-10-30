/**
 * livedub Chrome MV3 扩展 —— content script（每个页面一个实例，classic script）。
 *
 * v0.2：
 * - 原生全屏兼容：`fullscreenchange` 时把浮层迁进 `document.fullscreenElement`（容器型），
 *   退出后迁回 document；`<video>` 直接全屏时浏览器不允许叠加自定义 DOM，会展示提示（诚实限制）；
 * - 字幕停靠 bottom/top + Y 偏移避让平台原生字幕、背景/不透明度、字号，全部持久化；
 * - 设置面板可拖拽、可收起；
 * - 导出本次 SRT（background 累积 segment+translation，基于 lib/srt.js 生成）；
 * - 引擎未连接/断线时给出可操作指引（npm start / /health / 重试连接）；
 * - 延迟细分展示（ASR / 翻译 / 配音 / 端到端）；
 * - 结束时恢复所有被压音元素、清理定时器与拖拽状态。
 *
 * v0.3：
 * - 全局限定压音（offscreen 原声总线 GainNode）成为主方案：开启时 content 不再改
 *   <video>.volume（避免双重压音），只保留兜底路径（关闭全局限定压音时生效）；
 * - 裸 <video> 全屏：与 MAIN world 的 page-hook.js 通过 window.postMessage 协作，
 *   由 page-hook 把裸 video 包进容器再全屏，content 负责把浮层迁进该容器。
 *
 * v0.4 边看边写笔记：缓存最近一句双语字幕（停止抓音后仍可用），向 background 提供
 * 当前视频/时间/字幕上下文；浮层面板「记笔记」按钮 + 全局快捷键 Alt+Shift+N，
 * 结果显示为浮层 toast（成功/离线排队/截图失败）。
 *
 * 只做「显示 + 压音」，不直接连引擎：从 background 的 runtime 消息增量更新。
 * 为什么是 classic script：MV3 content_scripts 不能 import ESM。因此这里内联了与
 * extension/lib/{pcm,ui,constants,srt}.js 等价的少量纯逻辑（有注释标注），
 * tests/extension.test.mjs 会对 lib 版本做单测、并对本文件做关键实现静态校验。
 */

(() => {
  'use strict';

  // 防重复注入（manifest 静态注入 + background 兜底 executeScript 可能都跑到）
  if (globalThis.__livedubContentLoaded) return;
  globalThis.__livedubContentLoaded = true;

  // -------------------------------------------------------------------------
  // 常量 / 默认设置（与 extension/lib/constants.js + lib/ui.js 保持一致）
  // -------------------------------------------------------------------------

  const M = {
    STATE: 'livedub:state',
    ENGINE_EVENT: 'livedub:event',
    CONTENT_SETTINGS: 'livedub:settings',
    PING: 'livedub:ping',
    CONTENT_READY: 'livedub:content-ready',
    CONTENT_TOGGLE: 'livedub:toggle-capture',
    GET_SRT: 'livedub:get-srt',
    RECONNECT: 'livedub:reconnect',
    CAPTURE_NOTE: 'livedub:capture-note',
    NOTE_CONTEXT: 'livedub:note-context',
    NOTE_RESULT: 'livedub:note-result',
  };
  const STORAGE_SETTINGS_KEY = 'livedub:settings';
  const DEFAULT_SETTINGS = {
    engineUrl: 'ws://127.0.0.1:8787/ws',
    voiceMode: 'clone-first',
    dubEnabled: true,
    duckRatio: 0.18,
    showOriginal: true,
    fontSize: 22,
    dock: 'bottom',
    offsetY: 0,
    dx: 0,
    subsOpacity: 0.82,
    subsBg: 'dark',
    subsDensity: 'auto',
    captureReplay: true,
    globalDuck: true,
    duckRecoverMs: 800,
    fullscreenWorkaround: true,
    noteScreenshot: true,
    visionOcr: true,
    visionCaption: false,
    langFrom: 'en',
    langTo: 'zh',
    hidden: false,
    panelCollapsed: false,
    panelPos: null,
  };
  /** 与 lib/ui.js 对齐：这些全屏元素无法承载子节点（替换元素） */
  const NON_HOSTABLE_TAGS = ['VIDEO', 'AUDIO', 'IMG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'PICTURE', 'SVG'];
  const OFFSET_Y_MIN = -200;
  const OFFSET_Y_MAX = 320;
  const OFFSET_X_LIMIT = 480;
  /** 配音结束/说话结束后多久恢复原音量 */
  const IDLE_RESTORE_MS = 800;
  /** 字幕保留块数 */
  const MAX_BLOCKS = 3;
  /** 字幕块最长保留时间 */
  const BLOCK_TTL_MS = 25000;
  /** 浮层轮询间隔（压音 tick / 字幕过期 / SPA / 全屏兜底检查） */
  const TICK_MS = 500;
  /** v0.3：与 page-hook.js（MAIN world）的 postMessage 协作协议 */
  const PAGE_HOOK_SOURCE = 'livedub-page-hook';
  const CONTENT_MESSAGE_SOURCE = 'livedub-content';
  const DUCK_RECOVER_MS_MIN = 300;
  const DUCK_RECOVER_MS_MAX = 3000;

  const runtime = {
    settings: { ...DEFAULT_SETTINGS },
    bgState: null,
    sessionKey: null,
    metrics: null,
    error: null,
    errorTimer: null,
    items: new Map(), // key -> {key, src, dst, draft, ts}
    host: null,
    shadow: null,
    hostKind: null, // 'document' | 'fullscreen'
    hostParent: null,
    els: {},
    drag: null,
    panelDrag: null,
    trackedMedia: new Map(), // HTMLMediaElement -> originalVolume
    duck: { ducking: false, idleSince: null, lastActivity: 0 },
    panelOpen: false,
    mounted: false,
    fullscreenBareVideo: false,
    fullscreenHintShown: false,
    pageHookConfigKey: '',
    pageHookWrappedHinted: false,
    /** v0.4：最近一句双语字幕缓存（停止抓音后记笔记仍可用） */
    lastCaption: null, // {src,dst,t0Ms,t1Ms,updatedAt}
    toastTimer: null,
    /** v0.7 UI 状态：当前面板 tab / note 按钮状态 / toast 堆叠 */
    activeTab: 'subtitles',
    notePending: false,
    toasts: [],
    progressStartedAt: 0,
    progressDurationMs: 0,
    closedByUser: false,
  };

  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  // -------------------------------------------------------------------------
  // 设置（chrome.storage.local，popup 与浮层共享）
  // 仅展示类字段做 clamp；引擎/语音字段透传
  // -------------------------------------------------------------------------

  function clampNumber(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
  }

  function normalizeSettings(raw) {
    const merged = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
    // v0.1 的 subsPos = {dx, dy} 迁移到 v0.2 的 dx + offsetY
    let dx = merged.dx;
    let offsetY = merged.offsetY;
    if (merged.subsPos && typeof merged.subsPos === 'object' && dx == null && offsetY == null) {
      dx = Number(merged.subsPos.dx) || 0;
      offsetY = -(Number(merged.subsPos.dy) || 0);
    }
    merged.fontSize = Math.round(clampNumber(merged.fontSize, 14, 32, 22));
    merged.duckRatio = clampNumber(merged.duckRatio, 0.02, 1, 0.18);
    merged.subsOpacity = clampNumber(merged.subsOpacity, 0.2, 1, 0.82);
    merged.offsetY = Math.round(clampNumber(offsetY, OFFSET_Y_MIN, OFFSET_Y_MAX, 0));
    merged.dx = Math.round(clampNumber(dx, -OFFSET_X_LIMIT, OFFSET_X_LIMIT, 0));
    merged.dock = merged.dock === 'top' ? 'top' : 'bottom';
    merged.subsBg = ['dark', 'light', 'none'].includes(merged.subsBg) ? merged.subsBg : 'dark';
    merged.subsDensity = ['auto', 'wide', 'compact'].includes(merged.subsDensity) ? merged.subsDensity : 'auto';
    merged.panelCollapsed = merged.panelCollapsed === true;
    merged.dubEnabled = merged.dubEnabled !== false;
    merged.showOriginal = merged.showOriginal !== false;
    merged.hidden = merged.hidden === true;
    merged.captureReplay = merged.captureReplay !== false;
    merged.globalDuck = merged.globalDuck !== false;
    merged.fullscreenWorkaround = merged.fullscreenWorkaround !== false;
    merged.noteScreenshot = merged.noteScreenshot !== false;
    merged.visionOcr = merged.visionOcr !== false;
    merged.visionCaption = merged.visionCaption === true;
    merged.duckRecoverMs = Math.round(clampNumber(merged.duckRecoverMs, DUCK_RECOVER_MS_MIN, DUCK_RECOVER_MS_MAX, 800));
    merged.panelPos =
      merged.panelPos && typeof merged.panelPos === 'object'
        ? { dx: Math.round(Number(merged.panelPos.dx) || 0), dy: Math.round(Number(merged.panelPos.dy) || 0) }
        : null;
    delete merged.subsPos;
    return merged;
  }

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get({ [STORAGE_SETTINGS_KEY]: null });
      applySettings(normalizeSettings(stored[STORAGE_SETTINGS_KEY]));
    } catch {
      applySettings(normalizeSettings(null));
    }
  }

  async function saveSettings(patch) {
    runtime.settings = normalizeSettings({ ...runtime.settings, ...patch });
    applySettings(runtime.settings);
    try {
      await chrome.storage.local.set({ [STORAGE_SETTINGS_KEY]: runtime.settings });
    } catch {
      /* 隐私模式等场景 storage 写失败不影响展示 */
    }
  }

  function applySettings(settings) {
    runtime.settings = normalizeSettings(settings);
    if (runtime.settings.globalDuck !== false) {
      // 主方案在 offscreen 原声总线压音：content 侧必须恢复页面音量，避免双重压音
      restoreVolumes();
    }
    syncPanelControls();
    applyOverlayVisibility();
    applySubsLayout();
    applyPanelPosition();
    applyDensity();
    postPageHookConfig();
    renderSubtitles();
    renderMeta();
  }

  /** v0.7：字幕宽/紧凑两档（视口 < 760px 自动紧凑；可在面板强制） */
  function applyDensity() {
    const setting = runtime.settings.subsDensity || 'auto';
    const width = typeof window !== 'undefined' ? window.innerWidth : 1920;
    const density =
      setting === 'compact' ? 'compact' : setting === 'wide' ? 'wide' : width && width < 760 ? 'compact' : 'wide';
    if (runtime.els.root) runtime.els.root.setAttribute('data-density', density);
  }

  /** v0.7：同步 aria（switch/tab/tooltip），保持可访问性 */
  function syncAriaState() {
    const panel = runtime.els.panel;
    if (!panel) return;
    for (const input of panel.querySelectorAll('input[type="checkbox"][role="switch"]')) {
      input.setAttribute('aria-checked', input.checked ? 'true' : 'false');
    }
    for (const tab of panel.querySelectorAll('[data-act="tab"]')) {
      const id = tab.getAttribute('data-tab');
      const selected = id === runtime.activeTab;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.setAttribute('tabindex', selected ? '0' : '-1');
    }
    for (const tabpanel of panel.querySelectorAll('[data-panel-tab]')) {
      tabpanel.hidden = tabpanel.getAttribute('data-panel-tab') !== runtime.activeTab;
    }
    if (runtime.els.capsule) runtime.els.capsule.setAttribute('aria-expanded', runtime.panelOpen ? 'true' : 'false');
  }

  /** v0.7：切换面板 tab */
  function setActiveTab(tab) {
    const allowed = ['subtitles', 'notes', 'settings'];
    runtime.activeTab = allowed.includes(tab) ? tab : 'subtitles';
    syncAriaState();
    renderStatus();
  }

  // ---- v0.3：与 MAIN world page-hook.js 的协作 ----

  /** 把「裸 video 全屏兼容」等开关同步给页面主世界的 page-hook（同值不重复发送） */
  function postPageHookConfig() {
    const key = `${runtime.settings.fullscreenWorkaround === true}:${runtime.settings.captureReplay !== false}`;
    if (key === runtime.pageHookConfigKey) return;
    runtime.pageHookConfigKey = key;
    try {
      window.postMessage(
        {
          source: CONTENT_MESSAGE_SOURCE,
          type: 'config',
          fullscreenWorkaround: runtime.settings.fullscreenWorkaround === true,
          captureReplay: runtime.settings.captureReplay !== false,
        },
        '*',
      );
    } catch {
      /* ignore */
    }
  }

  function onPageHookMessage(event) {
    const data = event && event.data;
    if (!data || typeof data !== 'object' || data.source !== PAGE_HOOK_SOURCE) return;
    if (data.type === 'wrap' && !runtime.pageHookWrappedHinted) {
      runtime.pageHookWrappedHinted = true;
      showError('已启用「裸 video 全屏兼容」：已把 <video> 包进全屏容器，字幕浮层在原生全屏下可见。', 'info');
    } else if (data.type === 'error' && data.message) {
      showError(`全屏兼容失败，已回退原生全屏：${data.message}`, 'info');
    }
  }

  function formatSettingValue(key, value) {
    if (key === 'fontSize') return `${value}px`;
    if (key === 'offsetY') return `${value}px`;
    if (key === 'subsOpacity') return `${Math.round(value * 100)}%`;
    if (key === 'duckRecoverMs') return `${value}ms`;
    if (key === 'duckRatio') return String(value);
    return String(value);
  }

  function syncPanelControls() {
    const panel = runtime.els.panel;
    if (!panel) return;
    for (const input of panel.querySelectorAll('input[data-set], select[data-set]')) {
      const key = input.getAttribute('data-set');
      if (input.type === 'checkbox') input.checked = !!runtime.settings[key];
      else input.value = runtime.settings[key];
      const valueEl = panel.querySelector(`[data-val="${key}"]`);
      if (valueEl) valueEl.textContent = formatSettingValue(key, runtime.settings[key]);
    }
    for (const button of panel.querySelectorAll('[data-act^="dock-"]')) {
      button.classList.toggle('active', button.getAttribute('data-act') === `dock-${runtime.settings.dock}`);
    }
    const density = runtime.settings.subsDensity || 'auto';
    for (const button of panel.querySelectorAll('[data-act^="density-"]')) {
      const value = button.getAttribute('data-act').replace('density-', '');
      button.classList.toggle('active', density === value || (density === 'auto' && value === 'wide'));
    }
    if (runtime.els.panelBody) runtime.els.panelBody.hidden = runtime.settings.panelCollapsed;
    if (runtime.els.collapseButton) {
      runtime.els.collapseButton.textContent = runtime.settings.panelCollapsed ? '▸' : '▾';
      runtime.els.collapseButton.title = runtime.settings.panelCollapsed ? '展开设置' : '收起设置';
      runtime.els.collapseButton.setAttribute('aria-expanded', runtime.settings.panelCollapsed ? 'true' : 'false');
    }
    syncAriaState();
    renderNoteSummary();
    renderNoteButton();
  }

  /** v0.7：笔记卡摘要（今日/待同步） */
  function renderNoteSummary() {
    const el = runtime.els.noteSummary;
    if (!el) return;
    const stats = runtime.bgState && runtime.bgState.noteStats;
    const today = stats && Number.isFinite(stats.count) ? stats.count : 0;
    const queue = (runtime.bgState && runtime.bgState.noteQueueCount) || 0;
    el.textContent = `今日 ${today} 条 · 待同步 ${queue}`;
  }

  /** v0.7：记笔记按钮进度/完成态（识别画面中 / 已记录 @ mm:ss / 已排队） */
  function renderNoteButton() {
    const button = runtime.els.noteButton;
    if (!button) return;
    const lastNote = runtime.bgState && runtime.bgState.lastNote;
    const pending = runtime.notePending === true;
    let label = '记笔记';
    let state = 'idle';
    if (pending) {
      state = 'loading';
      label = '识别画面文字中…';
    } else if (lastNote && Number.isFinite(lastNote.at)) {
      const timeMs = Number.isFinite(lastNote.tMs) ? Math.max(0, Math.round(lastNote.tMs)) : 0;
      const total = Math.floor(timeMs / 1000);
      const stamp = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
      if (Date.now() - lastNote.at < 12_000) {
        label = lastNote.queued ? `已排队 @ ${stamp}` : `已记录 @ ${stamp}`;
        state = lastNote.queued ? 'queued' : 'done';
      }
    }
    button.setAttribute('data-state', state);
    button.setAttribute('aria-busy', pending ? 'true' : 'false');
    button.disabled = pending;
    if (pending) button.innerHTML = '<span class="spin" aria-hidden="true"></span>识别画面文字中…';
    else button.textContent = label;
  }

  // -------------------------------------------------------------------------
  // 浮层构建（Shadow DOM）
  // -------------------------------------------------------------------------

  const OVERLAY_CSS = `
    :host { all: initial; }
    .livedub-root {
      position: fixed; inset: 0; pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      color: var(--livedub-ink);
      --livedub-accent: #2dd4bf;
      --livedub-accent-strong: #14b8a6;
      --livedub-accent-soft: rgba(45, 212, 191, 0.14);
      --livedub-ink: #f2f7f6;
      --livedub-ink-dim: #a9bcba;
      --livedub-ink-mute: #7f9694;
      --livedub-glass: rgba(12, 20, 20, 0.76);
      --livedub-glass-strong: rgba(10, 17, 17, 0.92);
      --livedub-glass-border: rgba(255, 255, 255, 0.12);
      --livedub-shadow: 0 10px 34px rgba(0, 0, 0, 0.42);
      --livedub-danger: #fb7185;
      --livedub-warn: #fbbf24;
      --livedub-radius: 16px;
      --livedub-radius-sm: 12px;
      --livedub-dur: 170ms;
    }
    @media (prefers-color-scheme: light) {
      .livedub-root {
        --livedub-ink: #12201f;
        --livedub-ink-dim: #43595a;
        --livedub-ink-mute: #67807f;
        --livedub-glass: rgba(250, 253, 252, 0.88);
        --livedub-glass-strong: rgba(252, 255, 254, 0.96);
        --livedub-glass-border: rgba(15, 40, 38, 0.12);
        --livedub-shadow: 0 10px 30px rgba(15, 40, 38, 0.16);
        --livedub-accent-soft: rgba(20, 184, 166, 0.12);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .livedub-root * { transition: none !important; animation: none !important; }
    }
    .livedub-glass {
      background: var(--livedub-glass);
      border: 1px solid var(--livedub-glass-border);
      box-shadow: var(--livedub-shadow);
      -webkit-backdrop-filter: blur(14px) saturate(1.2);
      backdrop-filter: blur(14px) saturate(1.2);
    }
    @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
      .livedub-glass { background: var(--livedub-glass-strong); }
    }
    /* ---------- 状态 pill ---------- */
    .livedub-capsule {
      position: fixed; top: 14px; right: 14px;
      display: inline-flex; align-items: center; gap: 8px;
      min-height: 32px; padding: 6px 12px; border-radius: 999px;
      background: var(--livedub-glass);
      border: 1px solid var(--livedub-glass-border);
      box-shadow: var(--livedub-shadow);
      -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
      color: var(--livedub-ink);
      font-size: 12.5px; line-height: 1; cursor: pointer;
      pointer-events: auto; user-select: none;
      transition: transform var(--livedub-dur) ease, background var(--livedub-dur) ease;
    }
    .livedub-capsule:hover { transform: translateY(-1px); }
    .livedub-capsule:focus-visible,
    .livedub-panel button:focus-visible,
    .livedub-panel input:focus-visible,
    .livedub-panel select:focus-visible,
    .livedub-panel [role="tab"]:focus-visible,
    .livedub-toast button:focus-visible {
      outline: 2px solid var(--livedub-accent);
      outline-offset: 2px;
    }
    .livedub-capsule .dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--livedub-ink-mute); flex: none;
      transition: background var(--livedub-dur) ease, box-shadow var(--livedub-dur) ease;
    }
    .livedub-capsule[data-tone="live"] .dot { background: var(--livedub-accent); box-shadow: 0 0 0 3px var(--livedub-accent-soft); }
    .livedub-capsule[data-tone="busy"] .dot { background: var(--livedub-warn); animation: livedub-pulse 1.4s ease-in-out infinite; }
    .livedub-capsule[data-tone="translate"] .dot { background: #60a5fa; }
    .livedub-capsule[data-tone="speak"] .dot { background: var(--livedub-accent-strong); box-shadow: 0 0 0 3px var(--livedub-accent-soft); }
    .livedub-capsule[data-tone="error"] .dot { background: var(--livedub-danger); }
    .livedub-capsule .state { font-weight: 600; letter-spacing: 0.2px; }
    .livedub-capsule .lat {
      color: var(--livedub-ink-dim); font-variant-numeric: tabular-nums;
      padding-left: 8px; border-left: 1px solid var(--livedub-glass-border);
    }
    .livedub-capsule .gear { color: var(--livedub-ink-dim); font-size: 12px; }
    @keyframes livedub-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
    /* ---------- 快捷面板 ---------- */
    .livedub-panel {
      position: fixed; top: 56px; right: 14px; width: 318px;
      max-height: calc(100vh - 82px); overflow-y: auto; overflow-x: hidden;
      padding: 0; border-radius: var(--livedub-radius);
      background: var(--livedub-glass-strong);
      border: 1px solid var(--livedub-glass-border);
      box-shadow: var(--livedub-shadow);
      -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px);
      pointer-events: auto; font-size: 12.5px; color: var(--livedub-ink);
      scrollbar-width: thin;
    }
    .livedub-panel[hidden] { display: none; }
    .livedub-panel-head {
      position: sticky; top: 0; z-index: 2;
      display: flex; align-items: center; gap: 8px;
      min-height: 44px; padding: 8px 10px 8px 12px;
      border-bottom: 1px solid var(--livedub-glass-border);
      background: var(--livedub-glass-strong);
      cursor: grab; user-select: none;
    }
    .livedub-panel-head:active { cursor: grabbing; }
    .livedub-panel-title { font-size: 12.5px; font-weight: 700; letter-spacing: 0.3px; white-space: nowrap; }
    .livedub-panel-title .brand { color: var(--livedub-accent-strong); }
    .livedub-panel-head .spacer { flex: 1; }
    .livedub-icon-btn {
      flex: none; width: 32px; height: 32px; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      background: transparent; border: 1px solid transparent; border-radius: 9px;
      color: var(--livedub-ink-dim); font-size: 15px; line-height: 1; cursor: pointer;
      transition: background var(--livedub-dur) ease, color var(--livedub-dur) ease;
    }
    .livedub-icon-btn:hover { background: var(--livedub-accent-soft); color: var(--livedub-ink); }
    .livedub-tabs { display: flex; gap: 2px; padding: 8px 10px 0; }
    .livedub-tabs [role="tab"] {
      flex: 1; min-height: 32px; padding: 6px 8px;
      background: transparent; border: none; border-bottom: 2px solid transparent;
      border-radius: 8px 8px 0 0; color: var(--livedub-ink-mute);
      font-size: 12.5px; font-weight: 600; font-family: inherit; cursor: pointer;
      transition: color var(--livedub-dur) ease, border-color var(--livedub-dur) ease, background var(--livedub-dur) ease;
    }
    .livedub-tabs [role="tab"]:hover { color: var(--livedub-ink); background: var(--livedub-accent-soft); }
    .livedub-tabs [role="tab"][aria-selected="true"] {
      color: var(--livedub-ink); border-bottom-color: var(--livedub-accent);
    }
    .livedub-panel-body[hidden] { display: none; }
    .livedub-tabpanel { padding: 10px 12px 6px; }
    .livedub-tabpanel[hidden] { display: none; }
    .livedub-group { margin: 0 0 12px; }
    .livedub-group-title {
      font-size: 10.5px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase;
      color: var(--livedub-ink-mute); margin: 2px 0 7px;
    }
    .livedub-row {
      display: flex; align-items: center; gap: 8px;
      min-height: 34px; margin: 4px 0;
    }
    .livedub-row .row-label { color: var(--livedub-ink-dim); flex: none; min-width: 44px; }
    .livedub-row .val { min-width: 42px; text-align: right; color: var(--livedub-ink-dim); font-variant-numeric: tabular-nums; font-size: 11px; }
    .livedub-row input[type="range"] { flex: 1; min-width: 0; accent-color: var(--livedub-accent-strong); height: 32px; }
    .livedub-row select {
      flex: 1; min-width: 0; min-height: 32px; padding: 4px 8px; border-radius: 9px;
      background: var(--livedub-accent-soft); border: 1px solid var(--livedub-glass-border);
      color: var(--livedub-ink); font-size: 12px; font-family: inherit;
    }
    .livedub-row select option { background: #0f1a19; color: #eef7f6; }
    @media (prefers-color-scheme: light) { .livedub-row select option { background: #ffffff; color: #12201f; } }
    /* 开关（switch） */
    .livedub-switch { position: relative; display: inline-flex; align-items: center; gap: 8px; flex: 1; min-height: 32px; cursor: pointer; }
    .livedub-switch input {
      appearance: none; -webkit-appearance: none; flex: none;
      width: 34px; height: 20px; margin: 0; border-radius: 999px;
      background: var(--livedub-glass-border); border: 1px solid var(--livedub-glass-border);
      cursor: pointer; transition: background var(--livedub-dur) ease;
    }
    .livedub-switch input::after {
      content: ""; display: block; width: 14px; height: 14px; margin: 2px;
      border-radius: 50%; background: var(--livedub-ink-dim);
      transition: transform var(--livedub-dur) ease, background var(--livedub-dur) ease;
    }
    .livedub-switch input:checked { background: var(--livedub-accent-soft); border-color: var(--livedub-accent-strong); }
    .livedub-switch input:checked::after { transform: translateX(14px); background: var(--livedub-accent-strong); }
    .livedub-switch .switch-label { color: var(--livedub-ink); font-size: 12.5px; }
    /* 分段控件 */
    .livedub-seg {
      display: inline-flex; gap: 2px; padding: 2px; flex: 1;
      background: var(--livedub-accent-soft); border: 1px solid var(--livedub-glass-border);
      border-radius: 10px;
    }
    .livedub-seg button {
      flex: 1; min-height: 28px; padding: 4px 8px;
      background: transparent; border: none; border-radius: 8px;
      color: var(--livedub-ink-dim); font-size: 12px; font-family: inherit; cursor: pointer;
      transition: background var(--livedub-dur) ease, color var(--livedub-dur) ease;
    }
    .livedub-seg button:hover { color: var(--livedub-ink); }
    .livedub-seg button.active { background: var(--livedub-glass-strong); color: var(--livedub-ink); box-shadow: 0 1px 3px rgba(0,0,0,0.2); }
    /* 按钮 */
    .livedub-panel button.livedub-btn {
      min-height: 34px; padding: 7px 10px; border-radius: 10px;
      border: 1px solid var(--livedub-glass-border);
      background: var(--livedub-accent-soft); color: var(--livedub-ink);
      font-size: 12px; font-family: inherit; cursor: pointer;
      transition: background var(--livedub-dur) ease, opacity var(--livedub-dur) ease;
    }
    .livedub-panel button.livedub-btn:hover:not(:disabled) { background: var(--livedub-glass); }
    .livedub-panel button.livedub-btn:disabled { opacity: 0.45; cursor: default; }
    .livedub-panel button.livedub-btn-primary {
      background: linear-gradient(135deg, var(--livedub-accent-strong), var(--livedub-accent));
      border-color: transparent; color: #062622; font-weight: 700;
    }
    .livedub-panel button.livedub-btn-primary:hover:not(:disabled) { filter: brightness(1.05); }
    .livedub-panel .livedub-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
    .livedub-panel .livedub-actions button { flex: 1; min-width: 84px; }
    .livedub-note-btn { width: 100%; margin-top: 4px; }
    .livedub-note-btn .spin {
      display: inline-block; width: 11px; height: 11px; margin-right: 6px;
      border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%;
      animation: livedub-spin 0.8s linear infinite; vertical-align: -1px;
    }
    @keyframes livedub-spin { to { transform: rotate(360deg); } }
    .livedub-meta {
      margin: 8px 0 0; padding-top: 8px;
      border-top: 1px dashed var(--livedub-glass-border);
      font-size: 11px; color: var(--livedub-ink-mute); line-height: 1.6; white-space: pre-line;
    }
    .livedub-meta[hidden] { display: none; }
    .livedub-note-summary { font-size: 11.5px; color: var(--livedub-ink-dim); padding: 2px 0 6px; }
    .livedub-guide {
      margin: 8px 0 2px; padding: 10px; border-radius: var(--livedub-radius-sm);
      background: var(--livedub-accent-soft); border: 1px solid rgba(45, 212, 191, 0.28);
      font-size: 11.5px; line-height: 1.55; color: var(--livedub-ink);
    }
    .livedub-guide[hidden] { display: none; }
    .livedub-guide .guide-title { font-weight: 700; margin-bottom: 4px; }
    .livedub-guide .guide-body { white-space: pre-line; color: var(--livedub-ink-dim); }
    .livedub-guide .guide-actions { display: flex; gap: 6px; margin-top: 8px; }
    .livedub-guide .guide-actions button { flex: 1; }
    .livedub-cmd {
      display: flex; align-items: center; gap: 6px; margin-top: 8px;
      padding: 6px 8px; border-radius: 9px;
      background: var(--livedub-glass); border: 1px solid var(--livedub-glass-border);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: var(--livedub-ink);
    }
    .livedub-cmd code { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .livedub-cmd button { min-height: 26px; padding: 3px 8px; flex: none; }
    .livedub-panel-footer {
      padding: 8px 12px 10px; border-top: 1px solid var(--livedub-glass-border);
      color: var(--livedub-ink-mute); font-size: 10.5px; line-height: 1.5;
    }
    .livedub-panel-footer kbd {
      font-family: inherit; padding: 1px 5px; border-radius: 5px;
      border: 1px solid var(--livedub-glass-border); background: var(--livedub-accent-soft);
      color: var(--livedub-ink-dim);
    }
    .livedub-error {
      margin-top: 8px; padding: 8px 10px; border-radius: var(--livedub-radius-sm);
      background: rgba(251, 113, 133, 0.14); border: 1px solid rgba(251, 113, 133, 0.36);
      color: var(--livedub-ink); font-size: 11.5px; line-height: 1.45;
    }
    .livedub-error[hidden] { display: none; }
    .livedub-error[data-kind="info"] {
      background: var(--livedub-accent-soft); border-color: rgba(45, 212, 191, 0.32);
    }
    /* ---------- toast 堆叠 ---------- */
    .livedub-toasts {
      position: fixed; top: 56px; left: 50%; transform: translateX(-50%);
      display: flex; flex-direction: column; gap: 8px; align-items: center;
      pointer-events: none; max-width: min(78vw, 760px); z-index: 3;
    }
    .livedub-toast {
      display: flex; align-items: center; gap: 8px;
      min-height: 36px; padding: 7px 8px 7px 12px; border-radius: 999px;
      background: var(--livedub-glass-strong);
      border: 1px solid var(--livedub-glass-border);
      box-shadow: var(--livedub-shadow);
      -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
      color: var(--livedub-ink); font-size: 12.5px; line-height: 1.35;
      pointer-events: auto; white-space: pre-line; text-align: center;
      animation: livedub-toast-in var(--livedub-dur) ease both;
    }
    @keyframes livedub-toast-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
    .livedub-toast[data-kind="warn"] { border-color: rgba(251, 191, 36, 0.42); }
    .livedub-toast[data-kind="error"] { border-color: rgba(251, 113, 133, 0.48); }
    .livedub-toast .toast-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--livedub-accent); flex: none; }
    .livedub-toast[data-kind="warn"] .toast-dot { background: var(--livedub-warn); }
    .livedub-toast[data-kind="error"] .toast-dot { background: var(--livedub-danger); }
    .livedub-toast .toast-spin {
      width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent;
      border-radius: 50%; animation: livedub-spin 0.8s linear infinite; flex: none;
    }
    .livedub-toast .toast-close {
      flex: none; width: 32px; height: 32px; margin: -4px -4px -4px 0;
      display: inline-flex; align-items: center; justify-content: center;
      background: transparent; border: none; border-radius: 999px;
      color: var(--livedub-ink-mute); font-size: 15px; cursor: pointer;
    }
    .livedub-toast .toast-close:hover { background: var(--livedub-accent-soft); color: var(--livedub-ink); }
    /* ---------- 字幕 ---------- */
    .livedub-subs {
      position: fixed; left: 50%; bottom: 8vh;
      transform: translateX(-50%);
      width: fit-content; max-width: min(78vw, 980px);
      display: flex; flex-direction: column; gap: 6px;
      pointer-events: auto; user-select: none;
      --livedub-subs-alpha: 0.72;
      --livedub-subs-accent: var(--livedub-accent);
    }
    .livedub-subs[hidden] { display: none; }
    .livedub-subs-handle {
      align-self: center; width: 56px; height: 18px; margin-bottom: -2px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 999px; background: var(--livedub-glass);
      border: 1px solid var(--livedub-glass-border);
      color: var(--livedub-ink-mute); font-size: 11px; letter-spacing: 2px;
      cursor: grab; pointer-events: auto; opacity: 0.55;
      transition: opacity var(--livedub-dur) ease, background var(--livedub-dur) ease;
    }
    .livedub-subs:hover .livedub-subs-handle { opacity: 1; }
    .livedub-subs-handle:active { cursor: grabbing; }
    .livedub-stack { display: flex; flex-direction: column; gap: 6px; }
    .livedub-block {
      position: relative; overflow: hidden;
      padding: 11px 18px 12px; border-radius: var(--livedub-radius);
      background: rgba(8, 15, 15, var(--livedub-subs-alpha, 0.72));
      border: 1px solid rgba(255, 255, 255, 0.09);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
      -webkit-backdrop-filter: blur(10px) saturate(1.1); backdrop-filter: blur(10px) saturate(1.1);
      text-align: center;
      transition: border-color var(--livedub-dur) ease;
    }
    @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
      .livedub-block { background: rgba(8, 15, 15, 0.92); }
    }
    .livedub-root[data-bg="light"] .livedub-block {
      background: rgba(248, 252, 251, var(--livedub-subs-alpha, 0.9));
      border-color: rgba(15, 40, 38, 0.1);
      box-shadow: 0 8px 26px rgba(15, 40, 38, 0.2);
    }
    .livedub-root[data-bg="none"] .livedub-block {
      background: transparent; border-color: transparent;
      box-shadow: none; -webkit-backdrop-filter: none; backdrop-filter: none;
      padding: 4px 8px 6px;
    }
    .livedub-progress {
      height: 2px; border-radius: 999px; margin: 0 2px -2px;
      background: rgba(255, 255, 255, 0.12); overflow: hidden;
    }
    .livedub-root[data-bg="light"] .livedub-progress { background: rgba(15, 40, 38, 0.12); }
    .livedub-progress > span {
      display: block; height: 100%; width: 0;
      background: linear-gradient(90deg, var(--livedub-accent), var(--livedub-accent-strong));
      border-radius: 999px;
    }
    .livedub-root[data-speaking="true"] .livedub-progress > span { box-shadow: 0 0 8px var(--livedub-accent); }
    .livedub-block .time {
      position: absolute; top: 6px; right: 10px;
      font-size: 10px; color: var(--livedub-ink-mute); font-variant-numeric: tabular-nums;
      opacity: 0.8;
    }
    .livedub-root[data-bg="light"] .livedub-block .time { color: #5d7675; }
    .livedub-block .dst {
      color: #ffffff; font-weight: 600;
      font-size: 1em; line-height: 1.4;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5); white-space: pre-line;
      letter-spacing: 0.1px;
    }
    .livedub-block .dst.draft { opacity: 0.78; font-weight: 500; }
    .livedub-block .src {
      color: #a8bcba; font-size: 0.62em; line-height: 1.4;
      margin-bottom: 4px; white-space: pre-line; font-weight: 500;
    }
    .livedub-block .src[hidden] { display: none; }
    .livedub-root[data-bg="light"] .livedub-block .dst { color: #0c1a19; text-shadow: none; }
    .livedub-root[data-bg="light"] .livedub-block .src { color: #4d6665; }
    .livedub-root[data-bg="light"] .livedub-block .dst.draft { color: #243b3a; }
    /* 原声 duck 指示 */
    .livedub-duck {
      position: fixed; right: 14px; bottom: calc(8vh + 2px);
      display: inline-flex; align-items: center; gap: 5px;
      min-height: 22px; padding: 2px 9px; border-radius: 999px;
      background: var(--livedub-glass); border: 1px solid var(--livedub-glass-border);
      color: var(--livedub-ink-dim); font-size: 10.5px;
      pointer-events: none; opacity: 0; transform: translateY(4px);
      transition: opacity var(--livedub-dur) ease, transform var(--livedub-dur) ease;
    }
    .livedub-duck[data-visible="true"] { opacity: 1; transform: translateY(0); }
    .livedub-duck .duck-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--livedub-accent); }
    /* 宽/紧凑两档 */
    .livedub-root[data-density="compact"] .livedub-block { padding: 8px 14px 9px; border-radius: var(--livedub-radius-sm); }
    .livedub-root[data-density="compact"] .livedub-block .dst { font-size: 0.92em; line-height: 1.32; }
    .livedub-root[data-density="compact"] .livedub-block .src { font-size: 0.58em; margin-bottom: 2px; }
    .livedub-root[data-density="compact"] .livedub-subs { max-width: min(86vw, 760px); }
    .livedub-root[data-density="compact"] .livedub-block .time { display: none; }
  `;

  function attachShadowStyles(shadow) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(OVERLAY_CSS);
      shadow.adoptedStyleSheets = [sheet];
      return;
    } catch {
      /* 受限环境回退到 <style> */
    }
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    shadow.appendChild(style);
  }

  function buildOverlay() {
    if (runtime.host) return runtime.host;
    const host = document.createElement('div');
    host.id = 'livedub-overlay-host';
    host.setAttribute('data-livedub', 'overlay');
    host.style.cssText =
      'all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; pointer-events: none !important; display: block !important;';
    const shadow = host.attachShadow({ mode: 'open' });
    attachShadowStyles(shadow);
    shadow.innerHTML = `
      <div class="livedub-root" data-part="root" data-bg="dark" data-density="wide" data-speaking="false">
        <div class="livedub-capsule" data-part="capsule" role="button" tabindex="0"
             aria-haspopup="dialog" aria-expanded="false" aria-label="livedub：打开快捷面板"
             title="livedub 快捷面板（Esc 关闭）">
          <span class="dot" aria-hidden="true"></span>
          <span class="state" data-part="state">未连接</span>
          <span class="lat" data-part="lat">—</span>
          <span class="gear" aria-hidden="true">⚙</span>
        </div>

        <div class="livedub-panel" data-part="panel" role="dialog" aria-modal="false"
             aria-label="livedub 快捷面板" hidden>
          <div class="livedub-panel-head" data-part="panel-head" title="拖动移动面板">
            <span class="livedub-panel-title"><span class="brand">livedub</span> 快捷面板</span>
            <span class="spacer"></span>
            <button type="button" class="livedub-icon-btn" data-act="collapse" data-part="collapse"
                    title="收起面板" aria-label="收起面板">▾</button>
            <button type="button" class="livedub-icon-btn" data-act="close-panel" data-part="close"
                    title="关闭面板（Esc）" aria-label="关闭面板">✕</button>
          </div>
          <div class="livedub-panel-body" data-part="panel-body">
            <div class="livedub-tabs" role="tablist" aria-label="快捷面板分区">
              <button type="button" role="tab" data-act="tab" data-tab="subtitles"
                      id="livedub-tab-subtitles" aria-controls="livedub-panel-subtitles"
                      aria-selected="true" tabindex="0">字幕</button>
              <button type="button" role="tab" data-act="tab" data-tab="notes"
                      id="livedub-tab-notes" aria-controls="livedub-panel-notes"
                      aria-selected="false" tabindex="-1">笔记</button>
              <button type="button" role="tab" data-act="tab" data-tab="settings"
                      id="livedub-tab-settings" aria-controls="livedub-panel-settings"
                      aria-selected="false" tabindex="-1">设置</button>
            </div>

            <div class="livedub-guide" data-part="guide" hidden role="status">
              <div class="guide-title" data-part="guide-title"></div>
              <div class="guide-body" data-part="guide-body"></div>
              <div class="guide-actions">
                <button type="button" class="livedub-btn" data-act="reconnect" aria-label="立即重连引擎">立即重连</button>
                <button type="button" class="livedub-btn livedub-btn-primary" data-act="start" aria-label="开始同传">开始同传</button>
              </div>
              <div class="livedub-cmd" data-part="guide-cmd" hidden>
                <code>npm start</code>
                <button type="button" class="livedub-btn" data-act="copy-command"
                        title="复制启动命令" aria-label="复制启动命令">复制</button>
              </div>
            </div>

            <div class="livedub-tabpanel" data-panel-tab="subtitles" id="livedub-panel-subtitles"
                 role="tabpanel" aria-labelledby="livedub-tab-subtitles">
              <div class="livedub-group">
                <div class="livedub-group-title">字幕样式</div>
                <div class="livedub-row">
                  <span class="row-label">宽度</span>
                  <span class="livedub-seg" role="group" aria-label="字幕宽度">
                    <button type="button" data-act="density-wide" title="宽屏字幕（默认）" aria-label="宽屏字幕">宽</button>
                    <button type="button" data-act="density-compact" title="紧凑字幕（小窗口）" aria-label="紧凑字幕">紧凑</button>
                  </span>
                </div>
                <div class="livedub-row">
                  <span class="row-label">位置</span>
                  <span class="livedub-seg" role="group" aria-label="字幕停靠位置">
                    <button type="button" data-act="dock-bottom" title="字幕停靠底部" aria-label="字幕停靠底部">底部</button>
                    <button type="button" data-act="dock-top" title="字幕停靠顶部" aria-label="字幕停靠顶部">顶部</button>
                  </span>
                </div>
                <div class="livedub-row">
                  <label for="livedub-offset">避让 <input id="livedub-offset" type="range" data-set="offsetY" min="-200" max="320" step="10" aria-label="字幕垂直避让像素" /></label>
                  <span class="val" data-val="offsetY"></span>
                </div>
                <div class="livedub-row">
                  <label for="livedub-font">字号 <input id="livedub-font" type="range" data-set="fontSize" min="14" max="32" step="1" aria-label="字幕字号" /></label>
                  <span class="val" data-val="fontSize"></span>
                </div>
                <div class="livedub-row">
                  <label class="livedub-switch"><input type="checkbox" data-set="showOriginal" role="switch" aria-label="显示原文" /><span class="switch-label">显示原文</span></label>
                </div>
              </div>
              <div class="livedub-group">
                <div class="livedub-group-title">字幕背景</div>
                <div class="livedub-row">
                  <label for="livedub-subsbg">背景 <select id="livedub-subsbg" data-set="subsBg" aria-label="字幕背景风格"><option value="dark">深色玻璃</option><option value="light">浅色玻璃</option><option value="none">无背景</option></select></label>
                </div>
                <div class="livedub-row">
                  <label for="livedub-subsopacity">不透明度 <input id="livedub-subsopacity" type="range" data-set="subsOpacity" min="0.2" max="1" step="0.02" aria-label="字幕背景不透明度" /></label>
                  <span class="val" data-val="subsOpacity"></span>
                </div>
              </div>
            </div>

            <div class="livedub-tabpanel" data-panel-tab="notes" id="livedub-panel-notes"
                 role="tabpanel" aria-labelledby="livedub-tab-notes" hidden>
              <div class="livedub-group">
                <div class="livedub-group-title">快捷笔记</div>
                <div class="livedub-note-summary" data-part="note-summary">今日 0 条 · 待同步 0</div>
                <button type="button" class="livedub-btn livedub-btn-primary livedub-note-btn" data-act="note"
                        data-part="note-btn" aria-label="记录当前句为笔记（Alt+Shift+N）" title="记录当前句（Alt+Shift+N）">记笔记</button>
                <div class="livedub-row">
                  <label class="livedub-switch"><input type="checkbox" data-set="noteScreenshot" role="switch" aria-label="附页面截图" /><span class="switch-label">附页面截图</span></label>
                </div>
                <div class="livedub-row">
                  <label class="livedub-switch"><input type="checkbox" data-set="visionOcr" role="switch" aria-label="识别画面文字 OCR" /><span class="switch-label">识别画面文字（OCR，快）</span></label>
                </div>
                <div class="livedub-row">
                  <label class="livedub-switch"><input type="checkbox" data-set="visionCaption" role="switch" aria-label="画面理解 VLM" /><span class="switch-label">画面理解（VLM，慢 20-30s）</span></label>
                </div>
                <div class="livedub-actions">
                  <button type="button" class="livedub-btn" data-act="export" aria-label="导出本次字幕 SRT" title="导出本次字幕 SRT">导出 SRT</button>
                </div>
              </div>
              <div class="livedub-meta" data-part="meta" hidden></div>
            </div>

            <div class="livedub-tabpanel" data-panel-tab="settings" id="livedub-panel-settings"
                 role="tabpanel" aria-labelledby="livedub-tab-settings" hidden>
              <div class="livedub-group">
                <div class="livedub-group-title">配音与原声</div>
                <div class="livedub-row">
                  <label class="livedub-switch"><input type="checkbox" data-set="dubEnabled" role="switch" aria-label="中文配音" /><span class="switch-label">中文配音</span></label>
                </div>
                <div class="livedub-row">
                  <label class="livedub-switch"><input type="checkbox" data-set="captureReplay" role="switch" aria-label="原声重放" /><span class="switch-label">原声重放（关闭 = 只听配音）</span></label>
                </div>
                <div class="livedub-row">
                  <label class="livedub-switch"><input type="checkbox" data-set="globalDuck" role="switch" aria-label="全局限定压音" /><span class="switch-label">全局限定压音（iframe/WebAudio）</span></label>
                </div>
                <div class="livedub-row">
                  <label for="livedub-duck">压音 <input id="livedub-duck" type="range" data-set="duckRatio" min="0.02" max="0.6" step="0.01" aria-label="压音比例" /></label>
                  <span class="val" data-val="duckRatio"></span>
                </div>
                <div class="livedub-row">
                  <label for="livedub-recover">恢复延迟 <input id="livedub-recover" type="range" data-set="duckRecoverMs" min="300" max="3000" step="100" aria-label="压音恢复延迟" /></label>
                  <span class="val" data-val="duckRecoverMs"></span>
                </div>
              </div>
              <div class="livedub-group">
                <div class="livedub-group-title">高级</div>
                <div class="livedub-row">
                  <label class="livedub-switch"><input type="checkbox" data-set="fullscreenWorkaround" role="switch" aria-label="video 全屏兼容" /><span class="switch-label">video 全屏兼容（包裹容器）</span></label>
                </div>
                <div class="livedub-actions">
                  <button type="button" class="livedub-btn livedub-btn-primary" data-act="toggle" aria-label="开始或停止同传">开始同传</button>
                  <button type="button" class="livedub-btn" data-act="hide" aria-label="隐藏字幕浮层">隐藏浮层</button>
                </div>
              </div>
            </div>

            <div class="livedub-error" data-part="error" role="alert" hidden></div>
          </div>
          <div class="livedub-panel-footer">
            <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> 记笔记 · <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> 开始/停止 · <kbd>Esc</kbd> 关闭面板
          </div>
        </div>

        <div class="livedub-toasts" data-part="toast" role="status" aria-live="polite" aria-atomic="false"></div>
        <div class="livedub-duck" data-part="duck" data-visible="false" aria-hidden="true"><span class="duck-dot"></span><span data-part="duck-label"></span></div>
        <div class="livedub-subs" data-part="subs" hidden>
          <div class="livedub-subs-handle" data-part="subs-handle" title="拖动字幕位置" aria-label="拖动字幕位置">⋯⋯</div>
          <div class="livedub-progress" data-part="progress" aria-hidden="true"><span data-part="progress-fill"></span></div>
          <div class="livedub-stack livedub-sub-list" data-part="sublist"></div>
        </div>
      </div>`;

    runtime.host = host;
    runtime.shadow = shadow;
    runtime.els = {
      root: shadow.querySelector('[data-part="root"]'),
      capsule: shadow.querySelector('[data-part="capsule"]'),
      state: shadow.querySelector('[data-part="state"]'),
      lat: shadow.querySelector('[data-part="lat"]'),
      panel: shadow.querySelector('[data-part="panel"]'),
      panelHead: shadow.querySelector('[data-part="panel-head"]'),
      panelBody: shadow.querySelector('[data-part="panel-body"]'),
      collapseButton: shadow.querySelector('[data-part="collapse"]'),
      closeButton: shadow.querySelector('[data-part="close"]'),
      guide: shadow.querySelector('[data-part="guide"]'),
      guideTitle: shadow.querySelector('[data-part="guide-title"]'),
      guideBody: shadow.querySelector('[data-part="guide-body"]'),
      guideCmd: shadow.querySelector('[data-part="guide-cmd"]'),
      meta: shadow.querySelector('[data-part="meta"]'),
      error: shadow.querySelector('[data-part="error"]'),
      subs: shadow.querySelector('[data-part="subs"]'),
      sublist: shadow.querySelector('[data-part="sublist"]'),
      toast: shadow.querySelector('[data-part="toast"]'),
      duck: shadow.querySelector('[data-part="duck"]'),
      duckLabel: shadow.querySelector('[data-part="duck-label"]'),
      progress: shadow.querySelector('[data-part="progress"]'),
      progressFill: shadow.querySelector('[data-part="progress-fill"]'),
      noteSummary: shadow.querySelector('[data-part="note-summary"]'),
      noteButton: shadow.querySelector('[data-part="note-btn"]'),
    };
    bindOverlayEvents();

    applyOverlayVisibility();
    applySubsLayout();
    applyPanelPosition();
    syncPanelControls();
    return host;
  }

  // -------------------------------------------------------------------------
  // 全屏兼容：宿主选择 / 迁移（与 lib/ui.js 等价）
  // -------------------------------------------------------------------------

  function isHostableFullscreenElement(el) {
    if (!el || typeof el !== 'object' || el.nodeType !== 1) return false;
    const tag = String(el.tagName || '').toUpperCase();
    if (!tag) return false;
    return !NON_HOSTABLE_TAGS.includes(tag);
  }

  function resolveHostTarget() {
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement || null;
    if (isHostableFullscreenElement(fullscreenElement)) {
      return { kind: 'fullscreen', element: fullscreenElement, bare: false };
    }
    return { kind: 'document', element: document.documentElement, bare: !!fullscreenElement };
  }

  /**
   * 保证浮层挂载在正确宿主：
   * - 原生全屏（容器型）-> 迁入 fullscreenElement（浮层随全屏一起显示）；
   * - 退出全屏 / <video> 直接全屏（无法承载子节点）-> 留在 documentElement。
   * 同一 host 元素迁移，不重建 Shadow DOM，状态/拖拽/面板位置都不丢。
   */
  function ensureMounted() {
    if (!document.documentElement) return false;
    if (!runtime.host) buildOverlay();
    const target = resolveHostTarget();
    const targetElement = target.element || document.documentElement;
    const needsMove =
      runtime.hostKind == null ||
      runtime.hostKind !== target.kind ||
      runtime.hostParent !== targetElement ||
      runtime.host.parentNode !== targetElement;
    if (needsMove) {
      try {
        targetElement.appendChild(runtime.host);
      } catch {
        if (document.documentElement) document.documentElement.appendChild(runtime.host);
      }
      runtime.hostKind = target.kind;
      runtime.hostParent = runtime.host.parentNode;
      runtime.fullscreenBareVideo = target.bare;
      applySubsLayout();
      applyPanelPosition();
    }
    if (!runtime.mounted) {
      runtime.mounted = true;
      renderStatus();
      renderSubtitles();
      renderMeta();
    }
    return true;
  }

  function onFullscreenChange() {
    const wasBare = runtime.fullscreenBareVideo;
    ensureMounted();
    applySubsLayout();
    applyPanelPosition();
    renderStatus();
    const stillFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (runtime.fullscreenBareVideo) {
      // <video> 直接全屏时浮层无法渲染，提示留到退出全屏后再展示（否则用户看不到）
      runtime.fullscreenHintShown = true;
    } else if (!stillFullscreen && wasBare && runtime.fullscreenHintShown) {
      runtime.fullscreenHintShown = false;
      showError(
        '刚才的站点以 <video> 元素直接进入原生全屏：浏览器不允许在视频元素上叠加自定义字幕浮层，所以全屏内看不到字幕。可改用站点「剧场 / 网页全屏」模式。',
        'info',
      );
    }
    if (!stillFullscreen) {
      runtime.fullscreenBareVideo = false;
    }
  }

  // -------------------------------------------------------------------------
  // 布局：字幕停靠/避让/背景 + 设置面板位置
  // -------------------------------------------------------------------------

  function computeSubsLayoutInline({ dock = 'bottom', offsetY = 0, dx = 0, viewportHeight = 800, baseVh = 0.08 } = {}) {
    const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 800;
    const basePx = Math.round(height * baseVh);
    const offset = Math.round(clampNumber(offsetY, OFFSET_Y_MIN, OFFSET_Y_MAX, 0));
    const offsetX = Math.round(clampNumber(dx, -OFFSET_X_LIMIT, OFFSET_X_LIMIT, 0));
    const transform = `translateX(-50%) translateX(${offsetX}px)`;
    if (dock === 'top') return { topPx: Math.max(8, basePx + offset), bottomPx: null, transform };
    return { topPx: null, bottomPx: Math.max(8, basePx + offset), transform };
  }

  function applySubsLayout() {
    const subs = runtime.els.subs;
    const root = runtime.els.root;
    if (!subs) return;
    const layout = computeSubsLayoutInline({
      dock: runtime.settings.dock,
      offsetY: runtime.settings.offsetY,
      dx: runtime.settings.dx,
      viewportHeight: window.innerHeight,
    });
    subs.style.top = layout.topPx == null ? '' : `${layout.topPx}px`;
    subs.style.bottom = layout.bottomPx == null ? '' : `${layout.bottomPx}px`;
    subs.style.transform = layout.transform;
    subs.style.setProperty('--livedub-subs-alpha', String(runtime.settings.subsOpacity));
    if (root) root.setAttribute('data-bg', runtime.settings.subsBg);
    if (runtime.els.sublist) runtime.els.sublist.style.fontSize = `${runtime.settings.fontSize}px`;
  }

  function applyOverlayVisibility() {
    if (!runtime.host) return;
    runtime.host.style.display = runtime.settings.hidden ? 'none' : 'block';
    if (runtime.els.capsule) runtime.els.capsule.style.display = runtime.settings.hidden ? 'none' : 'flex';
  }

  function clampPanelPosition(pos) {
    const maxX = Math.max(0, window.innerWidth - 120);
    const maxY = Math.max(0, window.innerHeight - 100);
    return {
      dx: Math.round(clampNumber(pos.dx, -maxX, maxX, 0)),
      dy: Math.round(clampNumber(pos.dy, -maxY, maxY, 0)),
    };
  }

  function applyPanelPosition() {
    const panel = runtime.els.panel;
    if (!panel) return;
    const pos = runtime.settings.panelPos || { dx: 0, dy: 0 };
    panel.style.transform = `translate(${pos.dx}px, ${pos.dy}px)`;
  }

  // -------------------------------------------------------------------------
  // 浮层事件 / 拖拽 / 面板
  // -------------------------------------------------------------------------

  function bindOverlayEvents() {
    const { capsule, panel, subs } = runtime.els;
    if (capsule) {
      capsule.addEventListener('click', (event) => {
        event.stopPropagation();
        togglePanel();
      });
      capsule.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          togglePanel();
        }
      });
    }
    if (panel) {
      panel.addEventListener('click', onPanelClick);
      panel.addEventListener('change', onPanelChange);
      panel.addEventListener('input', onPanelChange);
      panel.addEventListener('keydown', onPanelKeydown);
    }
    if (runtime.els.panelHead) {
      runtime.els.panelHead.addEventListener('pointerdown', onPanelPointerDown);
    }
    if (subs) {
      subs.addEventListener('pointerdown', onSubtitlePointerDown);
    }
    if (runtime.els.toast) {
      runtime.els.toast.addEventListener('click', (event) => {
        const button = event.target && event.target.closest ? event.target.closest('button[data-toast-id]') : null;
        if (!button) return;
        event.stopPropagation();
        dismissToast(button.getAttribute('data-toast-id'));
      });
    }
    document.addEventListener(
      'click',
      (event) => {
        if (!runtime.panelOpen) return;
        const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
        if (runtime.host && path.includes(runtime.host)) return;
        togglePanel(false);
      },
      true,
    );
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape') return;
        if (runtime.panelOpen) {
          event.preventDefault();
          togglePanel(false);
          return;
        }
        if (runtime.toasts.length > 0) dismissToast(runtime.toasts[runtime.toasts.length - 1].id);
      },
      true,
    );
    window.addEventListener('resize', () => {
      applySubsLayout();
      applyPanelPosition();
      applyDensity();
    });
    window.addEventListener('beforeunload', () => {
      restoreVolumes();
    });
    document.addEventListener('fullscreenchange', onFullscreenChange, true);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange, true);
    // v0.3：MAIN world page-hook 的包裹/回退通知
    window.addEventListener('message', onPageHookMessage);
  }

  /** 面板内键盘导航：tab 左右切换；Esc 由 document 统一处理 */
  function onPanelKeydown(event) {
    if (!event.target || !event.target.closest) return;
    const tab = event.target.closest('[data-act="tab"]');
    if (tab && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      const tabs = [...runtime.els.panel.querySelectorAll('[data-act="tab"]')].map((el) => el.getAttribute('data-tab'));
      const current = tabs.indexOf(runtime.activeTab);
      const next = tabs[(current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      setActiveTab(next);
      const nextTab = runtime.els.panel.querySelector(`[data-act="tab"][data-tab="${next}"]`);
      if (nextTab) nextTab.focus();
    }
  }

  function togglePanel(force) {
    const next = typeof force === 'boolean' ? force : !runtime.panelOpen;
    runtime.panelOpen = next;
    if (runtime.els.panel) runtime.els.panel.hidden = !next;
    if (runtime.els.capsule) {
      runtime.els.capsule.setAttribute('aria-expanded', next ? 'true' : 'false');
      runtime.els.capsule.dataset.open = next ? 'true' : 'false';
    }
    if (next) {
      if (runtime.settings.panelCollapsed) void saveSettings({ panelCollapsed: false });
      renderStatus();
    }
  }

  function onPanelClick(event) {
    const target = event.target;
    const button = target && target.closest ? target.closest('button[data-act]') : null;
    if (!button) return;
    const action = button.getAttribute('data-act');
    switch (action) {
      case 'toggle':
      case 'start':
        void toggleCapture();
        break;
      case 'hide':
        void saveSettings({ hidden: true });
        break;
      case 'export':
        void exportSrt();
        break;
      case 'reconnect':
        void retryConnection();
        break;
      case 'collapse':
        void saveSettings({ panelCollapsed: !runtime.settings.panelCollapsed });
        break;
      case 'dock-bottom':
        void saveSettings({ dock: 'bottom' });
        break;
      case 'dock-top':
        void saveSettings({ dock: 'top' });
        break;
      case 'density-wide':
        void saveSettings({ subsDensity: 'wide' });
        break;
      case 'density-compact':
        void saveSettings({ subsDensity: 'compact' });
        break;
      case 'tab':
        setActiveTab(button.getAttribute('data-tab'));
        break;
      case 'close-panel':
        togglePanel(false);
        break;
      case 'copy-command':
        void copyText('npm start', button);
        break;
      case 'note':
        void captureNote();
        break;
      default:
        break;
    }
  }

  /** v0.7：复制命令（引导卡） */
  async function copyText(text, button) {
    let copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.cssText = 'position:fixed;opacity:0;';
        document.body.appendChild(area);
        area.select();
        copied = document.execCommand('copy');
        area.remove();
      } catch {
        copied = false;
      }
    }
    showToast(copied ? `已复制：${text}` : `请手动执行：${text}`, copied ? 'ok' : 'warn', 2600);
    if (copied && button) {
      const original = button.textContent;
      button.textContent = '已复制';
      setTimeout(() => {
        button.textContent = original;
      }, 1400);
    }
  }

  function onPanelChange(event) {
    const target = event.target;
    if (!target || !target.getAttribute) return;
    const key = target.getAttribute('data-set');
    if (!key) return;
    let value;
    if (target.type === 'checkbox') value = target.checked;
    else if (target.tagName === 'SELECT') value = target.value;
    else value = Number(target.value);
    if (key === 'duckRatio') value = clampNumber(value, 0.02, 1, 0.18);
    if (key === 'fontSize') value = Math.round(clampNumber(value, 14, 32, 22));
    if (key === 'offsetY') value = Math.round(clampNumber(value, OFFSET_Y_MIN, OFFSET_Y_MAX, 0));
    if (key === 'subsOpacity') value = clampNumber(value, 0.2, 1, 0.82);
    if (key === 'duckRecoverMs') {
      value = Math.round(clampNumber(value, DUCK_RECOVER_MS_MIN, DUCK_RECOVER_MS_MAX, 800));
    }
    const valueEl = runtime.els.panel && runtime.els.panel.querySelector(`[data-val="${key}"]`);
    if (valueEl) valueEl.textContent = formatSettingValue(key, value);
    void saveSettings({ [key]: value });
  }

  // ---- 设置面板拖拽 ----

  function onPanelPointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    const target = event.target;
    if (target && target.closest && target.closest('button')) return; // 头部按钮不触发拖拽
    event.preventDefault();
    event.stopPropagation();
    const base = runtime.settings.panelPos || { dx: 0, dy: 0 };
    runtime.panelDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dx: base.dx,
      dy: base.dy,
      next: base,
    };
    try {
      runtime.els.panelHead.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    runtime.els.panelHead.addEventListener('pointermove', onPanelPointerMove);
    runtime.els.panelHead.addEventListener('pointerup', onPanelPointerUp);
    runtime.els.panelHead.addEventListener('pointercancel', onPanelPointerUp);
  }

  function onPanelPointerMove(event) {
    const drag = runtime.panelDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const next = { dx: drag.dx + (event.clientX - drag.startX), dy: drag.dy + (event.clientY - drag.startY) };
    drag.next = next;
    if (runtime.els.panel) runtime.els.panel.style.transform = `translate(${next.dx}px, ${next.dy}px)`;
  }

  function onPanelPointerUp(event) {
    const drag = runtime.panelDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    runtime.panelDrag = null;
    const head = runtime.els.panelHead;
    if (head) {
      head.removeEventListener('pointermove', onPanelPointerMove);
      head.removeEventListener('pointerup', onPanelPointerUp);
      head.removeEventListener('pointercancel', onPanelPointerUp);
      try {
        head.releasePointerCapture(drag.pointerId);
      } catch {
        /* ignore */
      }
    }
    const moved = Math.abs(drag.next.dx - drag.dx) + Math.abs(drag.next.dy - drag.dy);
    // 位置变化很小 = 点击而非拖拽：恢复到已保存位置，不写 storage
    if (moved < 3) {
      applyPanelPosition();
      return;
    }
    void saveSettings({ panelPos: clampPanelPosition({ dx: drag.next.dx, dy: drag.next.dy }) });
  }

  // ---- 字幕拖拽（横向 + 停靠侧避让） ----

  function onSubtitlePointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    const subs = runtime.els.subs;
    if (!subs) return;
    event.preventDefault();
    event.stopPropagation();
    runtime.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dx: runtime.settings.dx,
      offsetY: runtime.settings.offsetY,
      next: { dx: runtime.settings.dx, offsetY: runtime.settings.offsetY },
    };
    try {
      subs.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    subs.addEventListener('pointermove', onSubtitlePointerMove);
    subs.addEventListener('pointerup', onSubtitlePointerUp);
    subs.addEventListener('pointercancel', onSubtitlePointerUp);
  }

  function onSubtitlePointerMove(event) {
    const drag = runtime.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    // bottom 停靠：向上拖 = 避让增大；top 停靠：向下拖 = 避让增大
    const sign = runtime.settings.dock === 'top' ? 1 : -1;
    const next = { dx: drag.dx + deltaX, offsetY: drag.offsetY + sign * deltaY };
    drag.next = next;
    const layout = computeSubsLayoutInline({
      dock: runtime.settings.dock,
      offsetY: next.offsetY,
      dx: next.dx,
      viewportHeight: window.innerHeight,
    });
    const subs = runtime.els.subs;
    if (!subs) return;
    subs.style.top = layout.topPx == null ? '' : `${layout.topPx}px`;
    subs.style.bottom = layout.bottomPx == null ? '' : `${layout.bottomPx}px`;
    subs.style.transform = layout.transform;
  }

  function onSubtitlePointerUp(event) {
    const drag = runtime.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    runtime.drag = null;
    const subs = runtime.els.subs;
    if (subs) {
      subs.removeEventListener('pointermove', onSubtitlePointerMove);
      subs.removeEventListener('pointerup', onSubtitlePointerUp);
      subs.removeEventListener('pointercancel', onSubtitlePointerUp);
      try {
        subs.releasePointerCapture(drag.pointerId);
      } catch {
        /* ignore */
      }
    }
    const moved = Math.abs(drag.next.dx - drag.dx) + Math.abs(drag.next.offsetY - drag.offsetY);
    if (moved < 3) {
      // 只是点了一下字幕（没有拖动）：恢复布局，不写 storage
      applySubsLayout();
      return;
    }
    void saveSettings({ dx: drag.next.dx, offsetY: drag.next.offsetY });
  }

  // -------------------------------------------------------------------------
  // 压音：记录页面 media 原音量，说话时压到 duckRatio，空闲 800ms 恢复
  // -------------------------------------------------------------------------

  function collectMedia() {
    const next = [];
    let media = [];
    try {
      media = document.querySelectorAll('video, audio');
    } catch {
      media = [];
    }
    for (const el of media) {
      if (!(el instanceof HTMLMediaElement)) continue;
      if (!runtime.trackedMedia.has(el)) {
        let volume = 1;
        try {
          volume = el.volume;
        } catch {
          volume = 1;
        }
        runtime.trackedMedia.set(el, volume);
        next.push(el);
      }
    }
    return next;
  }

  function applyDuckVolumes(elements) {
    const ratio = runtime.settings.duckRatio;
    for (const el of elements) {
      const original = runtime.trackedMedia.get(el);
      if (original == null) continue;
      try {
        el.volume = Math.min(1, Math.max(0, original * ratio));
      } catch {
        /* 某些自定义播放器 volume 只读，忽略 */
      }
    }
  }

  function duckStart() {
    // v0.3 主方案：offscreen 原声总线 GainNode 已负责压音；content 只在兜底模式下改 volume
    if (runtime.settings.globalDuck !== false) {
      restoreVolumes();
      return;
    }
    const fresh = collectMedia();
    if (!runtime.duck.ducking) {
      runtime.duck.ducking = true;
      applyDuckVolumes([...runtime.trackedMedia.keys()]);
    } else if (fresh.length > 0) {
      applyDuckVolumes(fresh);
    }
    runtime.duck.idleSince = null;
    runtime.duck.lastActivity = now();
  }

  function duckActivity() {
    if (runtime.settings.globalDuck !== false) {
      restoreVolumes();
      return;
    }
    if (!runtime.duck.ducking) {
      duckStart();
      return;
    }
    const fresh = collectMedia();
    if (fresh.length > 0) applyDuckVolumes(fresh);
    runtime.duck.idleSince = null;
    runtime.duck.lastActivity = now();
  }

  function duckIdle() {
    if (!runtime.duck.ducking) return;
    if (runtime.duck.idleSince == null) runtime.duck.idleSince = now();
  }

  function restoreVolumes() {
    for (const [el, original] of runtime.trackedMedia) {
      try {
        el.volume = original;
      } catch {
        /* ignore */
      }
    }
    runtime.trackedMedia.clear();
    runtime.duck.ducking = false;
    runtime.duck.idleSince = null;
  }

  function duckTick() {
    if (!runtime.duck.ducking) return;
    const t = now();
    if (runtime.duck.idleSince != null && t - runtime.duck.idleSince >= IDLE_RESTORE_MS) {
      restoreVolumes();
      return;
    }
    if (runtime.duck.idleSince == null && t - runtime.duck.lastActivity >= IDLE_RESTORE_MS) {
      // 引擎仍报 speaking 时放宽兜底窗口：避免两句配音之间音量来回抖动
      const speaking = runtime.bgState && runtime.bgState.engineState === 'speaking';
      if (!speaking || t - runtime.duck.lastActivity >= 3000) restoreVolumes();
    }
  }

  // -------------------------------------------------------------------------
  // 状态 / 字幕渲染
  // -------------------------------------------------------------------------

  function isActive() {
    const state = runtime.bgState;
    return !!state && (state.phase === 'running' || state.phase === 'starting');
  }

  function statusSummary() {
    const state = runtime.bgState;
    if (!state) return { label: '未连接', tone: 'idle' };
    if (state.error && (state.phase === 'error' || state.error.scope === 'capture')) {
      return { label: '抓音失败', tone: 'error' };
    }
    if (state.phase === 'starting') return { label: '连接中…', tone: 'busy' };
    if (state.phase === 'stopping') return { label: '停止中…', tone: 'busy' };
    if (state.phase === 'error') return { label: '异常', tone: 'error' };
    if (state.phase === 'running') {
      if (state.connection === 'connecting') return { label: '重连中…', tone: 'busy' };
      if (state.connection === 'closed') return { label: '已断开', tone: 'busy' };
      const engineState = state.engineState;
      if (engineState === 'speaking') return { label: '配音中', tone: 'speak' };
      if (engineState === 'translating') return { label: '翻译中', tone: 'translate' };
      if (engineState === 'listening') return { label: '收听中', tone: 'live' };
      if (engineState === 'paused') return { label: '已暂停', tone: 'idle' };
      if (engineState === 'error' || state.error) return { label: '引擎异常', tone: 'error' };
      return { label: '已连接', tone: 'live' };
    }
    return { label: '未连接', tone: 'idle' };
  }

  function formatLatency(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
    const value = Math.max(0, ms);
    return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
  }

  function latencyFromMetrics(metrics) {
    if (!metrics || typeof metrics !== 'object') return null;
    if (typeof metrics.e2eLagMs === 'number' && Number.isFinite(metrics.e2eLagMs)) return metrics.e2eLagMs;
    const parts = [metrics.asrFinalMs, metrics.mtDoneMs, metrics.ttsFirstMs].filter(
      (v) => typeof v === 'number' && Number.isFinite(v),
    );
    return parts.length > 0 ? parts.reduce((sum, v) => sum + v, 0) : null;
  }

  function currentLatency() {
    if (runtime.metrics) {
      const value = latencyFromMetrics(runtime.metrics);
      if (value != null) return value;
    }
    return runtime.bgState && typeof runtime.bgState.latencyMs === 'number' ? runtime.bgState.latencyMs : null;
  }

  function providerSummary() {
    const ready = runtime.bgState && runtime.bgState.ready;
    if (!ready || !ready.providers) return '';
    const providers = ready.providers;
    const names = [providers.asr, providers.translate, providers.tts].filter(Boolean);
    return names.length > 0 ? names.join(' · ') : '';
  }

  function voiceSummary() {
    const state = runtime.bgState;
    const voice = (state && state.voice) || (state && state.ready && state.ready.voice) || null;
    if (!voice) return '';
    const mode = voice.mode === 'clone' ? '克隆' : '预设';
    const degraded = voice.degraded ? '（已降级）' : '';
    return `${mode}${voice.voiceId ? ` · ${voice.voiceId}` : ''}${degraded}`;
  }

  function languageSummary() {
    const state = runtime.bgState;
    const session = state && state.session;
    if (!session) return '';
    return `${session.langFrom || 'en'} → ${session.langTo || 'zh'}`;
  }

  function latencyBreakdownLines() {
    const metrics = runtime.metrics || (runtime.bgState && runtime.bgState.metrics);
    if (!metrics) return [];
    const lines = [];
    if (Number.isFinite(metrics.asrFinalMs)) lines.push(`ASR ${formatLatency(metrics.asrFinalMs)}`);
    if (Number.isFinite(metrics.mtFirstMs)) lines.push(`翻译首字 ${formatLatency(metrics.mtFirstMs)}`);
    else if (Number.isFinite(metrics.mtDoneMs)) lines.push(`翻译 ${formatLatency(metrics.mtDoneMs)}`);
    if (Number.isFinite(metrics.ttsFirstMs)) lines.push(`配音 ${formatLatency(metrics.ttsFirstMs)}`);
    const e2e = latencyFromMetrics(metrics);
    if (e2e != null) lines.push(`端到端 ${formatLatency(e2e)}`);
    return lines;
  }

  /** v0.7：状态 pill + duck 指示 + 笔记按钮/摘要 + 进度线 */
  function renderStatus() {
    const capsule = runtime.els.capsule;
    if (!capsule) return;
    const summary = statusSummary();
    capsule.setAttribute('data-tone', summary.tone);
    if (runtime.els.state) runtime.els.state.textContent = summary.label;
    if (runtime.els.lat) runtime.els.lat.textContent = formatLatency(currentLatency());
    const state = runtime.bgState;
    const active = isActive();
    for (const button of runtime.els.panel ? runtime.els.panel.querySelectorAll('button[data-act="toggle"]') : []) {
      button.textContent = active ? '停止同传' : '开始同传';
    }
    capsule.title = `livedub：${summary.label}${state && state.engineState ? `（引擎 ${state.engineState}）` : ''}，点击打开快捷面板`;
    if (runtime.els.root) {
      runtime.els.root.setAttribute('data-speaking', state && state.engineState === 'speaking' ? 'true' : 'false');
    }
    renderDuckIndicator(state);
    renderNoteSummary();
    renderNoteButton();
    syncAriaState();
    renderGuidance();
    renderMeta();
    renderExportState();
  }

  /** 原声 duck 指示：说话且重放原声时显示「原声已压低」 */
  function renderDuckIndicator(state) {
    const el = runtime.els.duck;
    if (!el) return;
    const speaking = !!state && state.engineState === 'speaking';
    const visible = speaking && runtime.settings.captureReplay !== false;
    el.setAttribute('data-visible', visible ? 'true' : 'false');
    if (runtime.els.duckLabel) {
      runtime.els.duckLabel.textContent =
        runtime.settings.globalDuck === false ? '页面音量压音中' : '原声已压低';
    }
  }

  function renderExportState() {
    const count = (runtime.bgState && runtime.bgState.captionCount) || 0;
    const button = runtime.els.panel ? runtime.els.panel.querySelector('button[data-act="export"]') : null;
    if (button) {
      button.disabled = count === 0;
      button.title = count === 0 ? '先开始同传并让视频说几句话，才有字幕可导出' : `导出本次 ${count} 条字幕（SRT）`;
      button.setAttribute('aria-disabled', count === 0 ? 'true' : 'false');
    }
  }

  /** 统一引导卡：空态（npm start 可复制）/ 断线重连 / 抓音失败 */
  function renderGuidance() {
    const guide = runtime.els.guide;
    if (!guide) return;
    const state = runtime.bgState;
    const active = isActive();
    let info = null;
    if (!state || (!active && !state.error)) {
      info = {
        title: '未连接本地引擎',
        body: '① 在 livedub 目录执行 npm start\n② 确认 http://127.0.0.1:8787/health 可访问\n③ 打开视频后点「开始同传」',
        showRetry: false,
        showStart: true,
        copyCommand: 'npm start',
      };
    } else if (active && state.connection === 'closed') {
      info = {
        title: '引擎连接断开，正在自动重连…',
        body: '确认引擎进程仍在运行（npm start），或点「立即重连」跳过退避重试。',
        showRetry: true,
        showStart: false,
        copyCommand: 'npm start',
      };
    } else if (state.phase === 'error') {
      info = {
        title: '抓音失败',
        body: `${(state.error && state.error.message) || '请检查页面与引擎状态后重试。'}\n确认引擎已启动后再点「开始同传」。`,
        showRetry: false,
        showStart: true,
        copyCommand: 'npm start',
      };
    }
    guide.hidden = !info;
    if (!info) return;
    if (runtime.els.guideTitle) runtime.els.guideTitle.textContent = info.title;
    if (runtime.els.guideBody) runtime.els.guideBody.textContent = info.body;
    const retryButton = guide.querySelector('button[data-act="reconnect"]');
    const startButton = guide.querySelector('button[data-act="start"]');
    if (retryButton) retryButton.style.display = info.showRetry ? '' : 'none';
    if (startButton) startButton.style.display = info.showStart ? '' : 'none';
    if (runtime.els.guideCmd) runtime.els.guideCmd.hidden = !info.copyCommand;
  }

  function renderMeta() {
    const meta = runtime.els.meta;
    if (!meta) return;
    const lines = [];
    const providers = providerSummary();
    const voice = voiceSummary();
    const language = languageSummary();
    if (providers) lines.push(`引擎 ${providers}`);
    if (voice) lines.push(`音色 ${voice}`);
    if (language) lines.push(`语言 ${language}`);
    const audioMode = runtime.settings.captureReplay !== false
      ? runtime.settings.globalDuck !== false
        ? '原声重放 · 全局压音'
        : '原声重放 · 页面音量兜底'
      : '原声关闭（只听配音）';
    lines.push(`原声 ${audioMode}`);
    const latency = latencyBreakdownLines();
    if (latency.length > 0) lines.push(`延迟 ${latency.join(' · ')}`);
    const count = (runtime.bgState && runtime.bgState.captionCount) || 0;
    if (count > 0) lines.push(`本次字幕 ${count} 条（可导出 SRT）`);
    const noteStats = runtime.bgState && runtime.bgState.noteStats;
    if (noteStats && noteStats.count > 0) lines.push(`今日笔记 ${noteStats.count} 条`);
    const noteQueueCount = (runtime.bgState && runtime.bgState.noteQueueCount) || 0;
    if (noteQueueCount > 0) lines.push(`离线待同步笔记 ${noteQueueCount} 条`);
    const visionHealth = runtime.bgState && runtime.bgState.visionHealth;
    if (visionHealth && (visionHealth.ocrLabel || visionHealth.visionLabel)) {
      lines.push(`画面 ${visionHealth.ocrLabel || 'OCR ?'} · ${visionHealth.visionLabel || 'VLM ?'}`);
    }
    meta.hidden = lines.length === 0;
    meta.textContent = lines.join('\n');
  }

  /** v0.7：toast 堆叠（最多 3 条，可关闭；成功/排队/失败不同色调） */
  function planToastStackInline({ existing = [], next = null, max = 3 } = {}) {
    const limit = Math.max(1, max);
    const items = Array.isArray(existing) ? existing.slice(-limit) : [];
    if (!next) return { items };
    items.push(next);
    while (items.length > limit) items.shift();
    return { items };
  }

  function renderToasts() {
    const container = runtime.els.toast;
    if (!container) return;
    container.textContent = '';
    for (const item of runtime.toasts) {
      const toast = document.createElement('div');
      toast.className = 'livedub-toast';
      toast.setAttribute('data-kind', item.kind || 'ok');
      toast.setAttribute('data-toast-id', item.id);
      const dot = document.createElement('span');
      dot.className = item.loading ? 'toast-spin' : 'toast-dot';
      dot.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.className = 'toast-text';
      text.textContent = item.text;
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'toast-close';
      close.setAttribute('data-toast-id', item.id);
      close.setAttribute('aria-label', '关闭提示');
      close.title = '关闭提示';
      close.textContent = '✕';
      toast.appendChild(dot);
      toast.appendChild(text);
      toast.appendChild(close);
      container.appendChild(toast);
    }
  }

  function showToast(message, kind = 'ok', durationMs = 2600, options = {}) {
    const container = runtime.els.toast;
    if (!container) return;
    const id = `toast-${Date.now()}-${Math.round(Math.random() * 9999)}`;
    const next = {
      id,
      text: String(message || ''),
      kind,
      loading: options.loading === true,
      createdAt: Date.now(),
    };
    runtime.toasts = planToastStackInline({ existing: runtime.toasts, next, max: 3 }).items;
    renderToasts();
    if (runtime.toastTimers == null) runtime.toastTimers = new Map();
    const timer = setTimeout(() => dismissToast(id), Math.max(900, durationMs));
    runtime.toastTimers.set(id, timer);
  }

  function dismissToast(id) {
    runtime.toasts = runtime.toasts.filter((item) => item.id !== id);
    if (runtime.toastTimers && runtime.toastTimers.has(id)) {
      clearTimeout(runtime.toastTimers.get(id));
      runtime.toastTimers.delete(id);
    }
    renderToasts();
  }

  /** 找页面主视频（优先正在播放、其次有 duration 的） */
  function findPrimaryVideo() {
    let videos = [];
    try {
      videos = [...document.querySelectorAll('video')];
    } catch {
      videos = [];
    }
    if (videos.length === 0) return null;
    const playing = videos.find((video) => !video.paused && video.readyState > 0);
    if (playing) return playing;
    const withDuration = videos.find((video) => Number.isFinite(video.duration) && video.duration > 0);
    return withDuration || videos[0] || null;
  }

  /** 缓存最近一句字幕（partial/segment/translation 增量合并，停止抓音后仍可用） */
  function trackCaption(event) {
    if (!event || typeof event !== 'object') return;
    const id = `u:${event.id ?? ''}`;
    let caption = runtime.lastCaption;
    if (!caption || caption.id !== id) {
      caption = { id, src: '', dst: '', t0Ms: null, t1Ms: null, updatedAt: now() };
      runtime.lastCaption = caption;
    }
    if (event.type === 'partial' || event.type === 'segment') {
      if (event.text != null) caption.src = cleanText(event.text, 600);
    }
    if (event.type === 'segment') {
      if (Number.isFinite(event.t0Ms)) caption.t0Ms = Math.round(event.t0Ms);
      if (Number.isFinite(event.t1Ms)) caption.t1Ms = Math.round(event.t1Ms);
    }
    if (event.type === 'translation' && event.text != null) {
      caption.dst = cleanText(event.text, 600);
    }
    caption.updatedAt = now();
  }

  /** background 记笔记时请求的上下文（视频/时间轴/最近一句双语字幕） */
  function buildNoteContext() {
    const video = findPrimaryVideo();
    const caption = runtime.lastCaption;
    const currentMs = video && Number.isFinite(video.currentTime) ? Math.round(video.currentTime * 1000) : null;
    const tMs = currentMs != null ? currentMs : caption && Number.isFinite(caption.t1Ms) ? caption.t1Ms : 0;
    const durationMs =
      video && Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 1000) : undefined;
    const quotes =
      caption && (caption.src || caption.dst)
        ? [{ t0Ms: caption.t0Ms ?? undefined, t1Ms: caption.t1Ms ?? undefined, src: caption.src, dst: caption.dst }]
        : [];
    return {
      ok: true,
      context: {
        url: location.href,
        title: document.title,
        durationMs: durationMs || 0,
        tMs,
        text: (caption && (caption.dst || caption.src)) || '（无字幕）',
        quotes,
        hasVideo: !!video,
        capturing: isActive(),
      },
    };
  }

  /** 面板「记笔记」按钮：交给 background 处理截图 + POST（需要用户手势已由点击提供） */
  async function captureNote() {
    if (runtime.notePending) return;
    runtime.notePending = true;
    renderNoteButton();
    try {
      const response = await chrome.runtime.sendMessage({
        type: M.CAPTURE_NOTE,
        withScreenshot: runtime.settings.noteScreenshot !== false,
        trigger: 'overlay',
      });
      if (response && response.ok) {
        showToast(response.toast || '已记笔记', response.queued ? 'warn' : 'ok');
      } else {
        showToast((response && response.error && response.error.message) || '记笔记失败，请重试', 'error', 5200);
      }
    } catch (err) {
      showToast(`记笔记失败：${String((err && err.message) || err)}`, 'error', 5200);
    } finally {
      runtime.notePending = false;
      renderNoteButton();
    }
  }

  function showError(message, kind = 'error') {
    if (!runtime.els.error) return;
    if (runtime.errorTimer) clearTimeout(runtime.errorTimer);
    runtime.els.error.hidden = false;
    runtime.els.error.setAttribute('data-kind', kind);
    runtime.els.error.textContent = String(message || '');
    runtime.errorTimer = setTimeout(() => {
      runtime.errorTimer = null;
      if (runtime.els.error) runtime.els.error.hidden = true;
    }, 9000);
  }

  function cleanText(text, maxLen) {
    if (text == null) return '';
    const clean = String(text)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (clean.length <= maxLen) return clean;
    return `${clean.slice(0, Math.max(1, maxLen - 1))}…`;
  }

  function upsertItem(key, patch) {
    const existing = runtime.items.get(key);
    const item = existing ? { ...existing, ...patch } : { key, src: '', dst: '', draft: false, ts: now(), ...patch };
    item.ts = now();
    if (!existing) restartCaptionProgress(item);
    if (patch.dst != null) item.dst = cleanText(patch.dst, 600);
    if (patch.src != null) item.src = cleanText(patch.src, 600);
    runtime.items.set(key, item);
    pruneItems();
    renderSubtitles();
  }

  function pruneItems() {
    const cutoff = now() - BLOCK_TTL_MS;
    for (const [key, item] of runtime.items) {
      if (item.ts < cutoff) runtime.items.delete(key);
    }
    while (runtime.items.size > MAX_BLOCKS) {
      const firstKey = runtime.items.keys().next().value;
      runtime.items.delete(firstKey);
    }
  }

  /** 时间码 mm:ss（>=1h 为 h:mm:ss） */
  function formatTimecodeUi(ms) {
    const value = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
    const total = Math.floor(value / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
  }

  /** 估算字幕展示时长（进度线动画） */
  function estimateCaptionDurationUIMs({ text = '', t0Ms = null, t1Ms = null } = {}) {
    const span = Number.isFinite(t0Ms) && Number.isFinite(t1Ms) && t1Ms > t0Ms ? Math.round(t1Ms - t0Ms) : 0;
    if (span > 0) return Math.min(8000, Math.max(1200, span));
    const chars = String(text == null ? '' : text).replace(/\s+/g, '').length;
    return Math.min(6000, Math.max(1200, Math.round(900 + chars * 55)));
  }

  /** 新一句字幕到达：重置顶部 accent 进度线 */
  function restartCaptionProgress(item) {
    const fill = runtime.els.progressFill;
    if (!fill) return;
    const duration = estimateCaptionDurationUIMs({
      text: (item && (item.src || item.dst)) || '',
      t0Ms: item && item.t0Ms,
      t1Ms: item && item.t1Ms,
    });
    runtime.progressStartedAt = Date.now();
    runtime.progressDurationMs = duration;
    const reduced =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      fill.style.transition = 'none';
      fill.style.width = '100%';
      return;
    }
    fill.style.transition = 'none';
    fill.style.width = '0%';
    void fill.offsetWidth;
    fill.style.transition = `width ${duration}ms linear`;
    requestAnimationFrame(() => {
      fill.style.width = '100%';
    });
  }

  /** 双语字幕块：译文大字优先、原文次级、右上角时间码 */
  function renderSubtitles() {
    const { subs, sublist } = runtime.els;
    if (!subs || !sublist) return;
    const items = [...runtime.items.values()].slice(-2);
    const hasContent = items.some((item) => item.src || item.dst);
    subs.hidden = !hasContent;
    if (!hasContent) {
      sublist.textContent = '';
      return;
    }
    sublist.textContent = '';
    for (const item of items) {
      const block = document.createElement('div');
      block.className = 'livedub-block';
      block.setAttribute('data-block-id', item.key);
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = formatTimecodeUi(Number.isFinite(item.t0Ms) ? item.t0Ms : item.ts);
      time.setAttribute('aria-hidden', 'true');
      const src = document.createElement('div');
      src.className = 'src';
      src.textContent = runtime.settings.showOriginal ? item.src : '';
      src.hidden = !runtime.settings.showOriginal || !item.src;
      const dst = document.createElement('div');
      dst.className = 'dst';
      if (!item.dst) {
        dst.classList.add('draft');
        dst.textContent = item.src || '…';
      } else {
        if (item.draft) dst.classList.add('draft');
        dst.textContent = item.dst;
      }
      block.appendChild(time);
      block.appendChild(src);
      block.appendChild(dst);
      sublist.appendChild(block);
    }
  }

  // -------------------------------------------------------------------------
  // 引擎事件 / background 状态
  // -------------------------------------------------------------------------

  function handleEngineEvent(event) {
    if (!event || typeof event.type !== 'string') return;
    switch (event.type) {
      case 'ready':
        runtime.metrics = null;
        renderStatus();
        break;
      case 'partial':
        trackCaption(event);
        upsertItem(`u:${event.id ?? 'partial'}`, { src: event.text, draft: true });
        break;
      case 'segment': {
        trackCaption(event);
        const key = `u:${event.id ?? 'segment'}`;
        if (!runtime.items.has(key)) {
          const last = [...runtime.items.values()].pop();
          if (last && last.draft) runtime.items.delete(last.key);
        }
        upsertItem(key, {
          src: event.text,
          draft: false,
          t0Ms: Number.isFinite(event.t0Ms) ? event.t0Ms : null,
          t1Ms: Number.isFinite(event.t1Ms) ? event.t1Ms : null,
        });
        break;
      }
      case 'translation':
        trackCaption(event);
        upsertItem(`u:${event.id ?? 'segment'}`, { dst: event.text, draft: event.final === false });
        break;
      case 'dub':
        duckActivity();
        break;
      case 'status': {
        if (event.state === 'speaking') duckStart();
        else duckIdle();
        if (runtime.bgState) {
          runtime.bgState = { ...runtime.bgState, engineState: event.state || runtime.bgState.engineState };
          if (runtime.els.root) {
            runtime.els.root.setAttribute('data-speaking', event.state === 'speaking' ? 'true' : 'false');
          }
          renderStatus();
        }
        break;
      }
      case 'metrics': {
        runtime.metrics = event;
        renderStatus();
        break;
      }
      case 'voice':
        if (event.degraded && event.reason) showError(`音色已降级为预设（${event.reason}）`, 'info');
        renderMeta();
        break;
      case 'error':
        if (event.message) showError(`引擎错误（${event.scope || 'session'}）：${event.message}`, 'error');
        break;
      case 'bye':
        duckIdle();
        break;
      default:
        break;
    }
  }

  function handleBgState(state, settings) {
    if (settings) applySettings(settings);
    if (!state) return;
    const previous = runtime.bgState;
    runtime.bgState = { ...(previous || {}), ...state };
    if (state.startedAt && state.startedAt !== runtime.sessionKey) {
      runtime.sessionKey = state.startedAt;
      runtime.items.clear();
      runtime.metrics = null;
      runtime.error = null;
      if (runtime.els.error) runtime.els.error.hidden = true;
      renderSubtitles();
    }
    const wasActive = previous && (previous.phase === 'running' || previous.phase === 'starting');
    if (wasActive && state.phase !== 'running' && state.phase !== 'starting') {
      // 结束会话：恢复所有被压音元素 + 停掉压音状态机
      restoreVolumes();
    }
    if (state.metrics) runtime.metrics = state.metrics;
    if (state.error && state.error.message) showError(state.error.message, 'error');
    if (state.notice) showError(state.notice, 'info');
    renderStatus();
  }

  // -------------------------------------------------------------------------
  // 动作：开始/停止、重试连接、导出 SRT
  // -------------------------------------------------------------------------

  async function toggleCapture() {
    try {
      const response = await chrome.runtime.sendMessage({ type: M.CONTENT_TOGGLE, href: location.href });
      if (response && response.ok === false && response.error) {
        showError(response.error.message || String(response.error), 'error');
      } else if (response && response.state) {
        handleBgState(response.state);
      }
    } catch (err) {
      showError(
        `无法开始/停止：${String((err && err.message) || err)}。Chrome 要求用户手势，请点击工具栏的 livedub 图标，在弹窗里操作。`,
        'error',
      );
    }
  }

  async function retryConnection() {
    try {
      const response = await chrome.runtime.sendMessage({ type: M.RECONNECT });
      if (response && response.ok) showError('正在重新连接引擎…', 'info');
      else showError((response && response.error && response.error.message) || '重试连接失败，请停止后重新开始。', 'error');
    } catch (err) {
      showError(`重试连接失败：${String((err && err.message) || err)}`, 'error');
    }
  }

  function downloadTextFile(text, filename) {
    // 带 BOM，Windows 播放器对 UTF-8 SRT 的识别更稳
    const blob = new Blob([`\ufeff${text}`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename || 'livedub.srt';
    anchor.style.display = 'none';
    (document.body || document.documentElement).appendChild(anchor);
    try {
      anchor.click();
    } finally {
      setTimeout(() => {
        try {
          anchor.remove();
        } catch {
          /* ignore */
        }
        URL.revokeObjectURL(url);
      }, 1500);
    }
  }

  async function exportSrt() {
    try {
      const response = await chrome.runtime.sendMessage({ type: M.GET_SRT });
      if (!response || response.ok !== true) {
        showError((response && response.error && response.error.message) || '导出失败：暂时没有字幕数据', 'error');
        return;
      }
      downloadTextFile(response.srt, response.filename);
      showError(`已导出 ${response.count} 条字幕：${response.filename}`, 'info');
    } catch (err) {
      showError(`导出失败：${String((err && err.message) || err)}`, 'error');
    }
  }

  // -------------------------------------------------------------------------
  // background <-> content 消息
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;
    switch (message.type) {
      case M.PING:
        sendResponse({ ok: true, content: true, href: location.href });
        return false;
      case M.STATE:
        handleBgState(message.state, message.settings);
        sendResponse({ ok: true });
        return false;
      case M.CONTENT_SETTINGS:
        applySettings(message.settings);
        sendResponse({ ok: true });
        return false;
      case M.ENGINE_EVENT:
        handleEngineEvent(message.event);
        sendResponse({ ok: true });
        return false;
      case M.NOTE_CONTEXT:
        sendResponse(buildNoteContext());
        return false;
      case M.NOTE_RESULT: {
        const result = message.result || {};
        if (result.pending) {
          // v0.5/v0.7：正在等 OCR/VLM（VLM 可能 20-30s）——按钮进入 loading，toast 带 spinner
          runtime.notePending = true;
          renderNoteButton();
          if (result.toast) showToast(result.toast, 'warn', 4000, { loading: true });
        } else {
          runtime.notePending = false;
          renderNoteButton();
          if (result.toast) {
            const suffix = result.vision && (result.vision.ocr || result.vision.caption) ? '（含画面文字）' : '';
            showToast(`${result.toast}${suffix}`, result.queued ? 'warn' : 'ok');
          } else if (result.ok) {
            showToast('已记笔记', 'ok');
          }
        }
        sendResponse({ ok: true });
        return false;
      }
      default:
        return false;
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[STORAGE_SETTINGS_KEY]) return;
    applySettings(changes[STORAGE_SETTINGS_KEY].newValue);
  });

  // -------------------------------------------------------------------------
  // 启动 / SPA / 全屏保持
  // -------------------------------------------------------------------------

  let mutationTimer = null;
  let tickCount = 0;

  function startObservers() {
    try {
      const observer = new MutationObserver(() => {
        if (mutationTimer) return;
        mutationTimer = setTimeout(() => {
          mutationTimer = null;
          ensureMounted();
          if (runtime.duck.ducking) duckActivity();
        }, 400);
      });
      observer.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch {
      /* ignore */
    }
    setInterval(() => {
      tickCount += 1;
      ensureMounted();
      duckTick();
      if (tickCount % 2 === 0) renderNoteButton();
      if (tickCount % 4 === 0) pruneItems();
      // 运行中每 2s 收集一次新媒体元素（SPA 换播放器 / 新视频）
      if (runtime.duck.ducking && tickCount % 2 === 0) duckActivity();
    }, TICK_MS);
  }

  function announceReady() {
    try {
      chrome.runtime
        .sendMessage({ type: M.CONTENT_READY, href: location.href, title: document.title })
        .then(
          (response) => {
            if (response && response.state) handleBgState(response.state, response.settings);
          },
          () => {},
        );
    } catch {
      /* ignore */
    }
  }

  async function main() {
    ensureMounted();
    postPageHookConfig();
    await loadSettings();
    startObservers();
    announceReady();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void main(), { once: true });
  } else {
    void main();
  }
})();
