#!/bin/bash

# ===========================================
# 数据库迁移脚本
# 将旧版本数据迁移到新结构
# ===========================================

echo "==========================================="
echo "  数据库迁移脚本"
echo "==========================================="
echo ""

# 读取配置
if [ ! -f "data.json" ]; then
    echo "[错误] 配置文件 data.json 不存在"
    echo "请先复制 data.json.example 到 data.json 并配置"
    exit 1
fi

# 读取数据库配置
DB_HOST=$(grep -oP '(?<= "host": ")[^"]*' data.json)
DB_PORT=$(grep -oP '(?<= "port": )\d+' data.json)
DB_USER=$(grep -oP '(?<= "username": ")[^"]*' data.json)
DB_PASS=$(grep -oP '(?<= "password": ")[^"]*' data.json)
DB_NAME=$(grep -oP '(?<= "database": ")[^"]*' data.json)

echo "[信息] 数据库配置:"
echo "  主机: $DB_HOST"
echo "  端口: $DB_PORT"
echo "  用户: $DB_USER"
echo "  数据库: $DB_NAME"
echo ""

# 测试连接
echo "[1/7] 测试数据库连接..."
mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "SELECT 1;" 2>/dev/null
if [ $? -ne 0 ]; then
    echo "[错误] 数据库连接失败，请检查配置"
    exit 1
fi
echo "[成功] 数据库连接成功"
echo ""

# 检查 files 表是否存在
echo "[2/7] 检查表结构..."
TABLE_EXISTS=$(mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" -sN -e "SHOW TABLES LIKE 'files';" 2>/dev/null)

if [ -z "$TABLE_EXISTS" ]; then
    echo "[错误] files 表不存在，请先运行初始化脚本"
    exit 1
fi
echo "[成功] files 表已存在"
echo ""

# 检查是否有 delete_reason 字段
echo "[3/7] 检查字段..."
HAS_DELETE_REASON=$(mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" -sN -e "SHOW COLUMNS FROM files LIKE 'delete_reason';" 2>/dev/null)

if [ -n "$HAS_DELETE_REASON" ]; then
    echo "[提示] delete_reason 字段已存在，无需迁移"
    echo "[完成] 数据库已是最新结构"
    exit 0
fi
echo "[成功] 检测到需要迁移"
echo ""

# 备份数据
echo "[4/7] 创建数据备份..."
BACKUP_FILE="backup_$(date +%Y%m%d_%H%M%S).sql"
mysqldump -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" > "$BACKUP_FILE" 2>/dev/null

if [ $? -eq 0 ] && [ -f "$BACKUP_FILE" ]; then
    echo "[成功] 备份已创建: $BACKUP_FILE"
    BACKUP_SIZE=$(ls -lh "$BACKUP_FILE" | awk '{print $5}')
    echo "[信息] 备份文件大小: $BACKUP_SIZE"
else
    echo "[警告] 备份创建失败，继续迁移..."
    BACKUP_FILE=""
fi
echo ""

# 开始迁移
echo "[5/7] 添加 delete_reason 字段..."
mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" <<EOF 2>/dev/null
ALTER TABLE files
ADD COLUMN delete_reason VARCHAR(500) DEFAULT NULL
COMMENT '删除原因'
AFTER status;
EOF

if [ $? -ne 0 ]; then
    echo "[错误] 添加字段失败"
    if [ -n "$BACKUP_FILE" ]; then
        echo "[恢复] 尝试恢复备份..."
        mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" < "$BACKUP_FILE" 2>/dev/null
        if [ $? -eq 0 ]; then
            echo "[成功] 数据库已恢复"
        fi
    fi
    exit 1
fi
echo "[成功] delete_reason 字段已添加"
echo ""

# 验证字段是否添加成功
echo "[6/7] 验证字段..."
HAS_FIELD=$(mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" -sN -e "SHOW COLUMNS FROM files LIKE 'delete_reason';" 2>/dev/null)

if [ -z "$HAS_FIELD" ]; then
    echo "[错误] 字段添加验证失败"
    exit 1
fi
echo "[成功] 字段验证通过"
echo ""

# 显示迁移结果
echo "[7/7] 显示迁移结果..."
echo ""
mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
SELECT
    'files 表结构:' AS info,
    COLUMN_NAME AS 字段名,
    DATA_TYPE AS 数据类型,
    IS_NULLABLE AS 可空
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = '$DB_NAME' AND TABLE_NAME = 'files'
ORDER BY ORDINAL_POSITION;
" 2>/dev/null

echo ""
echo "==========================================="
echo "  迁移完成！"
echo "==========================================="
echo ""
echo "统计信息:"
echo "  新增字段: delete_reason (VARCHAR(500))"
echo "  备份文件: ${BACKUP_FILE:-未创建}"
echo "  数据库: $DB_NAME"
echo ""

# 显示表数据统计
mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
SELECT
    '总文件数:' AS info,
    COUNT(*) AS 数量
FROM files
UNION ALL
SELECT
    '正常文件数:' AS info,
    COUNT(*) AS 数量
FROM files
WHERE status = 'normal'
UNION ALL
SELECT
    '已删除文件数:' AS info,
    COUNT(*) AS 数量
FROM files
WHERE status = 'deleted';
" 2>/dev/null

echo ""
echo "注意:"
echo "  - 已有数据的 file_id 保持不变"
echo "  - 新上传的文件将支持填写删除原因"
echo "  - 旧数据的 delete_reason 字段为 NULL"
echo ""
echo "⚠️  建议:"
echo "  - 保存备份文件: $BACKUP_FILE"
echo "  - 测试应用程序功能"
echo "  - 确认删除功能正常工作"
echo ""
echo "如需回滚，使用:"
echo "  mysql -h$DB_HOST -P$DB_PORT -u$DB_USER -p$DB_PASS $DB_NAME < $BACKUP_FILE"
echo ""
