#!/usr/bin/env bash
# 编译 livedub 本地 OCR Helper（macOS Vision）并做自检。
#
#   bash scripts/build-ocr.sh            # 编译到 data/bin/ocr-macos（已是最新则跳过）
#   bash scripts/build-ocr.sh --check    # 编译 + 单次/--serve 两种模式冒烟自检（CI 用）
#   bash scripts/build-ocr.sh --force    # 强制重新编译
#   bash scripts/build-ocr.sh --out /tmp/ocr-macos --image /tmp/frame.png
#
# 沙箱注意：macOS 沙箱里默认 TMPDIR 下的 clang/swift module cache 可能 EPERM，
# 这里统一把编译期临时目录指到 /tmp（可用 LIVEDUB_TMPDIR 覆盖）。运行时不需要这些环境变量。
#
# 退出码：0 成功；2 环境不满足/编译失败/自检失败；1 参数错误。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/scripts/ocr-macos.swift"
OUT="$ROOT/data/bin/ocr-macos"
SELF_IMAGE="$ROOT/docs/assets/demo-original.png"
SWIFTC="${SWIFTC:-/usr/bin/swiftc}"

MODE="build"      # build | check
FORCE=0
QUIET=0

usage() {
  sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

log() {
  if [[ "$QUIET" != "1" ]]; then printf '%s\n' "$*"; fi
}

die() {
  printf 'build-ocr: %s\n' "$*" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE="check" ;;
    --force) FORCE=1 ;;
    --quiet|-q) QUIET=1 ;;
    --out)
      [[ $# -ge 2 ]] || die "--out 缺少路径参数"
      OUT="$2"
      shift
      ;;
    --image)
      [[ $# -ge 2 ]] || die "--image 缺少路径参数"
      SELF_IMAGE="$2"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "未知参数：$1（运行 bash scripts/build-ocr.sh --help 查看用法）"
      ;;
  esac
  shift
done

# --- 环境检查 -------------------------------------------------------------
if [[ "$(uname -s)" != "Darwin" ]]; then
  die "本机不是 macOS：macOS Vision OCR 不可用。engine/vision 会自动回退到 tesseract（仅英文）；在 macOS 上再运行本脚本。"
fi
[[ -f "$SRC" ]] || die "找不到 Swift 源码：$SRC"
[[ -x "$SWIFTC" ]] || die "找不到 swiftc：$SWIFTC（需要安装 Xcode Command Line Tools：xcode-select --install）"

# 沙箱里 clang module cache 默认位置可能 EPERM，统一放 /tmp；用户可用 LIVEDUB_TMPDIR 覆盖
SAFE_TMP="${LIVEDUB_TMPDIR:-/tmp}"
[[ -d "$SAFE_TMP" && -w "$SAFE_TMP" ]] || SAFE_TMP="/tmp"
export TMPDIR="$SAFE_TMP"
export CLANG_MODULE_CACHE_PATH="${CLANG_MODULE_CACHE_PATH:-$SAFE_TMP/livedub-clang-cache}"
export SWIFT_MODULECACHE_PATH="${SWIFT_MODULECACHE_PATH:-$SAFE_TMP/livedub-swift-module-cache}"
mkdir -p "$CLANG_MODULE_CACHE_PATH" "$SWIFT_MODULECACHE_PATH" "$(dirname "$OUT")"

# --- 编译 -----------------------------------------------------------------
if [[ "$FORCE" != "1" && -x "$OUT" && "$OUT" -nt "$SRC" ]]; then
  log "ocr-macos 已是最新：$OUT（如需重编加 --force）"
else
  log "编译 OCR Helper：$SRC"
  log "  swiftc=$SWIFTC  out=$OUT"
  if ! "$SWIFTC" -O -o "$OUT" "$SRC"; then
    die "swiftc 编译失败（上面是编译器输出）。常见原因：缺 Xcode Command Line Tools、TMPDIR 不可写；可先运行 xcode-select --install"
  fi
  chmod +x "$OUT"
  log "编译完成：$OUT（$(du -h "$OUT" | cut -f1)）"
fi

# --- 自检 -----------------------------------------------------------------
run_self_check() {
  local image="$1"
  [[ -f "$image" ]] || die "自检图片不存在：$image"
  local json
  if ! json="$("$OUT" --image "$image" --langs en-US,zh-Hans 2>/dev/null)"; then
    die "OCR 二进制执行失败：$OUT --image $image（可加 --force 重编）"
  fi

  if command -v node >/dev/null 2>&1; then
    printf '%s' "$json" | node --input-type=module -e '
      let raw = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { raw += chunk; });
      process.stdin.on("end", () => {
        let r;
        try { r = JSON.parse(raw); } catch (e) { console.error("build-ocr: 自检输出不是合法 JSON"); process.exit(1); }
        if (!r || r.ok !== true) { console.error("build-ocr: 自检失败：" + (r && r.message ? r.message : "ok!=true")); process.exit(1); }
        if (r.provider !== "macos-vision") { console.error("build-ocr: provider 异常：" + r.provider); process.exit(1); }
        const text = typeof r.text === "string" ? r.text : "";
        if (text.trim().length < 6) { console.error("build-ocr: 自检未识别出文字（检查自检图片）"); process.exit(1); }
        console.log("OCR 自检通过：provider=" + r.provider + " lines=" + r.lines.length + " chars=" + text.length + " ms=" + r.ms + " image=" + r.image.width + "x" + r.image.height);
      });
    ' || die "OCR 自检未通过（见上面输出）"
  else
    # 没有 node 时的最小兜底：只要 JSON 结构包含 ok 与 provider 就认为通过
    case "$json" in
      *'"ok":true'*'"provider":"macos-vision"'*) log "OCR 自检通过（简易检查，无 node 可用）" ;;
      *) die "OCR 自检未通过：$json" ;;
    esac
  fi
}

