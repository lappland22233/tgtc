# TG Imagebed Refactored（后端管理服务）

> 该仓库当前是一个基于 Go 的管理后端原型，包含认证、用户管理、RBAC 中间件、MySQL 仓储层以及简单管理前端页面（`admin/`）。

## 1. 项目概览

- **语言/运行时**：Go 1.21
- **核心依赖**：`net/http`、`github.com/golang-jwt/jwt/v5`、`github.com/go-sql-driver/mysql`、`github.com/jmoiron/sqlx`
- **主要能力**：
  - 账号登录与 JWT 刷新
  - 获取当前用户
  - 用户增删改查与改密
  - 角色鉴权（super_admin/admin/operator）
  - 管理日志与封禁仓储骨架

## 2. 目录结构

```text
cmd/server/main.go            # 服务入口与路由注册
internal/config               # 配置结构与加载
internal/handler              # HTTP 处理器（auth/user）
internal/service              # 业务层（auth/user）
internal/repository           # 数据访问层（users/admin_logs/bans）
internal/middleware           # 认证、RBAC、CORS
internal/model                # 领域模型与响应映射
migrations                    # 数据库初始化 SQL
admin                         # 管理后台静态页面
pkg/response                  # 统一 JSON 响应封装
```

## 3. 配置与启动

1. 复制配置模板并按实际环境修改：
   - `config.json.example` -> `config.json`
2. 初始化数据库：
   - 执行 `migrations/001_create_users_and_logs.sql`
3. 启动服务：

```bash
go run ./cmd/server
```

默认读取 `config.json`；也可通过 `CONFIG_PATH` 指定配置路径。

## 4. API 概要（当前路由）

### 公开接口

- `POST /api/auth/login`：登录
- `POST /api/auth/refresh`：刷新 token
- `GET /health`：健康检查

### 需登录

- `GET /api/auth/me`：当前用户
- `POST /api/auth/logout`：登出（当前为无状态提示）
- `POST /api/users/change-password`：修改当前用户密码

### 需 super_admin

- `GET /api/users`：用户分页
- `POST /api/users`：创建用户
- `PUT /api/users/update?id=<id>`：更新用户
- `DELETE /api/users/delete?id=<id>`：删除用户

### 需 admin 或 super_admin

- `GET /api/stats`：统计
- `POST /api/upload`：上传文件（multipart/form-data，字段 `file`）
- `GET /api/cache`：缓存统计
- `POST /api/cache/clean`：缓存清理（JSON 可选：`{"all": true}` 全量清理）
- `GET /api/admin/logs`：操作日志分页（支持 `user_id`、`action` 过滤）
- `GET /api/admin/bans`：封禁 IP 列表分页
- `POST /api/admin/bans`：封禁 IP（JSON: `ip`, `reason`）
- `DELETE /api/admin/bans?ip=<ip>`：解封 IP

## 5. 代码审查结论（截至 2026-04-24）

### 已修复的 P0 问题 ✅

1. ✅ `internal/handler/auth.go` 中 `map]interface{}` 语法错误 → 已修正为 `map[string]interface{}`
2. ✅ `internal/handler/user.go` 缺少 `internal/model` 包导入 → 已添加
3. ✅ `internal/handler/auth.go` 与 `internal/handler/user.go` 调用 `getClaimsFromContext` 未定义 → 已使用 `middleware.GetClaimsFromContext`
4. ✅ `internal/service/auth.go` 和 `internal/service/user.go` 中 `*string` 到 `sql.NullString` 类型不匹配 → 已修正

### 已修复的 P1 问题 ✅

5. ✅ `/api/stats` 硬编码占位返回 → 已实现真实统计逻辑（`StatsRepository`、`StatsService`、`StatsHandler`）
6. ✅ `main.go` 中未使用的 `DB` 结构体 → 已移除

### 后续建议

#### 一、功能完善类

