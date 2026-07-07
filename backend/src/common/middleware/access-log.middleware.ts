import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AccessLog } from '../entities/access-log.entity';
import { getClientIp } from '../utils/client-ip';

/** 不记录日志的路径前缀（减少管理后台日志噪音） */
const SKIP_PATH_PREFIXES = ['/api/admin/access-logs', '/api/admin/audit-logs', '/api/admin/alerts', '/api/admin/ban-stats', '/api/admin/source-analysis', '/api/admin/user-activity', '/api/admin/bandwidth', '/api/admin/file-type-stats', '/api/admin/dashboards'];

function shouldSkipPath(path: string): boolean {
  const normalized = path.split('?')[0].replace(/\/+$/, '') || '/';
  return SKIP_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

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
    const rawPath = (req.originalUrl || req.url || '/').split('#')[0] || '/';

    if (shouldSkipPath(rawPath)) {
      next();
      return;
    }

    const userId = extractUserIdFromCookie(req);

    // 记录响应开始时的已发送字节数，finish 时计算差值
    const startBytesSent = res.socket?.bytesWritten ?? 0;
    const self = this;

    res.on('finish', () => {
      const bytesSent = (res.socket?.bytesWritten ?? 0) - startBytesSent;
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
