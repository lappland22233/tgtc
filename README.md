# 文件分发系统

基于 NestJS + Vue 3 + PostgreSQL 的文件分发系统，使用 Telegram Bot API 作为文件存储后端。

## 功能特性

### 认证系统
- 邮箱注册与登录
- 邮件验证码验证（可配置开关）
- JWT 身份认证（Cookie 存储）

### 普通用户后台
- 拖拽/批量上传文件（默认 20MB 限制，可配置类型白名单）
- 删除自己的文件
- 设置文件访问权限（公开/私有）
- 设置访问次数限制
- 生成分享链接（支持过期时间、密码保护）
- 图片批量转 Markdown 链接

### 管理员后台
- 仪表盘统计（用户/文件/存储/访问量 + 月度图表）
- 用户管理（创建/删除/封禁/解封/角色授权）
- 文件管理（查看/批量删除/上传者筛选）
- IP 封禁管理
- SMTP 邮件配置
- 系统配置（认证开关、上传限制）

### 权限控制
- 三级权限：普通用户 / 管理员 / 超级管理员
- 第一个注册用户自动成为超级管理员
- 管理员需要超级管理员授权

## 技术栈

| 层 | 技术 |
|---|------|
| 后端 | NestJS 10 + TypeScript (CommonJS, ES2021) |
| ORM | TypeORM 0.3 |
| 数据库 | PostgreSQL >= 14 |
| 前端 | Vue 3 + TypeScript + Vite 5 |
| UI | TDesign Vue Next |
| 状态管理 | Pinia |
| 路由 | Vue Router 4 |
| 认证 | JWT + Passport + bcryptjs |
| 文件存储 | Telegram Bot API |
| 邮件 | Nodemailer + SMTP |

## 环境要求

- Node.js >= 18
- PostgreSQL >= 14
- Telegram Bot Token 和 Chat ID

## 快速开始

### 1. 后端

```bash
cd backend

# 安装依赖
npm install

# 创建环境配置（参考下方配置说明）
touch .env
```

配置环境变量后启动：

```bash
# 开发模式（自动同步表结构）
npm run start:dev

# 生产模式
npm run start:prod
```

### 2. 前端

```bash
cd frontend

# 安装依赖
npm install

# 开发模式（默认 http://localhost:5173，API 代理到 localhost:3000）
npm run dev

# 生产构建
npm run build
```

## 配置说明

`backend/.env`：

```env
# 数据库
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=your_password
DB_DATABASE=file_distribution

# 数据库行为（开发环境建议 DB_SYNCHRONIZE=true，生产必须 false）
DB_SYNCHRONIZE=true
DB_MIGRATIONS_RUN=false
NODE_ENV=development

# JWT
JWT_SECRET=your-random-secret-key
JWT_EXPIRES_IN=7d

# Telegram 存储
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# SMTP 邮件（可选，不配置则注册时无需验证码）
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your_email@example.com
SMTP_PASSWORD=your_password
SMTP_FROM=发件人显示名称

# 应用
APP_HOST=127.0.0.1
APP_PORT=3000
APP_URL=http://localhost:3000

# 前端（CORS）
FRONTEND_URL=http://localhost:5173

# 文件上传限制
MAX_FILE_SIZE=20971520
ALLOWED_FILE_TYPES=image/*,application/pdf,application/zip,text/*
```

`frontend/.env`：

```env
VITE_API_BASE_URL=http://localhost:3000
```

## 命令参考

### 测试

```bash
cd backend

npm run test             # 运行所有测试（Jest）
npm run test:watch       # 监听模式
npm run test:cov         # 覆盖率报告

# 运行单个测试
npx jest --testPathPattern=auth/auth.service.spec.ts
```

### 数据库迁移

```bash
cd backend

npm run migration:create     # 创建空白迁移文件
npm run migration:generate   # 基于实体差异自动生成迁移
npm run migration:run        # 执行迁移
npm run migration:revert     # 回滚上一次迁移
```

> 迁移 CLI 使用 `src/database/data-source.ts` 作为独立 DataSource，synchronize 固定为 `false`。

## 访问地址

- 前端：http://localhost:5173
- 后端 API：http://localhost:3000

## 默认管理员

第一个注册的账号自动成为超级管理员。

## 项目结构

```
├── backend/                     # NestJS 后端
│   ├── package.json
│   ├── tsconfig.json
│   ├── nest-cli.json
│   └── src/
│       ├── main.ts              # 应用入口
│       ├── app.module.ts        # 根模块
│       ├── auth/                # 认证模块（登录/注册/验证码/JWT策略）
│       ├── user/                # 用户模块
│       ├── file/                # 文件模块（上传/下载/删除/分享/公开访问）
│       ├── admin/               # 管理员模块（用户/文件/IP/系统配置管理）
│       ├── telegram/            # Telegram Bot API 存储服务
│       ├── mailer/              # SMTP 邮件服务
│       ├── config/              # 动态配置管理
│       ├── tasks/               # 定时任务（@nestjs/schedule）
│       ├── common/              # 公共模块
│       │   ├── entities/        # 数据实体（7个）
│       │   ├── guards/          # JWT + 角色守卫
│       │   ├── decorators/      # @CurrentUser, @Roles
│       │   ├── interceptors/    # 统一响应 { code, message, data }
│       │   ├── filters/         # 异常过滤器
│       │   ├── pipes/           # 自定义管道
│       │   └── services/        # 配置缓存服务
│       ├── database/            # TypeORM DataSource（CLI 迁移用）
│       └── migrations/          # 数据库迁移文件
│
└── frontend/                    # Vue 3 前端
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig.json
    ├── index.html
    └── src/
        ├── main.ts              # 应用入口
        ├── App.vue              # 根组件（深色主题）
        ├── router/              # Vue Router + 导航守卫
        ├── stores/              # Pinia（auth.ts, files.ts）
        ├── types/               # 类型定义
        ├── utils/               # 工具函数
        └── views/
            ├── auth/            # Login.vue, Register.vue
            ├── layout/          # Layout.vue（侧边栏布局）
            ├── user/            # Dashboard, FileList, Upload, Settings
            └── admin/           # Dashboard, Users, Files, Config
```

## 架构要点

- **API 前缀** `/api`，统一响应格式 `{ code, message, data }`
- **JWT 认证** 存储在 Cookie 中，axios `withCredentials: true`
- **路由守卫** 四级链：初始化恢复 → 认证检查 → 游客检查 → 管理员检查
- **TypeORM** 运行时配置在 `app.module.ts`，CLI 迁移配置在 `src/database/data-source.ts`
- **7 个数据实体**：User, File, SystemConfig, VerificationCode, BannedIP, ShareAudit, FileAccessLog
- **前端路径别名** `@` → `src/`
- **主题** 硬编码深色模式（TDesign `theme: 'dark'`）

## 许可证

GPL v3
