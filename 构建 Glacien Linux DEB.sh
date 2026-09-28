#!/bin/sh
# 在 Linux 本机执行全量桌面构建，并生成带系统依赖声明的 DEB 安装包。
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BUILD_VENV="${SCRIPT_DIR}/.desktop-build-venv"

if [ "$(uname -s)" != "Linux" ]; then
  printf '%s\n' "DEB 只能在 Linux 系统构建。" >&2
  exit 1
fi

cd -- "${SCRIPT_DIR}"
sh "${SCRIPT_DIR}/全量构建 Glacien Linux.sh"
"${BUILD_VENV}/bin/python" codes/package_linux_deb.py
