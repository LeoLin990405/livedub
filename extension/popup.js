/**
 * livedub Chrome MV3 扩展 —— popup（点击工具栏图标打开）。
 *
 * 职责：
 * - 引擎地址输入/保存（chrome.storage.local，与浮层共享）
 * - 连接状态、延迟、音色、开始/停止
 * - 音色模式（clone-first / preset）
 * - 打开本地工作台（由 WS 地址推导 http 地址）
 * - 错误提示（含「需要用户手势」的排障提示）
 *
 * 关键点：chrome.tabCapture.getMediaStreamId 必须在用户手势内调用。
 * 这里在「开始同传」按钮的点击回调里直接调用（弹窗点击 = 用户手势），
 * 拿到 streamId 再交给 background 创建 offscreen document。若直接调用失败，
 * 会退回到让 background 在消息链里再试一次（部分 Chrome 版本可用），
 * 两条路都失败时展示可读错误（让用户用快捷键 / 重新点击图标）。
 */

import {
  DEFAULT_ENGINE_URL,
  DEFAULT_SETTINGS,
  MSG,
  STORAGE_KEYS,
  deriveStudioUrl,
  isCapturablePage,
  normalizeEngineUrl,
} from './lib/constants.js';
import { formatLatency, pickLatencyMs } from './lib/pcm.js';

const $ = (id) => document.getElementById(id);

const ui = {
  status: $('status'),
  statusText: $('status-text'),
  error: $('error'),
  engineUrl: $('engine-url'),
  urlHint: $('url-hint'),
  saveUrl: $('save-url'),
  openStudio: $('open-studio'),
  toggle: $('toggle'),
  latency: $('latency'),
  voice: $('voice'),
  engine: $('engine'),
  voiceMode: $('voice-mode'),
  showOverlay: $('show-overlay'),
};

const runtime = {
  settings: { ...DEFAULT_SETTINGS },
  bgState: null,
  busy: false,
  errorTimer: null,
};

// ---------------------------------------------------------------------------
// 状态渲染
// ---------------------------------------------------------------------------

function isActive() {
  const phase = runtime.bgState && runtime.bgState.phase;
  return phase === 'running' || phase === 'starting';
}

function statusSummary() {
  const state = runtime.bgState;
  if (!state) return { label: '未连接', tone: 'idle' };
  if (state.phase === 'starting') return { label: '启动中…', tone: 'busy' };
  if (state.phase === 'stopping') return { label: '停止中…', tone: 'busy' };
  if (state.phase === 'error') return { label: '抓音失败', tone: 'error' };
  if (state.phase === 'running') {
    if (state.connection === 'connecting') return { label: '重连中…', tone: 'busy' };
    if (state.connection === 'closed') return { label: '已断开', tone: 'busy' };
    const engineState = state.engineState;
    if (engineState === 'speaking') return { label: '配音中', tone: 'speak' };
    if (engineState === 'translating') return { label: '翻译中', tone: 'translate' };
    if (engineState === 'listening') return { label: '收听中', tone: 'live' };
    if (engineState === 'paused') return { label: '已暂停', tone: 'idle' };
    if (engineState === 'error') return { label: '引擎异常', tone: 'error' };
    return { label: '已连接', tone: 'live' };
  }
  return { label: '未连接', tone: 'idle' };
}

function voiceLabel() {
  const state = runtime.bgState;
  const voice = (state && state.voice) || (state && state.ready && state.ready.voice) || null;
  if (!voice) return '—';
  const mode = voice.mode === 'clone' ? '克隆' : '预设';
  if (voice.degraded) return `${mode}·降级`;
  return voice.voiceId ? `${mode}·${String(voice.voiceId).slice(0, 14)}` : mode;
}

function engineLabel() {
  const state = runtime.bgState;
  if (!state) return '未连接';
  if (state.phase !== 'running') return state.phase === 'error' ? '异常' : '未连接';
  if (state.connection === 'closed') return '断开';
  if (state.connection === 'connecting') return '连接中';
  const engineState = state.engineState || 'idle';
  const map = {
    idle: '空闲',
    listening: '收听中',
    translating: '翻译中',
    speaking: '配音中',
    paused: '已暂停',
    error: '异常',
  };
  return map[engineState] || engineState;
}

