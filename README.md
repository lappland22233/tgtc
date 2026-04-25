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


