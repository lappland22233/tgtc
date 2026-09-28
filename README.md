# 文件分发系统

基于 NestJS、Vue 3、TypeORM、Redis 与 Telegram Bot API 的文件分发与网盘系统。元数据数据库默认使用 PostgreSQL，也正式支持显式 opt-in 的 SQLite 单机部署。系统提供层级文件夹、标签、同步/异步/分片上传、私有与公开访问、独立分享链接、管理员审计、安全监控和访问分析。

文件本体存放在 Telegram：上传与下载全部由后端代理，浏览器始终接触不到 Bot Token 与原始文件地址；仓库同时包含一个二次开发的 Telegram Bot API C++ fork（`telegram-bot-api/`）。

## 核心能力

- **用户与权限**：邮箱注册、验证码与密码重置；JWT（HttpOnly Cookie）；`super_admin` / `admin` / `user` 三级角色；频率限制与临时封禁；API 密钥（`X-API-Key`）只能管理关联账号资源
- **文件与文件夹**：闭包表文件夹树（创建 / 重命名 / 移动 / 软删除 / 恢复）；标签与多标签 AND 筛选；卡片与列表双视图、搜索与无限滚动；同步 / 异步 / 分片上传；类型白黑名单与动态大小限制；7 天删除冷静期；图片缩略图
- **下载与缓存**：后端代理下载；本地缓存上限 / 最低剩余空间 / TTL 可在后台热更新；冷文件经实时流端点边下载边构建缓存，同一文件全局只有一个上游回源；单区间 Range 与断点续传；磁盘配额与排队，以及可观测排队的「两阶段下载任务」
- **分享**：独立 `ShareLink` 模型，同一文件或文件夹可有多条分享；密码 / 有效期 / 最大访问次数；严格密码模式；SPA 分享页 `/s/:token` 支持文件夹层级浏览
- **Telegram Bot 文件直链**：在 Bot 私聊发送 `document` 换取带有效期的匿名直链；按日限额与白名单；复用站内同一套缓存 / Range 链路
- **账号池与副本扩散**：多 Bot 账号加权选号回源；主群锚点 + 用户账号服务端转发（字节二次传输恒为 0）；镜像任务持久化、幂等、可重试
- **管理与可观测性**：全站统计与自定义仪表盘；用户与全站文件管理；IP 封禁、攻击检测与 WebSocket 告警；访问日志、带宽 / 来源 UA / 活跃度分析；操作审计与 CSV / JSON 导出

## 技术栈

| 层级 | 技术 |
|---|---|
| 后端 | NestJS 11、TypeScript、TypeORM 0.3 |
| 前端 | Vue 3.5、TypeScript、Vite 6、TDesign Vue Next |
| 数据库 | PostgreSQL 14+（默认）/ SQLite 3（单机显式 opt-in） |
| 队列 | Bull 4、Redis |
| 文件存储 | Telegram Bot API / 二次开发本地 Bot API |
| 认证 | Passport JWT、bcryptjs、HttpOnly Cookie |
| 邮件 | Nodemailer、SMTP |
| 实时通信 | Socket.IO |
| 图表 | ECharts 6 |
| 图片处理 | sharp |
| 状态与路由 | Pinia、Vue Router 4 |

> `frontend` 依赖 `grid-layout-plus`，当前仪表盘主要使用原生 CSS Grid 布局。

> **最低配置**：2 核 CPU、4 GB 内存；磁盘可用空间 ≥ 最大并发数 × 4 GiB × 2（默认并发 8 时约 64 GiB）。详见 [docs/deployment.md](docs/deployment.md) 的环境要求。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/features.md](docs/features.md) | 核心能力详解：用户与权限、文件与文件夹、分享、管理与可观测性、上传模式 |
| [docs/configuration.md](docs/configuration.md) | 环境变量与配置全表：数据库（含 SQLite 运维边界）、应用与认证、SMTP、Redis、Telegram、Bot 账号池、镜像备份、副本扩散 |
| [docs/download-and-cache.md](docs/download-and-cache.md) | 下载与缓存：磁盘配额与排队、回源权重预算与内存治理、下载超时分层、磁盘占用与清理、Bot 直链断点续传、反向代理要求 |
| [docs/telegram.md](docs/telegram.md) | Telegram 集成：Bot 文件直链、文件引用完整性、workdir 持久性、僵尸上传恢复、管理后台文件体检 |
| [docs/deployment.md](docs/deployment.md) | 部署与运维：环境要求、快速开始、Linux x64 预编译发行版、发行包升级与回退、手工生产部署、部署注意事项 |
| [docs/api-routes.md](docs/api-routes.md) | API 路由概览（公开接口 / 登录用户接口 / 管理员接口） |
| [docs/API.md](docs/API.md) | API Key 编程调用说明：认证、文件 / 文件夹 / 分享接口与三种下载链接模式 |
| [docs/development.md](docs/development.md) | 项目结构与后端 / 前端常用命令 |
| [docs/security.md](docs/security.md) | 安全说明 |
| [frontend/STYLE_GUIDE.md](frontend/STYLE_GUIDE.md) | 前端样式唯一规范（Seed Token、双主题、禁用项清单） |


## 许可证

GNU General Public License v3.0