| # | 建议 | 当前状态 |
|---|------|----------|
| 1 | 完善日志与封禁功能 | ✅ 已补齐 `AdminService`、`AdminHandler` 并开放日志/封禁管理 API |
| 2 | 文件上传 API | ✅ 已新增 `/api/upload`，支持大小与 MIME 白名单校验，并落盘到与 `cache.dir` 同级的独立目录（默认 `cache_uploads`） |
| 3 | 缓存管理 API | ✅ 已新增 `/api/cache`（统计）与 `/api/cache/clean`（清理，支持全量/过期） |
| 4 | 健康检查接口 | ✅ 已新增 `/health` 端点，返回服务状态与 UTC 时间 |
| 5 | 访问统计 | ✅ `TodayAccess` 已改为基于 `files.last_accessed_at` 的今日访问文件数统计（非硬编码） |

#### 二、工程质量类

| # | 建议 | 说明 |
|---|------|------|
| 6 | 单元测试覆盖 | 缺失鉴权、用户 CRUD、改密流程的单元测试 |
| 7 | 输入验证 | handler 层未发现系统化的参数校验逻辑 |
| 8 | API 文档 | 缺失 Swagger/OpenAPI 文档 |
| 9 | 数据库迁移 | 仅一个 migration 文件，建议引入 `golang-migrate` 工具 |
| 10 | 错误码体系 | 当前 `pkg/response` 仅返回通用错误，建议定义业务错误码 |

#### 三、生产环境类

| # | 建议 | 说明 |
|---|------|------|
| 11 | Rate Limiting | 无请求限流，防 DDoS 必需 |
| 12 | 配置热更新 | 修改配置需重启服务 |
| 13 | 容器化部署 | 缺失 Dockerfile/docker-compose |
| 14 | 环境变量配置 | 仅支持 `config.json`，生产环境常用环境变量覆盖 |
| 15 | Structured Logging | 可增加 request_id tracing |

#### 四、安全类

| # | 建议 | 说明 |
|---|------|------|
| 16 | 敏感信息日志脱敏 | 日志中可能打印密码/JWT secret |
| 17 | IP 白名单/黑名单 | 已有 `ban_repo` 骨架，可完善 |
| 18 | 密码强度策略 | `ChangePassword` 未见复杂度校验 |
| 19 | JWT 密钥轮换 | 当前无 refresh token 后的密钥更新机制 |

#### 五、优先级建议

**P0（生产必需）**：
- 单元测试覆盖
- 健康检查接口
- 输入验证

**P1（稳定运行）**：
- 日志与封禁功能完善
- 访问统计
- Rate Limiting

**P2（可延后）**：
- Telegram/Cache/Upload API
- 容器化
- Swagger 文档

---

## 6. 检测功能优化建议（2026-04-25）

> 以下优化建议按照**实施阶段**和**功能域**两个维度进行组织，便于分阶段落地执行。

---

### 第一阶段：安全防护加固（🔴 P0 - 立即处理）

> 本阶段聚焦安全漏洞修复，必须在生产环境部署前完成。

#### 6.1 访问控制层

| 序号 | 问题描述 | 风险等级 | 优化方案 | 涉及文件 |
|------|----------|----------|----------|----------|
| 1 | **Ban IP 中间件存在但未应用到路由** | 🔴 高 | 在 `main.go` 中注册 `middleware.BanIPMiddleware` 到公开路由组（`/api/auth/*`, `/health`） | `cmd/server/main.go` |
| 2 | **CORS 允许所有来源 (`*`)** | 🔴 高 | 生产环境配置具体的允许域名列表，禁用通配符；开发/测试环境可配置多域名 | `internal/middleware/cors.go` |
| 3 | 无 Rate Limiting（防 DDoS） | 🟡 中 | 基于 IP 实现令牌桶限流，公开接口（登录、注册）限制 10次/分钟，管理接口 100次/分钟 | `internal/middleware/ratelimit.go` |

#### 6.2 文件上传安全

