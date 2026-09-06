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
- [限制与安全须知](#限制与安全须知)

---

## 获取密钥

使用任意已登录账号（所有角色均可）在 **网页端 → 个人设置 → API 密钥** 中创建；或先通过账号登录获取 JWT Cookie 后调用管理接口（见[密钥管理](#密钥管理)）。

明文密钥格式为 `tgtc_<随机段>`，**仅在创建/轮换的响应中出现一次**，关闭弹窗后无法再次查看，请立即妥善保存。此后只能凭前缀（如 `tgtc_a1b2c3d4`）在列表中识别密钥。

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

## 限制与安全须知

- **数量上限**：每个账号最多同时持有 20 个有效密钥，超出需先撤销。
- **失效条件**：撤销立即生效；关联账号被封禁后密钥立即失效；账号修改密码后，**早于密码变更时间创建的所有密钥失效**，需重新创建。
- **能力边界**：密钥不能访问其他账号的任何资源（即使关联账号是管理员）；不能管理用户、系统配置等管理员接口；不能创建或撤销其他密钥；独立标签管理接口（`/api/tags/*`）暂不支持密钥认证。
- **存储安全**：密钥等同账号文件操作凭证，请勿提交到代码仓库、日志或公开场所；怀疑泄露时立即在设置页撤销，或修改账号密码使全部旧密钥失效。
- **频率限制**：下载、搜索、分享访问等端点沿用系统安全配置中的限流规则，超限返回 `429`。
- **审计**：密钥的创建、撤销与文件操作均进入审计日志，日志中只出现密钥前缀，不出现明文。
