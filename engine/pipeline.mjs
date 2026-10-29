/**
 * Session 编排：把「音频 -> ASR -> 翻译 -> TTS 配音 -> 调度/字幕事件」串起来。
 *
 * 设计要点：
 * - 纯事件驱动，不依赖具体 provider；deps 可注入（tests/pipeline.test.mjs 用 engine/mock.mjs）。
 * - ASR final 的每句并行度=1 的顺序队列，保证字幕/配音顺序稳定（教学视频句子间有停顿，够用）。
 * - 所有下游失败都被隔离：翻译失败 -> 只显示原文；配音失败 -> 双语字幕照常；不得中断会话。
 * - 时间轴：客户端 tMs -> 会话时间轴（首个音频包为 0），所有下发的 t0Ms/t1Ms/startMs 都是会话时间轴。
 */
import {
  MSG,
  PROTOCOL_VERSION,
  AUDIO_INPUT_SAMPLE_RATE,
  AUDIO_FRAME_MS,
  DEFAULT_SESSION_OPTIONS,
  errorEvent,
  statusEvent,
  sanitizeGlossary,
} from './protocol.mjs';
import { base64Pcm, concatPcm, pcmDurationMs, msToSamples } from './audio.mjs';
import { createMetrics, now } from './metrics.mjs';
import { loadConfig, deepMerge } from './config.mjs';

/** 会话时间轴音频保留窗口（用于抽取讲师声音样本做克隆） */
class AudioTimeline {
  constructor({ sampleRate = AUDIO_INPUT_SAMPLE_RATE, maxMs = 120000 } = {}) {
    this.sampleRate = sampleRate;
    this.maxMs = maxMs;
    /** @type {{tMs:number, pcm:Buffer}[]} */
    this.chunks = [];
    this.endTMs = 0;
  }

  push(pcm, tMs) {
    if (!Buffer.isBuffer(pcm) || pcm.length === 0) return;
    this.chunks.push({ tMs, pcm });
    this.endTMs = Math.max(this.endTMs, tMs + pcmDurationMs(pcm, this.sampleRate));
    const cutoff = this.endTMs - this.maxMs;
    while (this.chunks.length > 1 && this.chunks[0].tMs + pcmDurationMs(this.chunks[0].pcm, this.sampleRate) < cutoff) {
      this.chunks.shift();
    }
  }

  /** 抽取 [t0Ms, t1Ms) 的 PCM，按块拼接；越界自动裁剪 */
  slice(t0Ms, t1Ms) {
    const t0 = Math.max(0, Math.min(t0Ms, t1Ms));
    const t1 = Math.max(t0, t1Ms);
    const parts = [];
    for (const chunk of this.chunks) {
      const cs = chunk.tMs;
      const ce = chunk.tMs + pcmDurationMs(chunk.pcm, this.sampleRate);
      const s = Math.max(t0, cs);
      const e = Math.min(t1, ce);
      if (e <= s) continue;
      const startSample = msToSamples(s - cs, this.sampleRate);
      const endSample = msToSamples(e - cs, this.sampleRate);
      parts.push(chunk.pcm.subarray(startSample * 2, endSample * 2));
    }
    return parts.length ? concatPcm(parts) : Buffer.alloc(0);
  }

  reset() {
    this.chunks = [];
    this.endTMs = 0;
  }
}

function sessionProviderInfo(config) {
  return {
    asr: config?.asr?.provider ?? 'unknown',
    translate: {
      provider: config?.translate?.provider ?? 'unknown',
      chain: Array.isArray(config?.translate?.chain) ? config.translate.chain : [],
    },
    tts: {
      provider: config?.tts?.provider ?? 'unknown',
      model: config?.tts?.model ?? '',
      voiceMode: config?.tts?.voiceMode ?? 'preset',
    },
    sampleRate: AUDIO_INPUT_SAMPLE_RATE,
  };
}

