"""
Bot2 HTTP 后端服务器
提供文件访问接口
"""
import os
import json
import logging
import io
from datetime import datetime, timedelta
from typing import Dict, Any

import requests
from flask import Flask, request, Response, send_file
from ipaddress import ip_address
import pymysql
from pymysql import cursors

# 配置日志
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO,
    handlers=[
        logging.FileHandler('bot2_server.log', encoding='utf-8'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# 配置
CONFIG_PATH = 'data.json'
CACHE_DIR = '/data/cache'
CACHE_TTL = 10 * 60  # 10分钟


class Config:
    """配置管理类"""

    def __init__(self, config_path: str = 'data.json'):
        self.config_path = config_path
        self.config: Dict[str, Any] = {}
        self.load_config()

    def load_config(self) -> bool:
        try:
            if not os.path.exists(self.config_path):
                logger.error(f"配置文件不存在: {self.config_path}")
                return False

            with open(self.config_path, 'r', encoding='utf-8') as f:
                self.config = json.load(f)

            logger.info("配置文件加载成功")
            return True
        except Exception as e:
            logger.error(f"加载配置文件失败: {e}")
            return False

    @property
    def mysql_config(self) -> Dict[str, Any]:
        return self.config['mysql']

    @property
    def bot_token(self) -> str:
        return self.config['telegram']['bot_token']

    @property
    def bot_api_url(self) -> str:
        return self.config['telegram']['bot_api_url']

    @property
    def base_url(self) -> str:
        return self.config['server']['base_url']


class Database:
    """数据库操作类"""

    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.connection = None

    def connect(self) -> bool:
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
            logger.error(f"数据库连接失败: {e}")
            return False

    def close(self):
        if self.connection:
            self.connection.close()

    def get_file_by_path(self, random_path: str):
        try:
            with self.connection.cursor() as cursor:
                sql = """
                    SELECT id, random_path, file_id, file_unique_id, mime_type,
                           file_size, file_name, cache_expires_at
                    FROM files
                    WHERE random_path = %s AND status = 'normal'
                    FOR UPDATE
                """
                cursor.execute(sql, (random_path,))
                return cursor.fetchone()
        except Exception as e:
            logger.error(f"查询文件失败: {e}")
            return None

    def update_file_access(self, file_id: int, cache_expires_at: datetime) -> bool:
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
            logger.error(f"更新文件访问时间失败: {e}")
            self.connection.rollback()
            return False

    def is_banned(self, ip_bytes: bytes) -> str:
        try:
            with self.connection.cursor() as cursor:
                sql = "SELECT reason FROM banned_ips WHERE ip = %s"
                cursor.execute(sql, (ip_bytes,))
                result = cursor.fetchone()
                if result:
                    return result['reason'] or "被封禁"
                return ""
        except Exception as e:
            logger.error(f"检查封禁失败: {e}")
            return ""


class TGClient:
    """Telegram API 客户端"""

    def __init__(self, bot_token: str, bot_api_url: str):
        self.bot_token = bot_token
        self.bot_api_url = bot_api_url

    def get_file(self, file_id: str) -> Dict[str, Any]:
        """获取文件信息"""
        url = f"{self.bot_api_url}/bot{self.bot_token}/getFile"
        params = {'file_id': file_id}
        response = requests.get(url, params=params, timeout=30)
        data = response.json()

        if not data.get('ok'):
            raise Exception(f"getFile 失败: {data.get('description', 'Unknown error')}")

        return data['result']

    def download_file(self, file_path: str) -> bytes:
        """下载文件"""
        file_path = file_path.lstrip('/')

        # 检查是否为本地绝对路径（自建Bot API --local 模式）
        if file_path.startswith('opt/telegram-bot-api/'):
            # 直接读取本地文件
            try:
                with open(f'/{file_path}', 'rb') as f:
                    return f.read()
            except Exception as e:
                raise Exception(f"读取本地文件失败: {e}")

        # 否则通过HTTP下载
        url = f"{self.bot_api_url}/file/bot{self.bot_token}/{file_path}"
        response = requests.get(url, timeout=60)
        response.raise_for_status()
        return response.content


# 初始化 Flask 应用
app = Flask(__name__)
config = Config(CONFIG_PATH)
db = Database(config.mysql_config)
tg_client = TGClient(config.bot_token, config.bot_api_url)


def get_client_ip():
    """获取客户端真实 IP"""
    # 优先读取 EO-Client-IP
    if ip := request.headers.get('EO-Client-IP'):
        if parsed := ip_address(ip):
            return parsed

    # 兼容 X-Forwarded-For
    if xff := request.headers.get('X-Forwarded-For'):
        ips = xff.split(',')
        if parsed := ip_address(ips[0].strip()):
            return parsed

    # 回退到 RemoteAddr
    host, _, _ = request.remote_addr.rpartition(':')
    if parsed := ip_address(host):
        return parsed

    return None


def enable_cors(response):
    """启用 CORS"""
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return response


@app.route('/<path:path>', methods=['GET', 'OPTIONS'])
def fetch_file(path):
    """文件访问处理器，支持断点续传"""
    if request.method == 'OPTIONS':
        return enable_cors(Response(''))

    logger.info(f"[访问] 路径: {path}")

    if not path:
        return Response('Not Found', status=404)

    # 获取客户端 IP
    client_ip = get_client_ip()
    logger.info(f"[访问] 路径: {path}, IP: {client_ip}")

    # 检查 IP 封禁
    if client_ip:
        ban_reason = db.is_banned(client_ip.packed)
        if ban_reason:
            logger.warning(f"[访问] IP已封禁: {client_ip}, 原因: {ban_reason}")
            return Response(
                json.dumps({'error': 'forbidden', 'reason': ban_reason}),
                status=403,
                mimetype='application/json'
            )

    # 查询文件信息
    file_info = db.get_file_by_path(path)
    if not file_info:
        logger.warning(f"[访问] 文件不存在: {path}")
        return Response('Not Found', status=404)

    file_id = file_info['file_id']
    mime_type = file_info['mime_type']
    file_name = file_info['file_name'] or f'file_{file_info["file_unique_id"]}'
    cache_expires = file_info['cache_expires_at']

    # 检查缓存
    cache_file = os.path.join(CACHE_DIR, path)
    cache_valid = datetime.now() < cache_expires if cache_expires else False

    if not (cache_valid and os.path.exists(cache_file)):
        # 缓存无效或不存在，从 Telegram 下载
        logger.info(f"[访问] 从 Telegram 下载: {file_id}")
        try:
            file_data = tg_client.get_file(file_id)
            file_content = tg_client.download_file(file_data['file_path'])

            # 保存到缓存
            os.makedirs(os.path.dirname(cache_file), exist_ok=True)
            with open(cache_file, 'wb') as f:
                f.write(file_content)

            logger.info(f"[访问] 下载成功: {path}")
        except Exception as e:
            logger.error(f"[访问] Telegram 下载失败: {e}")
            return Response('Failed to fetch file', status=502)

    # 获取文件大小
    file_size = os.path.getsize(cache_file)

    # 处理断点续传 Range 请求
    range_header = request.headers.get('Range')
    if range_header:
        # 解析 Range 头: "bytes=start-end"
        try:
            ranges = range_header.replace('bytes=', '').split('-')
            start = int(ranges[0]) if ranges[0] else 0
            end = int(ranges[1]) if ranges[1] else file_size - 1

            # 验证范围
            if start >= file_size or end >= file_size or start > end:
                logger.warning(f"[访问] 无效的 Range 请求: {range_header}")
                return Response('Invalid Range', status=416)

            # 读取指定范围
            content_length = end - start + 1
            with open(cache_file, 'rb') as f:
                f.seek(start)
                chunk = f.read(content_length)

            # 构建响应
            response = Response(
                chunk,
                206,  # Partial Content
                mimetype=mime_type,
                direct_passthrough=True
            )
            response.headers.add('Content-Range', f'bytes {start}-{end}/{file_size}')
            response.headers.add('Accept-Ranges', 'bytes')
            response.headers.add('Content-Length', str(content_length))

            # 更新访问时间
            db.update_file_access(file_info['id'], datetime.now() + timedelta(seconds=CACHE_TTL))

            logger.info(f"[访问] 断点续传: bytes={start}-{end}/{file_size}")
            return response
        except Exception as e:
            logger.error(f"[访问] 处理 Range 请求失败: {e}")
            # 如果 Range 处理失败，返回完整文件
            pass

    # 更新访问时间
    db.update_file_access(file_info['id'], datetime.now() + timedelta(seconds=CACHE_TTL))

    # 返回完整文件
    response = send_file(
        cache_file,
        mimetype=mime_type,
        as_attachment=False,
        download_name=file_name
    )
    response.headers.add('Accept-Ranges', 'bytes')
    return response


def main():
    """主函数"""
    # 创建缓存目录
    os.makedirs(CACHE_DIR, exist_ok=True)

    # 连接数据库
    if not db.connect():
        logger.error("数据库连接失败，程序退出")
        return

    logger.info("数据库连接成功")
    logger.info(f"缓存目录: {CACHE_DIR}")

    # 启动服务 - 固定监听 127.0.0.1:8082
    logger.info("服务启动监听: 127.0.0.1:8082")

    app.run(
        host='127.0.0.1',
        port=8082,
        threaded=True
    )


if __name__ == '__main__':
    main()
