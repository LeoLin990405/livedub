/**
 * livedub Chrome MV3 扩展 —— content script（每个页面一个实例，classic script）。
 *
 * 只做「显示 + 压音」，不直接连引擎：
 * - Shadow DOM 浮层（不污染页面样式）：底部双语字幕（原文灰色小字 + 译文白色大字，可拖拽）、
 *   右上角状态胶囊 + 延迟、点击胶囊展开设置面板；
 * - 压音：记录页面所有 video/audio 原 volume，引擎 state=speaking / 收到 dub 时把音量
 *   压到 duckRatio（默认 0.18），空闲 800ms 后恢复；停止/异常时全部恢复；
 * - SPA 导航 / 页面重建 body / 新视频出现时保持浮层（MutationObserver + 轻量 interval）；
 * - 从 background 的 runtime 消息增量更新（chrome.runtime.onMessage）。
 *
 * 为什么是 classic script：MV3 content_scripts 不能直接 import ESM。因此这里内联了
 * 与 extension/lib/constants.js、lib/pcm.js 等价的少量常量/逻辑（有注释标注），
 * tests/extension.test.mjs 会做一致性校验。
 */

(() => {
  'use strict';

  // 防重复注入（manifest 静态注入 + background 兜底 executeScript 可能都跑到）
  if (globalThis.__livedubContentLoaded) return;
  globalThis.__livedubContentLoaded = true;

  // -------------------------------------------------------------------------
  // 常量 / 默认设置（与 extension/lib/constants.js 保持一致）
  // -------------------------------------------------------------------------

  const M = {
    STATE: 'livedub:state',
    ENGINE_EVENT: 'livedub:event',
    CONTENT_SETTINGS: 'livedub:settings',
    PING: 'livedub:ping',
    CONTENT_READY: 'livedub:content-ready',
    CONTENT_TOGGLE: 'livedub:toggle-capture',
  };
  const STORAGE_SETTINGS_KEY = 'livedub:settings';
  const DEFAULT_SETTINGS = {
    engineUrl: 'ws://127.0.0.1:8787/ws',
    voiceMode: 'clone-first',
    dubEnabled: true,
    duckRatio: 0.18,
    showOriginal: true,
    fontSize: 22,
    langFrom: 'en',
    langTo: 'zh',
    hidden: false,
    subsPos: null,
  };
  /** 配音结束/说话结束后多久恢复原音量 */
  const IDLE_RESTORE_MS = 800;
  /** 字幕保留块数 */
  const MAX_BLOCKS = 3;
  /** 字幕块最长保留时间 */
  const BLOCK_TTL_MS = 25000;
  /** 浮层轮询间隔（压音 tick / 字幕过期 / SPA 检查） */
  const TICK_MS = 500;

  const runtime = {
    settings: { ...DEFAULT_SETTINGS },
    bgState: null,
    sessionKey: null,
    metrics: null,
    notice: '',
    error: null,
    errorTimer: null,
    items: new Map(), // key -> {key, src, dst, draft, ts}
    host: null,
    shadow: null,
    els: {},
    drag: null,
    trackedMedia: new Map(), // HTMLMediaElement -> originalVolume
    duck: { ducking: false, idleSince: null, lastActivity: 0 },
    panelOpen: false,
    mounted: false,
  };

  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  // -------------------------------------------------------------------------
  // 设置（chrome.storage.local，popup 与浮层共享）
  // -------------------------------------------------------------------------

  function normalizeSettings(raw) {
    const merged = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
    merged.fontSize = Math.min(32, Math.max(14, Number(merged.fontSize) || DEFAULT_SETTINGS.fontSize));
    merged.duckRatio = Math.min(1, Math.max(0.02, Number(merged.duckRatio) || DEFAULT_SETTINGS.duckRatio));
    merged.dubEnabled = merged.dubEnabled !== false;
    merged.showOriginal = merged.showOriginal !== false;
    merged.hidden = merged.hidden === true;
    if (merged.subsPos && typeof merged.subsPos === 'object') {
      merged.subsPos = { dx: Number(merged.subsPos.dx) || 0, dy: Number(merged.subsPos.dy) || 0 };
    } else {
      merged.subsPos = null;
    }
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
    applySettings(runtime.settings, { skipPanelSync: false });
    try {
      await chrome.storage.local.set({ [STORAGE_SETTINGS_KEY]: runtime.settings });
    } catch {
      /* 隐私模式等场景下 storage 写失败不影响展示 */
    }
  }

  function applySettings(settings, { skipPanelSync = false } = {}) {
    runtime.settings = normalizeSettings(settings);
    if (!skipPanelSync) syncPanelControls();
    applyOverlayVisibility();
    applySubtitleStyle();
    renderSubtitles();
  }

  function syncPanelControls() {
    const panel = runtime.els.panel;
    if (!panel) return;
    for (const input of panel.querySelectorAll('input[data-set]')) {
      const key = input.getAttribute('data-set');
      if (input.type === 'checkbox') input.checked = !!runtime.settings[key];
      else input.value = runtime.settings[key];
      const valueEl = panel.querySelector(`[data-val="${key}"]`);
      if (valueEl) valueEl.textContent = String(runtime.settings[key]);
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
      position: fixed; top: 52px; right: 14px; width: 264px;
      padding: 12px 14px; border-radius: 14px;
      background: rgba(14, 16, 24, 0.92);
      border: 1px solid rgba(255, 255, 255, 0.14);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(10px);
      pointer-events: auto; font-size: 13px; color: #e9ebf3;
    }
    .livedub-panel[hidden] { display: none; }
    .livedub-panel .row { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
    .livedub-panel .row label { display: flex; align-items: center; gap: 6px; flex: 1; }
    .livedub-panel .row input[type="range"] { flex: 1; accent-color: #7c9cff; }
    .livedub-panel .row .val { min-width: 34px; text-align: right; color: #b8bdd0; font-variant-numeric: tabular-nums; }
    .livedub-panel .actions { gap: 8px; margin-top: 10px; }
    .livedub-panel button {
      flex: 1; padding: 7px 8px; border-radius: 9px; border: 1px solid rgba(255, 255, 255, 0.18);
      background: rgba(255, 255, 255, 0.10); color: #f2f3f7; font-size: 13px; cursor: pointer;
      font-family: inherit;
    }
    .livedub-panel button:hover { background: rgba(255, 255, 255, 0.18); }
    .livedub-panel button[data-act="toggle"] { background: #3f5bd9; border-color: #5a74e8; }
    .livedub-panel button[data-act="toggle"]:hover { background: #4a67ec; }
    .livedub-panel .hint { color: #8f94a8; font-size: 11px; line-height: 1.5; }
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
    }
    .livedub-subs[hidden] { display: none; }
    .livedub-subs:active { cursor: grabbing; }
    .livedub-block {
      padding: 9px 16px; border-radius: 13px;
      background: rgba(10, 12, 20, 0.72);
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.38);
      backdrop-filter: blur(6px);
      text-align: center;
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
    .livedub-block .src[hidden] { display: none; }
  `;

  function attachShadowStyles(shadow) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(OVERLAY_CSS);
      shadow.adoptedStyleSheets = [sheet];
      return;
    } catch {
      /* 老浏览器 / 受限环境回退到 <style> */
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
    // 注意：style 属性通过 CSSOM/字符串只影响宿主元素，不污染页面其它节点
    host.style.cssText =
      'all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; pointer-events: none !important; display: block !important;';
    const shadow = host.attachShadow({ mode: 'open' });
    attachShadowStyles(shadow);
    shadow.innerHTML = `
      <div class="livedub-root" data-part="root">
        <div class="livedub-capsule" data-part="capsule" role="button" tabindex="0" title="livedub：点击打开设置">
          <span class="dot"></span>
          <span class="state" data-part="state">未连接</span>
          <span class="lat" data-part="lat">—</span>
          <span class="gear">⚙</span>
        </div>
        <div class="livedub-panel" data-part="panel" hidden>
          <div class="row"><label><input type="checkbox" data-set="dubEnabled" /> 中文配音</label></div>
          <div class="row"><label>压音 <input type="range" data-set="duckRatio" min="0.02" max="0.6" step="0.01" /></label><span class="val" data-val="duckRatio"></span></div>
          <div class="row"><label><input type="checkbox" data-set="showOriginal" /> 显示原文</label></div>
          <div class="row"><label>字号 <input type="range" data-set="fontSize" min="14" max="32" step="1" /></label><span class="val" data-val="fontSize"></span></div>
          <div class="row actions"><button type="button" data-act="toggle">开始同传</button><button type="button" data-act="hide">隐藏浮层</button></div>
          <div class="row hint">开始/停止需要用户手势；如果失败，请点击工具栏上的 livedub 图标在弹窗里操作。</div>
          <div class="livedub-error" data-part="error" hidden></div>
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
      error: shadow.querySelector('[data-part="error"]'),
      subs: shadow.querySelector('[data-part="subs"]'),
      sublist: shadow.querySelector('[data-part="sublist"]'),
    };
    bindOverlayEvents();
    applyOverlayVisibility();
    applySubtitleStyle();
    syncPanelControls();
    return host;
  }

  function ensureMounted() {
    if (!document.documentElement) return false;
    if (!runtime.host) buildOverlay();
    if (!runtime.host.isConnected) {
      document.documentElement.appendChild(runtime.host);
    }
    if (!runtime.mounted) {
      runtime.mounted = true;
      renderStatus();
      renderSubtitles();
    }
    return true;
  }

  function applyOverlayVisibility() {
    if (!runtime.host) return;
    runtime.host.style.display = runtime.settings.hidden ? 'none' : 'block';
    if (runtime.els.capsule) runtime.els.capsule.style.display = runtime.settings.hidden ? 'none' : 'flex';
  }

  function applySubtitleStyle() {
    if (!runtime.els.sublist) return;
    runtime.els.sublist.style.fontSize = `${runtime.settings.fontSize}px`;
    const pos = runtime.settings.subsPos || { dx: 0, dy: 0 };
    runtime.els.subs.style.transform = `translateX(-50%) translate(${pos.dx}px, ${pos.dy}px)`;
  }

  // -------------------------------------------------------------------------
  // 浮层事件 / 拖拽
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
      panel.addEventListener('click', (event) => event.stopPropagation());
      panel.addEventListener('change', onPanelChange);
      panel.addEventListener('input', onPanelChange);
      panel.addEventListener('click', (event) => {
        const button = event.target && event.target.closest ? event.target.closest('button[data-act]') : null;
        if (!button) return;
        const action = button.getAttribute('data-act');
        if (action === 'toggle') void toggleCapture();
        if (action === 'hide') void saveSettings({ hidden: true });
      });
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
    window.addEventListener('beforeunload', () => {
      restoreVolumes();
    });
  }

  function togglePanel(force) {
    const next = typeof force === 'boolean' ? force : !runtime.panelOpen;
    runtime.panelOpen = next;
    if (runtime.els.panel) runtime.els.panel.hidden = !next;
  }

  function onPanelChange(event) {
    const target = event.target;
    if (!target || !target.getAttribute) return;
    const key = target.getAttribute('data-set');
    if (!key) return;
    let value;
    if (target.type === 'checkbox') value = target.checked;
    else value = Number(target.value);
    if (key === 'duckRatio') value = Math.min(1, Math.max(0.02, value));
    if (key === 'fontSize') value = Math.min(32, Math.max(14, Math.round(value)));
    const valueEl = runtime.els.panel && runtime.els.panel.querySelector(`[data-val="${key}"]`);
    if (valueEl) valueEl.textContent = String(value);
    void saveSettings({ [key]: value });
  }

  function onSubtitlePointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    const subs = runtime.els.subs;
    if (!subs) return;
    event.preventDefault();
    event.stopPropagation();
    const startPos = runtime.settings.subsPos || { dx: 0, dy: 0 };
    runtime.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseX: startPos.dx,
      baseY: startPos.dy,
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
    const dx = drag.baseX + (event.clientX - drag.startX);
    const dy = drag.baseY + (event.clientY - drag.startY);
    if (runtime.els.subs) runtime.els.subs.style.transform = `translateX(-50%) translate(${dx}px, ${dy}px)`;
    runtime.drag.next = { dx, dy };
  }

  function onSubtitlePointerUp(event) {
    const drag = runtime.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
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
    runtime.drag = null;
    const next = drag.next || { dx: drag.baseX, dy: drag.baseY };
    void saveSettings({ subsPos: clampSubsPosition(next) });
  }

  function clampSubsPosition(pos) {
    const maxDx = Math.max(0, window.innerWidth / 2 - 80);
    const maxDyDown = Math.max(0, window.innerHeight * 0.45);
    const maxDyUp = Math.max(0, window.innerHeight * 0.8);
    return {
      dx: Math.min(maxDx, Math.max(-maxDx, Number(pos.dx) || 0)),
      dy: Math.min(maxDyDown, Math.max(-maxDyUp, Number(pos.dy) || 0)),
    };
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
      // 引擎仍报 speaking 时放宽兜底窗口：避免两句配音之间（> 800ms）音量来回抖动；
      // 正常结束会先收到非 speaking 的 status，由 idleSince 分支在 800ms 后精确恢复。
      const speaking = runtime.bgState && runtime.bgState.engineState === 'speaking';
      if (!speaking || t - runtime.duck.lastActivity >= 3000) restoreVolumes();
    }
  }

  // -------------------------------------------------------------------------
  // 状态 / 字幕渲染
  // -------------------------------------------------------------------------

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

  function renderStatus() {
    if (!runtime.els.capsule) return;
    const summary = statusSummary();
    runtime.els.capsule.setAttribute('data-tone', summary.tone);
    if (runtime.els.state) runtime.els.state.textContent = summary.label;
    const state = runtime.bgState;
    const latency = runtime.metrics
      ? latencyFromMetrics(runtime.metrics)
      : state && typeof state.latencyMs === 'number'
        ? state.latencyMs
        : null;
    if (runtime.els.lat) runtime.els.lat.textContent = formatLatency(latency);
    const toggleButton = runtime.els.panel && runtime.els.panel.querySelector('button[data-act="toggle"]');
    if (toggleButton) {
      const active = state && (state.phase === 'running' || state.phase === 'starting');
      toggleButton.textContent = active ? '停止同传' : '开始同传';
    }
    if (runtime.els.capsule) {
      const title = state && state.engineState ? `livedub：${summary.label}（引擎 ${state.engineState}）` : `livedub：${summary.label}`;
      runtime.els.capsule.title = title;
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
          // 部分引擎实现 partial/segment 用不同 id：合并掉最后一条 draft，避免重复块
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
      // 新会话：清空上一场字幕
      runtime.sessionKey = state.startedAt;
      runtime.items.clear();
      runtime.metrics = null;
      runtime.error = null;
      if (runtime.els.error) runtime.els.error.hidden = true;
      renderSubtitles();
    }
    const wasActive = previous && (previous.phase === 'running' || previous.phase === 'starting');
    if (wasActive && state.phase !== 'running' && state.phase !== 'starting') {
      // 停止 / 出错：恢复所有页面音量
      restoreVolumes();
      if (state.phase === 'idle' || state.phase === 'stopping') duckIdle();
    }
    if (typeof state.latencyMs === 'number') runtime.metrics = state.metrics || runtime.metrics;
    if (state.error && state.error.message) showError(state.error.message, 'error');
    if (state.notice) showError(state.notice, 'info');
    renderStatus();
  }

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
  // 启动 / SPA 保持
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
      // 页面滚动/视频出现后压音目标可能变化：运行中每 2s 收集一次新媒体元素
      if (runtime.duck.ducking && tickCount % 2 === 0) duckActivity();
    }, TICK_MS);
  }

  function announceReady() {
    try {
      chrome.runtime.sendMessage({ type: M.CONTENT_READY, href: location.href, title: document.title }).then(
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
