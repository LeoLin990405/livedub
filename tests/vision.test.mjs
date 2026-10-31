/**
 * v0.5 视觉能力层测试（engine/vision/index.mjs + scripts/ocr-macos.swift + scripts/build-ocr.sh）。
 *
 * 设计原则（与其它测试一致）：
 * - 默认离线、跨平台（CI 在 ubuntu 跑）：OCR 用 fake spawn、VLM / 总结用 fake fetch，不联网、不调 swiftc；
 * - 真机 OCR/VLM 测试放在 LIVEDUB_INTEGRATION=1 且 macOS 下（VLM 真实调用 ≤1 次，保持额度）；
 * - 同时静态校验 Swift helper / 构建脚本（存在、bash -n、关键 env 与 --check）；
 * - 断言不打印/不包含 apiKey；日志走注入的 log() 收集，不污染测试输出。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_VISION_CONFIG,
  buildSummaryInput,
  createVisionService,
  extractChatContent,
  formatClock,
  mergeVisionConfig,
  parseSummaryOutput,
} from '../engine/vision/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SWIFT_SRC = path.join(ROOT, 'scripts', 'ocr-macos.swift');
const BUILD_SCRIPT = path.join(ROOT, 'scripts', 'build-ocr.sh');
const OCR_BIN = path.join(ROOT, 'data', 'bin', 'ocr-macos');
const DEMO_PNG = path.join(ROOT, 'docs', 'assets', 'demo-original.png');
const STUDIO_ZH_PNG = path.join(ROOT, 'docs', 'assets', 'studio-notes-preview.png');

const INTEGRATION = process.env.LIVEDUB_INTEGRATION === '1' && process.platform === 'darwin';

/* ------------------------------------------------------------------ *
 * 测试基础设施：临时目录 / 假图片 / fake spawn / fake fetch
 * ------------------------------------------------------------------ */

const tempRoots = [];
function makeTempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livedub-vision-test-'));
  tempRoots.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tempRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** 只要求 PNG magic 正确的最小 buffer（视觉层不做解码，真正解码在 Swift helper） */
function pngBuffer() {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32, 7),
  ]);
}

/** 造一个存在的可执行文件（fake spawn 不会真的执行它，只过 existsSync/executable 检查） */
function makeFakeBin() {
  const dir = makeTempRoot();
  const bin = path.join(dir, 'ocr-macos');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(bin, 0o755);
  return bin;
}

function makeFakeExecutableScript(content = '#!/bin/sh\nexit 1\n') {
  const dir = makeTempRoot();
  const file = path.join(dir, 'fake-build-ocr.sh');
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
  return file;
}

/**
 * fake child_process.spawn。
 * handlers: [{ match(command, args) => boolean, spec }]；spec:
 *   { code, stdout, stderr } 正常退出；{ never: true } 永不退出（测超时）；
 *   { error } 触发 child 'error' 事件（测 ENOENT）。
 */
function makeFakeSpawn(handlers = []) {
  const calls = [];
  const children = [];
  const writes = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args: Array.isArray(args) ? args : [], options });
    const handler = handlers.find((item) => item.match(command, args));
    const spec = typeof handler?.spec === 'function' ? null : handler?.spec;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.stdioEnded = false;
    child.kill = (signal) => {
      child.killed = true;
      child.killedWith = signal;
    };
    const stdin = new EventEmitter();
    stdin.write = (data) => {
      writes.push({ command, data: String(data) });
      if (typeof handler?.onWrite === 'function') handler.onWrite({ data: String(data), child, command });
    };
    stdin.end = () => {
      child.stdioEnded = true;
    };
    child.stdin = stdin;
    children.push(child);
    setImmediate(() => {
      const resolved = typeof handler?.spec === 'function' ? handler.spec({ command, args, child }) : spec;
      if (!resolved || resolved.never) return;
      if (resolved.error) {
        child.emit('error', resolved.error);
        return;
      }
      if (resolved.stdout) child.stdout.emit('data', Buffer.from(resolved.stdout));
      if (resolved.stderr) child.stderr.emit('data', Buffer.from(resolved.stderr));
      child.emit('close', resolved.code ?? 0);
    });
    return child;
  };
  return { spawnImpl, calls, children, writes };
}

const OCR_HELPER_OK = {
  ok: true,
  provider: 'macos-vision',
  text: 'The Core Idea\nCompute the gradient of the loss.',
  lines: [
    { text: 'The Core Idea', confidence: 0.99, x: 0.1, y: 0.8, w: 0.4, h: 0.05 },
    { text: 'Compute the gradient of the loss.', confidence: 0.97, x: 0.12, y: 0.7, w: 0.6, h: 0.05 },
  ],
  ms: 812,
  languages: ['zh-Hans', 'en-US'],
  image: { width: 1280, height: 720 },
};

/**
 * fake fetch：handler({url, options, body, callIndex}) -> {status, json, text, throw, hang}
 */
function makeFakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    const callIndex = calls.length;
    calls.push({ url, options, body });
    const spec = (await handler({ url, options, body, callIndex })) ?? {};
    if (spec.throw) throw spec.throw;
    if (spec.hang) return new Promise(() => {});
    return {
      ok: spec.status === undefined ? true : spec.status < 400,
      status: spec.status ?? 200,
      json: async () => {
        if (spec.json === undefined) throw new Error('fake fetch: no json');
        return spec.json;
      },
      text: async () => (typeof spec.text === 'string' ? spec.text : JSON.stringify(spec.json ?? {})),
    };
  };
  return { fetchImpl, calls };
}

/**
 * fake 常驻 serve 子进程：模拟 `ocr-macos --serve` 的 stdin/stdout JSON 行协议。
 * - 启动后按 ready 行回复；onWrite 收到请求行后异步回响应（可配置永不响应/崩溃）
 * - 记录是否出现「前一个请求未响应就写下一个」的并发违规，用于断言串行队列
 */
function makeServeHandler({ bin, frames, readyLanguages = ['zh-Hans', 'en-US'], respond = true, crashAfterRequests = null, crashOnRequestIds = [] }) {
  const state = { spawnCount: 0, writes: [], responded: [], serialViolation: false };
  return {
    match: (command, args) => command === bin && Array.isArray(args) && args.includes('--serve'),
    spec: ({ child }) => {
      child._serveSpawnIndex = state.spawnCount++;
      child._serveResponded = [];
      child._serveCrashed = false;
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ ready: true, provider: 'macos-vision', languages: readyLanguages })}\n`));
      });
      return { never: true };
    },
    onWrite: ({ data, child }) => {
      const request = JSON.parse(String(data).trim());
      state.writes.push(request.id);
      if (state.responded.length < state.writes.length - 1) state.serialViolation = true;
      if (!respond) return;
      setImmediate(() => {
        if ((crashOnRequestIds || []).includes(request.id)) {
          child.emit('close', 1);
          return;
        }
        const text = typeof frames === 'function' ? frames(request, child._serveSpawnIndex) : `serve frame ${request.id}`;
        child._serveResponded.push(request.id);
        state.responded.push(request.id);
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({
          id: request.id,
          ok: true,
          provider: 'macos-vision',
          text,
          lines: text.split('\n').map((line) => ({ text: line })),
          ms: 11,
        })}\n`));
        if (crashAfterRequests && child._serveResponded.length >= crashAfterRequests && !child._serveCrashed) {
          child._serveCrashed = true;
          setTimeout(() => child.emit('close', 0), 0);
        }
      });
    },
    state,
  };
}

const CAPTION_DATA = {
  choices: [
    {
      message: {
        content: '画面类型：幻灯片。标题 The Core Idea。画面文字讲梯度下降：先算损失对参数的梯度，再沿反方向走一小步。',
      },
    },
  ],
};

