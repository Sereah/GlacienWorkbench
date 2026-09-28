#!/bin/zsh
# 在 macOS 本机复用缓存构建 dist/Glacien.app。
set -eu

SCRIPT_PATH="${0:A}"
SCRIPT_DIR="${SCRIPT_PATH:h}"
BUILD_VENV="${SCRIPT_DIR}/.desktop-build-venv"

cd -- "${SCRIPT_DIR}"
if [[ ! -x "${BUILD_VENV}/bin/python" ]]; then
  python3 -m venv "${BUILD_VENV}"
fi
"${BUILD_VENV}/bin/python" codes/prepare_desktop_build.py
"${BUILD_VENV}/bin/python" codes/build_desktop.py
print "增量构建完成：${SCRIPT_DIR}/dist/Glacien.app"
