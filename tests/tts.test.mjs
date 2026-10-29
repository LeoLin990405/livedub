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
 *   - 火山引擎（豆包语音）TTS v3：NDJSON data 解码、多行/半包、Resource-Id 推断、错误码映射、401
 *   - 火山声音复刻 v3：WAV 上传、status 2/4 成功、1 训练中、失败/过大、状态查询、凭据 UUID 校验
 *   - v0.3 voice manager 克隆候选链：minimax → volcengine，全失败才降级 preset、只尝试一轮
 *
 * 真机测试（macOS say / MiniMax 真实 API / 真实 2061 / 火山 401）仅在 LIVEDUB_INTEGRATION=1 时运行：
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
  for (const key of ['VOLCENGINE_SPEECH_API_KEY', 'ARS_SPEECH_API_KEY', 'ARK_SPEECH_API_KEY', 'LIVEDUB_PROVIDER_VOLCENGINE_API_KEY']) {
    delete process.env[key];
  }
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

/** 构造 MiniMax t2a_v2 成功响应（hex PCM） */
function t2aResponse(pcm, sampleRate = 24000) {
  return jsonResponse({
    data: { audio: pcm.toString('hex'), status: 2 },
    extra_info: { audio_length: pcmDurationMs(pcm, sampleRate), audio_sample_rate: sampleRate, audio_format: 'pcm' },
    base_resp: { status_code: 0, status_msg: 'success' },
  });
}

/** 构造 get_voice 响应 */
function voicesResponse(list = [{ voice_id: 'male-qn-qingse', voice_name: '青涩青年音色' }]) {
  return jsonResponse({ system_voice: list, voice_cloning: [], voice_generation: [], base_resp: { status_code: 0, status_msg: 'success' } });
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

/** 构造火山语音 TTS 的 NDJSON 响应（逐行 JSON；body 按小片切开模拟半包） */
function ndjsonResponse(lines, { status = 200, splitBytes = 7 } = {}) {
  const text = `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`;
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text;
    },
    async json() {
      return JSON.parse(text);
    },
    body: (async function* body() {
      const bytes = new TextEncoder().encode(text);
      for (let i = 0; i < bytes.length; i += splitBytes) yield bytes.subarray(i, i + splitBytes);
    })(),
  };
}

/** 火山语音错误响应（HTTP 200 + code） */
function volcErrorResponse(code, message = 'error') {
  return ndjsonResponse([{ code, message }]);
}

const VOLC_TEST_KEY = '11111111-2222-3333-4444-555555555555';
const VOLC_TEST_VOICE = 'zh_male_wennuanahu_moon_bigtts';

function volcConfig(overrides = {}) {
  return {
    tts: {
      provider: 'volcengine',
      sampleRate: 24000,
      speed: 1,
      voiceMode: 'preset',
      presetVoices: {
        default: VOLC_TEST_VOICE,
        male: VOLC_TEST_VOICE,
        female: 'zh_female_shuangkuaisisi_moon_bigtts',
      },
      volcengine: { baseUrl: 'https://volc.test', defaultVoice: VOLC_TEST_VOICE },
      clone: { provider: 'volcengine', minSampleSec: 1, maxSampleSec: 5 },
      timeoutMs: 500,
      cache: { enabled: false },
      ...overrides,
    },
    providers: { volcengine: { apiKey: VOLC_TEST_KEY } },
  };
}

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
// v0.2：LRU 缓存
// ---------------------------------------------------------------------------

test('v0.2 cache: 相同 text+voiceId+speed 第二次命中缓存，不再发请求', async () => {
  const pcm = makePcm(300, 24000);
  const fetchMock = makeFetchMock(async () => t2aResponse(pcm));
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  const miss = await tts.synthesize({ text: '梯度下降', voiceId: 'male-qn-qingse', speed: 1 });
  const hit = await tts.synthesize({ text: '梯度下降', voiceId: 'male-qn-qingse', speed: 1 });
  assert.equal(fetchMock.calls.length, 1, '第二次应命中缓存，不再请求 MiniMax');
  assert.equal(hit.pcm.equals(miss.pcm), true);
  assert.equal(hit.durationMs, miss.durationMs);
  assert.equal(hit.sampleRate, 24000);
  const st = tts.stats().cache;
  assert.equal(st.hits, 1);
  assert.equal(st.misses, 1);
  assert.equal(st.lookups, 2);
  assert.equal(st.entries, 1);
  assert.equal(st.hitRate, 0.5);
  assert.ok(st.bytes >= pcm.length);
  assert.equal(st.enabled, true);
});

test('v0.2 cache: key 含 voiceId 与 speed（不同 voice/speed 不串缓存）', async () => {
  const fetchMock = makeFetchMock(async () => t2aResponse(makePcm(120, 24000)));
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  await tts.synthesize({ text: '你好', voiceId: 'male-qn-qingse', speed: 1 });
  await tts.synthesize({ text: '你好', voiceId: 'female-shaonv', speed: 1 }); // 不同 voiceId -> miss
  await tts.synthesize({ text: '你好', voiceId: 'male-qn-qingse', speed: 1.5 }); // 不同 speed -> miss
  await tts.synthesize({ text: '你好', voiceId: 'male-qn-qingse', speed: 1 }); // hit
  assert.equal(fetchMock.calls.length, 3);
  assert.equal(tts.stats().cache.hits, 1);
});

test('v0.2 cache: speed 先钳制再进缓存 key（speed=5 与 speed=2 视为同一请求）', async () => {
  const fetchMock = makeFetchMock(async () => t2aResponse(makePcm(80, 24000)));
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  await tts.synthesize({ text: '钳制键', speed: 5 });
  await tts.synthesize({ text: '钳制键', speed: 2 });
  assert.equal(fetchMock.calls.length, 1);
  assert.equal(JSON.parse(fetchMock.calls[0].init.body).voice_setting.speed, 2);
});

test('v0.2 cache: 关闭缓存时行为不变（每次都请求），stats 可见', async () => {
  const fetchMock = makeFetchMock(async () => t2aResponse(makePcm(100, 24000)));
  const tts = await createTts({
    config: minimaxConfig({ cache: { enabled: false } }),
    log: () => {},
    fetchImpl: fetchMock,
  });
  await tts.synthesize({ text: '不缓存', voiceId: 'male-qn-qingse' });
  await tts.synthesize({ text: '不缓存', voiceId: 'male-qn-qingse' });
  assert.equal(fetchMock.calls.length, 2);
  const st = tts.stats().cache;
  assert.equal(st.enabled, false);
  assert.equal(st.lookups, 0);
  assert.equal(st.entries, 0);
});

