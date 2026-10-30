/**
 * livedub 扩展 UI 纯函数库（v0.7，浏览器 + Node 双端可用，零依赖）。
 *
 * 为「字幕浮层 / 快捷面板 / popup」提供可单测的展示决策：
 * - 面板 tab 切换（字幕 / 笔记 / 设置）；
 * - 状态 pill 文案与色调、原声 duck 指示、引导卡模型；
 * - 字幕宽度档位、进度线时长估算、动效降级（prefers-reduced-motion）；
 * - 笔记按钮 loading/已记录/排队状态、toast 堆叠、快捷操作/快捷键标签。
 *
 * content script 是 classic script，不能 import ESM，因此 content.js 内联了等价实现，
 * tests/extension.test.mjs 会同时校验本文件（纯函数单测）与 content.js 的接线。
 */

/** 快捷面板 tab 定义（顺序即展示顺序） */
export const PANEL_TABS = Object.freeze([
  { id: 'subtitles', label: '字幕', hint: '字幕样式、位置与原文显示' },
  { id: 'notes', label: '笔记', hint: '快捷笔记、画面文字与导出' },
  { id: 'settings', label: '设置', hint: '配音、原声、视觉与高级选项' },
]);

export const TAB_IDS = Object.freeze(PANEL_TABS.map((tab) => tab.id));

/** 字幕宽度档位 */
export const SUBS_DENSITIES = Object.freeze(['wide', 'compact']);
/** 紧凑模式触发宽度（px） */
export const COMPACT_BREAKPOINT_PX = 760;

/** Esc 键关闭面板/顶部 toast 的语义（便于测试与文档） */
export const ESC_ACTION = Object.freeze({ PANEL: 'close-panel', TOAST: 'dismiss-top-toast' });

// ---------------------------------------------------------------------------
// tab / 密度 / 主题 / 动效
// ---------------------------------------------------------------------------

/** 面板 tab 规范化 */
export function normalizePanelTab(value) {
  return TAB_IDS.includes(value) ? value : 'subtitles';
}

/** 循环切换 tab（键盘左右方向键用） */
export function cyclePanelTab(current, direction = 1) {
  const index = TAB_IDS.indexOf(normalizePanelTab(current));
  const step = direction < 0 ? -1 : 1;
  const next = (index + step + TAB_IDS.length) % TAB_IDS.length;
  return TAB_IDS[next];
}

/**
 * 字幕宽度档位：setting 可强制 wide/compact；auto 按视口宽度（<760 紧凑）。
 * @param {{viewportWidth?:number, setting?:string}} [opts]
 * @returns {'wide'|'compact'}
 */
export function resolveSubsDensity({ viewportWidth = 1920, setting = 'auto' } = {}) {
  if (setting === 'compact') return 'compact';
  if (setting === 'wide') return 'wide';
  const width = Number(viewportWidth);
  return Number.isFinite(width) && width > 0 && width < COMPACT_BREAKPOINT_PX ? 'compact' : 'wide';
}

/** 密度中文标签 */
export function formatDensityLabel(density) {
  return density === 'compact' ? '紧凑' : '宽';
}

/** 亮暗主题（preview/静态页用；扩展内由 CSS media query 自动适配） */
export function resolveTheme({ prefersLight = false } = {}) {
  return prefersLight === true ? 'light' : 'dark';
}

/**
 * 动效配置：prefers-reduced-motion 时关闭过渡/进度动画。
 * @param {{reducedMotion?:boolean}} [opts]
 */
export function motionProfile({ reducedMotion = false } = {}) {
  return reducedMotion === true
    ? { durationMs: 0, transitions: false, progressAnimation: false }
    : { durationMs: 170, transitions: true, progressAnimation: true };
}

// ---------------------------------------------------------------------------
// 状态 pill / 引导卡 / 快捷键
// ---------------------------------------------------------------------------

/**
 * 状态 pill 文案 + 色调。
 * @param {{phase?:string, connection?:string, engineState?:string, error?:object|null}} state
 * @returns {{text:string, tone:'idle'|'busy'|'live'|'translate'|'speak'|'error', ariaLabel:string}}
 */
