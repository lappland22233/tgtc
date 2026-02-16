# Go HTTP 服务部署指南

## 一、环境准备

### 1. 安装 Go 1.21+

确保系统已安装 Go 1.21 或更高版本：

```bash
go version
```

### 2. 安装依赖

```bash
go mod tidy
```

## 二、数据库配置

### 1. 初始化数据库

执行 `init_db.go.sql`：

```bash
mysql -u root -p < init_db.go.sql
```

或在 MySQL 客户端中：

```sql
source /path/to/init_db.go.sql
```

### 2. 验证表创建

```sql
USE tg_imagebed;
SHOW TABLES;
```

## 三、配置文件

### 1. 复制配置模板

```bash
cp data.json.example data.json
```

### 2. 编辑配置文件

```json
{
  "telegram": {
    "bot_token": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
    "channel_id": "-1001234567890"
  },
  "mysql": {
    "host": "localhost",
    "port": 3306,
    "username": "tg_imagebed",
    "password": "your_password",
    "database": "tg_imagebed"
  },
  "admin": {
    "user_ids": [123456789, 987654321]
  }
}
```

#### 配置说明：

- **telegram.bot_token**: Telegram Bot Token
- **telegram.channel_id**: 频道ID（必须为负数）
- **mysql**: MySQL 连接配置
- **admin.user_ids**: 管理员 ID 列表（Go 服务中仅用于日志记录，实际管理通过 Python Bot）

## 四、编译运行

### 1. 编译

```bash
go build -o tg-imagebed main.go
```

### 2. 创建缓存目录

```bash
mkdir -p /data/cache
```

Windows:
```cmd
mkdir C:\data\cache
```

### 3. 运行

```bash
./tg-imagebed
```

或直接运行：

```bash
go run main.go
```

## 五、生产部署

### systemd 服务（Linux）

创建 `/etc/systemd/system/tg-imagebed.service`：

```ini
[Unit]
Description=Telegram Image Bed HTTP Server
After=network.target mysql.service

[Service]
Type=simple
User=your_user
WorkingDirectory=/path/to/TG图床
ExecStart=/path/to/TG图床/tg-imagebed
Restart=always
RestartSec=10
Environment="CACHE_DIR=/data/cache"

[Install]
WantedBy=multi-user.target
```

启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable tg-imagebed
sudo systemctl start tg-imagebed
sudo systemctl status tg-imagebed
```

### Docker 部署

创建 `Dockerfile`：

```dockerfile
FROM golang:1.21-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY main.go .
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o tg-imagebed .

FROM alpine:latest
RUN apk --no-cache add ca-certificates tzdata

WORKDIR /root/

COPY --from=builder /app/tg-imagebed .

RUN mkdir -p /data/cache

EXPOSE 8080
CMD ["./tg-imagebed"]
```

构建运行：

```bash
docker build -t tg-imagebed .
docker run -d -p 8080:8080 -v /data/cache:/data/cache tg-imagebed
```

## 六、API 接口

### 1. 上传文件

**POST** `/upload`

请求：
- Method: `POST`
- Content-Type: `multipart/form-data`
- 参数: `file` (文件)
- 最大文件: 20MB

响应：
- 状态码: `200 OK`
- 响应体: 随机路径字符串（16-24位）

示例：

```bash
curl -X POST http://localhost:8080/upload \
  -F "file=@/path/to/image.jpg"
```

响应：
```
abc123xyz456789012345678
```

### 2. 访问文件

**GET** `/{random_path}`

请求：
- Method: `GET`
- 路径: `/random_path`

响应：
- 状态码: `200 OK`
- Content-Type: 文件 MIME 类型
- 响应体: 文件二进制内容

示例：

```bash
curl -O http://localhost:8080/abc123xyz456789012345678
```

或直接在浏览器访问：

```
http://your-domain.com/abc123xyz456789012345678
```

## 七、反向代理配置

### Nginx

```nginx
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 20M;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header EO-Client-IP $remote_addr;  # 腾讯云 EDGEone
    }
}
```

### Caddy

```caddyfile
your-domain.com {
    reverse_proxy 127.0.0.1:8080
    header_up EO-Client-IP {remote_host}
}
```

## 八、日志查看

服务日志会输出到标准输出，可以通过 systemd 查看：

```bash
# 查看实时日志
sudo journalctl -u tg-imagebed -f

# 查看最近100行
sudo journalctl -u tg-imagebed -n 100

# 搜索上传记录
sudo journalctl -u tg-imagebed | grep "\[上传\]"
```

## 九、性能优化

### 1. 调整连接池

在 `main.go` 中修改：

```go
db.SetMaxOpenConns(100)  // 最大连接数
db.SetMaxIdleConns(20)   // 空闲连接数
```

### 2. 调整缓存 TTL

```go
CacheTTL = 30 * time.Minute  // 30分钟
```

### 3. 调整最大上传

```go
MaxUpload = int64(50 << 20)  // 50MB
```

## 十、监控与维护

### 1. 检查服务状态

```bash
# systemd
sudo systemctl status tg-imagebed

# 进程检查
ps aux | grep tg-imagebed
```

### 2. 查看缓存使用

```bash
du -sh /data/cache
ls -lh /data/cache | head -20
```

### 3. 手动清理缓存

```bash
# 删除所有缓存
rm -rf /data/cache/*
mkdir -p /data/cache
```

### 4. 数据库查询

```sql
-- 查看文件统计
SELECT
    status,
    COUNT(*) as count,
    SUM(file_size) as total_size
FROM files
GROUP BY status;

-- 查看最近上传
SELECT * FROM files
ORDER BY created_at DESC
LIMIT 20;

-- 查看访问统计
SELECT
    DATE(created_at) as date,
    COUNT(*) as count
FROM files
WHERE DATE(created_at) >= DATE_SUB(NOW(), INTERVAL 7 DAY)
GROUP BY DATE(created_at)
ORDER BY date DESC;
```

## 十一、故障排查

### 1. 服务启动失败

- 检查配置文件是否正确
- 验证数据库连接
- 检查端口占用：`netstat -tlnp | grep 8080`

### 2. 上传失败

- 检查文件大小是否超过20MB
- 验证 Telegram Bot Token 和 Channel ID
- 查看服务日志

### 3. 文件访问失败

- 检查缓存目录权限
- 验证数据库中的文件记录
- 检查 Telegram API 连接

### 4. IP 封禁不生效

- 确认 banned_ips 表中有记录
- 验证 IP 格式（BINARY(16)）
- 检查 getClientIP 函数逻辑

## 十二、安全建议

1. **HTTPS**: 生产环境必须使用 HTTPS
2. **防火墙**: 限制数据库端口访问
3. **备份**: 定期备份数据库
4. **监控**: 设置日志监控告警
5. **限制上传**: 根据需求调整文件大小限制
6. **速率限制**: 在反向代理层面添加速率限制
