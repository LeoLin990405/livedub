#!/usr/bin/env node
/**
 * livedub 本地引擎服务：HTTP（静态工作台 + 只读 API）+ WebSocket（/ws 实时同传）。
 *
 * 职责边界：
 * - 传输层：静态托管 studio/（/studio/、/replay/）与 demo/（回放素材）；HTTP API：/health、/api/config、/api/voices；
 *   WebSocket：hello -> createSession() 建会话，二进制音频帧 / JSON 音频 / control/config/glossary 全部转发给会话，
 *   会话事件原样下发；连接关闭时调用 session.close('client disconnected')。
 * - 会话编排在 engine/pipeline.mjs（Lead scope）。本文件只依赖契约，不关心 ASR/翻译/TTS 细节。
 *   createSession 由 `opts.sessionFactory` 注入（测试用假会话/真 pipeline + mock deps），默认动态 import './pipeline.mjs'；
 *   pipeline 暂缺时回退内置演示会话（mock ASR/翻译/TTS），保证工作台可先跑通。
 * - 安全：只监听本机；WS checkOrigin 仅允许 chrome-extension://* 与本机 http(s)；静态服务白名单目录 + 防目录穿越；
 *   /api/config 走 config.publicConfig + 深删密钥字段；任何日志都不打印 apiKey。
 *
 * 用法：
 *   node engine/server.mjs [--port 8787] [--host 127.0.0.1] [--open] [--demo] [--verbose]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  AUDIO_FRAME_MS,
  AUDIO_INPUT_SAMPLE_RATE,
  MAX_AUDIO_FRAME_BYTES,
  MSG,
  PROTOCOL_VERSION,
  decodeAudioFrame,
  encodeEvent,
  errorEvent,
  normalizeHello,
  parseClientMessage,
  sanitizeGlossary,
  statusEvent,
} from './protocol.mjs';
import { base64Pcm, pcmFromBase64 } from './audio.mjs';
import {
  PROJECT_ROOT,
  deepMerge,
  loadConfig,
  publicConfig,
  readJsonIfExists,
  resolveWhisperModel,
} from './config.mjs';
import { attachWebSocketServer } from './ws.mjs';
import { createMockAsr, createMockTranslator, createMockTts } from './mock.mjs';

// ------------------------------------------------------------------ constants

export const DEFAULT_PORT = 8787;
export const DEFAULT_HOST = '127.0.0.1';
/** 最大并发会话（config.server.maxSessions 可覆盖） */
export const DEFAULT_MAX_SESSIONS = 4;
/** 会话初始化上限：whisper-server 冷启动 ~20-30s，留余量 */
export const DEFAULT_READY_TIMEOUT_MS = 35_000;
/** 建链后必须尽快发 hello，否则关闭空连接 */
export const DEFAULT_HELLO_TIMEOUT_MS = 30_000;
/** 音频帧积压上限（每帧 100ms，约 20s），超了丢帧防内存膨胀 */
const MAX_QUEUED_AUDIO_FRAMES = 200;
/** 音色列表接口单步超时 */
const VOICES_TIMEOUT_MS = 5_000;
/** UI 设置（工作台选择，持久化到 data/ui-settings.json，只影响之后建立的会话） */
const UI_SETTINGS_FILE = 'ui-settings.json';
const UI_SETTINGS_VERSION = 1;
const SETTINGS_BODY_LIMIT = 16 * 1024;
const ASR_ENGINE_META = Object.freeze({
  'whisper-local': {
    label: '本地 whisper',
    shortLabel: '本地',
    cloud: false,
    privacyTitle: '音频不离开本机',
    privacyDetail: '本地 whisper 识别，音频与字幕只在你的电脑内处理，不上传云端。',
  },
  'minimax-cloud': {
    label: '云端 MiniMax',
    shortLabel: '云端',
    cloud: true,
    privacyTitle: '音频会上传到 MiniMax',
    privacyDetail: '云端语音识别会把音频上传到 MiniMax 用于转写；不经过浏览器厂商等其它第三方。',
  },
  mock: {
    label: 'Mock（开发用）',
    shortLabel: 'Mock',
    cloud: false,
    privacyTitle: '音频不离开本机（Mock）',
    privacyDetail: 'Mock ASR 仅用于开发与测试，不会识别真实音频，也不会上传。',
  },
});
const ASR_ENGINE_VALUES = Object.freeze(Object.keys(ASR_ENGINE_META));
const VOICE_MODE_VALUES = Object.freeze(['clone-first', 'preset']);
const DESKTOP_APP_RELATIVE_PATH = 'apps/macos/build/livedub.app';
const DESKTOP_BUILD_COMMAND = 'bash scripts/build-macos.sh';

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.ndjson': 'application/x-ndjson; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.srt': 'application/x-subrip; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
});

/** 密钥字段名（大小写不敏感）：/api/config 与日志统一过滤 */
const SECRET_KEY_RE = /^(api_?key|apikey|token|secret|password|authorization|access_?key|refresh_?token)$/i;

// -------------------------------------------------------------------- helpers

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function makeLog(log) {
  if (typeof log === 'function') return log;
  return (msg, ...rest) => {
    if (process.env.LIVEDUB_DEBUG) console.error(`[livedub] ${msg}`, ...rest);
  };
}

let pkgCache = null;
function packageInfo() {
  if (pkgCache === null) {
    pkgCache = readJsonIfExists(path.join(PROJECT_ROOT, 'package.json')) ?? {};
  }
  return pkgCache;
}

function toProjectRelative(file) {
  if (!file) return null;
  const abs = path.resolve(file);
  const root = path.resolve(PROJECT_ROOT);
  if (abs === root) return '.';
  if (abs.startsWith(root + path.sep)) return path.relative(root, abs).split(path.sep).join('/');
  return abs;
}

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), Math.max(1, ms));
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 深拷贝并删除一切密钥字段（/api/config 兜底，publicConfig 之后再过一遍） */
export function scrubSecrets(value, seen = new WeakSet()) {
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) continue;
    out[key] = scrubSecrets(item, seen);
  }
  return out;
}

function formatHost(host) {
  const h = String(host ?? DEFAULT_HOST);
  if (h === '0.0.0.0' || h === '::' || h === '') return '127.0.0.1';
  if (h.includes(':') && !h.startsWith('[')) return `[${h}]`;
  return h;
}

function sendJson(res, status, payload, { head = false } = {}) {
  if (res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(head ? undefined : body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  if (res.writableEnded) return;
  const body = Buffer.from(String(text), 'utf8');
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function redirect(res, location) {
  if (res.writableEnded) return;
  res.writeHead(302, { Location: location, 'Content-Length': 0, 'Cache-Control': 'no-store' });
  res.end();
}

function notFound(res, detail = 'not found') {
  sendText(res, 404, `livedub: ${detail}\n`);
}

/** 静态路径归一化：拒绝 ..、空字节，确保落在白名单根目录内 */
function resolveStaticFile(root, pathname, prefix) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { error: 400, message: '路径编码非法' };
  }
  if (decoded.includes('\0')) return { error: 400, message: '路径含空字节' };
  const segments = decoded.split('/');
  if (segments.includes('..')) return { error: 403, message: '禁止目录穿越' };
  const rel = decoded.slice(prefix.length).replace(/^\/+/, '');
  const resolved = path.resolve(root, rel || 'index.html');
  const rootAbs = path.resolve(root);
  if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) {
    return { error: 403, message: '禁止访问白名单之外的路径' };
  }
  return { file: resolved };
}

