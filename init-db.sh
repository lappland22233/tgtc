#!/bin/bash

# TG 图床数据库初始化脚本

echo "=========================================="
echo "  TG 图床 - 数据库初始化"
echo "=========================================="
echo ""

# 检查配置文件
if [ ! -f "data.json" ]; then
    echo "[ERROR] 配置文件 data.json 不存在"
    exit 1
fi

# 读取配置
DB_HOST=$(grep -oP '(?<= "host": ")[^"]*' data.json)
DB_PORT=$(grep -oP '(?<= "port": )\d+' data.json)
DB_USER=$(grep -oP '(?<= "username": ")[^"]*' data.json)
DB_PASS=$(grep -oP '(?<= "password": ")[^"]*' data.json)
DB_NAME=$(grep -oP '(?<= "database": ")[^"]*' data.json)

echo "[INFO] 数据库配置:"
echo "  主机: $DB_HOST"
echo "  端口: $DB_PORT"
echo "  用户: $DB_USER"
echo "  数据库: $DB_NAME"
echo ""

# 测试连接
echo "[INFO] 测试数据库连接..."
mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" -e "SELECT 1;" 2>/dev/null
if [ $? -ne 0 ]; then
    echo "[ERROR] 数据库连接失败，请检查配置"
    exit 1
fi

echo "[SUCCESS] 数据库连接成功"
echo ""

# 数据库已在外部创建，跳过创建步骤
echo "[INFO] 数据库已存在，跳过创建"
echo ""

# 检查表是否存在，如果不存在则创建
echo "[INFO] 检查表结构..."
TABLE_EXISTS=$(mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "SHOW TABLES LIKE 'files';" 2>/dev/null | grep -c "files")

if [ "$TABLE_EXISTS" -eq 0 ]; then
    echo "[INFO] 表不存在，创建表结构..."
    mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" < init_db.go.sql 2>&1 | grep -v "Using a password on the command line interface can be insecure"
    if [ ${PIPESTATUS[0]} -eq 0 ]; then
        echo "[SUCCESS] 表结构初始化完成"
    else
        echo "[ERROR] 表结构初始化失败"
        exit 1
    fi
else
    echo "[INFO] 表已存在，检查字段..."

    # 检查 file_name 字段是否存在
    COLUMN_EXISTS=$(mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "SHOW COLUMNS FROM files LIKE 'file_name';" 2>/dev/null | grep -c "file_name")

    if [ "$COLUMN_EXISTS" -eq 0 ]; then
        echo "[INFO] 添加 file_name 字段..."
        mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "ALTER TABLE files ADD COLUMN file_name VARCHAR(255) DEFAULT NULL AFTER file_size;" 2>/dev/null
        echo "[SUCCESS] file_name 字段添加完成"
    else
        echo "[INFO] file_name 字段已存在"
    fi
fi

echo ""
echo "=========================================="
echo "[SUCCESS] 数据库初始化完成"
echo "=========================================="
echo ""