const SUMMARY_DATA = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          summary: '本视频用一页幻灯片讲清了梯度下降的核心思想：先计算损失函数对参数的梯度，再沿梯度的反方向更新参数，学习率决定每一步的大小。',
          keyPoints: [
            '梯度是损失函数对参数的偏导数，方向指向损失上升最快的方向',
            '沿负梯度方向迭代更新参数，学习率控制步长',
            '损失函数、学习率、梯度是本节三个核心术语',
          ],
        }),
      },
    },
  ],
};

/** 组装一个默认全 fake 的 service 上下文 */
function makeContext({
  spawnHandlers = [],
  fetchHandler = () => ({ status: 500, json: {} }),
  vision = {},
  providers = {},
  bin = makeFakeBin(),
  buildScript = BUILD_SCRIPT,
  log = () => {},
} = {}) {
  const fakeSpawn = makeFakeSpawn(spawnHandlers);
  const fakeFetch = makeFakeFetch(fetchHandler);
  const { ocr: ocrOverride, summary: summaryOverride, ...visionRest } = vision || {};
  const config = {
    providers: {
      'fake-vlm': { baseUrl: 'https://vlm.example.com/v1', apiKey: 'test-key-vlm', model: 'fake-vlm-model' },
      'fake-text': { baseUrl: 'https://text.example.com/v1', apiKey: 'test-key-text', model: 'fake-text-model' },
      ...providers,
    },
    vision: {
      provider: 'fake-vlm',
      model: 'fake-vlm-model',
      maxTokens: 300,
      timeoutMs: 5000,
      summary: { provider: 'fake-text', model: 'fake-text-model', maxInputChars: 4000, timeoutMs: 5000, ...summaryOverride },
      ...visionRest,
      ocr: {
        bin,
        buildScript,
        fallback: [],
        lazyBuild: false,
        timeoutMs: 2000,
        languages: ['zh-Hans', 'en-US'],
        // 单次 spawn 用例默认关掉 serve（serve 有独立用例；避免 fake spawn 被 serve 请求误触发）
        serve: { enabled: false },
        ...ocrOverride,
      },
    },
  };
  const logs = [];
  const logImpl = (message) => {
    logs.push(String(message));
    log(message);
  };
  const service = createVisionService({
    config,
    log: logImpl,
    fetchImpl: fakeFetch.fetchImpl,
    spawnImpl: fakeSpawn.spawnImpl,
  });
  return { service, config, fakeSpawn, fakeFetch, logs, bin, buildScript };
}

/* ------------------------------------------------------------------ *
 * 1. 默认配置 / 纯函数
 * ------------------------------------------------------------------ */

test('vision: 默认配置含 provider/model/ocr/summary/keyframe，merge 深合并且不污染默认值', () => {
  assert.equal(DEFAULT_VISION_CONFIG.provider, 'ark-plan');
  assert.equal(DEFAULT_VISION_CONFIG.model, 'doubao-seed-2-1-turbo-260628');
  assert.equal(DEFAULT_VISION_CONFIG.maxTokens, 800);
  assert.ok(DEFAULT_VISION_CONFIG.timeoutMs >= 60000, 'VLM 慢（20-30s），默认超时不应过小');
  assert.match(DEFAULT_VISION_CONFIG.prompt, /画面/);
  assert.deepEqual(DEFAULT_VISION_CONFIG.ocr.fallback, ['tesseract']);
  assert.match(DEFAULT_VISION_CONFIG.ocr.bin, /data\/bin\/ocr-macos/);
  assert.equal(DEFAULT_VISION_CONFIG.summary.provider, 'deepseek');
  assert.equal(DEFAULT_VISION_CONFIG.summary.model, 'deepseek-flash');
  assert.equal(DEFAULT_VISION_CONFIG.keyframe.intervalMs, 6000);
  assert.equal(DEFAULT_VISION_CONFIG.keyframe.maxFrames, 24);

  const merged = mergeVisionConfig({
    vision: { model: 'custom-model', keyframe: { intervalMs: 3000 }, ocr: { fallback: ['tesseract', 'macos-vision'] } },
  });
  assert.equal(merged.model, 'custom-model');
  assert.equal(merged.keyframe.intervalMs, 3000);
  assert.equal(merged.keyframe.minChange, DEFAULT_VISION_CONFIG.keyframe.minChange, '未覆盖的 keyframe 字段应保留默认');
  assert.deepEqual(merged.ocr.fallback, ['tesseract', 'macos-vision']);
  assert.deepEqual(DEFAULT_VISION_CONFIG.ocr.fallback, ['tesseract'], '不能污染默认配置');
  assert.equal(merged.provider, 'ark-plan');

  // 没有 config.vision 时也给全默认值
  const empty = mergeVisionConfig({});
  assert.deepEqual(empty.ocr.languages, DEFAULT_VISION_CONFIG.ocr.languages);
  assert.equal(empty.summary.provider, 'deepseek');
});

test('vision: formatClock 覆盖分秒/小时边界', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(65_000), '01:05');
  assert.equal(formatClock(3_661_000), '1:01:01');
  assert.equal(formatClock(-5), '00:00');
  assert.equal(formatClock(59_999), '00:59');
});

test('vision: extractChatContent 支持字符串与 content parts 数组', () => {
  assert.equal(extractChatContent({ choices: [{ message: { content: ' 你好 ' } }] }), '你好');
  assert.equal(
    extractChatContent({ choices: [{ message: { content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] } }] }),
    'AB',
  );
  assert.equal(extractChatContent({ choices: [{ delta: { content: '流式' } }] }), '流式');
  assert.equal(extractChatContent({}), '');
  assert.equal(extractChatContent(null), '');
});

test('vision: parseSummaryOutput 容忍代码围栏 / 非 JSON 兜底 / keyPoints 清洗与 6 条上限', () => {
  const fenced = '```json\n{"summary":"这是总结。","keyPoints":["要点一","要点二","要点三"]}\n```';
  const parsed = parseSummaryOutput(fenced);
  assert.equal(parsed.summary, '这是总结。');
  assert.deepEqual(parsed.keyPoints, ['要点一', '要点二', '要点三']);

  const many = parseSummaryOutput(JSON.stringify({
    summary: '总结',
    keyPoints: ['1', '2', '3', '2', '4', '5', '6', '7', '- 重复'],
  }));
  assert.equal(many.keyPoints.length, 6);
  assert.equal(many.keyPoints.filter((point) => point === '2').length, 1, '重复要点应去重');
  assert.deepEqual(many.keyPoints, ['1', '2', '3', '4', '5', '6']);

  const plain = parseSummaryOutput('总结：梯度下降是最优化方法。\n- 沿负梯度走\n- 学习率控制步长');
  assert.match(plain.summary, /梯度下降是最优化方法/);
  assert.deepEqual(plain.keyPoints, ['沿负梯度走', '学习率控制步长']);

  assert.deepEqual(parseSummaryOutput(''), { summary: '', keyPoints: [], links: [] });
  assert.deepEqual(parseSummaryOutput(null), { summary: '', keyPoints: [], links: [] });
});

