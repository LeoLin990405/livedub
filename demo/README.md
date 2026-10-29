# demo 产物说明

本目录由两条命令生成（全部为真实链路产物，不是占位文件）：

```bash
npm run demo:video   # scripts/make-demo.mjs -> demo/original.mp4
npm run batch        # scripts/batch.mjs    -> 下面这些文件
```

| 文件 | 说明 |
|---|---|
| `original.mp4` | 原始英文公开课示例（52.7s，1280×720，5 页幻灯片 + 英文旁白） |
| `dubbed.mp4` | **成品**：原声在配音区间自动压到 18% + 中文 AI 配音 + 烧录双语字幕（字幕由真实 ASR/翻译结果渲染） |
| `bilingual.srt` | 双语字幕（原文 + 中文译文），可直接给播放器用 |
| `session.jsonl` | 引擎事件回放流（每行一个事件：partial/segment/translation/dub/metrics…），回放页用 |
| `metrics.json` | 每句延迟指标（ASR / 翻译首字 / TTS 首包 / e2e），汇总见 `docs/MEASUREMENTS.md` |
| `demo-meta.json` | 示例视频的幻灯片时间轴与旁白脚本文本 |
| `tmp/` | 中间产物（16k/48k WAV、混音轨、无字幕版 mp4、字幕 PNG），可删除 |

## 回放（不需要重跑管线）

```bash
npm start
# 工作台：http://127.0.0.1:8787/studio/
# 回放：  http://127.0.0.1:8787/replay/?session=/demo/session.jsonl&video=/demo/original.mp4
```

回放会按事件时间轴渲染双语字幕，并按 `startMs` 播放当时合成的中文配音（base64 s16le）。

## 截图

- `docs/assets/studio-real-session.png` —— 本地工作台加载真实 `session.jsonl` 的界面（HUD 为真实延迟）
- `docs/assets/replay-real-session.png` —— 离线回放页（334 个真实事件、12 句字幕、91 段配音）
- `docs/assets/demo-bilingual-subtitled.png` —— `dubbed.mp4` 中的一帧（底部双语字幕卡片）
- `docs/assets/demo-original.png` —— 原始视频同一帧（无字幕）