function render() {
  const summary = statusSummary();
  ui.status.setAttribute('data-tone', summary.tone);
  ui.statusText.textContent = summary.label;

  const active = isActive();
  ui.toggle.dataset.mode = active ? 'stop' : 'start';
  ui.toggle.textContent = active ? '停止同传' : '开始同传';
  ui.toggle.disabled = runtime.busy || (runtime.bgState && runtime.bgState.phase === 'stopping');

  const metrics = runtime.bgState && runtime.bgState.metrics;
  const latency = runtime.bgState && typeof runtime.bgState.latencyMs === 'number' ? runtime.bgState.latencyMs : pickLatencyMs(metrics);
  ui.latency.textContent = formatLatency(latency);
  ui.voice.textContent = voiceLabel();
  ui.engine.textContent = engineLabel();

  if (document.activeElement !== ui.engineUrl) ui.engineUrl.value = runtime.settings.engineUrl;
  ui.voiceMode.value = runtime.settings.voiceMode === 'preset' ? 'preset' : 'clone-first';

  const state = runtime.bgState;
  if (state && state.error && state.error.message) showError(state.error.message, 'error', { autoHide: false });
  else if (state && state.notice) showError(state.notice, 'info');
  else if (ui.error.dataset.kind !== 'info' || !runtime.errorTimer) hideError();
}

function showError(message, kind = 'error', { autoHide = true } = {}) {
  ui.error.hidden = false;
  ui.error.dataset.kind = kind;
  ui.error.textContent = String(message || '');
  if (runtime.errorTimer) clearTimeout(runtime.errorTimer);
  runtime.errorTimer = null;
  if (autoHide) {
    runtime.errorTimer = setTimeout(() => {
      runtime.errorTimer = null;
      hideError();
    }, 9000);
  }
}

function hideError() {
  ui.error.hidden = true;
  ui.error.textContent = '';
  delete ui.error.dataset.kind;
}

function setBusy(busy) {
  runtime.busy = busy;
  ui.toggle.disabled = busy;
  ui.saveUrl.disabled = busy;
  ui.openStudio.disabled = busy;
}

function humanizeError(raw) {
  const message = String(raw || '未知错误');
  if (/gesture|not been invoked|user/i.test(message)) {
    return 'Chrome 要求用户手势才能抓音：请关闭本弹窗，重新点击工具栏的 livedub 图标，再点「开始同传」；也可以按 Alt+Shift+L。';
  }
  return message;
}

// ---------------------------------------------------------------------------
// 设置 / 状态同步
// ---------------------------------------------------------------------------

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get({ [STORAGE_KEYS.settings]: null });
    runtime.settings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) };
    runtime.settings.engineUrl = normalizeEngineUrl(runtime.settings.engineUrl) || DEFAULT_ENGINE_URL;
  } catch {
    runtime.settings = { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(patch) {
  runtime.settings = { ...runtime.settings, ...patch };
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: runtime.settings });
  } catch (err) {
    showError(`保存设置失败：${String((err && err.message) || err)}`);
  }
}

async function refreshState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: MSG.GET_STATE });
    if (response && response.state) {
      runtime.bgState = response.state;
      if (response.settings) runtime.settings = { ...runtime.settings, ...response.settings };
    }
  } catch (err) {
    showError(`无法连接扩展后台：${String((err && err.message) || err)}`);
  }
  render();
}

// ---------------------------------------------------------------------------
// 开始 / 停止
// ---------------------------------------------------------------------------

async function onToggleClick() {
  if (runtime.busy) return;
  if (isActive()) {
    await stopCapture();
    return;
  }
  await startCapture();
}

