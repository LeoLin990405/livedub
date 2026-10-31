# 架构与实时性设计

## 1. 进程拓扑

```text
┌──────────────────────────┐         ┌─────────────────────────────┐
│ Chrome 扩展 (MV3)         │         │ 本地工作台 studio/           │
│  background: tabCapture  │         │  <video> + Web Audio 采集    │
│  offscreen: 16k PCM/WS   │         │  字幕浮层 + 配音播放          │
│  content: 浮层/压音       │         │                              │
└────────────┬─────────────┘         └──────────────┬──────────────┘
             │  WS /ws（JSON 事件 + 二进制音频帧）                     │
             ▼                                                       ▼
┌────────────────────────────────────────────────────────────────────┐
│ engine/server.mjs   127.0.0.1:8787                                 │
│  ├─ Session（engine/pipeline.mjs）：每连接一个会话                  │
│  ├─ ASR:        本地 whisper-server（常驻，端口 18765）             │
│  ├─ Translator: deepseek / minimax / mimo（OpenAI 兼容流式）        │
│  ├─ TTS:        MiniMax speech-2.8-hd（PCM 流式）/ macOS say        │
│  ├─ Voice:      clone-first → preset 降级                          │
│  └─ Scheduler:  配音落后加速/丢弃 + 压音区间                         │
└────────────────────────────────────────────────────────────────────┘
```

零 npm 依赖：WS 服务端（`engine/ws.mjs`）、HTTP、音频处理、SSE 解析全部用 Node 内置能力实现。
课程页解析在 `engine/page/parse.mjs`：工作台把课程页交给本地引擎抓取，浏览器不直接请求外站。YouTube / B 站只取带时间轴的字幕。

## 2. 时间轴约定（实时性的基础）

- 客户端给每段 100ms 音频打上 `tMs`（网页是 `video.currentTime*1000`）；
- 引擎以**第一段音频**为 0 建立会话时间轴，所有事件（`segment.t0Ms/t1Ms`、`dub.startMs`）都在这个轴上；
- 客户端播放配音时按 `startMs` 对齐；来不及播放就立即播（同传允许滞后，不允许断流）；
- 音频统一 **s16le / mono / 16kHz**；二进制帧布局 `[0x01][float64BE tMs][pcm]`。

## 3. 单句时序

```text
音频 ──VAD──▶ 语音段开始 …… 语音段结束(句中停顿 300ms)
                                   │
                                   ├─ ASR final（whisper，≈0.5-1s）
                                   │     └─ 字幕原文立即上屏
                                   ├─ 翻译首 token（deepseek 流式，≈1s）──▶ 字幕译文流式刷新
                                   ├─ 第一个子句译完 ──▶ TTS 流式合成 ──▶ 配音首包（≈1s）
                                   ├─ 原声 duck 到 18%，播放中文配音
                                   └─ metrics 事件：asrFinalMs / mtFirstMs / ttsFirstMs / e2eLagMs
┌──────────── 实测 e2eLagMs 中位 3.0s（快速档 2.4s，本机 52.7s 示例课）────────────┐
```

为什么不是「全句译完才配音」：长句等待会累积到 3–5s。livedub 在**子句级**触发 TTS，让第一声尽快出来，后面子句边译边补。

## 4. 关键模块

### 4.1 ASR（`engine/asr` + `engine/segmenter.mjs`）

- 能量 VAD + 自适应阈值，帧长 20ms；支持 pre-roll（保留句首前 200ms）和 tail pad（句尾补 150ms），避免吞字；
- 句尾静音 300ms 或句长超 7s 触发 final；
- **partial 默认关闭**：每次 partial 推理同样占用 whisper 串行队列（~1.4s），实测会把 final 推后 ~0.8–1.1s；需要「字幕边听边长」可在 config 开启 `asr.whisper.partial.enabled`；
- 失败的「speculative final」实验：推理 1.4s ≫ 静音确认 280ms，只会增加队列争用（实测 e2e +0.7s），因此默认关闭，仅保留 opt-in + 推理耗时门限；
- `/inference` 带**领域初始 prompt**（如 gradient descent / loss function / learning rate），显著减少教学术语错词；线程数默认 8；
- 常驻 `whisper-server` 进程复用模型；会话关闭不杀进程，进程崩溃自动重启。
- 延迟旋钮：`LIVEDUB_PROFILE=fast`（或 `npm run start:fast`）换 `ggml-small`，7s 段推理 ~1.6s→~0.55s，e2e 3.0s→~2.4s，术语准确率略降，见 `docs/MEASUREMENTS.md`。

