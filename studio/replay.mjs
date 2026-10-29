/**
 * livedub 离线回放页。
 *
 * URL 参数：
 *   session=<jsonl 地址>   必填，引擎录制的会话事件 JSONL（第一行可为 meta）
 *   video=<视频地址>        可选；缺省时用渐变背景做纯字幕回放
 *   t=<毫秒>               起始时间（冻结在该时刻，便于截图/定位）
 *   autoplay=1             自动播放
 *
 * 时间轴：字幕按 t0Ms/t1Ms 渲染；配音按 dub.startMs 对齐播放（来不及就立即播）；
 * 事件顺序与 WS 下发一致，因此同一套解析逻辑也可以给 studio 的演示模式用。
 */
import {
  buildSrt,
  decodePcmBase64,
  downloadTextFile,
  formatClock,
  formatMs,
  parseSessionJsonl,
  stateAt,
} from './session-parse.mjs';

const $ = (id) => document.getElementById(id);

const els = {
  sessionTitle: $('sessionTitle'),
  sessionSubtitle: $('sessionSubtitle'),
  replayBadge: $('replayBadge'),
  replayBadgeText: $('replayBadgeText'),
  replayModeTag: $('replayModeTag'),
  replayStage: $('replayStage'),
  video: $('video'),
  mediaChip: $('mediaChip'),
  mediaLabel: $('mediaLabel'),
  clock: $('clock'),
  subs: $('subs'),
  subsSrc: $('subsSrc'),
  subsDst: $('subsDst'),
  loading: $('loading'),
  empty: $('empty'),
  btnPlay: $('btnPlay'),
  btnRestart: $('btnRestart'),
  timeCurrent: $('timeCurrent'),
  timeDuration: $('timeDuration'),
  seek: $('seek'),
  toggleDub: $('toggleDub'),
  eventStat: $('eventStat'),
  transcriptList: $('transcriptList'),
  transcriptCount: $('transcriptCount'),
  btnExport: $('btnExport'),
  btnCopySrt: $('btnCopySrt'),
  metaTitle: $('metaTitle'),
  metaSource: $('metaSource'),
  metaSessionId: $('metaSessionId'),
  metaLangs: $('metaLangs'),
  metaEvents: $('metaEvents'),
  metaDubs: $('metaDubs'),
  metaDuration: $('metaDuration'),
  pvAsr: $('pvAsr'),
  pvMt: $('pvMt'),
  pvTts: $('pvTts'),
  latAsr: $('latAsr'),
  latMt: $('latMt'),
  latTts: $('latTts'),
  latE2e: $('latE2e'),
  barAsr: $('barAsr'),
  barMt: $('barMt'),
  barTts: $('barTts'),
  barE2e: $('barE2e'),
  eventLog: $('eventLog'),
  eventCount: $('eventCount'),
  toasts: $('toasts'),
};

const langLabels = { en: '英语', zh: '中文', ja: '日语', ko: '韩语', fr: '法语', de: '德语', es: '西班牙语' };
const HUD_FIELDS = [
  { key: 'asrFinalMs', lat: 'latAsr', bar: 'barAsr', warn: 600, bad: 1600 },
  { key: 'mtFirstMs', lat: 'latMt', bar: 'barMt', warn: 700, bad: 2000 },
  { key: 'ttsFirstMs', lat: 'latTts', bar: 'barTts', warn: 1200, bad: 3000 },
  { key: 'e2eLagMs', lat: 'latE2e', bar: 'barE2e', warn: 1600, bad: 4000 },
];

const state = {
  params: new URLSearchParams(location.search),
  parsed: null,
  maxMs: 0,
  clock: 0,
  playing: false,
  useVideo: false,
  raf: null,
  playBase: 0,
  playWall: 0,
  audioCtx: null,
  dubGain: null,
  activeSources: new Set(),
  playedDubs: new Set(),
  renderedSegmentCount: -1,
  renderedSignature: '',
  renderedActiveId: null,
  lastSubsSrc: '',
  lastSubsDst: '',
};

function toast(message, tone = 'info', timeout = 4200) {
  const node = document.createElement('div');
  node.className = `toast ${tone}`;
  node.textContent = String(message);
  els.toasts.appendChild(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 240);
  }, timeout);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function shorten(text, max = 40) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function setBadge(tone, label) {
  els.replayBadge.dataset.tone = tone;
  els.replayBadgeText.textContent = label;
}

function providerName(value) {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return String(value.provider ?? value.name ?? value.model ?? '—');
  return String(value);
}

