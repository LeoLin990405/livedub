# livedub macOS 菜单栏 App（ScreenCaptureKit 系统音频）

浏览器之外的「同传耳机」：**抓取系统 / 任意 App 的音频**（Zoom、腾讯会议、本地播放器、浏览器……）
→ 发送给本机 livedub 引擎 → 桌面**置顶双语字幕浮层 + 中文配音**。

- 和 Chrome 扩展（只抓网页标签页）、本地工作台（只处理本地文件）互补，三端共用同一套线协议：
  [`docs/CONTRACTS.md`](../../docs/CONTRACTS.md) §3 / [`engine/protocol.mjs`](../../engine/protocol.mjs)。
- 原生 Swift，零第三方依赖：只用系统框架 `ScreenCaptureKit` / `AVFoundation` / `AppKit` / `Foundation`。
- 扫描线：`SCShareableContent` → `SCStream(capturesAudio=true)` → CMSampleBuffer → **16k mono s16le / 100ms 帧** → 本地引擎 WS。
- 引擎返回 `partial/segment/translation/dub/metrics/status/voice/error` → 浮层字幕 + `AVAudioEngine` 配音。

## 目录结构

```text
apps/macos/
├── Sources/
│   ├── main.swift                 # 入口：参数解析、NSApplication、菜单栏、会话编排、--simulate
│   ├── ScreenAudioCapture.swift   # ScreenCaptureKit 只抓音频：CMSampleBuffer -> mono float -> 16k s16le -> 100ms 分帧
│   ├── EngineClient.swift         # URLSessionWebSocketTask：hello / 二进制帧 / 事件解析 / 指数退避重连 / ping
│   ├── OverlayWindow.swift        # NSPanel 透明置顶浮层：译文+原文+状态/延迟，可拖动、可选点击穿透
│   ├── DubPlayer.swift            # AVAudioEngine + AVAudioPlayerNode：24k PCM 按 startMs 排序播放
│   ├── Settings.swift             # UserDefaults：引擎地址 / 字号 / 浮层位置 / 点击穿透 / 配音开关
│   ├── Protocol.swift             # 线协议 Swift 镜像（帧编解码、hello、事件解析、字幕折行、重采样）
│   └── SelfTest.swift             # --self-test headless 自检 + --simulate 演示语料
├── Info.plist                     # LSUIElement=true（菜单栏 App）、NSScreenCaptureUsageDescription 等
├── README.md                      # 本文件
└── build/                         # 构建产物（.gitignore 已忽略）
scripts/build-macos.sh             # 构建脚本（swiftc -O -> livedub.app，--check 跑自检）
tests/macos.test.mjs               # 静态契约测试（CI 跨平台，不依赖 swiftc）
```

## 环境要求

| 依赖 | 要求 | 说明 |
|---|---|---|
| macOS | **14+**（Sonoma 及以上） | ScreenCaptureKit 音频捕获 API |
| Swift | `/usr/bin/swiftc`（Swift 5.10 实测） | 只需 Command Line Tools：`xcode-select --install`；**不需要完整 Xcode** |
| 引擎 | Node ≥ 22 + 本地 livedub 引擎 | 同仓库 `node engine/server.mjs`（默认 `ws://127.0.0.1:8787/ws`） |
| 第三方依赖 | **零** | 不使用 SPM / CocoaPods / xcodebuild 工程 / npm 包 |

## 构建

```bash
cd livedub

# 构建 .app（默认）
bash scripts/build-macos.sh
#   -> apps/macos/build/livedub.app
#      Contents/MacOS/livedub
#      Contents/Info.plist
#      Contents/PkgInfo

# 编译 + headless 自检（提交前 / CI 用；失败退出码 1）
bash scripts/build-macos.sh --check

# 清理构建产物
bash scripts/build-macos.sh --clean
```

