/**
 * 能量 VAD 分段器（纯逻辑状态机：无 IO、无计时器、可单测）。
 *
 * 输入：任意长度的 16k mono s16le PCM（内部按 frameMs 对齐切帧）。
 * 输出（通过 onEvent 同步回调）：
 *   - { type: 'speechStart', t0Ms, t1Ms }                 一段语音开始（含 pre-roll）
 *   - { type: 'partial', t0Ms, t1Ms, pcm }                滚动 partial 窗口请求（每 partial.intervalMs 一次）
 *   - { type: 'final', t0Ms, t1Ms, pcm }                  一句最终音频（含 pre-roll / tailPad）
 *   - { type: 'speculate', id, t0Ms, t1Ms, pcm }         尾部静音刚开始（~120ms）时的推测收句请求（opt-in）：
 *                                                        提前把当前句送去识别，若静音确认则直接复用
 *   - { type: 'speculateCancel', id, reason }            推测作废（语音恢复 / 强制切分）：ASR 层丢弃结果
 *   注意：speculative 默认关闭；v0.2 实测大模型（推理 ~1.4s）下净收益不稳定，只有显式开启才生效。
 *
 * 时间轴：完全由「音频时长」推导（不是墙钟）。首个 push 的 tMs 作为锚点，
 * 之后每帧 t0Ms = 锚点 + 累计帧数 * frameMs；客户端 tMs 只用于检测跳变（seek/断流）。
 *
 * 语义约定：
 * - final 按时间顺序、两两不重叠（后一句 t0 至少 clamp 到前一句 t1）。
 * - final 的 pcm 与 [t0Ms, t1Ms] 严格对应（pcmDurationMs(pcm) === t1Ms - t0Ms，误差 0）。
 * - minSpeechMs 之内的短噪声不会起句；minSilenceMs 的静音收句；连续语音到 maxUtteranceMs 强制切分。
 * - preRollMs：起句时向前多带一段音频（不丢词头）；tailPadMs：收句向后多带一段音频（不丢词尾）。
 *
 * 作为 ASR 的内部组件使用；也可独立单测。见 docs/CONTRACTS.md §4。
 */
import {
  BYTES_PER_SAMPLE,
  INPUT_SAMPLE_RATE,
  msToSamples,
  pcmDurationMs,
  rms as pcmRms,
} from './audio.mjs';

export const SEGMENTER_DEFAULTS = Object.freeze({
  frameMs: 20,
  energyThreshold: 0.012,
  adaptive: true,
  adaptiveFactor: 1.8,
  adaptiveAlpha: 0.05,
  minSpeechMs: 240,
  minSilenceMs: 300,
  maxUtteranceMs: 7000,
  preRollMs: 200,
  tailPadMs: 150,
  /** speculative final：尾部静音开始就提前送 ASR 推理（默认关闭，opt-in；ASR 层按 config 显式传入） */
  speculative: false,
  /** 尾部静音达到该时长即触发推测（要明显小于 minSilenceMs 才有收益） */
  speculativeAfterMs: 120,
  /** 相邻 push 的 client tMs 与音频时间轴偏差超过该值 -> 视为 seek/断流，重置时间轴 */
  discontinuityMs: 500,
});

export const PARTIAL_DEFAULTS = Object.freeze({
  enabled: true,
  intervalMs: 900,
  windowMs: 9000,
});

