/**
 * 课程页解析：标题、页面里能直接播放的视频、带时间轴的字幕。
 * 不跑无头浏览器，不用 yt-dlp。YouTube / B 站只取字幕，不取加密流或需要 Referer 的 dash。
 * 媒体扩展名须与 studio/page-kit.mjs 的 MEDIA_EXTENSIONS 保持一致。
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';

export const MEDIA_EXTENSIONS = Object.freeze(['mp4', 'webm', 'ogg', 'ogv', 'mp3', 'm4a', 'wav', 'mov', 'm3u8', 'mkv']);
export const SUBTITLE_EXTENSIONS = Object.freeze(['vtt', 'srt']);

const MEDIA_EXT = new Set(MEDIA_EXTENSIONS);
const SUBTITLE_EXT = new Set(SUBTITLE_EXTENSIONS);
const HTML_CAP = 1_500_000;
const SUBTITLE_CAP = 400_000;
const CUE_CAP = 200;
const CUE_SAFETY = 5000;
const TRACK_CAP = 3;
const VIDEO_CAP = 5;
const TEXT_CAP = 500;
const TIMEOUT_MS = 12_000;
const REDIRECT_CAP = 5;
const WALK_NODES = 20_000;
const WALK_DEPTH = 10;

export class PageParseError extends Error {
  constructor(code, message, statusCode = 502) {
    super(message);
    this.name = 'PageParseError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function extensionOf(pathname) {
  const clean = String(pathname ?? '').split(/[?#]/, 1)[0];
  const base = decodeURIComponent(clean.split('/').filter(Boolean).pop() ?? '');
  const dot = base.lastIndexOf('.');
  if (dot < 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function classifyTarget(raw) {
  const url = new URL(raw);
  const ext = extensionOf(url.pathname);
  if (MEDIA_EXT.has(ext)) return 'media';
  if (SUBTITLE_EXT.has(ext)) return 'subtitles';
  return 'page';
}

function isBlockedMediaHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'googlevideo.com' || host.endsWith('.googlevideo.com')) return true;
  if (host === 'bilivideo.com' || host.endsWith('.bilivideo.com') || host.endsWith('.bilivideo.cn')) return true;
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return true;
  if (host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) return true;
  if (host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv' || host.endsWith('.b23.tv')) return true;
  return false;
}

function isLoadableMediaUrl(raw, mime = '') {
  if (typeof raw !== 'string' || !raw) return false;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (isBlockedMediaHost(url.hostname)) return false;
  if (url.pathname.toLowerCase().endsWith('.mpd')) return false;
  const type = String(mime ?? '').toLowerCase();
  if (type.startsWith('video/') || type.startsWith('audio/')) return true;
  return MEDIA_EXT.has(extensionOf(url.pathname));
}

function siteOf(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/\.$/, '');
    if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com')) {
      return 'youtube';
    }
    if (host === 'b23.tv' || host.endsWith('.b23.tv') || host === 'bilibili.com' || host.endsWith('.bilibili.com')) return 'bilibili';
  } catch {
    /* ignore */
  }
  return 'generic';
}

function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, body) => {
    const lower = String(body).toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower === 'nbsp') return ' ';
    const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : lower.startsWith('#') ? Number.parseInt(lower.slice(1), 10) : NaN;
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return all;
    try {
      return String.fromCodePoint(code);
    } catch {
      return all;
    }
  });
}

export function cleanCueText(raw) {
  const text = decodeEntities(String(raw ?? ''))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(text);
  return chars.length > TEXT_CAP ? chars.slice(0, TEXT_CAP).join('') : text;
}

function parseClock(token) {
  const text = String(token ?? '').trim().replace(',', '.');
  const match = /^(?:(\d+):)?(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?$/.exec(text);
  if (!match) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) return null;
  const frac = (match[4] ?? '0').padEnd(3, '0').slice(0, 3);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + Number(frac);
}

