# 环境变量与配置

> 本文档由原 README 拆分而来；完整示例见 `backend/.env.example`。标注 **SystemConfig 热更新** 的项以管理后台配置为准，环境变量只是初始值/回退；文中路径均相对仓库根。总索引见 [README](../README.md)。

---

## 数据库

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

### 数据库正式支持矩阵与 SQLite 运维边界

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


## 应用与认证

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


## SMTP

| 变量 | 说明 |
|---|---|
| `SMTP_HOST`、`SMTP_PORT` | SMTP 地址与端口 |
| `SMTP_SECURE` | 必须为 `true` 或 `false` |
| `SMTP_USER`、`SMTP_PASSWORD`、`SMTP_FROM` | SMTP 凭据与发件地址 |
| `SMTP_ENCRYPTION_KEY` | SMTP 密码加密密钥；启用 SMTP 时必需 |
| `SMTP_ENCRYPTION_SALT` | 密钥派生盐；启用 SMTP 时必需 |

不要提交实际 `.env`、Bot Token、数据库密码或 SMTP 密钥。

## Redis 与 Bull

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `REDIS_HOST` | `localhost` | Redis 地址 |
| `REDIS_PORT` | `6379` | Redis 端口 |
| `REDIS_PASSWORD` | - | Redis 密码 |
| `REDIS_DB` | `0` | Redis DB |
| `REDIS_TLS` | `false` | 是否启用 TLS |
| `REDIS_TLS_REJECT_UNAUTHORIZED` | `true` | 是否校验 Redis TLS 证书 |

Redis 承载 `metrics-aggregation`、`attack-detection`、`alert-evaluation`、`baseline-calculation`、`data-archival` 和 `file-upload` 六个队列。Redis 不可用会影响异步上传和后台任务。


## Telegram 与本地缓存

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
| `FILE_DOWNLOAD_MAX_CONCURRENT_UPSTREAMS` | `8` | 上游冷回源**权重预算**（非连接数）：`>1GiB` 权重 8、`256MiB–1GiB` 权重 2、其余 1；自动扩缩容开启时按有效 Bot 数映射 `min(64, max(8, n×16))`（1→16、2→32、4→64），范围 1-64（SystemConfig 热更新） |
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


## Telegram Bot 入站（文件直链）

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


## Bot 账号池（多账号回源，默认关闭）

> 默认关闭；`TELEGRAM_ACCOUNT_POOL_ENABLED` 不是 `true` 时，行为与单账号部署完全一致（可安全回退）。

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `TELEGRAM_ACCOUNT_POOL_ENABLED` | `false` | 账号池总开关；仅显式 `true` 时启用 |
| `TELEGRAM_ACCOUNT_POOL` | - | 账号 JSON 数组：`[{id,token,chatId,weight,maxInflight,enabled,note}]`（推荐，信息最全） |
| `TELEGRAM_BOT_TOKENS` | - | 逗号分隔 Token 列表（简化输入；存储 Chat 复用 `TELEGRAM_CHAT_ID`，**归档群不可充当存储目标**） |
| `TELEGRAM_ARCHIVE_CHAT_ID` | - | 收到的文件由接收账号转发到该群（**仅审计留痕**；严禁作为账号存储 Chat）。**不参与副本扩散**：中继目标群只认「启用中的镜像规则」 |
| `TELEGRAM_POOL_TARGET_REPLICAS` | `2` | 期望副本数（**范围 1-8**）；已迁移为 SystemConfig 热更新（后台「账号池 → 副本扩散策略」），本环境变量仅作为**初始值/回退**。**审计口径**：有效目标 = `min(配置值, 可承载副本账号数)`，用于覆盖率统计与能力预检展示；扩散本身由「启用中的镜像规则数」驱动，与该值无关 |
| `TELEGRAM_USER_RELAY_ENABLED` | `false` | 用户账号 MTProto 中继——**副本扩散的唯一执行链路**；构造期读取，变更后需重启后端。链路为「持有源消息的 Bot 转发进**主群** → 用户账号从主群转发到**各镜像群**」。不可用时按标准化原因**明确失败**（`not_configured`/`client_unavailable`/`no_account`/`source_missing`/`target_missing`/`permission_denied`/`auth_invalid`/`rate_limited`/`network`/`unknown`），缺口保留到中继恢复，**绝不退化为「从源 Bot 下载后向目标 Bot 上传」**（启动预检只告警不阻断）。**注意**：该开关是链路前置条件，关闭它**不会**停止已启用镜像规则下的镜像任务执行；需要止血时请用镜像功能运行时开关或停用规则 |

