/**
 * livedub Chrome 扩展（T5）自动化测试。
 *
 * 说明：真实的 tabCapture 需要用户手势 + 真实视频播放，无法在无头/CI 自动化，
 * 因此本文件覆盖：
 *  1. manifest.json 校验（MV3 / 权限 / content script / action / service worker / 无远程代码）；
 *  2. 扩展所有 JS 的 node --check 语法检查 + 静态实现断言（关键 API 调用位置）；
 *  3. extension/lib/pcm.js 纯函数单测，以及与 engine/protocol.mjs 的字节级协议一致性；
 *  4. extension/lib/constants.js 的地址规范化 / 默认值 / 消息类型；
 *  5. content script / background / offscreen / popup 之间的消息字符串一致性。
 *
 * 运行：node --test tests/extension.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  AUDIO_FRAME_HEADER_BYTES,
  AUDIO_FRAME_TAG,
  MAX_AUDIO_FRAME_BYTES,
  PROTOCOL_VERSION,
  base64ToBytes,
  base64ToFloat32,
  base64ToInt16,
  buildAudioFrame,
  buildHelloMessage,
  bytesToBase64,
  computeDubPlayhead,
  createDuckStateMachine,
  decodeAudioFrame,
  downsample48kTo16k,
  encodeAudioFrame,
  float32ToInt16,
  formatLatency,
  formatStateLabel,
  int16FromS16le,
  int16ToFloat32,
  pickLatencyMs,
  resampleLinear,
  s16leFromInt16,
  sanitizeEventText,
  wrapSubtitleLines,
} from '../extension/lib/pcm.js';
import {
  DEFAULT_ENGINE_URL,
  DEFAULT_SETTINGS,
  MSG,
  OFFSCREEN_DOCUMENT_URL,
  OFFSCREEN_REASONS,
  STORAGE_KEYS,
  deriveStudioUrl,
  isCapturablePage,
  normalizeEngineUrl,
} from '../extension/lib/constants.js';
import {
  PROTOCOL_VERSION as ENGINE_PROTOCOL_VERSION,
  decodeAudioFrame as engineDecodeAudioFrame,
  encodeAudioFrame as engineEncodeAudioFrame,
  normalizeHello,
} from '../engine/protocol.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const EXT = join(ROOT, 'extension');

const readExt = (rel) => readFileSync(join(EXT, rel), 'utf8');
const readSource = (rel) => readExt(rel);
const manifest = JSON.parse(readExt('manifest.json'));

/** 递归列出扩展目录下所有文件（返回相对路径，使用 / 分隔） */
function walkExtension(dir = EXT, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkExtension(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

const ALL_EXTENSION_FILES = walkExtension();
const JS_FILES = ALL_EXTENSION_FILES.filter((file) => file.endsWith('.js'));
const CODE_FILES = ALL_EXTENSION_FILES.filter((file) => /\.(?:js|html|json)$/.test(file));

const source = {
  background: readSource('background.js'),
  offscreen: readSource('offscreen.js'),
  offscreenHtml: readSource('offscreen.html'),
  content: readSource('content.js'),
  popup: readSource('popup.js'),
  popupHtml: readSource('popup.html'),
  pcm: readSource('lib/pcm.js'),
  constants: readSource('lib/constants.js'),
  worklet: readSource('worklet/pcm-worklet.js'),
  readme: readSource('README.md'),
};

/** 把 Int16Array 转成 Buffer（供 engine/protocol.mjs 的 Buffer 接口使用） */
function toBuffer(int16) {
  return Buffer.from(int16.buffer.slice(int16.byteOffset, int16.byteOffset + int16.byteLength));
}

// ===========================================================================
// 1. manifest 校验
// ===========================================================================

test('manifest：合法的 MV3 清单，background 为 module service worker + action popup', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(typeof manifest.name, 'string');
  assert.ok(manifest.name.length > 0);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.background.type, 'module', 'service worker 必须是 type: module，background.js 里用了 ESM import');
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.ok(manifest.action.default_title && manifest.action.default_title.length > 0);
  assert.ok(existsSync(join(EXT, 'background.js')));
  assert.ok(existsSync(join(EXT, 'popup.html')));
});