function finalizeCues(cues) {
  const out = [];
  let truncated = false;
  for (const cue of cues ?? []) {
    const text = cleanCueText(cue?.text);
    if (!text) continue;
    const t0 = Math.round(Number(cue.t0Ms));
    let t1 = Math.round(Number(cue.t1Ms));
    if (!Number.isFinite(t0) || t0 < 0 || !Number.isFinite(t1)) continue;
    if (t1 <= t0) t1 = t0 + 1;
    if (out.length >= CUE_CAP) {
      truncated = true;
      break;
    }
    out.push({ t0Ms: t0, t1Ms: t1, text });
  }
  return { cues: out, truncated };
}

function parseVttOrSrt(raw) {
  const normalized = String(raw ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const cues = [];
  for (const block of normalized.split(/\n{2,}/)) {
    if (cues.length >= CUE_SAFETY) break;
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !/^WEBVTT\b/i.test(line) && !/^NOTE\b/i.test(line) && !/^STYLE\b/i.test(line) && !/^REGION\b/i.test(line) && !/^(Kind|Language):/i.test(line));
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const match = /^(\S+)\s+-->\s+(\S+)/.exec(lines[timingIndex]);
    if (!match) continue;
    const t0 = parseClock(match[1]);
    const t1 = parseClock(match[2]);
    if (t0 == null || t1 == null) continue;
    const text = lines.slice(timingIndex + 1).join(' ');
    if (!cleanCueText(text)) continue;
    cues.push({ t0Ms: t0, t1Ms: t1, text });
  }
  return cues;
}

function parseTimedTextXml(raw) {
  const cues = [];
  const pattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let match = pattern.exec(raw);
  while (match) {
    if (cues.length >= CUE_SAFETY) break;
    const attrs = match[1] ?? '';
    const startRaw = /\bstart\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1] ?? '';
    const durRaw = /\bdur\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1] ?? '';
    let t0 = null;
    if (startRaw.includes(':')) t0 = parseClock(startRaw);
    else if (startRaw) t0 = Math.round(Number(startRaw) * 1000);
    if (t0 == null || !Number.isFinite(t0)) {
      match = pattern.exec(raw);
      continue;
    }
    let t1 = null;
    if (durRaw) {
      const dur = durRaw.includes(':') ? parseClock(durRaw) : Math.round(Number(durRaw) * 1000);
      if (Number.isFinite(dur)) t1 = t0 + dur;
    }
    cues.push({ t0Ms: t0, t1Ms: t1 ?? t0, text: match[2] ?? '' });
    match = pattern.exec(raw);
  }
  for (let i = 0; i < cues.length; i += 1) {
    if (cues[i].t1Ms > cues[i].t0Ms) continue;
    const next = cues[i + 1]?.t0Ms;
    cues[i].t1Ms = Number.isFinite(next) && next > cues[i].t0Ms ? next : cues[i].t0Ms + 1000;
  }
  return cues;
}

function parseJsonCues(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data.body)) {
    const cues = [];
    for (const item of data.body) {
      if (cues.length >= CUE_SAFETY) break;
      if (!item || typeof item !== 'object') continue;
      const from = Number(item.from);
      const to = Number(item.to);
      if (!Number.isFinite(from)) continue;
      cues.push({
        t0Ms: Math.round(from * 1000),
        t1Ms: Number.isFinite(to) ? Math.round(to * 1000) : Math.round(from * 1000),
        text: item.content ?? item.text ?? '',
      });
    }
    return cues;
  }
  if (Array.isArray(data.events)) {
    const cues = [];
    for (const event of data.events) {
      if (cues.length >= CUE_SAFETY) break;
      if (!event || typeof event !== 'object' || !Array.isArray(event.segs)) continue;
      const text = event.segs.map((seg) => seg?.utf8 ?? '').join('');
      const t0 = Number(event.tStartMs);
      if (!Number.isFinite(t0) || !cleanCueText(text)) continue;
      const dur = Number(event.dDurationMs);
      cues.push({ t0Ms: t0, t1Ms: t0 + (Number.isFinite(dur) ? dur : 0), text });
    }
    return cues;
  }
  return null;
}

