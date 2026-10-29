/**
 * T3 配音输出层单元测试（默认完全离线，不联网、不依赖真模型）。
 *
 * 覆盖：
 *   - splitForTts：空/超长/中英标点/数字与代码不切断/长度上限
 *   - scheduler：正常 / 轻度落后加速 / 严重落后跳过 / 连续排队 / 无效输入
 *   - MiniMax：请求体、hex 解码、SSE 解析（跨 chunk、结束包去重）、失败自动退非流式、错误码
 *   - cloneVoice：上传 WAV + voice_clone + 2061 降级；样本过短保护
 *   - listVoices：get_voice 映射 + 失败回退静态预设
 *   - voice manager：preset / clone-first 累积一次克隆 / 失败永久降级不重试 / 重采样
 *   - macos-say：不 spawn 的纯逻辑（列表/克隆不支持/空文本）
 *
 * 真机测试（macOS say / MiniMax 真实 API / 真实 2061）仅在 LIVEDUB_INTEGRATION=1 时运行：
 *   LIVEDUB_INTEGRATION=1 node --test tests/tts.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// 隔离用户真实 ~/.sayless，避免单测读到真实 Key 或误调真实接口；
// 真机集成模式（LIVEDUB_INTEGRATION=1）则保留真实配置。
const INTEGRATION = process.env.LIVEDUB_INTEGRATION === '1';
if (!INTEGRATION) {
  process.env.SAYLESS_DIR = path.join(os.tmpdir(), 'livedub-tts-test-no-sayless');
  delete process.env.LIVEDUB_PROVIDER_MINIMAX_API_KEY;
}

const { createTts, createTtsWithFallback, splitForTts } = await import('../engine/tts/index.mjs');
const { createScheduler } = await import('../engine/dub/scheduler.mjs');
const { createVoiceManager } = await import('../engine/voice.mjs');
const { createMockTts } = await import('../engine/mock.mjs');
const { pcmDurationMs } = await import('../engine/audio.mjs');

// ---------------------------------------------------------------------------
// 测试工具
// ---------------------------------------------------------------------------

function makePcm(ms, sampleRate = 24000) {
  const n = Math.max(1, Math.round((ms / 1000) * sampleRate));
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(((i * 37) % 4000) - 2000, i * 2);
  return buf;
}

function jsonResponse(obj, { status = 200 } = {}) {
  const text = JSON.stringify(obj);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text;
    },
    async json() {
      return obj;
    },
  };
}

function makeFetchMock(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    return handler(url, init, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}

function sseText(events) {
  return `${events.map((e) => (typeof e === 'string' ? `data: ${e}` : `data: ${JSON.stringify(e)}`)).join('\n\n')}\n\n`;
}

/** 把 SSE 文本按固定字节数切开，模拟 TCP 半包 */
function sseResponse(text, { splitBytes = 11 } = {}) {
  const bytes = new TextEncoder().encode(text);
  return {
    ok: true,
    status: 200,
    async text() {
      return text;
    },
    body: (async function* stream() {
      for (let i = 0; i < bytes.length; i += splitBytes) yield bytes.subarray(i, i + splitBytes);
    })(),
  };
}

function minimaxConfig(overrides = {}) {
  return {
    tts: {
      provider: 'minimax',
      model: 'speech-2.8-hd',
      sampleRate: 24000,
      speed: 1,
      voiceMode: 'preset',
      presetVoices: { default: 'male-qn-qingse', male: 'male-qn-qingse', female: 'female-shaonv', narrator: 'male-qn-qingse' },
      clone: { minSampleSec: 1, maxSampleSec: 5 },
      timeoutMs: 500,
      chunk: { minClauseChars: 8, maxChunkChars: 80 },
      fallbacks: [{ provider: 'minimax', voiceId: 'male-qn-qingse' }, { provider: 'macos-say', voice: 'Tingting' }],
      ...overrides,
    },
    providers: { minimax: { baseUrl: 'https://minimax.test/v1', apiKey: 'test-key-not-real' } },
  };
}

const OK_RESP = { base_resp: { status_code: 0, status_msg: 'success' } };

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function schedulerConfig(overrides = {}) {
  return { dub: { maxLagMs: 4000, maxAccelerate: 1.25, minGapMs: 60, startBufferMs: 120, catchUp: 'accelerate', ...overrides } };
}

// ---------------------------------------------------------------------------
// splitForTts
// ---------------------------------------------------------------------------

test('splitForTts: 空文本 / 空白 / 纯标点返回空数组', () => {
  assert.deepEqual(splitForTts(''), []);
  assert.deepEqual(splitForTts('   \n\t '), []);
  assert.deepEqual(splitForTts('。。。！！！'), []);
  assert.deepEqual(splitForTts(null), []);
  assert.deepEqual(splitForTts(undefined), []);
});

test('splitForTts: 中文句号/叹号切分（默认 minClauseChars=8）', () => {
  const out = splitForTts('今天我们学习梯度下降。它是一阶迭代优化算法！');
  assert.deepEqual(out, ['今天我们学习梯度下降。', '它是一阶迭代优化算法！']);
});

test('splitForTts: 过短子句会合并，避免每几个字发一次 TTS', () => {
  const out = splitForTts('好。的。嗯。今天我们学习梯度下降的基本原理。');
  assert.equal(out.length, 1);
  assert.equal(out[0], '好。的。嗯。今天我们学习梯度下降的基本原理。');
});

test('splitForTts: 英文句号+逗号切分，英文单词保持完整', () => {
  const out = splitForTts('Today we learn gradient descent. It is efficient, and it works.', {
    minClauseChars: 8,
    maxChunkChars: 40,
  });
  assert.deepEqual(out, ['Today we learn gradient descent.', 'It is efficient,', 'and it works.']);
});