| 序号 | 问题描述 | 风险等级 | 优化方案 | 涉及文件 |
|------|----------|----------|----------|----------|
| 4 | **仅检测文件头字节判断 MIME 类型** | 🔴 高 | 使用 `github.com/h2non/filetype` 进行深度文件类型检测，验证文件魔数与扩展名一致性 | `internal/service/upload.go` |
| 5 | 文件名未做安全处理 | 🟡 中 | 生成 UUID 作为存储文件名，原始文件名仅作为元数据；禁止路径分隔符和特殊字符 | `internal/service/upload.go` |
| 6 | 文件过大时先落盘再检测 | 🟡 中 | 小文件（<1MB）使用内存缓冲区预检，确认合法后再落盘；大文件使用流式读取前 8KB 检测 | `internal/handler/upload.go` |

---

### 第二阶段：输入验证体系（🟡 P1 - 近期处理）

> 本阶段建立系统化的参数校验机制，提升数据质量和接口健壮性。

#### 6.3 参数校验框架

| 序号 | 问题描述 | 风险等级 | 优化方案 | 涉及文件 |
|------|----------|----------|----------|----------|
| 7 | 无系统化参数校验框架 | 🟡 中 | 引入 `github.com/go-playground/validator/v10`，定义统一的请求结构体验证标签 | 所有 `handler` 文件 |
| 8 | 分页参数无边界限制 | 🟢 低 | `page` 最小值 1，`page_size` 范围 1-100，超出范围自动修正或返回错误 | `internal/handler/user.go`, `admin.go` |
| 9 | IP 地址仅验证格式 | 🟢 低 | 如需严格管控，集成 IP 地理位置库（如 `ip2region`）验证来源国家/地区 | `internal/service/admin.go` |

#### 6.4 认证凭证安全

| 序号 | 问题描述 | 风险等级 | 优化方案 | 涉及文件 |
|------|----------|----------|----------|----------|
| 10 | 刷新 Token 使用时间戳哈希，非真正随机 | 🟡 中 | 使用 `crypto/rand` 生成 32 字节随机数，Base64 编码作为 Refresh Token | `internal/service/auth.go` |
| 11 | 密码复杂度无强制校验 | 🟡 中 | 密码至少 8 位，必须包含大小写字母、数字、特殊字符中的至少 3 种 | `internal/service/user.go` |
| 12 | 用户名无格式限制 | 🟢 低 | 用户名 4-32 位，仅允许字母、数字、下划线，禁止纯数字 | `internal/service/user.go` |

---

### 第三阶段：内容合规检测（🟡 P1 - 近期处理）

> 本阶段针对文件上传场景，增加内容安全检测能力。

#### 6.5 内容安全检测

| 序号 | 问题描述 | 风险等级 | 优化方案 | 涉及文件 |
|------|----------|----------|----------|----------|
| 13 | 无敏感内容/NSFW 检测 | 🟡 中 | 集成腾讯云内容安全（IMS）或阿里云绿网 API，对图片进行涉黄、涉暴、涉政检测 | `internal/service/upload.go` |
| 14 | 无文件病毒扫描 | 🟢 低 | 集成 ClamAV（本地）或 Virustotal API（云端），对可执行文件和压缩包进行扫描 | `internal/service/upload.go` |

---

### 第四阶段：可观测性提升（🟢 P2 - 后续优化）

> 本阶段增强系统可观测性，便于问题排查和审计追踪。

#### 6.6 日志与追踪

| 序号 | 问题描述 | 风险等级 | 优化方案 | 涉及文件 |
|------|----------|----------|----------|----------|
| 15 | 无请求 Tracing ID | 🟢 低 | 在 `middleware` 中生成 `X-Request-ID`（UUID），注入 Context 并在所有日志中打印 | `internal/middleware/trace.go` |
| 16 | 敏感信息可能记录到日志 | 🟡 中 | 日志脱敏处理器：自动过滤 password、token、secret、authorization 等字段的值 | `pkg/logger/logger.go` |
| 17 | 角色变更无审计日志 | 🟢 低 | 用户角色变更时记录详细审计日志：操作人、被操作人、原角色、新角色、变更时间 | `internal/service/admin.go` |

