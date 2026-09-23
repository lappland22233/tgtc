# 文件分发系统

基于 NestJS、Vue 3、TypeORM、Redis 与 Telegram Bot API 的文件分发与网盘系统。元数据数据库默认使用 PostgreSQL，也正式支持显式 opt-in 的 SQLite 单机部署。系统提供层级文件夹、标签、同步/异步/分片上传、私有与公开访问、独立分享链接、管理员审计、安全监控和访问分析。

## 核心能力

### 用户与权限

- 邮箱注册、登录、验证码验证和密码重置
- JWT 身份认证，令牌存储于 HttpOnly Cookie
- `super_admin`、`admin`、`user` 三级角色权限
- 登录、验证码、文件密码和分享密码的频率限制与临时封禁
- 第一个成功注册的账号自动成为 `super_admin`
- API 密钥（`X-API-Key`）：所有用户可创建，程序化执行全部文件与文件夹操作，密钥只能管理关联账号资源，详见 [API 调用文档](API.md)

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
- 支持标准单区间 Range（closed / open-ended / suffix）：缓存命中直接返回 `206`；冷文件通过 build/spool follower 同样保持 `206`，断点续传可用
- 上游始终单路顺序回源，请求区间若尚未回源完成会等待补齐（并发多线程下载未回源部分无法立即应答）；非法或越界 Range 返回 `416` 而非静默回退 `200`

#### 下载磁盘配额与排队

所有会新增本地占用的下载环节（正式缓存构建、临时中转、缓存预热）统一走同一套调度：

- **占用预测 → 预约 → 排队**：按文件大小预测峰值占比并先行预约；准入公式为「物理空闲 − 最低安全余量 − 其他任务未写入预约 ≥ 本次新增」，避免多个任务复用同一份空闲空间；
- **写入即核销**：每写入一段数据就把预约量核销同等额度，已落盘部分由文件系统反映，不做物理/逻辑双重扣减；
- **不抢占**：已获得预约的任务不会被新任务或配置热更新撤销；回收只作用于已发布且未被读取的旧缓存，绝不删除进行中的临时文件；
- **结构性不可行时降级直通（并非"无条件可下载"）**：完整暂存不可行（单文件超过缓存上限，或卷内空间结构性不足）时自动降级为受限缓冲直通（`FILE_DOWNLOAD_DIRECT_WINDOW_MB`，不写本地副本），保持 `206`/`416` 与首字节语义。但准入仍在：等待队列满返回 `429 DOWNLOAD_QUEUE_FULL`；非任务化的直接下载在 `FILE_DOWNLOAD_DIRECT_WAIT_SECONDS` 内拿不到资源返回 `503 DOWNLOAD_SERVER_BUSY` + `Retry-After`。因此不保证「任何时刻都能立即开始下载」；
- **排队可见**：`POST /api/files/:id/download-tasks` 返回是否可立即下载或排队原因（磁盘 / 上游 / 负载）、近似队列位置与建议重试间隔；前端据此展示全局下载队列指示器并支持取消（详见 `API.md`）。

运维注意：本调度管理的是后端缓存卷（`tmp/Cache`）。自建 Telegram Bot API/TDLib 的 `--dir` 工作目录是**独立磁盘域**，两者位于同一物理卷时仍可能互相抢占，建议分卷部署并分别配置最低余量（`FILE_CACHE_MIN_FREE_DISK_GB` 与 `--workdir-min-free-bytes`）。

#### 回源权重预算、队列公平与内存治理

三个「权重/上限」概念必须分开，禁止互相换算：

| 配置/字段 | 层级 | 语义 |
|---|---|---|
| `telegram_accounts.weight` | 账号池 | 账号**选号**的加权概率（不影响全局预算） |
| `telegram_accounts.maxInflight` | 账号池 | 单账号在飞请求上限 |
| `FILE_DOWNLOAD_MAX_CONCURRENT_UPSTREAMS` | 下载资源协调器 | **全局上游回源权重预算**（不是连接数，也不是「账号数 × maxInflight」） |

- **权重映射**：`>1GiB` → 8、`256MiB–1GiB` → 2、其余 → 1；权重超过预算时按预算裁剪。
- **预算自动扩缩容**（`FILE_DOWNLOAD_AUTO_CAPACITY_ENABLED=true`，默认开启）：按**有效 Bot 数**映射 `min(64, max(8, n×8))`（1 个 → 8、2 个 → 16、4 个 → 32，上限 64）。「有效 Bot」= 同时满足 `enabled` + 已配置存储 Chat + 健康（未冷却、连续失败低于阈值）+ **该账号存在自己的 `status=ready` 副本**。闸门：升档需目标值连续 2 个评估周期稳定（60s/次）且窗口内无新增回源失败、无账号处于限流冷却；每次最多 `+8`；降档需目标持续偏低 10 个周期，每次最多 `-8`、永不低于 `8`；`有效 Bot = 0` 时挂起自动调整（无依据不缩容）。每次写入都会同时落审计日志（旧值/新值/有效 Bot 数/原因/来源）与运行日志。**任何调整都不撤销已授予的租约**，只影响后续准入。
- **队列等待策略**（`FILE_DOWNLOAD_UPSTREAM_QUEUE_POLICY`，默认 `strict_fifo`）：
  - `strict_fifo`：严格 FIFO，队首权重不足时后续任务也不放行（紧急回退模式）；
  - `bounded_fit`：队首暂时放不下时，仅在队首之后的前 8 个等待项中按 FIFO 顺序放过可适配的任务；单个队首最多被绕过 8 次，或被绕过至等待超过 10 秒后进入「队首保留」，不再发放非队首任务（大文件不会被小任务饿死）。绕过次数、队首等待年龄与保留状态均可在运行快照中观测。
- **副本目标**（`TELEGRAM_POOL_TARGET_REPLICAS`，SystemConfig 热更新，1-8，默认 2）：有效目标 = `min(配置值, 可承载副本账号数)`，无可承载账号时自动降为 1 并在运行快照中显示降级原因；Web 下载、Bot 公开下载与镜像回源共用同一解析结果。同一逻辑文件的扩散任务使用 single-flight，目标账号按 claim 去重（跨请求不重复排队同一目标）；跨逻辑文件的复制并发上限为 2，复制失败后 claim 立即释放以便下一轮重试。
- **内存治理**：spool/build follower **每块数据独立分配** 256KiB 读缓冲，读取后直接把该块内存的视图交给下游（不再 `Buffer.from(subarray)` 复制），从而去掉「复用缓冲 + 每块一次拷贝」的双重分配。**禁止复用已 push 的缓冲**：经 `pipeline(stream, res)` 消费时，`res.write()` 会把缓冲留在 socket 写队列里（尚未刷入内核），复用同一块内存会造成下载内容被后一块静默覆盖——`readableLength === 0` 只说明数据已离开本流的内部缓冲，**不代表下游已释放**。direct 直通流显式使用**字节模式**（`objectMode:false`），窗口（`FILE_DOWNLOAD_DIRECT_WINDOW_MB`，1-4MiB，默认 1MiB）即单请求预读内存上限，与文件总大小无关。运行快照暴露 `rssBytes`/`heapUsedBytes`/`externalBytes`/`arrayBuffersBytes`、直通流数与窗口总量、follower 缓冲分配次数——`heapUsed` 无法反映 glibc 原生堆的扩张，必须结合这些进程级读数判断。