test('splitForTts: 不切断数字（1,000 / 3.14）', () => {
  const out = splitForTts('alpha 1,000 beta', { minClauseChars: 1, maxChunkChars: 10 });
  assert.deepEqual(out, ['alpha', '1,000 beta']);

  const out2 = splitForTts('The value is 1,000 and pi is 3.14.', { minClauseChars: 2, maxChunkChars: 12 });
  assert.deepEqual(out2, ['The value is', '1,000 and pi', 'is 3.14.']);
  for (const chunk of out2) assert.ok(!chunk.startsWith('000') && !chunk.startsWith('14'), `数字被切断了: ${chunk}`);
});

test('splitForTts: 不切断代码标识符（优先在空格处切）', () => {
  const out = splitForTts('please call msToSamples later', { minClauseChars: 1, maxChunkChars: 14 });
  assert.deepEqual(out, ['please call', 'msToSamples', 'later']);
  assert.ok(out.includes('msToSamples'), '标识符被截断');
});

test('splitForTts: 无标点超长文本硬切兜底，块长不超过 maxChunkChars 且内容不丢', () => {
  const text = '这是一个没有任何标点的超长句子需要被硬切分成多块才能保证每块长度不超过限制并且内容完整';
  const out = splitForTts(text, { minClauseChars: 8, maxChunkChars: 16 });
  assert.ok(out.length > 1);
  for (const chunk of out) {
    assert.ok(chunk.length > 0, '不允许空块');
    assert.ok(chunk.length <= 16, `块超长: ${chunk.length} / ${chunk}`);
  }
  assert.equal(out.join(''), text, '切块不应丢字');
});

test('splitForTts: 400 字无标点默认 80 字上限', () => {
  const text = '梯'.repeat(400);
  const out = splitForTts(text);
  assert.ok(out.length >= 5);
  for (const chunk of out) assert.ok(chunk.length <= 80);
  assert.equal(out.join(''), text);
});

test('splitForTts: 中英混排 + 换行，重组后仅空白差异', () => {
  const text = '第一段。\n\nSecond sentence! 第三段，有逗号。';
  const out = splitForTts(text, { minClauseChars: 2, maxChunkChars: 20 });
  assert.ok(out.length >= 2);
  const strip = (s) => s.replace(/\s+/g, '');
  assert.equal(out.join('').replace(/\s+/g, ''), strip(text).replace(/\s+/g, ''));
  for (const chunk of out) assert.ok(chunk.length <= 20);
});

test('splitForTts: 切块可个性化配置 min/max', () => {
  const text = 'a。b。c。d。e。f。g。h。i。j。';
  const out = splitForTts(text, { minClauseChars: 100, maxChunkChars: 6 });
  // min 被 clamp 到 max，不会产生超过 max 的块
  for (const chunk of out) assert.ok(chunk.length <= 6, `chunk=${chunk}`);
  assert.ok(out.length >= 2);
  assert.equal(out.join(''), text);
});

// ---------------------------------------------------------------------------
// scheduler
// ---------------------------------------------------------------------------

test('scheduler: 正常（无落后）play rate=1，起点留 startBufferMs', () => {
  const s = createScheduler({ config: schedulerConfig() });
  assert.deepEqual(s.plan({ readyAtMs: 1000, durationMs: 2000, playheadMs: 1000 }), {
    action: 'play',
    startMs: 1120,
    rate: 1,
  });
});

test('scheduler: 落后恰好等于 maxLagMs 不加速', () => {
  const s = createScheduler({ config: schedulerConfig() });
  const r = s.plan({ readyAtMs: 0, durationMs: 2000, playheadMs: 4000 });
  assert.deepEqual(r, { action: 'play', startMs: 4120, rate: 1 });
});

test('scheduler: 轻度落后 -> 按比例加速（rate ∈ (1, maxAccelerate]）', () => {
  const s = createScheduler({ config: schedulerConfig() });
  const r = s.plan({ readyAtMs: 0, durationMs: 8000, playheadMs: 4400 });
  assert.equal(r.action, 'play');
  assert.equal(r.startMs, 4520);
  assert.equal(r.rate, 1.1);
  assert.equal(r.reason, 'catch-up');
});

test('scheduler: 落后较大 -> rate 封顶 maxAccelerate', () => {
  const s = createScheduler({ config: schedulerConfig() });
  const r = s.plan({ readyAtMs: 0, durationMs: 8000, playheadMs: 5000 });
  assert.equal(r.action, 'play');
  assert.equal(r.rate, 1.25);
  assert.ok(r.rate <= 1.25);
});

test('scheduler: 严重落后 -> skip reason=stale 且不推进游标', () => {
  const s = createScheduler({ config: schedulerConfig() });
  const skipped = s.plan({ readyAtMs: 0, durationMs: 2000, playheadMs: 9000 });
  assert.deepEqual(skipped, { action: 'skip', startMs: 9120, rate: 1, reason: 'stale' });
  // 下一条不落后的音频不应该被已丢弃的那条拖住
  const next = s.plan({ readyAtMs: 0, durationMs: 1000, playheadMs: 0 });
  assert.equal(next.action, 'play');
  assert.equal(next.startMs, 120);
});

test('scheduler: catchUp=none 接受落后正常速度播放', () => {
  const s = createScheduler({ config: schedulerConfig({ catchUp: 'none' }) });
  const r = s.plan({ readyAtMs: 0, durationMs: 2000, playheadMs: 9000 });
  assert.equal(r.action, 'play');
  assert.equal(r.rate, 1);
  assert.equal(r.reason, 'lag-accepted');
});

