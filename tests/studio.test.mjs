/**
 * T4 本地引擎服务 + 工作台传输层测试。
 *
 * 约束：
 * - 随机端口（port: 0），绝不占用 8787 / 18765；
 * - 不联网、不加载真模型：HTTP/WS 用注入的假会话或 pipeline + mock deps；
 * - /api/voices 全部注入 voiceLister，避免测试期间调用真实 TTS。
 *
 * 覆盖：
 * - /health、/api/config 脱敏（apiKey 不泄漏）、/api/voices 回退预设；
 * - 静态服务 200 / 404 / 302，目录穿越 403，Range 206；
 * - WS：hello -> ready -> 二进制音频帧 / JSON 音频兜底 -> segment/translation/dub；
 *   control/config/glossary/ping 转发；关闭连接触发 session.close('client disconnected')；
 * - WS Origin 白名单；真实 pipeline + mock deps 的端到端（pipeline 存在时）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { startServer, isAllowedOrigin, buildPresetVoices } from '../engine/server.mjs';
import { encodeAudioFrame } from '../engine/protocol.mjs';
import { PROJECT_ROOT, deepMerge, loadConfig } from '../engine/config.mjs';
import { createMockDeps } from '../engine/mock.mjs';
import { buildEventJsonl, parseSessionJsonl } from '../studio/session-parse.mjs';
import {
  buildNoteExportFilename,
  buildNotesMarkdown,
  buildOutlineMarkdown,
  buildQuoteMarkdown,
  buildVideoRef,
  filterNotes,
  fnv1aHex,
  formatNoteTimestamp,
  formatShortTimestamp,
  insertAtCursor,
  localNotesKey,
  makeQuote,
  makeVideoId,
  noteExcerpt,
  parseTags,
  renderMarkdown,
  resolveEditorShortcut,
  sortNotesByTime,
  timestampAnchor,
  videoTitleFrom,
} from '../studio/notes-kit.mjs';
import {
  ASR_ENGINE_OPTIONS,
  asrEngineLabel,
  asrPrivacyCopy,
  buildSettingsPatch,
  buildSparkline,
  desktopAppInstructions,
  isEditableTarget,
  mergeSettingsSnapshot,
  normalizeAsrEngine,
  normalizeSubsStyle,
  normalizeTheme,
  resolveShortcut,
} from '../studio/ui-kit.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 测试基础配置：所有 provider 都 mock，避免任何网络/模型依赖 */
function testConfig(overrides = {}) {
  return deepMerge(loadConfig(), {
    asr: { provider: 'mock' },
    translate: { provider: 'mock' },
    tts: { provider: 'mock', voiceMode: 'preset' },
    dub: { enabled: true },
    ...overrides,
  });
}

/** 每个测试独立的临时目录（UI 设置 / 桌面 App 检测互不污染） */
function makeTempDir(prefix = 'livedub-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * 测试专用 startServer：
 * - dataDir 指向临时目录，避免读写仓库 data/ui-settings.json；
 * - desktopAppPath 默认指向不存在的临时路径，避免本机 build 产物影响断言。
 */
function startTestServer(options = {}) {
  const dataDir = options.dataDir ?? makeTempDir('livedub-test-data-');
  return startServer({
    log: () => {},
    dataDir,
    desktopAppPath: options.desktopAppPath ?? path.join(dataDir, 'no-desktop-app'),
    ...options,
  });
}

// ------------------------------------------------------------------ HTTP 工具

function httpRequest(port, pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('http timeout')));
    req.end();
  });
}

function rawUpgrade(port, { origin, pathname = '/ws' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [
        `GET ${pathname} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${Buffer.from('livedub-test-0123').toString('base64')}`,
        'Sec-WebSocket-Version: 13',
      ];
      if (origin) lines.push(`Origin: ${origin}`);
      lines.push('', '');
      socket.write(lines.join('\r\n'));
    });
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('upgrade timeout'));
    }, 3000);
    timer.unref?.();
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1');
      if (data.includes('\r\n\r\n')) {
        clearTimeout(timer);
        socket.destroy();
        resolve(data);
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ------------------------------------------------------------------ WS 工具

async function openWs(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`WebSocket 连接失败：${url}`)), { once: true });
  });
  const events = [];
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    try {
      events.push(JSON.parse(event.data));
    } catch {
      /* ignore */
    }
  });
  return { socket, events };
}

function waitForEvent(events, predicate, timeoutMs = 5000, label = 'event') {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const found = events.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`等待 ${label} 超时（已收到：${events.map((event) => event.type).join(', ')}）`));
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function waitFor(predicate, timeoutMs = 5000, label = 'condition') {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`等待 ${label} 超时`));
      setTimeout(check, 10);
    };
    check();
  });
}

/**
 * 假会话工厂：与 pipeline.createSession 行为一致（工厂返回前 emit ready），
 * 前两帧音频后吐出一句完整事件，所有消息都记录，便于断言转发。
 */
function createFakeSessionFactory(record) {
  return async ({ id, options, emit, log }) => {
    const session = {
      id,
      options,
      frames: [],
      json: [],
      closed: false,
      closedReason: null,
      log,
    };
    record.push(session);
    const api = {
      async start() {
        return api;
      },
      onAudio(pcm, tMs) {
        session.frames.push({ tMs, bytes: pcm.length });
        if (session.frames.length === 2) {
          emit({ type: 'segment', id: 1, t0Ms: 0, t1Ms: 200, text: 'Hello world.', lang: 'en' });
          emit({ type: 'translation', id: 1, text: '你好，世界。', final: true });
          emit({
            type: 'dub',
            id: 1,
            seq: 0,
            startMs: 200,
            sampleRate: 16000,
            format: 's16le',
            pcm: Buffer.alloc(320).toString('base64'),
            durationMs: 10,
            voiceId: 'fake-voice',
            final: true,
          });
          emit({ type: 'metrics', id: 1, asrFinalMs: 100, mtFirstMs: 20, ttsFirstMs: 30, e2eLagMs: 150 });
        }
      },
      onJson(msg) {
        session.json.push(msg);
      },
      async close(reason) {
        session.closed = true;
        session.closedReason = reason;
      },
    };
    emit({ type: 'status', state: 'initializing' });
    emit({
      type: 'ready',
      sessionId: id,
      protocol: 1,
      providers: { asr: 'fake-asr', translate: 'fake-mt', tts: 'fake-tts' },
      voice: { mode: 'preset', voiceId: 'fake-voice' },
      limits: { audioFrameMs: 100, sampleRate: 16000, langFrom: 'en', langTo: 'zh' },
    });
    emit({ type: 'status', state: 'listening' });
    return api;
  };
}

function pcmFrame(tMs, { samples = 1600 } = {}) {
  return new Uint8Array(encodeAudioFrame(tMs, Buffer.alloc(samples * 2)));
}

// =================================================================== HTTP API

test('HTTP /health：ok、版本、provider、whisper 是否找到、sayless 路径', async () => {
  const srv = await startTestServer({ port: 0, config: testConfig(), log: () => {} });
  try {
    const res = await fetch(`${srv.url}/health`);
    assert.equal(res.status, 200);
    const health = await res.json();
    assert.equal(health.ok, true);
    assert.equal(health.name, 'livedub');
    assert.ok(String(health.version).length > 0);
    assert.equal(health.protocol, 1);
    assert.equal(health.providers.asr, 'mock');
    assert.equal(health.providers.translate, 'mock');
    assert.equal(health.providers.tts, 'mock');
    assert.equal(typeof health.whisper.found, 'boolean');
    // 模型是否存在取决于运行环境（CI 不下载 574MB 模型）：只校验字段自洽
    if (health.whisper.found) assert.ok(String(health.whisper.model ?? '').length > 0);
    else assert.ok(health.whisper.model == null || health.whisper.model === '');
    assert.equal(typeof health.sayless, 'object');
    assert.ok('configPath' in health.sayless);
    assert.equal(typeof health.mode, 'string');
    assert.equal(health.server.port, srv.port);
  } finally {
    await srv.close();
  }
});

