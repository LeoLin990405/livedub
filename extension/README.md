# livedub Chrome 扩展（MV3）

看教学视频（B 站 / YouTube / 网课平台）时的**本地实时同传**扩展（v0.4：还支持边看边按 `Alt+Shift+N` 记笔记）：

1. 抓取当前标签页的声音（`tabCapture`）；
2. 通过 WebSocket 推给本机 livedub 引擎（默认 `ws://127.0.0.1:8787/ws`）；
3. 引擎做流式 whisper 识别 → 增量翻译 → 中文 TTS 配音（优先克隆讲师音色）；
4. 扩展在页面上显示**双语字幕浮层**，并播放中文配音；说话时自动压低原声。

v0.2 迭代（日常可用性）：
- **原生全屏兼容**：容器型全屏（YouTube/B 站播放器）时浮层自动迁入 `document.fullscreenElement`，退出恢复；
  `<video>` 直接全屏受浏览器限制无法叠加 DOM（v0.3 起用 page-hook 包裹容器尽力解决）；
- **字幕停靠/避让**：底部/顶部停靠、Y 偏移（避让平台原生字幕）、横向拖动、深/浅/无背景、背景不透明度、字号，全部持久化；
- **导出本次 SRT**：客户端累积 segment+translation，按会话时间轴生成双语 SRT 并下载；
- **引擎未连接引导**：`npm start` 步骤、`/health` 检测、一键重试连接；
- **状态信息**：provider / 音色 / 语言方向、ASR/翻译/配音/端到端延迟细分；
- 设置面板可拖拽、可收起；结束会话恢复所有压音元素并清理 offscreen。

v0.3 迭代（消除两个已知限制）：
- **全局限定压音（核心）**：tabCapture 会让标签页本身静音，声音只存在于 capture stream 里。
  offscreen 用 `AudioContext` 把抓到的原声经 **GainNode 原声总线**重放给用户；引擎 `status=speaking` /
  收到 `dub` 时把该 GainNode 以 **160ms 线性渐变** duck 到设置比例（默认 0.18），说话结束
  `duckRecoverMs`（默认 800ms）后渐变恢复。因为压的是「抓到的标签页音频」本身，
  **iframe 播放器 / WebAudio 直出音频的站点也能压原声**，不再依赖 content 改 `<video>.volume`。
  content 层音量方案保留为兜底（开启全局限定压音时自动让位，避免双重压音）。
  新增设置：原声重放开/关、全局限定压音开关、duck 比例、恢复延迟。
- **裸 `<video>` 原生全屏兼容（尽力）**：MAIN world 的 `page-hook.js` 猴补
  `Element.prototype.requestFullscreen`：站点 JS 对裸 video 请求全屏时，先把它包进一个覆盖视口的
  `<div data-livedub-fullscreen-wrapper>` 再对容器全屏，content script 的浮层迁移逻辑因此可见；
  退出全屏/失败自动回滚 DOM 并回退原生全屏。设置项 `fullscreenWorkaround` 默认开。

v0.4 迭代（**边看边写笔记**）：
- 在任意网页视频上按 **Alt+Shift+N**（或浮层面板「记笔记」/ popup「记当前句」），把
  「当前视频 + 时间戳 + 最近一句双语字幕」写入本地引擎笔记库（`POST /api/notes`，kind=quick；
  引擎只有 quick 路由时自动回退 `POST /api/notes/quick` 写每日摘录 `quick-YYYY-MM-DD.md`）；
- 可选**页面截图**：background `chrome.tabs.captureVisibleTab` → `POST /api/notes/assets`（raw PNG）→
  `imageUrl` 随笔记保存（截图只在有 activeTab/用户手势时可用；失败自动降级为无图笔记）；
- **离线队列**：引擎未启动/请求失败时笔记进入本地队列（最多 50 条，`chrome.storage.local` 持久化），
  引擎 ready / 下次打开 popup / 下次记笔记时自动 flush；浮层 toast 显示「已记笔记 @ mm:ss」或「已排队」；
