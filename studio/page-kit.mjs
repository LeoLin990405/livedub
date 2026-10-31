/**
 * 工作台用的页面地址判断（浏览器安全：不抓网、不引引擎）。
 * 媒体扩展名须与 engine/page/parse.mjs 的 MEDIA_EXTENSIONS 保持一致。
 */

export const MEDIA_EXTENSIONS = Object.freeze(['mp4', 'webm', 'ogg', 'ogv', 'mp3', 'm4a', 'wav', 'mov', 'm3u8', 'mkv']);
export const SUBTITLE_EXTENSIONS = Object.freeze(['vtt', 'srt']);

const MEDIA_EXT = new Set(MEDIA_EXTENSIONS);
const SUBTITLE_EXT = new Set(SUBTITLE_EXTENSIONS);

export function urlExtension(url) {
  try {
    const parsed = new URL(url, 'http://local.invalid');
    const base = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '');
    const dot = base.lastIndexOf('.');
    if (dot < 0 || dot === base.length - 1) return '';
    return base.slice(dot + 1).toLowerCase();
  } catch {
    return '';
  }
}

export function isDirectMediaUrl(url) {
  return MEDIA_EXT.has(urlExtension(url));
}

export function isDirectSubtitleUrl(url) {
  return SUBTITLE_EXT.has(urlExtension(url));
}

/** 加密流、需要 Referer 的站点流、观看页本身，都不能交给 <video>。 */
export function isBlockedMediaHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'googlevideo.com' || host.endsWith('.googlevideo.com')) return true;
  if (host === 'bilivideo.com' || host.endsWith('.bilivideo.com') || host.endsWith('.bilivideo.cn')) return true;
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return true;
  if (host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) return true;
  if (host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv' || host.endsWith('.b23.tv')) return true;
  return false;
}

export function isLoadableVideo(item) {
  const url = typeof item === 'string' ? item : item?.url;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (isBlockedMediaHost(parsed.hostname)) return false;
  if (parsed.pathname.toLowerCase().endsWith('.mpd')) return false;
  const mime = String(item?.mime ?? '').toLowerCase();
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return true;
  return isDirectMediaUrl(url);
}

function langRank(lang) {
  const value = String(lang ?? '').trim().toLowerCase().replaceAll('_', '-');
  if (value === 'en' || value.startsWith('en-')) return 0;
  if (value === 'zh' || value.startsWith('zh-')) return 1;
  if (!value) return 3;
  return 2;
}

/** 优先英文，其次中文，否则用第一条有时间轴的字幕。没有时间轴的文稿不参与。 */
export function chooseSubtitleTrack(subtitles) {
  const list = (Array.isArray(subtitles) ? subtitles : [])
    .filter((track) => track && !track.syntheticTiming && Array.isArray(track.cues) && track.cues.some((cue) => String(cue?.text ?? '').trim()))
    .map((track, index) => ({ track, index }));
  list.sort((a, b) => langRank(a.track.lang) - langRank(b.track.lang) || a.index - b.index);
  return list[0]?.track ?? null;
}

export function cuesForSession(page) {
  const track = chooseSubtitleTrack(page?.subtitles);
  if (!track) return [];
  return track.cues
    .map((cue) => ({
      t0Ms: Number(cue.t0Ms) || 0,
      t1Ms: Number(cue.t1Ms) || 0,
      text: String(cue.text ?? '').trim(),
    }))
    .filter((cue) => cue.text);
}
