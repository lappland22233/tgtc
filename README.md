# 文件分发系统

基于 NestJS、Vue 3、TypeORM、Redis 与 Telegram Bot API 的文件分发与网盘系统。元数据数据库默认使用 PostgreSQL，也正式支持显式 opt-in 的 SQLite 单机部署。系统提供层级文件夹、标签、同步/异步/分片上传、私有与公开访问、独立分享链接、管理员审计、安全监控和访问分析。

## 核心能力

### 用户与权限

- 邮箱注册、登录、验证码验证和密码重置
- JWT 身份认证，令牌存储于 HttpOnly Cookie
- `super_admin`、`admin`、`user` 三级角色权限
- 登录、验证码、文件密码和分享密码的频率限制与临时封禁
- 第一个成功注册的账号自动成为 `super_admin`

### 文件与文件夹

- 闭包表（closure-table）文件夹树，支持创建、重命名、移动、软删除和恢复
- 文件卡片/列表双视图、搜索、排序、无限滚动和文件夹过滤
- 用户隔离的标签 CRUD 与多标签 AND 筛选
- 文件重命名、移动、轻量复制、批量 Markdown 链接生成
- 同步上传、Bull 异步上传、分片上传和断点状态查询
- 文件类型黑名单/白名单与动态上传大小限制
- 7 天删除冷静期，支持恢复和永久删除
- 图片缩略图及 RSA-OAEP 短时访问令牌

### 下载与缓存

- 下载由后端代理，不向浏览器暴露 Telegram Bot Token 或原始文件地址
- 本地文件缓存默认上限 10 GB、最低剩余空间 1 GB、TTL 3 天，可在管理后台热更新
- 冷文件可通过二次开发的 Telegram Bot API 实时流端点边下载边构建缓存
- 同一文件并发冷下载只建立一个上游回源；各客户端从临时缓存独立跟随读取
- 缓存使用临时文件、大小校验和原子发布；失败会清理不完整文件
- Range 下载仅在完整缓存命中时返回 `206`；冷文件 Range 请求回退为完整 `200` 下载

### 分享

- 独立 `ShareLink` 模型，同一文件或文件夹可创建多条分享链接
- SPA 分享页 `/s/:token`，支持文件信息卡片和文件夹层级浏览
- 可设置密码、有效期和最大访问次数
- 严格密码模式：验证成功前不返回目标文件或文件夹元数据
- 文件夹分享支持子目录、面包屑和单文件下载
- 我的分享列表支持筛选、复制链接、修改和取消
- 旧入口 `/files/public/:id` 兼容重定向至分享页

### 管理与可观测性

- 全站统计、自定义仪表盘、用户管理和全站文件管理
- 管理员“文件管理”使用独立的 `GET /api/admin/files` 全量查询；“我的文件”使用 `GET /api/files`，两者相互隔离
- SMTP、上传、认证、缓存和安全规则配置
- 永久/临时 IP 封禁、攻击检测、行为异常检测和 WebSocket 告警
- HTTP 访问日志、带宽与延迟分析、来源/UA 分析、用户活跃度和文件类型统计
- 操作审计与 CSV/JSON 数据导出


## 技术栈

| 层级 | 技术 |
|---|---|
| 后端 | NestJS 11、TypeScript、TypeORM 0.3 |
| 前端 | Vue 3.5、TypeScript、Vite 6、TDesign Vue Next |
| 数据库 | PostgreSQL 14+（默认）/ SQLite 3（单机显式 opt-in） |
| 队列 | Bull 4、Redis |
| 文件存储 | Telegram Bot API / 二次开发本地 Bot API |
| 认证 | Passport JWT、bcryptjs、HttpOnly Cookie |
| 邮件 | Nodemailer、SMTP |
| 实时通信 | Socket.IO |
| 图表 | ECharts 6 |
| 图片处理 | sharp |
| 状态与路由 | Pinia、Vue Router 4 |

> `frontend` 依赖 `grid-layout-plus`，当前仪表盘主要使用原生 CSS Grid 布局。

## 环境要求