**前置条件**（任一不满足时启动预检直接拒绝启用）：显式 `TELEGRAM_FILE_STREAMING_ENABLED=true`、`TELEGRAM_FILE_STREAM_BASE` 为合法 http/https 地址，且自建 Bot API 以 `--enable-file-streaming` 启动。每个账号必须有自己的 Token、自己的存储 Chat（`chatId`）与回源能力。

**不可回退约束**：`file_id` 按账号隔离，**不得跨账号复用**；跨账号逻辑聚合只用 `file_unique_id`（缺失时该文件不参与扩散，只能由源账号回源）；回复必须由「收到消息的账号」发出（失败不会改用默认账号代发）；仅支持**单后端实例**（账号画像、在飞计数、复制去重均为进程内状态）。

**只读诊断**：`GET /api/admin/bot-account-pool`（仅超级管理员）返回脱敏快照（账号 `tokenPreview`、在飞/带宽/健康/冷却）与计数（选号/换号/回退/主群搬运尝试 `mainChatPlantAttempts`/主群搬运失败 `mainChatPlantFailures`/主群搬运接管 `mainChatPlantTakeovers`/中继尝试 `relayAttempts`/中继成功 `relaySucceeded`/中继失败 `relayFailed`/认领超时 `relayClaimsMissed`/流式失败/回复失败/入站登记失败），用于区分「服务健康」与「账号池已启用但未生效」；`/api/health` 形状保持不变。

**回退**：把 `TELEGRAM_ACCOUNT_POOL_ENABLED` 置回 `false` 即可止血（功能降级，不是数据库回滚）；副本表与 `sourceAccountId` 均为 expand 式增量结构，回退程序版本无需回退数据库。


## 账号池后台管理 + 文件镜像备份（默认关闭；v1.5.3）

