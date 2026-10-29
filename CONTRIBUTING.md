# Contributing to livedub

感谢你愿意参与！livedub 是**本地优先**的实时同传引擎（ASR → 增量翻译 → TTS 配音 + 双语字幕），
主形态是 Chrome 扩展 + 本地工作台。为了保持低门槛，项目坚持**零 npm 运行时依赖**（Node ≥22 内置能力）。

## 开发环境

- macOS（当前主要支持平台；Linux 上可跑测试，扩展/`say` 兜底能力受限）
- Node.js **≥ 22**（推荐 24 LTS 或更高）
- `ffmpeg` / `ffprobe`：`brew install ffmpeg`
- 本地 ASR：`brew install whisper-cpp` + 一个 ggml 模型（默认 `models/ggml-large-v3-turbo-q5_0.bin`，见 README）
- 翻译/TTS API Key（可选，测试默认 mock）：默认从 `~/.sayless/config.json` 只读复用，或环境变量
  `LIVEDUB_PROVIDER_<NAME>_API_KEY`。**不要把任何 Key 提交进仓库。**

```bash
npm run doctor      # 环境体检（只读）
npm test            # 单元测试（离线、无需 whisper/网络）
npm start           # 本地引擎 + 工作台 http://127.0.0.1:8787/studio/
```

集成测试（会启动真实 whisper / 调真实 API，默认跳过）：

```bash
LIVEDUB_INTEGRATION=1 node --test tests/asr.test.mjs
LIVEDUB_INTEGRATION=1 node --test tests/tts.test.mjs
```

## 代码结构（重要）

`docs/CONTRACTS.md` 是**唯一接口事实来源**：线协议、provider 工厂、音频格式、时间轴约定都以它为准。
改动跨模块接口时，请同一个 PR 内同步更新 `docs/CONTRACTS.md`。

| 目录 | 职责 |
|---|---|
| `engine/protocol.mjs` | WS 线协议 / 二进制音频帧 |
| `engine/pipeline.mjs` | Session 编排（ASR → 翻译 → TTS → 调度 → 事件） |
| `engine/asr/` + `engine/segmenter.mjs` | 本地 whisper 流式识别、VAD 切分、partial |
| `engine/translate/` | 流式翻译、术语表、failover、子句提取 |
| `engine/tts/` + `engine/voice.mjs` | MiniMax / macOS say TTS、克隆降级、缓存 |
| `engine/dub/` | 配音调度策略 |
| `engine/server.mjs` | HTTP + WebSocket 服务、静态工作台 |
| `studio/` | 本地工作台 UI（零依赖） |
| `extension/` | Chrome MV3 扩展（抓声 + 浮层 + 配音） |
| `scripts/` | doctor / batch / demo 生成 / 图层渲染 |

## 代码约定

- ESM（`import`），文件后缀 `.mjs`（浏览器端 `.js` / `.mjs` 均可）
- **不新增 npm 运行时依赖**（测试也不依赖外部包；用 `node:test` + `node:assert/strict`）
- 不引入 TypeScript / 构建步骤；浏览器端纯原生 ES Module
- 命名英文，注释与 UI 文案中文；错误信息要带「下一步怎么办」
- 库代码不要 `console.log`，使用注入的 `log()`；不打印任何密钥
- 时间轴统一毫秒；音频统一 s16le / mono / 16kHz（输入）
- 提交前：`node --check` 所有新文件 + 相关测试通过

## PR 检查清单

- [ ] 改动限定在单一主题，说明动机与行为变化
- [ ] `npm test` 全绿；新增逻辑有单测（离线）
- [ ] 涉及真实 API/模型的验证请在 PR 描述里贴出命令与关键数字，并注明是否消耗额度
- [ ] 更新相关文档（README / docs/CONTRACTS.md / docs/MEASUREMENTS.md）
- [ ] 没有提交密钥、个人路径、模型权重、`demo/tmp/` 中间产物
- [ ] UI 改动附截图（工作台/扩展任一）

## 提交信息

使用 Conventional Commits 风格（中英文均可）：

```
feat(engine): speculative final to cut ASR latency
fix(extension): keep subtitle overlay in native fullscreen
docs: add provider setup guide
```

## 安全

发现安全问题请不要开公开 Issue，按 [SECURITY.md](SECURITY.md) 私下报告。

## English quick note

Issues/PRs in English are welcome. See `README.en.md` for project overview and
`docs/CONTRACTS.md` for the interface spec. Keep the project dependency-free at
runtime (`node:test` only for tests).