- Node.js 18+
- npm（项目未使用 yarn 或 pnpm）
- PostgreSQL 14+（默认、推荐用于多实例和较高写并发），或 SQLite 3（仅单实例/低写并发，必须设置 `DB_TYPE=sqlite`）
- Redis（两种数据库模式均必需，Bull 队列不由 SQLite 替代）
- Telegram Bot Token 与用于存储文件的 Chat ID（两种数据库模式均必需，SQLite 只保存元数据）
- 可选：SMTP 服务
- 可选：自建或本项目二次开发的 `telegram-bot-api`

## 快速开始

### 1. 创建数据库

```sql
CREATE DATABASE file_distribution;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
```

迁移会尝试创建 `uuid-ossp`。如果数据库账号没有创建扩展的权限，请先使用 PostgreSQL 超级用户执行第二条语句。

SQLite 无需创建数据库服务，但不会被默认启用。SQLite 单机首次部署示例：

```env
DB_TYPE=sqlite
DB_DATABASE=./data/tgtc.sqlite
DB_SQLITE_BUSY_TIMEOUT_MS=5000
DB_MIGRATIONS_RUN=false
```

随后在 `backend` 工作目录执行 `npm run migration:run:sqlite`。相对数据库路径按进程当前工作目录解析，因此 systemd/容器/PM2 的工作目录必须固定且与迁移命令一致。

### 2. 配置并启动后端

```bash
cd backend
cp .env.example .env
npm install
npm run migration:run
npm run start:dev
```

启动前必须编辑 `backend/.env`，至少正确设置：

- `DB_HOST`、`DB_PORT`、`DB_USERNAME`、`DB_PASSWORD`、`DB_DATABASE`
- 长度不少于 32 字符的 `JWT_SECRET`
- `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`
- `CORS_ORIGINS=http://localhost:5173`

如果配置了 `SMTP_HOST`，还必须同时配置完整 SMTP 参数以及 `SMTP_ENCRYPTION_KEY`、`SMTP_ENCRYPTION_SALT`；否则启动校验会拒绝启动。暂不使用邮件时，应移除或注释全部 SMTP 配置，并在系统认证配置中关闭依赖邮件的功能。

后端开发服务器默认监听 `http://0.0.0.0:3000`。

### 3. 启动前端

```bash
cd frontend
npm install
npm run dev
```

前端默认访问地址为 `http://localhost:5173`，Vite 将 `/api` 代理到 `http://localhost:3000`。

如需修改开发代理目标，在 `frontend/.env` 中设置：

```env
VITE_API_PROXY_TARGET=http://localhost:3000
```

生产前端固定使用同源 `/api`，不读取独立 API 基址。

## 环境变量

以下为关键配置，完整示例见 `backend/.env.example`。

### 数据库

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `DB_TYPE` | `postgres` | `postgres`（默认）或 `sqlite`；SQLite 必须显式 opt-in |
| `DB_HOST` | `localhost` | PostgreSQL 地址，仅 PostgreSQL 必需 |
| `DB_PORT` | `5432` | PostgreSQL 端口，仅 PostgreSQL 必需 |
| `DB_USERNAME` | `postgres` | 数据库用户，仅 PostgreSQL 必需 |
| `DB_PASSWORD` | - | 数据库密码，仅 PostgreSQL 必需 |
| `DB_DATABASE` | PG: `test` / SQLite: `data/tgtc.sqlite` | PostgreSQL 数据库名或 SQLite 文件路径；相对路径基于进程工作目录 |
| `DB_SQLITE_BUSY_TIMEOUT_MS` | `5000` | SQLite 写锁等待上限；超时仍会失败，不等于提高写并发能力 |
| `DB_SYNCHRONIZE` | `false` | 兼容项；实现始终关闭，表结构只能由迁移管理 |
| `DB_MIGRATIONS_RUN` | `false` | 启动时自动执行迁移；生产推荐部署前显式运行 |
| `DB_POOL_SIZE` | `20` | PostgreSQL 连接池上限，最大允许 200；SQLite 不适用 |
| `DB_CONNECTION_TIMEOUT_MS` | `5000` | 获取数据库连接超时 |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | PostgreSQL statement timeout |
| `DB_QUERY_TIMEOUT_MS` | `35000` | 驱动查询超时，不得小于 statement timeout |
| `DB_LOCK_TIMEOUT_MS` | `3000` | 数据库锁等待超时 |
| `DB_IDLE_TRANSACTION_TIMEOUT_MS` | `30000` | 空闲事务超时 |
| `DB_SSL` | `false` | 是否启用数据库 TLS |

