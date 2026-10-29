/**
 * T1 实时 ASR 层测试：engine/segmenter.mjs + engine/asr/index.mjs
 *
 * 单测不联网、不加载真实模型：
 *   - VAD 分段器用合成 PCM（纯逻辑）
 *   - whisper-local 用注入的 fetchImpl / spawnImpl 验证协议、共享进程、重启、busy-skip
 * 真机测试（会加载 ~574MB 模型，约 25-40s）：
 *   LIVEDUB_INTEGRATION=1 node --test tests/asr.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import { float32ToS16le, pcmDurationMs, pcmFromWav } from '../engine/audio.mjs';
import { createSegmenter } from '../engine/segmenter.mjs';
import { cleanAsrText, closeSharedServer, createAsr, listSharedServers } from '../engine/asr/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RATE = 16000;
const INTEGRATION = process.env.LIVEDUB_INTEGRATION === '1';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- PCM 合成

function tonePcm(ms, amplitude = 0.2, freq = 220) {
  const n = Math.round((ms / 1000) * RATE);
  const f32 = new Float32Array(n);
  for (let i = 0; i < n; i += 1) f32[i] = Math.sin((2 * Math.PI * freq * i) / RATE) * amplitude;
  return float32ToS16le(f32);
}

function silencePcm(ms) {
  return Buffer.alloc(Math.round((ms / 1000) * RATE) * 2);
}

/** 确定性伪随机噪声（避免 Math.random 造成单测抖动） */
function noisePcm(ms, amplitude = 0.008) {
  const n = Math.round((ms / 1000) * RATE);
  const f32 = new Float32Array(n);
  let seed = 123456789;
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const r = (seed / 0x7fffffff) * 2 - 1;
    f32[i] = r * amplitude;
  }
  return float32ToS16le(f32);
}

function pcmMs(pcm) {
  return pcmDurationMs(pcm, RATE);
}

function vadConfig(over = {}) {
  return {
    frameMs: 20,
    energyThreshold: 0.012,
    adaptive: false,
    minSpeechMs: 240,
    minSilenceMs: 300,
    maxUtteranceMs: 7000,
    preRollMs: 200,
    tailPadMs: 150,
    ...over,
  };
}

function makeSegmenter(configOver = {}, partialOver = {}) {
  const events = [];
  const seg = createSegmenter({
    config: vadConfig(configOver),
    partial: { enabled: true, intervalMs: 900, windowMs: 9000, ...partialOver },
    sampleRate: RATE,
    onEvent: (ev) => events.push(ev),
  });
  return { seg, events };
}

/**
 * 把 PCM 按 chunkMs 分块喂给 segmenter（默认 20ms = 一帧），返回结束时间轴。
 * 同一 segmenter 的多次调用默认在音频时间轴上连续（除非显式传 tMs 模拟 seek/断流）。
 */
const feedTimeline = new WeakMap();
function feedPcm(seg, pcm, { tMs, chunkMs = 20 } = {}) {
  const chunkBytes = Math.max(2, Math.round((chunkMs / 1000) * RATE) * 2);
  let t = tMs ?? feedTimeline.get(seg) ?? 0;
  for (let i = 0; i < pcm.length; i += chunkBytes) {
    const chunk = pcm.subarray(i, Math.min(pcm.length, i + chunkBytes));
    seg.push(chunk, t);
    t += Math.round((chunk.length / 2 / RATE) * 1000);
  }
  feedTimeline.set(seg, t);
  return t;
}

function finalsOf(events) {
  return events.filter((e) => e.type === 'final');
}

function partialsOf(events) {
  return events.filter((e) => e.type === 'partial');
}

// ================================================================ segmenter

test('segmenter: 静音不产生任何事件', () => {
  const { seg, events } = makeSegmenter();
  feedPcm(seg, silencePcm(2000));
  seg.flush();
  assert.deepEqual(events, []);
});

test('segmenter: 短噪声（< minSpeechMs）不起句', () => {
  const { seg, events } = makeSegmenter();
  feedPcm(seg, silencePcm(300));
  feedPcm(seg, noisePcm(120, 0.3));
  feedPcm(seg, silencePcm(1000));
  seg.flush();
  assert.equal(events.length, 0);
});