> 超级管理员在后台「Telegram 账号池」（`/admin/telegram-accounts`）管理 Bot 与用户账号，并配置**多条镜像规则**：所有启用规则共用同一个**主群**（`sourceChatId`，硬约束：启用规则的 `sourceChatId` 必须一致），每条规则对应一个**镜像群**（`targetChatId`），进入系统的新文件同步到各镜像群。**三层开关**：全局账号池、镜像功能、单账号与单规则；**关闭只阻止新任务**，不中断已开始的传输，也不删除已备份内容。

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
- `GET /api/admin/telegram-accounts/replication-audit`：副本扩散资格审计（策略状态 `strategy` + 中继指标 `relayMetrics` + 大文件覆盖率 `largeFileCoverage` + 最近轮次 `recentAttempts` + 观测降级 `observability`，另含目标解析 `configured`/`eligible`/`effectiveTarget` + 降级原因、逐账号资格与排除原因、ready 覆盖率与缺失样例、容量策略状态），只读、不触发扩散；
- `PUT /api/admin/telegram-accounts/replication-target`：期望副本数热更新（1-8，写入 SystemConfig 并审计；有效目标按可承载账号数收敛）；
- `GET /api/admin/telegram-accounts/replication-attempts`：扩散轮次列表（可按 `status`/`failureReason`/`ownerType`/`ownerId` 与时间窗筛选；返回 `truncated` 与观测降级标记）；
- `GET /api/admin/telegram-accounts/replication-attempts/:id`：单轮详情（生命周期时间线与「为什么失败 / 影响 / 建议操作 / 是否可重试」四段式，只读）；
- `POST /api/admin/telegram-accounts/replication-attempts/:id/retry`：手动重试（**不新建执行路径**：把该文件在**该轮次的目标镜像群**上的扩散重新交给镜像任务队列——终态任务重置为排队、缺失任务按当前源事实补建，响应返回 `requeued`/`created`/`ruleIds`；镜像模块未装配或状态不可重试时返回 400 并说明应先修正什么）；
- `POST /api/admin/telegram-accounts/relay-preflight`：中继能力预检（默认 `dryRun=true` 只做只读检查、**不产生任何 Telegram 消息**；显式 `dryRun=false` 才向目标群发送一条受控测试消息，响应中的 `sentTestMessage` 会如实声明）；
- `POST /api/admin/telegram-accounts/:id/auth/start|verify|cancel`：用户账号交互式授权（验证码与 2FA 密码**不入库不入日志**）；
- `GET/PUT /api/admin/telegram-mirror`、`PUT .../feature`、`POST/PUT/DELETE .../rules[/:id]`、`PUT .../rules/:id/enabled`、`POST .../rules/:id/test`：**多规则**配置（每条规则一个镜像群）与权限探测；
- `GET /api/admin/telegram-mirror/tasks`、`POST .../tasks/:id/retry|cancel`：任务列表与人工干预；`POST /api/admin/telegram-mirror/grants/:id/retry` 可对单个 Bot grant 补触发升级前遗漏的扩散任务，不扫描/批量重放旧 grant；已有 grant 任务若已 `succeeded`，只返回 `skippedSucceeded`，不会清除回执或重复转发；
- `POST/GET /api/admin/telegram-mirror/backfill[/pause|/resume|/cancel]`：历史文件补偿（按批限速、可暂停取消、`dry-run` 只统计）。响应中的 `job.classification` 给出**可恢复性分类**：`executable`（可执行）/ `missingAnchor`（缺源锚点）/ `covered`（已有当前版本任务）/ `staleVersion`（存在旧版本任务，将按当前版本补建），`missingAnchorSample` 给出最多 20 条缺锚点文件 id 供人工核查；**缺源锚点的文件在 `apply` 下会被跳过（不建单）**，避免继续产出无意义的阻塞任务；
- 兼容端点 `GET /api/admin/bot-account-pool` 保持不变（只读脱敏诊断）。

**扩散链路的事实边界（不可含糊）**：

