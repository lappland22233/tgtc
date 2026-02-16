#!/usr/bin/env bash

# TG 图床数据库初始化与迁移脚本（保留历史数据）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SQL_FILE="$SCRIPT_DIR/init_db.go.sql"
CONFIG_FILE="$SCRIPT_DIR/data.json"

echo "=========================================="
echo "  TG 图床 - 数据库初始化/迁移"
echo "=========================================="
echo ""

# 检查配置文件
if [ ! -f "$CONFIG_FILE" ]; then
    echo "[ERROR] 配置文件 data.json 不存在"
    exit 1
fi

# 检查 SQL 文件
if [ ! -f "$SQL_FILE" ]; then
    echo "[ERROR] 找不到 SQL 文件: $SQL_FILE"
    exit 1
fi

# 读取配置（使用 Python 解析，避免 grep 解析 JSON 不稳定）
readarray -t DB_CONF < <(python3 - "$CONFIG_FILE" <<'PY'
import json, sys
from pathlib import Path

cfg = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
mysql = cfg.get('mysql', {})
print(mysql.get('host', 'localhost'))
print(mysql.get('port', 3306))
print(mysql.get('username', 'root'))
print(mysql.get('password', ''))
print(mysql.get('database', ''))
PY
)

DB_HOST="${DB_CONF[0]}"
DB_PORT="${DB_CONF[1]}"
DB_USER="${DB_CONF[2]}"
DB_PASS="${DB_CONF[3]}"
DB_NAME="${DB_CONF[4]}"

if [ -z "$DB_NAME" ]; then
    echo "[ERROR] 配置缺失: mysql.database 不能为空"
    exit 1
fi

echo "[INFO] 数据库配置:"
echo "  主机: $DB_HOST"
echo "  端口: $DB_PORT"
echo "  用户: $DB_USER"
echo "  数据库: $DB_NAME"
echo ""

MYSQL_CMD=(mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS")

# 测试连接
printf '[INFO] 测试数据库连接...\n'
"${MYSQL_CMD[@]}" -e "SELECT 1;" >/dev/null 2>&1 || {
    echo "[ERROR] 数据库连接失败，请检查配置"
    exit 1
}

echo "[SUCCESS] 数据库连接成功"
echo ""

echo "[INFO] 执行表结构初始化与兼容迁移（幂等）..."
"${MYSQL_CMD[@]}" "$DB_NAME" < "$SQL_FILE"

echo ""
echo "[INFO] 验证关键字段..."
for col in file_name delete_reason; do
    EXISTS=$("${MYSQL_CMD[@]}" "$DB_NAME" -Nse "SHOW COLUMNS FROM files LIKE '$col';" | wc -l)
    if [ "$EXISTS" -eq 0 ]; then
        echo "[ERROR] 迁移后字段缺失: files.$col"
        exit 1
    fi
    echo "[SUCCESS] 字段存在: files.$col"
done

echo ""
echo "=========================================="
echo "[SUCCESS] 数据库初始化/迁移完成（数据保留）"
echo "=========================================="
echo ""
