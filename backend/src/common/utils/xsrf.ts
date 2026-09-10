import { randomBytes, timingSafeEqual } from 'crypto';
import type { Request } from 'express';

/**
 * CSRF 双重提交（double-submit cookie）令牌工具（2026-09-10 审查修复 M1）。
 *
 * 设计：
 * - 服务端在会话建立时下发**非 httpOnly** 的 `XSRF-TOKEN` Cookie，前端读取后回填
 *   `X-XSRF-TOKEN` 请求头；服务端比对二者是否一致（常量时间）。
 * - 由于攻击者无法读取其他源下的 Cookie（同源策略），跨站请求即使自动携带 Cookie
 *   也无法构造出匹配的请求头，从而阻断 CSRF。
 * - Secure / SameSite / Path / maxAge 与 `access_token` 保持一致，避免安全属性降级。
 *   `sameSite` 保持 lax：与项目既有约定一致，双重提交作为该策略之外的第二层防护。
 */
export const XSRF_COOKIE_NAME = 'XSRF-TOKEN';
export const XSRF_HEADER_NAME = 'x-xsrf-token';

/** 生成新的双提交令牌（32 字节随机 hex，不可预测）。 */
export function generateXsrfToken(): string {
  return randomBytes(32).toString('hex');
}

/** 与 access_token 完全一致的安全属性，唯一区别是 httpOnly=false（前端必须可读）。 */
export function getXsrfCookieOptions(req: Request): {
  httpOnly: false;
  secure: boolean;
  sameSite: 'lax';
  maxAge: number;
  path: string;
} {
  return {
    httpOnly: false,
    secure:
      process.env.SECURE_COOKIE === 'true'
      || req.secure
      || req.headers['x-forwarded-proto'] === 'https',
    sameSite: 'lax',
    maxAge: 7 * 24 * 3600 * 1000,
    path: '/',
  };
}

/** 常量时间字符串比较，避免通过响应时间侧信道逐字节猜测令牌。 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  // 长度不同直接返回 false：长度本身不是秘密，提前返回不引入可观测差异。
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
