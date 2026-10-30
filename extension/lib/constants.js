/**
 * livedub 扩展共享常量 / 纯函数（浏览器 + Node 均可 import；零依赖）。
 *
 * 这里只放「背景页、offscreen、popup、Node 测试」都会用到的东西：
 * 默认引擎地址、storage key、跨上下文消息类型、用户设置默认值、URL 规范化。
 * content script 是 classic script（MV3 限制，不能 import），因此它内部有一份
 * 等价的字符串常量；tests/extension.test.mjs 会校验两边一致。
 */

/** 本地引擎默认 WebSocket 地址（见 docs/CONTRACTS.md §3） */
export const DEFAULT_ENGINE_URL = 'ws://127.0.0.1:8787/ws';

/** chrome.storage 的 key（全部集中在这里，避免各处手写字符串漂移） */
export const STORAGE_KEYS = Object.freeze({
  /** chrome.storage.local：用户设置（引擎地址 / 配音 / 压音 / 字幕样式...） */
  settings: 'livedub:settings',
  /** chrome.storage.session：service worker 的运行态快照（SW 被回收后可恢复） */
  bgState: 'livedub:bg-state',
  /** chrome.storage.session：本次会话的 segment+translation 累积（用于导出 SRT 跨 SW 回收） */
  captions: 'livedub:captions',
  /** chrome.storage.local：笔记离线队列（POST 失败时排队，引擎重连后 flush） */
  noteQueue: 'livedub:note-queue',
  /** chrome.storage.local：今日笔记计数（本地统计，离线可用） */
  noteStats: 'livedub:note-stats',
});

/** 跨上下文消息类型（popup/content <-> background <-> offscreen） */
export const MSG = Object.freeze({
  // ---- popup / content -> background ----
  GET_STATE: 'livedub:get-state',
  START: 'livedub:start',
  STOP: 'livedub:stop',
  CONTENT_READY: 'livedub:content-ready',
  CONTENT_TOGGLE: 'livedub:toggle-capture',
  /** popup / 浮层 -> background：导出本次会话 SRT（返回 srt 文本与文件名） */
  GET_SRT: 'livedub:get-srt',
  /** popup / 浮层 -> background：立即重试连接引擎（运行中时驱动 offscreen 重连） */
  RECONNECT: 'livedub:reconnect',
  SET_SETTINGS: 'livedub:set-settings',
  CONFIG_PATCH: 'livedub:config-patch',

  // ---- background -> popup（chrome.runtime.sendMessage 广播）----
  STATE: 'livedub:state',

  // ---- background -> content（chrome.tabs.sendMessage）----
  ENGINE_EVENT: 'livedub:event',
  CONTENT_SETTINGS: 'livedub:settings',
  PING: 'livedub:ping',

  // ---- v0.4 笔记（background <-> content / popup） ----
  /** popup / content -> background：记录当前句为笔记（快捷键 Alt+Shift+N 走 commands） */
  CAPTURE_NOTE: 'livedub:capture-note',
  /** background -> content：请求当前视频/字幕上下文（返回 {ok,context}） */
  NOTE_CONTEXT: 'livedub:note-context',
  /** background -> content：记录结果（成功/排队 toast） */
  NOTE_RESULT: 'livedub:note-result',
  /** popup -> background：导出当前视频笔记 Markdown（POST /api/notes/export） */
  EXPORT_NOTES: 'livedub:export-notes',

  // ---- background <-> offscreen ----
  OFFSCREEN_HELLO: 'livedub:offscreen-hello',
  OFFSCREEN_START: 'livedub:offscreen-start',
  OFFSCREEN_STOP: 'livedub:offscreen-stop',
  OFFSCREEN_CONFIG: 'livedub:offscreen-config',
  OFFSCREEN_STATE: 'livedub:offscreen-state',
  OFFSCREEN_EVENT: 'livedub:offscreen-event',
  OFFSCREEN_STOPPED: 'livedub:offscreen-stopped',
  /** background -> offscreen 健康检查（用于 SW 恢复后确认采集是否还在） */
  OFFSCREEN_PING: 'livedub:offscreen-ping',
  /** background -> offscreen：跳过退避立即重连引擎 */
  OFFSCREEN_RECONNECT: 'livedub:offscreen-reconnect',
});

/** offscreen document 的路径与创建原因（manifest 不声明，由 background 动态创建） */
export const OFFSCREEN_DOCUMENT_URL = 'offscreen.html';
export const OFFSCREEN_REASONS = Object.freeze(['USER_MEDIA', 'AUDIO_PLAYBACK']);
export const OFFSCREEN_JUSTIFICATION = 'capture tab audio and play dub';