### 4.2 翻译（`engine/translate`）

- 每句一次流式 chat/completions；prompt 约束「忠实、口语化、可直接朗读、不解释、保留公式/标识符」；
- **翻译流式 × TTS 重叠**：`createClauseExtractor` 在 partial 译文里提取已稳定子句，先合成配音，不等整句译完（慢 provider 下实测首包提前 ~300ms）；
- 注入最近 3 句的双语上下文 + 术语表（强约束）；
- `chain` 顺序 failover；每个 provider 有超时与 AbortSignal，失败不阻塞后续句子。

### 4.3 TTS 与音色（`engine/tts` + `engine/voice.mjs`）

- MiniMax `t2a_v2` 优先请求 `format:pcm`（省掉 mp3 解码），流式 SSE 边到边发；会话启动时后台 `warmup()` 预热连接与音色列表；
- LRU 缓存同一音色/语速/文本的合成结果（教学高频重复短语），实测 cache hit 0ms vs miss ~0.9s；支持 abort 中断在途合成；
- `splitForTts` 按中英标点/长度切片，避免 TTS 一口气等整段；
- 克隆流程：会话累积讲师语音样本（≥`clone.minSampleSec`）→ 上传/克隆一次 → 成功则切克隆音色，失败**只记录一次 reason** 并永久降级 preset；
- 无 key/断网兜底：`macOS say`（Tingting 等中文音色）。

### 4.4 调度与混音（`engine/dub/scheduler.mjs`）

- `plan({readyAtMs, durationMs, lagMs})`：正常播放 / 加速追赶（≤1.25x）/ 丢弃过期块；
- 客户端负责真正混音：`dub` 音频入队按 `startMs` 播放，`status=speaking` 时原声降到 `duckOriginal`；
- 离线批处理用同一套数据生成混音轨：原声按配音区间 duck + 中文配音叠加，ffmpeg 编码 AAC。

### 4.5 失败隔离

| 故障 | 表现 | 系统行为 |
|---|---|---|
| whisper 崩溃 | ASR 超时 | 自动重启服务；当前句跳过并 emit `error(asr)`；字幕/其余链路继续 |
| 翻译全链失败 | 该句无译文 | emit `error(translate)`，保留原文，不配音 |
| TTS/克隆失败 | 该句无配音 | emit `error(tts)`，双语字幕照常；克隆失败自动降级 preset |
| 网络抖动 | 首字变慢 | 字幕先出原文，译文到达后覆盖；不会阻塞音频接收 |

## 5. 线协议（摘要）

完整定义见 [CONTRACTS.md](CONTRACTS.md)。要点：

- 客户端→引擎：`hello`（会话/语言/术语表）、二进制音频帧、`control`（pause/resume/seek/flush/stop）、`config`、`glossary`、`ping`；
- 引擎→客户端：`ready`、`status`、`partial`、`segment`、`translation`、`dub`、`voice`、`metrics`、`error`、`pong`、`bye`。

## 6. 安全边界

- 只绑定 `127.0.0.1`；WS `checkOrigin` 只接受 `chrome-extension://*` 与 `http://127.0.0.1/localhost`；
- `/api/config` 输出必须走 `publicConfig()`（删掉所有 apiKey）；
- 静态服务只允许白名单目录（`studio/`、`demo/`），防目录穿越；
- 密钥只在运行时从环境变量/`~/.sayless/config.json`/配置文件读取，不写回、不打日志。

## 7. 扩展端抓声流程（MV3）

