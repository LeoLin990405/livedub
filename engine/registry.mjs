/**
 * 默认 provider 装配：按 config 名称 lazy import 各层实现，返回 Session 需要的 deps。
 * - provider === 'mock' 时直接用 engine/mock.mjs，便于无网络/无模型跑通全链路。
 * - 未实现的 provider 名称 -> 明确报错（不静默回退）。
 */
import {
  createMockAsr,
  createMockTranslator,
  createMockTts,
  createMockScheduler,
  createMockVoiceManager,
} from './mock.mjs';
import { resolveWhisperModel } from './config.mjs';

export async function createDeps({ config, log = () => {} }) {
  const asrProvider = config?.asr?.provider ?? 'whisper-local';
  const translateProvider = config?.translate?.provider ?? 'deepseek';
  const ttsProvider = config?.tts?.provider ?? 'minimax';

  const asrMock = asrProvider === 'mock';
  const translateMock = translateProvider === 'mock';
  const ttsMock = ttsProvider === 'mock';

  const asrMod = asrMock ? null : await import('./asr/index.mjs').catch((err) => {
    throw new Error(`无法加载 ASR 模块 engine/asr/index.mjs：${err.message}（需先实现 T1）`);
  });
  const translateMod = translateMock ? null : await import('./translate/index.mjs').catch((err) => {
    throw new Error(`无法加载翻译模块 engine/translate/index.mjs：${err.message}（需先实现 T2）`);
  });
  const ttsMod = ttsMock ? null : await import('./tts/index.mjs').catch((err) => {
    throw new Error(`无法加载 TTS 模块 engine/tts/index.mjs：${err.message}（需先实现 T3）`);
  });
  const schedulerMod = await import('./dub/scheduler.mjs').catch(() => null);
  const voiceMod = await import('./voice.mjs').catch(() => null);

  if (!asrMock && typeof asrMod?.createAsr !== 'function') throw new Error('engine/asr/index.mjs 缺少 createAsr 导出');
  if (!translateMock && typeof translateMod?.createTranslator !== 'function') throw new Error('engine/translate/index.mjs 缺少 createTranslator 导出');
  if (!ttsMock && typeof ttsMod?.createTts !== 'function') throw new Error('engine/tts/index.mjs 缺少 createTts 导出');

  const whisperModel = resolveWhisperModel(config);
  if (!asrMock && asrProvider === 'whisper-local' && !whisperModel) {
    throw new Error('找不到 whisper 模型：检查 config.asr.whisper.models 候选路径（可运行 npm run doctor）');
  }

  return {
    config,
    splitForTtsFallback: (text, opts) => {
      if (typeof ttsMod?.splitForTts === 'function') return ttsMod.splitForTts(text, opts);
      return naiveSplit(text, opts);
    },
    createAsr: (opts) => {
      const cfg = opts?.config ?? config;
      return asrMock ? createMockAsr({ ...opts, config: cfg }) : asrMod.createAsr({ ...opts, config: cfg });
    },
    createTranslator: (opts) => {
      const cfg = opts?.config ?? config;
      return translateMock ? createMockTranslator({ ...opts, config: cfg }) : translateMod.createTranslator({ ...opts, config: cfg });
    },
    createTts: (opts) => {
      const cfg = opts?.config ?? config;
      if (ttsMock) return createMockTts({ ...opts, config: cfg });
      const factory = ttsMod.createTtsWithFallback ?? ttsMod.createTts;
      return factory({ ...opts, config: cfg });
    },
    createScheduler: (opts) => {
      const cfg = opts?.config ?? config;
      return schedulerMod?.createScheduler ? schedulerMod.createScheduler({ ...opts, config: cfg }) : createMockScheduler({ ...opts, config: cfg });
    },
    createVoiceManager: (opts) => {
      const cfg = opts?.config ?? config;
      return voiceMod?.createVoiceManager ? voiceMod.createVoiceManager({ ...opts, config: cfg }) : createMockVoiceManager({ ...opts, config: cfg });
    },
  };
}

/** 极简兜底切句（真实实现由 T3 的 splitForTts 提供） */
export function naiveSplit(text, { minClauseChars = 8, maxChunkChars = 80 } = {}) {
  const src = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!src) return [];
  const parts = src.match(/[^。！？；;.!?]+[。！？；;.!?]?/g) ?? [src];
  const out = [];
  let buf = '';
  for (const part of parts) {
    const p = part.trim();
    if (!p) continue;
    if (buf && buf.length + p.length > maxChunkChars) {
      out.push(buf);
      buf = '';
    }
    if (!buf && p.length > maxChunkChars) {
      for (let i = 0; i < p.length; i += maxChunkChars) out.push(p.slice(i, i + maxChunkChars));
      continue;
    }
    buf += p;
    if (buf.length >= minClauseChars && /[。！？；;.!?]$/.test(buf)) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}