/** 用户设置默认值；content script 内有一份同名副本（classic script 不能 import） */
export const DEFAULT_SETTINGS = Object.freeze({
  engineUrl: DEFAULT_ENGINE_URL,
  /** 'clone-first' | 'preset'，对应引擎 config tts.voiceMode */
  voiceMode: 'clone-first',
  /** 是否播放中文配音（对应引擎 dub.enabled） */
  dubEnabled: true,
  /** 说话时把页面 media 音量压到原音量的多少（0.02 ~ 1） */
  duckRatio: 0.18,
  /** 字幕是否显示原文 */
  showOriginal: true,
  /** 字幕译文字号（px） */
  fontSize: 22,
  /** 字幕停靠：bottom | top */
  dock: 'bottom',
  /** 字幕 Y 偏移（px，正值 = 远离停靠边：bottom 上移 / top 下移，用于避开平台原生字幕） */
  offsetY: 0,
  /** 字幕横向偏移（px，可拖拽） */
  dx: 0,
  /** 字幕背景不透明度（0.2 ~ 1，只影响背景不影响文字） */
  subsOpacity: 0.82,
  /** 字幕背景：dark | light | none */
  subsBg: 'dark',
  /** v0.3：offscreen 是否把抓到的原声重放给用户（tabCapture 会静音标签页，关闭=只听配音） */
  captureReplay: true,
  /** v0.3：全局限定压音（offscreen 对重放原声做 GainNode duck，覆盖 iframe/WebAudio 站点） */
  globalDuck: true,
  /** v0.3：说话结束后多少 ms 恢复原声（300~3000，duck 渐变 120-200ms） */
  duckRecoverMs: 800,
  /** v0.3：裸 <video> 全屏兼容（拦截站点 requestFullscreen 包一层容器） */
  fullscreenWorkaround: true,
  /** v0.4：记笔记时是否附带页面截图（captureVisibleTab） */
  noteScreenshot: true,
  langFrom: 'en',
  langTo: 'zh',
  /** 是否隐藏浮层（从 popup 可重新打开） */
  hidden: false,
  /** 设置面板是否收起（保留标题栏可展开） */
  panelCollapsed: false,
  /** 设置面板拖拽偏移 {dx, dy}，null = 默认右上角 */
  panelPos: null,
});

/**
 * 规范化引擎地址：接受 `ws://`/`wss://`/`http(s)://`/裸 host:port。
 * - http(s) 自动升级为 ws(s)
 * - 没有路径时按约定补 `/ws`（见 CONTRACTS §3）
 * - 非法返回 null（调用方展示错误，不要抛到 UI 顶层）
 * @param {string} value
 * @returns {string|null}
 */
export function normalizeEngineUrl(value) {
  if (typeof value !== 'string') return null;
  let raw = value.trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `ws://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  let proto = url.protocol.toLowerCase();
  if (proto === 'http:') proto = 'ws:';
  else if (proto === 'https:') proto = 'wss:';
  if (proto !== 'ws:' && proto !== 'wss:') return null;
  if (!url.hostname) return null;
  let path = url.pathname || '/ws';
  if (path === '/' || path === '') path = '/ws';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return `${proto}//${url.host}${path}${url.search}`;
}

/**
 * 从引擎 WS 地址推导引擎 HTTP 根地址。
 * ws://127.0.0.1:8787/ws -> http://127.0.0.1:8787
 * @param {string} engineUrl
 * @returns {string|null}
 */
export function deriveEngineHttpBase(engineUrl) {
  const normalized = normalizeEngineUrl(engineUrl);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    const proto = url.protocol === 'wss:' ? 'https:' : 'http:';
    return `${proto}//${url.host}`;
  } catch {
    return null;
  }
}

/**
 * 从引擎 WS 地址推导本地工作台地址，用于 popup 的「打开工作台」。
 * engine/server.mjs 静态托管在 /studio/（根路径 302 过去）。
 * ws://127.0.0.1:8787/ws -> http://127.0.0.1:8787/studio/
 * @param {string} engineUrl
 * @returns {string|null}
 */
export function deriveStudioUrl(engineUrl) {
  const base = deriveEngineHttpBase(engineUrl);
  return base ? `${base}/studio/` : null;
}

/**
 * 引擎健康检查地址（GET /health，返回 providers / whisper / ok 等）。
 * @param {string} engineUrl
 * @returns {string|null}
 */
export function deriveHealthUrl(engineUrl) {
  const base = deriveEngineHttpBase(engineUrl);
  return base ? `${base}/health` : null;
}

/**
 * 当前标签页 URL 是否可能被抓音。
 * chrome:// / edge:// / Chrome Web Store 等页面 tabCapture 会直接失败，提前给出可读错误。
 * @param {string|undefined} url
 */
export function isCapturablePage(url) {
  if (typeof url !== 'string' || !url) return false;
  if (/^https?:/i.test(url)) return true;
  // file:// 需要用户在扩展详情里打开「允许访问文件网址」，交给 tabCapture 抛错兜底
  if (/^file:/i.test(url)) return true;
  return false;
}