function parseRangeHeader(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return { invalid: true };
  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);
  if (start == null) {
    const suffix = end ?? 0;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else if (end == null || end >= size) {
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return { invalid: true };
  return { start, end };
}

// --------------------------------------------------------------- static serve

function serveStaticFile(req, res, file, log) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return notFound(res);
  }
  if (stat.isDirectory()) {
    const indexFile = path.join(file, 'index.html');
    try {
      stat = fs.statSync(indexFile);
      file = indexFile;
    } catch {
      return notFound(res, '目录不提供列表');
    }
  }
  if (!stat.isFile()) return notFound(res);

  const ext = path.extname(file).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
  const headers = {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };

  const rangeHeader = req.headers.range;
  if (rangeHeader && stat.size > 0) {
    const range = parseRangeHeader(rangeHeader, stat.size);
    if (range.invalid) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}`, 'Content-Length': 0 });
      return res.end();
    }
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
    headers['Content-Length'] = range.end - range.start + 1;
    res.writeHead(206, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file, { start: range.start, end: range.end });
    stream.on('error', (err) => {
      log(`静态文件读取失败：${err.message}`);
      res.destroy();
    });
    return stream.pipe(res);
  }

  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD' || stat.size === 0) return res.end();
  const stream = fs.createReadStream(file);
  stream.on('error', (err) => {
    log(`静态文件读取失败：${err.message}`);
    res.destroy();
  });
  stream.pipe(res);
}

// ------------------------------------------------------------- HTTP API data

/** 正在占用会话槽位的连接数（初始化中 + 已就绪） */
export function countActiveSessions(state) {
  let count = 0;
  for (const conn of state.sessions ?? []) {
    if (conn.phase === 'initializing' || conn.phase === 'ready') count += 1;
  }
  return count;
}

/** server.maxSessions 解析：优先 options，其次 config.server.maxSessions，非法回退 4 */
export function resolveMaxSessions(config, options = {}) {
  const raw = options.maxSessions ?? config?.server?.maxSessions;
  const number = Number(raw);
  if (Number.isInteger(number) && number > 0) return number;
  return DEFAULT_MAX_SESSIONS;
}


// ------------------------------------------------------- UI 设置（v0.3）

/** config 默认值 + UI overrides 合并成生效设置（只允许白名单三个字段） */
export function effectiveUiSettings(config, overrides = {}) {
  const base = {
    asr: { provider: String(config?.asr?.provider ?? 'whisper-local') },
    tts: { voiceMode: String(config?.tts?.voiceMode ?? 'preset') },
    dub: { enabled: config?.dub?.enabled !== false },
  };
  const merged = deepMerge(base, overrides && typeof overrides === 'object' ? overrides : {});
  if (!ASR_ENGINE_VALUES.includes(merged.asr?.provider)) merged.asr = { provider: 'whisper-local' };
  if (!VOICE_MODE_VALUES.includes(merged.tts?.voiceMode)) merged.tts = { voiceMode: 'preset' };
  merged.dub = { enabled: Boolean(merged.dub?.enabled) };
  return merged;
}

/**
 * 校验 UI 设置补丁：白名单字段 asr.provider / tts.voiceMode / dub.enabled。
 * 非法字段/值返回可读错误（HTTP 层映射 400），绝不接受密钥等其它字段。
 */
export function validateSettingsPatch(input) {
  const fail = (code, message, extra = {}) => ({ ok: false, error: { code, message, ...extra } });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('invalid_body', '请求体必须是 JSON 对象');
  const patch = {};
  for (const [group, value] of Object.entries(input)) {
    if (!['asr', 'tts', 'dub'].includes(group)) {
      return fail('unknown_field', `不支持的字段：${group}（允许 asr.provider / tts.voiceMode / dub.enabled）`, { field: group });
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid_body', `字段 ${group} 必须是对象`, { field: group });
    if (group === 'asr') {
      for (const [key, provider] of Object.entries(value)) {
        if (key !== 'provider') return fail('unknown_field', `不支持的字段：asr.${key}`, { field: `asr.${key}` });
        if (typeof provider !== 'string' || !ASR_ENGINE_VALUES.includes(provider)) {
          return fail('invalid_value', `asr.provider 非法：${String(provider)}（可选：${ASR_ENGINE_VALUES.join(' / ')}）`, {
            field: 'asr.provider',
            allowed: [...ASR_ENGINE_VALUES],
          });
        }
        patch.asr = { provider };
      }
    } else if (group === 'tts') {
      for (const [key, mode] of Object.entries(value)) {
        if (key !== 'voiceMode') return fail('unknown_field', `不支持的字段：tts.${key}`, { field: `tts.${key}` });
        if (typeof mode !== 'string' || !VOICE_MODE_VALUES.includes(mode)) {
          return fail('invalid_value', `tts.voiceMode 非法：${String(mode)}（可选：${VOICE_MODE_VALUES.join(' / ')}）`, {
            field: 'tts.voiceMode',
            allowed: [...VOICE_MODE_VALUES],
          });
        }
        patch.tts = { voiceMode: mode };
      }
    } else {
      for (const [key, enabled] of Object.entries(value)) {
        if (key !== 'enabled') return fail('unknown_field', `不支持的字段：dub.${key}`, { field: `dub.${key}` });
        if (typeof enabled !== 'boolean') {
          return fail('invalid_value', 'dub.enabled 必须是布尔值', { field: 'dub.enabled', allowed: [true, false] });
        }
        patch.dub = { enabled };
      }
    }
  }
  if (Object.keys(patch).length === 0) {
    return fail('empty_patch', '没有可保存的字段（允许 asr.provider / tts.voiceMode / dub.enabled）');
  }
  return { ok: true, patch };
}

/** 兼容两种 PUT 体：{settings:{...}} 或 {...}；顶层只允许 settings/version/updatedAt */
function normalizeSettingsInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: { code: 'invalid_body', message: '请求体必须是 JSON 对象' } };
  }
  if (Object.prototype.hasOwnProperty.call(body, 'settings')) {
    for (const key of Object.keys(body)) {
      if (!['settings', 'version', 'updatedAt', '_comment'].includes(key)) {
        return { ok: false, error: { code: 'unknown_field', message: `不支持的字段：${key}`, field: key } };
      }
    }
    if (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings)) {
      return { ok: false, error: { code: 'invalid_body', message: 'settings 必须是对象' } };
    }
    return { ok: true, input: body.settings };
  }
  return { ok: true, input: body };
}

function readRequestBody(req, limit = SETTINGS_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error('请求体过大（上限 16KB）');
        err.code = 'BODY_TOO_LARGE';
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => reject(err));
  });
}

/** 读取 data/ui-settings.json（不存在/脏数据都回退默认值，不抛错） */
function loadUiSettingsFromDisk(state) {
  const file = state.uiSettingsPath;
  const warnings = [];
  let persisted = null;
  let fileExists = false;
  try {
    if (fs.existsSync(file)) {
      fileExists = true;
      persisted = readJsonIfExists(file);
      if (persisted == null) warnings.push(`${toProjectRelative(file)} 解析失败，已回退默认设置`);
    }
  } catch (err) {
    warnings.push(`读取 ${toProjectRelative(file)} 失败：${err?.message ?? err}`);
  }
  let overrides = {};
  if (persisted && typeof persisted === 'object') {
    const validated = validateSettingsPatch(persisted.settings ?? persisted);
    if (validated.ok) overrides = validated.patch;
    else warnings.push(`ui-settings 已忽略：${validated.error.message}`);
  }
  return {
    overrides,
    effective: effectiveUiSettings(state.config, overrides),
    path: file,
    fileExists,
    updatedAt: typeof persisted?.updatedAt === 'string' ? persisted.updatedAt : null,
    warnings,
  };
}

/** 原子写 data/ui-settings.json（只写白名单字段 + 版本/时间，不含密钥） */
function writeUiSettingsFile(file, overrides, updatedAt) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = { version: UI_SETTINGS_VERSION, updatedAt, settings: overrides };
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function applyUiSettingsPatch(state, patch) {
  const overrides = deepMerge(state.uiSettings?.overrides ?? {}, patch);
  const updatedAt = new Date().toISOString();
  writeUiSettingsFile(state.uiSettingsPath, overrides, updatedAt);
  state.uiSettings = {
    ...(state.uiSettings ?? {}),
    overrides,
    effective: effectiveUiSettings(state.config, overrides),
    fileExists: true,
    updatedAt,
    warnings: [],
  };
  return state.uiSettings;
}

function buildUiSettingsPayload(state) {
  const ui = state.uiSettings ?? loadUiSettingsFromDisk(state);
  return {
    ok: true,
    version: UI_SETTINGS_VERSION,
    path: toProjectRelative(ui.path),
    fileExists: Boolean(ui.fileExists),
    updatedAt: ui.updatedAt ?? null,
    overrides: ui.overrides ?? {},
    settings: ui.effective ?? effectiveUiSettings(state.config, ui.overrides ?? {}),
    defaults: effectiveUiSettings(state.config, {}),
    asrEngine: asrEngineInfo(state),
    desktopApp: detectDesktopApp(state),
    warnings: Array.isArray(ui.warnings) ? ui.warnings : [],
  };
}

/** 当前生效的 ASR 引擎信息（含隐私文案；供 /health、/api/config、/api/settings 复用） */
export function asrEngineInfo(state) {
  const overrides = state.uiSettings?.overrides ?? {};
  const effective = state.uiSettings?.effective ?? effectiveUiSettings(state.config, overrides);
  const provider = effective.asr.provider;
  const meta = ASR_ENGINE_META[provider] ?? {
    label: provider,
    shortLabel: provider,
    cloud: false,
    privacyTitle: '未知 ASR 引擎',
    privacyDetail: '未识别的 asr.provider，请检查 config/livedub.config.json 或 data/ui-settings.json。',
  };
  return {
    provider,
    label: meta.label,
    shortLabel: meta.shortLabel ?? meta.label,
    cloud: Boolean(meta.cloud),
    privacy: meta.cloud ? 'cloud' : 'local',
    privacyTitle: meta.privacyTitle,
    privacyDetail: meta.privacyDetail,
    configProvider: String(state.config?.asr?.provider ?? 'whisper-local'),
    overridden: Boolean(overrides.asr?.provider),
    fallbackProvider: state.config?.asr?.fallback ?? null,
    engines: ASR_ENGINE_VALUES.filter((id) => id !== 'mock').map((id) => ({
      id,
      label: ASR_ENGINE_META[id].label,
      cloud: Boolean(ASR_ENGINE_META[id].cloud),
    })),
  };
}

/** 桌面 App 检测（apps/macos/build/livedub.app；可用 options.desktopAppPath 注入测试路径） */
export function detectDesktopApp(state) {
  const appPath = state.desktopAppPath ?? path.join(PROJECT_ROOT, DESKTOP_APP_RELATIVE_PATH);
  let available = false;
  try {
    available = fs.existsSync(appPath);
  } catch {
    available = false;
  }
  const buildScript = path.join(PROJECT_ROOT, 'scripts', 'build-macos.sh');
  let buildScriptFound = false;
  try {
    buildScriptFound = fs.existsSync(buildScript);
  } catch {
    buildScriptFound = false;
  }
  const displayPath = toProjectRelative(appPath);
  return {
    available,
    platform: process.platform,
    appPath: displayPath,
    openCommand: `open ${displayPath}`,
    buildCommand: DESKTOP_BUILD_COMMAND,
    buildScriptFound,
    hint: available
      ? '双击 .app，或在终端运行 open 命令启动桌面版；桌面版会复用本机 127.0.0.1 引擎。'
      : '在项目根目录运行构建命令生成 apps/macos/build/livedub.app；需要 macOS + Xcode Command Line Tools。',
  };
}

function buildHealth(state) {
  const config = state.config;
  const model = resolveWhisperModel(config);
  const saylessPath = config?._meta?.saylessConfigPath ?? null;
  const pkg = packageInfo();
  const engine = asrEngineInfo(state);
  const effective = state.uiSettings?.effective ?? effectiveUiSettings(config, state.uiSettings?.overrides ?? {});
  const ui = state.uiSettings ?? {};
  return {
    ok: true,
    name: 'livedub',
    version: pkg.version ?? '0.0.0',
    protocol: PROTOCOL_VERSION,
    mode: state.mode, // pipeline | demo | injected
    uptimeMs: Date.now() - state.startedAt,
    server: { host: state.host, port: state.port, url: state.url },
    providers: {
      asr: engine.provider,
      translate: config?.translate?.provider ?? null,
      translateChain: Array.isArray(config?.translate?.chain) ? config.translate.chain : [],
      tts: config?.tts?.provider ?? null,
      ttsModel: config?.tts?.model ?? null,
      voiceMode: effective.tts.voiceMode,
    },
    // 当前生效的 ASR 引擎（含云端/本地与隐私文案），下次会话使用
    asrEngine: engine,
    desktopApp: detectDesktopApp(state),
    uiSettings: {
      path: toProjectRelative(state.uiSettingsPath ?? path.join(state.dataDir ?? '', UI_SETTINGS_FILE)),
      fileExists: Boolean(ui.fileExists),
      updatedAt: ui.updatedAt ?? null,
      overridden: Object.keys(ui.overrides ?? {}).length > 0,
    },
    // Notes API 统计（不带内容）
    notes: getNotesStats(state),
    features: { dubEnabled: effective.dub.enabled },
    whisper: { found: Boolean(model), model: toProjectRelative(model) },
    sayless: { configPath: saylessPath, found: Boolean(saylessPath) },
    // activeSessions：已发 hello 并正在初始化/已就绪的会话数（不含仅建链未 hello 的空连接）
    activeSessions: countActiveSessions(state),
    sessions: { active: countActiveSessions(state), total: state.totalSessions, max: state.maxSessions },
    limits: {
      audioFrameMs: AUDIO_FRAME_MS,
      sampleRate: AUDIO_INPUT_SAMPLE_RATE,
      maxAudioFrameBytes: MAX_AUDIO_FRAME_BYTES,
    },
  };
}

/**
 * whisper-server 运行状态（尽力而为）：
 * 1) 本进程共享 server（engine/asr/index.mjs#listSharedServers）；
 * 2) 若本进程没有，再对 config 里 host:port 做一次 300ms HTTP 探测（跨进程复用场景）。
 * 任何异常都不影响 /health 返回。
 */
async function whisperRuntimeStatus(state) {
  const now = Date.now();
  if (state.whisperStatusCache && now - state.whisperStatusCache.at < 2000) return state.whisperStatusCache.value;
  const config = state.config;
  const whisperCfg = config?.asr?.whisper ?? {};
  const host = String(whisperCfg.host ?? '127.0.0.1');
  const port = Number(whisperCfg.port) || 18765;

  let inProcess = [];
  try {
    const mod = await import('./asr/index.mjs');
    if (typeof mod.listSharedServers === 'function') inProcess = mod.listSharedServers() ?? [];
  } catch {
    /* ASR 模块不可用时忽略 */
  }
  const servers = (Array.isArray(inProcess) ? inProcess : []).map((server) => ({
    pid: server?.pid ?? null,
    status: server?.status ?? null,
    baseUrl: server?.baseUrl ?? null,
    model: server?.modelPath ? toProjectRelative(server.modelPath) : null,
    refs: server?.refs ?? null,
    lastInferMs: server?.lastInferMs ?? null,
    avgInferMs: server?.avgInferMs ?? null,
  }));
  const inProcessRunning = servers.some((server) => server.status === 'ready' || server.status === 'starting');

  let reachable = null;
  if (!inProcessRunning && config?.asr?.provider === 'whisper-local') {
    reachable = await probeHttpHealth(`http://${host}:${port}/health`, 300);
  }

  const value = {
    running: inProcessRunning || reachable === true,
    source: inProcessRunning ? 'in-process' : reachable === true ? 'probe' : 'none',
    host,
    port,
    reachable,
    inProcessServers: servers,
  };
  state.whisperStatusCache = { at: now, value };
  return value;
}

/** 极短 HTTP 健康探测；失败/超时返回 false，不拖慢 /health */
function probeHttpHealth(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let request;
    try {
      request = http.get(url, (response) => {
        response.resume();
        finish(Number(response.statusCode) >= 200 && Number(response.statusCode) < 500);
      });
    } catch {
      finish(false);
      return;
    }
    request.on('error', () => finish(false));
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      finish(false);
    });
    const timer = setTimeout(() => {
      try {
        request.destroy();
      } catch {
        /* ignore */
      }
      finish(false);
    }, timeoutMs + 50);
    timer.unref?.();
  });
}

/** 关闭共享 whisper-server，避免 SIGINT/SIGTERM 后留下孤儿进程（尽力而为） */
async function closeSharedWhisperServers(state) {
  try {
    const mod = await import('./asr/index.mjs');
    if (typeof mod.closeSharedServer !== 'function') return;
    const closePromise = Promise.resolve().then(() => mod.closeSharedServer());
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), 8000);
      timer.unref?.();
    });
    const result = await Promise.race([closePromise.then(() => 'ok'), timeout]);
    clearTimeout(timer);
    if (result === 'timeout') state.log('关闭共享 whisper-server 超时（已放弃等待，进程退出会兜底清理）');
    else state.log('共享 whisper-server 已关闭');
  } catch (err) {
    state.log(`关闭共享 whisper-server 失败（不影响退出）：${err?.message ?? err}`);
  }
}

function buildPublicConfigPayload(state) {
  const snapshot = publicConfig(state.config);
  const ui = state.uiSettings ?? loadUiSettingsFromDisk(state);
  const effective = ui.effective ?? effectiveUiSettings(state.config, ui.overrides ?? {});
  // 工作台 UI 设置（data/ui-settings.json）优先，仅影响之后建立的会话；不写密钥
  snapshot.asr = { ...(snapshot.asr ?? {}), provider: effective.asr.provider };
  snapshot.tts = { ...(snapshot.tts ?? {}), voiceMode: effective.tts.voiceMode };
  snapshot.dub = { ...(snapshot.dub ?? {}), enabled: effective.dub.enabled };
  snapshot.server = { ...(snapshot.server ?? {}), host: state.host, port: state.port, url: state.url };
  snapshot.runtime = {
    ...(snapshot.runtime ?? {}),
    host: state.host,
    port: state.port,
    mode: state.mode,
    maxSessions: state.maxSessions,
    activeSessions: countActiveSessions(state),
    studioUrl: `${state.url}/studio/`,
    replayUrl: `${state.url}/replay/`,
    asrEngine: asrEngineInfo(state),
    desktopApp: detectDesktopApp(state),
    uiSettings: {
      path: toProjectRelative(state.uiSettingsPath ?? path.join(state.dataDir ?? '', UI_SETTINGS_FILE)),
      fileExists: Boolean(ui.fileExists),
      updatedAt: ui.updatedAt ?? null,
      overrides: ui.overrides ?? {},
      effective,
      warnings: Array.isArray(ui.warnings) ? ui.warnings : [],
    },
    notes: getNotesStats(state),
  };
  return { ok: true, protocol: PROTOCOL_VERSION, config: scrubSecrets(snapshot) };
}

