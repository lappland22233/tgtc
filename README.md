# 文件分发系统（网盘版）

基于 NestJS + Vue 3 + PostgreSQL 的文件分发系统，Telegram Bot API 作为存储后端。支持文件夹层级管理、卡片/列表双视图、SPA 分享页（百度网盘风格）、严格模式密码保护、限时分享和访问次数控制。

## 功能

### 认证
- 邮箱注册与登录，邮件验证码（可配置开关）
- JWT 身份认证（HttpOnly Cookie），三级角色权限（super_admin / admin / user）
- 登录失败限流（IP + email 维度，5 次失败锁定 15 分钟）
- 验证码使用 crypto 随机数 + SHA256 哈希存储，5 次错误锁定 5 分钟
- 请求级 Cookie secure 动态判断（兼容反向代理 X-Forwarded-Proto）
- 跨标签页登出同步（BroadcastChannel）

### 文件管理
- **文件夹层级管理**：创建/重命名/移动/删除文件夹，闭包表（closure-table）支持任意深度层级，移动时循环检测，软删除联动子树+内含文件（7 天冷静期）
- **卡片/列表双视图**：默认卡片网格视图（响应式自适应列数），支持切换到列表视图，偏好持久化到 localStorage
- 拖拽上传 / 弹窗批量上传
- 业务层动态大小限制
- 文件列表搜索、分页、类型筛选（分页/搜索参数持久化到 URL），支持按文件夹过滤
- **标签管理**：创建/编辑/删除标签，支持多标签筛选（AND 逻辑），文件列表快捷编辑标签
- 设置公开/私有、访问次数限制、分享有效期（含过期检查）
- 批量勾选图片一键生成 Markdown 链接
- 后端代理下载（不暴露 Telegram 原始 URL），使用流式传输
- 缩略图 RSA-OAEP 加密防外链，时间窗口 ±10 秒

### 分享访问
- **SPA 分享页**：打开分享链接 `/s/:token` 后先展示文件信息卡片（文件名、大小、类型、上传时间、有效期），提供显式下载按钮，而非直接下载/预览（百度网盘风格）
- **严格模式密码保护**：加密分享需输入密码后才能查看任何文件元数据，未验证前后端不查询 target 表，杜绝信息泄露
- **文件夹分享**：分享整个文件夹，支持子文件夹层级浏览、面包屑导航、单文件下载
- **独立分享模型**：ShareLink 实体独立于文件，同一文件/文件夹可创建多条分享链接（不同密码、有效期、次数限制）
- **老链接兼容**：`/files/public/:id` 自动 302 重定向到 `/s/:id`，迁移脚本为现有公开文件自动创建 ShareLink（token=文件 id），新文件懒创建
- 密码错误 5 次自动封禁 IP 5 分钟，1 小时内 5 次触发升级为 6 小时（与文件密码共享封禁表）
- 访问次数限制 + 有效期控制（从首次访问开始计时）
- **我的分享管理**：列出所有创建的分享，支持按类型筛选、复制链接、取消分享

### 管理员
- 全站仪表盘（30 秒自动刷新）
- 用户管理（创建/删除/封禁/授权，super_admin 不可通过 API 创建）
- 文件管理、IP 封禁管理（永久封禁 / 临时封禁，自定义时长）
- 系统配置（SMTP、上传限制、认证开关），敏感配置仅限 SUPER_ADMIN
- **安全规则配置**：超级管理员可视化调整攻击检测阈值（高频扫描/登录爆破/爬虫/异常下载）和自动封禁时长，热更新无需重启
- 文件类型过滤（黑名单/白名单双模式，危险类型带警告标识）
- **安全监控**：攻击检测告警面板、封禁统计、异常 IP 监控、告警管理
- **访问统计**：请求量、带宽、独立访客、峰值 QPS 实时监控，趋势折线图 + 状态码分布饼图（ECharts 6），按时间范围筛选，支持 30s/1min/5min 自动刷新
- **操作审计**：登录、配置变更、文件操作（含批量删除）、权限修改等安全事件全量记录，操作者自动关联用户名，支持按操作类型/用户/时间范围筛选，90 天自动清理

