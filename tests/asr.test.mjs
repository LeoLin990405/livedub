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


// ---------------------------------------------------------------- speculative final（segmenter）

test('segmenter: speculative final —— 尾部静音触发 speculate，静音确认后 final 带 speculated 标记', () => {
  const { seg, events } = makeSegmenter({ speculative: true }, { enabled: false });
  feedPcm(seg, silencePcm(300));
  feedPcm(seg, tonePcm(800));
  feedPcm(seg, silencePcm(600));
  seg.flush();

  const specs = events.filter((e) => e.type === 'speculate');
  assert.equal(specs.length, 1, '尾部静音 120ms 应触发一次推测');
  const spec = specs[0];
  // 语音 300-1100ms，t0=100（preRoll 200）；推测点在静音 120ms -> t1≈1220
  assert.ok(Math.abs(spec.t0Ms - 100) <= 20, `推测 t0=${spec.t0Ms} 应≈100`);
  assert.ok(Math.abs(spec.t1Ms - 1220) <= 20, `推测 t1=${spec.t1Ms} 应≈1220`);
  assert.equal(pcmMs(spec.pcm), spec.t1Ms - spec.t0Ms);

  const finals = finalsOf(events);
  assert.equal(finals.length, 1);
  assert.equal(finals[0].speculated, true, 'final 应标记为推测复用');
  assert.equal(finals[0].speculationId, spec.id);
  assert.ok(Math.abs(finals[0].t1Ms - 1260) <= 20, `final t1=${finals[0].t1Ms} 应≈1260（含 tailPad）`);
  assert.equal(pcmMs(finals[0].pcm), finals[0].t1Ms - finals[0].t0Ms);
  assert.equal(seg.stats().speculations, 1);
});

test('segmenter: speculative final —— 语音恢复则作废推测，不产生额外 final，时间轴连续', () => {
  const { seg, events } = makeSegmenter({ speculative: true }, { enabled: false });
  feedPcm(seg, silencePcm(300));
  feedPcm(seg, tonePcm(600)); // 300-900
  feedPcm(seg, silencePcm(160)); // 900-1060：静音 120ms 时触发推测，随后语音恢复
  feedPcm(seg, tonePcm(600)); // 1060-1660
  feedPcm(seg, silencePcm(600)); // 1660-2260：再次触发推测并确认
  seg.flush();

  const specs = events.filter((e) => e.type === 'speculate');
  const cancels = events.filter((e) => e.type === 'speculateCancel');
  const finals = finalsOf(events);
  assert.equal(specs.length, 2, '两次尾部静音应各触发一次推测');
  assert.equal(cancels.length, 1, '语音恢复应作废一次推测');
  assert.equal(cancels[0].id, specs[0].id, '作废的应是第一次推测');
  assert.equal(finals.length, 1, '被作废的推测不得产生 final');
  assert.equal(finals[0].speculated, true);
  assert.equal(finals[0].speculationId, specs[1].id);
  // 时间轴连续：final 覆盖整句（含 160ms 句中停顿），t1 = 语音结束 1660 + tailPad 160
  assert.ok(Math.abs(finals[0].t0Ms - 100) <= 20);
  assert.ok(Math.abs(finals[0].t1Ms - 1820) <= 20, `final t1=${finals[0].t1Ms} 应≈1820`);
  assert.equal(pcmMs(finals[0].pcm), finals[0].t1Ms - finals[0].t0Ms);
  assert.equal(seg.stats().speculationCancels, 1);
});

test('segmenter: speculative final 默认关闭（未显式开启时不发 speculate 事件，行为与 v0.1 一致）', () => {
  const { seg, events } = makeSegmenter({}, { enabled: false });
  feedPcm(seg, silencePcm(300));
  feedPcm(seg, tonePcm(800));
  feedPcm(seg, silencePcm(600));
  seg.flush();
  assert.equal(events.filter((e) => e.type === 'speculate').length, 0);
  assert.equal(events.filter((e) => e.type === 'speculateCancel').length, 0);
  const finals = finalsOf(events);
  assert.equal(finals.length, 1);
  assert.equal(finals[0].speculated, undefined);
  assert.ok(Math.abs(finals[0].t1Ms - 1260) <= 20);
});