- 可覆盖环境变量：`SWIFTC=/path/to/swiftc`、`MACOS_TARGET=arm64-apple-macos14.0`。
- 脚本只显式链接系统框架：`AppKit` / `AVFoundation` / `CoreMedia` / `CoreGraphics` / `ScreenCaptureKit`。
- 构建末尾会做 **ad-hoc 签名**（`codesign --force --sign -`），便于 `open` 正常启动；App 未公证。
- 本机实测（Swift 5.10 / macOS 14.8.9，Apple Silicon）：编译约 **6s**、可执行文件 **403 KB**、bundle **416 KB**。

## 运行

### 1. 启动本地引擎（真实同传需要）

```bash
node engine/server.mjs          # 或 npm start / npm run studio
# 健康检查：curl http://127.0.0.1:8787/health
```

### 2. 启动 App

```bash
open apps/macos/build/livedub.app
```

菜单栏出现字幕气泡图标（**没有 Dock 图标**，这是菜单栏 App 的预期形态）。
点菜单栏图标 → **开始同传** → 首次会提示授予「屏幕录制」权限。

### 3. 直接运行二进制（调试 / 冒烟）

```bash
BIN=apps/macos/build/livedub.app/Contents/MacOS/livedub

"$BIN" --self-test                 # headless 自检，退出码 0/1（不建窗口、不请求权限）
"$BIN" --simulate --duration 10    # 无权限/无引擎演示 UI（自动退出便于冒烟）
"$BIN" --autostart --duration 15   # 自动开始同传，15s 后自动退出
"$BIN" --engine-url ws://127.0.0.1:8787/ws --autostart
"$BIN" --help
```

| 参数 | 说明 |
|---|---|
| `--simulate` | 不抓音频、不连引擎，循环演示中英字幕/状态/延迟（无权限环境验证 UI） |
| `--autostart` | 启动后自动点一次「开始同传」（适合登录项 / 自动化冒烟） |
| `--duration <秒>` | N 秒后自动退出（调试用） |
| `--engine-url <url>` | 覆盖引擎地址并持久化 |
| `--self-test` | headless 自检：协议字节布局 / hello / 事件解析 / 字幕排版 / 重采样 / 分帧 |
| `-h, --help` | 帮助 |

### 菜单栏功能

| 菜单项 | 行为 |
|---|---|
| 状态：… | 当前状态 + 引擎地址（只读展示） |
| 开始 / 停止同传 | 连接引擎 + 开始系统音频捕获；再次点击停止 |
| 显示 / 隐藏字幕浮层 | 浮层显隐 |
| 字幕点击穿透 | 开启后鼠标事件穿透浮层（可点下面的窗口），此时浮层不能拖动 |
| 播放中文配音 | 配音开关（关闭后只看字幕；原声不受影响） |
| 显示原文行 | 原文行显隐 |
| 增大 / 减小字幕字号 | 即时生效并持久化 |
| 设置引擎地址… | 修改 WS 地址，保存后自动重连 |
| 打开屏幕录制权限设置… | 直达 系统设置 → 隐私与安全性 → 屏幕录制 |
| 重置字幕位置 | 回到屏幕底部居中 |
| 诊断信息… | 连接/丢帧/抓音频帧数/配音统计/最近日志，可一键复制 |
| 退出 livedub | 停止采集与播放后退出 |

浮层：译文大字（最多 2 行）+ 原文小字（1 行）+ 底行状态/延迟；无边框、半透明深色背景、置顶、
`NSPanel(.nonactivatingPanel)` 不抢焦点；**整个浮层可拖动**，位置持久化；多桌面/全屏 App 上也能显示。

## 权限设置（第一次必做）

macOS 用**「屏幕录制」权限**管控系统音频捕获——系统弹窗文案是「录制屏幕」，但 **livedub 只读取音频流，
不截屏、不保存画面**（Info.plist 的 `NSScreenCaptureUsageDescription` 有同样说明）。

1. 菜单栏 livedub → 开始同传；
2. 系统弹窗 / 或菜单「打开屏幕录制权限设置…」→
   **系统设置 → 隐私与安全性 → 屏幕录制** → 勾选 **livedub**；
   （从终端直接运行二进制时，勾选的是启动它的**终端 App**）；