const PRESET_VOICE_LABELS = Object.freeze({
  default: '默认音色',
  male: '男声',
  female: '女声',
  narrator: '旁白',
});

/** 由 config.tts.presetVoices / fallbacks 生成静态音色列表（/api/voices 回退值） */
export function buildPresetVoices(config) {
  const out = [];
  const seen = new Set();
  const add = (id, label, extra = {}) => {
    const voiceId = typeof id === 'string' ? id.trim() : '';
    if (!voiceId || seen.has(voiceId)) return;
    seen.add(voiceId);
    out.push({ id: voiceId, label: String(label ?? voiceId), ...extra });
  };
  const presets = config?.tts?.presetVoices ?? {};
  for (const [role, id] of Object.entries(presets)) {
    add(id, `预设 · ${PRESET_VOICE_LABELS[role] ?? role}`, { role, preset: true });
  }
  for (const fallback of config?.tts?.fallbacks ?? []) {
    if (fallback?.voiceId) {
      add(fallback.voiceId, `回退 · ${fallback.provider ?? 'tts'}`, {
        provider: fallback.provider ?? null,
        fallback: true,
      });
    }
  }
  return out;
}

function normalizeVoices(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const voice = { id, label: String(item.label ?? id).slice(0, 80) };
    if (item.gender) voice.gender = String(item.gender).slice(0, 20);
    if (item.cloned != null) voice.cloned = Boolean(item.cloned);
    if (item.provider) voice.provider = String(item.provider).slice(0, 40);
    out.push(voice);
    if (out.length >= 200) break;
  }
  return out;
}

/**
 * 尽力获取真实音色列表：T3 的 engine/tts/index.mjs#createTts().listVoices()。
 * 不经过 registry.createDeps（避免连带初始化 ASR/翻译）；失败抛错，由调用方回退预设列表。
 */
async function listVoicesBestEffort(state) {
  const { config, log } = state;
  if (typeof state.voiceLister === 'function') {
    const listed = await withTimeout(Promise.resolve().then(() => state.voiceLister({ config, log })), VOICES_TIMEOUT_MS, '音色列表获取超时');
    return listed;
  }
  const mod = await import('./tts/index.mjs');
  if (typeof mod.createTts !== 'function') throw new Error('engine/tts/index.mjs 未导出 createTts');
  const tts = await withTimeout(Promise.resolve().then(() => mod.createTts({ config, log })), VOICES_TIMEOUT_MS, 'TTS 初始化超时');
  try {
    if (typeof tts?.listVoices !== 'function') throw new Error('当前 TTS 实现不支持 listVoices()');
    return await withTimeout(Promise.resolve().then(() => tts.listVoices()), VOICES_TIMEOUT_MS, '音色列表获取超时');
  } finally {
    try {
      await tts?.close?.();
    } catch {
      /* 尽力而为 */
    }
  }
}

async function sendVoicesPayload(state, req, res, head) {
  if (state.voicesCache && Date.now() - state.voicesCache.at < 60_000) {
    return sendJson(res, 200, state.voicesCache.payload, { head });
  }
  let payload = null;
  let lastError = null;
  try {
    const listed = await listVoicesBestEffort(state);
    const voices = normalizeVoices(listed);
    if (voices.length > 0) payload = { ok: true, source: 'provider', voices, note: null };
  } catch (err) {
    lastError = String(err?.message ?? err).slice(0, 300);
    state.log(`获取实时音色列表失败，回退配置预设：${lastError}`);
  }
  if (!payload) {
    payload = {
      ok: true,
      source: 'preset',
      voices: buildPresetVoices(state.config),
      note: lastError ? '实时音色列表不可用，已回退到配置里的预设音色' : '当前使用配置里的预设音色',
    };
  }
  state.voicesCache = { at: Date.now(), payload };
  sendJson(res, 200, payload, { head });
}

// ------------------------------------------------------------- HTTP dispatch

// ------------------------------------------------------------- Notes API（v0.4）
// 共享契约（T5 扩展 / T6 macOS App 共用）：
//   VideoRef = { id, title, url?, durationMs? }
//   Note = { id, video, tMs, body(Markdown<=200KB), quotes?, tags?, imageUrl?, kind?, source, createdAt, updatedAt }
// 存储：data/notes/<videoSlug>.json；assets: data/notes/assets/；quick: data/notes/quick-YYYY-MM-DD.md；
// 导出：data/exports/<slug>-<date>.md。只落本地 data/，不写密钥；文件名/ID 仅 [A-Za-z0-9._-]。

const NOTES_MAX_BODY_BYTES = 200 * 1024;
const NOTES_MAX_JSON_BYTES = 1024 * 1024;
const NOTES_ASSET_MAX_BYTES = 4 * 1024 * 1024;
const NOTES_LIST_LIMIT_DEFAULT = 200;
const NOTES_LIST_LIMIT_MAX = 500;
const NOTE_KINDS = Object.freeze(['note', 'outline', 'quick', 'marker']);
const NOTE_SOURCES = Object.freeze(['studio', 'extension', 'macos', 'cli']);
const SAFE_RESOURCE_NAME_RE = /^[A-Za-z0-9._-]+$/;
const NOTE_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;
const NOTE_ASSET_FILE_RE = /^[A-Za-z0-9._-]+\.png$/;
const NOTES_KIND_LABELS = Object.freeze({ note: '笔记', outline: '课程大纲', quick: '快速摘录', marker: '标记' });

function notesPaths(state) {
  const notesDir = path.join(state.dataDir, 'notes');
  return { notesDir, assetsDir: path.join(notesDir, 'assets'), exportsDir: path.join(state.dataDir, 'exports') };
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 原子写（temp + rename），只写本地 data/ */
function atomicWriteFileSync(file, data) {
  ensureDirSync(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** video.id -> 安全文件名 slug（保留可读前缀 + sha1 防碰撞/大小写冲突） */
function notesSlugForVideoId(videoId) {
  const raw = String(videoId ?? '');
  const base = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 80) || 'video';
  return `${base}-${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10)}`;
}

function notesFileFor(state, videoId) {
  return path.join(notesPaths(state).notesDir, `${notesSlugForVideoId(videoId)}.json`);
}

function localDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 时间戳：HH:MM:SS */
function formatNoteTimestamp(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// ---- 校验/规范化 ----

function noteError(code, message, field) {
  return { ok: false, status: 400, error: { code, message, ...(field ? { field } : {}) } };
}

function normalizeVideoRef(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return noteError('invalid_video', 'video 必须是对象', 'video');
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id || id.length > 200) return noteError('invalid_video', 'video.id 必须是 1-200 字符的字符串', 'video.id');
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : id;
  const url = typeof raw.url === 'string' ? raw.url.trim().slice(0, 2000) : '';
  let durationMs;
  if (raw.durationMs != null) {
    const value = Number(raw.durationMs);
    if (!Number.isFinite(value) || value < 0) return noteError('invalid_video', 'video.durationMs 必须是非负数字', 'video.durationMs');
    durationMs = Math.round(value);
  }
  return {
    ok: true,
    video: { id, title: title.slice(0, 300), ...(url ? { url } : {}), ...(durationMs != null ? { durationMs } : {}) },
  };
}

function normalizeNoteTMs(raw, fallback = 0) {
  if (raw == null) return { ok: true, value: fallback };
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return noteError('invalid_tms', 'tMs 必须是非负毫秒数', 'tMs');
  return { ok: true, value: Math.round(value) };
}

function normalizeNoteBody(raw, { allowEmpty = true } = {}) {
  if (typeof raw !== 'string') return noteError('invalid_body', 'body 必须是 Markdown 字符串', 'body');
  if (!allowEmpty && raw.trim().length === 0) return noteError('invalid_body', 'body 不能为空', 'body');
  if (Buffer.byteLength(raw, 'utf8') > NOTES_MAX_BODY_BYTES) {
    return noteError('body_too_large', `body 超过 ${Math.round(NOTES_MAX_BODY_BYTES / 1024)}KB 上限`, 'body');
  }
  return { ok: true, value: raw };
}

function normalizeNoteQuotes(raw) {
  if (raw == null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return noteError('invalid_quotes', 'quotes 必须是数组', 'quotes');
  if (raw.length > 50) return noteError('invalid_quotes', 'quotes 最多 50 条', 'quotes');
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const quote = {};
    for (const key of ['t0Ms', 't1Ms']) {
      if (item[key] == null) continue;
      const value = Number(item[key]);
      if (!Number.isFinite(value) || value < 0) return noteError('invalid_quotes', `quotes.${key} 必须是非负数字`, 'quotes');
      quote[key] = Math.round(value);
    }
    for (const key of ['src', 'dst']) {
      if (typeof item[key] !== 'string' || !item[key].trim()) continue;
      quote[key] = item[key].slice(0, 2000);
    }
    if (Object.keys(quote).length > 0) out.push(quote);
  }
  return { ok: true, value: out };
}

function normalizeNoteTags(raw) {
  if (raw == null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return noteError('invalid_tags', 'tags 必须是数组', 'tags');
  if (raw.length > 20) return noteError('invalid_tags', 'tags 最多 20 个', 'tags');
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') return noteError('invalid_tags', 'tags 每项必须是字符串', 'tags');
    const tag = item.trim();
    if (!tag) continue;
    if (tag.length > 40) return noteError('invalid_tags', '单个 tag 不能超过 40 字符', 'tags');
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return { ok: true, value: out };
}

function normalizeNoteImageUrl(raw) {
  if (raw == null || raw === '') return { ok: true, value: undefined };
  if (typeof raw !== 'string') return noteError('invalid_image', 'imageUrl 必须是字符串', 'imageUrl');
  const value = raw.trim();
  if (value.length > 500) return noteError('invalid_image', 'imageUrl 过长', 'imageUrl');
  if (!/^\/api\/notes\/assets\/[A-Za-z0-9._-]+\.png$/.test(value)) {
    return noteError('invalid_image', 'imageUrl 必须指向 /api/notes/assets/<file>.png', 'imageUrl');
  }
  return { ok: true, value };
}

function normalizeNoteKind(raw, fallback = 'note') {
  if (raw == null || raw === '') return { ok: true, value: fallback };
  if (!NOTE_KINDS.includes(raw)) return noteError('invalid_kind', `kind 必须是 ${NOTE_KINDS.join(' / ')}`, 'kind');
  return { ok: true, value: raw };
}

function normalizeNoteSource(raw, fallback = 'studio') {
  if (raw == null || raw === '') return { ok: true, value: fallback };
  if (!NOTE_SOURCES.includes(raw)) return noteError('invalid_source', `source 必须是 ${NOTE_SOURCES.join(' / ')}`, 'source');
  return { ok: true, value: raw };
}

/** POST /api/notes 的完整校验 */
function normalizeNoteCreate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return noteError('invalid_body', '请求体必须是 JSON 对象');
  const allowed = new Set(['video', 'tMs', 'body', 'quotes', 'tags', 'imageUrl', 'kind', 'source']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return noteError('unknown_field', `不支持的字段：${key}`, key);
  }
  const videoResult = normalizeVideoRef(input.video);
  if (!videoResult.ok) return videoResult;
  const tMsResult = normalizeNoteTMs(input.tMs, 0);
  if (!tMsResult.ok) return tMsResult;
  const bodyResult = normalizeNoteBody(input.body ?? '');
  if (!bodyResult.ok) return bodyResult;
  const quotesResult = normalizeNoteQuotes(input.quotes);
  if (!quotesResult.ok) return quotesResult;
  const tagsResult = normalizeNoteTags(input.tags);
  if (!tagsResult.ok) return tagsResult;
  const imageResult = normalizeNoteImageUrl(input.imageUrl);
  if (!imageResult.ok) return imageResult;
  const kindResult = normalizeNoteKind(input.kind, 'note');
  if (!kindResult.ok) return kindResult;
  const sourceResult = normalizeNoteSource(input.source, 'studio');
  if (!sourceResult.ok) return sourceResult;
  return {
    ok: true,
    value: {
      video: videoResult.video,
      tMs: tMsResult.value,
      body: bodyResult.value,
      quotes: quotesResult.value,
      tags: tagsResult.value,
      imageUrl: imageResult.value,
      kind: kindResult.value,
      source: sourceResult.value,
    },
  };
}

/** PUT /api/notes/:id 的部分更新校验（白名单，不允许改 video/id/source/createdAt） */
function normalizeNotePatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return noteError('invalid_body', '请求体必须是 JSON 对象');
  const allowed = new Set(['body', 'tMs', 'tags', 'quotes', 'imageUrl', 'kind']);
  const patch = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!allowed.has(key)) return noteError('unknown_field', `不支持的字段：${key}`, key);
    if (key === 'body') {
      const result = normalizeNoteBody(raw);
      if (!result.ok) return result;
      patch.body = result.value;
    } else if (key === 'tMs') {
      const result = normalizeNoteTMs(raw);
      if (!result.ok) return result;
      patch.tMs = result.value;
    } else if (key === 'tags') {
      const result = normalizeNoteTags(raw);
      if (!result.ok) return result;
      patch.tags = result.value;
    } else if (key === 'quotes') {
      const result = normalizeNoteQuotes(raw);
      if (!result.ok) return result;
      patch.quotes = result.value;
    } else if (key === 'imageUrl') {
      const result = normalizeNoteImageUrl(raw);
      if (!result.ok) return result;
      patch.imageUrl = result.value;
    } else if (key === 'kind') {
      const result = normalizeNoteKind(raw);
      if (!result.ok) return result;
      patch.kind = result.value;
    }
  }
  if (Object.keys(patch).length === 0) return noteError('empty_patch', '没有可更新的字段（body/tMs/tags/quotes/imageUrl/kind）');
  return { ok: true, value: patch };
}

