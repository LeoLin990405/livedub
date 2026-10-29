/**
 * T2 单测：增量翻译（fake fetch，禁止真网络） + 字幕纯函数。
 * 运行：node --test tests/translate.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

// 隔离真实 ~/.sayless 配置：resolveProvider 在 translate 调用时才读取该路径，
// 指向不存在的目录即可保证单测完全不依赖本机 provider 凭据。
process.env.SAYLESS_DIR = path.join('/tmp', `livedub-test-sayless-${process.pid}-missing`);

import { createTranslator, buildTranslationMessages, cleanTranslation } from '../engine/translate/index.mjs';
import {
  formatSrt,
  formatSrtTime,
  splitCps,
  wrapLines,
  wrapBilingual,
  dedupeCues,
  mergeCues,
  countChars,
  cueCps,
} from '../engine/subtitles.mjs';

/* ------------------------------------------------------------------ *
 * fake fetch / SSE 工具
 * ------------------------------------------------------------------ */

const encoder = new TextEncoder();
const SSE_DONE = 'data: [DONE]\n\n';

function sseLine(content, { model = 'deepseek-flash' } = {}) {
  const chunk = {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta: content == null ? {} : { content }, finish_reason: null }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** 生成 SSE 响应；parts 里 null 表示 [DONE] */
function sseResponse(parts, { model = 'deepseek-flash', status = 200 } = {}) {
  const payload = parts.map((part) => (part === null ? SSE_DONE : sseLine(part, { model }))).join('');
  return responseFromText(payload, { status });
}

function responseFromText(text, { status = 200, contentType = 'text/event-stream' } = {}) {
  const bytes = encoder.encode(text);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': contentType } });
}

function responseFromByteChunks(byteChunks, { contentType = 'text/event-stream' } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const bytes of byteChunks) controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': contentType } });
}

function recordFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      init,
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function baseConfig(translateOverrides = {}, extra = {}) {
  return {
    session: { langFrom: 'en', langTo: 'zh' },
    glossary: [
      { src: 'gradient descent', dst: '梯度下降' },
      { src: 'learning rate', dst: '学习率' },
    ],
    providers: {
      deepseek: {
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'test-key-deepseek',
        model: 'deepseek-flash',
        chatPath: '/chat/completions',
      },
      minimax: {
        baseUrl: 'https://api.minimaxi.com/v1',
        apiKey: 'test-key-minimax',
        model: 'MiniMax-M3',
        chatPath: '/text/chatcompletion_v2',
      },
      'mimo-plan': {
        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
        apiKey: 'test-key-mimo',
        model: 'mimo-v2.6-flash',
        chatPath: '/chat/completions',
      },
    },
    translate: {
      provider: 'deepseek',
      chain: ['deepseek'],
      temperature: 0,
      maxTokens: 360,
      contextSegments: 3,
      timeoutMs: 3000,
      style: 'teaching',
      partialThrottleMs: 0,
      ...translateOverrides,
    },
    ...extra,
  };
}

function makeTranslator(options = {}) {
  const fetchImpl = options.fetchImpl ?? recordFetch(() => sseResponse(['梯度下降。', null]));
  const translator = createTranslator({
    config: options.config ?? baseConfig(),
    log: options.log ?? (() => {}),
    fetchImpl,
  });
  return { translator, fetchImpl };
}

/* ------------------------------------------------------------------ *
 * 翻译：正常流式路径
 * ------------------------------------------------------------------ */

test('deepseek 正常流：SSE 增量 -> 累计 onPartial -> 最终清洗文本 + 请求契约正确', async () => {
  const parts = ['梯度', '下降是', '一种一阶迭代优化算法。', null];
  const fetchImpl = recordFetch(() => sseResponse(parts));
  const logs = [];
  const translator = createTranslator({ config: baseConfig(), log: (m) => logs.push(m), fetchImpl });

  const partials = [];
  const result = await translator.translate({
    text: 'Gradient descent is a first order iterative optimization algorithm.',
    onPartial: (text) => partials.push(text),
  });

  assert.equal(result.text, '梯度下降是一种一阶迭代优化算法。');
  assert.equal(result.provider, 'deepseek');
  assert.equal(result.model, 'deepseek-flash');
  // 节流=0 时每个 delta 各一次；结尾 force emit 与最后一次相同被去重
  assert.deepEqual(partials, ['梯度', '梯度下降是', '梯度下降是一种一阶迭代优化算法。']);
  assert.equal(translator.name, 'deepseek');
  assert.deepEqual(translator.chain, ['deepseek']);

  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(call.init.method, 'POST');
  assert.ok(String(call.headers.authorization).startsWith('Bearer '));
  assert.ok(String(call.headers.authorization).endsWith('test-key-deepseek'));
  assert.equal(call.body.model, 'deepseek-flash');
  assert.equal(call.body.stream, true);
  assert.equal(call.body.temperature, 0);
  assert.equal(call.body.max_tokens, 360);
  assert.equal(call.body.messages.length, 2);
  assert.equal(call.body.messages[0].role, 'system');
  assert.equal(call.body.messages[1].role, 'user');
  assert.deepEqual(logs, []); // 主 provider 成功时不应有告警噪音
});

