#!/usr/bin/env node
/**
 * 离线批处理：把任意视频跑一遍真实同传管线，产出
 *   - demo/session.jsonl      引擎事件回放流（studio/replay.html 用）
 *   - demo/bilingual.srt      双语字幕
 *   - demo/dubbed.mp4         原声压低 + 中文配音 + 烧录双语字幕
 *   - demo/metrics.json       每句延迟指标
 *
 * 管线与实时模式完全一致（engine/pipeline.mjs createSession），只是把音频按 1x/2x 速度喂进去。
 *
 * 用法:
 *   node scripts/batch.mjs [--video demo/original.mp4] [--out demo] [--speed 1] [--mock]
 *                          [--no-burn] [--no-dub] [--lang-from en] [--lang-to zh]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig, deepMerge } from '../engine/config.mjs';
import { pcmFromWav, wavFromPcm, resamplePcm, pcmDurationMs, msToSamples } from '../engine/audio.mjs';
import { createSession } from '../engine/pipeline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = {
  video: arg('--video', path.join(ROOT, 'demo', 'original.mp4')),
  out: path.resolve(arg('--out', path.join(ROOT, 'demo'))),
  speed: Number(arg('--speed', '1')) || 1,
  mock: argv.includes('--mock'),
  burn: !argv.includes('--no-burn'),
  dub: !argv.includes('--no-dub'),
  langFrom: arg('--lang-from', 'en'),
  langTo: arg('--lang-to', 'zh'),
  ttsSpeed: Number(arg('--tts-speed', '1.15')) || 1.15,
};

function arg(name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}

function log(...a) {
  console.log(...a);
}

function run(cmd, args, { timeoutMs = 300000, quiet = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timeout`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}\n${stderr.slice(-3000)}`));
    });
  });
}

async function probeDurationMs(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Math.round(Number(stdout.trim()) * 1000);
}

function detectPython() {
  const candidates = [process.env.LIVEDUB_PYTHON, 'python3'].filter(Boolean);
  const runtimeRoot = path.join(process.env.HOME ?? '/tmp', '.dsh', 'dsh-runtimes');
  try {
    for (const dir of fs.readdirSync(runtimeRoot)) {
      const p = path.join(runtimeRoot, dir, 'dependencies', 'python', 'bin', 'python3');
      candidates.push(p);
    }
  } catch {
    /* ignore */
  }
  return candidates;
}

