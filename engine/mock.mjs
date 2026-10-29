/**
 * mock providers —— 让「整条管线」在没有网络/没有模型时也能确定性跑通。
 * 用途：
 *   - tests/pipeline.test.mjs 的端到端测试（无外部依赖）
 *   - studio 的离线回放 / 扩展的开发模式
 *   - 真实 provider 故障时的排查对照
 *
 * 契约与真实 provider 完全一致，见 docs/CONTRACTS.md。
 */
import { concatPcm, pcmDurationMs } from './audio.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

const DEFAULT_SCRIPT = [
  { text: 'Today we are going to learn about gradient descent.', durMs: 2400 },
  { text: 'It is a first order iterative optimization algorithm.', durMs: 2600 },
  { text: 'We repeatedly step in the opposite direction of the gradient.', durMs: 3000 },
];

const DEFAULT_DICT = {
  'today we are going to learn about gradient descent.': '今天我们来学习梯度下降。',
  'it is a first order iterative optimization algorithm.': '它是一种一阶迭代优化算法。',
  'we repeatedly step in the opposite direction of the gradient.': '我们反复朝着梯度的反方向迈步。',
};

/** 生成一段正弦波 PCM（s16le, mono），作为 mock 配音，可听出「有声音」 */
export function makeTonePcm(durationMs, sampleRate = 24000, freq = 440) {
  const n = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const buf = Buffer.allocUnsafe(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, i / (sampleRate * 0.01), (n - i) / (sampleRate * 0.01));
    buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * t) * 0.18 * 32767 * env), i * 2);
  }
  return buf;
}

/**
 * mock ASR：按脚本把音频流「识别」成 partial/final 事件。
 * cfg.mock.asrScript: [{text, durMs}]
 */
export function createMockAsr({ config = {}, log = () => {}, onEvent = () => {} } = {}) {
  const script = config?.mock?.asrScript ?? DEFAULT_SCRIPT;
  const sampleRate = 16000;
  let accumulatedMs = 0; // 已 push 的音频时长（近似会话时间轴）
  let scriptCursor = 0; // 当前脚本项已消费的音频时长
  let lastPartialAt = -Infinity;
  let closed = false;
  let partialTimer = null;

  function schedulePartial() {
    if (closed || partialTimer) return;
    partialTimer = setTimeout(() => {
      partialTimer = null;
      const item = script[scriptCursor];
      if (!item) return;
      if (accumulatedMs - lastPartialAt < 600) return;
      const progress = Math.min(0.92, (accumulatedMs - scriptCursorOffsetMs()) / item.durMs);
      if (progress <= 0.08) return;
      const chars = Math.max(1, Math.floor(item.text.length * progress));
      lastPartialAt = accumulatedMs;
      onEvent({
        type: 'partial',
        text: item.text.slice(0, chars),
        t0Ms: Math.round(scriptCursorOffsetMs()),
        t1Ms: Math.round(accumulatedMs),
      });
    }, 120);
    partialTimer.unref?.();
  }

  function scriptCursorOffsetMs() {
    let offset = 0;
    for (let i = 0; i < scriptCursor; i++) offset += script[i].durMs;
    return offset;
  }

  return {
    name: 'mock-asr',
    async push(pcm, tMs) {
      if (closed) return;
      const durMs = pcmDurationMs(pcm, sampleRate);
      accumulatedMs = Math.max(accumulatedMs, tMs + durMs);
      for (;;) {
        const item = script[scriptCursor];
        if (!item) break;
        const cursorOffset = scriptCursorOffsetMs();
        if (accumulatedMs < cursorOffset + item.durMs) break;
        onEvent({
          type: 'final',
          text: item.text,
          t0Ms: Math.round(cursorOffset),
          t1Ms: Math.round(cursorOffset + item.durMs),
          lang: 'en',
        });
        scriptCursor += 1;
        lastPartialAt = -Infinity;
      }
      schedulePartial();
    },
    async flush() {
      const item = script[scriptCursor];
      if (item) {
        onEvent({
          type: 'final',
          text: item.text,
          t0Ms: Math.round(scriptCursorOffsetMs()),
          t1Ms: Math.round(accumulatedMs),
          lang: 'en',
        });
        scriptCursor += 1;
      }
      accumulatedMs += 1;
    },
    async close() {
      closed = true;
      if (partialTimer) clearTimeout(partialTimer);
      partialTimer = null;
    },
  };
}

/** mock 翻译：查表 + 逐字流式输出 */
export function createMockTranslator({ config = {}, log = () => {} } = {}) {
  const dict = { ...DEFAULT_DICT, ...(config?.mock?.translations ?? {}) };
  const defaultPrefix = config?.mock?.translationPrefix ?? '【译】';
  const delayMs = config?.mock?.translateDelayMs ?? 4;
  return {
    name: 'mock-translator',
    async translate({ text, onPartial, signal } = {}) {
      const key = String(text ?? '').trim().toLowerCase();
      const hasDict = Object.prototype.hasOwnProperty.call(dict, key);
      const full = hasDict ? dict[key] : `${defaultPrefix}${text}`;
      const steps = Math.min(6, Math.max(1, Math.ceil(full.length / 6)));
      for (let i = 1; i <= steps; i++) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        await sleep(delayMs);
        onPartial?.(full.slice(0, Math.round((full.length * i) / steps)));
      }
      return { text: full, model: 'mock', provider: 'mock' };
    },
  };
}

