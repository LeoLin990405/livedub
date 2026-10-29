/**
 * 音色管理器：克隆优先（clone-first）-> 失败永久降级预设音色。
 *
 * 契约见 docs/CONTRACTS.md §4：
 *   createVoiceManager({ config, tts, log }) -> {
 *     state: { mode:'preset'|'clone', voiceId, reason? },
 *     ensureVoice({ pcm?, sampleRate?, gender? }) -> Promise<{ mode, voiceId, degraded?, reason? }>,
 *     stats(): object,
 *   }
 *
 * 语义（关键，别写错）：
 *   - tts.voiceMode='preset'：从不累积样本、从不尝试克隆；
 *   - tts.voiceMode='clone-first'：每句把讲师原声 PCM 累积起来（VAD 已切过，都是语音），
 *     攒够 tts.clone.minSampleSec 秒后**只尝试一轮克隆**；
 *     成功 -> 切克隆音色；失败 -> 记住 reason，此后永久用 preset 音色，**不得每句重试**。
 *   - 克隆候选链（v0.3）：按 tts.clone.chain（缺省 [clone.provider, 'minimax', 'volcengine'] 去重）逐个尝试；
 *     某 provider 不可用/失败只记一次原因并继续下一个（例如 MiniMax 2061 → 火山声音复刻 v3）；
 *     全部失败才永久降级 preset，voice 事件 reason 里保留每个 provider 的失败原因。
 *   - 非主 provider 的克隆客户端按需 lazy import ./tts/index.mjs 并用 config override 创建，
 *     创建失败（如缺 UUID Key）也只是一个可读的失败原因，不影响主链路。
 *
 * 样本统一重采样到 16kHz 单声道 s16le 后再克隆（ASR 输入本来就是 16k）。
 */
import { concatPcm, resamplePcm, pcmDurationMs } from './audio.mjs';

/** 克隆样本统一采样率（与项目音频总线一致） */
const SAMPLE_RATE = 16000;
/** 单条样本最大字符/字节安全上限，防止长会话内存无限增长 */
const MAX_SAMPLE_BYTES_HARD_CAP = 5 * 60 * SAMPLE_RATE * 2; // 5min 上限

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clampReason(reason) {
  const s = String(reason ?? 'unknown error').replace(/\s+/g, ' ').trim();
  return s.length > 300 ? `${s.slice(0, 297)}...` : s;
}

function snapshotOf(state, { includeReason = true } = {}) {
  const out = {
    mode: state.mode,
    voiceId: state.voiceId,
    degraded: Boolean(state.reason),
  };
  if (includeReason && state.reason) out.reason = state.reason;
  return out;
}

/**
 * @param {object} opts
 * @param {object} opts.config
 * @param {object} opts.tts 主 TTS 实例（pipeline 注入）
 * @param {Function} [opts.log]
 * @param {Function} [opts.createTtsImpl] 测试注入钩子：用 fake 克隆 provider 覆盖 lazy import 的 createTts
 */
