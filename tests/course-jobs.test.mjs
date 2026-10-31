import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startServer } from '../engine/server.mjs';
import {
  formatTranslationMarkdown,
  mergeCausalVotes,
  mergeNoteDrafts,
  mergeTranslations,
  planCourseRun,
  translateSubtitleCues,
} from '../studio/jobs-kit.mjs';
import { applyModelCausalLinks, buildVisualNoteMarkdown, linkSpeechAndVisuals } from '../studio/vision-kit.mjs';

const sample = {
  frames: [{ tMs: 1000, ocrText: 'batch normalization' }],
  segments: [
    { t0Ms: 0, t1Ms: 800, text: 'Hello class.' },
    { t0Ms: 8000, t1Ms: 12000, text: 'We apply batch normalization to the inputs.' },
  ],
};

test('课程任务：视频翻译只排备胎顺序，字幕翻译才批量问每个模型', () => {
  const video = planCourseRun({
    jobs: ['translate', 'notes', 'causal'],
    translateSource: 'video',
    models: ['minimax', 'deepseek', 'mimo-plan', 'extra'],
    availableModels: ['deepseek', 'minimax', 'mimo-plan'],
  });
  assert.deepEqual(video.jobs, { translate: true, notes: true, causal: true });
  assert.equal(video.batchTranslate, false);
  assert.deepEqual(video.liveChain, ['minimax', 'deepseek', 'mimo-plan']);
  assert.equal(video.models.translate.length, 3);

  const subtitles = planCourseRun({
    jobs: { translate: true, notes: false, causal: false },
    translateSource: 'subtitles',
    models: ['deepseek', 'minimax'],
    availableModels: ['deepseek', 'minimax'],
  });
  assert.equal(subtitles.liveChain, null);
  assert.equal(subtitles.batchTranslate, true);
  assert.equal(subtitles.jobs.notes, false);

  const none = planCourseRun({ jobs: [], models: ['deepseek'], availableModels: ['deepseek'] });
  assert.deepEqual(none.jobs, { translate: false, notes: false, causal: false });
  assert.equal(none.liveChain, null);
});

test('课程任务：译文和笔记按多数合并，对不上用主模型', () => {
  const agreed = mergeTranslations([
    { provider: 'deepseek', text: '学习率控制步长' },
    { provider: 'minimax', text: '学习率控制步长' },
    { provider: 'mimo-plan', text: '步长由学习率决定' },
  ]);
  assert.equal(agreed.agreement, 'majority');
  assert.equal(agreed.text, '学习率控制步长');
  assert.deepEqual(agreed.supporters, ['deepseek', 'minimax']);

  const primary = mergeTranslations([
    { provider: 'deepseek', text: '甲' },
    { provider: 'minimax', text: '乙' },
  ]);
  assert.equal(primary.agreement, 'primary');
  assert.equal(primary.text, '甲');

  const notes = mergeNoteDrafts([
    { provider: 'deepseek', summary: '主总结', keyPoints: ['只在主模型', '两边都有'] },
    { provider: 'minimax', summary: '另一份', keyPoints: ['两边都有', '只在第二家'] },
  ]);
  assert.equal(notes.summary, '主总结');
  assert.equal(notes.summaryAgreement, 'primary');
  assert.deepEqual(notes.keyPoints, ['两边都有']);

  const same = mergeNoteDrafts([
    { provider: 'deepseek', summary: '同一总结', keyPoints: ['甲'] },
    { provider: 'minimax', summary: '同一总结', keyPoints: ['甲'] },
  ]);
  assert.equal(same.summaryAgreement, 'unanimous');
  assert.deepEqual(same.keyPoints, ['甲']);
});

test('课程任务：因果投票不能发明规则没认出的关系', () => {
  const deterministic = linkSpeechAndVisuals(sample);
  assert.equal(deterministic.length, 1);
  const invented = {
    relation: 'speech_derives_visual',
    evidence: 'quantum foobar',
    cause: 'quantum foobar',
    effect: 'quantum foobar',
  };
  const real = {
    relation: 'visual_prompts_speech',
    evidence: 'batch normalization',
    cause: 'batch normalization',
    effect: 'We apply batch normalization',
  };
  const one = mergeCausalVotes({
    deterministic,
    modelSets: [{ provider: 'deepseek', links: [invented, real] }],
  });
  assert.equal(one.length, 1);
  assert.equal(one[0].evidence, 'batch normalization');
  const applied = applyModelCausalLinks(deterministic, one);
  assert.match(applied[0].effectText, /We apply batch normalization/);

  const voted = mergeCausalVotes({
    deterministic,
    modelSets: [
      { provider: 'deepseek', links: [invented] },
      { provider: 'minimax', links: [invented, { ...real, cause: 'not in the source', effect: 'also missing' }] },
    ],
  });
  assert.equal(voted.length, 0);

  const wording = mergeCausalVotes({
    deterministic,
    modelSets: [
      { provider: 'deepseek', links: [{ ...real, cause: 'not in the source', effect: 'also missing' }] },
      { provider: 'minimax', links: [real] },
      { provider: 'mimo-plan', links: [real] },
    ],
  });
  assert.equal(wording.length, 1);
  assert.equal(wording[0].cause, 'batch normalization');
  const grounded = applyModelCausalLinks(deterministic, wording);
  assert.equal(grounded[0].source, 'model');
});