test('manifest：权限与任务要求完全一致（tabCapture/offscreen/storage/activeTab/scripting）', () => {
  const required = ['tabCapture', 'offscreen', 'storage', 'activeTab', 'scripting'];
  assert.ok(Array.isArray(manifest.permissions));
  assert.deepEqual([...manifest.permissions].sort(), [...required].sort());
  // host_permissions 只允许本地回环（引擎 / 工作台），不申请外网访问
  assert.ok(Array.isArray(manifest.host_permissions) && manifest.host_permissions.length > 0);
  for (const pattern of manifest.host_permissions) {
    assert.match(pattern, /^(?:http|https):\/\/(?:127\.0\.0\.1|localhost)\//, `host_permissions 只应包含本地地址: ${pattern}`);
  }
  assert.ok(Number(manifest.minimum_chrome_version) >= 116, '需要 Chrome 116+（runtime.getContexts / offscreen）');
});

test('manifest：content_scripts 匹配 <all_urls>、all_frames=false、注入 content.js', () => {
  assert.ok(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length >= 1);
  const entry = manifest.content_scripts[0];
  assert.deepEqual(entry.matches, ['<all_urls>']);
  assert.equal(entry.all_frames, false, '只抓顶层 frame 的媒体元素，避免 iframe 重复注入');
  assert.ok(entry.js.includes('content.js'));
  assert.equal(entry.run_at, 'document_idle');
  assert.ok(existsSync(join(EXT, 'content.js')));
});

test('manifest：引用的文件都存在，且没有声明不存在的图标', () => {
  const referenced = new Set();
  referenced.add(manifest.background.service_worker);
  referenced.add(manifest.action.default_popup);
  for (const cs of manifest.content_scripts || []) {
    for (const file of cs.js || []) referenced.add(file);
    for (const file of cs.css || []) referenced.add(file);
  }
  for (const size of Object.values(manifest.icons || {})) referenced.add(size);
  for (const entry of manifest.web_accessible_resources || []) {
    for (const resource of entry.resources || []) if (!resource.includes('*')) referenced.add(resource);
  }
  for (const rel of referenced) {
    assert.ok(existsSync(join(EXT, rel)), `manifest 引用的文件不存在: ${rel}`);
  }
  // 图标可选：若声明了 action.default_icon 则文件必须存在
  for (const size of Object.values((manifest.action && manifest.action.default_icon) || {})) {
    assert.ok(existsSync(join(EXT, size)), `action.default_icon 文件不存在: ${size}`);
  }
});

test('manifest：没有远程代码 / 外部资源 / 放开 CSP', () => {
  const json = JSON.stringify(manifest);
  const urls = json.match(/(?:https?|wss?):\/\/[^"'\s]+/g) || [];
  for (const url of urls) {
    assert.match(url, /^(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost)/, `manifest 出现非本地 URL: ${url}`);
  }
  // 未显式声明 CSP => 使用 MV3 默认 "script-src 'self'"，不允许远程/内联脚本
  assert.equal(manifest.content_security_policy, undefined);
  assert.equal(manifest.sandbox, undefined);
  // 必须声明快捷键（用户手势入口之一）
  assert.ok(manifest.commands && manifest.commands['toggle-capture'], '缺少 toggle-capture 快捷键');
});

// ===========================================================================
// 2. 静态文件 / 语法 / 无远程代码
// ===========================================================================

test('扩展文件齐全（background/offscreen/content/popup/lib/worklet/README）', () => {
  const required = [
    'manifest.json',
    'background.js',
    'offscreen.html',
    'offscreen.js',
    'content.js',
    'popup.html',
    'popup.js',
    'lib/pcm.js',
    'lib/constants.js',
    'worklet/pcm-worklet.js',
    'README.md',
  ];
  for (const rel of required) assert.ok(existsSync(join(EXT, rel)), `缺少文件: extension/${rel}`);
});

test('所有扩展 JS 通过 node --check 语法检查', () => {
  assert.ok(JS_FILES.length >= 7, `期望至少 7 个 JS 文件，实际 ${JS_FILES.length}`);
  for (const rel of JS_FILES) {
    const result = spawnSync(process.execPath, ['--check', join(EXT, rel)], { encoding: 'utf8' });
    assert.equal(result.status, 0, `node --check 失败: extension/${rel}\n${result.stderr || ''}`);
  }
});

test('扩展代码没有远程脚本/样式/eval（MV3 禁止远程代码）', () => {
  for (const rel of CODE_FILES) {
    const code = readExt(rel);
    assert.ok(!/<script[^>]+src\s*=\s*["']https?:/i.test(code), `extension/${rel}: 引用了远程 script`);
    assert.ok(!/<link[^>]+href\s*=\s*["']https?:/i.test(code), `extension/${rel}: 引用了远程样式`);
    assert.ok(!/@import\s+url\(\s*["']?https?:/i.test(code), `extension/${rel}: CSS 远程 @import`);
    assert.ok(!/\bimport\s*\(\s*["']https?:/.test(code), `extension/${rel}: 远程动态 import`);
    assert.ok(!/\beval\s*\(/.test(code), `extension/${rel}: 使用了 eval`);
    assert.ok(!/\bnew\s+Function\b/.test(code), `extension/${rel}: 使用了 new Function`);
    const urls = (code.match(/(?:https?|wss?):\/\/[^\s"'`)>]+/g) || []).filter((url) => !url.includes('${'));
    for (const url of urls) {
      assert.match(
        url,
        /^(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost)(?:[:/]|$)/,
        `extension/${rel} 出现非本地 URL: ${url}`,
      );
    }
  }
});

test('content.js 是 classic script（不能有 ESM import/export）', () => {
  assert.ok(!/^\s*import\s/m.test(source.content), 'content script 不能使用静态 import');
  assert.ok(!/^\s*export\s/m.test(source.content), 'content script 不能使用 export');
  // 其余扩展页面/模块可以用 ESM
  assert.match(source.background, /^import\s/m);
  assert.match(source.popup, /^import\s/m);
  assert.match(source.offscreen, /^import\s/m);
  assert.ok(!/^\s*import\s/m.test(source.worklet), 'AudioWorklet 脚本保持自包含，不能 import');
});

test('lib/*.js 是浏览器/Node 双端纯模块（不依赖 node: 内置模块或 chrome API）', () => {
  // 注释里可以出现 chrome.xxx 的说明，只检查真实代码（先去掉注释）
  const stripComments = (code) =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const rel of ['lib/pcm.js', 'lib/constants.js']) {
    const raw = readExt(rel);
    const code = stripComments(raw);
    assert.ok(!/from\s+['"]node:/.test(code), `extension/${rel} 不应 import node: 模块`);
    assert.ok(!/\brequire\s*\(/.test(code), `extension/${rel} 不应使用 require`);
    assert.ok(
      !/\bchrome\.(?:runtime|tabs|offscreen|storage|scripting|action|commands)\s*\./.test(code),
      `extension/${rel} 不应依赖 chrome API`,
    );
  }
});

// ===========================================================================
// 3. 关键实现静态断言
// ===========================================================================

test('background.js：用户手势内调用 tabCapture.getMediaStreamId({targetTabId})', () => {
  assert.match(
    source.background,
    /chrome\.tabCapture\.getMediaStreamId\(\{\s*targetTabId/,
    'background 必须在用户手势内调用 getMediaStreamId({ targetTabId })',
  );
  assert.match(source.background, /action\.onClicked\.addListener/);
  assert.match(source.background, /commands\.onCommand\.addListener/);
  assert.match(source.background, /toggle-capture/);
});

test('background.js：offscreen document 创建参数（USER_MEDIA + AUDIO_PLAYBACK + justification）', () => {
  assert.match(source.background, /chrome\.offscreen\s*\.\s*createDocument\(/);
  assert.match(source.background, /url:\s*OFFSCREEN_DOCUMENT_URL/);
  assert.match(source.background, /reasons:\s*\[\.\.\.OFFSCREEN_REASONS\]/);
  assert.match(source.background, /justification:\s*OFFSCREEN_JUSTIFICATION/);
  assert.deepEqual(OFFSCREEN_REASONS, ['USER_MEDIA', 'AUDIO_PLAYBACK']);
  assert.equal(OFFSCREEN_DOCUMENT_URL, 'offscreen.html');
  // 已在运行时复用 offscreen，停止后关闭
  assert.match(source.background, /getContexts/);
  assert.match(source.background, /chrome\.offscreen\s*\.\s*closeDocument/);
  assert.match(source.background, /storage\.session/);
});

test('offscreen.js：getUserMedia 用 tabCapture streamId，AudioWorklet 16k 采集，WS 二进制帧', () => {
  assert.match(source.offscreen, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(source.offscreen, /chromeMediaSource:\s*'tab'/);
  assert.match(source.offscreen, /chromeMediaSourceId:\s*streamId/);
  assert.match(source.offscreen, /new AudioContext\(\{\s*sampleRate:\s*CAPTURE_SAMPLE_RATE/);
  assert.match(source.offscreen, /const CAPTURE_SAMPLE_RATE = 16000/);
  assert.match(source.offscreen, /audioWorklet\.addModule/);
  assert.match(source.offscreen, /new AudioWorkletNode\(/);
  assert.match(source.offscreen, /new WebSocket\(runtime\.engineUrl\)/);
  assert.match(source.offscreen, /encodeAudioFrame\(tMs, pcm\)/);
  assert.match(source.offscreen, /action:\s*'stop'/);
  assert.ok(!/chrome\.tabs\./.test(source.offscreen), 'offscreen document 只能使用 chrome.runtime API');
});

test('offscreen.js：hello 协议、dub 排期播放、指数退避重连', () => {
  assert.match(source.offscreen, /buildHelloMessage\(/);
  assert.match(source.offscreen, /source:\s*'extension'/);
  assert.match(source.offscreen, /base64ToFloat32\(/);
  assert.match(source.offscreen, /event\.startMs/);
  assert.match(source.offscreen, /const RECONNECT_DELAYS_MS = \[500, 1000, 2000, 4000, 8000, 10000\]/);
  assert.match(source.offscreen, /scheduleReconnect/);
  assert.match(source.offscreen, /setTimeout\(/);
});

test('worklet：注册 livedub-pcm，100ms 分片并输出 int16', () => {
  assert.match(source.worklet, /registerProcessor\('livedub-pcm'/);
  assert.match(source.worklet, /targetRate/);
  assert.match(source.worklet, /Int16Array/);
  assert.match(source.worklet, /chunkMs/);
  assert.match(source.worklet, /postMessage\(/);
});

test('content.js：Shadow DOM 浮层、双语字幕、状态胶囊、拖拽、压音 800ms', () => {
  assert.match(source.content, /attachShadow\(\{\s*mode:\s*'open'\s*\}\)/);
  assert.match(source.content, /new CSSStyleSheet\(\)/, '优先用 constructable stylesheet，避免受页面 CSP 影响');
  assert.match(source.content, /MutationObserver/);
  assert.match(source.content, /querySelectorAll\('video, audio'\)/);
  assert.match(source.content, /el\.volume\s*=/);
  assert.match(source.content, /const IDLE_RESTORE_MS = 800/);
  assert.match(source.content, /pointerdown/);
  assert.match(source.content, /chrome\.runtime\.onMessage\.addListener/);
  assert.match(source.content, /chrome\.storage\.local/);
  assert.match(source.content, /data-part="capsule"/);
  assert.match(source.content, /data-part="subs"/);
  assert.match(source.content, /duckRatio/);
  assert.match(source.content, /showOriginal/);
  assert.match(source.content, /fontSize/);
  // 双语字幕结构：原文 + 译文
  assert.match(source.content, /livedub-block \.src/);
  assert.match(source.content, /livedub-block \.dst/);
});

test('popup：引擎地址、开始/停止、音色模式、工作台、错误提示', () => {
  assert.match(source.popup, /chrome\.tabCapture\.getMediaStreamId/);
  assert.match(source.popup, /tabCapture\.getMediaStreamId/);
  assert.match(source.popup, /deriveStudioUrl/);
  assert.match(source.popup, /chrome\.tabs\.create/);
  assert.match(source.popup, /voiceMode/);
  assert.match(source.popupHtml, /id="engine-url"/);
  assert.match(source.popupHtml, /id="toggle"/);
  assert.match(source.popupHtml, /id="voice-mode"/);
  assert.match(source.popupHtml, /id="open-studio"/);
  assert.match(source.popupHtml, /id="error"/);
  assert.match(source.popupHtml, /<script type="module" src="popup.js"><\/script>/);
});

test('offscreen.html 以 module 方式加载 offscreen.js', () => {
  assert.match(source.offscreenHtml, /<script type="module" src="offscreen\.js"><\/script>/);
});

test('README 覆盖安装/权限/排障/手动测试清单', () => {
  for (const keyword of ['加载已解压', 'chrome://extensions', '权限', '排障', '手动测试清单', 'tabCapture', 'offscreen', 'Chrome 116']) {
    assert.ok(source.readme.includes(keyword), `README 缺少内容: ${keyword}`);
  }
  assert.ok(source.readme.length > 2000, 'README 内容过短');
});

// ===========================================================================
// 4. 消息类型跨文件一致性
// ===========================================================================

test('消息类型：background/offscreen/popup 走 MSG 常量，content 内联同一套字符串', () => {
  // 1) 使用 constants.js 的模块：确认 import 了 MSG 且引用了关键 key
  const constantUsers = {
    background: [
      'GET_STATE', 'START', 'STOP', 'CONTENT_READY', 'CONTENT_TOGGLE', 'SET_SETTINGS', 'CONFIG_PATCH',
      'STATE', 'ENGINE_EVENT', 'CONTENT_SETTINGS', 'PING',
      'OFFSCREEN_HELLO', 'OFFSCREEN_START', 'OFFSCREEN_STOP', 'OFFSCREEN_CONFIG',
      'OFFSCREEN_STATE', 'OFFSCREEN_EVENT', 'OFFSCREEN_STOPPED', 'OFFSCREEN_PING',
    ],
    offscreen: [
      'OFFSCREEN_HELLO', 'OFFSCREEN_START', 'OFFSCREEN_STOP', 'OFFSCREEN_CONFIG',
      'OFFSCREEN_STATE', 'OFFSCREEN_EVENT', 'OFFSCREEN_STOPPED', 'OFFSCREEN_PING',
    ],
    popup: ['GET_STATE', 'START', 'STOP', 'STATE'],
  };
  for (const [file, keys] of Object.entries(constantUsers)) {
    const code = source[file];
    assert.match(code, /from\s+['"]\.\/lib\/constants\.js['"]/, `${file} 应从 lib/constants.js 导入 MSG`);
    for (const key of keys) {
      assert.ok(code.includes(`MSG.${key}`), `${file} 缺少 MSG.${key}`);
    }
  }
  // 2) content script 是 classic script，不能 import，因此内联字符串必须与 MSG 值一致
  const contentLiteralTypes = [
    MSG.STATE,
    MSG.ENGINE_EVENT,
    MSG.PING,
    MSG.CONTENT_READY,
    MSG.CONTENT_TOGGLE,
    MSG.CONTENT_SETTINGS,
    STORAGE_KEYS.settings,
  ];
  for (const value of contentLiteralTypes) {
    assert.ok(source.content.includes(`'${value}'`), `content.js 缺少消息类型字符串 "${value}"`);
  }
  // 3) MSG 值唯一且统一加 livedub: 前缀
  const values = Object.values(MSG);
  assert.equal(new Set(values).size, values.length, 'MSG 存在重复值');
  for (const value of values) assert.match(value, /^livedub:/);
});

test('content.js 内联常量与 lib/constants.js 默认值一致', () => {
  assert.ok(source.content.includes(DEFAULT_ENGINE_URL), 'content 内联的默认引擎地址与 constants 不一致');
  assert.ok(source.content.includes(`duckRatio: ${DEFAULT_SETTINGS.duckRatio}`));
  assert.ok(source.content.includes(`fontSize: ${DEFAULT_SETTINGS.fontSize}`));
  assert.ok(source.content.includes(`voiceMode: '${DEFAULT_SETTINGS.voiceMode}'`));
  assert.ok(source.content.includes(STORAGE_KEYS.settings));
});

// ===========================================================================
// 5. extension/lib/pcm.js 纯函数
// ===========================================================================

test('pcm：float32 -> int16 饱和/取整', () => {
  const input = Float32Array.from([0, 1, -1, 0.5, -0.5, 2, -2, Number.NaN]);
  const out = float32ToInt16(input);
  assert.deepEqual([...out], [0, 32767, -32768, 16384, -16384, 32767, -32768, 0]);
});

test('pcm：int16 <-> float32', () => {
  const int16 = Int16Array.from([-32768, 0, 16384, 32767]);
  const floats = int16ToFloat32(int16);
  assert.equal(floats.length, 4);
  assert.equal(floats[0], -1);
  assert.equal(floats[1], 0);
  assert.equal(floats[2], 0.5);
  assert.ok(Math.abs(floats[3] - 32767 / 32768) < 1e-9);
});

test('pcm：s16le 字节编解码（小端）', () => {
  const int16 = Int16Array.from([0x1234, -2, 0]);
  const bytes = s16leFromInt16(int16);
  assert.deepEqual([...bytes], [0x34, 0x12, 0xfe, 0xff, 0x00, 0x00]);
  assert.deepEqual([...int16FromS16le(bytes)], [...int16]);
  assert.throws(() => int16FromS16le(new Uint8Array(3)), /even/);
});

test('pcm：48k -> 16k 线性重采样', () => {
  const input = Float32Array.from({ length: 48 }, (_, index) => index);
  const out = downsample48kTo16k(input);
  assert.equal(out.length, 16);
  // 采样点：0, 3, 6, ...（ratio=3）
  assert.deepEqual([...out.slice(0, 4)], [0, 3, 6, 9]);
  const same = resampleLinear(Float32Array.from([1, 2, 3]), 16000, 16000);
  assert.deepEqual([...same], [1, 2, 3]);
  assert.throws(() => resampleLinear([1], 0, 16000), /positive/);
});

test('pcm：二进制音频帧与 engine/protocol.mjs 字节级一致', () => {
  const samples = Int16Array.from([-32768, -1234, -1, 0, 1, 1234, 32767]);
  for (const tMs of [0, 1, 99.5, 1234, 3600000.25]) {
    const mine = Buffer.from(encodeAudioFrame(tMs, samples));
    const theirs = engineEncodeAudioFrame(tMs, toBuffer(samples));
    assert.equal(mine.toString('hex'), theirs.toString('hex'), `tMs=${tMs} 帧字节不一致`);
    assert.equal(mine[0], AUDIO_FRAME_TAG);
    assert.equal(mine.readDoubleBE(1), tMs);
    assert.equal(mine.length, AUDIO_FRAME_HEADER_BYTES + samples.length * 2);
  }
});

test('pcm：帧解析与 engine/protocol.mjs 双向兼容', () => {
  const samples = Int16Array.from([100, -100, 32767, -32768]);
  const engineFrame = engineEncodeAudioFrame(1234.5, toBuffer(samples));
  const decoded = decodeAudioFrame(new Uint8Array(engineFrame));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.tMs, 1234.5);
  assert.deepEqual([...int16FromS16le(decoded.pcm)], [...samples]);

  const myFrame = encodeAudioFrame(42, samples);
  const engineDecoded = engineDecodeAudioFrame(Buffer.from(myFrame));
  assert.equal(engineDecoded.ok, true);
  assert.equal(engineDecoded.tMs, 42);
  assert.deepEqual([...engineDecoded.pcm], [...toBuffer(samples)]);
});

test('pcm：编码非法输入抛错（空/奇数字节/负 tMs/NaN/超长）', () => {
  assert.throws(() => encodeAudioFrame(0, new Int16Array(0)), RangeError);
  assert.throws(() => encodeAudioFrame(0, new Uint8Array(3)), RangeError);
  assert.throws(() => encodeAudioFrame(-1, Int16Array.from([1])), RangeError);
  assert.throws(() => encodeAudioFrame(Number.NaN, Int16Array.from([1])), RangeError);
  assert.throws(() => encodeAudioFrame(0, new Uint8Array(MAX_AUDIO_FRAME_BYTES)), RangeError);
});

test('pcm：解码非法帧返回 ok:false 而不是抛异常', () => {
  assert.equal(decodeAudioFrame(new Uint8Array(5)).ok, false);
  assert.match(decodeAudioFrame(new Uint8Array(5)).error, /short/);

  const badTag = encodeAudioFrame(0, Int16Array.from([1, 2]));
  badTag[0] = 0x02;
  const tagResult = decodeAudioFrame(badTag);
  assert.equal(tagResult.ok, false);
  assert.match(tagResult.error, /tag/);

  const odd = new Uint8Array(AUDIO_FRAME_HEADER_BYTES + 3);
  odd[0] = AUDIO_FRAME_TAG;
  new DataView(odd.buffer).setFloat64(1, 100, false);
  const oddResult = decodeAudioFrame(odd);
  assert.equal(oddResult.ok, false);
  assert.match(oddResult.error, /odd/);

  const badT = new Uint8Array(AUDIO_FRAME_HEADER_BYTES + 2);
  badT[0] = AUDIO_FRAME_TAG;
  new DataView(badT.buffer).setFloat64(1, -5, false);
  const badTResult = decodeAudioFrame(badT);
  assert.equal(badTResult.ok, false);
  assert.match(badTResult.error, /tMs/);
});

test('pcm：buildAudioFrame 把任意采样率浮点采样编译成 16k 帧', () => {
  const samples48k = new Float32Array(4800); // 100ms @48k
  const frame = buildAudioFrame(0, samples48k, 48000);
  const decoded = decodeAudioFrame(frame);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.pcm.byteLength, 1600 * 2, '100ms @16k = 1600 采样 = 3200 字节');
  assert.equal(decoded.tMs, 0);
});

test('pcm：base64 编解码（dub pcm 往返）', () => {
  assert.equal(bytesToBase64(Uint8Array.from([0, 0, 0])), 'AAAA');
  assert.equal(bytesToBase64(Uint8Array.from([77, 97, 110])), 'TWFu');
  const samples = Int16Array.from([1000, -1000, 0, 32767, -32768]);
  const bytes = s16leFromInt16(samples);
  const b64 = bytesToBase64(bytes);
  assert.deepEqual([...base64ToBytes(b64)], [...bytes]);
  const floats = base64ToFloat32(b64);
  assert.equal(floats.length, samples.length);
  assert.ok(Math.abs(floats[0] - 1000 / 32768) < 1e-6);
  assert.deepEqual([...base64ToInt16(bytesToBase64(bytes))], [...samples]);
  assert.throws(() => base64ToBytes('不是base64'), /invalid base64/);
  assert.throws(() => base64ToBytes('abc'), /multiple of 4/);
});

test('pcm：hello 消息能被 engine/protocol.mjs#normalizeHello 接受', () => {
  assert.equal(PROTOCOL_VERSION, ENGINE_PROTOCOL_VERSION);
  const hello = buildHelloMessage({
    title: 'x'.repeat(600),
    url: 'https://www.youtube.com/watch?v=abc',
    langFrom: 'en',
    langTo: 'zh',
    overrides: { dub: { enabled: true }, tts: { voiceMode: 'clone-first' } },
    glossary: [{ src: 'gradient descent', dst: '梯度下降' }],
  });
  assert.equal(hello.type, 'hello');
  assert.equal(hello.protocol, ENGINE_PROTOCOL_VERSION);
  const normalized = normalizeHello(hello);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.options.source, 'extension');
  assert.equal(normalized.options.title.length, 500, 'title 超长应截断到 500');
  assert.equal(normalized.options.url, 'https://www.youtube.com/watch?v=abc');
  assert.equal(normalized.options.langFrom, 'en');
  assert.equal(normalized.options.langTo, 'zh');
  assert.equal(normalized.options.overrides.dub.enabled, true);
  assert.equal(normalized.options.glossary.length, 1);
  assert.equal(normalized.options.glossary[0].dst, '梯度下降');

  // 默认参数同样可用
  assert.equal(normalizeHello(buildHelloMessage()).ok, true);
});

test('pcm：事件文本清洗 / 截断 / 双语字幕换行', () => {
  assert.equal(sanitizeEventText('  hello\n\n world\t!  '), 'hello world !');
  assert.equal(sanitizeEventText(''), '');
  assert.equal(sanitizeEventText(null), '');
  assert.equal(sanitizeEventText('a\u0000b\u0007c'), 'abc');
  const long = 'x'.repeat(50);
  const cut = sanitizeEventText(long, { maxLen: 20 });
  assert.equal(cut.length, 20);
  assert.ok(cut.endsWith('…'));

  const wrapped = wrapSubtitleLines('这是一个很长的中文字幕需要换行显示出来才能看清', { maxCharsPerLine: 10, maxLines: 2 });
  const lines = wrapped.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].length <= 10);
  assert.ok(lines[1].endsWith('…'));

  const english = wrapSubtitleLines('this is a fairly long english sentence that needs wrapping', {
    maxCharsPerLine: 18,
    maxLines: 2,
  });
  assert.equal(english.split('\n').length, 2);
  assert.equal(wrapSubtitleLines('', { maxCharsPerLine: 10, maxLines: 2 }), '');
});

test('pcm：延迟 / 状态标签格式化', () => {
  assert.equal(formatLatency(850), '850ms');
  assert.equal(formatLatency(1234), '1.2s');
  assert.equal(formatLatency(null), '—');
  assert.equal(formatLatency(undefined), '—');
  assert.equal(formatLatency(Number.NaN), '—');
  assert.equal(formatStateLabel('listening'), '收听中');
  assert.equal(formatStateLabel('speaking'), '配音中');
  assert.equal(formatStateLabel('custom-state'), 'custom-state');
});

test('pcm：pickLatencyMs 优先 e2eLagMs，否则累加各阶段', () => {
  assert.equal(pickLatencyMs({ e2eLagMs: 1500, asrFinalMs: 1 }), 1500);
  assert.equal(pickLatencyMs({ asrFinalMs: 300, mtDoneMs: 400, ttsFirstMs: 200 }), 900);
  assert.equal(pickLatencyMs({}), null);
  assert.equal(pickLatencyMs(null), null);
});

test('pcm：dub 播放时刻（提前排期 / 落后立即播）', () => {
  const currentTime = 12;
  // 目标在 1.5s 之后 -> 排到 currentTime + 1.5 + 0.03
  const scheduled = computeDubPlayhead({ startMs: 1500, sessionNowMs: 0, currentTime });
  assert.ok(Math.abs(scheduled - (currentTime + 1.5 + 0.03)) < 1e-9);
  // 落后（startMs < 当前时刻）-> 立即播（只加 30ms 缓冲）
  const late = computeDubPlayhead({ startMs: 1000, sessionNowMs: 4000, currentTime });
  assert.ok(Math.abs(late - (currentTime + 0.03)) < 1e-9);
  // 没有时间轴信息 -> 立即播
  assert.ok(Math.abs(computeDubPlayhead({ startMs: Number.NaN, currentTime }) - (currentTime + 0.03)) < 1e-9);
  // 异常大的提前量被限制在 30s 内
  const far = computeDubPlayhead({ startMs: 10 * 60 * 1000, sessionNowMs: 0, currentTime });
  assert.ok(Math.abs(far - (currentTime + 30.03)) < 1e-9);
});

test('pcm：duck 状态机（speaking -> 压音，空闲 800ms -> 恢复）', () => {
  const duck = createDuckStateMachine({ duckRatio: 0.18, idleMs: 800 });
  assert.equal(duck.ducking, false);
  assert.equal(duck.ratio, 0.18);

  let result = duck.speak(1000);
  assert.equal(result.ducking, true);
  assert.equal(result.changed, true);
  assert.equal(result.ratio, 0.18);

  // 持续说话：idle 前不恢复
  assert.equal(duck.tick(1500).changed, false);
  assert.equal(duck.idle(1600).changed, false);
  assert.equal(duck.tick(2300).changed, false, '700ms 还没到 800ms');
  result = duck.tick(2400);
  assert.equal(result.changed, true);
  assert.equal(result.ducking, false);

  // 配音音频块续命
  duck.speak(0);
  duck.activity(500);
  duck.idle(600);
  assert.equal(duck.tick(1300).changed, false, 'idle 起算 700ms');
  assert.equal(duck.tick(1400).changed, true, 'idle 起算 800ms 恢复');

  // 兜底：speaking 后再也没有事件，也会在 idleMs 后恢复
  duck.speak(0);
  assert.equal(duck.tick(700).changed, false);
  assert.equal(duck.tick(800).changed, true);
});

test('pcm：duck 状态机比例钳制与 reset', () => {
  const duck = createDuckStateMachine({ duckRatio: 0.18 });
  assert.equal(duck.setRatio(0), 0.02);
  assert.equal(duck.setRatio(5), 1);
  assert.equal(duck.setRatio('abc'), 1, '非法值保持当前比例');
  duck.speak(0);
  const reset = duck.reset();
  assert.equal(reset.changed, true);
  assert.equal(duck.ducking, false);
  assert.equal(duck.reset().changed, false);
});

// ===========================================================================
// 6. extension/lib/constants.js
// ===========================================================================

test('constants：默认引擎地址与本地工作台推导', () => {
  assert.equal(DEFAULT_ENGINE_URL, 'ws://127.0.0.1:8787/ws');
  assert.equal(deriveStudioUrl('ws://127.0.0.1:8787/ws'), 'http://127.0.0.1:8787/');
  assert.equal(deriveStudioUrl('wss://engine.example.com/ws'), 'https://engine.example.com/');
  assert.equal(deriveStudioUrl(''), null);
  assert.equal(deriveStudioUrl('ftp://x/y'), null);
});

test('constants：normalizeEngineUrl 兼容 ws/wss/http/裸主机，非法返回 null', () => {
  assert.equal(normalizeEngineUrl('ws://127.0.0.1:8787/ws'), 'ws://127.0.0.1:8787/ws');
  assert.equal(normalizeEngineUrl('http://127.0.0.1:8787'), 'ws://127.0.0.1:8787/ws');
  assert.equal(normalizeEngineUrl('https://engine.example.com/ws'), 'wss://engine.example.com/ws');
  assert.equal(normalizeEngineUrl('127.0.0.1:8787'), 'ws://127.0.0.1:8787/ws');
  assert.equal(normalizeEngineUrl('ws://127.0.0.1:8787/ws/'), 'ws://127.0.0.1:8787/ws');
  assert.equal(normalizeEngineUrl('  ws://127.0.0.1:8787/custom  '), 'ws://127.0.0.1:8787/custom');
  assert.equal(normalizeEngineUrl('ws://127.0.0.1:8787/ws?token=abc'), 'ws://127.0.0.1:8787/ws?token=abc');
  assert.equal(normalizeEngineUrl(''), null);
  assert.equal(normalizeEngineUrl('   '), null);
  assert.equal(normalizeEngineUrl('ftp://127.0.0.1/x'), null);
  assert.equal(normalizeEngineUrl('not a url with spaces'), null);
  assert.equal(normalizeEngineUrl(null), null);
  assert.equal(normalizeEngineUrl(undefined), null);
});

test('constants：isCapturablePage 只在 http(s)/file 页面返回 true', () => {
  assert.equal(isCapturablePage('https://www.youtube.com/watch?v=abc'), true);
  assert.equal(isCapturablePage('http://127.0.0.1:8080/video'), true);
  assert.equal(isCapturablePage('file:///Users/me/lesson.html'), true);
  assert.equal(isCapturablePage('chrome://extensions'), false);
  assert.equal(isCapturablePage('chrome-extension://abc/popup.html'), false);
  assert.equal(isCapturablePage(''), false);
  assert.equal(isCapturablePage(undefined), false);
});

test('constants：默认设置符合契约（16k 引擎 / 配音开 / 压音 0.18 / 字号 22）', () => {
  assert.equal(DEFAULT_SETTINGS.engineUrl, DEFAULT_ENGINE_URL);
  assert.equal(DEFAULT_SETTINGS.voiceMode, 'clone-first');
  assert.equal(DEFAULT_SETTINGS.dubEnabled, true);
  assert.equal(DEFAULT_SETTINGS.duckRatio, 0.18);
  assert.equal(DEFAULT_SETTINGS.showOriginal, true);
  assert.equal(DEFAULT_SETTINGS.fontSize, 22);
  assert.equal(DEFAULT_SETTINGS.hidden, false);
  assert.equal(DEFAULT_SETTINGS.subsPos, null);
  assert.equal(STORAGE_KEYS.settings, 'livedub:settings');
  assert.equal(STORAGE_KEYS.bgState, 'livedub:bg-state');
});

test('constants：offscreen 文档配置与消息类型集合', () => {
  assert.equal(OFFSCREEN_DOCUMENT_URL, 'offscreen.html');
  assert.deepEqual(OFFSCREEN_REASONS, ['USER_MEDIA', 'AUDIO_PLAYBACK']);
  const requiredMessages = [
    'GET_STATE', 'START', 'STOP', 'CONTENT_READY', 'CONTENT_TOGGLE', 'SET_SETTINGS', 'CONFIG_PATCH',
    'STATE', 'ENGINE_EVENT', 'CONTENT_SETTINGS', 'PING',
    'OFFSCREEN_HELLO', 'OFFSCREEN_START', 'OFFSCREEN_STOP', 'OFFSCREEN_CONFIG',
    'OFFSCREEN_STATE', 'OFFSCREEN_EVENT', 'OFFSCREEN_STOPPED', 'OFFSCREEN_PING',
  ];
  for (const key of requiredMessages) assert.ok(typeof MSG[key] === 'string', `MSG.${key} 缺失`);
});

// ===========================================================================
// 7. 线协议冒烟（与 engine/ws.mjs 联调；纯本地回环，不依赖真实浏览器）
// ===========================================================================

test('协议冒烟：hello + 二进制音频帧 + control stop 能被 engine/ws.mjs 接收', { timeout: 15000 }, async () => {
  const { createServer } = await import('node:http');
  const { attachWebSocketServer } = await import('../engine/ws.mjs');

  const seen = { hello: null, frames: 0, controls: [] };
  const server = createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  attachWebSocketServer(server, {
    path: '/ws',
    onConnection(ws) {
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const frame = engineDecodeAudioFrame(data);
          assert.equal(frame.ok, true, `引擎无法解析扩展发来的音频帧: ${frame.error}`);
          seen.frames += 1;
          return;
        }
        const parsed = JSON.parse(String(data));
        if (parsed.type === 'hello') {
          const hello = normalizeHello(parsed);
          assert.equal(hello.ok, true, `引擎拒绝扩展 hello: ${hello.error}`);
          seen.hello = hello.options;
          ws.sendText(
            JSON.stringify({
              type: 'ready',
              sessionId: 'test-session',
              protocol: ENGINE_PROTOCOL_VERSION,
              providers: { asr: 'mock', translate: 'mock', tts: 'mock' },
              voice: { mode: 'preset', voiceId: 'male-qn-qingse' },
              limits: {},
            }),
          );
          ws.sendText(JSON.stringify({ type: 'status', state: 'listening' }));
        } else if (parsed.type === 'control') {
          seen.controls.push(parsed);
        }
      });
    },
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    const events = [];
    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') events.push(JSON.parse(event.data));
    });
    ws.send(
      JSON.stringify(
        buildHelloMessage({
          title: '协议冒烟',
          url: 'https://example.com/video',
          langFrom: 'en',
          langTo: 'zh',
          overrides: { dub: { enabled: true }, tts: { voiceMode: 'clone-first' } },
        }),
      ),
    );
    await waitFor(() => events.some((event) => event.type === 'ready'), 3000, '没收到引擎 ready');
    const pcm = float32ToInt16(new Float32Array(1600)); // 100ms @16k 静音
    for (let index = 0; index < 10; index += 1) ws.send(encodeAudioFrame(index * 100, pcm));
    ws.send(JSON.stringify({ type: 'control', action: 'stop', tMs: 1000 }));
    await waitFor(() => seen.frames === 10 && seen.controls.length === 1, 3000, '引擎没有收到全部音频帧/control');
    assert.equal(seen.hello.source, 'extension');
    assert.equal(seen.hello.title, '协议冒烟');
    assert.equal(seen.hello.langTo, 'zh');
    assert.equal(seen.hello.overrides.dub.enabled, true);
    assert.equal(seen.controls[0].action, 'stop');
  } finally {
    try {
      ws.close(1000, 'test done');
    } catch {
      /* ignore */
    }
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** 轮询等待条件成立，超时抛错（避免测试挂死） */
async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}