**发布顺序（手工步骤）**：

1. 上线「配置读取修复 + 运行时指标 + direct 字节模式 + follower 回归测试」，队列保持 `strict_fifo`；
2. 管理后台把直通窗口设为 `1 MiB`，观察 RSS 与吞吐；
3. 完成账号资格审计（账号池页「副本扩散策略」卡）与副本 dry-run（覆盖率与缺失样例），**不立即批量复制**；
4. 对少量热门文件执行副本补齐，确认至少两个可承载 Bot 均出现 ready 副本；
5. 低峰期切换 `bounded_fit`，观察队首等待、绕过次数、小文件 503 与大文件公平等待；
6. 稳定后扩大副本补齐范围；只有在可承载账号数与 Telegram 限流都允许时才提高期望副本数（4 不是默认值）。

**回滚开关**：队列异常 → 切回 `strict_fifo`（不改预算）；内存异常 → 直通窗口保持/降回 `1 MiB`；复制异常 → 暂停后台复制或把期望副本数降为当前已就绪路数（不删除已有 ready 副本）；Telegram 限流异常 → 关闭 `FILE_DOWNLOAD_AUTO_CAPACITY_ENABLED` 并维持当前预算（禁止直接手工翻倍）；配置展示异常 → 回退管理端 GET 变更，保留运行时安全区间与监控。

**发布阻塞条件**（任一命中都不得扩大流量或副本目标）：活跃权重超过预算或存在无法释放的租约；大文件在公平阈值内被持续绕过；账号池把没有对应 ready 副本的账号选为回源账号；`file_id` 归属校验失败；RSS/swap 随传输周期持续增长或 glibc `[heap]` 未形成平台；`FLOOD_WAIT`、复制失败或上游 503 显著高于基线。

**压测与观测场景**：① 2 个 4GiB 分卷并发（预算 16）混入多个 64MiB 以下小文件；② 16 个小文件持续回源（验证权重/账号在飞/direct 窗口）；③ 多个 follower 读取同一 spool（迟到、慢消费、断开重连、Range）；④ noCache 连续下载并重复 ≥3 个周期；⑤ 副本补齐与下载同时发生。Linux 侧额外采集 `/proc/<pid>/smaps_rollup`、`VmRSS`、`VmHWM`、swap 与 `[heap]` 段变化；验收阈值：固定并发下 RSS 在 10 分钟内回落到峰值 1.25 倍以内或形成平台，swap 不随周期线性增长。仅当代码侧治理完成后原生堆仍长期偏高，才在 canary 上单独验证 `MALLOC_ARENA_MAX` 等 allocator 参数（每次只改一个变量）。

### 分享

- 独立 `ShareLink` 模型，同一文件或文件夹可创建多条分享链接
- SPA 分享页 `/s/:token`，支持文件信息卡片和文件夹层级浏览
- 可设置密码、有效期和最大访问次数
- 严格密码模式：验证成功前不返回目标文件或文件夹元数据
- 文件夹分享支持子目录、面包屑和单文件下载
- 我的分享列表支持筛选、复制链接、修改和取消
- 旧入口 `/files/public/:id` 兼容重定向至分享页

### Telegram Bot 文件直链

- 用户在 Bot **私聊**中发送**文件**（`document`），即可获得带有效期的匿名下载直链
- 非白名单用户按日限额（默认 5 个文件/天），白名单用户不限；额度、有效期、切日时区可在后台热更新
- 直链仅受时间限制，不限下载次数；可被管理员按链接立即撤销
- 复用站内同一套本地缓存 / Range 链路：支持单区间 Range 与断点续传（`206` + `Content-Range`），越界 Range 返回 `416`
- **协议层无显式大小上限**：Bot 文件不经过本站上传链路，因此不受后台上传配置 `MAX_FILE_SIZE` 约束；本地 Bot API（`--local` + `--enable-file-streaming`）跳过内置的 20MB 下载上限，流式端点 `--file-stream-max-size` 默认 `0`（不限制）。实际可下载大小仍受 x64 平台、磁盘与缓存余量、代理临时卷、超时策略、链接有效期与 Telegram 本身能力约束
- 仅接受 `document`：图片/视频/音频等媒体类型会收到提示且**不消耗额度**；群组/频道消息一律静默忽略
- Bot 使用情况写入后端访问日志（`access_logs.botGrantId` / `botTelegramUserId`），并在后台汇总展示
- 管理员可在 Bot 私聊中维护白名单、按 TG 用户 ID 查询完整直链、按直链撤销（全程审计）

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

如启用 Bot 入站文件直链（默认**关闭**），还需配置 `TELEGRAM_BOT_UPDATES_ENABLED=true`、`TELEGRAM_BOT_ADMIN_IDS`（初始管理员 TG 用户 ID）、`TELEGRAM_BOT_ENCRYPTION_KEY`（32 字节 base64/hex，用于直链回放），并在后台「Telegram Bot 设置」中确认站点域名。

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
| `APP_HOST` | `127.0.0.1` | 监听地址；仅本机可访问，公网必须经反向代理 |
| `APP_PORT` | `3000` | 服务端口 |
| `DEPLOYMENT_MODE` | `single` | 部署形态；仅支持 `single`，`multi` 会被启动预检拒绝 |
| `APP_URL` | `http://localhost:3000` | 对外公开地址，用于分享链接 |
| `FRONTEND_URL` | - | CORS 单一来源回退值 |
| `CORS_ORIGINS` | - | 逗号分隔的允许来源，优先于 `FRONTEND_URL` |
| `JWT_SECRET` | - | 至少 32 字符，启动必检 |
| `JWT_EXPIRES_IN` | `7d` | JWT 有效期 |
| `SECURE_COOKIE` | `false` | HTTPS 生产环境必须显式设为 `true` |
| `TOKEN_EXTRACTION_MODE` | `both` | `both` 或 `cookie_only` |
| `TRUST_PROXY_HOPS` | 未设置 | Express 信任的反向代理跳数；位于反代之后必须设置（如 `1`） |

启用 Cookie 凭据时禁止将 `CORS_ORIGINS` 配置为 `*`。多层代理部署必须根据真实拓扑设置 `TRUST_PROXY_HOPS`，并确保上游正确维护 `X-Forwarded-For`。

