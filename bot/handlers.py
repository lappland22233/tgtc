"""
命令处理器模块
"""
import logging
from datetime import datetime
from telegram import Update, BotCommand
from telegram.ext import ContextTypes

logger = logging.getLogger(__name__)


class BotHandlers:
    """Bot 命令处理器集合"""

    def __init__(self, db, admin_ids):
        """
        初始化处理器

        Args:
            db: 数据库实例
            admin_ids: 管理员 ID 集合
        """
        self.db = db
        self.admin_ids = admin_ids

    def check_admin(self, user_id: int) -> bool:
        """检查用户是否为管理员"""
        return user_id in self.admin_ids

    async def start_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """/start 命令处理器"""
        user_id = update.effective_user.id

        if not self.check_admin(user_id):
            await update.message.reply_text("⚠️ 权限不足：此功能仅限管理员使用")
            return

        help_text = """
🤖 **TG 图床管理 Bot** 命令列表：

📋 **文件管理**
`/delete <path>` - 删除指定路径的文件
`/log [limit]` - 查看上传日志

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
        """/delete 命令处理器"""
        user_id = update.effective_user.id

        if not self.check_admin(user_id):
            await update.message.reply_text("⚠️ 权限不足")
            return

        if not context.args or len(context.args) != 1:
            await update.message.reply_text(
                "❌ 用法错误\n\n正确用法: `/delete <path>`\n\n示例: `/delete abc123xyz`",
                parse_mode='Markdown'
            )
            return

        random_path = context.args[0].strip()

        if len(random_path) < 16 or len(random_path) > 24:
            await update.message.reply_text("❌ 路径格式错误\n\n路径应为 16-24 位的字母数字组合")
            return

        success, message = self.db.delete_file_by_path(random_path)

        if success:
            await update.message.reply_text(f"✅ {message}\n\n路径: `{random_path}`", parse_mode='Markdown')
        else:
            await update.message.reply_text(f"❌ {message}")

    async def ban_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """/ban 命令处理器"""
        user_id = update.effective_user.id

        if not self.check_admin(user_id):
            await update.message.reply_text("⚠️ 权限不足")
            return

        if not context.args or len(context.args) < 1:
            await update.message.reply_text(
                "❌ 用法错误\n\n正确用法: `/ban <ip> [reason]`\n\n"
                "示例: `/ban 192.168.1.1 恶意访问`",
                parse_mode='Markdown'
            )
            return

        ip_str = context.args[0].strip()
        reason = ' '.join(context.args[1:]) if len(context.args) > 1 else ""

        success, message = self.db.ban_ip(ip_str, reason)

        if success:
            reason_text = f"\n原因: {reason}" if reason else ""
            await update.message.reply_text(f"✅ {message}{reason_text}")
        else:
            await update.message.reply_text(f"❌ {message}")

    async def unban_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """/unban 命令处理器"""
        user_id = update.effective_user.id

        if not self.check_admin(user_id):
            await update.message.reply_text("⚠️ 权限不足")
            return

        if not context.args or len(context.args) != 1:
            await update.message.reply_text(
                "❌ 用法错误\n\n正确用法: `/unban <ip>`\n\n"
                "示例: `/unban 192.168.1.1`",
                parse_mode='Markdown'
            )
            return

        ip_str = context.args[0].strip()

        success, message = self.db.unban_ip(ip_str)

        if success:
            await update.message.reply_text(f"✅ {message}")
        else:
            await update.message.reply_text(f"❌ {message}")

    async def list_bans_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """/list_bans 命令处理器"""
        user_id = update.effective_user.id

        if not self.check_admin(user_id):
            await update.message.reply_text("⚠️ 权限不足")
            return

        bans = self.db.get_banned_ips(limit=100)

        if not bans:
            await update.message.reply_text("📋 当前没有封禁的 IP")
            return

        lines = ["📋 **封禁 IP 列表** (最近100条)\n"]
        for i, ban in enumerate(bans, 1):
            reason = f"\n   原因: {ban['reason']}" if ban['reason'] else ""
            lines.append(f"{i}. `{ban['ip']}`\n   封禁时间: {ban['banned_at']}{reason}")

        text = "\n".join(lines)
        await update.message.reply_text(text, parse_mode='Markdown')

    async def stats_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """/stats 命令处理器"""
        user_id = update.effective_user.id

        if not self.check_admin(user_id):
            await update.message.reply_text("⚠️ 权限不足")
            return

        stats = self.db.get_stats()

        if not stats:
            await update.message.reply_text("❌ 获取统计信息失败")
            return

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

    async def log_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """/log 命令处理器 - 查看上传日志"""
        user_id = update.effective_user.id

        if not self.check_admin(user_id):
            await update.message.reply_text("⚠️ 权限不足")
            return

        limit = 20
        if context.args and len(context.args) >= 1:
            try:
                limit = min(100, max(1, int(context.args[0])))
            except ValueError:
                await update.message.reply_text("❌ 参数错误，limit 必须是数字")
                return

        logs = self.db.get_upload_logs(limit)

        if not logs:
            await update.message.reply_text("📋 暂无上传日志")
            return

        lines = [f"📋 上传日志 (最近 {limit} 条)\n"]
        for i, log in enumerate(logs, 1):
            lines.append(
                f"{i}. {log['random_path']}\n"
                f"   文件: {log['file_name']}\n"
                f"   大小: {log['file_size']} bytes\n"
                f"   类型: {log['mime_type']}\n"
                f"   上传IP: {log['upload_ip']}\n"
                f"   上传时间: {log['created_at']}\n"
            )

        text = "\n".join(lines)
        await update.message.reply_text(text)

    async def error_handler(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """错误处理器"""
        logger.error(f"Bot 错误: {context.error}", exc_info=context.error)

        if update and update.effective_message:
            try:
                await update.effective_message.reply_text(
                    "❌ 处理请求时发生错误，请联系管理员"
                )
            except Exception:
                pass

    async def post_init(self, application):
        """应用初始化后的回调，设置命令菜单"""
        commands = [
            BotCommand("start", "显示帮助信息"),
            BotCommand("delete", "删除文件"),
            BotCommand("log", "查看上传日志"),
            BotCommand("ban", "封禁 IP"),
            BotCommand("unban", "解封 IP"),
            BotCommand("list_bans", "查看封禁列表"),
            BotCommand("stats", "查看统计信息"),
        ]
        await application.bot.set_my_commands(commands)
        logger.info("Bot 命令菜单设置成功")