/** VTT、SRT、YouTube timedtext XML、YouTube json3、B 站 subtitle JSON。没有时间轴的纯文本不会变成 cue。 */
export function parseSubtitleDocument(text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '').trim();
  if (!raw) return [];
  if (raw.startsWith('{') || raw.startsWith('[')) {
    const jsonCues = parseJsonCues(raw);
    if (jsonCues?.length) return finalizeCues(jsonCues).cues;
  }
  if (/<text\b/i.test(raw) && /\bstart\s*=/i.test(raw)) {
    const xmlCues = parseTimedTextXml(raw);
    if (xmlCues.length) return finalizeCues(xmlCues).cues;
  }
  return finalizeCues(parseVttOrSrt(raw)).cues;
}

function parseSubtitleDocumentFull(text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '').trim();
  if (!raw) return { cues: [], truncated: false };
  if (raw.startsWith('{') || raw.startsWith('[')) {
    const jsonCues = parseJsonCues(raw);
    if (jsonCues?.length) return finalizeCues(jsonCues);
  }
  if (/<text\b/i.test(raw) && /\bstart\s*=/i.test(raw)) {
    const xmlCues = parseTimedTextXml(raw);
    if (xmlCues.length) return finalizeCues(xmlCues);
  }
  return finalizeCues(parseVttOrSrt(raw));
}

function resolveHttpUrl(raw, base) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || /^(?:data|blob|javascript|file|chrome|edge|about):/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function readTag(html, start) {
  if (html[start] !== '<') return null;
  let i = start + 1;
  if (html[i] === '/' || html[i] === '!' || html[i] === '?') return null;
  if (!/[A-Za-z]/.test(html[i] ?? '')) return null;
  let name = '';
  while (i < html.length && /[A-Za-z0-9:-]/.test(html[i])) {
    name += html[i];
    i += 1;
  }
  if (!name) return null;
  const attrs = {};
  while (i < html.length) {
    const before = i;
    while (i < html.length && /\s/.test(html[i])) i += 1;
    if (i >= html.length) return null;
    if (html[i] === '>') return { name: name.toLowerCase(), attrs, end: i + 1 };
    if (html[i] === '/') {
      if (html[i + 1] === '>') return { name: name.toLowerCase(), attrs, end: i + 2 };
      return null;
    }
    let key = '';
    while (i < html.length && /[^\s=>/]/.test(html[i])) {
      key += html[i];
      i += 1;
    }
    while (i < html.length && /\s/.test(html[i])) i += 1;
    let value = '';
    if (html[i] === '=') {
      i += 1;
      while (i < html.length && /\s/.test(html[i])) i += 1;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const end = html.indexOf(quote, i + 1);
        if (end < 0) return null;
        value = html.slice(i + 1, end);
        i = end + 1;
      } else {
        const begin = i;
        while (i < html.length && /[^\s>]/.test(html[i])) i += 1;
        value = html.slice(begin, i);
      }
    }
    if (key) attrs[key.toLowerCase()] = decodeEntities(value);
    if (i === before) return null;
  }
  return null;
}