/** 兼容两代翻译层：有 createClauseExtractor 就用真实实现，否则退到内置的简化版。 */
let clauseExtractorModulePromise = null;
async function loadClauseExtractorFactory() {
  if (!clauseExtractorModulePromise) {
    clauseExtractorModulePromise = import('./translate/index.mjs')
      .then((m) => (typeof m.createClauseExtractor === 'function' ? m.createClauseExtractor : null))
      .catch(() => null);
  }
  return clauseExtractorModulePromise;
}

/** 简化版子句提取器（翻译层 helper 不可用时的兜底；不追求稳定性判定） */
function createNaiveClauseExtractor({ minClauseChars = 8, maxChunkChars = 80, stabilityMs = 250 } = {}) {
  let emittedLength = 0;
  let lastText = '';
  let lastChangeAt = 0;
  return {
    push(cumulativeText) {
      const text = String(cumulativeText ?? '');
      const nowMs = Date.now();
      if (text !== lastText) {
        lastText = text;
        lastChangeAt = nowMs;
      }
      if (text.length < emittedLength) emittedLength = 0;
      if (nowMs - lastChangeAt < stabilityMs) return [];
      const rest = text.slice(emittedLength);
      const match = rest.match(/^[\s\S]*?[。！？；;.!?…]/);
      if (!match) return [];
      const raw = match[0];
      const clause = raw.trim();
      if (clause.length < minClauseChars) return [];
      emittedLength += raw.length;
      return [clause];
    },
    flush(finalText) {
      const text = String(finalText ?? '');
      const rest = text.slice(Math.min(emittedLength, text.length)).trim();
      emittedLength = text.length;
      if (!rest) return [];
      const parts = rest.match(/[^。！？；;.!?…]+[。！？；;.!?…]?/g) ?? [rest];
      const out = [];
      for (const part of parts) {
        const clause = String(part).trim();
        if (!clause) continue;
        for (let i = 0; i < clause.length; i += maxChunkChars) out.push(clause.slice(i, i + maxChunkChars));
      }
      return out;
    },
    reset() {
      emittedLength = 0;
      lastText = '';
      lastChangeAt = 0;
    },
  };
}

let sessionSeq = 0;