test('v0.2 cache: 超过 maxTextChars 的长文本不缓存（避免长句占内存）', async () => {
  const fetchMock = makeFetchMock(async () => t2aResponse(makePcm(100, 24000)));
  const tts = await createTts({
    config: minimaxConfig({ cache: { enabled: true, maxEntries: 64, maxTextChars: 10 } }),
    log: () => {},
    fetchImpl: fetchMock,
  });
  await tts.synthesize({ text: '短文本' }); // 3 字 -> 缓存
  await tts.synthesize({ text: '短文本' }); // hit
  await tts.synthesize({ text: '这是一个明显超过十个字符的较长中文句子' }); // 超长不缓存
  await tts.synthesize({ text: '这是一个明显超过十个字符的较长中文句子' }); // 再次 miss
  assert.equal(fetchMock.calls.length, 3);
  const st = tts.stats().cache;
  assert.equal(st.hits, 1);
  assert.equal(st.skipped, 2);
  assert.equal(st.entries, 1);
});

test('v0.2 cache: LRU 淘汰最久未用的条目', async () => {
  const fetchMock = makeFetchMock(async () => t2aResponse(makePcm(60, 24000)));
  const tts = await createTts({
    config: minimaxConfig({ cache: { enabled: true, maxEntries: 2, maxTextChars: 120 } }),
    log: () => {},
    fetchImpl: fetchMock,
  });
  await tts.synthesize({ text: 'T1' });
  await tts.synthesize({ text: 'T2' });
  await tts.synthesize({ text: 'T3' }); // 淘汰 T1
  let st = tts.stats().cache;
  assert.equal(st.entries, 2);
  assert.equal(st.evictions, 1);
  await tts.synthesize({ text: 'T1' }); // 已淘汰 -> 重新请求
  assert.equal(fetchMock.calls.length, 4);
  st = tts.stats().cache;
  assert.equal(st.entries, 2);
  assert.equal(st.misses, 4);
});

test('v0.2 cache: 流式结果可被随后命中（命中时单块返回，不重复请求）', async () => {
  const a = makePcm(150, 24000);
  const b = makePcm(200, 24000);
  const full = Buffer.concat([a, b]);
  const sse = sseText([
    { data: { audio: a.toString('hex'), status: 1 }, base_resp: { status_code: 0 } },
    { data: { audio: b.toString('hex'), status: 1 }, base_resp: { status_code: 0 } },
    { data: { audio: full.toString('hex'), status: 2 }, base_resp: { status_code: 0 } },
  ]);
  const fetchMock = makeFetchMock(async (url, init) => {
    const body = JSON.parse(init.body);
    return body.stream ? sseResponse(sse, { splitBytes: 256 }) : t2aResponse(full);
  });
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });

  const first = await collect(tts.synthesizeStream({ text: '流式缓存', voiceId: 'male-qn-qingse' }));
  assert.equal(first.length, 2);
  assert.equal(Buffer.concat(first.map((c) => c.pcm)).equals(full), true);

  const second = await collect(tts.synthesizeStream({ text: '流式缓存', voiceId: 'male-qn-qingse' }));
  assert.equal(second.length, 1, '缓存命中时按单块返回');
  assert.equal(second[0].pcm.equals(full), true);

  const viaSynthesize = await tts.synthesize({ text: '流式缓存', voiceId: 'male-qn-qingse' });
  assert.equal(viaSynthesize.pcm.equals(full), true);
  assert.equal(fetchMock.calls.length, 1, '流式写入缓存后 synthesize 也应命中');
  assert.equal(tts.stats().cache.hits, 2);
});

test('v0.2 cache: 消费者中途 break 不写缓存', async () => {
  const a = makePcm(100, 24000);
  const sse = sseText([
    { data: { audio: a.toString('hex'), status: 1 }, base_resp: { status_code: 0 } },
    { data: { audio: a.toString('hex'), status: 1 }, base_resp: { status_code: 0 } },
    { data: { audio: Buffer.concat([a, a]).toString('hex'), status: 2 }, base_resp: { status_code: 0 } },
  ]);
  const fetchMock = makeFetchMock(async (url, init) => {
    const body = JSON.parse(init.body);
    return body.stream ? sseResponse(sse, { splitBytes: 256 }) : t2aResponse(a);
  });
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  const iter = tts.synthesizeStream({ text: '半途而废', voiceId: 'male-qn-qingse' });
  const first = await iter.next();
  assert.equal(first.done, false);
  await iter.return();
  assert.equal(tts.stats().cache.entries, 0, '未消费完不应写缓存');
  await tts.synthesize({ text: '半途而废', voiceId: 'male-qn-qingse' });
  assert.equal(fetchMock.calls.length, 2, '第二次应重新请求（无缓存）');
});

test('v0.2 cache: clearCache() 后重新请求', async () => {
  const fetchMock = makeFetchMock(async () => t2aResponse(makePcm(90, 24000)));
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  await tts.synthesize({ text: '清理缓存' });
  assert.equal(tts.stats().cache.entries, 1);
  tts.clearCache();
  assert.equal(tts.stats().cache.entries, 0);
  await tts.synthesize({ text: '清理缓存' });
  assert.equal(fetchMock.calls.length, 2);
});

// ---------------------------------------------------------------------------
// v0.2：可中断（signal 贯穿 fetch / 子进程；abort 不写缓存）
// ---------------------------------------------------------------------------

test('v0.2 abort: signal 已取消时立刻抛 AbortError，不发请求', async () => {
  const fetchMock = makeFetchMock(async () => t2aResponse(makePcm(50, 24000)));
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => tts.synthesize({ text: '已取消', signal: ac.signal }), (err) => err.name === 'AbortError');
  await assert.rejects(
    async () => {
      for await (const _ of tts.synthesizeStream({ text: '已取消', signal: ac.signal })) {
        /* noop */
      }
    },
    (err) => err.name === 'AbortError'
  );
  assert.equal(fetchMock.calls.length, 0);
  assert.equal(tts.stats().cache.entries, 0);
});

test('v0.2 abort: 合成中途取消 -> AbortError 且不写缓存', async () => {
  const fetchMock = makeFetchMock(
    (url, init) =>
      new Promise((resolve, reject) => {
        const sig = init?.signal;
        const fail = () => reject(new DOMException('aborted', 'AbortError'));
        if (sig?.aborted) return fail();
        sig?.addEventListener('abort', fail, { once: true });
      })
  );
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  const ac = new AbortController();
  const pending = tts.synthesize({ text: '中途取消测试', signal: ac.signal });
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(pending, (err) => err.name === 'AbortError');
  assert.equal(tts.stats().cache.entries, 0);
  assert.equal(tts.stats().cache.stores, 0);
});

