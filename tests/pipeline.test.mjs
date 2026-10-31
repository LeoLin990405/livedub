import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMockAsr,
  createMockTranslator,
  createMockTts,
  createMockScheduler,
  createMockVoiceManager,
} from '../engine/mock.mjs';
import { createSession } from '../engine/pipeline.mjs';
import { silencePcm, makeTonePcm, sleep } from './helpers.mjs';

const SAMPLE_RATE = 16000;
const CHUNK_MS = 100;
const CHUNK_BYTES = (SAMPLE_RATE * CHUNK_MS * 2) / 1000;

function makeConfig(overrides = {}) {
  const base = {
    asr: { provider: 'mock' },
    translate: { provider: 'mock', chain: ['mock'], contextSegments: 3, maxTokens: 100, timeoutMs: 2000 },
    tts: {
      provider: 'mock',
      sampleRate: 24000,
      speed: 1,
      voiceMode: 'preset',
      presetVoices: { default: 'mock-female', female: 'mock-female', male: 'mock-male' },
      clone: { minSampleSec: 1, maxSampleSec: 45 },
      chunk: { minClauseChars: 8, maxChunkChars: 80 },
    },
    dub: { enabled: true, duckOriginal: 0.18, maxLagMs: 4000, maxAccelerate: 1.25, minGapMs: 60 },
    mock: {
      asrScript: [
        { text: 'Today we are going to learn about gradient descent.', durMs: 2400 },
        { text: 'It is a first order iterative optimization algorithm.', durMs: 2600 },
        { text: 'We repeatedly step in the opposite direction of the gradient.', durMs: 3000 },
      ],
      translations: {
        'today we are going to learn about gradient descent.': '今天我们来学习梯度下降。',
        'it is a first order iterative optimization algorithm.': '它是一种一阶迭代优化算法。',
        'we repeatedly step in the opposite direction of the gradient.': '我们反复朝着梯度的反方向迈步。',
      },
      translateDelayMs: 1,
      cloneFails: false,
    },
    glossary: [{ src: 'gradient descent', dst: '梯度下降' }],
  };
  return deepMerge(base, overrides);
}

function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? deepMerge(a[k], v) : v;
  }
  return out;
}

function makeDeps(config) {
  return {
    config,
    createAsr: (opts) => createMockAsr({ ...opts, config }),
    createTranslator: (opts) => createMockTranslator({ ...opts, config }),
    createTts: (opts) => createMockTts({ ...opts, config }),
    createScheduler: (opts) => createMockScheduler({ ...opts, config }),
    createVoiceManager: (opts) => createMockVoiceManager({ ...opts, config }),
    splitForTtsFallback: (text, opts) => {
      const src = String(text ?? '').trim();
      const parts = src.match(/[^。！？；;.!?]+[。！？；;.!?]?/g) ?? [src];
      return parts.map((s) => s.trim()).filter(Boolean);
    },
  };
}

function makeRecorder() {
  const events = [];
  const listeners = [];
  return {
    events,
    emit(event) {
      events.push(event);
      for (const fn of listeners) fn(event);
    },
    waitFor(predicate, { timeout = 4000, label = 'event' } = {}) {
      const found = events.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.splice(listeners.indexOf(onEvent), 1);
          reject(new Error(`timeout waiting for ${label}; events=${events.map((e) => e.type).join(',')}`));
        }, timeout);
        const onEvent = (event) => {
          if (!predicate(event)) return;
          clearTimeout(timer);
          listeners.splice(listeners.indexOf(onEvent), 1);
          resolve(event);
        };
        listeners.push(onEvent);
      });
    },
    count(type) {
      return events.filter((e) => e.type === type).length;
    },
    of(type) {
      return events.filter((e) => e.type === type);
    },
  };
}

async function feedAudio(session, totalMs, { chunkMs = CHUNK_MS, onChunk } = {}) {
  const chunk = silencePcm(chunkMs, SAMPLE_RATE);
  for (let t = 0; t < totalMs; t += chunkMs) {
    session.onAudio(chunk, t);
    onChunk?.(t);
    if (t % (chunkMs * 5) === 0) await new Promise((r) => setTimeout(r, 0));
  }
}

