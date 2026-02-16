#!/usr/bin/env bash

# Bot2 数据库初始化脚本
# 在已有数据库中创建表结构

set -e

cd "$(dirname "$0")"

echo "=========================================="
echo "Bot2 数据库表初始化"
echo "=========================================="
echo ""

# 检查配置文件
if [ ! -f "data.json" ]; then
    echo "❌ 错误: 配置文件 data.json 不存在"
    echo "请先复制 data.json.example 并填写配置"
    exit 1
fi

# 读取配置
echo "📋 读取配置文件..."
DB_HOST=$(python3 -c "import json; print(json.load(open('data.json'))['mysql']['host'])")
DB_PORT=$(python3 -c "import json; print(json.load(open('data.json'))['mysql']['port'])")
DB_USER=$(python3 -c "import json; print(json.load(open('data.json'))['mysql']['username'])")
DB_PASS=$(python3 -c "import json; print(json.load(open('data.json'))['mysql']['password'])")
DB_NAME=$(python3 -c "import json; print(json.load(open('data.json'))['mysql']['database'])")

echo ""
echo "数据库配置:"
echo "  主机: $DB_HOST:$DB_PORT"
echo "  用户: $DB_USER"
echo "  数据库: $DB_NAME"
echo ""

# 检查 init_db.sql 文件
if [ ! -f "init_db.sql" ]; then
    echo "❌ 错误: 找不到 init_db.sql 文件"
    exit 1
fi

# 执行 SQL
echo "🚀 开始初始化数据库表..."
mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" < init_db.sql 2>&1

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ 数据库表初始化成功！"
    echo ""
    echo "已创建的表:"
    echo "  - whitelist (白名单表)"
    echo "  - files (文件表)"
    echo "  - banned_ips (IP封禁表)"
    echo ""
else
    echo ""
    echo "❌ 数据库表初始化失败"
    echo ""
    echo "可能的原因:"
    echo "  - 数据库 $DB_NAME 不存在"
    echo "  - 用户 $DB_USER 没有权限"
    echo "  - MySQL 服务未运行"
    echo "  - 端口 $DB_PORT 不可访问"
    echo ""
    exit 1
fi

# 验证表是否创建成功
echo ""
echo "🔍 验证表结构..."
mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "SHOW TABLES;" 2>/dev/null

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ 表结构验证成功"
    echo ""
    echo "⚠️  请注意："
    echo "  默认管理员用户 ID 为 123456789"
    echo "  请在数据库中更新为你的实际 Telegram 用户 ID"
    echo ""
    echo "更新命令："
    echo "  mysql -h$DB_HOST -P$DB_PORT -u$DB_USER -p$DB_PASS $DB_NAME"
    echo "  mysql> UPDATE whitelist SET tg_user_id = 你的用户ID WHERE username = 'admin';"
    echo ""
else
    echo ""
    echo "⚠️  表结构验证失败"
fi

echo "=========================================="
