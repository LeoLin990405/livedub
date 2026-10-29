# Provider 配置与声音克隆

## 1. 配置来源（优先级从低到高）

1. `config/livedub.config.json`（仓库内默认值）
2. `~/.sayless/config.json` 的 `providers.<name>`（**只读复用**已有 Key，livedub 不会改写它）
3. 环境变量：`LIVEDUB_PROVIDER_<NAME>_API_KEY`、`LIVEDUB_TRANSLATE_PROVIDER`、`LIVEDUB_TTS_PROVIDER`、`LIVEDUB_WHISPER_MODEL`、`LIVEDUB_PORT`
4. 会话级 `hello.overrides`（网页/扩展可下发）

`translation.provider` / `tts.provider` 指向 provider 名称；`translation.chain` 是 failover 顺序。

## 2. 已支持/实测矩阵

| 能力 | provider 名称 | 说明 | 本机实测 |
|---|---|---|---|
| ASR | `whisper-local` | 本地 whisper-server，模型路径见 `asr.whisper.models` | ✅ 热推理 RTF≈0.05 |
| ASR | `mock` | 无模型/无网络测试用 | ✅ |
| 翻译 | `deepseek` | OpenAI 兼容流式；默认 `deepseek-flash` | ✅ 首字≈1.0s |
| 翻译 | `minimax` | OpenAI 兼容；`MiniMax-M3` | ✅ 首字≈2.4s |
| 翻译 | `mimo-plan` / `zai` / `ark-plan` | OpenAI 兼容备胎 | ✅（ark-plan 较慢，不建议主用） |
| TTS | `minimax` | `speech-2.8-hd`，PCM/SSE 流式，系统音色 | ✅ 短句首包≈1.1-1.5s |
| TTS | `macos-say` | 系统 `say`（Tingting 等），无 Key 兜底 | ✅ |
| TTS | `mock` | 正弦波测试音 | ✅ |
| 声音克隆 | `minimax`（pay-as-you-go） | `/v1/files/upload` + `/v1/voice_clone` | ⚠️ Token Plan 返回 2061，自动降级 |
| 声音克隆 | 火山语音复刻（规划） | openspeech `S_` 音色 / 复刻接口 | 🚧 需要语音控制台 UUID Key |

> 火山方舟 **Agent Plan 的 ark- Key 不能调用 openspeech 语音服务**（实测 401/45000030）。云端语音识别/克隆请使用火山「豆包语音」控制台的 Key，或继续用本地 whisper + MiniMax TTS。

## 3. 配置示例

### 3.1 最小可用（本机默认）

```json
{
  "asr": { "provider": "whisper-local" },
  "translate": { "provider": "deepseek", "chain": ["deepseek", "minimax", "mimo-plan"] },
  "tts": { "provider": "minimax", "model": "speech-2.8-hd", "voiceMode": "clone-first" }
}
```

### 3.2 只用字幕、不要配音

```json
{ "dub": { "enabled": false } }
```

或会话中下发 `{"type":"config","patch":{"dub":{"enabled":false}}}`。

### 3.3 换别家 TTS（比如 OpenAI 兼容 `/audio/speech`）

在 `config/livedub.config.json` 的 `providers` 里加：

```json
{
  "providers": {
    "mytts": {
      "baseUrl": "https://your-tts-host/v1",
      "apiKey": "${env:LIVEDUB_PROVIDER_MYTTS_API_KEY}",
      "model": "tts-1",
      "ttsChatPath": "/audio/speech"
    }
  },
  "tts": { "provider": "mytts" }
}
```

> 当前仓库内置的 TTS 适配器是 `minimax` / `macos-say`；接别家需要按 `docs/CONTRACTS.md` §4 的接口写一个适配器（约 100 行）。欢迎 PR。

## 4. 声音克隆怎么开

### 4.1 MiniMax（当前代码已支持）

1. 在 MiniMax 平台开通**按量付费**（Token Plan 不支持 voice_clone，会返回
   `base_resp.status_code=2061: your current token plan not support model, voice_clone`）；
2. 无需改配置：livedub 会在会话中自动截取讲师语音（默认 ≥12s）→ 上传 → 克隆 → 切换音色；
3. 克隆成功的音色会在 `voice` 事件里以 `mode:"clone"` 通知 UI；失败则 `degraded:true` + `reason`。

要求：音频 10s–5min、mp3/m4a/wav、≤20MB。教学视频里讲师声音稳定，通常 12–20s 就够。

### 4.2 火山语音复刻（规划中）

需要「豆包语音控制台 → API Key 管理」的 **UUID Key**（不是方舟 ark- Key），以及控制台里已复刻的音色 ID（`S_` 开头）。
livedub 的 TTS 适配器层已按「克隆 provider 可插拔」设计，接入时新增一个 provider 即可。

### 4.3 没有克隆能力时的降级策略

- 默认 `voiceMode: "clone-first"`：克隆失败 → 使用 `tts.presetVoices` 中按语言/性别选的高质量系统音色；
- `voiceMode: "preset"`：完全不尝试克隆（最省额度、最快）；
- 克隆失败只尝试一次并记住原因，不会每句重试。

## 5. 云端 ASR（MiniMax，v0.3 新增）

本地 whisper 是默认（离线、免费）。v0.3 新增 **MiniMax 云端 ASR**，用同一个 `providers.minimax` Key 即可，实测更快：

| 音频长度 | 整段转写耗时（含上传/网络） |
|---|---|
| 4s | ~0.79s |
| 12s | ~1.0–1.2s |