- 停止抓音后仍可记笔记（用缓存的最后一句字幕）；全屏容器内快捷键同样有效；
- popup 显示**今日笔记数 / 待同步数**，一键「打开笔记本」（引擎工作台 `/studio/?notes=1`）、
  「导出 Markdown」（`POST /api/notes/export`，显示落盘路径）、附截图开关与快捷键说明；
- 与 VSCode/Typora 的工作流：边看边按 `Alt+Shift+N` 打点，结束后在笔记库编辑/导出 Markdown
  （`data/exports/<slug>-<date>.md`，可直接放进 Obsidian vault 目录）。
  注意：Chrome 扩展快捷键只在 **Chrome 窗口聚焦**时生效；若当前焦点在 VSCode，先点回浏览器（或点浮层面板/popup 的按钮）。

v0.5 迭代（快捷笔记加入画面理解）：
- 截图上传 asset 成功后，自动调用引擎视觉端点，把**画面文字（OCR）**以代码块写进笔记正文：
  `POST /api/vision/ocr`（超时 8s，本地 macOS Vision/tesseract，约 1s/帧）；默认开启 `visionOcr`；
- 可选**画面理解（VLM）**：开启 `visionCaption`（默认关，慢 20-30s/次、消耗模型额度）后调用
  `POST /api/vision/analyze?mode=both`，追加「**画面理解**：<描述>」；等待期间浮层 toast 提示「正在识别画面…」；
- 视觉不可用（旧引擎无 `/api/vision/*`、OCR 未安装、VLM 未配置）时**静默跳过**，笔记照常保存；
- popup / 浮层面板可开关「识别画面文字（OCR，快）」「画面理解（VLM，慢）」，popup 显示视觉健康状态
  （`GET /api/vision/health`：本地 OCR provider / VLM 是否配置）；
- 笔记正文新增结构（保留原有 原文/译文/记录）：
  ```
  **画面文字**（OCR）：

  ```text
  <PPT 标题 / 代码 / 板书文字，最长 2000 字>
  ```

  **画面理解**：

  <VLM 对幻灯片/代码/图表的描述>
  ```

> 协议、时间轴、事件定义见 `docs/CONTRACTS.md` §3；引擎入口 `engine/server.mjs`。
> 本目录零 npm 依赖、无远程代码 / CDN / 内联脚本，所有资源随扩展本地打包。

## 目录结构

```
extension/
├── manifest.json          # MV3 清单：权限 / content script / popup / service worker
├── background.js          # service worker（module）：开始/停止、offscreen 生命周期、事件转发、状态
├── offscreen.html/js      # 隐藏页面：tabCapture 消费、AudioWorklet 16k PCM、WS、配音播放、原声总线压音
├── page-hook.js           # v0.3 MAIN world：裸 <video> requestFullscreen 包裹兼容（尽力而为）
├── content.js             # classic content script：Shadow DOM 浮层、双语字幕、状态胶囊、压音兜底
├── popup.html/js          # 工具栏弹窗：引擎地址、开始/停止、音色模式、延迟、错误
├── lib/
│   ├── constants.js       # 共享常量：默认地址 / storage key / 消息类型 / 设置默认值 / URL 规范化
│   ├── pcm.js             # 纯函数：PCM 编解码、重采样、base64、hello、文本清洗、duck 状态机、dub 排期
│   ├── ui.js              # v0.2/v0.3 纯函数：全屏宿主/包裹决策、字幕停靠/避让、原声总线增益
│   ├── srt.js             # v0.2 纯函数：caption -> SRT（时间戳/双语/文件名）
│   └── notes.js           # v0.4/v0.5 纯函数：videoId/quick note markdown/离线队列/今日计数/
│                          #   OCR 代码块（围栏自适应）/画面理解/视觉健康解析
├── worklet/pcm-worklet.js # AudioWorklet：100ms 分片 + 兜底重采样到 16kHz + float32→s16
└── README.md
tests/extension.test.mjs   # manifest / 静态检查 / 纯函数单测（node --test）
```

## 安装（加载未打包扩展，Chrome 156 / macOS）

1. 先启动本地引擎（另开终端，项目根目录）：
   ```bash
   cd livedub
   node engine/server.mjs          # 监听 127.0.0.1:8787，WS 路径 /ws
   ```
   引擎就绪前扩展也能打开，只是会显示「重连中」并按指数退避重试。