export class Session {
  constructor({ id, options = {}, emit = () => {}, log = () => {}, deps = null } = {}) {
    this.id = id || `s_${Date.now().toString(36)}_${(++sessionSeq).toString(36)}`;
    this.options = { ...DEFAULT_SESSION_OPTIONS, ...options };
    this.emitToClient = emit;
    this.log = log;
    this.deps = deps;
    this.config = deps?.config ?? null;
    this.metrics = createMetrics();
    this.state = 'created';
    this._closed = false;
    this._abort = new AbortController();
    this._status = null;
    this._pendingSegments = 0;
    this._activeDubs = 0;
    this._dubTimer = null;
    this._processQueue = Promise.resolve();
    this._ttsQueue = Promise.resolve();
    this._partialCounter = 0;
    this._segmentCounter = 0;
    this._partialTimer = null;
    this._paused = false;
    this._audioTimeline = new AudioTimeline({ sampleRate: AUDIO_INPUT_SAMPLE_RATE });
    this._t0OffsetMs = null;
    this._firstAudioRawTMs = null;
    this._lastAudioTMs = null;
    this._lastAudioWallAt = null;
    this._context = [];
    this._glossary = [];
    this._voiceInfo = null;
    this._splitForTts = null;
    this._clauseExtractorFactory = null;
    this._ttsFallbacks = [];
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    if (!this.deps) {
      const config = loadConfig({ overrides: this.options.overrides ?? {} });
      const { createDeps } = await import('./registry.mjs');
      this.deps = await createDeps({ config, log: this.log });
    }
    const baseConfig = this.deps.config ?? this.config ?? loadConfig();
    this.config = deepMerge(baseConfig, this.options.overrides ?? {});
    this._glossary = sanitizeGlossary(this.options.glossary ?? this.config.glossary ?? []);
    if (!this._glossary.length) this._glossary = sanitizeGlossary(this.config.glossary ?? []);

    const log = this.log;
    this._send(statusEvent('initializing', '正在加载 ASR / 翻译 / 配音…'));

    // 各层初始化：TTS/翻译先建，ASR 最慢（可能拉起 whisper-server）
    this.tts = await this.deps.createTts({ config: this.config, log });
    // 预热 TTS（后台进行，失败不致命）：让首个配音请求少一次冷连接
    if (typeof this.tts?.warmup === 'function') {
      Promise.resolve()
        .then(() => this.tts.warmup())
        .catch((err) => this.log(`tts warmup failed: ${err.message}`));
    }
    this.translator = await this.deps.createTranslator({ config: this.config, log });
    this.scheduler = this.deps.createScheduler ? await this.deps.createScheduler({ config: this.config, log }) : null;
    this.voice = this.deps.createVoiceManager ? await this.deps.createVoiceManager({ config: this.config, tts: this.tts, log }) : null;
    if (typeof this.deps.splitForTtsFallback === 'function') this._splitForTts = this.deps.splitForTtsFallback;
    if (!this._splitForTts) {
      try {
        const mod = await import('./tts/index.mjs');
        if (typeof mod.splitForTts === 'function') this._splitForTts = mod.splitForTts;
      } catch {
        /* T3 尚未实现时退到 registry 兜底 */
      }
    }
    if (typeof this.deps.createClauseExtractor === 'function') {
      this._clauseExtractorFactory = this.deps.createClauseExtractor;
    } else {
      const factory = await loadClauseExtractorFactory();
      if (factory) this._clauseExtractorFactory = factory;
    }
    this.asr = await this.deps.createAsr({
      config: this.config,
      log,
      onEvent: (ev) => this._onAsrEvent(ev),
      onError: (info) => this._onAsrError(info),
    });

    // 初始音色（preset；克隆在拿到足够语音样本后再尝试）
    try {
      this._voiceInfo = this.voice ? await this.voice.ensureVoice({}) : { mode: 'preset', voiceId: this.config?.tts?.presetVoices?.default ?? '' };
    } catch (err) {
      this._voiceInfo = { mode: 'preset', voiceId: this.config?.tts?.presetVoices?.default ?? '', degraded: true, reason: err.message };
    }

    this.state = 'ready';
    this._send({
      type: MSG.READY,
      sessionId: this.id,
      protocol: PROTOCOL_VERSION,
      providers: sessionProviderInfo(this.config),
      voice: this._voiceInfo,
      limits: {
        audioFrameMs: AUDIO_FRAME_MS,
        sampleRate: AUDIO_INPUT_SAMPLE_RATE,
        langFrom: this.config?.session?.langFrom ?? 'en',
        langTo: this.config?.session?.langTo ?? 'zh',
      },
    });
    this._sendVoiceEvent(this._voiceInfo);
    this._refreshStatus(true);
    this.log(`session ${this.id} ready`);
    return this;
  }

  /** 客户端上报一段 16k mono s16le PCM；rawTMs 是客户端时间轴（视频 currentTime*1000） */
  onAudio(pcm, rawTMs) {
    if (this._closed || this.state !== 'ready') return;
    if (!Buffer.isBuffer(pcm) || pcm.length < 2 || pcm.length % 2 !== 0) return;
    if (!Number.isFinite(rawTMs) || rawTMs < 0) return;
    if (this._paused) return;
    if (this._t0OffsetMs == null) {
      this._firstAudioRawTMs = rawTMs;
      this._t0OffsetMs = this.options.tMsBase != null ? Number(this.options.tMsBase) : rawTMs;
    }
    const tMs = Math.max(0, Math.round(rawTMs - this._t0OffsetMs));
    const durationMs = pcmDurationMs(pcm, AUDIO_INPUT_SAMPLE_RATE);
    this._lastAudioTMs = Math.max(this._lastAudioTMs ?? 0, tMs + durationMs);
    this._lastAudioWallAt = now();
    this._audioTimeline.push(pcm, tMs);
    this._asrChain = (this._asrChain ?? Promise.resolve())
      .then(() => this.asr.push(pcm, tMs))
      .catch((err) => this.log(`asr push error: ${err.message}`));
  }