async function openSession(configOverrides = {}, depsOverride = null) {
  const config = makeConfig(configOverrides);
  const recorder = makeRecorder();
  const session = await createSession({
    id: 'test-session',
    options: { source: 'test', langFrom: 'en', langTo: 'zh' },
    emit: (e) => recorder.emit(e),
    log: () => {},
    deps: depsOverride ? depsOverride(config) : makeDeps(config),
  });
  return { session, recorder, config };
}

test('pipeline: mock end-to-end produces segment -> translation -> dub -> metrics -> bye', async () => {
  const { session, recorder } = await openSession();
  const ready = await recorder.waitFor((e) => e.type === 'ready', { label: 'ready' });
  assert.equal(ready.protocol, 1);
  assert.equal(ready.providers.asr, 'mock');

  await feedAudio(session, 8200);
  const segment = await recorder.waitFor((e) => e.type === 'segment' && e.id === 1, { label: 'segment' });
  assert.match(segment.text, /gradient descent/);
  assert.equal(segment.lang, 'en');

  const translation = await recorder.waitFor((e) => e.type === 'translation' && e.id === 1 && e.final, { label: 'translation final' });
  assert.match(translation.text, /梯度下降/);

  const dub = await recorder.waitFor((e) => e.type === 'dub' && e.id === 1 && e.pcm && e.pcm.length > 0, { label: 'dub audio' });
  assert.equal(dub.format, 's16le');
  assert.equal(dub.sampleRate, 24000);
  assert.ok(dub.durationMs > 0);
  assert.ok(Buffer.from(dub.pcm, 'base64').length > 0);

  const finalDub = await recorder.waitFor((e) => e.type === 'dub' && e.id === 1 && e.final, { label: 'dub final' });
  assert.equal(finalDub.pcm, '');

  const metrics = await recorder.waitFor((e) => e.type === 'metrics' && e.id === 1, { label: 'metrics' });
  assert.ok(Number.isFinite(metrics.e2eLagMs));
  assert.ok(metrics.e2eLagMs >= 0);

  await recorder.waitFor((e) => e.type === 'segment' && e.id === 3, { label: '3 segments' });
  await recorder.waitFor((e) => e.type === 'translation' && e.id === 3 && e.final, { label: '3 translations' });
  assert.ok(recorder.count('segment') >= 3);
  assert.ok(recorder.count('translation') >= 3);
  const statuses = recorder.of('status').map((e) => e.state);
  assert.ok(statuses.includes('listening'));
  assert.ok(statuses.includes('translating'));

  await session.close('test done');
  const bye = await recorder.waitFor((e) => e.type === 'bye', { label: 'bye' });
  assert.equal(bye.reason, 'test done');
});

test('pipeline: glossary update + ping/pong + config patch', async () => {
  const { session, recorder } = await openSession();
  await recorder.waitFor((e) => e.type === 'ready', { label: 'ready' });
  session.onJson({ type: 'glossary', terms: [{ src: 'a', dst: 'b' }, { src: 'c', dst: 'd' }] });
  assert.equal(session.stats().glossaryTerms, 2);
  session.onJson({ type: 'ping', t: 42 });
  const pong = await recorder.waitFor((e) => e.type === 'pong', { label: 'pong' });
  assert.equal(pong.t, 42);
  session.onJson({ type: 'config', patch: { dub: { enabled: false } } });
  assert.equal(session.config.dub.enabled, false);
  await session.close('done');
});

test('pipeline: dub disabled still delivers subtitles', async () => {
  const { session, recorder } = await openSession({ dub: { enabled: false } });
  await recorder.waitFor((e) => e.type === 'ready', { label: 'ready' });
  await feedAudio(session, 5200);
  await recorder.waitFor((e) => e.type === 'translation' && e.id === 1 && e.final, { label: 'translation' });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(recorder.count('dub'), 0);
  await session.close('done');
});

test('pipeline: translation failure is isolated (error event, no dub, session alive)', async () => {
  const config = makeConfig();
  const recorder = makeRecorder();
  const session = await createSession({
    id: 'test-translate-fail',
    options: { source: 'test' },
    emit: (e) => recorder.emit(e),
    log: () => {},
    deps: {
      ...makeDeps(config),
      createTranslator: () => ({
        name: 'broken-translator',
        async translate() {
          throw new Error('boom');
        },
      }),
    },
  });
  await recorder.waitFor((e) => e.type === 'ready', { label: 'ready' });
  await feedAudio(session, 5200);
  const err = await recorder.waitFor((e) => e.type === 'error' && e.scope === 'translate', { label: 'translate error' });
  assert.match(err.message, /boom/);
  assert.equal(recorder.count('dub'), 0);
  assert.ok(recorder.count('segment') >= 1);
  assert.equal(session.state, 'ready');
  await session.close('done');
});