### 安全
- Telegram Bot Token 错误日志自动脱敏
- SMTP 密码不在事件日志中记录
- 注册流程防 TOCTOU 竞态（表锁 + FOR UPDATE）
- 配置缓存使用 upsert 原子操作
- Source map 生产关闭、.gitignore 覆盖密钥文件
- 前端全局错误边界防白屏
- **攻击检测系统**：自动检测高频扫描/登录爆破/爬虫/异常下载 4 种攻击行为，自动封禁 + 告警 + WebSocket 实时推送
- **安全规则可配置化**：超级管理员可热调整检测阈值和自动封禁时长，无需重启服务
- **IP 封禁**：支持永久封禁和临时封禁（自定义时长），自动封禁与手动封禁双模式
- **操作审计系统**：异步记录所有关键安全事件（登录/登录失败/权限变更/文件操作/配置修改/IP 封禁/批量删除），记录操作用户 ID，前端展示用户名
- **HTTP 访问日志**：全局中间件记录所有请求（IP/路径/状态码/耗时/带宽），数据持久化存储，30 天自动清理
- **审计日志**：90 天自动清理，防止数据库无限增长

### 遥测系统
- **前端遥测收集器**：自动采集 JS 错误、Vue 组件渲染失败、页面性能指标、设备环境信息
- **网络状态追踪**：Axios/fetch 拦截，4xx/5xx/3xx 响应自动上报路径和耗时
- **SPA 路由追踪**：Vue Router 路由切换性能自动记录，持续追踪后续行为
- **点击事件追踪**：静默记录用户点击，错误发生时上报前后 2+1 分钟上下文
- **白屏检测**：多维度判定（DOM 复杂度、交互元素、可见区域、采样点），准确识别白屏
- **组件渲染失败检测**：1 秒内连续 3 次 render/setup/mount 错误主动告警
- **控制台可视化**：生产环境实时打印遥测数据到浏览器 Console，按类型分色输出
- **管理后台遥测监控**：统计卡片、趋势图表、类型分布、页面性能概览、错误列表
- **数据导出**：超级管理员可按时间区间和类型导出遥测数据为 JSON 文件

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | NestJS 10 + TypeScript (CommonJS, strict mode) + TypeORM 0.3 |
| 数据库 | PostgreSQL ≥ 14 |
| 消息队列 | Bull 4.x + Redis |
| 前端 | Vue 3 + TypeScript + Vite 5 + TDesign + ECharts 6 |
| 存储 | Telegram Bot API（支持本地代理绕过限流） |
| 邮件 | Nodemailer + SMTP |
| 认证 | Passport JWT + bcryptjs |
| 实时推送 | Socket.IO 4.x（告警 WebSocket） |
| 状态管理 | Pinia |
| 路由 | Vue Router 4 |
| 仪表盘布局 | vue-grid-layout 2.4+ |

## 快速开始

**环境要求**：Node.js ≥ 18, PostgreSQL ≥ 14, Redis, Telegram Bot Token

