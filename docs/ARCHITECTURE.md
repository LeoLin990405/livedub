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
┌──────────────── 实测 e2eLagMs 中位 3.4s（本机 52.7s 示例课）──────────┐
```

为什么不是「全句译完才配音」：长句等待会累积到 3–5s。livedub 在**子句级**触发 TTS，让第一声尽快出来，后面子句边译边补。

## 4. 关键模块

### 4.1 ASR（`engine/asr` + `engine/segmenter.mjs`）

- 能量 VAD + 自适应阈值，帧长 20ms；支持 pre-roll（保留句首前 200ms）和 tail pad（句尾补 150ms），避免吞字；
- 句尾静音 300ms 或句长超 7s 触发 final；
- 句内每 ~1.5s 对最近 9s 窗口做一次「滚动 partial」，partial 是覆盖式字幕；
- `/inference` 带**领域初始 prompt**（如 gradient descent / loss function / learning rate），显著减少教学术语错词；线程数默认 8；
- 常驻 `whisper-server` 进程复用模型；会话关闭不杀进程，进程崩溃自动重启。
- 延迟旋钮：换 `ggml-small` 可把 7s 段推理从 ~1.6s 压到 ~0.55s（e2e 约再快 1s，术语准确率略降），见 `docs/MEASUREMENTS.md`。

### 4.2 翻译（`engine/translate`）

- 每句一次流式 chat/completions；prompt 约束「忠实、口语化、可直接朗读、不解释、保留公式/标识符」；
- 注入最近 3 句的双语上下文 + 术语表（强约束）；
- `chain` 顺序 failover；每个 provider 有超时与 AbortSignal，失败不阻塞后续句子。

### 4.3 TTS 与音色（`engine/tts` + `engine/voice.mjs`）

- MiniMax `t2a_v2` 优先请求 `format:pcm`（省掉 mp3 解码），流式 SSE 边到边发；
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
本机 52.7s 示例课实测（M2 / 16GB）：ASR 中位 2.1s、翻译首字 0.8s、TTS 首包 0.2s、**e2e 中位 3.4s**；
逐句表格与模型对比见 [MEASUREMENTS.md](MEASUREMENTS.md)。
调参（VAD 阈值、partial 间隔、TTS 切块长度、调度阈值）后重跑即可对比。
