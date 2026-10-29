# 实测数据（v0.2 · 2026-10-29 · 本机实测）

> 所有数字来自真实链路（不是 mock、不是估算）：`npm run demo:video && npm run batch`。
> 原始数据：`demo/metrics.json`、`demo/session.jsonl`；截图：`docs/assets/`。

## 环境

| 项 | 值 |
|---|---|
| 机器 | Apple M2 / 16GB / macOS 14.8.9 |
| Node | v26.3.1（项目要求 ≥22） |
| ASR | whisper.cpp `whisper-server`（常驻），默认 `ggml-large-v3-turbo-q5_0`（547MB），8 线程，领域初始 prompt |
| 翻译 | deepseek-flash（OpenAI 兼容流式） |
| TTS | MiniMax `speech-2.8-hd`，音色 `male-qn-qingse`（PCM 24kHz 流式） |
| 素材 | `demo/original.mp4`：52.7s 英文公开课（5 页幻灯片 + 英文旁白），共 12 句 |
| 喂入 | 16kHz 单声道，100ms/帧，**1x 实时**（与浏览器扩展/工作台一致） |

## 指标定义

- `asrFinalMs`：这句话语音结束 → ASR 最终文本
- `mtFirstMs`：ASR 完成 → 译文首字
- `ttsFirstMs`：翻译完成 → 配音首批音频可播
- **`e2eLagMs`：语音结束 → 中文配音可播（用户感知的同传滞后）**

## 最终结果（v0.2）

### 质量档（默认）：whisper large-v3-turbo-q5

| 指标 | 中位 | 最小 | 最大 |
|---|---|---|---|
| ASR 出字 | **1837ms** | 1439ms | 2238ms |
| 翻译首字 | **802ms** | 610ms | 1177ms |
| 翻译完成 | 879ms | — | — |
| TTS 首包 | **253ms** | 197ms | 386ms |
| **e2e（语音结束→配音可播）** | **3001ms** | 2322ms | 3522ms |

### 快速档：whisper small（`npm run start:fast` / `npm run batch:fast`）

| 指标 | 中位 |
|---|---|
| ASR 出字 | **922ms** |
| 翻译首字 | 890ms |
| TTS 首包 | 313ms |
| **e2e** | **2389ms** |

> 快速档用 ~0.55s/次的 small 模型换约 **0.6s** 的端到端延迟；术语准确率略降（`docs/PROVIDERS.md`）。

### 逐句（质量档，12 句）

| # | ASR | 翻译首字 | TTS 首包 | e2e |
|---|---|---|---|---|
| 1 | 2238 | 619 | 368 | 3257 |
| 2 | 1837 | 771 | 209 | 2844 |
| 3 | 2128 | 819 | 203 | 3251 |
| 4 | 1870 | 884 | 217 | 3001 |
| 5 | 1763 | 1131 | 359 | 3299 |
| 6 | 1691 | 802 | 205 | 2774 |
| 7 | 1827 | 757 | 253 | 2876 |
| 8 | 1865 | 798 | 220 | 2935 |
| 9 | 2092 | 885 | 386 | 3522 |
| 10 | 1744 | 1177 | 357 | 3325 |
| 11 | 1439 | 660 | 305 | 2437 |
| 12 | 1513 | 610 | 197 | 2322 |

## v0.2 的优化过程（含失败实验，都是真机数据）

### 1. speculative final：实测负收益 → 默认关闭（保留 opt-in）

思路：VAD 检测到尾部静音就开始 whisper 推理，静音确认后复用 → 省掉 280ms 静音等待。

实测（52.7s 整课）：**开启后 ASR 中位 2892ms、e2e 4059ms，比关闭时更差**。日志显示：
- whisper 单次推理 1.3–1.5s ≫ 静音确认窗口 ~160ms，推测结果赶不上 final 确认，**节省 ≈0ms**；
- 语音恢复时「推测作废」已跑满一次推理，并占用 whisper 串行队列（日志出现 4 次），把后续 final 推后。