  /** 客户端 JSON 消息（hello 由 server 消费；这里处理 control/config/glossary/ping） */
  onJson(msg) {
    if (this._closed || !msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case MSG.CONTROL:
        return this._onControl(msg).catch((err) => this.log(`control error: ${err.message}`));
      case MSG.CONFIG:
        return this._onConfigPatch(msg.patch ?? {});
      case MSG.GLOSSARY:
        this._glossary = sanitizeGlossary(msg.terms ?? []);
        this._send(statusEvent(this._status ?? 'listening', `术语表已更新（${this._glossary.length} 条）`, this._currentSessionMs()));
        return;
      case MSG.PING:
        this._send({ type: MSG.PONG, t: msg.t ?? null, tsMs: this._currentSessionMs() });
        return;
      default:
        this.log(`ignored client message type=${msg.type}`);
    }
  }

  async _onControl(msg) {
    const action = msg?.action;
    if (action === 'pause') {
      this._paused = true;
      try {
        await this.asr?.flush?.();
      } catch (err) {
        this.log(`flush on pause failed: ${err.message}`);
      }
      this._refreshStatus(true);
      return;
    }
    if (action === 'resume') {
      this._paused = false;
      this._refreshStatus(true);
      return;
    }
    if (action === 'flush') {
      await this.asr?.flush?.();
      return;
    }
    if (action === 'seek') {
      this._audioTimeline.reset();
      try {
        await this.asr?.flush?.();
      } catch {
        /* ignore */
      }
      this._refreshStatus(true);
      return;
    }
    if (action === 'stop') {
      await this.close('client stop');
    }
  }

  _onConfigPatch(patch) {
    if (!patch || typeof patch !== 'object') return;
    this.config = deepMerge(this.config ?? {}, patch);
    if (typeof patch.dub?.enabled === 'boolean') {
      this.log(`dub enabled -> ${patch.dub.enabled}`);
    }
    this._send(statusEvent(this._status ?? 'listening', '配置已更新', this._currentSessionMs()));
  }

  async close(reason = 'closed') {
    if (this._closed) return;
    this._closed = true;
    this.state = 'closed';
    clearTimeout(this._dubTimer);
    clearTimeout(this._partialTimer);
    try {
      await this.asr?.flush?.();
    } catch (err) {
      this.log(`asr flush on close failed: ${err.message}`);
    }
    try {
      await this.asr?.close?.();
    } catch (err) {
      this.log(`asr close failed: ${err.message}`);
    }
    this._abort.abort();
    await Promise.resolve();
    this._send({ type: MSG.BYE, reason });
    this.log(`session ${this.id} closed: ${reason}`);
  }

  // ------------------------------------------------------------------ internals

  _send(event) {
    if (!event || typeof event !== 'object') return;
    try {
      this.emitToClient(event);
    } catch (err) {
      this.log(`emit failed: ${err.message}`);
    }
  }

  _sendVoiceEvent(info) {
    if (!info) return;
    this._send({
      type: MSG.VOICE,
      mode: info.mode ?? 'preset',
      voiceId: info.voiceId ?? '',
      ...(info.degraded ? { degraded: true } : {}),
      ...(info.reason ? { reason: String(info.reason).slice(0, 300) } : {}),
    });
  }

  _currentSessionMs() {
    return this._lastAudioTMs ?? 0;
  }

  _wallFor(tMs) {
    if (this._lastAudioWallAt == null || this._lastAudioTMs == null) return now();
    return this._lastAudioWallAt - ((this._lastAudioTMs ?? 0) - tMs);
  }

