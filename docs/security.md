# 安全说明

> 本文档由原 README 拆分而来。启动顺序、CSRF 与部署预检等实现级契约见 `backend/src/main.ts`、`backend/src/common/guards/csrf.guard.ts` 与 `backend/src/config/deployment-preflight.ts`。总索引见 [README](../README.md)。

---

- 不要把 `.env`、Token、密码或加密密钥提交到仓库。
- 生产环境必须使用 HTTPS、强 `JWT_SECRET`、明确 CORS 来源和 `SECURE_COOKIE=true`。
- Telegram Token 会在错误日志中脱敏；生产异常响应不返回堆栈。
- 全局 `ValidationPipe` 启用白名单、类型转换和非白名单字段拒绝。
- Helmet 提供安全响应头；前端 CSP 由 `frontend/index.html` 管理。
- 关键写操作进入审计日志；访问日志按配置定期清理。
- 默认访问日志保留 30 天、审计日志保留 90 天。