// ---- 存储 ----

function readNotesStore(file) {
  const data = readJsonIfExists(file);
  if (!data || typeof data !== 'object') return { version: 1, video: null, notes: [] };
  const notes = Array.isArray(data.notes)
    ? data.notes.filter((note) => note && typeof note === 'object' && typeof note.id === 'string' && NOTE_ID_RE.test(note.id))
    : [];
  return { version: 1, video: data.video && typeof data.video === 'object' ? data.video : null, notes };
}

function saveNotesStore(state, file, store) {
  atomicWriteFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
  state.notesStatsCache = null;
}

/** 同一文件的写操作串行化（并发写不丢数据） */
function withNotesFileQueue(state, file, task) {
  const previous = state.noteQueues.get(file) ?? Promise.resolve();
  const run = previous.then(task, task);
  const chained = run.then(
    () => undefined,
    () => undefined,
  );
  const tracked = chained.finally(() => {
    if (state.noteQueues.get(file) === tracked) state.noteQueues.delete(file);
  });
  state.noteQueues.set(file, tracked);
  return run;
}

function listNotesStoreFiles(state) {
  const { notesDir } = notesPaths(state);
  let names = [];
  try {
    names = fs.readdirSync(notesDir).filter((name) => name.endsWith('.json') && SAFE_RESOURCE_NAME_RE.test(name) && !name.includes('..'));
  } catch {
    names = [];
  }
  return names.map((name) => path.join(notesDir, name));
}

function readAllNoteEntries(state) {
  const entries = [];
  for (const file of listNotesStoreFiles(state)) {
    const store = readNotesStore(file);
    for (const note of store.notes) {
      const video = note.video && typeof note.video === 'object' ? note.video : store.video;
      if (!video || typeof video.id !== 'string') continue;
      entries.push({ file, store, note: { ...note, video } });
    }
  }
  return entries;
}

function findNoteEntry(state, id) {
  if (!NOTE_ID_RE.test(String(id ?? '')) || String(id).includes('..')) return null;
  for (const file of listNotesStoreFiles(state)) {
    const store = readNotesStore(file);
    const index = store.notes.findIndex((note) => note.id === id);
    if (index >= 0) return { file, store, note: store.notes[index], index };
  }
  return null;
}

function getNotesStats(state) {
  const now = Date.now();
  if (state.notesStatsCache && now - state.notesStatsCache.at < 3000) return state.notesStatsCache.value;
  const { notesDir, exportsDir } = notesPaths(state);
  let videos = 0;
  let count = 0;
  for (const file of listNotesStoreFiles(state)) {
    const store = readNotesStore(file);
    if (store.notes.length === 0) continue;
    videos += 1;
    count += store.notes.length;
  }
  const value = {
    count,
    videos,
    notesDir: toProjectRelative(notesDir),
    exportsDir: toProjectRelative(exportsDir),
    assetsDir: toProjectRelative(path.join(notesDir, 'assets')),
  };
  state.notesStatsCache = { at: now, value };
  return value;
}

function buildNotesListPayload(state, { videoId = '', q = '', limit = NOTES_LIST_LIMIT_DEFAULT } = {}) {
  const entries = readAllNoteEntries(state);
  const videosMap = new Map();
  for (const { note } of entries) {
    const video = note.video;
    const summary = videosMap.get(video.id) ?? { video, count: 0, updatedAt: null };
    summary.count += 1;
    if (!summary.updatedAt || String(note.updatedAt ?? '') > summary.updatedAt) summary.updatedAt = note.updatedAt ?? null;
    summary.video = { ...video, ...(video.title ? { title: video.title } : {}) };
    videosMap.set(video.id, summary);
  }
  const videos = [...videosMap.values()].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  let notes = entries.map((entry) => entry.note);
  if (videoId) notes = notes.filter((note) => note.video?.id === String(videoId));
  const needle = String(q ?? '').trim().toLowerCase();
  if (needle) {
    notes = notes.filter((note) => {
      const haystack = [
        note.body ?? '',
        ...(Array.isArray(note.quotes) ? note.quotes.flatMap((quote) => [quote?.src ?? '', quote?.dst ?? '']) : []),
        ...(Array.isArray(note.tags) ? note.tags : []),
      ].join('\n');
      return haystack.toLowerCase().includes(needle);
    });
  }
  notes.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')) || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  const parsedLimit = Number(limit);
  const capped = Math.min(NOTES_LIST_LIMIT_MAX, Math.max(1, Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : NOTES_LIST_LIMIT_DEFAULT));
  return { videos, notes: notes.slice(0, capped), total: notes.length };
}

// ---- Markdown 导出 / quick 追加 ----

function buildQuoteMarkdown(quotes = []) {
  const lines = [];
  for (const quote of Array.isArray(quotes) ? quotes : []) {
    if (quote?.src) lines.push(`> 原文：${String(quote.src).trim()}`);
    if (quote?.dst) lines.push(`> 译文：${String(quote.dst).trim()}`);
    if ((!quote?.src && !quote?.dst) && (quote?.t0Ms != null || quote?.t1Ms != null)) {
      lines.push(`> 时间：${formatNoteTimestamp(quote.t0Ms ?? quote.t1Ms ?? 0)}`);
    }
  }
  return lines;
}

function buildNoteMarkdown(note) {
  const lines = [];
  const kindLabel = NOTES_KIND_LABELS[note.kind] ?? note.kind ?? '笔记';
  lines.push(`## [${formatNoteTimestamp(note.tMs)}](?t=${Math.round(Number(note.tMs) || 0)}) · ${kindLabel}`);
  lines.push('');
  const body = String(note.body ?? '').trim();
  lines.push(body || '（空笔记）');
  lines.push('');
  for (const quoteLine of buildQuoteMarkdown(note.quotes)) lines.push(quoteLine);
  if (Array.isArray(note.tags) && note.tags.length > 0) lines.push(`标签：${note.tags.join('、')}`);
  if (note.imageUrl) lines.push(`![截图](${note.imageUrl})`);
  lines.push('');
  return lines.join('\n');
}

function buildVideoHeader(video, noteCount, { forExport = false } = {}) {
  const date = localDateString();
  const lines = [
    '---',
    `title: ${JSON.stringify(String(video?.title ?? video?.id ?? 'livedub 笔记'))}`,
    `videoId: ${JSON.stringify(String(video?.id ?? ''))}`,
    ...(video?.url ? [`url: ${JSON.stringify(String(video.url))}`] : []),
    `date: ${date}`,
    `langFrom: ${JSON.stringify('en')}`,
    `langTo: ${JSON.stringify('zh')}`,
    `notes: ${noteCount}`,
    `generatedBy: ${JSON.stringify('livedub')}`,
    '---',
    '',
    `# ${String(video?.title ?? video?.id ?? 'livedub 笔记')}`,
    '',
  ];
  if (video?.url) lines.push(`> 视频：${video.url}`);
  if (video?.durationMs) lines.push(`> 时长：${formatNoteTimestamp(video.durationMs)}`);
  if (video?.url || video?.durationMs) lines.push('');
  if (noteCount === 0) {
    lines.push('（还没有笔记）');
    lines.push('');
  }
  return lines;
}

function buildVideoNotesMarkdown(state, videoId) {
  const id = String(videoId ?? '');
  const notes = readAllNoteEntries(state)
    .map((entry) => entry.note)
    .filter((note) => note.video?.id === id)
    .sort((a, b) => (Number(a.tMs) || 0) - (Number(b.tMs) || 0));
  const video = notes[0]?.video ?? { id, title: id };
  const lines = buildVideoHeader(video, notes.length, { forExport: true });
  for (const note of notes) lines.push(buildNoteMarkdown(note));
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

function buildQuickBlock({ video, tMs, text, quotes, tags, source }) {
  const lines = [`### ${formatNoteTimestamp(tMs)} · ${String(video.title ?? video.id)}`, ''];
  lines.push(`- 视频：${video.url ? `[${String(video.url)}](${String(video.url)})` : '`' + String(video.id) + '`'}`);
  lines.push(`- 时间戳：[${formatNoteTimestamp(tMs)}](?t=${Math.round(tMs)})（tMs=${Math.round(tMs)}）`);
  lines.push(`- 来源：${source}`);
  if (Array.isArray(tags) && tags.length > 0) lines.push(`- 标签：${tags.join('、')}`);
  lines.push('');
  lines.push(String(text ?? '').trim() || '（空摘录）');
  for (const quoteLine of buildQuoteMarkdown(quotes)) lines.push(quoteLine);
  lines.push('', '');
  return lines.join('\n');
}

function sendApiErrorPayload(res, status, error) {
  return sendJson(res, status, { ok: false, error: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) });
}

function sendMarkdownPayload(res, filename, markdown, { head = false } = {}) {
  const body = Buffer.from(String(markdown ?? ''), 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Length': body.length,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.end(head ? undefined : body);
}

function readJsonBodyForNotes(req, limit = NOTES_MAX_JSON_BYTES) {
  return new Promise((resolve) => {
    let size = 0;
    let settled = false;
    let tooLarge = false;
    const chunks = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      // 超限后继续把剩余 body 读完再回 413，避免客户端收到 socket reset（本地大笔记/攻击请求都更可控）
      if (tooLarge) {
        if (size > limit * 8) {
          finish({ ok: false, status: 413, error: { code: 'body_too_large', message: `请求体超过 ${Math.round(limit / 1024)}KB 上限` } });
          try {
            req.destroy();
          } catch {
            /* ignore */
          }
        }
        return;
      }
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      if (tooLarge) {
        return finish({ ok: false, status: 413, error: { code: 'body_too_large', message: `请求体超过 ${Math.round(limit / 1024)}KB 上限` } });
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return finish({ ok: true, value: {} });
      try {
        finish({ ok: true, value: JSON.parse(raw) });
      } catch {
        finish({ ok: false, status: 400, error: { code: 'invalid_json', message: '请求体不是合法 JSON' } });
      }
    });
    req.on('error', () => finish({ ok: false, status: 400, error: { code: 'bad_request', message: '读取请求体失败' } }));
  });
}

function readRawBodyForNotes(req, limit = NOTES_ASSET_MAX_BYTES) {
  return new Promise((resolve) => {
    let size = 0;
    let settled = false;
    let tooLarge = false;
    const chunks = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (tooLarge) {
        if (size > limit * 4) {
          finish({ ok: false, status: 413, error: { code: 'body_too_large', message: `截图超过 ${Math.round(limit / 1024 / 1024)}MB 上限` } });
          try {
            req.destroy();
          } catch {
            /* ignore */
          }
        }
        return;
      }
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      if (tooLarge) {
        return finish({ ok: false, status: 413, error: { code: 'body_too_large', message: `截图超过 ${Math.round(limit / 1024 / 1024)}MB 上限` } });
      }
      finish({ ok: true, buffer: Buffer.concat(chunks) });
    });
    req.on('error', () => finish({ ok: false, status: 400, error: { code: 'bad_request', message: '读取截图失败' } }));
  });
}

// ---- 请求处理 ----