test('scheduler: catchUp=skip 超过 maxLagMs 直接丢弃', () => {
  const s = createScheduler({ config: schedulerConfig({ catchUp: 'skip' }) });
  const r = s.plan({ readyAtMs: 0, durationMs: 2000, playheadMs: 5000 });
  assert.equal(r.action, 'skip');
  assert.equal(r.reason, 'stale');
});

test('scheduler: 连续排队 startMs 单调、不早于上一条结束+minGapMs', () => {
  const s = createScheduler({ config: schedulerConfig() });
  const a = s.plan({ readyAtMs: 0, durationMs: 2000, playheadMs: 0 });
  const b = s.plan({ readyAtMs: 200, durationMs: 1000, playheadMs: 1200 });
  const c = s.plan({ readyAtMs: 300, durationMs: 1000, playheadMs: 1300 });
  assert.deepEqual([a.startMs, b.startMs, c.startMs], [120, 2180, 3240]);
  assert.ok(b.startMs >= a.startMs + a.rate * 0); // 单调
  assert.ok(a.startMs + 2000 / a.rate + 60 <= b.startMs, '排队间隔不足');
  assert.ok(b.startMs + 1000 / b.rate + 60 <= c.startMs, '排队间隔不足');
  const stats = s.stats();
  assert.equal(stats.plans, 3);
  assert.equal(stats.plays, 3);
  assert.equal(stats.lastStartMs, 3240);
});

test('scheduler: 显式 lagMs 优先于 playheadMs 推算', () => {
  const s = createScheduler({ config: schedulerConfig({ startBufferMs: 0, minGapMs: 0 }) });
  const r = s.plan({ readyAtMs: 1000, durationMs: 1000, playheadMs: 1000, lagMs: 100 });
  assert.equal(r.action, 'play');
  assert.equal(r.rate, 1);
});

test('scheduler: pipeline 式调用（playhead=readyAt, 显式 lagMs）—— 延迟 3s 的短音频正常播', () => {
  const s = createScheduler({ config: schedulerConfig() });
  const r = s.plan({ readyAtMs: 10000, durationMs: 1500, playheadMs: 10000, lagMs: 3000 });
  assert.deepEqual(r, { action: 'play', startMs: 10120, rate: 1 });
});

test('scheduler: pipeline 式调用 —— 延迟 5s 且音频很短，即使加速也追不回 -> skip stale', () => {
  const s = createScheduler({ config: schedulerConfig() });
  const r = s.plan({ readyAtMs: 10000, durationMs: 1500, playheadMs: 10000, lagMs: 5000 });
  assert.equal(r.action, 'skip');
  assert.equal(r.reason, 'stale');
});

test('scheduler: 前一条音频把队列推得太长 -> 后一条按有效落后判定 skip', () => {
  const s = createScheduler({ config: schedulerConfig() });
  const first = s.plan({ readyAtMs: 0, durationMs: 6000, playheadMs: 0 });
  const second = s.plan({ readyAtMs: 1000, durationMs: 1000, playheadMs: 1000 });
  assert.equal(first.action, 'play');
  assert.equal(second.action, 'skip');
  assert.equal(second.reason, 'stale');
  assert.ok(second.startMs > first.startMs, 'skip 仍应给出单调的应然起点');
});

test('scheduler: 非法输入抛 RangeError，配置缺省时回退默认值', () => {
  const s = createScheduler({ config: {} });
  assert.throws(() => s.plan({ readyAtMs: -1, durationMs: 1000 }), RangeError);
  assert.throws(() => s.plan({ readyAtMs: 0, durationMs: 0 }), RangeError);
  assert.throws(() => s.plan({ readyAtMs: 0, durationMs: Infinity }), RangeError);
  // 空配置也应有默认值可工作
  assert.equal(s.plan({ readyAtMs: 0, durationMs: 1000 }).action, 'play');
  assert.equal(s.name, 'dub-scheduler');
});

// ---------------------------------------------------------------------------
// MiniMax TTS：请求体 / 响应解析
// ---------------------------------------------------------------------------

test('minimax synthesize: 请求地址/鉴权/body 正确，hex 音频解码为 s16le PCM', async () => {
  const pcm = makePcm(500, 24000);
  const fetchMock = makeFetchMock(async () =>
    jsonResponse({
      data: { audio: pcm.toString('hex'), status: 2 },
      extra_info: { audio_length: 500, audio_sample_rate: 24000, audio_format: 'pcm' },
      base_resp: { status_code: 0, status_msg: 'success' },
    })
  );
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  const res = await tts.synthesize({ text: '同学们好，今天我们学习梯度下降。', voiceId: 'male-qn-qingse', speed: 1.2 });

  assert.equal(fetchMock.calls.length, 1);
  const { url, init } = fetchMock.calls[0];
  assert.equal(url, 'https://minimax.test/v1/t2a_v2');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer test-key-not-real');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'speech-2.8-hd');
  assert.equal(body.stream, false);
  assert.equal(body.text, '同学们好，今天我们学习梯度下降。');
  assert.deepEqual(body.audio_setting, { sample_rate: 24000, format: 'pcm', channel: 1 });
  assert.equal(body.voice_setting.voice_id, 'male-qn-qingse');
  assert.equal(body.voice_setting.speed, 1.2);

  assert.equal(res.pcm.equals(pcm), true);
  assert.equal(res.sampleRate, 24000);
  assert.equal(res.format, 's16le');
  assert.equal(res.durationMs, 500);
  assert.equal(res.voiceId, 'male-qn-qingse');
});

test('minimax synthesize: 未配置 voiceId 时用 presetVoices.default', async () => {
  const pcm = makePcm(100, 24000);
  const fetchMock = makeFetchMock(async () => jsonResponse({ data: { audio: pcm.toString('hex'), status: 2 }, base_resp: { status_code: 0 } }));
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  await tts.synthesize({ text: '测试' });
  assert.equal(JSON.parse(fetchMock.calls[0].init.body).voice_setting.voice_id, 'male-qn-qingse');
});