  _onAsrEvent(ev) {
    if (this._closed || !ev) return;
    if (ev.type === 'partial') {
      const text = String(ev.text ?? '').trim();
      if (!text) return;
      this._send({
        type: MSG.PARTIAL,
        id: ++this._partialCounter,
        t0Ms: Math.round(ev.t0Ms ?? 0),
        t1Ms: Math.round(ev.t1Ms ?? this._currentSessionMs()),
        text,
      });
      return;
    }
    if (ev.type === 'final') {
      const text = String(ev.text ?? '').trim();
      if (!text) return;
      const segment = {
        text,
        t0Ms: Math.max(0, Math.round(ev.t0Ms ?? 0)),
        t1Ms: Math.max(0, Math.round(ev.t1Ms ?? this._currentSessionMs())),
        lang: ev.lang ?? this.config?.session?.langFrom ?? 'en',
      };
      this._pendingSegments += 1;
      this._refreshStatus();
      this._processQueue = this._processQueue
        .then(() => this._processSegment(segment))
        .catch((err) => {
          this.log(`segment pipeline error: ${err.message}`);
          this._send(errorEvent('session', `处理句子失败：${err.message}`));
        })
        .finally(() => {
          this._pendingSegments = Math.max(0, this._pendingSegments - 1);
          this._refreshStatus();
        });
      return;
    }
  }

  async _processSegment(segment) {
    if (this._closed) return;
    const id = ++this._segmentCounter;
    const { text, t0Ms, t1Ms, lang } = segment;
    this.metrics.mark(id, 'segmentReceivedAt');
    this.metrics.mark(id, 'asrFinalAt');
    this._send({ type: MSG.SEGMENT, id, t0Ms, t1Ms, text, lang });
    this._refreshStatus(true);

    // 收集讲师声音样本 -> 克隆音色（失败自动降级，不阻塞）
    if (this.voice && this.config?.tts?.voiceMode !== 'preset') {
      const sample = this._audioTimeline.slice(t0Ms, t1Ms);
      if (sample.length > 0) {
        this.voice
          .ensureVoice({ pcm: sample, sampleRate: AUDIO_INPUT_SAMPLE_RATE })
          .then((info) => {
            if (!info) return;
            const changed =
              !this._voiceInfo ||
              info.mode !== this._voiceInfo.mode ||
              info.voiceId !== this._voiceInfo.voiceId ||
              Boolean(info.degraded) !== Boolean(this._voiceInfo.degraded);
            if (changed) {
              this._voiceInfo = info;
              this._sendVoiceEvent(info);
            }
          })
          .catch((err) => this.log(`voice ensure failed: ${err.message}`));
      }
    }

    const dubEnabled = this.config?.dub?.enabled !== false;
    // 默认开启「翻译流式 x TTS 重叠」：已稳定的子句先合成，缩短第一个配音可播时间
    const overlap = dubEnabled && this.config?.dub?.overlapStreaming !== false;
    const dubStream = dubEnabled ? this._createDubStreamer(id, segment) : null;
    const extractor = overlap ? this._createClauseExtractor() : null;
    let translateFailed = false;

    try {
      this._send(statusEvent('translating', '', t1Ms));
      let firstWall = null;
      const result = await this.translator.translate({
        text,
        context: this._context.slice(-(Number(this.config?.translate?.contextSegments) || 3)),
        glossary: this._glossary,
        signal: this._abort.signal,
        onPartial: (partial) => {
          const p = String(partial ?? '');
          if (!p) return;
          if (firstWall == null) {
            firstWall = now();
            this.metrics.mark(id, 'mtFirstAt', firstWall);
          }
          this._send({ type: MSG.TRANSLATION, id, text: p, final: false });
          if (overlap && dubStream && extractor) {
            let clauses = [];
            try {
              clauses = extractor.push(p) ?? [];
            } catch (err) {
              this.log(`clause extractor failed: ${err.message}`);
            }
            for (const clause of clauses) dubStream.enqueue(clause);
          }
        },
      });
      this.metrics.mark(id, 'mtDoneAt');
      const translated = String(result?.text ?? '').trim();
      if (!translated) throw new Error('翻译结果为空');
      this._send({ type: MSG.TRANSLATION, id, text: translated, final: true });
      this._context.push({ src: text, dst: translated });
      if (this._context.length > 8) this._context.shift();

      if (dubStream) {
        let rest = [];
        if (overlap && extractor) {
          try {
            rest = extractor.flush(translated) ?? [];
          } catch (err) {
            this.log(`clause extractor flush failed: ${err.message}`);
            rest = this._splitClauses(translated);
          }
        } else {
          rest = this._splitClauses(translated);
        }
        for (const clause of rest) dubStream.enqueue(clause);
      }
    } catch (err) {
      translateFailed = true;
      this.log(`translate failed: ${err.message}`);
      this._send(errorEvent('translate', `翻译失败：${err.message}`, { segmentId: id, tsMs: t1Ms }));
    }

    if (dubStream) {
      try {
        await dubStream.finish();
      } catch (err) {
        this.log(`dub stream failed: ${err.message}`);
      }
    }
    this._sendMetrics(id, { t0Ms, t1Ms, ...(translateFailed ? { failed: 'translate' } : {}) });
  }

