#!/usr/bin/env node
/**
 * livedub 快捷笔记 CLI —— 边看边实现时，从终端/编辑器把「当前进度 + 灵感」记进笔记库。
 *
 * 在线：POST 到本地引擎 `/api/notes/quick`（默认 http://127.0.0.1:8787）。
 * 离线（引擎未启动 / 请求失败）：直接追加到 `data/notes/quick-YYYY-MM-DD.md`，格式与服务端一致。
 *
 * 用法：
 *   node scripts/note.mjs "今天学了反向传播：链式法则 + 计算图"
 *   node scripts/note.mjs "这行代码为什么要 detach？" --video "MIT 6.S191 Lecture 2" --time 12:34
 *   node scripts/note.mjs "对比三种优化器" --url "https://example.com/course" --tag optimizer --tag todo
 *   node scripts/note.mjs "截图笔记" --video "CS231n" --time 3:20 --screenshot /tmp/frame.png
 *   node scripts/note.mjs --help
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
  console.log(`livedub note — 快捷笔记 CLI

用法：node scripts/note.mjs "<笔记内容>" [选项]

选项：
  --video <title>       视频标题（默认「未命名课程」）
  --url <url>           视频地址（用于生成稳定的 video id）
  --time <mm:ss|hh:mm:ss>  当前视频时间（默认 00:00）
  --t-ms <ms>           直接给毫秒
  --tag <tag>           标签，可重复
  --source <cli>        来源标记（默认 cli）
  --engine <url>        引擎地址（默认 $LIVEDUB_ENGINE_URL 或 http://127.0.0.1:8787）
  --screenshot <png>    附带截图（>4MB 或非 PNG 会被拒绝；失败自动降级纯文字）
  --no-ocr              不识别截图中的画面文字
  --vision              额外做画面理解（VLM，慢 ~20-30s；默认关闭）
  --no-offline          引擎不可用时不要写本地降级文件（只报错）
  --print               仅打印将写入的 Markdown，不落盘/不发请求
  -h, --help

环境变量：
  LIVEDUB_ENGINE_URL    引擎 HTTP 地址（默认 http://127.0.0.1:8787）
`);
  process.exit(0);
}

function arg(name, fallback = null) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return fallback;
  return v;
}
function has(name) {
  return argv.includes(name);
}
function multi(name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[i + 1]);
  }
  return out;
}

const flagsWithValue = new Set(['--video', '--url', '--time', '--t-ms', '--tag', '--source', '--engine', '--screenshot']);
const textParts = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    if (flagsWithValue.has(a)) i += 1;
    continue;
  }
  textParts.push(a);
}
const text = textParts.join(' ').trim();
if (!text) {
  console.error('✖ 缺少笔记内容。示例：node scripts/note.mjs "今天的笔记"');
  process.exit(1);
}

const engineUrl = String(arg('--engine', process.env.LIVEDUB_ENGINE_URL || 'http://127.0.0.1:8787')).replace(/\/+$/, '');
const title = String(arg('--video', '未命名课程')).slice(0, 200);
const url = String(arg('--url', '')).slice(0, 2000);
const source = String(arg('--source', 'cli')).slice(0, 30);
const tags = [...new Set(multi('--tag').map((t) => String(t).slice(0, 40)))].slice(0, 20);

function parseTimeToMs(value) {
  if (!value) return 0;
  if (value.includes(':')) {
    const parts = value.split(':').map((x) => Number(x) || 0);
    if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
    if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
    return 0;
  }
  return Math.max(0, Math.round((Number(value) || 0) * 1000));
}

const tMsRaw = arg('--t-ms', null);
const tMs = tMsRaw !== null && Number.isFinite(Number(tMsRaw))
  ? Math.max(0, Number(tMsRaw))
  : parseTimeToMs(arg('--time', '0:00'));
const timeLabel = formatHms(tMs);

function formatHms(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hh = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

function videoId({ url, title }) {
  const src = url || title;
  let hash = 5381;
  for (const ch of src) hash = ((hash * 33) ^ ch.codePointAt(0)) >>> 0;
  const slug = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'video';
  return `${slug}-${hash.toString(36)}`;
}

const video = { id: videoId({ url, title }), title, ...(url ? { url } : {}) };

let bodyText = text;

function buildMarkdown() {
  const lines = [];
  const link = url ? `[${title}](${url})` : title;
  lines.push(`### ${timeLabel} · ${link}`);
  lines.push('');
  lines.push(bodyText);
  if (tags.length) lines.push('', tags.map((t) => `#${t.replace(/\s+/g, '-')}`).join(' '));
  return lines.join('\n');
}

let markdown = buildMarkdown();

if (has('--print')) {
  console.log(markdown);
  process.exit(0);
}

async function postJson(pathname, body, { raw = false, timeoutMs = 10000 } = {}) {
  const res = await fetch(`${engineUrl}${pathname}`, {
    method: 'POST',
    headers: raw ? { 'content-type': raw } : { 'content-type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(data.message || data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function uploadScreenshot(filePath) {
  if (!filePath) return null;
  const abs = path.resolve(filePath);
  const stat = fs.statSync(abs);
  if (stat.size > 4 * 1024 * 1024) throw new Error(`截图超过 4MB（${(stat.size / 1048576).toFixed(1)}MB）`);
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('截图必须是 PNG');
  const data = await postJson('/api/notes/assets', buf, { raw: 'image/png' });
  return data.url;
}

function appendOffline() {
  const dir = path.join(ROOT, 'data', 'notes');
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const file = path.join(dir, `quick-${day}.md`);
  const header = fs.existsSync(file) ? '' : `# livedub 快捷笔记 · ${day}\n\n`;
  fs.appendFileSync(file, `${header}${markdown}\n\n`, 'utf8');
  return file;
}

async function main() {
  let engineOk = true;
  let result = null;
  let screenshotUrl = null;
  try {
    if (arg('--screenshot')) {
      screenshotUrl = await uploadScreenshot(arg('--screenshot'));
      let ocrText = '';
      let caption = '';
      if (screenshotUrl && !has('--no-ocr')) {
        try {
          const ocrRes = await postJson('/api/vision/ocr', { imageUrl: screenshotUrl }, { timeoutMs: 15000 });
          ocrText = String(ocrRes.text ?? '').trim();
        } catch (err) {
          console.error(`! 画面文字识别失败（已跳过）：${err.message}`);
        }
      }
      if (screenshotUrl && has('--vision')) {
        try {
          const an = await postJson('/api/vision/analyze?mode=both', { imageUrl: screenshotUrl }, { timeoutMs: 120000 });
          ocrText = ocrText || String(an.ocr?.text ?? '').trim();
          caption = String(an.caption?.text ?? '').trim();
        } catch (err) {
          console.error(`! 画面理解失败（已跳过）：${err.message}`);
        }
      }
      if (ocrText) bodyText += `\n\n**画面文字**（OCR）：\n\n\`\`\`\n${ocrText.replace(/\`\`\`/g, "'''")}\n\`\`\``;
      if (caption) bodyText += `\n\n**画面理解**：\n\n${caption}`;
      markdown = buildMarkdown();
      const note = await postJson('/api/notes', {
        video,
        tMs,
        body: bodyText,
        tags,
        kind: 'quick',
        source,
        ...(screenshotUrl ? { imageUrl: screenshotUrl } : {}),
      });
      result = { path: '(engine)', markdown, note: note.note, screenshotUrl, ocrText, caption };
    } else {
      result = await postJson('/api/notes/quick', { video, tMs, text, source, ...(tags.length ? { tags } : {}) });
    }
  } catch (err) {
    engineOk = false;
    if (has('--no-offline')) {
      console.error(`✖ 引擎不可用且指定了 --no-offline：${err.message}`);
      process.exit(1);
    }
    const file = appendOffline();
    result = { path: file, markdown, offline: true, reason: err.message };
  }
  if (engineOk) {
    console.log(`✔ 已记笔记 ${timeLabel} · ${title}`);
    if (result?.path && result.path !== '(engine)') console.log(`  文件: ${result.path}`);
    if (result?.screenshotUrl) console.log(`  截图: ${result.screenshotUrl}`);
    if (result?.note?.id) console.log(`  笔记 ID: ${result.note.id}`);
  } else {
    console.log(`! 引擎未连接（${engineUrl}），已写入本地降级文件：`);
    console.log(`  ${result.path}`);
    console.log('  启动引擎后可在 /studio/ 笔记面板看到服务端笔记（降级文件仍可用 Obsidian 打开）。');
  }
}

main().catch((err) => {
  console.error(`✖ note 失败：${err.message}`);
  process.exit(1);
});
