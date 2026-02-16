"""
数据库操作模块
提供 MySQL 连接和数据库操作功能
"""
import json
import pymysql
from pymysql import cursors
from typing import Optional, Dict, Any, Tuple
from datetime import datetime
from ipaddress import ip_address
import os


class Database:
    """数据库连接和操作类"""

    def __init__(self, config: Dict[str, Any]):
        """
        初始化数据库连接

        Args:
            config: 数据库配置字典
        """
        self.config = config
        self.connection = None

    def connect(self) -> bool:
        """
        建立数据库连接

        Returns:
            bool: 连接是否成功
        """
        try:
            self.connection = pymysql.connect(
                host=self.config['host'],
                port=self.config['port'],
                user=self.config['username'],
                password=self.config['password'],
                database=self.config['database'],
                charset='utf8mb4',
                cursorclass=cursors.DictCursor,
                autocommit=False
            )
            return True
        except Exception as e:
            print(f"数据库连接失败: {e}")
            return False

    def close(self):
        """关闭数据库连接"""
        if self.connection:
            self.connection.close()
            self.connection = None

    def reconnect(self) -> bool:
        """重新连接数据库"""
        self.close()
        return self.connect()

    def get_file_by_path(self, random_path: str) -> Optional[Dict[str, Any]]:
        """
        根据随机路径查询文件信息

        Args:
            random_path: 随机路径字符串

        Returns:
            文件信息字典，不存在返回 None
        """
        try:
            with self.connection.cursor() as cursor:
                sql = """
                    SELECT id, random_path, file_id, file_unique_id,
                           mime_type, file_size, upload_ip, edge_ip,
                           status, created_at, last_accessed_at, cache_expires_at
                    FROM files
                    WHERE random_path = %s
                    FOR UPDATE
                """
                cursor.execute(sql, (random_path,))
                result = cursor.fetchone()
                return result
        except Exception as e:
            print(f"查询文件失败: {e}")
            return None

    def update_file_access(self, file_id: int, cache_expires_at: datetime) -> bool:
        """
        更新文件访问时间和缓存过期时间

        Args:
            file_id: 文件ID
            cache_expires_at: 缓存过期时间

        Returns:
            bool: 更新是否成功
        """
        try:
            with self.connection.cursor() as cursor:
                sql = """
                    UPDATE files
                    SET last_accessed_at = NOW(),
                        cache_expires_at = %s
                    WHERE id = %s
                """
                cursor.execute(sql, (cache_expires_at, file_id))
                self.connection.commit()
                return True
        except Exception as e:
            print(f"更新文件访问信息失败: {e}")
            self.connection.rollback()
            return False

    def delete_file_by_path(self, random_path: str) -> Tuple[bool, str]:
        """
        标记文件为已删除状态

        Args:
            random_path: 随机路径字符串

        Returns:
            (成功状态, 消息)
        """
        try:
            with self.connection.cursor() as cursor:
                sql = """
                    UPDATE files
                    SET status = 'deleted'
                    WHERE random_path = %s AND status = 'normal'
                """
                cursor.execute(sql, (random_path,))
                affected_rows = cursor.rowcount
                self.connection.commit()

                if affected_rows > 0:
                    return True, "文件已标记删除"
                else:
                    return False, "文件不存在或已被删除"
        except Exception as e:
            print(f"删除文件失败: {e}")
            self.connection.rollback()
            return False, f"操作失败: {str(e)}"

    def ban_ip(self, ip_str: str, reason: str = "") -> Tuple[bool, str]:
        """
        封禁 IP 地址

        Args:
            ip_str: IP 地址字符串
            reason: 封禁原因

        Returns:
            (成功状态, 消息)
        """
        try:
            # 验证 IP 地址
            ip_obj = ip_address(ip_str)
            ip_bytes = ip_obj.packed

            with self.connection.cursor() as cursor:
                # 检查是否已存在
                check_sql = "SELECT id FROM banned_ips WHERE ip = %s"
                cursor.execute(check_sql, (ip_bytes,))
                if cursor.fetchone():
                    return False, "该 IP 已被封禁"

                # 插入封禁记录
                sql = """
                    INSERT INTO banned_ips (ip, banned_at, reason)
                    VALUES (%s, NOW(), %s)
                """
                cursor.execute(sql, (ip_bytes, reason))
                self.connection.commit()
                return True, f"IP {ip_str} 已封禁"
        except ValueError:
            return False, "无效的 IP 地址格式"
        except Exception as e:
            print(f"封禁 IP 失败: {e}")
            self.connection.rollback()
            return False, f"操作失败: {str(e)}"

    def unban_ip(self, ip_str: str) -> Tuple[bool, str]:
        """
        解封 IP 地址

        Args:
            ip_str: IP 地址字符串

        Returns:
            (成功状态, 消息)
        """
        try:
            ip_obj = ip_address(ip_str)
            ip_bytes = ip_obj.packed

            with self.connection.cursor() as cursor:
                sql = "DELETE FROM banned_ips WHERE ip = %s"
                cursor.execute(sql, (ip_bytes,))
                affected_rows = cursor.rowcount
                self.connection.commit()

                if affected_rows > 0:
                    return True, f"IP {ip_str} 已解封"
                else:
                    return False, "该 IP 不在封禁列表中"
        except ValueError:
            return False, "无效的 IP 地址格式"
        except Exception as e:
            print(f"解封 IP 失败: {e}")
            self.connection.rollback()
            return False, f"操作失败: {str(e)}"

    def get_banned_ips(self, limit: int = 50) -> list:
        """
        获取封禁 IP 列表

        Args:
            limit: 返回数量限制

        Returns:
            封禁 IP 列表
        """
        try:
            with self.connection.cursor() as cursor:
                sql = """
                    SELECT
                        ip,
                        banned_at,
                        reason
                    FROM banned_ips
                    ORDER BY banned_at DESC
                    LIMIT %s
                """
                cursor.execute(sql, (limit,))
                results = cursor.fetchall()

                # 将二进制 IP 转换为可读格式
                for row in results:
                    ip_obj = ip_address(row['ip'])
                    row['ip'] = str(ip_obj)
                    row['banned_at'] = row['banned_at'].strftime('%Y-%m-%d %H:%M:%S')

                return results
        except Exception as e:
            print(f"获取封禁列表失败: {e}")
            return []

    def get_stats(self) -> Dict[str, Any]:
        """
        获取系统统计信息

        Returns:
            统计信息字典
        """
        try:
            with self.connection.cursor() as cursor:
                # 文件总数
                cursor.execute("SELECT COUNT(*) as total FROM files WHERE status = 'normal'")
                total_files = cursor.fetchone()['total']

                # 今日上传数
                cursor.execute("""
                    SELECT COUNT(*) as count
                    FROM files
                    WHERE DATE(created_at) = CURDATE() AND status = 'normal'
                """)
                today_uploads = cursor.fetchone()['count']

                # 今日访问量
                cursor.execute("""
                    SELECT COUNT(*) as count
                    FROM files
                    WHERE DATE(last_accessed_at) = CURDATE() AND status = 'normal'
                """)
                today_access = cursor.fetchone()['count']

                # 缓存中文件数（缓存未过期）
                cursor.execute("""
                    SELECT COUNT(*) as count
                    FROM files
                    WHERE cache_expires_at > NOW() AND status = 'normal'
                """)
                cached_files = cursor.fetchone()['count']

                # 封禁 IP 数
                cursor.execute("SELECT COUNT(*) as count FROM banned_ips")
                banned_count = cursor.fetchone()['count']

                # 缓存命中率（简单估算）
                hit_rate = 0
                if today_access > 0 and cached_files > 0:
                    hit_rate = min(100, (cached_files / total_files * 100) if total_files > 0 else 0)

                return {
                    'total_files': total_files,
                    'today_uploads': today_uploads,
                    'today_access': today_access,
                    'cached_files': cached_files,
                    'banned_ips': banned_count,
                    'cache_hit_rate': round(hit_rate, 2)
                }
        except Exception as e:
            print(f"获取统计信息失败: {e}")
            return {}

    def get_upload_logs(self, limit: int = 20) -> list:
        """
        获取上传日志

        Args:
            limit: 返回数量限制

        Returns:
            上传日志列表
        """
        try:
            with self.connection.cursor() as cursor:
                sql = """
                    SELECT
                        random_path,
                        file_name,
                        file_size,
                        mime_type,
                        upload_ip,
                        created_at
                    FROM files
                    WHERE status = 'normal'
                    ORDER BY created_at DESC
                    LIMIT %s
                """
                cursor.execute(sql, (limit,))
                results = cursor.fetchall()

                # 将二进制 IP 转换为可读格式
                for row in results:
                    if row['upload_ip']:
                        from ipaddress import ip_address
                        ip_obj = ip_address(row['upload_ip'])
                        row['upload_ip'] = str(ip_obj)
                    row['created_at'] = row['created_at'].strftime('%Y-%m-%d %H:%M:%S')
                    row['file_size'] = int(row['file_size']) if row['file_size'] else 0

                return results
        except Exception as e:
            print(f"获取上传日志失败: {e}")
            return []

    def __enter__(self):
        """支持上下文管理器"""
        if not self.connection:
            self.connect()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """退出上下文时关闭连接"""
        self.close()