function scanJsonObject(text, start) {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function extractAssignedObject(html, marker) {
  let from = 0;
  while (from < html.length) {
    const idx = html.indexOf(marker, from);
    if (idx < 0) return null;
    const brace = html.indexOf('{', idx + marker.length);
    if (brace < 0) return null;
    if (brace - idx > 80) {
      from = idx + marker.length;
      continue;
    }
    const json = scanJsonObject(html, brace);
    if (!json) return null;
    try {
      return JSON.parse(json);
    } catch {
      from = brace + 1;
    }
  }
  return null;
}

function langRank(lang) {
  const value = String(lang ?? '').trim().toLowerCase().replaceAll('_', '-');
  if (value === 'en' || value.startsWith('en-')) return 0;
  if (value === 'zh' || value.startsWith('zh-')) return 1;
  if (!value) return 3;
  return 2;
}

function addVideo(videos, raw, base, mime = '') {
  const href = resolveHttpUrl(raw, base);
  if (!href || !isLoadableMediaUrl(href, mime)) return;
  if (videos.some((item) => item.url === href)) return;
  if (videos.length >= VIDEO_CAP) return;
  const type = String(mime ?? '').toLowerCase();
  videos.push(type.startsWith('video/') || type.startsWith('audio/') ? { url: href, mime: type.split(';', 1)[0] } : { url: href });
}

function isStreamCdn(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  return host === 'googlevideo.com' || host.endsWith('.googlevideo.com') || host === 'bilivideo.com' || host.endsWith('.bilivideo.com') || host.endsWith('.bilivideo.cn');
}

function addTrack(tracks, raw, base, lang = '', label = '') {
  const href = resolveHttpUrl(raw, base);
  if (!href) return;
  const parsed = new URL(href);
  if (isStreamCdn(parsed.hostname) || MEDIA_EXT.has(extensionOf(parsed.pathname))) return;
  if (tracks.some((item) => item.url === href)) return;
  tracks.push({ url: href, lang: String(lang ?? '').trim(), label: String(label ?? '').trim() });
}

function preferVtt(raw) {
  try {
    const url = new URL(raw);
    if (!/timedtext/i.test(`${url.pathname}${url.search}`)) return raw;
    url.searchParams.set('fmt', 'vtt');
    return url.href;
  } catch {
    return raw;
  }
}

function ingestLdJson(raw, base, videos, tracks, state) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  const found = [];
  const walk = (node, depth) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const type = node['@type'];
    const types = Array.isArray(type) ? type : type ? [type] : [];
    if (types.some((item) => String(item).toLowerCase().includes('videoobject'))) found.push(node);
    if (node['@graph']) walk(node['@graph'], depth + 1);
  };
  walk(data, 0);
  for (const node of found) {
    if (!state.title && typeof node.name === 'string') state.title = cleanCueText(node.name);
    const content = node.contentUrl ?? node.embedUrl;
    const urls = Array.isArray(content) ? content : content ? [content] : [];
    for (const item of urls) addVideo(videos, typeof item === 'string' ? item : item?.url, base, item?.encodingFormat ?? '');
    const transcript = node.transcript;
    if (typeof transcript === 'string') {
      const asUrl = resolveHttpUrl(transcript, base);
      if (asUrl && (SUBTITLE_EXT.has(extensionOf(new URL(asUrl).pathname)) || /timedtext/i.test(asUrl))) addTrack(tracks, asUrl, base);
      else if (transcript.trim()) state.sawUntimed = true;
    }
  }
}

function youtubeTracks(player, base, tracks, state) {
  const title = player?.videoDetails?.title;
  if (typeof title === 'string' && title.trim()) state.title = cleanCueText(title);
  const list = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(list)) return;
  for (const track of list) {
    if (!track || typeof track !== 'object' || typeof track.baseUrl !== 'string') continue;
    const label = track.name?.simpleText || track.name?.runs?.map((run) => run?.text ?? '').join('') || '';
    addTrack(tracks, preferVtt(track.baseUrl), base, track.languageCode || track.lang || '', label);
  }
}

function walkForSubtitles(node, base, tracks, state) {
  const visit = { n: 0 };
  const walk = (current, depth) => {
    if (!current || typeof current !== 'object' || visit.n > WALK_NODES || depth > WALK_DEPTH) return;
    visit.n += 1;
    if (!Array.isArray(current)) {
      const subtitleUrl = current.subtitle_url || current.subtitleUrl;
      if (typeof subtitleUrl === 'string') {
        addTrack(tracks, subtitleUrl, base, current.lan || current.lang || current.language || '', current.lan_doc || current.label || '');
      }
      const title = current.videoData?.title;
      if (!state.bilibiliTitle && typeof title === 'string' && title.trim()) state.bilibiliTitle = cleanCueText(title);
    }
    const entries = Object.entries(current);
    entries.sort((a, b) => rankKey(b[0]) - rankKey(a[0]));
    for (const [, value] of entries.slice(0, 80)) {
      if (value && typeof value === 'object') walk(value, depth + 1);
    }
  };
  walk(node, 0);
}

function rankKey(key) {
  const name = String(key).toLowerCase();
  if (name.includes('subtitle')) return 3;
  if (name === 'videodata') return 2;
  if (name === 'data') return 1;
  return 0;
}

function skipElement(page, lower, from, name) {
  const close = lower.indexOf(`</${name}`, from);
  if (close < 0) return page.length;
  const end = page.indexOf('>', close);
  return end < 0 ? page.length : end + 1;
}

