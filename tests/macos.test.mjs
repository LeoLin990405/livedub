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
  // v0.4 快捷笔记
  'NotesClient.swift',
  'HotKey.swift',
  'Screenshot.swift',
  // v0.5 画面文字 / 画面理解
  'Vision.swift',
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
    // v0.4：Carbon RegisterEventHotKey（系统框架，非第三方）
    'Carbon',
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

test('macos: v0.5 画面文字（OCR）/ 画面理解（VLM）（Vision + NotesClient + 菜单）', () => {
  // 纯逻辑层：请求模型 / 清洗 / 代码块转义 / 降级决策 / health 解析
  const vision = readSource('Vision.swift');
  assert.match(vision, /\/api\/vision|VisionOCRRequest|imageUrl/, '缺少视觉 API 模型');
  assert.match(vision, /VisionAnalyzeResponse/);
  assert.match(vision, /VisionPlanner/);
  assert.match(vision, /ocrTimeout: TimeInterval = 25/);
  assert.match(vision, /analyzeTimeout: TimeInterval = 45/);
  assert.match(vision, /ocrMaxChars = 2_000/);
  assert.match(vision, /captionMaxChars = 1_000/);
  assert.match(vision, /maxImageBytes = 4 \* 1024 \* 1024/);
  assert.match(vision, /VisionHealthParser/, '缺少 /api/vision/health 解析');
  assert.match(vision, /endpointMissing/, '缺少旧引擎 404 降级决策');
  assert.match(vision, /codeBlock/, '缺少 OCR 代码块转义');
  assert.match(vision, /\*\*画面文字\*\*（OCR）/, '缺少画面文字段落标记');
  assert.match(vision, /\*\*画面理解\*\*/, '缺少画面理解段落标记');

  // 网络层：NotesClient 扩展
  const notes = readSource('NotesClient.swift');
  assert.match(notes, /fetchVisionHealth/);
  assert.match(notes, /recognizeImage/);
  assert.match(notes, /analyzeImage/);
  assert.match(notes, /visionOCRURL|visionHealthURL|visionAnalyzeURL/);
  assert.match(notes, /appendingPathComponent\("vision"\)/);
  assert.match(notes, /ocrText/, 'quick note 缺少 OCR 参数');
  assert.match(notes, /visionCaption/, 'quick note 缺少画面理解参数');

  // 设置 / 菜单 / 主流程
  const settings = readSource('Settings.swift');
  assert.match(settings, /notesOCR/);
  assert.match(settings, /notesVision/);
  const main = readSource('main.swift');
  assert.match(main, /识别画面文字（OCR/);
  assert.match(main, /画面理解（VLM/);
  assert.match(main, /visionStatusMenuItem|视觉：/);
  assert.match(main, /refreshVisionHealth/);
  assert.match(main, /--notes-vision/);
  assert.match(main, /画面理解中/);
  const selfTest = readSource('SelfTest.swift');
  for (const must of ['checkVision()', 'VisionText', 'VisionPlanner', 'VisionHealthParser', 'vision/ocr 请求体', '（OCR）']) {
    assert.ok(selfTest.includes(must), `SelfTest.swift 缺少 v0.5 检查：${must}`);
  }
});