async function handleNotesRequest(state, req, res, { method, pathname, url }) {
  const head = method === 'HEAD';

  if (pathname === '/api/notes') {
    if (method === 'GET' || method === 'HEAD') {
      const payload = buildNotesListPayload(state, {
        videoId: url.searchParams.get('videoId') ?? '',
        q: url.searchParams.get('q') ?? '',
        limit: url.searchParams.get('limit') ?? NOTES_LIST_LIMIT_DEFAULT,
      });
      return sendJson(res, 200, { ok: true, ...payload }, { head });
    }
    const parsed = await readJsonBodyForNotes(req);
    if (!parsed.ok) return sendJson(res, parsed.status, { ok: false, error: parsed.error.code, message: parsed.error.message });
    const normalized = normalizeNoteCreate(parsed.value);
    if (!normalized.ok) return sendApiErrorPayload(res, normalized.status, normalized.error);
    const value = normalized.value;
    const file = notesFileFor(state, value.video.id);
    const result = await withNotesFileQueue(state, file, () => {
      const store = readNotesStore(file);
      const now = new Date().toISOString();
      const note = {
        id: `n_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`,
        video: value.video,
        tMs: value.tMs,
        body: value.body,
        kind: value.kind,
        source: value.source,
        ...(value.quotes.length > 0 ? { quotes: value.quotes } : {}),
        ...(value.tags.length > 0 ? { tags: value.tags } : {}),
        ...(value.imageUrl ? { imageUrl: value.imageUrl } : {}),
        createdAt: now,
        updatedAt: now,
      };
      store.video = value.video;
      store.notes.push(note);
      saveNotesStore(state, file, store);
      return note;
    });
    state.log(`笔记创建 ${result.id}（${toProjectRelative(file)}，${result.body.length} 字符）`);
    return sendJson(res, 200, { ok: true, note: result });
  }

  if (pathname === '/api/notes/quick') {
    const parsed = await readJsonBodyForNotes(req);
    if (!parsed.ok) return sendJson(res, parsed.status, { ok: false, error: parsed.error.code, message: parsed.error.message });
    const input = parsed.value && typeof parsed.value === 'object' ? parsed.value : {};
    for (const key of Object.keys(input)) {
      if (!['video', 'tMs', 'text', 'quotes', 'source', 'tags', 'imageUrl'].includes(key)) {
        return sendApiErrorPayload(res, 400, { code: 'unknown_field', message: `不支持的字段：${key}`, field: key });
      }
    }
    const videoResult = normalizeVideoRef(input.video);
    if (!videoResult.ok) return sendApiErrorPayload(res, videoResult.status, videoResult.error);
    const tMsResult = normalizeNoteTMs(input.tMs, 0);
    if (!tMsResult.ok) return sendApiErrorPayload(res, tMsResult.status, tMsResult.error);
    if (typeof input.text !== 'string') return sendApiErrorPayload(res, 400, { code: 'invalid_text', message: 'text 必须是字符串', field: 'text' });
    if (Buffer.byteLength(input.text, 'utf8') > NOTES_MAX_BODY_BYTES) {
      return sendApiErrorPayload(res, 400, { code: 'text_too_large', message: 'text 超过 200KB 上限', field: 'text' });
    }
    const quotesResult = normalizeNoteQuotes(input.quotes);
    if (!quotesResult.ok) return sendApiErrorPayload(res, quotesResult.status, quotesResult.error);
    const tagsResult = normalizeNoteTags(input.tags);
    if (!tagsResult.ok) return sendApiErrorPayload(res, tagsResult.status, tagsResult.error);
    const sourceResult = normalizeNoteSource(input.source, 'extension');
    if (!sourceResult.ok) return sendApiErrorPayload(res, sourceResult.status, sourceResult.error);
    const imageResult = normalizeNoteImageUrl(input.imageUrl);
    if (!imageResult.ok) return sendApiErrorPayload(res, imageResult.status, imageResult.error);
    const { notesDir } = notesPaths(state);
    const date = localDateString();
    const file = path.join(notesDir, `quick-${date}.md`);
    const markdown = buildQuickBlock({
      video: videoResult.video,
      tMs: tMsResult.value,
      text: input.text,
      quotes: quotesResult.value,
      tags: tagsResult.value,
      source: sourceResult.value,
    });
    // 关键：quick 同时写入 per-video 笔记库（kind:'quick'），这样工作台笔记面板 /
    // GET /api/notes / 导出都能看到扩展、macOS、CLI 的快捷笔记；每日 markdown 照旧追加。
    const noteFile = notesFileFor(state, videoResult.video.id);
    const created = await withNotesFileQueue(state, noteFile, () => {
      const store = readNotesStore(noteFile);
      const now = new Date().toISOString();
      const note = {
        id: `n_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`,
        video: videoResult.video,
        tMs: tMsResult.value,
        body: input.text,
        kind: 'quick',
        source: sourceResult.value,
        ...(quotesResult.value.length > 0 ? { quotes: quotesResult.value } : {}),
        ...(tagsResult.value.length > 0 ? { tags: tagsResult.value } : {}),
        ...(imageResult.value ? { imageUrl: imageResult.value } : {}),
        createdAt: now,
        updatedAt: now,
      };
      store.video = videoResult.video;
      store.notes.push(note);
      saveNotesStore(state, noteFile, store);
      return note;
    });
    await withNotesFileQueue(state, file, () => {
      ensureDirSync(notesDir);
      let prefix = '';
      let existing = '';
      try {
        existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      } catch {
        existing = '';
      }
      if (!existing) prefix = `# livedub 快速摘录 · ${date}\n\n`;
      else if (!existing.endsWith('\n')) prefix = '\n';
      fs.appendFileSync(file, `${prefix}${markdown}`);
    });
    state.log(`快速摘录 ${created.id}（${toProjectRelative(noteFile)} + ${toProjectRelative(file)}）`);
    return sendJson(res, 200, { ok: true, path: toProjectRelative(file), markdown, note: created });
  }

  if (pathname === '/api/notes/assets') {
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!contentType.startsWith('image/png')) {
      return sendJson(res, 415, { ok: false, error: 'unsupported_media_type', message: '截图必须以 image/png 上传' });
    }
    const parsed = await readRawBodyForNotes(req);
    if (!parsed.ok) return sendJson(res, parsed.status, { ok: false, error: parsed.error.code, message: parsed.error.message });
    const buffer = parsed.buffer;
    if (buffer.length < 8 || buffer[0] !== 0x89 || buffer.toString('latin1', 1, 4) !== 'PNG') {
      return sendJson(res, 400, { ok: false, error: 'invalid_png', message: '文件不是合法 PNG' });
    }
    const { assetsDir } = notesPaths(state);
    const file = `img_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}.png`;
    try {
      ensureDirSync(assetsDir);
      atomicWriteFileSync(path.join(assetsDir, file), buffer);
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: 'persist_failed', message: `保存截图失败：${err?.message ?? err}` });
    }
    state.log(`笔记截图已保存 data/notes/assets/${file}（${buffer.length} 字节）`);
    return sendJson(res, 200, { ok: true, url: `/api/notes/assets/${file}`, size: buffer.length });
  }

  if (pathname.startsWith('/api/notes/assets/')) {
    const raw = pathname.slice('/api/notes/assets/'.length);
    let name;
    try {
      name = decodeURIComponent(raw);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_name', message: '文件名编码非法' });
    }
    if (!NOTE_ASSET_FILE_RE.test(name) || name.includes('..')) {
      return sendJson(res, 403, { ok: false, error: 'forbidden', message: '截图文件名非法' });
    }
    const file = path.join(notesPaths(state).assetsDir, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return sendJson(res, 404, { ok: false, error: 'not_found', message: '截图不存在' });
    }
    if (!stat.isFile()) return sendJson(res, 404, { ok: false, error: 'not_found', message: '截图不存在' });
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': stat.size,
      'Cache-Control': 'private, max-age=3600',
    });
    if (head) return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    return stream.pipe(res);
  }

  if (pathname === '/api/notes/export.md') {
    const videoId = String(url.searchParams.get('videoId') ?? '').trim();
    if (!videoId) return sendJson(res, 400, { ok: false, error: 'missing_video_id', message: '需要 ?videoId=' });
    if (videoId.length > 200) return sendJson(res, 400, { ok: false, error: 'invalid_video_id', message: 'videoId 过长' });
    const markdown = buildVideoNotesMarkdown(state, videoId);
    const filename = `${notesSlugForVideoId(videoId)}-${localDateString()}.md`;
    return sendMarkdownPayload(res, filename, markdown, { head });
  }

  if (pathname === '/api/notes/export') {
    const parsed = await readJsonBodyForNotes(req);
    if (!parsed.ok) return sendJson(res, parsed.status, { ok: false, error: parsed.error.code, message: parsed.error.message });
    const videoId = typeof parsed.value?.videoId === 'string' ? parsed.value.videoId.trim() : '';
    if (!videoId) return sendJson(res, 400, { ok: false, error: 'missing_video_id', message: '需要 videoId' });
    if (videoId.length > 200) return sendJson(res, 400, { ok: false, error: 'invalid_video_id', message: 'videoId 过长' });
    const markdown = buildVideoNotesMarkdown(state, videoId);
    const { exportsDir } = notesPaths(state);
    const filename = `${notesSlugForVideoId(videoId)}-${localDateString()}.md`;
    const file = path.join(exportsDir, filename);
    try {
      ensureDirSync(exportsDir);
      atomicWriteFileSync(file, markdown);
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: 'persist_failed', message: `导出失败：${err?.message ?? err}` });
    }
    state.log(`笔记导出 -> ${toProjectRelative(file)}（${markdown.length} 字符）`);
    return sendJson(res, 200, { ok: true, path: toProjectRelative(file), bytes: Buffer.byteLength(markdown, 'utf8') });
  }

  // /api/notes/:id —— PUT / DELETE
  if (pathname.startsWith('/api/notes/')) {
    const rawId = pathname.slice('/api/notes/'.length);
    if (!rawId || rawId.includes('/')) {
      return sendJson(res, 404, { ok: false, error: 'not_found', message: '笔记路由不存在' });
    }
    let id;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid_id', message: '笔记 id 编码非法' });
    }
    if (!NOTE_ID_RE.test(id) || id.includes('..')) {
      return sendJson(res, 400, { ok: false, error: 'invalid_id', message: '笔记 id 非法（仅允许 A-Za-z0-9._-）' });
    }
    if (method === 'PUT') {
      const parsed = await readJsonBodyForNotes(req);
      if (!parsed.ok) return sendJson(res, parsed.status, { ok: false, error: parsed.error.code, message: parsed.error.message });
      const patchResult = normalizeNotePatch(parsed.value);
      if (!patchResult.ok) return sendApiErrorPayload(res, patchResult.status, patchResult.error);
      const found = findNoteEntry(state, id);
      if (!found) return sendJson(res, 404, { ok: false, error: 'not_found', message: '笔记不存在' });
      const patch = patchResult.value;
      const updated = await withNotesFileQueue(state, found.file, () => {
        const store = readNotesStore(found.file);
        const note = store.notes.find((item) => item.id === id);
        if (!note) return null;
        if (patch.body !== undefined) note.body = patch.body;
        if (patch.tMs !== undefined) note.tMs = patch.tMs;
        if (patch.tags !== undefined) note.tags = patch.tags;
        if (patch.quotes !== undefined) note.quotes = patch.quotes;
        if (patch.imageUrl !== undefined) {
          if (patch.imageUrl) note.imageUrl = patch.imageUrl;
          else delete note.imageUrl;
        }
        if (patch.kind !== undefined) note.kind = patch.kind;
        note.updatedAt = new Date().toISOString();
        saveNotesStore(state, found.file, store);
        return note;
      });
      if (!updated) return sendJson(res, 404, { ok: false, error: 'not_found', message: '笔记不存在' });
      return sendJson(res, 200, { ok: true, note: updated });
    }
    if (method === 'DELETE') {
      const found = findNoteEntry(state, id);
      if (!found) return sendJson(res, 404, { ok: false, error: 'not_found', message: '笔记不存在' });
      await withNotesFileQueue(state, found.file, () => {
        const store = readNotesStore(found.file);
        const index = store.notes.findIndex((item) => item.id === id);
        if (index < 0) return;
        store.notes.splice(index, 1);
        if (store.notes.length === 0) {
          try {
            fs.unlinkSync(found.file);
          } catch {
            /* ignore */
          }
          state.notesStatsCache = null;
        } else {
          saveNotesStore(state, found.file, store);
        }
      });
      state.log(`笔记删除 ${id}`);
      return sendJson(res, 200, { ok: true, deleted: true });
    }
  }

  return sendJson(res, 404, { ok: false, error: 'not_found', message: '笔记路由不存在' });
}

/** /api/notes 系列允许的方法（用于全局 405/OPTIONS 判定） */
function allowedMethodsForPath(pathname) {
  if (pathname === '/api/settings') return ['GET', 'HEAD', 'PUT'];
  if (pathname === '/api/notes') return ['GET', 'HEAD', 'POST'];
  if (pathname === '/api/notes/quick') return ['POST'];
  if (pathname === '/api/notes/assets') return ['POST'];
  if (pathname.startsWith('/api/notes/assets/')) return ['GET', 'HEAD'];
  if (pathname === '/api/notes/export') return ['POST'];
  if (pathname === '/api/notes/export.md') return ['GET', 'HEAD'];
  if (pathname.startsWith('/api/notes/')) return ['PUT', 'DELETE'];
  return ['GET', 'HEAD'];
}

