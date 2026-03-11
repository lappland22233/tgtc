# 管理后台认证升级 - 部署检查清单

## ✅ 升级完成项

- [x] 后端 JWT 认证实现 (main.go)
  - [x] 添加 JWT 依赖 (github.com/golang-jwt/jwt/v5)
  - [x] 扩展配置结构体 (api_keys 字段)
  - [x] 实现 JWT token 生成和验证工具函数
  - [x] 实现 /api/login 接口
  - [x] 实现 /api/verify 接口
  - [x] 实现 JWT 认证中间件
  - [x] 移除旧的 Basic Auth 中间件

- [x] 前端登录界面实现 (admin/index.html)
  - [x] 登录页面 UI
  - [x] Token 管理功能 (localStorage)
  - [x] 自动请求拦截器
  - [x] 401 自动登出处理
  - [x] 登出按钮和功能

- [x] 配置文件更新
  - [x] data.json.example 添加 api_keys 示例
  - [x] 配置文件加载验证逻辑

- [x] 辅助工具
  - [x] generate-api-key.sh (Linux/Mac)
  - [x] generate-api-key.ps1 (Windows)
  - [x] AUTH_GUIDE.md 配置指南
  - [x] go.mod 依赖更新

## 📋 部署步骤

### 1. 安装依赖

```bash
cd "d:\xiangmu\TG图床"
go mod tidy
```

### 2. 生成 API Key

#### Windows PowerShell:
```powershell
.\generate-api-key.ps1
```

复制生成的 API Key，例如：
```
a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6
```

### 3. 配置 data.json

编辑 `data.json` 文件（如果不存在则从 data.json.example 复制）：

```json
{
  "telegram": {
    "bot_token": "YOUR_BOT_TOKEN",
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
  },
  "api_keys": [
    "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6"
  ]
}
```

**注意**: 将上面的示例 API Key 替换为你实际生成的值。

### 4. 编译和测试

```bash
# 编译
go build -o tg-upload.exe main.go

# 或者运行测试
go run main.go
```

### 5. 重启服务

```powershell
# 停止现有服务
.\stop.sh

# 启动新服务
.\start.sh

# 或者如果使用 systemd (Linux)
sudo systemctl restart telegram-bot-api
```

### 6. 验证登录

1. 打开浏览器访问：`http://localhost:8080/admin.html`
2. 输入配置的 API Key
3. 点击登录
4. 验证是否能正常访问管理后台

## 🔍 验证检查点

### 后端验证

- [ ] 服务启动日志显示 "已加载 X 个 API Key"
- [ ] 访问 `/api/login` 接口正常响应
- [ ] 使用正确 API Key 能获取到 token
- [ ] 使用错误 API Key 返回 401 错误
- [ ] 携带有效 token 能访问受保护的 API
- [ ] 携带无效 token 返回 401 错误

### 前端验证

- [ ] 首次访问自动跳转到登录页
- [ ] 输入 API Key 能成功登录
- [ ] 登录后能正常显示统计数据
- [ ] 文件列表能正常加载
- [ ] IP 封禁功能正常工作
- [ ] 文件删除功能正常工作
- [ ] 点击"退出登录"能返回登录页
- [ ] 刷新页面后保持登录状态
- [ ] Token 过期后自动跳转登录页

## 🐛 常见问题

### 问题 1: 编译失败

**错误信息**: `package github.com/golang-jwt/jwt/v5: cannot find package`

**解决方案**:
```bash
go mod tidy
go get github.com/golang-jwt/jwt/v5@v5.2.0
```

### 问题 2: 登录提示 "API Key 无效"

**检查项**:
1. data.json 中是否配置了 api_keys
2. API Key 是否与生成的一致（无多余空格）
3. 服务是否已重启

### 问题 3: 登录后立即被退出

**检查项**:
1. 浏览器控制台是否有 401 错误
2. 服务器时间是否准确
3. 清除浏览器缓存重试

### 问题 4: 无法访问 /api/login

**检查项**:
1. 服务是否正常启动
2. 端口是否正确（默认 8080）
3. 防火墙设置

## 📝 回滚方案

如果需要回滚到旧版本：

1. 备份当前的 main.go 和 admin/index.html
2. 恢复旧版本文件
3. 重启服务

**注意**: 旧版本使用 Basic Auth，需要重新配置用户名密码。

## 🎯 下一步优化建议

- [ ] 添加 token 刷新接口（当前 token 过期需重新登录）
- [ ] 添加登录日志记录
- [ ] 支持 token 黑名单机制
- [ ] 添加双因素认证 (2FA)
- [ ] 支持 OAuth2 第三方登录
- [ ] 添加密码强度检测
- [ ] 实现 API Key 轮换机制

## 📞 技术支持

如遇到问题，请查看：

1. [AUTH_GUIDE.md](./AUTH_GUIDE.md) - 详细配置指南
2. 服务器日志：`journalctl -u telegram-bot-api -f`
3. 浏览器控制台错误信息