1. **唯一链路 = 主群 → 用户账号中继 → 镜像群**：持有源消息的 Bot 先用 Bot API `forwardMessage` 把消息搬进**主群**（服务端复制、零字节），已授权的用户账号再从主群 `copyMessage` 到**每个启用规则的镜像群**（服务端复制、零字节），镜像群内各 Bot 各自收到消息并登记**自己账号的** `file_id` 副本；
2. **不存在字节二次上传**：原「Bot 重新上传到备份群」（目标账号二次上传）路径已整体删除，也没有任何降级分支会重新上传字节；`file_id` 按账号隔离，不允许把 A 账号的 `file_id` 交给 B 账号；
3. **主群与镜像群必须分离**，镜像群不得是任一账号的主存储 Chat；所有启用规则的 `sourceChatId` 必须一致（否则一份文件会有多个中转落点）；启用规则前必须通过一次真实权限测试；
4. **主群锚点必须先落库**（`telegram_main_chat_anchors`，唯一键 `ownerType + ownerId`，跨规则共享一个落点）：`forwardMessage` 没有幂等键，因此顺序固定为「**先写 `status='pending'` 预留 → 再转发 → 成功后收口为 `ready`**」，重试不重复搬运、同一文件不会在主群留下 N 条重复消息；搬运只允许由**持有该消息的那个账号**执行；`pending` 预留带 **5 分钟租约**——租约内重复触发按**可重试**等待（`main_chat_anchor_pending`，绝不冒险再搬一次），超租约视为「上次进程在落库前中断」的残留，由下一次重试**接管重搬**并计数 `mainChatPlantTakeovers`（此时主群可能已多出一条消息，需人工核对）；`failed` 行（上次转发未成功、无副作用残留）可立即接管；锚点指向旧主群（主群配置变更）时同样重搬并计入该计数；**接管用「删旧行 + 重新插入」的唯一键 CAS 完成**——同一时刻只有一个执行者持有预留，并发接管者会撞唯一键并按可重试收口，绝不双搬（不依赖 `affected` 行数，也不依赖日期列精度）；租约必须**短于**任务重试预算（`MIRROR_MAX_ATTEMPTS` 次退避之和，有单元测试断言守护），否则任务会在租约内耗尽重试、锚点长期停在 `pending`；租约内报错会带 `retryAfterMs = 租约剩余 + 15 秒`，把重试**排到租约到期之后**（否则最后一次可重试的尝试仍会撞上未到期的预留）；失败收口写入带 `status != 'ready'` 条件——租约到期后被接管并搬运成功的锚点，绝不会被更早那次超时失败改写成 `failed`（否则下一次重试会「立即接管重搬」再留一条重复消息）；
5. 任务幂等键为 `ruleId + 归属对象 + 源版本`：重复事件、重试与重启都收敛为一次有效扩散；覆盖上传递增 `uploadVersion` 会让旧任务自动作废；
6. `429` 尊重 `retry_after` 退避，权限/源消息失效/凭据失效/**主群缺失或与镜像群冲突**/**无可用用户账号**进入 `blocked` 并告警，**不会无限重试**；转发成功而状态落库失败时保存回执，重试凭回执确认（不重复转发）。

**只支持单后端实例**：账号画像、镜像任务对账与补偿进度均为进程内状态；`DEPLOYMENT_MODE=multi` 会被启动预检拒绝。**升级必须原子切换，禁止新旧两个版本并行写锚点表**：旧版本的接管是「原地 `update`」，会覆盖新版执行者刚写入的 `pending` 预留，两边各自搬运一次（`scripts/release/upgrade.sh` 已是原子切换，勿手工并行拉起旧版本）。

**回退**：先停用镜像规则 → 再停用异常账号 → 最后关闭账号池/镜像总开关；已写入备份群的消息不会自动删除；新增表与可空列均为 expand 式增量，回退程序版本无需回退数据库。


## 副本扩散与下载负载均衡（v1.6.0）

> 目标：**一次转发，多 Bot 共享副本，下载按负载分流**。Web 上传或 Bot 收到文件后，只有匹配对应范围开关的启用规则会建任务（`includeWebUploads` / `includeBotInboundFiles`）；源消息先搬进**主群**（Bot API 服务端转发，零字节），再由**用户账号**从主群服务端转发到对应**镜像群**；镜像群内每个 Bot 各自收到该消息、登记**自己账号的** `file_id` 副本；这些副本经桥接写入站内文件的副本记录后，下载回源即可在多个 Bot 之间按权重 × 带宽 × 健康 × 容量选号。**入库即触发扩散**（不再等下载时才补副本），但管理员可显式关闭任一来源范围，因此不是所有入库文件都会建镜像任务。

**为什么必须用用户账号**：Telegram 规定 bot 永远看不到其它 bot 发送的消息（与隐私模式、管理员身份无关）。因此「接收 Bot 转发到群」不能让其它 Bot 获得该文件；只有**用户账号**发出的消息才能被全群 Bot 看到。详见 `TELEGRAM_USER_RELAY_ENABLED` 的配置说明。

