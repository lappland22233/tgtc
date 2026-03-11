# 快速开始 - 5 分钟完成认证配置

## 🚀 快速步骤（Windows）

### 第 1 步：生成 API Key（30 秒）

打开 PowerShell，运行：
```powershell
cd "d:\xiangmu\TG图床"
.\generate-api-key.ps1
```

复制输出的 API Key，例如：
```
a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6
```

### 第 2 步：配置 data.json（1 分钟）

编辑 `data.json` 文件，添加 api_keys 字段：

```json
{
  "telegram": {
    "bot_token": "你的 BOT_TOKEN",
    "channel_id": "-1001234567890"
  },
  "mysql": {
    "host": "localhost",
    "port": 3306,
    "username": "tg_imagebed",
    "password": "你的密码",
    "database": "tg_imagebed"
  },
  "admin": {
    "user_ids": [你的用户 ID]
  },
  "api_keys": [
    "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6"
  ]
}
```

**注意**: 将上面的示例 Key 替换为你生成的真实 Key。

### 第 3 步：安装依赖（1 分钟）

```bash
cd "d:\xiangmu\TG图床"
go mod tidy
```

如果提示找不到 go 命令，需要先安装 Go: https://golang.org/dl/

### 第 4 步：重启服务（30 秒）

```powershell
.\stop.sh
.\start.sh
```

或者如果使用 systemd（Linux）:
```bash
sudo systemctl restart telegram-bot-api
```

### 第 5 步：登录验证（1 分钟）

1. 打开浏览器访问：`http://localhost:8080/admin.html`
2. 输入配置的 API Key
3. 点击"登录"按钮
4. 成功进入管理后台 ✅

## ⏱️ 总耗时：约 5 分钟

## ❓ 遇到问题？

### 问题 1: 找不到 generate-api-key.ps1

**解决**: 手动生成一个随机字符串作为 API Key
```powershell
# PowerShell 生成随机 Key
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 64 | ForEach-Object {[char]$_})
```

### 问题 2: 登录后提示 "API Key 无效"

**检查**:
1. data.json 中是否添加了 api_keys 字段
2. API Key 是否与生成的一致（注意不要有多余空格）
3. 服务是否已重启

**示例配置**:
```json
{
  "api_keys": ["你的-API-Key-这里"]
}
```

### 问题 3: 无法访问 /admin.html

**检查**:
1. 服务是否正常启动
2. 端口是否正确（默认 8080）
3. Windows 防火墙设置

### 问题 4: go mod tidy 失败

**解决**:
```bash
# 手动添加 JWT 依赖
go get github.com/golang-jwt/jwt/v5@v5.2.0

# 然后再次尝试
go mod tidy
```

## 📖 详细文档

- 📘 完整配置指南：[AUTH_GUIDE.md](./AUTH_GUIDE.md)
- ✅ 部署检查清单：[DEPLOYMENT_CHECKLIST.md](./DEPLOYMENT_CHECKLIST.md)
- 🔄 升级说明：[UPGRADE_README.md](./UPGRADE_README.md)

## 🎯 下一步

登录成功后，你可以：

1. 📊 查看统计数据（总文件数、今日上传等）
2. 📁 管理文件列表（查看、删除）
3. 🚫 封禁恶意 IP
4. 🔍 搜索特定文件
5. 📋 查看已封禁 IP 列表

---

**提示**: 生产环境建议使用 HTTPS 保护传输安全！
