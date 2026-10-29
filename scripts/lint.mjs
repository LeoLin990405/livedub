#!/usr/bin/env node
/**
 * 零依赖语法检查：node --check 所有仓库内 .mjs/.js（排除 models/、demo/tmp/、node_modules/）。
 * 用于本地与 CI（.github/workflows/ci.yml）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'models', 'demo']);
const EXT = new Set(['.mjs', '.js']);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name === 'tmp' && path.basename(dir) === 'demo') continue;
      yield* walk(full);
    } else if (entry.isFile() && EXT.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

let checked = 0;
const failures = [];
for (const file of walk(ROOT)) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  checked += 1;
  if (res.status !== 0) failures.push({ file: path.relative(ROOT, file), stderr: res.stderr?.trim() });
}

if (failures.length > 0) {
  console.error(`✖ syntax check failed: ${failures.length}/${checked}`);
  for (const f of failures) console.error(`\n--- ${f.file}\n${f.stderr}`);
  process.exit(1);
}
console.log(`✔ syntax check passed: ${checked} files`);
