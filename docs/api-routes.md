# API 路由概览

> 本文档由原 README 拆分而来。程序化调用（API Key 获取、认证方式、文件/文件夹/分享接口与三种下载链接模式）见 [API.md](API.md)。总索引见 [README](../README.md)。

---

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
| `GET` | `/api/s/:token` | 分享元数据或密码要求 |
| `POST` | `/api/s/:token/verify` | 验证分享密码并签发短期访问令牌 |
| `GET` | `/api/s/:token/download/:fileId` | 分享下载 |
| `GET` | `/api/s/:token/preview/:fileId` | 分享页内预览（Range 命中 206，不消费访问额度） |
| `GET` | `/api/s/:token/cache-status/:fileId` | 分享缓存状态（`cached`/`cold`） |
| `GET` | `/api/s/:token/thumbnail/:fileId` | 分享缩略图（凭证 Cookie 鉴权） |
| `GET` | `/api/s/:token/thumbnail-hd/:fileId` | 分享高清视频封面 |
| `GET` | `/api/s/:token/folder/:folderId/contents` | 浏览分享文件夹 |
| `GET` | `/api/s/:token/folder/:folderId/breadcrumb` | 分享面包屑 |
| `GET` | `/api/files/media/:id` | 公开媒体直链（无鉴权）；仅对公开、未删除、无密码、无次数/时效限制的图片、音频、视频生效 |
| `GET` | `/media/:id` | 公开媒体直链别名，直接返回图片、音频或视频本体 |
| `GET` | `/files/public/:id` | 旧分享入口兼容重定向 |
| `GET` | `/api/bot-dl/:token` | Telegram Bot 文件直链（匿名，仅时间限制；无效/已撤销/已过期统一 404） |
| `GET` | `/api/public-config` | 公共配置（站点标题与版本，无需登录） |
| `GET` | `/api/health` | 健康检查（数据库探活；失败返回 503 且不泄露连接信息） |
| `GET` | `/api/version` | 当前运行版本号 |
| `GET` | `/api/files/public-key` | 缩略图加密公钥（RSA-OAEP） |
| `GET` | `/api/files/media-ticket` | 凭一次性票据取媒体流（票据由登录用户签发，TTL 300 秒） |
| `POST` | `/api/s/:token/media-ticket/:fileId` | 签发分享内联预览票据（scope=share） |
| `GET` | `/api/media/share-ticket` | 凭分享票据取媒体流 |