async function startCapture() {
  hideError();
  setBusy(true);
  try {
    const engineUrl = normalizeEngineUrl(ui.engineUrl.value);
    if (!engineUrl) {
      showError('引擎地址格式不对，示例：ws://127.0.0.1:8787/ws');
      return;
    }
    if (engineUrl !== runtime.settings.engineUrl) {
      await saveSettings({ engineUrl });
      ui.urlHint.textContent = '已保存（引擎未运行时会在下次开始时连接）';
    }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || typeof tab.id !== 'number') {
      showError('没有找到当前标签页，请切换到视频页面后重试。');
      return;
    }
    if (tab.url && !isCapturablePage(tab.url)) {
      showError('当前页面不支持抓音（chrome://、扩展商店等页面无法捕获），请打开视频页面后重试。');
      return;
    }

    // 在用户手势内调用 tabCapture.getMediaStreamId（弹窗按钮点击就是手势）
    let streamId = null;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    } catch (gestureError) {
      // 兜底：让 background 在消息链里再试一次（部分 Chrome 版本可用）
      const fallback = await chrome.runtime.sendMessage({ type: MSG.START, tabId: tab.id, engineUrl });
      if (fallback && fallback.ok) {
        runtime.bgState = fallback.state;
        render();
        return;
      }
      throw new Error(
        (fallback && fallback.error && fallback.error.message) || (gestureError && gestureError.message) || 'getMediaStreamId 失败',
      );
    }

    const response = await chrome.runtime.sendMessage({ type: MSG.START, tabId: tab.id, streamId, engineUrl });
    if (!response || response.ok !== true) {
      throw new Error((response && response.error && response.error.message) || '抓音启动失败');
    }
    runtime.bgState = response.state;
    render();
  } catch (err) {
    showError(humanizeError(String((err && err.message) || err)));
  } finally {
    setBusy(false);
    render();
  }
}

async function stopCapture() {
  hideError();
  setBusy(true);
  try {
    const response = await chrome.runtime.sendMessage({ type: MSG.STOP });
    if (response && response.state) runtime.bgState = response.state;
    render();
  } catch (err) {
    showError(`停止失败：${String((err && err.message) || err)}`);
  } finally {
    setBusy(false);
    render();
  }
}

// ---------------------------------------------------------------------------
// 事件绑定 / 初始化
// ---------------------------------------------------------------------------

function bindEvents() {
  ui.toggle.addEventListener('click', () => {
    void onToggleClick();
  });

  ui.saveUrl.addEventListener('click', async () => {
    const normalized = normalizeEngineUrl(ui.engineUrl.value);
    if (!normalized) {
      showError('引擎地址格式不对，示例：ws://127.0.0.1:8787/ws');
      return;
    }
    await saveSettings({ engineUrl: normalized });
    ui.engineUrl.value = normalized;
    ui.urlHint.textContent = isActive() ? '已保存：本次会话继续用旧地址，重新开始后生效' : '已保存';
    hideError();
  });

  ui.openStudio.addEventListener('click', async () => {
    const url = deriveStudioUrl(runtime.settings.engineUrl || ui.engineUrl.value);
    if (!url) {
      showError('无法从引擎地址推导工作台地址，请检查引擎地址');
      return;
    }
    try {
      await chrome.tabs.create({ url });
    } catch (err) {
      showError(`打开工作台失败：${String((err && err.message) || err)}`);
    }
  });

  ui.voiceMode.addEventListener('change', async () => {
    const mode = ui.voiceMode.value === 'preset' ? 'preset' : 'clone-first';
    await saveSettings({ voiceMode: mode });
    if (isActive()) ui.urlHint.textContent = '音色模式已同步给运行中的引擎';
  });

  ui.showOverlay.addEventListener('click', async () => {
    await saveSettings({ hidden: false });
    ui.urlHint.textContent = '已请求显示浮层（切回视频页面查看）';
  });

  ui.engineUrl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void ui.saveUrl.click();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== MSG.STATE) return false;
    if (message.state) runtime.bgState = message.state;
    if (message.settings) runtime.settings = { ...runtime.settings, ...message.settings };
    render();
    return false;
  });
}

async function main() {
  bindEvents();
  await loadSettings();
  render();
  await refreshState();
}

void main();
