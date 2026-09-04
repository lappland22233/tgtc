# TGTC 系统更新运维手册

本文描述版本检测与自动更新链路的生产部署要点、故障处理与回退边界。
更新闭环：**检查 → 确认 → 下载 → 可信校验 → 预检 → 备份 → 迁移 → 原子切换 → 健康检查 → 成功或回退**。

## 1. 配置项（环境变量，只读；不得经系统配置 API 修改）

| 配置 | 默认 | 说明 |
|---|---|---|
| `UPDATE_CHECK_ENABLED` | `true` | 是否允许版本检查 |
| `UPDATE_INSTALL_ENABLED` | `false` | 是否允许触发安装；**首次上线保持 false**，演练通过后开启 |
| `UPDATE_GITHUB_OWNER` | `lappland22233` | 固定更新源 owner |
| `UPDATE_GITHUB_REPO` | `tgtc` | 固定更新源 repo |
| `UPDATE_GITHUB_TOKEN` | 空 | 可选；仅从环境变量读取，全程脱敏 |
| `UPDATE_CHECK_TIMEOUT_MS` | `10000` | GitHub API 请求超时 |
| `UPDATE_CACHE_TTL_MS` | `1800000` | 成功检查结果缓存 |
| `UPDATE_MIN_CHECK_INTERVAL_MS` | `10000` | 两次真实外呼最小间隔 |
| `UPDATE_MAX_ASSET_BYTES` | `3GiB` | 发行包大小上限 |
| `UPDATE_PUBLIC_KEY_PATH` | 包内公钥 | 发布签名验证公钥（私钥只在 CI secret `RELEASE_SIGNING_KEY`） |
| `UPDATE_TASK_DIR` | 空 | 任务描述目录（绝对路径）；安装必需 |
| `UPDATE_STAGING_DIR` | 空 | 下载暂存目录（绝对路径） |
| `UPDATE_UPDATER_PATH` | 空 | 固定更新器入口（绝对路径）；安装必需 |
| `UPDATE_TASK_TIMEOUT_MS` | `1800000` | 任务整体超时 |
| `UPDATE_HEALTH_TIMEOUT_MS` | `60000` | 激活后健康检查超时 |

启动时校验：非法值直接让应用启动失败；路径必须为绝对路径。

## 2. 部署前提

1. 服务以 `current` 符号链接部署（`systemctl cat tgtc.service` 必须引用 `$INSTALL_ROOT/current/`），
   旧版目录保留在 `$INSTALL_ROOT/releases/<版本>/`。
2. 运行时状态必须在发行目录之外：`.env`、数据库、Redis、Telegram Bot API workdir、上传分片。
   更新器对 `telegram-bot-api/data`、`td.binlog*`、`db.sqlite*`、`uploads/`、`logs/` 等有硬性保护断言，出现即拒绝执行。
3. 发布签名公钥随发行包内置（`scripts/release/update-public-key.pem`）；
   CI secret `RELEASE_SIGNING_KEY` 为对应 RSA-3072 私钥，绝不离线分发。
4. sudoers：只允许固定更新器入口 + uuid 参数（见 `scripts/release/systemd/tgtc-update.sudoers`），
   保持 sudo 默认 `env_reset`。systemd oneshot 样例见 `scripts/release/systemd/tgtc-update@.service`。

## 3. 更新执行器（updater.sh）的固定契约

- 后端把任务描述 JSON 写入 `UPDATE_TASK_DIR/<uuid>.json`（schema 见 `UpdateTaskDescription`），
  然后以 `sudo -n <UPDATE_UPDATER_PATH> <uuid>` 派发；无 shell、无任意路径参数。
- 更新器自行重新校验：任务来源（描述中的当前版本 = 本机部署版本）、资产名/大小/SHA-256、
  SHA256SUMS 签名（内置公钥）、清单 schema/版本/平台/兼容窗口，之后才进入备份/迁移/切换。
- 进度回传：`<uuid>.state`（状态机阶段名）与 `<uuid>.heartbeat`（心跳时间）。
- 状态机：`queued→downloading→verifying→prechecking→backing_up→extracting→migrating→
  activating→restarting→health_checking→succeeded`；失败进入
  `rollback_pending→rolling_back→rolled_back|rollback_failed`。
  `queued/downloading` 可取消；`backing_up` 起禁止取消。
- 全局互斥：数据库活动任务部分唯一索引 + 更新器 `flock` 文件锁。

## 4. 故障处理

| 故障 | 现象 | 处置 |
|---|---|---|
| GitHub 不可达/限流 | 检查返回 `stale`（原因 `network`/`rate_limited` 等） | 无需处理；业务不受影响，稍后重试 |
| 摘要/签名失败 | 任务停在 `error`，旧版本继续运行 | 确认 Release 完整性；重新检查更新 |
| 下载/校验阶段失败 | 任务 `rolled_back`（无需回退数据） | 旧版本继续运行；排查磁盘/网络后重试 |
| 迁移失败 | 任务 `rolled_back`；数据库已回退到备份点之前未切换 | 按第 5 节人工恢复；勿直接重试 |
| 启动/健康失败 | 更新器自动切回旧符号链接并重启旧版本 → `rolled_back` | 查 `<uuid>.error` 与 journald |
| `rollback_failed` | 状态停在 `rollback_failed`，服务可能运行新版本 | **停止自动重试**；保护现场；按第 5 节人工切换 + 告警 |
| 后端随升级重启 | 新进程基于"运行版本 vs 任务目标版本"自动收敛 succeeded/rolled_back | 无需人工 |

人工切换版本（所有自动手段不可用时）：

```bash
sudo systemctl stop tgtc.service
ln -sfn "releases/<版本>" "$INSTALL_ROOT/current"
sudo systemctl start tgtc.service
"$INSTALL_ROOT/current/scripts/release/health-check.sh"
```

数据库人工恢复：`pg_restore` 备份位于 `$INSTALL_ROOT/backups/<时间戳>/database.pg.dump`，
先 `pg_restore --list` 核对再恢复。SQLite 使用同目录 `database.sqlite`。
绝不移动/替换 Telegram Bot API workdir，否则历史 `file_id` 全部失效。

## 5. 上线顺序（对应总计划阶段 6）

1. 先开放"检查更新"（`UPDATE_INSTALL_ENABLED=false`），观察 stale/错误分布。
2. 预生产用真实 Release 完成 `旧版 → 新版` 升级与回退演练；至少各注入一次：
   GitHub 不可达、限流、下载中断、摘要错误、签名错误、磁盘不足、迁移失败、健康超时。
3. 演练通过后开启 `UPDATE_INSTALL_ENABLED=true`，首次生产升级安排维护窗口并人工值守。
4. 旧发行目录与备份按保留策略清理（backup.sh 内建按天清理；releases 目录人工评估后清理）。