test('vision: buildSummaryInput 含标题/时间戳/双语/画面，超长按预算裁剪且保留首尾', () => {
  const short = buildSummaryInput({
    title: 'MIT 6.S191 Lecture 2',
    transcript: [
      { t0Ms: 0, t1Ms: 3000, src: 'Gradient descent computes the gradient.', dst: '梯度下降计算梯度。' },
      { t0Ms: 3000, t1Ms: 6000, src: 'We take a step.', dst: '我们走一步。' },
    ],
    visuals: [{ tMs: 12_000, ocrText: 'The Core Idea', caption: '幻灯片讲梯度下降' }],
    lang: 'zh',
  });
  assert.equal(short.messages[0].role, 'system');
  assert.match(short.messages[0].content, /JSON/);
  const user = short.messages[1].content;
  assert.match(user, /MIT 6\.S191/);
  assert.match(user, /\[00:00/);
  assert.match(user, /梯度下降计算梯度/);
  assert.match(user, /画面文字：The Core Idea/);
  assert.match(user, /画面理解：幻灯片讲梯度下降/);
  assert.equal(short.stats.truncated, false);
  assert.equal(short.stats.transcriptItems, 2);

  // 超长输入：300 句字幕 + 60 条画面，预算 1600 字
  const longTranscript = Array.from({ length: 300 }, (_, i) => ({
    t0Ms: i * 1000,
    t1Ms: i * 1000 + 900,
    src: `Sentence number ${i} about gradient descent and the loss function with some extra words.`,
    dst: `第 ${i} 句，讲梯度下降与损失函数，还有一些补充说明。`,
  }));
  const longVisuals = Array.from({ length: 60 }, (_, i) => ({
    tMs: i * 6000,
    ocrText: `Frame ${i} OCR text with The Core Idea and gradient descent details.`,
    caption: `第 ${i} 帧画面理解：幻灯片讲梯度下降的核心思想。`,
  }));
  const long = buildSummaryInput({ title: '长视频', transcript: longTranscript, visuals: longVisuals, maxInputChars: 1600 });
  assert.equal(long.stats.truncated, true);
  assert.ok(long.stats.transcriptKept < 300);
  assert.ok(long.stats.visualKept < 60);
  // 实际 user 长度受预算约束（允许固定说明文字的少量超出）
  assert.ok(long.messages[1].content.length <= 1600 * 2, `输入应被裁剪，实际 ${long.messages[1].content.length}`);
  assert.match(long.messages[1].content, /中间省略/);
  // 保留首尾：第一句和最后一句都还在
  assert.match(long.messages[1].content, /Sentence number 0 /);
  assert.match(long.messages[1].content, /Sentence number 199 /, '保留最后一句（MAX_TRANSCRIPT_ITEMS=200 截断到 199）');
});

/* ------------------------------------------------------------------ *
 * 2. OCR：成功 / 失败 / 回退 / 超时 / 懒编译
 * ------------------------------------------------------------------ */

test('vision.ocr: macOS Vision 成功路径返回 text/lines/provider/ms，传对 --image/--langs 参数', async () => {
  const { service, fakeSpawn, bin } = makeContext({
    spawnHandlers: [{ match: (command) => command === bin, spec: { code: 0, stdout: JSON.stringify(OCR_HELPER_OK) } }],
  });
  const result = await service.ocr({ png: pngBuffer() });
  assert.equal(result.provider, 'macos-vision');
  assert.match(result.text, /Compute the gradient/);
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0].confidence, 0.99);
  assert.equal(typeof result.ms, 'number');
  assert.ok(result.ms >= 0);
  assert.equal(fakeSpawn.calls.length, 1);
  const call = fakeSpawn.calls[0];
  assert.equal(call.command, bin);
  assert.ok(call.args.includes('--image'));
  assert.ok(call.args.includes('zh-Hans,en-US'), '应把 config.vision.ocr.languages 传给 helper');
  await service.dispose();
});

test('vision.ocr: helper 返回 ok:false 时给出可读错误（含原因与下一步）', async () => {
  const { service, bin } = makeContext({
    spawnHandlers: [{
      match: (command) => command === bin,
      spec: { code: 0, stdout: JSON.stringify({ ok: false, provider: 'macos-vision', error: 'image_unreadable', message: '图片内容解码失败' }) },
    }],
  });
  await assert.rejects(service.ocr({ png: pngBuffer() }), (err) => {
    assert.match(err.message, /OCR 不可用/);
    assert.match(err.message, /图片内容解码失败/);
    assert.match(err.message, /build-ocr\.sh/);
    assert.equal(err.livedubReadable, true);
    return true;
  });
  await service.dispose();
});

test('vision.ocr: macos-vision 失败按 ocr.fallback 回退 tesseract，并注明仅 eng 语言限制', async () => {
  const bin = makeFakeBin();
  const { service, fakeSpawn, logs } = makeContext({
    bin,
    spawnHandlers: [
      { match: (command) => command === bin, spec: { code: 1, stderr: 'Vision 不可用' } },
      { match: (command) => command === 'tesseract', spec: { code: 0, stdout: 'The Core Idea\nGradient descent\n' } },
    ],
    vision: { ocr: { bin, fallback: ['tesseract'] } },
  });
  const result = await service.ocr({ png: pngBuffer() });
  assert.equal(result.provider, 'tesseract');
  assert.equal(result.degraded, true);
  assert.match(result.fallbackReason, /macos-vision/);
  assert.match(result.langNote, /eng/);
  assert.ok(result.text.includes('Gradient descent'));
  assert.equal(fakeSpawn.calls.length, 2);
  assert.equal(fakeSpawn.calls[1].command, 'tesseract');
  assert.ok(logs.some((line) => /回退到 tesseract/.test(line)));
  await service.dispose();
});

test('vision.ocr: 超时会 kill 子进程并报可读超时错误', async () => {
  const { service, fakeSpawn, bin } = makeContext({
    spawnHandlers: [{ match: (command) => command === bin, spec: { never: true } }],
  });
  await assert.rejects(service.ocr({ png: pngBuffer(), timeoutMs: 80 }), /超时/);
  assert.equal(fakeSpawn.children.length, 1);
  assert.equal(fakeSpawn.children[0].killed, true);
  assert.equal(fakeSpawn.children[0].killedWith, 'SIGKILL');
  await service.dispose();
});

test('vision.ocr: 子进程 ENOENT 映射成「未找到命令」可读错误', async () => {
  const { service, bin } = makeContext({
    spawnHandlers: [{
      match: (command) => command === bin,
      spec: { error: Object.assign(new Error('spawn ocr-macos ENOENT'), { code: 'ENOENT' }) },
    }],
  });
  await assert.rejects(service.ocr({ png: pngBuffer() }), /未找到命令/);
  await service.dispose();
});

test('vision.ocr: 二进制缺失 → 懒编译一次；编译失败回退 tesseract；再失败给出「OCR 不可用」', async () => {
  const missingBin = path.join(makeTempRoot(), 'missing-ocr');
  const buildScript = makeFakeExecutableScript();
  const tesseractOk = { match: (command) => command === 'tesseract', spec: { code: 0, stdout: 'Fallback text from tesseract\n' } };
  const ctx = makeContext({
    bin: missingBin,
    buildScript,
    spawnHandlers: [
      { match: (command) => command === 'bash', spec: { code: 1, stderr: 'swiftc: error' } },
      tesseractOk,
    ],
    vision: { ocr: { bin: missingBin, buildScript, lazyBuild: true, fallback: ['tesseract'] } },
  });
  const result = await ctx.service.ocr({ png: pngBuffer() });
  assert.equal(result.provider, 'tesseract');
  assert.equal(result.degraded, true);
  assert.ok(ctx.fakeSpawn.calls.some((call) => call.command === 'bash'), '应先尝试懒编译');
  assert.ok(ctx.logs.some((line) => /懒编译失败/.test(line)));
  await ctx.service.dispose();

  // 无 fallback 且编译失败 → 可读不可用错误
  const ctx2 = makeContext({
    bin: missingBin,
    buildScript,
    spawnHandlers: [{ match: (command) => command === 'bash', spec: { code: 1, stderr: 'swiftc: error' } }],
    vision: { ocr: { bin: missingBin, buildScript, lazyBuild: true, fallback: [] } },
  });
  await assert.rejects(ctx2.service.ocr({ png: pngBuffer() }), /OCR 不可用/);
  await ctx2.service.dispose();
});

