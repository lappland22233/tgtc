# GitHub私有仓库设置指南

## 📋 前置准备

1. 确保已安装Git
2. 拥有GitHub账号
3. 需要GitHub个人访问令牌（Personal Access Token）

## 🔑 获取GitHub访问令牌

### 步骤1：创建Personal Access Token

1. 登录GitHub
2. 点击右上角头像 → **Settings**
3. 左侧菜单 → **Developer settings**
4. **Personal access tokens** → **Tokens (classic)**
5. 点击 **Generate new token** → **Generate new token (classic)**

### 步骤2：配置Token权限

勾选以下权限：
- ✅ **repo** - 完整的仓库访问权限
- ✅ **workflow** - 工作流权限

设置Token：
- Note: `TG图床项目`
- Expiration: 选择合适的过期时间（推荐90天）
- 点击 **Generate token**

⚠️ **重要**: 复制生成的token（只显示一次）

## 📦 创建GitHub私有仓库

### 方法1：通过GitHub网页创建（推荐）

1. 访问 https://github.com/new
2. 填写仓库信息：
   - **Repository name**: `tg-imagebed`（或你喜欢的名称）
   - **Description**: `TG图床 - Telegram文件上传服务，支持后台管理`
   - **Public/Private**: 选择 **Private**（私有）
   - **Initialize this repository**: ❌ 不勾选
   - **Add .gitignore**: ❌ 不勾选（已存在）
   - **Add a license**: 选择或忽略

3. 点击 **Create repository**

### 方法2：使用GitHub CLI（需要安装gh）

```bash
# 安装 GitHub CLI (Windows)
winget install --id GitHub.cli

# 创建私有仓库
gh repo create tg-imagebed --private --source=. --remote=origin --push
```

## 🚀 推送到GitHub

### 步骤1：添加远程仓库

```bash
cd "d:/xiangmu/TG图床"

# 替换 YOUR_USERNAME 为你的GitHub用户名
git remote add origin https://github.com/YOUR_USERNAME/tg-imagebed.git
```

### 步骤2：推送到GitHub

```bash
# 推送到main分支
git push -u origin master
```

如果遇到认证问题，使用Token：

```bash
# 使用Token推送
git remote set-url origin https://YOUR_TOKEN@github.com/YOUR_USERNAME/tg-imagebed.git
git push -u origin master
```

## 🔐 配置SSH密钥（推荐长期使用）

### 生成SSH密钥

```bash
# 生成新的SSH密钥
ssh-keygen -t ed25519 -C "your_email@example.com"
```

### 添加SSH密钥到GitHub

1. 复制公钥：
```bash
cat ~/.ssh/id_ed25519.pub
```
或（Windows）
```powershell
Get-Content ~/.ssh/id_ed25519.pub
```

2. 添加到GitHub：
   - GitHub → Settings → SSH and GPG keys
   - 点击 **New SSH key**
   - Title: `TG图床开发机`
   - Key: 粘贴公钥内容
   - 点击 **Add SSH key**

### 使用SSH推送

```bash
# 更改远程地址为SSH
git remote set-url origin git@github.com:YOUR_USERNAME/tg-imagebed.git

# 推送
git push -u origin master
```

## 📝 完整的推送脚本

创建文件 `push-to-github.bat` (Windows):

```batch
@echo off
echo ==========================================
echo   推送到GitHub私有仓库
echo ==========================================
echo.

set REPO_NAME=tg-imagebed
set GITHUB_USERNAME=YOUR_USERNAME

echo [1/3] 添加远程仓库...
git remote add origin https://github.com/%GITHUB_USERNAME%/%REPO_NAME%.git 2>nul
git remote set-url origin https://github.com/%GITHUB_USERNAME%/%REPO_NAME%.git

echo [2/3] 推送到GitHub...
git push -u origin master

if %errorlevel% equ 0 (
    echo.
    echo [SUCCESS] 推送成功！
    echo.
    echo 仓库地址: https://github.com/%GITHUB_USERNAME%/%REPO_NAME%
) else (
    echo.
    echo [ERROR] 推送失败，请检查：
    echo   1. GitHub仓库是否已创建
    echo   2. 用户名和仓库名是否正确
    echo   3. 是否有访问权限
    echo.
    echo 如果遇到认证问题，请使用：
    echo   git remote set-url origin https://YOUR_TOKEN@github.com/%GITHUB_USERNAME%/%REPO_NAME%.git
)

echo ==========================================
pause
```

## 🌟 项目README建议

在 `README.md` 中添加：

```markdown
# TG图床

基于Telegram的文件上传服务，支持后台管理功能。

## ✨ 特性

- 📤 文件上传到Telegram
- 🎨 美观的前端界面
- 🔒 后台管理系统
- 📊 统计信息
- 🚫 IP封禁功能
- 💾 MySQL数据库支持

## 🚀 快速开始

### 前置要求

- Go 1.19+
- MySQL 5.7+
- Telegram Bot

### 安装

```bash
# 克隆仓库
git clone https://github.com/YOUR_USERNAME/tg-imagebed.git
cd tg-imagebed

# 配置数据库
cp data.json.example data.json
# 编辑 data.json 填入配置信息

# 编译
go build -o tg-imagebed

# 运行
./tg-imagebed
```

### 访问管理后台

```
http://localhost:8080/admin.html
```

默认凭据：admin / changeme123

## 📚 文档

- [后台管理系统](ADMIN_README.md)
- [快速入门](ADMIN_QUICKSTART.md)
- [部署指南](DEBIAN12_DEPLOY.md)

## 📄 许可证

MIT License

## 🔗 相关链接

- [Telegram Bot API](https://core.telegram.org/bots/api)
```

## 🔒 安全建议

1. ✅ 已排除敏感文件（data.json, *.db等）
2. ✅ 已忽略压缩包文件
3. ✅ 已忽略可执行文件
4. ✅ 已忽略Python缓存文件

## 📊 项目统计

已提交文件：60个文件
代码行数：11,751行

包含：
- Go主程序（带后台管理）
- Python Bot（两个版本）
- 前端界面
- 部署脚本
- 完整文档

## ❓ 常见问题

### Q1: 推送时提示认证失败
A: 使用Personal Access Token代替密码，或配置SSH密钥

### Q2: 如何更新仓库
```bash
git add .
git commit -m "update description"
git push
```

### Q3: 如何克隆私有仓库
```bash
git clone https://github.com/YOUR_USERNAME/tg-imagebed.git
# 或使用SSH
git clone git@github.com:YOUR_USERNAME/tg-imagebed.git
```

### Q4: telegram-bot-api文件夹未上传
A: 该文件夹是独立的Git仓库，已从主仓库中排除，可以通过Git Submodule添加

## 📞 支持

如有问题，请提交Issue。
