/**
 * 极简 WebSocket 服务端（RFC 6455 子集），零依赖。
 * 只实现 livedub 需要的部分：文本/二进制消息、ping/pong、close、消息分片接收。
 *
 * 用法：
 *   const { close } = attachWebSocketServer(httpServer, { path: '/ws', onConnection(ws, req) { ... } });
 *
 * 客户端侧可以直接用 Node 22+ 内置的 WebSocket（undici）做测试。
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const CLOSE_CODES = new Set([1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014]);

export class WebSocketConnection extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket
   * @param {{maxPayload?:number, log?:(...a:any[])=>void, req?:import('node:http').IncomingMessage}} opts
   */
  constructor(socket, { maxPayload = 4 * 1024 * 1024, log = () => {}, req } = {}) {
    super();
    this.socket = socket;
    this.req = req;
    this.maxPayload = maxPayload;
    this.log = log;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.closed = false;
    this.readyState = 'open';
    this.remoteAddress = socket.remoteAddress;
    this._closeCode = null;
    this._closeReason = '';
    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => this._feed(chunk));
    socket.on('error', (err) => {
      this.log('ws socket error', err?.message);
      this._emitError(err);
      this._hardClose(1006, 'socket error');
    });
    socket.on('close', () => this._hardClose(this._closeCode ?? 1006, this._closeReason || 'socket closed'));
    socket.on('end', () => this._hardClose(this._closeCode ?? 1006, this._closeReason || 'socket ended'));
  }

  /** 供 HTTP upgrade 后 head 数据复用 */
  feed(chunk) {
    this._feed(chunk);
  }

  _feed(chunk) {
    if (this.closed) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this._parseFrame();
      if (!frame) return;
      try {
        this._handleFrame(frame);
      } catch (err) {
        this.log('ws frame error', err?.message);
        this.close(1002, 'protocol error');
        return;
      }
      if (this.closed) return;
    }
  }

  /** 从 buffer 解出一帧（HTTP head 已剥离）；数据不足返回 null */
  _parseFrame() {
    const b = this.buffer;
    if (b.length < 2) return null;
    const b0 = b[0];
    const b1 = b[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(this.maxPayload)) throw new Error('payload too large');
      len = Number(big);
      off = 10;
    }
    if (len > this.maxPayload) throw new Error('payload too large');
    const maskLen = masked ? 4 : 0;
    if (b.length < off + maskLen + len) return null;
    let payload;
    if (masked) {
      const mask = b.subarray(off, off + 4);
      payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = b[off + maskLen + i] ^ mask[i & 3];
    } else {
      payload = b.subarray(off + maskLen, off + maskLen + len);
    }
    this.buffer = b.subarray(off + maskLen + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    if (opcode === OP_CLOSE) {
      let code = 1000;
      let reason = '';
      if (payload.length >= 2) {
        const c = payload.readUInt16BE(0);
        code = CLOSE_CODES.has(c) ? c : 1000;
        reason = payload.subarray(2).toString('utf8').slice(0, 123);
      }
      this._closeCode = code;
      this._closeReason = reason;
      this._sendFrame(OP_CLOSE, payload.subarray(0, Math.min(payload.length, 125)));
      this._hardClose(code, reason);
      return;
    }
    if (opcode === OP_PING) {
      this._sendFrame(OP_PONG, payload);
      return;
    }
    if (opcode === OP_PONG) {
      this.emit('pong', payload);
      return;
    }
    if (opcode === OP_CONT) {
      if (this.fragmentOpcode == null) throw new Error('unexpected continuation frame');
      this.fragments.push(payload);
    } else if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (this.fragmentOpcode != null) throw new Error('new message before fragmented one finished');
      this.fragmentOpcode = opcode;
      this.fragments.push(payload);
    } else {
      throw new Error(`unsupported opcode ${opcode}`);
    }
    if (!fin) return;
    const data = Buffer.concat(this.fragments);
    const op = this.fragmentOpcode;
    this.fragments = [];
    this.fragmentOpcode = null;
    if (op === OP_TEXT) this.emit('message', data.toString('utf8'), false);
    else this.emit('message', data, true);
  }

  _sendFrame(opcode, payload) {
    if (this.socket.destroyed || this.closed) return false;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
      return true;
    } catch (err) {
      this.log('ws write error', err?.message);
      return false;
    }
  }

  sendText(str) {
    return this._sendFrame(OP_TEXT, Buffer.from(String(str), 'utf8'));
  }

  sendBinary(buf) {
    return this._sendFrame(OP_BINARY, Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  }

  ping() {
    return this._sendFrame(OP_PING, Buffer.alloc(0));
  }

  /** 主动关闭：发 close 帧，短暂 grace 后销毁 socket */
  close(code = 1000, reason = '') {
    if (this.closed) return;
    const safeCode = CLOSE_CODES.has(code) ? code : 1000;
    const reasonBuf = Buffer.from(String(reason).slice(0, 123), 'utf8');
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(safeCode, 0);
    reasonBuf.copy(payload, 2);
    this._sendFrame(OP_CLOSE, payload);
    this._closeCode = safeCode;
    this._closeReason = String(reason);
    this._hardClose(safeCode, String(reason), { sendClose: false });
  }

  /** 直接销毁 socket（不发 close 帧） */
  terminate() {
    this._hardClose(this._closeCode ?? 1006, this._closeReason || 'terminated', { destroy: true });
  }

  _hardClose(code, reason, { destroy = false, sendClose = false } = {}) {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 'closed';
    this._closeCode = code;
    this._closeReason = reason;
    if (destroy) {
      try {
        this.socket.destroy();
      } catch {
        /* ignore */
      }
    } else {
      try {
        this.socket.end();
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          this.socket.destroy();
        } catch {
          /* ignore */
        }
      }, 250).unref?.();
    }
    this.emit('close', code, reason);
  }

  _emitError(err) {
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }
}

/**
 * 把 WS 服务挂到 http.Server 上。
 * @param {import('node:http').Server} httpServer
 * @param {{path?:string, onConnection?:(ws:WebSocketConnection, req:import('node:http').IncomingMessage)=>void, maxPayload?:number, log?:Function, checkOrigin?:(req:import('node:http').IncomingMessage)=>boolean}} opts
 */
export function attachWebSocketServer(httpServer, { path = '/ws', onConnection, maxPayload = 4 * 1024 * 1024, log = () => {}, checkOrigin } = {}) {
  const onUpgrade = (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
    const version = String(req.headers['sec-websocket-version'] ?? '');
    if (upgrade !== 'websocket' || !key || version !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    if (typeof checkOrigin === 'function' && !checkOrigin(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'),
    );
    const ws = new WebSocketConnection(socket, { maxPayload, log, req });
    if (head && head.length > 0) ws.feed(head);
    try {
      onConnection?.(ws, req);
    } catch (err) {
      log('ws onConnection error', err?.message);
      ws.close(1011, 'internal error');
    }
  };
  httpServer.on('upgrade', onUpgrade);
  return {
    close() {
      httpServer.off('upgrade', onUpgrade);
    },
  };
}
