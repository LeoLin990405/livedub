/**
 * v0.6 工作台「翻译参考画面文字（OCR）」纯函数：
 * 清洗/截断、变化与去重判定、发送节流、WS 消息构造。无 DOM/网络依赖，便于 node:test。
 */
export const VISUAL_CONTEXT_DEFAULTS = Object.freeze({
  enabled: false,
  intervalMs: 9000,
  minSendIntervalMs: 8000,
  maxChars: 2000,
  changeThreshold: 0.02,
  source: 'studio',
});

/** OCR 文本清洗：去控制字符、压缩空白/空行，截断 ≤ maxChars（默认 2000） */
export function normalizeVisualContextText(text, { maxChars = VISUAL_CONTEXT_DEFAULTS.maxChars } = {}) {
  const limit = Math.max(1, Math.round(Number(maxChars) || VISUAL_CONTEXT_DEFAULTS.maxChars));
  const cleaned = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\t+/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > limit ? cleaned.slice(0, limit).trim() : cleaned;
}

/**
 * 是否发送画面上下文：
 * - 开关默认关；关闭/空文本/未变化画面（changeRatio < changeThreshold）/同文本/节流间隔内都不发。
 * 返回 {send, reason}（便于日志与测试）。
 */
export function shouldSendVisualContext({
  enabled = false,
  text = '',
  lastText = '',
  changeRatio = 1,
  nowMs = Date.now(),
  lastSentAt = 0,
  minSendIntervalMs = VISUAL_CONTEXT_DEFAULTS.minSendIntervalMs,
  changeThreshold = VISUAL_CONTEXT_DEFAULTS.changeThreshold,
  maxChars = VISUAL_CONTEXT_DEFAULTS.maxChars,
} = {}) {
  if (enabled !== true) return { send: false, reason: 'disabled' };
  if (Number(changeRatio) < Number(changeThreshold)) return { send: false, reason: 'unchanged' };
  const normalized = normalizeVisualContextText(text, { maxChars });
  if (!normalized) return { send: false, reason: 'empty' };
  if (lastText && normalized === lastText) return { send: false, reason: 'duplicate' };
  const elapsed = Number(nowMs) - Number(lastSentAt || 0);
  if (Number.isFinite(elapsed) && elapsed < Math.max(0, Number(minSendIntervalMs) || 0)) {
    return { send: false, reason: 'throttled' };
  }
  return { send: true, reason: 'ok', text: normalized };
}

/** 构造 NS 消息 `{type:'visual-context',text,tMs,source,capturedAtMs}`（text ≤2000） */
export function buildVisualContextPayload({ text, tMs = 0, capturedAtMs = Date.now(), source = VISUAL_CONTEXT_DEFAULTS.source } = {}) {
  const normalized = normalizeVisualContextText(text);
  if (!normalized) return null;
  const timestamp = Math.max(0, Math.round(Number(tMs) || 0));
  return {
    type: 'visual-context',
    text: normalized,
    tMs: timestamp,
    source: String(source || VISUAL_CONTEXT_DEFAULTS.source).slice(0, 32),
    capturedAtMs: Math.max(0, Math.round(Number(capturedAtMs) || Date.now())),
  };
}

/** UI 状态行文案：「画面上下文：已开启 · 最近 00:01:23 · 128 字」/「已关闭」 */
export function describeVisualContext({ enabled = false, lastTMs = null, lastChars = 0, pending = false } = {}) {
  if (enabled !== true) return '画面上下文：已关闭';
  const parts = ['画面上下文：已开启'];
  if (pending) parts.push('识别中…');
  else if (lastTMs !== null && lastTMs !== undefined && Number.isFinite(Number(lastTMs))) {
    parts.push(`最近 ${formatHms(Number(lastTMs))}`);
    parts.push(`${Math.max(0, Math.round(Number(lastChars) || 0))} 字`);
  } else {
    parts.push('等待播放');
  }
  return parts.join(' · ');
}

function formatHms(ms) {
  const totalSeconds = Math.max(0, Math.floor(Math.round(Number(ms) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
