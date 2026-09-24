#!/bin/zsh
# macOS Finder 可双击入口：前台运行，关闭此终端窗口即停止 Glacien。
# 使用 zsh 的 :A 取得真实绝对路径，避免经 Finder、相对路径或符号链接启动时
# 因当前工作目录不同而找不到 codes/launcher.py。
set -eu

SCRIPT_PATH="${0:A}"
SCRIPT_DIR="${SCRIPT_PATH:h}"
LAUNCHER="${SCRIPT_DIR}/codes/launcher.py"

if [[ ! -f "${LAUNCHER}" ]]; then
  print -u2 "未找到 Glacien 启动文件：${LAUNCHER}"
  exit 1
fi

cd -- "${SCRIPT_DIR}"
exec /usr/bin/env python3 "${LAUNCHER}"