export function formatStatusPill({ phase = 'idle', connection = 'closed', engineState = 'idle', error = null } = {}) {
  const aria = (text) => `livedub 状态：${text}`;
  if (phase === 'starting') return { text: '连接中', tone: 'busy', ariaLabel: aria('连接中') };
  if (phase === 'stopping') return { text: '停止中', tone: 'busy', ariaLabel: aria('停止中') };
  if (phase === 'error') return { text: '抓音失败', tone: 'error', ariaLabel: aria('抓音失败') };
  if (phase === 'running') {
    if (connection === 'connecting') return { text: '重连中', tone: 'busy', ariaLabel: aria('引擎重连中') };
    if (connection === 'closed') return { text: '已断开', tone: 'busy', ariaLabel: aria('引擎已断开') };
    if (engineState === 'speaking') return { text: '播放中', tone: 'speak', ariaLabel: aria('中文配音播放中') };
    if (engineState === 'translating') return { text: '翻译中', tone: 'translate', ariaLabel: aria('翻译中') };
    if (engineState === 'listening') return { text: '识别中', tone: 'live', ariaLabel: aria('正在收听识别') };
    if (engineState === 'paused') return { text: '已暂停', tone: 'idle', ariaLabel: aria('已暂停') };
    if (engineState === 'error' || (error && error.scope !== 'capture')) {
      return { text: '引擎异常', tone: 'error', ariaLabel: aria('引擎异常') };
    }
    return { text: '已连接', tone: 'live', ariaLabel: aria('已连接') };
  }
  return { text: '未连接', tone: 'idle', ariaLabel: aria('未连接') };
}

/** 原声 duck 指示（说话时显示「原声已压低」） */
export function formatDuckIndicator({ engineState = 'idle', captureReplay = true, globalDuck = true } = {}) {
  if (engineState !== 'speaking' || captureReplay === false) return { visible: false, label: '' };
  return { visible: true, label: globalDuck === false ? '页面音量压音中' : '原声已压低' };
}

/**
 * 引导卡模型（空态/离线/错误统一）：
 * 引擎未连接 -> 显示 npm start 步骤 + 可复制命令；运行中断连 -> 立即重连；抓音失败 -> 错误文案 + 重试。
 * @param {{phase?:string, connection?:string, error?:object|null}} state
 */
export function buildGuideModel({ phase = 'idle', connection = 'closed', error = null } = {}) {
  if (phase === 'running' && connection === 'closed') {
    return {
      visible: true,
      title: '引擎连接断开，正在自动重连…',
      body: '确认引擎进程仍在运行（npm start），或点「立即重连」跳过退避重试。',
      showRetry: true,
      showStart: false,
      copyCommand: '',
    };
  }
  if (phase === 'error' || (error && error.scope === 'capture')) {
    return {
      visible: true,
      title: '抓音失败',
      body: `${(error && error.message) || '请检查页面与引擎状态后重试。'}\n确认引擎已启动后再点「开始同传」。`,
      showRetry: false,
      showStart: true,
      copyCommand: 'npm start',
    };
  }
  if (phase === 'running' || phase === 'starting') {
    return { visible: false, title: '', body: '', showRetry: false, showStart: false, copyCommand: '' };
  }
  return {
    visible: true,
    title: '未连接本地引擎',
    body: '① 在 livedub 目录执行 npm start\n② 确认 http://127.0.0.1:8787/health 可访问\n③ 打开视频后点「开始同传」',
    showRetry: false,
    showStart: true,
    copyCommand: 'npm start',
  };
}

/** 快捷键展示（面板 footer / popup footer 共用） */
export const SHORTCUTS = Object.freeze([
  { id: 'toggle', keys: 'Alt+Shift+L', label: '开始/停止同传' },
  { id: 'note', keys: 'Alt+Shift+N', label: '记录当前句为笔记' },
]);

// ---------------------------------------------------------------------------
// 字幕进度线 / 时长
// ---------------------------------------------------------------------------

