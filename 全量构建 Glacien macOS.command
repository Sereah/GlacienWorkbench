#!/bin/zsh
# 在 macOS 本机清理缓存后构建 dist/Glacien-<版本>.app。
set -eu

SCRIPT_PATH="${0:A}"
SCRIPT_DIR="${SCRIPT_PATH:h}"
BUILD_VENV="${SCRIPT_DIR}/.desktop-build-venv"

cd -- "${SCRIPT_DIR}"
if [[ ! -x "${BUILD_VENV}/bin/python" ]]; then
  python3 -m venv "${BUILD_VENV}"
fi
"${BUILD_VENV}/bin/python" codes/prepare_desktop_build.py
"${BUILD_VENV}/bin/python" codes/build_desktop.py --clean
print "全量构建完成：${SCRIPT_DIR}/dist（产物文件名包含 release.json 版本号）"
