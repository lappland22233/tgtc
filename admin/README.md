# 后台管理模块

此目录包含 TG 图床的后台管理功能。

## 文件结构

```
admin/
├── index.html   # 后台管理前端界面
├── api.go       # API 接口实现
└── auth.go      # 认证中间件
```

## 功能模块

### API 接口 (api.go)

- **StatsHandler** - 获取系统统计信息
- **FilesHandler** - 获取文件列表（支持分页和IP搜索）
- **BannedListHandler** - 获取封禁IP列表
- **BanHandler** - 封禁IP
- **UnbanHandler** - 解封IP
- **DeleteHandler** - 删除文件

### 认证中间件 (auth.go)

- **BasicAuthMiddleware** - HTTP Basic Auth 认证（默认）
- **TokenAuthMiddleware** - Bearer Token 认证
- **IPWhitelistMiddleware** - IP 白名单认证

## 配置

### 修改管理员密码

编辑 `auth.go` 文件：

```go
var (
    AdminUsername string
    AdminPassword string
)

func InitAdminAuth() {
    AdminUsername = "admin"      // 修改用户名
    AdminPassword = "your-password"  // 修改密码
}
```

### 切换认证方式

在 `main.go` 中修改路由注册：

```go
// 使用 Basic Auth（默认）
mux.HandleFunc("/admin.html", admin.BasicAuthMiddleware(handler))

// 使用 Token Auth
mux.HandleFunc("/admin.html", admin.TokenAuthMiddleware("your-token")(handler))

// 使用 IP 白名单
mux.HandleFunc("/admin.html", admin.IPWhitelistMiddleware([]string{"127.0.0.1"})(handler))
```

## 安全建议

1. ⚠️ **务必修改默认密码**
2. 🔒 生产环境使用 HTTPS
3. 🛡️ 考虑启用 IP 白名单
4. 📝 定期查看访问日志
5. 💾 定期备份数据库

## 访问地址

- 管理后台: `http://your-domain:8080/admin.html`
- API 接口前缀: `/api/`

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/stats` | GET | 获取统计信息 |
| `/api/files` | GET | 获取文件列表 |
| `/api/banned` | GET | 获取封禁IP列表 |
| `/api/ban` | POST | 封禁IP |
| `/api/unban` | POST | 解封IP |
| `/api/delete` | POST | 删除文件 |

详细的 API 文档请参考项目根目录的 `ADMIN_README.md`。
