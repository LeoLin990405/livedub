/**
 * ASR 文本清洗工具（whisper / 云端 ASR 共用）。
 * 零依赖纯函数，可单测。
 */

/** 截断日志用文本 */
export function truncate(text, max = 80) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

// `[00:00:00.000 --> 00:00:02.500]` 这类时间戳（whisper 某些输出格式会带）
const TIMESTAMP_MARKER =
  /\[\s*\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\s*\]/g;
// 非语音标记：可整块删除（whisper 对静音/噪声常输出这类 token）
const NON_SPEECH_BRACKET =
  /\[\s*(?:blank_?audio|silence|music|applause|laughter|inaudible|noise|sound|background\s+music|breathing|sighs?|coughs?|music\s+playing)\s*\]/gi;
const NON_SPEECH_PAREN =
  /\(\s*(?:music|silence|applause|laughter|inaudible|noise|sound|background\s+music|music\s+playing)\s*\)/gi;
const NON_SPEECH_CJK = /[\[（(【]\s*(?:音乐|掌声|笑声|静音|背景音乐)\s*[\]）)】]/g;
const MUSIC_NOTES = /[♪♫♬♩]+/g;
const PUNCT_ONLY = /^[\s\p{P}\p{S}]+$/u;

/**
 * 清洗 ASR 输出：去非语音标记/时间戳、折叠空白、纯标点视为空串。
 * @param {unknown} text
 * @returns {string}
 */
export function cleanAsrText(text) {
  let s = String(text ?? '');
  if (!s) return '';
  s = s
    .replace(TIMESTAMP_MARKER, ' ')
    .replace(NON_SPEECH_BRACKET, ' ')
    .replace(NON_SPEECH_PAREN, ' ')
    .replace(NON_SPEECH_CJK, ' ')
    .replace(MUSIC_NOTES, ' ')
    .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || PUNCT_ONLY.test(s)) return '';
  return s;
}
