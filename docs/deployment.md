# 部署与运维

> 本文档由原 README 拆分而来；文中路径均相对仓库根，省略前缀的源码路径（如 `file/file-cache.service.ts`、`telegram-mirror/*`）相对 `backend/src/`。下载链路的超时分层与反向代理要求见 [download-and-cache.md](download-and-cache.md)，生产环境变量见 [configuration.md](configuration.md)，多实例约束见本文档「部署注意事项」。总索引见 [README](../README.md)。

---

## 环境要求

**最低硬件配置**：

- CPU：2 核
- 内存：4 GB
- 磁盘：缓存卷可用空间 ≥ **最大并发数 × 4 GiB × 2**。「最大并发数」取上游冷回源的并发口径 `FILE_DOWNLOAD_MAX_CONCURRENT_UPSTREAMS`（默认 8；开启自动扩缩容时按有效 Bot 数最多映射到 64），单个并发按 4 GiB 大文件/分卷计，×2 为峰值系数（覆盖「后端缓存 + Bot API workdir」两份本地副本并存）——默认并发下需 **≥ 64 GiB** 可用空间。缓存卷与 Bot API workdir 建议分卷部署并分别配置最低余量（`FILE_CACHE_MIN_FREE_DISK_GB` 与 `--workdir-min-free-bytes`）；运行时准入参数见 [configuration.md](configuration.md)，磁盘域说明见 [download-and-cache.md](download-and-cache.md)。

**软件要求**：

- Node.js 26 LTS。开发、CI 和生产使用仓库根目录 `.node-version` 指定的 26.13.1。
- npm 12.2.3。安装 Node.js 后，在所选 Node 环境中运行 `npm install --global npm@12.2.3`。
- PostgreSQL（默认，CI 使用 19.0），或 SQLite 3（单实例，须设置 `DB_TYPE=sqlite`）
- Redis（两种数据库模式均需要，CI 使用 8.10.3）
- Telegram Bot Token 与用于存储文件的 Chat ID（两种数据库模式均必需，SQLite 只保存元数据）
- 可选：SMTP 服务
- 可选：自建或本项目二次开发的 `telegram-bot-api`


## 快速开始

### 1. 创建数据库

```sql
CREATE DATABASE file_distribution;
\connect file_distribution
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
```

上述命令在 `psql` 中运行。迁移会尝试创建 `uuid-ossp`。如果运行账号没有创建扩展的权限，请在应用数据库中用有权限的账号预先创建扩展。