生产环境启动预检（`backend/src/config/deployment-preflight.ts`）会在以下情况输出高可见度告警：既未设置 `SECURE_COOKIE=true` 也未设置 `TRUST_PROXY_HOPS`（Cookie 可能失去 `Secure`）、监听 `0.0.0.0`。若设置 `DEPLOYMENT_MODE=multi`，预检将**直接拒绝启动**（当前版本不支持多实例）。

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
| `TELEGRAM_FILE_STREAM_TIMEOUT_SECONDS` | `180` | 后端请求实时流端点的读超时（秒）；须**小于**首字节超时，并大于 Bot API `--file-stream-first-byte-timeout` |
| `HTTP_IDLE_TIMEOUT_SECONDS` | `180` | Node HTTP 空闲超时（秒）；须**大于**缓存空闲超时、**小于**外层 Nginx `proxy_read_timeout` |
| `FILE_CACHE_BUILD_FIRST_BYTE_TIMEOUT_MS` | `210000` | 缓存构建**首字节**超时（毫秒）；冷启动允许 TDLib 更久才出首块，`0` 表示禁用 |
| `FILE_CACHE_BUILD_IDLE_TIMEOUT_MS` | `150000` | 缓存构建**无进展**超时（毫秒），每收到数据即刷新 |
| `FILE_CACHE_BUILD_TOTAL_TIMEOUT_MS` | `0` | 单次缓存构建**总时限**（毫秒）；`0` = 禁用（默认），固定总时限会误杀长传输 |
| `FILE_DOWNLOAD_MAX_RESERVED_GB` | `0` | 在途下载任务「未写入预约」总上限（GB），0 表示仅受物理空间约束（SystemConfig 热更新） |
| `FILE_DOWNLOAD_MAX_CONCURRENT_UPSTREAMS` | `8` | 上游冷回源**权重预算**（非连接数）：`>1GiB` 权重 8、`256MiB–1GiB` 权重 2、其余 1；自动扩缩容开启时按有效 Bot 数映射 `min(64, max(8, n×8))`（1→8、2→16、4→32），范围 1-64（SystemConfig 热更新） |
| `FILE_DOWNLOAD_UPSTREAM_QUEUE_POLICY` | `strict_fifo` | 上游等待项选择策略：`strict_fifo`（严格 FIFO，回退模式）/ `bounded_fit`（前 8 个等待项内适配优先，队首最多被绕过 8 次或等待 10 秒后进入队首保留）（SystemConfig 热更新） |
| `FILE_DOWNLOAD_AUTO_CAPACITY_ENABLED` | `true` | 全局权重预算是否按有效 Bot 数自动扩缩容（关闭后只保留人工设置）（SystemConfig 热更新） |
| `FILE_DOWNLOAD_QUEUE_CAPACITY` | `128` | 磁盘/上游等待队列容量，超过后直接返回「服务器繁忙」（`429`）（SystemConfig 热更新） |
| `FILE_DOWNLOAD_QUEUE_TIMEOUT_SECONDS` | `1800` | 单个下载任务排队等待上限（秒）（SystemConfig 热更新） |
| `FILE_DOWNLOAD_SPOOL_GRACE_SECONDS` | `120` | 临时中转文件最后一个下载者离开后的保留时间（秒）（SystemConfig 热更新） |
| `FILE_DOWNLOAD_DIRECT_WINDOW_MB` | `1` | 受限缓冲直通的缓冲窗口（MB，**1-4**，推荐 `1`）：字节模式下的 `highWaterMark` 即单请求预读内存上限，与文件总大小无关（SystemConfig 热更新） |
| `FILE_DOWNLOAD_DIRECT_WAIT_SECONDS` | `60` | 非任务化直接下载端点的有限等待上限（秒）；超时返回 `503 DOWNLOAD_SERVER_BUSY` + `Retry-After`（不再挂到 1800s）；4GiB 场景建议上调到 `180`（SystemConfig 热更新） |
| `FILE_DOWNLOAD_TASK_RETENTION_SECONDS` | `900` | 下载任务状态保留时间（秒）（SystemConfig 热更新） |
| `THUMBNAIL_DIR` | `tmp/thumbnails` | 缩略图目录 |
| `FILE_PROCESSING_STALE_MINUTES` | `60` | 上传队列僵尸任务恢复阈值（分钟） |

> **配置来源**：`FILE_CACHE_BUILD_*` 三层超时、`HTTP_IDLE_TIMEOUT_SECONDS`、`TELEGRAM_FILE_STREAM_TIMEOUT_SECONDS` 与 `FILE_CACHE_NO_CACHE_MODE`（初始值）为**真实环境变量**，`.env` 生效；而 `FILE_DOWNLOAD_*` 及 `FILE_CACHE_MAX_SIZE_GB` / `FILE_CACHE_MIN_FREE_DISK_GB` / `FILE_CACHE_TTL_DAYS` 由管理后台「下载资源调度 / 缓存配置」以 **SystemConfig 热更新**为来源——**环境变量不是它们的来源**，上表默认值仅为参考。

实时流要求二次开发 Bot API 使用 `--enable-file-streaming` 启动，后端访问：

```text
/stream/file/bot<TOKEN>/<encoded-file-id>
```

实时流的失效处理约定：

- **首字节前不失败**：TDLib 报「已下载」但 workdir 副本已不存在时（缓存清理、换目录等），流会请求 TDLib 重新回源并等待，而不是让冷文件的首个请求直接 5xx；只有已经开始传输后才中断（TDLib 的下载错误始终经 `on_file_error` 正常上报）。
- **首字节前一律返回 JSON 错误 + 真实 HTTP 状态码**：不再裸断连接（历史表现为 nginx `upstream prematurely closed connection while reading response header`）。
- **后端一次受控回源**：流式端点返回 502（路径失效/尺寸不可用），或返回带「TDLib 本地副本不可用」（打不开/读不到/找不到真实路径）特征的 500/504 时，后端执行一次强制回源（非 `metadata_only` `getFile`），失败保持瞬时错误语义、不顺延重试。

缓存容量、最低磁盘空间和 TTL 存放在系统配置中，默认分别为 10 GB、1 GB、3 天，可从超级管理员后台热更新。

### Telegram Bot 入站（文件直链）

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `TELEGRAM_BOT_UPDATES_ENABLED` | `false` | 入站消费总开关；仅显式 `true` 时启用，**不支持热更新**（安全边界） |
| `TELEGRAM_BOT_ADMIN_IDS` | - | 初始管理员 TG 用户 ID，逗号分隔；开启入站时必填 |
| `TELEGRAM_BOT_POLL_TIMEOUT_SECONDS` | `30` | 长轮询超时（1–120 秒） |
| `TELEGRAM_BOT_ENCRYPTION_KEY` | - | 直链 Token 可逆加密根密钥（32 字节 base64/64 位 hex）；缺失时 `/link_query` 只能返回前缀 |
| `TELEGRAM_BOT_DAILY_LIMIT` | `5` | 非白名单用户每日直链额度（env 兜底，面板可调） |
| `TELEGRAM_BOT_LINK_TTL_HOURS` | `4` | 直链有效期（小时，env 兜底，面板可调） |
| `TELEGRAM_BOT_QUOTA_TIMEZONE` | `Asia/Shanghai` | 每日额度切日时区（env 兜底，面板可调） |
| `TELEGRAM_BOT_LINK_DOMAIN_MODE` | `auto` | `auto` 自动获取 / `manual` 手动设置（env 兜底，面板可调） |
| `TELEGRAM_BOT_LINK_DOMAIN` | - | 手动模式下的站点域名，如 `https://text.lappland.top`（env 兜底，面板可调） |