export function parseHtmlPage(html, baseUrl) {
  const page = String(html ?? '');
  const lower = page.toLowerCase();
  const base = baseUrl;
  const videos = [];
  const tracks = [];
  const state = { title: '', bilibiliTitle: '', sawUntimed: false };
  let documentTitle = '';
  let i = 0;
  while (i < page.length) {
    const start = page.indexOf('<', i);
    if (start < 0) break;
    const tag = readTag(page, start);
    if (!tag) {
      i = start + 1;
      continue;
    }
    const attrs = tag.attrs;
    if (tag.name === 'script' || tag.name === 'style') {
      if (tag.name === 'script' && String(attrs.type || '').toLowerCase().includes('ld+json')) {
        const close = lower.indexOf('</script', tag.end);
        ingestLdJson(page.slice(tag.end, close < 0 ? Math.min(page.length, tag.end + 200_000) : close), base, videos, tracks, state);
      }
      i = skipElement(page, lower, tag.end, tag.name);
      continue;
    }
    if (tag.name === 'title' && !documentTitle) {
      const close = lower.indexOf('</title', tag.end);
      documentTitle = cleanCueText(page.slice(tag.end, close < 0 ? tag.end : close));
    } else if (tag.name === 'meta') {
      const key = String(attrs.property || attrs.name || '').toLowerCase();
      if (key === 'og:title' && attrs.content) state.title = cleanCueText(attrs.content);
      if ((key === 'og:video' || key === 'og:video:url' || key === 'og:video:secure_url' || key === 'twitter:player:stream') && attrs.content) {
        addVideo(videos, attrs.content, base, attrs.type || '');
      }
    } else if (tag.name === 'video' && attrs.src) {
      addVideo(videos, attrs.src, base, attrs.type || '');
    } else if (tag.name === 'source' && attrs.src) {
      addVideo(videos, attrs.src, base, attrs.type || '');
    } else if (tag.name === 'track' && attrs.src) {
      const kind = String(attrs.kind || 'subtitles').toLowerCase();
      if (kind === 'subtitles' || kind === 'captions') addTrack(tracks, attrs.src, base, attrs.srclang || attrs.lang || '', attrs.label || '');
    } else if (tag.name === 'a' && attrs.href && SUBTITLE_EXT.has(extensionOf(attrs.href))) {
      addTrack(tracks, attrs.href, base);
    }
    i = tag.end;
  }
  const youtube = extractAssignedObject(page, 'ytInitialPlayerResponse');
  if (youtube) youtubeTracks(youtube, base, tracks, state);
  const bilibili = extractAssignedObject(page, '__INITIAL_STATE__');
  if (bilibili) walkForSubtitles(bilibili, base, tracks, state);
  const site = siteOf(base);
  const title = (site === 'bilibili' && state.bilibiliTitle) || state.title || state.bilibiliTitle || documentTitle || '';
  return { site, title, videos, tracks, sawUntimed: state.sawUntimed };
}

function pickTracks(tracks) {
  return tracks
    .map((track, index) => ({ track, index }))
    .sort((a, b) => langRank(a.track.lang) - langRank(b.track.lang) || a.index - b.index)
    .slice(0, TRACK_CAP)
    .map((item) => item.track);
}

function isMetadataHost(host) {
  const name = String(host ?? '').toLowerCase().replace(/\.$/, '');
  return name === 'metadata.google.internal' || name.endsWith('.metadata.google.internal');
}

function isBlockedV4(ip) {
  const parts = String(ip).split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (parts[0] === 0) return true;
  return parts[0] === 169 && parts[1] === 254;
}