test('pipeline: tts failure keeps subtitles and session alive', async () => {
  const config = makeConfig();
  const recorder = makeRecorder();
  const deps = makeDeps(config);
  const session = await createSession({
    id: 'test-tts-fail',
    options: { source: 'test' },
    emit: (e) => recorder.emit(e),
    log: () => {},
    deps: {
      ...deps,
      createTts: () => ({
        name: 'broken-tts',
        async synthesize() {
          throw new Error('tts-down');
        },
        async listVoices() {
          return [];
        },
        async cloneVoice() {
          throw new Error('no clone');
        },
      }),
    },
  });
  await recorder.waitFor((e) => e.type === 'ready', { label: 'ready' });
  await feedAudio(session, 5200);
  await recorder.waitFor((e) => e.type === 'translation' && e.id === 1 && e.final, { label: 'translation' });
  const err = await recorder.waitFor((e) => e.type === 'error' && e.scope === 'tts', { label: 'tts error' });
  assert.match(err.message, /tts-down/);
  assert.equal(recorder.count('dub'), 0);
  await session.close('done');
});

test('pipeline: clone-first upgrades voice after enough speech samples', async () => {
  const { session, recorder } = await openSession({ tts: { voiceMode: 'clone-first' } });
  await recorder.waitFor((e) => e.type === 'ready', { label: 'ready' });
  await feedAudio(session, 3200);
  const voice = await recorder.waitFor((e) => e.type === 'voice' && e.mode === 'clone', { label: 'cloned voice' });
  assert.match(voice.voiceId, /mock-clone/);
  await session.close('done');
});

test('pipeline: clone failure degrades to preset with reason', async () => {
  const { session, recorder } = await openSession({ tts: { voiceMode: 'clone-first' }, mock: { cloneFails: true } });
  await recorder.waitFor((e) => e.type === 'ready', { label: 'ready' });
  await feedAudio(session, 3200);
  const voice = await recorder.waitFor((e) => e.type === 'voice' && e.degraded === true, { label: 'degraded voice' });
  assert.equal(voice.mode, 'preset');
  assert.match(String(voice.reason), /clone/i);
  await session.close('done');
});

test('pipeline: no audio -> close is clean', async () => {
  const { session, recorder } = await openSession();
  await recorder.waitFor((e) => e.type === 'ready', { label: 'ready' });
  await session.close('no audio');
  await recorder.waitFor((e) => e.type === 'bye', { label: 'bye' });
  assert.equal(recorder.count('segment'), 0);
});

// ------------------------------------------------- v0.2 streaming TTS overlap

function testClauseExtractor() {
  let emitted = 0;
  return {
    push(text) {
      const rest = String(text ?? '').slice(emitted);
      const m = rest.match(/^(.+?[。！？；;.!?…])/);
      if (!m) return [];
      emitted += m[1].length;
      return [m[1].trim()];
    },
    flush(text) {
      const finalText = String(text ?? '');
      const rest = finalText.slice(Math.min(emitted, finalText.length)).trim();
      emitted = finalText.length;
      return rest ? [rest] : [];
    },
    reset() {
      emitted = 0;
    },
  };
}

function makeSlowTranslator({ first = '今天我们来学习梯度下降。', second = '它是优化算法。', finalDelayMs = 140 } = {}) {
  return {
    name: 'slow-translator',
    async translate({ onPartial }) {
      onPartial?.(first);
      await sleep(30);
      onPartial?.(first + second);
      await sleep(finalDelayMs);
      return { text: first + second };
    },
  };
}

async function openCustomSession(configOverrides, depsOverride) {
  const config = makeConfig(configOverrides);
  const recorder = makeRecorder();
  const session = await createSession({
    id: 'test-custom',
    options: { source: 'test' },
    emit: (e) => recorder.emit(e),
    log: () => {},
    deps: depsOverride(config),
  });
  return { session, recorder, config };
}