test('minimax synthesize: base_resp 错误码抛带 code 的可读 Error（含 2061 提示）', async () => {
  for (const [code, msg] of [
    [1004, 'invalid api key'],
    [2061, 'your current token plan not support model'],
  ]) {
    const fetchMock = makeFetchMock(async () => jsonResponse({ base_resp: { status_code: code, status_msg: msg } }));
    const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
    await assert.rejects(
      () => tts.synthesize({ text: '测试' }),
      (err) => {
        assert.equal(err.code, code);
        assert.match(err.message, new RegExp(String(code)));
        assert.match(err.message, /下一步/);
        return true;
      }
    );
  }
});

test('minimax synthesize: HTTP 错误 / 非法 hex 都有清晰报错', async () => {
  const httpMock = makeFetchMock(async () => jsonResponse({ base_resp: {} }, { status: 502 }));
  const tts1 = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: httpMock });
  await assert.rejects(() => tts1.synthesize({ text: '测试' }), /HTTP 502/);

  const badHexMock = makeFetchMock(async () => jsonResponse({ data: { audio: 'not-hex!!' }, base_resp: { status_code: 0 } }));
  const tts2 = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: badHexMock });
  await assert.rejects(() => tts2.synthesize({ text: '测试' }), /hex/);
});

test('minimax synthesize: 空文本 / 超长文本在发请求前抛错', async () => {
  const fetchMock = makeFetchMock(async () => jsonResponse({ data: { audio: '00' }, base_resp: { status_code: 0 } }));
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  await assert.rejects(() => tts.synthesize({ text: '   ' }), /文本为空/);
  await assert.rejects(() => tts.synthesize({ text: '字'.repeat(5001) }), /文本过长/);
  assert.equal(fetchMock.calls.length, 0);
});

test('createTts: 未知 provider / 缺少 apiKey 会抛可读错误', async () => {
  await assert.rejects(() => createTts({ config: { tts: { provider: 'bogus' } } }), /unknown provider: bogus/);
  await assert.rejects(() => createTts({ config: { tts: {} } }), /tts\.provider/);
  // 该用例必须在「无用户配置」环境下验证，否则真实 ~/.sayless 会提供 Key
  const savedDir = process.env.SAYLESS_DIR;
  const savedKey = process.env.LIVEDUB_PROVIDER_MINIMAX_API_KEY;
  process.env.SAYLESS_DIR = path.join(os.tmpdir(), 'livedub-tts-test-no-sayless');
  delete process.env.LIVEDUB_PROVIDER_MINIMAX_API_KEY;
  try {
    await assert.rejects(
      () => createTts({ config: { tts: { provider: 'minimax' }, providers: { minimax: { baseUrl: 'https://x.test/v1' } } } }),
      /apiKey/
    );
  } finally {
    if (savedDir === undefined) delete process.env.SAYLESS_DIR;
    else process.env.SAYLESS_DIR = savedDir;
    if (savedKey !== undefined) process.env.LIVEDUB_PROVIDER_MINIMAX_API_KEY = savedKey;
  }
});

test('createTts: mock provider 离线可用（接口完整）', async () => {
  const tts = await createTts({ config: { tts: { provider: 'mock', sampleRate: 24000, chunk: { minClauseChars: 4 } } }, log: () => {} });
  assert.equal(tts.name, 'mock-tts');
  const res = await tts.synthesize({ text: '你好世界', voiceId: 'mock-female' });
  assert.ok(res.pcm.length > 0);
  assert.equal(res.format, 's16le');
  const voices = await tts.listVoices();
  assert.ok(Array.isArray(voices) && voices.length > 0);
});

// ---------------------------------------------------------------------------
// MiniMax synthesizeStream：SSE 解析 / 结束包去重 / 自动退非流式
// ---------------------------------------------------------------------------

test('minimax synthesizeStream: 逐块 yield 增量音频，结束包全量音频不重复播放', async () => {
  const a = makePcm(200, 24000);
  const b = makePcm(300, 24000);
  const full = Buffer.concat([a, b]);
  const sse = sseText([
    { data: { audio: a.toString('hex'), status: 1 }, base_resp: { status_code: 0 } },
    { data: { audio: b.toString('hex'), status: 1 }, base_resp: { status_code: 0 } },
    { data: { audio: full.toString('hex'), status: 2 }, base_resp: { status_code: 0 } },
  ]);
  const fetchMock = makeFetchMock(async () => sseResponse(sse, { splitBytes: 256 }));
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  const chunks = await collect(tts.synthesizeStream({ text: '同学们好。' }));
  assert.equal(fetchMock.calls.length, 1);
  assert.equal(JSON.parse(fetchMock.calls[0].init.body).stream, true);
  assert.equal(chunks.length, 2, '结束包里的全量音频不应再 yield 一次');
  assert.equal(Buffer.concat(chunks.map((c) => c.pcm)).equals(full), true);
  for (const c of chunks) {
    assert.equal(c.sampleRate, 24000);
    assert.equal(c.format, 's16le');
  }
});

test('minimax synthesizeStream: SSE 跨字节半包 / CRLF 也能正确解析', async () => {
  const pcm = makePcm(120, 24000);
  const sse = sseText([{ data: { audio: pcm.toString('hex'), status: 1 }, base_resp: { status_code: 0 } }]).replace(/\n/g, '\r\n');
  // 去掉末尾空行，模拟连接直接结束
  const fetchMock = makeFetchMock(async () => sseResponse(sse.trimEnd(), { splitBytes: 5 }));
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  const chunks = await collect(tts.synthesizeStream({ text: '测试。' }));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].pcm.equals(pcm), true);
});