function ipv6Bytes(address) {
  const text = String(address).toLowerCase();
  if (text.includes('.')) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 0) return null;
  const groups = halves.length === 1 ? left : [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

function isBlockedIp(address) {
  const family = net.isIP(address);
  if (family === 4) return isBlockedV4(address);
  if (family !== 6) return false;
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isBlockedV4(mapped[1]);
  if (lower === '::') return true;
  const bytes = ipv6Bytes(lower);
  if (!bytes) return false;
  return bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80;
}

async function vetUrl(raw, lookup) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new PageParseError('invalid_url', '地址无效', 400);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PageParseError('invalid_url', '只支持 http(s) 地址', 400);
  }
  if (url.username || url.password) {
    throw new PageParseError('invalid_url', '地址里不能带用户名或密码', 400);
  }
  let host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) throw new PageParseError('invalid_url', '地址缺少主机名', 400);
  if (isMetadataHost(host)) throw new PageParseError('blocked_url', '这个地址不能抓取', 400);
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new PageParseError('blocked_url', '这个地址不能抓取', 400);
    return url.href;
  }
  let records;
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw new PageParseError('page_fetch_failed', `无法解析主机：${host}`, 502);
  }
  const list = Array.isArray(records) ? records : [records];
  if (!list.length) throw new PageParseError('page_fetch_failed', `无法解析主机：${host}`, 502);
  for (const record of list) {
    const address = typeof record === 'string' ? record : record?.address;
    if (isBlockedIp(address)) throw new PageParseError('blocked_url', '这个地址不能抓取', 400);
  }
  return url.href;
}

async function readText(response, maxBytes) {
  if (!response?.body || typeof response.body.getReader !== 'function') {
    const text = typeof response?.text === 'function' ? await response.text() : '';
    return String(text).slice(0, maxBytes);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const buf = Buffer.from(value);
    chunks.push(buf);
    size += buf.length;
    if (size >= maxBytes) break;
  }
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
}

function contentTypeOf(response) {
  return String(response.headers?.get?.('content-type') ?? '');
}

function isMediaType(contentType) {
  return /^video\/|^audio\//i.test(contentType);
}

async function fetchFollowing(startUrl, { fetchImpl, lookup, signal, maxBytes, treatExtensionAsMedia, referer = '' }) {
  let current = await vetUrl(startUrl, lookup);
  for (let hop = 0; hop <= REDIRECT_CAP; hop += 1) {
    const response = await fetchImpl(current, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,text/vtt,application/x-subrip,application/json,*/*;q=0.1',
        'user-agent': 'livedub-page-parse/0.7',
        ...(referer ? { referer } : {}),
      },
    });
    const status = Number(response.status) || 0;
    if (status >= 300 && status < 400) {
      const location = response.headers?.get?.('location');
      try {
        await response.body?.cancel?.();
      } catch {
        /* ignore */
      }
      if (!location) throw new PageParseError('page_fetch_failed', '重定向缺少地址', 502);
      if (hop === REDIRECT_CAP) throw new PageParseError('page_fetch_failed', '重定向次数过多', 502);
      current = await vetUrl(new URL(location, current).href, lookup);
      continue;
    }
    if (status < 200 || status >= 300) {
      try {
        await response.body?.cancel?.();
      } catch {
        /* ignore */
      }
      throw new PageParseError('page_fetch_failed', `抓取失败（HTTP ${status}）`, 502);
    }
    const contentType = contentTypeOf(response);
    const asMedia = isMediaType(contentType) || (treatExtensionAsMedia && !/^text\/html|^application\/xhtml/i.test(contentType));
    if (asMedia) {
      try {
        await response.body?.cancel?.();
      } catch {
        /* ignore */
      }
      const mime = contentType.split(';', 1)[0].trim().toLowerCase();
      return { finalUrl: current, contentType, body: '', media: true, mime: mime.startsWith('video/') || mime.startsWith('audio/') ? mime : '' };
    }
    const body = await readText(response, maxBytes);
    return { finalUrl: current, contentType, body, media: false, mime: '' };
  }
  throw new PageParseError('page_fetch_failed', '重定向次数过多', 502);
}

function joinWarning(left, right) {
  const parts = [String(left ?? '').trim(), String(right ?? '').trim()].filter(Boolean);
  return parts.join('');
}

function defaultLookup(hostname, options) {
  return dnsLookup(hostname, { all: true, verbatim: true, ...options });
}

/**
 * @param {string} inputUrl
 * @param {{ fetch?: typeof fetch, lookup?: Function, signal?: AbortSignal }} [options]
 */
