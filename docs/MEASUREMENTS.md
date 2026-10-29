# 实测数据（2026-10-29 · 本机）

> 所有数字来自 `npm run demo:video && npm run batch` 的真实链路（不是 mock、不是估算）。
> 原始数据：`demo/metrics.json`、`demo/session.jsonl`；可视化：`docs/assets/studio-real-session.png`。

## 环境

| 项 | 值 |
|---|---|
| 机器 | MacBook Pro (Apple Silicon, M 系列) / macOS 14.8.9 / 12GB 内存级 |
| Node | v26.3.1（项目要求 ≥22） |
| ASR | whisper.cpp `whisper-server`，模型 `ggml-large-v3-turbo-q5_0`（547MB），8 线程，初始 prompt 注入领域词 |
| 翻译 | deepseek-flash（OpenAI 兼容流式，首字最快的实测 provider） |
| TTS | MiniMax `speech-2.8-hd`，音色 `male-qn-qingse`（PCM 24kHz 流式） |
| 素材 | `demo/original.mp4`，52.7s 英文公开课（5 页幻灯片 + Samantha 旁白） |
| 喂入方式 | 16kHz 单声道，100ms/帧，**1x 实时**喂入（与浏览器扩展/工作台一致） |

## 指标定义（很重要）

- `asrFinalMs`：这段语音结束 → ASR 最终文本（含 VAD 静音判定 + whisper 推理）
- `mtFirstMs`：ASR 完成 → 翻译首字
- `mtDoneMs`：ASR 完成 → 翻译完成
- `ttsFirstMs`：翻译完成 → 配音首批音频可播（MiniMax 流式首包）
- `e2eLagMs`：**这句语音结束 → 中文配音可播**（用户真正感知的同传滞后）
- `e2eFromStartMs`：从这句语音开始算（长句天然更大，仅诊断用）

## 结果：52.7s 示例课（12 句）

| 指标 | 中位 | 最小 | 最大 |
|---|---|---|---|
| ASR 出字（语音结束→final） | **2148ms** | 1455ms | 3440ms |
| 翻译首字 | **798ms** | 620ms | 1449ms |
| 翻译完成 | 950ms | — | — |
| TTS 首包 | **217ms** | 172ms | 437ms |
| **e2e（语音结束→配音可播）** | **3384ms** | 2749ms | 4718ms |

逐句：

| # | 时间轴 | ASR | 翻译首字 | TTS 首包 | e2e |
|---|---|---|---|---|---|
| 1 | 0.00–2.78s | 2630 | 1030 | 437 | 4150 |
| 2 | 2.78–6.68s | 2509 | 620 | 206 | 3384 |
| 3 | 7.12–15.12s | 2148 | 1219 | 217 | 3603 |
| 4 | 15.12–18.24s | 3440 | 669 | 190 | 4335 |
| 5 | 18.68–23.36s | 1849 | 700 | 172 | 2819 |
| 6 | 23.36–27.94s | 1792 | 678 | 226 | 2749 |
| 7 | 28.34–31.28s | 2044 | 798 | 212 | 3108 |
| 8 | 31.44–34.26s | 1869 | 1057 | 184 | 3160 |
| 9 | 34.26–40.56s | 3191 | 709 | 373 | 4718 |
| 10 | 40.98–46.98s | 3297 | 700 | 408 | 4485 |
| 11 | 46.98–50.76s | 1455 | 1449 | 204 | 3109 |
| 12 | 50.82–52.12s | 1556 | 931 | 303 | 2808 |

## 冷启动 / 稳态

- `whisper-server` 冷启动（含模型加载 + Metal shader 编译）在本机沙箱约 **23–25s**；引擎会在后台预热，`ready` 事件不阻塞，但**前 1–2 句**的 final 会等到模型就绪。正常桌面环境缓存生效后会更快。
- 热态 whisper 推理（7s 段）实测：

| 模型 | 热推理（7s 段，含 prompt） | 说明 |
|---|---|---|
| `ggml-large-v3-turbo-q5_0`（默认） | **~1.58s**（首次 2.4s） | 术语准确率高，推荐 |
| `ggml-small` | **~0.55s**（首次 1.2s） | 可把 e2e 再压 ~1s；术语准确率略降 |

低延迟模式（示例）：

```bash
LIVEDUB_WHISPER_MODEL=~/.sayless/ggml-small.bin npm start
# 或 batch：LIVEDUB_WHISPER_MODEL=~/.sayless/ggml-small.bin node scripts/batch.mjs
```

## 声音克隆实测

- 初始音色 `male-qn-qingse` 直接可用（系统音色）。
- 会话中自动采集讲师语音并尝试 MiniMax voice_clone：当前 **Token Plan 返回 2061**（`your current token plan not support model, voice_clone`）→ 引擎一次性降级 preset 并继续工作（`voice` 事件携带 `degraded:true` + reason）。详见 `docs/PROVIDERS.md`。
- 克隆失败不会拖慢主链路（upload + 失败返回约 1-2s，且只尝试一次）。

## 已知影响延迟的因素（按影响力排序）

1. **ASR 固定开销**：whisper.cpp 每次请求按 30s 窗口算，大型模型 ~1.5s/次；换 small 可省 ~1s，但术语准确率下降。
2. **翻译网络 TTFT**：deepseek-flash 0.6–1.4s；切换 provider/网络会直接体现在 e2e 上。
3. **VAD 静音等待**：默认 280ms，决定「说完到开始识别」的固定延迟。
4. **子句切块**：长句会在第一个子句译完后就开始 TTS（默认 8 字），避免等整句。

## 复现

```bash
npm run demo:video     # 生成 demo/original.mp4（52.7s 示例课）
npm run batch          # 真实链路：demo/dubbed.mp4 + bilingual.srt + session.jsonl + metrics.json
```

`demo/metrics.json` 里 `latencyMedians` 即上表；`demo/session.jsonl` 可用
`http://127.0.0.1:8787/replay/?session=/demo/session.jsonl&video=/demo/original.mp4` 回放。