test('minimax synthesizeStream: 只有结束包（无增量块）时兜底 yield 全量', async () => {
  const full = makePcm(400, 24000);
  const sse = sseText([{ data: { audio: full.toString('hex'), status: 2 }, base_resp: { status_code: 0 } }]);
  const fetchMock = makeFetchMock(async () => sseResponse(sse));
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  const chunks = await collect(tts.synthesizeStream({ text: '测试。' }));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].pcm.equals(full), true);
});

test('minimax synthesizeStream: 流式失败自动回退非流式（网络错误）', async () => {
  const pcm = makePcm(250, 24000);
  const fetchMock = makeFetchMock(async (url, init, idx) => {
    if (idx === 0) throw new TypeError('fetch failed');
    return jsonResponse({ data: { audio: pcm.toString('hex'), status: 2 }, base_resp: { status_code: 0 } });
  });
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  const chunks = await collect(tts.synthesizeStream({ text: '回退测试。' }));
  assert.equal(fetchMock.calls.length, 2);
  assert.equal(JSON.parse(fetchMock.calls[0].init.body).stream, true);
  assert.equal(JSON.parse(fetchMock.calls[1].init.body).stream, false);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].pcm.equals(pcm), true);
});

test('minimax synthesizeStream: 流式 HTTP 错误也回退非流式', async () => {
  const pcm = makePcm(100, 24000);
  const fetchMock = makeFetchMock(async (url, init, idx) => {
    if (idx === 0) return { ok: false, status: 500, async text() { return 'server error'; } };
    return jsonResponse({ data: { audio: pcm.toString('hex'), status: 2 }, base_resp: { status_code: 0 } });
  });
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  const chunks = await collect(tts.synthesizeStream({ text: '回退测试。' }));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].pcm.equals(pcm), true);
});

test('minimax synthesizeStream: 已 yield 部分音频后中断 -> 抛错而不是整段重放', async () => {
  const a = makePcm(100, 24000);
  const firstEvent = `data: ${JSON.stringify({ data: { audio: a.toString('hex'), status: 1 }, base_resp: { status_code: 0 } })}\n\n`;
  const fetchMock = makeFetchMock(async () => {
    // 先完整交出一个事件（会被 yield），再模拟连接中断
    return {
      ok: true,
      status: 200,
      async text() {
        return '';
      },
      body: (async function* broken() {
        yield new TextEncoder().encode(firstEvent);
        throw new Error('connection reset');
      })(),
    };
  });
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  const seen = [];
  await assert.rejects(
    async () => {
      for await (const c of tts.synthesizeStream({ text: '测试。' })) seen.push(c);
    },
    /connection reset/
  );
  assert.equal(seen.length, 1, '中断前应已 yield 出第一块音频');
  assert.equal(fetchMock.calls.length, 1, '已经 yield 过音频时不应回退重放');
});

test('minimax synthesizeStream: signal 已取消时抛 AbortError', async () => {
  const fetchMock = makeFetchMock(async () => sseResponse(sseText([{ data: { audio: '0000', status: 2 }, base_resp: { status_code: 0 } }])));
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    async () => {
      for await (const _ of tts.synthesizeStream({ text: '测试', signal: ac.signal })) {
        /* noop */
      }
    },
    (err) => err.name === 'AbortError'
  );
});

// ---------------------------------------------------------------------------
// MiniMax cloneVoice / listVoices
// ---------------------------------------------------------------------------

test('minimax cloneVoice: 上传 WAV(purpose=voice_clone) + voice_clone，2061 抛带 code 可读错误', async () => {
  const pcm = makePcm(12000, 16000);
  const fetchMock = makeFetchMock(async (url, init) => {
    if (url.endsWith('/files/upload')) {
      const form = init.body;
      assert.ok(form instanceof FormData, 'upload 应使用 multipart FormData');
      assert.equal(form.get('purpose'), 'voice_clone');
      const file = form.get('file');
      assert.ok(file && typeof file.arrayBuffer === 'function', '缺失采样文件');
      assert.match(file.name, /\.wav$/);
      const bytes = Buffer.from(await file.arrayBuffer());
      assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
      assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
      assert.equal(bytes.length, pcm.length + 44);
      return jsonResponse({ file: { file_id: 457582082547948, bytes: bytes.length, purpose: 'voice_clone' }, base_resp: { status_code: 0 } });
    }
    if (url.endsWith('/voice_clone')) {
      const body = JSON.parse(init.body);
      assert.equal(body.file_id, 457582082547948);
      assert.match(body.voice_id, /^[a-z][a-z0-9]{7,}$/);
      return jsonResponse({
        demo_audio: '',
        input_sensitive: false,
        base_resp: { status_code: 2061, status_msg: 'your current token plan not support model, voice_clone' },
      });
    }
    throw new Error(`unexpected url ${url}`);
  });
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  await assert.rejects(
    () => tts.cloneVoice({ pcm, sampleRate: 16000, name: 'session-speaker' }),
    (err) => {
      assert.equal(err.code, 2061);
      assert.match(err.message, /2061/);
      assert.match(err.message, /voice_clone|Token Plan/);
      return true;
    }
  );
  assert.equal(fetchMock.calls.length, 2);
});

test('minimax cloneVoice: 样本过短/过长在网络请求前拦截', async () => {
  const fetchMock = makeFetchMock(async () => {
    throw new Error('should not be called');
  });
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  await assert.rejects(() => tts.cloneVoice({ pcm: makePcm(2000, 16000), sampleRate: 16000 }), /样本过短/);
  await assert.rejects(() => tts.cloneVoice({ pcm: Buffer.alloc(0), sampleRate: 16000 }), /PCM/);
  assert.equal(fetchMock.calls.length, 0);
});