生产环境不要使用 `DB_SYNCHRONIZE=true`，应通过迁移管理结构变化。

#### 数据库正式支持矩阵与 SQLite 运维边界

| 能力/场景 | PostgreSQL 14+ | SQLite 3 |
|---|---|---|
| 默认启用 | 是（未设置 `DB_TYPE` 时使用） | 否，必须 `DB_TYPE=sqlite` |
| 部署形态 | 单实例或多实例 | 仅单应用实例、单 SQLite 文件、低写并发 |
| Schema 生命周期 | PostgreSQL 迁移链 | 独立 SQLite 基线与增量迁移链 |
| 队列与文件存储 | 仍需 Redis + Telegram | 仍需 Redis + Telegram |
| 建议用途 | 生产默认、较高并发 | 小规模单机生产、开发/验收 |

SQLite 允许并发读取，但写入最终串行化。`DB_SQLITE_BUSY_TIMEOUT_MS` 仅控制等待锁的时长；超过上限仍可能出现 `SQLITE_BUSY`。不要多开后端实例共享同一 SQLite 文件，不要将数据库置于 NFS/SMB 等网络文件系统，也不要把高频写负载误当作已获得与 PostgreSQL 相同的并发能力；达到这些需求时使用 PostgreSQL。

迁移与发布步骤：停止写流量（SQLite 建议停应用）→ 备份 → 执行对应迁移命令 → 运行检查 → 启动。PostgreSQL 使用 `npm run migration:run:postgres`（原 `migration:run` 外部 DB 路径仍保留）；SQLite 使用 `npm run migration:run:sqlite`。SQLite 发布门禁为 `npm run gate:sqlite`，覆盖隔离迁移链、真实文件迁移/回滚重放、完整性、关键仓储业务与锁冲突测试；该门禁使用测试替身处理业务外围依赖，**不代表真实 Redis 或 Telegram 网络端到端验证**。

SQLite 备份前应停止应用或使用 SQLite 在线备份能力取得一致快照，不要在写入期间直接复制单个文件。至少保留数据库文件及同目录可能存在的 `-wal`/`-shm` 文件的一致集合；恢复时先停应用，在同一固定路径完整替换并检查权限，再运行 `PRAGMA integrity_check` 与迁移。数据库备份不能替代 Telegram Bot API workdir 备份。

### 应用与认证

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `NODE_ENV` | `development` | `development/test/staging/production` |
| `APP_HOST` | `127.0.0.1` | 监听地址；示例配置为 `0.0.0.0` |
| `APP_PORT` | `3000` | 服务端口 |
| `APP_URL` | `http://localhost:3000` | 对外公开地址，用于分享链接 |
| `FRONTEND_URL` | - | CORS 单一来源回退值 |
| `CORS_ORIGINS` | - | 逗号分隔的允许来源，优先于 `FRONTEND_URL` |
| `JWT_SECRET` | - | 至少 32 字符，启动必检 |
| `JWT_EXPIRES_IN` | `7d` | JWT 有效期 |
| `SECURE_COOKIE` | `false` | HTTPS 生产环境建议设为 `true` |
| `TOKEN_EXTRACTION_MODE` | `both` | `both` 或 `cookie_only` |
| `TRUST_PROXY_HOPS` | `1` | Express 信任的反向代理跳数 |

启用 Cookie 凭据时禁止将 `CORS_ORIGINS` 配置为 `*`。多层代理部署必须根据真实拓扑设置 `TRUST_PROXY_HOPS`，并确保上游正确维护 `X-Forwarded-For`。

### Redis 与 Bull

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `REDIS_HOST` | `localhost` | Redis 地址 |
| `REDIS_PORT` | `6379` | Redis 端口 |
| `REDIS_PASSWORD` | - | Redis 密码 |
| `REDIS_DB` | `0` | Redis DB |
| `REDIS_TLS` | `false` | 是否启用 TLS |
| `REDIS_TLS_REJECT_UNAUTHORIZED` | `true` | 是否校验 Redis TLS 证书 |

