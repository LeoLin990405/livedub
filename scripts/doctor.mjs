#!/usr/bin/env node
/**
 * livedub 环境体检。
 *
 * 默认只做只读检查（不产生 API 费用）：
 *   node scripts/doctor.mjs
 *
 * 加 --probe 会做真实链路的极小样本探测（会产生极小费用 / 启动本地 whisper）：
 *   node scripts/doctor.mjs --probe
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  PROJECT_ROOT,
  loadConfig,
  loadSaylessProviders,
  resolveProvider,
  resolveWhisperModel,
  validateConfig,
  saylessConfigPath,
} from '../engine/config.mjs';

const argv = process.argv.slice(2);
const probe = argv.includes('--probe');
const jsonOut = argv.includes('--json');

const rows = [];
let errors = 0;
let warnings = 0;

function add(level, name, detail) {
  if (level === 'error') errors += 1;
  if (level === 'warn') warnings += 1;
  rows.push({ level, name, detail });
}

function run(cmd, args, { timeoutMs = 15000, input = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ ok: false, code: null, stdout: '', stderr: String(err.message) });
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: String(err.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
    if (input) child.stdin.end(input);
  });
}

async function existsCmd(cmd) {
  const which = await run('/usr/bin/which', [cmd], { timeoutMs: 5000 });
  return which.ok;
}

function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(600);
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(true));
    socket.connect(port, host);
  });
}

async function checkBaseline() {
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 22 ? 'ok' : 'error', 'node', `v${process.versions.node}${major >= 22 ? '' : '（需要 >=22）'}`);
  for (const cmd of ['ffmpeg', 'ffprobe', 'say', 'whisper-server']) {
    const ok = await existsCmd(cmd);
    add(ok ? 'ok' : cmd === 'whisper-server' ? 'error' : 'warn', cmd, ok ? '在 PATH 中' : `未找到 ${cmd}`);
  }
  const model = resolveWhisperModel(loadConfig());
  add(model ? 'ok' : 'error', 'whisper 模型', model ? path.relative(PROJECT_ROOT, model) + ` (${(fs.statSync(model).size / 1e6).toFixed(0)}MB)` : '候选路径都不存在，运行 npm run doctor 查看 config.asr.whisper.models');
}

async function checkConfig() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    add('error', 'config', err.message);
    return null;
  }
  add('ok', 'config', 'config/livedub.config.json 已加载');
  const sayless = loadSaylessProviders();
  if (sayless.path) add('ok', 'sayless providers', `${sayless.path}（${Object.keys(sayless.providers).length} 个 provider，只读复用 Key）`);
  else add('warn', 'sayless providers', '未找到 ~/.sayless/config.json（翻译/TTS 需要自己配置 Key）');

  const issues = validateConfig(config);
  for (const issue of issues) add(issue.level === 'error' ? 'error' : 'warn', issue.scope, issue.message);

  const primary = config.translate?.provider;
  for (const name of [primary, ...(config.translate?.chain ?? [])].filter(Boolean)) {
    if (![...(config.translate?.chain ?? [])].length && name !== primary) continue;
    try {
      const p = resolveProvider(config, name);
      add(p.apiKey ? 'ok' : 'error', `translate/${name}`, `${p.model || '(model 未配置)'} @ ${p.baseUrl}${p.apiKey ? '' : ' — 缺 apiKey'}`);
    } catch (err) {
      add('error', `translate/${name}`, err.message);
    }
  }
  try {
    const tts = resolveProvider(config, config.tts?.provider);
    add(tts.apiKey ? 'ok' : 'error', `tts/${config.tts?.provider}`, `${config.tts?.model} @ ${tts.baseUrl}${tts.apiKey ? '' : ' — 缺 apiKey'}`);
    add('ok', 'tts voiceMode', `${config.tts?.voiceMode}（克隆失败会自动降级 preset：${config.tts?.presetVoices?.default}）`);
  } catch (err) {
    add('error', 'tts', err.message);
  }

  // 视觉理解（v0.5，可选能力）
  const visionCfg = config.vision ?? {};
  const ocrBin = path.resolve(PROJECT_ROOT, String(visionCfg.ocr?.bin || 'data/bin/ocr-macos'));
  const ocrReady = fs.existsSync(ocrBin);
  add(ocrReady ? 'ok' : 'warn', 'vision OCR', ocrReady ? `本地 ${path.relative(PROJECT_ROOT, ocrBin)}` : '本地 OCR 未构建（npm run build:ocr；也可用 tesseract 兜底）');
  try {
    const vp = resolveProvider(config, visionCfg.provider || 'ark-plan');
    add(vp.apiKey ? 'ok' : 'warn', 'vision VLM', `${visionCfg.model || vp.model} @ ${vp.baseUrl}${vp.apiKey ? '' : ' — 缺 apiKey（仅 OCR 可用）'}`);
  } catch (err) {
    add('warn', 'vision VLM', err.message);
  }

  // 云端 ASR / 火山语音（可选能力）
  const asrProvider = config.asr?.provider ?? 'whisper-local';
  add('ok', 'asr.provider', asrProvider + (asrProvider === 'minimax-cloud' ? '（音频会上传到 MiniMax）' : '（本地识别）'));
  if (asrProvider === 'minimax-cloud') {
    try {
      const mm = resolveProvider(config, 'minimax');
      add(mm.apiKey ? 'ok' : 'error', 'cloud ASR (minimax)', `${config.asr?.minimaxCloud?.model ?? 'asr-1.0'} @ ${mm.baseUrl}${mm.apiKey ? '' : ' — 缺 apiKey'}`);
    } catch (err) {
      add('error', 'cloud ASR (minimax)', err.message);
    }
  }
  const volcKey = process.env.VOLCENGINE_SPEECH_API_KEY || process.env.ARK_SPEECH_API_KEY || '';
  try {
    const vp = resolveProvider(config, 'volcengine');
    const key = volcKey || vp.apiKey || '';
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
    add(isUuid ? 'ok' : 'warn', 'volcengine speech', isUuid ? '已配置 UUID Key（可启用真实声音克隆）' : '未配置豆包语音 UUID Key（火山 TTS/复刻不可用，克隆会降级 preset）');
  } catch (err) {
    add('warn', 'volcengine speech', err.message);
  }
  for (const port of [Number(config.server?.port ?? 8787), Number(config.asr?.whisper?.port ?? 18765)]) {
    const free = await portFree(port);
    add(free ? 'ok' : 'warn', `port ${port}`, free ? '空闲' : '已被占用（可能是已在运行的 livedub）');
  }
  return config;
}

async function checkFiles() {
  const required = [
    'engine/server.mjs',
    'engine/pipeline.mjs',
    'engine/asr/index.mjs',
    'engine/translate/index.mjs',
    'engine/tts/index.mjs',
    'engine/voice.mjs',
    'engine/dub/scheduler.mjs',
    'studio/index.html',
    'studio/replay.html',
    'extension/manifest.json',
    'config/livedub.fast.json',
    'config/livedub.cloud.json',
    'scripts/build-macos.sh',
    'scripts/build-ocr.sh',
  ];
  for (const rel of required) {
    const ok = fs.existsSync(path.join(PROJECT_ROOT, rel));
    add(ok ? 'ok' : 'warn', rel, ok ? '存在' : '缺失（模块可能还没实现）');
  }
}

// ------------------------------------------------------------------ probe

async function probeProviders(config) {
  const key = config.translate?.provider;
  try {
    const p = resolveProvider(config, key);
    if (p.apiKey) {
      const t0 = performance.now();
      const res = await fetch(`${p.baseUrl}${p.chatPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify({
          model: p.model,
          temperature: 0,
          max_tokens: 30,
          messages: [
            { role: 'system', content: '你是同传翻译，只输出中文译文。' },
            { role: 'user', content: 'Gradient descent minimizes a loss function.' },
          ],
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content?.trim() ?? '';
        add('ok', `probe translate/${key}`, `${Math.round(performance.now() - t0)}ms · ${text.slice(0, 48)}`);
      } else {
        add('error', `probe translate/${key}`, `HTTP ${res.status}：${(await res.text()).slice(0, 160)}`);
      }
    }
  } catch (err) {
    add('error', `probe translate/${key}`, err.message);
  }

  const ttsProvider = config.tts?.provider;
  try {
    const p = resolveProvider(config, ttsProvider);
    if (p.apiKey && ttsProvider === 'minimax') {
      const voiceId = config.tts?.presetVoices?.default ?? 'male-qn-qingse';
      const t0 = performance.now();
      const res = await fetch(`${p.baseUrl}${p.ttsChatPath ?? '/t2a_v2'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify({
          model: config.tts?.model ?? 'speech-2.8-hd',
          text: '梯度下降是一种优化算法。',
          stream: false,
          voice_setting: { voice_id: voiceId, speed: 1.0 },
          audio_setting: { sample_rate: 24000, format: 'pcm' },
        }),
      });
      const data = await res.json().catch(() => ({}));
      const audio = data?.data?.audio;
      if (res.ok && audio) {
        const bytes = Buffer.from(audio, 'hex').length;
        add('ok', `probe tts/${ttsProvider}`, `${Math.round(performance.now() - t0)}ms · voice=${voiceId} · ${(bytes / 1024).toFixed(0)}KB PCM`);
      } else {
        add('error', `probe tts/${ttsProvider}`, `HTTP ${res.status}：${JSON.stringify(data?.base_resp ?? data).slice(0, 160)}`);
      }
    }
  } catch (err) {
    add('error', `probe tts/${ttsProvider}`, err.message);
  }

  // 云端 ASR 冒烟（MINIMAX，极小样本）：4s 英文
  if ((config.asr?.provider ?? '') === 'minimax-cloud') {
    try {
      const mm = resolveProvider(config, 'minimax');
      const aiff = path.join(os.tmpdir(), `livedub-doctor-cloud-${Date.now()}.aiff`);
      const wav = aiff.replace('.aiff', '.wav');
      await run('say', ['-v', 'Samantha', '-o', aiff, 'Glossary terms matter for accurate translation.']);
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', aiff, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
      const t0 = performance.now();
      const form = new FormData();
      form.append('model', 'asr-1.0');
      form.append('file', new Blob([fs.readFileSync(wav)], { type: 'audio/wav' }), 'probe.wav');
      const res = await fetch(`${mm.baseUrl.replace(/\/$/, '')}/speech_to_text`, {
        method: 'POST',
        headers: { authorization: `Bearer ${mm.apiKey}`, language: 'en' },
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.text) add('ok', 'probe cloud ASR', `${Math.round(performance.now() - t0)}ms · ${String(data.text).slice(0, 60)}`);
      else add('error', 'probe cloud ASR', `HTTP ${res.status}：${JSON.stringify(data).slice(0, 160)}`);
      for (const f of [aiff, wav]) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
    } catch (err) {
      add('error', 'probe cloud ASR', err.message);
    }
  }

  // whisper-server 冒烟：用系统 say 生成 2s 英文，识别一次
  const model = resolveWhisperModel(config);
  if (model) {
    const whisperServer = config.asr?.whisper?.bin ?? 'whisper-server';
    const port = 18799;
    const tmp = path.join(os.tmpdir(), `livedub-doctor-${Date.now()}.wav`);
    await run('say', ['-v', 'Samantha', '-o', tmp.replace('.wav', '.aiff'), 'Gradient descent is an optimization algorithm.']);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', tmp.replace('.wav', '.aiff'), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmp]);
    const child = spawn(whisperServer, ['-m', model, '--port', String(port), '--host', '127.0.0.1'], { stdio: 'ignore' });
    let up = false;
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await fetch(`http://127.0.0.1:${port}/`).catch(() => null);
      if (res) {
        up = true;
        break;
      }
    }
    if (up) {
      const t0 = performance.now();
      const wav = fs.readFileSync(tmp);
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'probe.wav');
      form.append('language', 'en');
      form.append('response_format', 'json');
      const res = await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form }).catch((err) => ({ ok: false, statusText: err.message }));
      if (res.ok) {
        const data = await res.json();
        add('ok', 'probe whisper', `${Math.round(performance.now() - t0)}ms · ${String(data.text ?? '').trim().slice(0, 80)}`);
      } else {
        add('error', 'probe whisper', `推理失败 ${res.status ?? ''} ${res.statusText ?? ''}`);
      }
    } else {
      add('error', 'probe whisper', 'whisper-server 90s 内未就绪');
    }
    child.kill('SIGKILL');
    for (const f of [tmp, tmp.replace('.wav', '.aiff')]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
}

// ------------------------------------------------------------------ main

async function main() {
  await checkBaseline();
  const config = await checkConfig();
  await checkFiles();
  if (probe && config) await probeProviders(config);

  if (jsonOut) {
    console.log(JSON.stringify({ ok: errors === 0, errors, warnings, checks: rows }, null, 2));
  } else {
    const icon = { ok: '✔', warn: '!', error: '✖' };
    console.log('\n l i v e d u b   d o c t o r\n');
    for (const row of rows) console.log(`  ${icon[row.level]} ${row.name.padEnd(22)} ${row.detail}`);
    console.log(`\n  结果：${errors === 0 ? '可以启动' : '存在阻塞项'}（errors=${errors}, warnings=${warnings}）`);
    if (!probe) console.log('  提示：node scripts/doctor.mjs --probe 会真实调用翻译/TTS/whisper 做极小样本探测（有极小费用）。');
    console.log('');
  }
  process.exit(errors === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`doctor failed: ${err.message}`);
  process.exit(1);
});