test('minimax cloneVoice: 成功路径返回 clone 音色信息', async () => {
  const pcm = makePcm(12000, 16000);
  const fetchMock = makeFetchMock(async (url) => {
    if (url.endsWith('/files/upload')) return jsonResponse({ file: { file_id: 'file-1' }, base_resp: { status_code: 0 } });
    return jsonResponse({ voice_id: 'livedubvoice123', base_resp: { status_code: 0 } });
  });
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  const cloned = await tts.cloneVoice({ pcm, sampleRate: 16000, name: 'session-speaker' });
  assert.deepEqual(cloned, { voiceId: 'livedubvoice123', mode: 'clone', provider: 'minimax', name: 'session-speaker' });
});

test('minimax listVoices: 映射 system_voice + voice_cloning，并缓存', async () => {
  const fetchMock = makeFetchMock(async (url, init) => {
    assert.equal(url, 'https://minimax.test/v1/get_voice');
    assert.deepEqual(JSON.parse(init.body), { voice_type: 'all' });
    return jsonResponse({
      system_voice: [
        { voice_id: 'male-qn-qingse', voice_name: '青涩青年音色' },
        { voice_id: 'female-shaonv', voice_name: '少女音色' },
      ],
      voice_cloning: [{ voice_id: 'hackaconluke834068', voice_name: '我的克隆音色' }],
      voice_generation: [],
      base_resp: { status_code: 0, status_msg: 'success' },
    });
  });
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  const voices = await tts.listVoices();
  assert.equal(voices.length, 3);
  assert.deepEqual(voices[0], { id: 'male-qn-qingse', label: '青涩青年音色', gender: 'male', cloned: false });
  assert.equal(voices[2].cloned, true);
  const again = await tts.listVoices();
  assert.equal(again, voices, '应命中内存缓存');
  assert.equal(fetchMock.calls.length, 1);
});

test('minimax listVoices: 接口失败回退静态预设列表（不抛错）', async () => {
  const fetchMock = makeFetchMock(async () => {
    throw new TypeError('offline');
  });
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  const voices = await tts.listVoices();
  assert.ok(Array.isArray(voices) && voices.length > 0);
  assert.ok(voices.some((v) => v.id === 'male-qn-qingse'));
  assert.ok(voices.every((v) => typeof v.label === 'string'));
});

// ---------------------------------------------------------------------------
// createTtsWithFallback：minimax -> macos-say / mock 降级链
// ---------------------------------------------------------------------------

test('tts fallback chain: 主 provider 合成失败自动切 mock 并返回音频', async () => {
  const fetchMock = makeFetchMock(async () => jsonResponse({ base_resp: { status_code: 500, status_msg: 'server down' } }));
  const cfg = minimaxConfig();
  cfg.tts.fallbacks = [{ provider: 'minimax', voiceId: 'male-qn-qingse' }, { provider: 'mock' }];
  const tts = await createTtsWithFallback({ config: cfg, log: () => {}, fetchImpl: fetchMock });
  assert.equal(tts.name, 'minimax');
  assert.deepEqual(tts.providers, ['minimax', 'mock-tts']);
  const res = await tts.synthesize({ text: '降级测试', voiceId: 'male-qn-qingse' });
  assert.ok(res.pcm.length > 0);
  assert.equal(res.format, 's16le');
  assert.equal(fetchMock.calls.length, 1, '主 provider 只失败一次就切走');
});

test('tts fallback chain: 主 provider 创建失败（无 Key）时跳过而不是整体崩', async () => {
  const savedDir = process.env.SAYLESS_DIR;
  const savedKey = process.env.LIVEDUB_PROVIDER_MINIMAX_API_KEY;
  process.env.SAYLESS_DIR = path.join(os.tmpdir(), 'livedub-tts-test-no-sayless');
  delete process.env.LIVEDUB_PROVIDER_MINIMAX_API_KEY;
  try {
    const cfg = { tts: { provider: 'minimax', sampleRate: 24000, presetVoices: { default: 'male-qn-qingse' }, fallbacks: [{ provider: 'mock' }] } };
    const tts = await createTtsWithFallback({ config: cfg, log: () => {} });
    assert.deepEqual(tts.providers, ['mock-tts']);
    const res = await tts.synthesize({ text: '无 Key 兜底' });
    assert.ok(res.pcm.length > 0);
  } finally {
    if (savedDir === undefined) delete process.env.SAYLESS_DIR;
    else process.env.SAYLESS_DIR = savedDir;
    if (savedKey !== undefined) process.env.LIVEDUB_PROVIDER_MINIMAX_API_KEY = savedKey;
  }
});

test('tts fallback chain: 流式主 provider 失败（首包前）自动切 mock 流', async () => {
  const fetchMock = makeFetchMock(async () => {
    throw new TypeError('fetch failed');
  });
  const cfg = minimaxConfig();
  cfg.tts.fallbacks = [{ provider: 'mock' }];
  const tts = await createTtsWithFallback({ config: cfg, log: () => {}, fetchImpl: fetchMock });
  const chunks = await collect(tts.synthesizeStream({ text: '流式降级' }));
  assert.ok(chunks.length > 0);
  assert.ok(Buffer.concat(chunks.map((c) => c.pcm)).length > 0);
});

test('tts fallback chain: 没有任何可用 provider 时抛可读错误', async () => {
  await assert.rejects(() => createTtsWithFallback({ config: { tts: { provider: 'bogus' } } }), /没有可用的 TTS provider/);
});

test('tts fallback chain: signal 取消不触发降级链', async () => {
  const fetchMock = makeFetchMock(async () => jsonResponse({ data: { audio: '0000' }, base_resp: { status_code: 0 } }));
  const cfg = minimaxConfig();
  cfg.tts.fallbacks = [{ provider: 'mock' }];
  const tts = await createTtsWithFallback({ config: cfg, log: () => {}, fetchImpl: fetchMock });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => tts.synthesize({ text: '取消', signal: ac.signal }), (err) => err.name === 'AbortError');
  assert.equal(fetchMock.calls.length, 0);
});