2. Chrome 地址栏打开 `chrome://extensions`；
3. 右上角打开 **开发者模式（Developer mode）**；
4. 点击 **加载已解压的扩展程序（Load unpacked）**，选择本仓库的 `livedub/extension` 目录；
5. 把 livedub 图标固定到工具栏（可选）；
6. 打开任意有声音的视频页面（如 B 站 / YouTube），点击工具栏 livedub 图标 → 弹窗里点 **开始同传**。

停止：再点一次弹窗里的「停止同传」。快捷键 `Alt+Shift+L` 同样可以开始/停止（在用户手势链内，最适合排障）。

## 权限说明（为什么需要）

| 权限 | 用途 |
|---|---|
| `tabCapture` | 捕获当前标签页音频（`getMediaStreamId`，必须在用户手势内调用） |
| `offscreen` | 创建隐藏 offscreen document 跑 `getUserMedia` / AudioWorklet / WebSocket / 音频播放（MV3 service worker 没有这些能力） |
| `storage` | `storage.local` 保存设置（引擎地址、配音开关、压音比例、字号、浮层位置）；`storage.session` 保存运行态，service worker 被回收后恢复 |
| `activeTab` | 用户点击扩展图标/快捷键后临时获得当前标签页访问（注入浮层所需） |
| `scripting` | 对「扩展加载前就已打开」的旧标签页兜底注入 `content.js` |

content script 有两条：`page-hook.js` 运行在 `world: "MAIN"` / `document_start`，只做裸 `<video>` 全屏包裹兼容；
`content.js` 运行在默认 ISOLATED world / `document_idle`，负责浮层 UI 与压音兜底 —— 两者通过
`window.postMessage`（source 白名单）协作，互不共享权限。

`host_permissions: http://127.0.0.1/*, http://localhost/*` 只用于连接本地引擎 / 打开本地工作台，**不会访问外网**。
扩展不使用任何远程代码（无 `<script src="http…">`、无 CDN、无 `eval`），符合 MV3 CSP。

## 工作原理（消息流）

```
popup ──START(streamId)──▶ background ──OFFSCREEN_START──▶ offscreen
                                             │
                    tabCapture streamId ─────┘
offscreen: getUserMedia(tab) ─▶ 16k AudioContext + AudioWorklet（100ms）
         ─▶ WS 二进制帧 [0x01 | float64BE tMs | s16le] ─▶ 引擎
引擎 ──JSON 事件──▶ offscreen ──OFFSCREEN_EVENT──▶ background ──ENGINE_EVENT──▶ content（浮层）
                                              └────STATE（广播）──────────────▶ popup
```

- 音频时间轴：`offscreen` 每段会话（含重连后的新会话）从第一帧 `tMs=0` 起算；`dub.startMs` 与该时间轴对齐。
- 断线重连：指数退避 0.5s→1s→2s→4s→8s→10s（上限 10s），重连成功后重新发 `hello`、时间轴归零；断线期间的音频直接丢弃（实时同传不做长缓存）。
- 停止：offscreen 先发 `{type:'control', action:'stop'}` 再关闭 WS / 音轨 / AudioContext，background 随后关闭 offscreen document。
- 压音：v0.3 主方案是 offscreen 对「抓到的标签页原声」做 GainNode duck（见下），content script 的 `video/audio.volume` 方案保留为兜底；两种方案都按 `duckRatio`（默认 0.18）压音、说话结束 `duckRecoverMs` 后恢复，停止/异常时全部恢复。
- 全屏：监听 `fullscreenchange`，容器型全屏元素（`<div>` 播放器壳）可承载浮层，直接把同一个 Shadow DOM host 迁进去（`position:fixed` 仍相对视口），退出后迁回 `document.documentElement`；`<video>`/`<canvas>` 等替换元素自身全屏时浏览器不允许子节点渲染，浮层保持挂载但不显示，并弹提示。
- SRT：background 累积 `segment`（t0Ms/t1Ms/src）+ `translation`（dst）到 `chrome.storage.session`（最多 400 句），
  导出时用 `lib/srt.js` 生成双语 SRT；content 浮层与 popup 都可触发下载。
