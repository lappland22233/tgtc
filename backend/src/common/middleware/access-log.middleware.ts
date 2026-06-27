import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AccessLog } from '../entities/access-log.entity';
import { getClientIp } from '../utils/client-ip';

/** 不记录日志的路径集合（使用 originalUrl 路径部分匹配，去除查询参数和尾部斜杠） */
const SKIP_PATH_SET = new Set([
  '/api/admin/access-logs',
  '/api/admin/access-logs/stats',
  '/api/admin/access-logs/trend',
  '/api/admin/access-logs/top-files',
  '/api/admin/access-logs/top-paths',
  '/api/admin/access-logs/status-by-path',
  '/api/admin/access-logs/download-stats',
  '/api/admin/access-logs/abnormal-ips',
  '/api/admin/audit-logs',
  '/api/admin/alerts',
  '/api/admin/alerts/unacknowledged',
  '/api/admin/alerts/rules',
  '/api/admin/ban-stats',
  '/api/admin/source-analysis/referer',
  '/api/admin/source-analysis/user-agent',
  '/api/admin/source-analysis',
  '/api/admin/user-activity',
  '/api/admin/user-activity/stats',
  '/api/admin/bandwidth/top-files',
  '/api/admin/file-type-stats',
  '/api/admin/bandwidth',
  '/api/admin/dashboards',
  '/api/admin/dashboards/presets',
]);

/** 从 JWT Cookie 中安全提取 userId（不解密，仅 base64url 解码 payload） */
function extractUserIdFromCookie(req: Request): string | null {
  try {
    const token = req.cookies?.access_token;
    if (!token || typeof token !== 'string') return null;

    // JWT = base64url(header).base64url(payload).base64url(signature)
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf-8');
    const payload = JSON.parse(payloadJson);

    return (payload?.sub && typeof payload.sub === 'string') ? payload.sub : null;
  } catch {
    return null;
  }
}

@Injectable()
export class AccessLogMiddleware implements NestMiddleware {
  constructor(
    @InjectRepository(AccessLog)
    private accessLogRepository: Repository<AccessLog>,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();
    // Phase 0.2: 保留完整 originalUrl（含 queryString），仅去除 fragment
    // 用于搜索关键词、分享参数等精确分析
    const rawPath = (req.originalUrl || req.url || '/').split('#')[0] || '/';

    // 匹配跳过路径时，去除查询参数和尾部斜杠
    const pathForMatching = rawPath.split('?')[0].replace(/\/+$/, '') || '/';
    if (SKIP_PATH_SET.has(pathForMatching)) {
      next();
      return;
    }

    // Phase 0.2: 从 JWT Cookie 提取 userId（用于用户维度访问分析）
    const userId = extractUserIdFromCookie(req);

    // 通过拦截 write/end 追踪实际发送的字节数
    let bytesSent = 0;
    const originalWrite = res.write.bind(res) as typeof res.write;
    const originalEnd = res.end.bind(res) as typeof res.end;
    const self = this;

    res.write = function (chunk: unknown, ...rest: unknown[]): boolean {
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
        const data = chunk as string | Buffer;
        bytesSent += Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
      }
      return originalWrite(chunk as any, ...rest as any[]);
    } as typeof res.write;

    res.end = function (chunk?: unknown, ...rest: unknown[]): unknown {
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
        const data = chunk as string | Buffer;
        bytesSent += Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
      }
      return originalEnd(chunk as any, ...rest as any[]);
    } as typeof res.end;

    // 在响应完成时记录日志
    res.on('finish', () => {
      self.logAsync(req, res, Date.now() - start, rawPath, bytesSent, userId).catch(() => {
        // 日志写入失败不影响业务
      });
    });

    next();
  }

  private async logAsync(
    req: Request,
    res: Response,
    duration: number,
    path: string,
    bytesSent: number,
    userId: string | null,
  ): Promise<void> {
    try {
      const ip = getClientIp(req);

      const responseSize =
        bytesSent ||
        parseInt(res.getHeader('content-length') as string) ||
        0;

      const entry = this.accessLogRepository.create({
        ip,
        method: req.method,
        path: path.substring(0, 500),
        statusCode: res.statusCode,
        responseSize,
        duration,
        userAgent: (req.headers['user-agent'] as string)?.substring(0, 500) || null,
        referer: (req.headers['referer'] as string)?.substring(0, 300) || null,
        userId,  // Phase 0.2: 记录已认证用户
      });

      await this.accessLogRepository.save(entry);
    } catch {
      // 忽略
    }
  }
}