test('vision.ocr: 非 PNG/JPEG 输入与空输入给出可读错误（不启动子进程）', async () => {
  const { service, fakeSpawn } = makeContext();
  await assert.rejects(service.ocr({ png: Buffer.from('not an image') }), /PNG\/JPEG/);
  await assert.rejects(service.ocr({ png: Buffer.alloc(0) }), /图片为空/);
  assert.equal(fakeSpawn.calls.length, 0);
  await service.dispose();
});

test('vision.ocr: 支持 data URL / 本地文件路径输入（真实小工具场景）', async () => {
  const bin = makeFakeBin();
  const ok = { match: (command) => command === bin, spec: { code: 0, stdout: JSON.stringify(OCR_HELPER_OK) } };
  const dir = makeTempRoot();
  const file = path.join(dir, 'frame.png');
  fs.writeFileSync(file, pngBuffer());
  const ctx = makeContext({ bin, spawnHandlers: [ok], vision: { ocr: { bin } } });
  const viaPath = await ctx.service.ocr({ png: file });
  assert.match(viaPath.text, /gradient/);
  const viaDataUrl = await ctx.service.ocr({ png: `data:image/png;base64,${pngBuffer().toString('base64')}` });
  assert.match(viaDataUrl.text, /gradient/);
  await ctx.service.dispose();
});

/* ------------------------------------------------------------------ *
 * 2.5 常驻 serve 模式（逐帧 OCR 的核心优化：进程只启动一次）
 * ------------------------------------------------------------------ */

test('vision.ocr: 优先使用常驻 --serve 进程，多帧复用同一进程（mode=serve）', async () => {
  const bin = makeFakeBin();
  const serve = makeServeHandler({ bin, frames: (request) => `第 ${request.id} 帧：梯度下降` });
  const ctx = makeContext({ bin, spawnHandlers: [serve], vision: { ocr: { bin, serve: { enabled: true } } } });

  const first = await ctx.service.ocr({ png: pngBuffer() });
  assert.equal(first.mode, 'serve');
  assert.equal(first.provider, 'macos-vision');
  assert.match(first.text, /第 1 帧/);

  const second = await ctx.service.ocr({ png: pngBuffer() });
  assert.equal(second.mode, 'serve');
  assert.match(second.text, /第 2 帧/);

  const serveCalls = ctx.fakeSpawn.calls.filter((call) => call.args.includes('--serve'));
  assert.equal(serveCalls.length, 1, '两帧应复用同一个 serve 子进程（只 spawn 一次）');
  assert.equal(ctx.fakeSpawn.writes.length, 2);
  const requestPayload = JSON.parse(ctx.fakeSpawn.writes[0].data.trim());
  assert.ok(requestPayload.image.endsWith('.png'), '请求里应带本地图片路径');

  const health = ctx.service.health();
  assert.equal(health.ocr.mode, 'serve');
  assert.equal(health.ocr.serve.enabled, true);
  assert.equal(health.ocr.serve.running, true);
  assert.equal(health.ocr.serve.spawnCount, 1);
  assert.equal(health.ocr.serve.requests, 2);

  await ctx.service.dispose();
  assert.equal(ctx.fakeSpawn.children[0].stdioEnded, true, 'dispose 应关闭 serve 子进程 stdin');
  assert.equal(ctx.fakeSpawn.children[0].killed, true, 'dispose 应终止 serve 子进程');
});

test('vision.ocr: 并发 OCR 调用经 serve 串行队列（第二个请求等第一个响应后才写）', async () => {
  const bin = makeFakeBin();
  const serve = makeServeHandler({ bin, frames: (request) => `帧 ${request.id}` });
  const ctx = makeContext({ bin, spawnHandlers: [serve], vision: { ocr: { bin, serve: { enabled: true } } } });

  const [a, b] = await Promise.all([
    ctx.service.ocr({ png: pngBuffer() }),
    ctx.service.ocr({ png: pngBuffer() }),
  ]);
  assert.equal(a.mode, 'serve');
  assert.equal(b.mode, 'serve');
  assert.match(a.text, /帧 1/);
  assert.match(b.text, /帧 2/);
  assert.equal(serve.state.writes.length, 2);
  assert.equal(serve.state.serialViolation, false, 'serve 请求必须串行写 stdin');
  assert.equal(ctx.fakeSpawn.calls.length, 1, '并发帧也应复用同一个 serve 进程');
  await ctx.service.dispose();
});

test('vision.ocr: serve 请求超时 → kill 常驻进程并回退单次 spawn（degraded）', async () => {
  const bin = makeFakeBin();
  const serve = makeServeHandler({ bin, respond: false });
  const spawnOk = {
    match: (command, args) => command === bin && !args.includes('--serve'),
    spec: { code: 0, stdout: JSON.stringify(OCR_HELPER_OK) },
  };
  const ctx = makeContext({
    bin,
    spawnHandlers: [serve, spawnOk],
    vision: { ocr: { bin, serve: { enabled: true, timeoutMs: 80 } } },
  });

  const result = await ctx.service.ocr({ png: pngBuffer() });
  assert.equal(result.mode, 'spawn');
  assert.equal(result.degraded, true);
  assert.match(result.fallbackReason, /serve/);
  assert.match(result.text, /gradient/);
  // 超时后重启 serve 重试一次；两次都超时才回退单次 spawn
  const serveCalls = ctx.fakeSpawn.calls.filter((call) => call.args.includes('--serve'));
  assert.equal(serveCalls.length, 2, '超时后应重启 serve 并重试一次');
  assert.ok(ctx.fakeSpawn.children[0].killed, '首次超时应 kill 常驻进程');
  assert.ok(ctx.fakeSpawn.children[1].killed, '重试超时也应 kill 常驻进程');
  assert.equal(ctx.fakeSpawn.calls.filter((call) => call.command === bin && !call.args.includes('--serve')).length, 1);
  await ctx.service.dispose();
});

test('vision.ocr: serve 首次超时 → 重启 serve 重试一次成功（不落回单次 spawn）', async () => {
  const bin = makeFakeBin();
  let spawnIndex = -1;
  const serve = {
    match: (command, args) => command === bin && args.includes('--serve'),
    spec: ({ child }) => {
      spawnIndex += 1;
      child._gen = spawnIndex;
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ ready: true, provider: 'macos-vision' })}\n`));
      });
      return { never: true };
    },
    onWrite: ({ data, child }) => {
      const request = JSON.parse(String(data).trim());
      setImmediate(() => {
        if (child._gen === 0) return; // 第一代常驻进程永远不响应 -> 超时
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({
          id: request.id,
          ok: true,
          provider: 'macos-vision',
          text: `重试成功 ${request.id}`,
          lines: [{ text: '重试成功' }],
          ms: 9,
        })}\n`));
      });
    },
  };
  const ctx = makeContext({ bin, spawnHandlers: [serve], vision: { ocr: { bin, serve: { enabled: true, timeoutMs: 80 } } } });
  const result = await ctx.service.ocr({ png: pngBuffer() });
  assert.equal(result.mode, 'serve');
  assert.equal(result.serveRetried, true);
  assert.match(result.text, /重试成功/);
  assert.equal(ctx.fakeSpawn.calls.filter((call) => call.args.includes('--serve')).length, 2);
  assert.equal(ctx.fakeSpawn.calls.filter((call) => call.command === bin && !call.args.includes('--serve')).length, 0, '重试成功就不该回退单次 spawn');
  assert.equal(ctx.service.health().ocr.serve.restarts, 1);
  await ctx.service.dispose();
});