Redis 承载 `metrics-aggregation`、`attack-detection`、`alert-evaluation`、`baseline-calculation`、`data-archival` 和 `file-upload` 六个队列。Redis 不可用会影响异步上传和后台任务。

### Telegram 与本地缓存

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `TELEGRAM_BOT_TOKEN` | - | Bot Token，启动必检 |
| `TELEGRAM_CHAT_ID` | - | 文件存储 Chat ID，启动必检 |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | 官方或自建 Bot API 地址 |
| `TELEGRAM_MAX_UPLOAD_SIZE` | `2147483648` | Telegram 服务层上传上限 |
| `TELEGRAM_LOCAL_FILE_DIR` | - | 自建 Bot API 本地文件目录白名单 |
| `TELEGRAM_FILE_STREAMING_ENABLED` | `false` | 是否使用二次开发实时流端点 |
| `TELEGRAM_FILE_STREAM_BASE` | `TELEGRAM_API_BASE` | 实时流服务地址 |
| `TELEGRAM_FILE_STREAM_TIMEOUT_SECONDS` | `120` | 实时流请求超时 |
| `FILE_CACHE_BUILD_IDLE_TIMEOUT_MS` | `60000` | 缓存构建无进展超时 |
| `FILE_CACHE_BUILD_TOTAL_TIMEOUT_MS` | `1800000` | 单次缓存构建总时限 |
| `THUMBNAIL_DIR` | `tmp/thumbnails` | 缩略图目录 |
| `FILE_PROCESSING_STALE_MINUTES` | `60` | 上传队列僵尸任务恢复阈值（分钟） |

实时流要求二次开发 Bot API 使用 `--enable-file-streaming` 启动，后端访问：

```text
/stream/file/bot<TOKEN>/<encoded-file-id>
```

缓存容量、最低磁盘空间和 TTL 存放在系统配置中，默认分别为 10 GB、1 GB、3 天，可从超级管理员后台热更新。

## Telegram 文件引用完整性

### Bot API workdir 持久性（根因预防）

文件存储的 Telegram `file_id` 与 Bot API 的 **session + 本地文件目录（`--dir` workdir）** 强绑定：

- **一旦更换 `--dir`、清空或重命名 workdir，所有历史 `file_id` 将立即失效（404）**，对应文件全部不可下载；
- 后端 `TELEGRAM_LOCAL_FILE_DIR` 必须与 systemd 服务 `ExecStart` 中的 `--dir` 参数**完全一致**；
- 禁止使用 `/tmp` 等临时目录作为 workdir（会被系统清理）；
- 禁止在同一 Bot Token 上使用多个不同的 `--dir` 交替启动；
- workdir 是不可变的持久化资产。尤其不得删除、截断、覆盖或排除其中的 `db.sqlite` 与 `td.binlog`；它们不是本项目可重建的缓存；
- 备份/迁移时必须在 Bot API 停止或取得一致快照后整体保留 workdir（含 `db.sqlite`、`td.binlog`、session、documents 等），不可只复制后端 PostgreSQL/SQLite 元数据库。恢复时也必须整体恢复到原绝对路径，并保持属主与权限。

`deploy.sh` 已在编译本地 Bot API 阶段加入 workdir 一致性检查（绝对路径、非 `/tmp`、已有数据时提示保留）。

### 僵尸上传自动恢复

上传通过 Bull 队列异步提交到 Telegram。若进程异常退出或队列任务丢失，文件会长期停留在 `processing`。后端定时任务（每 30 分钟）会自动将 `status=processing` 且超过 `FILE_PROCESSING_STALE_MINUTES`（默认 60 分钟）未更新的记录标记为 `error`，前端显示"上传失败"，用户可重新上传。

### 管理后台文件体检

管理后台保留普通分析与运营能力，包括管理后台首页、Bandwidth、AccessLogs、SourceAnalysis、UserActivity 等页面；普通用户的默认仪表盘 `/dashboard` 也不受影响。管理后台自定义仪表盘及其 CRUD API 已下线，旧前端路径 `/admin/dashboard-customizer` 会重定向到 `/admin`。部署新增迁移 `1798200000000-DropDashboardConfigs`，用于删除历史 `dashboard_configs` 表；不要修改或回滚已执行的历史迁移。

