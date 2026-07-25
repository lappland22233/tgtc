# Errors

Command failures and integration errors.

---

## [ERR-20260725-003] backend-test-missing-hmac-secret

**Logged**: 2026-07-25T16:09:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary
后端完整测试未配置验证码服务启动所需的 HMAC 密钥，导致 AuthService 测试在依赖注入阶段失败。

### Error
```text
CODE_HMAC_SECRET 或 JWT_SECRET 环境变量未配置，无法安全计算验证码哈希
```

### Context
- `AuthService` 构造函数按安全要求拒绝无验证码 HMAC 密钥启动。
- `auth.service.spec.ts` 未设置测试密钥。

### Suggested Fix
测试创建 AuthService 前设置专用的非生产 `CODE_HMAC_SECRET`。

### Metadata
- Reproducible: yes
- Related Files: backend/src/auth/auth.service.spec.ts

### Resolution
- **Resolved**: 2026-07-25T16:09:00+08:00
- **Notes**: 单元测试 `beforeEach` 中设置测试专用 HMAC 密钥。

---

## [ERR-20260724-001] parallel_persistent_shell_cwd

**Logged**: 2026-07-24T22:59:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary
并行命令复用了持久 PowerShell 工作目录，导致相对 `cd backend` 从 `backend` 内再次进入不存在的目录，并混入旧测试输出。

### Error
```text
Cannot find path 'C:\预备重构\backend\backend' because it does not exist.
```

### Context
- 并行执行前后端验证命令时使用了相对目录。
- 后续改为每条命令先 `Set-Location` 到绝对路径并重新验证。

### Suggested Fix
并行或持久终端中的验证命令始终以 `Set-Location '<absolute path>'` 开头。

### Metadata
- Reproducible: yes
- Related Files: backend/package.json, frontend/package.json

### Resolution
- **Resolved**: 2026-07-24T22:59:00+08:00
- **Notes**: 使用绝对目录重新执行，最终测试、类型检查和构建均通过。

---

## [ERR-20260724-002] growing_cache_retry_tests

**Logged**: 2026-07-24T23:18:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary
增长缓存测试曾把跟随流结束误认为正式缓存已完成原子发布，并且失败流未进入读取状态。

### Error
```text
ENOENT reading final cache; follower error test timed out.
```

### Context
- 跟随者读取到期望字节可以早于缓存容量检查和 rename。
- `Readable.from(async generator)` 只有进入 flowing/读取状态后才会执行并传播会话错误。

### Suggested Fix
最终缓存断言前等待会话 `completion`；错误传播测试先消费或 `resume()` 跟随流。

### Metadata
- Reproducible: yes
- Related Files: backend/src/file/file-cache.service.spec.ts

### Resolution
- **Resolved**: 2026-07-24T23:18:00+08:00
- **Notes**: 调整测试时序后 10 个缓存测试及 88 个定向测试全部通过。

---

## [ERR-20260725-001] realtime_cache_follower_tmp_race

**Logged**: 2026-07-25T13:45:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
实时缓存首块进度曾早于临时文件可读取状态，导致跟随者在 Windows 上打开 `.tmp` 时出现 ENOENT。

### Error
```text
ENOENT: no such file or directory, open '<cache-file>.tmp'
```

### Context
- 初版在上游 `data` 事件中推进 `bytesWritten`，但 WriteStream 尚未完成临时文件创建或落盘。
- 跟随者据此立即打开临时文件，暴露创建与进度通知竞态。

### Suggested Fix
缓存会话应先独占创建 `.tmp`，并逐块等待写入回调后才更新可读进度；跟随者只能读取已确认写入的字节。

### Metadata
- Reproducible: yes
- Related Files: backend/src/file/file-cache.service.ts, backend/src/file/file-cache.service.spec.ts

### Resolution
- **Resolved**: 2026-07-25T13:43:54+08:00
- **Notes**: 改为预创建临时文件、逐块背压写入后发布进度，定向测试与完整回归通过。

---

## [ERR-20260725-002] isolated_production_build

**Logged**: 2026-07-25T15:05:00+08:00
**Priority**: high
**Status**: resolved
**Area**: tests

### Summary
隔离生产构建暴露了前端内联 CSS 路径代理缺陷和两个重复 Vue SFC；Bot API 原生编译受本机工具链依赖缺失阻塞。

### Error
```text
[vite:html-inline-proxy] No matching HTML proxy module
Single file component can contain only one <template> element
Visual Studio instance not found; MSYS2 make/gperf/OpenSSL development dependencies unavailable
```

### Context
- 所有输出必须落在工作区根目录 `.tmp`，不能保留在源码目录。
- 前端 `index.html` 内联关键 CSS 在中文绝对路径下触发 Vite 5 HTML proxy 错误。
- `FileShareCard.vue` 和 `FolderShareBrowser.vue` 各包含两份完整 SFC。
- 后端与前端最终成功；C++ CMake 配置因本机无可用 Visual Studio/Make 和完整依赖而无法完成。

### Suggested Fix
持续使用 `.tmp` 隔离输出；关键 CSS 使用同源静态文件；Vue 构建前检查重复顶层块；原生 Bot API 构建环境预装 VS 2022 + vcpkg，或完整 MSYS2 UCRT64 CMake/Ninja/gperf/OpenSSL/zlib 工具链。

### Metadata
- Reproducible: yes
- Related Files: frontend/index.html, frontend/public/critical.css, frontend/src/views/share/FileShareCard.vue, frontend/src/views/share/FolderShareBrowser.vue, telegram-bot-api/CMakeLists.txt

### Resolution
- **Resolved**: 2026-07-25T15:05:00+08:00
- **Notes**: 前端改为静态关键 CSS 并清除重复 SFC 后，类型检查与 Vite 生产构建通过；原生编译阻塞已明确归因于环境依赖而非源码错误。

---