function logLine(type, message, tone = 'mt') {
  const empty = els.eventLog.querySelector('.log-empty');
  if (empty) empty.remove();
  const line = document.createElement('div');
  line.className = 'log-line';
  const stamp = formatClock(Number(message?.atMs ?? state.clock));
  line.innerHTML = `<span class="lg-time">${stamp}</span><span class="lg-type ${tone}">${escapeHtml(String(type))}</span><span class="lg-msg">${escapeHtml(String(message?.text ?? ''))}</span>`;
  els.eventLog.appendChild(line);
  while (els.eventLog.children.length > 80) els.eventLog.firstElementChild.remove();
  els.eventLog.scrollTop = els.eventLog.scrollHeight;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

// ------------------------------------------------------------------ 媒体加载

function setupVideo(videoUrl) {
  if (!videoUrl) return;
  els.video.addEventListener('loadedmetadata', () => {
    els.replayStage.classList.remove('no-video');
    els.mediaLabel.textContent = shorten(videoUrl.split('/').pop() ?? 'video', 36);
    if (state.params.get('t')) setVideoTime(Number(state.params.get('t')) || 0);
    updateDurationUi();
    setBadge('ok', '回放就绪');
  });
  els.video.addEventListener('error', () => {
    els.replayStage.classList.add('no-video');
    els.mediaLabel.textContent = '视频加载失败，已回退纯字幕回放';
    toast('视频加载失败，回退为纯字幕回放', 'warn', 5000);
  });
  els.video.src = videoUrl;
  els.video.load();
}

function setVideoTime(ms) {
  if (!state.useVideo) return;
  try {
    if (Number.isFinite(els.video.duration) && els.video.duration > 0) {
      els.video.currentTime = clamp(ms / 1000, 0, els.video.duration);
    }
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------ 状态渲染

function applyAt(tMs) {
  if (!state.parsed) return;
  const total = state.maxMs;
  const t = clamp(Math.round(Number(tMs) || 0), 0, total);
  state.clock = t;
  const snapshot = stateAt(state.parsed, t);

  // 字幕
  const current = snapshot.current;
  const src = current ? String(current.src ?? '') : '';
  const dst = current ? String(current.dst ?? '') : '';
  if (src || dst) {
    els.subs.hidden = false;
    if (src !== state.lastSubsSrc) {
      els.subsSrc.textContent = src;
      state.lastSubsSrc = src;
    }
    if (dst !== state.lastSubsDst) {
      els.subsDst.textContent = dst || (current.translating ? '…' : '');
      els.subsDst.classList.toggle('pending', !dst && Boolean(current.translating));
      state.lastSubsDst = dst;
    }
  } else {
    els.subs.hidden = true;
    state.lastSubsSrc = '';
    state.lastSubsDst = '';
  }

  // 字幕时间轴（按 t0Ms 增量重建）
  renderTranscripts(snapshot.segmentsSoFar, current && !current.partial ? current.id : null);

  // HUD
  renderMetrics(snapshot.metrics);

  // 时间/进度
  els.timeCurrent.textContent = formatClock(t);
  els.clock.textContent = `${formatClock(t)} / ${formatClock(total)}`;
  if (total > 0) {
    const progress = clamp((t / total) * 100, 0, 100);
    els.seek.value = String(Math.round(progress * 10));
    els.seek.style.setProperty('--seek-progress', `${progress}%`);
  }

  // 事件流（最近 8 条）
  renderEventStream(t);

  // 状态徽标
  const playbackState = snapshot.status?.state;
  if (playbackState === 'speaking') setBadge('accent', '配音中');
  else if (playbackState === 'translating') setBadge('busy', '翻译中');
  else if (playbackState === 'listening') setBadge('ok', '聆听中');
  else if (playbackState === 'error') setBadge('err', '错误');
}

function renderTranscripts(segments, activeId) {
  const count = segments.length;
  const signature = segments.map((segment) => `${segment.id}:${segment.translation.length}`).join('|');
  if (count !== state.renderedSegmentCount || signature !== state.renderedSignature) {
    state.renderedSegmentCount = count;
    state.renderedSignature = signature;
    els.transcriptList.innerHTML = '';
    if (count === 0) {
      els.transcriptList.innerHTML = '<div class="list-empty">当前时间点还没有识别出的字幕。</div>';
    } else {
      for (const segment of segments) {
        const node = document.createElement('article');
        node.className = 'transcript-item';
        node.dataset.id = segment.id;
        node.innerHTML = `<span class="t-time">${formatClock(segment.t0Ms)}</span><div class="t-body"><div class="t-src"></div><div class="t-dst"></div></div>`;
        node.querySelector('.t-src').textContent = segment.text || '…';
        const dstNode = node.querySelector('.t-dst');
        if (segment.translation) dstNode.textContent = segment.translation;
        else {
          dstNode.textContent = '（无译文）';
          dstNode.classList.add('pending');
        }
        node.addEventListener('click', () => seekTo(segment.t0Ms));
        els.transcriptList.appendChild(node);
      }
      els.transcriptList.scrollTop = els.transcriptList.scrollHeight;
    }
    els.transcriptCount.textContent = `${count} 句`;
    els.btnExport.disabled = count === 0;
  }
  if (state.renderedActiveId !== activeId) {
    state.renderedActiveId = activeId;
    for (const node of els.transcriptList.children) {
      node.classList?.toggle('active', activeId != null && node.dataset?.id === activeId);
    }
  }
}

function renderMetrics(metrics) {
  for (const field of HUD_FIELDS) {
    const value = metrics?.[field.key];
    const text = formatMs(value);
    const latNode = els[field.lat];
    latNode.textContent = text;
    const bar = els[field.bar];
    if (Number.isFinite(Number(value))) {
      const tone = Number(value) >= field.bad ? 'bad' : Number(value) >= field.warn ? 'mid' : '';
      latNode.className = `mono ${tone === 'bad' ? 'bad' : tone === 'mid' ? 'mid' : 'good'}`.trim();
      bar.style.width = `${clamp((Number(value) / (field.bad * 1.2)) * 100, 3, 100).toFixed(1)}%`;
      bar.className = tone;
    } else {
      latNode.textContent = '—';
      bar.style.width = '0%';
      bar.className = '';
    }
  }
}

function renderEventStream(tMs) {
  const events = state.parsed?.eventsWithTimeline ?? [];
  const visible = events.filter((event) => event.atMs <= tMs).slice(-8);
  els.eventCount.textContent = `${events.filter((event) => event.atMs <= tMs).length} / ${events.length}`;
  els.eventLog.innerHTML = '';
  if (visible.length === 0) {
    els.eventLog.innerHTML = '<div class="log-empty">还没有事件。</div>';
    return;
  }
  for (const event of visible) {
    let text = '';
    let tone = 'mt';
    switch (event.type) {
      case 'ready':
        text = `就绪 ${event.sessionId ?? ''}`;
        tone = 'ok';
        break;
      case 'status':
        text = `状态 ${event.state ?? ''}`;
        break;
      case 'partial':
        text = shorten(event.text ?? '', 26);
        break;
      case 'segment':
        text = shorten(event.text ?? '', 34);
        tone = 'ok';
        break;
      case 'translation':
        text = shorten(event.text ?? '', 30);
        break;
      case 'dub':
        text = `配音块 start=${event.startMs}ms ${event.durationMs ?? 0}ms`;
        tone = 'warn';
        break;
      case 'metrics':
        text = `E2E ${formatMs(event.e2eLagMs)} · MT ${formatMs(event.mtFirstMs)}`;
        break;
      case 'voice':
        text = `音色 ${event.mode ?? ''} / ${event.voiceId ?? ''}`;
        break;
      case 'error':
        text = shorten(event.message ?? '', 34);
        tone = 'err';
        break;
      default:
        text = event.type;
    }
    logLine(event.type, { atMs: event.atMs, text }, tone);
  }
}

function updateDurationUi() {
  els.timeDuration.textContent = formatClock(state.maxMs);
  els.metaDuration.textContent = formatClock(state.maxMs);
  els.clock.textContent = `${formatClock(state.clock)} / ${formatClock(state.maxMs)}`;
}

// ---------------------------------------------------------------- 配音播放

function getAudioContext() {
  if (state.audioCtx) return state.audioCtx;
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) return null;
  state.audioCtx = new Context({ latencyHint: 'interactive' });
  state.dubGain = state.audioCtx.createGain();
  state.dubGain.gain.value = 1;
  state.dubGain.connect(state.audioCtx.destination);
  return state.audioCtx;
}

function playDubsUpTo(tMs) {
  if (!els.toggleDub.checked || !state.parsed) return;
  for (const dub of state.parsed.dubs) {
    const key = `${dub.id}:${dub.seq}`;
    if (state.playedDubs.has(key)) continue;
    if (dub.startMs > tMs) continue;
    state.playedDubs.add(key);
    if (tMs - dub.startMs > 2500) continue; // 落后太多就跳过
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    let pcm;
    try {
      pcm = decodePcmBase64(dub.pcm);
    } catch {
      continue;
    }
    if (!pcm.length) continue;
    const buffer = ctx.createBuffer(1, pcm.length, dub.sampleRate || 24000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 32768;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(state.dubGain);
    const delay = Math.max(0, (dub.startMs - tMs) / 1000);
    try {
      source.start(ctx.currentTime + Math.min(delay, 30) + 0.02);
    } catch {
      continue;
    }
    state.activeSources.add(source);
    source.onended = () => state.activeSources.delete(source);
  }
}

// ------------------------------------------------------------------ 回放控制

function startPlayback() {
  if (!state.parsed) return;
  if (state.playing) return;
  state.playing = true;
  updatePlayButton();
  setBadge('accent', '回放中');
  if (state.clock >= state.maxMs) applyAt(0);
  state.playBase = state.clock;
  state.playWall = performance.now();
  const tick = () => {
    if (!state.playing) return;
    let t;
    if (state.useVideo && state.videoReady()) {
      t = els.video.currentTime * 1000;
    } else {
      t = state.playBase + (performance.now() - state.playWall);
    }
    if (t >= state.maxMs) {
      applyAt(state.maxMs);
      stopPlayback({ ended: true });
      return;
    }
    applyAt(t);
    playDubsUpTo(t);
    state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
}

function stopPlayback({ ended = false } = {}) {
  state.playing = false;
  if (state.raf) cancelAnimationFrame(state.raf);
  state.raf = null;
  updatePlayButton();
  if (ended) {
    setBadge('idle', '回放结束');
  }
}

function togglePlayback() {
  if (state.playing) {
    stopPlayback();
    return;
  }
  if (state.useVideo && els.video.src) {
    els.video
      .play()
      .then(() => {
        if (!state.playing) {
          state.playing = true;
          updatePlayButton();
          setBadge('accent', '回放中');
          const tick = () => {
            if (!state.playing) return;
            const t = els.video.currentTime * 1000;
            if (t >= state.maxMs) {
              applyAt(state.maxMs);
              stopPlayback({ ended: true });
              return;
            }
            applyAt(t);
            playDubsUpTo(t);
            state.raf = requestAnimationFrame(tick);
          };
          state.raf = requestAnimationFrame(tick);
        }
      })
      .catch(() => startPlayback());
    return;
  }
  startPlayback();
}

function updatePlayButton() {
  const use = els.btnPlay.querySelector('use');
  use.setAttribute('href', state.playing ? '#i-pause' : '#i-play');
}

function seekTo(ms) {
  const target = clamp(Number(ms) || 0, 0, state.maxMs);
  if (state.playing) {
    state.playBase = target;
    state.playWall = performance.now();
    setVideoTime(target);
  }
  state.playedDubs.clear();
  applyAt(target);
  if (!state.playing) playDubsUpTo(target);
}

// ---------------------------------------------------------------- UI 绑定

function bindUi() {
  els.btnPlay.addEventListener('click', togglePlayback);
  els.btnRestart.addEventListener('click', () => {
    stopPlayback();
    seekTo(0);
    if (state.useVideo) setVideoTime(0);
  });
  els.seek.addEventListener('input', () => {
    if (state.maxMs <= 0) return;
    const target = (Number(els.seek.value) / 1000) * state.maxMs;
    els.timeCurrent.textContent = formatClock(target);
    els.clock.textContent = `${formatClock(target)} / ${formatClock(state.maxMs)}`;
    els.seek.style.setProperty('--seek-progress', `${Number(els.seek.value) / 10}%`);
  });
  els.seek.addEventListener('change', () => {
    if (state.maxMs <= 0) return;
    stopPlayback();
    seekTo((Number(els.seek.value) / 1000) * state.maxMs);
  });
  els.toggleDub.addEventListener('change', () => {
    if (!els.toggleDub.checked) {
      for (const source of state.activeSources) {
        try {
          source.stop();
        } catch {
          /* ignore */
        }
      }
      state.activeSources.clear();
    } else {
      getAudioContext()?.resume?.().catch?.(() => {});
    }
  });
  els.btnExport.addEventListener('click', exportSrt);
  els.btnCopySrt.addEventListener('click', copySrt);
}

function srtText() {
  return buildSrt(state.parsed?.segments?.values() ?? []);
}

function exportSrt() {
  const srt = srtText();
  if (!srt) {
    toast('没有可导出的字幕', 'warn');
    return;
  }
  const base = String(state.parsed?.meta?.title ?? 'livedub-replay').replace(/[\\/:*?"<>|]/g, '_');
  downloadTextFile(`${base}.srt`, srt, 'application/x-subrip;charset=utf-8');
  toast('SRT 已导出', 'ok');
}

async function copySrt() {
  const srt = srtText();
  if (!srt) {
    toast('没有可复制的字幕', 'warn');
    return;
  }
  try {
    await navigator.clipboard.writeText(srt);
    toast('SRT 已复制到剪贴板', 'ok');
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = srt;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand?.('copy');
    textarea.remove();
    toast('SRT 已复制', 'ok');
  }
}

// ------------------------------------------------------------------ 元信息

function applyMeta(parsed) {
  const meta = parsed.meta ?? {};
  const ready = parsed.ready ?? {};
  const title = String(meta.title ?? ready.title ?? meta.sessionId ?? parsed.ready?.sessionId ?? '未命名会话');
  els.sessionTitle.textContent = shorten(title, 48);
  els.metaTitle.textContent = shorten(title, 22);
  els.sessionSubtitle.textContent = `离线回放 · ${meta.source ?? 'studio'} · ${parsed.events.length} 个事件`;
  els.metaSource.textContent = String(meta.source ?? '—');
  els.metaSessionId.textContent = shorten(String(ready.sessionId ?? meta.sessionId ?? '—'), 16);
  const langFrom = meta.langFrom ?? ready.limits?.langFrom ?? 'en';
  const langTo = meta.langTo ?? ready.limits?.langTo ?? 'zh';
  els.metaLangs.textContent = `${langLabels[langFrom] ?? langFrom} → ${langLabels[langTo] ?? langTo}`;
  els.metaEvents.textContent = String(parsed.events.length);
  els.metaDubs.textContent = String(parsed.dubs.length);

  const providers = ready.providers;
  els.pvAsr.textContent = shorten(providerName(providers?.asr), 18);
  els.pvMt.textContent = shorten(providerName(providers?.translate), 18);
  const tts = providers?.tts;
  els.pvTts.textContent = shorten(tts && typeof tts === 'object' && tts.model ? `${providerName(tts)} · ${tts.model}` : providerName(tts), 18);
  els.pvAsr.title = String(providerName(providers?.asr));
  els.pvMt.title = String(providerName(providers?.translate));
  els.pvTts.title = String(tts && typeof tts === 'object' && tts.model ? `${providerName(tts)} · ${tts.model}` : providerName(tts));

  els.replayModeTag.textContent = meta.demo === true ? '演示' : '离线';
  els.eventStat.textContent = `${parsed.events.length} 事件 · ${parsed.segments.size} 句字幕 · ${parsed.dubs.length} 段配音`;
}

// -------------------------------------------------------------------- 启动

async function bootstrap() {
  bindUi();
  updatePlayButton();
  const sessionUrl = state.params.get('session');
  const videoUrl = state.params.get('video');
  if (!sessionUrl) {
    els.loading.hidden = true;
    els.empty.hidden = false;
    els.sessionTitle.textContent = '缺少 session 参数';
    els.sessionSubtitle.textContent = '用法：/replay/?session=/demo/session.jsonl&video=/demo/original.mp4';
    setBadge('warn', '缺少参数');
    return;
  }
  state.useVideo = Boolean(videoUrl);
  if (videoUrl) setupVideo(videoUrl);
  state.videoReady = () => Boolean(els.video.src) && Number.isFinite(els.video.duration) && els.video.duration > 0;

  try {
    const response = await fetch(sessionUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}（${sessionUrl}）`);
    const text = await response.text();
    const parsed = parseSessionJsonl(text);
    state.parsed = parsed;
    if (parsed.events.length === 0) {
      els.loading.hidden = true;
      els.empty.hidden = false;
      setBadge('warn', '没有事件');
      return;
    }
    let end = Number(parsed.meta?.durationMs) || 0;
    for (const segment of parsed.segments.values()) end = Math.max(end, segment.t1Ms);
    for (const dub of parsed.dubs) end = Math.max(end, dub.startMs + (dub.durationMs || 0));
    state.maxMs = Math.max(1000, end);
    applyMeta(parsed);
    updateDurationUi();
    els.loading.hidden = true;
    const initial = Number(state.params.get('t'));
    stopPlayback();
    applyAt(Number.isFinite(initial) ? initial : 0);
    setBadge('ok', '回放就绪');
    if (state.params.get('autoplay') === '1') togglePlayback();
  } catch (err) {
    els.loading.hidden = true;
    els.empty.hidden = false;
    els.sessionTitle.textContent = '加载会话失败';
    els.sessionSubtitle.textContent = err.message;
    setBadge('err', '加载失败');
    toast(`加载会话失败：${err.message}`, 'err', 7000);
  }
}

bootstrap().catch((err) => {
  console.error(err);
  toast(`回放初始化失败：${err.message}`, 'err', 8000);
});
