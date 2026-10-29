/**
 * livedub Chrome MV3 扩展 —— popup（点击工具栏图标打开）。
 *
 * v0.2：
 * - 引擎未连接引导：显示 `npm start` 步骤 + 「检测引擎」(/health) + 「重试连接」；
 * - ready 后显示 provider / voice / 语言方向；
 * - 延迟拆分为 ASR / 翻译 / 配音 / 端到端；
 * - 导出本次 SRT（background 累积字幕，popup 只负责下载）；
 * - 保留 v0.1：引擎地址保存、开始/停止（手势内 getMediaStreamId）、音色模式、工作台、错误提示。
 */

import {
  DEFAULT_ENGINE_URL,
  DEFAULT_SETTINGS,
  MSG,
  STORAGE_KEYS,
  deriveHealthUrl,
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
  probeEngine: $('probe-engine'),
  openStudio: $('open-studio'),
  health: $('health'),
  healthText: $('health-text'),
  healthDetail: $('health-detail'),
  guidance: $('guidance'),
  guidanceTitle: $('guidance-title'),
  guidanceBody: $('guidance-body'),
  retryEngine: $('retry-engine'),
  probeAgain: $('probe-again'),
  toggle: $('toggle'),
  latAsr: $('lat-asr'),
  latMt: $('lat-mt'),
  latTts: $('lat-tts'),
  latE2e: $('lat-e2e'),
  providers: $('providers'),
  voiceDetail: $('voice-detail'),
  languages: $('languages'),
  voiceMode: $('voice-mode'),
  showOverlay: $('show-overlay'),
  exportSrt: $('export-srt'),
  captionCount: $('caption-count'),
};