### 登录用户接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/auth/me` | 当前用户 |
| `GET` | `/api/users/me/stats` | 当前用户统计 |
| `PUT` | `/api/users/me/password` | 修改密码 |
| `GET` | `/api/files/upload-config` | 查询上传限制（类型白黑名单与动态大小上限，需登录） |
| `GET` | `/api/files` | **当前用户文件列表**；管理员访问此端点默认仍查询自己的文件 |
| `GET` | `/api/files/:id` | 文件详情 |
| `GET` | `/api/files/:id/download` | 登录用户下载 |
| `GET` | `/api/files/:id/preview` | 页内在线预览（Range 命中 206，冷文件回退全量） |
| `GET` | `/api/files/:id/cache-status` | 缓存状态（`cached`/`cold`），前端据此决定单连接策略 |
| `GET` | `/api/files/:id/thumbnail?t=` | 加密令牌缩略图 |
| `GET` | `/api/files/:id/thumbnail-hd?t=` | 加密令牌高清视频封面 |
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
| `GET` | `/api/files/:id/share` | 生成单文件分享链接 |
| `POST` | `/api/files/:id/download-link` | 创建下载直链（三种模式，额外做同源写校验） |
| `POST` | `/api/files/:id/media-ticket` | 签发媒体预览票据（TTL 300 秒，避免把 JWT 写进 URL） |
| `POST` | `/api/files/:id/download-tasks` | 创建下载任务（两阶段下载第一阶段，返回排队原因与队列位置） |
| `GET` | `/api/download-tasks/:taskId` | 查询下载任务状态（仅创建者本人） |
| `DELETE` | `/api/download-tasks/:taskId` | 取消排队中的下载任务（仅创建者本人） |
| `POST` | `/api/api-keys` | 创建 API 密钥（明文仅返回一次） |
| `GET` | `/api/api-keys` | 我的 API 密钥列表 |
| `DELETE` | `/api/api-keys/:id` | 撤销密钥（即时失效） |
| `POST` | `/api/api-keys/:id/rotate` | 轮换密钥 |
| `GET` | `/api/api-keys/:id/reveal` | 重新显示明文（仅新密钥） |
| `GET/PUT` | `/api/api-keys/:id/allowlist` | 查询或替换密钥 IP 白名单 |
| `GET` | `/api/api-keys/:id/usage-logs` | 密钥使用记录（IP 脱敏） |
| `GET` | `/api/api-keys/admin/usage-logs` | 管理员查看全站密钥使用记录（handler 内联角色校验） |

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
| `GET` | `/api/admin/my-files-stats` | 当前管理员的文件统计 |
| `DELETE` | `/api/admin/banned-ips/:ip` | 按 IP 解封（路径参数形式；IPv6 建议用 `banned-ips/unban`） |
| `POST` | `/api/admin/files/stale-paths/cleanup` | 清理存量旧路径（试运行/执行，仅 `super_admin`） |
| `POST` | `/api/admin/smtp/test` | 发送测试邮件 |
| `GET/PUT` | `/api/admin/download-config` | 下载资源调度配置，仅 `super_admin` |
| `GET` | `/api/admin/download-runtime` | 下载与缓存运行快照（预约/队列/权重/RSS 等），仅 `super_admin` |
| `GET` | `/api/admin/source-analysis/referer` | 来源 Referer 分析，仅 `super_admin` |
| `GET` | `/api/admin/source-analysis/user-agent` | User-Agent 来源分析，仅 `super_admin` |
| `GET` | `/api/admin/user-activity/stats` | 用户活跃度统计，仅 `super_admin` |
| `GET` | `/api/admin/bandwidth/top-files` | 带宽消耗 Top 文件，仅 `super_admin` |
| `GET` | `/api/admin/file-type-stats` | 文件类型统计，仅 `super_admin` |
| `GET` | `/api/admin/comparison` | 同比 / 环比分析，仅 `super_admin` |
| `GET` | `/api/admin/ban-stats` | IP 封禁统计，仅 `super_admin` |
| `GET` | `/api/admin/audit-logs/email-verification-stats` | 邮箱验证统计，仅 `super_admin` |
| `GET` | `/api/admin/bot-account-pool` | Bot 账号池只读诊断，仅 `super_admin` |
| `GET` | `/api/admin/bot-inbound-status` | Bot 入站轮询诊断，仅 `super_admin` |
| `GET` | `/api/admin/access-logs*` | 访问日志及聚合分析（含 Top 文件/路径、延迟、状态码、下载量、异常 IP、趋势等子路径） |
| `GET` | `/api/admin/audit-logs` | 操作审计 |
| `GET/PUT` | `/api/admin/bot-config` | Telegram Bot 配置（有效期/额度/时区/站点域名，仅 `super_admin`） |
| `GET` | `/api/admin/bot-config/detected-domain` | 探测可信站点域名候选值（仅 `super_admin`） |
| `GET` | `/api/admin/bot-usage` | Bot 使用情况汇总（收到文件/下载次数/去重用户/带宽/趋势，仅 `super_admin`） |
| `GET` | `/api/admin/bot-usage/users` | Bot 用户明细（TG 用户 ID + @用户名，支持关键字/时间筛选与分页，仅 `super_admin`） |
| `GET` | `/api/admin/export` | CSV/JSON 数据导出 |

多数分析、审计、缓存和安全配置接口仅允许 `super_admin`；管理员接口一律只接受 JWT 会话（不接受 API Key）。

#### 系统更新（仅 `super_admin`）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/admin/update/status` | 更新状态与当前版本 |
| `POST` | `/api/admin/update/check` | 检查 GitHub 可用更新 |
| `POST` | `/api/admin/update/install` | 安装更新（创建任务） |
| `GET` | `/api/admin/update/tasks` | 更新任务列表 |
| `GET` | `/api/admin/update/tasks/:taskId` | 单个更新任务详情 |
| `POST` | `/api/admin/update/tasks/:taskId/cancel` | 取消更新任务 |