function createRequestHandler(state) {
  return async function handleRequest(req, res) {
    const method = req.method ?? 'GET';
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    } catch {
      return sendText(res, 400, 'livedub: bad request url\n');
    }
    const pathname = url.pathname;

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    const isApi = pathname === '/health' || pathname.startsWith('/api/');
    const allowedMethods = allowedMethodsForPath(pathname);

    if (method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', `${allowedMethods.join(',')},OPTIONS`);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }

    if (isApi) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-store');
    }

    if (!allowedMethods.includes(method)) {
      if (isApi) {
        res.setHeader('Allow', allowedMethods.join(', '));
        return sendJson(res, 405, { ok: false, error: 'method not allowed', allow: allowedMethods.join(', ') });
      }
      return sendText(res, 405, 'livedub: method not allowed\n');
    }

    try {
      if (pathname === '/health') {
        const health = buildHealth(state);
        try {
          health.whisper.server = await whisperRuntimeStatus(state);
          health.whisper.running = health.whisper.server.running;
        } catch (err) {
          state.log(`whisper 状态探测失败（不影响 /health）：${err?.message ?? err}`);
          health.whisper.server = { running: null, source: 'unknown', error: 'status probe failed' };
        }
        return sendJson(res, 200, health, { head: method === 'HEAD' });
      }

      if (pathname === '/api/notes' || pathname.startsWith('/api/notes/')) {
        return await handleNotesRequest(state, req, res, { method, pathname, url });
      }

      if (pathname === '/api/settings') {
        if (method === 'PUT') {
          let raw;
          try {
            raw = await readRequestBody(req);
          } catch (err) {
            const status = err?.code === 'BODY_TOO_LARGE' ? 413 : 400;
            return sendJson(res, status, {
              ok: false,
              error: status === 413 ? 'body_too_large' : 'bad_request',
              message: err?.message ?? '读取请求体失败',
            });
          }
          let parsed;
          try {
            parsed = raw.trim() ? JSON.parse(raw) : null;
          } catch {
            return sendJson(res, 400, { ok: false, error: 'invalid_json', message: '请求体不是合法 JSON' });
          }
          const sendSettingsError = (error) =>
            sendJson(res, 400, {
              ok: false,
              error: error.code,
              message: error.message,
              ...(error.field ? { field: error.field } : {}),
              ...(error.allowed ? { allowed: error.allowed } : {}),
            });
          const normalized = normalizeSettingsInput(parsed);
          if (!normalized.ok) return sendSettingsError(normalized.error);
          const validated = validateSettingsPatch(normalized.input);
          if (!validated.ok) return sendSettingsError(validated.error);
          try {
            applyUiSettingsPatch(state, validated.patch);
          } catch (err) {
            state.log(`保存 UI 设置失败：${err?.message ?? err}`);
            return sendJson(res, 500, {
              ok: false,
              error: 'persist_failed',
              message: `保存 UI 设置失败：${err?.message ?? err}`,
              hint: '检查 data/ 目录写权限后重试',
            });
          }
          state.log(`UI 设置已更新：${JSON.stringify(validated.patch)} -> ${toProjectRelative(state.uiSettingsPath)}（下次会话生效）`);
          return sendJson(res, 200, { ...buildUiSettingsPayload(state), saved: true, nextSessionOnly: true });
        }
        return sendJson(res, 200, buildUiSettingsPayload(state), { head: method === 'HEAD' });
      }

      if (pathname === '/api/config') {
        return sendJson(res, 200, buildPublicConfigPayload(state), { head: method === 'HEAD' });
      }

      if (pathname === '/api/voices') {
        return await sendVoicesPayload(state, req, res, method === 'HEAD');
      }

      if (pathname === '/ws') {
        return sendJson(res, 426, {
          ok: false,
          error: '需要 WebSocket 升级',
          hint: '请用 ws:// 连接 /ws，先发 hello 建立会话（见 docs/CONTRACTS.md §3）',
        });
      }

      if (pathname === '/' || pathname === '') return redirect(res, '/studio/');
      if (pathname === '/studio') return redirect(res, `/studio/${url.search}`);
      if (pathname === '/replay') return redirect(res, `/replay/${url.search}`);

      if (pathname === '/replay/') {
        return serveStaticFile(req, res, path.join(state.studioDir, 'replay.html'), state.log);
      }

      if (pathname === '/favicon.ico') {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        return res.end();
      }

      if (pathname.startsWith('/studio/')) {
        const requestPath = pathname.slice('/studio'.length);
        const target = resolveStaticFile(state.studioDir, requestPath, '');
        if (target.error) return sendText(res, target.error, `livedub: ${target.message}\n`);
        return serveStaticFile(req, res, target.file, state.log);
      }

      // demo/ 只读托管：回放会话 JSONL 与演示视频（由 scripts/make-demo.mjs 生成）
      if (pathname.startsWith('/demo/')) {
        const resolved = resolveStaticFile(state.demoDir, pathname, '/demo');
        if (resolved.error) return sendText(res, resolved.error, `livedub: ${resolved.message}\n`);
        return serveStaticFile(req, res, resolved.file, state.log);
      }

      return notFound(res, `没有这个路由：${pathname}`);
    } catch (err) {
      state.log(`HTTP 处理失败 ${method} ${pathname}：${err?.message ?? err}`);
      if (!res.headersSent) return sendJson(res, 500, { ok: false, error: 'internal error' });
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    }
  };
}

// --------------------------------------------------------------- WS transport

/**
 * WS Origin 白名单：chrome-extension://*、http(s)://127.0.0.1*、http(s)://localhost*。
 * 没有 Origin 的客户端（Node 测试、curl）放行；其它 Origin 一律 403。
 */
export function isAllowedOrigin(origin) {
  if (origin == null || origin === '') return true;
  const value = String(origin);
  if (/^chrome-extension:\/\/[a-z0-9]{8,}$/i.test(value)) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  } catch {
    return false;
  }
}

/** 处理一条 WebSocket 连接（hello -> 会话，之后纯转发） */
function handleWebSocketConnection(ws, req, state) {
  const { config, log } = state;
  const conn = {
    ws,
    req,
    session: null,
    sessionId: null,
    phase: 'awaiting-hello', // awaiting-hello | initializing | ready | closed
    readyAt: null,
    closed: false,
    audioFrames: 0,
    badFrames: 0,
    queuedAudio: 0,
    audioChain: Promise.resolve(),
    dropWarned: false,
    helloWarned: false,
    initTimer: null,
    helloTimer: null,
  };
  state.sessions.add(conn);

  const send = (event) => {
    if (conn.closed || ws.closed) return false;
    if (!event || typeof event !== 'object') return false;
    try {
      return ws.sendText(encodeEvent(event));
    } catch (err) {
      log(`WS 下发事件失败：${err?.message ?? err}`);
      return false;
    }
  };
  const sendError = (scope, message, extra = {}) => send(errorEvent(scope, message, extra));

  /** 会话事件出口：拦截 ready/bye 做连接状态管理，其余原样下发 */
  const emitToClient = (event) => {
    if (!event || typeof event !== 'object') return;
    if (event.type === MSG.READY) {
      conn.readyAt = Date.now();
      conn.phase = 'ready';
      clearTimeout(conn.initTimer);
      conn.initTimer = null;
    }
    if (event.type === MSG.BYE) {
      send(event);
      setTimeout(() => {
        if (conn.closed) return;
        try {
          ws.close(1000, 'session bye');
        } catch {
          /* ignore */
        }
      }, 80).unref?.();
      return;
    }
    send(event);
  };

  const handleAudio = (pcm, tMs) => {
    if (conn.closed) return;
    if (!conn.session) {
      // hello 前送音频属于误用；初始化阶段（whisper 冷启动）按 Lead 约定直接丢弃
      if (conn.phase === 'awaiting-hello' && !conn.helloWarned) {
        conn.helloWarned = true;
        sendError('server', '收到音频但还没有 hello：请先发送 hello 建立会话');
      }
      return;
    }
    if (!Number.isFinite(tMs) || tMs < 0) {
      sendError('server', `音频时间戳非法：${tMs}（需要非负毫秒数）`, { recoverable: true });
      return;
    }
    if (pcm.length > MAX_AUDIO_FRAME_BYTES) {
      sendError('server', '音频帧过大（上限 256KB）', { recoverable: true });
      return;
    }
    const copy = Buffer.from(pcm); // 复制：避免持有 ws 大 buffer
    if (conn.queuedAudio >= MAX_QUEUED_AUDIO_FRAMES && !conn.dropWarned) {
      conn.dropWarned = true;
      sendError('session', '音频处理积压，正在丢弃部分帧。请降低帧率或检查 ASR 性能。', { recoverable: true });
    }
    if (conn.queuedAudio >= MAX_QUEUED_AUDIO_FRAMES) return;
    conn.audioFrames += 1;
    conn.queuedAudio += 1;
    conn.audioChain = conn.audioChain
      .then(() => {
        const session = conn.session;
        if (!session || typeof session.onAudio !== 'function') return undefined;
        return session.onAudio(copy, tMs);
      })
      .catch((err) => {
        sendError('session', `处理音频失败：${err?.message ?? err}`, { recoverable: true });
      })
      .finally(() => {
        conn.queuedAudio = Math.max(0, conn.queuedAudio - 1);
      });
  };

  const handleBinary = (data) => {
    let frame;
    try {
      frame = decodeAudioFrame(Buffer.isBuffer(data) ? data : Buffer.from(data));
    } catch (err) {
      frame = { ok: false, error: err?.message ?? 'decode failed' };
    }
    if (!frame.ok) {
      conn.badFrames += 1;
      if (conn.badFrames <= 3) {
        sendError('server', `音频帧格式错误：${frame.error}（期望 [0]=0x01 + float64BE tMs + s16le PCM）`, { recoverable: true });
      }
      if (conn.badFrames > 50) {
        try {
          ws.close(1008, 'too many bad frames');
        } catch {
          /* ignore */
        }
      }
      return;
    }
    handleAudio(frame.pcm, frame.tMs);
  };

  const forwardJson = (msg) => {
    const session = conn.session;
    if (!session || typeof session.onJson !== 'function') {
      sendError('server', `会话尚未就绪，忽略 ${msg.type} 消息`, { recoverable: true });
      return;
    }
    try {
      const maybe = session.onJson(msg);
      if (maybe && typeof maybe.then === 'function') {
        maybe.catch((err) => sendError('session', `处理 ${msg.type} 失败：${err?.message ?? err}`, { recoverable: true }));
      }
    } catch (err) {
      sendError('session', `处理 ${msg.type} 失败：${err?.message ?? err}`, { recoverable: true });
    }
  };

  const handleJsonAudio = (msg) => {
    const pcm = pcmFromBase64(msg.pcm);
    if (!pcm || pcm.length < 2 || pcm.length % 2 !== 0) {
      sendError('server', 'audio.pcm 不是合法的 base64 s16le 数据', { recoverable: true });
      return;
    }
    const tMs = Number(msg.tMs);
    handleAudio(pcm, Number.isFinite(tMs) ? tMs : -1);
  };

  const handleHello = (msg) => {
    if (conn.closed || conn.phase === 'rejected') return;
    clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    if (conn.phase !== 'awaiting-hello') {
      sendError('session', '本连接已有会话，重复 hello 已忽略；如需新会话请重连', { recoverable: true });
      return;
    }
    const normalized = normalizeHello(msg);
    if (!normalized.ok) {
      sendError('server', `hello 无效：${normalized.error}。请按 docs/CONTRACTS.md §3.1 发送 protocol:1 的 hello。`, {
        recoverable: false,
      });
      try {
        ws.close(1002, 'bad hello');
      } catch {
        /* ignore */
      }
      return;
    }

    const activeSessions = countActiveSessions(state);
    if (activeSessions >= state.maxSessions) {
      const message = `并发会话已达上限（${activeSessions}/${state.maxSessions}）：请先关闭其他工作台/扩展标签页，或重启引擎提高 server.maxSessions 后重试。`;
      conn.phase = 'rejected';
      log(`拒绝新会话：${message}`);
      sendError('session', message, { recoverable: false, code: 'MAX_SESSIONS' });
      send(statusEvent('error', message, 0));
      try {
        ws.close(1013, 'max sessions');
      } catch {
        /* ignore */
      }
      return;
    }

    conn.phase = 'initializing';
    conn.sessionId = `s_${crypto.randomUUID()}`;
    state.totalSessions += 1;
    log(`新会话 ${conn.sessionId}（source=${normalized.options.source}）开始初始化`);

    const options = normalized.options;
    // 工作台 UI 设置（data/ui-settings.json）注入到会话 overrides：
    // 只影响之后建立的会话；客户端 hello 里自带的 overrides 优先级更高。
    const uiOverrides = state.uiSettings?.overrides ?? {};
    if (uiOverrides && typeof uiOverrides === 'object' && Object.keys(uiOverrides).length > 0) {
      options.overrides = deepMerge(uiOverrides, options.overrides ?? {});
    }
    const effectiveAsr = options.overrides?.asr?.provider ?? config?.asr?.provider ?? 'whisper-local';
    log(`新会话 ${conn.sessionId} 使用 ASR=${effectiveAsr}${uiOverrides?.asr?.provider ? '（来自 UI 设置）' : ''}`);
    const factoryPromise = Promise.resolve().then(() =>
      state.sessionFactory({ id: conn.sessionId, options, emit: emitToClient, log, config }),
    );

    const timeoutMs = state.readyTimeoutMs;
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(
          `会话初始化超时（${Math.round(timeoutMs / 1000)} 秒）：whisper-server 冷启动或网络较慢。请稍候重连，或运行 npm run doctor 检查环境。`,
        );
        err.code = 'INIT_TIMEOUT';
        reject(err);
      }, timeoutMs);
      timer.unref?.();
      conn.initTimer = timer;
    });

    (async () => {
      try {
        const session = await Promise.race([factoryPromise, timeoutPromise]);
        clearTimeout(timer);
        conn.initTimer = null;
        if (conn.closed) {
          try {
            await session?.close?.('client disconnected');
          } catch {
            /* ignore */
          }
          return;
        }
        conn.session = session;
        conn.phase = 'ready';
        log(`会话 ${conn.sessionId} 就绪（pipeline 事件已开始下发）`);
      } catch (err) {
        clearTimeout(timer);
        conn.initTimer = null;
        if (conn.closed) return;
        const message =
          err?.code === 'INIT_TIMEOUT'
            ? err.message
            : `会话初始化失败：${err?.message ?? err}。请检查 provider 配置/密钥与 whisper 模型后重连。`;
        log(`会话 ${conn.sessionId} 初始化失败：${err?.message ?? err}`);
        sendError('session', message, { recoverable: false });
        send(statusEvent('error', message, 0));
        try {
          ws.close(1011, 'session init failed');
        } catch {
          /* ignore */
        }
        factoryPromise.then((late) => late?.close?.('init failed')).catch(() => {});
      }
    })();
  };

  const handleJson = (text) => {
    const parsed = parseClientMessage(text);
    if (!parsed.ok) {
      sendError('server', `无法解析文本消息：${parsed.error}（需要 JSON 文本帧，见 docs/CONTRACTS.md §3）`);
      return;
    }
    const msg = parsed.msg;
    if (msg.type === MSG.HELLO) return handleHello(msg);
    if (msg.type === MSG.PING) {
      if (conn.session && typeof conn.session.onJson === 'function') return forwardJson(msg);
      return send({ type: MSG.PONG, t: msg.t ?? null });
    }
    if (msg.type === MSG.BYE) {
      try {
        ws.close(1000, 'client bye');
      } catch {
        /* ignore */
      }
      return;
    }
    if (msg.type === MSG.AUDIO) return handleJsonAudio(msg);
    if (!conn.session) {
      if (conn.phase === 'awaiting-hello') sendError('server', '第一条消息必须是 hello：先建立会话再发送音频/控制消息');
      else if (conn.phase === 'initializing') sendError('server', '会话正在初始化（whisper 冷启动约 20-30 秒），消息暂被忽略', { recoverable: true });
      return;
    }
    forwardJson(msg);
  };

  ws.on('message', (data, isBinary) => {
    if (conn.closed) return;
    try {
      if (isBinary) handleBinary(data);
      else handleJson(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    } catch (err) {
      log(`处理 WS 消息异常：${err?.message ?? err}`);
      sendError('server', '处理消息时发生内部错误', { recoverable: true });
    }
  });
  ws.on('error', (err) => log(`WS 错误（${req?.socket?.remoteAddress ?? '?'}）：${err?.message ?? err}`));
  ws.on('close', () => {
    conn.closed = true;
    conn.phase = 'closed';
    clearTimeout(conn.helloTimer);
    clearTimeout(conn.initTimer);
    conn.helloTimer = null;
    conn.initTimer = null;
    state.sessions.delete(conn);
    const session = conn.session;
    conn.session = null;
    if (session && typeof session.close === 'function') {
      Promise.resolve()
        .then(() => session.close('client disconnected'))
        .catch((err) => log(`关闭会话失败：${err?.message ?? err}`));
    }
  });

  conn.helloTimer = setTimeout(() => {
    if (conn.closed || conn.phase !== 'awaiting-hello') return;
    sendError('server', '建立连接后 30 秒内没有收到 hello，连接将关闭', { recoverable: false });
    try {
      ws.close(1008, 'hello timeout');
    } catch {
      /* ignore */
    }
  }, state.helloTimeoutMs);
  conn.helloTimer.unref?.();
}