async function findPillowPython() {
  for (const py of detectPython()) {
    try {
      await run(py, ['-c', 'import PIL'], { timeoutMs: 20000 });
      return py;
    } catch {
      /* next */
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ SRT

function srtTime(ms) {
  const clamped = Math.max(0, Math.round(ms));
  const hh = String(Math.floor(clamped / 3600000)).padStart(2, '0');
  const mm = String(Math.floor((clamped % 3600000) / 60000)).padStart(2, '0');
  const ss = String(Math.floor((clamped % 60000) / 1000)).padStart(2, '0');
  const mmm = String(clamped % 1000).padStart(3, '0');
  return `${hh}:${mm}:${ss},${mmm}`;
}

function wrapText(text, maxChars) {
  const src = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!src) return [];
  const hasCjk = /[\u4e00-\u9fff]/.test(src);
  const lines = [];
  let cur = '';
  const units = hasCjk ? Array.from(src) : src.split(' ');
  for (const unit of units) {
    const candidate = hasCjk ? cur + unit : cur ? `${cur} ${unit}` : unit;
    const limit = hasCjk ? maxChars : Math.round(maxChars * 1.7);
    if (cur && Array.from(candidate).length > limit) {
      lines.push(cur);
      cur = hasCjk ? unit : unit;
    } else {
      cur = candidate;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function buildSrt(cues, { width = 42 } = {}) {
  const blocks = [];
  cues.forEach((cue, idx) => {
    const origLines = wrapText(cue.orig, width);
    const zhLines = wrapText(cue.dst, Math.round(width * 0.62));
    const text = [...origLines, ...zhLines].join('\n');
    blocks.push(`${idx + 1}\n${srtTime(cue.t0Ms)} --> ${srtTime(cue.t1Ms)}\n${text}\n`);
  });
  return blocks.join('\n');
}

// ------------------------------------------------------------------ audio mixing

function decodePcmBase64(b64) {
  return Buffer.from(String(b64 ?? ''), 'base64');
}

/** 构造 48k stereo 输出：原声按配音区间自动压低（ducking）+ 混入中文配音 */
function mixDubTrack({ original48Stereo, dubChunks, duckLevel, totalMs }) {
  const rate = 48000;
  const frames = Math.max(msToSamples(totalMs, rate), Math.floor(original48Stereo.length / 4));
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const idx = i * 4;
    if (idx + 3 < original48Stereo.length) {
      L[i] = original48Stereo.readInt16LE(idx) / 32768;
      R[i] = original48Stereo.readInt16LE(idx + 2) / 32768;
    }
  }

  // 配音轨 + 区间
  const dub = new Float32Array(frames);
  const intervals = [];
  const bySegment = new Map();
  for (const chunk of dubChunks) {
    if (!chunk.pcm || chunk.pcm.length === 0) continue;
    if (!bySegment.has(chunk.id)) bySegment.set(chunk.id, []);
    bySegment.get(chunk.id).push(chunk);
  }
  for (const chunks of bySegment.values()) {
    chunks.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const sampleRate = Number(chunks[0].sampleRate) || 24000;
    let pcm = Buffer.concat(chunks.map((c) => c.pcmData));
    if (sampleRate !== rate) pcm = resamplePcm(pcm, sampleRate, rate);
    const startFrame = Math.max(0, Math.round(((chunks[0].startMs ?? 0) / 1000) * rate));
    const dur = Math.floor(pcm.length / 2);
    for (let i = 0; i < dur && startFrame + i < frames; i++) {
      dub[startFrame + i] += pcm.readInt16LE(i * 2) / 32768;
    }
    intervals.push({ start: startFrame, end: Math.min(frames, startFrame + dur) });
  }

  // ducking 包络：区间内原声 0.18，150ms 平滑
  const gain = new Float32Array(frames).fill(1);
  const ramp = Math.round(rate * 0.15);
  for (const { start, end } of intervals) {
    for (let i = Math.max(0, start - ramp); i < Math.min(frames, end + ramp); i++) {
      let g = duckLevel;
      if (i < start) g = 1 + (duckLevel - 1) * ((i - (start - ramp)) / ramp);
      else if (i >= end) g = duckLevel + (1 - duckLevel) * ((i - end) / ramp);
      gain[i] = Math.min(gain[i], g);
    }
  }

  const out = Buffer.allocUnsafe(frames * 4);
  for (let i = 0; i < frames; i++) {
    const g = gain[i];
    const mixL = Math.max(-1, Math.min(1, L[i] * g + dub[i] * 0.95));
    const mixR = Math.max(-1, Math.min(1, R[i] * g + dub[i] * 0.95));
    out.writeInt16LE(Math.round(mixL * 32767), i * 4);
    out.writeInt16LE(Math.round(mixR * 32767), i * 4 + 2);
  }
  return { pcm48Stereo: out, dubMs: (intervals.length ? Math.max(...intervals.map((x) => x.end)) / rate * 1000 : 0) };
}

/**
 * 把 pipeline 产出的配音块重新排到视频时间轴上（离线批处理专用）。
 *
 * 背景：pipeline 的 dub.startMs 是「TTS 就绪时刻」（直播语义），实时喂入时可能晚于视频末尾，
 * 直接用于成片/回放会导致最后几句配音越界。离线场景改为：每句配音尽量从「该句语音开始 + buffer」
 * 处起播，并按全局游标顺序排列（不重叠），最后裁剪到视频时长内。
 */
function scheduleDubs({ segments, dubChunks, videoMs, startBufferMs = 320, minGapMs = 60 }) {
  const orderedSegments = [...segments.values()].sort((a, b) => a.t0Ms - b.t0Ms);
  const byId = new Map();
  for (const chunk of dubChunks) {
    if (!chunk.pcmData || chunk.pcmData.length === 0) continue;
    if (!byId.has(chunk.id)) byId.set(chunk.id, []);
    byId.get(chunk.id).push(chunk);
  }
  const schedule = new Map(); // `${id}:${seq}` -> startMs
  const segmentEnd = new Map(); // id -> endMs
  const chunksWithStart = [];
  let cursorMs = 0;
  for (const seg of orderedSegments) {
    const chunks = byId.get(seg.id);
    if (!chunks || chunks.length === 0) continue;
    chunks.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const sampleRate = Number(chunks[0].sampleRate) || 24000;
    const totalDurMs = chunks.reduce((sum, c) => sum + pcmDurationMs(c.pcmData, Number(c.sampleRate) || sampleRate), 0);
    let target = Math.max(seg.t0Ms + startBufferMs, cursorMs + minGapMs);
    // 不越过视频结尾（留出 120ms 余量），过长则允许重叠/裁剪
    target = Math.min(target, Math.max(0, videoMs - 120));
    let offsetMs = 0;
    for (const chunk of chunks) {
      const dur = pcmDurationMs(chunk.pcmData, Number(chunk.sampleRate) || sampleRate);
      const startMs = Math.round(target + offsetMs);
      schedule.set(`${chunk.id}:${chunk.seq ?? 0}`, startMs);
      chunksWithStart.push({ ...chunk, startMs, durationMs: dur });
      offsetMs += dur;
    }
    segmentEnd.set(seg.id, Math.round(target + totalDurMs));
    cursorMs = Math.round(target + totalDurMs);
  }
  return { schedule, segmentEnd, chunks: chunksWithStart, totalEndMs: cursorMs };
}

// ------------------------------------------------------------------ main

async function main() {
  const startedAt = Date.now();
  if (!fs.existsSync(opt.video)) throw new Error(`视频不存在: ${opt.video}`);
  fs.mkdirSync(opt.out, { recursive: true });
  const tmp = path.join(opt.out, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });

  log(`\n▶ livedub batch`);
  log(`  video : ${path.relative(ROOT, opt.video)}`);
  log(`  out   : ${path.relative(ROOT, opt.out)}`);
  log(`  mode  : ${opt.mock ? 'mock providers' : 'real providers'} | ${opt.langFrom} -> ${opt.langTo} | feed=${opt.speed}x | ttsSpeed=${opt.ttsSpeed}\n`);

  const videoMs = await probeDurationMs(opt.video);

  // 1) 抽 16k mono（ASR） 与 48k stereo（混音）
  const wav16 = path.join(tmp, 'audio16k.wav');
  const wav48 = path.join(tmp, 'audio48k.wav');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', opt.video, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav16]);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', opt.video, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', wav48]);
  const { pcm: pcm16 } = pcmFromWav(fs.readFileSync(wav16));
  const { pcm: pcm48Stereo } = pcmFromWav(fs.readFileSync(wav48));

  // 2) 配置（真实 provider / mock）
  let config = loadConfig();
  if (opt.mock) {
    config = deepMerge(config, {
      asr: { provider: 'mock' },
      translate: { provider: 'mock', chain: ['mock'] },
      tts: { provider: 'mock' },
      session: { langFrom: opt.langFrom, langTo: opt.langTo },
      dub: { enabled: opt.dub, catchUp: 'none' },
    });
  } else {
    config = deepMerge(config, {
      session: { langFrom: opt.langFrom, langTo: opt.langTo },
      dub: { enabled: opt.dub, catchUp: 'none' },
      // 成片专用语速：中文配音通常比原声长 5-15%，略提速以避免最后几句被视频结尾裁掉（直播/工作台仍用 1.0）
      tts: { speed: opt.ttsSpeed },
    });
  }

  // 3) 跑管线
  const sessionJsonl = path.join(opt.out, 'session.jsonl');
  fs.writeFileSync(sessionJsonl, '');
  const events = [];
  const segments = new Map();
  const translations = new Map();
  const dubChunks = [];
  const metricsList = [];
  const writer = fs.createWriteStream(sessionJsonl, { flags: 'a' });
  const meta = {
    type: 'meta',
    sessionId: null,
    title: path.basename(opt.video, path.extname(opt.video)),
    video: `/demo/${path.basename(opt.video)}`,
    langFrom: opt.langFrom,
    langTo: opt.langTo,
    durationMs: videoMs,
    mock: opt.mock,
    generatedAt: new Date().toISOString(),
  };
  writer.write(`${JSON.stringify(meta)}\n`);

  // 用本次运行的 config（含 mock 覆盖）创建会话
  const activity = { last: Date.now() };
  const session2 = await createSession({
    options: {
      source: 'batch',
      title: meta.title,
      langFrom: opt.langFrom,
      langTo: opt.langTo,
      overrides: {
        asr: config.asr,
        translate: config.translate,
        tts: config.tts,
        dub: config.dub,
        glossary: config.glossary,
      },
    },
    emit: (event) => {
      events.push(event);
      if (event.type === 'ready') meta.sessionId = event.sessionId;
      if (event.type === 'segment') segments.set(event.id, event);
      if (event.type === 'translation' && event.final) translations.set(event.id, event);
      if (event.type === 'dub' && event.pcm) dubChunks.push({ ...event, pcmData: decodePcmBase64(event.pcm) });
      if (event.type === 'metrics') metricsList.push(event);
      activity.last = Date.now();
      writer.write(`${JSON.stringify(event)}\n`);
    },
    log: (...a) => log('  [engine]', ...a),
  });

  // 等 ASR 热起来（冷启动 20-30s）；避免把 finals 全部挤到会话关闭之后
  try {
    if (typeof session2.asr?.warmup === 'function') {
      log('  asr warmup…');
      await session2.asr.warmup();
      log('  asr warm');
    }
  } catch (err) {
    log(`  [warn] asr warmup failed: ${err.message}`);
  }

  // 4) 按速度喂音频
  const chunkMs = 100;
  const chunkBytes = (16000 * chunkMs) / 1000 * 2;
  const totalChunks = Math.ceil(pcm16.length / chunkBytes);
  const feedStartedAt = Date.now();
  let lastProgress = 0;
  for (let i = 0; i < totalChunks; i++) {
    const tMs = i * chunkMs;
    session2.onAudio(pcm16.subarray(i * chunkBytes, (i + 1) * chunkBytes), tMs);
    if (i % 5 === 0) await sleep((chunkMs * 5) / opt.speed); // 5 个 chunk = 500ms 音频
    if (session2.stats().pendingSegments > 2) {
      while (session2.stats().pendingSegments > 1) await sleep(80);
    }
    const pct = Math.floor(((i + 1) / totalChunks) * 100);
    if (pct >= lastProgress + 20) {
      lastProgress = pct;
      log(`  feed ${pct}% (segments=${session2.stats().segments}, pending=${session2.stats().pendingSegments}, ${((Date.now() - feedStartedAt) / 1000).toFixed(0)}s)`);
    }
  }
  log(`  feed done, flushing…`);
  session2.onJson({ type: 'control', action: 'flush' });
  const flushWall = Date.now();
  let warnedNoOutput = false;
  while (Date.now() - flushWall < Math.max(150000, videoMs * 2 + 90000)) {
    const st = session2.stats();
    const hasOutput = st.segments > 0 || st.partials > 0;
    if (hasOutput && st.pendingSegments === 0 && Date.now() - activity.last > 5000) break;
    if (!hasOutput && !warnedNoOutput && Date.now() - flushWall > 90000) {
      warnedNoOutput = true;
      log('  [warn] ASR 90s 内没有任何输出，可能是 whisper-server 启动失败（继续收尾）');
    }
    if (!hasOutput && Date.now() - flushWall > 120000) break;
    await sleep(250);
  }
  const finalStats = session2.stats();
  log(`  drain done (segments=${finalStats.segments}, partials=${finalStats.partials})`);
  await sleep(500);
  await session2.close('batch done');
  writer.end();
  await new Promise((r) => writer.on('close', r));

  // 4.5) 离线重排配音时间轴（按句对齐 + 不越界），并回写 session.jsonl 供回放使用
  const scheduled = dubChunks.length
    ? scheduleDubs({ segments, dubChunks, videoMs })
    : { schedule: new Map(), segmentEnd: new Map(), chunks: [], totalEndMs: 0 };
  if (dubChunks.length > 0) {
    try {
      const lines = fs.readFileSync(sessionJsonl, 'utf8').split('\n').filter(Boolean);
      const rewritten = lines.map((line) => {
        try {
          const event = JSON.parse(line);
          if (event.type === 'dub') {
            const key = `${event.id}:${event.seq}`;
            if (scheduled.schedule.has(key)) event.startMs = scheduled.schedule.get(key);
            else if (event.final && scheduled.segmentEnd.has(event.id)) event.startMs = scheduled.segmentEnd.get(event.id);
          }
          return JSON.stringify(event);
        } catch {
          return line;
        }
      });
      fs.writeFileSync(sessionJsonl, rewritten.join('\n') + '\n');
    } catch (err) {
      log(`  [warn] session.jsonl startMs 回写失败: ${err.message}`);
    }
    log(`  dub schedule: ${dubChunks.length} chunks, last dub ends at ${(scheduled.totalEndMs / 1000).toFixed(1)}s (video ${(videoMs / 1000).toFixed(1)}s)`);
    if (scheduled.totalEndMs > videoMs + 200) log(`  [warn] 结尾配音超出视频 ${((scheduled.totalEndMs - videoMs) / 1000).toFixed(1)}s，混音时会裁剪（可缩短译文/提高 TTS 语速）`);
  }

  // 5) SRT + metrics
  const cues = [...segments.values()]
    .sort((a, b) => a.t0Ms - b.t0Ms)
    .map((seg) => ({
      t0Ms: seg.t0Ms,
      t1Ms: seg.t1Ms,
      orig: seg.text,
      dst: translations.get(seg.id)?.text ?? '',
    }));
  const srt = buildSrt(cues);
  const srtPath = path.join(opt.out, 'bilingual.srt');
  fs.writeFileSync(srtPath, srt);

  const finite = (v) => Number.isFinite(v);
  const med = (arr) => {
    const a = arr.filter(finite).sort((x, y) => x - y);
    if (!a.length) return null;
    return Math.round(a[Math.floor(a.length / 2)]);
  };
  const metrics = {
    videoMs,
    segments: cues.length,
    mock: opt.mock,
    generatedAt: new Date().toISOString(),
    latencyMedians: {
      asrFinalMs: med(metricsList.map((m) => m.asrFinalMs)),
      mtFirstMs: med(metricsList.map((m) => m.mtFirstMs)),
      mtDoneMs: med(metricsList.map((m) => m.mtDoneMs)),
      ttsFirstMs: med(metricsList.map((m) => m.ttsFirstMs)),
      e2eLagMs: med(metricsList.map((m) => m.e2eLagMs)),
    },
    perSegment: metricsList,
  };
  fs.writeFileSync(path.join(opt.out, 'metrics.json'), JSON.stringify(metrics, null, 2));

  log(`\n  segments=${cues.length} translated=${cues.filter((c) => c.dst).length} dubChunks=${dubChunks.length}`);
  log(`  latency medians: ${JSON.stringify(metrics.latencyMedians)}`);

  // 6) 混音 + mux
  if (opt.dub && dubChunks.length > 0) {
    const { pcm48Stereo: mixed } = mixDubTrack({
      original48Stereo: pcm48Stereo,
      dubChunks: scheduled.chunks,
      duckLevel: Number(config.dub?.duckOriginal ?? 0.18),
      totalMs: videoMs,
    });
    const mixedWav = path.join(tmp, 'mixed48.wav');
    fs.writeFileSync(mixedWav, wavFromPcm(mixed, 48000, 2));
    const noSub = path.join(tmp, 'dubbed-nosub.mp4');
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', opt.video, '-i', mixedWav,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest',
      '-movflags', '+faststart', noSub,
    ]);
    let finalMp4 = noSub;
    if (opt.burn && cues.length > 0) {
      const py = await findPillowPython();
      if (py) {
        const subDir = path.join(tmp, 'subs');
        await run(py, [path.join(ROOT, 'scripts', 'render-overlays.py'), 'subtitles', '--srt', srtPath, '--out', subDir, '--width', '1280', '--height', '720']);
        const manifest = JSON.parse(fs.readFileSync(path.join(subDir, 'subtitles.json'), 'utf8'));
        const inputs = ['-i', noSub];
        const filters = [];
        let last = '[0:v]';
        manifest.cues.forEach((cue, i) => {
          inputs.push('-i', path.join(subDir, cue.file));
          const from = (cue.startMs / 1000 - 0.15).toFixed(3);
          const to = (cue.endMs / 1000 + 0.35).toFixed(3);
          const outLabel = `[v${i + 1}]`;
          filters.push(`${last}[${i + 1}:v]overlay=0:0:enable='between(t,${from},${to})'${outLabel}`);
          last = outLabel;
        });
        const burned = path.join(opt.out, 'dubbed.mp4');
        await run('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-y',
          ...inputs,
          '-filter_complex', filters.join(';'),
          '-map', last, '-map', '0:a:0',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
          '-c:a', 'copy', '-movflags', '+faststart', burned,
        ]);
        finalMp4 = burned;
        log(`  burned ${manifest.cues.length} bilingual cues -> ${path.relative(ROOT, burned)}`);
      } else {
        log('  [warn] 找不到带 Pillow 的 python，跳过字幕烧录（bilingual.srt 仍可用）');
      }
    }
    if (finalMp4 === noSub) {
      const fallback = path.join(opt.out, 'dubbed.mp4');
      try {
        fs.copyFileSync(noSub, fallback);
        finalMp4 = fallback;
      } catch {
        /* ignore */
      }
    }
    log(`  dubbed video -> ${path.relative(ROOT, finalMp4)}`);
  } else {
    log('  [warn] 没有配音 chunk（--no-dub 或 TTS 全部失败），只输出字幕与事件流');
  }

  log(`\n✔ batch done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  try {
    const { closeSharedServer } = await import('../engine/asr/index.mjs');
    await closeSharedServer();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n✖ batch failed: ${err.message}`);
  process.exit(1);
});
