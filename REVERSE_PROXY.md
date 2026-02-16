# 反向代理配置指南

## 目录

- [Nginx 配置](#nginx-配置)
- [Apache 配置](#apache-配置)
- [Caddy 配置](#caddy-配置)
- [Traefik 配置](#traefik-配置)
- [腾讯云 EDGEone 配置](#腾讯云-edgeone-配置)
- [Cloudflare 配置](#cloudflare-配置)
- [HTTPS 证书配置](#https-证书配置)

---

## Nginx 配置

### 基础配置

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # 允许的最大上传大小
    client_max_body_size 20M;

    # 日志
    access_log /var/log/nginx/tg-imagebed-access.log;
    error_log /var/log/nginx/tg-imagebed-error.log;

    location / {
        # 代理到后端服务
        proxy_pass http://127.0.0.1:8080;

        # 传递真实 IP（腾讯云 EDGEone）
        proxy_set_header EO-Client-IP $remote_addr;

        # 标准代理头
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 超时设置
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;

        # 禁用缓冲（大文件上传）
        proxy_request_buffering off;
        proxy_buffering off;
    }
}
```

### HTTPS + HTTP/2 配置（推荐）

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # 重定向到 HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    # SSL 证书（Let's Encrypt）
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # SSL 安全配置
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # HSTS
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # 允许的最大上传大小
    client_max_body_size 20M;

    # 日志
    access_log /var/log/nginx/tg-imagebed-access.log;
    error_log /var/log/nginx/tg-imagebed-error.log;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header EO-Client-IP $remote_addr;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        proxy_request_buffering off;
        proxy_buffering off;
    }
}
```

### 使用 Nginx 缓存（减少后端负载）

```nginx
# 定义缓存路径
proxy_cache_path /var/cache/nginx/tg-imagebed levels=1:2 keys_zone=tg_imagebed:10m max_size=10g inactive=60d use_temp_path=off;

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    # SSL 配置...
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    client_max_body_size 20M;

    location / {
        # 使用缓存
        proxy_cache tg_imagebed;
        proxy_cache_valid 200 60m;
        proxy_cache_valid 404 1m;
        proxy_cache_key "$scheme$request_method$host$request_uri";

        # 缓存控制
        add_header X-Cache-Status $upstream_cache_status;
        add_header Cache-Control "public, max-age=600";

        proxy_pass http://127.0.0.1:8080;
        proxy_set_header EO-Client-IP $remote_addr;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        proxy_request_buffering off;
        proxy_buffering off;
    }

    # 上传接口不缓存
    location /upload {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header EO-Client-IP $remote_addr;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        proxy_request_buffering off;
        proxy_buffering off;
    }
}
```

### 部署步骤

```bash
# 1. 创建配置文件
sudo nano /etc/nginx/sites-available/tg-imagebed

# 2. 复制上述配置并修改域名

# 3. 创建软链接
sudo ln -s /etc/nginx/sites-available/tg-imagebed /etc/nginx/sites-enabled/

# 4. 测试配置
sudo nginx -t

# 5. 重启 Nginx
sudo systemctl restart nginx

# 6. 如果使用 Let's Encrypt
sudo certbot --nginx -d your-domain.com
```

---

## Apache 配置

### 基础配置

```apache
<VirtualHost *:80>
    ServerName your-domain.com

    # 允许的最大上传大小
    LimitRequestBody 20971520  # 20MB

    # 代理模块
    ProxyPreserveHost On
    ProxyRequests Off

    # 传递真实 IP
    ProxyPassReverse / http://127.0.0.1:8080/
    ProxyPass / http://127.0.0.1:8080/

    # 设置环境变量传递真实 IP
    RequestHeader set EO-Client-IP "%{REMOTE_ADDR}s"
</VirtualHost>
```

### HTTPS 配置

```apache
<VirtualHost *:80>
    ServerName your-domain.com
    Redirect permanent / https://your-domain.com/
</VirtualHost>

<VirtualHost *:443>
    ServerName your-domain.com

    # SSL 配置
    SSLEngine on
    SSLCertificateFile /etc/letsencrypt/live/your-domain.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/your-domain.com/privkey.pem
    SSLProtocol all -SSLv2 -SSLv3
    SSLCipherSuite HIGH:MEDIUM:!aNULL:!MD5

    LimitRequestBody 20971520

    ProxyPreserveHost On
    ProxyRequests Off

    <Location />
        ProxyPass http://127.0.0.1:8080/
        ProxyPassReverse http://127.0.0.1:8080/
        RequestHeader set EO-Client-IP "%{REMOTE_ADDR}s"
    </Location>
</VirtualHost>
```

---

## Caddy 配置

### 基础配置（自动 HTTPS）

```caddyfile
your-domain.com {
    # 自动 HTTPS（Let's Encrypt）
    # Caddy 会自动申请和续期证书

    # 上传大小限制
    request_body {
        max_size 20MB
    }

    # 传递真实 IP
    header_up EO-Client-IP {remote_host}

    # 反向代理
    reverse_proxy 127.0.0.1:8080
}
```

### 高级配置（带日志和缓存）

```caddyfile
your-domain.com {
    # 日志
    log {
        output file /var/log/caddy/tg-imagebed-access.log
        format json
    }

    # 错误日志
    log {
        output file /var/log/caddy/tg-imagebed-error.log
        format json
        level ERROR
    }

    # 上传大小限制
    request_body {
        max_size 20MB
    }

    # 响应头
    header {
        # 安全头
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        X-XSS-Protection "1; mode=block"

        # 缓存控制
        Cache-Control "public, max-age=600"
        Access-Control-Allow-Origin "*"
    }

    # 上传接口不缓存
    @upload {
        path /upload
    }
    header @upload Cache-Control "no-cache"

    # 传递真实 IP
    header_up EO-Client-IP {remote_host}

    # 反向代理
    reverse_proxy 127.0.0.1:8080 {
        # 超时设置
        transport http {
            dial_timeout 60s
            response_header_timeout 60s
        }

        # 健康检查
        health_uri /
        health_interval 30s
        health_timeout 10s
    }
}
```

### 部署步骤

```bash
# 1. 安装 Caddy
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy

# 2. 创建配置文件
sudo nano /etc/caddy/Caddyfile

# 3. 复制上述配置并修改域名

# 4. 验证配置
sudo caddy validate --config /etc/caddy/Caddyfile

# 5. 重启 Caddy
sudo systemctl restart caddy

# 6. 查看状态
sudo systemctl status caddy
```

---

## Traefik 配置

### Docker Compose 配置

```yaml
version: '3'

services:
  tg-imagebed:
    image: tg-imagebed:latest
    restart: always
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.tg-imagebed.rule=Host(`your-domain.com`)"
      - "traefik.http.routers.tg-imagebed.entrypoints=websecure"
      - "traefik.http.routers.tg-imagebed.tls.certresolver=letsencrypt"
      - "traefik.http.services.tg-imagebed.loadbalancer.server.port=8080"
    volumes:
      - /data/cache:/data/cache
    networks:
      - traefik-net

  traefik:
    image: traefik:v2.10
    command:
      - "--api.insecure=true"
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.websecure.address=:443"
      - "--certificatesresolvers.letsencrypt.acme.tlschallenge=true"
      - "--certificatesresolvers.letsencrypt.acme.email=your-email@example.com"
      - "--certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
    ports:
      - "80:80"
      - "443:443"
      - "8080:8080"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./letsencrypt:/letsencrypt
    networks:
      - traefik-net

networks:
  traefik-net:
    external: true
```

---

## 腾讯云 EDGEone 配置

### 1. 添加站点

1. 登录 [腾讯云 EDGEone 控制台](https://console.cloud.tencent.com/edgeone)
2. 点击"添加站点"
3. 输入域名并选择接入方式

### 2. 源站配置

**源站类型**: 自定义源站

**源站地址**: 您的服务器 IP

**回源端口**: 8080

**回源协议**: HTTP（或 HTTPS，如源站配置了 SSL）

### 3. 回源 HTTP 头配置

在"回源配置" → "HTTP 回源头"中添加：

| 名称 | 值 | 说明 |
|------|-----|------|
| `EO-Client-IP` | `${client_ip}` | 传递客户端真实 IP |
| `X-Forwarded-For` | `${client_ip}` | 标准代理头 |
| `X-Real-IP` | `${client_ip}` | 标准代理头 |

### 4. 缓存配置

**缓存规则**：

- **静态文件**（推荐）:
  - 文件类型：`jpg, jpeg, png, gif, webp, svg, ico, bmp`
  - 缓存时间：30天

- **其他文件**:
  - 文件类型：所有文件
  - 缓存时间：10分钟

**忽略参数**: 勾选（忽略 URL 参数缓存）

### 5. 上传下载配置

**请求限速**（可选）:

- 单 IP 下载速度：10MB/s
- 单 IP 上传速度：5MB/s

**连接限制**:

- 单 IP 并发数：10

### 6. HTTPS 配置

在"证书管理"中：

1. 选择"托管证书"
2. 添加证书（使用 Let's Encrypt 自动申请）
3. 启用 HTTP 自动跳转 HTTPS

### 7. 安全配置

**WAF 防护**（推荐）:

- 开启基础防护
- 开启速率限制（单 IP 100 请求/分钟）

**访问控制**（可选）:

- IP 黑名单
- 地域封禁

---

## Cloudflare 配置

### 1. 添加站点

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 点击"Add a Site"
3. 输入域名并选择 Free 或 Pro 计划

### 2. DNS 设置

添加 A 记录：

| 类型 | 名称 | 内容 | 代理状态 |
|------|------|------|----------|
| A | @ | 您的服务器 IP | 已代理（橙色云） |

### 3. SSL/TLS 配置

选择加密模式：**Full (strict)**

### 4. 缓存规则

创建页面规则：

**规则 1 - 静态文件**：

- 匹配：`*.jpg, *.jpeg, *.png, *.gif, *.webp, *.svg`
- 设置：缓存级别：标准，边缘缓存时间：1个月

**规则 2 - 其他文件**：

- 匹配：`your-domain.com/*`
- 设置：缓存级别：标准，边缘缓存时间：10分钟

### 5. 传递客户端 IP

Cloudflare 使用 `CF-Connecting-IP` 头，需要在后端支持。

**Nginx 配置**：

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    # Cloudflare 使用 CF-Connecting-IP
    proxy_set_header EO-Client-IP $http_cf_connecting_ip;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $http_cf_connecting_ip;
    proxy_set_header X-Forwarded-For $http_cf_connecting_ip;
}
```

**修改 Go 代码**（如果需要支持 Cloudflare）：

在 `main.go` 的 `getClientIP` 函数中添加：

```go
func getClientIP(r *http.Request) net.IP {
    // 优先读取 EO-Client-IP
    if ip := r.Header.Get("EO-Client-IP"); ip != "" {
        if parsed := net.ParseIP(ip); parsed != nil {
            return parsed
        }
    }

    // Cloudflare
    if ip := r.Header.Get("CF-Connecting-IP"); ip != "" {
        if parsed := net.ParseIP(ip); parsed != nil {
            return parsed
        }
    }

    // 兼容 X-Forwarded-For
    if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
        ips := strings.Split(xff, ",")
        if parsed := net.ParseIP(strings.TrimSpace(ips[0])); parsed != nil {
            return parsed
        }
    }

    // 回退到 RemoteAddr
    host, _, err := net.SplitHostPort(r.RemoteAddr)
    if err != nil {
        return nil
    }
    return net.ParseIP(host)
}
```

### 6. 速率限制（付费计划）

在 **Security** → **WAF** → **Rate Limiting Rules** 中创建规则：

```
当 URI 路径 包含 /upload
并且 请求频率 超过 每10分钟 20次
则 触发 阻止 操作 1小时
```

---

## HTTPS 证书配置

### Let's Encrypt（免费）

#### 使用 Certbot（Nginx/Apache）

```bash
# 安装 Certbot
sudo apt update
sudo apt install certbot python3-certbot-nginx  # Nginx
# 或
sudo apt install certbot python3-certbot-apache  # Apache

# 申请证书
sudo certbot --nginx -d your-domain.com

# 自动续期
sudo certbot renew --dry-run
```

#### 使用 Certbot（手动模式）

```bash
# 申请证书
sudo certbot certonly --manual --preferred-challenges dns -d your-domain.com

# 按照提示添加 DNS TXT 记录

# 证书位置
# /etc/letsencrypt/live/your-domain.com/fullchain.pem
# /etc/letsencrypt/live/your-domain.com/privkey.pem
```

### 自动续期

创建 cron 任务：

```bash
sudo crontab -e
```

添加：

```
0 0 * * * certbot renew --quiet --post-hook "systemctl reload nginx"
```

---

## 性能优化建议

### 1. 开启 Gzip 压缩

**Nginx**：

```nginx
gzip on;
gzip_vary on;
gzip_min_length 1024;
gzip_types text/plain text/css text/xml text/javascript application/json application/javascript application/xml+rss application/rss+xml font/truetype font/opentype application/vnd.ms-fontobject image/svg+xml;
```

**Caddy**：

```caddyfile
encode {
    gzip 6
    zstd
}
```

### 2. 开启 HTTP/2

**Nginx**：

```nginx
listen 443 ssl http2;
```

**Caddy**：默认支持 HTTP/3

### 3. CDN 加速

- 腾讯云 CDN
- Cloudflare CDN
- 阿里云 CDN
- AWS CloudFront

### 4. 静态文件分离

将频繁访问的静态文件使用对象存储（如腾讯云 COS、阿里云 OSS），配合 CDN 加速。

---

## 监控与日志

### Nginx 访问日志分析

```bash
# 查看访问量
awk '{print $1}' /var/log/nginx/tg-imagebed-access.log | sort | uniq -c | sort -rn | head -10

# 查看上传请求
grep "POST /upload" /var/log/nginx/tg-imagebed-access.log | wc -l

# 查看状态码统计
awk '{print $9}' /var/log/nginx/tg-imagebed-access.log | sort | uniq -c | sort -rn
```

### Caddy 日志

```bash
# 实时查看日志
tail -f /var/log/caddy/tg-imagebed-access.log

# 错误日志
tail -f /var/log/caddy/tg-imagebed-error.log
```

---

## 故障排查

### 1. 502 Bad Gateway

**原因**：后端服务未运行或端口错误

**解决**：
```bash
# 检查后端服务
ps aux | grep tg-imagebed

# 检查端口
netstat -tlnp | grep 8080

# 查看后端日志
tail -f http.log
```

### 2. 413 Request Entity Too Large

**原因**：文件大小超过限制

**解决**：

**Nginx**：
```nginx
client_max_body_size 50M;
```

**Caddy**：
```caddyfile
request_body {
    max_size 50MB
}
```

### 3. 无法获取真实 IP

**原因**：反向代理头未正确配置

**解决**：确保在 Nginx/Caddy 中配置了 `EO-Client-IP` 头

### 4. SSL 证书错误

**原因**：证书过期或配置错误

**解决**：
```bash
# 检查证书
sudo certbot certificates

# 续期
sudo certbot renew

# 测试配置
sudo nginx -t
```

---

## 安全建议

1. **使用 HTTPS**：强制 HTTPS 访问
2. **开启 HSTS**：防止协议降级攻击
3. **限制上传大小**：防止恶意上传大文件
4. **速率限制**：防止 DDoS 攻击
5. **WAF 防护**：开启 Web 应用防火墙
6. **定期更新**：保持软件最新版本
7. **监控日志**：及时发现异常访问
8. **备份配置**：定期备份反向代理配置

---

## 快速参考

### Nginx 常用命令

```bash
sudo nginx -t                    # 测试配置
sudo systemctl restart nginx     # 重启
sudo systemctl reload nginx      # 重新加载配置
sudo systemctl status nginx      # 查看状态
```

### Caddy 常用命令

```bash
sudo caddy validate --config /etc/caddy/Caddyfile  # 验证配置
sudo systemctl restart caddy                        # 重启
sudo systemctl reload caddy                         # 重新加载
sudo systemctl status caddy                         # 查看状态
```

### Apache 常用命令

```bash
sudo apachectl configtest  # 测试配置
sudo systemctl restart apache2  # 重启
sudo systemctl reload apache2   # 重新加载
sudo systemctl status apache2   # 查看状态
```
