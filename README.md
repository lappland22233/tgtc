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
# Linux/Mac
bash init-db.sh

# Windows
init-db.bat
```

4. **修改管理员密码**
编辑 `admin/auth.go`:
```go
AdminUsername = "admin"
AdminPassword = "your-strong-password"  // ⚠️ 务必修改
```

5. **编译程序**
```bash
# Linux/Mac
./build-with-admin.sh

# Windows
build-with-admin.bat

# 或手动编译
go build -o tg-imagebed
```

6. **运行程序**
```bash
./tg-imagebed          # Linux/Mac
tg-imagebed.exe        # Windows
```

### 访问服务

- **上传界面**: http://localhost:8080/upload.html
- **管理后台**: http://localhost:8080/admin.html
- **默认凭据**: admin / changeme123 ⚠️ 请务必修改！

## 📚 文档

| 文档 | 说明 |
|------|------|
| [admin/README.md](admin/README.md) | 后台管理模块文档 |
| [ADMIN_QUICKSTART.md](ADMIN_QUICKSTART.md) | 快速入门指南 |
| [DEBIAN12_DEPLOY.md](DEBIAN12_DEPLOY.md) | Debian 12部署指南 |
| [GET_CHANNEL_ID.md](GET_CHANNEL_ID.md) | 获取频道ID指南 |
| [REVERSE_PROXY.md](REVERSE_PROXY.md) | 反向代理配置 |

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

1. ✅ **修改默认密码** - 编辑 `admin/auth.go`
2. 🔒 **使用HTTPS** - 配置Nginx反向代理
3. 🛡️ **启用IP白名单** - 限制管理后台访问
4. 💾 **定期备份** - 备份数据库和配置
5. 📊 **监控日志** - 定期查看访问日志

## 📁 项目结构

```
tg-imagebed/
├── admin/                    # 后台管理模块
│   ├── index.html           # 前端界面
│   ├── api.go              # API接口
│   ├── auth.go             # 认证中间件
│   └── README.md           # 模块文档
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

详见 [DEBIAN12_DEPLOY.md](DEBIAN12_DEPLOY.md)

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