- 接口：`POST https://api.minimaxi.com/v1/speech_to_text`，multipart `model=asr-1.0` + WAV 16k mono；`stream=true` 时 SSE 增量
- 使用：`npm run start:cloud` / `npm run batch:cloud`（等价 `LIVEDUB_PROFILE=cloud`）
- 隐私：**云端 ASR 会把音频上传到 MiniMax**；工作台会显示隐私提示。失败自动降级本地 whisper（`asr.fallback`）
- 不支持音频流式输入：由客户端 VAD 切句后整段上传，因此最终延迟 ≈ VAD 静音判定 + 一次上传/识别

> 想完全离线就保持默认档；想让延迟更低且能接受音频上云就用 cloud 档。

## 6. 火山引擎 TTS + 声音复刻（真正原声克隆，v0.3 新增）

> ⚠️ 需要**豆包语音控制台**的 **UUID 格式 API Key**（「语音技术 → API Key 管理」）。
> 火山方舟的 `ark-` Key 不能调用语音服务（实测 401 Invalid X-Api-Key）。
> 当前本机只有方舟 Key，所以该 provider 的协议已实现、真机只能验证 401/降级路径。

配置（`config/livedub.config.json`）：

```json
{
  "providers": {
    "volcengine": { "baseUrl": "https://openspeech.bytedance.com" }
  },
  "tts": {
    "provider": "volcengine",
    "clone": { "chain": ["volcengine", "minimax"] }
  }
}
```

凭证（任一）：`VOLCENGINE_SPEECH_API_KEY` / `ARK_SPEECH_API_KEY` 环境变量，或 `~/.sayless/config.json` 的 `providers.volcengine.apiKey`。

- **TTS**：`POST /api/v3/tts/unidirectional`，按音色自动推断 `X-Api-Resource-Id`（复刻 `S_`→`seed-icl-2.0`、2.0 `uranus`→`seed-tts-2.0`、1.0 `_bigtts`→`volc.service_type.10029`），PCM 24k 流式返回
- **声音复刻**：`POST /api/v3/tts/voice_clone`，上传 10s–5min 讲师语音 → `speaker_id`，status=2/4 即可合成（1=训练中，会提示稍后重试）
- livedub 的 `clone-first` 会按 `tts.clone.chain` 依次尝试（例如 火山 → MiniMax），失败自动降级预设音色并继续同传

开通步骤：
1. 火山引擎控制台搜索「豆包语音」→ 开通语音合成/声音复刻；
2. 「语音技术 → API Key 管理」创建 UUID Key；
3. `export ARK_SPEECH_API_KEY=<uuid>` 或写进 `~/.sayless/config.json` 的 `providers.volcengine.apiKey`；
4. `npm run doctor` 应显示 volcengine 已配置；`npm start` 后会在会话中自动尝试克隆讲师音色。

## 7. 延迟档位（ASR）

| 档位 | 开启方式 | ASR 后端 | 实测 e2e（本机） | 适用 |
|---|---|---|---|---|
| 质量档（默认） | `npm start` | 本地 whisper large | ~3.0s | 离线、术语准确 |
| 快速档 | `npm run start:fast` | 本地 whisper small | ~2.4s | 离线、低延迟 |
| 云端档 | `npm run start:cloud` | MiniMax 云端 ASR | 见 docs/MEASUREMENTS.md | 低延迟、可接受音频上云 |

`config/livedub.fast.json` / `config/livedub.cloud.json` 是档位覆盖文件（`LIVEDUB_PROFILE` 叠加）。

> ASR partial（边听边出字幕）默认关闭：每次 partial 也要跑一次识别（本地 whisper 会占用串行队列）。
> 需要实时字幕感可开 `asr.whisper.partial.enabled`。

## 8. 常见问题

| 档位 | 开启方式 | 模型 | 实测 e2e（本机） | 适用 |
|---|---|---|---|---|
| 质量档（默认） | `npm start` / `npm run batch` | `ggml-large-v3-turbo-q5_0` | ~3.0s | 术语多、口音重、要求准确 |
| 快速档 | `npm run start:fast` / `npm run batch:fast` | `ggml-small` | ~2.4s | 追求更低延迟，可接受少量术语误差 |

快速档需要 `models/ggml-small.bin` 或 `~/.sayless/ggml-small.bin`（见 `config/livedub.fast.json` 的候选路径）：

```bash
curl -L -o models/ggml-small.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
```

> ASR partial（边听边出字幕）默认关闭：每次 partial 也要跑一次 whisper 推理，会占用串行队列，
> 实测让 final 延后 ~0.8s。想要实时字幕感可在 config 里开 `asr.whisper.partial.enabled`。

## 8. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `provider "deepseek" 缺少 apiKey` | `~/.sayless/config.json` 里没有该 provider，或环境变量未设置；`npm run doctor` 会列出来 |
| TTS 返回 2061 | Token Plan 不支持克隆；已自动降级，无需处理；要克隆请换按量付费 |
| whisper 启动 20-30s 才 ready | 沙箱/冷启动 Metal shader 缓存；正常机器更快，模型常驻后每句只需几百 ms |
| 字幕出来了但没配音 | 看 `error(tts)` 事件与 `npm run doctor --probe`；确认 TTS key 与音色 ID |
| 页面抓不到声音（扩展） | DRM/受保护页面、或未在点击手势内调用 tabCapture；换普通视频页面试试 |

## 9. 用量与成本参考（请以各家实时价格为准）

- 翻译：每句一次短请求（输入 <200 tokens，输出 <120 tokens），60 分钟课程约 300–500 句；
- TTS：按输出字符计费，中文译文约为原文的 0.6–1.0 倍字符量；
- ASR：本地 whisper 免费（只耗本机 GPU/CPU）。

想省额度：把 `dub.enabled` 设 false 只留字幕；或把 `translate.chain` 只留一家。
