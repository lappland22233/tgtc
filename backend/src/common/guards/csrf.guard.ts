import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { assertSameOriginWrite } from '../utils/same-origin';
import { timingSafeEqualString, XSRF_COOKIE_NAME, XSRF_HEADER_NAME } from '../utils/xsrf';

/** RFC 7231 安全方法：不改变服务端状态，无需 CSRF 校验。 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 尚未签发 XSRF Cookie 的认证入口：仍需同源校验，但不做双重提交比对。
 *
 * - login/register/send-code/verify-email/reset-password：在会话建立之前调用，
 *   此时不可能携带 XSRF Cookie；
 * - logout：仅强制登出（低风险），豁免可兼容升级前已建立、尚未拿到 XSRF Cookie 的存量会话。
 *
 * 注意：这不是「认证端点无条件放行」——所有非安全方法仍先经过 Origin/Referer 同源校验，
 * 且这些端点在已有 XSRF Cookie 时依然执行双重提交比对（不一致即拒绝）。
 */
const DOUBLE_SUBMIT_EXEMPT_PATHS = new Set([
  'auth/login',
  'auth/register',
  'auth/send-code',
  'auth/verify-email',
  'auth/reset-password',
  'auth/logout',
]);

/**
 * 全局 CSRF 防护（2026-09-10 审查修复 M1）。
 *
 * 两层防线（对非安全方法）：
 * 1. **同源校验**（纵深）：跨站 Origin 优先拒绝；缺失时按既有策略回退 Referer；
 *    无 Origin/Referer 的非浏览器客户端放行，不误伤 Bearer / API Key 调用。
 * 2. **双重提交**（对携带会话 Cookie 的请求）：`X-XSRF-TOKEN` 头必须与
 *    非 httpOnly 的 `XSRF-TOKEN` Cookie 常量时间相等，缺失或失配一律拒绝。
 *
 * 无会话 Cookie 的请求（Bearer / API Key）不涉及浏览器自动携带的凭据，
 * 不做双重提交，但仍受同源校验、认证与权限校验保护。
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly logger = new Logger(CsrfGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const method = (req.method || '').toUpperCase();
    if (SAFE_METHODS.has(method)) return true;

    // ---- 第一层：同源校验（记录拒绝原因，但不打印 Origin/Referer/令牌值） ----
    try {
      assertSameOriginWrite(req);
    } catch (error) {
      this.logger.warn(`[CSRF] 拒绝 ${method} ${this.safePath(req)}：跨站 Origin/Referer 校验失败`);
      throw error;
    }

    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    // 非 Cookie 会话：Bearer / API Key 请求不经过浏览器 Cookie 自动携带路径。
    if (!cookies['access_token']) return true;

    const path = this.normalizedPath(req);
    const cookieToken = cookies[XSRF_COOKIE_NAME];
    const rawHeader = req.headers[XSRF_HEADER_NAME];
    const headerToken = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    if (DOUBLE_SUBMIT_EXEMPT_PATHS.has(path)) {
      // 已有双提交凭据时仍然比对：失配视为伪造尝试。
      if (cookieToken && headerToken && !timingSafeEqualString(cookieToken, headerToken)) {
        this.logger.warn(`[CSRF] 拒绝 ${method} ${this.safePath(req)}：认证入口双重提交令牌不匹配`);
        throw new ForbiddenException('CSRF 校验失败');
      }
      return true;
    }

    if (!cookieToken) {
      this.logger.warn(`[CSRF] 拒绝 ${method} ${this.safePath(req)}：缺少 ${XSRF_COOKIE_NAME} Cookie`);
      throw new ForbiddenException('CSRF 校验失败');
    }
    if (!headerToken) {
      this.logger.warn(`[CSRF] 拒绝 ${method} ${this.safePath(req)}：缺少 ${XSRF_HEADER_NAME} 请求头`);
      throw new ForbiddenException('CSRF 校验失败');
    }
    if (!timingSafeEqualString(cookieToken, headerToken)) {
      this.logger.warn(`[CSRF] 拒绝 ${method} ${this.safePath(req)}：双重提交令牌不匹配`);
      throw new ForbiddenException('CSRF 校验失败');
    }
    return true;
  }

  /** 仅取路径（不含 query），避免把查询参数中的敏感值写入安全事件日志。 */
  private safePath(req: Request): string {
    return (req.path || '/').split('?')[0] ?? '/';
  }

  /** 去掉全局前缀 /api/，得到与豁免清单一致的路由路径。 */
  private normalizedPath(req: Request): string {
    return this.safePath(req).replace(/^\/api\//, '').replace(/^\/+/, '');
  }
}
