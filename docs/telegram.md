# Telegram 集成

> 本文档由原 README 拆分而来；文中路径均相对仓库根，省略前缀的源码路径（如 `file/file-cache.service.ts`、`telegram-mirror/*`）相对 `backend/src/`。相关配置项（Bot 入站、账号池、镜像、副本扩散）见 [configuration.md](configuration.md)。总索引见 [README](../README.md)。

---

## Telegram Bot 文件直链

- 用户在 Bot **私聊**中发送**文件**（`document`），即可获得带有效期的匿名下载直链
- 非白名单用户按日限额（默认 5 个文件/天），白名单用户不限；额度、有效期、切日时区可在后台热更新
- 直链仅受时间限制，不限下载次数；可被管理员按链接立即撤销
- 复用站内同一套本地缓存 / Range 链路：支持单区间 Range 与断点续传（`206` + `Content-Range`），越界 Range 返回 `416`
- **协议层无显式大小上限**：Bot 文件不经过本站上传链路，因此不受后台上传配置 `MAX_FILE_SIZE` 约束；本地 Bot API（`--local` + `--enable-file-streaming`）跳过内置的 20MB 下载上限，流式端点 `--file-stream-max-size` 默认 `0`（不限制）。实际可下载大小仍受 x64 平台、磁盘与缓存余量、代理临时卷、超时策略、链接有效期与 Telegram 本身能力约束
- 仅接受 `document`：图片/视频/音频等媒体类型会收到提示且**不消耗额度**；群组/频道消息一律静默忽略
- Bot 使用情况写入后端访问日志（`access_logs.botGrantId` / `botTelegramUserId`），并在后台汇总展示
- 管理员可在 Bot 私聊中维护白名单、按 TG 用户 ID 查询完整直链、按直链撤销（全程审计）


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

上传通过 Bull 队列异步提交到 Telegram。若进程异常退出或队列任务丢失，文件会长期停留在 `processing`。恢复逻辑实现于**定时任务** `tasks/tasks.service.ts` 的 `recoverStaleProcessingFiles()`（每 30 分钟执行；**不在** `file/file.service.ts`），阈值 `FILE_PROCESSING_STALE_MINUTES`（默认 60 分钟）：任务分批扫描 `status=processing` 的超时记录，只处理未提交（`uploadStage` 为 `pending`/`uploading` 且未回填 `telegramFilePath`）的文件并标记为 `error`（已提交记录由同一任务的恢复分支先处理，不受影响），前端显示"上传失败"，用户可重新上传。

镜像链路中与 Telegram 引用完整性相关的主群锚点（`telegram_main_chat_anchors`，租约/接管语义）见 [configuration.md](configuration.md) 的「账号池后台管理 + 文件镜像备份」小节。

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

> **部署提醒**：`metadata_only` 是本地二次开发 Bot API 的扩展。升级后**必须重新编译并重启 `telegram-bot-api`**，否则该参数会被旧二进制忽略，体检仍可能触发 `downloadFile` 预载。构建方法见 [部署与升级](deployment.md)（`cmake -DCMAKE_BUILD_TYPE=Release ..` + `cmake --build .`）。


