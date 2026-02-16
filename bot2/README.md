# Bot2 - TG 文件直链生成器

## 功能说明

Bot2 接收用户转发的文件，生成可访问的直链。具有以下特性：

- 🔒 白名单权限管理，仅授权用户可生成直链
- 📁 支持文档、图片、视频、音频、语音等所有文件类型
- 🌐 自定义域名直链，格式与主项目一致
- 💾 文件缓存机制，提高访问速度
- 🛡️ IP 封禁功能，防止滥用

## 系统架构

```
用户 → Bot (文件转发) → Bot2 (生成直链) → Database (存储)
                                    ↓
                               HTTP Server (提供访问)
                                    ↓
                            Telegram (文件存储)
```

## 安装步骤

### 1. 数据库初始化

```bash
# 执行 SQL 脚本创建白名单表
mysql -u root -p tgtc < init_db.sql
```

### 2. 创建 Bot Token

1. 访问 [@BotFather](https://t.me/BotFather)
2. 创建新 Bot：`/newbot`
3. 记录生成的 Bot Token

### 3. 配置文件

复制配置模板：
```bash
cp data.json.example data.json
```

编辑 `data.json`：
```json
{
  "telegram": {
    "bot_token": "你的_BOT_TOKEN",
    "bot_api_url": "http://127.0.0.1:8081"
  },
  "mysql": {
    "host": "localhost",
    "port": 3306,
    "username": "tg_imagebed",
    "password": "your_password",
    "database": "tgtc"
  },
  "admin": {
    "user_ids": [123456789]
  },
  "server": {
    "listen_addr": ":8082",
    "base_url": "https://your-domain.com"
  }
}
```

### 4. 安装依赖

```bash
# Bot 依赖
pip install -r requirements.txt

# HTTP Server 依赖
pip install flask requests
```

### 5. 启动服务

```bash
# 启动 Bot（接收文件）
python bot.py

# 启动 HTTP Server（提供文件访问）
python server.py
```

### 6. 使用 Systemd 管理（可选）

创建服务文件 `/etc/systemd/system/bot2.service`：
```ini
[Unit]
Description=Bot2 - TG File Link Generator
After=network.target mysql.service

[Service]
Type=simple
User=root
WorkingDirectory=/path/to/bot2
Environment="PATH=/usr/local/bin:/usr/bin:/bin"
ExecStart=/usr/bin/python3 /path/to/bot2/bot.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

创建服务文件 `/etc/systemd/system/bot2-server.service`：
```ini
[Unit]
Description=Bot2 HTTP Server
After=network.target mysql.service

[Service]
Type=simple
User=root
WorkingDirectory=/path/to/bot2
Environment="PATH=/usr/local/bin:/usr/bin:/bin"
ExecStart=/usr/bin/python3 /path/to/bot2/server.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

启动服务：
```bash
systemctl daemon-reload
systemctl start bot2 bot2-server
systemctl enable bot2 bot2-server
```

## 使用方法

### 生成直链

1. 将 Bot 添加到白名单（需要管理员操作）
2. 转发任意文件给 Bot
3. Bot 返回可访问的直链

### 管理命令

| 命令 | 说明 | 权限 |
|------|------|------|
| `/start` | 显示帮助信息 | 所有用户 |
| `/help` | 查看使用说明 | 所有用户 |
| `/link` | 查看直链生成方法 | 所有用户 |
| `/add <user_id>` | 添加用户到白名单 | 管理员 |
| `/remove <user_id>` | 从白名单移除用户 | 管理员 |
| `/list` | 查看白名单列表 | 管理员 |
| `/stats` | 查看统计信息 | 管理员 |

### API 接口

#### 访问文件

```
GET https://your-domain.com/{random_path}
```

示例：
```
GET https://your-domain.com/abc123def456...
```

响应：
- 成功：返回文件内容（支持在线预览）
- 失败：返回 404 Not Found

## 数据库结构

### whitelist 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT | 主键 ID |
| tg_user_id | BIGINT | Telegram 用户 ID（唯一） |
| username | VARCHAR(255) | Telegram 用户名 |
| added_by | BIGINT | 添加者用户 ID |
| added_at | DATETIME | 添加时间 |
| status | ENUM | 状态：active/removed |

## 配置说明

### telegram.bot_token
Bot Token 从 @BotFather 获取

### telegram.bot_api_url
自建 Bot API 服务器地址，例如：`http://127.0.0.1:8081`

### mysql
数据库配置，与主项目共用同一个数据库

### admin.user_ids
管理员用户 ID 列表，只有管理员可以管理白名单

### server.listen_addr
HTTP 服务监听地址，例如：`:8082`

### server.base_url
访问域名，用于生成文件直链

## 日志文件

- `bot2.log`: Bot 运行日志
- `bot2_server.log`: HTTP Server 运行日志

## 故障排查

### Bot 无法启动
- 检查 `data.json` 配置是否正确
- 确认数据库连接正常
- 查看 `bot2.log` 日志

### 文件无法访问
- 检查 HTTP Server 是否运行
- 确认缓存目录 `/data/cache` 有写入权限
- 查看 `bot2_server.log` 日志

### 权限不足
- 确认用户 ID 在白名单中
- 使用 `/list` 命令查看白名单

## 安全建议

1. 使用 Nginx 反向代理提供 HTTPS
2. 限制 IP 白名单访问
3. 定期检查日志文件
4. 启用 IP 封禁功能防止滥用

## 注意事项

- Bot 和 HTTP Server 需要同时运行
- 缓存目录 `/data/cache` 需要足够的磁盘空间
- 直链格式与主项目保持一致
- 自建 Bot API 必须使用 `--local` 模式