处理：默认关闭；opt-in 需同时满足 `speculativeFinal: true` + 最近推理耗时 EMA 门限（超过则本会话自动关闭）+ 作废时真正 abort 请求。
代码与单测保留（`engine/asr`），供小模型/短推理场景实验。

### 2. partial（边听边出字幕）：会占用 whisper 队列 → 默认关闭

partial 每次也要跑一次 ~1.4s 推理，final 只能排队。A/B（同一 52.7s 素材）：

| partial 配置 | ASR 中位 | e2e 中位 |
|---|---|---|
| 每 1.5s 一次 | 2949ms | 3891ms |
| 每 3.0s 一次 | 2377ms | 3814ms |
| **关闭（默认）** | **1837ms** | **3001ms** |

处理：`config.asr.whisper.partial.enabled` 默认 **false**（延迟优先）；需要「字幕边听边长」的实时感可开启，代价约 +0.8s e2e。

### 3. 翻译流式 × TTS 重叠（新增）

翻译还在流式输出时，已稳定的子句先送 TTS 合成，不再等整句翻译完成。
- 在「慢速翻译」集成测试中，首个配音比 translation final 提前 **~298ms**；
- 对 deepseek-flash 单句场景收益较小（首字 0.7–0.9s 占主导，中文译文通常末尾才有句号），但不会变慢；
- 已用 `createClauseExtractor`（稳定性 + 标点 + 数字/代码/URL 保护）实现，见 `docs/CONTRACTS.md`。

### 4. TTS 预热与缓存（新增）

- `warmup()`：会话启动后台预热 provider（MiniMax 1 次轻量 get_voice，不发生 TTS 计费），实测 430–610ms 完成；流式首包 **235–266ms**。
- LRU 缓存：教学视频高频重复短语非常常见，实测同句 **cache miss 889ms → hit 0ms**（PCM 完全一致），输出 token 与网络请求都省。
- 可中断：会话 close 时正在进行的合成可快速中止（实测 close 4ms、无未处理 rejection、无残留 say 进程）。

### 5. 成片时轴修正（batch）

- v0.1 的 batch 直接用 pipeline 的 `dub.startMs`（TTS 就绪时刻），1x 实时喂入会导致最后几分钟配音越界（实测末尾到 56s，而视频 52.7s，最后一句被裁）。
- v0.2 改为离线重排：按句开始 + 320ms 起播、全局顺序不重叠、回写 `session.jsonl` 供回放对齐；并对成片使用 TTS 语速 1.15（中文通常比英文长 5–15%）。
- 现在：52.7s 视频，配音结束 **52.1s**，无裁剪。

## 冷启动 / 稳态

- `whisper-server` 冷启动在本机沙箱约 **21–25s**（模型加载 + Metal shader 缓存被沙箱禁用）；引擎后台预热，`ready` 不阻塞，但前 1–2 句 final 会等到模型就绪。
- 热推理：large-q5 **~1.4–1.5s/次**（7s 段），small **~0.55s/次**。

## 复现

```bash
npm run demo:video                 # 生成 demo/original.mp4
npm run batch                      # 质量档：demo/dubbed.mp4 + metrics.json + session.jsonl
npm run batch:fast                 # 快速档（small ASR）：demo-fast/
```

`demo/metrics.json.latencyMedians` 即本文数字；`demo/session.jsonl` 可用
`http://127.0.0.1:8787/replay/?session=/demo/session.jsonl&video=/demo/original.mp4` 回放。

> 说明：延迟受网络（翻译/TTS）与机器负载影响，同一份代码不同轮次会有 ±10–20% 波动；
> 上表是最终一轮「无并发负载」的干净数据。完整 A/B 实验日志在 `docs/CONTRACTS.md` 提到的配置项里可复现。
