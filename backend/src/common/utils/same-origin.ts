import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';

/**
 * 写语义端点的同源校验（CSRF 纵深防御）。
 *
 * 规则：
 * - 浏览器跨站请求必带 `Origin`（POST 一定携带），无 Origin 时按既有策略回退 `Referer`；
 * - 仅比对 host（忽略 scheme，兼容反向代理终止 TLS 的部署）；
 * - 允许的 host 集合 = 请求自身 host + CORS_ORIGINS / FRONTEND_URL / APP_URL 中的 host，
 *   以兼容前后端分离部署（例如开发期 Vite 5173 代理到后端 3000）；
 * - 无 Origin/Referer 的非浏览器客户端（API Key / Bearer 脚本调用）放行——它们不受
 *   浏览器同源策略约束，也不携带可被利用的 Cookie，仍由认证与权限校验保护。
 */
export function assertSameOriginWrite(req: Request): void {
  const raw = (req.headers['origin'] as string | undefined)
    ?? (req.headers['referer'] as string | undefined);
  if (!raw) return;
  let originHost: string | undefined;
  try {
    originHost = new URL(raw).host;
  } catch {
    throw new ForbiddenException('非法的 Origin/Referer');
  }
  if (!originHost) return;
  if (originHost === req.hostname) return;
  if (isConfiguredCorsHost(originHost)) return;
  throw new ForbiddenException('跨站请求被拒绝');
}

/** 判断 host 是否属于显式配置允许的跨源来源（CORS_ORIGINS / FRONTEND_URL / APP_URL）。 */
export function isConfiguredCorsHost(host: string): boolean {
  const configured: string[] = [];
  const push = (value?: string) => {
    for (const entry of (value ?? '').split(',')) {
      const trimmed = entry.trim();
      if (trimmed) configured.push(trimmed);
    }
  };
  push(process.env.CORS_ORIGINS);
  push(process.env.FRONTEND_URL);
  push(process.env.APP_URL);
  for (const origin of configured) {
    try {
      if (new URL(origin).host === host) return true;
    } catch {
      // 配置项非法时忽略（env-validation 已对关键项做格式校验）
    }
  }
  return false;
}