function finiteNum(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 归一化 vad 配置（供 ASR 层与单测共用） */
export function normalizeVadConfig(config = {}) {
  const src = config && typeof config === 'object' ? config : {};
  return {
    frameMs: finiteNum(src.frameMs, SEGMENTER_DEFAULTS.frameMs, { min: 5, max: 100 }),
    energyThreshold: finiteNum(src.energyThreshold, SEGMENTER_DEFAULTS.energyThreshold, { min: 1e-5, max: 1 }),
    adaptive: src.adaptive !== false,
    adaptiveFactor: finiteNum(src.adaptiveFactor, SEGMENTER_DEFAULTS.adaptiveFactor, { min: 1, max: 10 }),
    adaptiveAlpha: finiteNum(src.adaptiveAlpha, SEGMENTER_DEFAULTS.adaptiveAlpha, { min: 0.001, max: 1 }),
    minSpeechMs: finiteNum(src.minSpeechMs, SEGMENTER_DEFAULTS.minSpeechMs, { min: 0, max: 60000 }),
    minSilenceMs: finiteNum(src.minSilenceMs, SEGMENTER_DEFAULTS.minSilenceMs, { min: 20, max: 60000 }),
    maxUtteranceMs: finiteNum(src.maxUtteranceMs, SEGMENTER_DEFAULTS.maxUtteranceMs, { min: 200, max: 120000 }),
    preRollMs: finiteNum(src.preRollMs, SEGMENTER_DEFAULTS.preRollMs, { min: 0, max: 2000 }),
    tailPadMs: finiteNum(src.tailPadMs, SEGMENTER_DEFAULTS.tailPadMs, { min: 0, max: 2000 }),
    speculative: src.speculative === true,
    speculativeAfterMs: finiteNum(src.speculativeAfterMs, SEGMENTER_DEFAULTS.speculativeAfterMs, { min: 20, max: 5000 }),
    discontinuityMs: finiteNum(src.discontinuityMs, SEGMENTER_DEFAULTS.discontinuityMs, { min: 100, max: 60000 }),
  };
}

/** 归一化 partial 配置 */
export function normalizePartialConfig(partial = {}) {
  const src = partial && typeof partial === 'object' ? partial : {};
  return {
    enabled: src.enabled !== false,
    intervalMs: finiteNum(src.intervalMs, PARTIAL_DEFAULTS.intervalMs, { min: 100, max: 60000 }),
    windowMs: finiteNum(src.windowMs, PARTIAL_DEFAULTS.windowMs, { min: 500, max: 120000 }),
  };
}

/**
 * @param {object} opts
 * @param {object} [opts.config]  asr.whisper.vad
 * @param {object} [opts.partial] asr.whisper.partial
 * @param {number} [opts.sampleRate=16000]
 * @param {(ev: object) => void} [opts.onEvent]
 * @param {(msg: string) => void} [opts.log]
 */
export function createSegmenter({
  config = {},
  partial = {},
  sampleRate = INPUT_SAMPLE_RATE,
  onEvent = () => {},
  log = () => {},
} = {}) {
  const cfg = normalizeVadConfig(config);
  const pcfg = normalizePartialConfig(partial);
  const rate = finiteNum(sampleRate, INPUT_SAMPLE_RATE, { min: 8000, max: 48000 });
  const frameMs = cfg.frameMs;
  const frameSamples = Math.max(1, Math.round((frameMs / 1000) * rate));
  const frameBytes = frameSamples * BYTES_PER_SAMPLE;
  const minSpeechFrames = Math.max(1, Math.ceil(cfg.minSpeechMs / frameMs));
  const minSilenceFrames = Math.max(1, Math.ceil(cfg.minSilenceMs / frameMs));
  const tailFrames = Math.max(0, Math.round(cfg.tailPadMs / frameMs));
  const preRollFrames = Math.max(0, Math.round(cfg.preRollMs / frameMs));
  // 推测触发点必须早于静音确认点，否则没有收益（minSilenceMs 太小则自动关闭推测）
  const speculateFrames = cfg.speculative
    ? Math.max(0, Math.min(Math.ceil(cfg.speculativeAfterMs / frameMs), minSilenceFrames - 1))
    : 0;
  // 历史环形缓冲要能覆盖 pre-roll + 检测窗口 + partial 窗口 + 最长句
  const keepMs =
    Math.max(
      pcfg.enabled ? pcfg.windowMs : 0,
      cfg.preRollMs + cfg.minSpeechMs + frameMs,
      cfg.maxUtteranceMs + cfg.tailPadMs,
    ) + 1000;
  const keepFrames = Math.max(4, Math.ceil(keepMs / frameMs));

  let closed = false;
  let buffer = Buffer.alloc(0);
  let anchorT0Ms = null; // 时间轴锚点（首次 push 的 tMs）
  let lastFrameEndMs = null; // 已处理的音频时间轴末端
  /** @type {Array<{t0Ms:number, endMs:number, pcm:Buffer}>} */
  let history = [];

  let speaking = false;
  /** @type {null | {t0Ms:number, frames:Array<{t0Ms:number, endMs:number, pcm:Buffer}>, lastVoicedEndMs:number, hasSpeech:boolean}} */
  let utt = null;
  let voicedRun = 0; // 连续超过阈值的帧数（idle 时用于起句）
  let silenceRun = 0; // 连续低于阈值的帧数（speaking 时用于收句）
  let lastVoicedEndMs = null;
  let prevFinalT1Ms = 0;
  let noiseFloor = 0;
  let lastPartialAtMs = 0;
  let liveThreshold = cfg.energyThreshold;
  let speculating = false; // 当前句是否处于「尾部静音、推测已发出」状态
  let speculationSeq = 0;
  /** @type {null | {id:number, t0Ms:number, t1Ms:number}} */
  let speculation = null;

  const stats = {
    frames: 0,
    speechStarts: 0,
    finals: 0,
    partials: 0,
    forceSplits: 0,
    discontinuityResets: 0,
    speculations: 0,
    speculationCancels: 0,
    bytesIn: 0,
  };

  function emit(ev) {
    if (closed || !ev) return;
    try {
      onEvent(ev);
    } catch (err) {
      log(`[segmenter] onEvent 抛错：${err?.message ?? err}`);
    }
  }

  function threshold() {
    return cfg.adaptive ? Math.max(cfg.energyThreshold, noiseFloor * cfg.adaptiveFactor) : cfg.energyThreshold;
  }

  function resetSpeaking() {
    speaking = false;
    utt = null;
    voicedRun = 0;
    silenceRun = 0;
    lastVoicedEndMs = null;
    speculating = false;
    speculation = null;
  }

  function trimHistory() {
    const minT0 = (lastFrameEndMs ?? 0) - keepMs;
    while (history.length > keepFrames || (history.length > 0 && history[0].endMs <= minT0)) history.shift();
  }

  /** 从 frames 里裁剪出 [fromMs, toMs) 的连续 PCM；t0Ms 精确等于 fromMs（首帧可被采样级裁剪） */
  function selectRange(frames, fromMs, toMs) {
    const picked = [];
    for (const f of frames) {
      if (f.endMs <= fromMs || f.t0Ms >= toMs) continue;
      let pcm = f.pcm;
      let t0 = f.t0Ms;
      if (t0 < fromMs) {
        const drop = Math.min(
          Math.round(((fromMs - t0) / 1000) * rate),
          Math.floor(pcm.length / BYTES_PER_SAMPLE),
        );
        pcm = pcm.subarray(drop * BYTES_PER_SAMPLE);
        t0 = fromMs;
      }
      const frameEndMs = t0 + (pcm.length / BYTES_PER_SAMPLE / rate) * 1000;
      if (frameEndMs > toMs) {
        const keep = Math.max(0, Math.round(((toMs - t0) / 1000) * rate));
        pcm = pcm.subarray(0, keep * BYTES_PER_SAMPLE);
      }
      if (pcm.length > 0) picked.push({ t0Ms: t0, pcm });
    }
    return picked;
  }

  function emitFinal(t0Ms, t1Ms, pcm, extra = {}) {
    if (pcm.length === 0) return false;
    // 用 PCM 实际时长回写 t1，保证 t0/t1 与音频严格一致
    const actualT1 = t0Ms + pcmDurationMs(pcm, rate);
    prevFinalT1Ms = Math.max(prevFinalT1Ms, actualT1);
    stats.finals += 1;
    emit({ type: 'final', t0Ms, t1Ms: actualT1, pcm, ...extra });
    return true;
  }

  /** 收句：把 utt 从 t0 裁到 lastVoicedEnd + tailPad（自然收句）或当前音频末端（flush） */
  function endUtterance(nowMs, { tail = true } = {}) {
    if (!speaking || !utt) return;
    const voicedEnd = Math.max(utt.lastVoicedEndMs || 0, utt.t0Ms);
    const tailMs = tail ? tailFrames * frameMs : 0;
    const t1 = Math.min(nowMs, voicedEnd + tailMs);
    if (utt.hasSpeech && t1 > utt.t0Ms) {
      const picked = selectRange(utt.frames, utt.t0Ms, t1);
      const pcm = picked.length ? Buffer.concat(picked.map((p) => p.pcm)) : Buffer.alloc(0);
      if (pcm.length > 0) {
        // 尾部静音期已发出推测 -> final 带上关联 id，ASR 层可直接复用那次推理
        const extra = speculating && speculation ? { speculated: true, speculationId: speculation.id } : {};
        emitFinal(utt.t0Ms, t1, pcm, extra);
      }
    }
    resetSpeaking();
  }

  /** 连续语音到 maxUtteranceMs：在 cutMs 硬切，立刻以 cutMs 起下一句（无 pre-roll、不重叠） */
  function forceSplit(cutMs) {
    if (!speaking || !utt) return;
    // 硬切分需要完整音频，作废尾部推测（极少数：静音期间句长达到 maxUtteranceMs）
    if (speculating) cancelSpeculation('force-split');
    if (utt.hasSpeech && cutMs > utt.t0Ms) {
      const picked = selectRange(utt.frames, utt.t0Ms, cutMs);
      const pcm = picked.length ? Buffer.concat(picked.map((p) => p.pcm)) : Buffer.alloc(0);
      if (pcm.length > 0) emitFinal(utt.t0Ms, cutMs, pcm, { split: true });
    }
    stats.forceSplits += 1;
    speaking = true;
    utt = { t0Ms: cutMs, frames: [], lastVoicedEndMs: cutMs, hasSpeech: false };
    voicedRun = 0;
    silenceRun = 0;
    lastPartialAtMs = cutMs;
  }

  function startUtterance(onsetMs) {
    const lowerBound = Math.max(0, onsetMs - cfg.preRollMs, prevFinalT1Ms);
    const firstIdx = history.findIndex((f) => f.endMs > lowerBound);
    if (firstIdx < 0) return;
    const frames = history.slice(firstIdx);
    const t0Ms = Math.max(lowerBound, frames[0].t0Ms);
    speaking = true;
    utt = {
      t0Ms,
      frames,
      lastVoicedEndMs: lastFrameEndMs ?? onsetMs,
      hasSpeech: true,
    };
    voicedRun = 0;
    silenceRun = 0;
    lastPartialAtMs = t0Ms;
    stats.speechStarts += 1;
    emit({ type: 'speechStart', t0Ms, t1Ms: lastFrameEndMs ?? onsetMs });
  }

  function emitPartial(nowMs) {
    if (!speaking || !utt || !pcfg.enabled) return;
    if (utt.frames.length === 0) return;
    const last = utt.frames[utt.frames.length - 1];
    const t1 = Math.min(nowMs, last.endMs);
    const fromMs = Math.max(utt.t0Ms, t1 - pcfg.windowMs);
    if (t1 <= fromMs) return;
    const picked = selectRange(utt.frames, fromMs, t1);
    if (picked.length === 0) return;
    const pcm = Buffer.concat(picked.map((p) => p.pcm));
    if (pcm.length === 0) return;
    const t0 = fromMs;
    lastPartialAtMs = t1;
    stats.partials += 1;
    emit({ type: 'partial', t0Ms: t0, t1Ms: t0 + pcmDurationMs(pcm, rate), pcm });
  }

  /** 尾部静音达到 speculativeAfterMs：把当前句（含已积累的少量尾静音）提前送去识别 */
  function emitSpeculate(nowMs) {
    if (!speaking || !utt || !utt.hasSpeech) return;
    const t0 = utt.t0Ms;
    const t1 = Math.min(nowMs, lastFrameEndMs ?? nowMs);
    if (t1 <= t0) return;
    const picked = selectRange(utt.frames, t0, t1);
    if (picked.length === 0) return;
    const pcm = Buffer.concat(picked.map((p) => p.pcm));
    if (pcm.length === 0) return;
    speculationSeq += 1;
    speculation = { id: speculationSeq, t0Ms: t0, t1Ms: t0 + pcmDurationMs(pcm, rate) };
    speculating = true;
    stats.speculations += 1;
    emit({ type: 'speculate', id: speculation.id, t0Ms: speculation.t0Ms, t1Ms: speculation.t1Ms, pcm });
  }

  /** 推测作废：语音恢复 / 强制切分（ASR 层丢弃在途结果，不产生任何事件） */
  function cancelSpeculation(reason) {
    if (!speculating || !speculation) return;
    const id = speculation.id;
    speculating = false;
    speculation = null;
    stats.speculationCancels += 1;
    emit({ type: 'speculateCancel', id, reason });
  }

  function updateNoiseFloor(energy) {
    const capped = Math.min(energy, cfg.energyThreshold);
    noiseFloor += cfg.adaptiveAlpha * (capped - noiseFloor);
    if (noiseFloor < 0) noiseFloor = 0;
    liveThreshold = threshold();
  }

  function processFrame(pcm, t0Ms) {
    const endMs = t0Ms + (pcm.length / BYTES_PER_SAMPLE / rate) * 1000;
    const frame = { t0Ms, endMs, pcm };
    history.push(frame);
    stats.frames += 1;
    lastFrameEndMs = endMs;

    const energy = pcmRms(pcm);
    liveThreshold = threshold();
    const voiced = energy >= liveThreshold;

    if (!speaking) {
      if (voiced) {
        voicedRun += 1;
        if (voicedRun >= minSpeechFrames) {
          const onsetMs = t0Ms - (voicedRun - 1) * frameMs;
          startUtterance(onsetMs);
        }
      } else {
        voicedRun = 0;
        if (cfg.adaptive) updateNoiseFloor(energy);
      }
      trimHistory();
      return;
    }

    // speaking：当前帧加入当前句（起句帧已由 startUtterance 从 history 带入）
    if (utt.frames[utt.frames.length - 1] !== frame) utt.frames.push(frame);

    if (voiced) {
      silenceRun = 0;
      utt.lastVoicedEndMs = endMs;
      utt.hasSpeech = true;
      // 语音恢复（用户只是句中停顿）-> 作废尾部静音期的推测，继续累积
      if (speculating) cancelSpeculation('speech-resumed');
    } else {
      silenceRun += 1;
      if (cfg.adaptive) updateNoiseFloor(energy);
      // 尾部静音刚开始 -> 提前送 whisper 推理，静音确认后直接复用
      if (speculateFrames > 0 && !speculating && silenceRun >= speculateFrames) emitSpeculate(endMs);
    }

    // 1) 静音够长 -> 自然收句
    if (silenceRun >= minSilenceFrames) {
      endUtterance(endMs, { tail: true });
      trimHistory();
      return;
    }
    // 2) 连续语音超长 -> 强制切分
    if (endMs - utt.t0Ms >= cfg.maxUtteranceMs) {
      forceSplit(endMs);
      trimHistory();
      return;
    }
    // 3) 滚动 partial
    if (pcfg.enabled && endMs - lastPartialAtMs >= pcfg.intervalMs) {
      emitPartial(endMs);
    }
    trimHistory();
  }

  function handleDiscontinuity(nextTMs) {
    // seek / 长断流：把已积累的语音先落成 final（不丢数据），再重置时间轴
    if (speaking && utt) {
      const now = lastFrameEndMs ?? nextTMs;
      endUtterance(now, { tail: true });
    }
    resetSpeaking();
    history = [];
    buffer = Buffer.alloc(0);
    anchorT0Ms = Math.max(0, nextTMs);
    lastFrameEndMs = anchorT0Ms;
    prevFinalT1Ms = 0;
    lastPartialAtMs = 0;
    stats.discontinuityResets += 1;
    log(`[segmenter] 音频时间轴跳变，重置到 ${anchorT0Ms}ms`);
  }

  return {
    /** 喂入 16k mono s16le PCM；tMs 为该段首采样在会话时间轴上的位置 */
    push(pcm, tMs) {
      if (closed) return;
      if (!Buffer.isBuffer(pcm) || pcm.length < BYTES_PER_SAMPLE) return;
      if (pcm.length % BYTES_PER_SAMPLE !== 0) pcm = pcm.subarray(0, pcm.length - 1);
      if (pcm.length === 0) return;
      stats.bytesIn += pcm.length;

      const clientTMs = Number.isFinite(tMs) ? Number(tMs) : lastFrameEndMs ?? anchorT0Ms ?? 0;
      if (anchorT0Ms == null) {
        anchorT0Ms = Math.max(0, clientTMs);
        lastFrameEndMs = anchorT0Ms;
      } else if (lastFrameEndMs != null) {
        const drift = clientTMs - lastFrameEndMs;
        if (Math.abs(drift) > cfg.discontinuityMs) handleDiscontinuity(clientTMs);
      }

      buffer = buffer.length === 0 ? pcm : Buffer.concat([buffer, pcm]);
      while (buffer.length >= frameBytes) {
        const frame = Buffer.from(buffer.subarray(0, frameBytes)); // 复制，避免长期持有大 buffer
        buffer = buffer.subarray(frameBytes);
        const t0 = lastFrameEndMs ?? anchorT0Ms;
        processFrame(frame, t0);
      }
    },

    /** 会话结束/暂停：把当前语音落成 final（不重置时间轴锚点；后续可继续 push） */
    flush() {
      if (closed) return;
      if (buffer.length >= BYTES_PER_SAMPLE) {
        const padded = Buffer.alloc(frameBytes);
        buffer.copy(padded, 0, 0, Math.min(buffer.length, frameBytes));
        buffer = Buffer.alloc(0);
        if (speaking) {
          const t0 = lastFrameEndMs ?? anchorT0Ms ?? 0;
          processFrame(padded, t0);
        }
      }
      if (speaking) {
        endUtterance(lastFrameEndMs ?? anchorT0Ms ?? 0, { tail: true });
      }
      resetSpeaking();
      trimHistory();
    },

    /** 丢弃所有状态（seek / 会话重置用） */
    reset({ tMs = null } = {}) {
      resetSpeaking();
      history = [];
      buffer = Buffer.alloc(0);
      prevFinalT1Ms = 0;
      lastPartialAtMs = 0;
      voicedRun = 0;
      silenceRun = 0;
      if (Number.isFinite(tMs)) {
        anchorT0Ms = Math.max(0, tMs);
        lastFrameEndMs = anchorT0Ms;
      } else {
        anchorT0Ms = null;
        lastFrameEndMs = null;
      }
    },

    close() {
      closed = true;
      speaking = false;
      utt = null;
      history = [];
      buffer = Buffer.alloc(0);
    },

    /** 诊断信息（单测/日志用） */
    state() {
      return {
        speaking,
        threshold: liveThreshold,
        noiseFloor,
        energyThreshold: cfg.energyThreshold,
        lastFrameEndMs,
        utteranceT0Ms: utt?.t0Ms ?? null,
        prevFinalT1Ms,
        bufferedBytes: buffer.length,
        frameMs,
        sampleRate: rate,
        speculative: {
          enabled: speculateFrames > 0,
          afterMs: cfg.speculativeAfterMs,
          frames: speculateFrames,
          speculating,
          speculationId: speculation?.id ?? null,
        },
        stats: { ...stats },
      };
    },

    stats() {
      return { ...stats };
    },

    config: { ...cfg, partial: { ...pcfg }, frameBytes, keepMs },
  };
}
