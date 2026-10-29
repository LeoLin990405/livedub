#!/usr/bin/env node
/**
 * 生成 demo 用的「英文公开课」原始视频（demo/original.mp4）。
 *
 * 做法：Pillow 渲染幻灯片（本机 ffmpeg 无 drawtext） + macOS say 生成英文旁白 + ffmpeg 合成。
 * 之后由 scripts/batch.mjs 跑真实同传管线，产出 dubbed.mp4 / 双语 SRT / session.jsonl。
 *
 * 用法：node scripts/make-demo.mjs [--out demo] [--force]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outDir = argValue('--out') ? path.resolve(argValue('--out')) : path.join(ROOT, 'demo');
const force = args.includes('--force');
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const VOICE = process.env.LIVEDUB_DEMO_VOICE ?? 'Samantha';

function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

function run(cmd, argv, { cwd = ROOT, timeoutMs = 120000, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d;
      if (!quiet) process.stdout.write(d);
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${argv.join(' ')} exited ${code}\n${stderr.slice(-2000)}`));
    });
  });
}

async function probeDurationMs(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { quiet: true });
  return Math.round(Number(stdout.trim()) * 1000);
}

/** 找到带 Pillow 的 python3 */
const PY_CANDIDATES = [process.env.LIVEDUB_PYTHON, 'python3'];
function detectPython() {
  const runtimeRoot = path.join(os.homedir(), '.dsh', 'dsh-runtimes');
  try {
    for (const dir of fs.readdirSync(runtimeRoot)) {
      const candidate = path.join(runtimeRoot, dir, 'dependencies', 'python', 'bin', 'python3');
      if (fs.existsSync(candidate)) PY_CANDIDATES.push(candidate);
    }
  } catch {
    /* ignore */
  }
  return PY_CANDIDATES.filter(Boolean);
}

async function findPythonWithPillow() {
  for (const py of detectPython()) {
    try {
      await run(py, ['-c', 'import PIL'], { quiet: true, timeoutMs: 20000 });
      return py;
    } catch {
      /* next */
    }
  }
  throw new Error('找不到带 Pillow 的 python3：设置 LIVEDUB_PYTHON=/path/to/python3（pip install pillow）');
}

// ---------------------------------------------------------------- demo 内容

const DEMO_TITLE = 'Gradient Descent: The Engine of Deep Learning';
const SLIDES = [
  {
    title: 'Gradient Descent',
    subtitle: '梯度下降 · 一种最优化方法',
    bullets: [
      'The workhorse algorithm behind modern deep learning.',
      'Goal: minimize a loss function by iteratively updating parameters.',
      'This lecture: intuition, learning rate, and common failure modes.',
    ],
    narration: [
      'Welcome to this short lecture on gradient descent.',
      'Gradient descent is the workhorse algorithm behind modern deep learning.',
    ],
  },
  {
    title: 'The Core Idea',
    subtitle: '核心思想：沿梯度反方向迭代',
    bullets: [
      'Compute the gradient of the loss with respect to the parameters.',
      'Take a small step in the opposite direction of the gradient.',
      'Repeat until the loss stops improving.',
    ],
    narration: [
      'The idea is simple. We compute the gradient of the loss with respect to the parameters, and then we take a small step in the opposite direction.',
      'We repeat this process until the loss stops improving.',
    ],
  },
  {
    title: 'The Learning Rate',
    subtitle: '学习率：每一步走多远',
    bullets: [
      'Controls the size of each update step.',
      'Too large: training can diverge or oscillate.',
      'Too small: training becomes painfully slow.',
    ],
    narration: [
      'The learning rate controls how big each step is.',
      'If the learning rate is too large, training can diverge. If it is too small, training becomes very slow.',
    ],
  },
  {
    title: 'In Practice',
    subtitle: '实践中的梯度下降',
    bullets: [
      'Stochastic gradients trade exactness for speed.',
      'Momentum and adaptive methods smooth the trajectory.',
      'Learning rate schedules start large and decay over time.',
    ],
    narration: [
      'In practice we rarely use the exact gradient. Stochastic gradients trade exactness for speed.',
      'Momentum and adaptive methods smooth the trajectory, and learning rate schedules start large and decay over time.',
    ],
  },
  {
    title: 'Next Steps',
    subtitle: '下一讲：手写实现',
    bullets: [
      'Derive the gradient by hand for a linear model.',
      'Implement the update rule in code.',
      'Visualize the loss surface and the optimization path.',
    ],
    narration: [
      'In the next lecture, we will derive the gradient for a linear model, and implement the update rule in code.',
      'We will also visualize the loss surface and the optimization path. Thanks for watching.',
    ],
  },
];

