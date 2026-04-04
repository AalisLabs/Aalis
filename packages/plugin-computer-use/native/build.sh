#!/bin/bash
# 构建 macOS Accessibility 原生模块
# 仅在 macOS 上编译

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "跳过原生模块构建（非 macOS 平台）"
  exit 0
fi

if ! command -v cargo &> /dev/null; then
  echo "警告: 未安装 Rust/cargo，跳过原生模块构建"
  echo "  UI 自动化功能将不可用"
  echo "  安装 Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  exit 0
fi

echo "正在构建原生模块..."
cargo build --release 2>&1

# 复制 dylib 并重命名为 .node
cp target/release/libaalis_ax_native.dylib ../ax-native.darwin-arm64.node 2>/dev/null || \
cp target/release/libaalis_ax_native.dylib ../ax-native.darwin-x64.node 2>/dev/null || true

# 根据架构确定正确的文件名
ARCH=$(uname -m)
if [[ "$ARCH" == "arm64" ]]; then
  cp target/release/libaalis_ax_native.dylib ../ax-native.darwin-arm64.node
  echo "已构建: ax-native.darwin-arm64.node"
elif [[ "$ARCH" == "x86_64" ]]; then
  cp target/release/libaalis_ax_native.dylib ../ax-native.darwin-x64.node
  echo "已构建: ax-native.darwin-x64.node"
fi

echo "原生模块构建完成 ✓"