test('HTTP /api/config：publicConfig 脱敏，任何 apiKey 都不出现', async () => {
  const envKey = 'LIVEDUB_PROVIDER_DEEPSEEK_API_KEY';
  const previousEnv = process.env[envKey];
  process.env[envKey] = 'sk-ENV-SECRET-should-not-leak';
  const config = testConfig({
    providers: { deepseek: { apiKey: 'sk-FILE-SECRET-should-not-leak', baseUrl: 'https://api.deepseek.com' } },
  });
  const srv = await startTestServer({ port: 0, config, log: () => {} });
  try {
    const res = await fetch(`${srv.url}/api/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.protocol, 1);
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('sk-FILE-SECRET'), '配置文件里的 apiKey 泄漏了');
    assert.ok(!serialized.includes('sk-ENV-SECRET'), '环境变量里的 apiKey 泄漏了');
    assert.ok(!serialized.includes('"apiKey"'), '响应里不应有 apiKey 字段');
    assert.equal(body.config.asr.provider, 'mock');
    assert.equal(typeof body.config.runtime.whisperModelFound, 'boolean');
    assert.equal(body.config.runtime.mode, 'pipeline');
  } finally {
    if (previousEnv === undefined) delete process.env[envKey];
    else process.env[envKey] = previousEnv;
    await srv.close();
  }
});

test('HTTP /api/voices：真实 provider 失败时回退 config 预设，不返回 500', async () => {
  const srv = await startTestServer({
    port: 0,
    config: testConfig(),
    log: () => {},
    voiceLister: async () => {
      throw new Error('offline in tests');
    },
  });
  try {
    const res = await fetch(`${srv.url}/api/voices`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.source, 'preset');
    assert.ok(Array.isArray(body.voices));
    assert.ok(body.voices.length >= 1);
    for (const voice of body.voices) {
      assert.equal(typeof voice.id, 'string');
      assert.equal(typeof voice.label, 'string');
      assert.ok(voice.id.length > 0);
    }
    assert.ok(!JSON.stringify(body).includes('apiKey'));
    // 预设来自配置：male-qn-qingse 应在列表里
    assert.ok(body.voices.some((voice) => voice.id === 'male-qn-qingse'));
  } finally {
    await srv.close();
  }
});

test('HTTP /api/voices：注入的 provider 成功时 source=provider', async () => {
  const srv = await startTestServer({
    port: 0,
    config: testConfig(),
    log: () => {},
    voiceLister: async () => [
      { id: 'voice-a', label: '音色 A', gender: 'female' },
      { id: 'voice-b', label: '音色 B' },
    ],
  });
  try {
    const res = await fetch(`${srv.url}/api/voices`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, 'provider');
    assert.equal(body.voices.length, 2);
    assert.equal(body.voices[0].id, 'voice-a');
  } finally {
    await srv.close();
  }
});

test('HTTP 静态服务：/ -> /studio/、/studio/ 与 /replay/ 200、缺失 404', async () => {
  const srv = await startTestServer({ port: 0, config: testConfig(), log: () => {} });
  try {
    const root = await httpRequest(srv.port, '/');
    assert.equal(root.status, 302);
    assert.equal(root.headers.location, '/studio/');

    const studio = await httpRequest(srv.port, '/studio/');
    assert.equal(studio.status, 200);
    assert.match(String(studio.headers['content-type']), /text\/html/);
    assert.ok(studio.body.includes('本地实时同传工作台'));
    assert.ok(studio.body.includes('开始同传'));
    // v0.3：ASR 引擎选择 / 隐私提示 / 桌面 App 入口
    assert.ok(studio.body.includes('识别引擎'));
    assert.ok(studio.body.includes('本地 whisper'));
    assert.ok(studio.body.includes('云端 MiniMax'));
    assert.ok(studio.body.includes('音频不离开本机'));
    assert.ok(studio.body.includes('桌面 App'));
    assert.ok(studio.body.includes('data/ui-settings.json'));
    // v0.4：学习笔记面板（含 ?notes=1 打开入口所需的 DOM）
    assert.ok(studio.body.includes('学习笔记'));
    assert.ok(studio.body.includes('notesDrawer'));
    assert.ok(studio.body.includes('notesEditor'));
    assert.ok(studio.body.includes('data/notes/'));

    const app = await httpRequest(srv.port, '/studio/app.mjs');
    assert.equal(app.status, 200);
    assert.match(String(app.headers['content-type']), /text\/javascript/);
    assert.ok(app.body.includes('startSession'));

    const worklet = await httpRequest(srv.port, '/studio/worklet.js');
    assert.equal(worklet.status, 200);

    const replay = await httpRequest(srv.port, '/replay/');
    assert.equal(replay.status, 200);
    assert.match(String(replay.headers['content-type']), /text\/html/);
    assert.ok(replay.body.includes('离线回放'));
    // /replay/ 的相对路径会解析成 /replay/...，因此页面资源必须用绝对路径
    assert.ok(replay.body.includes('/studio/styles.css'), 'replay.html 应使用绝对样式路径');
    assert.ok(replay.body.includes('/studio/replay.mjs'), 'replay.html 应使用绝对脚本路径');
    const replayCss = await httpRequest(srv.port, '/studio/styles.css');
    assert.equal(replayCss.status, 200);
    const replayJs = await httpRequest(srv.port, '/studio/replay.mjs');
    assert.equal(replayJs.status, 200);

    const replayRedirect = await httpRequest(srv.port, '/replay?session=/studio/sample/session.jsonl');
    assert.equal(replayRedirect.status, 302);
    assert.equal(replayRedirect.headers.location, '/replay/?session=/studio/sample/session.jsonl');

    const sample = await httpRequest(srv.port, '/studio/sample/session.jsonl');
    assert.equal(sample.status, 200);
    const firstLine = sample.body.split('\n')[0];
    assert.equal(JSON.parse(firstLine).type, 'meta');

    const missing = await httpRequest(srv.port, '/studio/does-not-exist.js');
    assert.equal(missing.status, 404);

    const api404 = await fetch(`${srv.url}/api/nope`);
    assert.equal(api404.status, 404);

    const wsHttp = await fetch(`${srv.url}/ws`);
    assert.equal(wsHttp.status, 426);
  } finally {
    await srv.close();
  }
});

test('HTTP 静态服务：目录穿越 403、Range 206、非白名单前缀 404', async () => {
  const srv = await startTestServer({ port: 0, config: testConfig(), log: () => {} });
  try {
    const attempts = [
      '/studio/%2e%2e%2fengine%2fconfig.mjs',
      '/studio/%2e%2e/%2e%2e/etc/passwd',
      '/demo/%2e%2e%2fconfig%2flivedub.config.json',
    ];
    for (const attempt of attempts) {
      const res = await httpRequest(srv.port, attempt);
      assert.ok([403, 404].includes(res.status), `${attempt} 应为 403/404，实际 ${res.status}`);
      assert.ok(!res.body.includes('PROJECT_ROOT'), '穿越请求泄漏了 engine/config.mjs 内容');
      assert.ok(!res.body.includes('livedub.config'), '穿越请求泄漏了配置文件内容');
    }

    // 原始 URL 未编码的 ../ 同样拒绝（http client 不会自动 normalize）
    const raw = await httpRequest(srv.port, '/studio/../engine/config.mjs');
    assert.ok([403, 404].includes(raw.status));

    const range = await httpRequest(srv.port, '/studio/sample/session.jsonl', { headers: { Range: 'bytes=0-9' } });
    assert.equal(range.status, 206);
    assert.match(String(range.headers['content-range']), /^bytes 0-9\/\d+$/);
    assert.equal(range.body.length, 10);

    const outside = await httpRequest(srv.port, '/engine/config.mjs');
    assert.equal(outside.status, 404);
  } finally {
    await srv.close();
  }
});

// ===================================================================== WS

test('WS：hello -> ready -> 二进制音频帧 -> segment/translation/dub，并转发 control/config/glossary/ping', async () => {
  const record = [];
  const srv = await startTestServer({ port: 0, config: testConfig(), log: () => {}, sessionFactory: createFakeSessionFactory(record) });
  let client = null;
  try {
    client = await openWs(`${srv.url.replace('http://', 'ws://')}/ws`);
    const { socket, events } = client;
    socket.send(
      JSON.stringify({
        type: 'hello',
        protocol: 1,
        session: { source: 'test', title: 'studio test', langFrom: 'en', langTo: 'zh' },
        glossary: [{ src: 'gradient descent', dst: '梯度下降' }],
      }),
    );

    const ready = await waitForEvent(events, (event) => event.type === 'ready', 4000, 'ready');
    assert.equal(ready.protocol, 1);
    assert.equal(ready.providers.asr, 'fake-asr');
    assert.equal(typeof ready.sessionId, 'string');
    assert.ok(ready.sessionId.length > 0);
    await waitForEvent(events, (event) => event.type === 'status' && event.state === 'listening', 4000, 'status listening');

    const session = record[0];
    assert.ok(session, '应创建会话');
    assert.equal(session.options.source, 'test');
    assert.equal(session.options.glossary.length, 1);
    assert.equal(session.options.glossary[0].src, 'gradient descent');

    // 二进制音频帧：tag 0x01 + float64BE tMs + s16le 100ms
    socket.send(pcmFrame(0));
    socket.send(pcmFrame(100));
    const segment = await waitForEvent(events, (event) => event.type === 'segment', 4000, 'segment');
    assert.equal(segment.text, 'Hello world.');
    const translation = await waitForEvent(events, (event) => event.type === 'translation' && event.final === true, 4000, 'translation');
    assert.equal(translation.text, '你好，世界。');
    const dub = await waitForEvent(events, (event) => event.type === 'dub', 4000, 'dub');
    assert.equal(dub.format, 's16le');
    assert.equal(dub.sampleRate, 16000);
    assert.ok(dub.pcm.length > 0);

    // JSON 音频兜底
    const fallbackPcm = Buffer.alloc(3200);
    socket.send(JSON.stringify({ type: 'audio', tMs: 200, pcm: fallbackPcm.toString('base64') }));
    // control / config / glossary / ping 转发
    socket.send(JSON.stringify({ type: 'control', action: 'pause', tMs: 200 }));
    socket.send(JSON.stringify({ type: 'control', action: 'resume', tMs: 200 }));
    socket.send(JSON.stringify({ type: 'config', patch: { dub: { enabled: false } } }));
    socket.send(JSON.stringify({ type: 'glossary', terms: [{ src: 'learning rate', dst: '学习率' }] }));
    socket.send(JSON.stringify({ type: 'ping', t: 42 }));

    await waitFor(() => session.frames.length >= 3, 4000, '3 帧音频');
    assert.deepEqual(
      session.frames.map((frame) => frame.tMs),
      [0, 100, 200],
    );
    assert.deepEqual(
      session.frames.map((frame) => frame.bytes),
      [3200, 3200, 3200],
    );
    await waitFor(
      () => ['control', 'config', 'glossary', 'ping'].every((type) => session.json.some((msg) => msg.type === type)),
      4000,
      'JSON 消息转发',
    );
    const controls = session.json.filter((msg) => msg.type === 'control');
    assert.deepEqual(
      controls.map((msg) => msg.action),
      ['pause', 'resume'],
    );
    const glossary = session.json.find((msg) => msg.type === 'glossary');
    assert.equal(glossary.terms[0].dst, '学习率');
    const ping = session.json.find((msg) => msg.type === 'ping');
    assert.equal(ping.t, 42);

    // 关闭连接 -> session.close('client disconnected')
    const closed = new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }));
    socket.close();
    await closed;
    await waitFor(() => session.closed === true, 4000, 'session.close');
    assert.equal(session.closedReason, 'client disconnected');
    client = null;
  } finally {
    try {
      client?.socket?.close();
    } catch {
      /* ignore */
    }
    await srv.close();
  }
});

test('WS：非法音频帧/未 hello 送音频只回 error 事件，不崩溃', async () => {
  const record = [];
  const srv = await startTestServer({ port: 0, config: testConfig(), log: () => {}, sessionFactory: createFakeSessionFactory(record) });
  let client = null;
  try {
    client = await openWs(`${srv.url.replace('http://', 'ws://')}/ws`);
    const { socket, events } = client;
    socket.send(pcmFrame(0)); // 未 hello
    const helloError = await waitForEvent(events, (event) => event.type === 'error' && /hello/.test(event.message), 3000, 'hello error');
    assert.equal(helloError.recoverable, true);

    socket.send(JSON.stringify({ type: 'hello', protocol: 1, session: { source: 'test' } }));
    await waitForEvent(events, (event) => event.type === 'ready', 4000, 'ready');

    // 非法帧：只有 tag 没有 tMs
    socket.send(new Uint8Array([0x01, 0x00]));
    const frameError = await waitForEvent(events, (event) => event.type === 'error' && /音频帧格式错误/.test(event.message), 3000, 'frame error');
    assert.equal(frameError.recoverable, true);

    // 非法 JSON
    socket.send('{not json');
    await waitForEvent(events, (event) => event.type === 'error' && /解析文本消息/.test(event.message), 3000, 'json error');

    // 连接仍然可用
    socket.send(JSON.stringify({ type: 'ping', t: 7 }));
    await waitFor(() => record[0].json.some((msg) => msg.type === 'ping' && msg.t === 7), 3000, 'ping 转发');
  } finally {
    try {
      client?.socket?.close();
    } catch {
      /* ignore */
    }
    await srv.close();
  }
});

test('WS Origin 白名单：本机/扩展放行，外部 Origin 403', async () => {
  const srv = await startTestServer({ port: 0, config: testConfig(), log: () => {}, sessionFactory: createFakeSessionFactory([]) });
  try {
    const local = await rawUpgrade(srv.port, { origin: `http://127.0.0.1:${srv.port}` });
    assert.match(local, /101 Switching Protocols/);
    const localhost = await rawUpgrade(srv.port, { origin: 'http://localhost:3000' });
    assert.match(localhost, /101 Switching Protocols/);
    const extension = await rawUpgrade(srv.port, { origin: 'chrome-extension://abcdefghijklmnopqrstuvwx' });
    assert.match(extension, /101 Switching Protocols/);
    const noOrigin = await rawUpgrade(srv.port, {});
    assert.match(noOrigin, /101 Switching Protocols/);

    const evil = await rawUpgrade(srv.port, { origin: 'https://evil.example.com' });
    assert.match(evil, /403 Forbidden/);
  } finally {
    await srv.close();
  }
});

test('isAllowedOrigin / buildPresetVoices 纯函数', () => {
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:8787'), true);
  assert.equal(isAllowedOrigin('http://localhost:5173'), true);
  assert.equal(isAllowedOrigin('https://localhost:5173'), true);
  assert.equal(isAllowedOrigin('chrome-extension://abcdefghijklmnop'), true);
  assert.equal(isAllowedOrigin('https://evil.example.com'), false);
  assert.equal(isAllowedOrigin('file:///tmp/x.html'), false);
  assert.equal(isAllowedOrigin('chrome-extension://short'), false);

  const voices = buildPresetVoices(testConfig());
  assert.ok(voices.length >= 2);
  assert.ok(voices.every((voice) => typeof voice.id === 'string' && typeof voice.label === 'string'));
  assert.ok(voices.some((voice) => voice.id === 'male-qn-qingse'));
});

test('--demo 模式：/health 报告 demo，WS 可建立演示会话', async () => {
  const srv = await startTestServer({ port: 0, config: testConfig(), demo: true, log: () => {} });
  let client = null;
  try {
    const health = await (await fetch(`${srv.url}/health`)).json();
    assert.equal(health.mode, 'demo');
    client = await openWs(`${srv.url.replace('http://', 'ws://')}/ws`);
    client.socket.send(JSON.stringify({ type: 'hello', protocol: 1, session: { source: 'test' } }));
    const ready = await waitForEvent(client.events, (event) => event.type === 'ready', 4000, 'demo ready');
    assert.equal(ready.providers.asr, 'mock');
    assert.equal(typeof ready.sessionId, 'string');
  } finally {
    try {
      client?.socket?.close();
    } catch {
      /* ignore */
    }
    await srv.close();
  }
});

// ===================================================== 真实 pipeline 端到端

test('真实 engine/pipeline.mjs + mock deps：hello -> ready -> 音频 -> segment/translation/dub', { timeout: 30_000 }, async (t) => {
  const pipelinePath = path.join(PROJECT_ROOT, 'engine', 'pipeline.mjs');
  if (!fs.existsSync(pipelinePath)) {
    t.skip('engine/pipeline.mjs 尚未就绪（Lead scope），传输层已由注入假会话覆盖');
    return;
  }
  const pipeline = await import('../engine/pipeline.mjs');
  const config = testConfig();
  const deps = { config, ...createMockDeps() };
  const srv = await startTestServer({
    port: 0,
    config,
    log: () => {},
    sessionFactory: async (args) => pipeline.createSession({ ...args, deps }),
  });
  let client = null;
  try {
    client = await openWs(`${srv.url.replace('http://', 'ws://')}/ws`);
    const { socket, events } = client;
    socket.send(
      JSON.stringify({
        type: 'hello',
        protocol: 1,
        session: { source: 'test', title: 'pipeline e2e', langFrom: 'en', langTo: 'zh' },
        glossary: [{ src: 'gradient descent', dst: '梯度下降' }],
      }),
    );
    const ready = await waitForEvent(events, (event) => event.type === 'ready', 15_000, 'pipeline ready');
    assert.equal(ready.protocol, 1);
    assert.equal(ready.sessionId.length > 0, true);

    // mock ASR 第一句需要累计 2400ms 音频 -> 送 30 帧（每帧 100ms）
    for (let index = 0; index < 30; index += 1) {
      socket.send(pcmFrame(index * 100));
      await sleep(8);
    }

    const segment = await waitForEvent(events, (event) => event.type === 'segment', 15_000, 'segment');
    assert.match(segment.text, /gradient descent/i);
    const translation = await waitForEvent(events, (event) => event.type === 'translation' && event.final === true && event.text, 15_000, 'translation');
    assert.ok(translation.text.includes('梯度下降'), `译文应包含术语：${translation.text}`);
    const dub = await waitForEvent(events, (event) => event.type === 'dub' && event.pcm && event.pcm.length > 0, 15_000, 'dub');
    assert.equal(dub.format, 's16le');
    assert.ok(dub.sampleRate >= 8000);
    assert.ok(dub.durationMs > 0);
    assert.equal(typeof dub.startMs, 'number');
  } finally {
    try {
      client?.socket?.close();
    } catch {
      /* ignore */
    }
    await srv.close();
  }
});

// ================================================ v0.2 服务端健壮性 / 纯函数

test('server.maxSessions：超过并发上限时拒绝新会话（error+1013）并报告 activeSessions', async () => {
  const record = [];
  const srv = await startTestServer({
    port: 0,
    config: testConfig(),
    log: () => {},
    sessionFactory: createFakeSessionFactory(record),
    maxSessions: 1,
  });
  let first = null;
  let second = null;
  try {
    first = await openWs(`${srv.url.replace('http://', 'ws://')}/ws`);
    first.socket.send(JSON.stringify({ type: 'hello', protocol: 1, session: { source: 'test' } }));
    await waitForEvent(first.events, (event) => event.type === 'ready', 4000, 'ready');

    const health = await (await fetch(`${srv.url}/health`)).json();
    assert.equal(health.activeSessions, 1);
    assert.equal(health.sessions.active, 1);
    assert.equal(health.sessions.max, 1);

    second = await openWs(`${srv.url.replace('http://', 'ws://')}/ws`);
    const secondClosed = new Promise((resolve) => second.socket.addEventListener('close', (event) => resolve(event.code), { once: true }));
    second.socket.send(JSON.stringify({ type: 'hello', protocol: 1, session: { source: 'test' } }));
    const error = await waitForEvent(second.events, (event) => event.type === 'error', 4000, 'max sessions error');
    assert.equal(error.code, 'MAX_SESSIONS');
    assert.equal(error.recoverable, false);
    assert.match(error.message, /上限/);
    const closeCode = await secondClosed;
    assert.equal(closeCode, 1013);
    assert.equal(record.length, 1, '被拒绝的连接不应创建会话');

    // 第一个连接关闭后，槽位释放
    const firstClosed = new Promise((resolve) => first.socket.addEventListener('close', resolve, { once: true }));
    first.socket.close();
    await firstClosed;
    await waitFor(() => record[0].closed === true, 4000, 'first session closed');
  } finally {
    try {
      second?.socket?.close();
    } catch {
      /* ignore */
    }
    try {
      first?.socket?.close();
    } catch {
      /* ignore */
    }
    await srv.close();
  }
});

test('server.maxSessions：从 config.server.maxSessions 读取并出现在 /health 与 /api/config', async () => {
  const srv = await startTestServer({
    port: 0,
    config: testConfig({ server: { maxSessions: 2 } }),
    log: () => {},
    sessionFactory: createFakeSessionFactory([]),
  });
  try {
    assert.equal(srv.maxSessions, 2);
    const health = await (await fetch(`${srv.url}/health`)).json();
    assert.equal(health.sessions.max, 2);
    const payload = await (await fetch(`${srv.url}/api/config`)).json();
    assert.equal(payload.config.runtime.maxSessions, 2);
  } finally {
    await srv.close();
  }
});

test('/health：whisper-server 运行状态（尽力而为）与优雅关闭幂等', async () => {
  const srv = await startTestServer({
    port: 0,
    config: testConfig(),
    log: () => {},
    sessionFactory: createFakeSessionFactory([]),
    voiceLister: async () => [],
  });
  const health = await (await fetch(`${srv.url}/health`)).json();
  assert.equal(typeof health.whisper.server, 'object');
  assert.equal(typeof health.whisper.server.running, 'boolean');
  assert.equal(health.whisper.server.host, '127.0.0.1');
  assert.equal(health.whisper.server.port, 18765);
  assert.equal(typeof health.whisper.running, 'boolean');
  assert.equal(health.sessions.max, 4);
  await srv.close();
  await srv.close(); // 幂等：SIGINT/SIGTERM 可能被重复触发
  await assert.rejects(fetch(`${srv.url}/health`), '关闭后 HTTP 端口应已释放');
});

test('导出事件 JSONL：meta 首行 + 逐行事件 + 可被回放解析（无内部 atMs 字段）', () => {
  const events = [
    { type: 'ready', sessionId: 's_test', protocol: 1 },
    { type: 'status', state: 'listening', tsMs: 0 },
    { type: 'segment', id: 1, t0Ms: 0, t1Ms: 1200, text: 'Hello world.', lang: 'en' },
    { type: 'translation', id: 1, text: '你好，世界。', final: true },
    { type: 'dub', id: 1, seq: 0, startMs: 1400, sampleRate: 24000, format: 's16le', pcm: 'AAAA', durationMs: 10, voiceId: 'v1', final: true },
  ];
  const meta = { title: '单元测试会话', video: '/demo/original.mp4', langFrom: 'en', langTo: 'zh', durationMs: 12000 };
  const jsonl = buildEventJsonl(events, { meta });
  const lines = jsonl.trim().split('\n');
  assert.equal(lines.length, events.length + 1);
  assert.equal(JSON.parse(lines[0]).type, 'meta');
  assert.equal(JSON.parse(lines[0]).title, '单元测试会话');
  assert.ok(jsonl.endsWith('\n'), 'JSONL 应以换行结尾');

  const parsed = parseSessionJsonl(jsonl);
  assert.equal(parsed.meta.title, '单元测试会话');
  assert.equal(parsed.meta.video, '/demo/original.mp4');
  assert.equal(parsed.events.length, events.length);
  assert.equal(parsed.segments.size, 1);
  assert.equal(parsed.segments.get('1').translation, '你好，世界。');
  assert.equal(parsed.dubs.length, 1);
  assert.ok(!jsonl.includes('"atMs"'), '导出不应包含内部字段 atMs');
  assert.ok(!jsonl.includes('"inferred"'));

  // 带标注时间的事件也应剔除内部字段
  const annotated = buildEventJsonl([{ type: 'status', state: 'listening', atMs: 100, inferred: true }]);
  assert.ok(!annotated.includes('atMs'));
  assert.ok(!annotated.includes('inferred'));

  // 空输入
  assert.equal(buildEventJsonl([], { meta: null }), '');
  assert.equal(buildEventJsonl(null), '');
});

test('UI 纯函数：主题/字幕样式/快捷键/sparkline', () => {
  // 主题
  assert.equal(normalizeTheme('light'), 'light');
  assert.equal(normalizeTheme('LIGHT'), 'light');
  assert.equal(normalizeTheme('dark'), 'dark');
  assert.equal(normalizeTheme('neon'), 'dark');
  assert.equal(normalizeTheme(null), 'dark');
  assert.equal(normalizeTheme('neon', 'light'), 'light');

  // 字幕样式预设
  assert.deepEqual(normalizeSubsStyle({ size: 'xl', opacity: 5, position: 'top' }), { size: 'xl', opacity: 1, position: 'top' });
  const fallbackStyle = normalizeSubsStyle({ size: 'huge', opacity: -1, position: 'left' });
  assert.deepEqual(fallbackStyle, { size: 'm', opacity: 0.15, position: 'bottom' });
  assert.deepEqual(normalizeSubsStyle(null), { size: 'm', opacity: 0.72, position: 'bottom' });

  // 快捷键
  const base = { preventDefault: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false, code: 'Space', key: ' ' };
  assert.equal(resolveShortcut(base), 'toggle-play');
  assert.equal(resolveShortcut({ ...base, code: 'KeyS', key: 's' }), 'toggle-subs');
  assert.equal(resolveShortcut({ ...base, code: 'KeyD', key: 'd' }), 'toggle-dub');
  assert.equal(resolveShortcut({ ...base, code: 'Escape', key: 'Escape' }), 'escape');
  assert.equal(resolveShortcut({ ...base, code: 'KeyX', key: 'x' }), null);
  assert.equal(resolveShortcut(base, { editable: true }), null);
  assert.equal(resolveShortcut({ ...base, ctrlKey: true }), null);
  assert.equal(resolveShortcut({ ...base, metaKey: true }), null);
  assert.equal(resolveShortcut({ ...base, repeat: true }), null);
  assert.equal(resolveShortcut({ ...base, defaultPrevented: true }), null);
  assert.equal(resolveShortcut(null), null);

  // 是否可编辑元素
  assert.equal(isEditableTarget({ tagName: 'INPUT' }), true);
  assert.equal(isEditableTarget({ tagName: 'textarea' }), true);
  assert.equal(isEditableTarget({ tagName: 'SELECT' }), true);
  assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isEditableTarget({ tagName: 'DIV' }), false);
  assert.equal(isEditableTarget(null), false);

  // sparkline
  const spark = buildSparkline([100, 200, 300], { width: 100, height: 50, pad: 5 });
  assert.equal(spark.count, 3);
  assert.equal(spark.min, 100);
  assert.equal(spark.max, 300);
  assert.equal(spark.last, 300);
  assert.equal(spark.points.split(' ').length, 3);
  const empty = buildSparkline([]);
  assert.deepEqual(empty, { points: '', min: 0, max: 0, last: null, count: 0 });
  assert.equal(buildSparkline([100, Number.NaN, -5, 'x', 200]).count, 2);
  assert.equal(buildSparkline([42]).count, 1);
});

