"""
Telegram Bot 主程序 - bot2
功能：接收文件转发，生成可访问的直链
"""
import os
import sys
import json
import logging
import threading
from typing import Dict, Any, List
from datetime import datetime
import requests

import telebot
from telebot import types
from ipaddress import ip_address

from database import Database


# 配置日志
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO,
    handlers=[
        logging.FileHandler('bot2.log', encoding='utf-8'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)


class CustomTeleBot(telebot.TeleBot):
    """自定义 TeleBot 类，支持自定义 API URL"""

    def __init__(self, token, api_url=None, **kwargs):
        super().__init__(token, **kwargs)
        if api_url:
            self.api_url = api_url
            self.base_url = api_url
            self.file_url = f"{api_url}/file/bot{token}"


class Config:
    """配置管理类"""

    def __init__(self, config_path: str = 'data.json'):
        """
        加载配置文件

        Args:
            config_path: 配置文件路径
        """
        self.config_path = config_path
        self.config: Dict[str, Any] = {}
        self.load_config()

    def load_config(self) -> bool:
        """
        加载配置文件

        Returns:
            bool: 加载是否成功
        """
        try:
            if not os.path.exists(self.config_path):
                logger.error(f"配置文件不存在: {self.config_path}")
                return False

            with open(self.config_path, 'r', encoding='utf-8') as f:
                self.config = json.load(f)

            # 验证必要配置
            required_keys = [
                'telegram.bot_token',
                'telegram.bot_api_url',
                'mysql.host',
                'mysql.username',
                'mysql.password',
                'mysql.database',
                'admin.user_ids',
                'server.listen_addr',
                'server.base_url'
            ]

            for key in required_keys:
                keys = key.split('.')
                value = self.config
                for k in keys:
                    if k not in value:
                        logger.error(f"配置缺失: {key}")
                        return False
                    value = value[k]

            logger.info("配置文件加载成功")
            return True
        except json.JSONDecodeError as e:
            logger.error(f"配置文件格式错误: {e}")
            return False
        except Exception as e:
            logger.error(f"加载配置文件失败: {e}")
            return False

    @property
    def bot_token(self) -> str:
        return self.config['telegram']['bot_token']

    @property
    def bot_api_url(self) -> str:
        return self.config['telegram']['bot_api_url']

    @property
    def mysql_config(self) -> Dict[str, Any]:
        return self.config['mysql']

    @property
    def admin_ids(self) -> set:
        return set(self.config['admin']['user_ids'])

    @property
    def listen_addr(self) -> str:
        return self.config['server']['listen_addr']

    @property
    def base_url(self) -> str:
        return self.config['server']['base_url']


class TGBot:
    """Telegram Bot 主类"""

    def __init__(self, config: Config):
        """
        初始化 Bot

        Args:
            config: 配置对象
        """
        self.config = config
        self.db = Database(config.mysql_config)
        self.bot = CustomTeleBot(config.bot_token, api_url=config.bot_api_url)
        # 并发控制：限制同时处理的文件数量
        self.file_lock = threading.Semaphore(5)

    def check_admin(self, user_id: int) -> bool:
        """
        检查用户是否为管理员

        Args:
            user_id: Telegram 用户 ID

        Returns:
            bool: 是否为管理员
        """
        return user_id in self.config.admin_ids

    def check_whitelist(self, user_id: int) -> bool:
        """
        检查用户是否在白名单中

        Args:
            user_id: Telegram 用户 ID

        Returns:
            bool: 是否在白名单中
        """
        return self.db.check_whitelist(user_id)

    def start(self):
        """启动 Bot"""
        try:
            # 注册命令处理器
            self.bot.message_handler(commands=['start'])(self.start_command)
            self.bot.message_handler(commands=['help'])(self.help_command)
            self.bot.message_handler(commands=['link'])(self.link_command)
            self.bot.message_handler(commands=['add'])(self.add_whitelist_command)
            self.bot.message_handler(commands=['remove'])(self.remove_whitelist_command)
            self.bot.message_handler(commands=['list'])(self.list_whitelist_command)
            self.bot.message_handler(commands=['stats'])(self.stats_command)

            # 注册消息处理器（处理文件转发）
            self.bot.message_handler(content_types=['document', 'photo', 'video', 'audio', 'voice'])(self.handle_file)
            self.bot.message_handler(content_types=['text'])(self.handle_text)

            logger.info("Bot 启动中...")
            self.bot.polling(non_stop=True)

        except KeyboardInterrupt:
            logger.info("收到中断信号，正在关闭 Bot...")
        except Exception:
            logger.exception("Bot 运行错误")
        finally:
            logger.info("Bot 已关闭")

    def start_command(self, message: types.Message):
        """
        /start 命令处理器

        Args:
            message: Telegram 消息对象
        """
        user_id = message.from_user.id

        help_text = """
🤖 **TG 文件直链 Bot**

发送任意文件给我，我会生成一个可访问的直链。

📋 **可用命令**：
`/link` - 查看使用方法
`/help` - 查看帮助信息

🔒 **权限管理**（仅管理员）：
`/add <user_id>` - 添加用户到白名单
`/remove <user_id>` - 从白名单移除用户
`/list` - 查看白名单列表
`/stats` - 查看统计信息

---

⚠️ 只有白名单用户才能生成直链
"""
        self.bot.reply_to(message, help_text, parse_mode='Markdown')

    def help_command(self, message: types.Message):
        """
        /help 命令处理器

        Args:
            message: Telegram 消息对象
        """
        user_id = message.from_user.id

        help_text = """
📖 **使用说明**

**生成文件直链**：
1. 转发任意文件、图片、视频等到 Bot
2. 等待处理完成
3. Bot 会返回可访问的直链

**支持的文件类型**：
• 文档
• 图片
• 视频
• 音频
• 语音

**注意事项**：
• 只有白名单用户才能生成直链
• 生成的直链有效期：永久
• 文件大小限制：最大 2GB（受 Telegram 限制）

**获取用户 ID**：
• 使用 @userinfobot 获取您的 Telegram 用户 ID
• 或发送 /me 命令到 @userinfobot

---

有问题请联系管理员
"""
        self.bot.reply_to(message, help_text, parse_mode='Markdown')

    def link_command(self, message: types.Message):
        """
        /link 命令处理器 - 查看使用方法

        Args:
            message: Telegram 消息对象
        """
        usage_text = """
🔗 **生成直链方法**

只需转发任意文件给 Bot，即可自动生成直链！

**示例**：
1. 转发一个图片
2. 转发一个文档
3. 转发一个视频

Bot 会立即返回直链，可直接访问。

**直链格式**：
`https://your-domain.com/随机路径`

---

开始转发文件吧！📁
"""
        self.bot.reply_to(message, usage_text, parse_mode='Markdown')

    def add_whitelist_command(self, message: types.Message):
        """
        /add 命令处理器 - 添加用户到白名单

        Args:
            message: Telegram 消息对象
        """
        user_id = message.from_user.id

        if not self.check_admin(user_id):
            self.bot.reply_to(message, "⚠️ 权限不足：此功能仅限管理员使用")
            return

        # 检查参数
        if len(message.text.split()) < 2:
            self.bot.reply_to(
                message,
                "❌ 用法错误\n\n正确用法: `/add <user_id>`\n\n示例: `/add 123456789`",
                parse_mode='Markdown'
            )
            return

        # 参数解析异常保护
        try:
            target_user_id = int(message.text.split()[1].strip())
        except (ValueError, IndexError):
            self.bot.reply_to(message, "❌ user_id 必须是数字")
            return

        # 执行添加
        success, msg = self.db.add_to_whitelist(target_user_id, added_by=user_id)

        if success:
            self.bot.reply_to(message, f"✅ {msg}", parse_mode='Markdown')
        else:
            self.bot.reply_to(message, f"❌ {msg}", parse_mode='Markdown')

    def remove_whitelist_command(self, message: types.Message):
        """
        /remove 命令处理器 - 从白名单移除用户

        Args:
            message: Telegram 消息对象
        """
        user_id = message.from_user.id

        if not self.check_admin(user_id):
            self.bot.reply_to(message, "⚠️ 权限不足：此功能仅限管理员使用")
            return

        # 检查参数
        if len(message.text.split()) < 2:
            self.bot.reply_to(
                message,
                "❌ 用法错误\n\n正确用法: `/remove <user_id>`\n\n示例: `/remove 123456789`",
                parse_mode='Markdown'
            )
            return

        # 参数解析异常保护
        try:
            target_user_id = int(message.text.split()[1].strip())
        except (ValueError, IndexError):
            self.bot.reply_to(message, "❌ user_id 必须是数字")
            return

        # 执行移除
        success, msg = self.db.remove_from_whitelist(target_user_id)

        if success:
            self.bot.reply_to(message, f"✅ {msg}", parse_mode='Markdown')
        else:
            self.bot.reply_to(message, f"❌ {msg}", parse_mode='Markdown')

    def list_whitelist_command(self, message: types.Message):
        """
        /list 命令处理器 - 查看白名单列表

        Args:
            message: Telegram 消息对象
        """
        user_id = message.from_user.id

        if not self.check_admin(user_id):
            self.bot.reply_to(message, "⚠️ 权限不足：此功能仅限管理员使用")
            return

        # 获取白名单
        whitelist = self.db.get_whitelist(limit=100)

        if not whitelist:
            self.bot.reply_to(message, "📋 白名单为空")
            return

        # 构建回复文本
        lines = ["📋 **白名单列表**\n"]
        for i, user in enumerate(whitelist, 1):
            lines.append(
                f"{i}. `{user['tg_user_id']}`\n   用户名: {user['username']}\n   添加时间: {user['added_at']}"
            )

        text = "\n".join(lines)
        self.bot.reply_to(message, text, parse_mode='Markdown')

    def stats_command(self, message: types.Message):
        """
        /stats 命令处理器 - 查看统计信息

        Args:
            message: Telegram 消息对象
        """
        user_id = message.from_user.id

        if not self.check_admin(user_id):
            self.bot.reply_to(message, "⚠️ 权限不足：此功能仅限管理员使用")
            return

        # 获取白名单统计
        whitelist = self.db.get_whitelist(limit=1000)
        whitelist_count = len(whitelist)

        # 构建回复文本
        text = f"""
📊 **系统统计信息**

👥 **用户统计**
• 白名单用户数: {whitelist_count}

---
更新时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
"""
        self.bot.reply_to(message, text, parse_mode='Markdown')

    def handle_file(self, message: types.Message):
        """
        处理文件消息

        Args:
            message: Telegram 消息对象
        """
        # 并发控制：限制同时处理的文件数量
        if not self.file_lock.acquire(blocking=False):
            self.bot.reply_to(message, "⏳ 当前处理队列已满，请稍后再试")
            return

        try:
            user_id = message.from_user.id
            username = message.from_user.username

            # 检查白名单
            if not self.check_whitelist(user_id):
                self.bot.reply_to(message, "⚠️ 权限不足：您不在白名单中，无法生成直链")
                return

            # 获取文件信息
            file_info = None
            file_type = None

            if message.document:
                file_info = message.document
                file_type = 'document'
            elif message.photo:
                file_info = message.photo[-1]  # 获取最大尺寸的图片
                file_type = 'photo'
            elif message.video:
                file_info = message.video
                file_type = 'video'
            elif message.audio:
                file_info = message.audio
                file_type = 'audio'
            elif message.voice:
                file_info = message.voice
                file_type = 'voice'

            if not file_info:
                self.bot.reply_to(message, "❌ 无法识别文件")
                return

            # 先发送"处理中"消息
            processing_msg = self.bot.reply_to(
                message,
                "⏳ 正在生成文件直链，请稍候喵~"
            )

            # 获取文件信息
            file_id = file_info.file_id
            file_unique_id = file_info.file_unique_id
            file_size = getattr(file_info, 'file_size', 0)
            mime_type = getattr(file_info, 'mime_type', 'application/octet-stream')
            filename = getattr(file_info, 'file_name', f'file_{file_unique_id}')

            # 获取上传者信息（模拟）
            upload_ip_str = "127.0.0.1"  # Bot 内部处理，使用本地 IP
            edge_ip_str = "127.0.0.1"

            try:
                upload_ip = ip_address(upload_ip_str).packed
                edge_ip = ip_address(edge_ip_str).packed
            except Exception:
                upload_ip = None
                edge_ip = None

            # 创建文件记录
            success, msg, random_path = self.db.create_file_link(
                file_id=file_id,
                file_unique_id=file_unique_id,
                mime_type=mime_type,
                file_size=file_size,
                filename=filename,
                upload_ip=upload_ip,
                edge_ip=edge_ip,
                tg_user_id=user_id,
                username=username
            )

            if success:
                # 生成访问 URL
                access_url = f"{self.config.base_url.rstrip('/')}/{random_path}"

                response_text = f"""
✅ **文件直链生成成功！**

📁 文件名: `{filename}`
📏 大小: {file_size / 1024 / 1024:.2f} MB
🔗 直链: `{access_url}`

---

⚠️ 请妥善保存此直链
"""
                # 编辑原消息为成功状态
                try:
                    self.bot.edit_message_text(
                        chat_id=processing_msg.chat.id,
                        message_id=processing_msg.message_id,
                        text=response_text,
                        parse_mode='Markdown'
                    )
                except Exception as e:
                    logger.warning(f"编辑消息失败，尝试发送新消息: {e}")
                    self.bot.reply_to(message, response_text, parse_mode='Markdown')
                logger.info(f"文件直链生成成功: {random_path}, 用户: {user_id}")
            else:
                # 编辑原消息为失败状态
                try:
                    self.bot.edit_message_text(
                        chat_id=processing_msg.chat.id,
                        message_id=processing_msg.message_id,
                        text=f"❌ {msg}"
                    )
                except Exception as e:
                    logger.warning(f"编辑消息失败，尝试发送新消息: {e}")
                    self.bot.reply_to(message, f"❌ {msg}")
                logger.error(f"文件直链生成失败: {msg}, 用户: {user_id}")
        finally:
            # 释放并发锁
            self.file_lock.release()

    def handle_text(self, message: types.Message):
        """
        处理文本消息

        Args:
            message: Telegram 消息对象
        """
        # 忽略命令消息（已被其他处理器处理）
        if message.text.startswith('/'):
            return

        # 提示用户发送文件
        self.bot.reply_to(
            message,
            "请转发文件给我以生成直链 📁\n\n发送 /help 查看使用说明"
        )


def main():
    """主函数"""
    # 加载配置
    config_path = os.path.join(os.path.dirname(__file__), 'data.json')
    config = Config(config_path)

    if not config.config:
        logger.error("配置加载失败，程序退出")
        sys.exit(1)

    # 创建并运行 Bot
    bot = TGBot(config)
    bot.start()


if __name__ == '__main__':
    main()
