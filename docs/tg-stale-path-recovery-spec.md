# Telegram 本地路径失效降级与垃圾数据治理 — Feature Spec

状态：approved-by-plan（作为 `telegram-stale-path-fallback-cleanup` 计划的验收依据）
日期：2026-08-15
负责人：backend（TelegramService / FileService / Admin）、frontend（Files.vue）

---

## 1. Problem Statement

Telegram Bot API 自托管实例的工作目录从 `/data/cb/...` 迁移到 `/root/cb/...` 后，数据库 `files` 表中约 6223 条 `status='ready'` 记录的 `telegramFilePath` 仍是旧绝对路径，而旧目录已不存在。当用户访问这些文件时，Bot API 的 `--enable-file-streaming` 端点回源失败，返回 `{"ok":false,"error_code":502,"description":"Exact file size is unavailable from Telegram"}`，后端 `TelegramService.getRealtimeFileStream` 将 502 直接透传，用户在下载、预览、公开媒体和分享链路上看到 HTTP 502。

后果：
- 24 小时内约 20+ 次 502，集中在少数被真实访问的旧文件；
- 全部 6223 条旧路径记录是"潜在地雷"，任何访问都会失败；
- 当前代码缺少"从 Telegram 重新拉取并更新路径"的恢复能力，也缺少批量清理失效路径的管理入口。

## 2. Goals

1. 对可恢复文件（file_id 仍有效）首次访问时自动从 Telegram 重新拉取，成功后写入有效 `telegramFilePath`，用户无感知地获得文件，不再收到 502。
2. 对不可恢复文件（file_id 永久失效）安全标记为 `status='error'`、清空 `telegramFilePath`，所有读取入口稳定返回 HTTP 410 而非 502。
3. 提供仅 SUPER_ADMIN 可用的存量治理动作：dry-run 统计 + apply 幂等清空旧 `/data/cb/tgtc-beta/...` 路径，不触碰正确路径。
4. 恢复逻辑覆盖全部文件读取入口：下载、预览、公开媒体、分享下载/预览、普通/高清缩略图。
5. 普通瞬时 Telegram 故障（超时、429、普通 5xx）不修改数据库状态，不被误判为永久失效。

## 3. Non-Goals

- 不做 `/data/cb` → `/root/cb` 的前缀替换（会制造新的假路径）。
- 不批量下载 6223 个文件来修复路径（不做全量体检回源）。
- 不删除数据库记录，也不删除 Telegram 远端对象（多条 File 记录可能共享同一 `telegramFileId`）。
- 不自动软删除/永久删除失效文件（由管理员通过既有删除流程处理）。
- 不改变现有 `verifyFileExists(metadata_only=true)` 的文件体检语义。
- 不改动 Telegram Bot API C++ 源码。

## 4. User Stories

- 作为普通用户，当分享/访问的文件本地路径已失效但 Telegram 仍持有该文件时，我希望首次点击下载/预览自动成功，而不是看到 502。
- 作为普通用户，当文件在 Telegram 中永久不存在时，我希望看到明确的"文件不可用"提示（410），而不是含糊的网关错误。
- 作为管理员，我希望在清理旧路径前先 dry-run 查看影响数量，再决定 apply，避免误操作。
- 作为管理员，我希望批量清理只清空旧根目录下的路径，正确路径和空路径不受影响。
- 作为运维，我希望审计日志只记录模式和数量，不泄露 Bot Token、完整绝对路径或文件信息。

## 5. Requirements

### Must-Have (P0)

**R1 — 特定 502 分类**
`TelegramService.telegramRequest` 对 HTTP 502 且描述含 "Exact file size is unavailable from Telegram"（脱敏匹配）判定为"路径失效型 502"，抛出新增类型化错误（如 `TelegramStreamPathError`），区别于普通 5xx/超时/429。

**R2 — 单次强制回源**
`getRealtimeFileStream` 首次流式请求失败且为 R1 类型时，执行**一次**非 `metadata_only` 的 `getFile`（触发 Bot API 实际下载），成功后返回新 `file_path`：
- 回源成功且 `file_path` 非空 → 以新路径安全打开本地流返回（内部经 `getFileStream` 风格再取一次 `getFileInfo`，总计数为「streaming 1 + getFile 2 + 本地打开」）；
- 回源成功但 `file_path` 为空 → 再尝试 streaming 一次；
- 回源明确返回 Telegram 永久不存在（`TelegramFileNotFoundError`）→ 包装为"恢复失败，判定永久不可用"；回源遇到瞬时错误（超时/429/普通 5xx）→ **保持原错误类型抛出，不转永久**。
禁止递归/无限重试。

**R3 — 安全打开本地路径**
本地绝对路径在 `createReadStream` 前先 `fs.promises.open`/存在性检查，ENOENT 同步转为 R1 类型的可恢复错误，避免延迟 `stream error` 越过恢复边界。