**站点域名解析优先级（防 Host 伪造）**：手动模式配置 > `APP_URL` > 受信代理头（仅 `TRUST_PROXY_HOPS` 正确配置时）> **fail-closed**。系统**绝不**回退到 `localhost` 或裸 `Host` 头；无可信来源时会拒绝签发并提示管理员在后台配置。

**单消费者约束**：同一 Bot Token 只能有一个入站更新消费者。本模块与文件存储共用 `TELEGRAM_BOT_TOKEN`，因此**不得**同时启用 Webhook 或其他 `getUpdates` 消费者。启动时若检测到已设置 Webhook，会写入错误日志告警（`getUpdates` 会返回 409）。

**Bot 命令**

| 命令 | 权限 | 说明 |
|---|---|---|
| `/help`、`/start` | 所有用户 | 用法说明 |
| `/id` | 所有用户 | 返回自己的 TG 用户 ID |
| `/quota` | 所有用户 | 查询今日剩余额度（白名单提示不限额） |
| `/wl_add <TG用户ID>` | 管理员 | 永久加入白名单 |
| `/wl_remove <TG用户ID>` | 管理员 | 移出白名单 |
| `/wl_list` | 管理员 | 列出白名单（截断） |
| `/link_query <TG用户ID>` | 管理员 | 按 TG 用户 ID 查询完整有效直链（每次调用全审计） |
| `/link_revoke <直链URL或Token>` | 管理员 | 按直链撤销，立即失效 |

管理员身份仅依据**数字 TG 用户 ID**（`TELEGRAM_BOT_ADMIN_IDS`）；`@username` 属于用户可控字段，仅用于审计展示，绝不参与权限判定。审计记录 TG 用户 ID 与用户名（如有），且**从不记录完整 Token**。

**灰度开启步骤**

1. 在 `.env` 配置 `TELEGRAM_BOT_ADMIN_IDS` 与 `TELEGRAM_BOT_ENCRYPTION_KEY`（并确认 `APP_URL` 为对外真实地址）；
2. 运行迁移（`npm run migration:run`），确认 `telegram_bot_*` 三张表与 `access_logs` 新列已创建；
3. 设置 `TELEGRAM_BOT_UPDATES_ENABLED=true` 并重启后端；
4. 以初始管理员身份私聊 Bot，先执行 `/help` 与 `/wl_add`，再发送一个文件验证直链可用；
5. 在后台「Telegram Bot 设置」确认「当前生效域名」正确后再放开给普通用户。

### Bot 账号池（多账号回源，默认关闭）

> 默认关闭；`TELEGRAM_ACCOUNT_POOL_ENABLED` 不是 `true` 时，行为与单账号部署完全一致（可安全回退）。

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `TELEGRAM_ACCOUNT_POOL_ENABLED` | `false` | 账号池总开关；仅显式 `true` 时启用 |
| `TELEGRAM_ACCOUNT_POOL` | - | 账号 JSON 数组：`[{id,token,chatId,weight,maxInflight,enabled,note}]`（推荐，信息最全） |
| `TELEGRAM_BOT_TOKENS` | - | 逗号分隔 Token 列表（简化输入；存储 Chat 复用 `TELEGRAM_CHAT_ID`，**归档群不可充当存储目标**） |
| `TELEGRAM_ARCHIVE_CHAT_ID` | - | 收到的文件由接收账号转发到该群（**仅审计留痕**；严禁作为账号存储 Chat）；同时作为「用户账号中继」在下载期懒扩散路径上的**副本可见群** |
| `TELEGRAM_POOL_TARGET_REPLICAS` | `2` | 期望副本数（**范围 1-8**）；已迁移为 SystemConfig 热更新（后台「账号池 → 副本扩散策略」），本环境变量仅作为**初始值/回退**。有效目标 = `min(配置值, 可承载副本账号数)`，`1` 表示不主动扩散；Web 下载、Bot 公开下载与镜像回源共用同一解析结果 |
| `TELEGRAM_USER_RELAY_ENABLED` | `false` | 用户账号 MTProto 中继（策略 B）；已接入客户端，不可用时明确失败并**自动回退策略 A**（启动预检只告警不阻断） |

**前置条件**（任一不满足时启动预检直接拒绝启用）：显式 `TELEGRAM_FILE_STREAMING_ENABLED=true`、`TELEGRAM_FILE_STREAM_BASE` 为合法 http/https 地址，且自建 Bot API 以 `--enable-file-streaming` 启动。每个账号必须有自己的 Token、自己的存储 Chat（`chatId`）与回源能力。

**不可回退约束**：`file_id` 按账号隔离，**不得跨账号复用**；跨账号逻辑聚合只用 `file_unique_id`（缺失时该文件不参与扩散，只能由源账号回源）；回复必须由「收到消息的账号」发出（失败不会改用默认账号代发）；仅支持**单后端实例**（账号画像、在飞计数、复制去重均为进程内状态）。

**只读诊断**：`GET /api/admin/bot-account-pool`（仅超级管理员）返回脱敏快照（账号 `tokenPreview`、在飞/带宽/健康/冷却）与计数（选号/换号/回退/复制/流式失败/回复失败），用于区分「服务健康」与「账号池已启用但未生效」；`/api/health` 形状保持不变。

**回退**：把 `TELEGRAM_ACCOUNT_POOL_ENABLED` 置回 `false` 即可止血（功能降级，不是数据库回滚）；副本表与 `sourceAccountId` 均为 expand 式增量结构，回退程序版本无需回退数据库。

### 账号池后台管理 + 文件镜像备份（默认关闭；v1.5.3）