/**
 * 估算一句字幕的展示时长（进度线动画用）：
 * 有 t0Ms/t1Ms 用真实跨度（钳制 1.2-8s），否则按文本长度估算（900ms + 55ms/字，钳制 1.2-6s）。
 * @param {{text?:string, t0Ms?:number|null, t1Ms?:number|null}} [opts]
 */
export function estimateCaptionDurationMs({ text = '', t0Ms = null, t1Ms = null } = {}) {
  const span =
    Number.isFinite(t0Ms) && Number.isFinite(t1Ms) && t1Ms > t0Ms ? Math.round(t1Ms - t0Ms) : 0;
  if (span > 0) return Math.min(8000, Math.max(1200, span));
  const chars = String(text == null ? '' : text).replace(/\s+/g, '').length;
  return Math.min(6000, Math.max(1200, Math.round(900 + chars * 55)));
}

/**
 * 进度线比例（0~1）：startedAt 时开始计时，duration 后到 1。
 * @param {{startedAtMs?:number, nowMs?:number, durationMs?:number}} opts
 */
export function computeCaptionProgress({ startedAtMs = 0, nowMs = 0, durationMs = 2000 } = {}) {
  const duration = Number(durationMs);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const elapsed = Number(nowMs) - Number(startedAtMs);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  return Math.min(1, Math.max(0, elapsed / duration));
}

// ---------------------------------------------------------------------------
// 笔记按钮状态 / toast 堆叠
// ---------------------------------------------------------------------------

/**
 * 笔记按钮状态：识别中（loading）/ 已记录 @ mm:ss / 已排队 @ mm:ss / 空闲。
 * @param {{pending?:boolean, lastNote?:object|null, nowMs?:number, doneWindowMs?:number}} [opts]
 */
export function formatNoteButtonState({ pending = false, lastNote = null, nowMs = 0, doneWindowMs = 12000 } = {}) {
  if (pending) {
    return { state: 'loading', label: '识别画面文字中…', ariaBusy: true, disabled: true };
  }
  const stamp = (ms) => {
    const value = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
    const total = Math.floor(value / 1000);
    const mm = String(Math.floor(total / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  };
  if (lastNote && Number.isFinite(lastNote.at) && (!nowMs || nowMs - lastNote.at <= doneWindowMs)) {
    const time = stamp(lastNote.tMs);
    if (lastNote.queued) return { state: 'queued', label: `已排队 @ ${time}`, ariaBusy: false, disabled: false };
    return { state: 'done', label: `已记录 @ ${time}`, ariaBusy: false, disabled: false };
  }
  return { state: 'idle', label: '记笔记', ariaBusy: false, disabled: false };
}

/**
 * toast 堆叠：最多 max 条，保留最新；返回去重后的列表（旧的在前）+ 被丢弃数量。
 * @param {{existing?:Array<object>, next?:object|null, max?:number}} [opts]
 */
export function planToastStack({ existing = [], next = null, max = 3 } = {}) {
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 3;
  const items = Array.isArray(existing) ? existing.slice(-limit) : [];
  const dropped = Math.max(0, (Array.isArray(existing) ? existing.length : 0) - items.length);
  if (!next || typeof next !== 'object') return { items, dropped };
  items.push(next);
  let overflow = 0;
  while (items.length > limit) {
    items.shift();
    overflow += 1;
  }
  return { items, dropped: dropped + overflow };
}

// ---------------------------------------------------------------------------
// 快捷操作（popup grid）
// ---------------------------------------------------------------------------

export const QUICK_ACTIONS = Object.freeze([
  { id: 'capture-note', label: '记当前句', hint: '把当前字幕+截图记进笔记（Alt+Shift+N）' },
  { id: 'open-notebook', label: '笔记库', hint: '在工作台打开笔记面板' },
  { id: 'export-notes', label: '导出', hint: '导出当前视频的笔记 Markdown' },
  { id: 'show-overlay', label: '浮层', hint: '重新显示字幕浮层' },
]);

/** 笔记卡摘要文案 */
export function formatNoteSummary({ todayCount = 0, queueCount = 0 } = {}) {
  return `今日 ${todayCount} 条 · 待同步 ${queueCount}`;
}
