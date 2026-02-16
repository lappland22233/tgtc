# 后台管理系统快速入门

## 📁 新的文件结构

```
TG图床/
├── admin/                    # 🆕 后台管理模块
│   ├── index.html           #   前端界面
│   ├── api.go              #   API接口实现
│   ├── auth.go             #   认证中间件
│   └── README.md           #   模块文档
├── main.go                 # 主程序（已更新）
├── ADMIN_README.md         # 📖 完整使用文档
├── ADMIN_CHANGELOG.md      # 📝 更新日志
└── ADMIN_QUICKSTART.md    # 🚀 快速入门（本文件）
```

## 🚀 快速开始

### 1. 修改默认密码

编辑 `admin/auth.go`:

```go
func InitAdminAuth() {
    AdminUsername = "your-username"  // ⬅️ 修改这里
    AdminPassword = "your-password"  // ⬅️ 修改这里
}
```

### 2. 编译程序

**Linux/Mac:**
```bash
./build-with-admin.sh
```

**Windows:**
```cmd
build-with-admin.bat
```

**或手动编译:**
```bash
go build -o tg-imagebed
```

### 3. 运行程序

```bash
./tg-imagebed          # Linux/Mac
tg-imagebed.exe        # Windows
```

### 4. 访问管理后台

```
http://localhost:8080/admin.html
```

### 5. 登录

- 用户名: `admin`（或你修改后的用户名）
- 密码: `changeme123`（或你修改后的密码）

## ✨ 主要功能

### 📊 统计面板
- 总文件数
- 今日上传
- 今日访问
- 封禁IP
- 缓存命中率

### 📁 文件管理
- 查看所有上传文件
- 分页浏览（每页20条）
- 按IP搜索上传历史
- 在线预览文件
- 删除文件（软删除）
- 直接封禁上传IP

### 🔒 IP管理
- 封禁IP地址（可填写原因）
- 解封IP地址
- 查看已封禁IP列表
- 一键解封操作

## 🔗 API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/admin.html` | GET | 管理后台界面 |
| `/api/stats` | GET | 获取统计信息 |
| `/api/files` | GET | 获取文件列表 |
| `/api/banned` | GET | 获取封禁IP列表 |
| `/api/ban` | POST | 封禁IP |
| `/api/unban` | POST | 解封IP |
| `/api/delete` | POST | 删除文件 |

所有 API 端点都需要认证！

## 🔐 认证方式

### 默认：HTTP Basic Auth

所有端点使用 Basic Auth 认证：
- 浏览器访问会弹出登录框
- API 调用需要在 Header 中添加:
  ```
  Authorization: Basic base64(username:password)
  ```

### 可选：Token Auth

修改 `main.go` 中的路由：

```go
mux.HandleFunc("/api/stats", admin.TokenAuthMiddleware("your-token")(admin.StatsHandler(db)))
```

### 可选：IP 白名单

修改 `main.go` 中的路由：

```go
mux.HandleFunc("/admin.html", admin.IPWhitelistMiddleware([]string{"127.0.0.1"})(handler))
```

## ⚙️ 切换认证方式示例

```go
// 1. Basic Auth（默认）
mux.HandleFunc("/api/stats", admin.BasicAuthMiddleware(admin.StatsHandler(db)))

// 2. Token Auth
mux.HandleFunc("/api/stats", admin.TokenAuthMiddleware("secret-token")(admin.StatsHandler(db)))

// 3. IP 白名单
mux.HandleFunc("/api/stats", admin.IPWhitelistMiddleware([]string{"127.0.0.1"})(admin.StatsHandler(db)))

// 4. 组合使用（先IP白名单，再Basic Auth）
mux.HandleFunc("/api/stats",
    admin.IPWhitelistMiddleware([]string{"127.0.0.1"})(
        admin.BasicAuthMiddleware(admin.StatsHandler(db))))
```

## 📝 API 使用示例

### 获取统计信息

```bash
curl -u admin:password http://localhost:8080/api/stats
```

响应:
```json
{
  "total_files": 1234,
  "today_uploads": 56,
  "today_access": 789,
  "cached_files": 456,
  "banned_ips": 7,
  "cache_hit_rate": 36.95
}
```

### 获取文件列表

```bash
curl -u admin:password "http://localhost:8080/api/files?page=1"
```

### 按IP搜索

```bash
curl -u admin:password "http://localhost:8080/api/files?ip=1.2.3.4"
```

### 封禁IP

```bash
curl -u admin:password -X POST http://localhost:8080/api/ban \
  -H "Content-Type: application/json" \
  -d '{"ip":"1.2.3.4","reason":"恶意上传"}'
```

### 解封IP

```bash
curl -u admin:password -X POST http://localhost:8080/api/unban \
  -H "Content-Type: application/json" \
  -d '{"ip":"1.2.3.4"}'
```

### 删除文件

```bash
curl -u admin:password -X POST http://localhost:8080/api/delete \
  -H "Content-Type: application/json" \
  -d '{"path":"abc123xyz"}'
```

## ⚠️ 安全建议

1. **必须修改默认密码**
   ```go
   // admin/auth.go
   AdminPassword = "your-strong-password-123!@#"
   ```

2. **生产环境使用 HTTPS**
   - 配置反向代理（Nginx/Apache）
   - 使用 Let's Encrypt 免费证书

3. **启用 IP 白名单**
   ```go
   // main.go
   admin.IPWhitelistMiddleware([]string{"your.admin.ip"})
   ```

4. **定期备份数据库**
   ```bash
   mysqldump -u user -p database > backup.sql
   ```

5. **监控访问日志**
   - 查看程序日志中的认证记录
   - 关注失败的登录尝试

## 📚 详细文档

- **完整使用指南**: `ADMIN_README.md`
- **模块文档**: `admin/README.md`
- **更新日志**: `ADMIN_CHANGELOG.md`

## 🔧 故障排除

### 无法访问管理后台
- 检查密码是否正确
- 查看程序日志
- 确认端口未被占用

### 编译失败
- 检查 Go 版本 (>= 1.19)
- 确保 `go.mod` 存在
- 运行 `go mod tidy`

### API 返回 401
- 检查认证凭据
- 确认认证方式配置正确

### IP封禁不生效
- 检查IP格式
- 查看数据库 `banned_ips` 表
- 重启服务

## 🎯 下一步

1. ✅ 修改默认密码
2. ✅ 测试管理后台功能
3. ✅ 配置反向代理（Nginx）
4. ✅ 启用 HTTPS
5. ✅ 设置定期备份
6. ✅ 配置监控告警

---

**需要帮助？** 查看完整文档 `ADMIN_README.md`