> 超级管理员在后台「Telegram 账号池」（`/admin/telegram-accounts`）管理 Bot 与用户账号，并配置一条镜像备份规则，把进入系统的新文件同步到独立备份群。**三层开关**：全局账号池、镜像功能、单账号与单规则；**关闭只阻止新任务**，不中断已开始的传输，也不删除已备份内容。

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `TELEGRAM_ACCOUNT_ENCRYPTION_KEY` | - | **账号凭据加密根密钥**（32 字节 base64/64 位 hex）；缺失时后台新增/轮换账号会被拒绝（不会明文落库） |
| `TELEGRAM_ACCOUNT_POOL_ENABLED` | `false` | 账号池总开关的**首次默认值**；后台「运行时配置」优先并即时生效 |
| `TELEGRAM_MIRROR_ENABLED` | `false` | 镜像功能总开关的**首次默认值**；后台可热切换 |
| `TELEGRAM_ACCOUNT_POOL_FORCE_DISABLED` | `false` | 紧急止血：设为 `true` 时后台无法开启账号池（需移除变量并重启恢复） |
| `TELEGRAM_MIRROR_FORCE_DISABLED` | `false` | 紧急止血：设为 `true` 时后台无法开启镜像 |
| `TELEGRAM_USER_CLIENT_TIMEOUT_MS` | `60000` | 用户账号 MTProto（`teleproto`）单次调用整体超时 |

**接口**（全部仅 `super_admin`，JWT Cookie，不接受 API Key，写操作均审计）：

- `GET/PUT /api/admin/telegram-accounts/overview|feature`：总览与账号池总开关（响应含 `pool` 运行态与 `envAccounts` 只读视图）；
- `GET/POST/PATCH/DELETE /api/admin/telegram-accounts[/bots|/users|/:id]`：账号全生命周期（创建即校验、测试、启停、轮换、撤销）；列表项带 `source`（`panel`/`both`）与 `runtime` 运行态；
- `POST /api/admin/telegram-accounts/env/:accountId/probe`：**环境变量账号**（主 Bot 或 `TELEGRAM_ACCOUNT_POOL` 配置项）重新探测，只回脱敏结论并写审计；
- `GET /api/admin/telegram-accounts/replication-audit`：副本扩散资格审计（目标解析 `configured`/`eligible`/`effectiveTarget` + 降级原因、逐账号资格与排除原因、ready 覆盖率与缺失样例、容量策略状态），只读、不触发扩散；
- `PUT /api/admin/telegram-accounts/replication-target`：期望副本数热更新（1-8，写入 SystemConfig 并审计；有效目标按可承载账号数收敛）；
- `POST /api/admin/telegram-accounts/:id/auth/start|verify|cancel`：用户账号交互式授权（验证码与 2FA 密码**不入库不入日志**）；
- `GET/PUT /api/admin/telegram-mirror`、`PUT .../feature`、`PUT .../rule/enabled`、`POST .../test`：规则配置与权限探测；
- `GET /api/admin/telegram-mirror/tasks`、`POST .../tasks/:id/retry|cancel`：任务列表与人工干预；
- `POST/GET /api/admin/telegram-mirror/backfill[/pause|/resume|/cancel]`：历史文件补偿（按批限速、可暂停取消、`dry-run` 只统计）；
- 兼容端点 `GET /api/admin/bot-account-pool` 保持不变（只读脱敏诊断）。

**两条镜像路径的事实边界（不可含糊）**：

1. **Bot 路径 = 目标账号二次上传**：备份群消息由目标 Bot 自己产生，各自持有独立 `file_id`（文件字节上传两次）；不允许把 A 账号的 `file_id` 交给 B 账号；
2. **用户账号路径 = MTProto 无源复制**（`copyMessages`）：文件字节只上传一次，但**仍需源 `chat_id + message_id` 可访问**，且用户账号必须同时是源群可读成员与备份群可写成员；
3. 主存储群与备份群**必须分离**，备份群不得是任一账号的主存储 Chat；启用规则前必须通过一次真实权限测试；
4. 任务幂等键为 `ruleId + 归属对象 + 源版本`：重复事件、重试与重启都收敛为一次有效备份；覆盖上传递增 `uploadVersion` 会让旧任务自动作废；
5. `429` 尊重 `retry_after` 退避，权限/源消息失效/凭据失效进入 `blocked` 并告警，**不会无限重试**；目标上传成功而状态落库失败时保存回执，重试凭回执确认（不重复上传）。

**只支持单后端实例**：账号画像、镜像任务对账与补偿进度均为进程内状态；`DEPLOYMENT_MODE=multi` 会被启动预检拒绝。

**回退**：先停用镜像规则 → 再停用异常账号 → 最后关闭账号池/镜像总开关；已写入备份群的消息不会自动删除；新增表与可空列均为 expand 式增量，回退程序版本无需回退数据库。

### 副本扩散与下载负载均衡（v1.5.4）

> 目标：**一次转发，多 Bot 共享副本，下载按负载分流**。Web 上传或 Bot 收到文件后，由**用户账号**把源消息服务端转发进「副本可见群」；群内每个 Bot 各自收到该消息、登记**自己账号的** `file_id` 副本；这些副本经桥接写入站内文件的副本记录后，下载回源即可在多个 Bot 之间按权重 × 带宽 × 健康 × 容量选号。

**为什么必须用用户账号**：Telegram 规定 bot 永远看不到其它 bot 发送的消息（与隐私模式、管理员身份无关）。因此「接收 Bot 转发到群」不能让其它 Bot 获得该文件；只有**用户账号**发出的消息才能被全群 Bot 看到。详见 `TELEGRAM_USER_RELAY_ENABLED` 的配置说明。

| 环节 | 实现位置 | 关键契约 |
|---|---|---|
| 中继 | `telegram-account-pool/user-relay.service.ts`（策略 B 接入点）、`telegram-mirror/telegram-user-copy.service.ts` | 服务端转发、**零字节重传**；幂等键 = 逻辑操作 + 执行账号（派生确定性 `random_id`，重试不产生重复消息） |
| 副本认领 | `telegram-bot/telegram-bot-dispatch.service.ts` | 各 Bot 长轮询各自收到群消息后登记本账号副本；**缺失 `file_unique_id` 时拒绝登记**（不退化为 `file_id`） |
| 桥接 | `telegram-account-pool/file-copy.service.ts` | 按 `file_unique_id` 反查 `files.telegramFileUniqueId`，额外写 `ownerType='file'` 副本；`file_id` 严格归属产生它的账号，**禁止跨账号借用** |
| 选号回源 | `telegram-account-pool/account-aware-download.service.ts` | 加权选号 + 失败换号（最多 3 次）+ 副本不足时后台懒扩散（不阻塞首字节） |

**部署前置条件**（缺任一项都不会损坏数据，但副本无法扩散，下载仍集中在单账号）：

1. `TELEGRAM_BOT_UPDATES_ENABLED=true`，且账号池已启用、存在 ≥2 个 Bot 账号；
2. **副本可见群内每个 Bot 都必须关闭隐私模式（BotFather `/setprivacy` → Disable）或设为管理员**——否则 Bot 收不到用户账号发出的普通群消息；
3. 至少一个已授权的 `user` 账号，且**同时是源群与副本可见群成员**、对副本可见群有发送权限；
4. `TELEGRAM_USER_RELAY_ENABLED=true`；中继目标群按「**启用中的镜像规则备份群 → `TELEGRAM_ARCHIVE_CHAT_ID`**」顺序解析，两者至少要有一个指向副本可见群（否则中继返回 `user_relay_target_missing` 并回退策略 A）。

