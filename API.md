# API 调用文档

本文档描述通过 **API 密钥（API Key）** 调用文件分发系统接口的方法。API Key 允许脚本、命令行工具和第三方程序以某个账号身份执行全部文件与文件夹操作，无需维持浏览器登录会话。

- 所有需要认证的接口同时接受 **JWT Cookie**（网页端）与 **`X-API-Key` 请求头**（程序调用）。
- 请求同时携带两者时 `X-API-Key` 优先；密钥无效或已撤销时直接返回 `401`，**不会**回退到 Cookie 认证。
- **Owner-only 边界**：每个密钥只能操作其关联账号拥有的文件和文件夹。即使该账号本身是管理员，通过 API Key 也无法访问其他用户的任何资源。

## 目录

- [获取密钥](#获取密钥)
- [认证方式](#认证方式)
- [响应格式与错误](#响应格式与错误)
- [密钥管理](#密钥管理)
- [文件操作](#文件操作)
- [获取下载链接（三种模式）](#获取下载链接三种模式)
- [文件夹操作](#文件夹操作)
- [分享管理](#分享管理)
- [Telegram Bot 文件直链](#telegram-bot-文件直链)
- [限制与安全须知](#限制与安全须知)

---

## 获取密钥

使用任意已登录账号（所有角色均可）在 **网页端 → 个人设置 → API 密钥** 中创建；或先通过账号登录获取 JWT Cookie 后调用管理接口（见[密钥管理](#密钥管理)）。

明文密钥格式为 `tgtc_<随机段>`，在创建/轮换的响应中出现（网页端「查看」按钮同样可回显）。密钥以 AES-256-GCM 密文保存，因此关闭弹窗后仍可由所有者在列表中点「查看」重新回显——**历史密钥**（未保存密文）、**已撤销密钥**以及**根密钥变更**导致解密失败的密钥除外；这三种情况会返回明确的错误提示，需重新创建或轮换。

## 认证方式

在需要认证的请求上附加请求头：

```text
X-API-Key: tgtc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

curl 示例：

```bash
curl -H "X-API-Key: tgtc_xxxx" https://your-domain.example/api/files
```

认证失败的响应均为 `401`，不区分"密钥不存在 / 已撤销 / 账号被封禁 / 密码已变更"，避免泄露信息。

## 响应格式与错误

除流式下载外，所有响应由全局拦截器统一包装：

```json
{
  "code": 0,
  "message": "success",
  "data": { }
}
```

- `code = 0` 表示成功，业务数据在 `data` 字段；
- `code != 0` 或 HTTP 4xx/5xx 表示失败，`message` 为人类可读的错误描述；
- 常见状态码：`400` 参数错误、`401` 认证失败、`403` 无权操作（含尝试访问他人资源）、`404` 资源不存在、`410` 资源不可用（过期/耗尽）、`429` 请求过于频繁。

下文示例中的 `data` 均指响应包装内的业务数据。

---

## 密钥管理

密钥管理接口**仅接受登录会话（JWT Cookie）**，不接受 API Key 自身认证——密钥不能创建、撤销或轮换其他密钥。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/api-keys` | 创建密钥，响应含明文（仅此一次） |
| `GET` | `/api/api-keys` | 列出我的密钥（仅元信息） |
| `DELETE` | `/api/api-keys/:id` | 撤销密钥（即时失效，幂等） |
| `POST` | `/api/api-keys/:id/rotate` | 轮换密钥：撤销旧密钥并签发新明文 |

创建（`name` 可选，最长 64 字符，默认"默认密钥"）：

```bash
curl -X POST https://your-domain.example/api/api-keys \
  -H "Content-Type: application/json" \
  -b "access_token=<JWT>" \
  -d '{"name": "CI 部署脚本"}'
```

```json
{
  "id": "0d1c9c3e-...",
  "name": "CI 部署脚本",
  "prefix": "tgtc_a1b2c3d4",
  "key": "tgtc_a1b2c3d4XXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "createdAt": "2026-09-06T08:00:00.000Z"
}
```

轮换会撤销旧密钥并返回一个新明文，响应结构与创建相同。

---

## 文件操作

以下接口均接受 `X-API-Key` 认证。除非特别说明，操作仅作用于密钥关联账号自己的文件。

### 上传

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/files/upload` | 同步单文件上传，multipart 字段名 `file`；可选 `tagIds` |
| `POST` | `/api/files/upload-multiple` | 同步批量（最多 10 个），字段名 `files` |
| `POST` | `/api/files/upload-async` | 异步上传，立即返回 `jobId`，适合大文件；可选 `tagIds`、`folderId`、`overwriteFileId` |
| `POST` | `/api/files/upload-multiple-async` | 异步批量（最多 10 个） |
| `GET` | `/api/files/upload-status/:jobId` | 查询异步任务状态 |
| `POST` | `/api/files/chunk/init` | 分片上传初始化 |
| `POST` | `/api/files/chunk/:uploadId` | 上传单个分片（`chunk` + `index`） |
| `GET` | `/api/files/chunk/:uploadId/status` | 查询已上传分片 |
| `POST` | `/api/files/chunk/:uploadId/complete` | 完成合并，后台入队上传 |
| `POST` | `/api/files/chunk/:uploadId/abort` | 取消并清理 |

单文件同步上传示例：

```bash
curl -X POST https://your-domain.example/api/files/upload \
  -H "X-API-Key: tgtc_xxxx" \
  -F "file=@./report.pdf"
```

分片上传适合超过代理层限制的大文件，流程：`init` → 循环上传分片 → `complete` → 轮询文件列表确认状态。分片大小上限 100 MB，Multer 单文件硬上限 600 MB；实际业务上限由系统配置决定。

### 查询

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/files` | 文件列表。支持 `page`/`limit`/`keyword`/`folderId`/`tagIds`/`includeDeleted`/`sortBy`/`sortOrder`/`cursor` |
| `GET` | `/api/files/:id` | 文件详情 |

```bash
curl -H "X-API-Key: tgtc_xxxx" \
  "https://your-domain.example/api/files?limit=20&keyword=report"
```

### 下载与预览

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/files/:id/download` | 下载文件本体；支持单区间 `Range`（断点续传）——缓存命中直出 `206`，**冷 build/spool 亦保持 `206`**（未回源区间由 follower 等待补齐）；可携带 `?taskTicket=` 消费下载任务票据 |
| `GET` | `/api/files/:id/preview` | 页内预览（`inline`），预览不消耗访问次数 |
| `GET` | `/api/files/:id/cache-status` | 查询缓存状态（`cached`/`cold`） |
| `GET` | `/api/files/:id/thumbnail` | 缩略图 |
| `GET` | `/api/files/:id/thumbnail-hd` | 高清视频封面 |

```bash
curl -H "X-API-Key: tgtc_xxxx" -OJ \
  "https://your-domain.example/api/files/<file-id>/download"
```

#### 下载任务（排队与负载感知）

服务器磁盘或 Telegram 回源繁忙时，直接发起下载会进入服务端队列。为便于展示真实排队状态而非长时间等待，可先创建下载任务。任务**真实持有磁盘预约**（不再是只读探测），资源就绪时签发一次性票据：

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/files/:id/download-tasks` | 创建下载任务，返回可否立即下载或排队原因 |
| `GET` | `/api/download-tasks/:taskId` | 查询任务状态（服务端每次重新评估队列情况） |
| `DELETE` | `/api/download-tasks/:taskId` | 取消排队中的任务（幂等） |

请求体（可选）：

```json
{ "nocache": false }
```

响应示例（排队中）：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "taskId": "8f0d…",
    "status": "queued",
    "queueReason": "disk",
    "queuePosition": 3,
    "retryAfterMs": 5000,
    "expectedSize": 10485760,
    "downloadUrl": "/api/files/<file-id>/download",
    "expiresAt": "2026-09-17T12:30:00.000Z",
    "message": "正在等待服务器释放磁盘空间，前面还有 2 个任务"
  }
}
```

响应示例（资源就绪，含一次性票据）：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "taskId": "8f0d…",
    "status": "streamable",
    "mode": "cache",
    "expectedSize": 4294967296,
    "downloadUrl": "/api/files/<file-id>/download?taskTicket=<ticket>",
    "ticket": "<ticket>",
    "ticketExpiresAt": "2026-09-17T12:31:00.000Z",
    "expiresAt": "2026-09-17T12:45:00.000Z",
    "message": "已为该任务预留磁盘空间，正在开始下载"
  }
}
```

字段说明：

- `status`：`queued`（排队中）/ `streamable`（可开始下载）/ `cancelled` / `expired`；
- `mode`：`cache`（走正式缓存 / 临时暂存）或 `direct`（结构性不可行时有界直通，不占本地缓存）；
- `queueReason`：`disk`（磁盘空间）/ `upstream`（回源连接）/ `server_load`（综合负载或缓存容量饱和）；
- `retryAfterMs`：建议的查询间隔（客户端应按此退避，页面隐藏时可进一步降频）；
- `downloadUrl`：拿到 `streamable` 后由浏览器原生下载使用（同源 Cookie 鉴权）。资源就绪时 URL 会**自带 `?taskTicket=`**，前端**不得**自行拼接；
- `ticket` / `ticketExpiresAt`：一次性票据与其过期时间（默认 120 秒）。**仅在任务真实持有预约时下发**。

票据与取消语义：

- 正文请求 `GET /api/files/:id/download?taskTicket=<ticket>` 会**原子消费**票据，并把任务持有的磁盘预约交接给该请求，使其**不再重新排队**；
- 票据**单次有效**、绑定归属用户与文件：已被消费、归属 / 文件不匹配、过期的票据一律忽略，回退到常规准入路径（不影响旧前端与直接下载）；
- **取消以服务端返回状态为准**：任务已把预约交接给正文请求（`handedOff`）后，`DELETE` 取消**不再生效**（避免中途砍断已开始的传输）；取消 / 过期 / 关闭会释放预约并作废票据；
- `mode='direct'` 的任务**立即变为 `streamable`**（不再停在 `queued`），真实下载走有界滚动缓冲直通。

```bash
# 1) 创建任务
TASK=$(curl -s -H "X-API-Key: tgtc_xxxx" -H "Content-Type: application/json" \
  -d '{}' "https://your-domain.example/api/files/<file-id>/download-tasks" | jq -r .data.taskId)

# 2) 轮询直到可下载（按 retryAfterMs 退避，示例固定 2s）
curl -s -H "X-API-Key: tgtc_xxxx" \
  "https://your-domain.example/api/download-tasks/$TASK" | jq .data.status

# 3) 拿到 streamable 后，用返回的 downloadUrl（已含 taskTicket）触发下载
# 4) 取消排队（可选）
curl -s -X DELETE -H "X-API-Key: tgtc_xxxx" \
  "https://your-domain.example/api/download-tasks/$TASK"
```

说明：

- 下载任务**不传输文件**，仅上报调度状态；最终文件传输仍由 `/api/files/:id/download` 完成；
- 任务状态以服务端**内存为权威**（与「仅支持单后端实例」的约束一致），同时落库一份最终状态用于重启恢复；服务重启后遗留的非终态任务被标记为 `expired`，需重新创建；
- 任务归属绑定创建者身份，其他用户查询 / 取消一律返回 `404`；
- 若直接调用下载端点而未使用任务接口，服务器会在有限等待（`FILE_DOWNLOAD_DIRECT_WAIT_SECONDS`，默认 60s）后返回结构化错误，不会无限悬挂。

**下载相关结构化错误码**（随响应头 `X-Tgtc-Error-Code` 返回，一般同时带 `Retry-After`）：

| 错误码 | HTTP | 含义 |
|---|---:|---|
| `DOWNLOAD_QUEUE_FULL` | `429` | 磁盘 / 上游等待队列已满 |
| `DOWNLOAD_QUEUE_TIMEOUT` | `503` | 排队等待超时 |
| `DOWNLOAD_QUEUE_CANCELLED` | `499` | 排队期间被取消（用户取消 / 请求断开） |
| `DOWNLOAD_SERVER_BUSY` | `503` | 上游并发或服务器综合负载过高（非任务化直连在有限等待后返回） |
| `DOWNLOAD_STORAGE_PROBE_UNAVAILABLE` | `503` | 磁盘空间探测失败（fail-closed） |
| `DOWNLOAD_INSUFFICIENT_STORAGE` | `507` | 结构上无法完整暂存（单文件超过缓存上限 / 卷内空间结构性不足），应降级直通 |
| `DOWNLOAD_SHUTTING_DOWN` | `503` | 服务正在关闭，下载请求已取消 |

### 修改与删除

| 方法 | 路径 | 请求体 | 说明 |
|---|---|---|---|
| `PATCH` | `/api/files/:id/rename` | `{"newOriginalName": "..."}` | 重命名 |
| `PATCH` | `/api/files/:id/move` | `{"folderId": "<uuid>" \| null}` | 移动（`null` 为根目录） |
| `POST` | `/api/files/:id/copy` | `{"folderId": "<uuid>" \| null}` | 复制副本 |
| `DELETE` | `/api/files/:id` | - | 请求删除（7 天冷静期，可恢复） |
| `POST` | `/api/files/:id/restore` | - | 恢复删除 |
| `POST` | `/api/files/:id/force-delete` | - | 跳过冷静期永久删除 |
| `PUT` | `/api/files/:id/access-type` | `{"accessType": "public" \| "private"}` | 公开/私有 |
| `PUT` | `/api/files/:id/password` | `{"password": "..."}` | 设置访问密码 |
| `PUT` | `/api/files/:id/expires` | `{"expiresIn": 1..720 \| null}` | 有效期（小时；`null` 永久） |
| `PUT` | `/api/files/:id/access-count` | `{"maxAccessCount": -1..1000000}` | 访问次数上限（`-1` 不限） |
| `PUT` | `/api/files/:id/tags` | `{"tagIds": ["<uuid>"]}` | 全量替换标签 |
| `DELETE` | `/api/files/:id/tags/:tagId` | - | 移除单个标签 |
| `POST` | `/api/files/batch-markdown` | `{"ids": ["<uuid>"]}` | 批量生成 Markdown |

### 公开属性说明

文件级 `public/private`、密码、访问次数与有效期属于**遗留约束模型**，仅影响 `/files/public/:id` 旧公开入口。新分享场景建议改用[获取下载链接](#获取下载链接三种模式)或[分享管理](#分享管理)，约束由链接自身携带，不改动文件属性。

---

## 获取下载链接（三种模式）

一个接口，通过 `mode` 参数返回三种下载链接：

```text
GET /api/files/:id/download-link?mode=<permanent|timed|count_limited>
```

### 模式一：永久公开（`mode=permanent`）

将文件**转换为公开文件**并返回公开下载链接，匿名可访问、无时效和次数限制。

```bash
curl -H "X-API-Key: tgtc_xxxx" \
  "https://your-domain.example/api/files/<file-id>/download-link?mode=permanent"
```

```json
{
  "mode": "permanent",
  "url": "https://your-domain.example/files/public/<file-id>",
  "token": "<file-id>",
  "expiresIn": null,
  "maxAccessCount": -1
}
```

行为说明：

- 转换为公开文件时会**一并清除**文件遗留的密码、访问次数与有效期约束（该操作记录审计日志）；如需收回，调用 `PUT /api/files/:id/access-type` 改回 `private`；
- 链接真实可访问地址为 `https://<前端域名>/files/public/<file-id>`（后端返回的 `url` 基于 `APP_URL`，程序内建议按当前站点 origin 重建）。

### 模式二：限时公开（`mode=timed`）

返回限时公开下载链接，匿名可访问；`durationHours` 为有效小时数（**必填**，整数 1-720，即最长 30 天）。**首次被访问时开始计时**，到期后链接自动失效。

```bash
curl -H "X-API-Key: tgtc_xxxx" \
  "https://your-domain.example/api/files/<file-id>/download-link?mode=timed&durationHours=24"
```

```json
{
  "mode": "timed",
  "url": "https://your-domain.example/s/AbC12xYz34qQ",
  "token": "AbC12xYz34qQ",
  "expiresIn": 24,
  "maxAccessCount": -1
}
```

### 模式三：限次下载（`mode=count_limited`）

返回限次数下载链接，匿名可访问；`maxAccessCount` 为最大访问次数（**必填**，整数 1-1000000）。达到次数上限后链接自动失效；浏览器对同一文件的分段（Range）下载在 30 秒窗口内只计一次，完整下载不会被重复扣次。

```bash
curl -H "X-API-Key: tgtc_xxxx" \
  "https://your-domain.example/api/files/<file-id>/download-link?mode=count_limited&maxAccessCount=10"
```

```json
{
  "mode": "count_limited",
  "url": "https://your-domain.example/s/AbC12xYz34qQ",
  "token": "AbC12xYz34qQ",
  "expiresIn": null,
  "maxAccessCount": 10
}
```

### 两种受限链接的通用说明

- `timed` / `count_limited` 创建的是**独立分享链接**（`/s/:token`），不修改文件本身的公开属性，过期或耗尽后文件不受影响；
- 每次调用都会创建一条新链接；可在网页端 **我的分享** 中查看、修改和取消，也可通过分享管理接口操作（见下文）；
- 参数缺失或超出范围返回 `400`，例如 `mode=timed` 未携带 `durationHours`。

---

## 文件夹操作

全部接受 `X-API-Key` 认证，仅作用于关联账号自己的文件夹。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/folders/tree` | 完整文件夹树 |
| `GET` | `/api/folders/contents?parentId=` | 列出子文件夹与文件（`parentId` 缺省为根目录） |
| `GET` | `/api/folders/breadcrumb?parentId=` | 面包屑路径 |
| `POST` | `/api/folders` | 创建文件夹，`{"name": "...", "parentId": "<uuid>" \| null}` |
| `PATCH` | `/api/folders/:id` | 重命名 |
| `PATCH` | `/api/folders/:id/move` | 移动到新父级 |
| `DELETE` | `/api/folders/:id` | 软删除（联动子树与文件，7 天冷静期） |
| `POST` | `/api/folders/:id/restore` | 恢复软删 |

创建文件夹示例：

```bash
curl -X POST https://your-domain.example/api/folders \
  -H "X-API-Key: tgtc_xxxx" -H "Content-Type: application/json" \
  -d '{"name": "backup-2026", "parentId": null}'
```

---

## 分享管理

接受 `X-API-Key` 认证，仅能管理密钥关联账号创建的分享。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/shares` | 创建分享链接。请求体：`targetType`（`file`/`folder`）、`targetId`、可选 `password`、`maxAccessCount`（-1 不限）、`expiresIn`（1-720 小时，`null` 永久） |
| `GET` | `/api/shares` | 我的分享列表（`targetType`/`page`/`limit`） |
| `GET` | `/api/shares/:id` | 分享详情 |
| `PATCH` | `/api/shares/:id` | 修改密码/次数/有效期 |
| `DELETE` | `/api/shares/:id` | 取消分享 |

```bash
curl -X POST https://your-domain.example/api/shares \
  -H "X-API-Key: tgtc_xxxx" -H "Content-Type: application/json" \
  -d '{"targetType": "file", "targetId": "<file-id>", "maxAccessCount": 5, "expiresIn": 72}'
```

成功响应的 `data` 含 `token`、`url` 和 `id`；分享页地址为 `https://<前端域名>/s/<token>`。

> 不受 `X-API-Key` 影响的公开端点：`GET /api/s/:token` 系列（分享元数据、密码验证、下载、预览、文件夹浏览）保持匿名可用，行为与网页访客一致。

---

## Telegram Bot 文件直链

Bot 直链由 Telegram 私聊交互签发，面向**匿名下载**，与 API 密钥体系完全解耦（不复用 JWT，也不暴露 Bot Token、`file_id` 或本站用户凭据）。需管理员先设置 `TELEGRAM_BOT_UPDATES_ENABLED=true` 并重启后端。

### 匿名直链下载

```http
GET /api/bot-dl/:token
```

| 项 | 说明 |
|---|---|
| 认证 | 无需认证 |
| 有效期 | 默认 4 小时（后台「Telegram Bot 设置」可调，1–720 小时；已签发链接沿用签发时的有效期） |
| 次数 | **不限次数**，仅受时间限制 |
| 文件大小 | **协议层无显式大小上限**。Bot 文件不经过本站上传链路，不受后台上传配置的 `MAX_FILE_SIZE` 约束；本地 Bot API 以 `--local` 运行跳过内置 20MB 下载上限，流式端点 `--file-stream-max-size` 默认 `0`（不限制）。实际可下载大小受 x64 平台、磁盘与缓存余量、代理临时卷、超时策略、链接有效期与 Telegram 本身能力约束 |
| 失效 | 不存在 / 已撤销 / 已过期**统一返回 `404`**，不区分原因（防枚举） |
| 限流 | 按来源 IP 与完整 Token 的 SHA-256 摘要双维度限流，超限返回 `429` |

**响应契约**：

| 场景 | 状态 | 关键响应头 |
|---|---|---|
| 完整下载 | `200` | `Content-Length`、`Accept-Ranges: bytes`、`ETag: "<强ETag>"`、`Content-Type`、`Content-Disposition: attachment`、`Cache-Control: no-store, no-cache, must-revalidate`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` |
| 单区间 Range | `206` | `Content-Range: bytes <start>-<end>/<total>`、`Content-Length`（分段长度）、`Accept-Ranges: bytes`、**与完整响应相同的 `ETag`** |
| 越界 / 多区间 / 非法 Range | `416` | `Content-Range: bytes */<total>`、`ETag`（同样携带） |
| 文件大小未知 | `200` | 无 `Accept-Ranges`、无 `ETag`、无 `Content-Range`，完整直通 |
| 无效 / 已撤销 / 过期 | `404` | JSON 错误体（不区分原因） |
| 超限 | `429` | 限流响应 |

**`ETag` 与 `If-Range` 语义**：

稳定强 `ETag` = `sha256('telegram-bot:' + file_id + ':' + size)` 的十六进制摘要（带引号），不含明文凭据；同一 Telegram 文件跨不同直链保持一致。`If-Range` 行为：

| `If-Range` 值 | 行为 |
|---|---|
| 缺省 | 有 `Range` 即按强 ETag 契约处理 |
| 与服务端强 `ETag` **精确相同** | 认 Range，返回 `206` |
| 弱标签 `W/"..."` | **忽略 Range**，回完整 `200` |
| 任意不匹配的 ETag | 忽略 Range，回完整 `200` |
| 日期值 | 忽略 Range，回完整 `200` |

> 实现只支持**强 ETag 精确匹配**：弱校验与日期值一律按「版本不匹配」处理、回完整 `200`，避免客户端把不同版本的分段拼成损坏文件。

**Range 与断点续传**：

- `bytes=0-99`（closed）、`bytes=500-`（open-ended）、`bytes=-500`（suffix）均返回真实 `206` + `Content-Range`；
- 上游始终**单路顺序回源并写入本地缓存**，客户端请求的区间若尚未回源完成，由区间 follower 等待补齐后再继续输出；因此**并发多线程下载尚未回源的部分无法立即应答**（表现为等待，而不是报错、也不会重复回源）——**冷 Range 仍从 Telegram 偏移 0 顺序回源，不是随机读取**；
- 非法或越界 Range（含多区间 `bytes=0-1,5-6`、错误单位等）统一返回 `416` + `Content-Range: bytes */<total>`，**不会**静默退化为 `200`；
- 仅当 Telegram 未上报 `file_size`（无法计算 `Content-Range` / `Content-Length`）时，才退化为完整 `200` 直连传输，此时不返回 `Accept-Ranges`、不下发 `ETag`；
- **续传前提是链接仍在有效期内**：过期 / 已撤销 / 不存在统一 `404`，无法从旧链接续传；
- 缓存键由 Telegram `file_id` 经带命名空间的 SHA-256 派生为稳定 UUID，因此同一文件的多次直链访问（含跨 grant）复用同一份缓存。

**续传示例**：

```bash
# 1) 全新下载
curl -OJ "https://your-domain.example/api/bot-dl/<token>"

# 2) 断点续传（curl 自动带 Range / If-Range，命中则 206 继续，否则回 200 从头下）
curl -C - -OJ "https://your-domain.example/api/bot-dl/<token>"

# 3) 显式续传：先取强 ETag，再按 If-Range 携带
ETAG=$(curl -sI "https://your-domain.example/api/bot-dl/<token>" \
  | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')
curl -H "Range: bytes=1048576-" -H "If-Range: $ETAG" -o part.bin \
  "https://your-domain.example/api/bot-dl/<token>"
```

> `If-Range` 不匹配时，响应会是**完整 `200`**（无 `Content-Range`、`Content-Length` 等于文件总长）。客户端应据此从头重下，而不是把该响应当作续传分段拼接。

**错误响应头**：流式下载路径的结构化错误（如服务繁忙、队列满、无法完整暂存）会随响应头返回 `X-Tgtc-Error-Code` 与 `Retry-After`（错误码表见[下载任务](#下载任务排队与负载感知)）；本端点自身的「无效 / 已撤销 / 过期」仍为统一 `404`、「超限」为 `429`。

### 管理配置

```http
GET /api/admin/bot-config
PUT /api/admin/bot-config
```

仅 `super_admin`。`GET` 返回 `config`、`effectiveDomain`、`detectedDomain`、`cryptoAvailable`。

`PUT` 请求体（字段均可选，写入后**热更新生效**）：

```json
{
  "linkTtlHours": 4,
  "dailyLimit": 5,
  "quotaTimezone": "Asia/Shanghai",
  "linkDomainMode": "auto",
  "linkDomain": "https://text.lappland.top"
}
```

| 字段 | 校验 |
|---|---|
| `linkTtlHours` | 1–720 的整数（小时） |
| `dailyLimit` | 1–100000 的整数 |
| `quotaTimezone` | 合法 IANA 时区名 |
| `linkDomainMode` | `auto` 或 `manual` |
| `linkDomain` | `http(s)://host[:port]`，不含路径/查询串/用户信息；可为空字符串 |

非法值返回 `400`（后端为权威校验方）。变更写入 `config_change` 审计（`resourceType: 'bot_config'`），且不记录敏感明文。

### 域名探测

```http
GET /api/admin/bot-config/detected-domain
```

返回 `{ "detectedDomain": "https://..." | null }`。与签发时的解析优先级一致：**手动配置 > `APP_URL` > 受信代理头（需 `TRUST_PROXY_HOPS`）> fail-closed**；不采信裸 `Host` 头，无可用来源时返回 `null`。

### 使用情况汇总

```http
GET /api/admin/bot-usage?timeRange=7d
```

`timeRange` 支持 `1h` / `24h` / `7d` / `30d`（默认 `7d`）。两个数据源：**下载**侧来自 `access_logs`，**收到文件**侧来自 `telegram_bot_file_grants`（即 Bot 收到文件并成功签发直链的记录，被配额拒绝的文件不计入）：

```json
{
  "timeRange": "7d",
  "requests": 42,
  "rangedRequests": 12,
  "completedRequests": 30,
  "abortedRequests": 12,
  "abortedByReason": { "client_abort": 9, "timeout": 2, "upstream_error": 1 },
  "downloads": 42,
  "uniqueUsers": 7,
  "totalBytes": "104857600",
  "filesReceived": 18,
  "receivedBytes": "734003200",
  "trend": [
    {
      "bucket": "2026-09-15 00:00:00",
      "requests": 12,
      "ranged": 3,
      "completed": 10,
      "aborted": 2,
      "downloads": 12,
      "bytes": "20971520",
      "files": 4,
      "fileBytes": "104857600"
    }
  ]
}
```

统计口径为「**请求数 / 分段数 / 完成数 / 中断数**」：

- `requests`：HTTP 请求数（含完整、分段与中断）；
- `rangedRequests`：其中 Range（`206`）请求数——**断点续传是否真的发生，看这个值**；
- `completedRequests`：把响应体**完整写完**的请求数；
- `abortedRequests`：被中断的请求数（客户端断开 / 上游失败 / 超时 / 服务关闭）；
- `abortedByReason`：中断原因分布（`terminationReason` → 次数，不含 `completed`）；
- `downloads`：**旧字段，保留为「请求数兼容别名」**——历史上它就是请求数（非完整下载数），新前端请改用 `requests` / `rangedRequests` / `completedRequests` / `abortedRequests`；
- 趋势行同样给出 `requests` / `ranged` / `completed` / `aborted` 与兼容字段 `downloads`。

计数规则补充：

- **Range 请求单独计数**：一个文件的分段下载会产生多次请求、分别计入 `requests` 与 `rangedRequests`，因此 `requests` 通常大于「文件数」；
- **客户端中断如何统计**：只有响应体被完整写出（pipeline 正常返回）才计入 `completedRequests` 与访问次数；客户端提前断开计入 `abortedRequests`，并按原因分类（如 `client_abort`）。未分类的历史行与普通请求按 `0` 计；
- `totalBytes` / `receivedBytes` / `fileBytes` 均为字符串（bigint 在 SQL 侧聚合，超出 `Number.MAX_SAFE_INTEGER` 亦不丢精度）；带宽口径优先取**实际响应正文字节**（`COALESCE(responseBodyBytes, responseSize)`），历史行回退到含响应头的估算值；
- 两个数据源的时间桶使用同一表达式与粒度，已按桶合并为一条 `trend`。

### Bot 用户明细

```http
GET /api/admin/bot-usage/users?timeRange=all&keyword=@alice&page=1&pageSize=20
```

按 TG 用户 ID 聚合的 Bot 使用明细，**直接给出用户 ID 与 @用户名**（`telegramUsername` 为该用户最新一次非空的快照；不返回昵称 `telegramDisplayName`）：

| 参数 | 说明 |
|---|---|
| `timeRange` | `all`（默认，不限时间）/ `1h` / `24h` / `7d` / `30d`，按「收到文件」时间过滤 |
| `keyword` | 同时匹配 TG 用户 ID 与 @用户名（大小写不敏感，`%`/`_`/`\` 已转义） |
| `page` / `pageSize` | 页码（默认 1）与每页条数（默认 20，上限 100） |

```json
{
  "total": 3,
  "page": 1,
  "pageSize": 20,
  "rows": [
    {
      "telegramUserId": "80000000000000001",
      "telegramUsername": "@alice",
      "filesReceived": 6,
      "receivedBytes": "734003200",
      "downloads": 11,
      "lastReceivedAt": "2026-09-15T08:12:33.000Z",
      "lastAccessedAt": "2026-09-15T09:40:02.000Z"
    }
  ]
}
```

`downloads` 为该用户文件直链的**累计**访问次数（`accessCount` 之和，不随时间范围变化）。

### Bot 命令（Telegram 私聊）

| 命令 | 权限 | 说明 |
|---|---|---|
| `/help`、`/start` | 所有用户 | 用法说明 |
| `/id` | 所有用户 | 返回自己的 TG 用户 ID |
| `/quota` | 所有用户 | 查询今日剩余额度 |
| `/wl_add <TG用户ID>` | 管理员 | 永久加入白名单 |
| `/wl_remove <TG用户ID>` | 管理员 | 移出白名单 |
| `/wl_list` | 管理员 | 列出白名单（截断） |
| `/link_query <TG用户ID>` | 管理员 | 返回完整可点直链（每次调用全审计） |
| `/link_revoke <直链URL或Token>` | 管理员 | 按直链撤销，立即失效 |

> 管理员身份仅依据数字 TG 用户 ID；`@username` 仅用于审计展示。**不提供**用户侧用量历史命令（无 `/history`）。

---

## 限制与安全须知

- **数量上限**：每个账号最多同时持有 20 个有效密钥，超出需先撤销。
- **失效条件**：撤销立即生效；关联账号被封禁后密钥立即失效；账号修改密码后，**早于密码变更时间创建的所有密钥失效**，需重新创建。
- **能力边界**：密钥不能访问其他账号的任何资源（即使关联账号是管理员）；不能管理用户、系统配置等管理员接口；不能创建或撤销其他密钥；独立标签管理接口（`/api/tags/*`）暂不支持密钥认证。
- **存储安全**：密钥等同账号文件操作凭证，请勿提交到代码仓库、日志或公开场所；怀疑泄露时立即在设置页撤销，或修改账号密码使全部旧密钥失效。
- **频率限制**：下载、搜索、分享访问等端点沿用系统安全配置中的限流规则，超限返回 `429`。
- **审计**：密钥的创建、撤销与文件操作均进入审计日志，日志中只出现密钥前缀，不出现明文。
