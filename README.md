# 文件分发系统

基于 NestJS + Vue 3 + PostgreSQL 的文件分发系统，Telegram Bot API 作为存储后端，支持加密访问、限时分享和访问次数控制。

## 功能

### 认证
- 邮箱注册与登录，邮件验证码（可配置开关）
- JWT 身份认证（HttpOnly Cookie），三级角色权限（super_admin / admin / user）
- 登录失败限流（IP + email 维度，5 次失败锁定 15 分钟）
- 验证码使用 crypto 随机数 + SHA256 哈希存储，5 次错误锁定 5 分钟
- 请求级 Cookie secure 动态判断（兼容反向代理 X-Forwarded-Proto）
- 跨标签页登出同步（BroadcastChannel）

### 文件管理
- 拖拽上传 / 弹窗批量上传
- Multer 层 500MB 硬上限 + 业务层动态大小限制
- 文件列表搜索、分页、类型筛选（分页/搜索参数持久化到 URL）
- 设置公开/私有、访问次数限制、分享有效期（含过期检查）
- 批量勾选图片一键生成 Markdown 链接
- 后端代理下载（不暴露 Telegram 原始 URL），使用流式传输
- 缩略图 RSA-OAEP 加密防外链，时间窗口 ±30 秒

### 分享访问
- **公开无约束**：直接流式返回文件内容，CDN 友好
- **加密文件**：访问时弹出密码验证页面，输入 `?ps=` 参数访问
- **受限文件**（次数限制/时效限制）：自动 302 跳转短效访问链接（30s，jti 防重放）
- 密码错误 5 次自动封禁 IP 5 分钟，1 小时内 5 次触发升级为 6 小时
- 密码页面使用服务端 APP_URL 拼接，防止 Host Header 注入

### 管理员
- 全站仪表盘（30 秒自动刷新）
- 用户管理（创建/删除/封禁/授权，super_admin 不可通过 API 创建）
- 文件管理、IP 封禁管理
- 系统配置（SMTP、上传限制、认证开关），敏感配置仅限 SUPER_ADMIN
- 文件类型过滤（黑名单/白名单双模式，危险类型带警告标识）

### 安全
- Telegram Bot Token 错误日志自动脱敏
- SMTP 密码不在事件日志中记录
- 注册流程防 TOCTOU 竞态（表锁 + FOR UPDATE）
- 配置缓存使用 upsert 原子操作
- Source map 生产关闭、.gitignore 覆盖密钥文件
- 前端全局错误边界防白屏

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | NestJS 10 + TypeScript (CommonJS, strict mode) + TypeORM 0.3 |
| 数据库 | PostgreSQL ≥ 14 |
| 前端 | Vue 3 + TypeScript + Vite 5 + TDesign |
| 存储 | Telegram Bot API（支持本地代理绕过限流） |
| 邮件 | Nodemailer + SMTP |
| 认证 | Passport JWT + bcryptjs |
| 状态管理 | Pinia |
| 路由 | Vue Router 4 |

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
# HTTP 服务器超时 10 分钟，支持大文件上传
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

# Telegram Bot（支持本地 API 代理）
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
# TELEGRAM_API_BASE=https://api.telegram.org  # 可选：自建代理地址

# SMTP 邮件
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_email@example.com
SMTP_PASSWORD=your_password
SMTP_FROM=noreply@example.com

# 应用
APP_HOST=0.0.0.0
APP_PORT=3000
APP_URL=http://localhost:3000
FRONTEND_URL=http://localhost:5173
CORS_ORIGINS=http://localhost:5173