```bash
# 确保 Redis 正在运行（Bull 消息队列依赖）

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
# 确保 Redis 正在运行
cd frontend && npm run build
cd ../backend && npm run build && npm run start:prod
# 后端直接服务前端静态文件，单端口部署
# HTTP 服务器空闲超时 120 秒（有数据传输时自动重置），支持大文件上传
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

# Redis（Bull 消息队列）
REDIS_HOST=localhost
REDIS_PORT=6379
# REDIS_PASSWORD=  # 可选：Redis 密码
# REDIS_DB=0

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
# SMTP_ENCRYPTION_KEY=your-encryption-key  # 必需：SMTP 密码 AES-256-CBC 加密密钥，未配置时启动报错
# SMTP_ENCRYPTION_SALT=smtp-encryption-salt  # 可选：加密盐

# 应用
APP_HOST=0.0.0.0
APP_PORT=3000
APP_URL=http://localhost:3000
FRONTEND_URL=http://localhost:5173
CORS_ORIGINS=http://localhost:5173
# SECURE_COOKIE=true  # 生产 HTTPS 环境启用 Cookie secure 标志
# TOKEN_EXTRACTION_MODE=both  # both（Cookie + Bearer）或 cookie_only

# 上传（启动后可从管理面板动态调整）
MAX_FILE_SIZE=83886080
FILE_TYPE_MODE=blacklist      # blacklist 或 whitelist
FILE_TYPE_FILTER=              # 逗号分隔的扩展名，如 .zip,.exe,.sh，空值不限制

# 日志保留策略（定时自动清理）
ACCESS_LOG_RETENTION_DAYS=30   # 访问日志保留天数
AUDIT_LOG_RETENTION_DAYS=90    # 审计日志保留天数
```

第一个注册的账号自动成为超级管理员。

## 项目结构