#### Telegram 账号池与镜像（仅 `super_admin`）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/admin/telegram-accounts/overview` | 账号池总览与能力预检 |
| `PUT` | `/api/admin/telegram-accounts/feature` | 账号池总开关 |
| `GET` | `/api/admin/telegram-accounts` | 账号列表（分页筛选） |
| `GET` | `/api/admin/telegram-accounts/replication-audit` | 副本资格审计报告 |
| `PUT` | `/api/admin/telegram-accounts/replication-target` | 期望副本数热更新 |
| `GET` | `/api/admin/telegram-accounts/replication-attempts` | 扩散轮次时间线查询（筛选参数 `status` 支持英文逗号分隔多值，如 `retryable_failed,claim_timeout`；非法值 400，不静默忽略） |
| `GET` | `/api/admin/telegram-accounts/replication-attempts/:attemptId` | 单轮扩散详情与建议 |
| `POST` | `/api/admin/telegram-accounts/replication-attempts/:attemptId/retry` | 手动重试单轮扩散 |
| `POST` | `/api/admin/telegram-accounts/relay-preflight` | 中继能力预检（默认演练） |
| `POST` | `/api/admin/telegram-accounts/bots` | 添加 Bot 账号 |
| `POST` | `/api/admin/telegram-accounts/users` | 创建用户账号（待授权） |
| `POST` | `/api/admin/telegram-accounts/env/:accountId/probe` | 重探环境变量账号 |
| `GET` | `/api/admin/telegram-accounts/:id` | 账号详情（脱敏） |
| `PATCH` | `/api/admin/telegram-accounts/:id` | 更新账号配置 |
| `DELETE` | `/api/admin/telegram-accounts/:id` | 撤销账号（清空凭据） |
| `POST` | `/api/admin/telegram-accounts/:id/test` | 测试连接与权限 |
| `POST` | `/api/admin/telegram-accounts/:id/rotate` | 轮换账号凭据 |
| `POST` | `/api/admin/telegram-accounts/:id/auth/start` | 授权：发送验证码 |
| `POST` | `/api/admin/telegram-accounts/:id/auth/verify` | 授权：提交验证码 |
| `POST` | `/api/admin/telegram-accounts/:id/auth/cancel` | 授权：取消会话 |
| `GET` | `/api/admin/telegram-mirror` | 镜像总览与前置检查 |
| `POST` | `/api/admin/telegram-mirror/rules` | 新建镜像规则（默认停用） |
| `PUT` | `/api/admin/telegram-mirror/rules/:id` | 更新镜像规则 |
| `DELETE` | `/api/admin/telegram-mirror/rules/:id` | 删除镜像规则 |
| `PUT` | `/api/admin/telegram-mirror/feature` | 镜像功能总开关（热更新） |
| `PUT` | `/api/admin/telegram-mirror/rules/:id/enabled` | 启用或停用规则 |
| `POST` | `/api/admin/telegram-mirror/rules/:id/test` | 规则权限测试 |
| `POST` | `/api/admin/telegram-mirror/grants/:id/retry` | Bot 直链补触发扩散 |
| `GET` | `/api/admin/telegram-mirror/tasks` | 镜像任务列表（筛选） |
| `POST` | `/api/admin/telegram-mirror/tasks/:id/retry` | 重试失败任务 |
| `POST` | `/api/admin/telegram-mirror/tasks/:id/cancel` | 取消未开始任务 |
| `POST` | `/api/admin/telegram-mirror/backfill` | 启动历史文件补偿 |
| `GET` | `/api/admin/telegram-mirror/backfill` | 补偿任务状态 |
| `POST` | `/api/admin/telegram-mirror/backfill/pause` | 暂停历史补偿 |
| `POST` | `/api/admin/telegram-mirror/backfill/resume` | 恢复历史补偿 |
| `POST` | `/api/admin/telegram-mirror/backfill/cancel` | 取消历史补偿 |

#### 运维告警（仅 `super_admin`）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/admin/alerts` | 告警列表（分页筛选） |
| `GET` | `/api/admin/alerts/unacknowledged` | 未确认告警列表 |
| `POST` | `/api/admin/alerts/:id/acknowledge` | 确认单条告警 |
| `POST` | `/api/admin/alerts/acknowledge-all` | 确认全部告警 |
| `GET` | `/api/admin/alerts/rules` | 告警规则列表 |
| `PUT` | `/api/admin/alerts/rules` | 修改规则（占位实现，返回 501） |


