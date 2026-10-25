# 开发与项目结构

> 本文档由原 README 拆分而来；文中路径均相对仓库根，省略前缀的源码路径（如 `file/file-cache.service.ts`、`telegram-mirror/*`）相对 `backend/src/`。总索引见 [README](../README.md)。

---

## 项目结构

```text
backend/src/
├── auth/             认证、验证码和密码重置
├── user/             用户资料、统计和管理员用户管理
├── file/             文件、异步/分片上传、下载、缓存和缩略图
├── folder/           闭包表文件夹树与文件移动/复制
├── share/            独立分享链接与公开分享访问
├── tag/              用户标签和文件关联
├── admin/            全站管理、分析、配置和日志查询
├── alert/            告警规则、持久化与 WebSocket 推送
├── jobs/             六个 Bull 队列及处理器
├── security/         行为异常检测

├── telegram/         Telegram 上传、下载和实时流客户端
├── mailer/           SMTP 邮件服务
├── tasks/            定时清理任务
├── common/           17 个实体、守卫、拦截器、过滤器和公共服务
├── database/         TypeORM CLI DataSource
└── migrations/       28 个迁移文件

frontend/src/
├── views/auth/       登录与注册
├── views/user/       仪表盘、我的文件、我的分享和设置
├── views/share/      公开分享页
├── views/admin/      已注册的管理员页面
├── components/       文件、文件夹、分享、上传与导航组件
├── composables/      自动刷新、分页、移动端和分片上传逻辑
├── stores/           Pinia 认证、文件、文件夹和标签状态
├── api/              Axios 客户端与管理员文件专用 API
├── router/           公开、登录、用户和管理员路由守卫
├── types/            TypeScript 类型
└── utils/            格式化、缩略图和权限工具
```

当前后端注册 17 个 TypeORM 实体，`app.module.ts` 与 `database/data-source.ts` 的实体列表必须保持同步。


## 常用命令

提交前分别在 `backend`、`frontend` 执行 `npm ci` 和 `npm run check:ci`。GitHub Actions 调用相同的 `check:ci` 脚本，检查依赖树、生产依赖审计（high/critical 阻断）、类型、构建及覆盖率；后端还执行 SQLite 和真实 Redis 队列门禁，前端还执行产物体积门禁。后端需先启动测试用 Redis（默认 127.0.0.1:6379，数据库 15；可用 REDIS_HOST、REDIS_PORT、REDIS_PASSWORD、REDIS_TEST_DB 覆盖），测试仅操作本次生成的唯一队列，不清空 Redis 数据库。不要只用 `npm test` 代替该命令，也不要用 `npm audit fix --force` 绕过兼容性验证。

覆盖率下限（语句/分支/函数/行）：后端为 60%/45%/55%/60%，前端为 40%/70%/50%/40%。后端在原先四项 30% 基础上提高要求，前端从仅报告覆盖率改为阻断退化。

PostgreSQL 专项需要独立测试服务：设置 `DB_TYPE=postgres` 及 `DB_HOST`、`DB_PORT`、`DB_USERNAME`、`DB_PASSWORD`、`DB_DATABASE`，执行 `npm run migration:run`、检查无待执行迁移、再次执行确认幂等，然后执行 `npm run test:integration:pg`。测试账号需要创建/删除隔离测试数据库的权限；业务回归本身只写入按次创建的隔离库。该命令同时执行 SQLite 与 PostgreSQL 的安全审查回归，不能用跳过 PG 的普通测试运行替代。

原生和发行检查仍是独立 CI 作业：`scripts/release/tests/*.test.sh`、ShellCheck、CMake/CTest 和 Linux ZIP 构建验签。前后端质量检查通过不代表这些平台相关作业已执行。覆盖率报告输出到各组件的 `coverage/`，CI 保留报告供评审。

### 后端

```bash
cd backend
npm run start:dev
npm run typecheck
npm run build
npm test
npm run test:cov
npm run migration:create
npm run migration:generate
npm run migration:run             # 环境驱动，未设置 DB_TYPE 时为 PostgreSQL
npm run migration:run:postgres    # 显式 PostgreSQL（外部 DB 路径）
npm run migration:run:sqlite      # 显式 SQLite
npm run migration:revert
npm run migration:revert:postgres
npm run migration:revert:sqlite
npm run gate:sqlite               # SQLite 迁移 + 真实文件集成发布门禁
npm run start:prod
```

`migration:generate` 默认生成到 `src/migrations/Migration.ts`，生成后应使用时间戳和语义化名称重命名；也可以直接调用 TypeORM CLI 指定目标文件名。迁移加载 glob 只匹配以数字时间戳开头的文件（`[0-9]*.ts`），未重命名或含 `.spec.`/`.test.` 的测试文件不会进入迁移集合。

### 前端

```bash
cd frontend
npm run dev
npm run typecheck
npm run build
npm run preview
```