test('SSE 解析容忍任意 chunk 边界（半行/半字符/keep-alive/[DONE]）', async () => {
  const payload = [
    ': keep-alive\n\n',
    sseLine('梯度'),
    sseLine('下降是一种'),
    'data: {"choices":[{"delta":{"content":"优化算法。"}}]}\n\n',
    '\n',
    SSE_DONE,
  ].join('');
  const bytes = encoder.encode(payload);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.slice(i, i + 7));

  const fetchImpl = recordFetch(() => responseFromByteChunks(chunks));
  const translator = createTranslator({ config: baseConfig(), fetchImpl });
  const result = await translator.translate({ text: 'Gradient descent is an optimization algorithm.' });
  assert.equal(result.text, '梯度下降是一种优化算法。');
});

test('上报累计式快照 / 整段重复帧时译文不翻倍（兼容部分网关）', async () => {
  // 累计快照：每帧都是「到目前为止的全文」，最后再把全量快照重复一遍
  const cumulativeFetch = recordFetch(() =>
    sseResponse(['梯度', '梯度下降', '梯度下降是一种优化算法。', '梯度下降是一种优化算法。', null]),
  );
  const cumulativeTranslator = createTranslator({ config: baseConfig(), fetchImpl: cumulativeFetch });
  const cumulativeResult = await cumulativeTranslator.translate({ text: 'Gradient descent is an optimization algorithm.' });
  assert.equal(cumulativeResult.text, '梯度下降是一种优化算法。');

  // 正常增量里的单字重复（如笑声）不能被误删
  const incrementalFetch = recordFetch(() => sseResponse(['哈', '哈', '。', null]));
  const incrementalTranslator = createTranslator({ config: baseConfig(), fetchImpl: incrementalFetch });
  const incrementalResult = await incrementalTranslator.translate({ text: 'haha.' });
  assert.equal(incrementalResult.text, '哈哈。');
});

