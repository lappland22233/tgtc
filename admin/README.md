# 管理后台说明

管理后台逻辑已合并到 `main.go`，包含：

- `adminAuthMiddleware`
- `/admin.html` 页面路由
- `/api/stats`、`/api/files`、`/api/banned`、`/api/ban`、`/api/unban`、`/api/delete`

默认账号密码在 `main.go` 中通过 `adminUser/adminPass` 配置。

> 建议部署前务必修改默认密码。