test('segmenter: 一句话的 t0/t1 包含 pre-roll 与 tailPad，且与 PCM 时长严格一致', () => {
  const { seg, events } = makeSegmenter();
  // 500ms 静音 + 800ms 语音 + 600ms 静音
  feedPcm(seg, silencePcm(500));
  feedPcm(seg, tonePcm(800));
  feedPcm(seg, silencePcm(600));
  seg.flush();

  const starts = events.filter((e) => e.type === 'speechStart');
  assert.equal(starts.length, 1);
  const finals = finalsOf(events);
  assert.equal(finals.length, 1);
  const f = finals[0];
  // 语音 onset=500ms，preRoll=200 -> t0=300；语音结束 1300 + tailPad 160 -> t1≈1460
  assert.ok(Math.abs(f.t0Ms - 300) <= 20, `t0=${f.t0Ms} 应≈300`);
  assert.ok(Math.abs(f.t1Ms - 1460) <= 20, `t1=${f.t1Ms} 应≈1460`);
  assert.equal(pcmMs(f.pcm), f.t1Ms - f.t0Ms, 't1-t0 必须等于 PCM 时长');
});

test('segmenter: 两句静音切分，final 按顺序且不重叠', () => {
  const { seg, events } = makeSegmenter();
  feedPcm(seg, silencePcm(400));
  feedPcm(seg, tonePcm(700));
  feedPcm(seg, silencePcm(500));
  feedPcm(seg, tonePcm(700));
  feedPcm(seg, silencePcm(500));
  seg.flush();

  const finals = finalsOf(events);
  assert.equal(finals.length, 2);
  const [a, b] = finals;
  assert.ok(a.t0Ms >= 0 && a.t1Ms > a.t0Ms);
  assert.ok(b.t0Ms >= a.t1Ms, `第二句 t0=${b.t0Ms} 不应早于第一句 t1=${a.t1Ms}`);
  assert.equal(pcmMs(a.pcm), a.t1Ms - a.t0Ms);
  assert.equal(pcmMs(b.pcm), b.t1Ms - b.t0Ms);
});

test('segmenter: 连续语音到 maxUtteranceMs 强制切分，且首尾相接不重叠', () => {
  const { seg, events } = makeSegmenter({ maxUtteranceMs: 2000 });
  feedPcm(seg, tonePcm(10000));
  feedPcm(seg, silencePcm(500));
  seg.flush();

  const finals = finalsOf(events);
  assert.ok(finals.length >= 4, `10s 连续语音按 2s 切分应 >=4 句，实际 ${finals.length}`);
  for (let i = 0; i < finals.length; i += 1) {
    assert.equal(pcmMs(finals[i].pcm), finals[i].t1Ms - finals[i].t0Ms);
    assert.ok(finals[i].t1Ms - finals[i].t0Ms <= 2000 + 20, '每句不应超过 maxUtteranceMs + 1 帧');
    if (i > 0) assert.equal(finals[i].t0Ms, finals[i - 1].t1Ms, '强制切分后相邻句应首尾相接');
  }
  assert.ok(Math.abs(finals[0].t0Ms - 0) <= 20);
  assert.ok(Math.abs(finals[finals.length - 1].t1Ms - 10000) <= 20);
  assert.ok(seg.stats().forceSplits >= 4);
});

test('segmenter: flush 落尾（话说到一半也能出 final），之后可继续识别', () => {
  const { seg, events } = makeSegmenter();
  feedPcm(seg, tonePcm(800)); // 没有尾部静音，直接 flush
  seg.flush();
  let finals = finalsOf(events);
  assert.equal(finals.length, 1);
  assert.ok(Math.abs(finals[0].t1Ms - 800) <= 20);

  // flush 后继续说话
  feedPcm(seg, silencePcm(400), { tMs: 800 });
  feedPcm(seg, tonePcm(600), { tMs: 1200 });
  feedPcm(seg, silencePcm(500), { tMs: 1800 });
  seg.flush();
  finals = finalsOf(events);
  assert.equal(finals.length, 2);
  assert.ok(finals[1].t0Ms >= finals[0].t1Ms);
});