// ---------------------------------------------------------------- demo session

/**
 * 内置演示会话：pipeline.mjs 尚不可用时的兜底（mock ASR -> mock 翻译 -> mock TTS）。
 * 与 pipeline.createSession 的对外行为一致：工厂内部完成初始化并 emit ready；
 * 返回 { start(), onAudio(), onJson(), close(), stats() }。
 */
export async function createDemoSession({ id, options = {}, emit = () => {}, log = () => {}, config = {} } = {}) {
  const sessionId = id ?? `demo_${crypto.randomUUID().slice(0, 8)}`;
  const demoConfig = { ...config, mock: { ...(config?.mock ?? {}), translateDelayMs: 30 } };
  const sampleRate = Number(config?.tts?.sampleRate) || 24000;
  const voiceId = config?.tts?.presetVoices?.default ?? 'demo-voice';
  let closed = false;
  let segmentCounter = 0;
  let partialId = null;
  let dubSeq = 0;
  let lastDubEndMs = 0;
  let glossary = sanitizeGlossary(options.glossary ?? config?.glossary ?? []);
  let workChain = Promise.resolve();
  const speakingTimers = new Set();

  const send = (event) => {
    if (closed) return;
    try {
      emit(event);
    } catch (err) {
      log(`演示会话 emit 失败：${err?.message ?? err}`);
    }
  };

  const asr = createMockAsr({ config: demoConfig, log, onEvent: onAsrEvent });
  const translator = createMockTranslator({ config: demoConfig, log });
  const tts = createMockTts({ config: demoConfig, log });

  function onAsrEvent(ev) {
    if (closed || !ev) return;
    if (ev.type === 'partial') {
      partialId = partialId ?? `p_${segmentCounter + 1}`;
      send({
        type: MSG.PARTIAL,
        id: partialId,
        t0Ms: Math.round(ev.t0Ms ?? 0),
        t1Ms: Math.round(ev.t1Ms ?? 0),
        text: String(ev.text ?? ''),
      });
      return;
    }
    if (ev.type === 'final') {
      partialId = null;
      const segId = `seg_${++segmentCounter}`;
      send({
        type: MSG.SEGMENT,
        id: segId,
        t0Ms: Math.round(ev.t0Ms ?? 0),
        t1Ms: Math.round(ev.t1Ms ?? 0),
        text: String(ev.text ?? ''),
        lang: ev.lang ?? 'en',
      });
      send(statusEvent('translating', '', Math.round(ev.t1Ms ?? 0)));
      workChain = workChain
        .then(() => processSegment(segId, ev))
        .catch((err) => {
          log(`演示会话处理句子失败：${err?.message ?? err}`);
          send(errorEvent('session', `演示会话处理失败：${err?.message ?? err}`, { recoverable: true }));
        });
    }
  }

  async function processSegment(segId, ev) {
    if (closed) return;
    const t1Ms = Math.round(ev.t1Ms ?? 0);
    const translateStart = Date.now();
    const result = await translator.translate({
      text: ev.text,
      context: [],
      glossary,
      onPartial: (partial) => send({ type: MSG.TRANSLATION, id: segId, text: String(partial ?? ''), final: false }),
    });
    const mtFirstMs = Math.max(1, Date.now() - translateStart);
    const mtDoneMs = Math.max(mtFirstMs, Date.now() - translateStart);
    send({ type: MSG.TRANSLATION, id: segId, text: String(result?.text ?? ''), final: true });

    const ttsStart = Date.now();
    const audio = await tts.synthesize({ text: result?.text ?? ev.text, voiceId, speed: 1 });
    const ttsFirstMs = Math.max(1, Date.now() - ttsStart);
    const durationMs = audio?.durationMs ?? 1000;
    const startMs = Math.max(t1Ms, lastDubEndMs + 60);
    lastDubEndMs = startMs + durationMs;
    send({
      type: MSG.DUB,
      id: segId,
      seq: ++dubSeq,
      startMs,
      sampleRate: audio?.sampleRate ?? sampleRate,
      format: 's16le',
      pcm: base64Pcm(audio?.pcm ?? Buffer.alloc(0)),
      durationMs,
      voiceId: audio?.voiceId ?? voiceId,
      final: true,
    });
    send({
      type: MSG.METRICS,
      id: segId,
      t0Ms: Math.round(ev.t0Ms ?? 0),
      t1Ms,
      asrFinalMs: Math.round(900 + String(ev.text ?? '').length * 12),
      mtFirstMs,
      mtDoneMs,
      ttsFirstMs,
      e2eLagMs: Math.round(1400 + String(ev.text ?? '').length * 15),
      voiceMode: 'preset',
    });
    send(statusEvent('speaking', '', t1Ms));
    const timer = setTimeout(() => {
      speakingTimers.delete(timer);
      if (!closed) send(statusEvent('listening', '', lastDubEndMs));
    }, Math.min(Math.max(300, durationMs), 4000));
    timer.unref?.();
    speakingTimers.add(timer);
  }

  const session = {
    id: sessionId,
    async start() {
      return session;
    },
    async onAudio(pcm, tMs) {
      if (closed) return;
      if (!Buffer.isBuffer(pcm) || pcm.length < 2 || pcm.length % 2 !== 0) return;
      try {
        await asr.push(pcm, tMs);
      } catch (err) {
        send(errorEvent('asr', `演示 ASR 处理失败：${err?.message ?? err}`, { recoverable: true }));
      }
    },
    async onJson(msg) {
      if (closed || !msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case MSG.CONTROL:
          if (msg.action === 'pause') send(statusEvent('paused', '', 0));
          else if (msg.action === 'resume') send(statusEvent('listening', '', 0));
          else if (msg.action === 'flush') await asr.flush();
          else if (msg.action === 'stop') await session.close('client stop');
          return;
        case MSG.CONFIG:
          if (msg.patch?.tts?.voiceMode === 'clone-first') {
            send({ type: MSG.VOICE, mode: 'preset', voiceId, degraded: true, reason: '演示会话不支持声音克隆，已使用预设音色' });
          }
          return;
        case MSG.GLOSSARY:
          glossary = sanitizeGlossary(msg.terms ?? []);
          send(statusEvent('listening', `术语表已更新（${glossary.length} 条）`, 0));
          return;
        case MSG.PING:
          send({ type: MSG.PONG, t: msg.t ?? null });
          return;
        default:
          return;
      }
    },
    async close(reason = 'closed') {
      if (closed) return;
      closed = true;
      for (const timer of speakingTimers) clearTimeout(timer);
      speakingTimers.clear();
      try {
        await asr.close?.();
      } catch {
        /* ignore */
      }
      try {
        emit({ type: MSG.BYE, reason: String(reason) });
      } catch {
        /* ignore */
      }
      log(`演示会话 ${sessionId} 已关闭：${reason}`);
    },
    stats() {
      return { id: sessionId, demo: true, segments: segmentCounter, voiceId, glossary: glossary.length };
    },
  };

  // 与 pipeline 一致：工厂返回前完成初始化并下发 ready / voice / status
  send({
    type: MSG.READY,
    sessionId,
    protocol: PROTOCOL_VERSION,
    providers: {
      asr: 'mock',
      translate: { provider: 'mock', chain: ['mock'] },
      tts: { provider: 'mock', model: 'mock', voiceMode: 'preset' },
      sampleRate: AUDIO_INPUT_SAMPLE_RATE,
    },
    voice: { mode: 'preset', voiceId },
    limits: {
      audioFrameMs: AUDIO_FRAME_MS,
      sampleRate: AUDIO_INPUT_SAMPLE_RATE,
      langFrom: config?.session?.langFrom ?? 'en',
      langTo: config?.session?.langTo ?? 'zh',
      demo: true,
    },
  });
  send({ type: MSG.VOICE, mode: 'preset', voiceId });
  send(statusEvent('listening', '演示会话已就绪（engine/pipeline.mjs 尚未接入）', 0));
  log(`演示会话 ${sessionId} 已就绪（pipeline.mjs 缺失时的兜底）`);
  return session;
}

// ------------------------------------------------------------- session factory

/** 默认会话工厂：优先 engine/pipeline.mjs；缺失则回退内置演示会话 */
async function loadDefaultSessionFactory({ log, forceDemo = false }) {
  if (forceDemo) {
    log('已通过 --demo 强制使用内置演示会话（mock ASR/翻译/TTS）');
    return { factory: createDemoSession, mode: 'demo' };
  }
  try {
    const mod = await import('./pipeline.mjs');
    if (typeof mod.createSession === 'function') {
      log('会话层：engine/pipeline.mjs');
      return { factory: mod.createSession, mode: 'pipeline' };
    }
    log('engine/pipeline.mjs 未导出 createSession，回退内置演示会话');
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      log('engine/pipeline.mjs 尚未就绪，使用内置演示会话（mock ASR/翻译/TTS）');
    } else {
      log(`加载 engine/pipeline.mjs 失败：${err?.message ?? err}；回退内置演示会话`);
    }
  }
  return { factory: createDemoSession, mode: 'demo' };
}

// ---------------------------------------------------------------- server start