```text
点击图标（用户手势）
  → chrome.tabCapture.getMediaStreamId({targetTabId})
  → chrome.offscreen.createDocument({reasons:['USER_MEDIA','AUDIO_PLAYBACK']})
  → offscreen: getUserMedia(chromeMediaSource:'tab', streamId)
  → AudioContext({sampleRate:16000}) → AudioWorklet（100ms 块）
  → WebSocket 二进制帧 → 引擎
  ← 事件：partial/segment/translation 转发 content script；dub 在 offscreen 播放
  → content script：Shadow DOM 字幕浮层 + 原声 duck；停止时恢复所有 video/audio 音量
```

## 8. 为什么不用「一句话一请求大模型」简单方案

- 延迟不可控：整段 ASR + 整段翻译 + 整段 TTS 串行，首声要 4–6s；
- 字幕不同步：字幕只能等整段结束才出现；
- 无法处理讲课的连续长句：本项目用 VAD 句尾 + 子句切块 + 流式 token 把等待拆散。

## 9. 评估方式

`npm run batch` 会对示例视频跑完整真实链路，输出 `demo/metrics.json`：
每句的 asrFinalMs / mtFirstMs / mtDoneMs / ttsFirstMs / e2eLagMs，以及中位数汇总。
本机 52.7s 示例课实测（M2 / 16GB）：ASR 中位 1.8s、翻译首字 0.8s、TTS 首包 0.25s、**e2e 中位 3.0s**（快速档 2.4s）；
逐句表格、失败的 speculative-final 实验与 partial A/B 数据见 [MEASUREMENTS.md](MEASUREMENTS.md)。
调参（VAD 阈值、partial 间隔、TTS 切块长度、调度阈值）后重跑即可对比。

## 10. v0.3 新增组件

### 10.1 云端 ASR（MiniMax asr-1.0）

- 新 provider `minimax-cloud`（`engine/asr/minimax-cloud.mjs`）：仍用本地 VAD 切句，每个 final 段上传 WAV（16k mono）到
  `POST /v1/speech_to_text`（multipart `model=asr-1.0`，可选 `language` header），解析 `{ text }`。
- 延迟：4s 音频 ≈0.79s、12s ≈1.0–1.2s（含上传/网络），比本地 whisper 的 ~1.4s 快。
- **隐私**：音频会上传。默认档仍是本地 whisper。`LIVEDUB_PROFILE=cloud` 现在指向 `stream-cloud`（一条流式识别，失败后同一会话降级本地 whisper）。`minimax-cloud` 仍是上面的整段上传 provider。
- 失败降级：网络/401/超时/空文本 → 本段自动切 `asr.fallback`（本地 whisper 懒创建），连续失败熔断；云端可用时后台可预热本地兜底。流式识别器断开时同样降级，并且不结束会话。

### 10.2 火山引擎 TTS + 声音复刻 v3（真正原声克隆）

- provider `volcengine`（`engine/tts/index.mjs`）：
  - TTS v3：`POST /api/v3/tts/unidirectional`，NDJSON 流式（`data` base64 → PCM 24k），`X-Api-Resource-Id` 按音色代际自动推断；
  - 声音复刻 v3：`POST /api/v3/tts/voice_clone`（`speaker_id` + 讲师音频 base64 WAV），status=2/4 可用、1=训练中；
  - 凭据必须是**豆包语音控制台 UUID Key**（方舟 `ark-` Key 不适用，实测 401）。
- `engine/voice.mjs` 克隆候选链 `tts.clone.chain`（默认 minimax → volcengine）：逐家尝试、失败只记一次原因，全失败降级 preset；`voice` 事件带每家原因。

### 10.3 macOS 桌面悬浮窗（ScreenCaptureKit 原生 App）

```text
apps/macos/  Swift (无第三方依赖)
  菜单栏 App ── SCStream 抓系统/应用音频（音频 only）
             ── CMSampleBuffer → 16kHz mono s16le → 100ms 帧
             ── URLSessionWebSocketTask → ws://127.0.0.1:8787/ws（线协议与浏览器端一致）
             ← 事件：partial/segment/translation/dub/status/…
  悬浮层：NSPanel（无边框/透明/置顶/可拖动/点击穿透），双语字幕两行 + 状态/延迟
  配音：AVAudioEngine + AVAudioPlayerNode 调度 24k PCM（按 startMs 顺序）
```