**Bot 私聊来源（Bot 收到用户私聊文件）**：用户账号读不到「Bot 与用户的私聊」，因此这类来源会先由**接收该消息的 Bot** 用 Bot API `forwardMessage`（服务端复制、零字节）搬到中转群（规则源群，未配置时回退 `TELEGRAM_ARCHIVE_CHAT_ID`），再把中转消息作为中继源锚点；锚点写回任务行，重试不会重复搬运。中转群缺失或与备份群相同时任务进入 `blocked` 并给出可执行提示。

**可见性与放大抑制**：来自备份群的消息只登记副本、**不再向归档群转发**（否则群内 N 个 Bot 会各转发一次，消息量按 Bot 数放大）。

**排障信号**：`GET /api/admin/bot-account-pool` 的计数新增 `userRelaysOk` / `userRelaysFailed` / `inboundBridgeMisses`（后者表示群消息与站内文件无关，属正常）；`userRelaysFailed` 连续增长会触发 `BOT_POOL_USER_RELAY_FAILING` 告警并附可执行检查项。

### 环境变量主 Bot 与统一选号（v1.5.3）

> `.env` 配置的 `TELEGRAM_BOT_TOKEN`（主 Bot）**始终**注册进账号池注册表，并在后台「Telegram 账号池 → Bot」页签的**环境变量账号**只读区可见；账号池关闭时行为与单 Bot 部署完全一致。

| 行为 | 说明 |
|---|---|
| 后台可见 | 展示来源徽标（环境变量）、主 Bot 标签、脱敏 `tokenPreview`、存储 Chat、权重、`inflight/maxInflight`、带宽/健康/冷却与最近错误；唯一操作是「重新探测」，**不提供编辑/删除/轮换**（密钥轮换只能改 `.env`） |
| 去重 | 同一 Token 只对应**一个逻辑账号**：显式池配置已含该 Token 时只标记 `primary`；数据库账号与环境变量账号同 Token 时环境变量优先（面板条目被跳过并告警）；`createBot`/`rotateBot` 命中环境变量 Token 时直接拒绝并提示 |
| 存储 Chat | 未配置存储 Chat 的账号只参与**下载回源**，不会被选为上传/镜像目标（后台行内提示，池初始化时告警一次） |
| 统一选号 | 下载回源、Web 新文件上传（同步/异步/分片合并）、副本扩散、镜像目标上传全部走同一套加权评分（权重 × 带宽 × 健康 × 容量，失败换号 + 账号级冷却 + 上限） |
| 严格无缓存旁路 | `noCache`（严格磁盘策略）任务**不**走池化上传，保留 fork 的 `local_cache_released` / `releaseLocalFile` 语义 |
| 轮询行为变更 | 池化模式下按账号逐一长轮询（含主 Bot）。账号级 offset 键首次出现时，仅当历史全局 offset **归属该账号**（`TELEGRAM_BOT_UPDATE_OFFSET_OWNER` 标记，旧部署按「是否为主 Bot」推断）才继承，避免重放约 24 小时旧更新，也避免把 A 的偏移套到 B 上跳过未消费更新 |
| 归属正确性 | 池化上传的 `file_id` 只属于实际上传账号：主副本定位（`telegramSourceAccountId`）、副本表、镜像任务的源锚点都写**真实账号**，回源时优先用该账号自己的 `file_id` |

**已知限制**：

1. 缩略图/衍生媒体链路仍走单账号回源（一次性小体量生成，不参与用户面向的下载/预览路径）；如需池化应抽 `TelegramSourceStreamResolver` 共用，而不是复制回退逻辑；
2. 下载回源在「来源账号已不在池内/被禁用且无任何副本」时会退回默认账号尝试（该 `file_id` 属于其它账号，**预期失败**，日志会给出原因）；彻底 fail-closed 需按上一条抽出统一源解析器后实施。

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

## 下载超时分层

下载链路跨越多层，任何**外层**先于内层断开，都会让客户端只看到「无原因中断」而不是可分类的超时（历史 4GiB 分卷事件即由此放大）。因此各层超时必须满足 **内层 < 外层**。

层级链（与 `scripts/release/start.sh` 写入的 systemd 单元、`.env` 及 `backend/src/config/env-validation.ts` 注释一致）：

```text
首字节链：Bot API 首字节 120s < Nest HTTP 180s < 缓存首字节 210s
空闲链：  Bot API 空闲 120s   < 缓存空闲 150s   < Node 空闲 180s < Nginx read 210s
```

两条链互相独立：**首字节链**管「等第一个数据块」的阶段（冷文件需要 TDLib 先回源），
**空闲链**管「已经开始传输但长时间没有新数据」的阶段。两者都不设固定总时长。

对应的配置项与默认值：

| 层级 | 配置项 / 参数 | 默认值 | 作用 |
|---|---|---|---|
| 最内层：Bot API 首字节 | `--file-stream-first-byte-timeout` | `120`（秒） | TDLib 回源后首个字节到达上限 |
| Nest 上游请求 | `TELEGRAM_FILE_STREAM_TIMEOUT_SECONDS` | `180`（秒） | 后端请求实时流端点的读超时 |
| 缓存构建空闲 | `FILE_CACHE_BUILD_IDLE_TIMEOUT_MS` | `150000`（毫秒） | 传输中无数据则中止会话；**每收到数据即刷新** |
| 缓存构建首字节 | `FILE_CACHE_BUILD_FIRST_BYTE_TIMEOUT_MS` | `210000`（毫秒） | 冷启动允许 TDLib 更久才吐出首块 |
| 缓存构建总时限 | `FILE_CACHE_BUILD_TOTAL_TIMEOUT_MS` | `0`（禁用） | 需绝对上限的场景再显式开启，必须大于首字节超时 |
| Node HTTP 空闲 | `HTTP_IDLE_TIMEOUT_SECONDS` | `180`（秒） | 数据传输中不超时，仅空闲时生效 |
| 最外层：Nginx read | `proxy_read_timeout` | `210s` | 见 `nginx-download.conf.template`；**不得设置固定总时长** |

两条必须理解的原则：

- **内层必须小于外层**：`env-validation` 会对非法数值（非整数、负数）直接报错；对层级冲突（如首字节小于空闲、`HTTP_IDLE_TIMEOUT_SECONDS*1000` 不大于缓存空闲、总时限不大于首字节）只输出**高可见度告警**、不阻断启动，以免既有自定义部署升级失败。冲突时外层会先断开，表现为无法分类的 502/504。
- **总时限默认禁用（`0`）**：固定总时限不随进度刷新，会把速度低于约 **2.28 MiB/s** 的 4GiB 长传输直接误杀（4GiB ÷ 1800s ≈ 2.28MiB/s）。真正的卡死改由**首字节超时**与**有进度即刷新**的空闲超时来判定。

