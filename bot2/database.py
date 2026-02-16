"""
数据库操作模块
提供 MySQL 连接和数据库操作功能
"""
import logging
import random
import string
from dbutils.pooled_db import PooledDB
import pymysql
from pymysql import cursors
from typing import Optional, Dict, Any, List, Tuple
from datetime import datetime
from ipaddress import ip_address
import os

logger = logging.getLogger(__name__)


class Database:
    """数据库连接和操作类（使用连接池）"""

    def __init__(self, config: Dict[str, Any]):
        """
        初始化数据库连接池

        Args:
            config: 数据库配置字典
        """
        self.config = config
        self.pool = PooledDB(
            creator=pymysql,
            maxconnections=10,
            mincached=2,
            maxcached=5,
            blocking=True,
            host=config['host'],
            port=config['port'],
            user=config['username'],
            password=config['password'],
            database=config['database'],
            charset='utf8mb4',
            cursorclass=pymysql.cursors.DictCursor,
            autocommit=True,
            connect_timeout=5
        )
        logger.info("数据库连接池初始化成功")

    def get_conn(self):
        """
        从连接池获取数据库连接

        Returns:
            数据库连接对象
        """
        return self.pool.connection()

    def close(self):
        """关闭连接池（实际上由连接池管理）"""
        # 连接池会自动管理连接，这里不做特殊处理
        pass

    def create_file_link(self, file_id: str, file_unique_id: str, mime_type: str,
                        file_size: int, filename: str, upload_ip: bytes,
                        edge_ip: bytes, tg_user_id: int, username: str = None) -> Tuple[bool, str, str]:
        """
        创建文件直链记录（使用连接池，单次短事务）

        Args:
            file_id: Telegram 文件 ID
            file_unique_id: Telegram 文件唯一 ID
            mime_type: 文件 MIME 类型
            file_size: 文件大小
            filename: 文件名
            upload_ip: 上传者 IP（二进制）
            edge_ip: 边缘 IP（二进制）
            tg_user_id: Telegram 用户 ID
            username: Telegram 用户名（可选）

        Returns:
            (成功状态, 消息, 随机路径)
        """
        conn = self.get_conn()
        try:
            with conn.cursor() as cursor:
                # 生成随机路径
                chars = string.ascii_letters + string.digits
                random_path = ''.join(random.choices(chars, k=24))

                # 插入文件记录
                sql = """
                    INSERT INTO files
                    (random_path, file_id, file_unique_id, mime_type, file_size, file_name,
                     upload_ip, edge_ip, status, created_at, last_accessed_at, cache_expires_at)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'normal',NOW(),NOW(),NOW()+INTERVAL 10 MINUTE)
                """
                cursor.execute(sql, (random_path, file_id, file_unique_id, mime_type,
                                    file_size, filename, upload_ip, edge_ip))

                return True, "文件直链创建成功", random_path
        except Exception:
            logger.exception("create_file_link 操作失败")
            return False, "数据库操作失败", ""
        finally:
            conn.close()

    def check_whitelist(self, tg_user_id: int) -> bool:
        """
        检查用户是否在白名单中

        Args:
            tg_user_id: Telegram 用户 ID

        Returns:
            bool: 是否在白名单中
        """
        conn = self.get_conn()
        try:
            with conn.cursor() as cursor:
                sql = """
                    SELECT COUNT(*) as count
                    FROM whitelist
                    WHERE tg_user_id = %s AND status = 'active'
                """
                cursor.execute(sql, (tg_user_id,))
                result = cursor.fetchone()
                return result['count'] > 0
        except Exception:
            logger.exception("check_whitelist 查询失败")
            return False
        finally:
            conn.close()

    def add_to_whitelist(self, tg_user_id: int, username: str = None,
                        added_by: int = None) -> Tuple[bool, str]:
        """
        添加用户到白名单

        Args:
            tg_user_id: Telegram 用户 ID
            username: Telegram 用户名（可选）
            added_by: 添加者 ID（可选）

        Returns:
            (成功状态, 消息)
        """
        conn = self.get_conn()
        try:
            with conn.cursor() as cursor:
                # 检查是否已存在
                check_sql = "SELECT id FROM whitelist WHERE tg_user_id = %s"
                cursor.execute(check_sql, (tg_user_id,))
                if cursor.fetchone():
                    return False, "该用户已在白名单中"

                # 插入白名单记录
                sql = """
                    INSERT INTO whitelist (tg_user_id, username, added_by, added_at, status)
                    VALUES (%s, %s, %s, NOW(), 'active')
                """
                cursor.execute(sql, (tg_user_id, username, added_by))
                return True, f"用户 {tg_user_id} 已添加到白名单"
        except Exception:
            logger.exception("add_to_whitelist 操作失败")
            return False, "数据库操作失败"
        finally:
            conn.close()

    def remove_from_whitelist(self, tg_user_id: int) -> Tuple[bool, str]:
        """
        从白名单移除用户

        Args:
            tg_user_id: Telegram 用户 ID

        Returns:
            (成功状态, 消息)
        """
        conn = self.get_conn()
        try:
            with conn.cursor() as cursor:
                sql = "UPDATE whitelist SET status = 'removed' WHERE tg_user_id = %s"
                cursor.execute(sql, (tg_user_id,))
                affected_rows = cursor.rowcount

                if affected_rows > 0:
                    return True, f"用户 {tg_user_id} 已从白名单移除"
                else:
                    return False, "该用户不在白名单中"
        except Exception:
            logger.exception("remove_from_whitelist 操作失败")
            return False, "数据库操作失败"
        finally:
            conn.close()

    def get_whitelist(self, limit: int = 50) -> List[Dict[str, Any]]:
        """
        获取白名单列表

        Args:
            limit: 返回数量限制

        Returns:
            白名单列表
        """
        conn = self.get_conn()
        try:
            with conn.cursor() as cursor:
                sql = """
                    SELECT tg_user_id, username, added_by, added_at, status
                    FROM whitelist
                    WHERE status = 'active'
                    ORDER BY added_at DESC
                    LIMIT %s
                """
                cursor.execute(sql, (limit,))
                results = cursor.fetchall()

                # 格式化时间
                for row in results:
                    if row['added_at']:
                        row['added_at'] = row['added_at'].strftime('%Y-%m-%d %H:%M:%S')
                    if not row['username']:
                        row['username'] = 'N/A'

                return results
        except Exception:
            logger.exception("get_whitelist 查询失败")
            return []
        finally:
            conn.close()

    def get_file_by_path(self, random_path: str) -> Optional[Dict[str, Any]]:
        """
        根据随机路径查询文件信息（无行锁，仅供读取）

        Args:
            random_path: 随机路径字符串

        Returns:
            文件信息字典，不存在返回 None
        """
        conn = self.get_conn()
        try:
            with conn.cursor() as cursor:
                sql = """
                    SELECT id, random_path, file_id, file_unique_id,
                           mime_type, file_size, upload_ip, edge_ip,
                           status, created_at, last_accessed_at, cache_expires_at
                    FROM files
                    WHERE random_path = %s AND status = 'normal'
                """
                cursor.execute(sql, (random_path,))
                result = cursor.fetchone()
                return result
        except Exception:
            logger.exception("get_file_by_path 查询失败")
            return None
        finally:
            conn.close()

    def update_file_access(self, file_id: int, cache_expires_at: datetime) -> bool:
        """
        更新文件访问时间和缓存过期时间（原子更新，不锁行）

        Args:
            file_id: 文件 ID
            cache_expires_at: 缓存过期时间

        Returns:
            bool: 更新是否成功
        """
        conn = self.get_conn()
        try:
            with conn.cursor() as cursor:
                sql = """
                    UPDATE files
                    SET last_accessed_at = NOW(),
                        cache_expires_at = %s
                    WHERE id = %s
                """
                cursor.execute(sql, (cache_expires_at, file_id))
                return True
        except Exception:
            logger.exception("update_file_access 操作失败")
            return False
        finally:
            conn.close()

    def touch_file(self, file_id: int) -> bool:
        """
        延长文件缓存时间（并发安全，使用 GREATEST 不重置 TTL）

        Args:
            file_id: 文件 ID

        Returns:
            bool: 更新是否成功
        """
        conn = self.get_conn()
        try:
            with conn.cursor() as cursor:
                sql = """
                    UPDATE files
                    SET last_accessed_at = NOW(),
                        cache_expires_at = GREATEST(
                            cache_expires_at,
                            NOW() + INTERVAL 10 MINUTE
                        )
                    WHERE id = %s
                """
                cursor.execute(sql, (file_id,))
                return True
        except Exception:
            logger.exception("touch_file 操作失败")
            return False
        finally:
            conn.close()