test('vision.ocr: serve 崩溃后自动重启一次，后续帧继续走 serve', async () => {
  const bin = makeFakeBin();
  const serve = makeServeHandler({ bin, frames: (request) => `帧 ${request.id}`, crashAfterRequests: 1 });
  const ctx = makeContext({ bin, spawnHandlers: [serve], vision: { ocr: { bin, serve: { enabled: true } } } });

  const first = await ctx.service.ocr({ png: pngBuffer() });
  assert.equal(first.mode, 'serve');
  assert.match(first.text, /帧 1/);

  // 等 serve close 事件被处理（健康检查的 running 变 false）
  for (let i = 0; i < 100 && ctx.service.health().ocr.serve.running; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(ctx.service.health().ocr.serve.running, false);

  const second = await ctx.service.ocr({ png: pngBuffer() });
  assert.equal(second.mode, 'serve', '崩溃后应自动重启 serve 而不是永久回退');
  assert.match(second.text, /帧 2/);
  const serveCalls = ctx.fakeSpawn.calls.filter((call) => call.args.includes('--serve'));
  assert.equal(serveCalls.length, 2, '崩溃一次应重启一次');
  assert.equal(ctx.service.health().ocr.serve.restarts, 1);
  await ctx.service.dispose();
});

test('vision.ocr: serve 连续崩溃超过 maxRestarts 后停用 serve，回退单次 spawn', async () => {
  const bin = makeFakeBin();
  // 每一代 serve 进程收到第一个请求就崩（无响应）
  const serve = makeServeHandler({ bin, respond: true, crashOnRequestIds: [1, 2, 3, 4] });
  const spawnOk = {
    match: (command, args) => command === bin && !args.includes('--serve'),
    spec: { code: 0, stdout: JSON.stringify(OCR_HELPER_OK) },
  };
  const ctx = makeContext({
    bin,
    spawnHandlers: [serve, spawnOk],
    vision: { ocr: { bin, serve: { enabled: true, timeoutMs: 200, maxRestarts: 1 } } },
  });

  const results = [];
  for (let i = 0; i < 3; i += 1) results.push(await ctx.service.ocr({ png: pngBuffer() }));
  // 每次 serve 崩溃后都成功回退到单次 spawn
  assert.ok(results.every((result) => result.mode === 'spawn'));
  const serveCalls = ctx.fakeSpawn.calls.filter((call) => call.args.includes('--serve'));
  assert.equal(serveCalls.length, 2, '初次 + 重启一次后应停用 serve');
  assert.equal(ctx.service.health().ocr.serve.disabled, true);
  assert.equal(ctx.service.health().ocr.mode, 'spawn', 'serve 停用后健康检查应报告 spawn');
  await ctx.service.dispose();
});

test('vision.health: 无 Vision 二进制且不可懒编译、无 tesseract 时 mode=unavailable', async () => {
  const missingBin = path.join(makeTempRoot(), 'missing-ocr');
  const config = {
    providers: {},
    vision: {
      provider: 'nope',
      ocr: { bin: missingBin, lazyBuild: false, fallback: [], serve: { enabled: true } },
    },
  };
  const service = createVisionService({
    config,
    log: () => {},
    fetchImpl: async () => { throw new Error('no fetch'); },
    spawnImpl: () => { throw new Error('no spawn'); },
    env: { PATH: '/nonexistent-path-for-vision-test' },
  });
  const health = service.health();
  assert.equal(health.ocr.binExists, false);
  // 本机（开发机）可能装了 tesseract，CI 上通常没有：两种环境都应给出自洽的 mode
  if (health.ocr.tesseract) {
    assert.equal(health.ocr.mode, 'tesseract');
    assert.equal(health.ocr.ok, true);
  } else {
    assert.equal(health.ocr.mode, 'unavailable');
    assert.equal(health.ocr.ok, false);
    assert.equal(health.ready, false);
  }
  await service.dispose();
});

/* ------------------------------------------------------------------ *
 * 3. 视觉大模型：成功 / 401 / 超时 / 空内容
 * ------------------------------------------------------------------ */

test('vision.analyze: mode=vision 成功，请求体是 OpenAI 兼容 image_url data URL 且带 Bearer', async () => {
  const { service, fakeFetch } = makeContext({
    fetchHandler: () => ({ status: 200, json: CAPTION_DATA }),
  });
  const result = await service.analyze({ png: pngBuffer(), mode: 'vision', maxTokens: 123 });
  assert.equal(result.mode, 'vision');
  assert.equal(result.caption.provider, 'fake-vlm');
  assert.equal(result.caption.model, 'fake-vlm-model');
  assert.match(result.caption.text, /幻灯片/);
  assert.equal(result.ocr, undefined);
  assert.equal(result.provider, 'fake-vlm');

  assert.equal(fakeFetch.calls.length, 1);
  const call = fakeFetch.calls[0];
  assert.match(call.url, /^https:\/\/vlm\.example\.com\/v1\/chat\/completions$/);
  assert.equal(call.options.headers.Authorization, 'Bearer test-key-vlm');
  assert.equal(call.body.model, 'fake-vlm-model');
  assert.equal(call.body.max_tokens, 123);
  assert.equal(call.body.stream, false);
  const content = call.body.messages[0].content;
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /画面/);
  assert.equal(content[1].type, 'image_url');
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
  await service.dispose();
});

test('vision.analyze: 401 给出可读鉴权错误，日志/错误里不出现 apiKey', async () => {
  const { service, logs } = makeContext({
    fetchHandler: () => ({ status: 401, json: { error: { code: 'AuthenticationError', message: 'invalid api key' } } }),
  });
  await assert.rejects(service.analyze({ png: pngBuffer(), mode: 'vision' }), (err) => {
    assert.match(err.message, /401/);
    assert.match(err.message, /apiKey/);
    assert.ok(!err.message.includes('test-key-vlm'), '错误信息不能包含密钥');
    return true;
  });
  const joined = logs.join('\n');
  assert.ok(!joined.includes('test-key-vlm'), '日志不能包含密钥');
  assert.ok(!joined.includes('base64,'), '日志不能包含图片 base64');
  await service.dispose();
});

test('vision.analyze: 视觉模型超时（异常 fetch 不响应）报可读超时', async () => {
  const { service } = makeContext({ fetchHandler: () => ({ hang: true }) });
  await assert.rejects(service.analyze({ png: pngBuffer(), mode: 'vision', timeoutMs: 80 }), /超时/);
  await service.dispose();
});

test('vision.analyze: 空内容 / HTTP 500 / 返回 error 对象都报可读错误', async () => {
  const empty = makeContext({ fetchHandler: () => ({ status: 200, json: { choices: [{ message: { content: '   ' } }] } }) });
  await assert.rejects(empty.service.analyze({ png: pngBuffer(), mode: 'vision' }), /空内容/);
  await empty.service.dispose();

  const serverError = makeContext({ fetchHandler: () => ({ status: 500, json: { error: { message: 'server overloaded' } } }) });
  await assert.rejects(serverError.service.analyze({ png: pngBuffer(), mode: 'vision' }), /HTTP 500/);
  await serverError.service.dispose();

  const errorPayload = makeContext({ fetchHandler: () => ({ status: 200, json: { error: { code: 'InvalidParameter', message: 'model not found' } } }) });
  await assert.rejects(errorPayload.service.analyze({ png: pngBuffer(), mode: 'vision' }), /model not found/);
  await errorPayload.service.dispose();
});

