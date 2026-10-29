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
import { silencePcm, makeTonePcm } from './helpers.mjs';

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
