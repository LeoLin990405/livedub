# Roadmap

## 已实现（v0.2）

- 本地实时同传引擎：VAD 切分、滚动 partial、子句级 TTS、调度/压音、失败隔离；
- Chrome MV3 扩展：tabCapture 抓声、Shadow DOM 双语字幕浮层、中文配音、原声 ducking；
- 本地工作台：本地视频实时同传、延迟 HUD、术语表、音色模式、SRT 导出；
- 离线批处理：真实管线跑视频 → 双语 SRT + 配音 + 烧录字幕 mp4 + session 回放流；
- 克隆优先 / preset 降级的音色管理；MiniMax 克隆适配器（受套餐限制自动降级）；
- 零依赖测试（mock 端到端）+ doctor 环境体检。
- v0.2：翻译流式 × TTS 重叠、TTS 预热/LRU 缓存/可中断、快速档（small ASR e2e ~2.4s）、
  成片时轴修正、ASR partial/推测收句的 A/B 结论（默认关闭）、工作台主题/字幕预设/快捷键/延迟趋势/JSONL 导出、
  扩展全屏浮层/SRT 导出/断连引导、服务端会话上限与优雅退出、MIT 开源与 GitHub Actions CI。

## 下一阶段（按优先级）

1. **声音克隆真正可用**
   - 火山语音「声音复刻」provider（openspeech v3，`S_` 音色 / 复刻接口）；
   - MiniMax 按量付费克隆的端到端验证；
   - 克隆样本质量筛选（VAD 置信度、背景音乐检测、男女声判定）。
2. **云端流式 ASR 适配器**
   - 火山豆包流式 ASR（`X-Api-Resource-Id: volc.seedasr.sauc.duration`）；
   - 阿里/OpenAI Realtime 类接口；
   - 与本地 whisper 自动选择（网络/延迟/准确率）。
3. **桌面形态**
   - macOS 菜单栏 App + ScreenCaptureKit 系统/应用音频捕获 + 悬浮字幕窗；
   - 覆盖任意播放器/网课客户端（腾讯会议、Zoom、本地播放器）。
4. **教学质量**
   - 幻灯片 OCR（每 N 秒截帧）→ 作为翻译上下文，专有名词更准；
   - 课程术语表自动抽取（从讲义/字幕/幻灯片）+ 一键导入；
   - 公式/代码段落识别：不翻译、保留原样并标注。
5. **体验**
   - 字幕样式主题、字体/位置记忆；
   - 双语字幕导出 ASS（带样式）、配音音轨单独导出；
   - 扩展支持多标签页会话管理、快捷键、HUD 悬浮球收起。
6. **工程**
   - `pnpm gate` 式 CI（macOS runner 上跑 whisper 集成用例）；
   - 性能回归基线（RTF / e2eLag 分位数）；
   - 发布 Chrome Web Store 打包脚本。

## 明确不做

- 不做云端账号体系与订阅（本地优先）；
- 不内置任何 DRM 破解；
- 不把用户音频/字幕默认上传或持久化（`privacy.*` 显式关闭）。