test('vision.analyze: 网络错误（ECONNRESET）自动重试一次后成功；health.probe 记录成功', async () => {
  let attempts = 0;
  const { service, fakeFetch } = makeContext({
    fetchHandler: () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          throw: Object.assign(new Error('fetch failed'), {
            cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
          }),
        };
      }
      return { status: 200, json: CAPTION_DATA };
    },
  });
  const result = await service.analyze({ png: pngBuffer(), mode: 'vision' });
  assert.match(result.caption.text, /幻灯片/);
  assert.equal(fakeFetch.calls.length, 2, '网络错误应自动重试一次');
  const health = service.health();
  assert.equal(health.vision.available, true);
  assert.equal(health.vision.probe.ok, true);
  assert.equal(typeof health.vision.probe.ms, 'number');
  await service.dispose();
});

test('vision.analyze: 两次网络失败 → 可读错误（提示已重试）；401/超时不重试且 available=false', async () => {
  const networkDown = makeContext({
    fetchHandler: () => ({ throw: Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }) }),
  });
  await assert.rejects(networkDown.service.analyze({ png: pngBuffer(), mode: 'vision' }), (err) => {
    assert.match(err.message, /网络请求失败/);
    assert.match(err.message, /已自动重试 1 次/);
    return true;
  });
  assert.equal(networkDown.fakeFetch.calls.length, 2);
  assert.equal(networkDown.service.health().vision.available, false);
  await networkDown.service.dispose();

  const unauthorized = makeContext({ fetchHandler: () => ({ status: 401, json: { error: { message: 'bad key' } } }) });
  await assert.rejects(unauthorized.service.analyze({ png: pngBuffer(), mode: 'vision' }), /401/);
  assert.equal(unauthorized.fakeFetch.calls.length, 1, '401 不应重试');
  const health401 = unauthorized.service.health();
  assert.equal(health401.vision.configured, true);
  assert.equal(health401.vision.available, false, '已配置但探测失败');
  assert.equal(health401.vision.probe.ok, false);
  assert.ok(health401.vision.probe.error);
  assert.equal(health401.ready, true, 'OCR 仍可用时整体 ready 仍为 true');
  await unauthorized.service.dispose();

  const timeout = makeContext({ fetchHandler: () => ({ hang: true }) });
  await assert.rejects(timeout.service.analyze({ png: pngBuffer(), mode: 'vision', timeoutMs: 80 }), /超时/);
  assert.equal(timeout.fakeFetch.calls.length, 1, '超时不重试');
  await timeout.service.dispose();
});

test('vision.analyze: mode=ocr 只跑本地 OCR（不调用视觉模型）', async () => {
  const bin = makeFakeBin();
  const { service, fakeFetch } = makeContext({
    bin,
    spawnHandlers: [{ match: (command) => command === bin, spec: { code: 0, stdout: JSON.stringify(OCR_HELPER_OK) } }],
    vision: { ocr: { bin } },
  });
  const result = await service.analyze({ png: pngBuffer(), mode: 'ocr' });
  assert.equal(result.mode, 'ocr');
  assert.match(result.ocr.text, /gradient/);
  assert.equal(result.caption, undefined);
  assert.equal(fakeFetch.calls.length, 0, 'mode=ocr 不应该调用 VLM');
  await service.dispose();
});

test('vision.analyze: mode=both 并行返回 ocr + caption；未知 mode 报错', async () => {
  const bin = makeFakeBin();
  const { service, fakeFetch } = makeContext({
    bin,
    spawnHandlers: [{ match: (command) => command === bin, spec: { code: 0, stdout: JSON.stringify(OCR_HELPER_OK) } }],
    fetchHandler: () => ({ status: 200, json: CAPTION_DATA }),
    vision: { ocr: { bin } },
  });
  const result = await service.analyze({ png: pngBuffer(), mode: 'both' });
  assert.match(result.ocr.text, /gradient/);
  assert.match(result.caption.text, /幻灯片/);
  assert.equal(result.provider, 'fake-vlm');
  assert.equal(fakeFetch.calls.length, 1);
  await assert.rejects(service.analyze({ png: pngBuffer(), mode: 'video' }), /未知 analyze mode/);
  await service.dispose();
});

test('vision.analyze: mode=both 时 OCR 失败但视觉成功 → 返回 caption + warnings', async () => {
  const bin = makeFakeBin();
  const { service } = makeContext({
    bin,
    spawnHandlers: [{ match: (command) => command === bin, spec: { code: 1, stderr: 'ocr crash' } }],
    fetchHandler: () => ({ status: 200, json: CAPTION_DATA }),
    vision: { ocr: { bin, fallback: [] } },
  });
  const result = await service.analyze({ png: pngBuffer(), mode: 'both' });
  assert.equal(result.ocr, undefined);
  assert.match(result.caption.text, /幻灯片/);
  assert.equal(result.warnings[0].scope, 'ocr');
  await service.dispose();
});

test('vision.analyzeSheet: 拼图分析走 vision 模式与专用 grid prompt，返回 sheet 标记', async () => {
  const { service, fakeFetch } = makeContext({ fetchHandler: () => ({ status: 200, json: CAPTION_DATA }) });
  const result = await service.analyzeSheet({ png: pngBuffer() });
  assert.equal(result.sheet, true);
  assert.equal(result.mode, 'vision');
  assert.match(result.caption.text, /幻灯片/);
  const prompt = fakeFetch.calls[0].body.messages[0].content[0].text;
  assert.match(prompt, /网格|逐格/);
  await service.dispose();
});

test('vision.analyze: 视觉 provider 缺 apiKey 时在调用前报可读错误', async () => {
  const bin = makeFakeBin();
  const config = {
    providers: { 'fake-vlm': { baseUrl: 'https://vlm.example.com/v1', model: 'm' } }, // 无 apiKey
    vision: { provider: 'fake-vlm', model: 'm', ocr: { bin, lazyBuild: false, fallback: [] } },
  };
  const service = createVisionService({ config, log: () => {}, fetchImpl: async () => { throw new Error('should not fetch'); }, spawnImpl: () => { throw new Error('should not spawn'); } });
  await assert.rejects(service.analyze({ png: pngBuffer(), mode: 'vision' }), /缺少 apiKey/);
  await service.dispose();
});

/* ------------------------------------------------------------------ *
 * 4. summarize：成功 / 裁剪 / 解析兜底 / 失败
 * ------------------------------------------------------------------ */

const DEMO_TRANSCRIPT = [
  { t0Ms: 1200, t1Ms: 5600, src: 'Gradient descent computes the gradient of the loss with respect to the parameters.', dst: '梯度下降计算损失函数对参数的梯度。' },
  { t0Ms: 5600, t1Ms: 9800, src: 'Then we take a small step in the opposite direction of the gradient.', dst: '然后沿梯度的反方向走一小步。' },
  { t0Ms: 9800, t1Ms: 13_400, src: 'The learning rate controls the size of each step.', dst: '学习率控制每一步的大小。' },
];

