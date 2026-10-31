import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVisualNoteMarkdown, linkSpeechAndVisuals } from '../studio/vision-kit.mjs';
import { buildSummaryInput, parseSummaryOutput } from '../engine/vision/index.mjs';

test('因果：画面先出现，口播随后讲到同一内容', () => {
  const links = linkSpeechAndVisuals({
    frames: [{ tMs: 1000, ocrText: 'batch normalization' }],
    segments: [
      { t0Ms: 0, t1Ms: 800, text: 'Hello class.', translation: '大家好。' },
      { t0Ms: 8000, t1Ms: 12000, text: 'We apply batch normalization to the inputs.', translation: '我们对输入做批量归一化。' },
    ],
  });
  assert.equal(links.length, 1);
  assert.equal(links[0].relation, 'visual_prompts_speech');
  assert.equal(links[0].evidence.toLowerCase(), 'batch normalization');
  assert.equal(links[0].causeKind, 'visual');
  assert.equal(links[0].effectKind, 'speech');
});

test('因果：口播先讲，画面随后才出现', () => {
  const links = linkSpeechAndVisuals({
    frames: [{ tMs: 9000, ocrText: 'softmax' }],
    segments: [{ t0Ms: 1000, t1Ms: 4000, text: 'Next we need softmax.', translation: '接下来需要 softmax。' }],
  });
  assert.equal(links.length, 1);
  assert.equal(links[0].relation, 'speech_prompts_visual');
  assert.equal(links[0].causeKind, 'speech');
  assert.equal(links[0].effectKind, 'visual');
});

test('因果：口播在解释画面，而不是只因为时间重叠', () => {
  const links = linkSpeechAndVisuals({
    frames: [{ tMs: 5000, ocrText: 'softmax' }],
    segments: [{ t0Ms: 4800, t1Ms: 8000, text: 'Softmax means a probability distribution.', translation: 'softmax 是指一种概率分布。' }],
  });
  assert.equal(links.length, 1);
  assert.equal(links[0].relation, 'speech_explains_visual');
});

test('因果：口播推出画面上的结论', () => {
  const links = linkSpeechAndVisuals({
    frames: [{ tMs: 12000, ocrText: 'Vanishing Gradient' }],
    segments: [{ t0Ms: 10000, t1Ms: 14000, text: 'Therefore the gradient vanishes.', translation: '因此梯度会消失。' }],
  });
  assert.equal(links.length, 1);
  assert.equal(links[0].relation, 'speech_derives_visual');
  assert.match(links[0].evidence.toLowerCase(), /gradient/);
});

test('因果：口播指向画面', () => {
  const links = linkSpeechAndVisuals({
    frames: [{ tMs: 3500, ocrText: '仅有图' }],
    segments: [{ t0Ms: 3000, t1Ms: 5000, text: 'As shown on this slide.', translation: '如图。' }],
  });
  assert.equal(links.length, 1);
  assert.equal(links[0].relation, 'speech_refers_visual');
});

test('因果：时间靠近但内容无关，不写进笔记', () => {
  const markdown = buildVisualNoteMarkdown({
    title: '无关',
    summary: '没有共同内容。',
    frames: [{ tMs: 1000, ocrText: 'softmax attention', imageUrl: '/api/notes/assets/a.png' }],
    segments: [{ t0Ms: 1200, t1Ms: 2000, text: 'The weather is nice today.', translation: '今天天气不错。' }],
    range: { startMs: 0, endMs: 5000 },
    generatedAt: new Date('2026-01-02T00:00:00'),
  });
  assert.match(markdown, /## 因果关系/);
  assert.match(markdown, /只是时间上挨在一起，不算因果/);
  assert.doesNotMatch(markdown, /画面引出讲解|讲解解释画面|口播指向画面/);
});

test('因果：笔记写出关系，并拒绝编造的模型因果', () => {
  const frames = [{ tMs: 1000, ocrText: 'batch normalization', imageUrl: '/api/notes/assets/a.png' }];
  const segments = [{ t0Ms: 8000, t1Ms: 12000, text: 'We apply batch normalization to the inputs.' }];
  const markdown = buildVisualNoteMarkdown({
    title: 'BN',
    summary: '批量归一化。',
    frames,
    segments,
    modelLinks: [
      {
        relation: 'visual_prompts_speech',
        evidence: 'quantum foobar',
        cause: 'quantum foobar',
        effect: 'quantum foobar',
      },
      {
        relation: 'visual_prompts_speech',
        evidence: 'batch normalization',
        cause: 'batch normalization',
        effect: 'We apply batch normalization',
      },
    ],
    range: { startMs: 0, endMs: 12000 },
    generatedAt: new Date('2026-01-02T00:00:00'),
  });
  assert.match(markdown, /## 因果关系/);
  assert.match(markdown, /画面引出讲解/);
  assert.match(markdown, /batch normalization/);
  assert.match(markdown, /因（画面）：batch normalization/);
  assert.match(markdown, /果（口播）：We apply batch normalization/);
  assert.doesNotMatch(markdown, /quantum foobar/);
  assert.match(markdown, /\*\*因果\*\*：画面引出讲解（batch normalization）/);
});

test('因果：已经讲过的术语，后面的画面不再算成引出', () => {
  const links = linkSpeechAndVisuals({
    frames: [{ tMs: 20000, ocrText: 'softmax' }],
    segments: [
      { t0Ms: 1000, t1Ms: 3000, text: 'We introduce softmax early.' },
      { t0Ms: 21000, t1Ms: 24000, text: 'Back to softmax again.' },
    ],
  });
  assert.ok(links.every((link) => link.relation !== 'visual_prompts_speech'));
});

test('总结输出能解析因果关系，并要求模型按这五种关系作答', () => {
  const parsed = parseSummaryOutput(JSON.stringify({
    summary: '讲了归一化。',
    keyPoints: ['先看画面', '再听讲解'],
    links: [
      { relation: 'visual_prompts_speech', evidence: 'batch normalization', cause: 'batch normalization', effect: 'We apply batch normalization' },
      { relation: 'made_up', evidence: 'x', cause: 'y', effect: 'z' },
      { relation: 'speech_explains_visual', evidence: '', cause: 'a', effect: 'b' },
    ],
  }));
  assert.equal(parsed.links.length, 1);
  assert.equal(parsed.links[0].relation, 'visual_prompts_speech');
  assert.deepEqual(parseSummaryOutput(''), { summary: '', keyPoints: [], links: [] });
  const messages = buildSummaryInput({
    title: 't',
    transcript: [{ t0Ms: 0, t1Ms: 1000, src: 'Hello.', dst: '你好。' }],
    visuals: [{ tMs: 0, ocrText: 'Hello' }],
  });
  assert.match(messages.messages[0].content, /visual_prompts_speech/);
  assert.match(messages.messages[0].content, /speech_derives_visual/);
  assert.match(messages.messages[1].content, /links/);
});
