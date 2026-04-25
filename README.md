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

### 6.1 认证授权检测

| 问题 | 风险等级 | 优化建议 |
|------|----------|----------|
| 刷新 Token 使用 `fmt.Sprintf("%d", time.Now().UnixNano())` 生成哈希，非真正随机 | 🟡 中 | 使用 `crypto/rand` 生成随机字节，或使用 UUID 库生成唯一标识符 |
| Token 过期时间硬编码为 24 小时 | 🟢 低 | 将 JWT 过期时间、刷新 Token 有效期提取到配置文件中，支持环境差异化配置 |
| 缺少 Token 黑名单机制 | 🟡 中 | 登出时将 Token 加入 Redis 黑名单，设置与 Token 过期时间一致的 TTL |

### 6.2 输入验证检测

| 问题 | 风险等级 | 优化建议 |
|------|----------|----------|
| 无系统化参数校验框架 | 🟡 中 | 引入 `go-playground/validator` 或 `ozzo-validation`，在 handler 层统一校验请求参数 |
| 用户名/密码复杂度无强制校验 | 🟡 中 | 密码至少 8 位，包含大小写字母、数字、特殊字符；用户名限制长度和字符集 |
| 分页参数 `page` 和 `page_size` 允许任意值 | 🟢 低 | 限制 `page_size` 最大值（如 100），`page` 最小值为 1 |
| IP 地址验证仅检查格式，不验证归属 | 🟢 低 | 如需更严格的安全控制，可集成 IP 地理位置库验证来源 |

### 6.3 安全检测

| 问题 | 风险等级 | 优化建议 |
|------|----------|----------|
| **Ban IP 中间件存在但未应用到路由** | 🔴 高 | 在 `main.go` 中注册 `middleware.BanIPMiddleware` 到需要保护的路由组 |
| **CORS 允许所有来源 (`*`)** | 🔴 高 | 生产环境配置具体的允许域名列表，禁用通配符 |
| 无 Rate Limiting（防 DDoS） | 🟡 中 | 基于 IP 或用户 ID 实现令牌桶/漏桶限流，使用 `golang.org/x/time/rate` 或 Redis 分布式限流 |
| 无 XSS 防护 | 🟡 中 | 对输出到前端的数据进行 HTML 转义，使用 `html/template` 或专门的 XSS 防护库 |
| 无请求 Tracing ID | 🟢 低 | 在 middleware 中生成 `X-Request-ID`，注入到 Context 并在日志中打印，便于问题追踪 |
| 敏感信息可能记录到日志 | 🟡 中 | 日志脱敏处理，过滤密码、JWT Token、身份证号等敏感字段 |

### 6.4 文件上传检测

| 问题 | 风险等级 | 优化建议 |
|------|----------|----------|
| **仅检测文件头字节判断 MIME 类型，非真实内容检测** | 🔴 高 | 使用 `github.com/h2non/filetype` 或 `github.com/gabriel-vasile/mimetype` 进行深度文件类型检测，防止伪造扩展名攻击 |
| **无敏感内容/NSFW 检测** | 🟡 中 | 集成图片内容审核服务（如腾讯云内容安全、阿里云绿网）或本地 NSFW 模型检测 |
| 文件过大时 `io.LimitReader` 仍会写入磁盘后再删除 | 🟡 中 | 优先使用内存缓冲区检测文件头，确认合法后再落盘；大文件使用流式处理 |
| 无文件病毒扫描 | 🟢 低 | 集成 ClamAV 或云杀毒服务对上传文件进行病毒扫描 |
| 文件名未做安全处理 | 🟡 中 | 生成随机文件名存储，原始文件名仅作为元数据记录，防止路径遍历攻击 |

### 6.5 业务逻辑检测

| 问题 | 风险等级 | 优化建议 |
|------|----------|----------|
| 创建用户时未检查用户名唯一性（依赖数据库唯一索引报错） | 🟢 低 | 在 service 层主动查询用户名是否存在，返回友好的错误提示 |
| 删除用户前未检查关联数据 | 🟢 低 | 删除用户前检查是否有未完成的操作或关联资源，或采用软删除策略 |
| 角色变更无审计日志 | 🟢 低 | 记录角色变更操作到 admin_logs，包含操作人、被操作人、原角色、新角色 |

### 6.6 性能与错误处理

| 问题 | 风险等级 | 优化建议 |
|------|----------|----------|
| 数据库连接池配置固定，无动态调整 | 🟢 低 | 将连接池参数（max_open_conns, max_idle_conns, conn_max_lifetime）提取到配置 |
| 部分错误返回原始数据库错误信息 | 🟡 中 | 统一错误处理，对外隐藏数据库细节，返回标准错误码和友好提示 |
| 缓存清理操作无进度反馈 | 🟢 低 | 大文件缓存清理改为异步任务，提供进度查询接口 |

### 6.7 配置与部署

| 问题 | 风险等级 | 优化建议 |
|------|----------|----------|
| JWT Secret 存储在配置文件中 | 🟡 中 | 生产环境使用环境变量或密钥管理服务（KMS）注入 JWT Secret |
| 配置不支持热更新 | 🟢 低 | 使用 `fsnotify` 监听配置文件变更，或集成配置中心（如 Apollo、Nacos） |
| 缺少 Dockerfile/docker-compose | 🟢 低 | 提供容器化部署方案，便于 CI/CD 集成 |

---

## 7. 优化实施优先级

### 🔴 P0 - 立即处理（安全风险）
1. **启用 Ban IP 中间件** - 当前代码已存在但未应用到路由
2. **限制 CORS 来源** - 生产环境禁用通配符
3. **文件真实内容检测** - 防止伪造文件头攻击

### 🟡 P1 - 近期处理（功能完善）
4. 引入系统化参数校验框架
5. 实现 Rate Limiting
6. 添加敏感内容/NSFW 检测
7. 密码复杂度强制校验

### 🟢 P2 - 后续优化（体验提升）
8. 请求 Tracing ID
9. 日志脱敏
10. 容器化部署
11. 配置热更新




