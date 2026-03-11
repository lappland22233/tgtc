# 更新日志

## [2.1.0] - 2026-03-11

### 🔧 Bug Fixes

#### ✅ 修复 JWT 认证关键问题

**P2 Badge: JWT Signing Key Persist Across Restarts**
- **问题**: JWT 签名密钥在每次服务重启时重新生成，导致所有 Token 失效
- **解决方案**: 
  - 新增 `initJWTSecret()` 函数
  - JWT 密钥持久化到 `jwt_secret.key` 文件
  - 启动时自动加载已存在的密钥
- **影响**: 
  - ✅ Token 在服务重启后仍然有效（2 小时有效期内）
  - ✅ 支持多实例部署
  - ✅ 避免用户意外登出

**P2 Badge: Expose /admin.html without JWT Gate**
- **问题**: `/admin.html` 被 JWT 中间件拦截，导致登录页面无法访问
- **解决方案**:
  - 移除 `/admin.html` 的 JWT 认证中间件
  - 作为公开页面提供（登录入口）
  - 其他管理 API 保持 JWT 认证
- **影响**:
  - ✅ 用户可以直接访问登录页面
  - ✅ 正常的登录流程得以恢复
  - ✅ 保持了其他 API 的安全性

### 📁 文件变更

**修改的文件**:
- `main.go` - 实现 JWT 密钥持久化和路由修复
- `.gitignore` - 已有 `*.key` 规则保护密钥文件

**新增的文件**:
- `jwt_secret.key` - JWT 签名密钥文件（运行时自动生成）
- `JWT_FIXES.md` - 详细的修复技术文档
- `P2_BADGE_FIX_SUMMARY.md` - 完整的修复总结
- `verify-jwt-fix.sh` - Bash 验证脚本
- `verify-jwt-fix.ps1` - PowerShell 验证脚本

### 🔒 安全性

- JWT 密钥文件权限设置为 `0600`（仅所有者可读写）
- 密钥文件已添加到 `.gitignore`，避免提交到版本控制
- 生产环境建议使用环境变量或密钥管理服务

### 📊 技术细节

**JWT 密钥初始化流程**:
```go
func initJWTSecret() {
    jwtSecretFile := "jwt_secret.key"
    
    // 尝试读取已存在的密钥
    if data, err := os.ReadFile(jwtSecretFile); err == nil {
        jwtSecret = data
        return
    }
    
    // 生成新密钥并保存
    jwtSecret = generateJWTSecret()
    os.WriteFile(jwtSecretFile, jwtSecret, 0600)
}
```

**路由认证配置**:
```go
// 公开路由（登录页面）
mux.HandleFunc("/admin.html", serveAdminPage)

// 受保护的路由（需要 JWT）
mux.HandleFunc("/api/stats", jwtAuthMiddleware(statsHandler))
// ... 其他 API
```

### 🚀 升级指南

**全新安装**:
1. 直接运行程序，自动生成 `jwt_secret.key`
2. 无需额外配置

**从 v2.0 升级**:
1. 停止当前服务
2. 更新代码到 v2.1.0
3. 重新启动服务（自动生成新密钥文件）
4. **注意**: 升级后所有用户的 Token 会失效，需要重新登录

### ✅ 验证清单

- [x] JWT 密钥持久化功能正常
- [x] `/admin.html` 可以正常访问
- [x] 登录后能够获取 Token
- [x] 重启服务后 Token 仍然有效
- [x] 密钥文件不会被 Git 跟踪

### 📝 相关文档

- [详细修复说明](./JWT_FIXES.md)
- [完整总结](./P2_BADGE_FIX_SUMMARY.md)
- [认证指南](./AUTH_GUIDE.md)

---

## [2.0.0] - 2026-03-XX

### ✨ 新功能

- 🔐 JWT 认证系统
  - API Key + Token 双重认证
  - Token 有效期 2 小时
  - 自动续期机制
- 🎨 全新管理后台界面
  - 优雅的登录页面
  - Token 本地存储
  - 401 自动登出
- 📊 增强统计功能
- 🚫 IP 封禁管理

### 🔧 改进

- 从 Basic Auth 迁移到 JWT 认证
- 支持多 API Key 配置
- 更安全的凭据管理

---

## [1.0.0] - 初始版本

### ✨ 基础功能

- 📤 文件上传到 Telegram
- 🎨 Web 上传界面
- 💾 MySQL 数据库支持
- 🔄 缓存管理
- 🚫 基础 IP 封禁功能
