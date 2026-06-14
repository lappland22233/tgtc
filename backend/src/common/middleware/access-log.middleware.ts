import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AccessLog } from '../entities/access-log.entity';
import { getClientIp } from '../utils/client-ip';

/** 不记录日志的路径前缀 */
const SKIP_PATHS = ['/api/admin/access-logs', '/api/admin/access-logs/stats'];

@Injectable()
export class AccessLogMiddleware implements NestMiddleware {
  constructor(
    @InjectRepository(AccessLog)
    private accessLogRepository: Repository<AccessLog>,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();
    const path = req.originalUrl || req.url;

    // 跳过自身 API 请求
    if (SKIP_PATHS.some((p) => path.startsWith(p))) {
      next();
      return;
    }

    // 在响应完成时记录日志
    res.on('finish', () => {
      this.logAsync(req, res, Date.now() - start, path).catch(() => {
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
  ): Promise<void> {
    try {
      const ip = getClientIp(req);
      const responseSize = parseInt(res.getHeader('content-length') as string) || 0;

      const entry = this.accessLogRepository.create({
        ip,
        method: req.method,
        path: path.substring(0, 500),
        statusCode: res.statusCode,
        responseSize,
        duration,
        userAgent: (req.headers['user-agent'] as string)?.substring(0, 500) || null,
        referer: (req.headers['referer'] as string)?.substring(0, 300) || null,
      });

      await this.accessLogRepository.save(entry);
    } catch {
      // 忽略
    }
  }
}