覆盖 Zoom/腾讯会议/本地播放器等浏览器之外的场景；含 `--simulate`（无权限演示 UI）与 `--self-test`（协议/帧自检）。
限制：系统音频不会被静音 → 原声与配音同时存在（可先静音播放器；后续可用虚拟声卡方案）。

### 10.4 扩展：全局限定压音 + 裸视频全屏

- Chrome `tabCapture` 会静音标签页本身，声音只在 capture stream 中：offscreen 把原声经 GainNode 回放，
  `status=speaking` 时 160ms 渐变 duck 到设定比例，空闲恢复 → **iframe / WebAudio 站点也能压原声**（不再依赖 DOM 音量）。
- 裸 `<video>` 原生全屏无法叠加 DOM：content script 在 MAIN world 猴补 `requestFullscreen`，对替换元素先包一层容器再对容器全屏；
  退出/失败自动回滚（`settings.fullscreenWorkaround`，默认开）。

## 11. v0.5 视频画面理解（图文笔记）

```text
工作台（canvas 抽帧）
  ├─ 关键帧：每 6s 采样 + 64×36 灰度差异去重（minChange 0.035，最多 24 帧）
  ├─ 每帧 → PNG → assets → /api/vision/ocr（本地 macOS Vision，~1s/帧，离线）
  ├─ 可选批量 → 2×3 拼图 → /api/vision/analyze?mode=vision
  │        （OpenAI 兼容视觉模型，默认 ark-plan/doubao；单帧 20-30s，默认关闭）
  └─ transcript(字幕) + visuals(OCR/描述) → /api/vision/summarize（deepseek）
        → 「本条总结 + 要点 + 按时间线的截图/画面文字/双语引用」Markdown → Notes API 保存
```

- **本地 OCR**：`scripts/ocr-macos.swift`（Vision VNRecognizeTextRequest，en-US/zh-Hans）编译为 `data/bin/ocr-macos`；
  缺失时回退 `tesseract`（仅 eng）。构建：`npm run build:ocr`。
- **VLM**：`engine/vision/index.mjs` 调用 `config.vision.provider`（默认 ark-plan）的 OpenAI 兼容 `image_url`；
  未配置 Key 时只有 OCR，不影响笔记。
- **总结**：文本 LLM（默认 deepseek）消费字幕+画面文字/描述，输出中文总结与 3-6 要点。
- **快捷笔记**：扩展 `Alt+Shift+N` / macOS `⌥N` 的截图会自动做 OCR，把「画面文字」追加进正文（VLM 可选）。
- 实测（M2）：OCR serve 首帧 ~0.65–1.5s、后续 0.2–1.5s/帧；VLM 单帧 20.3–21.9s、6 帧拼图 38.7s；总结 2–6s；demo 3 帧图文笔记 ~10s。
- 局限：VLM 慢且按调用计费，默认只做 OCR；DRM/跨域画面可能截不到；OCR 质量取决于画面清晰度。

## 12. v0.6：章节图文笔记 / 画面 OCR 翻译上下文 / Obsidian 同步

- **章节图文笔记**：工作台用「字幕间隙 >2.5s + 画面变化点」把视频切成章节（20s–180s，最多 30 章），
  每章独立采样/OCR/总结并保存为一篇 `kind:'visual'` 笔记，最后生成 `kind:'outline'` 课程总览（章节时间锚点）。
  实测 demo 52s → 2 章 + 总览、7 张截图、约 42s。
- **画面上下文翻译**：客户端（工作台/桌面端）每 8–10s 把当前画面 OCR 通过 WS `visual-context` 推给引擎；
  引擎保存 TTL 120s 的最近一条，翻译时作为「仅术语/语境参考」注入 prompt；`seek` 清空。
- **Obsidian 同步**：`notes.obsidian.{enabled,dir,assetsSubdir,autoExport}`；导出 Markdown 到 vault、
  复制截图资产并改写相对路径、维护 `livedub-notes-index.md`；启用 autoExport 时笔记增删改后 debounce(~1s) 自动同步。