test('v0.2 abort: 流式中途取消 -> AbortError 且不写缓存（无未处理 rejection）', async () => {
  const firstPcm = makePcm(60, 24000);
  const firstEvent = `data: ${JSON.stringify({ data: { audio: firstPcm.toString('hex'), status: 1 }, base_resp: { status_code: 0 } })}\n\n`;
  const fetchMock = makeFetchMock((url, init) => ({
    ok: true,
    status: 200,
    async text() {
      return '';
    },
    body: (async function* stream() {
      yield new TextEncoder().encode(firstEvent);
      await new Promise((resolve) => {
        const sig = init?.signal;
        const fallback = setTimeout(resolve, 2000); // 兜底，避免测试挂死
        fallback.unref?.();
        if (sig?.aborted) return resolve();
        sig?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new DOMException('aborted', 'AbortError');
    })(),
  }));
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  const ac = new AbortController();
  const iter = tts.synthesizeStream({ text: '流式中途取消', signal: ac.signal });
  const first = await iter.next();
  assert.equal(first.done, false);
  ac.abort();
  await assert.rejects(() => iter.next(), (err) => err.name === 'AbortError');
  assert.equal(tts.stats().cache.entries, 0);
});

// ---------------------------------------------------------------------------
// v0.2：warmup（失败不致命、幂等、预热 listVoices TTL）
// ---------------------------------------------------------------------------

test('v0.2 warmup: minimax 用一次轻量 get_voice 预热，并顺带填满 listVoices TTL 缓存', async () => {
  const fetchMock = makeFetchMock(async (url) => {
    assert.match(url, /\/get_voice$/);
    return voicesResponse([
      { voice_id: 'male-qn-qingse', voice_name: '青涩青年音色' },
      { voice_id: 'female-shaonv', voice_name: '少女音色' },
    ]);
  });
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  const result = await tts.warmup();
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'minimax');
  assert.equal(result.voices, 2);
  assert.ok(result.elapsedMs >= 0);
  assert.equal(fetchMock.calls.length, 1, 'warmup 只应发 1 次轻量 get_voice');
  const voices = await tts.listVoices();
  assert.equal(voices.length, 2);
  assert.equal(fetchMock.calls.length, 1, 'warmup 后 listVoices 应命中 TTL 缓存');
  const w = tts.stats().warmup;
  assert.equal(w.called, true);
  assert.equal(w.ok, true);
});

test('v0.2 warmup: provider 失败只记录不抛，之后合成仍可用', async () => {
  const pcm = makePcm(100, 24000);
  const fetchMock = makeFetchMock(async (url, init, idx) => {
    if (idx === 0) throw new TypeError('warmup network down');
    return t2aResponse(pcm);
  });
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  const result = await tts.warmup();
  assert.equal(result.ok, false);
  assert.match(result.error, /network/);
  assert.equal(tts.stats().warmup.ok, false);
  const res = await tts.synthesize({ text: '预热失败后合成' });
  assert.equal(res.pcm.equals(pcm), true);
});

test('v0.2 warmup: 幂等（多次调用只预热一次）', async () => {
  const fetchMock = makeFetchMock(async () => voicesResponse());
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  const [a, b] = await Promise.all([tts.warmup(), tts.warmup()]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(fetchMock.calls.length, 1);
});

test('v0.2 warmup: macos-say / mock 也有 warmup 且不 throw', async () => {
  const say = await createTts({
    config: { tts: { provider: 'macos-say', sampleRate: 24000, fallbacks: [{ provider: 'macos-say', voice: 'Tingting' }] } },
    log: () => {},
  });
  const sayResult = await say.warmup();
  assert.equal(sayResult.provider, 'macos-say');
  assert.equal(typeof sayResult.ok, 'boolean');

  const mock = await createTts({ config: { tts: { provider: 'mock', sampleRate: 24000 } }, log: () => {} });
  const mockResult = await mock.warmup();
  assert.equal(mockResult.ok, true);
  assert.deepEqual(Object.keys(mock.stats()).sort(), ['cache', 'name', 'provider', 'voiceList', 'warmup']);
});

// ---------------------------------------------------------------------------
// v0.2：参数校验（voiceId / speed / 文本）+ listVoices TTL
// ---------------------------------------------------------------------------

test('v0.2 参数校验: 非法 voiceId / 空文本 / 超长文本在请求前抛清晰错误', async () => {
  const fetchMock = makeFetchMock(async () => t2aResponse(makePcm(50, 24000)));
  const tts = await createTts({ config: minimaxConfig(), log: () => {}, fetchImpl: fetchMock });
  await assert.rejects(() => tts.synthesize({ text: 'x', voiceId: 123 }), /voiceId 必须是字符串/);
  await assert.rejects(() => tts.synthesize({ text: 'x', voiceId: 'bad\u0000id' }), /控制字符/);
  await assert.rejects(() => tts.synthesize({ text: 'x', voiceId: 'x'.repeat(129) }), /voiceId 过长/);
  await assert.rejects(() => tts.synthesize({ text: '   ' }), /文本为空/);
  await assert.rejects(() => tts.synthesize({ text: '字'.repeat(5001) }), /文本过长/);
  assert.equal(fetchMock.calls.length, 0);
});

test('v0.2 speed 钳制: 0.5 <= speed <= 2.0 后再传给 provider', async () => {
  const fetchMock = makeFetchMock(async () => t2aResponse(makePcm(50, 24000)));
  const tts = await createTts({ config: minimaxConfig({ cache: { enabled: false } }), log: () => {}, fetchImpl: fetchMock });
  const speedOf = (call) => JSON.parse(call.init.body).voice_setting.speed;
  await tts.synthesize({ text: '速度一', speed: 5 });
  await tts.synthesize({ text: '速度二', speed: 0.1 });
  await tts.synthesize({ text: '速度三', speed: 'not-a-number' });
  await tts.synthesize({ text: '速度四', speed: 1.3 });
  assert.deepEqual(fetchMock.calls.map(speedOf), [2, 0.5, 1, 1.3]);
});

test('v0.2 listVoices: 短 TTL 缓存，过期后重新获取', async () => {
  const fetchMock = makeFetchMock(async () => voicesResponse());
  const tts = await createTts({
    config: minimaxConfig({ voiceListTtlMs: 30 }),
    log: () => {},
    fetchImpl: fetchMock,
  });
  const a = await tts.listVoices();
  const b = await tts.listVoices();
  assert.equal(a, b, 'TTL 内应返回同一份缓存');
  assert.equal(fetchMock.calls.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 45));
  await tts.listVoices();
  assert.equal(fetchMock.calls.length, 2, 'TTL 过期后应重新请求');
  assert.equal(tts.stats().voiceList.fetches, 2);
  assert.equal(typeof tts.stats().voiceList.ttlMs, 'number');
});

test('v0.2 降级链: warmup / stats / 缓存 均可用', async () => {
  const fetchMock = makeFetchMock(async () => {
    throw new TypeError('primary down');
  });
  const cfg = minimaxConfig();
  cfg.tts.fallbacks = [{ provider: 'mock' }];
  const tts = await createTtsWithFallback({ config: cfg, log: () => {}, fetchImpl: fetchMock });
  const warm = await tts.warmup();
  assert.equal(warm.providers.length, 2);
  assert.equal(typeof warm.ok, 'boolean');
  const first = await tts.synthesize({ text: '降级链缓存' });
  const second = await tts.synthesize({ text: '降级链缓存' });
  assert.equal(first.pcm.equals(second.pcm), true);
  const stats = tts.stats();
  assert.equal(stats.providers.length, 2);
  assert.ok(stats.providers[1].cache.hits >= 1, 'fallback provider 的缓存应在工作');
  assert.ok(stats.providers[1].cache.entries >= 1);
  tts.clearCache();
  const afterClear = tts.stats();
  assert.equal(afterClear.providers[0].cache.entries, 0);
  assert.equal(afterClear.providers[1].cache.entries, 0);
});

// ---------------------------------------------------------------------------
// v0.3 火山引擎 TTS v3（NDJSON 流式 / Resource-Id / 错误码）
// ---------------------------------------------------------------------------

test('volcengine TTS: 请求地址/headers/body 正确，多行 NDJSON data 拼接为 PCM', async () => {
  const a = makePcm(120, 24000);
  const b = makePcm(180, 24000);
  const fetchMock = makeFetchMock(async () =>
    ndjsonResponse([
      { code: 0, message: '', data: a.toString('base64') },
      { code: 0, message: '', data: b.toString('base64') },
    ])
  );
  const tts = await createTts({ config: volcConfig(), log: () => {}, fetchImpl: fetchMock });
  const res = await tts.synthesize({ text: '同学们好，今天我们学习梯度下降。', voiceId: VOLC_TEST_VOICE });

  assert.equal(fetchMock.calls.length, 1);
  const { url, init } = fetchMock.calls[0];
  assert.equal(url, 'https://volc.test/api/v3/tts/unidirectional');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['X-Api-Key'], VOLC_TEST_KEY);
  assert.equal(init.headers['X-Api-Resource-Id'], 'volc.service_type.10029');
  assert.match(init.headers['X-Api-Request-Id'], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  const body = JSON.parse(init.body);
  assert.equal(body.req_params.text, '同学们好，今天我们学习梯度下降。');
  assert.equal(body.req_params.speaker, VOLC_TEST_VOICE);
  assert.deepEqual(body.req_params.audio_params, { format: 'pcm', sample_rate: 24000 });

  assert.equal(res.pcm.equals(Buffer.concat([a, b])), true);
  assert.equal(res.sampleRate, 24000);
  assert.equal(res.format, 's16le');
  assert.equal(res.durationMs, 300);
  assert.equal(res.voiceId, VOLC_TEST_VOICE);
});

test('volcengine TTS: X-Api-Resource-Id 按音色类型推断（S_→seed-icl-2.0 / uranus→seed-tts-2.0 / 其它→10029）', async () => {
  const cases = [
    ['S_clone_abc', 'seed-icl-2.0'],
    ['zh_male_uranus_demo', 'seed-tts-2.0'],
    ['zh_female_x_moon_bigtts', 'volc.service_type.10029'],
  ];
  for (const [voiceId, expected] of cases) {
    const fetchMock = makeFetchMock(async () => ndjsonResponse([{ code: 0, data: makePcm(40).toString('base64') }]));
    const tts = await createTts({ config: volcConfig(), log: () => {}, fetchImpl: fetchMock });
    await tts.synthesize({ text: '资源 id 测试', voiceId });
    assert.equal(fetchMock.calls[0].init.headers['X-Api-Resource-Id'], expected, `voiceId=${voiceId}`);
  }
});

test('volcengine TTS: config.resourceId 可覆盖自动推断（S_ 复刻音色被误配时也以配置为准）', async () => {
  const cfg = volcConfig({ volcengine: { baseUrl: 'https://volc.test', defaultVoice: VOLC_TEST_VOICE, resourceId: 'seed-icl-2.0' } });
  const fetchMock = makeFetchMock(async () => ndjsonResponse([{ code: 0, data: makePcm(40).toString('base64') }]));
  const tts = await createTts({ config: cfg, log: () => {}, fetchImpl: fetchMock });
  await tts.synthesize({ text: '覆盖资源 id' });
  assert.equal(fetchMock.calls[0].init.headers['X-Api-Resource-Id'], 'seed-icl-2.0');
});

test('volcengine TTS: NDJSON 跨 chunk 半包 / CRLF / 容忍 data: 前缀 / SSE 心跳行', async () => {
  const pcm = makePcm(90, 24000);
  const raw = `\r\n: heartbeat\r\n\r\ndata: ${JSON.stringify({ code: 0, data: pcm.toString('base64') })}\r\n`;
  const fetchMock = makeFetchMock(async () => ({
    ok: true,
    status: 200,
    async text() {
      return raw;
    },
    body: (async function* body() {
      const bytes = new TextEncoder().encode(raw);
      for (let i = 0; i < bytes.length; i += 5) yield bytes.subarray(i, i + 5);
    })(),
  }));
  const tts = await createTts({ config: volcConfig(), log: () => {}, fetchImpl: fetchMock });
  const res = await tts.synthesize({ text: '半包解析' , voiceId: VOLC_TEST_VOICE });
  assert.equal(res.pcm.equals(pcm), true);
});

test('volcengine TTS: synthesizeStream 边收边 yield（多个 data 行 → 多块）', async () => {
  const a = makePcm(50, 24000);
  const b = makePcm(70, 24000);
  const c = makePcm(30, 24000);
  const fetchMock = makeFetchMock(async () =>
    ndjsonResponse(
      [
        { code: 0, data: a.toString('base64') },
        { code: 0, data: b.toString('base64') },
        { code: 0, data: c.toString('base64') },
        { code: 0, data: '' },
      ],
      { splitBytes: 11 }
    )
  );
  const tts = await createTts({ config: volcConfig(), log: () => {}, fetchImpl: fetchMock });
  const chunks = await collect(tts.synthesizeStream({ text: '流式火山', voiceId: VOLC_TEST_VOICE }));
  assert.equal(chunks.length, 3);
  assert.equal(Buffer.concat(chunks.map((x) => x.pcm)).equals(Buffer.concat([a, b, c])), true);
  for (const chunk of chunks) assert.equal(chunk.sampleRate, 24000);
});

test('volcengine TTS: 错误码 45000010 / 55000000 / 45000030 映射为可读错误 + 提示', async () => {
  const cases = [
    [45000010, /X-Api-Key|45000010/, /UUID/],
    [55000000, /speaker|55000000/, /seed-icl-2\.0|Resource-Id/],
    [45000030, /45000030/, /权限|ark-|UUID Key/],
  ];
  for (const [code, messageRe, hintRe] of cases) {
    const fetchMock = makeFetchMock(async () => volcErrorResponse(code, 'volc says no'));
    const tts = await createTts({ config: volcConfig(), log: () => {}, fetchImpl: fetchMock });
    await assert.rejects(
      () => tts.synthesize({ text: '错误码映射', voiceId: VOLC_TEST_VOICE }),
      (err) => {
        assert.equal(err.code, code);
        assert.match(err.message, messageRe);
        assert.match(err.message, hintRe);
        return true;
      }
    );
  }
});

test('volcengine TTS: 错误码嵌在 header 里也能识别（真实 401 body 形态）', async () => {
  const fetchMock = makeFetchMock(async () =>
    ndjsonResponse([{ header: { code: 45000010, message: 'Invalid X-Api-Key' } }])
  );
  const tts = await createTts({ config: volcConfig(), log: () => {}, fetchImpl: fetchMock });
  await assert.rejects(
    () => tts.synthesize({ text: 'header 错误码', voiceId: VOLC_TEST_VOICE }),
    (err) => err.code === 45000010 && /Invalid X-Api-Key|UUID/.test(err.message)
  );
});

test('volcengine TTS: HTTP 401 鉴权失败给出 UUID Key 开通提示', async () => {
  const fetchMock = makeFetchMock(async () => ({
    ok: false,
    status: 401,
    async text() {
      return 'unauthorized';
    },
  }));
  const tts = await createTts({ config: volcConfig(), log: () => {}, fetchImpl: fetchMock });
  await assert.rejects(
    () => tts.synthesize({ text: '401 测试', voiceId: VOLC_TEST_VOICE }),
    (err) => {
      assert.equal(err.code, 401);
      assert.match(err.message, /401|鉴权失败/);
      assert.match(err.message, /UUID Key|豆包语音控制台/);
      return true;
    }
  );
});

test('volcengine TTS: 空音频 / 缺 speaker / 已 abort 的清晰错误', async () => {
  const emptyMock = makeFetchMock(async () => ndjsonResponse([{ code: 0, data: '' }]));
  const tts1 = await createTts({ config: volcConfig(), log: () => {}, fetchImpl: emptyMock });
  await assert.rejects(() => tts1.synthesize({ text: '空音频', voiceId: VOLC_TEST_VOICE }), /0 字节|空/);

  const cfgNoVoice = volcConfig({ presetVoices: {}, volcengine: { baseUrl: 'https://volc.test' } });
  const tts2 = await createTts({ config: cfgNoVoice, log: () => {}, fetchImpl: makeFetchMock(async () => ndjsonResponse([])) });
  await assert.rejects(() => tts2.synthesize({ text: '缺音色' }), /speaker|音色 ID/);

  const ac = new AbortController();
  ac.abort();
  const tts3 = await createTts({ config: volcConfig(), log: () => {}, fetchImpl: makeFetchMock(async () => ndjsonResponse([])) });
  await assert.rejects(() => tts3.synthesize({ text: '取消', signal: ac.signal }), (err) => err.name === 'AbortError');
});

test('volcengine TTS: warmup 纯本地（不发请求）且返回 ok', async () => {
  const fetchMock = makeFetchMock(async () => ndjsonResponse([]));
  const tts = await createTts({ config: volcConfig(), log: () => {}, fetchImpl: fetchMock });
  const warm = await tts.warmup();
  assert.equal(warm.ok, true);
  assert.equal(warm.provider, 'volcengine');
  assert.equal(fetchMock.calls.length, 0);
});

test('volcengine TTS: 走 createTts 缓存后重复短语不重复请求', async () => {
  const pcm = makePcm(80, 24000);
  const fetchMock = makeFetchMock(async () => ndjsonResponse([{ code: 0, data: pcm.toString('base64') }]));
  const cfg = volcConfig({ cache: { enabled: true, maxEntries: 8, maxTextChars: 120 } });
  const tts = await createTts({ config: cfg, log: () => {}, fetchImpl: fetchMock });
  await tts.synthesize({ text: '重复术语', voiceId: VOLC_TEST_VOICE });
  const hit = await tts.synthesize({ text: '重复术语', voiceId: VOLC_TEST_VOICE });
  assert.equal(fetchMock.calls.length, 1);
  assert.equal(hit.pcm.equals(pcm), true);
});

// ---------------------------------------------------------------------------
// v0.3 火山引擎凭据（UUID 校验 / env 别名 / 拒 ark-）
// ---------------------------------------------------------------------------

test('volcengine 凭据: 缺 Key / ark- Key / 非 UUID 都给出可读开通提示（不发请求）', async () => {
  const saved = process.env.SAYLESS_DIR;
  process.env.SAYLESS_DIR = path.join(os.tmpdir(), 'livedub-tts-test-no-sayless');
  try {
    await assert.rejects(
      () => createTts({ config: { tts: { provider: 'volcengine' }, providers: {} }, log: () => {} }),
      (err) => {
        assert.equal(err.code, 'missing_api_key');
        assert.match(err.message, /豆包语音|UUID Key/);
        assert.match(err.message, /开通|控制台/);
        return true;
      }
    );
    await assert.rejects(
      () => createTts({ config: { tts: { provider: 'volcengine' }, providers: { volcengine: { apiKey: 'ark-12345678-abcd' } } }, log: () => {} }),
      (err) => {
        assert.equal(err.code, 'ark_key_not_supported');
        assert.match(err.message, /ark-/);
        assert.match(err.message, /不能调用|没有语音权限/);
        return true;
      }
    );
    await assert.rejects(
      () => createTts({ config: { tts: { provider: 'volcengine' }, providers: { volcengine: { apiKey: 'not-a-uuid-key' } } }, log: () => {} }),
      (err) => {
        assert.equal(err.code, 'bad_api_key_format');
        assert.match(err.message, /UUID/);
        return true;
      }
    );
  } finally {
    if (saved === undefined) delete process.env.SAYLESS_DIR;
    else process.env.SAYLESS_DIR = saved;
  }
});

test('volcengine 凭据: env 别名 VOLCENGINE_SPEECH_API_KEY / ARS_SPEECH_API_KEY 可用', async () => {
  const saved = {
    VOLCENGINE: process.env.VOLCENGINE_SPEECH_API_KEY,
    ARS: process.env.ARS_SPEECH_API_KEY,
    ARK: process.env.ARK_SPEECH_API_KEY,
  };
  try {
    delete process.env.ARS_SPEECH_API_KEY;
    delete process.env.ARK_SPEECH_API_KEY;
    process.env.VOLCENGINE_SPEECH_API_KEY = VOLC_TEST_KEY;
    const tts1 = await createTts({ config: { tts: { provider: 'volcengine' }, providers: {} }, log: () => {} });
    assert.equal(tts1.name, 'volcengine');

    delete process.env.VOLCENGINE_SPEECH_API_KEY;
    process.env.ARS_SPEECH_API_KEY = VOLC_TEST_KEY;
    const tts2 = await createTts({ config: { tts: { provider: 'volcengine' }, providers: {} }, log: () => {} });
    assert.equal(tts2.name, 'volcengine');
  } finally {
    if (saved.VOLCENGINE === undefined) delete process.env.VOLCENGINE_SPEECH_API_KEY;
    else process.env.VOLCENGINE_SPEECH_API_KEY = saved.VOLCENGINE;
    if (saved.ARS === undefined) delete process.env.ARS_SPEECH_API_KEY;
    else process.env.ARS_SPEECH_API_KEY = saved.ARS;
    if (saved.ARK === undefined) delete process.env.ARK_SPEECH_API_KEY;
    else process.env.ARK_SPEECH_API_KEY = saved.ARK;
  }
});

// ---------------------------------------------------------------------------
// v0.3 火山声音复刻 v3（voice_clone）
// ---------------------------------------------------------------------------

function decodeWavFromCloneBody(init) {
  const body = JSON.parse(init.body);
  const bytes = Buffer.from(body.audio.data, 'base64');
  return { body, bytes };
}

test('volcengine cloneVoice: status=2 成功，上传 base64 WAV（RIFF）+ language/extra_params 正确', async () => {
  const pcm = makePcm(12000, 16000);
  const fetchMock = makeFetchMock(async () => jsonResponse({ code: 0, message: '', status: 2, speaker_id: 'S_clone_ready_1' }));
  const tts = await createTts({ config: volcConfig(), log: () => {}, fetchImpl: fetchMock });
  const cloned = await tts.cloneVoice({ pcm, sampleRate: 16000, name: 'session-speaker' });

  assert.equal(cloned.mode, 'clone');
  assert.equal(cloned.provider, 'volcengine');
  assert.equal(cloned.voiceId, 'S_clone_ready_1');
  assert.equal(fetchMock.calls.length, 1);
  const { url, init } = fetchMock.calls[0];
  assert.equal(url, 'https://volc.test/api/v3/tts/voice_clone');
  assert.equal(init.headers['X-Api-Key'], VOLC_TEST_KEY);
  assert.match(init.headers['X-Api-Request-Id'], /^[0-9a-f-]{36}$/i);
  assert.equal(init.headers['X-Api-Resource-Id'], undefined, '复刻接口只带 X-Api-Key + X-Api-Request-Id');
  const { body, bytes } = decodeWavFromCloneBody(init);
  assert.match(body.speaker_id, /^S_[A-Za-z0-9_]+$/);
  assert.equal(body.audio.format, 'wav');
  assert.equal(body.language, 1);
  assert.equal(body.extra_params.enable_audio_denoise, true);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.length, pcm.length + 44);
});

