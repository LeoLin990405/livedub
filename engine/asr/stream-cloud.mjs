/**
 * 流式云端 ASR（provider: stream-cloud）。
 *
 * 音频到达后立刻以二进制帧送出；服务端回 JSON {type:'partial'|'final', text}。
 * flush 发送 {type:'flush'}。连接失败或中途断开时，同一条识别器改走 asr.fallback
 * （云端档是 whisper-local），并重放已缓冲的 PCM，不把错误抛出会话。
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 1500;

function textFromMessage(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return '';
}

/**
 * @param {object} opts
 * @param {object} opts.config
 * @param {(msg: string) => void} [opts.log]
 * @param {(ev: object) => void} [opts.onEvent]
 * @param {(info: object) => void} [opts.onError]
 * @param {(args: {onEvent: Function}) => Promise<object>} [opts.fallbackFactory]
 * @param {typeof WebSocket} [opts.WebSocketImpl]
 */
export function createStreamCloudAsr({
  config = {},
  log = () => {},
  onEvent = () => {},
  onError,
  fallbackFactory,
  WebSocketImpl,
} = {}) {
  const url = String(config?.asr?.streamCloud?.url ?? '').trim();
  const connectTimeoutMs = Math.max(
    200,
    Number(config?.asr?.streamCloud?.connectTimeoutMs) || DEFAULT_CONNECT_TIMEOUT_MS,
  );
  const WS = WebSocketImpl ?? globalThis.WebSocket;
  /** @type {{pcm: Buffer, tMs: number}[]} */
  const buffered = [];
  let replayed = 0;
  let ws = null;
  let connected = false;
  let failed = false;
  let closed = false;
  let fallback = null;
  /** @type {Promise<object>|null} */
  let fallbackPromise = null;
  let replayChain = Promise.resolve();

  function report(message) {
    log(`[stream-cloud] ${message}`);
    try {
      onError?.({ message, recoverable: true });
    } catch {
      /* 观测回调不影响识别 */
    }
  }

  function replayToFallback() {
    replayChain = replayChain
      .then(async () => {
        if (typeof fallbackFactory !== 'function') {
          throw new Error('stream-cloud: 未配置 asr.fallback');
        }
        if (!fallbackPromise) fallbackPromise = Promise.resolve().then(() => fallbackFactory({ onEvent }));
        fallback = await fallbackPromise;
        const pending = buffered.slice(replayed);
        replayed = buffered.length;
        for (const item of pending) await fallback.push(item.pcm, item.tMs);
      })
      .catch((err) => {
        report(`本地识别失败：${err?.message ?? err}`);
      });
    return replayChain;
  }

  async function failOver(reason) {
    if (closed || failed) return;
    failed = true;
    connected = false;
    report(`${reason}，同一会话改走本地识别`);
    try {
      ws?.close?.();
    } catch {
      /* ignore */
    }
    ws = null;
    await replayToFallback();
  }

  function handleMessage(data) {
    const raw = textFromMessage(data);
    if (!raw) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const text = String(msg?.text ?? '').trim();
    if (!text || (msg.type !== 'partial' && msg.type !== 'final')) return;
    onEvent({
      type: msg.type,
      text,
      t0Ms: Number(msg.t0Ms) || 0,
      t1Ms: Number(msg.t1Ms) || 0,
    });
  }

  function sendPcm(pcm) {
    if (!ws || failed || !connected) return;
    const bytes = Buffer.isBuffer(pcm) ? new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength) : pcm;
    try {
      ws.send(bytes);
    } catch (err) {
      void failOver(err?.message ?? 'send failed');
    }
  }

  function connect() {
    if (!url || typeof WS !== 'function') return failOver(url ? '当前运行时没有 WebSocket' : 'empty url');
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      let socket;
      try {
        socket = new WS(url);
      } catch (err) {
        failOver(err?.message ?? 'connect failed').then(finish);
        return;
      }
      ws = socket;
      const timer = setTimeout(() => {
        if (!connected) failOver('connect timeout').then(finish);
      }, connectTimeoutMs);
      socket.addEventListener('open', () => {
        connected = true;
        finish();
      });
      socket.addEventListener('message', (ev) => handleMessage(ev?.data));
      socket.addEventListener('error', () => {
        if (!closed) failOver('socket error').then(finish);
      });
      socket.addEventListener('close', () => {
        if (closed) {
          finish();
          return;
        }
        failOver(connected ? 'socket closed' : 'closed before open').then(finish);
      });
    });
  }

  const connecting = connect();

  return {
    name: 'stream-cloud',

    warmup() {
      return connecting;
    },

    async push(pcm, tMs) {
      if (closed || !Buffer.isBuffer(pcm) || pcm.length === 0) return;
      buffered.push({ pcm, tMs: Number(tMs) || 0 });
      try {
        await connecting;
      } catch {
        /* failOver 已处理 */
      }
      if (closed) return;
      if (failed) {
        await replayToFallback();
        return;
      }
      sendPcm(pcm);
    },

    async flush() {
      if (closed) return;
      try {
        await connecting;
      } catch {
        /* failOver 已处理 */
      }
      if (failed) {
        await replayToFallback();
        try {
          await fallback?.flush?.();
        } catch (err) {
          report(`本地 flush 失败：${err?.message ?? err}`);
        }
        return;
      }
      try {
        ws?.send(JSON.stringify({ type: 'flush' }));
      } catch (err) {
        await failOver(err?.message ?? 'flush failed');
        try {
          await fallback?.flush?.();
        } catch {
          /* 已记录 */
        }
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      try {
        ws?.close?.();
      } catch {
        /* ignore */
      }
      try {
        await fallback?.close?.();
      } catch (err) {
        log(`[stream-cloud] 关闭本地识别失败：${err?.message ?? err}`);
      }
    },
  };
}