## 磁盘占用与清理

一次大文件下载会同时涉及多个磁盘域，需分别配置与监控：

| 位置 | 路径 | 默认策略 | 清理/准入 |
|---|---|---|---|
| 后端下载缓存 | `tmp/Cache` | 上限 `10GiB`、TTL `3` 天、LRU 淘汰 | 命中刷新；超上限按 LRU 淘汰；过期清理；管理后台可热更新 |
| TDLib workdir | `runtime/telegram-bot-api/data` | 清理阈值 `20GiB` / 目标 `15GiB` / 间隔 `3600s` / 文件 TTL `86400s` / 最低余量 `1GiB` | workdir 清理任务 + **写前空间准入** |
| Bot API 临时目录 | `runtime/telegram-bot-api/tmp` | `start.sh` 以 `--temp-dir` 显式落在受控路径 | 组件自身管理（默认 `/tmp` 会脱离 workdir 配额统计） |
| Nginx 代理临时卷 | `proxy_temp_path` / `client_body_temp_path` | 下载端点 `proxy_max_temp_file_size 0`（直通不落盘） | 模板声明 + 容量告警清单 |

- **workdir 中不可删除的是控制状态**：`db.sqlite*` 与 `td.binlog*`（以及 session）是 `file_id` 的绑定凭据，删除/清空/重命名会让历史 `file_id` 全部失效；**媒体副本本身可被回收**（可由 `file_id` 重新回源）。
- **bot 直链上游按引用计数回收 workdir 副本**：后端请求 bot 直链文件时携带 `X-Telegram-No-Cache`，流正常结束后，Bot API 在**无其他流监听者/下载监听者**时删除 TDLib workdir 中的本地副本（引用计数安全），使「Cache + workdir」两份完整副本收敛为一份；中断传输的行为与不带该头一致。
- **写前空间准入（fail-closed）**：开始为文件建立本地副本前检查「可用空间 − `workdir-min-free-bytes` ≥ 预计增量」；未知大小用 `--workdir-unknown-file-min-free-bytes`（默认 `512MiB`）。不满足时在首字节前返回结构化 **`507`**（JSON + 真实状态码），并计数告警。
- **缓存占用明细**：`GET /api/admin/download-runtime` 暴露 `buildBytes` / `spoolBytes` / `orphanBytes` / `orphanFiles` / `cleanupFailureTotal` / `cacheUsageScannedAt`。应用启动时与**每 6 小时**清理进程崩溃残留的 `.tmp` / `.spool`；`unlinkAllCacheFiles` 已改为前缀匹配（此前只删固定后缀，孤儿文件永不清）。

## Bot 直链断点续传

`GET /api/bot-dl/:token` 复用与站内下载**完全相同**的本地缓存 / Range 链路，断点续传契约如下：

- 完整下载返回 `200`（含 `Content-Length`、`Accept-Ranges: bytes`、强 `ETag`）；
- 单区间 Range 返回 `206`（含 `Content-Range`），且**与完整响应使用同一 ETag**；
- 稳定强 `ETag` = `sha256('telegram-bot:' + file_id + ':' + size)` 的十六进制摘要（带引号），不含明文凭据，同一 Telegram 文件跨不同直链保持一致；
- `If-Range` **仅在强 ETag 精确匹配时**才认 Range；弱标签（`W/"..."`）、版本不匹配、日期值一律**忽略 Range 回完整 `200`**，避免客户端把不同版本的分段拼成损坏文件；
- 越界与多区间 Range 仍返回 `416` + `Content-Range: bytes */<total>`（`416` 也携带 `ETag`）；
- 文件大小未知（Telegram 未上报）时**不声明 `Accept-Ranges`、不下发 `ETag`**，退化为完整 `200` 直通；
- **续传前提是链接仍在有效期内**：过期 / 已撤销 / 不存在统一 `404`，无法从旧链接续传。

冷文件的 Range 请求仍从 Telegram **偏移 0 顺序回源并写入本地缓存**，客户端请求的区间若尚未回源完成，由区间 follower **等待补齐**后再继续输出——**不是随机读取**，并发多线程下载尚未回源的部分无法立即应答（表现为等待，而不是报错或重复回源）。

`curl -C -` 自动断点续传示例：

```bash
curl -C - -OJ "https://your-domain.example/api/bot-dl/<token>"
```

完整的 200/206/416 响应头契约、`If-Range` 语义表与显式续传示例见 [API.md](API.md)。

## 下载端点反向代理要求

为避免代理侧再次放大占用、破坏 Range/`206` 语义或最先断开长传输：

- **模板**：`scripts/release/nginx-download.conf.template`（`/api/bot-dl/` 与 `/api/s/` 直通片段）——`proxy_buffering off`、`proxy_request_buffering off`、`proxy_cache off`、`proxy_max_temp_file_size 0`、`gzip off`、`proxy_read_timeout 210s`、不设固定总时长、Range/`If-Range` 透传、`map $uri $tgtc_redacted_uri` 日志脱敏、代理临时目录声明与容量告警清单。
- **部署自检**：`scripts/release/check-download-proxy.sh`——静态校验 Nginx 下载 location + 真实 HTTP 探针（`206` / `Content-Range` / `Accept-Ranges` / 强 `ETag` + `If-Range` 不匹配回 `200` + 磁盘余量阈值）；配套回归测试 `scripts/release/tests/check-download-proxy.test.sh`（16 用例）。
- **生产 Nginx 不在本仓库**，本模板只是片段，**实际应用由运维执行**；部署后必须运行自检脚本验收。

运维要点：

- **`TGTC_BOT_STATS_PORT` 为 opt-in**：`start.sh` 仅在设置了该变量时才给 Bot API 加 `--http-stat-port`（默认关闭）。开启后暴露的 stats 端点**必须自行限制为仅本机可访问**（绑定回环 / 防火墙 / 仅允许受控监控来源），不要直接暴露公网。
- **4GiB 分卷场景**建议将 `FILE_DOWNLOAD_DIRECT_WAIT_SECONDS` 上调到 `180`（仍须小于 Nginx `proxy_read_timeout` `210s`）。
- `start.sh` 会为 Bot API 生成 systemd 单元并写入 `.env`：显式传入首字节 `120s`、空闲 `120s`、最大连接 `100`、最大文件 `0`（不限）、workdir 清理阈值 `20GiB`/目标 `15GiB`/间隔 `3600s`/TTL `86400s`/最低余量 `1GiB`/未知大小余量 `512MiB` 与 `--temp-dir`。

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
└── vX.Y.Z/
    ├── tgtc-vX.Y.Z-linux-x64.zip
    ├── SHA256SUMS
    └── RELEASE.txt
