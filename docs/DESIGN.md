# livedub 设计规范（v0.7）

> 统一三端（工作台 / Chrome 扩展 / macOS 悬浮窗）的视觉与交互语言：**沉浸看课 + 学术工具**。
> 目标：视频与字幕是主体，控制与笔记是次级工具；克制、低饱和、高信息密度；动效短促、可关闭。

## 1. 设计原则

1. **内容优先**：视频/字幕占据视觉焦点；chrome（按钮/边框/图标）尽量轻，只在需要时出现。
2. **清晰层级**：同一屏最多 2 级视觉权重（主内容 / 辅助），避免面板堆叠与颜色过载。
3. **状态可读**：识别中 / 翻译中 / 播放中 / 错误 / 离线 / 已保存，都有文字 + 颜色 + 图标三重表达。
4. **短动效**：120–240ms，只用于层级变化（抽屉、toast、切换）；尊重 `prefers-reduced-motion`。
5. **可访问**：键盘可达、焦点可见、对比度 ≥4.5、命中区 ≥32px、aria 标签完整。
6. **一致性**：三端共用同一色板、字体栈、圆角、阴影与状态语义。

## 2. 色彩（jade / ink）

| Token | Dark | Light | 用途 |
|---|---|---|---|
| `--bg` | `#07080d` | `#eef1f7` | 页面底色 |
| `--surface-1` | `rgba(20,23,34,.82)` | `rgba(255,255,255,.92)` | 卡片/浮层 |
| `--surface-2` | `rgba(28,32,46,.9)` | `#ffffff` | 嵌套面板/输入 |
| `--surface-3` | `rgba(38,44,62,.92)` | `#f4f6fb` | 悬停/选中底 |
| `--border` | `rgba(255,255,255,.08)` | `rgba(15,23,42,.09)` | 默认描边 |
| `--border-strong` | `rgba(255,255,255,.16)` | `rgba(15,23,42,.18)` | 强调描边/焦点 |
| `--text` | `#e9ebf2` | `#1d2635` | 正文 |
| `--text-strong` | `#f8fafc` | `#0b1220` | 标题/字幕译文 |
| `--text-2` | `#a8b0c3` | `#4b566b` | 次级文字 |
| `--text-3` | `#7d8598` | `#6b7688` | 弱提示（大字号才用） |
| `--accent` | `#5eead4` | `#0f9488` | 主强调/进度/焦点 |
| `--accent-ink` | `#042f2b` | `#ffffff` | 强调色上的文字 |
| `--ok` | `#34d399` | `#0f9d75` | 成功/已保存 |
| `--busy` | `#60a5fa` | `#2563eb` | 处理中 |
| `--warn` | `#fbbf24` | `#b45309` | 警告/排队 |
| `--err` | `#fb7185` | `#dc2626` | 错误 |

## 3. 字体与字号

```css
--sans: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif;
--mono: "SF Mono", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace;
```

| 角色 | 字号/行高 | 字重 | 说明 |
|---|---|---|---|
| Display | 28/34 | 650 | 空态/欢迎标题 |
| H1 | 20/28 | 620 | 页面/面板标题 |
| H2 | 15/22 | 600 | 分组标题 |
| Body | 13.5/20 | 430 | 正文 |
| Small | 12/17 | 450 | 辅助/说明 |
| Caption | 11/15 | 500 | 状态/标签（mono 数字） |
| Subtitle 译文 | 22–26/32 | 620 | 浮层/字幕舞台 |
| Subtitle 原文 | 13.5/20 | 430 | 次级 |

数字（延迟/时间戳/字数）统一 `font-variant-numeric: tabular-nums`；长文本行宽 ≤72ch。

## 4. 间距 / 圆角 / 阴影

- 间距阶梯：`4 8 12 16 20 24 32 40`；面板内边距 16/20；卡片间距 12/16。
- 圆角：`--radius-xs:8px`、`--radius-sm:12px`、`--radius:16px`、`--radius-lg:20px`、`--radius-pill:999px`。
- 阴影：`--shadow-card`（大范围柔影 + 内外描边）、`--shadow-pop`（浮层/弹窗）、`--shadow-focus`（焦点环）。
- 焦点环：`outline: 2px solid color-mix(in oklab, var(--accent) 55%, transparent); outline-offset: 2px;`，仅 `:focus-visible`。
- 动效：`--dur-fast:120ms`、`--dur-base:180ms`、`--dur-slow:240ms`、`--ease-out: cubic-bezier(.2,.7,.3,1)`。