| 环节 | 实现位置 | 关键契约 |
|---|---|---|
| 主群搬运 | `telegram-mirror/telegram-main-chat-anchor.service.ts` | 持有源消息的 Bot 用 `forwardMessage` 把消息搬进主群并持久化锚点（`telegram_main_chat_anchors`，唯一键 `ownerType + ownerId`）；**先写 `pending` 预留再执行转发**（租约 5 分钟，超租约接管重搬并计数 `mainChatPlantTakeovers`），重试不重复搬运；失败分类为阻塞并给出可执行提示 |
| 中继 | `telegram-mirror/telegram-user-copy.service.ts`（**唯一执行链路**）、`telegram-account-pool/user-relay.service.ts`（**只做**能力判定与目标群解析，不执行转发） | 从**主群锚点**服务端转发到 `rule.targetChatId`、**零字节重传**；幂等键 = 逻辑操作 + 执行账号 + **目标群 + 锚点**（派生确定性 `random_id`，重试不产生重复消息）；失败按标准化原因返回，**不存在任何字节二次传输的降级路径** |
| 副本认领 | `telegram-bot/telegram-bot-dispatch.service.ts` | 各 Bot 长轮询各自收到群消息后登记本账号副本；**缺失 `file_unique_id` 时拒绝登记**（不退化为 `file_id`）；命中目标群的消息标记来源 `relayed` |
| 回源并发与失败分类 | `telegram-account-pool/account-aware-download.service.ts`、`telegram-bot/telegram-bot-public.controller.ts` | 仅尝试同一逻辑文件的 ready 副本账号，最多 8 个且不超过副本数；源账号冷却/满载返回结构化 `503` + `Retry-After`，日志/响应/失败审计共用 `requestId`；来源身份未知与容量不足分开计数，**禁止跨账号借用 `file_id`** |
| 桥接 | `telegram-account-pool/file-copy.service.ts` | 按 `file_unique_id` 反查 `files.telegramFileUniqueId`，额外写 `ownerType='file'` 副本；`file_id` 严格归属产生它的账号，**禁止跨账号借用** |
| 轮次状态 | `telegram-account-pool/replication-attempt.service.ts` | 每轮扩散一行 `telegram_replication_attempts`：前置阻塞 → 中继 → 有界认领等待 → 终态（`succeeded`/`partial_success`/`claim_timeout`/`retryable_failed`/`blocked_*`），退避重试与保留期清理都在这里 |
| 选号回源 | `telegram-account-pool/account-aware-download.service.ts` | 只在同一归属的 ready 副本账号间加权选号，最多尝试 8 个（不超过该文件持有副本数）；已知来源但无容量返回带 `Retry-After` 的 `DOWNLOAD_ACCOUNT_POOL_BUSY`，绝不跨账号复用 `file_id`；**下载路径不产生任何扩散副作用**（扩散在入库时即已触发） |

**扩散完成的口径**（不能只看「转发成功」）：中继成功只是中间态；认领窗口内新增 ≥1 个 ready 副本为 `partial_success`，达到有效目标数为 `succeeded`，窗口内零新增记为 `claim_timeout`（说明群里没人拿到 `file_id`）。

**部署前置条件**（缺任一项都不会损坏数据，但副本无法扩散，下载仍集中在单账号）：

1. `TELEGRAM_BOT_UPDATES_ENABLED=true`，且账号池已启用、存在 ≥2 个 Bot 账号；
2. **各镜像群内每个 Bot 都必须关闭隐私模式（BotFather `/setprivacy` → Disable）或设为管理员**——否则 Bot 收不到用户账号发出的普通群消息；
3. 至少一个已授权的 `user` 账号，且**同时是主群与各镜像群成员**、对各镜像群有发送权限（用户账号读不到 Bot 私聊，也未必是各账号存储 Chat 的成员，所以源消息必须先落到主群）；
4. `TELEGRAM_USER_RELAY_ENABLED=true`（构造期读取，需重启后端）；中继目标群**只认「启用中的镜像规则 `targetChatId`」**——没有启用规则时中继返回 `target_missing`（映射为 `blocked_target_chat`）；**主群 = 启用规则的 `sourceChatId`**（复用现有配置，不新增开关；所有启用规则必须一致，否则判定为阻塞）；`TELEGRAM_ARCHIVE_CHAT_ID` 仅保留其审计转发用途。

