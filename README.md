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

- `GET /api/stats`：统计（当前为 TODO 占位返回）

## 5. 代码审查结论（截至 2026-04-24）

以下是针对当前 `work` 分支代码的快速审查结论：

### P0：当前分支不可直接通过构建/测试

- `go test ./...` 失败，存在依赖校验问题（`go.sum` 缺失必要记录）。
- 此外，从源码静态检查可见多个会导致编译失败的问题：
  - `internal/handler/auth.go` 中 `map]interface{}` 语法错误（应为 `map[string]interface{}`）。
  - `internal/handler/user.go` 使用 `model.UserResponse`/`model.RoleSuperAdmin` 但未导入 `internal/model`。
  - `internal/handler/auth.go` 与 `internal/handler/user.go` 调用了 `getClaimsFromContext`，但当前目录下未定义该函数（middleware 中存在 `GetClaimsFromContext`）。
  - `internal/service/auth.go` 和 `internal/service/user.go` 将 `*string` 直接赋值给 `sql.NullString` 字段（如 `IP` / `Target`），类型不匹配。

### P1：功能完成度与一致性问题

- `cmd/server/main.go` 中 `/api/stats` 仍为硬编码占位返回。
- `main.go` 中定义了 `type DB struct { *sqlx.DB }`，当前未被使用。
- 配置结构内 Telegram/Cache/Upload 等字段完整，但部分能力尚未在路由层体现。

### 建议修复顺序

1. 先修复所有编译错误与类型错误（保证 `go test ./...` 可运行）。
2. 为 handler/service 增加单元测试覆盖（鉴权、用户 CRUD、改密流程）。
3. 再补齐 `/api/stats` 的真实统计查询逻辑与权限测试。

## 6. 与 `main` 分支差异说明

当前仓库内 **不存在本地 `main` 分支**，也未配置远程仓库（`git remote -v` 为空），因此无法给出真实的 `work` vs `main` 代码差异。

### 当前 Git 状态（审查时）

- 当前分支：`work`
- 历史提交：仅 1 条初始提交（`Initial commit to beta branch`）
- 无 `main` 引用可供对比

### 一旦存在 `main` 后的对比命令

```bash
git fetch origin
git diff --stat main...work
git log --oneline --left-right main...work
```

如果你希望，我可以在后续拿到 `main`（本地或远程）后，补一份逐文件差异报告（含接口级变更清单）。