# serve 模式冒烟：同一个常驻进程连发 2 帧（验证 stdin/stdout JSON 行协议 + 首帧/后续帧耗时）
run_serve_check() {
  local image="$1"
  [[ -f "$image" ]] || die "serve 自检图片不存在：$image"
  if ! command -v node >/dev/null 2>&1; then
    log "跳过 --serve 冒烟（没有 node 可用）"
    return 0
  fi
  OCR_BIN="$OUT" OCR_IMAGE="$image" node --input-type=module - <<'NODE'
import { spawn } from 'node:child_process';

const bin = process.env.OCR_BIN;
const image = process.env.OCR_IMAGE;
const child = spawn(bin, ['--serve', '--langs', 'en-US,zh-Hans'], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', () => {});
let buffer = '';
let stderrText = '';
child.stderr.on('data', (chunk) => { stderrText += chunk.toString(); });
const lines = [];
const waiters = [];
function handleLine(line) {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  lines.push(message);
  for (const waiter of [...waiters]) {
    if (waiter.match(message)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  }
}
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    handleLine(line);
  }
});
function waitFor(match, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const waiter = { match, resolve };
    waiters.push(waiter);
    const timer = setTimeout(() => {
      const at = waiters.indexOf(waiter);
      if (at >= 0) waiters.splice(at, 1);
      reject(new Error(`${label} 超时（${timeoutMs}ms）；stderr=${stderrText.slice(0, 300)}`));
    }, timeoutMs);
    const wrapped = waiter.resolve;
    waiter.resolve = (value) => { clearTimeout(timer); wrapped(value); };
  });
}
function send(id) {
  const startedAt = Date.now();
  child.stdin.write(JSON.stringify({ id, image }) + '\n');
  return waitFor((message) => message.id === id, 30000, `请求 ${id}`).then((response) => ({ ...response, wallMs: Date.now() - startedAt }));
}

try {
  await waitFor((message) => message.ready === true, 30000, 'ready');
  const first = await send(1);
  const second = await send(2);
  if (!first.ok || !second.ok) throw new Error(`serve 返回失败：${JSON.stringify(first).slice(0, 200)}`);
  if (!first.text || first.lines.length === 0) throw new Error('serve 从第 1 帧没识别出文字');
  if (!second.text || second.lines.length === 0) throw new Error('serve 从第 2 帧没识别出文字');
  console.log(`serve 冒烟通过：第1帧 ${first.wallMs}ms（识别 ${first.ms}ms, ${first.lines.length} 行），第2帧 ${second.wallMs}ms（识别 ${second.ms}ms, ${second.lines.length} 行）`);
} catch (err) {
  console.error(`build-ocr: serve 冒烟失败：${err.message}`);
  process.exit(1);
} finally {
  try { child.stdin.end(); } catch {}
  try { child.kill('SIGTERM'); } catch {}
}
NODE
  [[ $? -eq 0 ]] || die "--serve 冒烟未通过（见上面输出）"
}

if [[ "$MODE" == "check" ]]; then
  run_self_check "$SELF_IMAGE"
  run_serve_check "$SELF_IMAGE"
fi

exit 0