// ---------------------------------------------------------------------------
// macos-say（不 spawn 的纯逻辑；真机合成见文末 integration 测试）
// ---------------------------------------------------------------------------

test('macos-say: 接口完整、listVoices 含配置音色、cloneVoice 明确不支持', async () => {
  const tts = await createTts({
    config: { tts: { provider: 'macos-say', sampleRate: 24000, fallbacks: [{ provider: 'macos-say', voice: 'Tingting' }] } },
    log: () => {},
  });
  assert.equal(tts.name, 'macos-say');
  const voices = await tts.listVoices();
  assert.ok(voices.some((v) => v.id === 'Tingting'));
  await assert.rejects(() => tts.cloneVoice({ pcm: makePcm(1000, 16000), sampleRate: 16000 }), /不支持声音克隆/);
  await assert.rejects(() => tts.synthesize({ text: '  ' }), /文本为空/);
});

// ---------------------------------------------------------------------------
// voice manager：clone-first / 一次性降级
// ---------------------------------------------------------------------------

function voiceConfig(overrides = {}) {
  return {
    tts: {
      voiceMode: 'clone-first',
      sampleRate: 24000,
      presetVoices: { default: 'male-qn-qingse', male: 'male-qn-qingse', female: 'female-shaonv', narrator: 'male-qn-qingse' },
      clone: { minSampleSec: 1, maxSampleSec: 5 },
      ...overrides,
    },
  };
}

test('voiceManager: preset 模式不累积、不尝试克隆；gender 切换预设音色', async () => {
  const tts = createMockTts({ config: voiceConfig() });
  const vm = createVoiceManager({ config: voiceConfig({ voiceMode: 'preset' }), tts, log: () => {} });
  assert.equal(vm.state.mode, 'preset');
  for (let i = 0; i < 5; i++) {
    const r = await vm.ensureVoice({ pcm: makePcm(500, 16000), sampleRate: 16000, gender: i % 2 ? 'female' : 'male' });
    assert.equal(r.mode, 'preset');
    assert.equal(r.degraded, false);
  }
  assert.equal(vm.stats().cloneAttempts, 0);
  assert.equal(vm.state.voiceId, 'male-qn-qingse');
  await vm.ensureVoice({ gender: 'female' });
  assert.equal(vm.state.voiceId, 'female-shaonv');
});

test('voiceManager: clone-first 攒够样本后只克隆一次并切到克隆音色', async () => {
  const tts = createMockTts({ config: voiceConfig() });
  const vm = createVoiceManager({ config: voiceConfig(), tts, log: () => {} });
  const first = await vm.ensureVoice({ pcm: makePcm(400, 16000), sampleRate: 16000 });
  assert.equal(first.mode, 'preset');
  assert.equal(first.degraded, false, '未达阈值不算降级');
  assert.equal(vm.stats().cloneAttempts, 0);
  const second = await vm.ensureVoice({ pcm: makePcm(700, 16000), sampleRate: 16000 });
  assert.equal(second.mode, 'clone');
  assert.match(second.voiceId, /^mock-clone-/);
  const third = await vm.ensureVoice({ pcm: makePcm(700, 16000), sampleRate: 16000 });
  assert.equal(third.mode, 'clone');
  assert.equal(vm.stats().cloneAttempts, 1, '成功之后不应重复克隆');
});

test('voiceManager: 克隆失败一次后永久降级 preset，绝不每句重试', async () => {
  const cfg = voiceConfig();
  const tts = createMockTts({ config: { ...cfg, mock: { cloneFails: true } } });
  const vm = createVoiceManager({ config: cfg, tts, log: () => {} });
  const r1 = await vm.ensureVoice({ pcm: makePcm(1200, 16000), sampleRate: 16000 });
  assert.equal(r1.mode, 'preset');
  assert.equal(r1.degraded, true);
  assert.match(r1.reason, /克隆失败/);
  for (let i = 0; i < 5; i++) {
    const r = await vm.ensureVoice({ pcm: makePcm(500, 16000), sampleRate: 16000 });
    assert.equal(r.mode, 'preset');
    assert.equal(r.degraded, true);
  }
  assert.equal(vm.stats().cloneAttempts, 1, '失败后不得重试');
});

test('voiceManager: TTS 不支持 cloneVoice 时直接降级且不崩', async () => {
  const noCloneTts = { name: 'no-clone', async synthesize() { return { pcm: Buffer.alloc(2), sampleRate: 16000 }; } };
  const vm = createVoiceManager({ config: voiceConfig(), tts: noCloneTts, log: () => {} });
  const r = await vm.ensureVoice({ pcm: makePcm(2000, 16000), sampleRate: 16000 });
  assert.equal(r.mode, 'preset');
  assert.equal(r.degraded, true);
  assert.match(r.reason, /不支持/);
});

test('voiceManager: 24k 样本重采样到 16k 后克隆，样本时长正确', async () => {
  const cloneCalls = [];
  const tts = {
    name: 'spy-tts',
    async cloneVoice(args) {
      cloneCalls.push(args);
      return { voiceId: 'spy-clone' };
    },
  };
  const vm = createVoiceManager({ config: voiceConfig(), tts, log: () => {} });
  const r = await vm.ensureVoice({ pcm: makePcm(1200, 24000), sampleRate: 24000 });
  assert.equal(r.mode, 'clone');
  assert.equal(r.voiceId, 'spy-clone');
  assert.equal(cloneCalls.length, 1);
  assert.equal(cloneCalls[0].sampleRate, 16000);
  const clonedMs = pcmDurationMs(cloneCalls[0].pcm, 16000);
  assert.ok(clonedMs >= 1150 && clonedMs <= 1250, `重采样后时长异常: ${clonedMs}`);
});

