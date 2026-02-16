# Debian 12 部署 Telegram Bot API 服务器

## 前置准备

### 1. 获取 API ID 和 API Hash
1. 访问 https://my.telegram.org/apps
2. 登录你的 Telegram 账号
3. 填写应用信息获取 `api_id` 和 `api_hash`

### 2. 系统要求
- Debian 12 系统
- 至少 1GB 可用磁盘空间
- 至少 512MB RAM
- root 或 sudo 权限

---

## 部署步骤

### 第一步：安装依赖

```bash
# 更新系统
sudo apt update && sudo apt upgrade -y

# 安装编译依赖
sudo apt install -y build-essential cmake git zlib1g-dev libssl-dev gperf
```

依赖说明：
- `build-essential`: GCC 编译器等基础编译工具
- `cmake`: 构建工具
- `git`: 版本控制
- `zlib1g-dev`: 压缩库
- `libssl-dev`: OpenSSL 开发库
- `gperf`: 性能优化工具

### 第二步：克隆并编译源码

```bash
# 克隆仓库（包含子模块）
cd /opt
sudo git clone --recursive https://github.com/tdlib/telegram-bot-api.git
cd telegram-bot-api

# 创建构建目录
mkdir build
cd build

# 使用 CMake 配置（Release 版本）
sudo cmake -DCMAKE_BUILD_TYPE=Release ..

# 编译并安装
sudo cmake --build . --target install
```

编译时间：根据服务器性能，可能需要 10-30 分钟

### 第三步：验证安装

```bash
# 检查可执行文件
telegram-bot-api --help
```

正常情况下会显示帮助信息和可用选项。

### 第四步：创建配置文件

```bash
# 创建配置目录
sudo mkdir -p /etc/telegram-bot-api

# 创建环境变量配置文件
sudo nano /etc/telegram-bot-api/.env
```

添加以下内容（替换你的 API 凭证）：
```env
TELEGRAM_API_ID=你的_api_id
TELEGRAM_API_HASH=你的_api_hash
```

保存并退出（Ctrl+O 保存，Ctrl+X 退出）

### 第五步：启动服务

#### 方式一：手动启动（测试）

```bash
# 加载环境变量
export TELEGRAM_API_ID=你的_api_id
export TELEGRAM_API_HASH=你的_api_hash

# 启动服务（local 模式，支持更多功能）
telegram-bot-api --local
```

服务默认监听端口：`8081`

#### 方式二：使用 systemd 管理（推荐）

创建 systemd 服务文件：
```bash
sudo nano /etc/systemd/system/telegram-bot-api.service
```

添加以下内容：
```ini
[Unit]
Description=Telegram Bot API Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/telegram-bot-api
Environment="TELEGRAM_API_ID=你的_api_id"
Environment="TELEGRAM_API_HASH=你的_api_hash"
ExecStart=/usr/local/bin/telegram-bot-api --local
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

启动并启用服务：
```bash
# 重新加载 systemd
sudo systemctl daemon-reload

# 启动服务
sudo systemctl start telegram-bot-api

# 设置开机自启
sudo systemctl enable telegram-bot-api

# 查看服务状态
sudo systemctl status telegram-bot-api
```

### 第六步：配置防火墙

```bash
# 如果使用 UFW 防火墙
sudo ufw allow 8081/tcp

# 或者使用 iptables
sudo iptables -A INPUT -p tcp --dport 8081 -j ACCEPT
sudo iptables-save > /etc/iptables/rules.v4
```

---

## 使用方法

### 基本用法

你的 Bot API 服务器地址现在是：
```
http://你的服务器IP:8081
```

### 配置 Telegram Bot

在你的 Bot 代码中将 API 地址从：
```
https://api.telegram.org
```
改为：
```
http://你的服务器IP:8081
```

#### Python 示例：
```python
import telebot

bot = telebot.TeleBot('你的_BOT_TOKEN', api_url='http://你的服务器IP:8081')

@bot.message_handler(commands=['start'])
def start(message):
    bot.send_message(message.chat.id, 'Hello!')

bot.polling()
```

#### Go 示例：
```go
bot, err := tgbotapi.NewBotAPIWithAPIEndpoint("你的_BOT_TOKEN", "http://你的服务器IP:8081")
```

### 本地模式特性

使用 `--local` 参数后，你的 Bot API 服务器支持：

- ✅ 无限制下载文件大小
- ✅ 上传文件最大 2000 MB
- ✅ 使用本地路径上传文件
- ✅ 支持本地 IP 的 webhook
- ✅ 使用任意端口的 webhook
- ✅ 最大 100,000 个 webhook 连接
- ✅ 返回文件的绝对本地路径

---

## 高级配置

### 自定义端口

修改启动参数：
```bash
telegram-bot-api --local --http-port=自定义端口
```

### 日志配置

```bash
# 指定日志级别
telegram-bot-api --local --log-level=INFO

# 指定日志文件
telegram-bot-api --local --log=/var/log/telegram-bot-api.log
```

### 性能调优

```bash
# 设置临时目录
telegram-bot-api --local --temp-dir=/tmp/telegram

# 设置 HTTP 线程数（默认 4）
telegram-bot-api --local --http-statistics-port=8082
```

---

## 故障排查

### 检查服务状态
```bash
sudo systemctl status telegram-bot-api
```

### 查看日志
```bash
# systemd 日志
sudo journalctl -u telegram-bot-api -f

# 自定义日志文件
tail -f /var/log/telegram-bot-api.log
```

### 常见问题

**1. 端口被占用**
```bash
# 查看占用 8081 端口的进程
sudo lsof -i :8081
# 或
sudo netstat -tulpn | grep 8081
```

**2. API 凭证错误**
确保 `api_id` 和 `api_hash` 正确，且从 my.telegram.org 获取。

**3. 编译失败**
确保所有依赖已正确安装：
```bash
sudo apt install --reinstall build-essential cmake git zlib1g-dev libssl-dev gperf
```

**4. Bot 无法连接**
- 检查防火墙设置
- 确认服务器 IP 正确
- 验证端口 8081 可访问：
  ```bash
  curl http://localhost:8081/getMe
  ```

---

## 更新服务器

```bash
# 停止服务
sudo systemctl stop telegram-bot-api

# 更新代码
cd /opt/telegram-bot-api
sudo git pull --recurse-submodules

# 重新编译
cd build
sudo cmake --build . --target install

# 启动服务
sudo systemctl start telegram-bot-api
```

---

## 卸载

```bash
# 停止并禁用服务
sudo systemctl stop telegram-bot-api
sudo systemctl disable telegram-bot-api

# 删除服务文件
sudo rm /etc/systemd/system/telegram-bot-api.service
sudo systemctl daemon-reload

# 删除安装目录
sudo rm -rf /opt/telegram-bot-api

# 删除可执行文件
sudo rm /usr/local/bin/telegram-bot-api
```

---

## 安全建议

1. **使用反向代理**: 配置 Nginx 或 Caddy 提供 HTTPS
2. **限制访问**: 使用防火墙规则限制访问来源
3. **定期更新**: 保持系统和软件最新
4. **监控日志**: 定期检查异常访问

---

## 参考资源

- 官方文档: https://core.telegram.org/bots/api
- 构建生成器: https://tdlib.github.io/telegram-bot-api/build.html
- 问题反馈: [@BotSupport](https://t.me/BotSupport)
- 新闻更新: [@BotNews](https://t.me/botnews)
