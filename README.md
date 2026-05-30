# 文件分发系统

基于 NestJS + Vue 3 + PostgreSQL 的小型文件分发系统，使用 Telegram Bot API 作为存储源。

## 功能特性

### 认证系统
- 邮箱注册与登录
- 邮件验证码验证
- JWT 身份认证

### 普通用户后台
- 上传文件（默认20MB限制）
- 删除自己的文件
- 设置图片访问次数限制
- 设置文件访问权限（公开/私有）

### 管理员后台
- 仪表盘统计
- 用户管理（创建/删除/封禁/授权）
- 文件管理（查看/删除）
- IP封禁管理
- SMTP邮件配置
- 上传文件类型和大小配置

### 权限控制
- 三级权限体系：普通用户 / 管理员 / 超级管理员
- 第一个注册用户自动成为超级管理员
- 管理员需要超级管理员授权

## 技术栈

- **后端**: NestJS + TypeScript + TypeORM
- **数据库**: PostgreSQL
- **前端**: Vue 3 + TypeScript + Vite + TDesign
- **文件存储**: Telegram Bot API
- **邮件服务**: Nodemailer + SMTP

## 快速开始

### 环境要求
- Node.js >= 18
- PostgreSQL >= 14
- Telegram Bot Token

### 后端启动

```bash
cd backend

# 安装依赖
npm install

# 复制环境配置
cp .env.example .env
# 编辑 .env 填写配置

# 启动数据库后自动创建表
npm run start:dev
```

### 前端启动

```bash
cd frontend

# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

### 配置说明

编辑 `backend/.env`:

```env
# 数据库
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=your_password
DB_DATABASE=file_distribution

# JWT密钥（请修改为随机字符串）
JWT_SECRET=your-super-secret-key

# Telegram Bot Token
TELEGRAM_BOT_TOKEN=your_bot_token

# SMTP配置
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your_email@example.com
SMTP_PASSWORD=your_password
SMTP_FROM=显示名称

# 应用配置
APP_PORT=3000
FRONTEND_URL=http://localhost:5173
```

## 访问地址

- 前端: http://localhost:5173
- 后端API: http://localhost:3000

## 默认管理员

第一个注册的账号会自动成为超级管理员。

## 项目结构

```
├── backend/                 # 后端项目
│   └── src/
│       ├── auth/          # 认证模块
│       ├── user/          # 用户模块
│       ├── file/          # 文件模块
│       ├── admin/         # 管理模块
│       ├── telegram/      # Telegram服务
│       ├── mailer/        # 邮件服务
│       └── common/        # 公共模块
│
└── frontend/               # 前端项目
    └── src/
        ├── views/         # 页面组件
        ├── stores/       # 状态管理
        ├── router/       # 路由配置
        └── api/          # API封装
```