test('volcengine cloneVoice: status=4 也视为可用；显式 voiceId 必须 S_ 前缀', async () => {
  const fetchMock = makeFetchMock(async () => jsonResponse({ code: 0, status: 4, speaker_id: 'S_custom_voice_9' }));
  const tts = await createTts({ config: volcConfig(), log: () => {}, fetchImpl: fetchMock });
  const cloned = await tts.cloneVoice({ pcm: makePcm(12000, 16000), sampleRate: 16000, voiceId: 'S_custom_voice_9' });
  assert.equal(cloned.voiceId, 'S_custom_voice_9');
  const body = JSON.parse(fetchMock.calls[0].init.body);
  assert.equal(body.speaker_id, 'S_custom_voice_9');

  await assert.rejects(
    () => tts.cloneVoice({ pcm: makePcm(12000, 16000), sampleRate: 16000, voiceId: 'no-prefix' }),
    (err) => err.code === 'bad_speaker_id' && /S_/.test(err.message)
  );
  assert.equal(fetchMock.calls.length, 1, '非法 speaker_id 应在请求前拦截');
});

test('volcengine cloneVoice: status=1 训练中 -> 明确错误（voice manager 会降级 preset）', async () => {
  const fetchMock = makeFetchMock(async () => jsonResponse({ code: 0, status: 1, speaker_id: 'S_training_1' }));
  const tts = await createTts({ config: volcConfig(), log: () => {}, fetchImpl: fetchMock });
  await assert.rejects(
    () => tts.cloneVoice({ pcm: makePcm(12000, 16000), sampleRate: 16000 }),
    (err) => {
      assert.equal(err.code, 'voice_clone_training');
      assert.match(err.message, /训练中/);
      assert.match(err.message, /降级|重试|voiceCloneStatus/);
      return true;
    }
  );
});

