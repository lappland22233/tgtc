# 管理后台认证配置指南

## 📋 概述

管理后台已升级为基于 **API Key + JWT Token** 的双重认证机制，提供更安全、现代化的身份验证。

## 🔐 认证原理

1. **API Key**: 长期有效的密钥，存储在服务器配置中
2. **JWT Token**: 临时访问令牌，有效期 2 小时，由 API Key 换取
3. **认证流程**: 
   - 管理员输入 API Key 登录
   - 服务器验证 API Key 有效性
   - 返回 JWT Token 给客户端
   - 客户端在后续请求中携带 Token
   - 服务器验证 Token 有效性

## ⚙️ 配置步骤

### 1. 生成 API Key

#### Linux/Mac:
```bash
chmod +x generate-api-key.sh
./generate-api-key.sh
```

#### Windows PowerShell:
```powershell
.\generate-api-key.ps1
```

或者手动生成（推荐）:
```bash
openssl rand -hex 32
```

### 2. 配置 data.json

编辑 `data.json` 文件，添加生成的 API Key:

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
    "your-secret-api-key-here-change-this-in-production"
  ]
}
```

### 3. 重启服务

```bash
# 如果使用 systemd
sudo systemctl restart telegram-bot-api

# 或者手动重启
./stop.sh
./start.sh
```

### 4. 访问管理后台

1. 打开浏览器访问：`http://your-domain:8080/admin.html`
2. 输入配置的 API Key
3. 点击登录

## 🛡️ 安全最佳实践

### API Key 管理

✅ **推荐做法**:
- 使用至少 32 字节的随机字符串（64 个十六进制字符）
- 定期更换 API Key（建议每 3-6 个月）
- 为不同管理员配置不同的 API Key
- 使用环境变量或密钥管理服务存储 API Key
- 在生产环境中使用 HTTPS

❌ **避免做法**:
- 不要使用默认或示例中的 API Key
- 不要将 API Key 提交到版本控制系统
- 不要在日志或错误信息中暴露完整 API Key
- 不要在前端代码中硬编码 API Key

### 多管理员配置

支持配置多个 API Key，每个管理员一个：

```json
{
  "api_keys": [
    "admin1-secret-key-here",
    "admin2-secret-key-here",
    "admin3-secret-key-here"
  ]
}
```

### Token 特性

- **有效期**: 2 小时
- **自动过期**: Token 过期后需要重新登录
- **安全存储**: Token 存储在浏览器 localStorage 中
- **自动续期**: 每次请求会自动验证 Token 有效性

## 🔧 故障排查

### 问题 1: 无法登录，提示 "API Key 无效"

**解决方案**:
1. 检查 data.json 中是否配置了 api_keys
2. 确认 API Key 格式正确（无多余空格）
3. 重启服务使配置生效
4. 查看服务器日志确认配置加载成功

### 问题 2: 登录后立即被退出

**解决方案**:
1. 检查浏览器控制台是否有 401 错误
2. 确认服务器时间准确（JWT 依赖时间验证）
3. 清除浏览器缓存和 localStorage 后重试

### 问题 3: 提示 "未配置 API Keys"

**解决方案**:
1. 在 data.json 中添加 api_keys 配置
2. 确保 JSON 格式正确（注意逗号分隔）
3. 重启服务

## 📝 升级说明

从旧版本升级的用户请注意：

1. **向后兼容性**: 旧的 Basic Auth 已被移除，必须配置 API Key
2. **数据迁移**: 无需迁移数据，只需更新配置
3. **首次配置**: 首次启动时会提示生成 API Key

## 🆘 紧急访问

如果忘记密码或无法访问管理后台：

1. 直接修改 `data.json` 中的 `api_keys` 配置
2. 重启服务
3. 使用新的 API Key 登录

## 📊 监控和日志

服务器会记录以下认证相关日志：

- `[认证] 登录成功`: API Key 验证成功
- `[认证] 登录失败`: API Key 验证失败
- `[认证] Token 验证通过`: Token 验证成功
- `[认证] Token 验证失败`: Token 过期或无效

查看日志：
```bash
journalctl -u telegram-bot-api -f
# 或
tail -f /path/to/your/log/file
```

## 🔗 相关资源

- [JWT 官方文档](https://jwt.io/)
- [OWASP 认证指南](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [API Key 最佳实践](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