export function createVoiceManager({ config = {}, tts, log = () => {}, createTtsImpl = null } = {}) {
  const ttsCfg = config?.tts ?? {};
  const presetVoices = ttsCfg.presetVoices ?? {};
  const voiceMode = String(ttsCfg.voiceMode ?? 'preset');
  const cloneFirst = voiceMode === 'clone-first' || voiceMode === 'clone';
  const cloneCfg = ttsCfg.clone ?? {};
  const minSampleSec = positiveNumber(cloneCfg.minSampleSec, 12);
  const maxSampleSec = Math.max(minSampleSec, positiveNumber(cloneCfg.maxSampleSec, 45));
  const maxBytes = Math.min(MAX_SAMPLE_BYTES_HARD_CAP, Math.round(maxSampleSec * SAMPLE_RATE * 2));
  const needMs = minSampleSec * 1000;

  // 克隆候选链：tts.clone.chain > [tts.clone.provider, 'minimax', 'volcengine']，去重去空
  const cloneProviderChain = (() => {
    const configured = Array.isArray(cloneCfg.chain) && cloneCfg.chain.length > 0 ? cloneCfg.chain : null;
    const raw = configured ?? [cloneCfg.provider || tts?.name || 'minimax', 'minimax', 'volcengine'];
    const out = [];
    for (const item of raw) {
      const name = typeof item === 'string' ? item : item?.provider;
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (!trimmed || out.includes(trimmed)) continue;
      out.push(trimmed);
    }
    return out;
  })();

  /** 返回 presetVoices 里按 gender 选中的音色 id */
  function pickPreset(gender) {
    const g = typeof gender === 'string' ? gender.toLowerCase() : '';
    if ((g === 'male' || g === 'female' || g === 'narrator') && typeof presetVoices[g] === 'string' && presetVoices[g]) {
      return presetVoices[g];
    }
    if (typeof presetVoices.default === 'string' && presetVoices.default) return presetVoices.default;
    const first = Object.values(presetVoices).find((v) => typeof v === 'string' && v);
    return first ?? null;
  }

  const state = { mode: 'preset', voiceId: pickPreset(), reason: null };

  let buffer = Buffer.alloc(0);
  let bufferedMs = 0;
  let attempted = false; // 是否已尝试过克隆（失败后永久不再试）
  let cloneAttempts = 0;
  let clonePromise = null;
  let lastSampleMs = 0;
  let updates = 0;

  function degrade(reason) {
    state.mode = 'preset';
    state.reason = clampReason(reason);
    if (!state.voiceId) state.voiceId = pickPreset();
  }

  function applyGender(gender) {
    if (state.mode !== 'preset' || !gender) return;
    const id = pickPreset(gender);
    if (id) state.voiceId = id;
  }

  /** 把讲师 PCM 追加进克隆样本缓冲（统一 16k） */
  function accumulate(pcm, sampleRate) {
    if (!Buffer.isBuffer(pcm) || pcm.length < 2) return;
    const rate = positiveNumber(sampleRate, SAMPLE_RATE);
    const remain = maxBytes - buffer.length;
    if (remain < 2) return;
    const normalized = rate === SAMPLE_RATE ? pcm : resamplePcm(pcm, rate, SAMPLE_RATE);
    let chunk = normalized.length > remain ? normalized.subarray(0, remain - (remain % 2)) : normalized;
    if (chunk.length % 2 !== 0) chunk = chunk.subarray(0, chunk.length - 1);
    if (chunk.length < 2) return;
    buffer = concatPcm([buffer, chunk]);
    bufferedMs = pcmDurationMs(buffer, SAMPLE_RATE);
  }

  const cloneClients = new Map(); // provider -> Promise<tts 实例>
  let cloneProvider = null; // 克隆成功时实际使用的 provider
  let cloneFailures = []; // [{provider, code, message}] 每个候选一次

  function createCloneClientFor(providerName) {
    const factory = createTtsImpl;
    const overrideConfig = { ...config, tts: { ...ttsCfg, provider: providerName } };
    if (typeof factory === 'function') return Promise.resolve(factory({ config: overrideConfig, log }));
    // 生产路径：lazy import（与 registry 用同一套 createTts，含缓存/校验包装）
    return import('./tts/index.mjs').then((mod) => mod.createTts({ config: overrideConfig, log }));
  }

  function cloneClientFor(providerName) {
    // 主 TTS 实例就是该 provider 时直接复用，避免重复创建/重复认证
    if (tts && tts.name === providerName) {
      if (typeof tts.cloneVoice === 'function') return Promise.resolve(tts);
      return Promise.reject(new Error(`${providerName} 不支持音色克隆（cloneVoice 未实现）`));
    }
    if (!cloneClients.has(providerName)) {
      const promise = createCloneClientFor(providerName).then((inst) => {
        if (!inst || typeof inst.cloneVoice !== 'function') {
          throw new Error(`${providerName} 不支持音色克隆（cloneVoice 未实现）`);
        }
        return inst;
      });
      cloneClients.set(providerName, promise);
    }
    return cloneClients.get(providerName);
  }

  async function attemptClone() {
    lastSampleMs = Math.round(bufferedMs);
    const pcm = Buffer.from(buffer);
    const failures = [];
    try {
      for (const providerName of cloneProviderChain) {
        try {
          const client = await cloneClientFor(providerName);
          const cloned = await client.cloneVoice({ pcm, sampleRate: SAMPLE_RATE, name: 'session-speaker' });
          if (!cloned?.voiceId) throw new Error('cloneVoice 返回缺少 voiceId');
          state.mode = 'clone';
          state.voiceId = String(cloned.voiceId);
          state.reason = null;
          cloneProvider = String(cloned.provider || providerName);
          cloneFailures = failures;
          log(
            `[voice] 克隆音色就绪：${state.voiceId}（provider=${cloneProvider}，样本 ${(lastSampleMs / 1000).toFixed(1)}s）`
          );
          return;
        } catch (err) {
          failures.push({ provider: providerName, code: err?.code ?? null, message: clampReason(err?.message ?? err) });
          log(`[voice] ${providerName} 克隆失败，尝试下一个候选：${err?.message ?? err}`);
        }
      }
      cloneProvider = null;
      cloneFailures = failures;
      const summary = failures.length
        ? failures.map((f) => `${f.provider}: ${f.message}${f.code != null ? `（code=${f.code}）` : ''}`).join('；')
        : '没有可用的克隆 provider';
      degrade(`克隆失败，永久降级预设音色：${summary}`);
      log(`[voice] ${state.reason}`);
    } finally {
      // 失败后样本已无用，释放内存；成功也不需要再累积。
      buffer = Buffer.alloc(0);
      bufferedMs = 0;
    }
  }

  /**
   * 每句（或每段音频）调用一次；返回当前应使用的音色。
   * 永远不会因为克隆失败而 throw（会话主链路不能被音色拖垮）。
   */
  async function ensureVoice({ pcm, sampleRate, gender } = {}) {
    updates += 1;
    try {
      if (gender) applyGender(gender);

      if (!cloneFirst) return snapshotOf(state, { includeReason: false }); // 纯预设模式：不攒样本
      if (state.mode === 'clone') return snapshotOf(state);
      if (clonePromise) {
        await clonePromise; // 并发调用：等正在进行的克隆出结果，避免状态闪烁
        return snapshotOf(state);
      }
      if (attempted) return snapshotOf(state); // 失败过 -> 永久 preset，绝不重试
      if (cloneProviderChain.length === 0) {
        degrade('没有配置任何克隆 provider（tts.clone.chain / tts.clone.provider 为空）');
        return snapshotOf(state);
      }

      if (pcm) accumulate(pcm, sampleRate);
      if (bufferedMs < needMs) return snapshotOf(state, { includeReason: false }); // 还在攒样本

      attempted = true; // 先置位，避免并发调用重复克隆
      cloneAttempts += 1;
      clonePromise = attemptClone();
      await clonePromise;
      clonePromise = null;
      return snapshotOf(state);
    } catch (err) {
      // 理论上不应该到这里；兜底仍然只降级不抛。
      clonePromise = null;
      if (!state.reason) degrade(`音色管理异常：${err?.message ?? err}`);
      return snapshotOf(state);
    }
  }

  function stats() {
    return {
      name: 'voice-manager',
      provider: tts?.name ?? null,
      voiceMode,
      cloneFirst,
      mode: state.mode,
      voiceId: state.voiceId,
      reason: state.reason,
      degraded: Boolean(state.reason),
      sampleMs: Math.round(bufferedMs),
      lastSampleMs,
      minSampleSec,
      maxSampleSec,
      cloneAttempts,
      cloneAttempted: attempted,
      cloneProvider,
      cloneProviderChain,
      cloneFailures,
      updates,
      cloneInFlight: Boolean(clonePromise),
    };
  }

  return { state, ensureVoice, stats };
}