test('volcengine cloneVoice: 业务失败码 / HTTP 401 / 音频超 10MB 都有可读错误', async () => {
  const codeMock = makeFetchMock(async () => jsonResponse({ code: 45000010, message: 'Invalid X-Api-Key' }));
  const tts1 = await createTts({ config: volcConfig(), log: () => {}, fetchImpl: codeMock });
  await assert.rejects(
    () => tts1.cloneVoice({ pcm: makePcm(12000, 16000), sampleRate: 16000 }),
    (err) => err.code === 45000010 && /X-Api-Key|45000010/.test(err.message)
  );

  const httpMock = makeFetchMock(async () => ({ ok: false, status: 401, async text() { return 'unauthorized'; } }));
  const tts2 = await createTts({ config: volcConfig(), log: () => {}, fetchImpl: httpMock });
  await assert.rejects(
    () => tts2.cloneVoice({ pcm: makePcm(12000, 16000), sampleRate: 16000 }),
    (err) => err.code === 401 && /401|鉴权/.test(err.message)
  );

  const noFetch = makeFetchMock(async () => jsonResponse({ code: 0, status: 2 }));
  const tts3 = await createTts({ config: volcConfig(), log: () => {}, fetchImpl: noFetch });
  const tooLarge = Buffer.alloc(Math.ceil((10 * 1024 * 1024) / 2) * 2); // 10MB PCM -> WAV 超过 10MB
  await assert.rejects(
    () => tts3.cloneVoice({ pcm: tooLarge, sampleRate: 16000 }),
    (err) => err.code === 'audio_too_large' && /10MB/.test(err.message)
  );
  assert.equal(noFetch.calls.length, 0);
});