const runtime = {
  settings: { ...DEFAULT_SETTINGS },
  bgState: null,
  busy: false,
  errorTimer: null,
  health: { state: 'unknown', data: null, error: '' },
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

function healthProviders() {
  const state = runtime.bgState;
  if (state && state.ready && state.ready.providers) return state.ready.providers;
  if (runtime.health.state === 'online' && runtime.health.data && runtime.health.data.providers) {
    return runtime.health.data.providers;
  }
  return null;
}

function providerLabel() {
  const providers = healthProviders();
  if (!providers) return '—';
  const names = [providers.asr, providers.translate, providers.tts].filter(Boolean);
  return names.length > 0 ? names.join(' · ') : '—';
}

function voiceLabel() {
  const state = runtime.bgState;
  const voice = (state && state.voice) || (state && state.ready && state.ready.voice) || null;
  if (!voice) return '—';
  const mode = voice.mode === 'clone' ? '克隆' : '预设';
  if (voice.degraded) return `${mode}·已降级`;
  return voice.voiceId ? `${mode}·${String(voice.voiceId).slice(0, 20)}` : mode;
}

function languageLabel() {
  const state = runtime.bgState;
  const session = state && state.session;
  const from = (session && session.langFrom) || runtime.settings.langFrom || 'en';
  const to = (session && session.langTo) || runtime.settings.langTo || 'zh';
  return `${from} → ${to}`;
}

function metricsSource() {
  const state = runtime.bgState;
  if (!state) return null;
  return state.metrics || null;
}

function renderMetrics() {
  const state = runtime.bgState;
  const metrics = metricsSource();
  ui.latAsr.textContent = metrics ? formatLatency(metrics.asrFinalMs) : '—';
  ui.latMt.textContent = metrics ? formatLatency(Number.isFinite(metrics.mtFirstMs) ? metrics.mtFirstMs : metrics.mtDoneMs) : '—';
  ui.latTts.textContent = metrics ? formatLatency(metrics.ttsFirstMs) : '—';
  const e2e = metrics ? pickLatencyMs(metrics) : state && Number.isFinite(state.latencyMs) ? state.latencyMs : null;
  ui.latE2e.textContent = formatLatency(e2e);
}

function renderHealth() {
  const health = runtime.health;
  ui.health.dataset.state = health.state;
  if (health.state === 'checking') {
    ui.healthText.textContent = '检测引擎中…';
    ui.healthDetail.hidden = true;
    return;
  }
  if (health.state === 'online' && health.data) {
    const data = health.data;
    const whisper = data.whisper && data.whisper.found ? 'whisper ✓' : 'whisper ✗';
    ui.healthText.textContent = `引擎在线 · v${data.version || '?'} · ${whisper}`;
    const chain = data.providers && Array.isArray(data.providers.translateChain) && data.providers.translateChain.length
      ? data.providers.translateChain.join('/')
      : '';
    const parts = [
      `whisper ${(data.whisper && data.whisper.model) || '未找到'}`,
      chain ? `翻译链 ${chain}` : '',
      data.providers && data.providers.tts ? `TTS ${data.providers.tts}${data.providers.ttsModel ? `/${data.providers.ttsModel}` : ''}` : '',
    ].filter(Boolean);
    ui.healthDetail.hidden = parts.length === 0;
    ui.healthDetail.textContent = parts.join(' · ');
    return;
  }
  if (health.state === 'offline') {
    ui.healthText.textContent = '引擎离线';
    ui.healthDetail.hidden = !health.error;
    ui.healthDetail.textContent = health.error ? `原因：${health.error}` : '';
    return;
  }
  ui.healthText.textContent = '引擎未检测';
  ui.healthDetail.hidden = true;
}

function renderGuidance() {
  const state = runtime.bgState;
  const active = isActive();
  let info = null;
  if (active && state && state.connection === 'closed') {
    info = {
      title: '引擎连接断开，正在自动重连…',
      body: '请确认引擎进程仍在运行（cd livedub && npm start）。也可以点「重试连接」立即重连，无需重新开始抓音。',
      showRetry: true,
      showProbe: false,
    };
  } else if (!active && state && state.phase === 'error') {
    info = {
      title: '抓音失败',
      body: `${(state.error && state.error.message) || '请检查页面与引擎状态后重试。'}\n可先确认引擎已启动（cd livedub && npm start），再点「开始同传」。`,
      showRetry: false,
      showProbe: true,
    };
  } else if (!active) {
    info = {
      title: runtime.health.state === 'online' ? '引擎在线：点「开始同传」' : '未连接本地引擎',
      body:
        runtime.health.state === 'online'
          ? '已检测到本地引擎。切到视频页面后点「开始同传」即可。'
          : '① 打开终端，在 livedub 目录执行 npm start\n② 确认 http://127.0.0.1:8787/health 可访问\n③ 点「重新检测」，然后开始同传',
      showRetry: false,
      showProbe: runtime.health.state !== 'online',
    };
  }
  ui.guidance.hidden = !info;
  if (!info) return;
  ui.guidanceTitle.textContent = info.title;
  ui.guidanceBody.textContent = info.body;
  ui.retryEngine.style.display = info.showRetry ? '' : 'none';
  ui.probeAgain.style.display = info.showProbe ? '' : 'none';
}

function render() {
  const summary = statusSummary();
  ui.status.dataset.tone = summary.tone;
  ui.statusText.textContent = summary.label;

  const active = isActive();
  ui.toggle.dataset.mode = active ? 'stop' : 'start';
  ui.toggle.textContent = active ? '停止同传' : '开始同传';
  ui.toggle.disabled = runtime.busy || (runtime.bgState && runtime.bgState.phase === 'stopping');

  renderMetrics();
  ui.providers.textContent = providerLabel();
  ui.voiceDetail.textContent = voiceLabel();
  ui.languages.textContent = languageLabel();

  if (document.activeElement !== ui.engineUrl) ui.engineUrl.value = runtime.settings.engineUrl;
  ui.voiceMode.value = runtime.settings.voiceMode === 'preset' ? 'preset' : 'clone-first';

  const captionCount = (runtime.bgState && runtime.bgState.captionCount) || 0;
  ui.captionCount.textContent = `本次会话字幕 ${captionCount} 条`;
  ui.exportSrt.disabled = captionCount === 0;
  ui.exportSrt.title = captionCount === 0 ? '先开始同传并让视频说几句话，才有字幕可导出' : `导出 ${captionCount} 条字幕（SRT）`;

  renderHealth();
  renderGuidance();

  const state = runtime.bgState;
  if (state && state.error && state.error.message) showError(state.error.message, 'error', { autoHide: false });
  else if (state && state.notice) showError(state.notice, 'info');
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
  ui.probeEngine.disabled = busy;
}

function humanizeError(raw) {
  const message = String(raw || '未知错误');
  if (/gesture|not been invoked|user/i.test(message)) {
    return 'Chrome 要求用户手势才能抓音：请关闭本弹窗，重新点击工具栏的 livedub 图标，再点「开始同传」；也可以按 Alt+Shift+L。';
  }
  return message;
}

// ---------------------------------------------------------------------------
// 引擎健康检测（GET <host:port>/health，需 host_permissions 本地回环）
// ---------------------------------------------------------------------------

function describeFetchError(err) {
  const message = String((err && err.message) || err || 'unknown');
  if (/abort|timeout/i.test(message)) return '连接超时（引擎可能未启动）';
  if (/Failed to fetch|NetworkError|network/i.test(message)) return '无法连接（引擎可能未启动或端口不对）';
  return message;
}

async function probeEngineHealth({ silent = false } = {}) {
  const healthUrl = deriveHealthUrl(runtime.settings.engineUrl);
  if (!healthUrl) {
    runtime.health = { state: 'offline', data: null, error: '引擎地址格式无效' };
    renderHealth();
    return;
  }
  runtime.health = { state: 'checking', data: runtime.health.data, error: '' };
  renderHealth();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1800);
    let response;
    try {
      response = await fetch(healthUrl, { cache: 'no-store', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`/health 返回 HTTP ${response.status}`);
    const data = await response.json();
    runtime.health = { state: 'online', data, error: '' };
  } catch (err) {
    runtime.health = { state: 'offline', data: null, error: describeFetchError(err) };
    if (!silent) {
      showError(
        `无法连接本地引擎（${runtime.health.error}）。请在 livedub 目录执行 npm start，确认 http://127.0.0.1:8787/health 可访问后点「重新检测」。`,
        'error',
      );
    }
  }
  renderHealth();
  renderGuidance();
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
// 开始 / 停止 / 重试 / 导出
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
      ui.urlHint.textContent = '已保存（重新开始后生效）';
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
    void probeEngineHealth({ silent: true });
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

async function retryConnection() {
  hideError();
  if (!isActive()) {
    await probeEngineHealth();
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: MSG.RECONNECT });
    if (response && response.ok) showError('已触发立即重连引擎…', 'info');
    else showError((response && response.error && response.error.message) || '重试失败，请停止后重新开始。', 'error');
  } catch (err) {
    showError(`重试失败：${String((err && err.message) || err)}`, 'error');
  }
  render();
}

function downloadTextFile(text, filename) {
  const blob = new Blob([`\ufeff${text}`], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename || 'livedub.srt';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
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
  hideError();
  try {
    const response = await chrome.runtime.sendMessage({ type: MSG.GET_SRT });
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
    await probeEngineHealth({ silent: true });
  });

  ui.probeEngine.addEventListener('click', () => {
    void probeEngineHealth();
  });
  ui.probeAgain.addEventListener('click', () => {
    void probeEngineHealth();
  });
  ui.retryEngine.addEventListener('click', () => {
    void retryConnection();
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
    if (isActive()) showError('音色模式已同步给运行中的引擎', 'info');
  });

  ui.showOverlay.addEventListener('click', async () => {
    await saveSettings({ hidden: false });
    ui.urlHint.textContent = '已请求显示浮层（切回视频页面查看）';
  });

  ui.exportSrt.addEventListener('click', () => {
    void exportSrt();
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
  if (!isActive()) void probeEngineHealth({ silent: true });
}

void main();