超级管理员在 **文件管理** 页面可执行"文件体检"。体检是**持久化后台任务**（Bull `file-verify` 队列），发起后立即返回任务 ID（HTTP 202），由后台分批校验，前端通过轮询查看实时进度，刷新页面可恢复，同一时间全局仅允许一个活动任务：

- `POST /api/admin/files/verify`：创建体检任务，返回 `{ task, isNewTask }`；已有活动任务时返回现有任务（`isNewTask=false`）；
- `GET /api/admin/files/verify/active`：查询当前活动任务，无任务返回 `null`；
- `GET /api/admin/files/verify/:taskId`：查询任务状态、进度与最终统计。

行为约定：

- **dry-run（默认）**：仅统计，不修改数据；
- **apply**：校验 `ready` 文件在 Telegram 端是否存在——确认失效的标记为 `error`，路径缺失且校验返回本地路径时回填；
- 仅明确的永久性错误（`invalid file_id` / `file not found`）会被标记；网络超时、429、5xx 只计入统计，不误标；
- 体检通过 Telegram Bot API `getFile` **仅获取元数据，不下载文件内容**。使用本项目二次开发的本地 Bot API 时，请求携带 `metadata_only=true`：Bot API 只做 `file_id` 校验后直接返回，**不会调用 TDLib `downloadFile` 预载文件**（官方/未升级的 Bot API 会忽略该参数，默认仍只返回元数据）；
- 体检分批有限并发执行，核心操作记录脱敏审计统计；
- 任务状态（`queued/running/completed/failed`）、进度与统计持久化在 `file_verify_tasks` 表；失败时仅保留脱敏错误摘要；
- 进程崩溃时由 Bull 对 stalled job 重新投递接管执行；应用启动时会清理"入库后未入队"的孤儿任务，释放活动槽位。

> **部署提醒**：`metadata_only` 是本地二次开发 Bot API 的扩展。升级后**必须重新编译并重启 `telegram-bot-api`**，否则该参数会被旧二进制忽略，体检仍可能触发 `downloadFile` 预载。构建方法见"部署"章节（`cmake -DCMAKE_BUILD_TYPE=Release ..` + `cmake --build .`）。

### SMTP

| 变量 | 说明 |
|---|---|
| `SMTP_HOST`、`SMTP_PORT` | SMTP 地址与端口 |
| `SMTP_SECURE` | 必须为 `true` 或 `false` |
| `SMTP_USER`、`SMTP_PASSWORD`、`SMTP_FROM` | SMTP 凭据与发件地址 |
| `SMTP_ENCRYPTION_KEY` | SMTP 密码加密密钥；启用 SMTP 时必需 |
| `SMTP_ENCRYPTION_SALT` | 密钥派生盐；启用 SMTP 时必需 |

不要提交实际 `.env`、Bot Token、数据库密码或 SMTP 密钥。

## 上传模式

| 模式 | 端点 | 适用场景 |
|---|---|---|
| 同步单文件 | `POST /api/files/upload` | 小文件或无代理超时风险 |
| 同步批量 | `POST /api/files/upload-multiple` | 最多 10 个文件 |
| 异步单文件 | `POST /api/files/upload-async` | 大文件，接收完成后由 Bull 上传 Telegram |
| 异步批量 | `POST /api/files/upload-multiple-async` | 最多 10 个文件 |
| 异步状态 | `GET /api/files/upload-status/:jobId` | 查询后台任务结果 |
| 分片初始化 | `POST /api/files/chunk/init` | 创建分片会话，可携带 `folderId` |
| 分片状态 | `GET /api/files/chunk/:uploadId/status` | 获取已上传分片 |
| 上传分片 | `POST /api/files/chunk/:uploadId` | multipart：`chunk` + `index` |
| 完成分片 | `POST /api/files/chunk/:uploadId/complete` | 后台合并并进入上传队列 |
| 取消分片 | `POST /api/files/chunk/:uploadId/abort` | 取消会话并清理临时文件 |

