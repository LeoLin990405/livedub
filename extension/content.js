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
    captureReplay: true,
    globalDuck: true,
    duckRecoverMs: 800,
    fullscreenWorkaround: true,
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
    merged.panelCollapsed = merged.panelCollapsed === true;
    merged.dubEnabled = merged.dubEnabled !== false;
    merged.showOriginal = merged.showOriginal !== false;
    merged.hidden = merged.hidden === true;
    merged.captureReplay = merged.captureReplay !== false;
    merged.globalDuck = merged.globalDuck !== false;
    merged.fullscreenWorkaround = merged.fullscreenWorkaround !== false;
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
    postPageHookConfig();
    renderSubtitles();
    renderMeta();
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
      const active = button.getAttribute('data-act') === `dock-${runtime.settings.dock}`;
      button.classList.toggle('active', active);
    }
    if (runtime.els.panelBody) runtime.els.panelBody.hidden = runtime.settings.panelCollapsed;
    if (runtime.els.collapseButton) {
      runtime.els.collapseButton.textContent = runtime.settings.panelCollapsed ? '▸' : '▾';
      runtime.els.collapseButton.title = runtime.settings.panelCollapsed ? '展开设置' : '收起设置';
    }
  }

  // -------------------------------------------------------------------------
  // 浮层构建（Shadow DOM）
  // -------------------------------------------------------------------------

  const OVERLAY_CSS = `
    :host { all: initial; }
    .livedub-root {
      position: fixed; inset: 0; pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      color: #fff;
    }
    .livedub-capsule {
      position: fixed; top: 14px; right: 14px;
      display: flex; align-items: center; gap: 8px;
      padding: 7px 12px; border-radius: 999px;
      background: rgba(14, 16, 24, 0.78);
      border: 1px solid rgba(255, 255, 255, 0.14);
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(8px);
      font-size: 13px; line-height: 1; cursor: pointer;
      pointer-events: auto; user-select: none;
      color: #f2f3f7;
    }
    .livedub-capsule .dot { width: 8px; height: 8px; border-radius: 50%; background: #8b8fa3; }
    .livedub-capsule[data-tone="live"] .dot { background: #3ddc84; box-shadow: 0 0 6px #3ddc84; }
    .livedub-capsule[data-tone="busy"] .dot { background: #f5b93f; }
    .livedub-capsule[data-tone="translate"] .dot { background: #5aa9ff; }
    .livedub-capsule[data-tone="speak"] .dot { background: #b48cff; box-shadow: 0 0 6px #b48cff; }
    .livedub-capsule[data-tone="error"] .dot { background: #ff5c6c; }
    .livedub-capsule .lat { color: #b8bdd0; font-variant-numeric: tabular-nums; }
    .livedub-capsule .gear { color: #b8bdd0; font-size: 12px; }
    .livedub-panel {
      position: fixed; top: 52px; right: 14px; width: 292px;
      max-height: calc(100vh - 78px); overflow-y: auto; overflow-x: hidden;
      padding: 11px 13px; border-radius: 14px;
      background: rgba(14, 16, 24, 0.94);
      border: 1px solid rgba(255, 255, 255, 0.14);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(10px);
      pointer-events: auto; font-size: 13px; color: #e9ebf3;
      scrollbar-width: thin;
    }
    .livedub-panel[hidden] { display: none; }
    .livedub-panel-head {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding-bottom: 7px; margin-bottom: 6px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.10);
      cursor: grab; user-select: none;
    }
    .livedub-panel-head:active { cursor: grabbing; }
    .livedub-panel-title { font-size: 12.5px; font-weight: 600; letter-spacing: 0.2px; }
    .livedub-panel-title .brand { color: #7c9cff; }
    .livedub-panel-head button {
      flex: none; width: 24px; height: 21px; padding: 0;
      background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 6px; color: #b8bdd0; font-size: 12px; line-height: 1; cursor: pointer;
    }
    .livedub-panel-body[hidden] { display: none; }
    .livedub-panel .row { display: flex; align-items: center; gap: 8px; margin: 7px 0; }
    .livedub-panel .row label { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
    .livedub-panel .row .row-label { color: #b8bdd0; flex: none; }
    .livedub-panel .row input[type="range"] { flex: 1; min-width: 0; accent-color: #7c9cff; }
    .livedub-panel .row select {
      flex: 1; min-width: 0; padding: 4px 6px; border-radius: 7px;
      background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.16);
      color: #e9ebf3; font-size: 12px; font-family: inherit;
    }
    .livedub-panel .row select option { background: #1a1d28; color: #e9ebf3; }
    .livedub-panel .row .val { min-width: 40px; text-align: right; color: #b8bdd0; font-variant-numeric: tabular-nums; font-size: 11.5px; }
    .livedub-panel .seg { display: inline-flex; gap: 4px; flex: 1; justify-content: flex-end; }
    .livedub-panel .seg button { flex: none; padding: 4px 10px; font-size: 12px; }
    .livedub-panel .seg button.active { background: #3f5bd9; border-color: #5a74e8; color: #fff; }
    .livedub-panel .actions { gap: 6px; margin-top: 10px; flex-wrap: wrap; }
    .livedub-panel button {
      padding: 6px 9px; border-radius: 9px; border: 1px solid rgba(255, 255, 255, 0.18);
      background: rgba(255, 255, 255, 0.10); color: #f2f3f7; font-size: 12px; cursor: pointer;
      font-family: inherit; transition: background 0.15s ease, opacity 0.15s ease;
    }
    .livedub-panel button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.18); }
    .livedub-panel button:disabled { opacity: 0.45; cursor: default; }
    .livedub-panel .actions button { flex: 1; min-width: 78px; }
    .livedub-panel button[data-act="toggle"] { background: #3f5bd9; border-color: #5a74e8; }
    .livedub-panel button[data-act="toggle"]:hover:not(:disabled) { background: #4a67ec; }
    .livedub-panel .hint { color: #8f94a8; font-size: 11px; line-height: 1.5; margin: 6px 0 0; }
    .livedub-guide {
      margin: 8px 0; padding: 9px 10px; border-radius: 10px;
      background: rgba(90, 169, 255, 0.13); border: 1px solid rgba(90, 169, 255, 0.32);
      font-size: 11.5px; line-height: 1.55; color: #d6e6ff;
    }
    .livedub-guide[hidden] { display: none; }
    .livedub-guide .guide-title { font-weight: 600; margin-bottom: 3px; }
    .livedub-guide .guide-body { white-space: pre-line; color: #b9cbe4; }
    .livedub-guide .guide-actions { display: flex; gap: 6px; margin-top: 7px; }
    .livedub-guide .guide-actions button { flex: 1; font-size: 11.5px; padding: 5px 8px; }
    .livedub-meta {
      margin: 7px 0 0; padding-top: 7px;
      border-top: 1px dashed rgba(255, 255, 255, 0.12);
      font-size: 11px; color: #9aa0b4; line-height: 1.6; white-space: pre-line;
    }
    .livedub-meta[hidden] { display: none; }
    .livedub-error {
      margin-top: 8px; padding: 7px 9px; border-radius: 9px;
      background: rgba(255, 92, 108, 0.18); border: 1px solid rgba(255, 92, 108, 0.4);
      color: #ffd3d7; font-size: 12px; line-height: 1.45;
    }
    .livedub-error[hidden] { display: none; }
    .livedub-error[data-kind="info"] {
      background: rgba(90, 169, 255, 0.16); border-color: rgba(90, 169, 255, 0.38); color: #cfe4ff;
    }
    .livedub-subs {
      position: fixed; left: 50%; bottom: 8vh;
      transform: translateX(-50%);
      max-width: min(78vw, 980px);
      display: flex; flex-direction: column; gap: 6px;
      pointer-events: auto; cursor: grab; user-select: none;
      --livedub-subs-alpha: 0.72;
    }
    .livedub-subs[hidden] { display: none; }
    .livedub-subs:active { cursor: grabbing; }
    .livedub-block {
      padding: 9px 16px; border-radius: 13px;
      background: rgba(10, 12, 20, var(--livedub-subs-alpha, 0.72));
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.38);
      backdrop-filter: blur(6px);
      text-align: center;
    }
    .livedub-root[data-bg="light"] .livedub-block {
      background: rgba(248, 249, 252, var(--livedub-subs-alpha, 0.86));
      border-color: rgba(0, 0, 0, 0.08);
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.22);
    }
    .livedub-root[data-bg="light"] .livedub-block .dst { color: #10131c; text-shadow: none; }
    .livedub-root[data-bg="light"] .livedub-block .src { color: #4a4f60; }
    .livedub-root[data-bg="none"] .livedub-block {
      background: transparent; border-color: transparent;
      box-shadow: none; backdrop-filter: none;
      padding: 2px 6px;
    }
    .livedub-block .src {
      color: #b4b9c9; line-height: 1.35; margin-bottom: 3px;
      font-size: 0.68em; white-space: pre-line;
    }
    .livedub-block .dst {
      color: #ffffff; font-weight: 600; line-height: 1.38;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6); white-space: pre-line;
    }
    .livedub-block .dst.draft { color: #e3e6f0; opacity: 0.82; font-weight: 500; }
    .livedub-root[data-bg="light"] .livedub-block .dst.draft { color: #3a3f52; }
    .livedub-block .src[hidden] { display: none; }
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
      <div class="livedub-root" data-part="root" data-bg="dark">
        <div class="livedub-capsule" data-part="capsule" role="button" tabindex="0" title="livedub：点击打开设置">
          <span class="dot"></span>
          <span class="state" data-part="state">未连接</span>
          <span class="lat" data-part="lat">—</span>
          <span class="gear">⚙</span>
        </div>
        <div class="livedub-panel" data-part="panel" hidden>
          <div class="livedub-panel-head" data-part="panel-head" title="拖动移动设置面板">
            <span class="livedub-panel-title"><span class="brand">livedub</span> 设置</span>
            <button type="button" data-act="collapse" data-part="collapse" title="收起设置">▾</button>
          </div>
          <div class="livedub-panel-body" data-part="panel-body">
            <div class="row"><label><input type="checkbox" data-set="dubEnabled" /> 中文配音</label></div>
            <div class="row"><label><input type="checkbox" data-set="captureReplay" /> 原声重放（关闭 = 只听配音）</label></div>
            <div class="row"><label><input type="checkbox" data-set="globalDuck" /> 全局限定压音（iframe/WebAudio 也生效）</label></div>
            <div class="row"><label>压音 <input type="range" data-set="duckRatio" min="0.02" max="0.6" step="0.01" /></label><span class="val" data-val="duckRatio"></span></div>
            <div class="row"><label>恢复延迟 <input type="range" data-set="duckRecoverMs" min="300" max="3000" step="100" /></label><span class="val" data-val="duckRecoverMs"></span></div>
            <div class="row"><label><input type="checkbox" data-set="showOriginal" /> 显示原文</label></div>
            <div class="row"><label>字号 <input type="range" data-set="fontSize" min="14" max="32" step="1" /></label><span class="val" data-val="fontSize"></span></div>
            <div class="row"><span class="row-label">位置</span><span class="seg"><button type="button" data-act="dock-bottom">底部</button><button type="button" data-act="dock-top">顶部</button></span></div>
            <div class="row"><label>避让 <input type="range" data-set="offsetY" min="-200" max="320" step="10" /></label><span class="val" data-val="offsetY"></span></div>
            <div class="row"><label>背景 <select data-set="subsBg"><option value="dark">深色</option><option value="light">浅色</option><option value="none">无背景</option></select></label></div>
            <div class="row"><label>不透明度 <input type="range" data-set="subsOpacity" min="0.2" max="1" step="0.02" /></label><span class="val" data-val="subsOpacity"></span></div>
            <div class="row"><label><input type="checkbox" data-set="fullscreenWorkaround" /> video 全屏兼容（包裹容器）</label></div>
            <div class="livedub-guide" data-part="guide" hidden>
              <div class="guide-title" data-part="guide-title"></div>
              <div class="guide-body" data-part="guide-body"></div>
              <div class="guide-actions">
                <button type="button" data-act="reconnect">重试连接</button>
                <button type="button" data-act="start">开始同传</button>
              </div>
            </div>
            <div class="livedub-meta" data-part="meta" hidden></div>
            <div class="row actions">
              <button type="button" data-act="toggle">开始同传</button>
              <button type="button" data-act="export">导出 SRT</button>
              <button type="button" data-act="hide">隐藏浮层</button>
            </div>
            <div class="hint">开始/停止需要用户手势；点工具栏 livedub 图标在弹窗操作更稳。字幕可拖动，位置/样式自动保存。</div>
            <div class="livedub-error" data-part="error" hidden></div>
          </div>
        </div>
        <div class="livedub-subs" data-part="subs" hidden><div class="livedub-sub-list" data-part="sublist"></div></div>
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
      guide: shadow.querySelector('[data-part="guide"]'),
      guideTitle: shadow.querySelector('[data-part="guide-title"]'),
      guideBody: shadow.querySelector('[data-part="guide-body"]'),
      meta: shadow.querySelector('[data-part="meta"]'),
      error: shadow.querySelector('[data-part="error"]'),
      subs: shadow.querySelector('[data-part="subs"]'),
      sublist: shadow.querySelector('[data-part="sublist"]'),
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
    }
    if (runtime.els.panelHead) {
      runtime.els.panelHead.addEventListener('pointerdown', onPanelPointerDown);
    }
    if (subs) {
      subs.addEventListener('pointerdown', onSubtitlePointerDown);
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
    window.addEventListener('resize', () => {
      applySubsLayout();
      applyPanelPosition();
    });
    window.addEventListener('beforeunload', () => {
      restoreVolumes();
    });
    document.addEventListener('fullscreenchange', onFullscreenChange, true);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange, true);
    // v0.3：MAIN world page-hook 的包裹/回退通知
    window.addEventListener('message', onPageHookMessage);
  }

  function togglePanel(force) {
    const next = typeof force === 'boolean' ? force : !runtime.panelOpen;
    runtime.panelOpen = next;
    if (runtime.els.panel) runtime.els.panel.hidden = !next;
    if (next && runtime.settings.panelCollapsed) void saveSettings({ panelCollapsed: false });
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
      default:
        break;
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
    capsule.title = `livedub：${summary.label}${state && state.engineState ? `（引擎 ${state.engineState}）` : ''}，点击打开设置`;
    renderGuidance();
    renderMeta();
    renderExportState();
  }

  function renderExportState() {
    const count = (runtime.bgState && runtime.bgState.captionCount) || 0;
    const button = runtime.els.panel ? runtime.els.panel.querySelector('button[data-act="export"]') : null;
    if (button) {
      button.disabled = count === 0;
      button.title =
        count === 0 ? '先开始同传并让视频说几句话，才有字幕可导出' : `导出本次 ${count} 条字幕（SRT）`;
    }
  }

  function renderGuidance() {
    const guide = runtime.els.guide;
    if (!guide) return;
    const state = runtime.bgState;
    const active = isActive();
    let info = null;
    if (!state || (!active && !state.error)) {
      info = {
        title: '未连接本地引擎',
        body:
          '① 在 livedub 目录执行 npm start（或 node engine/server.mjs）\n② 确认 http://127.0.0.1:8787/health 可访问\n③ 点击工具栏 livedub 图标 → 开始同传',
        showRetry: false,
        showStart: true,
      };
    } else if (active && state.connection === 'closed') {
      info = {
        title: '引擎连接断开，正在自动重连…',
        body: '请确认引擎进程仍在运行（npm start）。也可以点「重试连接」立即重连，无需重新开始抓音。',
        showRetry: true,
        showStart: false,
      };
    } else if (state.phase === 'error') {
      info = {
        title: '抓音失败',
        body: `${(state.error && state.error.message) || '请检查页面与引擎状态后重试。'}\n可先确认引擎已启动（npm start），再点「开始同传」。`,
        showRetry: false,
        showStart: true,
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
    meta.hidden = lines.length === 0;
    meta.textContent = lines.join('\n');
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
        upsertItem(`u:${event.id ?? 'partial'}`, { src: event.text, draft: true });
        break;
      case 'segment': {
        const key = `u:${event.id ?? 'segment'}`;
        if (!runtime.items.has(key)) {
          const last = [...runtime.items.values()].pop();
          if (last && last.draft) runtime.items.delete(last.key);
        }
        upsertItem(key, { src: event.text, draft: false });
        break;
      }
      case 'translation':
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