**R4 — 条件回写路径**
`FileService` 在恢复成功后，仅当 `id`、`status='ready'`、`uploadVersion` 匹配时更新 `telegramFilePath`，防止覆盖并发上传/替换结果。

**R5 — 永久失败转 410**
恢复仍失败（Telegram 永久不存在）时，按 R4 并发守卫更新 `status='error'`、`uploadStage='failed'`、清空 `telegramFilePath`，写入固定脱敏原因；失效缓存；已 `error` 的文件在所有读取入口抛 `GoneException`（HTTP 410）。

**R6 — 全入口覆盖**
`getDownloadStream` 统一承载下载/预览/公开媒体/分享主文件流；`getThumbnailStream`/`getHdThumbnailStream`/分享缩略图复用同一 Telegram 恢复能力；不复制恢复逻辑到控制器。

**R7 — 存量清理接口**
`POST /admin/files/stale-paths/cleanup`（SUPER_ADMIN），DTO：`mode: 'dry-run'|'apply'`（服务端固定前缀，不接受任意 SQL 模式）。dry-run 返回命中数；apply 条件更新 `telegramFilePath=NULL`，条件 `isDeleted=false AND telegramFilePath LIKE '/data/cb/tgtc-beta/%'`。幂等、可审计。

**R8 — 前端治理入口**
`Files.vue` 增加旧路径清理按钮：先 dry-run 展示统计，确认后 apply，结果反馈，防重复提交。

### Should-Have (P1)

**R9 — 进程内恢复去重**
按 `telegramFileId` 短期合并恢复 Promise，避免共享 file_id 的复制记录并发重复回源；完成后立即释放。

**R10 — 410 前端映射**
前端 `error.ts` 将 410 映射为明确的"文件已不可用"文案，其余错误行为不变。

### Future (P2)

- 支持更多旧根目录前缀的配置化扩展。
- 将清理结果纳入管理后台统计/导出。

## 6. Acceptance Criteria

### 恢复分类
- [ ] 指定失效文件首次访问**不再**透传 502；可恢复文件重新拉取后成功返回，且数据库 `telegramFilePath` 被更新为有效新路径。
- [ ] 仅 `Exact file size is unavailable from Telegram` 型 502 触发恢复；普通 502、超时、429 **不**修改数据库状态。
- [ ] 恢复最多执行一次（无递归/无限重试）；失败不落入死循环。

### 永久失败语义
- [ ] 无法恢复文件被安全标记 `error`、`uploadStage='failed'`、`telegramFilePath=NULL`，`uploadFailureReason` 为固定脱敏文本。
- [ ] 已 `error` 文件在下载、预览、`/media`、分享下载/预览、普通/高清缩略图入口**均**返回 HTTP 410。
- [ ] 并发上传/覆盖期间，旧恢复结果不能覆盖新版本（uploadVersion 守卫生效）。

### 存量治理
- [ ] dry-run 正确统计旧路径数量，不修改任何记录。
- [ ] apply 只清空 `/data/cb/tgtc-beta/...`，不触碰 `/root/cb/...`、空路径或其他记录，不改变文件 `status`。
- [ ] 重复 apply 无副作用（第二次命中数为 0）。
- [ ] 审计仅记录模式、命中数、修改数，无 Token/绝对路径/上游响应。

### 质量门禁
- [ ] 后端相关 Jest 套件通过；前端 Vitest 通过；两端 `tsc --noEmit` 通过；`npm run build` 通过。

## 7. Success Metrics

| 指标 | 目标 |
|---|---|
| 旧文件访问 502 率 | 首次访问自动恢复后趋近 0 |
| 恢复成功写入有效路径 | 被访问的旧文件 24h 内路径全部为有效新路径 |
| 无法恢复文件误标 error | 仅确认永久失效的文件被标记（普通 5xx/超时 0 误标） |
| 存量旧路径记录数 | apply 后旧 `/data/cb` 前缀记录降至 0 |
| 410 语义覆盖入口 | 全读取入口稳定返回 410 而非 502 |

## 8. Open Questions

- (blocking, none) 已通过计划确认口径：无法恢复→标记 error 保留；存量→仅清空路径；范围→全部入口。
- (non-blocking) 是否需要在 410 响应体附带 `code` 字段供前端精细判断 — 实现时按 `GoneException('文件已不可用')` 标准形式，前端按状态码 410 映射即可。
- (non-blocking) 旧路径前缀是否要支持配置化 — 本版固定为 `/data/cb/tgtc-beta/`，不做配置化（防止误配造成大面积清空）。

## 9. Timeline Considerations

- 本功能无外部硬期限，随 `beta` 分支下一次发布上线。
- 建议部署顺序：后端代码 → 前端代码 → 生产先 dry-run 核对统计 → apply。
- 依赖：无其他团队；需 PostgreSQL/Redis 环境执行既有迁移（本功能不新增迁移）。
