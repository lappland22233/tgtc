# 核心能力

> 本文档由原 README 拆分而来；文中路径均相对仓库根。下载与缓存的调度细节见 [download-and-cache.md](download-and-cache.md)，Telegram 集成见 [telegram.md](telegram.md)，配置项见 [configuration.md](configuration.md)。总索引见 [README](../README.md)。

---

## 用户与权限

- 邮箱注册、登录、验证码验证和密码重置
- JWT 身份认证，令牌存储于 HttpOnly Cookie
- `super_admin`、`admin`、`user` 三级角色权限
- 登录、验证码、文件密码和分享密码的频率限制与临时封禁
- 第一个成功注册的账号自动成为 `super_admin`
- API 密钥（`X-API-Key`）：所有用户可创建，程序化执行全部文件与文件夹操作，密钥只能管理关联账号资源，详见 [API 调用文档](API.md)


## 文件与文件夹

- 闭包表（closure-table）文件夹树，支持创建、重命名、移动、软删除和恢复
- 文件卡片/列表双视图、搜索、排序、无限滚动和文件夹过滤
- 用户隔离的标签 CRUD 与多标签 AND 筛选
- 文件重命名、移动、轻量复制、批量 Markdown 链接生成
- 同步上传、Bull 异步上传、分片上传和断点状态查询
- 文件类型黑名单/白名单与动态上传大小限制
- 7 天删除冷静期，支持恢复和永久删除
- 图片缩略图及 RSA-OAEP 短时访问令牌


## 分享

- 独立 `ShareLink` 模型，同一文件或文件夹可创建多条分享链接
- SPA 分享页 `/s/:token`，支持文件信息卡片和文件夹层级浏览
- 可设置密码、有效期和最大访问次数
- 严格密码模式：验证成功前不返回目标文件或文件夹元数据
- 文件夹分享支持子目录、面包屑和单文件下载
- 我的分享列表支持筛选、复制链接、修改和取消
- 旧入口 `/files/public/:id` 兼容重定向至分享页


## 管理与可观测性

- 全站统计、自定义仪表盘、用户管理和全站文件管理
- 管理员“文件管理”使用独立的 `GET /api/admin/files` 全量查询；“我的文件”使用 `GET /api/files`，两者相互隔离
- SMTP、上传、认证、缓存和安全规则配置
- 永久/临时 IP 封禁、攻击检测、行为异常检测和 WebSocket 告警
- HTTP 访问日志、带宽与延迟分析、来源/UA 分析、用户活跃度和文件类型统计
- 操作审计与 CSV/JSON 数据导出



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