export async function collectPage(inputUrl, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const lookup = options.lookup ?? defaultLookup;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  timer.unref?.();
  const signal = options.signal ?? controller.signal;
  const onAbort = () => controller.abort();
  if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const initial = await vetUrl(String(inputUrl ?? '').trim(), lookup);
    const kind = classifyTarget(initial);
    const fetched = await fetchFollowing(initial, {
      fetchImpl,
      lookup,
      signal,
      maxBytes: kind === 'subtitles' ? SUBTITLE_CAP : HTML_CAP,
      treatExtensionAsMedia: kind === 'media',
    });
    if (fetched.media) {
      return {
        ok: true,
        kind: 'media',
        url: String(inputUrl),
        finalUrl: fetched.finalUrl,
        site: siteOf(fetched.finalUrl),
        title: '',
        videos: [{ url: fetched.finalUrl, ...(fetched.mime ? { mime: fetched.mime } : {}) }],
        subtitles: [],
        cueCount: 0,
      };
    }
    const subtitleDoc = kind === 'subtitles' || /text\/vtt|application\/x-subrip/i.test(fetched.contentType) || SUBTITLE_EXT.has(extensionOf(new URL(fetched.finalUrl).pathname));
    if (subtitleDoc) {
      const parsed = parseSubtitleDocumentFull(fetched.body);
      const warning = parsed.truncated ? '字幕只保留前 200 条。' : '';
      return {
        ok: true,
        kind: 'subtitles',
        url: String(inputUrl),
        finalUrl: fetched.finalUrl,
        site: siteOf(fetched.finalUrl),
        title: '',
        videos: [],
        subtitles: [{ lang: '', label: '', url: fetched.finalUrl, cues: parsed.cues }],
        cueCount: parsed.cues.length,
        ...(warning ? { warning } : {}),
      };
    }
    const page = parseHtmlPage(fetched.body, fetched.finalUrl);
    const subtitles = [];
    let truncated = false;
    for (const track of pickTracks(page.tracks)) {
      try {
        const sub = await fetchFollowing(track.url, {
          fetchImpl,
          lookup,
          signal,
          maxBytes: SUBTITLE_CAP,
          treatExtensionAsMedia: false,
          referer: fetched.finalUrl,
        });
        if (sub.media) continue;
        const parsed = parseSubtitleDocumentFull(sub.body);
        if (parsed.truncated) truncated = true;
        subtitles.push({ lang: track.lang, label: track.label, url: sub.finalUrl, cues: parsed.cues });
      } catch {
        /* 一条字幕失败不影响整页 */
      }
    }
    const cueCount = subtitles.reduce((sum, track) => sum + track.cues.length, 0);
    let warning = '';
    if (page.sawUntimed && cueCount === 0) warning = joinWarning(warning, '页面有一段没有时间轴的文稿，不能当作字幕，也不能用来对齐画面。');
    if ((page.site === 'youtube' || page.site === 'bilibili') && page.videos.length === 0) {
      warning = joinWarning(
        warning,
        cueCount > 0
          ? '视频文件不在页面里。配音仍要用扩展抓这个标签页的声音；这里的字幕可以交给「已有字幕」。'
          : '视频文件不在页面里，也没有读到带时间轴的字幕。配音仍要用扩展抓这个标签页的声音。',
      );
    }
    if (truncated) warning = joinWarning(warning, '字幕只保留前 200 条。');
    if (cueCount === 0 && page.videos.length === 0 && !warning) warning = '没有找到可播放的视频或带时间轴的字幕。';
    return {
      ok: true,
      kind: 'page',
      url: String(inputUrl),
      finalUrl: fetched.finalUrl,
      site: page.site,
      title: page.title,
      videos: page.videos,
      subtitles,
      cueCount,
      ...(warning ? { warning } : {}),
    };
  } catch (err) {
    if (err instanceof PageParseError) throw err;
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new PageParseError('page_timeout', '抓取页面超时', 504);
    }
    const name = err?.name ?? '';
    if (name === 'TimeoutError' || name === 'AbortError') throw new PageParseError('page_timeout', '抓取页面超时', 504);
    throw new PageParseError('page_fetch_failed', `抓取失败：${String(err?.message ?? err).slice(0, 300)}`, 502);
  } finally {
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', onAbort);
  }
}
