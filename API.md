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
| `GET` | `/api/files/:id/download` | 下载文件本体；本地缓存命中时支持 `Range`（断点续传） |
| `GET` | `/api/files/:id/preview` | 页内预览（`inline`），预览不消耗访问次数 |
| `GET` | `/api/files/:id/cache-status` | 查询缓存状态（`cached`/`cold`） |
| `GET` | `/api/files/:id/thumbnail` | 缩略图 |
| `GET` | `/api/files/:id/thumbnail-hd` | 高清视频封面 |

```bash
curl -H "X-API-Key: tgtc_xxxx" -OJ \
  "https://your-domain.example/api/files/<file-id>/download"
```

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
| 响应 | 完整下载 `200`（含 `Content-Length`）；单区间 Range 返回 `206`（含 `Content-Range`）；`Content-Disposition: attachment`、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Accept-Ranges: bytes` |
| 失效 | 不存在 / 已撤销 / 已过期**统一返回 `404`**，不区分原因（防枚举） |
| 限流 | 按来源 IP 与 Token 前缀双维度限流，超限返回 `429` |

> **Range 与断点续传**：端点复用与站内下载完全相同的本地缓存 / Range 链路（`FileCacheService`），**支持标准单区间 Range 与断点续传**——`bytes=0-99`（closed）、`bytes=500-`（open-ended）、`bytes=-500`（suffix）均返回真实 `206` + `Content-Range`。
>
> - 上游始终**单路顺序回源并写入本地缓存**，客户端请求的区间若尚未回源完成，由区间 follower 等待补齐后再继续输出；因此**并发多线程下载尚未回源的部分无法立即应答**（表现为等待，而不是报错、也不会重复回源）。
> - 非法或越界 Range（含多区间 `bytes=0-1,5-6`、错误单位等）统一返回 `416` + `Content-Range: bytes */<total>`，**不会**静默退化为 `200`，避免客户端按完整长度解析出错。
> - 仅当 Telegram 未上报 `file_size`（无法计算 `Content-Range` / `Content-Length`）时，才退化为完整 `200` 直连传输，此时不返回 `Accept-Ranges`。
> - 缓存键由 Telegram `file_id` 经带命名空间的 SHA-256 派生为稳定 UUID，因此同一文件的多次直链访问（含跨 grant）复用同一份缓存。

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

`timeRange` 支持 `1h` / `24h` / `7d` / `30d`（默认 `7d`）。返回基于 `access_logs` 的 Bot 直链下载统计：

```json
{
  "timeRange": "7d",
  "downloads": 42,
  "uniqueUsers": 7,
  "totalBytes": "104857600",
  "trend": [{ "bucket": "2026-09-15 00:00:00", "downloads": 12, "bytes": "20971520" }]
}
```

`totalBytes` 为字符串（bigint 在 SQL 侧聚合，超出 `Number.MAX_SAFE_INTEGER` 亦不丢精度）。

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
