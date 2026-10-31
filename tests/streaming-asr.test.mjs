/**
 * stream-cloud：对本地假流式端点发真实 PCM，并在断线后降级到本地 mock 识别器。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createAsr } from '../engine/asr/index.mjs';
import { attachWebSocketServer } from '../engine/ws.mjs';
import { silencePcm } from './helpers.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('cloud profile names exactly one streaming recognizer', () => {
  const cloud = JSON.parse(readFileSync(path.join(ROOT, 'config/livedub.cloud.json'), 'utf8'));
  assert.equal(cloud.asr.provider, 'stream-cloud');
  assert.equal(cloud.asr.fallback, 'whisper-local');
  assert.equal(cloud.translate.draftReuse, true);
});

test('stream-cloud emits a partial before the utterance is flushed', async () => {
  const server = http.createServer();
  const sockets = [];
  attachWebSocketServer(server, {
    path: '/asr',
    onConnection(ws) {
      sockets.push(ws);
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          ws.sendText(JSON.stringify({ type: 'partial', text: 'hello partial', t0Ms: 0, t1Ms: 100 }));
          return;
        }
        const msg = JSON.parse(String(data));
        if (msg.type === 'flush') {
          ws.sendText(JSON.stringify({ type: 'final', text: 'hello final', t0Ms: 0, t1Ms: 400 }));
        }
      });
    },
  });
  const port = await listen(server);
  const events = [];
  const asr = await createAsr({
    config: {
      asr: {
        provider: 'stream-cloud',
        fallback: 'mock',
        streamCloud: { url: `ws://127.0.0.1:${port}/asr`, connectTimeoutMs: 2000 },
      },
      mock: { asrScript: [{ text: 'should not be used', durMs: 5000 }] },
    },
    onEvent: (ev) => events.push(ev),
    log: () => {},
  });
  try {
    await asr.push(silencePcm(200, 16000), 0);
    for (let i = 0; i < 40 && !events.some((ev) => ev.type === 'partial'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const partial = events.find((ev) => ev.type === 'partial');
    assert.ok(partial, `应在 flush 前收到 partial，实际 ${events.map((ev) => ev.type).join(',')}`);
    assert.equal(partial.text, 'hello partial');
    assert.equal(events.some((ev) => ev.type === 'final'), false);
    await asr.flush();
    for (let i = 0; i < 40 && !events.some((ev) => ev.type === 'final'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const final = events.find((ev) => ev.type === 'final');
    assert.equal(final?.text, 'hello final');
    assert.ok(events.findIndex((ev) => ev.type === 'partial') < events.findIndex((ev) => ev.type === 'final'));
    await asr.close();
  } finally {
    for (const ws of sockets) {
      try { ws.close(); } catch { /* ignore */ }
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

test('stream-cloud falls back to the local recognizer without ending the session', async () => {
  const server = http.createServer();
  attachWebSocketServer(server, {
    path: '/asr',
    onConnection(ws) {
      ws.close(1000, 'unavailable');
    },
  });
  const port = await listen(server);
  const events = [];
  const asr = await createAsr({
    config: {
      asr: {
        provider: 'stream-cloud',
        fallback: 'mock',
        streamCloud: { url: `ws://127.0.0.1:${port}/asr`, connectTimeoutMs: 2000 },
      },
      mock: { asrScript: [{ text: 'local fallback transcript', durMs: 200 }] },
    },
    onEvent: (ev) => events.push(ev),
    log: () => {},
  });
  try {
    await asr.push(silencePcm(300, 16000), 0);
    for (let i = 0; i < 40 && !events.some((ev) => ev.type === 'final'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const final = events.find((ev) => ev.type === 'final');
    assert.equal(final?.text, 'local fallback transcript');
    await asr.push(silencePcm(100, 16000), 300);
    await asr.flush();
    await asr.close();
    assert.equal(asr.name, 'stream-cloud');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