3. 回到 App。若系统要求重启 App，退出再 `open` 一次；App 会每秒轮询权限，授权后自动开始捕获。

实现：`CGPreflightScreenCaptureAccess()` 查询 + `CGRequestScreenCaptureAccess()` 触发系统弹窗。
注意：**重新构建后 ad-hoc 签名 cdhash 变化，屏幕录制权限可能需要重新勾选**（开发期正常现象）。

## 与引擎配合（协议细节）

- 地址：默认 `ws://127.0.0.1:8787/ws`；菜单可改，格式 `ws(s)://host:port/ws`
  （缺 scheme 补 `ws://`、缺端口补 `8787`、缺路径补 `/ws`）。
- `hello`（第一条，JSON 文本帧）：

  ```json
  {"type":"hello","protocol":1,
   "session":{"source":"studio","title":"macOS 系统音频 · livedub app",
              "url":"","langFrom":"en","langTo":"zh","tMsBase":null,"overrides":{}}}
  ```

  契约 §3.1 的 `source` 枚举暂为 `extension|studio|batch|test`，因此 macOS App 复用 `studio`
  （引擎 `normalizeHello` 会回落到 studio）；协议扩展后可直接改成 `macos`。
- 音频（二进制帧，与 `engine/protocol.mjs#encodeAudioFrame` **字节级一致**）：

  ```text
  [0]=0x01 | [1..8]=float64 big-endian tMs | [9..]=s16le 16k mono
  每 100ms 一帧（1600 采样 / 3200 字节 PCM；单帧上限 256KB）
  ```

  采集侧：ScreenCaptureKit 给 48kHz / 2ch / Float32（non-interleaved 或 interleaved）→
  混单声道 → 盒式抗混叠 + 线性插值重采样到 16k → 100ms 分帧。`tMs` 从 0 开始按帧递增。
- 下行事件处理：

  | 事件 | App 行为 |
  |---|---|
  | `ready` | 状态「聆听中」，记录 provider/音色 |
  | `status` | 浮层状态行 / 菜单状态（listening/translating/speaking/paused/error） |
  | `partial` / `segment` | 更新原文行 |
  | `translation` | 更新译文行（流式覆盖） |
  | `dub` | base64 s16le（默认 24kHz）→ `DubPlayer`：按 `startMs` 排序，到点播放；落后 >1.5s 丢弃 |
  | `metrics` | `e2eLagMs` 显示为「延迟 x.xs」 |
  | `voice` | 音色切换/降级提示 |
  | `error` | 状态标红；不可恢复错误弹窗 |
  | `pong` / `bye` | 保活 / 引擎关闭会话 |

- 断线：指数退避重连 **0.5s → 1s → 2s → 4s → 8s**（+0~0.25s 抖动），连接成功后计数归零；
  每次重连重新发 `hello`（新会话）。断线期间音频帧直接丢弃（不排队，避免补发造成延迟堆积）。
- `ping`：连接后每 15s 发 `{"type":"ping","t":...}` + WebSocket 协议级 ping。
- `pause/resume` control 消息已在 `EngineClient.sendControl(_:)` 封装（菜单暂未暴露）。

## 自检 / 测试

```bash
# 1) 编译 + 自检（76 项，退出码 0/1）
bash scripts/build-macos.sh --check

# 2) 静态契约测试（默认跨平台、离线、不跑 swiftc —— CI 在 ubuntu 也能跑）
node --test tests/macos.test.mjs

# 3) 本机完整构建测试（macOS）
LIVEDUB_MACOS_BUILD=1 node --test tests/macos.test.mjs
```

`--self-test` 覆盖（headless，不建窗口 / 不请求权限 / 不联网）：

