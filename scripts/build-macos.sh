#!/usr/bin/env bash
#
# livedub macOS 菜单栏 App 构建脚本（ScreenCaptureKit 系统音频捕获）
#
# 用法：
#   bash scripts/build-macos.sh            # 编译并生成 apps/macos/build/livedub.app
#   bash scripts/build-macos.sh --check    # 编译 + 运行 headless --self-test（CI 用）
#   bash scripts/build-macos.sh --clean    # 删除构建产物
#
# 特点：
#   - 只用系统 Command Line Tools 的 swiftc（无需完整 Xcode、无 xcodebuild 工程、无 SPM 第三方依赖）
#   - 产物：apps/macos/build/livedub.app（Contents/MacOS/livedub + Contents/Info.plist + Contents/PkgInfo）
#   - 环境变量：SWIFTC（默认 /usr/bin/swiftc）、MACOS_TARGET（默认 <arch>-apple-macos14.0）
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_SRC="$ROOT/apps/macos"
SRC_DIR="$APP_SRC/Sources"
BUILD_DIR="$APP_SRC/build"
APP_BUNDLE="$BUILD_DIR/livedub.app"
BIN="$APP_BUNDLE/Contents/MacOS/livedub"
INFO_TEMPLATE="$APP_SRC/Info.plist"

CHECK=0
for arg in "$@"; do
  case "$arg" in
    --check)
      CHECK=1
      ;;
    --clean)
      rm -rf "$BUILD_DIR"
      echo "[build-macos] 已删除 $BUILD_DIR"
      exit 0
      ;;
    -h | --help)
      grep -E '^#( |$)' "$0" | sed -e 's/^# \{0,1\}//' -e '/^$/{n;/^$/d}'
      exit 0
      ;;
    *)
      echo "[build-macos] 未知参数：$arg（支持 --check / --clean / --help）" >&2
      exit 2
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[build-macos] 错误：此 App 只能在 macOS 上构建（当前 $(uname -s)）" >&2
  exit 1
fi

SWIFTC="${SWIFTC:-/usr/bin/swiftc}"
if ! command -v "$SWIFTC" >/dev/null 2>&1; then
  echo "[build-macos] 错误：找不到 swiftc：$SWIFTC" >&2
  echo "[build-macos] 下一步：安装 Command Line Tools（xcode-select --install），或设置 SWIFTC 指向可用的 swiftc" >&2
  exit 1
fi
if [[ ! -f "$INFO_TEMPLATE" ]]; then
  echo "[build-macos] 错误：缺少 Info.plist 模板：$INFO_TEMPLATE" >&2
  exit 1
fi

shopt -s nullglob
SOURCES=("$SRC_DIR"/*.swift)
shopt -u nullglob
if [[ ${#SOURCES[@]} -eq 0 ]]; then
  echo "[build-macos] 错误：$SRC_DIR 下没有 Swift 源码" >&2
  exit 1
fi
if [[ ! -f "$SRC_DIR/main.swift" ]]; then
  echo "[build-macos] 错误：缺少 $SRC_DIR/main.swift（Swift 可执行程序的入口文件必须叫 main.swift）" >&2
  exit 1
fi

ARCH="$(uname -m)"
TARGET="${MACOS_TARGET:-${ARCH}-apple-macos14.0}"

mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources" "$BUILD_DIR/.module-cache"

# 1) Info.plist（LSUIElement=true = 菜单栏 App 无 Dock 图标；NSScreenCaptureUsageDescription = 屏幕录制用途说明）
cp "$INFO_TEMPLATE" "$APP_BUNDLE/Contents/Info.plist"
# 2) PkgInfo（传统包类型标记：APPL????）
printf 'APPL????' > "$APP_BUNDLE/Contents/PkgInfo"

echo "[build-macos] $("$SWIFTC" --version | head -1)"
echo "[build-macos] target=$TARGET sources=${#SOURCES[@]} 个 .swift"
echo "[build-macos] 编译中（swiftc -O ...）"

START_SECONDS=$(date +%s)
# 只链接系统框架（AppKit/AVFoundation/CoreMedia/CoreGraphics/ScreenCaptureKit），零第三方依赖
"$SWIFTC" -O -whole-module-optimization \
  -target "$TARGET" \
  -module-cache-path "$BUILD_DIR/.module-cache" \
  -o "$BIN" \
  "${SOURCES[@]}" \
  -framework AppKit \
  -framework AVFoundation \
  -framework CoreMedia \
  -framework CoreGraphics \
  -framework ScreenCaptureKit
chmod +x "$BIN"
END_SECONDS=$(date +%s)

# 3) ad-hoc 签名：让 App 可以被 `open` 正常启动（未签名 App 在部分机器上会被 Gatekeeper 拦）。
#    注意：ad-hoc 签名每次重新构建后 cdhash 变化，屏幕录制权限可能需要重新授权（README 有说明）。
if command -v codesign >/dev/null 2>&1; then
  if codesign --force --sign - --timestamp=none "$APP_BUNDLE" >/dev/null 2>&1; then
    echo "[build-macos] ad-hoc 签名完成（未公证，首次打开建议右键 → 打开）"
  else
    echo "[build-macos] 警告：ad-hoc 签名失败（不影响直接运行 Contents/MacOS/livedub）" >&2
  fi
fi

BINARY_BYTES=$(wc -c <"$BIN" | tr -d ' ')
BUNDLE_SIZE=$(du -sh "$APP_BUNDLE" 2>/dev/null | awk '{print $1}')
echo "[build-macos] 编译完成：$((END_SECONDS - START_SECONDS))s，可执行文件 $((BINARY_BYTES / 1024)) KB，bundle $BUNDLE_SIZE"
echo "[build-macos] 产物：$APP_BUNDLE"

if [[ "$CHECK" -eq 1 ]]; then
  echo "[build-macos] --check：运行 headless 自检（不建窗口、不请求权限）..."
  if "$BIN" --self-test; then
    echo "[build-macos] ✅ 编译 + self-test 全部通过"
    exit 0
  fi
  echo "[build-macos] ❌ self-test 失败" >&2
  exit 1
fi

cat <<EOF
[build-macos] ✅ 构建完成
  启动（菜单栏）：open "$APP_BUNDLE"
  模拟演示（无需权限）："$BIN" --simulate
  自检："$BIN" --self-test
EOF