test('segmenter: 滚动 partial 窗口按 intervalMs 触发，窗口不超过 windowMs', () => {
  const { seg, events } = makeSegmenter(
    { minSpeechMs: 100, minSilenceMs: 300 },
    { intervalMs: 200, windowMs: 1000 },
  );
  feedPcm(seg, tonePcm(1200));
  feedPcm(seg, silencePcm(400));
  seg.flush();

  const partials = partialsOf(events);
  assert.ok(partials.length >= 4, `应产生多次 partial，实际 ${partials.length}`);
  let prevT1 = -1;
  for (const p of partials) {
    assert.ok(p.t1Ms > prevT1, 'partial t1 应递增');
    prevT1 = p.t1Ms;
    assert.ok(p.t1Ms - p.t0Ms <= 1000 + 20, `窗口 ${p.t1Ms - p.t0Ms}ms 不应超过 windowMs`);
    assert.equal(pcmMs(p.pcm), p.t1Ms - p.t0Ms);
  }
  const finals = finalsOf(events);
  assert.equal(finals.length, 1);
  assert.ok(finals[0].t0Ms >= 0);
});

test('segmenter: adaptive 会抬高底噪阈值，且不影响语音检出', () => {
  // 自适应：低噪（RMS≈0.0085 < 0.012）持续后，阈值应升到 energyThreshold 之上
  const { seg, events } = makeSegmenter({ adaptive: true });
  feedPcm(seg, noisePcm(2000, 0.012));
  const stateAfterNoise = seg.state();
  assert.ok(stateAfterNoise.noiseFloor > 0, 'noiseFloor 应被估计出来');
  assert.ok(
    stateAfterNoise.threshold > stateAfterNoise.energyThreshold,
    `自适应阈值 ${stateAfterNoise.threshold} 应 > ${stateAfterNoise.energyThreshold}`,
  );
  // 自适应后仍然能检出正常语音
  feedPcm(seg, tonePcm(800), { tMs: 2000 });
  feedPcm(seg, silencePcm(500), { tMs: 2800 });
  seg.flush();
  assert.equal(finalsOf(events).length, 1);

  // 关闭 adaptive 时阈值固定
  const fixed = makeSegmenter({ adaptive: false });
  feedPcm(fixed.seg, noisePcm(2000, 0.012));
  assert.equal(fixed.seg.state().threshold, fixed.seg.state().energyThreshold);
});

test('segmenter: 时间轴跳变（seek/断流）会落尾并重置时间轴', () => {
  const { seg, events } = makeSegmenter();
  feedPcm(seg, tonePcm(600));
  // 直接跳到 5000ms（模拟 seek）
  feedPcm(seg, tonePcm(600), { tMs: 5000 });
  feedPcm(seg, silencePcm(500), { tMs: 5600 });
  seg.flush();

  const finals = finalsOf(events);
  assert.ok(finals.length >= 2, `跳变前后应各有一句，实际 ${finals.length}`);
  const last = finals[finals.length - 1];
  assert.ok(last.t0Ms >= 4700, `跳变后时间轴应从 5000ms 附近重新开始，实际 t0=${last.t0Ms}`);
  assert.ok(last.t1Ms >= 5000, `跳变后 final 应结束在 5000ms 之后，实际 t1=${last.t1Ms}`);
  assert.ok(seg.stats().discontinuityResets >= 1);
});

// ================================================================ ASR 单元（mock / 注入）

test('cleanAsrText: 去时间戳/非语音标记/折叠空白/纯标点为空', () => {
  assert.equal(cleanAsrText('  hello   world  '), 'hello world');
  assert.equal(cleanAsrText('[BLANK_AUDIO]'), '');
  assert.equal(cleanAsrText('[ Music ]'), '');
  assert.equal(cleanAsrText('(applause)'), '');
  assert.equal(cleanAsrText('[00:00:00.000 --> 00:00:02.500] hello there'), 'hello there');
  assert.equal(cleanAsrText('...'), '');
  assert.equal(cleanAsrText(''), '');
  assert.equal(cleanAsrText(null), '');
  assert.equal(cleanAsrText('♪ ♪'), '');
});