- 协议常量与 `engine/protocol.mjs` 对齐：`0x01` / `16000` / `100ms` / `256KB` / `24000` / `ws://127.0.0.1:8787/ws`；
- 音频帧字节布局：长度 9+3200、`tMs=1234` 的 IEEE‑754 固定字节向量 `40 93 48 00 00 00 00 00`、
  s16le 小端字节、往返解码、空 PCM / 负 tMs / 超限 / 错误魔数拒绝；
- `hello` JSON 字段（type/protocol/session/source 枚举/tMsBase=null/中文标题）与非法 source 回落；
- 事件解析：`ready/status/partial/segment/translation/dub(base64)/metrics/voice/error/pong/bye/unknown`；
- 字幕折行（ASCII / CJK 双列宽 / 超长 token 硬切 / 最多 2 行省略）、延迟格式（`1.8s` / `—`）、状态文案；
- 16k 100ms 分帧（不足不出帧、tMs 递增、reset）、48k/44.1k → 16k 重采样（长度 / RMS / 静音）；
- 引擎地址清洗（补 scheme/端口/`/ws`、http→ws、非法回落默认）。

## 手动测试清单

> 前置：`bash scripts/build-macos.sh --check` 通过；`node engine/server.mjs` 已启动（除模拟模式）。

- [ ] `--self-test` 退出码 0，输出 `self-test: N checks passed`
- [ ] **模拟模式**：`"$BIN" --simulate --duration 12` → 浮层出现，中文大字 + 英文小字 + 状态 + 延迟轮换；
      菜单「停止模拟演示」可用
- [ ] **引擎未启动**：先不启动引擎，开始同传 → 状态「重连引擎…」，日志出现指数退避；
      启动引擎后 8s 内自动连上（无需重启 App）
- [ ] **真实音频**：播放一段英文播客/视频/Zoom 会议（系统声音）→ 原文行先出、译文随后出现，
      延迟数字约 2–4s（取决于引擎 provider 配置）
- [ ] **配音**：默认开启能听到中文配音；菜单关闭后立即静音（原声继续）
- [ ] **浮层交互**：拖动位置 → 退出重开位置保持；开启点击穿透 → 可点击下层窗口且无法拖动；
      关闭后可拖动；「重置字幕位置」回到底部居中
- [ ] **字号**：增大/减小即时生效，重启后保持
- [ ] **权限**：系统设置取消勾选 livedub → 开始同传 → 出现权限提示；重新授权后自动恢复捕获
- [ ] **断线重连**：`kill` 引擎 → 状态重连；重启引擎 → 自动恢复（不重启 App）
- [ ] **退出**：菜单退出后 `pgrep -fl livedub` 无残留；无 Dock 图标（菜单栏 App 正常形态）

### 验收记录（本机实测，2026-10-29，Swift 5.10 / macOS 14.8.9 / Apple Silicon）

- `bash scripts/build-macos.sh --check`：编译 6s，**self-test 76/76 通过**，退出码 0；
  可执行文件 403 KB，bundle 416 KB。
- `livedub --self-test` 直接运行退出码 0。
- **端到端**（用 `engine/ws.mjs` 起一个临时假引擎，端口 19787，不联网）：
  hello 字段正确；真实 SCK 采集到 48kHz/2ch/float32 系统音频；
  7.4s 内发出 **75 帧、每帧 PCM 3200 字节、tMs 0→7400 递增、坏帧 0**
  （用 `engine/protocol.mjs#decodeAudioFrame` 权威解析校验）。
- **重连**：假引擎每 2.5s 断开一次 → App 自动重连 3 次、每次重新 hello，期间音频帧持续发送。
- **模拟模式 UI**：真实创建菜单栏图标 + 置顶浮层，截图确认译文/原文/状态/延迟渲染正确。

## 已知限制

1. **系统音频不会自动静音 → 原声与中文配音同时存在。**
   这是 ScreenCaptureKit「采集」而非「替换」系统输出的本质限制。缓解：
   把播放器 / Zoom 静音或调低系统音量；后续方案是用虚拟声卡（BlackHole / Loopback）把中文配音
   注入系统输出、原声走静音通道（需要安装音频驱动，本期不做）。