test('segmenter: speculative final —— 连续两句各自命中，final 不重不漏不重叠', () => {
  const { seg, events } = makeSegmenter({ speculative: true }, { enabled: false });
  feedPcm(seg, silencePcm(300));
  feedPcm(seg, tonePcm(600)); // 300-900
  feedPcm(seg, silencePcm(500)); // 900-1400 -> 第一句 final
  feedPcm(seg, tonePcm(600)); // 1400-2000
  feedPcm(seg, silencePcm(500)); // 2000-2500 -> 第二句 final
  seg.flush();

  const specs = events.filter((e) => e.type === 'speculate');
  const finals = finalsOf(events);
  assert.equal(specs.length, 2);
  assert.equal(finals.length, 2, '两句应各产生且仅产生一个 final');
  assert.ok(finals[0].speculated && finals[1].speculated);
  assert.equal(finals[0].speculationId, specs[0].id);
  assert.equal(finals[1].speculationId, specs[1].id);
  assert.ok(finals[1].t0Ms >= finals[0].t1Ms, 'final 不允许重叠');
  for (const f of finals) assert.equal(pcmMs(f.pcm), f.t1Ms - f.t0Ms);
  assert.equal(seg.stats().finals, 2);
});


test('segmenter: minSilence 280->220 使静音确认收句提前 60ms（音频时间轴确定性）', () => {
  const speechEndMs = 300 + 600; // 300ms 前静音 + 600ms 语音
  const measureConfirmDelay = (minSilenceMs) => {
    const { seg, events } = makeSegmenter({ minSilenceMs }, { enabled: false });
    feedPcm(seg, silencePcm(300));
    feedPcm(seg, tonePcm(600));
    const frameBytes = (20 / 1000) * RATE * 2;
    const silence = silencePcm(400);
    let fedMs = 0;
    for (let i = 0; i < silence.length; i += frameBytes) {
      seg.push(silence.subarray(i, i + frameBytes), speechEndMs + fedMs);
      fedMs += 20;
      if (finalsOf(events).length > 0) break;
    }
    const final = finalsOf(events)[0];
    assert.ok(final, `minSilence=${minSilenceMs} 应产生 final`);
    // final 在最后一帧静音处理完后发出：确认点 = 语音结束 + fedMs
    return { fedMs, final };
  };
  const a = measureConfirmDelay(280);
  const b = measureConfirmDelay(220);
  assert.equal(a.fedMs, 280, 'minSilence 280 应在语音结束后 280ms 确认');
  assert.equal(b.fedMs, 220, 'minSilence 220 应在语音结束后 220ms 确认');
  assert.equal(a.fedMs - b.fedMs, 60, '220 应比 280 提前 60ms 收句');
  // final 的音频边界一致（tailPad 150ms -> 160ms，且都已被 minSilence 覆盖），差异只在「发出时刻」
  assert.equal(a.final.t1Ms, b.final.t1Ms, '两档 minSilence 的 final 音频边界应相同');
  assert.equal(a.final.t1Ms, speechEndMs + 160, 't1 = 语音结束 + tailPad(160ms)');
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
  let abortedCount = 0;
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
      const signal = init?.signal;
      const run = (async () => {
        const file = init?.body?.get?.('file');
        const buf = file ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0);
        const audioMsExact = Math.max(0, Math.round(((buf.length - 44) / 2 / RATE) * 1000));
        let text;
        if (typeof respond === 'function') {
          text = await respond({ call: calls, audioMs: audioMsExact, form: init?.body });
        } else {
          text = audioMsExact >= 1000 ? 'gradient descent is an iterative optimization algorithm' : 'gradient descent';
        }
        return { text, audioMsExact };
      })();
      run.catch(() => {}); // 外层 abort 时不产生 unhandled rejection
      // 模拟真实 fetch：signal abort 时立刻 reject（用于验证推测取消的真正 abort）
      let out;
      try {
        out = await new Promise((resolve, reject) => {
          const onAbort = () => {
            abortedCount += 1;
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          };
          if (signal?.aborted) return onAbort();
          signal?.addEventListener?.('abort', onAbort, { once: true });
          run.then(
            (v) => {
              signal?.removeEventListener?.('abort', onAbort);
              resolve(v);
            },
            (err) => {
              signal?.removeEventListener?.('abort', onAbort);
              reject(err);
            },
          );
        });
      } catch (err) {
        throw err;
      }
      // 支持 respond 返回 { httpError: 400 } 模拟非重试型失败 / { text } 自定义文本
      const text = out.text;
      if (text && typeof text === 'object') {
        if (text.httpError) return jsonResponse({ error: 'forced failure' }, text.httpError);
        return jsonResponse({ text: String(text.text ?? '') });
      }
      return jsonResponse({ text });
    }
    return new Response('not found', { status: 404 });
  };
  return { spawnImpl, fetchImpl, children, calls: () => calls, alive, aborted: () => abortedCount };
}