```

`ZIP` 是唯一支持的发行压缩格式。归档必须且只能含 `tgtc-vX.Y.Z-linux-x64/` 顶层目录，且包内 `VERSION`、顶层目录、ZIP 文件名及 `SHA256SUMS` 的资产名必须为同一版本。归档至少包含 `backend/`、`frontend/index.html`、`runtime/bin/node`、`telegram-bot-api/bin/telegram-bot-api`、`bin/tgtc`、`start.sh` 和完整的 `scripts/release/` 运维脚本。

发行包不包含 TypeScript 源码、测试、source map、开发依赖、`.env`、数据库、Redis 持久化、Telegram Bot API workdir、上传分片、日志、缓存或用户数据。`start.sh`、运行二进制和可执行运维脚本必须保留 Unix 可执行权限。数据库结构仍由包内编译后的正式运行时迁移维护；这些迁移不是开发文件，新库初始化和后续升级均依赖它们。

### 发行包部署、升级与回退

`VERSION` 是唯一的发行版本源，必须与前后端 `package.json` 和 lockfile 根包版本一致。Linux x64 构建在 Linux 环境执行：

```bash
bash scripts/build-linux-x64-release.sh
```

构建产物包含 `backend/`、`frontend/`、`telegram-bot-api/`、`runtime/`、`bin/`、`start.sh` 和 `scripts/release/`。首次安装使用包根目录的 `./start.sh`；已使用 `current` 符号链接部署的实例可使用：

```bash
# 检查真实服务、数据库依赖、前端入口和运行版本
./scripts/release/health-check.sh

# 独立校验 ZIP 的摘要、版本、结构、权限与安全边界
./scripts/release/validate-release.sh /absolute/path/tgtc-vX.Y.Z-linux-x64.zip /absolute/path/SHA256SUMS

# 校验 ZIP、备份、迁移、原子切换；失败仅回退程序，不回退不可逆迁移
./scripts/release/upgrade.sh /absolute/path/tgtc-vX.Y.Z-linux-x64.zip /absolute/path/SHA256SUMS

# 原子回退到上一程序版本或指定版本；不移动数据库、.env 或 Telegram workdir
./scripts/release/rollback.sh [X.Y.Z]
```

升级会把 `.env`、数据库和 Telegram Bot API workdir 保持在发行目录外。特别是 Bot API 的 `telegram-bot-api/data` 与历史 `file_id` 强绑定，严禁删除、重命名、迁移或由发行包覆盖。备份脚本根据 `DB_TYPE` 使用 PostgreSQL 逻辑备份或停止写入后的 SQLite 一致性备份：

```bash
./scripts/release/backup.sh
```

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
2. **反向代理**：正确设置 `X-Forwarded-For` 和 `X-Forwarded-Proto`，并匹配 `TRUST_PROXY_HOPS`。Node 必须监听 `127.0.0.1`（`.env.example` 默认值），由反向代理暴露公网。
3. **大文件**：提高代理请求体限制和读写超时；下载链路应关闭不必要的代理缓冲并透传 Range 请求。
4. **HTTPS**：设置 `SECURE_COOKIE=true`，配置明确的 `CORS_ORIGINS`，不要使用通配符。若 TLS 在反向代理终止，必须同时设置 `TRUST_PROXY_HOPS`（使后端识别 `X-Forwarded-Proto: https`）或显式 `SECURE_COOKIE=true`，否则会话 Cookie 将缺少 `Secure` 标志。启动预检会对生产环境下的不安全组合发出明确告警（见下）。
5. **迁移**：生产环境保持 `DB_SYNCHRONIZE=false`，部署前运行 `npm run migration:run`。
6. **多实例：当前版本不支持**。本版本必须**单后端实例**部署（PostgreSQL + Redis + Telegram Bot API 可共享，但后端进程只能有一个）。原因是核心链路上仍有进程内内存态，多实例会直接导致功能异常：
   - 分片上传会话（`chunk-upload.service.ts` 的 `sessions`）：实例 A 创建的会话分片落到实例 B 会 `session not found`，大文件分片上传**随机失败**；
   - 缓存冷回源 single-flight（`cache-session-coordinator.ts` 的 `buildSessions`/`spoolSessions`）：多实例会重复向 Telegram 回源同一文件、重复写盘，去重失效；
   - 上传任务态（`upload-job.service.ts` 的 `jobs`）与合并并发信号量（`mergeSemaphorePerUser`）：进程重启即丢失、跨实例不共享；
   - 缩略图构建去重（`thumbnail.service.ts` 的 `thumbnailBuilds`）及其他进程内 Map；
   - 文件缓存 `tmp/Cache`、缩略图 `tmp/thumbnails` 与冷回源 spool 均为**实例本地磁盘**。

   `FILE_CACHE_NO_CACHE_MODE=true` 可跳过磁盘缓存，但**不能**解决上述会话/任务/单飞的内存态问题。需要多实例前必须先完成 Redis 外置专项（会议纪要见 `docs/multi-instance-redis-design.md`）。若误配多实例，启动预检会输出高可见度错误（`CLUSTER_MODE` 相关校验）。
7. **优雅退出**：应用已启用 Nest shutdown hooks；进程管理器应发送可处理的终止信号并给予日志 flush 时间。

HTTP 服务器参数：活动连接空闲超时默认 `180` 秒（`HTTP_IDLE_TIMEOUT_SECONDS`，需大于缓存空闲超时且小于外层 Nginx `proxy_read_timeout`）、Keep-Alive 65 秒、请求头超时 66 秒；上传端点另行禁用请求超时。

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

`migration:generate` 默认生成到 `src/migrations/Migration.ts`，生成后应使用时间戳和语义化名称重命名；也可以直接调用 TypeORM CLI 指定目标文件名。迁移加载 glob 只匹配以数字时间戳开头的文件（`[0-9]*.ts`），未重命名或含 `.spec.`/`.test.` 的测试文件不会进入迁移集合。

### 前端

```bash
cd frontend
npm run dev
npm run typecheck
npm run build
npm run preview
```

## API 概览

> 程序化调用的完整说明（密钥获取、认证方式、全部文件/文件夹/分享接口及三种下载链接模式）见 **[API 调用文档](API.md)**。

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
| `GET` | `/api/bot-dl/:token` | Telegram Bot 文件直链（匿名，仅时间限制；无效/已撤销/已过期统一 404） |

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
| `GET/PUT` | `/api/admin/bot-config` | Telegram Bot 配置（有效期/额度/时区/站点域名，仅 `super_admin`） |
| `GET` | `/api/admin/bot-config/detected-domain` | 探测可信站点域名候选值（仅 `super_admin`） |
| `GET` | `/api/admin/bot-usage` | Bot 使用情况汇总（收到文件/下载次数/去重用户/带宽/趋势，仅 `super_admin`） |
| `GET` | `/api/admin/bot-usage/users` | Bot 用户明细（TG 用户 ID + @用户名，支持关键字/时间筛选与分页，仅 `super_admin`） |

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