test('非 SSE（application/json）响应走整包解析兜底', async () => {
  const fetchImpl = recordFetch(
    () =>
      new Response(
        JSON.stringify({
          model: 'deepseek-chat',
          choices: [{ message: { role: 'assistant', content: '译文：梯度下降。' } }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  const translator = createTranslator({ config: baseConfig(), fetchImpl });
  const result = await translator.translate({ text: 'Gradient descent.' });
  assert.equal(result.text, '梯度下降。');
  assert.equal(result.model, 'deepseek-chat');
  assert.equal(result.provider, 'deepseek');
});

test('最终清洗：去「译文：」前缀、包裹引号、尾部解释性括号', async () => {
  const fetchImpl = recordFetch(() =>
    sseResponse(['译文：“梯度下降是一种优化算法。”（注：此处为直译）', null]),
  );
  const translator = createTranslator({ config: baseConfig(), fetchImpl });
  const result = await translator.translate({ text: 'Gradient descent is an optimization algorithm.' });
  assert.equal(result.text, '梯度下降是一种优化算法。');
});

test('cleanTranslation 纯函数边界', () => {
  assert.equal(cleanTranslation(''), '');
  assert.equal(cleanTranslation('   '), '');
  assert.equal(cleanTranslation('“梯度下降”'), '梯度下降');
  assert.equal(cleanTranslation('"梯度下降"'), '梯度下降');
  assert.equal(cleanTranslation('**梯度下降**'), '梯度下降');
  assert.equal(cleanTranslation('```\n梯度下降\n```'), '梯度下降');
  assert.equal(cleanTranslation('翻译：梯度下降（意译）'), '梯度下降');
  assert.equal(cleanTranslation('梯度\n下降'), '梯度下降');
  assert.equal(cleanTranslation('hello\nworld'), 'hello world');
  // 正常括号内容属于译文的一部分，不应被删
  assert.equal(cleanTranslation('注意力机制（Attention）很重要。'), '注意力机制（Attention）很重要。');
});

/* ------------------------------------------------------------------ *
 * 翻译：prompt（术语 + 上下文 + 教学约束）
 * ------------------------------------------------------------------ */

test('prompt 包含术语表强约束、最近双语上下文与教学同传要求', async () => {
  const fetchImpl = recordFetch(() => sseResponse(['损失函数衡量误差。', null]));
  const translator = createTranslator({ config: baseConfig(), fetchImpl });
  await translator.translate({
    text: 'We use gradient descent to minimize the loss function.',
    context: [
      { src: 'The loss function measures error.', dst: '损失函数衡量误差。' },
      { src: 'A smaller loss is better.', dst: '损失越小越好。' },
    ],
    glossary: [{ src: 'loss function', dst: '损失函数' }],
  });

  const [{ messages }] = fetchImpl.calls.map((call) => call.body);
  const [system, user] = messages;
  assert.equal(system.role, 'system');
  assert.match(system.content, /同声传译|教学视频/);
  assert.match(system.content, /不增删/);
  assert.match(system.content, /术语表/);
  assert.match(system.content, /TTS/);
  assert.match(system.content, /只输出译文/);

  assert.equal(user.role, 'user');
  assert.match(user.content, /gradient descent = 梯度下降/);
  assert.match(user.content, /loss function = 损失函数/);
  assert.match(user.content, /【最近上下文/);
  assert.match(user.content, /The loss function measures error\./);
  assert.match(user.content, /损失函数衡量误差。/);
  assert.match(user.content, /We use gradient descent to minimize the loss function\./);
});

test('buildTranslationMessages 只带最近 contextSegments 句上下文', () => {
  const context = [
    { src: 'context one', dst: '上下文一' },
    { src: 'context two', dst: '上下文二' },
    { src: 'context three', dst: '上下文三' },
    { src: 'context four', dst: '上下文四' },
    { src: 'context five', dst: '上下文五' },
  ];
  const messages = buildTranslationMessages({
    text: 'target sentence',
    context,
    glossary: [],
    config: baseConfig(), // contextSegments = 3
  });
  const user = messages[1].content;
  assert.ok(!user.includes('context one'));
  assert.ok(!user.includes('context two'));
  assert.ok(user.includes('context three'));
  assert.ok(user.includes('context four'));
  assert.ok(user.includes('context five'));
  assert.ok(user.includes('target sentence'));
  // 术语表来自 config.glossary（即便本次没显式传 glossary）
  assert.ok(user.includes('gradient descent = 梯度下降'));
});

test('会话级术语表覆盖项目默认译法（调用方优先）', () => {
  const messages = buildTranslationMessages({
    text: 'Gradient descent converges slowly here.',
    glossary: [{ src: 'gradient descent', dst: '梯度下降法' }],
    config: baseConfig(),
  });
  const user = messages[1].content;
  assert.ok(user.includes('gradient descent = 梯度下降法'));
  assert.ok(!user.includes('gradient descent = 梯度下降\n'));
});

test('超长输入按 maxInputChars 截断后翻译并 log 告警', async () => {
  const fetchImpl = recordFetch(() => sseResponse(['超长。', null]));
  const logs = [];
  const translator = createTranslator({
    config: baseConfig({ maxInputChars: 10 }),
    log: (m) => logs.push(m),
    fetchImpl,
  });
  const result = await translator.translate({ text: 'Gradient descent is an optimization algorithm.' });
  assert.equal(result.text, '超长。');
  const user = fetchImpl.calls[0].body.messages[1].content;
  assert.ok(user.includes('Gradient d'), '只应发送前 10 个字符');
  assert.ok(!user.includes('optimization'));
  assert.ok(logs.some((line) => /截断/.test(line)));
});

test('onPartial 回调抛异常不影响翻译主流程', async () => {
  const fetchImpl = recordFetch(() => sseResponse(['梯度', '下降。', null]));
  const logs = [];
  const translator = createTranslator({ config: baseConfig(), log: (m) => logs.push(m), fetchImpl });
  const result = await translator.translate({
    text: 'Gradient descent.',
    onPartial: () => {
      throw new Error('UI 回调炸了');
    },
  });
  assert.equal(result.text, '梯度下降。');
  assert.ok(logs.some((line) => /onPartial/.test(line)));
});

/* ------------------------------------------------------------------ *
 * 翻译：超时 / 中断
 * ------------------------------------------------------------------ */

test('config.translate.timeoutMs 到点中断并抛出可读超时错误', async () => {
  const fetchImpl = (url, init = {}) =>
    new Promise((resolve, reject) => {
      const fail = () => reject(Object.assign(new Error('aborted by client'), { name: 'AbortError' }));
      if (init.signal?.aborted) return fail();
      init.signal?.addEventListener('abort', fail, { once: true });
    });
  const translator = createTranslator({ config: baseConfig({ timeoutMs: 60 }), fetchImpl });

  const startedAt = Date.now();
  await assert.rejects(
    () => translator.translate({ text: 'hello world' }),
    (err) => /翻译全部 provider 失败/.test(err.message) && /超时/.test(err.message) && /deepseek/.test(err.message),
  );
  assert.ok(Date.now() - startedAt < 3000, '超时应在 3s 内触发');
});

test('调用前已 abort：立即抛 AbortError，不发请求', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = recordFetch(() => {
    throw new Error('测试失败：已 abort 不应发起 fetch');
  });
  const translator = createTranslator({ config: baseConfig(), fetchImpl });

  await assert.rejects(
    () => translator.translate({ text: 'hello', signal: controller.signal }),
    (err) => err.name === 'AbortError',
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('流式中途 abort：抛 AbortError、不再降级、不继续读流', async () => {
  const controller = new AbortController();
  const fetchImpl = recordFetch(() => {
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(encoder.encode(sseLine('第一段')));
        // 故意不 close：模拟仍在生成的流
      },
      cancel() {},
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  });
  const translator = createTranslator({
    config: baseConfig({ chain: ['deepseek', 'minimax'] }),
    fetchImpl,
  });

  let partialCount = 0;
  await assert.rejects(
    () =>
      translator.translate({
        text: 'hello world',
        signal: controller.signal,
        onPartial: () => {
          partialCount += 1;
          controller.abort();
        },
      }),
    (err) => err.name === 'AbortError',
  );
  assert.equal(partialCount, 1);
  assert.equal(fetchImpl.calls.length, 1, '用户中断后不应再尝试备胎 provider');
});

/* ------------------------------------------------------------------ *
 * 翻译：chain 降级
 * ------------------------------------------------------------------ */

test('chain 降级：deepseek 网络失败 -> minimax HTTP 500 -> mimo-plan 成功', async () => {
  const fetchImpl = recordFetch((call, index) => {
    if (index === 0) throw new TypeError('fetch failed');
    if (index === 1) {
      return new Response('upstream boom', { status: 500, headers: { 'content-type': 'text/plain' } });
    }
    return sseResponse(['梯度下降是一种优化算法。', null], { model: 'mimo-v2.6-flash' });
  });
  const logs = [];
  const translator = createTranslator({
    config: baseConfig({ chain: ['deepseek', 'minimax', 'mimo-plan'] }),
    log: (m) => logs.push(m),
    fetchImpl,
  });

  const result = await translator.translate({ text: 'Gradient descent is an optimization algorithm.' });
  assert.equal(result.provider, 'mimo-plan');
  assert.equal(result.model, 'mimo-v2.6-flash');
  assert.equal(result.text, '梯度下降是一种优化算法。');
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(fetchImpl.calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(fetchImpl.calls[1].url, 'https://api.minimaxi.com/v1/text/chatcompletion_v2');
  assert.equal(fetchImpl.calls[2].url, 'https://token-plan-sgp.xiaomimimo.com/v1/chat/completions');
  assert.ok(logs.some((line) => /降级/.test(line)), '降级应有 log 记录');
  assert.ok(translator.chain.includes('minimax'));
});

test('chain 全部失败：错误可读，包含每个 provider 的失败原因与下一步建议', async () => {
  const fetchImpl = recordFetch(() => {
    throw new TypeError('network unreachable');
  });
  const translator = createTranslator({
    config: baseConfig({ chain: ['deepseek', 'minimax'] }),
    fetchImpl,
  });
  await assert.rejects(
    () => translator.translate({ text: 'hello world' }),
    (err) =>
      /翻译全部 provider 失败/.test(err.message) &&
      /deepseek/.test(err.message) &&
      /minimax/.test(err.message) &&
      /下一步/.test(err.message),
  );
  assert.equal(fetchImpl.calls.length, 2);
});

test('SSE 返回 error 结构：错误信息透出，不静默成功', async () => {
  const fetchImpl = recordFetch(() => responseFromText('data: {"error":{"message":"invalid api_key"}}\n\n'));
  const translator = createTranslator({ config: baseConfig(), fetchImpl });
  await assert.rejects(
    () => translator.translate({ text: 'hello world' }),
    (err) => /invalid api_key/.test(err.message) && /deepseek/.test(err.message),
  );
});

test('未知 provider：createTranslator 直接抛 unknown provider', () => {
  assert.throws(
    () => createTranslator({ config: baseConfig({ provider: 'ark-plan', chain: ['ark-plan'] }) }),
    /unknown provider: ark-plan/,
  );
  assert.throws(
    () => createTranslator({ config: baseConfig({ provider: 'deepseek', chain: ['deepseek', 'nope'] }) }),
    /unknown provider: nope/,
  );
});

/* ------------------------------------------------------------------ *
 * 翻译：mock / 边界
 * ------------------------------------------------------------------ */

test('mock provider：复用 engine/mock.mjs，逐段 onPartial，无网络', async () => {
  const fetchImpl = recordFetch(() => {
    throw new Error('测试失败：mock 不应联网');
  });
  const config = baseConfig({ provider: 'mock', chain: [] });
  const translator = createTranslator({ config, fetchImpl });
  assert.equal(translator.name, 'mock');

  const partials = [];
  const result = await translator.translate({
    text: 'Today we are going to learn about gradient descent.',
    onPartial: (text) => partials.push(text),
  });
  assert.equal(result.text, '今天我们来学习梯度下降。');
  assert.equal(result.provider, 'mock');
  assert.ok(partials.length > 0);
  assert.equal(fetchImpl.calls.length, 0);
});

test('空文本：直接返回空串，不发请求', async () => {
  const fetchImpl = recordFetch(() => {
    throw new Error('测试失败：空文本不应发请求');
  });
  const translator = createTranslator({ config: baseConfig(), fetchImpl });
  const result = await translator.translate({ text: '   ' });
  assert.equal(result.text, '');
  assert.equal(fetchImpl.calls.length, 0);
});

test('空 onPartial / 缺失字段不崩溃', async () => {
  const fetchImpl = recordFetch(() => sseResponse(['梯度下降。', null]));
  const translator = createTranslator({ config: baseConfig(), fetchImpl });
  const result = await translator.translate({ text: 'Gradient descent.' });
  assert.equal(result.text, '梯度下降。');
  assert.deepEqual(await createTranslator({ config: baseConfig(), fetchImpl }).translate({}), {
    text: '',
    model: '',
    provider: 'deepseek',
  });
});

/* ------------------------------------------------------------------ *
 * 字幕：时间轴 / SRT
 * ------------------------------------------------------------------ */

test('formatSrtTime：毫秒 -> HH:MM:SS,mmm', () => {
  assert.equal(formatSrtTime(0), '00:00:00,000');
  assert.equal(formatSrtTime(1500), '00:00:01,500');
  assert.equal(formatSrtTime(3723456), '01:02:03,456');
  assert.equal(formatSrtTime(-10), '00:00:00,000');
  assert.equal(formatSrtTime(Number.NaN), '00:00:00,000');
  assert.equal(formatSrtTime(999.6), '00:00:01,000');
});

test('countChars / cueCps', () => {
  assert.equal(countChars('梯度 descent'), 9);
  assert.equal(countChars('  '), 0);
  assert.equal(cueCps('梯度下降', 2000), 2);
  assert.equal(cueCps('梯度下降', 0), 0);
});

test('formatSrt：毫秒时间轴 -> 标准 SRT（双语、编号、空行、结尾换行）', () => {
  const srt = formatSrt([
    { startMs: 0, endMs: 3000, src: 'Gradient descent', dst: '梯度下降' },
    { startMs: 3000, endMs: 6000, src: 'learning rate', dst: '学习率' },
  ]);
  assert.equal(
    srt,
    [
      '1',
      '00:00:00,000 --> 00:00:03,000',
      'Gradient descent',
      '梯度下降',
      '',
      '2',
      '00:00:03,000 --> 00:00:06,000',
      'learning rate',
      '学习率',
      '',
    ].join('\n'),
  );
});

test('formatSrt：默认过滤 partial，按 id 用后到的 final 覆盖', () => {
  const cues = [
    { id: 7, startMs: 0, endMs: 1200, src: 'Gradient', dst: '梯度', final: false },
    { id: 7, startMs: 0, endMs: 3000, src: 'Gradient descent', dst: '梯度下降', final: true },
    { id: 9, startMs: 3000, endMs: 4200, src: 'partial only', final: false },
    { id: 8, startMs: 4200, endMs: 7200, src: 'learning rate', dst: '学习率', final: true },
  ];
  const srt = formatSrt(cues);
  assert.equal(srt.trim().split(/\n\n/).length, 2, '只导出两条 final cue');
  assert.ok(!srt.includes('partial only'));
  assert.ok(!srt.includes('\nGradient\n'), 'partial 版本不应出现');
  assert.match(srt, /Gradient descent\n梯度下降/);

  const withPartial = formatSrt(cues, { includePartial: true });
  assert.equal(withPartial.trim().split(/\n\n/).length, 3);
  assert.ok(withPartial.includes('partial'));
});

test('formatSrt：支持 t0Ms/t1Ms/text 别名、bilingual=false 只出译文、自动补 end', () => {
  const srt = formatSrt([{ t0Ms: 1000, t1Ms: 2500, text: 'Only text' }], { bilingual: false });
  assert.equal(srt, '1\n00:00:01,000 --> 00:00:02,500\nOnly text\n');

  const dstOnly = formatSrt([{ startMs: 0, endMs: 3000, src: 'Gradient descent', dst: '梯度下降' }], {
    bilingual: false,
  });
  assert.ok(dstOnly.includes('梯度下降'));
  assert.ok(!dstOnly.includes('Gradient descent'));

  const autoEnd = formatSrt([{ startMs: 0, src: '梯度下降', dst: '梯度下降' }]);
  assert.match(autoEnd, /00:00:00,000 --> 00:00:00,445/);
});

test('formatSrt：重叠 cue 顺延、空输入/纯 partial 返回空串', () => {
  const srt = formatSrt(
    [
      { startMs: 0, endMs: 3000, src: 'A' },
      { startMs: 2000, endMs: 4000, src: 'B' },
    ],
    { bilingual: false },
  );
  assert.equal(
    srt,
    ['1', '00:00:00,000 --> 00:00:03,000', 'A', '', '2', '00:00:03,000 --> 00:00:04,000', 'B', ''].join('\n'),
  );
  assert.equal(formatSrt([]), '');
  assert.equal(formatSrt([{ startMs: 0, endMs: 1000, src: 'x', final: false }]), '');
  assert.equal(formatSrt([null, {}, 'bad', { startMs: 0, endMs: 1000 }]), '');
});

test('dedupeCues：同 id 后到覆盖、完全相同去重、按时间排序', () => {
  const cues = dedupeCues([
    { startMs: 3000, endMs: 4000, src: 'b' },
    { id: 1, startMs: 0, endMs: 1000, src: 'a', final: false },
    { id: 1, startMs: 0, endMs: 2000, src: 'a final', final: true },
    { startMs: 3000, endMs: 4000, src: 'b' },
  ]);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].src, 'a final');
  assert.equal(cues[0].final, true);
  assert.equal(cues[1].src, 'b');
});

test('mergeCues：相邻碎片合并，间隔大/字符超限/状态不同不合并', () => {
  const mergedFragments = mergeCues(
    [
      { startMs: 0, endMs: 900, src: 'Gradient descent', dst: '梯度下降' },
      { startMs: 950, endMs: 1800, src: 'is an algorithm', dst: '是一种算法' },
    ],
    { maxGapMs: 150 },
  );
  assert.equal(mergedFragments.length, 1);
  assert.equal(mergedFragments[0].src, 'Gradient descent is an algorithm');
  assert.equal(mergedFragments[0].dst, '梯度下降是一种算法');
  assert.equal(mergedFragments[0].endMs, 1800);

  const tooFar = mergeCues(
    [
      { startMs: 0, endMs: 900, src: 'a' },
      { startMs: 2000, endMs: 3000, src: 'b' },
    ],
    { maxGapMs: 150 },
  );
  assert.equal(tooFar.length, 2);

  const overChars = mergeCues(
    [
      { startMs: 0, endMs: 900, src: 'a'.repeat(30) },
      { startMs: 950, endMs: 1800, src: 'b'.repeat(30) },
    ],
    { maxGapMs: 150, maxCharsPerCue: 20 },
  );
  assert.equal(overChars.length, 2);

  const mixedFinal = mergeCues(
    [
      { startMs: 0, endMs: 900, src: 'a', final: true },
      { startMs: 950, endMs: 1800, src: 'b', final: false },
    ],
    { maxGapMs: 150 },
  );
  assert.equal(mixedFinal.length, 2);
});

/* ------------------------------------------------------------------ *
 * 字幕：断行 / CPS / 双语排版
 * ------------------------------------------------------------------ */

test('wrapLines：英文按词断行，中文按字断行，文本不丢字', () => {
  const english = wrapLines('It is a first order iterative optimization algorithm', { maxCharsPerLine: 12 });
  assert.deepEqual(english, ['It is a', 'first order', 'iterative', 'optimization', 'algorithm']);
  assert.equal(english.join(' '), 'It is a first order iterative optimization algorithm');
  for (const line of english) assert.ok(Array.from(line).length <= 12);

  const chinese = wrapLines('梯度下降是一种一阶迭代优化算法', { maxCharsPerLine: 8 });
  assert.deepEqual(chinese, ['梯度下降是一种一', '阶迭代优化算法']);
  assert.equal(chinese.join(''), '梯度下降是一种一阶迭代优化算法');
});

test('wrapLines：超长单词/URL 硬拆但保留全部字符；空文本返回空数组', () => {
  const url = 'https://example.com/some/very/long/path?q=gredient';
  const lines = wrapLines(url, { maxCharsPerLine: 10 });
  assert.equal(lines.join(''), url);
  for (const line of lines) assert.ok(Array.from(line).length <= 10);
  assert.deepEqual(wrapLines('', { maxCharsPerLine: 10 }), []);
  assert.deepEqual(wrapLines('   ', { maxCharsPerLine: 10 }), []);
});

test('splitCps：按时长收紧行长，收尾标点不落行首', () => {
  // 1.5s * 9cps = 13 字符预算 < maxCharsPerLine 24
  const shortCue = splitCps('梯度下降是一种一阶迭代优化算法', {
    maxCps: 9,
    maxCharsPerLine: 24,
    durationMs: 1500,
  });
  assert.deepEqual(shortCue, ['梯度下降是一种一阶迭代优化', '算法']);

  // 4 字符/行时「。」宁可挂在上一行，也不落到行首
  const punctSafe = splitCps('第一句话。第二句话。', { maxCps: 9, maxCharsPerLine: 4, durationMs: 5000 });
  assert.deepEqual(punctSafe, ['第一句话。', '第二句话。']);

  // 英文按词断行，不切断单词
  const english = splitCps('It is a first order iterative optimization algorithm', {
    maxCps: 9,
    maxCharsPerLine: 12,
    durationMs: 5000,
  });
  assert.equal(english.join(' '), 'It is a first order iterative optimization algorithm');
  assert.ok(english.every((line) => !/^\s|\s$/.test(line)));

  // maxLines 限制：超出部分并入最后一行而不是丢字
  const limited = splitCps('梯度下降是一种一阶迭代优化算法', {
    maxCps: 9,
    maxCharsPerLine: 4,
    durationMs: 5000,
    maxLines: 2,
  });
  assert.equal(limited.length, 2);
  assert.equal(limited.join(''), '梯度下降是一种一阶迭代优化算法');
});

test('wrapBilingual：原文行 + 译文行；支持对象/位置参数；bilingual=false 只出译文', () => {
  const objectForm = wrapBilingual({
    src: 'Gradient descent is an optimization algorithm.',
    dst: '梯度下降是一种优化算法。',
    maxCharsPerLine: 24,
    maxLines: 2,
  });
  assert.equal(objectForm, 'Gradient descent is an optimization algorithm.\n梯度下降是一种优化算法。');

  const positionalForm = wrapBilingual('hello world', '你好世界', { maxCharsPerLine: 20 });
  assert.equal(positionalForm, 'hello world\n你好世界');

  const translatedOnly = wrapBilingual({
    src: 'Gradient descent',
    dst: '梯度下降',
    bilingual: false,
  });
  assert.equal(translatedOnly, '梯度下降');

  const empty = wrapBilingual({ src: '', dst: '' });
  assert.equal(empty, '');
});