**Bot 私聊来源（主 BOT 收到用户私聊文件）**：用户账号读不到「Bot 与用户的私聊」，因此入站时会先由**接收该消息的 Bot** 用 Bot API `forwardMessage`（服务端复制、零字节）把消息搬进**主群**，并把「主群 chat_id + message_id」作为**主群锚点**持久化（`telegram_main_chat_anchors`，唯一键 `ownerType + ownerId`，跨规则共享一个落点）——**先写 `pending` 预留再转发**（租约 5 分钟；租约内按可重试等待，超租约接管重搬并计数 `mainChatPlantTakeovers`），重试不会重复搬运、同一文件不会在主群留下 N 条重复消息。**Web 上传来源同理**：锚点若在各账号存储 Chat（userbot 未必是成员），同样先搬进主群，保证「唯一源锚点 = 主群」；锚点已在主群则直接使用，不做多余转发。主群缺失、与镜像群相同或搬运账号不是主群成员时任务进入 `blocked` 并给出可执行提示，**不回退归档群，更不回退为字节上传**。

**可见性与放大抑制**：来自**主群或镜像群**的消息只登记副本、**不再向归档群转发**（否则群内 N 个 Bot 会各转发一次，消息量按 Bot 数放大）。

**排障信号**：`GET /api/admin/bot-account-pool` 的计数提供 `relayAttempts` / `relaySucceeded` / `relayFailed` / `relayClaimsMissed`（三者一起看：只有尝试数增长而成功数为 0 才说明中继真在失败，而不是「本轮没有需要扩散的文件」）与 `inboundBridgeMisses`（群消息与站内文件无关，属正常）。告警规则：`RELAY_NOT_READY`（中继已启用但不可用，CRITICAL）、`RELAY_FAILURE_BURST`（失败激增）、`RELAY_CLAIM_TIMEOUT_BURST`（中继成功但无人认领）、`LARGE_FILE_COVERAGE_DEGRADED`（≥4GiB 分层出现缺口）、`REPLICATION_OBSERVABILITY_GAP`（轮次写入/读取失败，观测数据不完整）、`MIRROR_NO_ENABLED_RULES`（镜像功能已开启但没有任何启用中的规则，CRITICAL——这是唯一「新文件不会有任何备份且不产生任务记录」的静默状态）。

**运维排障手册（副本扩散）**：

