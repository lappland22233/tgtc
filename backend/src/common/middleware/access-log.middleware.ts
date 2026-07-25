import { Injectable, NestMiddleware, OnApplicationShutdown, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AccessLog } from '../entities/access-log.entity';
import { getClientIp } from '../utils/client-ip';

/** 不记录日志的路径前缀（减少管理后台日志噪音） */
const SKIP_PATH_PREFIXES = ['/api/admin/access-logs', '/api/admin/audit-logs', '/api/admin/alerts', '/api/admin/ban-stats', '/api/admin/source-analysis', '/api/admin/user-activity', '/api/admin/bandwidth', '/api/admin/file-type-stats', '/api/admin/dashboards'];

/** 批量写入参数：缓冲达到阈值或定时器到期时统一 flush，降低高 QPS 下的写放大 */
const FLUSH_INTERVAL_MS = 5000;
const FLUSH_BATCH_SIZE = 200;
/** 缓冲上限：DB 长时间不可用时丢弃最旧记录，避免内存无界增长 */
const MAX_BUFFER_SIZE = 10000;

function shouldSkipPath(path: string): boolean {
  const normalized = path.split('?')[0].replace(/\/+$/, '') || '/';
  return SKIP_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

@Injectable()
export class AccessLogMiddleware implements NestMiddleware, OnApplicationShutdown {
  private readonly logger = new Logger(AccessLogMiddleware.name);
  /** 内存缓冲：累积访问日志，定时/定量批量写入，避免逐请求同步写库 */
  private buffer: Partial<AccessLog>[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;

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

    // 中间件阶段不解码未验签 Cookie；仅接受上游认证链路已写入的可信用户上下文。
    const userId = (req as Request & { user?: { id?: string } }).user?.id || null;

    // 记录响应开始时的已发送字节数，finish 时计算差值。
    // 注意：bytesWritten 含 HTTP 响应头，并非精确的响应体大小，仅作带宽估算。
    const startBytesSent = res.socket?.bytesWritten ?? 0;
    const self = this;

    res.on('finish', () => {
      const bytesSent = (res.socket?.bytesWritten ?? 0) - startBytesSent;
      self.enqueue(req, res, Date.now() - start, rawPath, bytesSent, userId);
    });

    next();
  }

  /** 将日志条目加入内存缓冲，并按需触发批量 flush（fire-and-forget，不阻塞响应） */
  private enqueue(
    req: Request,
    res: Response,
    duration: number,
    path: string,
    bytesSent: number,
    userId: string | null,
  ): void {
    try {
      const ip = getClientIp(req);

      const responseSize =
        bytesSent ||
        parseInt(res.getHeader('content-length') as string) ||
        0;

      const entry: Partial<AccessLog> = {
        ip,
        method: req.method,
        path: path.substring(0, 500),
        statusCode: res.statusCode,
        responseSize,
        duration,
        userAgent: (req.headers['user-agent'] as string)?.substring(0, 500) || null,
        referer: (req.headers['referer'] as string)?.substring(0, 300) || null,
        userId, // 仅记录认证链路提供的可信用户 ID
      };

      this.buffer.push(entry);

      // 缓冲超上限时丢弃最旧记录，防止 DB 慢响应导致内存无界增长
      if (this.buffer.length > MAX_BUFFER_SIZE) {
        this.buffer.splice(0, this.buffer.length - MAX_BUFFER_SIZE);
      }

      if (this.buffer.length >= FLUSH_BATCH_SIZE) {
        void this.flush();
      } else {
        this.ensureTimer();
      }
    } catch {
      // 日志构建失败不影响业务
    }
  }

  private ensureTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    // 不阻止进程退出
    this.flushTimer.unref?.();
  }

  /** 批量写入缓冲中的日志。失败时丢弃本批（访问日志非关键数据），避免无界重试堆积 */
  private async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.accessLogRepository.insert(batch);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`访问日志批量写入失败（丢弃 ${batch.length} 条）: ${message}`);
    } finally {
      this.flushing = false;
      // 若缓冲在写入期间又累积了新记录，安排下一次 flush
      if (this.buffer.length > 0) {
        this.ensureTimer();
      }
    }
  }

  async onApplicationShutdown(_signal?: string): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // 优雅关闭前尽量落盘剩余缓冲
    await this.flush();
  }
}
