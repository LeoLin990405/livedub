/**
 * 画面术语、开场窗口学习、草稿翻译次数上限。
 * 走真实 createSession / buildTranslationMessages，不打网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSession } from '../engine/pipeline.mjs';
import { buildTranslationMessages } from '../engine/translate/index.mjs';
import { createMockTts, createMockScheduler, createMockVoiceManager } from '../engine/mock.mjs';

const UNIQUE = 'ZZZUNIQUEOPAQUELECTURESENTENCEABOUTWIDGETSNEVERCOPIED';
const LONG_OCR = `${UNIQUE} into the prompt verbatim and must stay out of the glossary blob.\nsoftmax attention\nlayer norm`;

function makeConfig(overrides = {}) {
  return {
    asr: { provider: 'mock' },
    translate: {
      provider: 'mock',
      chain: ['mock'],
      contextSegments: 3,
      maxTokens: 100,
      timeoutMs: 2000,
      draftReuse: false,
      draftMaxExtraCalls: 1,
      openingWindowMs: 90000,
      visualTermLimit: 8,
      ...(overrides.translate ?? {}),
    },
    tts: {
      provider: 'mock',
      sampleRate: 24000,
      speed: 1,
      voiceMode: 'preset',
      presetVoices: { default: 'mock-female' },
      chunk: { minClauseChars: 8, maxChunkChars: 80 },
    },
    dub: { enabled: false },
    glossary: [{ src: 'gradient descent', dst: '梯度下降' }],
    ...overrides,
    translate: {
      provider: 'mock',
      chain: ['mock'],
      contextSegments: 3,
      draftReuse: false,
      draftMaxExtraCalls: 1,
      openingWindowMs: 90000,
      visualTermLimit: 8,
      ...(overrides.translate ?? {}),
    },
  };
}

async function openSession(config, { createAsr, createTranslator }) {
  const events = [];
  const session = await createSession({
    id: 'glossary-draft',
    options: { source: 'test' },
    emit: (event) => events.push(event),
    log: () => {},
    deps: {
      config,
      createAsr,
      createTranslator,
      createTts: (opts) => createMockTts({ ...opts, config }),
      createScheduler: (opts) => createMockScheduler({ ...opts, config }),
      createVoiceManager: (opts) => createMockVoiceManager({ ...opts, config }),
      splitForTtsFallback: (text) => [String(text ?? '').trim()].filter(Boolean),
    },
  });
  return { session, events };
}

test('glossary: long OCR becomes a short term list and stays out of the translation prompt', () => {
  const messages = buildTranslationMessages({
    text: 'Hello there.',
    visualContext: LONG_OCR,
    glossary: [{ src: 'gradient descent', dst: '梯度下降' }],
    config: {},
  });
  const user = messages[1].content;
  assert.ok(user.includes('softmax attention'), '短行应进入术语表');
  assert.ok(user.includes('gradient descent = 梯度下降'));
  assert.ok(!user.includes(UNIQUE), '整段 OCR 不应出现在 prompt');
  assert.ok(!user.includes('【本页画面文字'));
  assert.ok(!user.includes('<<<'));
  assert.ok(!messages[0].content.includes(UNIQUE));
});

test('glossary: opening-window transcript and on-screen terms are learned; later transcript is not', async () => {
  const seen = [];
  let emitFinal = () => {};
  const config = makeConfig();
  const { session, events } = await openSession(config, {
    createAsr: ({ onEvent }) => {
      emitFinal = (ev) => onEvent(ev);
      return { name: 'scripted', async push() {}, async flush() {}, async close() {} };
    },
    createTranslator: () => ({
      name: 'recording',
      async translate(args) {
        seen.push(args);
        return { text: '译文。' };
      },
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(events.some((event) => event.type === 'ready'));

  session.onJson({ type: 'visual-context', text: LONG_OCR, tMs: 1000, source: 'test' });
  emitFinal({ type: 'final', text: 'We apply batch normalization to the inputs.', t0Ms: 1000, t1Ms: 2000, lang: 'en' });
  emitFinal({ type: 'final', text: 'quantum foobar appears only in the later lecture.', t0Ms: 120000, t1Ms: 121000, lang: 'en' });

  const finals = [];
  for (let i = 0; i < 40 && finals.length < 2; i += 1) {
    finals.splice(0, finals.length, ...events.filter((event) => event.type === 'translation' && event.final));
    if (finals.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(finals.length, 2);

  const entries = session.glossaryEntries();
  const srcs = entries.map((entry) => entry.src.toLowerCase());
  assert.ok(srcs.some((src) => src.includes('softmax attention')));
  assert.ok(srcs.some((src) => src.includes('layer norm')));
  assert.ok(srcs.some((src) => src.includes('batch normalization')));
  assert.ok(!srcs.some((src) => src.includes(UNIQUE.toLowerCase())));
  assert.ok(!srcs.some((src) => src.includes('quantum foobar')));
  assert.ok(seen.length >= 1);
  assert.equal(seen[0].visualContext, undefined);
  const prompt = buildTranslationMessages({
    text: 'Next sentence.',
    glossary: entries,
    config: {},
  });
  assert.ok(prompt[1].content.includes('softmax attention'));
  assert.ok(!prompt[1].content.includes(UNIQUE));
  await session.close('done');
});

test('draft: extra translation calls stop at draftMaxExtraCalls and identical finals are reused', async () => {
  let calls = 0;
  let emit = () => {};
  const config = makeConfig({ translate: { draftReuse: true, draftMaxExtraCalls: 1 } });
  const { session, events } = await openSession(config, {
    createAsr: ({ onEvent }) => {
      emit = (ev) => onEvent(ev);
      return { name: 'scripted', async push() {}, async flush() {}, async close() {} };
    },
    createTranslator: () => ({
      name: 'counting',
      translate({ text }) {
        calls += 1;
        return Promise.resolve({ text: `译:${text}` });
      },
    }),
  });

  const source = 'batch normalization helps training.';
  emit({ type: 'partial', text: source, t0Ms: 0, t1Ms: 400 });
  emit({ type: 'partial', text: source, t0Ms: 0, t1Ms: 700 });
  emit({ type: 'partial', text: source, t0Ms: 0, t1Ms: 900 });
  emit({ type: 'final', text: source, t0Ms: 0, t1Ms: 1000, lang: 'en' });

  for (let i = 0; i < 40 && !events.some((event) => event.type === 'translation' && event.final); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(calls, 1, '相同草稿命中后不应再翻译，多次 partial 也不能突破次数上限');
  await session.close('done');
});

test('draft: a much shorter partial is not reused, and the cap still bounds extra calls', async () => {
  let calls = 0;
  let emit = () => {};
  const config = makeConfig({ translate: { draftReuse: true, draftMaxExtraCalls: 1 } });
  const { session, events } = await openSession(config, {
    createAsr: ({ onEvent }) => {
      emit = (ev) => onEvent(ev);
      return { name: 'scripted', async push() {}, async flush() {}, async close() {} };
    },
    createTranslator: () => ({
      name: 'counting',
      translate({ text }) {
        calls += 1;
        return Promise.resolve({ text: `译:${text}` });
      },
    }),
  });

  emit({ type: 'partial', text: 'hello', t0Ms: 0, t1Ms: 200 });
  emit({ type: 'partial', text: 'hello there friend', t0Ms: 0, t1Ms: 400 });
  emit({ type: 'partial', text: 'hello there friend again', t0Ms: 0, t1Ms: 600 });
  emit({
    type: 'final',
    text: 'hello there friend again and the sentence kept growing well past the draft.',
    t0Ms: 0,
    t1Ms: 1000,
    lang: 'en',
  });
  for (let i = 0; i < 40 && !events.some((event) => event.type === 'translation' && event.final); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(calls, 2, '1 次草稿 + 1 次正式翻译；更多 partial 被次数上限挡住');
  await session.close('done');
});
