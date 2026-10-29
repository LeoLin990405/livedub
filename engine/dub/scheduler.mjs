/**
 * 配音调度器（纯策略）。
 *
 * 职责：给定「译文音频就绪时刻 / 音频时长 / 当前播放头」，决定这条配音
 *   - 立即排期播放（play）；
 *   - 以加速倍率追赶（play + rate>1）；
 *   - 直接丢弃（skip，reason='stale'，因为已经落后到追不回来）。
 *
 * 时间轴：全部为「会话时间轴毫秒」（客户端第一段音频为 0），见 docs/CONTRACTS.md §3。
 *
 * 约束（契约 §4）：
 *   - startMs 单调不回退；
 *   - 相邻两次 play 的起点间隔至少 dub.minGapMs；
 *   - 落后 > dub.maxLagMs 时可加速（rate <= dub.maxAccelerate）或跳过。
 *
 * 策略是纯函数式的（只维护游标计数），方便表驱动单测；不依赖网络与定时器。
 */

const DEFAULTS = Object.freeze({
  maxLagMs: 4000,
  maxAccelerate: 1.25,
  minGapMs: 60,
  startBufferMs: 120,
  catchUp: 'accelerate', // accelerate | skip | none
});

const CATCH_UP_MODES = new Set(['accelerate', 'skip', 'none']);

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 非负数字；非法时回退默认值（配置错误不应让会话崩溃） */
function nonNegative(value, fallback) {
  return Math.max(0, finiteOr(value, fallback));
}

function roundMs(ms) {
  return Math.max(0, Math.round(ms));
}

/** 把倍率规整到 3 位小数，避免浮点噪音进入测试与事件 */
function roundRate(rate) {
  return Math.round(rate * 1000) / 1000;
}

function assertInput({ readyAtMs, durationMs, playheadMs, lagMs }) {
  if (!Number.isFinite(readyAtMs) || readyAtMs < 0) {
    throw new RangeError('scheduler.plan: readyAtMs 必须是 >= 0 的有限数字（会话时间轴毫秒）');
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError('scheduler.plan: durationMs 必须是 > 0 的有限数字（音频时长毫秒）');
  }
  if (playheadMs != null && !Number.isFinite(Number(playheadMs))) {
    throw new RangeError('scheduler.plan: playheadMs 必须是有限数字或省略');
  }
  if (lagMs != null && !Number.isFinite(Number(lagMs))) {
    throw new RangeError('scheduler.plan: lagMs 必须是有限数字或省略');
  }
}