// ================================================ v0.3 UI 设置 / 桌面 App

test('GET/PUT /api/settings：默认值、白名单校验 400、持久化、/api/config 合并与 /health asrEngine', async () => {
  const dataDir = makeTempDir('livedub-settings-');
  const srv = await startTestServer({ config: testConfig(), dataDir });
  try {
    // GET 默认值（来自 config，未持久化）
    let res = await fetch(`${srv.url}/api/settings`);
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.fileExists, false);
    assert.deepEqual(body.overrides, {});
    assert.equal(body.settings.asr.provider, 'mock');
    assert.equal(body.settings.tts.voiceMode, 'preset');
    assert.equal(body.settings.dub.enabled, true);
    assert.equal(typeof body.path, 'string');
    assert.equal(body.asrEngine.cloud, false);

    // PUT 白名单字段
    res = await fetch(`${srv.url}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: { asr: { provider: 'minimax-cloud' }, tts: { voiceMode: 'clone-first' }, dub: { enabled: false } },
      }),
    });
    assert.equal(res.status, 200);
    body = await res.json();
    assert.equal(body.saved, true);
    assert.equal(body.nextSessionOnly, true);
    assert.equal(body.fileExists, true);
    assert.equal(typeof body.updatedAt, 'string');
    assert.equal(body.settings.asr.provider, 'minimax-cloud');
    assert.equal(body.overrides.tts.voiceMode, 'clone-first');
    assert.equal(body.asrEngine.provider, 'minimax-cloud');
    assert.equal(body.asrEngine.cloud, true);
    assert.equal(body.asrEngine.privacy, 'cloud');

    // 落盘文件只含白名单字段，不含任何密钥
    const settingsFile = path.join(dataDir, 'ui-settings.json');
    assert.ok(fs.existsSync(settingsFile), '应持久化到 data/ui-settings.json');
    const raw = fs.readFileSync(settingsFile, 'utf8');
    assert.ok(!raw.includes('apiKey'));
    assert.ok(!raw.includes('secret'));
    const saved = JSON.parse(raw);
    assert.equal(saved.version, 1);
    assert.equal(saved.settings.asr.provider, 'minimax-cloud');
    assert.equal(saved.settings.dub.enabled, false);

    // /api/config 合并 UI 设置（脱敏后）
    const configBody = await (await fetch(`${srv.url}/api/config`)).json();
    assert.equal(configBody.config.asr.provider, 'minimax-cloud');
    assert.equal(configBody.config.tts.voiceMode, 'clone-first');
    assert.equal(configBody.config.dub.enabled, false);
    assert.equal(configBody.config.runtime.uiSettings.overrides.asr.provider, 'minimax-cloud');
    assert.equal(configBody.config.runtime.uiSettings.effective.dub.enabled, false);
    assert.equal(typeof configBody.config.runtime.asrEngine, 'object');
    assert.equal(typeof configBody.config.runtime.desktopApp, 'object');
    assert.ok(!JSON.stringify(configBody).includes('apiKey'));

    // /health：生效 ASR 引擎 + 隐私信息
    const health = await (await fetch(`${srv.url}/health`)).json();
    assert.equal(health.providers.asr, 'minimax-cloud');
    assert.equal(health.asrEngine.provider, 'minimax-cloud');
    assert.equal(health.asrEngine.cloud, true);
    assert.match(health.asrEngine.privacyTitle, /MiniMax/);
    assert.equal(health.uiSettings.overridden, true);
    assert.equal(health.features.dubEnabled, false);

    // 非法值 / 非白名单字段 -> 400
    const invalidPayloads = [
      { asr: { provider: 'cloud-magic' } },
      { tts: { voiceMode: 'clone' } },
      { dub: { enabled: 'yes' } },
      { asr: { provider: 'whisper-local', extra: 1 } },
      { secret: 'should-not-persist' },
      { settings: { asr: { provider: 'nope' } } },
      { settings: {} },
    ];
    for (const payload of invalidPayloads) {
      const response = await fetch(`${srv.url}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 400, `payload ${JSON.stringify(payload)} 应返回 400`);
      const error = await response.json();
      assert.equal(error.ok, false);
      assert.equal(typeof error.error, 'string');
      assert.equal(typeof error.message, 'string');
    }
    // 非法 JSON -> 400
    const badJson = await fetch(`${srv.url}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    assert.equal(badJson.status, 400);
    // 非 PUT 之外的方法 -> 405 + Allow
    const post = await fetch(`${srv.url}/api/settings`, { method: 'POST', body: '{}' });
    assert.equal(post.status, 405);
    assert.match(String(post.headers.get('allow')), /PUT/);
  } finally {
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('/api/settings：重启后读取持久化设置；脏文件回退默认并给 warning', async () => {
  const dataDir = makeTempDir('livedub-settings-persist-');
  let srv = await startTestServer({ config: testConfig(), dataDir });
  try {
    await fetch(`${srv.url}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asr: { provider: 'minimax-cloud' } }),
    });
    await srv.close();

    srv = await startTestServer({ config: testConfig(), dataDir });
    const body = await (await fetch(`${srv.url}/api/settings`)).json();
    assert.equal(body.overrides.asr.provider, 'minimax-cloud');
    assert.equal(body.settings.asr.provider, 'minimax-cloud');
    assert.equal(body.fileExists, true);
    const health = await (await fetch(`${srv.url}/health`)).json();
    assert.equal(health.asrEngine.provider, 'minimax-cloud');
    assert.equal(health.asrEngine.overridden, true);
    await srv.close();

    // 脏 JSON：服务仍能启动，回退 config 默认值并返回 warning
    fs.writeFileSync(path.join(dataDir, 'ui-settings.json'), '{ this is not json');
    srv = await startTestServer({ config: testConfig(), dataDir });
    const fallback = await (await fetch(`${srv.url}/api/settings`)).json();
    assert.equal(fallback.fileExists, true);
    assert.deepEqual(fallback.overrides, {});
    assert.equal(fallback.settings.asr.provider, 'mock', '脏文件应回退 config 默认值');
    assert.ok(Array.isArray(fallback.warnings) && fallback.warnings.length > 0);
  } finally {
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('/health 与 /api/config：desktopApp 检测（不存在 -> 构建命令；存在 -> 启动命令）', async () => {
  const dataDir = makeTempDir('livedub-desktop-');
  const appPath = path.join(dataDir, 'build', 'livedub.app');
  const srv = await startTestServer({ config: testConfig(), dataDir, desktopAppPath: appPath });
  try {
    let health = await (await fetch(`${srv.url}/health`)).json();
    assert.equal(health.desktopApp.available, false);
    assert.equal(health.desktopApp.buildCommand, 'bash scripts/build-macos.sh');
    assert.equal(typeof health.desktopApp.buildScriptFound, 'boolean');
    assert.equal(typeof health.desktopApp.openCommand, 'string');
    assert.equal(typeof health.desktopApp.hint, 'string');
    assert.equal(health.desktopApp.platform, process.platform);

    // 构建产物出现后，无需重启服务即可检测到
    fs.mkdirSync(appPath, { recursive: true });
    health = await (await fetch(`${srv.url}/health`)).json();
    assert.equal(health.desktopApp.available, true);
    assert.match(health.desktopApp.openCommand, /^open /);

    const configBody = await (await fetch(`${srv.url}/api/config`)).json();
    assert.equal(configBody.config.runtime.desktopApp.available, true);
  } finally {
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('UI 设置注入下一次会话 overrides：asr/tts/dub 生效，客户端 hello.overrides 优先', async () => {
  const dataDir = makeTempDir('livedub-settings-session-');
  const record = [];
  const srv = await startTestServer({ config: testConfig(), dataDir, sessionFactory: createFakeSessionFactory(record) });
  try {
    const put = await fetch(`${srv.url}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asr: { provider: 'minimax-cloud' }, tts: { voiceMode: 'preset' }, dub: { enabled: false } }),
    });
    assert.equal(put.status, 200);

    const first = await openWs(`${srv.url.replace('http://', 'ws://')}/ws`);
    first.socket.send(JSON.stringify({ type: 'hello', protocol: 1, session: { source: 'test' } }));
    await waitForEvent(first.events, (event) => event.type === 'ready', 4000, 'ready');
    await waitFor(() => record.length >= 1, 4000, '会话创建');
    const overrides = record[0].options.overrides ?? {};
    assert.equal(overrides.asr?.provider, 'minimax-cloud');
    assert.equal(overrides.tts?.voiceMode, 'preset');
    assert.equal(overrides.dub?.enabled, false);
    first.socket.close();

    // 客户端 hello.overrides 优先级更高（例如临时切克隆音色）
    const second = await openWs(`${srv.url.replace('http://', 'ws://')}/ws`);
    second.socket.send(
      JSON.stringify({ type: 'hello', protocol: 1, session: { source: 'test', overrides: { tts: { voiceMode: 'clone-first' } } } }),
    );
    await waitForEvent(second.events, (event) => event.type === 'ready', 4000, 'ready2');
    await waitFor(() => record.length >= 2, 4000, '第二个会话');
    const secondOverrides = record[1].options.overrides ?? {};
    assert.equal(secondOverrides.asr?.provider, 'minimax-cloud', 'UI 设置的 asr 仍生效');
    assert.equal(secondOverrides.tts?.voiceMode, 'clone-first', '客户端 hello.overrides 应覆盖 UI 设置');
    second.socket.close();
  } finally {
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('UI 纯函数（v0.3）：ASR 标签/隐私文案/桌面 App 引导/设置补丁', () => {
  assert.equal(ASR_ENGINE_OPTIONS.length, 2);
  assert.deepEqual(
    ASR_ENGINE_OPTIONS.map((engine) => engine.id),
    ['whisper-local', 'minimax-cloud'],
  );

  assert.equal(normalizeAsrEngine('minimax-cloud'), 'minimax-cloud');
  assert.equal(normalizeAsrEngine('weird-provider'), 'whisper-local');
  assert.equal(normalizeAsrEngine(null), 'whisper-local');
  assert.equal(normalizeAsrEngine(undefined, 'minimax-cloud'), 'minimax-cloud');

  assert.equal(asrEngineLabel('whisper-local'), '本地 whisper');
  assert.equal(asrEngineLabel('minimax-cloud'), '云端 MiniMax');
  assert.equal(asrEngineLabel('mock'), 'Mock（开发用）');
  assert.equal(asrEngineLabel('unknown-x'), 'unknown-x');

  const local = asrPrivacyCopy('whisper-local');
  assert.equal(local.cloud, false);
  assert.equal(local.tone, 'local');
  assert.match(local.title, /不离开本机/);
  const cloud = asrPrivacyCopy('minimax-cloud');
  assert.equal(cloud.cloud, true);
  assert.equal(cloud.tone, 'cloud');
  assert.match(cloud.title, /MiniMax/);
  assert.match(cloud.detail, /上传/);

  const missing = desktopAppInstructions({ available: false });
  assert.equal(missing.available, false);
  assert.equal(missing.badge, '未构建');
  assert.equal(missing.command, 'bash scripts/build-macos.sh');
  const ready = desktopAppInstructions({ available: true, appPath: 'apps/macos/build/livedub.app' });
  assert.equal(ready.available, true);
  assert.equal(ready.badge, '已构建');
  assert.match(ready.command, /^open /);
  assert.match(ready.command, /livedub\.app/);

  assert.deepEqual(buildSettingsPatch({ asrProvider: 'minimax-cloud' }), { asr: { provider: 'minimax-cloud' } });
  assert.deepEqual(buildSettingsPatch({ ttsVoiceMode: 'preset', dubEnabled: false }), {
    tts: { voiceMode: 'preset' },
    dub: { enabled: false },
  });
  assert.deepEqual(buildSettingsPatch({ asrProvider: 'bad-value' }), {});

  const merged = mergeSettingsSnapshot({
    settings: { asr: { provider: 'minimax-cloud' }, tts: { voiceMode: 'preset' }, dub: { enabled: false } },
    overrides: { asr: { provider: 'minimax-cloud' } },
    updatedAt: '2026-01-01T00:00:00.000Z',
    fileExists: true,
  });
  assert.equal(merged.asrProvider, 'minimax-cloud');
  assert.equal(merged.ttsVoiceMode, 'preset');
  assert.equal(merged.dubEnabled, false);
  assert.equal(merged.fileExists, true);
  const fallback = mergeSettingsSnapshot({}, 'minimax-cloud');
  assert.equal(fallback.asrProvider, 'minimax-cloud');
  assert.equal(fallback.dubEnabled, true);
});


// ================================================== v0.4 共享 Notes API

const NOTES_VIDEO = {
  id: 'local-demo-abc123',
  title: 'Gradient Descent Demo',
  url: 'http://127.0.0.1:8787/demo/original.mp4',
  durationMs: 52700,
};

/** 最小合法 PNG 头（服务端只校验 PNG 签名） */
function tinyPng(extra = 'payload') {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(extra)]);
}

async function notesApi(srv, method, pathname, body, headers = {}) {
  const isRaw = Buffer.isBuffer(body);
  const response = await fetch(`${srv.url}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined && body !== null ? { 'Content-Type': isRaw ? headers['Content-Type'] ?? 'application/octet-stream' : 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined || body === null ? undefined : isRaw ? body : JSON.stringify(body),
  });
  const contentType = String(response.headers.get('content-type') ?? '');
  const data = contentType.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, data };
}

test('Notes API：CRUD / 列表搜索 / 持久化 / 校验 / 405', async () => {
  const dataDir = makeTempDir('livedub-notes-crud-');
  let srv = await startTestServer({ config: testConfig(), dataDir });
  try {
    const createPayload = {
      video: NOTES_VIDEO,
      tMs: 20000,
      body: '# 梯度下降\n\n- 反方向走一小步',
      quotes: [{ t0Ms: 18000, t1Ms: 20000, src: 'We repeat this process.', dst: '我们重复这个过程。' }],
      tags: ['gradient', 'gd'],
      kind: 'note',
      source: 'studio',
    };
    let result = await notesApi(srv, 'POST', '/api/notes', createPayload);
    assert.equal(result.status, 200);
    assert.equal(result.data.ok, true);
    const note = result.data.note;
    assert.match(note.id, /^[A-Za-z0-9._-]+$/);
    assert.equal(note.video.id, NOTES_VIDEO.id);
    assert.equal(note.video.title, NOTES_VIDEO.title);
    assert.equal(note.tMs, 20000);
    assert.equal(note.body, createPayload.body);
    assert.equal(note.kind, 'note');
    assert.equal(note.source, 'studio');
    assert.equal(note.quotes.length, 1);
    assert.deepEqual(note.tags, ['gradient', 'gd']);
    assert.equal(typeof note.createdAt, 'string');
    assert.equal(typeof note.updatedAt, 'string');

    result = await notesApi(srv, 'GET', `/api/notes?videoId=${encodeURIComponent(NOTES_VIDEO.id)}`);
    assert.equal(result.status, 200);
    assert.equal(result.data.notes.length, 1);
    assert.equal(result.data.videos.length, 1);
    assert.equal(result.data.videos[0].video.id, NOTES_VIDEO.id);
    assert.equal(result.data.videos[0].count, 1);
    assert.equal(typeof result.data.videos[0].updatedAt, 'string');

    // 搜索 body / quotes / tags
    for (const [query, expected] of [
      ['梯度下降', 1],
      ['重复这个过程', 1],
      ['gradient', 1],
      ['not-found-xyz', 0],
    ]) {
      const searched = await notesApi(srv, 'GET', `/api/notes?videoId=${encodeURIComponent(NOTES_VIDEO.id)}&q=${encodeURIComponent(query)}`);
      assert.equal(searched.data.notes.length, expected, `q=${query}`);
    }

    // PUT 部分更新
    result = await notesApi(srv, 'PUT', `/api/notes/${note.id}`, { body: '# 更新后的笔记', tMs: 21000, tags: ['updated'] });
    assert.equal(result.status, 200);
    assert.equal(result.data.note.body, '# 更新后的笔记');
    assert.equal(result.data.note.tMs, 21000);
    assert.deepEqual(result.data.note.tags, ['updated']);
    assert.ok(result.data.note.updatedAt >= note.updatedAt);

    // 第二条笔记 + limit
    result = await notesApi(srv, 'POST', '/api/notes', { video: NOTES_VIDEO, tMs: 5000, body: 'second note' });
    assert.equal(result.status, 200);
    assert.notEqual(result.data.note.id, note.id);
    const limited = await notesApi(srv, 'GET', `/api/notes?videoId=${encodeURIComponent(NOTES_VIDEO.id)}&limit=1`);
    assert.equal(limited.data.notes.length, 1);
    assert.equal(limited.data.total, 2);
    const allVideos = await notesApi(srv, 'GET', '/api/notes');
    assert.equal(allVideos.data.notes.length, 2);
    assert.equal(allVideos.data.videos[0].count, 2);

    // 落盘：data/notes/<slug>.json，文件名安全
    const notesDir = path.join(dataDir, 'notes');
    const files = fs.readdirSync(notesDir).filter((file) => file.endsWith('.json'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^[A-Za-z0-9._-]+\.json$/);
    const store = JSON.parse(fs.readFileSync(path.join(notesDir, files[0]), 'utf8'));
    assert.equal(store.notes.length, 2);
    assert.equal(store.video.id, NOTES_VIDEO.id);

    // 校验：非法字段/值 400
    const invalidPayloads = [
      { video: NOTES_VIDEO, secret: 'leak' },
      { video: { id: '' }, body: 'x' },
      { video: NOTES_VIDEO, body: 'x'.repeat(200 * 1024 + 1) },
      { video: NOTES_VIDEO, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) },
      { video: NOTES_VIDEO, tags: ['x'.repeat(41)] },
      { video: NOTES_VIDEO, kind: 'evil' },
      { video: NOTES_VIDEO, source: 'browser' },
      { video: NOTES_VIDEO, tMs: -1 },
      { video: NOTES_VIDEO, imageUrl: '../evil.png' },
      { video: NOTES_VIDEO, quotes: 'nope' },
    ];
    for (const payload of invalidPayloads) {
      result = await notesApi(srv, 'POST', '/api/notes', payload);
      assert.equal(result.status, 400, `payload ${JSON.stringify(payload).slice(0, 80)} 应 400`);
      assert.equal(result.data.ok, false);
      assert.equal(typeof result.data.error, 'string');
    }
    result = await notesApi(srv, 'PUT', `/api/notes/${note.id}`, { video: NOTES_VIDEO });
    assert.equal(result.status, 400);
    result = await notesApi(srv, 'PUT', '/api/notes/..%2Fevil', { body: 'x' });
    assert.equal(result.status, 400);
    result = await notesApi(srv, 'PUT', '/api/notes/n_does_not_exist', { body: 'x' });
    assert.equal(result.status, 404);
    result = await notesApi(srv, 'DELETE', '/api/notes/n_does_not_exist');
    assert.equal(result.status, 404);
    // 方法限制
    result = await notesApi(srv, 'POST', '/api/notes/some-id', {});
    assert.equal(result.status, 405);
    result = await notesApi(srv, 'GET', '/api/notes/quick');
    assert.equal(result.status, 405);
    result = await notesApi(srv, 'DELETE', '/api/notes');
    assert.equal(result.status, 405);

    // 删除
    result = await notesApi(srv, 'DELETE', `/api/notes/${note.id}`);
    assert.equal(result.status, 200);
    assert.equal(result.data.deleted, true);
    result = await notesApi(srv, 'DELETE', `/api/notes/${note.id}`);
    assert.equal(result.status, 404);

    // 重启后仍能读取持久化笔记
    await srv.close();
    srv = await startTestServer({ config: testConfig(), dataDir });
    const afterRestart = await notesApi(srv, 'GET', `/api/notes?videoId=${encodeURIComponent(NOTES_VIDEO.id)}`);
    assert.equal(afterRestart.data.notes.length, 1);
    assert.equal(afterRestart.data.notes[0].body, 'second note');
  } finally {
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Notes API：quick 追加 / PNG assets / export.md / export 写文件 / health 统计', async () => {
  const dataDir = makeTempDir('livedub-notes-export-');
  const srv = await startTestServer({ config: testConfig(), dataDir });
  try {
    await notesApi(srv, 'POST', '/api/notes', {
      video: NOTES_VIDEO,
      tMs: 20000,
      body: '笔记正文',
      quotes: [{ src: 'English quote', dst: '中文引用' }],
      tags: ['demo'],
    });
    // quick 追加两次
    const quick1 = await notesApi(srv, 'POST', '/api/notes/quick', {
      video: NOTES_VIDEO,
      tMs: 30000,
      text: '快速摘录第一条',
      source: 'extension',
      tags: ['quick'],
    });
    assert.equal(quick1.status, 200);
    assert.match(quick1.data.path, /quick-\d{4}-\d{2}-\d{2}\.md$/);
    assert.match(quick1.data.markdown, /快速摘录第一条/);
    assert.ok(quick1.data.note, 'quick 响应应包含 note');
    assert.equal(quick1.data.note.kind, 'quick');
    assert.equal(quick1.data.note.source, 'extension');
    assert.equal(quick1.data.note.body, '快速摘录第一条');
    assert.equal(quick1.data.note.tMs, 30000);
    assert.equal(quick1.data.note.video.id, NOTES_VIDEO.id);
    const quickFile = path.join(dataDir, 'notes', path.basename(quick1.data.path));
    assert.ok(fs.existsSync(quickFile));
    const quick2 = await notesApi(srv, 'POST', '/api/notes/quick', {
      video: NOTES_VIDEO,
      tMs: 40000,
      text: '快速摘录第二条',
      source: 'macos',
      quotes: [{ src: 'quote en', dst: '引文' }],
    });
    assert.equal(quick2.status, 200);
    assert.equal(quick2.data.path, quick1.data.path, '同一天追加到同一个 md');
    const quickContent = fs.readFileSync(quickFile, 'utf8');
    assert.ok(quickContent.includes('快速摘录第一条'));
    assert.ok(quickContent.includes('快速摘录第二条'));
    assert.ok(quickContent.includes('macos'));
    assert.ok(quickContent.includes('quote en'));
    assert.equal(quick2.data.note.source, 'macos');
    assert.deepEqual(quick2.data.note.quotes, [{ src: 'quote en', dst: '引文' }]);

    // quick 也进入 per-video 笔记库：工作台面板 / GET / export 都能看到
    const quickList = await notesApi(srv, 'GET', `/api/notes?videoId=${encodeURIComponent(NOTES_VIDEO.id)}&limit=500`);
    assert.equal(quickList.status, 200);
    assert.equal(quickList.data.notes.length, 3, '1 条普通笔记 + 2 条 quick');
    const quickNotes = quickList.data.notes.filter((note) => note.kind === 'quick');
    assert.equal(quickNotes.length, 2);
    assert.ok(quickNotes.some((note) => note.body === '快速摘录第一条'));
    assert.equal(quickList.data.videos.length, 1);
    assert.equal(quickList.data.videos[0].count, 3);
    assert.equal(quickList.data.videos[0].video.title, NOTES_VIDEO.title);
    assert.equal(quickList.data.videos[0].video.url, NOTES_VIDEO.url);
    assert.equal(quickList.data.videos[0].video.durationMs, NOTES_VIDEO.durationMs);

    // PNG 上传/读取
    const png = tinyPng('asset-content');
    let result = await notesApi(srv, 'POST', '/api/notes/assets', png, { 'Content-Type': 'image/png' });
    assert.equal(result.status, 200);
    assert.match(result.data.url, /^\/api\/notes\/assets\/[A-Za-z0-9._-]+\.png$/);
    const assetFile = path.join(dataDir, 'notes', 'assets', result.data.url.split('/').pop());
    assert.ok(fs.existsSync(assetFile));
    assert.deepEqual(fs.readFileSync(assetFile), png);
    result = await notesApi(srv, 'GET', result.data.url);
    assert.equal(result.status, 200);
    assert.match(String(result.headers.get('content-type')), /image\/png/);
    assert.deepEqual(result.data, png);

    // assets 安全/校验
    result = await notesApi(srv, 'POST', '/api/notes/assets', Buffer.from('not png'), { 'Content-Type': 'image/png' });
    assert.equal(result.status, 400);
    result = await notesApi(srv, 'POST', '/api/notes/assets', png, { 'Content-Type': 'text/plain' });
    assert.equal(result.status, 415);
    result = await notesApi(srv, 'POST', '/api/notes/assets', Buffer.alloc(4 * 1024 * 1024 + 16, 0x41), { 'Content-Type': 'image/png' });
    assert.equal(result.status, 413);
    result = await notesApi(srv, 'GET', '/api/notes/assets/..%2F..%2Fdata%2Fui-settings.json');
    assert.equal(result.status, 403);
    result = await notesApi(srv, 'GET', '/api/notes/assets/nope.png');
    assert.equal(result.status, 404);

    // export.md
    result = await notesApi(srv, 'GET', `/api/notes/export.md?videoId=${encodeURIComponent(NOTES_VIDEO.id)}`);
    assert.equal(result.status, 200);
    assert.match(String(result.headers.get('content-type')), /text\/markdown/);
    assert.match(String(result.headers.get('content-disposition')), /attachment/);
    const markdown = result.data.toString('utf8');
    assert.match(markdown, /^---\n/);
    assert.ok(markdown.includes(NOTES_VIDEO.title));
    assert.ok(markdown.includes('[00:00:20](?t=20000)'));
    assert.ok(markdown.includes('English quote'));
    assert.ok(markdown.includes('中文引用'));
    assert.ok(markdown.includes('标签：demo'));
    assert.ok(markdown.includes('快速摘录第一条'), '导出应包含 quick 笔记');
    assert.ok(markdown.includes('快速摘录第二条'));
    result = await notesApi(srv, 'GET', '/api/notes/export.md');
    assert.equal(result.status, 400);

    // export 写 data/exports
    result = await notesApi(srv, 'POST', '/api/notes/export', { videoId: NOTES_VIDEO.id });
    assert.equal(result.status, 200);
    assert.match(result.data.path, /(?:^data\/exports\/|[\\/]exports\/)[A-Za-z0-9._-]+-\d{4}-\d{2}-\d{2}\.md$/);
    const exported = path.isAbsolute(result.data.path) ? result.data.path : path.join(PROJECT_ROOT, result.data.path);
    assert.ok(fs.existsSync(exported));
    assert.ok(fs.readFileSync(exported, 'utf8').includes('笔记正文'));
    fs.rmSync(exported, { force: true });

    // /health 与 /api/config 的 notes 统计（不带内容）
    const health = await (await fetch(`${srv.url}/health`)).json();
    assert.equal(typeof health.notes, 'object');
    assert.equal(health.notes.count, 3, 'quick 也应计入笔记统计');
    assert.equal(health.notes.videos, 1);
    assert.match(String(health.notes.notesDir), /notes$/);
    assert.match(String(health.notes.exportsDir), /exports$/);
    assert.ok(!JSON.stringify(health.notes).includes('笔记正文'));
    const configBody = await (await fetch(`${srv.url}/api/config`)).json();
    assert.equal(configBody.config.runtime.notes.count, 3);
  } finally {
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Notes API：并发写串行化（不丢笔记/不损坏文件）', async () => {
  const dataDir = makeTempDir('livedub-notes-concurrent-');
  const srv = await startTestServer({ config: testConfig(), dataDir });
  try {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        notesApi(srv, 'POST', '/api/notes', { video: NOTES_VIDEO, tMs: index * 1000, body: `并发笔记 ${index}` }),
      ),
    );
    assert.deepEqual([...new Set(results.map((item) => item.status))], [200]);
    const ids = new Set(results.map((item) => item.data.note?.id));
    assert.equal(ids.size, 12);
    const list = await notesApi(srv, 'GET', `/api/notes?videoId=${encodeURIComponent(NOTES_VIDEO.id)}&limit=500`);
    assert.equal(list.data.notes.length, 12);

    // 并发 PUT 同一笔记：不损坏 JSON，最终 body 为其中一次写入
    const target = results[0].data.note.id;
    const patches = await Promise.all(
      Array.from({ length: 8 }, (_, index) => notesApi(srv, 'PUT', `/api/notes/${target}`, { body: `patch-${index}` })),
    );
    assert.deepEqual([...new Set(patches.map((item) => item.status))], [200]);
    const finalList = await notesApi(srv, 'GET', `/api/notes?videoId=${encodeURIComponent(NOTES_VIDEO.id)}&limit=500`);
    const targetNote = finalList.data.notes.find((note) => note.id === target);
    assert.match(targetNote.body, /^patch-[0-7]$/);
    const notesDir = path.join(dataDir, 'notes');
    for (const file of fs.readdirSync(notesDir).filter((name) => name.endsWith('.json'))) {
      JSON.parse(fs.readFileSync(path.join(notesDir, file), 'utf8')); // 能解析即未损坏
    }
  } finally {
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Notes 纯函数：视频身份 / Markdown 渲染 / 导出 / 大纲 / 时间戳 / 快捷键', () => {
  // 视频身份稳定
  const idA = makeVideoId({ name: 'lecture.mp4', size: 12345 });
  const idB = makeVideoId({ name: 'lecture.mp4', size: 12345 });
  assert.equal(idA, idB);
  assert.match(idA, /^local-[0-9a-f]{8}$/);
  assert.notEqual(idA, makeVideoId({ name: 'lecture.mp4', size: 54321 }));
  assert.match(makeVideoId({ url: 'https://example.com/a.mp4#t=100' }), /^url-[0-9a-f]{8}$/);
  assert.equal(makeVideoId({ url: 'https://example.com/a.mp4#t=100' }), makeVideoId({ url: 'https://example.com/a.mp4' }));
  assert.notEqual(makeVideoId({ url: 'https://example.com/a.mp4' }), makeVideoId({ url: 'https://example.com/b.mp4' }));
  assert.equal(videoTitleFrom({ name: 'demo.mp4' }), 'demo.mp4');
  assert.equal(videoTitleFrom({ url: 'https://example.com/x/lecture.mp4' }), 'lecture.mp4');
  assert.deepEqual(buildVideoRef({ id: 'local-1', title: 'T', url: 'https://e/x', durationMs: 1000 }), {
    id: 'local-1',
    title: 'T',
    url: 'https://e/x',
    durationMs: 1000,
  });
  assert.equal(fnv1aHex('livedub'), fnv1aHex('livedub'));
  assert.notEqual(fnv1aHex('a'), fnv1aHex('b'));

  // 时间戳
  assert.equal(formatNoteTimestamp(0), '00:00:00');
  assert.equal(formatNoteTimestamp(754000), '00:12:34');
  assert.equal(formatShortTimestamp(754000), '12:34');
  assert.equal(timestampAnchor(754000), '[00:12:34](?t=754000)');
  assert.equal(formatNoteTimestamp(-100), '00:00:00');

  // Markdown 渲染（安全转义 + 常见语法）
  const html = renderMarkdown('# 标题\n\n- a\n- b\n\n**粗体** 和 *斜体* 和 `code`\n\n[链接](https://example.com) ![图](/api/notes/assets/x.png)\n\n> 引用\n\n```js\nconst a = 1 < 2;\n```');
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<ul>\n<li>a<\/li>\n<li>b<\/li>\n<\/ul>/);
  assert.match(html, /<strong>粗体<\/strong>/);
  assert.match(html, /<em>斜体<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/example.com"/);
  assert.match(html, /<img src="\/api\/notes\/assets\/x.png"/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<pre><code class="language-js">const a = 1 &lt; 2;/);
  assert.match(renderMarkdown('<script>alert(1)</script>'), /&lt;script&gt;/);
  assert.doesNotMatch(renderMarkdown('<script>alert(1)</script>'), /<script>/);
  assert.doesNotMatch(renderMarkdown('[bad](javascript:alert(1))'), /href="javascript:/);
  assert.equal(renderMarkdown(''), '');

  // 插入/标签/搜索
  assert.deepEqual(insertAtCursor('abc', 'X', 1, 2), { value: 'a\nX\nc', selectionStart: 3, selectionEnd: 3 });
  assert.deepEqual(parseTags('a, b、c; a\n d'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(parseTags('x'.repeat(50)), ['x'.repeat(40)]);
  const notes = [
    { id: '1', tMs: 5000, body: 'alpha gradient', tags: ['ml'], quotes: [{ src: 'quote one' }] },
    { id: '2', tMs: 1000, body: 'beta', tags: [] },
    { id: '3', tMs: 1000, body: 'gamma', tags: ['opt'] },
  ];
  assert.deepEqual(sortNotesByTime(notes).map((note) => note.id), ['2', '3', '1']);
  assert.deepEqual(filterNotes(notes, 'gradient').map((note) => note.id), ['1']);
  assert.deepEqual(filterNotes(notes, 'quote').map((note) => note.id), ['1']);
  assert.deepEqual(filterNotes(notes, 'opt').map((note) => note.id), ['3']);
  assert.deepEqual(filterNotes(notes, '').length, 3);
  assert.match(noteExcerpt(notes[0]), /alpha gradient/);
  assert.equal(
    noteExcerpt({ body: '---\ntitle: "x"\nvideoId: "v"\n---\n\n# 大纲标题\n\n内容' }),
    '大纲标题 内容',
    '列表摘要应跳过 YAML front matter',
  );
  assert.equal(localNotesKey('v1'), 'livedub.notes.v1:v1');
  assert.deepEqual(makeQuote({ src: 'en', dst: '中', t0Ms: 10, t1Ms: 20 }), { t0Ms: 10, t1Ms: 20, src: 'en', dst: '中' });
  assert.equal(buildQuoteMarkdown({ src: 'en', dst: '中' }), '> 原文：en\n> 译文：中');

  // 导出 Markdown（YAML front matter + 时间戳 anchor + 截图/标签）
  const exported = buildNotesMarkdown({
    video: { id: 'local-1', title: 'Demo Talk', url: 'https://e/x', durationMs: 60000 },
    notes: [{ id: '1', tMs: 20000, body: '正文', tags: ['a'], imageUrl: '/api/notes/assets/x.png', quotes: [{ src: 'en', dst: '中' }] }],
    date: new Date('2026-01-02T00:00:00Z'),
  });
  assert.match(exported, /^---\n/);
  assert.match(exported, /title: "Demo Talk"/);
  assert.match(exported, /url: "https:\/\/e\/x"/);
  assert.match(exported, /date: 2026-01-02/);
  assert.match(exported, /\[00:00:20\]\(\?t=20000\)/);
  assert.match(exported, /!\[截图\]\(\/api\/notes\/assets\/x\.png\)/);
  assert.match(exported, /标签：a/);
  assert.equal(buildNoteExportFilename('Demo Talk / v1', new Date('2026-01-02T00:00:00Z')), 'Demo-Talk-v1-notes-2026-01-02.md');

  // 大纲
  const outline = buildOutlineMarkdown({
    video: { id: 'local-1', title: 'Demo', url: 'https://e/x' },
    segments: [
      { t0Ms: 61000, t1Ms: 62000, text: 'Second', translation: '第二' },
      { t0Ms: 0, t1Ms: 1000, text: 'First', translation: '第一' },
    ],
    date: new Date('2026-01-02T00:00:00Z'),
  });
  assert.match(outline, /# Demo · 课程大纲/);
  assert.match(outline, /## 1\. \[00:00:00\]\(\?t=0\)/);
  assert.match(outline, /## 2\. \[00:01:01\]\(\?t=61000\)/);
  assert.match(outline, /- 原文：First/);
  assert.match(outline, /- 译文：第一/);
  assert.ok(outline.indexOf('First') < outline.indexOf('Second'));

  // 快捷键
  assert.equal(resolveEditorShortcut({ ctrlKey: true, key: 'Enter', code: 'Enter' }), 'save');
  assert.equal(resolveEditorShortcut({ metaKey: true, key: 'Enter', code: 'Enter' }), 'save');
  assert.equal(resolveEditorShortcut({ ctrlKey: true, shiftKey: true, key: 'C', code: 'KeyC' }), 'codeblock');
  assert.equal(resolveEditorShortcut({ key: 'Enter', code: 'Enter' }), null);
  assert.equal(resolveShortcut({ preventDefault: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false, code: 'KeyN', key: 'n' }), 'new-note');
  assert.equal(resolveShortcut({ code: 'KeyN', key: 'n' }, { editable: true }), null);
});


test('Notes API：quick -> 笔记库 -> GET -> export 链路（扩展/CLI 快捷笔记可见）', async () => {
  const dataDir = makeTempDir('livedub-notes-quick-chain-');
  const srv = await startTestServer({ config: testConfig(), dataDir });
  try {
    const video = {
      id: 'local-quick-chain',
      title: 'Quick Capture Lecture',
      url: 'https://example.com/lecture.mp4',
      durationMs: 120000,
    };
    // 先按扩展流程上传截图，再带 imageUrl quick
    const png = tinyPng('quick-shot');
    const asset = await notesApi(srv, 'POST', '/api/notes/assets', png, { 'Content-Type': 'image/png' });
    assert.equal(asset.status, 200);
    const quick = await notesApi(srv, 'POST', '/api/notes/quick', {
      video,
      tMs: 65000,
      text: '扩展快捷笔记：这段讲学习率',
      quotes: [{ t0Ms: 63000, t1Ms: 65000, src: 'The learning rate controls the step size.', dst: '学习率控制步长。' }],
      source: 'extension',
      tags: ['extension', 'quick'],
      imageUrl: asset.data.url,
    });
    assert.equal(quick.status, 200);
    assert.ok(quick.data.note?.id);
    assert.equal(quick.data.note.kind, 'quick');
    assert.equal(quick.data.note.source, 'extension');
    assert.equal(quick.data.note.body, '扩展快捷笔记：这段讲学习率');
    assert.equal(quick.data.note.imageUrl, asset.data.url);
    assert.equal(quick.data.note.tMs, 65000);
    assert.equal(quick.data.note.video.title, video.title);
    assert.equal(quick.data.note.video.url, video.url);
    assert.equal(quick.data.note.video.durationMs, video.durationMs);

    // GET /api/notes?videoId= 能看到 quick 笔记 + video 元信息
    const list = await notesApi(srv, 'GET', `/api/notes?videoId=${encodeURIComponent(video.id)}`);
    assert.equal(list.status, 200);
    assert.equal(list.data.notes.length, 1);
    assert.equal(list.data.notes[0].kind, 'quick');
    assert.equal(list.data.videos.length, 1);
    assert.equal(list.data.videos[0].video.title, video.title);
    assert.equal(list.data.videos[0].video.url, video.url);
    assert.equal(list.data.videos[0].video.durationMs, video.durationMs);
    assert.equal(list.data.videos[0].count, 1);

    // 导出能看到 quick
    const exported = await notesApi(srv, 'GET', `/api/notes/export.md?videoId=${encodeURIComponent(video.id)}`);
    assert.equal(exported.status, 200);
    const markdown = exported.data.toString('utf8');
    assert.ok(markdown.includes('扩展快捷笔记：这段讲学习率'));
    assert.ok(markdown.includes('The learning rate controls the step size.'));
    assert.ok(markdown.includes(asset.data.url));

    // health / config 统计包含 quick
    const health = await (await fetch(`${srv.url}/health`)).json();
    assert.equal(health.notes.count, 1);
    assert.equal(health.notes.videos, 1);

    // 同一个 quick 同时写入每日 markdown
    const quickPath = path.isAbsolute(quick.data.path) ? quick.data.path : path.join(PROJECT_ROOT, quick.data.path);
    assert.ok(fs.existsSync(quickPath));
    assert.ok(fs.readFileSync(quickPath, 'utf8').includes('扩展快捷笔记'));

    // PUT 可以更新 quick 笔记（工作台编辑历史快捷笔记）
    const updated = await notesApi(srv, 'PUT', `/api/notes/${quick.data.note.id}`, { body: '更新后的 quick 笔记' });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.note.kind, 'quick');
    const afterUpdate = await notesApi(srv, 'GET', `/api/notes?videoId=${encodeURIComponent(video.id)}`);
    assert.equal(afterUpdate.data.notes[0].body, '更新后的 quick 笔记');
  } finally {
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
