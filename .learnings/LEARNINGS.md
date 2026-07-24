# Learnings

Corrections, insights, and knowledge gaps captured during development.

**Categories**: correction | insight | knowledge_gap | best_practice

---

## [LRN-20260724-001] best_practice

**Logged**: 2026-07-24T20:02:00+08:00
**Priority**: critical
**Status**: resolved
**Area**: backend

### Summary
文件读流必须在返回调用方前确认实际打开，并持续处理异步 error；不能把 `createReadStream()` 的创建等同于文件已可读。

### Details
telegram-bot-api 的本地副本可能被清理或轮转。数据库保留的旧绝对路径会在 `createReadStream()` 异步 open 时产生 ENOENT；若流尚未交给 pipeline，未处理的 error 会终止 Node 进程。缓存的 stat→open 也存在同类 TOCTOU。

### Suggested Action
下载链路使用 `fs.promises.open()` 获取 FileHandle，再以同一句柄 fstat/createReadStream；本地副本可恢复错误通过 file_id 调当前自建 Bot API 的 getFile 刷新路径。返回绝对路径时直接在白名单目录读取，只有相对路径才能拼接 `/file/bot<TOKEN>/`。安全校验错误保持 fail-closed。

### Metadata
- Source: conversation
- Related Files: backend/src/telegram/telegram.service.ts, backend/src/file/file-cache.service.ts
- Tags: node-stream, enoent, telegram, cache, failover
- Pattern-Key: harden.file_stream_open

### Resolution
- **Resolved**: 2026-07-24T20:27:00+08:00
- **Notes**: 已实现 FileHandle 安全打开；旧路径仅调用当前自建 Bot API 刷新，绝对路径直接读取、相对路径走文件端点，并覆盖失效 file_id 回归测试。

---