# 上传（启动后可从管理面板动态调整）
MAX_FILE_SIZE=20971520
FILE_TYPE_MODE=blacklist      # blacklist 或 whitelist
FILE_TYPE_FILTER=              # 逗号分隔的扩展名，如 .zip,.exe,.sh，空值不限制
```

第一个注册的账号自动成为超级管理员。

## 项目结构

```
├── backend/src/
│   ├── main.ts               # 入口：CORS、Cookie、全局管道/拦截器、静态文件、超时配置
│   ├── app.module.ts         # 根模块（TypeORM、Schedule、事件发射器）
│   ├── auth/                 # 登录/注册/邮箱验证/密码重置/状态查询
│   ├── user/                 # 个人信息/密码修改/统计
│   ├── file/                 # 上传/下载/分享/公开访问/缩略图加密
│   ├── admin/                # 用户/文件/IP封禁/系统配置管理
│   ├── telegram/             # Telegram Bot API 上传下载（流式传输，Token 脱敏）
│   ├── mailer/               # SMTP 邮件（事件驱动配置热更新）
│   ├── config/               # 动态配置缓存
│   ├── tasks/                # 定时清理（过期限流/Token/封禁）
│   ├── common/
│   │   ├── entities/         # 8 个数据实体
│   │   ├── services/         # ConfigCacheService (upsert 原子操作) + RateLimitService
│   │   ├── guards/           # JWT 认证 + 角色权限守卫
│   │   ├── decorators/       # @CurrentUser @Roles
│   │   └── interceptors/     # 统一响应 { code, message, data }
│   ├── database/             # TypeORM CLI DataSource（含 dotenv/config 加载）
│   └── migrations/           # 8 个数据库迁移文件
│
├── frontend/src/
│   ├── views/
│   │   ├── auth/             # Login.vue Register.vue（redirect 安全校验）
│   │   ├── user/             # Dashboard FileList Settings
│   │   ├── admin/            # Dashboard Users Files Config
│   │   └── layout/           # 侧边栏布局
│   ├── components/           # UploadModal ThumbnailImg
│   ├── stores/               # auth files (Pinia)
│   ├── router/               # 四级路由守卫链 + redirect 安全校验
│   ├── api/                  # axios 客户端（30s 超时，401 防抖）
│   ├── types/                # TS 类型定义
│   └── utils/                # error.ts thumbnail.ts
│
├── .gitignore
├── LICENSE
└── README.md
```

## 开发命令

```bash
# 后端
cd backend
npm run start:dev            # 开发启动（自动 watch）
npm run build                # 生产构建（使用 tsconfig.build.json，关闭 sourceMap）
npm run start:prod           # 生产启动
npm run test                 # 跑测试（Jest，覆盖率阈值 30%）
npm run test:cov             # 测试 + 覆盖率报告
npm run typecheck            # TypeScript 类型检查（strict 模式）
npx jest --testPathPattern=auth/auth.service  # 单测
npm run migration:generate   # 生成迁移
npm run migration:run        # 执行迁移
npm run migration:revert     # 回滚迁移

# 前端
cd frontend
npm run dev                  # 开发启动（Vite 代理 /api 到 :3000）
npm run build                # vue-tsc 类型检查 + vite build
npm run preview              # 预览生产构建
npm run typecheck            # TypeScript 类型检查
```

## API 概览

### Public（无需登录）
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/register` | 用户注册 |
| POST | `/api/auth/login` | 登录 |
| POST | `/api/auth/send-code` | 发送验证码 |
| GET | `/api/auth/status` | 认证状态查询 |
| GET | `/files/public/:id` | 公开文件访问 |
| GET | `/files/public/:id?ps=` | 密码验证访问 |
| GET | `/files/public/:id?access=` | 短效访问链接 |
| GET | `/api/files/upload-config` | 上传配置 |

### User（需登录）
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/verify-email` | 邮箱验证 |
| POST | `/api/auth/reset-password` | 重置密码 |
| GET | `/api/users/me/stats` | 个人统计 |
| POST | `/api/files/upload-multiple` | 批量上传 |
| GET | `/api/files` | 文件列表 |
| GET | `/api/files/:id/download` | 下载 |
| PUT | `/api/files/:id/password` | 设置密码 |
| PUT | `/api/files/:id/access-type` | 公开/私有 |
| PUT | `/api/files/:id/access-count` | 访问限制 |
| PUT | `/api/files/:id/expires` | 有效期 |
| POST | `/api/files/batch-markdown` | 批量 Markdown |

### Admin / Super Admin
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/stats` | 全站统计 |
| GET | `/api/admin/users` | 用户列表 |
| POST | `/api/admin/users` | 创建用户 |
| DELETE | `/api/admin/users/:id` | 删除用户 |
| GET | `/api/admin/banned-ips` | IP 封禁列表 |
| POST | `/api/admin/banned-ips` | 封禁 IP |
| DELETE | `/api/admin/banned-ips/:ip` | 解封 IP |
| PUT | `/api/admin/config` | 系统配置（仅 SUPER_ADMIN） |

## 许可证

GNU General Public License v3.0