PostgreSQL 跨主版本升级时使用 `pg_upgrade`，或先用适配新服务器的客户端导出再恢复到新建数据库。[PostgreSQL 升级说明](https://www.postgresql.org/support/versioning/#upgrading)

SQLite 由应用内的驱动读取数据文件。更换驱动后的第一次启动可以沿用原 `DB_TYPE=sqlite` 和数据文件路径。SQLite 单机首次部署示例：

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
npm ci
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

后端默认监听 `http://127.0.0.1:3000`。

### 3. 启动前端

```bash
cd frontend
npm ci
npm run dev
```

前端默认访问地址为 `http://localhost:5173`，Vite 将 `/api` 代理到 `http://localhost:3000`。

如需修改开发代理目标，在 `frontend/.env` 中设置：

```env
VITE_API_PROXY_TARGET=http://localhost:3000
```

生产前端固定使用同源 `/api`，不读取独立 API 基址。


## 从源码部署 2.0.1

在单独的源码目录构建已经选定的提交。仓库根目录的 `VERSION` 随后端一起部署，`/api/version` 读取该文件。前端产物放在相邻的 `frontend/dist/`。以下示例中的路径需换成实际绝对路径。

```bash
SOURCE=/srv/tgtc-2.0.1
cd "$SOURCE"
test "$(node --version)" = "v$(cat .node-version)"
test "$(npm --version)" = "12.2.3"
bash scripts/release/check-version.sh
(cd frontend && npm ci --include=dev && npm run build)
(cd backend && npm ci --include=dev && npm run build && npm run build:data-migrator)
```

使用自建 Bot API 的实例还需构建本仓库的 C++ 服务。安装 CMake、C++ 编译器、gperf、OpenSSL 和 zlib 开发文件后运行。Linux x86_64 的 CI 使用校验过 SHA256 的 CMake 4.5.1、OpenSSL 4.1.0 和 zlib 1.4。[原生构建依赖脚本](../scripts/setup-bot-api-build-deps.sh)

```bash
cmake -S "$SOURCE/telegram-bot-api" -B "$SOURCE/telegram-bot-api/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF
cmake --build "$SOURCE/telegram-bot-api/build" --target telegram-bot-api --parallel 1
```

后端服务工作目录决定相对 SQLite 路径和 `tmp/` 的位置。首次部署可将 `backend/.env.example` 复制到工作目录的 `.env` 后填写。设置 `NODE_ENV=production`、`DB_SYNCHRONIZE=false`，用下面的命令手工迁移时可设置 `DB_MIGRATIONS_RUN=false`。从既有实例升级时应保留原配置与工作目录。

```bash
SOURCE=/srv/tgtc-2.0.1
APP_WORKDIR=/var/lib/tgtc/backend
APP_ENV="$APP_WORKDIR/.env"
NODE=$(command -v node)
cd "$APP_WORKDIR"
DOTENV_CONFIG_PATH="$APP_ENV" "$NODE" -r "$SOURCE/backend/node_modules/dotenv/config" \
  "$SOURCE/backend/node_modules/typeorm/cli.js" migration:run -d "$SOURCE/backend/dist/database/data-source.js"
```

用系统服务启动 `$NODE $SOURCE/backend/dist/main.js`。服务的 `WorkingDirectory` 和 `EnvironmentFile` 应与迁移使用的实际路径相同。进程默认在 127.0.0.1 监听，并通过同源站点提供前端和 `/api`。systemd 部署可运行 `bash "$SOURCE/scripts/release/health-check.sh"` 检查服务、数据库、前端和版本。非默认监听地址请设置 `TGTC_API_URL` 和 `TGTC_FRONTEND_URL`。

### 从 1.x 手工升级

1. 在维护窗口前完成新源码构建。记录现有 `systemctl cat tgtc.service`、Node 路径、旧提交和 `VERSION`。源码原地 checkout 常以旧仓库的 `backend/` 为工作目录，先把新提交构建到旁边的目录，避免尚在运行的进程与 `npm ci` 或重编译共用依赖。旧预编译部署通常从 `/opt/tgtc/current/bin/tgtc` 启动，可用 `readlink -f /opt/tgtc/current` 和 `cat /opt/tgtc/current/VERSION` 确认旧版本。
2. 核对并保留原工作目录、`.env`、上传暂存、缓存、Redis 持久化和 Telegram Bot API 的 `--dir`、`--temp-dir`。历史 `file_id` 依赖原 Bot 工作目录及凭据。先关闭旧更新入口，确认没有进行中的运维任务，再停后端以及其他会写该数据库的进程。
3. 后端停写后运行备份并验证。以下示例针对旧 `/opt` 布局；原地 checkout 请将 `TGTC_BACKEND_WORKDIR` 改为实际旧工作目录，`TGTC_VERSION_FILE` 改为旧源码的 `VERSION`。备份根目录应位于持久安装根内。脚本会输出本次备份的确切路径。

   ```bash
   sudo systemctl stop tgtc.service
   TGTC_INSTALL_ROOT=/opt/tgtc TGTC_BACKEND_WORKDIR=/opt/tgtc/runtime/backend \
     TGTC_VERSION_FILE=/opt/tgtc/current/VERSION bash "$SOURCE/scripts/release/backup.sh"
   (cd "/opt/tgtc/backups/本次备份目录" && sha256sum -c SHA256SUMS)
   ```

4. 在同一停写窗口内，按上节命令对实际数据库运行新源码迁移。旧 `/opt` 实例通常使用 `APP_WORKDIR=/opt/tgtc/runtime/backend`，并保留其中的 `.env` 与 SQLite 文件。先确认迁移命令成功，再调整服务。
5. 对旧预编译部署用 `systemctl edit tgtc.service` 指向源码的后端入口，保留原运行账号和工作路径。示例中的 Node 路径须指向已安装的 Node.js 26。

   ```ini
   [Service]
   WorkingDirectory=/opt/tgtc/runtime/backend
   EnvironmentFile=/opt/tgtc/runtime/backend/.env
   ExecStart=
   ExecStart=/usr/local/bin/node /srv/tgtc-2.0.1/backend/dist/main.js
   ```

   使用本仓库 Bot API 的实例应同时把其单元的可执行文件替换为新构建，保留原有启动参数、目录和凭据。执行 `systemctl daemon-reload`，先重启需要更新二进制的本地 Bot 服务，再启动后端，运行健康检查，确认 `/api/version` 为 `2.0.1`。
6. 迁移、启动或健康检查失败时停止后端并保留日志。2.0.1 调整了授权唯一索引，SQLite 还会归并时间键。恢复到 1.x 时，先从本次备份恢复数据库，再切回原程序及服务配置。PostgreSQL 可在空数据库上运行 `pg_restore --exit-on-error --single-transaction -d 恢复库 database.pg.dump`；SQLite 可用备份文件作新库并运行 `PRAGMA integrity_check`。核对连接配置、数据和版本后再恢复写入。独立 SQLite 备份只会重启它自己停下的服务。

### 退役旧自动更新组件

在已有 1.x 主机上检查 `systemctl list-units --all 'tgtc-update@*.service'` 及相关 timer、cron 和独立更新进程。关闭旧管理入口，确认正在运行的任务已结束并核对当前运行版本，再停用实际存在的专用 timer 或外部调度。保留服务器的历史日志、更新任务记录和备份。

如部署过旧模板，将 `/etc/systemd/system/tgtc-update@.service` 及其专用 drop-in、`/etc/sudoers.d/tgtc-update`、`/etc/polkit-1/rules.d/49-tgtc-update.rules` 移至仅管理员可读的归档目录。若授权规则写在共用 sudoers 文件中，用 `visudo` 仅移除旧更新器的命令授权。随后执行 `visudo -c`、`systemctl daemon-reload` 和 `systemctl mask tgtc-update@.service`，并核对该模板已停用。单独安装过的 updater 脚本可在撤销其调度与权限后归档。数据库中的历史 `update_tasks` 保留供迁移和审计，2.0.1 的服务不会重放这些任务。

### PostgreSQL 转 SQLite

在新源码后端运行 `npm run build:data-migrator`。停止源库业务写入，保留源数据库备份，从旧服务的工作目录运行工具。目标必须是新的 SQLite 文件。

```bash
cd "$APP_WORKDIR"
DOTENV_CONFIG_PATH="$APP_WORKDIR/.env" MIGRATION_TARGET="$APP_WORKDIR/data/converted.sqlite" \
  "$NODE" "$SOURCE/backend/dist-migrator/build-data-migrator.js"
```

核对目标旁边的 `.migration-report.json` 中的逐表行数、结构和完整性检查。将后端的 `DB_TYPE` 与 `DB_DATABASE` 指向已验证的 SQLite，启动后再次检查健康状态、版本和关键业务数据。


## 部署注意事项

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

   `FILE_CACHE_NO_CACHE_MODE=true` 可跳过磁盘缓存，但**不能**解决上述会话/任务/单飞的内存态问题。需要多实例前必须先完成 Redis 外置专项（把分片上传会话、上传任务态、缓存冷回源 single-flight 与缩略图构建去重外置到 Redis 等共享存储）。若误配多实例，启动预检会输出高可见度错误（`CLUSTER_MODE` 相关校验）。
7. **优雅退出**：应用已启用 Nest shutdown hooks；进程管理器应发送可处理的终止信号并给予日志 flush 时间。

HTTP 服务器参数：活动连接空闲超时默认 `180` 秒（`HTTP_IDLE_TIMEOUT_SECONDS`，需大于缓存空闲超时且小于外层 Nginx `proxy_read_timeout`）、Keep-Alive 65 秒、请求头超时 66 秒；上传端点另行禁用请求超时。