- 全局限定压音：原声链路 `capture stream -> monitorSource -> monitorGain(原声总线) -> destination`；
  duck 状态机在 offscreen（`status`/`dub` 驱动，100ms tick 检查恢复），`captureReplay=false` 时总线增益为 0。
  content 只在 `globalDuck=false` 时才改页面 `video/audio.volume`（兜底，仅顶层 frame 媒体）。
- 全屏兼容包裹：page-hook（MAIN world）与 content 通过 `window.postMessage`（source `livedub-content` /
  `livedub-page-hook`）同步 `fullscreenWorkaround` 开关；包裹层是 `<div>`，属于「可承载子节点」元素，
  content 的 `fullscreenchange` 迁移会把浮层放进包裹层内。
- 视觉增强（v0.5）：`POST /api/notes/assets` 成功后，若 `visionOcr`（默认开）→ `POST /api/vision/ocr {imageUrl}`
  （8s 超时）→ `lib/notes.js#buildVisionOcrSection` 生成「画面文字」代码块；若 `visionCaption`（默认关）→
  `POST /api/vision/analyze?mode=both`（45s 超时）→ 追加「画面理解」。视觉失败/旧引擎无端点时静默跳过，
  不阻断笔记保存；结果同时拼进 `POST /api/notes` 的 body（quick 兜底则拼进 text）。
- 笔记：background 收到快捷键/按钮/命令后向 content 要 `{url,title,durationMs,tMs,text,quotes}` 上下文，
  用 `lib/notes.js` 计算稳定 videoId、构造笔记请求体；主写入 `POST /api/notes`（笔记库存档，工作台「笔记本」
  与导出 Markdown 都基于它，支持 `kind=quick`/`quotes`/`tags`/`imageUrl`），引擎无该路由时回退
  `POST /api/notes/quick`（不支持 imageUrl，截图降级）；可选截图（`captureVisibleTab` → raw PNG →
  `POST /api/notes/assets`）拿相对 `imageUrl`；失败时 payload 进 `lib/notes.js` 的离线队列
  （`chrome.storage.local`），引擎 ready / popup 打开 / 下次记录时 flush。今日计数与最近一条结果广播给 popup/浮层。

## 排障（按顺序排查）

1. **提示「Chrome 要求用户手势才能抓音」**
   - `chrome.tabCapture.getMediaStreamId` 只能在用户手势内调用。请**点击工具栏图标打开弹窗后点「开始同传」**，或按 `Alt+Shift+L`；不要从页面内的浮层按钮、书签脚本等间接路径触发（Chrome 不把消息链视为手势）。
   - 若弹窗内仍失败：先在 `chrome://extensions` 里确认扩展已启用、没有报错，再重试。
2. **一直显示「重连中」/「已断开」**
   - 引擎没启动或端口不对。终端执行 `node engine/server.mjs`，确认监听 `127.0.0.1:8787`。
   - 改引擎地址：弹窗里填写后点「保存地址」。**已运行中的会话继续用旧地址，重新开始后生效。**
   - 用 `lsof -i :8787` 检查端口是否被占用。
3. **页面没声音 / 原声被静音**
   - `tabCapture` 抓走音频后标签页本身会被 Chrome 静音；本扩展在 offscreen document 里用默认采样率 AudioContext 把原声重放回来。若完全听不到原声，先停止再开始，或用 `chrome://inspect` 打开 offscreen document 看 `__livedubOffscreen.status()`。
   - 某些页面（如 DRM 播放器）无法被捕获，会得到「当前页面不支持抓音」。
4. **字幕不出现**
   - 确认当前标签页地址是 `http(s)://`（`chrome://`、扩展商店不支持）；刷新页面让 content script 注入；或查看 `chrome://extensions` → 错误 → 内容脚本错误。
   - 浮层可能被页面全屏/最高 z-index 覆盖，或用户点过「隐藏浮层」：点扩展图标 → 「显示字幕浮层」。
5. **浮层位置/样式**
   - 浮层在 Shadow DOM 里，不影响页面样式；字幕框可拖动，位置与字号、压音比例、配音开关都存在 `chrome.storage.local`。
