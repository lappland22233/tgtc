# TG图床

基于Telegram的文件上传服务，支持完整的后台管理系统。

## ✨ 特性

- 📤 **文件上传** - 上传文件到Telegram频道/群组
- 🎨 **美观界面** - 现代化的Web上传界面
- 🔒 **后台管理** - 完整的管理后台系统
- 📊 **数据统计** - 实时统计信息展示
- 🚫 **IP管理** - IP封禁和解封功能
- 💾 **数据库支持** - MySQL数据库存储
- 🔄 **多语言** - 支持Go和Python两种实现
- 🚀 **高性能** - 本地缓存，快速响应

## 📦 包含内容

### Go版本（主要）
- 完整的HTTP服务器
- 后台管理系统
- IP封禁功能
- 统计信息API
- 文件管理接口

### Python版本
- **bot/** - Telegram机器人版本
- **bot2/** - Web服务器版本

## 🚀 快速开始

### 前置要求

- Go 1.19+
- MySQL 5.7+
- Telegram Bot Token

### 安装步骤

1. **克隆仓库**
```bash
git clone https://github.com/YOUR_USERNAME/tg-imagebed.git
cd tg-imagebed
```

2. **配置数据库**
```bash
# 复制配置文件模板
cp data.json.example data.json

# 编辑配置文件
nano data.json
```

配置内容：
```json
{
  "telegram": {
    "bot_token": "YOUR_BOT_TOKEN",
    "channel_id": "-1001234567890"
  },
  "mysql": {
    "host": "localhost",
    "port": 3306,
    "username": "your_username",
    "password": "your_password",
    "database": "tg_imagebed"
  },
  "admin": {
    "user_ids": [123456789]
  }
}
```

3. **初始化数据库**
```bash
bash init-db.sh
```

4. **修改管理员密码**
编辑 `main.go` 中的 `adminUser/adminPass` 默认值。

5. **编译程序**
```bash
./build-with-admin.sh
# 或手动编译
go build -o tg-imagebed
```

6. **运行程序**
```bash
./tg-imagebed
```

### 访问服务

- **上传界面**: http://localhost:8080/upload.html
- **管理后台**: http://localhost:8080/admin.html
- **默认凭据**: admin / changeme123 ⚠️ 请务必修改！

## 📚 文档

项目说明已统一合并到本 `README.md`，请优先参考下文的「统一说明」「更新日志」「保留数据迁移流程」章节。

## 🌟 后台管理功能

### 统计面板
- 📊 总文件数
- 📈 今日上传数
- 👥 今日访问数
- 🔒 封禁IP数量
- 💾 缓存命中率

### 文件管理
- 📋 文件列表（分页显示）
- 🔍 按IP搜索
- 👁️ 在线预览
- 🗑️ 删除文件
- 🚫 封禁上传IP

### IP管理
- 🔐 封禁IP地址
- ✅ 解封IP地址
- 📋 查看封禁列表
- 📝 封禁原因记录

## 🔗 API接口

### 统计信息
```bash
GET /api/stats
Authorization: Basic base64(username:password)
```

### 文件列表
```bash
GET /api/files?page=1&ip=1.2.3.4
Authorization: Basic base64(username:password)
```

### 封禁IP
```bash
POST /api/ban
Authorization: Basic base64(username:password)
Content-Type: application/json

{
  "ip": "1.2.3.4",
  "reason": "恶意上传"
}
```

详见 [admin/README.md](admin/README.md)

## 🔐 安全建议

1. ✅ **修改默认密码** - 编辑 `main.go` 中的 `adminUser/adminPass`
2. 🔒 **使用HTTPS** - 配置Nginx反向代理
3. 🛡️ **启用IP白名单** - 限制管理后台访问
4. 💾 **定期备份** - 备份数据库和配置
5. 📊 **监控日志** - 定期查看访问日志

## 📁 项目结构

```
tg-imagebed/
├── admin/                    # 后台管理前端
│   ├── index.html           # 前端界面
│   └── README.md            # 使用说明（后端逻辑已并入 main.go）
├── bot/                     # Python Bot版本
│   ├── bot.py
│   ├── config.py
│   └── requirements.txt
├── bot2/                    # Python Server版本
│   ├── server.py
│   ├── server2.go
│   └── requirements.txt
├── main.go                  # Go主程序
├── go.mod                   # Go模块配置
├── data.json.example        # 配置文件模板
├── init-db.sh               # 数据库初始化脚本
├── build-with-admin.sh      # 编译脚本
└── README.md                # 本文件
```

## 🛠️ 开发

### 本地开发

```bash
# 安装依赖
go mod download

# 运行开发服务器
go run main.go

# 热重载（需要air）
air
```

### 测试

```bash
# 测试API
curl -u admin:password http://localhost:8080/api/stats

# 测试上传
curl -X POST -F "file=@test.jpg" http://localhost:8080/upload
```

## 🚀 部署

### 使用Systemd

```bash
# 复制服务文件
sudo cp telegram-bot-api.service /etc/systemd/system/

# 启动服务
sudo systemctl start tg-imagebed
sudo systemctl enable tg-imagebed
```

### 使用Docker

```bash
# 构建镜像
docker build -t tg-imagebed .

# 运行容器
docker run -d -p 8080:8080 tg-imagebed
```

部署说明已合并到本 README 的「统一说明（已合并）」章节

## 📄 许可证

MIT License

## 🙏 致谢

- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Go](https://go.dev/)
- [MySQL](https://www.mysql.com/)

## 📞 支持

- 📧 提交Issue报告问题
- 💬 查看文档获取帮助
- 🌟 给项目点个Star

---

**注意**: 本项目仅供学习和个人使用，请勿用于非法用途。

## 📘 统一说明（已合并）

> 已将原先分散的部署、后台、反向代理、频道 ID 获取等说明整合到本 README，后续以本文件为主进行维护。

### 后台管理快速使用

1. 修改 `main.go` 中默认账号密码（务必修改）。
2. 编译并启动服务：`go build -o tg-imagebed && ./tg-imagebed`。
3. 访问后台：`http://localhost:8080/admin.html`。
4. 常用接口：`/api/stats`、`/api/files`、`/api/ban`、`/api/unban`、`/api/delete`。

### Debian 12 部署精简步骤

```bash
# 1) 安装依赖
sudo apt update
sudo apt install -y golang-go mysql-server nginx

# 2) 初始化数据库（会保留已有数据）
cp data.json.example data.json
bash init-db.sh

# 3) 编译并运行
go build -o tg-imagebed
./tg-imagebed
```

### 反向代理（Nginx 最小配置）

```nginx
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 20M;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header EO-Client-IP $remote_addr;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```


### 统一管理脚本（推荐）

已提供 `manage.sh` 统一管理以下操作：编译、启动、停止、重启、依赖安装、数据库初始化/迁移、运行状态检查、日志查看、数据包备份。

```bash
# 查看帮助
bash manage.sh --help

# 安装依赖
bash manage.sh install-deps

# 初始化/迁移数据库
bash manage.sh init-db

# 编译
bash manage.sh build

# 启动 / 停止 / 重启 / 状态
bash manage.sh start
bash manage.sh stop
bash manage.sh restart
bash manage.sh status

# 查看日志（tail -f）
bash manage.sh logs

# 备份（配置 + 日志 + 可选数据库导出）
bash manage.sh backup
```

### 获取 Telegram 频道 ID

1. 将机器人加入目标频道并授予发送消息权限。
2. 向频道发送一条测试消息。
3. 使用 `https://api.telegram.org/bot<token>/getUpdates` 查看更新。
4. 在返回 JSON 中找到 `chat.id`（一般为 `-100` 开头），填入 `data.json`。

## 🧾 更新日志（主说明文件）

- **2026-02-16**
  - 新增：统一迁移 SQL `init_db.go.sql`，用于 Go 版本数据库初始化与兼容迁移。
  - 优化：`init-db.sh` 改为使用 Python 解析 `data.json`，避免原正则解析 JSON 不稳定问题。
  - 优化：`init-db.sh` 增加 SQL 文件存在性检查、关键字段校验与幂等迁移执行。
  - 文档：将分散说明整合进主 README，并在此处持续记录新增功能与运维改动。
  - 新增：`manage.sh` 统一管理脚本，整合启动/停止/重启/安装依赖/数据库初始化。
  - 新增：`manage.sh backup` 数据包备份功能（配置、日志、可选数据库导出）。
  - 修复：`init-db.sh` 始终读取脚本目录下的 `data.json`，避免跨目录执行误读配置。
  - 兼容：迁移 SQL 中移除 `DEFAULT (CURRENT_TIMESTAMP + INTERVAL ...)`，适配 MySQL 5.7。
  - 规范：继续统一 `.sh` 脚本 shebang / LF 行尾 / 入口行为。
  - 规范：新增 `.gitattributes` 固定行尾策略，避免 CRLF 引发脚本问题。

## 🛡️ 保留数据迁移流程

> 目标：升级表结构时不丢失历史文件数据、访问统计和封禁记录。

### 1) 迁移前检查

```bash
# 备份数据库（强烈建议）
mysqldump -h<host> -P<port> -u<user> -p <database> > backup_before_migration.sql

# 确认配置
cp data.json.example data.json  # 如未创建
nano data.json
```

### 2) 执行迁移（幂等）

```bash
bash init-db.sh
```

### 3) 迁移后验证

```bash
# 验证核心表是否存在
mysql -h<host> -P<port> -u<user> -p <database> -e "SHOW TABLES LIKE 'files';"
mysql -h<host> -P<port> -u<user> -p <database> -e "SHOW TABLES LIKE 'banned_ips';"

# 验证新增字段
mysql -h<host> -P<port> -u<user> -p <database> -e "SHOW COLUMNS FROM files LIKE 'file_name';"
mysql -h<host> -P<port> -u<user> -p <database> -e "SHOW COLUMNS FROM files LIKE 'delete_reason';"
```

### 4) 回滚策略

```bash
# 若迁移后出现异常，可用备份恢复
mysql -h<host> -P<port> -u<user> -p <database> < backup_before_migration.sql
```