test('macos: v0.4 ⌥N 快捷笔记（NotesClient / 全局热键 / 截图 / 离线队列 / 菜单）', () => {
  // Notes API 客户端：quick + assets + 离线队列 + macos source
  const notes = readSource('NotesClient.swift');
  assert.match(notes, /api.*notes.*quick|api\/notes\/quick|QuickNoteRequest/, '缺少 quick note 请求');
  assert.match(notes, /assetsURL|api\/notes\/assets/, '缺少 assets 上传');
  assert.match(notes, /NoteVideoRef/);
  assert.match(notes, /NoteQuote/);
  assert.match(notes, /static let source = "macos"/);
  assert.match(notes, /UserDefaultsNotesStore/);
  assert.match(notes, /NotesOfflineQueue/);
  assert.match(notes, /static let maxItems = 50/);
  assert.match(notes, /flushOfflineQueue/);
  assert.match(notes, /imageUrl/);
  assert.match(notes, /relativeAssetPath|isValidAssetPath/, 'imageUrl 必须按服务端契约用相对路径');
  assert.match(notes, /formatSessionTime/, '缺少会话时间格式化');
  assert.match(notes, /formatClock/, '缺少墙钟时间格式化');
  assert.match(notes, /deriveVideoTitle/, '缺少视频标题推导');
  assert.match(notes, /deriveVideoID/, '缺少视频 id 推导');

  // 全局热键：Carbon（不依赖第三方 / 不需要辅助功能）
  const hotkey = readSource('HotKey.swift');
  assert.match(hotkey, /RegisterEventHotKey/);
  assert.match(hotkey, /kVK_ANSI_N/);
  assert.match(hotkey, /optionKey/);
  assert.match(hotkey, /⌥N/);
  assert.doesNotMatch(hotkey, /import (?!Carbon|Foundation)/, '热键只允许系统框架');

  // 截图：SCScreenshotManager + 4MB 上限 + 降级决策
  const screenshot = readSource('Screenshot.swift');
  assert.match(screenshot, /SCScreenshotManager\.captureImage/);
  assert.match(screenshot, /maxAssetBytes = 4 \* 1024 \* 1024/);
  assert.match(screenshot, /ScreenshotPlanner/);
  assert.match(screenshot, /textOnly/);
  assert.match(screenshot, /CGPreflightScreenCaptureAccess/, '截图应复用屏幕录制权限');

  // 浮层 toast + 菜单/设置接入
  const overlay = readSource('OverlayWindow.swift');
  assert.match(overlay, /showToast/);
  assert.match(overlay, /已记录/);
  const main = readSource('main.swift');
  assert.match(main, /GlobalHotKey\.shared/);
  assert.match(main, /takeNote/);
  assert.match(main, /--note-once/);
  assert.match(main, /openNotesPanel|studioNotesURL/);
  assert.match(main, /打开笔记/);
  assert.match(main, /打开工作台/);
  const settings = readSource('Settings.swift');
  assert.match(settings, /notesIncludeScreenshot/);
  assert.match(settings, /notesWhenPaused/);
});

test('macos: Notes API 端点在引擎侧存在（与 T4 契约对齐）', () => {
  const server = read('engine/server.mjs');
  assert.match(server, /\/api\/notes\/quick/, '引擎缺少 POST /api/notes/quick');
  assert.match(server, /\/api\/notes\/assets/, '引擎缺少 POST /api/notes/assets');
  assert.match(server, /NOTE_SOURCES[^;]*'macos'/, 'Notes source 枚举应包含 macos');
});

test('macos: v0.4 笔记文案/队列常量在 self-test 中覆盖', () => {
  const selfTest = readSource('SelfTest.swift');
  for (const must of [
    'checkNotes()',
    'Notes HTTP',
    'formatSessionTime',
    'deriveVideoTitle',
    'NotesOfflineQueue',
    'InMemoryNotesStore',
    'ScreenshotPlanner',
    'GlobalHotKey.displayName',
    '（无字幕）',
    'quick note',
    '离线队列',
  ]) {
    assert.ok(selfTest.includes(must), `SelfTest.swift 缺少 v0.4 检查：${must}`);
  }
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
    // v0.4 快捷笔记工作流
    '⌥N',
    '笔记',
    'data/notes',
    '离线',
    '按 ⌥N',
    // v0.5 画面文字/画面理解
    '画面文字',
    'OCR',
    '画面理解',
    'VLM',
    'api/vision',
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
    const match = output.match(/self-test: (\d+) checks passed/);
    assert.ok(match, '构建输出缺少 self-test 统计');
    assert.ok(Number(match[1]) >= 150, `self-test 项数应 >= 150（v0.5 含视觉检查），实际 ${match[1]}`);
    assert.ok(existsSync(path.join(APP_DIR, 'build', 'livedub.app', 'Contents', 'MacOS', 'livedub')));
  },
);