test('asr: mock provider 复用 createMockAsr，事件形状符合契约', async () => {
  const events = [];
  const asr = await createAsr({
    config: {
      asr: { provider: 'mock' },
      mock: { asrScript: [{ text: 'gradient descent is simple', durMs: 400 }] },
    },
    log: () => {},
    onEvent: (ev) => events.push(ev),
  });
  assert.equal(asr.name, 'mock-asr');
  for (let i = 0; i < 4; i += 1) await asr.push(Buffer.alloc((RATE / 10) * 2), i * 100);
  await asr.flush();
  const finals = finalsOf(events);
  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, 'gradient descent is simple');
  assert.equal(typeof finals[0].t0Ms, 'number');
  assert.equal(typeof finals[0].t1Ms, 'number');
  assert.equal(finals[0].lang, 'en');
  await asr.close();
});

test('asr: 未知 provider 抛清晰错误（不静默回退）', async () => {
  await assert.rejects(
    () => createAsr({ config: { asr: { provider: 'azure-speech' } }, log: () => {}, onEvent: () => {} }),
    /unknown provider: azure-speech/,
  );
});

// ---------------------------------------------------------------- whisper-local 注入测试

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livedub-asr-test-'));
const fakeModelPath = path.join(tmpDir, 'fake-model.bin');
fs.writeFileSync(fakeModelPath, 'not-a-real-model');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * 假 whisper-server：spawnImpl 返回 EventEmitter 假子进程，fetchImpl 模拟 /health + /inference。
 * 默认按音频时长返回不同文本（>1000ms 视为 final，否则视为 partial）。
 */
function makeFakeWhisper({ respond } = {}) {
  const children = [];
  let calls = 0;
  const spawnImpl = (bin, args) => {
    const child = new EventEmitter();
    child.pid = 5000 + children.length;
    child.args = args;
    child.killed = false;
    child.exitCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      if (child.killed) return true;
      child.killed = true;
      child.exitCode = 0;
      setImmediate(() => child.emit('exit', 0, null));
      return true;
    };
    children.push(child);
    return child;
  };
  const alive = () => children.some((c) => !c.killed);
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/health')) {
      if (!alive()) throw new TypeError('fetch failed: connect ECONNREFUSED');
      return jsonResponse({ status: 'ok' });
    }
    if (u.endsWith('/inference')) {
      calls += 1;
      const file = init?.body?.get?.('file');
      const buf = file ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0);
      const audioMsExact = Math.max(0, Math.round(((buf.length - 44) / 2 / RATE) * 1000));
      let text;
      if (typeof respond === 'function') {
        text = await respond({ call: calls, audioMs: audioMsExact, form: init?.body });
      } else {
        text = audioMsExact >= 1000 ? 'gradient descent is an iterative optimization algorithm' : 'gradient descent';
      }
      return jsonResponse({ text });
    }
    return new Response('not found', { status: 404 });
  };
  return { spawnImpl, fetchImpl, children, calls: () => calls, alive };
}

function whisperConfig({ port, vad = {}, partial = {}, modelPath = fakeModelPath } = {}) {
  return {
    session: { sampleRate: RATE, langFrom: 'en' },
    asr: {
      provider: 'whisper-local',
      whisper: {
        bin: 'whisper-server',
        host: '127.0.0.1',
        port,
        models: [modelPath],
        language: 'en',
        threads: 2,
        startupTimeoutMs: 5000,
        requestTimeoutMs: 5000,
        vad: vadConfig(vad),
        partial: { enabled: true, intervalMs: 400, windowMs: 2000, minChars: 3, skipWhileBusy: true, ...partial },
      },
    },
  };
}

