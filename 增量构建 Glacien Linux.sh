#!/bin/sh
# 在 Linux 本机复用缓存构建 dist/Glacien。
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BUILD_VENV="${SCRIPT_DIR}/.desktop-build-venv"

cd -- "${SCRIPT_DIR}"
if [ ! -x "${BUILD_VENV}/bin/python" ]; then
  python3 -m venv "${BUILD_VENV}"
fi
"${BUILD_VENV}/bin/python" codes/prepare_desktop_build.py
"${BUILD_VENV}/bin/python" codes/build_desktop.py
printf '%s\n' "Incremental build completed: ${SCRIPT_DIR}/dist/Glacien"