test('volcengine cloneVoice: 样本 <10s 在请求前拦截（火山 v3 要求 10s-5min）', async () => {
  const fetchMock = makeFetchMock(async () => jsonResponse({ code: 0, status: 2 }));
  const tts = await createTts({ config: volcConfig(), log: () => {}, fetchImpl: fetchMock });
  await assert.rejects(
    () => tts.cloneVoice({ pcm: makePcm(3000, 16000), sampleRate: 16000 }),
    (err) => err.code === 'sample_too_short' && /10s/.test(err.message)
  );
  assert.equal(fetchMock.calls.length, 0);
});

test('volcengine voiceCloneStatus: 尽力而为的状态查询（ready / 不可用都不抛）', async () => {
  const readyMock = makeFetchMock(async (url) => {
    assert.match(url, /\/api\/v3\/tts\/voice_clone\?speaker_id=S_ready_1$/);
    return jsonResponse({ code: 0, status: 4, speaker_id: 'S_ready_1' });
  });
  const tts1 = await createTts({ config: volcConfig(), log: () => {}, fetchImpl: readyMock });
  const ready = await tts1.voiceCloneStatus('S_ready_1');
  assert.equal(ready.ok, true);
  assert.equal(ready.statusText, 'ready');

  const unavailableMock = makeFetchMock(async () => ({ ok: false, status: 404, async text() { return 'not found'; } }));
  const tts2 = await createTts({ config: volcConfig(), log: () => {}, fetchImpl: unavailableMock });
  const unavailable = await tts2.voiceCloneStatus('S_x');
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.supported, false);
});