## 5. 组件规范

- **按钮**：`primary`（accent 填充/accent-ink 文字）、`soft`（surface-3 底）、`ghost`（透明/悬停 surface-3）、`danger`（err 文字/淡底）、`icon`（32×32，圆角 10）。所有按钮：hover/active/focus-visible/disabled/loading 五态。
- **开关/分段**：switch 28×16 轨道；segmented 用 surface-2 容器 + 选中 surface-3/accent 文字；必须带可见 label 或 aria-label。
- **chip/badge**：pill 圆角、11–12px；语义色只用文字/圆点，不整块高饱和。
- **toast**：右下角堆叠（浮层除外），图标 + 单行标题 +（可选）详情；4s 自动消失、可关闭、最多 3 条；`aria-live="polite"`。
- **dialog**：surface-1 + 20px 圆角 + backdrop blur；标题/说明/操作右对齐；Esc 关闭；焦点锁定。
- **空态**：图标 + 一句说明 + 1–2 个主操作；不放大段技术错误。
- **skeleton**：用于生成/加载列表；禁止整页 spinner。

## 6. 三端布局

### 工作台（studio，≥1100px）
```
┌──────────────────────────────────────────────────────┐
│ topbar: brand · 状态胶囊 · 延迟/趋势 · 主题 · ⌘K · ?   │
├───────────────┬──────────────────────────┬───────────┤
│ 视频舞台       │ 字幕舞台（当前句/历史）     │ dock      │
│ (16:9)        │                          │ 字幕/笔记/设置 │
├───────────────┴──────────────────────────┴───────────┤
│ controlbar: 播放/停止 · 音量 · 字幕 · 音色 · 笔记 · PiP │
└──────────────────────────────────────────────────────┘
```
- ≤1100px：dock 变右侧抽屉覆盖；≤720px：单列 + 底部 tab 切换“视频/字幕/笔记/设置”。
- 笔记工作区：左 list（搜索/过滤 chips/章节分组） + 右 editor/预览；窄屏切换视图。

### Chrome 扩展
- 字幕浮层：底部居中、最大宽 880px、圆角 16、玻璃背景；译文 22–24px/原文 13.5px；顶部 2px accent 进度线；状态 pill 右上；控制条 hover 出现，8s 无操作隐藏；拖动把手顶部。
- 面板：360–400px 宽，字幕/笔记/设置三段；空态/离线引导卡统一。
- popup：320px 宽品牌头 + 引擎状态 + 主操作 + 笔记卡 + 快捷 grid + footer。

### macOS 悬浮窗
- NSPanel 无边框、圆角 18–20、`NSVisualEffectView` 材质；宽度默认 760pt（字号联动），底部居中默认；译文 22–26pt semibold / 原文 13–14pt；状态行圆点+延迟；悬停显示微型工具条；点击穿透可切换；设置用独立窗口（分组表单 + 即时生效 + 恢复默认）。

## 7. 可访问性检查清单

- [ ] 所有交互控件键盘可达，`:focus-visible` 可见（≥2px accent 环）。
- [ ] 图标按钮有 `aria-label`/tooltip；tab rail 使用 `role=tablist/tab/tabpanel` + 左右键。
- [ ] 文本对比度：正文/次级 ≥4.5:1（大字号 ≥3:1）；状态不只靠颜色（圆点+文字）。
- [ ] 动效尊重 `prefers-reduced-motion: reduce`（关闭位移/呼吸/闪烁）。
- [ ] 命中区 ≥32px（桌面端 ≥28pt）；toast/状态有 `aria-live`。
- [ ] 空态/错误有可读下一步，不显示原始堆栈。

## 8. 验收截图（v0.7）

工作台：dark 主页 / light 主页 / 笔记工作区 / 命令面板 / 生成进度 / 窄屏 / replay；扩展：浮层 / 面板 / popup；
macOS：浮层双语 / 状态与 toast / 设置窗口。截图放 `docs/assets/`，README 与各端 README 引用。

## 9. 代码落点

| 端 | 落点 |
|---|---|
| 工作台 | `studio/index.html`、`studio/styles.css`（tokens + 组件）、`studio/app.mjs`、`studio/replay.*` |
| 扩展 | `extension/content.js`（Shadow DOM CSS）、`extension/popup.html/js`、`extension/lib/ui.js` |
| macOS | `apps/macos/Sources/OverlayWindow.swift`、`SettingsWindow.swift`、`main.swift` |