  _splitClauses(text) {
    const opts = this.config?.tts?.chunk ?? {};
    let clauses = [];
    try {
      clauses = this._splitForTts ? this._splitForTts(text, opts) : [];
    } catch (err) {
      this.log(`splitForTts failed: ${err.message}`);
    }
    if (!Array.isArray(clauses) || clauses.length === 0) {
      clauses = String(text).match(/[^。！？；;.!?]+[。！？；;.!?]?/g)?.map((s) => s.trim()).filter(Boolean) ?? [String(text)];
    }
    return clauses;
  }

  _createClauseExtractor() {
    const opts = {
      minClauseChars: this.config?.tts?.chunk?.minClauseChars ?? 8,
      maxChunkChars: this.config?.tts?.chunk?.maxChunkChars ?? 80,
      stabilityMs: this.config?.translate?.clauseStabilityMs ?? 250,
    };
    if (typeof this._clauseExtractorFactory === 'function') {
      try {
        return this._clauseExtractorFactory(opts);
      } catch (err) {
        this.log(`createClauseExtractor failed: ${err.message}`);
      }
    }
    return createNaiveClauseExtractor(opts);
  }

  _onAsrError(info) {
    const message = typeof info === 'string' ? info : info?.message ?? info?.error ?? '未知识别错误';
    this.log(`asr error: ${message}`);
    this._send(errorEvent('asr', `识别失败：${String(message).slice(0, 300)}`, { recoverable: true }));
  }

  /** 一个句子的配音流：可被翻译的 partial 提前 enqueue 子句，最后 finish 收尾（顺序/时间轴由内部状态维护） */
  _createDubStreamer(id, segment) {
    const state = {
      seq: 0,
      scheduledEndMs: 0,
      firstChunk: true,
      voiceId: this._voiceInfo?.voiceId || this.config?.tts?.presetVoices?.default || '',
      speed: Number(this.config?.tts?.speed) || 1,
      sampleRate: Number(this.config?.tts?.sampleRate) || 24000,
    };
    let chain = Promise.resolve();
    let finished = false;
    return {
      enqueue: (clause) => {
        const text = String(clause ?? '').trim();
        if (!text || finished || this._closed) return;
        chain = chain
          .then(() => this._synthesizeClause(id, text, segment, state))
          .catch((err) => {
            if (this._closed || err?.name === 'AbortError') return;
            this.log(`tts clause chain error id=${id}: ${err.message}`);
            this._send(errorEvent('tts', `配音失败：${err.message}`, { segmentId: id, recoverable: true }));
          });
      },
      finish: async () => {
        if (finished) return;
        finished = true;
        await chain;
        if (state.seq > 0) {
          this.metrics.mark(id, 'ttsDoneAt');
          // 结束标记：空音频 + final=true（客户端收到空 pcm 忽略播放，仅用于收尾）
          this._send({
            type: MSG.DUB,
            id,
            seq: state.seq,
            startMs: state.scheduledEndMs,
            sampleRate: state.sampleRate,
            format: 's16le',
            pcm: '',
            durationMs: 0,
            voiceId: state.voiceId,
            final: true,
          });
        }
      },
    };
  }