Multer 单文件硬上限为 600 MB，单分片硬上限为 100 MB；实际业务上限由 `MAX_FILE_SIZE` 或管理后台动态配置决定，默认示例为 80 MB。

### Linux x64 预编译发行版

正式发行文件按版本存放于 `.Releases/v<版本>/`。完整 Linux x64 包包含已构建前端、后端生产依赖、Node.js 运行时和二次开发 Telegram Bot API 可执行文件：

```text
.Releases/
├── tgtc-v1.x.x-linux-x64.tar.gz
├── SHA256SUMS
├── RELEASE.txt
└── README.md
```

发行包不包含 TypeScript 源码、测试和开发依赖。数据库结构仍由包内编译后的正式运行时迁移维护；这些迁移不是开发文件，新库初始化和后续升级均依赖它们。

### 手工生产部署

```bash
# 前端
cd frontend
npm ci
npm run build

# 后端
cd ../backend
npm ci
npm run migration:run
npm run build
NODE_ENV=production npm run start:prod
```

生产模式由 NestJS 直接服务 `frontend/dist`，API 前缀为 `/api`，SPA 导航回退到 `index.html`。

### 部署注意事项

1. **持久化目录**：后端需要对工作目录下的 `tmp/` 有读写权限。该目录包含：
   - `tmp/Cache`：下载缓存
   - `tmp/uploads`：异步上传与分片临时文件
   - `tmp/thumbnails`：缩略图
   - `tmp/logs`：应用日志
2. **反向代理**：正确设置 `X-Forwarded-For` 和 `X-Forwarded-Proto`，并匹配 `TRUST_PROXY_HOPS`。
3. **大文件**：提高代理请求体限制和读写超时；下载链路应关闭不必要的代理缓冲并透传 Range 请求。
4. **HTTPS**：设置 `SECURE_COOKIE=true`，配置明确的 `CORS_ORIGINS`，不要使用通配符。
5. **迁移**：生产环境保持 `DB_SYNCHRONIZE=false`，部署前运行 `npm run migration:run`。
6. **多实例**：当前分片会话与部分上传任务状态保存在单实例内存，本地临时文件和缓存也依赖实例磁盘。多实例部署需要会话粘性与共享存储，或先将相关状态外置。文件缓存（`tmp/Cache`）、缩略图（`tmp/thumbnails`）与冷回源会话状态均为**实例本地**，`FILE_CACHE_NO_CACHE_MODE=true` 可跳过磁盘缓存，但各实例仍有独立的 spool 与会话并发预算。
7. **优雅退出**：应用已启用 Nest shutdown hooks；进程管理器应发送可处理的终止信号并给予日志 flush 时间。

HTTP 服务器参数：活动连接空闲超时 120 秒、Keep-Alive 65 秒、请求头超时 66 秒；上传端点另行禁用请求超时。

## 项目结构

```text
backend/src/
├── auth/             认证、验证码和密码重置
├── user/             用户资料、统计和管理员用户管理
├── file/             文件、异步/分片上传、下载、缓存和缩略图
├── folder/           闭包表文件夹树与文件移动/复制
├── share/            独立分享链接与公开分享访问
├── tag/              用户标签和文件关联
├── admin/            全站管理、分析、配置和日志查询
├── alert/            告警规则、持久化与 WebSocket 推送
├── jobs/             六个 Bull 队列及处理器
├── security/         行为异常检测

├── telegram/         Telegram 上传、下载和实时流客户端
├── mailer/           SMTP 邮件服务
├── tasks/            定时清理任务
├── common/           17 个实体、守卫、拦截器、过滤器和公共服务
├── database/         TypeORM CLI DataSource
└── migrations/       28 个迁移文件

frontend/src/
├── views/auth/       登录与注册
├── views/user/       仪表盘、我的文件、我的分享和设置
├── views/share/      公开分享页
├── views/admin/      已注册的管理员页面
├── components/       文件、文件夹、分享、上传与导航组件
├── composables/      自动刷新、分页、移动端和分片上传逻辑
├── stores/           Pinia 认证、文件、文件夹和标签状态
├── api/              Axios 客户端与管理员文件专用 API
├── router/           公开、登录、用户和管理员路由守卫
├── types/            TypeScript 类型
└── utils/            格式化、缩略图和权限工具
```

