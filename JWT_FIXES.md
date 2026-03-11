# JWT 认证修复说明

## 🔧 修复内容

### 问题 1：JWT Signing Key 在重启后不持久化

**问题描述**：
- 之前每次服务重启时，`generateJWTSecret()` 都会生成新的随机密钥
- 导致之前颁发的所有 JWT Token 立即失效（即使在 2 小时有效期内）
- 用户会被意外登出，负载均衡场景下会出现认证失败

**解决方案**：
- ✅ 新增 `initJWTSecret()` 函数
- ✅ 首次启动时生成密钥并保存到 `jwt_secret.key` 文件
- ✅ 后续启动时从文件加载已存在的密钥
- ✅ 密钥文件权限设置为 `0600`（仅所有者可读写）

**影响**：
- ✅ Token 在服务重启后仍然有效（在 2 小时有效期内）
- ✅ 支持多实例部署（需要共享 `jwt_secret.key` 文件）
- ✅ 提高用户体验，避免意外登出

### 问题 2：`/admin.html` 被 JWT 中间件拦截

**问题描述**：
- `/admin.html` 被 `jwtAuthMiddleware` 拦截
- 初次访问时浏览器还没有 Token，直接返回 401
- 用户无法看到登录页面，形成死循环

**解决方案**：
- ✅ 移除 `/admin.html` 的 JWT 认证中间件
- ✅ `/admin.html` 作为公开页面，允许任何人访问
- ✅ 其他管理 API（`/api/*`）仍然需要 JWT 认证
- ✅ 前端通过 Token 检测自动显示登录页面或主界面

**认证流程**：
```
1. 用户访问 /admin.html
   ↓
2. 服务器返回登录页面（无需认证）
   ↓
3. 前端检查 localStorage 中的 Token
   ↓
4. 如果有 Token 且有效 → 显示主界面
   ↓
5. 如果无 Token 或无效 → 显示登录页面
```

## 📁 新增文件

- `jwt_secret.key` - JWT 签名密钥文件（自动生成，已加入 .gitignore）

## 🔒 安全建议

1. **生产环境部署**：
   - 建议将 `jwt_secret.key` 存储在安全的位置（如环境变量、密钥管理服务）
   - 多实例部署时需要共享同一个密钥文件

2. **密钥轮换**：
   - 定期更换 `jwt_secret.key` 文件（例如每月）
   - 更换后所有旧 Token 会立即失效，用户需要重新登录

3. **文件权限**：
   - 确保 `jwt_secret.key` 文件权限为 `0600`
   - 仅允许应用运行用户读取

## 🚀 升级步骤

### 全新安装
1. 直接运行程序，会自动生成 `jwt_secret.key`
2. 无需任何额外配置

### 从旧版本升级
1. 停止当前运行的服务
2. 更新代码到最新版本
3. 重新启动服务
4. 首次启动会自动生成 `jwt_secret.key`

**注意**：升级后所有用户的 Token 会失效，需要重新登录。

## 📊 技术细节

### JWT 密钥初始化流程

```go
func initJWTSecret() {
    jwtSecretFile := "jwt_secret.key"
    
    // 1. 尝试读取已存在的密钥文件
    if data, err := os.ReadFile(jwtSecretFile); err == nil {
        jwtSecret = data
        log.Printf("[认证] 已加载 JWT 密钥文件：%s", jwtSecretFile)
        return
    }
    
    // 2. 生成新密钥并保存到文件
    jwtSecret = generateJWTSecret()
    if err := os.WriteFile(jwtSecretFile, jwtSecret, 0600); err != nil {
        log.Printf("[警告] 保存 JWT 密钥文件失败：%v", err)
    } else {
        log.Printf("[认证] 已生成并保存 JWT 密钥文件：%s", jwtSecretFile)
    }
}
```

### 路由认证配置

```go
// 公开路由（无需认证）
mux.HandleFunc("/admin.html", func(w http.ResponseWriter, r *http.Request) {
    http.ServeFile(w, r, "admin/index.html")
})

// 受保护的路由（需要 JWT 认证）
mux.HandleFunc("/api/stats", jwtAuthMiddleware(statsHandler))
mux.HandleFunc("/api/files", jwtAuthMiddleware(filesHandler))
mux.HandleFunc("/api/banned", jwtAuthMiddleware(bannedListHandler))
// ... 其他 API
```

## ✅ 验证清单

- [ ] 服务启动后检查日志，确认 JWT 密钥已生成或加载
- [ ] 访问 `/admin.html` 能够正常显示登录页面
- [ ] 使用正确的 API Key 登录后能够访问管理界面
- [ ] 关闭并重新启动服务，确认之前的 Token 仍然有效
- [ ] 检查 `jwt_secret.key` 文件是否存在且权限正确

## 🐛 故障排查

### 问题：重启后 Token 仍然失效

**可能原因**：
- `jwt_secret.key` 文件没有被正确保存
- 文件权限问题导致无法读取

**解决方法**：
1. 检查 `jwt_secret.key` 文件是否存在
2. 检查文件权限：`ls -l jwt_secret.key`
3. 查看启动日志中的认证信息

### 问题：无法访问 `/admin.html`

**可能原因**：
- 反向代理配置问题
- 文件路径错误

**解决方法**：
1. 检查 `admin/index.html` 文件是否存在
2. 检查服务器日志
3. 尝试直接访问 `http://localhost:8080/admin.html`

## 📞 获取帮助

如有问题，请查看项目文档或提交 Issue。
