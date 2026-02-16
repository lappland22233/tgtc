#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
数据库迁移脚本
将旧版本数据迁移到新结构，添加 delete_reason 字段
"""

import json
import pymysql
from datetime import datetime
import os
import sys


def load_config():
    """加载数据库配置"""
    config_file = 'data.json'

    if not os.path.exists(config_file):
        print("[错误] 配置文件 data.json 不存在")
        print("请先复制 data.json.example 到 data.json 并配置")
        sys.exit(1)

    with open(config_file, 'r', encoding='utf-8') as f:
        config = json.load(f)

    return config['mysql']


def connect_db(config):
    """连接数据库"""
    try:
        connection = pymysql.connect(
            host=config['host'],
            port=config['port'],
            user=config['username'],
            password=config['password'],
            database=config['database'],
            charset='utf8mb4',
            cursorclass=pymysql.cursors.DictCursor
        )
        return connection
    except Exception as e:
        print(f"[错误] 数据库连接失败: {e}")
        sys.exit(1)


def check_table_exists(connection, table_name):
    """检查表是否存在"""
    try:
        with connection.cursor() as cursor:
            cursor.execute(f"SHOW TABLES LIKE '{table_name}'")
            return cursor.fetchone() is not None
    except Exception as e:
        print(f"[错误] 检查表失败: {e}")
        return False


def check_column_exists(connection, table_name, column_name):
    """检查字段是否存在"""
    try:
        with connection.cursor() as cursor:
            cursor.execute(f"""
                SELECT COLUMN_NAME
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = '{table_name}'
                AND COLUMN_NAME = '{column_name}'
            """)
            return cursor.fetchone() is not None
    except Exception as e:
        print(f"[错误] 检查字段失败: {e}")
        return False


def backup_database(connection, config):
    """备份数据库"""
    backup_file = f"backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.sql"

    try:
        print(f"[信息] 创建备份文件: {backup_file}")

        # 使用 mysqldump 命令
        import subprocess
        cmd = [
            'mysqldump',
            f'-h{config["host"]}',
            f'-P{config["port"]}',
            f'-u{config["username"]}',
            f'-p{config["password"]}',
            config['database']
        ]

        with open(backup_file, 'w', encoding='utf-8') as f:
            result = subprocess.run(cmd, stdout=f, stderr=subprocess.PIPE)

        if result.returncode == 0 and os.path.exists(backup_file):
            backup_size = os.path.getsize(backup_file)
            print(f"[成功] 备份已创建: {backup_file} ({backup_size} 字节)")
            return backup_file
        else:
            print("[警告] 备份创建失败")
            return None

    except Exception as e:
        print(f"[警告] 备份创建失败: {e}")
        return None


def add_delete_reason_field(connection):
    """添加 delete_reason 字段"""
    try:
        with connection.cursor() as cursor:
            sql = """
                ALTER TABLE files
                ADD COLUMN delete_reason VARCHAR(500) DEFAULT NULL
                COMMENT '删除原因'
                AFTER status
            """
            cursor.execute(sql)
            connection.commit()
            print("[成功] delete_reason 字段已添加")
            return True
    except Exception as e:
        print(f"[错误] 添加字段失败: {e}")
        connection.rollback()
        return False


def restore_database(connection, backup_file, config):
    """恢复数据库备份"""
    try:
        print("[恢复] 尝试恢复备份...")

        import subprocess
        cmd = [
            'mysql',
            f'-h{config["host"]}',
            f'-P{config["port"]}',
            f'-u{config["username"]}',
            f'-p{config["password"]}',
            config['database']
        ]

        with open(backup_file, 'r', encoding='utf-8') as f:
            subprocess.run(cmd, stdin=f)

        print("[成功] 数据库已恢复")
        return True
    except Exception as e:
        print(f"[错误] 恢复失败: {e}")
        return False


def show_table_structure(connection, table_name):
    """显示表结构"""
    try:
        with connection.cursor() as cursor:
            cursor.execute(f"""
                SELECT
                    COLUMN_NAME AS 字段名,
                    DATA_TYPE AS 数据类型,
                    COLUMN_TYPE AS 完整类型,
                    IS_NULLABLE AS 可空,
                    COLUMN_DEFAULT AS 默认值,
                    COLUMN_COMMENT AS 注释
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = '{table_name}'
                ORDER BY ORDINAL_POSITION
            """)
            columns = cursor.fetchall()

            print(f"\n{table_name} 表结构:")
            print("-" * 100)
            for col in columns:
                print(f"  {col['字段名']:20} | {col['数据类型']:15} | {col['可空']:5} | {col['默认值'] or 'NULL':10} | {col['注释']}")
            print("-" * 100)

    except Exception as e:
        print(f"[错误] 显示表结构失败: {e}")


def show_statistics(connection):
    """显示数据统计"""
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT COUNT(*) as total FROM files")
            total = cursor.fetchone()['total']

            cursor.execute("SELECT COUNT(*) as count FROM files WHERE status = 'normal'")
            normal = cursor.fetchone()['count']

            cursor.execute("SELECT COUNT(*) as count FROM files WHERE status = 'deleted'")
            deleted = cursor.fetchone()['count']

            cursor.execute("SELECT COUNT(*) as count FROM files WHERE delete_reason IS NOT NULL")
            with_reason = cursor.fetchone()['count']

            print("\n数据统计:")
            print("-" * 50)
            print(f"  总文件数:     {total}")
            print(f"  正常文件数:   {normal}")
            print(f"  已删除文件数: {deleted}")
            print(f"  有删除原因:   {with_reason}")
            print("-" * 50)

    except Exception as e:
        print(f"[错误] 显示统计失败: {e}")


def main():
    """主函数"""
    print("=" * 50)
    print("  数据库迁移脚本")
    print("=" * 50)
    print()

    # 加载配置
    print("[1/7] 加载配置...")
    config = load_config()
    print(f"[信息] 数据库: {config['host']}:{config['port']}/{config['database']}")
    print("[成功] 配置加载成功")
    print()

    # 连接数据库
    print("[2/7] 连接数据库...")
    connection = connect_db(config)
    print("[成功] 数据库连接成功")
    print()

    # 检查表是否存在
    print("[3/7] 检查表结构...")
    if not check_table_exists(connection, 'files'):
        print("[错误] files 表不存在，请先运行初始化脚本")
        print("运行: python init-db.py 或 bash init-db.sh")
        sys.exit(1)
    print("[成功] files 表已存在")
    print()

    # 检查字段是否存在
    print("[4/7] 检查字段...")
    if check_column_exists(connection, 'files', 'delete_reason'):
        print("[提示] delete_reason 字段已存在，无需迁移")
        print("[完成] 数据库已是最新结构")
        sys.exit(0)
    print("[成功] 检测到需要迁移")
    print()

    # 备份数据
    print("[5/7] 创建数据备份...")
    backup_file = backup_database(connection, config)
    print()

    # 开始迁移
    print("[6/7] 添加 delete_reason 字段...")
    if not add_delete_reason_field(connection):
        if backup_file:
            restore_database(connection, backup_file, config)
        sys.exit(1)
    print()

    # 验证字段
    print("[7/7] 验证字段...")
    if not check_column_exists(connection, 'files', 'delete_reason'):
        print("[错误] 字段添加验证失败")
        sys.exit(1)
    print("[成功] 字段验证通过")
    print()

    # 显示结果
    print("=" * 50)
    print("  迁移完成！")
    print("=" * 50)
    print()

    show_table_structure(connection, 'files')
    show_statistics(connection)

    print("\n注意事项:")
    print("  - 已有数据的 file_id 保持不变")
    print("  - 新上传的文件将支持填写删除原因")
    print("  - 旧数据的 delete_reason 字段为 NULL")
    print()
    if backup_file:
        print(f"⚠️  建议:")
        print(f"  - 保存备份文件: {backup_file}")
        print(f"  - 测试应用程序功能")
        print(f"  - 确认删除功能正常工作")
        print()
        print(f"如需回滚，使用:")
        print(f"  mysql -h{config['host']} -P{config['port']} -u{config['username']} -p{config['password']} {config['database']} < {backup_file}")
    else:
        print("⚠️  警告: 未创建备份文件，建议手动备份")

    # 关闭连接
    connection.close()

    print()
    print("=" * 50)


if __name__ == '__main__':
    main()