当前后端注册 17 个 TypeORM 实体，`app.module.ts` 与 `database/data-source.ts` 的实体列表必须保持同步。

## 常用命令

### 后端

```bash
cd backend
npm run start:dev
npm run typecheck
npm run build
npm test
npm run test:cov
npm run migration:create
npm run migration:generate
npm run migration:run             # 环境驱动，未设置 DB_TYPE 时为 PostgreSQL
npm run migration:run:postgres    # 显式 PostgreSQL（外部 DB 路径）
npm run migration:run:sqlite      # 显式 SQLite
npm run migration:revert
npm run migration:revert:postgres
npm run migration:revert:sqlite
npm run gate:sqlite               # SQLite 迁移 + 真实文件集成发布门禁
npm run start:prod
```

`migration:generate` 默认生成到 `src/migrations/Migration.ts`，生成后应使用时间戳和语义化名称重命名；也可以直接调用 TypeORM CLI 指定目标文件名。

### 前端

```bash
cd frontend
npm run dev
npm run typecheck
npm run build
npm run preview
```

## API 概览

所有 API 正常响应由全局拦截器统一包装为：

```json
{
  "code": 0,
  "message": "success",
  "data": {}
}
```

流式下载和导出端点直接返回文件内容，不使用 JSON 包装。

媒体直链格式为 `https://your-domain.example/media/<file-id>`，可用于 Markdown、`<img>`、`<audio>` 和 `<video>`。直链仅对公开、未删除、无密码、无访问次数限制、无有效期限制的图片/音频/视频生效；响应使用原始 MIME、`Content-Disposition: inline` 和一小时公共缓存。视频/音频在本地缓存命中后支持 Range，冷文件首次请求回退为完整响应并建立缓存。

### 公开接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/auth/register` | 注册 |
| `POST` | `/api/auth/login` | 登录并写入 Cookie |
| `POST` | `/api/auth/logout` | 登出并清除 Cookie |
| `POST` | `/api/auth/send-code` | 发送验证码 |
| `POST` | `/api/auth/verify-email` | 验证邮箱 |
| `POST` | `/api/auth/reset-password` | 重置密码 |
| `GET` | `/api/auth/status` | 查询认证功能配置 |
| `GET` | `/api/files/upload-config` | 查询上传限制 |
| `GET` | `/api/s/:token` | 分享元数据或密码要求 |
| `POST` | `/api/s/:token/verify` | 验证分享密码并签发短期访问令牌 |
| `GET` | `/api/s/:token/download/:fileId` | 分享下载 |
| `GET` | `/api/s/:token/preview/:fileId` | 分享页内预览（Range 命中 206，不消费访问额度） |
| `GET` | `/api/s/:token/cache-status/:fileId` | 分享缓存状态（`cached`/`cold`） |
| `GET` | `/api/s/:token/thumbnail/:fileId` | 分享缩略图（凭证 Cookie 鉴权） |
| `GET` | `/api/s/:token/thumbnail-hd/:fileId` | 分享高清视频封面 |
| `GET` | `/api/s/:token/folder/:folderId/contents` | 浏览分享文件夹 |
| `GET` | `/api/s/:token/folder/:folderId/breadcrumb` | 分享面包屑 |

| `GET` | `/media/:id` | 公开媒体直链，直接返回图片、音频或视频本体 |
| `GET` | `/files/public/:id` | 旧分享入口兼容重定向 |