---

### 第五阶段：工程化完善（🟢 P2 - 后续优化）

> 本阶段提升工程质量和运维能力。

#### 6.7 错误处理与配置

| 序号 | 问题描述 | 风险等级 | 优化方案 | 涉及文件 |
|------|----------|----------|----------|----------|
| 18 | 部分错误返回原始数据库错误 | 🟡 中 | 定义业务错误码体系（如 `ErrUserNotFound = 1001`），对外隐藏数据库细节 | `pkg/response/error.go` |
| 19 | JWT Secret 存储在配置文件中 | 🟡 中 | 生产环境优先从环境变量 `JWT_SECRET` 读取，其次才是配置文件 | `internal/config/config.go` |
| 20 | Token 过期时间硬编码 | 🟢 低 | 将 `jwt_ttl`、`refresh_ttl` 提取到配置，支持环境差异化（开发 24h，生产 2h） | `internal/config/config.go` |
| 21 | 数据库连接池配置固定 | 🟢 低 | 将 `max_open_conns`、`max_idle_conns`、`conn_max_lifetime` 提取到配置 | `internal/repository/db.go` |

#### 6.8 部署与运维

| 序号 | 问题描述 | 风险等级 | 优化方案 | 涉及文件 |
|------|----------|----------|----------|----------|
| 22 | 缺少 Dockerfile/docker-compose | 🟢 低 | 提供多阶段构建 Dockerfile 和 docker-compose.yml，包含 MySQL、Redis 依赖 | 根目录 |
| 23 | 配置不支持热更新 | 🟢 低 | 使用 `fsnotify` 监听配置文件变更，或集成 Apollo/Nacos 配置中心 | `internal/config/watcher.go` |
| 24 | 缓存清理无进度反馈 | 🟢 低 | 大文件缓存清理改为异步任务，提供 `GET /api/cache/clean/status` 查询进度 | `internal/handler/cache.go` |

---

## 7. 优化实施路线图

### 实施顺序建议

```
第 1 周：安全防护加固（P0）
├── [高] 启用 Ban IP 中间件
├── [高] 限制 CORS 来源
├── [高] 文件真实内容检测
└── [中] 文件名安全处理

第 2-3 周：输入验证体系（P1）
├── [中] 引入 validator 校验框架
├── [中] 密码复杂度校验
├── [中] 刷新 Token 随机化
└── [低] 分页参数边界限制

第 4-5 周：内容合规检测（P1）
├── [中] 集成 NSFW 内容审核 API
└── [低] 文件病毒扫描（可选）

第 6-8 周：可观测性 + 工程化（P2）
├── [低] 请求 Tracing ID
├── [中] 日志脱敏
├── [中] 业务错误码体系
└── [低] Dockerfile / 配置热更新
```

### 依赖关系图

```
安全防护加固（P0）
       │
       ▼
输入验证体系（P1） ──► 内容合规检测（P1）
       │
       ▼
可观测性提升（P2） ──► 工程化完善（P2）
```

---

## 8. 快速修复清单（Copy & Check）

### 🔴 本周必须完成

- [ ] `main.go` 中注册 `BanIPMiddleware` 到路由
- [ ] `cors.go` 中配置具体允许域名，移除 `*`
- [ ] `upload.go` 中集成 `filetype` 库进行深度文件检测

### 🟡 本月计划完成

- [ ] 引入 `go-playground/validator` 框架
- [ ] 实现密码复杂度校验（8位+3种字符类型）
- [ ] 实现基于 IP 的 Rate Limiting
- [ ] 集成内容安全审核 API

### 🟢 后续迭代完成

- [ ] 添加 `X-Request-ID` Tracing
- [ ] 实现日志脱敏处理器
- [ ] 定义业务错误码体系
- [ ] 提供 Dockerfile 和 docker-compose