| 症状 | 先看什么 | 处理 |
|---|---|---|
| 策略卡显示「中继未启用」 | 中继开关与「构造期读取，重启生效」标注 | 在 `.env` 设置 `TELEGRAM_USER_RELAY_ENABLED=true` 后**重启后端**（不热更新），再点「能力预检（只读）」确认 |
| 用户账号认证失效（`auth_invalid`） | 用户账号页签的健康与最近错误 | 重新走交互式授权（`auth/start` → `auth/verify`）；验证码与 2FA 密码**不入库不入日志**；账号会被标记降级，修好后自动恢复 |
| 中继成功但无人认领（`claim_timeout` / `relayClaimsMissed` 增长） | 目标群内每个 Bot 的成员状态与隐私模式 | 按顺序排查：① Bot 是否都在群内；② 是否关闭隐私模式或设为管理员；③ `TELEGRAM_BOT_UPDATES_ENABLED=true` 且轮询正常；④ 群消息的 `file_unique_id` 能否对上站内文件（对不上只计入 `inboundBridgeMisses`，属正常） |
| 中继报 `target_missing`（策略卡「未解析到目标群」） | 镜像规则是否启用且配置了 `targetChatId` | 启用镜像规则；`TELEGRAM_ARCHIVE_CHAT_ID` **不再**作为扩散目标群 |
| 大文件（≥4GiB）覆盖率退化 | 「大文件覆盖率」卡的 ≥4GiB 分层与缺失样例、Bot 入站事件范围、同一 grant/fileUnique 的 ready 账号列表 | 先确认 `includeBotInboundFiles` 已开启、Bot 长轮询与用户账号中继正常，再确认镜像群内各 Bot 已认领同一文件；只在同一文件确实有多个可调度 ready 副本后做冷回源测试。账号池对同一文件会尝试最多 8 个持有副本的账号；没有副本时不得跨账号复用 `file_id`。对升级前已签发的 Bot 直链 grant，可在管理员 API `POST /api/admin/telegram-mirror/grants/:id/retry` 对单个 UUID 受控补建/重排任务，不批量回放历史 grants |
| 主群缺失 / 主群与镜像群冲突 | 任务失败原因与策略卡提示（`blocked_*`） | 在镜像规则里把 `sourceChatId` 配成同一个独立主群（不得等于任一镜像群、不得是账号存储 Chat），保存后重试任务 |
| 无可用用户账号 / 搬运账号不是主群成员 | 用户账号页签的授权状态与主群成员身份 | 先完成交互式授权，再把该账号加入主群（可读）与各镜像群（可写）；搬运只能由**持有该消息的账号**执行，不能跨账号代搬 |
| 手动重试的边界 | 事件时间线的「是否可重试」 | 只有 `retryable_failed` / `claim_timeout` 可重试；重试**不新建执行路径**——把该文件在**该轮次的目标镜像群**上的扩散重新交给镜像任务队列（重置终态任务、按当前源事实补建缺失任务），响应返回 `requeued`/`created`/`ruleIds`；`blocked_*` 必须先修配置。轮次记录缺目标群（历史数据）时**明确拒绝**重试（不按「全部启用规则」误重排其它镜像群），请改用「镜像任务列表」里按镜像群的重试入口 |
| 任务报 `main_chat_anchor_pending`（主群锚点正在搬运中） | 主群锚点表的 `status`/`plantedAt`（预留时间）与后端日志 | 属**可重试**保护：租约（5 分钟）内不重复搬运，等租约到期后重试会自动接管；若日志出现「接管重搬」告警，请人工核对主群是否多出一条消息（计数 `mainChatPlantTakeovers` 长期 > 0 说明存在崩溃/落库失败窗口）。该计数在**主群配置变更后重搬**时也会增加（日志为「主群锚点不可复用」），属预期的一次性重搬，不是故障信号 |
| 后台「全绿」但新文件没有备份 | `MIRROR_NO_ENABLED_RULES` 告警与镜像规则列表 | 镜像功能已开启但没有**启用中**的规则：触发层直接跳过（不建单、无 blocked 记录）。启用至少一条镜像规则即可恢复 |
| 后台显示「观测数据不完整」 | `REPLICATION_OBSERVABILITY_GAP` 告警与后端日志 | 轮次写入失败（磁盘 / 锁等待 / 权限）时指标与事件不完整——**不得**把「看不到失败」当成「没有失败」；先修写入再看扩散健康度 |
| 需要人工验证目标群可写 | 策略卡「探测目标群可写」 | 默认只读预检**不产生消息**；只有显式确认后才发送一条受控测试消息（会真实出现在群里，可忽略） |

**限速原则（大文件缺口补偿）**：每次重试都会真实向目标群发一条消息，用户账号受 Telegram Flood 限制；`rate_limited`/`network`/`unknown` 类失败按指数退避自动重试（基数 30s、倍率 2、上限 15min，最多 5 次后升级为 `blocked_manual`）。因此**不要一次点多个重试**：优先处理 `claim_timeout`（通常是群权限问题，改完配置一次就够），大文件缺口按分钟级节奏逐个补。


## 环境变量主 Bot 与统一选号（v1.5.3）

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