test('课程任务：字幕批量翻译有上限，失败的模型弃权', async () => {
  const cues = Array.from({ length: 41 }, (_, index) => ({
    id: String(index),
    t0Ms: index * 1000,
    t1Ms: index * 1000 + 800,
    text: `sentence ${index}`,
  }));
  const calls = [];
  const merged = await translateSubtitleCues({
    cues,
    models: ['deepseek', 'minimax'],
    translate: async ({ text, provider }) => {
      calls.push(provider);
      if (provider === 'minimax') throw new Error('down');
      return { text: `译 ${text}`, provider };
    },
  });
  assert.equal(merged.length, 40);
  assert.equal(calls.length, 80);
  assert.equal(merged[0].agreement, 'primary');
  assert.equal(merged[0].text, '译 sentence 0');
  assert.equal(merged[0].provider, 'deepseek');
  const markdown = formatTranslationMarkdown({ title: '课', cues: merged.slice(0, 1) });
  assert.match(markdown, /采用主模型/);
  assert.match(markdown, /译 sentence 0/);
  assert.match(markdown, /实时同传不在这里合并/);
});

test('课程任务：关掉因果时笔记不再写因果关系一节', () => {
  const markdown = buildVisualNoteMarkdown({
    title: '只记笔记',
    summary: '总结',
    keyPoints: ['要点'],
    frames: sample.frames,
    segments: sample.segments,
    includeCausal: false,
    range: { startMs: 0, endMs: 12000 },
    generatedAt: new Date('2026-01-02T00:00:00'),
  });
  assert.match(markdown, /## 本节总结/);
  assert.doesNotMatch(markdown, /## 因果关系/);
  assert.doesNotMatch(markdown, /\*\*因果\*\*/);
});

test('POST /api/translate 钉住指定模型，并拒绝未知字段', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livedub-translate-'));
  const seen = [];
  const srv = await startServer({
    port: 0,
    host: '127.0.0.1',
    log: () => {},
    dataDir,
    closeAsrOnShutdown: false,
    desktopAppPath: path.join(dataDir, 'no-app'),
    config: {
      server: { host: '127.0.0.1', port: 0 },
      translate: { provider: 'deepseek', chain: ['deepseek', 'minimax', 'mimo-plan'] },
      asr: { provider: 'mock' },
      tts: { provider: 'mock' },
    },
    sessionFactory: async () => ({ onAudio() {}, onJson() {}, async close() {} }),
    visionFactory: async () => {
      throw new Error('vision disabled');
    },
    translateFactory: ({ config }) => {
      seen.push({ provider: config.translate.provider, chain: config.translate.chain.slice() });
      return {
        async translate({ text }) {
          if (config.translate.provider === 'minimax') throw new Error('minimax down');
          return { text: `[${config.translate.provider}] ${text}`, model: 'fake', provider: config.translate.provider };
        },
      };
    },
  });
  try {
    const post = (body) => fetch(`${srv.url}/api/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const get = await fetch(`${srv.url}/api/translate`);
    assert.equal(get.status, 405);

    const pinned = await post({ text: 'Hello class.', provider: 'mimo-plan' });
    assert.equal(pinned.status, 200);
    const pinnedBody = await pinned.json();
    assert.equal(pinnedBody.text, '[mimo-plan] Hello class.');
    assert.equal(pinnedBody.provider, 'mimo-plan');
    assert.deepEqual(seen.at(-1), { provider: 'mimo-plan', chain: ['mimo-plan'] });

    const fallback = await post({ text: 'Hello class.' });
    assert.equal(fallback.status, 200);
    assert.deepEqual(seen.at(-1).chain, ['deepseek']);

    for (const [label, body] of [
      ['unknown', { text: 'Hello', secret: 'x' }],
      ['empty', { text: '   ' }],
      ['bad provider', { text: 'Hello', provider: 'nope' }],
    ]) {
      const response = await post(body);
      assert.equal(response.status, 400, label);
    }

    const failed = await post({ text: 'Hello', provider: 'minimax' });
    assert.equal(failed.status, 502);
    const failedBody = await failed.json();
    assert.equal(failedBody.error, 'translate_failed');
    assert.match(failedBody.message, /minimax down/);
  } finally {
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
