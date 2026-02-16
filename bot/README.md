# TG 图床 Bot 管理端

独立的 Telegram Bot 管理模块，用于管理 TG 图床系统的文件、IP 封禁等。

## 功能特性

- 📋 文件管理：删除指定路径的文件
- 🔒 IP 管理：封禁/解封 IP 地址，查看封禁列表
- 📊 统计信息：查看系统统计数据
- 🤖 Telegram Bot 集成：命令式交互

## 目录结构

```
bot/
├── __init__.py      # 模块初始化
├── main.py          # Bot 主程序
├── config.py        # 配置管理
├── database.py      # 数据库操作
├── handlers.py      # 命令处理器
└── requirements.txt # Python 依赖
```

## 安装依赖

```bash
cd bot
pip install -r requirements.txt
```

## 运行 Bot

```bash
python -m bot.main
```

或者直接运行：

```bash
python bot/main.py
```

## 命令列表

| 命令 | 描述 | 示例 |
|------|------|------|
| `/start` | 显示帮助信息 | - |
| `/delete <path>` | 删除文件 | `/delete abc123xyz` |
| `/ban <ip> [reason]` | 封禁 IP | `/ban 192.168.1.1 恶意访问` |
| `/unban <ip>` | 解封 IP | `/unban 192.168.1.1` |
| `/list_bans` | 查看封禁列表 | - |
| `/stats` | 查看统计信息 | - |

## 配置文件

Bot 使用项目根目录的 `data.json` 配置文件，需要包含以下配置：

```json
{
  "telegram": {
    "bot_token": "your_bot_token",
    "channel_id": 1234567890
  },
  "mysql": {
    "host": "localhost",
    "port": 3306,
    "username": "user",
    "password": "password",
    "database": "tgtc"
  },
  "admin": {
    "user_ids": [123456789]
  }
}
```

## 注意事项

- 所有管理命令需要管理员权限
- IP 地址格式验证严格，仅支持有效的 IPv4/IPv6 地址
- 日志文件为 `bot.log`