2. **App 未签名 / 未公证**（只有 ad-hoc 签名）：从 Finder 首次打开可能被 Gatekeeper 拦截 →
   右键 → 打开（或 系统设置 → 隐私与安全性 → 仍要打开）。本地构建一般没有 quarantine 标记，
   下载来的副本可 `xattr -dr com.apple.quarantine apps/macos/build/livedub.app`。
3. **重新构建后屏幕录制权限可能需重新勾选**（ad-hoc cdhash 变化，TCC 视为新 App）。
4. SCK 抓的是**显示器混音**：同一显示器上所有 App 的声音会混在一起，暂不支持只抓单个 App
   （`SCContentFilter` 支持按 App 过滤，可作为后续增强）。
5. 需要登录的**图形会话**（WindowServer）；SSH / 无头 / CI 环境无法抓音频
   （`--self-test` 与 `--simulate` 不受影响，仍可运行）。
6. **受 DRM 保护**的音频可能抓不到（与浏览器端 `tabCapture` 的限制类似）。
7. 无自动更新、无开机自启设置面板（可用 `--autostart` + 系统「登录项」手动添加）。
8. 浮层只显示**当前句**（译文最多 2 行、原文 1 行），不提供历史字幕滚动 / SRT 导出
   （历史与导出在工作台 / 扩展端）。
9. 停止同传即结束引擎会话；`pause/resume` control 已封装但菜单未暴露。
10. 识别 / 翻译 / TTS 都在引擎侧：需要本地引擎已启动、whisper 模型就绪、provider 配置可用
    （见根目录 README 与 `docs/PROVIDERS.md`）；App 本身不含模型。

## 故障排查

| 现象 | 排查 |
|---|---|
| 一直「等待屏幕录制权限」 | 系统设置 → 隐私与安全性 → 屏幕录制 勾选 livedub / 启动它的终端；重启 App；构建后权限可能重置 |
| 状态一直「重连引擎…」 | `node engine/server.mjs` 是否在跑、端口 8787 是否被占、菜单里地址是否改错；看引擎终端日志 |
| 有原文没有译文 / 配音 | 引擎 translate / tts provider 配置或 Key 问题（`npm run doctor`、`docs/PROVIDERS.md`） |
| 字幕有、没声音 | 菜单「播放中文配音」是否开；系统输出设备；`--simulate` 本来就不播音频 |
| 浮层挡住操作 | 开「字幕点击穿透」或隐藏浮层；「重置字幕位置」 |
| 某个 App 没声音被识别 | 确认它确实在当前显示器输出、没有静音；DRM 内容抓不到属已知限制 |
| 编译报 `swiftc not found` | `xcode-select --install`；或 `SWIFTC=/path/to/swiftc bash scripts/build-macos.sh` |
| 编译报 SDK/availability 错 | 需要 macOS 14+ SDK；`swiftc --version` 应为 5.10+，`MACOS_TARGET` 默认 `<arch>-apple-macos14.0` |

## 隐私与安全

- 音频只在内存中：系统采集 → `ws://127.0.0.1` 本地引擎，**不落盘、不上传**；App 不截屏、不保存画面。
- 引擎会把**文本**发给配置的云翻译 / TTS provider（与其他端一致，取决于用户配置）。
- 日志只打印状态与计数，不打印 API Key；`--simulate` / `--self-test` 完全离线。

## 相关文档

- 线协议与事件字段：[`docs/CONTRACTS.md`](../../docs/CONTRACTS.md) §3；权威实现 [`engine/protocol.mjs`](../../engine/protocol.mjs)
- 浏览器端：[`extension/README.md`](../../extension/README.md)；本地工作台：根目录 README
- 路线图：[`docs/ROADMAP.md`](../../docs/ROADMAP.md)（v0.3 桌面悬浮窗）
- 构建脚本：[`scripts/build-macos.sh`](../../scripts/build-macos.sh)；静态测试：[`tests/macos.test.mjs`](../../tests/macos.test.mjs)