### 登录用户接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/auth/me` | 当前用户 |
| `GET` | `/api/users/me/stats` | 当前用户统计 |
| `PUT` | `/api/users/me/password` | 修改密码 |
| `GET` | `/api/files` | **当前用户文件列表**；管理员访问此端点默认仍查询自己的文件 |
| `GET` | `/api/files/:id` | 文件详情 |
| `GET` | `/api/files/:id/download` | 登录用户下载 |
| `GET` | `/api/files/:id/preview` | 页内在线预览（Range 命中 206，冷文件回退全量） |
| `GET` | `/api/files/:id/cache-status` | 缓存状态（`cached`/`cold`），前端据此决定单连接策略 |
| `GET` | `/api/files/:id/thumbnail?t=` | 加密令牌缩略图 |
| `GET` | `/api/files/:id/thumbnail-hd?t=` | 加密令牌高清视频封面 |
| `GET` | `/api/files/media/:id` | 公开媒体直链（原 `/media/:id` 别名） |
| `PATCH` | `/api/files/:id/rename` | 重命名显示名 |
| `PATCH` | `/api/files/:id/move` | 移动文件 |
| `POST` | `/api/files/:id/copy` | 轻量复制文件 |
| `DELETE` | `/api/files/:id` | 请求删除 |
| `POST` | `/api/files/:id/restore` | 恢复删除 |
| `POST` | `/api/files/:id/force-delete` | 文件主永久删除 |
| `POST` | `/api/files/batch-markdown` | 批量生成 Markdown |
| `GET/POST` | `/api/folders/*` | 文件夹树、内容、创建和恢复 |
| `PATCH/DELETE` | `/api/folders/:id*` | 重命名、移动和删除文件夹 |
| `GET/POST/PATCH/DELETE` | `/api/shares/*` | 管理自己的分享链接 |
| `GET/POST/PUT/DELETE` | `/api/tags/*` | 管理标签与文件关联 |

上传与分片端点见“上传模式”。

### 管理员接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/users` | 用户列表，非 `/api/admin/users` |
| `POST` | `/api/users` | 创建用户 |
| `GET` | `/api/users/:id` | 用户详情 |
| `DELETE` | `/api/users/:id` | 删除用户 |
| `PUT` | `/api/users/:id/role` | 修改角色，仅 `super_admin` |
| `PUT` | `/api/users/:id/ban` | 封禁或解封用户 |
| `GET` | `/api/admin/stats` | 全站统计 |
| `GET` | `/api/admin/files` | **全站文件列表**，支持上传者筛选 |
| `DELETE` | `/api/admin/files/:id` | 删除任意用户文件 |
| `POST` | `/api/admin/files/batch-delete` | 批量删除文件 |
| `POST` | `/api/admin/files/verify` | 创建文件体检异步任务（202，仅 `super_admin`） |
| `GET` | `/api/admin/files/verify/active` | 查询当前活动体检任务（仅 `super_admin`） |
| `GET` | `/api/admin/files/verify/:taskId` | 查询体检任务进度与结果（仅 `super_admin`） |
| `GET/POST` | `/api/admin/banned-ips` | 查询或新增 IP 封禁 |
| `POST` | `/api/admin/banned-ips/unban` | 通过请求体解封 IP，推荐用于 IPv6 |
| `GET/PUT` | `/api/admin/config` | 系统配置 |
| `GET/PUT` | `/api/admin/smtp` | SMTP 配置 |
| `GET/PUT` | `/api/admin/upload-config` | 上传配置 |
| `GET/PUT` | `/api/admin/auth-config` | 认证配置 |
| `GET/PUT` | `/api/admin/cache-config` | 缓存配置，仅 `super_admin` |
| `GET/PUT` | `/api/admin/security-config` | 安全规则，仅 `super_admin` |
| `GET` | `/api/admin/access-logs*` | 访问日志及聚合分析 |
| `GET` | `/api/admin/audit-logs` | 操作审计 |

| `GET` | `/api/admin/export` | CSV/JSON 数据导出 |

多数分析、审计、缓存和安全配置接口仅允许 `super_admin`。

## 安全说明

- 不要把 `.env`、Token、密码或加密密钥提交到仓库。
- 生产环境必须使用 HTTPS、强 `JWT_SECRET`、明确 CORS 来源和 `SECURE_COOKIE=true`。
- Telegram Token 会在错误日志中脱敏；生产异常响应不返回堆栈。
- 全局 `ValidationPipe` 启用白名单、类型转换和非白名单字段拒绝。
- Helmet 提供安全响应头；前端 CSP 由 `frontend/index.html` 管理。
- 关键写操作进入审计日志；访问日志按配置定期清理。
- 默认访问日志保留 30 天、审计日志保留 90 天。

## 许可证

GNU General Public License v3.0
