import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  encodeAudioFrame,
  decodeAudioFrame,
  normalizeHello,
  sanitizeGlossary,
  PROTOCOL_VERSION,
} from '../engine/protocol.mjs';
import {
  wavFromPcm,
  pcmFromWav,
  resamplePcm,
  gainPcm,
  mixPcmInto,
  silencePcm,
  concatPcm,
  pcmDurationMs,
  float32ToS16le,
  s16leToFloat32,
  base64Pcm,
  pcmFromBase64,
  chunkPcm,
  fitPcmSamples,
  msToSamples,
} from '../engine/audio.mjs';
import { attachWebSocketServer } from '../engine/ws.mjs';

// ---------------------------------------------------------------- audio helpers

test('audio: wav roundtrip keeps pcm/sampleRate', () => {
  const pcm = Buffer.alloc(3200);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE((i * 7) % 1000, i);
  const wav = wavFromPcm(pcm, 16000, 1);
  const parsed = pcmFromWav(wav);
  assert.equal(parsed.sampleRate, 16000);
  assert.equal(parsed.channels, 1);
  assert.deepEqual(Buffer.from(parsed.pcm), pcm);
});

test('audio: duration / resample / gain / mix / silence', () => {
  const pcm = silencePcm(1000, 16000);
  assert.equal(pcmDurationMs(pcm, 16000), 1000);
  assert.equal(pcm.length, 32000);
  const up = resamplePcm(pcm, 16000, 24000);
  assert.equal(pcmDurationMs(up, 24000), 1000);
  const down = resamplePcm(up, 24000, 16000);
  assert.equal(pcmDurationMs(down, 16000), 1000);
  const loud = gainPcm(float32ToS16le(new Float32Array([0.5, -0.5, 2, -2])), 2);
  assert.equal(loud.readInt16LE(0), 32767);
  assert.equal(loud.readInt16LE(2), -32768);
  const target = silencePcm(100, 16000);
  const mixed = mixPcmInto(target, silencePcm(20, 16000), 1, msToSamples(10, 16000));
  assert.equal(mixed.length, target.length);
  const f32 = s16leToFloat32(float32ToS16le(new Float32Array([0.25, -0.25])));
  assert.ok(Math.abs(f32[0] - 0.25) < 0.01);
  assert.equal(pcmFromBase64(base64Pcm(pcm)).length, pcm.length);
  assert.equal(chunkPcm(pcm, 4096).length, Math.ceil(pcm.length / 4096));
  assert.equal(fitPcmSamples(pcm, 100).length, 200);
  assert.equal(pcmFromWav(wavFromPcm(concatPcm([silencePcm(10, 16000), silencePcm(20, 16000)]), 16000)).pcm.length, 960);
});

test('protocol: binary audio frame roundtrip + rejection', () => {
  const pcm = silencePcm(100, 16000);
  const frame = encodeAudioFrame(1234.5, pcm);
  const decoded = decodeAudioFrame(frame);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.tMs, 1234.5);
  assert.deepEqual(Buffer.from(decoded.pcm), pcm);
  assert.equal(decodeAudioFrame(Buffer.from([0x02, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2])).ok, false);
  assert.equal(decodeAudioFrame(Buffer.alloc(4)).ok, false);
  assert.throws(() => encodeAudioFrame(-1, pcm), /tMs/);
  assert.throws(() => encodeAudioFrame(NaN, pcm), /tMs/);
  assert.throws(() => encodeAudioFrame(0, Buffer.alloc(3)), /s16le/);
});

test('protocol: hello normalization + glossary sanitize', () => {
  const ok = normalizeHello({ type: 'hello', protocol: PROTOCOL_VERSION, session: { source: 'extension', langFrom: 'en', langTo: 'zh', title: 'MIT 6.006' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.options.source, 'extension');
  assert.equal(ok.options.langTo, 'zh');
  const bad = normalizeHello({ type: 'hello', protocol: 99 });
  assert.equal(bad.ok, false);
  const gloss = sanitizeGlossary([
    { src: 'gradient descent', dst: '梯度下降' },
    { src: 'gradient descent', dst: '重复' },
    { src: '  ', dst: 'x' },
    { src: 'a'.repeat(200), dst: 'x' },
  ]);
  assert.equal(gloss.length, 1);
  assert.equal(gloss[0].dst, '梯度下降');
});

// ------------------------------------------------------------------------- WS

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    const wsNotes = [];
    attachWebSocketServer(server, {
      path: '/ws',
      log: (...a) => wsNotes.push(a.join(' ')),
      onConnection: (ws) => handler(ws, wsNotes),
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, wsNotes }));
  });
}

function wsConnect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.binaryType = 'arraybuffer';
    const messages = [];
    ws.addEventListener('open', () => resolve({ ws, messages }));
    ws.addEventListener('error', (e) => reject(new Error(`ws error ${e.message ?? ''}`)));
    ws.addEventListener('message', (ev) => messages.push(ev.data));
  });
}

test('ws: text/binary echo, large payload, server close', async () => {
  const { server, port } = await startServer((ws) => {
    ws.on('message', (data, isBinary) => {
      if (isBinary) ws.sendBinary(Buffer.concat([Buffer.from('bin:'), Buffer.from(data)]));
      else ws.sendText(`echo:${data}`);
    });
    ws.on('close', () => {});
  });
  try {
    const { ws, messages } = await wsConnect(port);
    ws.send('hello');
    ws.send(new Uint8Array(200 * 1024).fill(7));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(messages[0], 'echo:hello');
    const bin = Buffer.from(messages[1]);
    assert.equal(bin.length, 200 * 1024 + 4);
    assert.equal(bin.subarray(0, 4).toString(), 'bin:');
    assert.equal(bin[5], 7);
    ws.close(1000, 'bye');
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    server.close();
  }
});

test('ws: rejects wrong path', async () => {
  const { server, port } = await startServer(() => {});
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/nope`);
    const failed = await new Promise((resolve) => {
      ws.addEventListener('error', () => resolve(true));
      ws.addEventListener('open', () => resolve(false));
      setTimeout(() => resolve(false), 800);
    });
    assert.equal(failed, true);
  } finally {
    server.close();
  }
});

// v0.6：画面 OCR 上下文清洗（只作翻译参考）
import { sanitizeVisualContext, VISUAL_CONTEXT_MAX_CHARS } from '../engine/protocol.mjs';

test('protocol: sanitizeVisualContext 清洗/截断/拒绝无效输入', () => {
  assert.equal(sanitizeVisualContext(''), '');
  assert.equal(sanitizeVisualContext(null), '');
  assert.equal(sanitizeVisualContext('   \n\t  '), '');
  assert.equal(sanitizeVisualContext('...!!!'), '');
  assert.equal(sanitizeVisualContext('Gradient\u0000 Descent'), 'Gradient Descent');
  assert.equal(sanitizeVisualContext('a\n\n\n b'), 'a\nb');
  assert.equal(sanitizeVisualContext('x'.repeat(VISUAL_CONTEXT_MAX_CHARS + 10)).length, VISUAL_CONTEXT_MAX_CHARS);
  assert.equal(sanitizeVisualContext('学习率 learning rate', 4), '学习率 ');
  assert.equal(sanitizeVisualContext('😀abc', 2), '😀a'); // 不切坏代理对
});
