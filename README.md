# 文件分发系统

基于 NestJS + Vue 3 + PostgreSQL 的文件分发系统，Telegram Bot API 作为存储后端，支持加密访问、限时分享和访问次数控制。

## 功能

### 认证
- 邮箱注册与登录，邮件验证码（可配置开关）
- JWT 身份认证（HttpOnly Cookie），三级角色权限（super_admin / admin / user）
- 登录失败限流（IP + email 维度，5 次失败锁定 15 分钟）
- 验证码使用 crypto 随机数 + SHA256 哈希存储，5 次错误锁定 5 分钟

### 文件管理
- 拖拽上传 / 弹窗批量上传
- Multer 层 500MB 硬上限 + 业务层动态大小限制
- 文件列表搜索、分页、类型筛选
- 设置公开/私有、访问次数限制、分享有效期（含过期检查）
- 批量勾选图片一键生成 Markdown 链接
- 后端代理下载（不暴露 Telegram 原始 URL），使用流式传输

### 分享访问
- **公开无约束**：直接流式返回文件内容，CDN 友好
- **加密文件**：访问时弹出密码验证页面，输入 `?ps=` 参数访问
- **受限文件**（次数限制/时效限制）：自动 302 跳转短效访问链接（30s，jti 防重放）
- 密码错误 5 次自动封禁 IP 5 分钟，1 小时内 5 次触发升级为 6 小时
- 密码页面使用服务端 APP_URL 拼接，防止 Host Header 注入

### 管理员
- 用户管理（创建/删除/封禁/授权，super_admin 不可通过 API 创建）
- 文件管理、IP 封禁管理
- 系统配置（SMTP、上传限制、注册开关），敏感配置仅限 SUPER_ADMIN

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | NestJS 10 + TypeScript + TypeORM 0.3 |
| 数据库 | PostgreSQL ≥ 14 |
| 前端 | Vue 3 + TypeScript + Vite 5 + TDesign |
| 存储 | Telegram Bot API |
| 邮件 | Nodemailer + SMTP |
| 认证 | Passport JWT + bcryptjs |

## 快速开始

**环境要求**：Node.js ≥ 18, PostgreSQL ≥ 14, Telegram Bot Token

```bash
# 后端
cd backend
cp .env.example .env   # 编辑数据库、JWT、Telegram、SMTP 配置
npm install
npm run start:dev      # 默认 http://127.0.0.1:3000

# 前端
cd frontend
npm install
npm run dev            # 默认 http://localhost:5173
```

**生产部署**：
```bash
cd frontend && npm run build
cd ../backend && npm run build && npm run start:prod
# 后端直接服务前端静态文件，单端口部署
```

## 配置 (.env)

```env
# 数据库
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=your_password
DB_DATABASE=file_distribution
DB_SYNCHRONIZE=true          # 开发 true，生产 false
DB_MIGRATIONS_RUN=false       # 启动时自动执行迁移

# JWT
JWT_SECRET=your-random-secret
JWT_EXPIRES_IN=7d

# Telegram Bot
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# SMTP 邮件
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_email@example.com
SMTP_PASSWORD=your_password
SMTP_FROM=noreply@example.com

# 应用
APP_HOST=127.0.0.1
APP_PORT=3000
APP_URL=http://localhost:3000
FRONTEND_URL=http://localhost:5173
CORS_ORIGINS=http://localhost:5173

# 上传
MAX_FILE_SIZE=20971520
ALLOWED_FILE_TYPES=image/*,.pdf,.zip,.rar,.txt
```

第一个注册的账号自动成为超级管理员。

## 项目结构

```
tgtc/
├── backend/src/
│   ├── main.ts              # 入口：CORS、静态文件、URL 重写
│   ├── app.module.ts        # 根模块
│   ├── auth/                # 登录/注册/邮箱验证
│   ├── user/                # 个人信息/密码修改/统计
│   ├── file/                # 上传/下载/分享/公开访问/密码验证/批量MK
│   ├── admin/               # 用户/文件/IP封禁/系统配置管理 (DTO: admin.dto.ts)
│   ├── telegram/            # Telegram Bot API 上传下载，支持流式传输
│   ├── mailer/              # SMTP 邮件
│   ├── config/              # 动态配置缓存
│   ├── tasks/               # 定时清理过期封禁
│   ├── common/
│   │   ├── entities/        # User File SystemConfig VerificationCode BannedIP ShareAudit FileAccessLog RateLimit
│   │   ├── services/        # ConfigCacheService RateLimitService
│   │   ├── guards/          # JWT 认证 + 角色守卫
│   │   ├── decorators/      # @CurrentUser @Roles
│   │   └── interceptors/    # 统一响应 { code, message, data }
│   ├── database/            # TypeORM CLI DataSource
│   └── migrations/          # 数据库迁移
│
├── frontend/src/
│   ├── views/
│   │   ├── auth/            # Login Register
│   │   ├── user/            # Dashboard FileList Settings
│   │   ├── admin/           # Dashboard Users Files Config
│   │   └── layout/          # 侧边栏布局
│   ├── components/          # UploadModal
│   ├── stores/              # auth files (Pinia)
│   ├── router/              # 四级路由守卫链
│   ├── types/               # TS 类型
│   └── utils/               # 错误处理
│
└── README.md
```

## 开发命令

```bash
cd backend
npm run start:dev            # 开发启动
npm run build                # 构建
npm run test                 # 跑测试
npm run typecheck            # TypeScript 类型检查
npx jest --testPathPattern=auth/auth.service  # 单测
npm run migration:generate   # 生成迁移
npm run migration:run        # 执行迁移

cd frontend
npm run dev                  # 开发启动
npm run build                # vue-tsc + vite build
npm run typecheck            # TypeScript 类型检查
```

## API 概览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/files/public/:id` | 公开访问：无约束直返/加密弹密码页/受限302跳转 |
| GET | `/files/public/:id?ps=` | 密码验证参数 |
| GET | `/files/public/:id?access=` | 短效访问链接（30秒有效期，支持流式返回） |
| GET | `/files/:id/share` | 生成分享直链 |
| PUT | `/files/:id/password` | 设置/移除密码 |
| PUT | `/files/:id/access-type` | 设置公开/私有 |
| PUT | `/files/:id/access-count` | 设置访问次数限制 |
| PUT | `/files/:id/expires` | 设置分享有效期（小时） |
| POST | `/files/batch-markdown` | 批量生成 Markdown |

## 许可证

GNU General Public License v3.0