/** 把 PCM 以 100ms 块喂给 asr（每块之间让出事件循环，允许 pump 启动） */
async function feedAsr(asr, pcm, { tMs = 0, chunkMs = 100, yieldEach = false } = {}) {
  const chunkBytes = Math.max(2, Math.round((chunkMs / 1000) * RATE) * 2);
  let t = tMs;
  for (let i = 0; i < pcm.length; i += chunkBytes) {
    const chunk = pcm.subarray(i, Math.min(pcm.length, i + chunkBytes));
    await asr.push(chunk, t);
    t += Math.round((chunk.length / 2 / RATE) * 1000);
    if (yieldEach) await sleep(0);
  }
  return t;
}

/** 按真实时间节奏喂入（约 chunkMs 一块），用于真机测 final 延迟 / partial 间隔 */
async function feedAsrRealtime(asr, pcm, { chunkMs = 100 } = {}) {
  const chunkBytes = Math.max(2, Math.round((chunkMs / 1000) * RATE) * 2);
  const startWall = Date.now();
  let t = 0;
  for (let i = 0; i < pcm.length; i += chunkBytes) {
    const chunk = pcm.subarray(i, Math.min(pcm.length, i + chunkBytes));
    await asr.push(chunk, t);
    t += Math.round((chunk.length / 2 / RATE) * 1000);
    const wait = startWall + t - Date.now();
    if (wait > 0) await sleep(wait);
  }
  return { endTMs: t, startWall, endWall: Date.now() };
}

test('asr/whisper-local: 识别协议、音频时间轴、共享 server 单例、close 不杀共享进程', async () => {
  const port = 18801;
  const fake = makeFakeWhisper();
  const events = [];
  try {
    const asr = await createAsr({
      config: whisperConfig({ port }),
      log: () => {},
      onEvent: (ev) => events.push(ev),
      fetchImpl: fake.fetchImpl,
      spawnImpl: fake.spawnImpl,
    });
    await asr.warmup();
    assert.equal(fake.children.length, 1, '应只拉起一个 whisper-server');
    assert.equal(asr.name, 'whisper-local');
    const spawnArgs = fake.children[0].args;
    assert.ok(spawnArgs.includes('-m') && spawnArgs.includes(fakeModelPath), 'server 参数应带模型路径');
    assert.ok(spawnArgs.includes('--port') && spawnArgs.includes(String(port)), 'server 参数应带端口');

    // 400ms 静音 + 900ms 语音 + 700ms 静音 -> 一句 final，t0≈200（preRoll），t1≈1460（tailPad）
    await feedAsr(asr, silencePcm(400));
    await feedAsr(asr, tonePcm(900), { tMs: 400 });
    await feedAsr(asr, silencePcm(700), { tMs: 1300 });
    await asr.flush();

    const finals = finalsOf(events);
    assert.equal(finals.length, 1, `应识别出一句，事件：${JSON.stringify(events)}`);
    assert.match(finals[0].text, /gradient descent/);
    assert.ok(Math.abs(finals[0].t0Ms - 200) <= 20, `t0=${finals[0].t0Ms} 应≈200（音频时间轴）`);
    assert.ok(Math.abs(finals[0].t1Ms - 1460) <= 20, `t1=${finals[0].t1Ms} 应≈1460（tailPad）`);
    assert.equal(finals[0].t1Ms - finals[0].t0Ms, 1260);
    assert.equal(finals[0].lang, 'en');

    // 第二个会话：复用同一个共享 server
    const events2 = [];
    const asr2 = await createAsr({
      config: whisperConfig({ port }),
      log: () => {},
      onEvent: (ev) => events2.push(ev),
      fetchImpl: fake.fetchImpl,
      spawnImpl: fake.spawnImpl,
    });
    await asr2.warmup();
    assert.equal(fake.children.length, 1, '第二会话应复用共享 whisper-server');
    assert.equal(asr2.stats().server.pid, asr.stats().server.pid);

    await asr.close(); // 会话 close 不能杀共享进程
    assert.equal(fake.children[0].killed, false, '会话 close 后共享 server 应仍然存活');

    await feedAsr(asr2, tonePcm(800));
    await feedAsr(asr2, silencePcm(600), { tMs: 800 });
    await asr2.flush();
    assert.equal(finalsOf(events2).length, 1);

    await asr2.close();
    assert.equal(fake.children[0].killed, false, '所有会话 close 后共享 server 仍应存活（由 closeSharedServer 收尾）');
    await closeSharedServer();
    assert.equal(fake.children[0].killed, true, 'closeSharedServer 应杀掉共享 server');
    assert.equal(listSharedServers().length, 0);
  } finally {
    await closeSharedServer();
  }
});