test('vision.summarize: 成功返回 summary/keyPoints/provider/model/ms，请求体含裁剪后的字幕与画面', async () => {
  const { service, fakeFetch } = makeContext({ fetchHandler: () => ({ status: 200, json: SUMMARY_DATA }) });
  const result = await service.summarize({
    title: 'The Core Idea of Gradient Descent',
    transcript: DEMO_TRANSCRIPT,
    visuals: [{ tMs: 1200, ocrText: 'The Core Idea\nGradient descent', caption: '幻灯片讲解梯度下降' }],
  });
  assert.match(result.summary, /梯度下降/);
  assert.ok(Array.isArray(result.keyPoints));
  assert.ok(Array.isArray(result.links));
  assert.ok(result.keyPoints.length >= 3 && result.keyPoints.length <= 6);
  assert.equal(result.provider, 'fake-text');
  assert.equal(result.model, 'fake-text-model');
  assert.equal(typeof result.ms, 'number');
  assert.equal(result.input.transcriptItems, 3);

  const call = fakeFetch.calls[0];
  assert.match(call.url, /^https:\/\/text\.example\.com\/v1\/chat\/completions$/);
  const userContent = call.body.messages[1].content;
  assert.match(userContent, /Gradient descent computes the gradient/);
  assert.match(userContent, /画面文字/);
  assert.match(call.body.messages[0].content, /JSON/);
  await service.dispose();
});

test('vision.summarize: 指定另一家 provider 时用那一家自己的 model', async () => {
  const { service, fakeFetch } = makeContext({
    fetchHandler: () => ({ status: 200, json: SUMMARY_DATA }),
    providers: {
      'other-text': { baseUrl: 'https://other.example.com/v1', apiKey: 'test-key-other', model: 'other-text-model' },
    },
    vision: { summary: { provider: 'fake-text', model: 'deepseek-flash' } },
  });
  const result = await service.summarize({
    title: '换模型',
    transcript: DEMO_TRANSCRIPT,
    visuals: [],
    provider: 'other-text',
  });
  assert.equal(result.provider, 'other-text');
  assert.equal(result.model, 'other-text-model');
  assert.match(fakeFetch.calls[0].url, /^https:\/\/other\.example\.com\/v1\/chat\/completions$/);
  assert.equal(fakeFetch.calls[0].body.model, 'other-text-model');
  await service.dispose();
});

test('vision.summarize: 超长输入按 maxInputChars 裁剪后再发送', async () => {
  const { service, fakeFetch } = makeContext({
    fetchHandler: () => ({ status: 200, json: SUMMARY_DATA }),
    vision: { summary: { provider: 'fake-text', model: 'fake-text-model', maxInputChars: 1200, timeoutMs: 5000 } },
  });
  const transcript = Array.from({ length: 200 }, (_, i) => ({
    t0Ms: i * 1000,
    t1Ms: i * 1000 + 900,
    src: `Long sentence ${i} about gradient descent, learning rate, loss function and optimization.`,
    dst: `第 ${i} 句讲梯度下降、学习率和损失函数。`,
  }));
  const result = await service.summarize({ title: '长课', transcript });
  assert.equal(result.input.truncated, true);
  assert.ok(result.input.transcriptKept < 200);
  const sentChars = fakeFetch.calls[0].body.messages[1].content.length;
  assert.ok(sentChars <= 1200 * 2, `发送给模型的输入应被裁剪，实际 ${sentChars} 字`);
  await service.dispose();
});

test('vision.summarize: 输出非 JSON 时兜底解析；空输出 / 401 报可读错误', async () => {
  const plain = makeContext({
    fetchHandler: () => ({ status: 200, json: { choices: [{ message: { content: '本视频讲梯度下降。\n- 沿负梯度更新\n- 学习率控制步长' } }] } }),
  });
  const result = await plain.service.summarize({ title: 't', transcript: DEMO_TRANSCRIPT });
  assert.match(result.summary, /梯度下降/);
  assert.ok(result.keyPoints.length >= 2);
  await plain.service.dispose();

  const empty = makeContext({ fetchHandler: () => ({ status: 200, json: { choices: [{ message: { content: '' } }] } }) });
  await assert.rejects(empty.service.summarize({ title: 't', transcript: DEMO_TRANSCRIPT }), /空内容/);
  await empty.service.dispose();

  const unauthorized = makeContext({ fetchHandler: () => ({ status: 401, json: { error: { message: 'bad key' } } }) });
  await assert.rejects(unauthorized.service.summarize({ title: 't', transcript: DEMO_TRANSCRIPT }), /401/);
  await unauthorized.service.dispose();
});

test('vision.summarize: 输入为空时也构造合法请求（不抛异常）', async () => {
  const { service, fakeFetch } = makeContext({ fetchHandler: () => ({ status: 200, json: SUMMARY_DATA }) });
  const result = await service.summarize({});
  assert.ok(result.summary.length > 0);
  assert.match(fakeFetch.calls[0].body.messages[1].content, /无字幕/);
  await service.dispose();
});

/* ------------------------------------------------------------------ *
 * 5. health / dispose
 * ------------------------------------------------------------------ */

test('vision.health: 返回 ocr/vision/summary/keyframe 摘要，不泄露 apiKey，不编译不发请求', async () => {
  const bin = makeFakeBin();
  const { service, fakeSpawn, fakeFetch } = makeContext({
    bin,
    spawnHandlers: [{ match: (command) => command === bin, spec: { code: 0, stdout: JSON.stringify(OCR_HELPER_OK) } }],
    vision: { ocr: { bin, fallback: ['tesseract'] } },
  });
  const health = service.health();
  assert.equal(typeof health.ready, 'boolean');
  assert.equal(health.ocr.ok, true);
  assert.equal(health.ocr.binExists, true);
  assert.equal(health.ocr.provider, 'macos-vision');
  assert.equal(health.ocr.mode, 'spawn', 'serve 关闭时应报告 spawn 模式');
  assert.equal(health.ocr.serve.enabled, false);
  assert.deepEqual(health.ocr.fallback, ['tesseract']);
  assert.equal(health.vision.configured, true);
  assert.equal(health.vision.provider, 'fake-vlm');
  assert.equal(health.vision.model, 'fake-vlm-model');
  assert.equal(health.summary.configured, true);
  assert.equal(health.keyframe.intervalMs, 6000);
  assert.equal(health.disposed, false);

  const serialized = JSON.stringify(health);
  assert.ok(!serialized.includes('test-key-vlm'), 'health 不能包含密钥');
  assert.ok(!serialized.includes('test-key-text'), 'health 不能包含密钥');
  assert.equal(fakeSpawn.calls.length, 0, 'health 不应编译/运行子进程');
  assert.equal(fakeFetch.calls.length, 0, 'health 不应发网络请求');
  assert.equal(health.vision.available, true, '已配置且尚未探测失败时视为可用');
  assert.equal(health.vision.probe.ok, null, '还没真实调用过');
  assert.equal(health.ocr.lastOcrMs, null, '还没 OCR 过');

  await service.ocr({ png: pngBuffer() });
  const afterOcr = service.health();
  assert.equal(typeof afterOcr.ocr.lastOcrMs, 'number');
  assert.ok(afterOcr.ocr.lastOcrMs >= 0);
  assert.equal(afterOcr.ocr.lastOcrMode, 'spawn');
  assert.ok(afterOcr.ocr.lastOcrAt);

  await service.dispose();
  const after = service.health();
  assert.equal(after.disposed, true);
  assert.equal(after.ready, false, 'dispose 后 ready 应为 false');
});

test('vision.health: 二进制缺失但可懒编译时 ok=true；VLM 无 Key 时 configured=false 并给原因', async () => {
  const missingBin = path.join(makeTempRoot(), 'missing-ocr');
  const buildScript = makeFakeExecutableScript();
  const config = {
    providers: {},
    vision: {
      provider: 'not-a-provider',
      model: 'x',
      ocr: { bin: missingBin, buildScript, lazyBuild: true, fallback: [] },
    },
  };
  const service = createVisionService({ config, log: () => {}, fetchImpl: async () => { throw new Error('no fetch'); }, spawnImpl: () => { throw new Error('no spawn'); } });
  const health = service.health();
  assert.equal(health.ocr.binExists, false);
  if (fs.existsSync('/usr/bin/swiftc') && fs.existsSync(buildScript)) {
    assert.equal(health.ocr.canLazyBuild, true);
    assert.equal(health.ocr.ok, true);
  }
  assert.equal(health.vision.configured, false);
  assert.ok(health.vision.reason, '未配置时应说明原因');
  assert.equal(health.ready, health.ocr.ok, '只有当 OCR 也没有时才 ready=false');
  await service.dispose();
});

