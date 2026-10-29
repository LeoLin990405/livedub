/**
 * 配置加载与 provider 凭据解析。
 *
 * 分层（后者覆盖前者）：
 *   1. config/livedub.config.json（项目默认值，提交进仓库）
 *   2. ~/.sayless/config.json 里的 providers（复用用户已有的 OpenAI 兼容 Key；只读，绝不写回）
 *   3. env：LIVEDUB_*（见下）/ 各 provider 的 LIVEDUB_PROVIDER_<NAME>_API_KEY
 *   4. 调用方 overrides（会话级，来自 hello.overrides）
 *
 * 安全：永不落盘密钥；publicConfig() 输出给浏览器的配置必须脱敏。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_FILE = path.join(PROJECT_ROOT, 'config', 'livedub.config.json');

export function projectPath(...parts) {
  return path.join(PROJECT_ROOT, ...parts);
}

export function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** 候选路径 -> 第一个存在的绝对路径（支持 ~ 展开与相对项目根） */
export function findFirstExisting(candidates) {
  for (const candidate of candidates ?? []) {
    if (!candidate) continue;
    const p = path.isAbsolute(candidate) ? expandHome(candidate) : projectPath(expandHome(candidate));
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function readJsonIfExists(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    return readJson(file);
  } catch {
    return null;
  }
}

export function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** ~/.sayless 配置路径（用户已有的一批 OpenAI 兼容 provider / Key 来源） */
export function saylessConfigPath(env = process.env) {
  const dir = env.SAYLESS_DIR ? expandHome(env.SAYLESS_DIR) : path.join(os.homedir(), '.sayless');
  return path.join(dir, 'config.json');
}

/** 读取 sayless 的 providers（只读；不存在则空） */
export function loadSaylessProviders(env = process.env) {
  const cfg = readJsonIfExists(saylessConfigPath(env));
  if (!cfg) return { path: null, providers: {}, llm: null, translate: null, asr: null, tts: null };
  return {
    path: saylessConfigPath(env),
    providers: cfg.providers ?? {},
    llm: cfg.llm ?? null,
    translate: cfg.translate ?? null,
    asr: cfg.asr ?? null,
    tts: cfg.tts ?? null,
  };
}

export function providerEnvKey(name) {
  return `LIVEDUB_PROVIDER_${String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

const BUILTIN_PROVIDERS = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', chatPath: '/chat/completions' },
  minimax: { baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-M3', chatPath: '/chat/completions', ttsChatPath: '/t2a_v2' },
  ark: { baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', chatPath: '/chat/completions' },
  volcengine: { baseUrl: 'https://openspeech.bytedance.com' },
};

/**
 * 解析某个 provider 的连接信息。
 * 顺序：session/livedub config.providers[name] -> ~/.sayless providers[name] -> 内置默认
 */
export function resolveProvider(config, name, env = process.env) {
  if (!name) throw new Error('provider name is required');
  const local = config?.providers?.[name] ?? {};
  const sayless = loadSaylessProviders(env).providers?.[name] ?? {};
  const builtin = BUILTIN_PROVIDERS[name] ?? {};
  const merged = { ...builtin, ...sayless, ...local };
  const apiKey = env[providerEnvKey(name)] || local.apiKey || sayless.apiKey || '';
  const baseUrl = String(merged.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error(`provider "${name}" 缺少 baseUrl（检查 ~/.sayless/config.json 或 config/livedub.config.json）`);
  return {
    name,
    baseUrl,
    apiKey,
    model: merged.model || '',
    chatPath: merged.chatPath || '/chat/completions',
    ttsChatPath: merged.ttsChatPath || '/t2a_v2',
    timeoutMs: Number(merged.timeoutMs) > 0 ? Number(merged.timeoutMs) : 30000,
    raw: merged,
  };
}

/** whisper 模型：按 asr.whisper.models 候选找第一个存在的 */
export function resolveWhisperModel(config) {
  const whisper = config?.asr?.whisper ?? {};
  const candidates = whisper.models ?? (whisper.model ? [whisper.model] : []);
  const found = findFirstExisting(candidates);
  return found;
}

/** 加载完整配置 */
export function loadConfig({ env = process.env, overrides = {} } = {}) {
  let base = readJsonIfExists(CONFIG_FILE) ?? {};
  const profile = String(env.LIVEDUB_PROFILE ?? '').trim();
  if (profile) {
    const profileFile = path.join(PROJECT_ROOT, 'config', `livedub.${profile}.json`);
    const profileOverlay = readJsonIfExists(profileFile);
    if (profileOverlay) {
      base = deepMerge(base, profileOverlay);
      delete base._comment;
    } else {
      process.emitWarning(`LIVEDUB_PROFILE=${profile} 但找不到 ${path.basename(profileFile)}，使用默认配置`);
    }
  }
  const sayless = loadSaylessProviders(env);
  const withSayless = deepMerge(base, {
    // 只有显式提供的 sayless.* 才注入，避免把用户的全部 provider 深拷贝进配置（运行时 resolveProvider 会再查）
    providers: {},
  });
  let config = deepMerge(withSayless, overrides ?? {});

  // env 覆盖
  if (env.LIVEDUB_PORT) config = deepMerge(config, { server: { port: Number(env.LIVEDUB_PORT) } });
  if (env.LIVEDUB_HOST) config = deepMerge(config, { server: { host: String(env.LIVEDUB_HOST) } });
  if (env.LIVEDUB_WHISPER_MODEL) {
    config = deepMerge(config, { asr: { whisper: { models: [env.LIVEDUB_WHISPER_MODEL] } } });
  }
  if (env.LIVEDUB_TRANSLATE_PROVIDER) {
    config = deepMerge(config, { translate: { provider: env.LIVEDUB_TRANSLATE_PROVIDER } });
  }
  if (env.LIVEDUB_TTS_PROVIDER) {
    config = deepMerge(config, { tts: { provider: env.LIVEDUB_TTS_PROVIDER } });
  }

  config._meta = {
    projectRoot: PROJECT_ROOT,
    saylessConfigPath: sayless.path,
    saylessProviderCount: Object.keys(sayless.providers ?? {}).length,
  };
  return config;
}

/** 给浏览器的脱敏配置快照 */
export function publicConfig(config) {
  const snap = deepMerge({}, config);
  delete snap._meta;
  if (snap.providers) {
    for (const [name, p] of Object.entries(snap.providers)) {
      if (p && typeof p === 'object') {
        delete p.apiKey;
        delete p.token;
        delete p.secret;
      }
      snap.providers[name] = p;
    }
  }
  const whisperModel = resolveWhisperModel(config);
  snap.runtime = {
    ...(snap.runtime ?? {}),
    projectRoot: PROJECT_ROOT,
    saylessConfigPath: config?._meta?.saylessConfigPath ?? null,
    saylessProviderCount: config?._meta?.saylessProviderCount ?? 0,
    whisperModel,
    whisperModelFound: Boolean(whisperModel),
  };
  return snap;
}

/** 校验配置，返回问题列表（doctor 用） */
export function validateConfig(config, env = process.env) {
  const issues = [];
  const asr = config?.asr ?? {};
  if (asr.provider === 'whisper-local') {
    const p = resolveWhisperModel(config);
    if (!p) issues.push({ level: 'error', scope: 'asr', message: '找不到 whisper 模型（asr.whisper.models 候选均不存在，可运行 npm run doctor 查看）' });
  } else if (!asr.provider) {
    issues.push({ level: 'error', scope: 'asr', message: 'asr.provider 未配置' });
  }
  const primary = config?.translate?.provider;
  if (primary) {
    try {
      const p = resolveProvider(config, primary, env);
      if (!p.apiKey) issues.push({ level: 'error', scope: 'translate', message: `provider "${primary}" 缺少 apiKey` });
    } catch (e) {
      issues.push({ level: 'error', scope: 'translate', message: e.message });
    }
  }
  const ttsPrimary = config?.tts?.provider;
  if (ttsPrimary && ttsPrimary !== 'macos-say' && ttsPrimary !== 'mock') {
    try {
      const p = resolveProvider(config, ttsPrimary, env);
      if (!p.apiKey) issues.push({ level: 'error', scope: 'tts', message: `provider "${ttsPrimary}" 缺少 apiKey` });
    } catch (e) {
      issues.push({ level: 'error', scope: 'tts', message: e.message });
    }
  }
  return issues;
}