test('pipeline v0.2: dub starts before translation final when streaming overlap enabled', async () => {
  const { session, recorder } = await openCustomSession({}, (config) => ({
    ...makeDeps(config),
    createTranslator: () => makeSlowTranslator(),
    createClauseExtractor: () => testClauseExtractor(),
  }));
  await recorder.waitFor((e) => e.type === 'ready', { label: 'ready' });
  await feedAudio(session, 2600);
  await recorder.waitFor((e) => e.type === 'translation' && e.final, { label: 'translation final' });
  await recorder.waitFor((e) => e.type === 'dub' && e.pcm, { label: 'dub audio' });
  const dubIdx = recorder.events.findIndex((e) => e.type === 'dub' && e.pcm);
  const finalIdx = recorder.events.findIndex((e) => e.type === 'translation' && e.final);
  assert.ok(dubIdx >= 0 && finalIdx >= 0, 'both events present');
  assert.ok(dubIdx < finalIdx, `expected dub (${dubIdx}) before translation final (${finalIdx})`);
  await session.close('done');
});

test('pipeline v0.2: overlap can be disabled (dub only after translation final)', async () => {
  const { session, recorder } = await openCustomSession({ dub: { overlapStreaming: false } }, (config) => ({
    ...makeDeps(config),
    createTranslator: () => makeSlowTranslator(),
    createClauseExtractor: () => testClauseExtractor(),
  }));
  await recorder.waitFor((e) => e.type === 'ready', { label: 'ready' });
  await feedAudio(session, 2600);
  await recorder.waitFor((e) => e.type === 'dub' && e.pcm, { label: 'dub audio' });
  const dubIdx = recorder.events.findIndex((e) => e.type === 'dub' && e.pcm);
  const finalIdx = recorder.events.findIndex((e) => e.type === 'translation' && e.final);
  assert.ok(finalIdx >= 0 && dubIdx >= 0);
  assert.ok(finalIdx < dubIdx, `expected translation final (${finalIdx}) before dub (${dubIdx})`);
  await session.close('done');
});

test('pipeline v0.2: tts.warmup is called after session starts', async () => {
  let warmupCalled = false;
  const { session, recorder } = await openCustomSession({}, (config) => ({
    ...makeDeps(config),
    createTts: (opts) => {
      const tts = createMockTts({ ...opts, config });
      tts.warmup = async () => {
        warmupCalled = true;
      };
      return tts;
    },
  }));
  await recorder.waitFor((e) => e.type === 'ready', { label: 'ready' });
  for (let i = 0; i < 20 && !warmupCalled; i++) await sleep(10);
  assert.equal(warmupCalled, true);
  await session.close('done');
});

test('pipeline v0.2: asr onError is forwarded as error(asr) event', async () => {
  const { session, recorder } = await openCustomSession({}, (config) => ({
    ...makeDeps(config),
    createAsr: (opts) => {
      setTimeout(() => opts.onError?.({ message: 'microphone lost' }), 0);
      return createMockAsr({ ...opts, config });
    },
  }));
  await recorder.waitFor((e) => e.type === 'ready', { label: 'ready' });
  const err = await recorder.waitFor((e) => e.type === 'error' && e.scope === 'asr', { label: 'asr error' });
  assert.match(err.message, /microphone lost/);
  await session.close('done');
});

