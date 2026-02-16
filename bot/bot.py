"""
Telegram Bot 主程序
用于管理 TG 图床系统的文件、IP 封禁等
"""
import os
import sys
import json
import asyncio
from datetime import datetime, timedelta
from typing import Dict, Any, List
import logging

from telegram import Update, BotCommand
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    ConversationHandler,
    MessageHandler,
    filters
)

from database import Database


# 配置日志
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO,
    handlers=[
        logging.FileHandler('bot.log', encoding='utf-8'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)


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
                'telegram.channel_id',
                'mysql.host',
                'mysql.username',
                'mysql.password',
                'mysql.database',
                'admin.user_ids'
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
    def channel_id(self) -> int:
        return int(self.config['telegram']['channel_id'])

    @property
    def mysql_config(self) -> Dict[str, Any]:
        return self.config['mysql']

    @property
    def admin_ids(self) -> set:
        return set(self.config['admin']['user_ids'])


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
        self.application: Application = None

    def check_admin(self, user_id: int) -> bool:
        """
        检查用户是否为管理员

        Args:
            user_id: Telegram 用户 ID

        Returns:
            bool: 是否为管理员
        """
        return user_id in self.config.admin_ids

    async def start_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """
        /start 命令处理器

        Args:
            update: Telegram 更新对象
            context: 上下文对象
        """
        user_id = update.effective_user.id

        if not self.check_admin(user_id):
            await update.message.reply_text(
                "⚠️ 权限不足：此功能仅限管理员使用"
            )
            return

        help_text = """
🤖 **TG 图床管理 Bot** 命令列表：

📋 **文件管理**
`/delete <path>` - 删除指定路径的文件

🔒 **IP 管理**
`/ban <ip> [reason]` - 封禁 IP 地址
`/unban <ip>` - 解封 IP 地址
`/list_bans` - 查看封禁 IP 列表

📊 **统计信息**
`/stats` - 查看系统统计数据

ℹ️ **帮助**
`/start` - 显示帮助信息

---
所有操作需要管理员权限
        """
        await update.message.reply_text(help_text, parse_mode='Markdown')

    async def delete_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """
        /delete 命令处理器 - 删除文件

        Args:
            update: Telegram 更新对象
            context: 上下文对象
        """
        user_id = update.effective_user.id

        if not self.check_admin(user_id):
            await update.message.reply_text("⚠️ 权限不足")
            return

        # 检查参数
        if not context.args or len(context.args) != 1:
            await update.message.reply_text(
                "❌ 用法错误\n\n正确用法: `/delete <path>`\n\n示例: `/delete abc123xyz`",
                parse_mode='Markdown'
            )
            return

        random_path = context.args[0].strip()

        if len(random_path) < 16 or len(random_path) > 24:
            await update.message.reply_text(
                "❌ 路径格式错误\n\n路径应为 16-24 位的字母数字组合"
            )
            return

        # 执行删除
        success, message = self.db.delete_file_by_path(random_path)

        if success:
            await update.message.reply_text(
                f"✅ {message}\n\n路径: `{random_path}`",
                parse_mode='Markdown'
            )
        else:
            await update.message.reply_text(f"❌ {message}")

    async def ban_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """
        /ban 命令处理器 - 封禁 IP

        Args:
            update: Telegram 更新对象
            context: 上下文对象
        """
        user_id = update.effective_user.id

        if not self.check_admin(user_id):
            await update.message.reply_text("⚠️ 权限不足")
            return

        # 检查参数
        if not context.args or len(context.args) < 1:
            await update.message.reply_text(
                "❌ 用法错误\n\n正确用法: `/ban <ip> [reason]`\n\n"
                "示例: `/ban 192.168.1.1 恶意访问`",
                parse_mode='Markdown'
            )
            return

        ip_str = context.args[0].strip()
        reason = ' '.join(context.args[1:]) if len(context.args) > 1 else ""

        # 执行封禁
        success, message = self.db.ban_ip(ip_str, reason)

        if success:
            reason_text = f"\n原因: {reason}" if reason else ""
            await update.message.reply_text(
                f"✅ {message}{reason_text}",
                parse_mode='Markdown'
            )
        else:
            await update.message.reply_text(f"❌ {message}")

    async def unban_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """
        /unban 命令处理器 - 解封 IP

        Args:
            update: Telegram 更新对象
            context: 上下文对象
        """
        user_id = update.effective_user.id

        if not self.check_admin(user_id):
            await update.message.reply_text("⚠️ 权限不足")
            return

        # 检查参数
        if not context.args or len(context.args) != 1:
            await update.message.reply_text(
                "❌ 用法错误\n\n正确用法: `/unban <ip>`\n\n"
                "示例: `/unban 192.168.1.1`",
                parse_mode='Markdown'
            )
            return

        ip_str = context.args[0].strip()

        # 执行解封
        success, message = self.db.unban_ip(ip_str)

        if success:
            await update.message.reply_text(f"✅ {message}")
        else:
            await update.message.reply_text(f"❌ {message}")

    async def list_bans_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """
        /list_bans 命令处理器 - 查看封禁列表

        Args:
            update: Telegram 更新对象
            context: 上下文对象
        """
        user_id = update.effective_user.id

        if not self.check_admin(user_id):
            await update.message.reply_text("⚠️ 权限不足")
            return

        # 获取封禁列表
        bans = self.db.get_banned_ips(limit=100)

        if not bans:
            await update.message.reply_text("📋 当前没有封禁的 IP")
            return

        # 构建回复文本
        lines = ["📋 **封禁 IP 列表** (最近100条)\n"]
        for i, ban in enumerate(bans, 1):
            reason = f"\n   原因: {ban['reason']}" if ban['reason'] else ""
            lines.append(
                f"{i}. `{ban['ip']}`\n   封禁时间: {ban['banned_at']}{reason}"
            )

        text = "\n".join(lines)
        await update.message.reply_text(text, parse_mode='Markdown')

    async def stats_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """
        /stats 命令处理器 - 查看统计信息

        Args:
            update: Telegram 更新对象
            context: 上下文对象
        """
        user_id = update.effective_user.id

        if not self.check_admin(user_id):
            await update.message.reply_text("⚠️ 权限不足")
            return

        # 获取统计信息
        stats = self.db.get_stats()

        if not stats:
            await update.message.reply_text("❌ 获取统计信息失败")
            return

        # 构建回复文本
        text = f"""
📊 **系统统计信息**

📁 **文件统计**
• 总文件数: {stats['total_files']}
• 今日上传: {stats['today_uploads']}
• 今日访问: {stats['today_access']}

💾 **缓存统计**
• 缓存文件数: {stats['cached_files']}
• 缓存命中率: {stats['cache_hit_rate']}%

🔒 **安全统计**
• 封禁 IP 数: {stats['banned_ips']}

---
更新时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
"""
        await update.message.reply_text(text, parse_mode='Markdown')

    async def error_handler(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """
        错误处理器

        Args:
            update: Telegram 更新对象
            context: 上下文对象
        """
        logger.error(f"Bot 错误: {context.error}", exc_info=context.error)

        if update and update.effective_message:
            try:
                await update.effective_message.reply_text(
                    "❌ 处理请求时发生错误，请联系管理员"
                )
            except Exception:
                pass

    async def post_init(self, application: Application):
        """
        应用初始化后的回调，设置命令菜单

        Args:
            application: Application 对象
        """
        commands = [
            BotCommand("start", "显示帮助信息"),
            BotCommand("delete", "删除文件"),
            BotCommand("ban", "封禁 IP"),
            BotCommand("unban", "解封 IP"),
            BotCommand("list_bans", "查看封禁列表"),
            BotCommand("stats", "查看统计信息"),
        ]
        await application.bot.set_my_commands(commands)
        logger.info("Bot 命令菜单设置成功")

    def run(self):
        """启动 Bot"""
        try:
            # 连接数据库
            if not self.db.connect():
                logger.error("数据库连接失败，程序退出")
                sys.exit(1)

            logger.info("数据库连接成功")

            # 创建 Application
            self.application = Application.builder().token(self.config.bot_token).post_init(self.post_init).build()

            # 注册命令处理器
            self.application.add_handler(CommandHandler("start", self.start_command))
            self.application.add_handler(CommandHandler("delete", self.delete_command))
            self.application.add_handler(CommandHandler("ban", self.ban_command))
            self.application.add_handler(CommandHandler("unban", self.unban_command))
            self.application.add_handler(CommandHandler("list_bans", self.list_bans_command))
            self.application.add_handler(CommandHandler("stats", self.stats_command))

            # 注册错误处理器
            self.application.add_error_handler(self.error_handler)

            # 启动 Bot
            logger.info("Bot 启动中...")
            self.application.run_polling(allowed_updates=Update.ALL_TYPES)

        except KeyboardInterrupt:
            logger.info("收到中断信号，正在关闭 Bot...")
        except Exception as e:
            logger.error(f"Bot 运行错误: {e}", exc_info=True)
        finally:
            self.db.close()
            logger.info("Bot 已关闭")


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
    bot.run()


if __name__ == '__main__':
    main()
