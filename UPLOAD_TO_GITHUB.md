# 📤 上传到GitHub私有仓库指南

## ✅ 已完成的工作

### 1. Git仓库初始化
- ✅ 初始化Git仓库
- ✅ 创建`.gitignore`文件
- ✅ 添加所有非压缩包文件
- ✅ 创建首次提交

### 2. 排除的文件
- ✅ 压缩包文件（*.zip）
- ✅ 可执行文件
- ✅ 配置文件（data.json）
- ✅ 数据库文件（*.db）
- ✅ Python缓存（__pycache__/）
- ✅ 嵌入的git仓库（telegram-bot-api/）
- ✅ IDE配置（.vscode/, .idea/）

### 3. 已包含的文件
- ✅ Go主程序（main.go, go.mod）
- ✅ 后台管理系统（admin/文件夹）
- ✅ Python Bot版本（bot/文件夹）
- ✅ Python Server版本（bot2/文件夹）
- ✅ 部署脚本和文档
- ✅ 完整的使用文档

### 4. 提交统计
- **提交数量**: 2次
- **文件数量**: 64个文件
- **代码行数**: 12,528行

## 🚀 下一步：推送到GitHub

### 方法1：使用自动脚本（推荐）

#### Windows用户
```batch
push-to-github.bat
```

#### Linux/Mac用户
```bash
chmod +x push-to-github.sh
./push-to-github.sh
```

脚本会：
1. 检查Git状态
2. 添加所有文件
3. 提交变更
4. 推送到GitHub

**使用前请修改脚本中的配置：**
```batch
set GITHUB_USERNAME=YOUR_USERNAME
set REPO_NAME=tg-imagebed
```

### 方法2：手动推送

#### 步骤1：在GitHub上创建私有仓库

1. 访问 https://github.com/new
2. 填写信息：
   - Repository name: `tg-imagebed`
   - 选择 **Private**
   - 不初始化仓库（不要勾选任何选项）
3. 点击 **Create repository**

#### 步骤2：添加远程仓库

```bash
cd "d:/xiangmu/TG图床"

# 替换 YOUR_USERNAME 为你的GitHub用户名
git remote add origin https://github.com/YOUR_USERNAME/tg-imagebed.git
```

#### 步骤3：推送到GitHub

```bash
# 推送到master分支
git push -u origin master
```

如果遇到认证问题，使用Token：

```bash
# 1. 生成Personal Access Token
# 访问: https://github.com/settings/tokens
# 创建新token，勾选repo权限

# 2. 使用Token推送
git remote set-url origin https://YOUR_TOKEN@github.com/YOUR_USERNAME/tg-imagebed.git
git push -u origin master
```

## 🔐 认证方式

### 方式1：Personal Access Token

1. 获取Token：
   - GitHub → Settings → Developer settings
   - Personal access tokens → Tokens (classic)
   - Generate new token (classic)
   - 勾选 `repo` 权限
   - 生成并复制token

2. 使用Token：
```bash
git remote set-url origin https://YOUR_TOKEN@github.com/YOUR_USERNAME/tg-imagebed.git
```

### 方式2：SSH密钥（推荐长期使用）

1. 生成SSH密钥：
```bash
ssh-keygen -t ed25519 -C "your_email@example.com"
```

2. 添加到GitHub：
   - 复制公钥：`cat ~/.ssh/id_ed25519.pub`
   - GitHub → Settings → SSH and GPG keys → New SSH key
   - 粘贴公钥内容

3. 使用SSH推送：
```bash
git remote set-url origin git@github.com:YOUR_USERNAME/tg-imagebed.git
git push -u origin master
```

## 📋 完整操作流程（复制粘贴版）

### Windows（PowerShell）

```powershell
# 1. 进入项目目录
cd "d:\xiangmu\TG图床"

# 2. 添加远程仓库（替换YOUR_USERNAME）
git remote add origin https://github.com/YOUR_USERNAME/tg-imagebed.git

# 3. 推送到GitHub
git push -u origin master

# 如果需要认证，使用Token
git remote set-url origin https://YOUR_TOKEN@github.com/YOUR_USERNAME/tg-imagebed.git
git push -u origin master
```

### Linux/Mac（Bash）

```bash
# 1. 进入项目目录
cd "d:/xiangmu/TG图床"

# 2. 添加远程仓库（替换YOUR_USERNAME）
git remote add origin https://github.com/YOUR_USERNAME/tg-imagebed.git

# 3. 推送到GitHub
git push -u origin master

# 如果需要认证，使用Token
git remote set-url origin https://YOUR_TOKEN@github.com/YOUR_USERNAME/tg-imagebed.git
git push -u origin master
```

## ⚠️ 常见问题

### Q1: 推送时提示"认证失败"

**解决方案：**
1. 使用Personal Access Token代替密码
2. 或配置SSH密钥（推荐）

### Q2: 提示"仓库不存在"

**解决方案：**
1. 先在GitHub上创建仓库
2. 确保仓库名称正确
3. 确保使用私有仓库（Private）

### Q3: 提示"权限不足"

**解决方案：**
1. 检查GitHub用户名是否正确
2. 确认是否有仓库访问权限
3. Token是否勾选了repo权限

### Q4: 如何更新仓库

```bash
# 添加所有修改
git add .

# 提交
git commit -m "update description"

# 推送
git push
```

## 📊 项目统计

### 已提交内容

| 类别 | 数量 |
|------|------|
| 总文件数 | 64个 |
| 代码文件 | 60个 |
| 文档文件 | 4个 |
| 总行数 | 12,528行 |

### 文件类型分布

- Go代码: 2个文件
- Python代码: 12个文件
- Shell脚本: 10个文件
- 批处理脚本: 5个文件
- HTML文件: 2个文件
- Markdown文档: 10个文件
- 配置文件: 23个

## 📚 相关文档

- **GitHub设置指南**: [GITHUB_SETUP.md](GITHUB_SETUP.md)
- **后台管理系统**: [ADMIN_README.md](ADMIN_README.md)
- **快速入门**: [ADMIN_QUICKSTART.md](ADMIN_QUICKSTART.md)
- **更新日志**: [ADMIN_CHANGELOG.md](ADMIN_CHANGELOG.md)

## ✨ 下一步建议

1. ✅ 在GitHub上创建私有仓库
2. ✅ 配置认证方式（Token或SSH）
3. ✅ 推送代码到GitHub
4. ✅ 设置仓库描述和标签
5. ✅ 添加GitHub Actions（可选）
6. ✅ 配置自动化测试（可选）

## 🎉 完成！

当你完成上述步骤后，你的TG图床项目就会安全地保存在GitHub私有仓库中了！

**仓库地址示例**: https://github.com/YOUR_USERNAME/tg-imagebed

---

**需要帮助？** 查看 [GITHUB_SETUP.md](GITHUB_SETUP.md) 获取更详细的说明。