  async _synthesizeClause(id, clause, segment, state) {
    if (this._closed) return;
    let emitted = false;
    const emitChunk = (pcm, sampleRate) => {
      const buf = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm ?? []);
      if (buf.length === 0) return;
      const rate = Number(sampleRate) || state.sampleRate;
      const durationMs = pcmDurationMs(buf, rate);
      const readyAtMs = this._currentSessionMs();
      let plan = { action: 'play', startMs: readyAtMs, rate: 1 };
      try {
        if (this.scheduler) {
          plan = this.scheduler.plan({
            readyAtMs,
            durationMs,
            playheadMs: readyAtMs,
            lagMs: Math.max(0, readyAtMs - segment.t1Ms),
          });
        }
      } catch (err) {
        this.log(`scheduler plan failed: ${err.message}`);
      }
      if (plan.action === 'skip') {
        this.log(`drop stale dub chunk id=${id} (lag=${Math.round(readyAtMs - segment.t1Ms)}ms)`);
        return;
      }
      const startMs = Math.max(Math.round(plan.startMs ?? readyAtMs), state.scheduledEndMs);
      state.scheduledEndMs = startMs + durationMs;
      if (state.firstChunk) {
        state.firstChunk = false;
        this.metrics.mark(id, 'ttsFirstAt');
        this.metrics.mark(id, 'dubFirstAt');
      }
      this._send({
        type: MSG.DUB,
        id,
        seq: state.seq++,
        startMs,
        sampleRate: rate,
        format: 's16le',
        pcm: base64Pcm(buf),
        durationMs,
        voiceId: state.voiceId,
        final: false,
      });
      emitted = true;
      this._markSpeaking(durationMs);
    };

    try {
      if (typeof this.tts.synthesizeStream === 'function') {
        for await (const chunk of this.tts.synthesizeStream({ text: clause, voiceId: state.voiceId, speed: state.speed, signal: this._abort.signal })) {
          if (this._closed) break;
          emitChunk(chunk?.pcm, chunk?.sampleRate);
        }
      } else {
        const res = await this.tts.synthesize({ text: clause, voiceId: state.voiceId, speed: state.speed, signal: this._abort.signal });
        emitChunk(res?.pcm, res?.sampleRate);
      }
      if (!emitted) this.log(`tts returned no audio for clause: ${clause.slice(0, 20)}`);
    } catch (err) {
      if (this._closed || err?.name === 'AbortError') return;
      this.log(`tts clause failed: ${err.message}`);
      this._send(errorEvent('tts', `配音失败：${err.message}`, { segmentId: id, recoverable: true }));
    }
  }

  _markSpeaking(durationMs) {
    this._activeDubs = 1;
    this._refreshStatus(true);
    clearTimeout(this._dubTimer);
    this._dubTimer = setTimeout(() => {
      this._activeDubs = 0;
      this._refreshStatus(true);
    }, Math.max(300, durationMs + 250));
    this._dubTimer.unref?.();
  }

  _sendMetrics(id, { t0Ms, t1Ms, failed } = {}) {
    const summary = this.metrics.summary(id, {
      t0Ms,
      t1Ms,
      wallFor: (t) => this._wallFor(t),
      extra: {
        id,
        ...(failed ? { failed } : {}),
        ...(this._voiceInfo?.mode ? { voiceMode: this._voiceInfo.mode } : {}),
      },
    });
    this._send({ type: MSG.METRICS, ...summary });
  }

  _refreshStatus(force = false) {
    if (this._closed) return;
    let state;
    if (this._paused) state = 'paused';
    else if (this._activeDubs > 0) state = 'speaking';
    else if (this._pendingSegments > 0) state = 'translating';
    else state = 'listening';
    if (!force && this._status === state) return;
    this._status = state;
    this._send(statusEvent(state, '', this._currentSessionMs()));
  }

  stats() {
    return {
      id: this.id,
      state: this.state,
      status: this._status,
      segments: this._segmentCounter,
      partials: this._partialCounter,
      pendingSegments: this._pendingSegments,
      glossaryTerms: this._glossary.length,
      voice: this._voiceInfo,
      lastAudioTMs: this._lastAudioTMs,
    };
  }
}

export async function createSession(opts) {
  const session = new Session(opts);
  await session.start();
  return session;
}