/**
 * 启动本地引擎服务。
 * @param {object} [options]
 * @param {number} [options.port] 0 = 随机端口（测试用）
 * @param {string} [options.host]
 * @param {object} [options.config] 直接注入完整配置（测试用）
 * @param {object} [options.configOverrides] loadConfig 的 overrides（测试用 mock provider）
 * @param {Function} [options.sessionFactory] 注入会话工厂（{id, options, emit, log, config} -> session）
 * @param {Function} [options.voiceLister] 注入音色列表实现（测试用；默认读 T3 tts/index.mjs）
 * @param {Function} [options.log]
 * @param {boolean} [options.demo] 强制内置演示会话
 * @param {number} [options.readyTimeoutMs]
 * @param {string} [options.studioDir]
 * @param {string} [options.demoDir]
 */
export async function startServer(options = {}) {
  const env = options.env ?? process.env;
  const log = makeLog(options.log);
  const config = options.config ?? loadConfig({ env, overrides: options.configOverrides ?? {} });
  const studioDir = path.resolve(options.studioDir ?? path.join(PROJECT_ROOT, 'studio'));
  const demoDir = path.resolve(options.demoDir ?? path.join(PROJECT_ROOT, 'demo'));
  const dataDir = path.resolve(options.dataDir ?? path.join(PROJECT_ROOT, 'data'));

  let sessionFactory = options.sessionFactory;
  let mode;
  if (typeof sessionFactory === 'function') {
    mode = options.sessionMode ?? 'injected';
    log('会话层：外部注入 sessionFactory（测试/集成模式）');
  } else {
    const loaded = await loadDefaultSessionFactory({ log, forceDemo: options.demo === true });
    sessionFactory = loaded.factory;
    mode = loaded.mode;
  }

  const state = {
    config,
    log,
    studioDir,
    demoDir,
    sessionFactory,
    mode,
    sessions: new Set(),
    totalSessions: 0,
    maxSessions: resolveMaxSessions(config, options),
    startedAt: Date.now(),
    host: options.host ?? config?.server?.host ?? DEFAULT_HOST,
    port: 0,
    url: '',
    pkg: packageInfo(),
    readyTimeoutMs:
      Number.isFinite(options.readyTimeoutMs) && options.readyTimeoutMs >= 0 ? options.readyTimeoutMs : DEFAULT_READY_TIMEOUT_MS,
    helloTimeoutMs:
      Number.isFinite(options.helloTimeoutMs) && options.helloTimeoutMs >= 0 ? options.helloTimeoutMs : DEFAULT_HELLO_TIMEOUT_MS,
    voiceLister: typeof options.voiceLister === 'function' ? options.voiceLister : null,
    voicesCache: null,
    whisperStatusCache: null,
    closeAsrOnShutdown: options.closeAsrOnShutdown !== false,
    // v0.3：工作台 UI 设置（data/ui-settings.json），只影响之后建立的会话
    dataDir,
    uiSettingsPath: path.resolve(options.settingsPath ?? path.join(dataDir, UI_SETTINGS_FILE)),
    desktopAppPath: options.desktopAppPath ? path.resolve(options.desktopAppPath) : path.join(PROJECT_ROOT, DESKTOP_APP_RELATIVE_PATH),
    uiSettings: null,
    // v0.4：共享 Notes API（data/notes、data/exports；文件级串行化 + 原子写）
    noteQueues: new Map(),
    notesStatsCache: null,
    env,
  };

  // 读取持久化的 UI 设置（不存在/脏数据回退默认值，不阻塞启动）
  state.uiSettings = loadUiSettingsFromDisk(state);
  for (const warning of state.uiSettings.warnings ?? []) log(`UI 设置：${warning}`);
  if (Object.keys(state.uiSettings.overrides ?? {}).length > 0) {
    const effective = state.uiSettings.effective;
    log(
      `UI 设置已加载（${toProjectRelative(state.uiSettingsPath)}）：ASR=${effective.asr.provider}，voiceMode=${effective.tts.voiceMode}，dub=${effective.dub.enabled ? 'on' : 'off'}（下次会话生效）`,
    );
  }

  const server = http.createServer(createRequestHandler(state));
  server.on('clientError', (err, socket) => {
    if (!socket.writable) return;
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });

  const wsAttachment = attachWebSocketServer(server, {
    path: '/ws',
    maxPayload: MAX_AUDIO_FRAME_BYTES + 64,
    checkOrigin: (req) => isAllowedOrigin(req.headers.origin),
    log,
    onConnection: (ws, req) => {
      try {
        handleWebSocketConnection(ws, req, state);
      } catch (err) {
        log(`WS 连接处理失败：${err?.message ?? err}`);
        try {
          ws.close(1011, 'internal error');
        } catch {
          /* ignore */
        }
      }
    },
  });

  const desiredPort = options.port ?? config?.server?.port ?? DEFAULT_PORT;
  try {
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(desiredPort, state.host);
    });
  } catch (err) {
    wsAttachment.close();
    throw err;
  }

  const address = server.address();
  if (address && typeof address === 'object') {
    state.port = address.port;
    state.host = address.address && address.address !== '::' ? address.address : state.host;
  }
  state.url = `http://${formatHost(state.host)}:${state.port}`;
  state.studioUrl = `${state.url}/studio/`;
  log(`livedub 引擎已监听 ${state.url}（mode=${mode}）`);

  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    const connections = [...state.sessions];
    for (const conn of connections) {
      try {
        conn.ws.sendText(encodeEvent({ type: MSG.BYE, reason: 'server shutdown' }));
      } catch {
        /* ignore */
      }
      try {
        conn.ws.close(1001, 'server shutdown');
      } catch {
        /* ignore */
      }
    }
    await sleep(80);
    for (const conn of connections) {
      try {
        if (!conn.ws.closed) conn.ws.terminate();
      } catch {
        /* ignore */
      }
    }
    state.sessions.clear();
    wsAttachment.close();
    await new Promise((resolve) => {
      const done = () => resolve();
      try {
        server.close(done);
      } catch {
        done();
      }
      server.closeAllConnections?.();
      setTimeout(done, 1000).unref?.();
    });
    // 重要：共享 whisper-server 不随会话关闭；引擎退出时必须显式收尾，避免 18765 残留孤儿进程。
    if (state.closeAsrOnShutdown) await closeSharedWhisperServers(state);
    log('livedub 引擎已关闭');
  }

  return {
    server,
    state,
    config,
    mode,
    host: state.host,
    port: state.port,
    url: state.url,
    studioUrl: state.studioUrl,
    maxSessions: state.maxSessions,
    dataDir: state.dataDir,
    uiSettingsPath: state.uiSettingsPath,
    desktopAppPath: state.desktopAppPath,
    notesDir: path.join(state.dataDir, 'notes'),
    exportsDir: path.join(state.dataDir, 'exports'),
    sessions: state.sessions,
    close,
  };
}

// ----------------------------------------------------------------------- CLI

export function parseCliArgs(argv = []) {
  const args = { port: undefined, host: undefined, dataDir: undefined, open: false, demo: false, help: false, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const item = String(argv[i]);
    if (item === '--open' || item === '-o') args.open = true;
    else if (item === '--demo') args.demo = true;
    else if (item === '--verbose' || item === '-v') args.verbose = true;
    else if (item === '--help' || item === '-h') args.help = true;
    else if (item === '--port' || item === '-p') {
      args.port = Number(argv[++i]);
    } else if (item.startsWith('--port=')) args.port = Number(item.slice('--port='.length));
    else if (item === '--host') args.host = argv[++i];
    else if (item.startsWith('--host=')) args.host = item.slice('--host='.length);
    else if (item === '--data-dir') args.dataDir = argv[++i];
    else if (item.startsWith('--data-dir=')) args.dataDir = item.slice('--data-dir='.length);
    else throw new Error(`未知参数：${item}（支持 --port/--host/--open/--demo/--verbose/--help）`);
  }
  if (args.port !== undefined) {
    if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
      throw new Error('--port 必须是 0-65535 的整数');
    }
  }
  return args;
}

function formatMode(mode) {
  if (mode === 'pipeline') return 'engine/pipeline.mjs（真实会话）';
  if (mode === 'demo') return '内置演示会话（mock ASR/翻译/TTS）';
  return '外部注入 sessionFactory';
}

function openInBrowser(url, log) {
  if (process.platform !== 'darwin') {
    log(`请手动在浏览器打开：${url}`);
    return;
  }
  try {
    const child = spawn('open', [url], { stdio: 'ignore', detached: true });
    child.on('error', (err) => log(`无法自动打开浏览器：${err.message}；请手动打开 ${url}`));
    child.unref();
    log(`已在默认浏览器打开 ${url}`);
  } catch (err) {
    log(`无法自动打开浏览器：${err.message}；请手动打开 ${url}`);
  }
}

function printHelp() {
  console.log(`livedub 本地引擎 + 工作台

用法：
  node engine/server.mjs [选项]

选项：
  -p, --port <端口>   监听端口（默认取 config/livedub.config.json，8787）
      --host <地址>   监听地址（默认 127.0.0.1）
  -o, --open          启动后在默认浏览器打开工作台（macOS: open）
      --demo          强制使用内置演示会话（mock ASR/翻译/TTS，不需要密钥/模型）
      --data-dir <目录> 运行期数据目录（默认 ./data；笔记/设置/导出都放这里）
  -v, --verbose       输出调试日志（也不打印密钥）
  -h, --help          显示帮助

工作台：http://127.0.0.1:<port>/studio/    回放：/replay/?session=/demo/session.jsonl
API：  /health  /api/config  /api/voices  /api/settings（GET/PUT）      WS：/ws（见 docs/CONTRACTS.md §3）`);
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    console.error(`[livedub] ${err.message}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    printHelp();
    return;
  }

  const log = (msg) => console.log(`[livedub ${new Date().toISOString().slice(11, 19)}] ${msg}`);
  let started;
  try {
    started = await startServer({
      port: args.port,
      host: args.host,
      dataDir: args.dataDir,
      demo: args.demo,
      verbose: args.verbose,
      log,
    });
  } catch (err) {
    if (err?.code === 'EADDRINUSE') {
      const port = err.port ?? args.port ?? DEFAULT_PORT;
      console.error(
        `[livedub] 端口 ${port} 已被占用。\n  换一个端口：node engine/server.mjs --port ${Number(port) + 1}\n  或查看占用：lsof -nP -iTCP:${port} -sTCP:LISTEN`,
      );
    } else {
      console.error(`[livedub] 启动失败：${err?.message ?? err}`);
    }
    process.exitCode = 1;
    return;
  }

  const config = started.config;
  const whisperModel = resolveWhisperModel(config);
  const saylessPath = config?._meta?.saylessConfigPath ?? null;
  const line = (label, value) => console.log(`  ${label.padEnd(6, ' ')} ${value}`);
  console.log('');
  console.log('  livedub 本地引擎已启动');
  console.log('  ─────────────────────────────────────────────');
  line('引擎', started.url);
  line('工作台', started.studioUrl);
  line('回放', `${started.url}/replay/`);
  line('会话层', formatMode(started.mode));
  const uiEffective = started.state?.uiSettings?.effective ?? null;
  const asrProvider = uiEffective?.asr?.provider ?? config?.asr?.provider ?? '?';
  const uiNote = started.state?.uiSettings?.overrides?.asr?.provider ? '（UI 设置，下次会话生效）' : '';
  const asrNote = asrProvider === 'minimax-cloud' ? '云端识别，音频会上传到 MiniMax' : whisperModel ? `模型 ${toProjectRelative(whisperModel)}` : '⚠ 未找到 whisper 模型';
  line('ASR', `${asrProvider} · ${asrNote}${uiNote}`);
  line('设置', `${toProjectRelative(started.uiSettingsPath)}${started.state?.uiSettings?.overrides && Object.keys(started.state.uiSettings.overrides).length ? '（已应用）' : '（默认）'}`);
  const desktopApp = detectDesktopApp(started.state);
  line('桌面版', desktopApp.available ? desktopApp.appPath : `未构建 · ${desktopApp.buildCommand}`);
  line('翻译', `${config?.translate?.provider ?? '?'}${Array.isArray(config?.translate?.chain) ? `（链：${config.translate.chain.join(' → ')}）` : ''}`);
  line('配音', `${config?.tts?.provider ?? '?'} · ${config?.tts?.voiceMode ?? 'preset'}`);
  line('并发', `最多 ${started.maxSessions} 个会话（config.server.maxSessions）`);
  const notesStats = getNotesStats(started.state);
  line('笔记', `${notesStats.count} 条 · ${notesStats.notesDir}（导出 ${notesStats.exportsDir}）`);
  line('凭据', saylessPath ? `~/.sayless 配置已发现` : '未发现 ~/.sayless/config.json（可使用 --demo 体验）');
  console.log('  ─────────────────────────────────────────────');
  console.log('  按 Ctrl+C 退出');

  if (args.open) openInBrowser(started.studioUrl, log);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${signal}，正在关闭…`);
    try {
      await started.close();
    } catch (err) {
      console.error(`[livedub] 关闭时出错：${err?.message ?? err}`);
    }
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entry && import.meta.url === entry) {
  main().catch((err) => {
    console.error(`[livedub] 启动失败：${err?.message ?? err}`);
    process.exit(1);
  });
}