test('volcengine listVoices: 配置音色 + S_ 复刻音色 + 静态公版兜底', async () => {
  const cfg = volcConfig({
    volcengine: {
      baseUrl: 'https://volc.test',
      defaultVoice: VOLC_TEST_VOICE,
      voices: [{ id: 'zh_custom_voice_1', label: '自定义音色', gender: 'female' }],
      clonedVoices: ['S_my_clone_1'],
    },
  });
  const tts = await createTts({ config: cfg, log: () => {}, fetchImpl: makeFetchMock(async () => jsonResponse({})) });
  const voices = await tts.listVoices();
  assert.ok(voices.find((v) => v.id === 'zh_custom_voice_1' && v.label === '自定义音色'));
  assert.ok(voices.find((v) => v.id === 'S_my_clone_1' && v.cloned === true));
  assert.ok(voices.find((v) => v.id === VOLC_TEST_VOICE));
});

// ---------------------------------------------------------------------------
// v0.3 voice manager：克隆候选链 minimax -> volcengine
// ---------------------------------------------------------------------------

function chainVoiceConfig(overrides = {}) {
  return {
    tts: {
      voiceMode: 'clone-first',
      sampleRate: 24000,
      presetVoices: { default: 'male-qn-qingse', male: 'male-qn-qingse', female: 'female-shaonv' },
      clone: { provider: 'minimax', minSampleSec: 1, maxSampleSec: 5, ...overrides },
    },
  };
}

function fakeCloneProvider({ provider, voiceId, fail } = {}) {
  return {
    name: provider,
    cloneCalls: 0,
    async cloneVoice() {
      this.cloneCalls += 1;
      if (fail) throw fail;
      return { voiceId: voiceId || `S_${provider}_clone`, mode: 'clone', provider };
    },
  };
}

test('voice 克隆链: minimax 失败（2061）后自动尝试 volcengine 并成功', async () => {
  const primary = {
    name: 'minimax',
    async cloneVoice() {
      const err = new Error('[tts:minimax] voice_clone 失败：plan not support（base_resp.status_code=2061）');
      err.code = 2061;
      throw err;
    },
  };
  const volcFake = fakeCloneProvider({ provider: 'volcengine', voiceId: 'S_volc_clone_abc' });
  const factoryCalls = [];
  const vm = createVoiceManager({
    config: chainVoiceConfig(),
    tts: primary,
    log: () => {},
    createTtsImpl: ({ config }) => {
      factoryCalls.push(config.tts.provider);
      if (config.tts.provider === 'volcengine') return volcFake;
      throw new Error(`unexpected provider ${config.tts.provider}`);
    },
  });
  const result = await vm.ensureVoice({ pcm: makePcm(1200, 16000), sampleRate: 16000 });
  assert.equal(result.mode, 'clone');
  assert.equal(result.voiceId, 'S_volc_clone_abc');
  assert.equal(result.degraded, false);
  const stats = vm.stats();
  assert.equal(stats.cloneProvider, 'volcengine');
  assert.deepEqual(stats.cloneProviderChain, ['minimax', 'volcengine']);
  assert.equal(stats.cloneFailures.length, 1);
  assert.equal(stats.cloneFailures[0].provider, 'minimax');
  assert.deepEqual(factoryCalls, ['volcengine']);
});

test('voice 克隆链: 全失败才降级 preset，只尝试一轮、不重试', async () => {
  const primary = {
    name: 'minimax',
    async cloneVoice() {
      const err = new Error('plan not support');
      err.code = 2061;
      throw err;
    },
  };
  let factoryCalls = 0;
  const vm = createVoiceManager({
    config: chainVoiceConfig(),
    tts: primary,
    log: () => {},
    createTtsImpl: () => {
      factoryCalls += 1;
      const err = new Error('[tts:volcengine] 缺少火山引擎（豆包语音）API Key');
      err.code = 'missing_api_key';
      throw err;
    },
  });
  const first = await vm.ensureVoice({ pcm: makePcm(1200, 16000), sampleRate: 16000 });
  assert.equal(first.mode, 'preset');
  assert.equal(first.degraded, true);
  assert.match(first.reason, /minimax/);
  assert.match(first.reason, /volcengine/);
  assert.match(first.reason, /2061/);
  assert.match(first.reason, /missing_api_key|API Key/);
  assert.equal(vm.stats().cloneAttempts, 1);
  assert.equal(factoryCalls, 1, 'volcengine 客户端只创建/尝试一次');

  // 再来 3 句：绝不重试
  for (let i = 0; i < 3; i++) {
    const r = await vm.ensureVoice({ pcm: makePcm(300, 16000), sampleRate: 16000 });
    assert.equal(r.degraded, true);
  }
  assert.equal(vm.stats().cloneAttempts, 1);
  assert.equal(factoryCalls, 1);
});

test('voice 克隆链: 配置 tts.clone.chain=["volcengine"] 时优先走火山', async () => {
  const primary = { name: 'minimax', async cloneVoice() { throw new Error('should not be used'); } };
  const volcFake = fakeCloneProvider({ provider: 'volcengine', voiceId: 'S_volc_only' });
  const factoryCalls = [];
  const vm = createVoiceManager({
    config: chainVoiceConfig({ chain: ['volcengine'] }),
    tts: primary,
    log: () => {},
    createTtsImpl: ({ config }) => {
      factoryCalls.push(config.tts.provider);
      return volcFake;
    },
  });
  const result = await vm.ensureVoice({ pcm: makePcm(1200, 16000), sampleRate: 16000 });
  assert.equal(result.mode, 'clone');
  assert.equal(result.voiceId, 'S_volc_only');
  assert.equal(volcFake.cloneCalls, 1);
  assert.equal(factoryCalls[0], 'volcengine');
  assert.deepEqual(vm.stats().cloneProviderChain, ['volcengine']);
});

test('voice 克隆链: 主 provider 就在链里时直接复用，不重复创建实例', async () => {
  const primary = fakeCloneProvider({ provider: 'volcengine', voiceId: 'S_primary_ok' });
  let factoryCalls = 0;
  const vm = createVoiceManager({
    config: chainVoiceConfig({ provider: 'volcengine', chain: ['volcengine', 'minimax'] }),
    tts: primary,
    log: () => {},
    createTtsImpl: () => {
      factoryCalls += 1;
      throw new Error('不应创建');
    },
  });
  const result = await vm.ensureVoice({ pcm: makePcm(1200, 16000), sampleRate: 16000 });
  assert.equal(result.mode, 'clone');
  assert.equal(primary.cloneCalls, 1);
  assert.equal(factoryCalls, 0);
});