// ---------------------------------------------------------------- main

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const workDir = path.join(outDir, 'tmp');
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const target = path.join(outDir, 'original.mp4');
  if (fs.existsSync(target) && !force) {
    console.log(`skip: ${target} exists（--force 重新生成）`);
    return;
  }

  const py = await findPythonWithPillow();
  console.log(`python(pillow): ${py}`);

  // 1) 幻灯片 PNG
  const specPath = path.join(workDir, 'slides-spec.json');
  fs.writeFileSync(specPath, JSON.stringify({ width: WIDTH, height: HEIGHT, eyebrow: 'LIVEDUB DEMO LECTURE · UNIVERSITY STYLE', slides: SLIDES }, null, 2));
  const slideDir = path.join(workDir, 'slides');
  await run(py, [path.join(ROOT, 'scripts', 'render-overlays.py'), 'slides', '--spec', specPath, '--out', slideDir]);

  // 2) 每页旁白（say）+ 时长
  const slideFiles = [];
  const timeline = [];
  let cursorMs = 0;
  for (let i = 0; i < SLIDES.length; i++) {
    const slide = SLIDES[i];
    const aiff = path.join(workDir, `narration_${i + 1}.aiff`);
    const wav = path.join(workDir, `narration_${i + 1}.wav`);
    await run('say', ['-v', VOICE, '-r', '172', '-o', aiff, slide.narration.join(' ')]);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', aiff, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    const durMs = await probeDurationMs(wav);
    const videoMs = durMs + 700; // 页尾留白
    slideFiles.push({ png: path.join(slideDir, `slide_${String(i + 1).padStart(2, '0')}.png`), wav, videoMs });
    timeline.push({ index: i + 1, title: slide.title, startMs: cursorMs, endMs: cursorMs + videoMs, narration: slide.narration });
    cursorMs += videoMs;
  }

  // 3) 每页视频（静音）
  const segFiles = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const seg = path.join(workDir, `seg_${i + 1}.mp4`);
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-loop', '1', '-framerate', String(FPS), '-i', slideFiles[i].png,
      '-t', (slideFiles[i].videoMs / 1000).toFixed(3),
      '-vf', `scale=${WIDTH}:${HEIGHT}:flags=lanczos,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-r', String(FPS),
      '-an', seg,
    ]);
    segFiles.push(seg);
    console.log(`slide ${i + 1}/${slideFiles.length}: ${(slideFiles[i].videoMs / 1000).toFixed(1)}s`);
  }

  // 4) 拼接视频 + 拼接旁白
  const concatList = path.join(workDir, 'concat.txt');
  fs.writeFileSync(concatList, segFiles.map((f) => `file '${f}'`).join('\n'));
  const silentVideo = path.join(workDir, 'slides.mp4');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-c', 'copy', silentVideo]);

  const audioList = path.join(workDir, 'audio-concat.txt');
  // 每页音频之间补 0.7s 静音，和视频页尾一致
  const pads = [];
  for (let i = 0; i < slideFiles.length; i++) {
    pads.push(`file '${slideFiles[i].wav}'`);
    const padFile = path.join(workDir, `pad_${i + 1}.wav`);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '0.7', '-c:a', 'pcm_s16le', padFile]);
    pads.push(`file '${padFile}'`);
  }
  fs.writeFileSync(audioList, pads.join('\n'));
  const narration = path.join(workDir, 'narration.wav');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', audioList, '-c', 'copy', narration]);

  // 5) 合成原始视频
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', silentVideo, '-i', narration,
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest',
    '-movflags', '+faststart', target,
  ]);

  const meta = {
    title: DEMO_TITLE,
    voice: VOICE,
    width: WIDTH,
    height: HEIGHT,
    durationMs: await probeDurationMs(target),
    timeline,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'demo-meta.json'), JSON.stringify(meta, null, 2));
  console.log(`\n✔ ${target}`);
  console.log(JSON.stringify({ durationMs: meta.durationMs, slides: timeline.length }, null, 2));
}

main().catch((err) => {
  console.error(`make-demo failed: ${err.message}`);
  process.exit(1);
});
