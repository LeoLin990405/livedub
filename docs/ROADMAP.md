# Roadmap

## 已实现（v0.5）

- 本地实时同传引擎：VAD 切分、滚动 partial、子句级 TTS、调度/压音、失败隔离；
- Chrome MV3 扩展：tabCapture 抓声、Shadow DOM 双语字幕浮层、中文配音、原声 ducking；
- 本地工作台：本地视频实时同传、延迟 HUD、术语表、音色模式、SRT 导出；
- 离线批处理：真实管线跑视频 → 双语 SRT + 配音 + 烧录字幕 mp4 + session 回放流；
- 克隆优先 / preset 降级的音色管理；MiniMax 克隆适配器（受套餐限制自动降级）；
- 零依赖测试（mock 端到端）+ doctor 环境体检。
- v0.2：翻译流式 × TTS 重叠、TTS 预热/LRU 缓存/可中断、快速档（small ASR e2e ~2.4s）、
  成片时轴修正、ASR partial/推测收句的 A/B 结论（默认关闭）、工作台主题/字幕预设/快捷键/延迟趋势/JSONL 导出、
  扩展全屏浮层/SRT 导出/断连引导、服务端会话上限与优雅退出、MIT 开源与 GitHub Actions CI。
- v0.5：**视频画面理解 → 图文笔记**：关键帧采样（画面差异去重）+ 本地 macOS Vision OCR（serve 常驻）
  + 可选 VLM 画面语义理解 + 音频字幕综合总结；扩展/macOS 快捷笔记与 CLI 自动附带画面文字。
- v0.4：**学习笔记**（Notes API + 工作台笔记抽屉/Markdown 预览/截图/代码块/大纲/导出/画中画 +
  扩展 `Alt+Shift+N` + macOS `⌥N` 全局快捷笔记 + CLI），笔记只落本机、可导出 Obsidian。
- v0.3：**云端 ASR 档**（MiniMax asr-1.0，e2e 2.2–2.4s + 本地降级/熔断 + 隐私提示）、
  **火山引擎 TTS + 声音复刻 v3**（真正音色克隆，需豆包语音 UUID Key）、
  **macOS 桌面悬浮窗**（ScreenCaptureKit + NSPanel 字幕 + 配音）、扩展**全局限定压音**（iframe/WebAudio）+
  **裸 video 全屏包装**、工作台本地/云端 ASR 切换 + `/api/settings`、CI 增加 macOS 构建 job。

## 下一阶段（按优先级）

1. **桌面级压音 / 虚拟声卡（macOS）**
   - App 端接入虚拟音频设备（BlackHole 等）或 ScreenCaptureKit + 独立回放总线，实现「原声压低 + 配音」而非并存；
   - 系统级 mute 原声、字幕置顶与多屏/全屏 App 适配。
2. **更低延迟（目标 <2s）**
   - 真正支持「音频流式输入」的云端 ASR（火山豆包流式 / 阿里 Realtime 等）替代 VAD 整段上传；
   - 启用已备好的草稿翻译复用（`createClauseExtractor` + `draftTranslationReusable`）并控制重复计费；
   - ASR/翻译并行流水线（当前段间串行）。
3. **发布渠道**
   - Chrome Web Store 上架（需账号/审核）、Homebrew Cask 提供 macOS App、签名 + notarize、自动构建 Release 资产；
   - 自动更新（Sparkle）。
4. **教学质量**
   - 幻灯片 OCR 作为翻译上下文（v0.5 已能抽帧+OCR，下一步接入翻译 prompt）；课程术语表自动抽取/导入；
   - 公式/代码段落识别：不翻译、保留原样并标注；平台原生字幕重叠避让策略。
5. **工程**
   - 真机回归基线（RTF / e2e 分位数 CI 阈值，macOS runner 上跑夜间 integration）；
   - 多会话并发体验（桌面端 + 浏览器端同时使用）。

## 明确不做

- 不做云端账号体系与订阅（本地优先）；
- 不内置任何 DRM 破解；
- 不把用户音频/字幕默认上传或持久化（`privacy.*` 显式关闭）。