/** mock TTS：合成低音量正弦波，接口与真实 TTS 完全一致 */
export function createMockTts({ config = {}, log = () => {} } = {}) {
  const sampleRate = config?.tts?.sampleRate ?? 24000;
  const cloneFails = Boolean(config?.mock?.cloneFails);
  const minChars = Number(config?.tts?.chunk?.minClauseChars ?? 8);
  return {
    name: 'mock-tts',
    sampleRate,
    async synthesize({ text, voiceId, speed = 1 } = {}) {
      const chars = Math.max(minChars, String(text ?? '').replace(/\s+/g, ' ').trim().length);
      const durationMs = Math.min(9000, Math.max(500, Math.round(chars * 95 / Math.max(0.5, speed))));
      return { pcm: makeTonePcm(durationMs, sampleRate, 392), sampleRate, format: 's16le', durationMs, voiceId: voiceId || 'mock' };
    },
    async *synthesizeStream({ text, voiceId, speed = 1 } = {}) {
      const { pcm, sampleRate: sr, durationMs } = await this.synthesize({ text, voiceId, speed });
      const chunkBytes = Math.max(2, Math.floor(pcm.length / 3 / 2) * 2);
      for (let i = 0; i < pcm.length; i += chunkBytes) {
        yield { pcm: pcm.subarray(i, i + chunkBytes), sampleRate: sr, format: 's16le', durationMs };
        await sleep(20);
      }
    },
    async listVoices() {
      return [
        { id: 'mock-female', label: 'Mock 女声', gender: 'female', cloned: false },
        { id: 'mock-male', label: 'Mock 男声', gender: 'male', cloned: false },
        { id: 'mock-clone-1', label: 'Mock 克隆音色', gender: 'unknown', cloned: true },
      ];
    },
    async cloneVoice({ pcm, sampleRate: sr = 16000, name = 'mock-clone' } = {}) {
      if (cloneFails) throw new Error('mock clone disabled (config.mock.cloneFails=true)');
      const bytes = pcm?.length ?? 0;
      return { voiceId: `mock-clone-${bytes % 1000}`, mode: 'clone', provider: 'mock', name, sampleRate: sr };
    },
  };
}

/** mock scheduler：直接按顺序播放 */
export function createMockScheduler({ config = {} } = {}) {
  let lastEndMs = 0;
  return {
    name: 'mock-scheduler',
    plan({ readyAtMs, durationMs }) {
      const startMs = Math.max(readyAtMs, lastEndMs);
      lastEndMs = startMs + durationMs;
      return { action: 'play', startMs, rate: 1 };
    },
    stats() {
      return { lastEndMs };
    },
  };
}

/** 汇总：一次拿到全套 mock deps（pipeline e2e 用） */
export function createMockDeps(overrides = {}) {
  return {
    createAsr: (opts) => createMockAsr({ ...opts, config: opts.config }),
    createTranslator: (opts) => createMockTranslator(opts),
    createTts: (opts) => createMockTts(opts),
    createScheduler: (opts) => createMockScheduler(opts),
    createVoiceManager: (opts) => createMockVoiceManager(opts),
    ...overrides,
  };
}

/** mock 音色管理：clone-first 时 3 段语音后返回克隆音色 */
export function createMockVoiceManager({ config = {}, tts, log = () => {} } = {}) {
  const mode = config?.tts?.voiceMode ?? 'preset';
  const state = { mode: 'preset', voiceId: config?.tts?.presetVoices?.default ?? 'mock-female', reason: null };
  let samples = Buffer.alloc(0);
  let sampleRate = 16000;
  const minSampleSec = Number(config?.tts?.clone?.minSampleSec ?? 2);
  return {
    state,
    async ensureVoice({ pcm, sampleRate: sr = 16000 } = {}) {
      if (mode === 'preset') return { ...state, degraded: false };
      if (pcm && pcm.length > 0) {
        samples = concatPcm([samples, pcm]);
        sampleRate = sr;
      }
      const needBytes = Math.floor(minSampleSec * sampleRate * 2);
      if (state.mode === 'preset' && samples.length >= needBytes) {
        try {
          const cloned = await tts.cloneVoice({ pcm: samples, sampleRate, name: 'session-speaker' });
          state.mode = 'clone';
          state.voiceId = cloned.voiceId;
          log('mock voice cloned', cloned.voiceId);
        } catch (err) {
          state.reason = err.message;
        }
      }
      return { ...state, degraded: Boolean(state.reason) };
    },
    stats() {
      return { ...state, sampleBytes: samples.length };
    },
  };
}