export function createScheduler({ config = {}, log = () => {} } = {}) {
  const dub = config?.dub ?? {};
  const maxLagMs = nonNegative(dub.maxLagMs, DEFAULTS.maxLagMs);
  const maxAccelerate = Math.max(1, finiteOr(dub.maxAccelerate, DEFAULTS.maxAccelerate));
  const minGapMs = nonNegative(dub.minGapMs, DEFAULTS.minGapMs);
  const startBufferMs = nonNegative(dub.startBufferMs, DEFAULTS.startBufferMs);
  const catchUp = CATCH_UP_MODES.has(dub.catchUp) ? dub.catchUp : DEFAULTS.catchUp;

  // 调度游标（只在 play 时推进；skip 表示这条音频被丢弃，不能让游标空转）
  let lastStartMs = 0;
  let lastEndMs = 0;
  let hasPlanned = false;

  const counters = { plans: 0, plays: 0, skips: 0, accelerated: 0, staleSkips: 0, maxLagSeenMs: 0 };

  /**
   * 为一条译文音频排期。
   * @param {object} input
   * @param {number} input.readyAtMs 音频就绪时刻（会话时间轴毫秒）
   * @param {number} input.durationMs 音频时长（毫秒，原始时长，不含加速）
   * @param {number} [input.playheadMs] 当前播放头（会话时间轴毫秒）
   * @param {number} [input.lagMs] 显式落后量；优先于 playheadMs 推算
   * @returns {{action:'play'|'skip', startMs:number, rate:number, reason?:string}}
   */
  function plan({ readyAtMs, durationMs, playheadMs, lagMs } = {}) {
    assertInput({ readyAtMs, durationMs, playheadMs, lagMs });
    counters.plans += 1;

    // ---- 1. 落后量：显式 lagMs > playheadMs 推算 > 0 ----
    let lag = 0;
    if (lagMs != null) lag = Math.max(0, Number(lagMs));
    else if (playheadMs != null) lag = Math.max(0, Number(playheadMs) - readyAtMs);
    counters.maxLagSeenMs = Math.max(counters.maxLagSeenMs, lag);

    // ---- 2. 候选起点 ----
    // 底线是「音频就绪时刻」；已知播放头时对齐到 播放头 + startBufferMs（给客户端留一点起播缓冲）。
    const alignedToPlayhead = playheadMs != null ? Number(playheadMs) + startBufferMs : readyAtMs;
    const baseStartMs = Math.max(readyAtMs, alignedToPlayhead);
    // 串行排队：不早于上一条音频播完 + minGapMs，同时保证起点单调不回退。
    let startMs = baseStartMs;
    if (hasPlanned) {
      startMs = Math.max(startMs, lastEndMs + minGapMs, lastStartMs + minGapMs);
    }
    startMs = roundMs(startMs);

    // ---- 3. 落后策略 ----
    // 有效落后 = 音频本身迟到的时间 + 排队/起播缓冲额外推迟的时间。
    // 注意：真正的「迟到」不只是 lag，还有被前面音频挤到后面的排队时间；
    // pipeline 以 playheadMs=readyAtMs + 显式 lagMs 调用时，排队时间也必须计入，
    // 否则长队列会让配音无限后移却永远不 skip。
    const noQueueStartMs = Math.max(readyAtMs, playheadMs != null ? Number(playheadMs) : readyAtMs);
    // startBufferMs 是主动留的起播缓冲，不算「落后」；超出它的排队时间才算额外延迟。
    const extraDelayMs = Math.max(0, startMs - (noQueueStartMs + startBufferMs));
    const effectiveLagMs = lag + extraDelayMs;

    let action = 'play';
    let rate = 1;
    let reason;

    if (effectiveLagMs > maxLagMs) {
      if (catchUp === 'skip') {
        action = 'skip';
        reason = 'stale';
      } else if (catchUp === 'accelerate') {
        // 轻度落后：按落后比例线性加一点点速度，上限 maxAccelerate。
        rate = Math.min(maxAccelerate, 1 + (effectiveLagMs - maxLagMs) / Math.max(1, maxLagMs));
        rate = roundRate(Math.max(1, rate));
        // 严重落后：即使按上限速度播完，播完时仍落后 maxLagMs 以上 → 丢掉，别让配音永远追着画面跑。
        const residualLagMs = effectiveLagMs + durationMs * (1 / rate - 1);
        if (residualLagMs > maxLagMs) {
          action = 'skip';
          reason = 'stale';
        } else {
          reason = 'catch-up';
        }
      } else {
        // catchUp === 'none'：接受落后，正常速度播放。
        reason = 'lag-accepted';
      }
    }

    if (action === 'play') {
      counters.plays += 1;
      if (rate > 1) counters.accelerated += 1;
      lastStartMs = startMs;
      lastEndMs = startMs + durationMs / rate;
      if (hasPlanned && lastEndMs < startMs) lastEndMs = startMs; // 防御：duration>0 时不会发生
      hasPlanned = true;
    } else {
      counters.skips += 1;
      if (reason === 'stale') counters.staleSkips += 1;
      rate = 1;
    }

    const result = { action, startMs, rate };
    if (reason) result.reason = reason;
    if (action === 'play' && rate > 1) {
      log(`[dub] catch-up: lag=${Math.round(effectiveLagMs)}ms rate=${rate} start=${startMs}ms`);
    } else if (action === 'skip') {
      log(`[dub] skip stale audio: lag=${Math.round(effectiveLagMs)}ms start=${startMs}ms`);
    }
    return result;
  }

  function stats() {
    return {
      name: 'dub-scheduler',
      ...counters,
      catchUp,
      maxLagMs,
      maxAccelerate,
      minGapMs,
      startBufferMs,
      lastStartMs,
      lastEndMs,
    };
  }

  return { name: 'dub-scheduler', plan, stats };
}
