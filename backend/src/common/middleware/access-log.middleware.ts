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
  '/api/admin/audit-logs',
]);

@Injectable()
export class AccessLogMiddleware implements NestMiddleware {
  constructor(
    @InjectRepository(AccessLog)
    private accessLogRepository: Repository<AccessLog>,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();
    // T1-1/T1-2/T1-3: 使用 originalUrl 获取含全局 /api 前缀的原始路径
    // 去除查询参数和尾部斜杠，确保路径匹配一致性和统计聚合准确性
    const rawPath = (req.originalUrl || req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';

    // T1-5: 使用 Set.has() O(1) 查找替代 Array.includes() O(n)
    if (SKIP_PATH_SET.has(rawPath)) {
      next();
      return;
    }

    // T1-4: 通过拦截 write/end 追踪实际发送的字节数
    // 注意：统计的是业务层写入字节（压缩前），gzip 压缩后实际网络传输量可能更低
    let bytesSent = 0;
    const originalWrite = res.write.bind(res) as typeof res.write;
    const originalEnd = res.end.bind(res) as typeof res.end;
    const self = this;

    res.write = function (chunk: unknown, ...rest: any[]): boolean {
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
        const data = chunk as string | Buffer;
        bytesSent += Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
      }
      return (originalWrite as any)(chunk, ...rest);
    };

    res.end = function (chunk: unknown, ...rest: any[]): any {
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
        const data = chunk as string | Buffer;
        bytesSent += Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
      }
      return (originalEnd as any)(chunk, ...rest);
    };

    // 在响应完成时记录日志
    res.on('finish', () => {
      self.logAsync(req, res, Date.now() - start, rawPath, bytesSent).catch(() => {
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
  ): Promise<void> {
    try {
      const ip = getClientIp(req);

      // 优先使用实际发送的字节数，其次使用 content-length 头
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
      });

      await this.accessLogRepository.save(entry);
    } catch {
      // 忽略
    }
  }
}
