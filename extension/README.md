# livedub Chrome 扩展（MV3）

看教学视频（B 站 / YouTube / 网课平台）时的**本地实时同传**扩展：

1. 抓取当前标签页的声音（`tabCapture`）；
2. 通过 WebSocket 推给本机 livedub 引擎（默认 `ws://127.0.0.1:8787/ws`）；
3. 引擎做流式 whisper 识别 → 增量翻译 → 中文 TTS 配音（优先克隆讲师音色）；
4. 扩展在页面上显示**双语字幕浮层**，并播放中文配音；说话时自动压低原声。

> 协议、时间轴、事件定义见 `docs/CONTRACTS.md` §3；引擎入口 `engine/server.mjs`。
> 本目录零 npm 依赖、无远程代码 / CDN / 内联脚本，所有资源随扩展本地打包。

## 目录结构

```
extension/
├── manifest.json          # MV3 清单：权限 / content script / popup / service worker
├── background.js          # service worker（module）：开始/停止、offscreen 生命周期、事件转发、状态
├── offscreen.html/js      # 隐藏页面：tabCapture 消费、AudioWorklet 16k PCM、WS、配音播放
├── content.js             # classic content script：Shadow DOM 浮层、双语字幕、状态胶囊、压音
├── popup.html/js          # 工具栏弹窗：引擎地址、开始/停止、音色模式、延迟、错误
├── lib/
│   ├── constants.js       # 共享常量：默认地址 / storage key / 消息类型 / 设置默认值 / URL 规范化
│   └── pcm.js             # 纯函数：PCM 编解码、重采样、base64、hello、文本清洗、duck 状态机
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
- 压音：content script 记录页面 `video/audio` 原始 `volume`，引擎状态 `speaking` 或收到 `dub` 时把音量设为 `原音量 × duckRatio`（默认 0.18），空闲 800ms 后恢复；停止/异常时全部恢复。

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

## 已知限制 / TODO

- **无法自动化验证真实 tabCapture**：本机/CI 无法在无头环境点击扩展图标并播放真实视频，自动测试只做 manifest、静态检查、纯函数单测；音画同步、真实抓音必须按上面的手动清单验证。
- 压音只作用于页面里可见的 `<video>/<audio>` 元素，且只在顶层 frame（manifest `all_frames: false`）：iframe 播放器（部分网课平台）与 Web Audio API 直出音频的站点不会被压音。
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
- `lib/constants.js`：默认引擎地址、URL 规范化、工作台地址推导、消息类型/设置默认值；
- **线协议冒烟**：用 Node 起一个 `engine/ws.mjs` 回环服务，验证扩展的 `hello` + 二进制音频帧 + `control stop` 能被引擎解析；
- `computeDubPlayhead`：dub 按 `startMs` 排期、落后立即播；
- content/background/offscreen/popup 的关键实现静态断言（user gesture、offscreen reasons、Shadow DOM、压音 800ms 等）。
