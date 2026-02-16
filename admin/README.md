# 后台管理模块

此目录包含 TG 图床的后台管理功能。

## 文件结构

```
admin/
├── index.html   # 后台管理前端界面
├── api.go       # API 接口实现
└── auth.go      # 兼容占位（认证已合并到 main.go）
```

## 功能模块

### API 接口 (api.go)

- **StatsHandler** - 获取系统统计信息
- **FilesHandler** - 获取文件列表（支持分页和IP搜索）
- **BannedListHandler** - 获取封禁IP列表
- **BanHandler** - 封禁IP
- **UnbanHandler** - 解封IP
- **DeleteHandler** - 删除文件

### 认证与访问控制（main.go）

- 管理端认证中间件已统一放到 `main.go` 的 `adminAuthMiddleware`。
- 管理接口与用户上传接口共用同一个服务与端口。
- 未携带或携带错误凭据访问管理路由时，直接返回 `404`（隐藏管理入口）。

## 配置

### 修改管理员密码

编辑 `main.go` 中默认值：

```go
adminUser = "admin"
adminPass = "your-strong-password"
```

## 安全建议

1. ⚠️ **务必修改 main.go 中默认密码**
2. 🙈 匿名访问管理端会返回 404
3. 🔒 生产环境使用 HTTPS
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
