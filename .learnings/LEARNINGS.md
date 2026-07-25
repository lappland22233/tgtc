# Learnings

Corrections, insights, and knowledge gaps captured during development.

**Categories**: correction | insight | knowledge_gap | best_practice

---

## [LRN-20260724-001] best_practice

**Logged**: 2026-07-24T22:59:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
流式双写必须用首块时序和失败清理竞态测试验证，不能只检查最终缓存。

### Details
未缓存下载的上游流启动后，任何后续数据库 await 都会让首块滞留在 PassThrough；WriteStream 在 open 尚未完成时发生上游错误，直接 unlink 还可能被迟到的 open 重新创建为 0 字节 `.tmp`。

### Suggested Action
回源前完成必要数据库操作；回源返回后立即让 Controller 订阅；失败时等待 WriteStream `close` 后再 unlink。测试需断言首块早于源流结束及原子发布、客户端断开仍完成缓存、错误不遗留 `.tmp`。

### Metadata
- Source: error
- Related Files: backend/src/file/file.service.ts, backend/src/file/file-cache.service.ts, backend/src/file/file-cache.service.spec.ts
- Tags: streaming, cache, race-condition, pass-through
- Pattern-Key: harden.streaming_cache_timing
- Recurrence-Count: 1
- First-Seen: 2026-07-24
- Last-Seen: 2026-07-24

### Resolution
- **Resolved**: 2026-07-24T22:59:00+08:00
- **Notes**: 调整回源时序和失败清理，并新增 4 组回归测试。

---

## [LRN-20260724-002] best_practice

**Logged**: 2026-07-24T23:18:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
未完成缓存的重试下载应复用单一回源，并从已落盘临时文件独立跟随增长。

### Details
直接广播上游块会让晚加入者丢失历史数据；等待 inflight 完成则导致重试长期无首字节。可靠做法是为每个文件保存构建会话，让跟随者按独立 offset 读取 `.tmp`，通过进度版本和事件避免检查/订阅竞态，完成后切换正式路径，失败向所有活跃读取者传播。

### Suggested Action
缓存会话必须隔离客户端取消、保留单一回源、保护活动 tmp 不受定时清理，并测试晚加入、首客户端中断、跟随者中断、失败广播和原子发布时序。

### Metadata
- Source: error
- Related Files: backend/src/file/file-cache.service.ts, backend/src/file/file-cache.service.spec.ts
- Tags: streaming, retry, growing-file, concurrency
- Pattern-Key: harden.streaming_cache_retry
- Recurrence-Count: 1
- First-Seen: 2026-07-24
- Last-Seen: 2026-07-24

### Resolution
- **Resolved**: 2026-07-24T23:18:00+08:00
- **Notes**: 实现增长临时缓存跟随流，定向测试和构建通过。

---