function whisperConfig({ port, vad = {}, partial = {}, modelPath = fakeModelPath, speculativeFinal, speculativeMinInferenceMs } = {}) {
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
        ...(speculativeFinal !== undefined ? { speculativeFinal } : {}),
        ...(speculativeMinInferenceMs !== undefined ? { speculativeMinInferenceMs } : {}),
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


// ---------------------------------------------------------------- speculative final（ASR 层）

test('asr/whisper-local: speculative final 命中 —— 只推理一次，final 直接复用推测结果', async () => {
  const port = 18811;
  const fake = makeFakeWhisper();
  const events = [];
  try {
    const asr = await createAsr({
      config: whisperConfig({ port, partial: { enabled: false }, speculativeFinal: true }),
      log: () => {},
      onEvent: (ev) => events.push(ev),
      fetchImpl: fake.fetchImpl,
      spawnImpl: fake.spawnImpl,
    });
    await asr.warmup();
    await feedAsr(asr, silencePcm(300));
    await feedAsr(asr, tonePcm(800), { tMs: 300 });
    await feedAsr(asr, silencePcm(600), { tMs: 1100 });
    await asr.flush();

    const finals = finalsOf(events);
    assert.equal(finals.length, 1, '应只有一条 final');
    assert.equal(fake.calls(), 1, '推测已提前推理，final 不应重复推理');
    const stats = asr.stats();
    assert.equal(stats.speculations, 1);
    assert.equal(stats.speculationHits, 1);
    assert.equal(stats.speculationCancels, 0);
    assert.equal(stats.speculationFailed, 0);
    assert.ok(stats.lastSpeculationSavedMs >= 0, '应记录推测节省时间估算');
    assert.match(finals[0].text, /gradient descent/);
    assert.ok(Math.abs(finals[0].t0Ms - 100) <= 20, `final t0=${finals[0].t0Ms} 应≈100`);
    assert.ok(Math.abs(finals[0].t1Ms - 1260) <= 20, `final t1=${finals[0].t1Ms} 应≈1260`);
    await asr.close();
  } finally {
    await closeSharedServer();
  }
});

test('asr/whisper-local: speculative final 取消 —— 语音恢复后作废，最终只发一次 final', async () => {
  const port = 18812;
  const fake = makeFakeWhisper();
  const events = [];
  try {
    const asr = await createAsr({
      config: whisperConfig({
        port,
        vad: { minSilenceMs: 400 },
        partial: { enabled: false },
        speculativeFinal: true,
      }),
      log: () => {},
      onEvent: (ev) => events.push(ev),
      fetchImpl: fake.fetchImpl,
      spawnImpl: fake.spawnImpl,
    });
    await asr.warmup();
    await feedAsr(asr, silencePcm(300));
    await feedAsr(asr, tonePcm(600), { tMs: 300 }); // 300-900
    await feedAsr(asr, silencePcm(180), { tMs: 900 }); // 句中停顿：触发推测后语音恢复
    await feedAsr(asr, tonePcm(600), { tMs: 1080 }); // 1080-1680
    await feedAsr(asr, silencePcm(700), { tMs: 1680 }); // 句尾确认
    await asr.flush();

    const finals = finalsOf(events);
    assert.equal(finals.length, 1, '作废的推测不得产生 final');
    assert.equal(fake.calls(), 2, '第一次推测 + 第二次推测各推理一次，final 复用第二次');
    const stats = asr.stats();
    assert.equal(stats.speculations, 2);
    assert.equal(stats.speculationCancels, 1);
    assert.equal(stats.speculationHits, 1);
    assert.equal(stats.speculationFailed, 0);
    assert.ok(Math.abs(finals[0].t0Ms - 100) <= 20, `t0=${finals[0].t0Ms} 应≈100（时间轴连续）`);
    assert.ok(Math.abs(finals[0].t1Ms - 1840) <= 20, `t1=${finals[0].t1Ms} 应≈1680+160`);
    await asr.close();
  } finally {
    await closeSharedServer();
  }
});

test('asr/whisper-local: speculative final —— flush 时在途推测可直接复用', async () => {
  const port = 18813;
  const fake = makeFakeWhisper();
  const events = [];
  try {
    const asr = await createAsr({
      config: whisperConfig({
        port,
        vad: { minSilenceMs: 600 },
        partial: { enabled: false },
        speculativeFinal: true,
      }),
      log: () => {},
      onEvent: (ev) => events.push(ev),
      fetchImpl: fake.fetchImpl,
      spawnImpl: fake.spawnImpl,
    });
    await asr.warmup();
    await feedAsr(asr, silencePcm(300));
    await feedAsr(asr, tonePcm(800), { tMs: 300 });
    await feedAsr(asr, silencePcm(200), { tMs: 1100 }); // 静音 120ms 触发推测，但未到 600ms 确认
    await asr.flush(); // 暂停/seek 路径：立即落句

    const finals = finalsOf(events);
    assert.equal(finals.length, 1);
    assert.equal(fake.calls(), 1, 'flush 应复用推测结果，不重复推理');
    assert.equal(asr.stats().speculationHits, 1);
    assert.ok(Math.abs(finals[0].t1Ms - 1260) <= 20, `t1=${finals[0].t1Ms} 应≈1260`);
    await asr.close();
  } finally {
    await closeSharedServer();
  }
});

test('asr/whisper-local: speculative final 推理失败 -> 回退普通推理，final 不丢', async () => {
  const port = 18814;
  const fake = makeFakeWhisper({
    respond: ({ call }) => (call === 1 ? { httpError: 400 } : 'fallback final text about gradient descent'),
  });
  const events = [];
  try {
    const asr = await createAsr({
      config: whisperConfig({ port, partial: { enabled: false }, speculativeFinal: true }),
      log: () => {},
      onEvent: (ev) => events.push(ev),
      fetchImpl: fake.fetchImpl,
      spawnImpl: fake.spawnImpl,
    });
    await asr.warmup();
    await feedAsr(asr, silencePcm(300));
    await feedAsr(asr, tonePcm(800), { tMs: 300 });
    await feedAsr(asr, silencePcm(600), { tMs: 1100 });
    await asr.flush();

    const finals = finalsOf(events);
    assert.equal(finals.length, 1, '推测失败后 final 仍必须产生');
    assert.match(finals[0].text, /fallback final text/);
    assert.equal(fake.calls(), 2, '推测失败一次 + final 回退推理一次');
    const stats = asr.stats();
    assert.equal(stats.speculationFailed, 1);
    assert.equal(stats.speculationHits, 0);
    assert.equal(stats.speculationMisses, 1);
    await asr.close();
  } finally {
    await closeSharedServer();
  }
});

test('asr/whisper-local: speculativeFinal=false 时无推测请求（行为与 v0.1 一致）', async () => {
  const port = 18815;
  const fake = makeFakeWhisper();
  const events = [];
  try {
    const asr = await createAsr({
      config: whisperConfig({ port, partial: { enabled: false }, speculativeFinal: false }),
      log: () => {},
      onEvent: (ev) => events.push(ev),
      fetchImpl: fake.fetchImpl,
      spawnImpl: fake.spawnImpl,
    });
    await asr.warmup();
    await feedAsr(asr, silencePcm(300));
    await feedAsr(asr, tonePcm(800), { tMs: 300 });
    await feedAsr(asr, silencePcm(600), { tMs: 1100 });
    await asr.flush();

    const finals = finalsOf(events);
    assert.equal(finals.length, 1);
    assert.equal(fake.calls(), 1, '关闭推测后只应有 final 一次推理');
    assert.equal(asr.stats().speculations, 0);
    assert.equal(asr.stats().speculative.enabled, false);
    await asr.close();
  } finally {
    await closeSharedServer();
  }
});


test('asr/whisper-local: 默认关闭 speculative final（未显式开启时零推测、零额外请求）', async () => {
  const port = 18817;
  const fake = makeFakeWhisper();
  const events = [];
  try {
    const asr = await createAsr({
      config: whisperConfig({ port, partial: { enabled: false } }), // 不传 speculativeFinal -> 默认关闭
      log: () => {},
      onEvent: (ev) => events.push(ev),
      fetchImpl: fake.fetchImpl,
      spawnImpl: fake.spawnImpl,
    });
    await asr.warmup();
    await feedAsr(asr, silencePcm(300));
    await feedAsr(asr, tonePcm(800), { tMs: 300 });
    await feedAsr(asr, silencePcm(600), { tMs: 1100 });
    await asr.flush();

    const finals = finalsOf(events);
    assert.equal(finals.length, 1);
    assert.equal(fake.calls(), 1, '默认关闭时只应有一次 final 推理（无推测请求）');
    const stats = asr.stats();
    assert.equal(stats.speculations, 0);
    assert.equal(stats.speculative.enabled, false);
    assert.equal(stats.speculationGateBlocked, 0);
    assert.ok(Math.abs(finals[0].t1Ms - 1260) <= 20, '默认路径 final 边界与 v0.1 一致');
    await asr.close();
  } finally {
    await closeSharedServer();
  }
});

test('asr/whisper-local: opt-in 后按实测推理耗时自动关闭推测（speculativeMinInferenceMs）', async () => {
  const port = 18818;
  // 每次推理 40ms，模拟「慢于门限 30ms」的模型
  const fake = makeFakeWhisper({
    respond: async ({ audioMs }) => {
      await sleep(40);
      return audioMs >= 1000 ? 'gradient descent is an iterative optimization algorithm' : 'gradient descent';
    },
  });
  const events = [];
  try {
    const asr = await createAsr({
      config: whisperConfig({
        port,
        partial: { enabled: false },
        speculativeFinal: true,
        speculativeMinInferenceMs: 30,
      }),
      log: () => {},
      onEvent: (ev) => events.push(ev),
      fetchImpl: fake.fetchImpl,
      spawnImpl: fake.spawnImpl,
    });
    await asr.warmup();
    // 两句话，每句 300ms 前静音 + 600ms 语音 + 700ms 尾静音（每块 1600ms）。
    // 真实流是实时的：第一句推理/EMA 更新完成后再来第二句，否则两条推测会在测量前就接连触发。
    for (const base of [0, 1600]) {
      await feedAsr(asr, silencePcm(300), { tMs: base });
      await feedAsr(asr, tonePcm(600), { tMs: base + 300 });
      await feedAsr(asr, silencePcm(700), { tMs: base + 900 });
      await sleep(200); // 等第一句 final 完成，EMA 生效
    }
    await asr.flush();

    const finals = finalsOf(events);
    assert.equal(finals.length, 2);
    assert.ok(finals[1].t0Ms >= finals[0].t1Ms, 'final 不允许重叠');
    const stats = asr.stats();
    // 第一句：无测量值时允许一次推测并命中；EMA≈40ms > 30ms 后门限关闭
    assert.ok(stats.speculationHits >= 1, `第一句应命中推测，stats=${JSON.stringify(stats.speculative)}`);
    assert.ok(stats.speculationGateBlocked >= 1, '第二句应被推理耗时门限拦住');
    assert.equal(stats.speculative.gateOpen, false);
    assert.ok(stats.speculative.emaInferMs > 30, `EMA=${stats.speculative.emaInferMs} 应 > 30`);
    await asr.close();
  } finally {
    await closeSharedServer();
  }
});

test('asr/whisper-local: 取消在途推测会真正 abort 请求，不阻塞后续 final', async () => {
  const port = 18819;
  // 每个请求 200ms，保证语音恢复时推测仍在途
  const fake = makeFakeWhisper({
    respond: async ({ audioMs }) => {
      await sleep(200);
      return audioMs >= 1000 ? 'gradient descent is an iterative optimization algorithm' : 'gradient descent';
    },
  });
  const events = [];
  try {
    const asr = await createAsr({
      config: whisperConfig({
        port,
        vad: { minSilenceMs: 600 },
        partial: { enabled: false },
        speculativeFinal: true,
        speculativeMinInferenceMs: 0, // 强制开启，验证 abort 而非门限
      }),
      log: () => {},
      onEvent: (ev) => events.push(ev),
      fetchImpl: fake.fetchImpl,
      spawnImpl: fake.spawnImpl,
    });
    await asr.warmup();
    await feedAsr(asr, silencePcm(300));
    await feedAsr(asr, tonePcm(600), { tMs: 300 }); // 300-900
    await feedAsr(asr, silencePcm(180), { tMs: 900 }); // 触发推测后 60ms 语音恢复 -> abort
    await feedAsr(asr, tonePcm(600), { tMs: 1080 }); // 1080-1680
    await feedAsr(asr, silencePcm(900), { tMs: 1680 }); // 句尾确认
    await asr.flush();

    const finals = finalsOf(events);
    assert.equal(finals.length, 1, '作废的推测不得产生 final');
    assert.ok(fake.aborted() >= 1, '取消时应真正 abort 在途 fetch');
    const stats = asr.stats();
    assert.ok(stats.speculationAborts >= 1, `应记录 abort，实际 ${stats.speculationAborts}`);
    assert.equal(stats.speculationFailed, 0, 'abort 不应记为失败');
    assert.equal(stats.speculationHits, 1);
    assert.match(finals[0].text, /gradient descent/);
    assert.ok(Math.abs(finals[0].t1Ms - 1840) <= 20, `t1=${finals[0].t1Ms} 应≈1840`);
    await asr.close();
  } finally {
    await closeSharedServer();
  }
});

test('asr/whisper-local: 尾部静音/推测期间跳过 partial（不抢推理）', async () => {
  const port = 18816;
  const fake = makeFakeWhisper();
  const events = [];
  try {
    const asr = await createAsr({
      config: whisperConfig({
        port,
        partial: { enabled: true, intervalMs: 100, windowMs: 1500 },
        speculativeFinal: true,
      }),
      log: () => {},
      onEvent: (ev) => events.push(ev),
      fetchImpl: fake.fetchImpl,
      spawnImpl: fake.spawnImpl,
    });
    await asr.warmup();
    await feedAsr(asr, silencePcm(300));
    await feedAsr(asr, tonePcm(1200), { tMs: 300 });
    await feedAsr(asr, silencePcm(700), { tMs: 1500 });
    await asr.flush();

    const finals = finalsOf(events);
    assert.equal(finals.length, 1);
    const stats = asr.stats();
    assert.equal(stats.speculationHits, 1);
    assert.ok(stats.skippedPartialsTail >= 1, `尾部静音期间应有 partial 被跳过，实际 ${stats.skippedPartialsTail}`);
    await asr.close();
  } finally {
    await closeSharedServer();
  }
});

// ================================================================ 真机（门控）

if (INTEGRATION) {
  test(
    'asr/whisper-local 真机：默认关闭回到 v0.1 延迟 + minSilence 280/220 + opt-in 门限',
    { timeout: 480000 },
    async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livedub-asr-live-'));
      const mkClip = (text, name) => {
        const aiff = path.join(dir, `${name}.aiff`);
        const wav = path.join(dir, `${name}.wav`);
        execFileSync('say', ['-v', 'Samantha', '-o', aiff, text]);
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
        return pcmFromWav(fs.readFileSync(wav)).pcm;
      };
      // 去掉 say 自带的头尾静音，保证拼接后的停顿时长可控
      const trimSilence = (pcm, { threshold = 0.01, padMs = 20 } = {}) => {
        const samples = pcm.length / 2;
        const amp = (i) => Math.abs(pcm.readInt16LE(i * 2)) / 0x8000;
        let a = 0;
        let b = samples - 1;
        while (a < b && amp(a) < threshold) a += 1;
        while (b > a && amp(b) < threshold) b -= 1;
        const pad = Math.round((padMs / 1000) * RATE);
        return pcm.subarray(Math.max(0, a - pad) * 2, Math.min(samples - 1, b + pad) * 2);
      };
      const modelPath = path.join(ROOT, 'models', 'ggml-large-v3-turbo-q5_0.bin');
      const port = 18789; // 固定端口：所有轮次复用同一个共享 whisper-server（只加载一次模型）
      const TAIL_PAD_MS = 160; // tailPadMs=150 -> 8 帧 = 160ms
      const PAUSE_MS = 180; // 句中停顿（含 clip 边缘的少量数字静音，实际 ~200-220ms）
      const TAIL_SILENCE_MS = 700;
      try {
        const clip1 = trimSilence(mkClip('Gradient descent is a first order iterative optimization algorithm.', 'clip1'));
        const clip2 = trimSilence(mkClip('We repeatedly step in the opposite direction of the gradient.', 'clip2'));
        // 延迟对比用单句音频（无句中停顿），避免停顿时长影响 minSilence 对比的有效性
        const latencyAudio = Buffer.concat([clip1, silencePcm(TAIL_SILENCE_MS)]);
        // 安全性探针：句中有 180ms 停顿（+ clip 边缘静音），minSilence 越小越有切碎风险
        const safetyAudio = Buffer.concat([clip1, silencePcm(PAUSE_MS), clip2, silencePcm(TAIL_SILENCE_MS)]);
        // opt-in 门限验证用两句，句间 1400ms 静音
        const doubleAudio = Buffer.concat([safetyAudio, silencePcm(700), safetyAudio]);

        const runRound = async ({ speculativeFinal, minSilenceMs, audio: roundAudio = latencyAudio, label }) => {
          const events = [];
          const logs = [];
          const asr = await createAsr({
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
                  // 默认不传 speculativeFinal -> 走内部默认关闭（v0.1 行为）
                  ...(speculativeFinal !== undefined ? { speculativeFinal } : {}),
                  vad: vadConfig({ minSilenceMs, maxUtteranceMs: 30000 }),
                  // 对比实验关掉 partial，避免 partial 推理占用 server 干扰 final 延迟测量
                  partial: { enabled: false, intervalMs: 1500, windowMs: 9000, minChars: 6, skipWhileBusy: true },
                },
              },
            },
            log: (m) => logs.push({ wall: Date.now(), msg: m }),
            onEvent: (ev) => events.push({ ...ev, __wall: Date.now() }),
          });
          try {
            const warm = await asr.warmup();
            const feed = await feedAsrRealtime(asr, roundAudio, { chunkMs: 100 });
            await asr.flush();
            const finals = finalsOf(events).map((f) => ({
              t0Ms: f.t0Ms,
              t1Ms: f.t1Ms,
              text: f.text,
              // 语音结束 ≈ t1 - tailPad；对照它是「用户说完」的墙钟时刻
              latencyMs: f.__wall - (feed.startWall + (f.t1Ms - TAIL_PAD_MS)),
            }));
            const avgInferMs = asr.stats().avgFinalInferMs;
            return { label, speculativeFinal, minSilenceMs, finals, stats: asr.stats(), warm, avgInferMs };
          } finally {
            await asr.close().catch(() => {});
          }
        };

        // 0) 热推理 warm-up（首轮第一次推理明显偏慢，丢弃不进对比）
        await runRound({ minSilenceMs: 280, audio: latencyAudio, label: 'warm-up (discard)' });
        // 1) 默认关闭 + 单句延迟：minSilence 280 vs 220 交替两轮，抵消热缓存漂移
        const lat280a = await runRound({ minSilenceMs: 280, audio: latencyAudio, label: 'lat/280 #1' });
        const lat220a = await runRound({ minSilenceMs: 220, audio: latencyAudio, label: 'lat/220 #1' });
        const lat280b = await runRound({ minSilenceMs: 280, audio: latencyAudio, label: 'lat/280 #2' });
        const lat220b = await runRound({ minSilenceMs: 220, audio: latencyAudio, label: 'lat/220 #2' });
        // 2) 安全性探针：同一段含 180ms 句中停顿的音频，看 280/260/220 是否切碎
        const safe280 = await runRound({ minSilenceMs: 280, audio: safetyAudio, label: 'safe/280' });
        const safe260 = await runRound({ minSilenceMs: 260, audio: safetyAudio, label: 'safe/260' });
        const safe220 = await runRound({ minSilenceMs: 220, audio: safetyAudio, label: 'safe/220' });
        // 3) opt-in 门限：显式开启，默认 speculativeMinInferenceMs=250；大模型推理 ~1.4s -> 命中一次后自动关闭
        const optIn = await runRound({ minSilenceMs: 300, speculativeFinal: true, audio: doubleAudio, label: 'opt-in/gated' });

        const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
        const perFinalLat = (r) => (r.finals.length ? r.finals.map((f) => f.latencyMs) : []);
        const lat280 = avg([...perFinalLat(lat280a), ...perFinalLat(lat280b)]);
        const lat220 = avg([...perFinalLat(lat220a), ...perFinalLat(lat220b)]);
        // 去掉推理耗时抖动：latency - inferMs ≈ VAD 静音确认等待（280 vs 220，确定性相差 60ms）
        const waitOf = (r) => avg(r.finals.map((f) => f.latencyMs - (r.avgInferMs ?? 0)));
        const wait280 = avg([waitOf(lat280a), waitOf(lat280b)]);
        const wait220 = avg([waitOf(lat220a), waitOf(lat220b)]);
        const latencyRounds = [lat280a, lat220a, lat280b, lat220b];
        const allRounds = latencyRounds.concat([safe280, safe260, safe220, optIn]);
        const pids = new Set(allRounds.map((r) => r.stats.server.pid));
        const inferAvg = avg(
          latencyRounds
            .map((r) => r.stats.avgFinalInferMs)
            .filter((v) => Number.isFinite(v)),
        );
        const onStats = optIn.stats;

        t.diagnostic(
          `默认关闭（真机）：单句 final 延迟 minSilence=280 -> ${lat280.toFixed(0)}ms，220 -> ${lat220.toFixed(0)}ms；` +
            `扣除推理后的 VAD 等待 280=${wait280.toFixed(0)}ms，220=${wait220.toFixed(0)}ms（差 ${(wait280 - wait220).toFixed(0)}ms）；` +
            `final 推理 avg=${inferAvg.toFixed(0)}ms；startup=${optIn.stats.server.startupMs}ms，服务 pid=${[...pids].join('/')}（唯一=只加载一次模型）`,
        );
        t.diagnostic(
          `安全性探针（句中停顿 180ms + clip 边缘静音，实际静音约 200-220ms）：` +
            `minSilence=280 final 数=${safe280.finals.length}，260 final 数=${safe260.finals.length}，220 final 数=${safe220.finals.length}`,
        );
        t.diagnostic(
          `opt-in 门限（speculativeFinal=true, speculativeMinInferenceMs=${onStats.speculative.minInferenceMs}ms）：` +
            `speculations=${onStats.speculations} hits=${onStats.speculationHits} cancels=${onStats.speculationCancels} aborts=${onStats.speculationAborts} ` +
            `gateBlocked=${onStats.speculationGateBlocked} gateOpen=${onStats.speculative.gateOpen} EMA=${onStats.speculative.emaInferMs}ms；` +
            `final 延迟=[${optIn.finals.map((f) => f.latencyMs.toFixed(0)).join(', ')}]ms`,
        );
        t.diagnostic(`识别文本（默认关闭）："${lat280a.finals.map((f) => f.text).join(' ')}"`);

        // ---- 结构性断言 ----
        for (const round of latencyRounds) {
          assert.equal(round.finals.length, 1, `${round.label} 单句音频应只产生一句`);
          assert.equal(round.stats.speculations, 0, `${round.label} 默认关闭时不应有推测`);
          assert.equal(round.stats.speculative.enabled, false);
          const joined = round.finals.map((f) => f.text).join(' ').toLowerCase();
          assert.match(joined, /gradient/, `${round.label} 识别文本应包含 gradient`);
        }
        assert.equal(pids.size, 1, '所有轮次应复用同一个共享 whisper-server（不重复加载模型）');
        // 默认路径确认回到 v0.1 水平（真机 soft 上限；v0.1 实测中位 ~2.1s）
        assert.ok(lat280 <= 3200, `默认关闭下 final 延迟应回到 v0.1 量级，实际 ${lat280}ms`);
        // minSilence 280 -> 220 的确定性收益是 VAD 等待 -60ms（推理抖动大，故用 wait 比较；soft 阈值 20ms）
        assert.ok(
          Number.isFinite(wait280) && Number.isFinite(wait220) && wait280 - wait220 >= 20,
          `minSilence 220 的 VAD 等待应比 280 少 >=20ms（280=${wait280}ms 220=${wait220}ms）`,
        );
        assert.ok(Number.isFinite(lat220) && lat220 <= lat280 + 250, `minSilence 220 墙钟延迟不应显著变差（280=${lat280}ms 220=${lat220}ms）`);
        // 180ms 句中停顿在默认 280ms 下必须保持同一句（安全基线）
        assert.equal(safe280.finals.length, 1, '默认 minSilence=280 不应切碎 180ms 句中停顿');
        assert.match(safe280.finals.map((f) => f.text).join(' ').toLowerCase(), /opposite direction/, '安全基线应完整识别两句');

        // ---- opt-in 门限断言：允许一次推测（无测量值），命中后按实测推理耗时关闭 ----
        assert.equal(optIn.finals.length, 2, 'opt-in 轮喂了两句，应产生两个 final');
        assert.ok(onStats.speculations >= 1, 'opt-in 后第一句应允许一次推测');
        assert.ok(onStats.speculationHits >= 1, '第一句句尾停顿应命中推测');
        assert.ok(onStats.speculationAborts >= 1, '句中停顿的推测应被真正 abort（不阻塞队列）');
        assert.ok(onStats.speculationGateBlocked >= 1, '第二句应被推理耗时门限拦住');
        assert.equal(onStats.speculative.gateOpen, false);
        assert.ok(onStats.speculative.emaInferMs > onStats.speculative.minInferenceMs, '大模型实测推理耗时应高于门限');
        assert.equal(onStats.speculationFailed, 0, '真机推测/abort 不应记为失败');
      } finally {
        await closeSharedServer();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
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
