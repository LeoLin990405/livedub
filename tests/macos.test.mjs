/**
 * livedub macOS 菜单栏 App（ScreenCaptureKit）静态契约测试。
 *
 * 设计原则（与其它测试一致）：
 * - 默认离线、跨平台（CI 在 ubuntu 跑）：只读文件 + `bash -n`，不调用 swiftc、不启动 GUI；
 * - 协议常量以 engine/protocol.mjs 为权威来源，Swift 侧只做「对齐断言」，防止两边漂移；
 * - 真编译 + `--self-test` 由 scripts/build-macos.sh --check 完成；
 *   如需在本机做端到端构建，设置 LIVEDUB_MACOS_BUILD=1 会额外跑一次（仅 macOS）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, 'apps', 'macos');
const SOURCES_DIR = path.join(APP_DIR, 'Sources');
const BUILD_SCRIPT = path.join(ROOT, 'scripts', 'build-macos.sh');

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const readSource = (name) => readFileSync(path.join(SOURCES_DIR, name), 'utf8');

const SWIFT_FILES = [
  'main.swift',
  'ScreenAudioCapture.swift',
  'EngineClient.swift',
  'OverlayWindow.swift',
  'DubPlayer.swift',
  'Settings.swift',
];

test('macos: 构建脚本存在，bash -n 语法检查通过', () => {
  assert.ok(existsSync(BUILD_SCRIPT), `缺少构建脚本：${path.relative(ROOT, BUILD_SCRIPT)}`);
  const result = execFileSync('bash', ['-n', BUILD_SCRIPT], { encoding: 'utf8' });
  assert.equal(result.trim(), '');
});

test('macos: 构建脚本生成 livedub.app（swiftc -O + Info.plist + PkgInfo），不含 xcodebuild/SPM', () => {
  const script = readFileSync(BUILD_SCRIPT, 'utf8');
  assert.match(script, /\/usr\/bin\/swiftc|SWIFTC/);
  assert.match(script, /-O\b/, "构建脚本应使用 swiftc -O 优化编译");
  assert.match(script, /livedub\.app/);
  assert.match(script, /Contents\/MacOS\/livedub/);
  assert.match(script, /Contents\/Info\.plist/);
  assert.match(script, /Contents\/PkgInfo/);
  assert.match(script, /APPL\?\?\?\?/);
  assert.match(script, /--check/);
  assert.match(script, /--self-test/);
  // 只用系统框架，不依赖 Xcode 工程 / SPM / 第三方包
  for (const framework of ['AppKit', 'AVFoundation', 'CoreMedia', 'CoreGraphics', 'ScreenCaptureKit']) {
    assert.match(script, new RegExp(`-framework ${framework}`), `构建脚本应显式链接 ${framework}`);
  }
  // 注释里会提到「无 xcodebuild 工程」，这里只检查可执行代码行
  const scriptCode = script
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  assert.doesNotMatch(scriptCode, /xcodebuild|Package\.swift|pod install|npm install/);
});

test('macos: Swift 源文件齐全且包含关键实现', () => {
  for (const file of SWIFT_FILES) {
    const full = path.join(SOURCES_DIR, file);
    assert.ok(existsSync(full), `缺少 Swift 源：apps/macos/Sources/${file}`);
    assert.ok(statSync(full).size > 500, `${file} 过小，可能未实现`);
  }

  const capture = readSource('ScreenAudioCapture.swift');
  assert.match(capture, /SCShareableContent/);
  assert.match(capture, /SCStreamConfiguration/);
  assert.match(capture, /capturesAudio = true/);
  assert.match(capture, /CGPreflightScreenCaptureAccess/);
  assert.match(capture, /CGRequestScreenCaptureAccess/);

  const engine = readSource('EngineClient.swift');
  assert.match(engine, /URLSessionWebSocketTask/);
  assert.match(engine, /webSocketTask\(with:/);
  assert.match(engine, /sendAudioFrame/);
  assert.match(engine, /reconnect/i);
  assert.match(engine, /ping/i);

  const overlay = readSource('OverlayWindow.swift');
  assert.match(overlay, /NSPanel/);
  assert.match(overlay, /ignoresMouseEvents/);
  assert.match(overlay, /isMovableByWindowBackground/);
  assert.match(overlay, /\.floating/);

  const dub = readSource('DubPlayer.swift');
  assert.match(dub, /AVAudioEngine/);
  assert.match(dub, /AVAudioPlayerNode/);
  assert.match(dub, /scheduleBuffer/);
  assert.match(dub, /startMs/);

  const settings = readSource('Settings.swift');
  assert.match(settings, /UserDefaults/);
  assert.match(settings, /engineURL/);
  assert.match(settings, /fontSize/);
  assert.match(settings, /clickThrough/);

  const main = readSource('main.swift');
  assert.match(main, /NSApplication/);
  assert.match(main, /NSStatusBar/);
  assert.match(main, /--simulate/);
  assert.match(main, /--self-test/);
  assert.match(main, /--duration/);
});

test('macos: Swift 只用系统框架（零第三方 Swift 依赖）', () => {
  const allowed = new Set([
    'AppKit',
    'AVFoundation',
    'CoreGraphics',
    'CoreMedia',
    'Foundation',
    'ScreenCaptureKit',
  ]);
  for (const file of SWIFT_FILES) {
    const source = readSource(file);
    for (const match of source.matchAll(/^import\s+([A-Za-z_][\w]*)/gm)) {
      assert.ok(allowed.has(match[1]), `${file} 引入了非系统框架：${match[1]}`);
    }
  }
  assert.ok(!existsSync(path.join(APP_DIR, 'Package.swift')), 'macOS App 不应引入 Swift Package');
  assert.ok(!existsSync(path.join(APP_DIR, 'livedub.xcodeproj')), 'macOS App 不应引入 Xcode 工程');
});

test('macos: 协议常量与 engine/protocol.mjs 一致（帧标签/采样率/分帧/上限）', () => {
  const protocol = read('engine/protocol.mjs');
  const numberFrom = (pattern, label) => {
    const match = protocol.match(pattern);
    assert.ok(match, `engine/protocol.mjs 缺少 ${label}`);
    return Number(match[1]);
  };

  const protocolVersion = numberFrom(/export const PROTOCOL_VERSION = (\d+);/, 'PROTOCOL_VERSION');
  const frameTag = numberFrom(/export const AUDIO_FRAME_TAG = (0x[0-9a-fA-F]+);/, 'AUDIO_FRAME_TAG');
  const inputSampleRate = numberFrom(/export const AUDIO_INPUT_SAMPLE_RATE = (\d+);/, 'AUDIO_INPUT_SAMPLE_RATE');
  const frameMs = numberFrom(/export const AUDIO_FRAME_MS = (\d+);/, 'AUDIO_FRAME_MS');
  const maxFrameBytes = numberFrom(
    /export const MAX_AUDIO_FRAME_BYTES = (\d+) \* 1024;/,
    'MAX_AUDIO_FRAME_BYTES',
  ) * 1024;

  assert.equal(protocolVersion, 1, '当前线协议应为 v1');
  assert.equal(frameTag, 0x01);
  assert.equal(inputSampleRate, 16000);
  assert.equal(frameMs, 100);
  assert.equal(maxFrameBytes, 256 * 1024);

  const swift = readSource('Protocol.swift');
  assert.match(swift, /static let version = 1/);
  assert.match(swift, /audioFrameTag: UInt8 = 0x01/);
  assert.match(swift, /audioInputSampleRate = 16_000/);
  assert.match(swift, /audioFrameMs = 100/);
  assert.match(swift, /maxAudioFrameBytes = 256 \* 1024/);
  assert.match(swift, /frameSamples: Int \{ audioInputSampleRate \* audioFrameMs \/ 1000 \}/);
  assert.match(swift, /frameSamples == 1_?600|frameSamples\b/, '应推导每帧 1600 采样');
  // 二进制帧布局：tag + float64BE tMs + s16le
  assert.match(swift, /stride\(from: 56, through: 0, by: -8\)/, 'tMs 必须写 float64 big-endian');
  assert.match(swift, /data\.append\(LiveDubProtocol\.audioFrameTag\)/);
  assert.match(swift, /S16leCodec/);
});

test('macos: 引擎地址 / 事件名与 docs+protocol.mjs 对齐', () => {
  const engineURL = 'ws://127.0.0.1:8787/ws';
  const protocolSwift = readSource('Protocol.swift');
  assert.ok(protocolSwift.includes(`defaultEngineURL = "${engineURL}"`), 'Swift 默认引擎地址应与文档一致');
  assert.match(protocolSwift, /enginePort = 8787/);
  assert.match(protocolSwift, /wsPath = "\/ws"/);

  const contracts = read('docs/CONTRACTS.md');
  assert.match(contracts, /8787/);
  assert.match(contracts, /`?\/ws`?/);
  assert.ok(contracts.includes(engineURL) || /WebSocket `?\/ws`?/.test(contracts));

  // server -> client 事件：Swift 解析器必须覆盖 protocol.mjs MSG 里定义的类型
  const protocol = read('engine/protocol.mjs');
  const msgBlock = protocol.match(/export const MSG = Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert.ok(msgBlock, 'engine/protocol.mjs 缺少 MSG 定义');
  const serverEvents = ['ready', 'status', 'partial', 'segment', 'translation', 'dub', 'metrics', 'voice', 'error', 'pong', 'bye'];
  for (const event of serverEvents) {
    assert.ok(msgBlock[1].includes(`'${event}'`), `protocol.mjs MSG 缺少 ${event}`);
    assert.match(protocolSwift, new RegExp(`case "${event}":`), `Swift 事件解析器缺少 ${event}`);
  }
  // client -> server：hello / ping / control
  const engineClient = readSource('EngineClient.swift');
  assert.match(engineClient, /"type":\s*"ping"/);
  assert.match(engineClient, /sendControl/);
  assert.match(protocolSwift, /"type":\s*"hello"/);
  const main = readSource('main.swift');
  assert.match(main, /sendAudioFrame/);
});

test('macos: Info.plist 关键键（LSUIElement / 屏幕录制权限说明 / bundle 元数据）', () => {
  const plist = readFileSync(path.join(APP_DIR, 'Info.plist'), 'utf8');
  assert.match(plist, /LSUIElement<\/key>\s*<true\/>/, '菜单栏 App 必须 LSUIElement=true');
  assert.match(
    plist,
    /NSScreenCaptureUsageDescription<\/key>\s*<string>[^<]{10,}<\/string>/,
    '必须有屏幕录制用途说明（系统权限弹窗展示）',
  );
  assert.match(plist, /CFBundleIdentifier<\/key>\s*<string>[A-Za-z0-9.\-]+<\/string>/);
  assert.match(plist, /CFBundleExecutable<\/key>\s*<string>livedub<\/string>/);
  assert.match(plist, /CFBundlePackageType<\/key>\s*<string>APPL<\/string>/);
  assert.match(plist, /LSMinimumSystemVersion<\/key>\s*<string>1[34]\.[0-9]+<\/string>/);
  assert.match(plist, /NSScreenCaptureUsageDescription[\s\S]{0,400}(不截屏|音频)/, '权限说明应解释只抓音频');
});

test('macos: apps/macos/README.md 覆盖构建/权限/运行/已知限制/手动测试', () => {
  const readmePath = path.join(APP_DIR, 'README.md');
  assert.ok(existsSync(readmePath), '缺少 apps/macos/README.md');
  const readme = readFileSync(readmePath, 'utf8');

  for (const must of [
    'bash scripts/build-macos.sh',
    '--check',
    '--self-test',
    '--simulate',
    '--autostart',
    'open ',
    '屏幕录制',
    '隐私与安全性',
    '系统设置',
    'ws://127.0.0.1:8787/ws',
    'node engine/server.mjs',
    '已知限制',
    '原声',
    '虚拟声卡',
    '手动测试',
  ]) {
    assert.ok(readme.includes(must), `README 缺少关键说明：${must}`);
  }
  assert.match(readme, /ad-hoc|未签名|签名/, 'README 应说明未签名 App 的打开方式');
  assert.match(readme, /屏幕录制[\s\S]{0,200}(只|不)(截屏|录屏|保存)/, 'README 应说明只抓音频不截屏');
});

test('macos: 构建产物目录已 gitignore，避免把二进制提交进仓库', () => {
  const gitignore = read('.gitignore');
  assert.match(gitignore, /apps\/macos\/build\//);
});

test(
  'macos: 本机完整编译 + self-test（LIVEDUB_MACOS_BUILD=1 且 macOS 时运行）',
  { skip: process.env.LIVEDUB_MACOS_BUILD === '1' && process.platform === 'darwin' ? false : '设置 LIVEDUB_MACOS_BUILD=1 在 macOS 上运行完整 swiftc 构建' },
  () => {
    const output = execFileSync('bash', [BUILD_SCRIPT, '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 180_000,
    });
    assert.match(output, /self-test: \d+ checks passed/);
    assert.ok(existsSync(path.join(APP_DIR, 'build', 'livedub.app', 'Contents', 'MacOS', 'livedub')));
  },
);
