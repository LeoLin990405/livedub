/**
 * livedub note CLI（scripts/note.mjs）测试：
 * - --print 模式只输出 Markdown（时间戳/标题/标签/链接正确）
 * - --t-ms 与 --time 解析
 * - --no-offline 在引擎不可用时退出码 1
 * - --help 退出码 0
 * 不依赖网络/引擎；不写仓库 data/（离线写盘用例用临时工作目录的副本）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'note.mjs');

function run(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ...env },
  });
}

test('note CLI: --print 输出带时间戳/标题/链接/标签的 Markdown', () => {
  const res = run(['反向传播 = 链式法则 + 计算图', '--video', 'MIT 6.S191', '--url', 'https://example.com/l2', '--time', '12:34', '--tag', 'autograd', '--print']);
  assert.equal(res.status, 0, res.stderr);
  const out = res.stdout;
  assert.match(out, /### 12:34 · \[MIT 6\.S191\]\(https:\/\/example\.com\/l2\)/);
  assert.match(out, /反向传播 = 链式法则 \+ 计算图/);
  assert.match(out, /#autograd/);
});

test('note CLI: --t-ms 优先于 --time，且 --print 不写盘', () => {
  const res = run(['毫秒时间戳', '--video', 'X', '--time', '1:00', '--t-ms', '754000', '--print']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /### 12:34 · X/);
});

test('note CLI: 空内容退出码 1 并提示', () => {
  const res = run(['--video', 'X', '--print']);
  assert.equal(res.status, 1);
  assert.match(String(res.stderr), /缺少笔记内容/);
});

test('note CLI: --no-offline + 不可达引擎 -> 失败退出码 1（不落盘）', () => {
  const res = run(['测试', '--no-offline', '--engine', 'http://127.0.0.1:9', '--video', 'X'], {
    LIVEDUB_ENGINE_URL: 'http://127.0.0.1:9',
  });
  assert.equal(res.status, 1);
  assert.match(String(res.stderr), /引擎不可用/);
});

test('note CLI: --help 退出码 0 且包含用法', () => {
  const res = run(['--help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /livedub note/);
  assert.match(res.stdout, /--video/);
  assert.match(res.stdout, /--screenshot/);
});

test('note CLI: --print 与 --vision/--no-ocr 组合不联网、退出码 0', () => {
  const res = run(['图文笔记 CLI 参数', '--video', 'X', '--time', '2:00', '--print', '--vision', '--no-ocr']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /### 02:00 · X/);
});