6. **offscreen document 生命周期**
   - offscreen 只在抓音期间存在，停止后 background 会 `chrome.offscreen.closeDocument()` 关闭它；再次开始时自动重建。
   - MV3 的 service worker 约 30s 空闲可能被回收：**音频采集与播放跑在 offscreen，不受影响**；引擎事件到达会唤醒 SW 继续转发；运行态快照存 `chrome.storage.session`，SW 恢复时会自动校验并同步。
   - 如果 offscreen 被浏览器关闭（例如浏览器内存回收），扩展会显示「抓音会话已结束」，重新点开始即可。
7. **Chrome 版本**
   - 需要 Chrome 116+（`chrome.runtime.getContexts` / offscreen 稳定行为）。本开发环境 Chrome 156 / macOS 14。
   - 若在更老的 Chrome 上加载失败，请升级浏览器后重试。

## 手动测试清单（tabCapture 无法自动化，必须人工验证）

| # | 步骤 | 预期 |
|---|---|---|
| 1 | `node engine/server.mjs` 启动引擎；打开一个 B 站/YouTube 视频并播放 | 引擎日志出现 WS 连接 |
| 2 | 点击工具栏 livedub 图标 → 弹窗状态「未连接」、延迟「—」 | 弹窗正常渲染，无控制台错误 |
| 3 | 点「开始同传」 | 扩展图标有运行提示；弹窗状态依次「启动中…」→「收听中」；页面右上角出现状态胶囊；标签页原声先短暂静音后被重放 |
| 4 | 等待视频说话 5~10s | 底部出现双语字幕：原文灰色小字 + 译文白色大字；状态胶囊显示「翻译中/配音中」和延迟（ms 或 s） |
| 5 | 观察说话时页面音量 | 原声被压低（约 0.18 倍），中文配音播放；停顿 0.8s 后原声恢复 |
| 6 | 拖动字幕框 | 可拖动并记住位置（重开页面/刷新后保持） |
| 7 | 点击状态胶囊 | 展开设置面板：配音开关、压音比例、显示原文、字号、开始/停止、隐藏浮层都能生效 |
| 8 | 关闭弹窗后再打开 | 仍显示当前状态/延迟（background 状态广播） |
| 9 | 点「停止同传」（或 Alt+Shift+L） | 状态回到「未连接」，页面音量全部恢复，offscreen document 被关闭（`chrome://extensions` → 检查视图可确认） |
| 10 | 引擎运行中杀掉 `engine/server.mjs` | 胶囊显示「重连中…」，每秒退避重试；重启引擎后自动重连并恢复字幕 |
| 11 | 停止后在另一个视频页点开始 | 正常抓新标签页；旧字幕清空（新会话） |
| 12 | SPA 站点内跳转（如 YouTube 视频切换） | 浮层保持、继续更新字幕 |
| 13 | 在 `chrome://extensions` 页面点开始 | 显示「当前页面不支持抓音」可读错误，无未捕获异常 |
| 14 | 多标签页同时只允许一个会话 | 第二个标签页点开始会提示已在运行（先停止） |
| 15 | 在 YouTube/B 站播放器上进入**全屏**（容器型） | 字幕浮层与状态胶囊跟随进入全屏、位置正常；退出全屏后回到页面右下/底部，不丢设置 |
| 16 | 点胶囊打开设置 → 位置切「顶部」、拖动「避让」滑块 | 字幕移动到顶部/按偏移避让；刷新页面后仍保持 |
| 17 | 设置 → 背景切换深/浅/无，拖「不透明度」 | 字幕背景立即变化，文字仍清晰可读；持久化 |
| 18 | 拖动设置面板标题栏、点右上角 ▾ 收起 | 面板可移动、可收起/展开，位置保存 |
| 19 | 播放视频说几句后点「导出 SRT」（浮层或 popup） | 下载 `livedub-<标题>-<时间>.srt`，时间轴/双语行正确，可被播放器加载 |
| 20 | 拖动字幕框左右/上下 | 位置跟随手指，刷新后保持（横向偏移 + 避让） |
| 21 | 引擎未启动时打开 popup | 显示「未连接本地引擎」引导（npm start / /health 步骤）；点「检测引擎」显示离线；启动引擎后点「重新检测」变在线 |
| 22 | 运行中 kill 引擎，再重启 | 胶囊/popup 显示重连中；点「重试连接」立即重连；字幕恢复 |
| 23 | 停止会话 | 页面音量全部恢复；offscreen document 关闭；字幕仍在（可继续导出本次 SRT） |
| 24 | 在 `<video>` 元素被直接全屏的站点（如部分原生播放器）进入全屏 | v0.3 默认已启用「video 全屏兼容」：字幕浮层进入全屏可见；失败时回退原生并提示 |
| 25 | 打开 **iframe 播放器** 的站点（如嵌入 YouTube/B 站），播放并开始同传 | 说话时原声被压低（全局限定压音生效）、结束后恢复；字幕正常（不再依赖 iframe 内 video.volume） |
| 26 | 打开 **WebAudio 直出** 的站点（没有 `<video>/<audio>` 或音量不受 DOM 控制） | 原声同样被压低/恢复；content 面板「原声」行显示「原声重放 · 全局压音」 |
| 27 | 设置里关闭「全局限定压音」 | 压音改由 content 改页面 `<video>.volume` 完成（顶层 frame 生效，iframe/WebAudio 站点不再压音） |
| 28 | 设置里关闭「原声重放」 | 标签页原声完全静音（Chrome 抓音已静音），只听到中文配音；字幕仍正常 |
| 29 | 调节「恢复延迟」300/800/3000ms | 说话结束后原声恢复的延迟随之变化，duck/恢复是渐变（约 160ms），无爆音 |
| 30 | 对比：未开始同传时页面声音 vs 开始后 | 开始后声音只来自扩展的 offscreen 重放（音质不变），**不会出现双声**；若听到双声/无原声见排障 |
| 31 | 播放视频，在 Chrome 聚焦时按 **Alt+Shift+N** | 浮层 toast「已记笔记 @ mm:ss」；`data/notes/<video>.json` 新增一条（含双语引用/视频链接，工作台笔记本可见）；popup 今日笔记 +1 |
| 32 | 浮层面板勾选「附页面截图」→ 点「记笔记」 | 笔记带截图：`data/notes/assets/` 出现 PNG，笔记数据含 imageUrl；页面不可截时降级无图并提示 |
| 33 | 关闭引擎（kill `npm start`）后按 Alt+Shift+N 两次 | toast「引擎未连接，已排队（N）」；popup 显示待同步数；重启引擎后回到 popup 或再记一条 → 自动 flush，待同步归 0 |
| 34 | 原生全屏（容器型或裸 video+兼容）中按 Alt+Shift+N | 仍能记笔记并看到 toast（快捷键是浏览器级，不受全屏影响） |
| 35 | 停止同传后（未关闭页面）按 Alt+Shift+N | 仍可用缓存的最后一句字幕记笔记；无字幕时记「（无字幕）」 |
| 36 | popup →「打开笔记本」 | 打开 `http://127.0.0.1:8787/studio/?notes=1`，工作台切到笔记视图（若工作台尚未实现 notes 面板则显示主界面） |
| 37 | popup →「导出 Markdown」 | 调用 `POST /api/notes/export`，显示落盘路径 `data/exports/<slug>-<date>.md`；引擎未启动时给 npm start 引导 |
| 38 | 连续记 3 条后刷新页面再按 Alt+Shift+N | 视频/字幕上下文重建；同一视频笔记归到同一 id（元数据加载前记录的可能另归，见限制） |
| 39 | 播放带有 PPT/代码/板书的视频，确认 `visionOcr` 开、附截图开，按 Alt+Shift+N | 浮层先 toast「正在识别画面文字…」，随后「已记笔记 @ mm:ss（含画面文字）」；笔记正文出现 `**画面文字**（OCR）：` 代码块，内容为画面上的文字 |
| 40 | 画面无文字（纯人脸/风景）时记笔记 | 不出现空 OCR 代码块；笔记照常保存（无画面文字段落） |
| 41 | popup 打开（引擎 v0.5 在线） | 「画面」行显示 `OCR macos-vision · VLM …已配置/未配置`；旧引擎显示「未检测到视觉接口（旧引擎）」 |
| 42 | 开启「画面理解（VLM，慢）」后记笔记 | 等待 toast 提示 20-30s；完成后笔记追加 `**画面理解**：` 描述；关闭开关后恢复快速记录 |
| 43 | 用旧版引擎（无 /api/vision/*）记笔记 | 视觉调用静默跳过（控制台无未捕获错误），笔记正常保存且无视觉段落 |

## 已知限制 / TODO

- **无法自动化验证真实 tabCapture**：本机/CI 无法在无头环境点击扩展图标并播放真实视频，自动测试只做 manifest、静态检查、纯函数单测、线协议冒烟；音画同步、真实抓音、全屏/导出/SRT 下载必须按上面的手动清单验证。
- **笔记截图**依赖 activeTab/用户手势：快捷键与 popup 点击可用；页面受限（chrome://、PDF 等）或权限未授予时自动降级为无图笔记并提示。
- **笔记离线队列只保存文本**（不保存截图）：离线期间截图上传失败会丢弃截图，笔记照常排队；队列上限 50 条，超出丢最旧。
- 笔记 videoId 由 url+title+时长生成：视频元数据（duration）尚未加载时记录的第一条可能归入另一 id，加载完成后的笔记会归到带时长的 id；同一视频标题变化（站点改标题）也会导致 id 变化。
- 笔记写入/导出依赖本地引擎 Notes API（`docs/CONTRACTS.md` §7.6）；引擎未实现/未启动时仅能排队 + `npm start` 引导，不影响字幕主链路。
  实现说明：优先 `POST /api/notes`（笔记库存档、支持 imageUrl，工作台笔记本/导出可见）；若引擎只有 quick 路由则回退
  `POST /api/notes/quick`（写每日摘录 `quick-YYYY-MM-DD.md`，截图降级为无图）。
- 「打开笔记本」跳到 `/studio/?notes=1`，笔记面板由工作台负责；若该版本工作台未实现 notes 视图，会显示主界面（扩展侧不报错）。
- **画面文字/画面理解依赖引擎 `/api/vision/*` 与截图**：未附截图、截图上传失败、旧引擎无视觉端点或 OCR/VLM 未配置时静默跳过（笔记仍保存）；OCR 准确率取决于画面清晰度/字体/语言，复杂公式/代码可能有误。
- **画面理解（VLM）慢且消耗模型额度**：默认关闭；开启后每次记笔记多等约 20-30s（超时 45s 会降级为仅 OCR/无视觉），适合「停下来精读某一帧」而不是连续打点。
- 视觉能力健康状态（popup「画面」行）来自 `GET /api/vision/health`，引擎未启动/旧版时显示不可用，不影响记笔记。
- 快捷键是 **Chrome 命令**，只在浏览器窗口聚焦时触发（VSCode 等外部编辑器内无法直接触发 OS 级快捷键）；可切回浏览器按 `Alt+Shift+N`，或使用浮层/popup 按钮。
- 截图是 `captureVisibleTab`（当前可见区域），会包含页面 UI/水印；受 DRM 保护页面可能黑屏或失败，失败自动降级无图。
- **原生全屏的浏览器限制（v0.3 尽力解决）**：容器型全屏（YouTube/B 站）一直正常；裸 `<video>` 全屏通过
  page-hook 包裹容器解决，但以下情况会回退原生全屏（浮层不可见，并提示）：页面用非标准方式进入全屏
  （浏览器原生控件、iOS `webkitEnterFullscreen`、跨进程 iframe 内部全屏）、站点异步/延迟调用
  `requestFullscreen` 导致包裹失败、页面在包裹期间重建 video 元素。
- **SRT 时间轴**：SRT 使用客户端会话时间轴（第一段音频为 0），不是视频文件自身的 `currentTime`；若需要与视频文件精确对齐，后续可用 `tMsBase`/视频时间戳扩展协议（当前契约未要求）。
- SRT 只累积最近 400 句（约几十分钟），超长课程可分多次导出；刷新页面/重启扩展后 background 会从 `chrome.storage.session` 恢复上次累积。
- 压音：v0.3 起主方案是对抓取到的标签页音频做全局限定压音（iframe/WebAudio 都能压）；
  兜底方案（关闭全局限定压音时）仍只作用于页面顶层 frame 的 `<video>/<audio>` 元素。
- **双声/无原声说明**：Chrome `tabCapture` 抓取后标签页本地声音会被静音，所以正常只有 offscreen 一条原声输出，
  不会双声；关闭「原声重放」= 完全静音原声只听配音。若站点通过系统级/独立进程输出音频（极少数 DRM 播放器、
  桌面客户端内嵌页），抓音可能拿不到该声音，此时原声重放/压音对它无效（页面仍可能自己出声）。
- 全局限定压音依赖 offscreen 的 AudioContext 处于 running；若浏览器挂起 offscreen 音频，会退化为页面音量兜底。
- 克隆音色依赖引擎侧能力：当前 Token Plan 不支持 `voice_clone` 时会自动降级为预设音色（浮层/弹窗会提示降级原因）。
- 同一时间只支持一个标签页抓音（`tabCapture` 会话为全局单例逻辑）；引擎地址修改对运行中的会话不生效，需停止后重新开始。
- 无扩展图标 PNG（manifest 未声明 `icons`，Chrome 显示默认图标）；如需图标请另加 PNG 并在 manifest 声明。
- `dub` 播放使用默认采样率 AudioContext；如果系统输出设备被切换/挂起，可能出现短时无声，停止再开始可恢复。
- 极端长句会被字幕层折叠为最多 2 行（`maxCharsPerLine` 由引擎 subs 配置控制），超长内容以 … 截断。
- service worker 被回收后，popup 首次打开可能需要 1 个消息往返恢复状态（<100ms），期间按钮短暂可用属正常。

## 自动化测试

```bash
cd livedub
node --test tests/extension.test.mjs
```

覆盖：
- `manifest.json`：MV3、权限集合、`content_scripts` `<all_urls>` + `all_frames:false`、action popup、module service worker、无远程代码；
- 所有扩展 JS 的 `node --check` 语法检查；
- `lib/pcm.js` 纯函数：float32↔s16、s16le、48k→16k 重采样、二进制音频帧与 `engine/protocol.mjs` **字节级一致**、base64、hello 与 `normalizeHello` 兼容、文本清洗/截断、duck 状态机；
- `lib/constants.js`：默认引擎地址、URL 规范化、工作台地址推导（/studio/）、健康检查地址、消息类型/设置默认值；
- `lib/ui.js`：全屏宿主选择/迁移决策、字幕停靠/避让布局、背景/透明度/字号/压音规范化（含 v0.1 subsPos 迁移）；
  v0.3 原声总线增益 `resolveReplayGain`、duck 恢复延迟钳制、裸 video 全屏包裹/恢复决策；
- `lib/srt.js`：SRT 时间戳、caption 排序/防重叠/兜底时长、双语行折叠、文件名清洗与时间戳；
- **线协议冒烟**：用 Node 起一个 `engine/ws.mjs` 回环服务，验证扩展的 `hello` + 二进制音频帧 + `control stop` 能被引擎解析；
- `computeDubPlayhead`：dub 按 `startMs` 排期、落后立即播；
- `lib/notes.js`（v0.4）：videoId 稳定/URL 规范化、quick note 请求体/Markdown、离线队列（入队/上限/flush 成功与失败/持久化）、今日计数、时间码、Notes API URL/响应解析；
- `lib/notes.js`（v0.5）：画面文字清洗/2000 截断/反引号围栏自适应、画面理解段落、正文拼接（原文结构保留）、quick 文本兜底、OCR/analyze 响应解析、视觉 health 解析（含旧引擎降级）；
- `page-hook.js`：MAIN world 猴补 `requestFullscreen`、裸 video 包裹/回滚、postMessage 协作协议；
- content/background/offscreen/popup 的关键实现静态断言（user gesture、offscreen reasons、Shadow DOM、
  v0.3 原声总线 duck/恢复、全局限定压音让位、压音 800ms 等）。