```
├── backend/src/
│   ├── main.ts               # 入口：CORS、Cookie、全局管道/拦截器、静态文件、超时配置、/files/public/ URL 重写
│   ├── app.module.ts         # 根模块（TypeORM、Schedule、事件发射器）
│   ├── auth/                 # 登录/注册/邮箱验证/密码重置/状态查询
│   ├── user/                 # 个人信息/密码修改/统计
│   ├── file/                 # 上传/下载/删除/分享/公开访问/缩略图加密/批量上传；/files/public/:id 302 重定向到 /s/:id（懒创建 ShareLink）
│   ├── folder/               # 文件夹模块（闭包表层级管理：创建/重命名/移动/软删除/恢复/列出内容/面包屑）
│   ├── share/                # 分享链接模块（独立 ShareLink 实体：创建/列出/修改/取消；公开端点 /s/:token 元数据+密码验证+下载+文件夹浏览）
│   ├── admin/                # 用户/文件/IP封禁/系统配置管理/仪表盘/访问统计/审计日志
│   ├── alert/                # 告警模块（规则评估 + WebSocket 推送）
│   ├── jobs/                 # Bull 任务队列（指标聚合/攻击检测/告警评估/基线计算/数据归档）
│   ├── tag/                  # 标签模块（CRUD + 文件关联）
│   ├── telemetry/            # 遥测模块（前端事件上报收集）
│   ├── security/             # 行为异常检测（6 种异常模式）
│   ├── telegram/             # Telegram Bot API 上传下载（流式传输，Token 脱敏）
│   ├── mailer/               # SMTP 邮件
│   ├── config/               # 动态配置缓存
│   ├── tasks/                # 定时清理（限流/Token/封禁/访问日志/审计日志）
│   ├── common/
│   │   ├── entities/         # 17 个数据实体（含 Folder、ShareLink）
│   │   ├── services/         # ConfigCacheService + RateLimitService + AuditService
│   │   ├── guards/           # JWT 认证 + 角色权限守卫
│   │   ├── decorators/       # @CurrentUser @Roles
│   │   ├── interceptors/     # 统一响应 { code, message, data }
│   │   ├── middleware/       # AccessLogMiddleware（全局 HTTP 请求日志）
│   │   └── utils/            # client-ip.ts crypto.util.ts
│   ├── database/             # TypeORM CLI DataSource
│   └── migrations/           # 22 个数据库迁移文件
│
├── frontend/src/
│   ├── views/
│   │   ├── auth/             # Login.vue Register.vue
│   │   ├── user/             # Dashboard FileList（网盘主页面，卡片/列表双视图） Shares（我的分享管理） Settings
│   │   ├── share/            # ShareView（SPA 分享页状态机） PasswordPrompt（严格模式密码卡片） FileShareCard（文件信息卡+下载按钮） FolderShareBrowser（文件夹分享层级浏览）
│   │   ├── admin/            # Dashboard Users Files Config AccessLogs AuditLogs SourceAnalysis UserActivity BandwidthAnalysis FileTypeAnalysis AlertManagement SecurityMonitor DashboardCustomizer
│   │   └── layout/           # 侧边栏布局（含「我的分享」入口）
│   ├── components/
│   │   ├── folder/           # FolderTree（左侧文件夹树+右键菜单） FolderBreadcrumb FolderCreateDialog FolderRenameDialog FolderMoveDialog（支持批量文件移动）
│   │   ├── file/             # FileCard（文件卡片，悬停显示操作按钮） FolderCard（文件夹卡片，区分样式）
│   │   ├── share/            # CreateShareDialog（创建分享弹窗，支持密码/有效期/次数设置）
│   │   └── ...               # UploadModal ThumbnailImg TagManager FileTagEditor
│   ├── composables/          # useAutoRefresh useCursorPagination useTimeRange useMobile
│   ├── stores/               # auth files tags folders（文件夹树/面包屑/CRUD） (Pinia)
│   ├── router/               # 四级路由守卫链 + redirect 安全校验 + /s/:token 公开分享路由（meta.public 跳过登录）
│   ├── api/                  # axios 客户端（30s 超时，401 防抖，410 Gone 分享失效处理）
│   ├── types/                # TS 类型定义
│   └── utils/                # error.ts format.ts thumbnail.ts telemetry.ts(遥测收集器)
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
| GET | `/files/public/:id` | 老分享链接入口 → 302 重定向到 `/s/:id`（懒创建 ShareLink，复制文件遗留约束） |
| GET | `/api/files/upload-config` | 上传配置 |
| GET | `/api/s/:token` | 分享公开入口：返回文件/文件夹元数据（**不返回字节**）；严格模式密码保护：未验证时只返回 `{ requiresPassword: true }` |
| POST | `/api/s/:token/verify` | 提交密码验证，返回 5 分钟 access JWT |
| GET | `/api/s/:token/download/:fileId` | 分享文件下载（需 access JWT 或无密码），流式返回 |
| GET | `/api/s/:token/folder/:folderId/contents` | 浏览文件夹分享中的子文件夹内容（子文件夹 + 文件列表） |
| GET | `/api/s/:token/folder/:folderId/breadcrumb` | 返回从分享根文件夹到当前 folder 的路径（面包屑） |

### User（需登录）
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/verify-email` | 邮箱验证 |
| POST | `/api/auth/reset-password` | 重置密码 |
| GET | `/api/users/me/stats` | 个人统计 |
| POST | `/api/files/upload-multiple` | 批量上传 |
| GET | `/api/files` | 文件列表（支持 `folderId` 过滤：`root`=根目录，UUID=指定文件夹） |
| DELETE | `/api/files/:id` | 请求删除文件（7天冷静期） |
| POST | `/api/files/:id/restore` | 恢复已删除文件 |
| POST | `/api/files/:id/force-delete` | 强制永久删除 |
| GET | `/api/files/:id/download` | 下载（后端代理流式转发） |
| GET | `/api/files/:id/thumbnail?t=` | 缩略图预览 |
| PATCH | `/api/files/:id/move` | 移动文件到指定文件夹（`folderId: null`=根目录） |
| GET | `/api/files/:id/share` | 生成分享链接（旧端点，建议用 POST /api/shares） |
| PUT | `/api/files/:id/password` | 设置密码（遗留端点，新分享用 POST /api/shares） |
| PUT | `/api/files/:id/access-type` | 公开/私有 |
| PUT | `/api/files/:id/access-count` | 访问限制（遗留端点） |
| PUT | `/api/files/:id/expires` | 有效期（遗留端点） |
| POST | `/api/files/batch-markdown` | 批量 Markdown |
| GET | `/api/files/public-key` | RSA-OAEP 加密公钥 |
| GET | `/api/tags` | 用户标签列表（含文件计数） |
| POST | `/api/tags` | 创建标签 |
| PUT | `/api/tags/:id` | 更新标签 |
| DELETE | `/api/tags/:id` | 删除标签 |
| PUT | `/api/files/:id/tags` | 批量设置文件标签 |
| DELETE | `/api/files/:id/tags/:tagId` | 移除文件标签 |