test('asr/whisper-local: busy 时按 skipWhileBusy 跳过 partial', async () => {
  const port = 18802;
  let release = null;
  let calls = 0;
  const fake = makeFakeWhisper({
    respond: async ({ audioMs }) => {
      calls += 1;
      if (calls === 1) {
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return audioMs >= 1400 ? 'continuous optimization converges quickly' : 'continuous optimization';
    },
  });
  try {
    const events = [];
    const asr = await createAsr({
      config: whisperConfig({
        port,
        vad: { minSpeechMs: 100, minSilenceMs: 300 },
        partial: { intervalMs: 200, windowMs: 1500 },
      }),
      log: () => {},
      onEvent: (ev) => events.push(ev),
      fetchImpl: fake.fetchImpl,
      spawnImpl: fake.spawnImpl,
    });
    await asr.warmup();

    // 逐步喂音频并让出事件循环：第一次 partial 请求会被门闩卡住
    await feedAsr(asr, tonePcm(1000), { yieldEach: true });
    for (let i = 0; i < 100 && !release; i += 1) await sleep(5);
    assert.ok(release, '第一个推理请求应已发出（partial）');

    // 卡住期间继续说话：partial 窗口应被跳过（skipWhileBusy）
    await feedAsr(asr, tonePcm(1000), { tMs: 1000, yieldEach: true });
    const skippedBeforeRelease = asr.stats().skippedPartials;
    assert.ok(skippedBeforeRelease >= 1, `busy 时应有 partial 被跳过，实际 ${skippedBeforeRelease}`);

    release();
    release = null;
    await feedAsr(asr, silencePcm(700), { tMs: 2000 });
    await asr.flush();

    const finals = finalsOf(events);
    assert.equal(finals.length, 1);
    assert.ok(asr.stats().skippedPartials >= 1);
    assert.ok(fake.calls() >= 2, '至少一次 partial + 一次 final 推理');
    await asr.close();
  } finally {
    if (release) release();
    await closeSharedServer();
  }
});

test('asr/whisper-local: 推理连接失败时重启 server 并重试一次', async () => {
  const port = 18803;
  let calls = 0;
  const fake = makeFakeWhisper({
    respond: () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed: socket hang up');
      return 'retry succeeded with gradient descent';
    },
  });
  try {
    const events = [];
    const asr = await createAsr({
      config: whisperConfig({ port }),
      log: () => {},
      onEvent: (ev) => events.push(ev),
      fetchImpl: fake.fetchImpl,
      spawnImpl: fake.spawnImpl,
    });
    await asr.warmup();
    assert.equal(fake.children.length, 1);

    await feedAsr(asr, tonePcm(800));
    await feedAsr(asr, silencePcm(600), { tMs: 800 });
    await asr.flush();

    const finals = finalsOf(events);
    assert.equal(finals.length, 1, '重启后第二次尝试应成功');
    assert.match(finals[0].text, /retry succeeded/);
    assert.equal(fake.children.length, 2, '应在推理失败后重启 whisper-server');
    assert.equal(fake.children[0].killed, true);
    assert.equal(fake.children[1].killed, false);
    assert.ok(asr.stats().server.restarts >= 1);
    await asr.close();
  } finally {
    await closeSharedServer();
  }
});

test('asr/whisper-local: 空音频/静音会话不产生 final，也不抛错', async () => {
  const port = 18804;
  const fake = makeFakeWhisper();
  try {
    const events = [];
    const asr = await createAsr({
      config: whisperConfig({ port }),
      log: () => {},
      onEvent: (ev) => events.push(ev),
      fetchImpl: fake.fetchImpl,
      spawnImpl: fake.spawnImpl,
    });
    await asr.warmup();
    await asr.push(Buffer.alloc(0), 0);
    await feedAsr(asr, silencePcm(1500));
    await asr.flush();
    assert.equal(events.length, 0);
    assert.equal(fake.calls(), 0, '静音不应触发推理');
    await asr.close();
  } finally {
    await closeSharedServer();
  }
});

