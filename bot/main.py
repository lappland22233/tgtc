"""
Telegram Bot 主程序
用于管理 TG 图床系统的文件、IP 封禁等
"""
import os
import sys
import logging

from telegram.ext import (
    Application,
    CommandHandler,
)

from config import Config
from database import Database
from handlers import BotHandlers


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
        self.handlers = BotHandlers(self.db, config.admin_ids)
        self.application = None

    def run(self):
        """启动 Bot"""
        try:
            # 连接数据库
            if not self.db.connect():
                logger.error("数据库连接失败，程序退出")
                sys.exit(1)

            logger.info("数据库连接成功")

            # 创建 Application
            self.application = Application.builder().token(self.config.bot_token).post_init(self.handlers.post_init).build()

            # 注册命令处理器
            self.application.add_handler(CommandHandler("start", self.handlers.start_command))
            self.application.add_handler(CommandHandler("delete", self.handlers.delete_command))
            self.application.add_handler(CommandHandler("log", self.handlers.log_command))
            self.application.add_handler(CommandHandler("ban", self.handlers.ban_command))
            self.application.add_handler(CommandHandler("unban", self.handlers.unban_command))
            self.application.add_handler(CommandHandler("list_bans", self.handlers.list_bans_command))
            self.application.add_handler(CommandHandler("stats", self.handlers.stats_command))

            # 注册错误处理器
            self.application.add_error_handler(self.handlers.error_handler)

            # 启动 Bot
            logger.info("Bot 启动中...")
            from telegram import Update
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
    # 加载配置（当前目录的 data.json）
    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data.json')
    config = Config(config_path)

    if not config.config:
        logger.error("配置加载失败，程序退出")
        sys.exit(1)

    # 创建并运行 Bot
    bot = TGBot(config)
    bot.run()


if __name__ == '__main__':
    main()
