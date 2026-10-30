# Changelog

All notable changes to livedub are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/), versioning: [SemVer](https://semver.org/).

## [0.7.0] - 2026-10-30

前端设计优化：统一三端设计语言，工作台布局重构与命令面板，笔记工作区、扩展浮层/面板/popup、macOS 悬浮窗与设置面板。

### Added

- 设计规范 [docs/DESIGN.md](docs/DESIGN.md)（tokens / 组件 / 三端布局 / 可访问性清单）。
- 工作台：设计系统 tokens、顶部状态栏 + 视频/字幕舞台 + 可折叠 dock（字幕/笔记/设置）、底部控制条、
  笔记 list+editor 工作区（过滤/搜索/章节分组/保存态/图片 lightbox）、命令面板 ⌘K（16 条命令）、
  快捷键帮助 `?`、toast 堆叠、章节生成 5 步进度、≤1100px 底部 sheet / ≤720px 单列、replay 页统一；39 单测。
- Chrome 扩展：字幕浮层重设计（accent 进度线/状态 pill/玻璃质感/悬停控制条/宽窄两档）、面板分段
  （字幕/笔记/设置，aria tablist + 方向键）、笔记按钮进度态、popup 重设计、亮暗自适应与 reduced-motion；
  新增离线 UI 预览页（extension/preview）；100 单测。
- macOS：浮层材质（NSVisualEffectView）/22–26pt 字号层级/状态 pill/悬停工具条、独立设置窗口
  （字幕/浮层/音频/笔记视觉/引擎，即时生效）、菜单栏分区重设计、toast 重设计；self-test 273 项。

### Changed

- 版本 0.7.0；三端共用 jade/ink 色板、字体栈、圆角/阴影/动效 tokens；可访问性（焦点环/aria/命中区/reduced-motion）。

## [0.6.0] - 2026-10-30

章节化图文笔记、画面 OCR 辅助翻译、Obsidian 自动同步。

### Added

- **章节图文笔记**：按字幕停顿 + 画面变化自动分章，逐章生成 OCR/画面理解/总结的 `kind:'visual'` 笔记，
  并生成 `kind:'outline'` 课程总览（章节时间锚点）。实测 demo 52s → 2 章 + 总览、7 张截图、约 42s。
- **画面 OCR 作为翻译上下文**：客户端可通过 WS `visual-context` 推送最近画面文字（TTL 120s、去重、仅参考），
  翻译 prompt 注入术语/公式语境；工作台/Mac App 可选开启（默认关闭）。
- **Obsidian 自动同步**：`notes.obsidian` 配置 vault 目录，导出 Markdown + 截图资产（相对路径）+ 索引文件；
  笔记保存后 debounce ~1s 自动同步（可关），工作台显示同步状态与路径。

### Changed

- 版本 0.6.0；Notes/Vision/WS 契约文档同步（§7.6/§7.8）。

## [0.5.0] - 2026-10-30

视频画面理解 → 音频 + 画面双重内容的图文笔记。

### Added

- **视觉能力层**（`engine/vision/`）：本地 macOS Vision OCR（Swift helper，~1s/帧、离线）、
  OpenAI 兼容 VLM 画面理解（默认 ark-plan/doubao，可选/批量）、文本 LLM 图文总结；
  配置 `vision.{provider,model,prompt,ocr,summary,keyframe}`；`npm run build:ocr`。
- **视觉端点**：`/api/vision/ocr`、`/api/vision/analyze?mode=ocr|vision|both`、
  `/api/vision/summarize`、`/api/vision/health`（raw PNG 或本机 asset 相对路径；防穿越/大小限制）。
- **工作台「图文笔记」**：范围选择 → 关键帧采样（画面差异去重）→ 本地 OCR（默认快）→
  可选 VLM 拼图理解（慢，默认关）→ 字幕+画面综合总结 → 自动生成 `kind:'visual'` 图文笔记
  （时间线截图/画面文字/画面理解/双语引用 + 本节总结与要点）；笔记编辑区可「捕获当前画面」。
- **快捷笔记增强**：扩展 `Alt+Shift+N` / macOS `⌥N` 截图后自动 OCR，把「画面文字」写入笔记正文；
  CLI `npm run note -- ... --screenshot` 同样自动带画面文字（`--vision` 可加画面理解）。

### Changed

- 版本 0.5.0；notes 相关文档更新（docs/NOTES.md「图文笔记：画面理解」、docs/CONTRACTS.md §7.7）。

## [0.4.0] - 2026-10-30

看视频边实现边写笔记。

### Added

- **学习笔记 / Notes API**（`engine/server.mjs`）：笔记 CRUD、`/api/notes/quick` 快捷追加、
  PNG 资产、Markdown 导出到 `data/exports/`；数据只落本机 `data/notes/`（gitignore）。
- **工作台学习笔记面板**：按 `N` 在当前时间新建、Markdown 编辑+预览、插入当前双语字幕/时间戳/
  代码块/视频截图、自动保存、搜索、点击笔记 seek 回放、生成课程大纲、复制/下载/写文件导出、
  **画中画（PiP）** 边看边写。
- **Chrome 扩展快捷笔记**：`Alt+Shift+N` 记录当前句双语字幕 + 时间戳 +（可选）页面截图，
  离线队列、popup 今日笔记数/打开笔记本/导出 Markdown。
- **macOS App 全局笔记**：`⌥N` 全局热键（无第三方依赖）、可选屏幕截图（SCScreenshotManager）、
  离线队列、菜单栏入口。
- **CLI**：`npm run note -- "..."`（`scripts/note.mjs`），支持视频/时间/标签/截图，
  引擎离线时自动写 `data/notes/quick-YYYY-MM-DD.md`。
- 文档：[docs/NOTES.md](docs/NOTES.md)（三种工作流 / Obsidian 集成 / 隐私）。

### Changed

- 版本 0.4.0；package scripts 增加 `note`。

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