// ================================================================ 真机（门控）

if (INTEGRATION) {
  test('asr/whisper-local 真机：say 生成英文语音 -> 识别出 gradient', { timeout: 300000 }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livedub-asr-live-'));
    const aiff = path.join(dir, 'speech.aiff');
    const wav = path.join(dir, 'speech.wav');
    execFileSync('say', [
      '-v',
      'Samantha',
      '-o',
      aiff,
      'Gradient descent is a first order iterative optimization algorithm. We repeatedly step in the opposite direction of the gradient.',
    ]);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    const { pcm } = pcmFromWav(fs.readFileSync(wav));
    assert.ok(pcm.length > RATE * 2 * 2, '生成音频应大于 2s');

    const modelPath = path.join(ROOT, 'models', 'ggml-large-v3-turbo-q5_0.bin');
    const port = 18771 + Math.floor(Math.random() * 20);
    const events = [];
    let asr = null;
    try {
      asr = await createAsr({
        config: {
          session: { sampleRate: RATE, langFrom: 'en' },
          asr: {
            provider: 'whisper-local',
            whisper: {
              bin: 'whisper-server',
              host: '127.0.0.1',
              port,
              models: [modelPath],
              language: 'en',
              threads: 6,
              startupTimeoutMs: 180000,
              requestTimeoutMs: 120000,
              vad: vadConfig(),
              partial: { enabled: true, intervalMs: 900, windowMs: 9000, minChars: 3, skipWhileBusy: true },
            },
          },
        },
        log: () => {},
        onEvent: (ev) => events.push({ ...ev, __wall: Date.now() }),
      });
      const warm = await asr.warmup();
      // 按真实时间喂入（100ms/块），这样才能测到 final 延迟与 partial 更新间隔
      const audioMs = Math.round((pcm.length / 2 / RATE) * 1000);
      const feed = await feedAsrRealtime(asr, pcm, { chunkMs: 100 });
      await asr.push(silencePcm(800), feed.endTMs);
      await sleep(800);
      const flushStart = Date.now();
      await asr.flush();
      const flushWall = Date.now() - flushStart;
      const finals = finalsOf(events);
      const partials = partialsOf(events);
      const partialStamps = partials.map((p) => p.__wall ?? 0).filter(Boolean);
      const partialIntervals = partialStamps.slice(1).map((w, i) => w - partialStamps[i]);
      const finalLatencies = finals.map((f) => {
        const audioEndWall = f.t1Ms <= feed.endTMs ? feed.startWall + f.t1Ms : feed.endWall + (f.t1Ms - feed.endTMs);
        return f.__wall ? f.__wall - audioEndWall : null;
      });
      const joined = finals.map((f) => f.text).join(' ');
      t.diagnostic(
        `whisper 真机：startup=${asr.stats().server.startupMs}ms（reused=${warm?.reused}），音频=${audioMs}ms，` +
          `final=${finals.length} 延迟=[${finalLatencies.join(', ')}]ms，partial=${partials.length} 间隔=[${partialIntervals.join(', ')}]ms，` +
          `infer=${asr.stats().avgFinalInferMs}ms(avg)，flush=${flushWall}ms，text="${joined}"`,
      );
      assert.ok(finals.length >= 1, '真机应识别出至少一句');
      assert.match(joined.toLowerCase(), /gradient/, `识别文本应包含 gradient，实际 "${joined}"`);
      for (const f of finals) {
        assert.ok(f.t1Ms > f.t0Ms, 't0/t1 必须是音频时间轴');
        assert.ok(f.t1Ms <= Math.round((pcm.length / 2 / RATE) * 1000) + 2000);
      }
      const stats = asr.stats();
      assert.ok(stats.lastFinalInferMs > 0);
    } finally {
      if (asr) await asr.close().catch(() => {});
      await closeSharedServer();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// 测试收尾：清理临时模型目录（closeSharedServer 已在各用例 finally 调用）
after(async () => {
  await closeSharedServer();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
