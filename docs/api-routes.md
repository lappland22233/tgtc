# API 路由概览

> 本文档由原 README 拆分而来。程序化调用（API Key 获取、认证方式、文件/文件夹/分享接口与三种下载链接模式）见 [API.md](../API.md)。总索引见 [README](../README.md)。

---

> 程序化调用的完整说明（密钥获取、认证方式、全部文件/文件夹/分享接口及三种下载链接模式）见 **[API 调用文档](../API.md)**。

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


