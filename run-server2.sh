#!/usr/bin/env bash
set -euo pipefail

# 兼容旧入口：run-server2.sh
# 新结构已统一为单服务入口 main.go + manage.sh
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "[INFO] run-server2.sh 已弃用，正在切换到统一入口: manage.sh start"
exec "$SCRIPT_DIR/manage.sh" start "$@"