test('vision.dispose: 幂等、dispose 后调用报「已 dispose」', async () => {
  const { service } = makeContext();
  assert.deepEqual(await service.dispose(), { ok: true });
  assert.deepEqual(await service.dispose(), { ok: true });
  await assert.rejects(service.ocr({ png: pngBuffer() }), /已 dispose/);
  await assert.rejects(service.analyze({ png: pngBuffer() }), /已 dispose/);
  await assert.rejects(service.summarize({}), /已 dispose/);
});

/* ------------------------------------------------------------------ *
 * 6. Swift helper / 构建脚本静态契约（CI 跨平台可跑）
 * ------------------------------------------------------------------ */

test('vision: scripts/ocr-macos.swift 使用 Vision accurate 中英识别并输出 JSON 契约', () => {
  assert.ok(fs.existsSync(SWIFT_SRC), `缺少 ${path.relative(ROOT, SWIFT_SRC)}`);
  const source = fs.readFileSync(SWIFT_SRC, 'utf8');
  assert.match(source, /import Vision/);
  assert.match(source, /VNRecognizeTextRequest/);
  assert.match(source, /\.accurate/);
  assert.match(source, /zh-Hans/);
  assert.match(source, /en-US/);
  assert.match(source, /--image/);
  assert.match(source, /"provider"/);
  assert.match(source, /macos-vision/);
  assert.match(source, /"lines"/);
  assert.match(source, /"confidence"/);
  assert.match(source, /"ms"/);
  assert.match(source, /JSONSerialization/);
  assert.match(source, /"ok": false/);
  // 常驻 serve 模式：stdin 逐行 JSON 请求 / stdout ready + 响应行
  assert.match(source, /--serve/);
  assert.match(source, /"ready"/);
  assert.match(source, /readLine\(strippingNewline: true\)/);
  assert.match(source, /"image"/);
});

test('vision: scripts/build-ocr.sh 可 bash -n，产物 data/bin/ocr-macos，含沙箱 env 与 --check', () => {
  assert.ok(fs.existsSync(BUILD_SCRIPT), `缺少 ${path.relative(ROOT, BUILD_SCRIPT)}`);
  const out = execFileSync('bash', ['-n', BUILD_SCRIPT], { encoding: 'utf8' });
  assert.equal(out.trim(), '');
  const script = fs.readFileSync(BUILD_SCRIPT, 'utf8');
  assert.match(script, /swiftc/);
  assert.match(script, /-O/);
  assert.match(script, /data\/bin\/ocr-macos/);
  assert.match(script, /TMPDIR/);
  assert.match(script, /CLANG_MODULE_CACHE_PATH/);
  assert.match(script, /SWIFT_MODULECACHE_PATH/);
  assert.match(script, /--check/);
  assert.match(script, /docs\/assets\/demo-original\.png/);
  assert.match(script, /LIVEDUB_TMPDIR/);
  assert.match(script, /run_serve_check/);
  assert.match(script, /--serve/);
});

/* ------------------------------------------------------------------ *
 * 7. 真机集成（LIVEDUB_INTEGRATION=1 且 macOS 才跑；VLM 真实调用 1 次）
 * ------------------------------------------------------------------ */

test('vision 真机：macOS Vision OCR 两张图 + 一次 VLM 单帧 + 一次 summarize', { skip: !INTEGRATION }, async (t) => {
  // 确保二进制存在（首次会编译；已编译则秒过）
  if (!fs.existsSync(OCR_BIN)) {
    execFileSync('bash', [BUILD_SCRIPT, '--check'], { encoding: 'utf8', timeout: 240_000 });
  }
  const service = createVisionService({ config: {}, log: (line) => t.diagnostic(`[vision] ${line}`) });

  try {
    const demoPng = fs.readFileSync(DEMO_PNG);
    const zhPng = fs.readFileSync(STUDIO_ZH_PNG);

    // 常驻 serve：第 1 帧含进程启动；第 2/3 帧是纯识别耗时（目标 <1.5s/帧，机器负载高时会变慢）
    const t1 = Date.now();
    const ocrDemo = await service.ocr({ png: demoPng });
    const wall1 = Date.now() - t1;
    t.diagnostic(`OCR serve 第1帧: wall=${wall1}ms helper=${ocrDemo.helperMs}ms lines=${ocrDemo.lines.length} chars=${ocrDemo.text.length} mode=${ocrDemo.mode}`);
    assert.equal(ocrDemo.provider, 'macos-vision');
    assert.ok(ocrDemo.lines.length >= 3, '演示幻灯片至少识别出 3 行');
    assert.match(ocrDemo.text, /gradient/i);
    assert.equal(ocrDemo.mode, 'serve', '有二进制时应走常驻 serve 模式');

    const t2 = Date.now();
    const ocrZh = await service.ocr({ png: zhPng });
    const wall2 = Date.now() - t2;
    t.diagnostic(`OCR serve 第2帧（中文界面截图）: wall=${wall2}ms helper=${ocrZh.helperMs}ms lines=${ocrZh.lines.length} chars=${ocrZh.text.length}`);
    assert.ok(ocrZh.text.length > 50);
    assert.match(ocrZh.text, /ASR|字幕|livedub|笔记/i);

    const t3 = Date.now();
    const ocrDemo3 = await service.ocr({ png: demoPng });
    const wall3 = Date.now() - t3;
    t.diagnostic(`OCR serve 第3帧: wall=${wall3}ms helper=${ocrDemo3.helperMs}ms mode=${ocrDemo3.mode}`);
    const healthAfterOcr = service.health();
    t.diagnostic(`OCR serve health: mode=${healthAfterOcr.ocr.mode} spawnCount=${healthAfterOcr.ocr.serve.spawnCount} requests=${healthAfterOcr.ocr.serve.requests} restarts=${healthAfterOcr.ocr.serve.restarts}`);
    assert.equal(healthAfterOcr.ocr.mode, 'serve');
    assert.equal(healthAfterOcr.ocr.serve.spawnCount, 1, '三帧应只启动一次常驻进程');

    // 真实 VLM 单帧（额度有限：整个测试文件只此一次）
    const analyzed = await service.analyze({ png: demoPng, mode: 'vision', timeoutMs: 120_000 });
    t.diagnostic(`VLM 单帧: provider=${analyzed.caption.provider} model=${analyzed.caption.model} ms=${analyzed.caption.ms} chars=${analyzed.caption.text.length}`);
    assert.ok(analyzed.caption.text.length > 20, 'VLM 应返回中文画面描述');
    assert.match(analyzed.caption.text, /[\u4e00-\u9fff]/, '描述应为中文');

    // 真实文本总结（deepseek，快）
    const summarized = await service.summarize({
      title: 'The Core Idea of Gradient Descent',
      transcript: DEMO_TRANSCRIPT,
      visuals: [{ tMs: 1200, ocrText: ocrDemo.text.slice(0, 600), caption: analyzed.caption.text }],
    });
    t.diagnostic(`summarize: provider=${summarized.provider} ms=${summarized.ms} keyPoints=${summarized.keyPoints.length}`);
    assert.ok(summarized.summary.length >= 30);
    assert.ok(summarized.keyPoints.length >= 1 && summarized.keyPoints.length <= 6);
  } finally {
    await service.dispose();
  }
});