test('voice 克隆链: 真实 volcengine provider 训练中(1) -> voice manager 降级 preset 且 reason 可读', async () => {
  const fetchMock = makeFetchMock(async () => jsonResponse({ code: 0, status: 1, speaker_id: 'S_training_9' }));
  const volcTts = await createTts({ config: volcConfig(), log: () => {}, fetchImpl: fetchMock });
  const vm = createVoiceManager({
    config: chainVoiceConfig({ provider: 'volcengine', chain: ['volcengine'], maxSampleSec: 30 }),
    tts: volcTts,
    log: () => {},
  });
  const result = await vm.ensureVoice({ pcm: makePcm(12000, 16000), sampleRate: 16000 });
  assert.equal(result.mode, 'preset');
  assert.equal(result.degraded, true);
  assert.match(result.reason, /训练中|voice_clone_training/);
  assert.equal(vm.state.voiceId, 'male-qn-qingse');
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

test('integration: v0.2 warmup + 流式首包 + 缓存 miss/hit（2 次 TTS + 1 次轻量预热）', { skip: !INTEGRATION }, async () => {
  const { loadConfig } = await import('../engine/config.mjs');
  const config = loadConfig();
  const tts = await createTts({ config, log: () => {} });

  // 预热：1 次轻量 get_voice（不计 TTS 字符），同时建立/复用 HTTP 连接
  const w0 = Date.now();
  const warm = await tts.warmup();
  const warmMs = Date.now() - w0;
  assert.equal(warm.ok, true);
  assert.ok(tts.stats().voiceList.cached, 'warmup 应填满 listVoices TTL 缓存');
  assert.ok(warm.voices > 0);

  // TTS #1/#2：预热后两条流式 -> 首包延迟（不同文本，避免缓存互相干扰）
  const streamSamples = [];
  for (const streamText of ['梯度下降是一种一阶迭代优化算法。', '学习率决定每次参数更新的步长。']) {
    const t0 = Date.now();
    let firstMs = null;
    let streamBytes = 0;
    for await (const chunk of tts.synthesizeStream({ text: streamText, voiceId: 'male-qn-qingse' })) {
      if (firstMs == null) firstMs = Date.now() - t0;
      streamBytes += chunk.pcm.length;
    }
    streamSamples.push({ text: streamText, firstMs, totalMs: Date.now() - t0, bytes: streamBytes });
  }
  const firstMs = streamSamples[0].firstMs;

  // TTS #3：非流式 cache miss
  const text = '反向传播通过链式法则计算每一层的梯度。';
  const m0 = Date.now();
  const miss = await tts.synthesize({ text, voiceId: 'male-qn-qingse' });
  const missMs = Date.now() - m0;

  // cache hit：本地内存命中，不应该再发请求
  const h0 = Date.now();
  const hit = await tts.synthesize({ text, voiceId: 'male-qn-qingse' });
  const hitMs = Date.now() - h0;

  assert.equal(hit.pcm.equals(miss.pcm), true, '命中缓存音频应与 miss 一致');
  assert.ok(hitMs <= missMs, `缓存命中(${hitMs}ms)不应慢于 miss(${missMs}ms)`);
  assert.ok(hitMs < 200, `缓存命中耗时异常：${hitMs}ms`);
  const cacheStats = tts.stats().cache;
  assert.ok(cacheStats.hits >= 1);
  assert.ok(missMs < 5000, `cache miss 太慢：${missMs}ms`);

  console.log(
    `[integration-v0.2] warmup=${warmMs}ms ok=${warm.ok} voices=${warm.voices} | stream first=${streamSamples.map((x) => x.firstMs).join('/')}ms total=${streamSamples.map((x) => x.totalMs).join('/')}ms | cache miss=${missMs}ms hit=${hitMs}ms pcm=${miss.pcm.length}B@${miss.sampleRate}Hz duration=${miss.durationMs}ms | cache=${JSON.stringify({ hits: cacheStats.hits, misses: cacheStats.misses, hitRate: cacheStats.hitRate, entries: cacheStats.entries })}`
  );
});

test('integration: 火山语音 401 可读错误（本机无 UUID Key）', { skip: !INTEGRATION }, async () => {
  const saved = process.env.VOLCENGINE_SPEECH_API_KEY;
  // 用「格式合法但不存在」的 UUID key，让真实 openspeech 返回 401/45000010（<=2 次真机请求预算）
  process.env.VOLCENGINE_SPEECH_API_KEY = '00000000-0000-4000-8000-000000000000';
  try {
    const { loadConfig } = await import('../engine/config.mjs');
    const config = loadConfig({
      overrides: { tts: { provider: 'volcengine', voiceMode: 'preset', cache: { enabled: false } } },
    });
    const tts = await createTts({ config, log: () => {} });
    await assert.rejects(
      () => tts.synthesize({ text: '今天我们学习梯度下降。', voiceId: 'zh_male_wennuanahu_moon_bigtts' }),
      (err) => {
        assert.ok(
          err.code === 401 || err.code === 45000010 || String(err.code || '').startsWith('http_'),
          `预期 401/45000010/http_xxx，实际 code=${err.code}`
        );
        assert.match(err.message, /401|45000010|鉴权失败|X-Api-Key/);
        assert.match(err.message, /UUID Key|豆包语音控制台|控制台/);
        console.log(`[integration-volc] 401 evidence: ${JSON.stringify({ code: err.code, message: err.message.slice(0, 240) })}`);
        return true;
      }
    );
  } finally {
    if (saved === undefined) delete process.env.VOLCENGINE_SPEECH_API_KEY;
    else process.env.VOLCENGINE_SPEECH_API_KEY = saved;
  }
});

test('integration: 火山 401 自动降级 macos-say（原声克隆不可用时的兜底）', { skip: !INTEGRATION }, async () => {
  const saved = process.env.VOLCENGINE_SPEECH_API_KEY;
  process.env.VOLCENGINE_SPEECH_API_KEY = '00000000-0000-4000-8000-000000000000';
  const logs = [];
  try {
    const { loadConfig } = await import('../engine/config.mjs');
    const config = loadConfig({
      overrides: {
        tts: {
          provider: 'volcengine',
          voiceMode: 'preset',
          sampleRate: 24000,
          cache: { enabled: false },
          fallbacks: [{ provider: 'macos-say', voice: 'Tingting' }],
        },
      },
    });
    const tts = await createTtsWithFallback({ config, log: (m) => logs.push(String(m)) });
    assert.deepEqual(tts.providers, ['volcengine', 'macos-say']);
    const res = await tts.synthesize({ text: '今天我们学习梯度下降。', voiceId: 'zh_male_wennuanahu_moon_bigtts' });
    assert.ok(res.pcm.length > 0, '降级后应拿到 macos-say 音频');
    assert.equal(res.sampleRate, 24000);
    assert.ok(
      logs.some((m) => /volcengine.*失败|尝试下一个|fallback/i.test(m)),
      `应看到 volcengine 失败并切 fallback 的日志，实际：${logs.slice(-5).join(' | ')}`
    );
    console.log(
      `[integration-volc] fallback evidence: providers=${tts.providers.join('->')} pcm=${res.pcm.length}B@${res.sampleRate}Hz duration=${res.durationMs}ms logs=${logs.filter((m) => /volcengine|fallback/i.test(m)).slice(-2).join(' | ')}`
    );
  } finally {
    if (saved === undefined) delete process.env.VOLCENGINE_SPEECH_API_KEY;
    else process.env.VOLCENGINE_SPEECH_API_KEY = saved;
  }
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
