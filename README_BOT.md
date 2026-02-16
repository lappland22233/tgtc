# Telegram Bot 部署指南

## 一、环境准备

### 1. 安装 Python 3.9+

确保系统已安装 Python 3.9 或更高版本：

```bash
python --version
```

### 2. 创建虚拟环境（推荐）

```bash
python -m venv venv
```

### 3. 激活虚拟环境

Windows:
```bash
venv\Scripts\activate
```

Linux/Mac:
```bash
source venv/bin/activate
```

### 4. 安装依赖

```bash
pip install -r requirements.txt
```

## 二、数据库配置

### 1. 创建数据库

执行 `init_db.sql` 初始化数据库：

```bash
mysql -u root -p < init_db.sql
```

或在 MySQL 客户端中执行：

```sql
source /path/to/init_db.sql
```

### 2. 验证表创建

```sql
USE tg_imagebed;
SHOW TABLES;
```

应显示：
- `files`
- `banned_ips`

## 三、配置文件

### 1. 复制配置模板

```bash
cp data.json.example data.json
```

### 2. 编辑配置文件

编辑 `data.json`，填写以下信息：

```json
{
  "telegram": {
    "bot_token": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
    "channel_id": -1001234567890
  },
  "mysql": {
    "host": "localhost",
    "port": 3306,
    "username": "tg_imagebed",
    "password": "your_password",
    "database": "tg_imagebed",
    "max_open_conns": 100,
    "max_idle_conns": 10,
    "conn_max_lifetime": 3600
  },
  "admin": {
    "user_ids": [123456789, 987654321]
  }
}
```

#### 配置说明：

- **telegram.bot_token**: Telegram Bot Token，从 [@BotFather](https://t.me/BotFather) 获取
- **telegram.channel_id**: 频道或群组 ID（用于存储文件），负数为频道，正数为群组
- **mysql**: MySQL 数据库连接信息
- **admin.user_ids**: 管理员 Telegram ID 列表，可从 [@userinfobot](https://t.me/userinfobot) 获取

## 四、启动 Bot

### 前台运行

```bash
python bot.py
```

### 后台运行（Linux）

使用 nohup:

```bash
nohup python bot.py > bot.log 2>&1 &
```

使用 systemd（推荐）：

创建 `/etc/systemd/system/tg-imagebed-bot.service`:

```ini
[Unit]
Description=Telegram Image Bed Bot
After=network.target mysql.service

[Service]
Type=simple
User=your_user
WorkingDirectory=/path/to/TG图床
Environment="PATH=/path/to/TG图床/venv/bin"
ExecStart=/path/to/TG图床/venv/bin/python bot.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable tg-imagebed-bot
sudo systemctl start tg-imagebed-bot
sudo systemctl status tg-imagebed-bot
```

## 五、Bot 命令使用

### /start
显示帮助信息和命令列表

### /delete <path>
删除指定路径的文件

示例:
```
/delete abc123xyz456
```

### /ban <ip> [reason]
封禁 IP 地址

示例:
```
/ban 192.168.1.1 恶意访问
```

### /unban <ip>
解封 IP 地址

示例:
```
/unban 192.168.1.1
```

### /list_bans
查看封禁 IP 列表（最近100条）

### /stats
查看系统统计信息：
- 总文件数
- 今日上传数
- 今日访问量
- 缓存文件数
- 缓存命中率
- 封禁 IP 数

## 六、日志查看

Bot 运行日志保存在 `bot.log`：

```bash
# 实时查看日志
tail -f bot.log

# 查看最近100行
tail -n 100 bot.log

# 搜索错误
grep ERROR bot.log
```

## 七、权限管理

添加新管理员：

1. 编辑 `data.json`
2. 在 `admin.user_ids` 中添加新的 Telegram ID
3. 重启 Bot

## 八、常见问题

### 1. Bot 无响应
- 检查 `data.json` 配置是否正确
- 检查数据库连接是否正常
- 查看 `bot.log` 错误日志

### 2. 命令无权限
- 确认您的 Telegram ID 在 `admin.user_ids` 列表中
- 使用 [@userinfobot](https://t.me/userinfobot) 获取您的 ID

### 3. 数据库连接失败
- 检查 MySQL 服务是否运行
- 验证数据库用户名和密码
- 确认防火墙未阻止连接

### 4. Bot Token 无效
- 从 [@BotFather](https://t.me/BotFather) 重新生成 Token
- 更新 `data.json` 中的配置

## 九、安全建议

1. **保护配置文件**: 确保 `data.json` 文件权限设置正确（仅允许所有者读取）
2. **使用强密码**: MySQL 数据库密码应足够复杂
3. **限制管理员**: 仅将必要的用户添加到管理员列表
4. **定期备份**: 定期备份数据库数据
5. **监控日志**: 定期检查 `bot.log` 查找异常活动

## 十、维护命令

### 重启 Bot

```bash
# 使用 systemd
sudo systemctl restart tg-imagebed-bot

# 手动重启
pkill -f "python bot.py"
python bot.py
```

### 查看连接数

```sql
-- 查看 MySQL 连接数
SHOW PROCESSLIST;

-- 查看文件统计
SELECT status, COUNT(*) as count FROM files GROUP BY status;

-- 查看封禁 IP 数
SELECT COUNT(*) as count FROM banned_ips;
```