test('voiceManager: MiniMax 2061 克隆失败 -> 会话层拿到 degraded 状态而不是异常', async () => {
  const pcm12s = makePcm(12000, 16000);
  const fetchMock = makeFetchMock(async (url) => {
    if (url.endsWith('/files/upload')) return jsonResponse({ file: { file_id: 1 }, base_resp: { status_code: 0 } });
    return jsonResponse({ base_resp: { status_code: 2061, status_msg: 'your current token plan not support model, voice_clone' } });
  });
  const cfg = minimaxConfig({ voiceMode: 'clone-first', clone: { minSampleSec: 10, maxSampleSec: 30 } });
  const tts = await createTts({ config: cfg, log: () => {}, fetchImpl: fetchMock });
  const vm = createVoiceManager({ config: cfg, tts, log: () => {} });
  const r = await vm.ensureVoice({ pcm: pcm12s, sampleRate: 16000 });
  assert.equal(r.mode, 'preset');
  assert.equal(r.degraded, true);
  assert.match(r.reason, /2061/);
  assert.equal(vm.state.voiceId, 'male-qn-qingse');
  const callsAfterFirst = fetchMock.calls.length;
  await vm.ensureVoice({ pcm: makePcm(500, 16000), sampleRate: 16000 });
  assert.equal(fetchMock.calls.length, callsAfterFirst, '降级后不得再请求克隆接口');
});

// ---------------------------------------------------------------------------
// 真机测试（默认跳过）：LIVEDUB_INTEGRATION=1 node --test tests/tts.test.mjs
// ---------------------------------------------------------------------------

test('integration: macOS say 合成中文并输出 24k s16le PCM', { skip: !INTEGRATION }, async () => {
  const tts = await createTts({
    config: { tts: { provider: 'macos-say', sampleRate: 24000, fallbacks: [{ provider: 'macos-say', voice: 'Tingting' }] } },
    log: () => {},
  });
  const res = await tts.synthesize({ text: '同学们好，今天我们学习梯度下降的基本原理。' });
  assert.equal(res.sampleRate, 24000);
  assert.equal(res.format, 's16le');
  assert.equal(res.pcm.length % 2, 0);
  assert.ok(res.durationMs > 500 && res.durationMs < 15000, `时长异常: ${res.durationMs}`);
  assert.ok(res.pcm.length > 1000);
  console.log(`[integration] macos-say: ${res.durationMs}ms @${res.sampleRate}Hz voice=${res.voiceId} bytes=${res.pcm.length}`);
});

test('integration: MiniMax 真实合成（非流式）', { skip: !INTEGRATION }, async () => {
  const { loadConfig } = await import('../engine/config.mjs');
  const config = loadConfig();
  const tts = await createTts({ config, log: () => {} });
  const started = Date.now();
  const res = await tts.synthesize({ text: '同学们好，今天我们学习梯度下降。', voiceId: 'male-qn-qingse' });
  const elapsed = Date.now() - started;
  assert.equal(res.format, 's16le');
  assert.ok(res.pcm.length > 0);
  assert.ok(res.durationMs > 200);
  console.log(`[integration] minimax synthesize: ${res.durationMs}ms @${res.sampleRate}Hz bytes=${res.pcm.length} wall=${elapsed}ms voice=${res.voiceId}`);
});

test('integration: MiniMax 真实流式合成（首包延迟）', { skip: !INTEGRATION }, async () => {
  const { loadConfig } = await import('../engine/config.mjs');
  const config = loadConfig();
  const tts = await createTts({ config, log: () => {} });
  const started = Date.now();
  let firstMs = null;
  let bytes = 0;
  let chunks = 0;
  for await (const chunk of tts.synthesizeStream({ text: '我们今天学习梯度下降的基本原理。' })) {
    if (firstMs == null) firstMs = Date.now() - started;
    bytes += chunk.pcm.length;
    chunks += 1;
  }
  assert.equal(chunks > 0, true);
  assert.ok(bytes > 0);
  assert.ok(firstMs < 5000, `首包太慢: ${firstMs}ms`);
  console.log(`[integration] minimax stream: first=${firstMs}ms chunks=${chunks} bytes=${bytes} duration=${pcmDurationMs(Buffer.alloc(bytes), 24000)}ms`);
});

test('integration: MiniMax 真实 clone 返回 2061 并带 code', { skip: !INTEGRATION }, async () => {
  const { loadConfig } = await import('../engine/config.mjs');
  const config = loadConfig();
  const tts = await createTts({ config, log: () => {} });
  // 本地 say 生成 ~13s 真人语音样本（不算 API 调用）
  const sayConfig = { tts: { provider: 'macos-say', sampleRate: 24000, fallbacks: [{ provider: 'macos-say', voice: 'Tingting' }] } };
  const say = await createTts({ config: sayConfig, log: () => {} });
  const sample = await say.synthesize({
    text: '同学们好，今天我们学习梯度下降的基本原理。它是一种一阶迭代优化算法，我们反复朝着梯度的反方向迈步，逐步逼近损失函数的最小值。',
  });
  await assert.rejects(
    () => tts.cloneVoice({ pcm: sample.pcm, sampleRate: sample.sampleRate, name: 'integration-check' }),
    (err) => {
      // 当前 Token Plan 固定返回 2061；若未来 plan 支持克隆则允许成功（err 不存在）
      assert.equal(err.code, 2061);
      assert.match(err.message, /voice_clone|Token Plan/);
      console.log(`[integration] clone 2061: ${err.message.slice(0, 120)}`);
      return true;
    }
  );
});
