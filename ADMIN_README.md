# TG图床后台管理系统

## 功能概述

后台管理系统提供以下功能：

1. **统计信息展示**
   - 总文件数
   - 今日上传数
   - 今日访问数
   - 封禁IP数量
   - 缓存命中率

2. **文件管理**
   - 查看所有上传文件
   - 显示文件路径、大小、类型、上传IP等信息
   - 按IP搜索上传历史
   - 删除文件（软删除，标记为deleted状态）
   - 在线预览文件

3. **IP管理**
   - 封禁指定IP地址
   - 查看已封禁IP列表
   - 解封IP地址
   - 从文件列表直接封禁上传IP

## 访问地址

- 管理后台: `http://your-domain/admin.html`
- API接口:
  - `GET /api/stats` - 获取统计信息
  - `GET /api/files` - 获取文件列表（支持分页和IP搜索）
  - `GET /api/banned` - 获取封禁IP列表
  - `POST /api/ban` - 封禁IP
  - `POST /api/unban` - 解封IP
  - `POST /api/delete` - 删除文件

## 认证方式

### 默认认证

系统使用 **HTTP Basic Auth** 进行认证，默认凭据：

- **用户名**: `admin`
- **密码**: `changeme123`

⚠️ **重要**: 生产环境必须修改默认密码！

### 修改管理员密码

编辑 `admin/auth.go` 文件，修改以下配置：

```go
var (
    AdminUsername string
    AdminPassword string
)

func InitAdminAuth() {
    AdminUsername = "your-username"
    AdminPassword = "your-strong-password"

    log.Printf("[认证] 管理员认证已启用（用户名: %s）", AdminUsername)
}
```

然后重新编译和运行程序。

### 其他认证方式（可选）

系统提供了以下认证中间件（在 `admin/auth.go` 中）：

1. **Basic Auth** (默认使用)
   - 标准的HTTP基本认证
   - 适合生产环境

2. **Token Auth**
   - 使用Bearer Token认证
   - 更适合API调用

3. **IP白名单**
   - 限制特定IP访问
   - 可与其他认证方式结合使用

切换认证方式，在 `main.go` 中修改路由注册：

```go
// 使用 Token 认证
mux.HandleFunc("/admin.html", admin.TokenAuthMiddleware("your-token")(func(w http.ResponseWriter, r *http.Request) {
    http.ServeFile(w, r, "admin/index.html")
}))

// 使用 IP 白名单
mux.HandleFunc("/admin.html", admin.IPWhitelistMiddleware([]string{"127.0.0.1"})(func(w http.ResponseWriter, r *http.Request) {
    http.ServeFile(w, r, "admin/index.html")
}))
```

```go
// 使用 Token 认证
mux.HandleFunc("/admin.html", tokenAuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
    http.ServeFile(w, r, "admin.html")
}))

// 使用 IP 白名单
mux.HandleFunc("/admin.html", ipWhitelistMiddleware(func(w http.ResponseWriter, r *http.Request) {
    http.ServeFile(w, r, "admin.html")
}))
```

## API 接口文档

### 1. 获取统计信息

**请求**
```
GET /api/stats
```

**响应**
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

### 2. 获取文件列表

**请求**
```
GET /api/files?page=1&ip=1.2.3.4
```

参数:
- `page`: 页码（默认1）
- `ip`: 按IP筛选（可选）

**响应**
```json
{
  "files": [
    {
      "id": 1,
      "random_path": "abc123xyz",
      "file_id": "BAADBAADbwADBwAE",
      "file_unique_id": "AgADBAADbwADBwAE",
      "mime_type": "image/jpeg",
      "file_size": 102400,
      "file_name": "photo.jpg",
      "upload_ip": "1.2.3.4",
      "edge_ip": "5.6.7.8",
      "status": "normal",
      "created_at": "2024-01-01 12:00:00",
      "last_accessed_at": "2024-01-01 13:00:00"
    }
  ],
  "current_page": 1,
  "total_pages": 10,
  "total_count": 200
}
```

### 3. 获取封禁IP列表

**请求**
```
GET /api/banned
```

**响应**
```json
{
  "banned_ips": [
    {
      "ip": "1.2.3.4",
      "banned_at": "2024-01-01 12:00:00",
      "reason": "恶意上传"
    }
  ]
}
```

### 4. 封禁IP

**请求**
```
POST /api/ban
Content-Type: application/json

{
  "ip": "1.2.3.4",
  "reason": "恶意上传"
}
```

**响应**
```json
{
  "success": true,
  "message": "IP 1.2.3.4 已封禁"
}
```

### 5. 解封IP

**请求**
```
POST /api/unban
Content-Type: application/json

{
  "ip": "1.2.3.4"
}
```

**响应**
```json
{
  "success": true,
  "message": "IP 1.2.3.4 已解封"
}
```

### 6. 删除文件

**请求**
```
POST /api/delete
Content-Type: application/json

{
  "path": "abc123xyz"
}
```

**响应**
```json
{
  "success": true,
  "message": "文件已删除"
}
```

## 前端界面功能

### 仪表板
- 实时显示系统统计信息
- 四个统计卡片展示关键指标
- 数据自动刷新

### 文件管理
- 表格形式展示文件列表
- 支持分页浏览（每页20条）
- 按IP搜索上传历史
- 查看文件详细信息
- 在线预览文件
- 删除文件（软删除）
- 从列表直接封禁上传IP

### IP管理
- 封禁指定IP（支持填写原因）
- 解封IP
- 查看已封禁IP列表
- 显示封禁时间和原因
- 一键解封操作

## 安全建议

1. **修改默认密码**
   - 务必修改默认的管理员用户名和密码
   - 使用强密码（至少12位，包含大小写字母、数字和特殊字符）

2. **启用HTTPS**
   - 生产环境必须使用HTTPS
   - 避免Basic Auth凭据在传输中被截获

3. **IP白名单**
   - 限制只有特定IP可以访问管理后台
   - 结合Basic Auth使用提高安全性

4. **定期备份数据**
   - 定期备份数据库
   - 保留操作日志

5. **监控访问日志**
   - 关注异常的访问行为
   - 及时发现安全威胁

## 部署说明

1. **编译程序**
```bash
go build -o tg-imagebed main.go admin_api.go admin_auth.go
```

2. **运行程序**
```bash
./tg-imagebed
```

3. **访问管理后台**
```
http://your-domain:8080/admin.html
```

4. **输入认证信息**
- 用户名: admin
- 密码: changeme123（请先修改）

## 数据库结构

系统使用以下数据库表：

### files 表
- 存储所有文件信息
- 包含上传IP、文件路径、状态等

### banned_ips 表
- 存储被封禁的IP地址
- 记录封禁时间和原因

## 故障排除

### 无法访问管理后台
- 检查认证凭据是否正确
- 查看程序日志
- 确认端口未被防火墙阻止

### IP封禁不生效
- 检查IP格式是否正确
- 查看数据库 banned_ips 表
- 重启服务

### 文件删除后仍可访问
- 删除是软删除，文件在Telegram上仍然存在
- 如需彻底删除，需要手动从Telegram频道删除
- 或修改代码实现真正的硬删除

## 开发说明

### 添加新功能
1. 在 `admin_api.go` 中添加新的API处理函数
2. 在 `main.go` 中注册路由
3. 在 `admin.html` 中添加前端交互逻辑

### 自定义界面
- 修改 `admin.html` 文件
- 使用CSS变量调整主题颜色
- 添加新的功能模块

## 许可证

本管理系统是TG图床项目的一部分，遵循项目许可证。
