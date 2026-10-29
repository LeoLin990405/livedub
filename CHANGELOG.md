# Changelog

All notable changes to livedub are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/), versioning: [SemVer](https://semver.org/).

## [0.3.0] - 2026-10-29

「全部补齐」版本：云端 ASR、火山声音复刻、macOS 桌面悬浮窗、全局限定压音、裸视频全屏。

### Added

- **云端 ASR（MiniMax asr-1.0）**：新增 `minimax-cloud` ASR provider，VAD 切句后整段上传（4s≈0.79s / 12s≈1.0-1.2s），
  失败自动降级本地 whisper；新增 `cloud` 档位（`npm run start:cloud` / `batch:cloud`），工作台显示上云隐私提示。
- **火山引擎 TTS + 声音复刻**：新增 `volcengine` TTS provider（v3 流式 PCM + `voice_clone` v3），
  支持真正的讲师音色克隆（需豆包语音控制台 UUID Key，缺失时给出可读提示并降级 preset）。
- **macOS 桌面悬浮窗**（`apps/macos/`）：ScreenCaptureKit 抓系统/应用音频 + 原生透明字幕浮层 + 中文配音，
  覆盖 Zoom/腾讯会议/本地播放器等浏览器外场景；含 `--simulate` 演示模式与 `--self-test`。
- **扩展全局限定压音**：tabCapture 原声经 GainNode 回放并平滑 duck —— iframe/WebAudio 站点也能压原声。
- **裸视频全屏叠加**：content script 可选包装裸 `<video>` 再全屏，解决原生 video 全屏无法叠加 DOM 的限制。
- 工作台：ASR 引擎切换（本地/云端）、隐私提示、桌面 App 入口、`GET/PUT /api/settings`。
- CI 增加 macOS 构建/自检 job；新增 `scripts/build-macos.sh --check`。

### Changed

- 工作台新增 `GET/PUT /api/settings`（白名单 asr.provider/tts.voiceMode/dub.enabled，下一次会话生效）与隐私提示。
- 延迟档位三档：默认（本地 large）~3.0s、快速（本地 small）~2.4s、**云端（MiniMax ASR）~2.2–2.4s**（52.7s 示例课两次实测：2204/2385ms）。
- 版本 0.3.0。

## [0.2.0] - 2026-10-29

性能与体验迭代 + 开源发布。

### Added

- **翻译流式 × TTS 重叠**：翻译还在流式输出时，已稳定的子句先送 TTS 合成；
  `createClauseExtractor` 保证子句稳定、不重复、不切断数字/代码/URL（慢 provider 下首包实测提前 ~300ms）。
- **TTS 预热与 LRU 缓存**：会话启动后台 `warmup()`（不产生 TTS 计费）；同音色/语速/文本命中缓存（实测 miss ~0.9s → hit 0ms）；
  合成可 abort，会话关闭 4ms 内中止；`speed` 钳制与音色列表 TTL 缓存。
- **快速档**：`LIVEDUB_PROFILE=fast`（`npm run start:fast` / `npm run batch:fast`），small ASR 模型把 e2e 3.0s 压到 ~2.4s。
- **ASR speculative final（opt-in）**：尾部静音提前推理 + 推理耗时门限 + 取消时真正 abort。
- 工作台：明暗主题、字幕样式预设（字号/位置/不透明度）、仅字幕模式、键盘快捷键（Space/S/D/Esc）、
  延迟 sparkline、事件 JSONL 导出、断连引导、回放首帧/poster、窄屏响应式与 aria。
- 扩展：原生全屏浮层迁移、字幕顶部/底部停靠 + Y 偏移避让、背景/透明度、SRT 导出、
  引擎未连接引导、provider/音色/语言与 4 项延迟显示、SW 回收后字幕可恢复。
- 服务端：`server.maxSessions` 并发上限（超出 1013 关闭）、SIGINT/SIGTERM 关闭共享 whisper-server、
  `/health` 报告活跃会话与 whisper 运行状态。
- 批处理：成片配音时间轴重排（按句对齐、不越界、回写 `session.jsonl` 供回放对齐）+ 成片专用 TTS 语速 1.15。
- 开源脚手架：MIT License、CONTRIBUTING、CODE_OF_CONDUCT、SECURITY、CHANGELOG、
  GitHub Actions CI（Node 22/24 + 密钥扫描）、Issue/PR 模板、英文 README、编辑器配置、`scripts/lint.mjs`。

### Changed

- 实测端到端延迟（语音结束 → 中文配音可播，52.7s 示例课）：**3.4s → 3.0s**；快速档 **2.4s**（详见 `docs/MEASUREMENTS.md`）。
- **ASR partial 默认关闭**：partial 推理同样占用 whisper 串行队列，A/B 实测使 e2e 增加 ~0.8s；
  需要「字幕边听边长」可在 config 开启 `asr.whisper.partial.enabled`。
- 翻译 prompt 口语化迭代；术语/公式/代码标识符保护更严格。
- pipeline：ASR 错误转发为 `error(scope:"asr")`、AbortError 不再刷 error、metrics 定义改为「语音结束→配音可播」。

### Fixed

- **speculative final 实测负收益**（推理 1.4s ≫ 静音窗口，只增加队列争用）→ 默认关闭，保留 opt-in 与门限，实验数据记录在 MEASUREMENTS。
- whisper 领域初始 prompt 修复术语错词（loss → law/lost 等）。
- 批处理实时喂入节奏、ASR 冷启动排队、共享 whisper-server 退出清理、成片末句被视频结尾裁掉。
- 烧录字幕卡片与幻灯片文字重叠（底部压暗 + 高不透明度卡片）。

## [0.1.0] - 2026-10-29

首个可运行版本。

### Added

- 本地零依赖 Node 引擎：VAD 切分、whisper-server 流式识别、deepseek 增量翻译、
  MiniMax 流式 TTS（克隆优先 / 自动降级）、配音调度与原声压音、逐句延迟指标。
- Chrome MV3 扩展：tabCapture 抓声、Shadow DOM 双语字幕浮层、中文配音、原声 ducking。
- 本地工作台：本地视频实时同传、延迟 HUD、术语表、SRT 导出、离线会话回放。
- 离线批处理：视频 → 双语 SRT + 中文配音 + 烧录字幕成片 + 可回放事件流。
- 单元测试（node:test，mock 端到端）、`doctor` 环境体检、演示视频生成脚本。