// v0.6：画面 OCR 上下文（WS visual-context）传给翻译器，带 TTL/去重/清洗
test('pipeline: visual-context 传给翻译器（top-level 参数）+ 去重/TTL/seek 清空', async () => {
  const calls = [];
  const config = makeConfig();
  const recorder = makeRecorder();
  const baseDeps = makeDeps(config);
  const session = await createSession({
    id: 'test-visual-context',
    options: { source: 'test', langFrom: 'en', langTo: 'zh' },
    emit: (e) => recorder.emit(e),
    log: () => {},
    deps: {
      ...baseDeps,
      createTranslator: (opts) => {
        const t = baseDeps.createTranslator(opts);
        const orig = t.translate.bind(t);
        t.translate = async (args) => {
          calls.push(args);
          return orig(args);
        };
        return t;
      },
    },
  });
  await recorder.waitFor((e) => e.type === 'ready', { label: 'ready' });

  // 空/纯标点忽略；有效文本接受
  session.onJson({ type: 'visual-context', text: '   ', tMs: 0, source: 'test' });
  session.onJson({ type: 'visual-context', text: '...', tMs: 0, source: 'test' });
  assert.equal(session.stats().visualContext.received, 0);
  session.onJson({ type: 'visual-context', text: 'Gradient Descent · learning rate 学习率', tMs: 1000, source: 'test' });
  // 相同内容去重
  session.onJson({ type: 'visual-context', text: 'Gradient Descent · learning rate 学习率', tMs: 1200, source: 'test' });
  const st1 = session.stats();
  assert.equal(st1.visualContext.received, 1);
  assert.equal(st1.visualContext.ignored >= 2, true);
  assert.equal(st1.visualContext.hasContext, true);

  await feedAudio(session, 5200);
  await recorder.waitFor((e) => e.type === 'translation' && e.id === 1 && e.final, { label: 'translation' });
  assert.ok(calls.length >= 1, 'translator 应被调用');
  assert.equal(calls[0].visualContext, undefined);
  const glossarySrc = (calls[0].glossary ?? []).map((term) => term.src).join('\n');
  assert.match(glossarySrc, /learning rate/);
  assert.equal(session.stats().visualContext.used >= 1, true);

  // seek 后旧画面上下文作废
  await session.onJson({ type: 'control', action: 'seek' });
  assert.equal(session.stats().visualContext.hasContext, false);

  // TTL：把 ttl 配成 1ms 后旧上下文过期
  session.onJson({ type: 'visual-context', text: '另一帧画面文字', tMs: 2000, source: 'test' });
  await new Promise((r) => setTimeout(r, 5));
  session._configForTest = null;
  session.config.visual = { contextTtlMs: 1 };
  assert.equal(session.stats().visualContext.hasContext, false);
  await session.close('done');
});

test('pipeline: next translation starts before previous TTS finishes, dub stays in sentence order', async () => {
  const starts = [];
  let ttsEntered = 0;
  let ttsFinished = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const { session, recorder } = await openCustomSession({}, (config) => ({
    ...makeDeps(config),
    createAsr: ({ onEvent }) => {
      let fired = false;
      return {
        name: 'two-finals',
        async push() {
          if (fired) return;
          fired = true;
          onEvent({ type: 'final', text: 'First sentence about gradient descent.', t0Ms: 0, t1Ms: 1000, lang: 'en' });
          onEvent({ type: 'final', text: 'Second sentence about learning rate.', t0Ms: 1000, t1Ms: 2000, lang: 'en' });
        },
        async flush() {},
        async close() {},
      };
    },
    createTranslator: () => ({
      name: 'timed-translator',
      translate({ text }) {
        starts.push(text);
        const zh = String(text).startsWith('First') ? '第一句讲梯度下降。' : '第二句讲学习率。';
        return Promise.resolve({ text: zh });
      },
    }),
    createTts: () => ({
      name: 'blocking-tts',
      async synthesize() {
        ttsEntered += 1;
        if (ttsEntered === 1) await firstGate;
        ttsFinished += 1;
        return { pcm: Buffer.alloc(4800), sampleRate: 24000 };
      },
    }),
  }));
  await recorder.waitFor((e) => e.type === 'ready', { label: 'ready' });
  session.onAudio(silencePcm(100, SAMPLE_RATE), 0);
  await sleep(40);
  assert.equal(starts.length, 2, '第二句翻译应在第一句 TTS 结束前已经开始');
  assert.equal(ttsFinished, 0, '此时第一句 TTS 仍被挡住');
  assert.ok(ttsEntered >= 1);
  releaseFirst();
  await recorder.waitFor((e) => e.type === 'dub' && e.id === 2 && e.final, { label: 'dub 2 final' });
  const ids = recorder.of('dub').map((event) => event.id);
  for (let i = 1; i < ids.length; i += 1) assert.ok(ids[i] >= ids[i - 1], `配音 id 应非递减：${ids.join(',')}`);
  const firstOf2 = ids.indexOf(2);
  const lastOf1 = ids.lastIndexOf(1);
  assert.ok(lastOf1 >= 0 && firstOf2 > lastOf1, `id 1 的配音应全部早于 id 2：${ids.join(',')}`);
  await session.close('done');
});