### 文件夹（需登录）
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/folders` | 创建文件夹（`parentId: null`=根目录） |
| GET | `/api/folders/tree` | 返回当前用户的完整文件夹树（左侧导航） |
| GET | `/api/folders/breadcrumb?parentId=` | 返回从根到指定 folder 的路径 |
| GET | `/api/folders/contents?parentId=` | 列出子文件夹 + 文件（主区域视图） |
| PATCH | `/api/folders/:id` | 重命名文件夹 |
| PATCH | `/api/folders/:id/move` | 移动文件夹到新父级（循环检测） |
| DELETE | `/api/folders/:id` | 软删除文件夹（联动子树+内含文件，7天冷静期） |
| POST | `/api/folders/:id/restore` | 恢复已删除文件夹（只恢复同时删除的文件） |

### 分享链接（需登录）
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/shares` | 创建分享（`targetType: file\|folder`，可选密码/有效期/次数限制） |
| GET | `/api/shares` | 列出我的分享（分页，可按 targetType 过滤） |
| GET | `/api/shares/:id` | 查看分享详情（返回 `hasPassword` 布尔值，不暴露密码哈希） |
| PATCH | `/api/shares/:id` | 更新分享设置（密码/有效期/次数） |
| DELETE | `/api/shares/:id` | 取消分享（软删除） |

### Admin / Super Admin
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/stats` | 全站统计 |
| GET | `/api/admin/users` | 用户列表 |
| POST | `/api/admin/users` | 创建用户 |
| PUT | `/api/admin/users/:id/role` | 修改用户角色 |
| DELETE | `/api/admin/users/:id` | 删除用户 |
| GET | `/api/admin/files` | 全站文件管理 |
| DELETE | `/api/admin/files/:id` | 删除任意用户文件 |
| GET | `/api/admin/banned-ips` | IP 封禁列表 |
| POST | `/api/admin/banned-ips` | 封禁 IP |
| DELETE | `/api/admin/banned-ips/:ip` | 解封 IP |
| PUT | `/api/admin/config` | 系统配置（仅 SUPER_ADMIN） |
| PUT | `/api/admin/config/batch` | 批量配置 |
| PUT | `/api/admin/upload-config` | 上传配置 |
| PUT | `/api/admin/auth-config` | 认证配置 |
| PUT | `/api/admin/smtp-config` | SMTP 配置 |
| GET | `/api/admin/security-config` | 安全规则配置（仅 SUPER_ADMIN） |
| PUT | `/api/admin/security-config` | 更新安全规则配置 |
| GET | `/api/admin/access-logs` | HTTP 访问日志（分页/筛选） |
| GET | `/api/admin/access-logs/stats` | 访问统计 |
| GET | `/api/admin/access-logs/trend` | 流量趋势 |
| GET | `/api/admin/audit-logs` | 操作审计日志 |

### 遥测
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/telemetry/report` | 上报遥测事件（无需认证） |
| GET | `/api/admin/telemetry/stats` | 遥测聚合统计（趋势+类型分布） |
| GET | `/api/admin/telemetry/records` | 遥测记录列表（分页+类型筛选） |
| GET | `/api/admin/telemetry/errors` | 最近错误摘要 |
| GET | `/api/admin/telemetry/performance` | 页面性能概览（按 URL 聚合各阶段耗时） |
| GET | `/api/admin/telemetry/export` | 导出遥测数据为 JSON 文件 |

## 许可证

GNU General Public License v3.0
