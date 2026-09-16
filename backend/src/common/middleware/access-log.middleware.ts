import { Injectable, NestMiddleware, OnApplicationShutdown, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AccessLog } from '../entities/access-log.entity';
import { getClientIp } from '../utils/client-ip';
import { sanitizeUrlForLog, sanitizeRefererForLog } from '../utils/sensitive-data';

/**
 * Bot 直链控制器在请求对象上挂载的身份上下文（D8/C-2）。
 * 中间件在 res 'finish'（正常完成）或 'close'（客户端提前断开）阶段读取并写入
 * access_logs 的 botGrantId/botTelegramUserId 列。
 */
export interface BotAccessContext {
  botGrantId?: string | null;
  botTelegramUserId?: string | null;
}

/** 不记录日志的路径前缀（减少管理后台日志噪音） */
const SKIP_PATH_PREFIXES = ['/api/admin/access-logs', '/api/admin/audit-logs', '/api/admin/alerts', '/api/admin/ban-stats', '/api/admin/source-analysis', '/api/admin/user-activity', '/api/admin/bandwidth', '/api/admin/file-type-stats'];

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
    // 集中脱敏：只记录规范化 pathname + 非敏感 query，绝不持久化
    // access/token/code/password 等凭据型查询参数（C-02 修复）。
    const rawPath = sanitizeUrlForLog((req.originalUrl || req.url || '/').split('#')[0]);

    if (shouldSkipPath(rawPath)) {
      next();
      return;
    }

    // 中间件阶段不解码未验签 Cookie；仅接受上游认证链路已写入的可信用户上下文。
    const userId = (req as Request & { user?: { id?: string } }).user?.id || null;

    // 记录响应开始时的已发送字节数，finish/close 时计算差值。
    // 注意：bytesWritten 含 HTTP 响应头，并非精确的响应体大小，仅作带宽估算。
    // 必须在进入中间件时冻结 socket 引用：Node 在响应结束后会把 res.socket 置为 null，
    // 等到 finish/close 阶段再读 res.socket 会恒为 0，导致响应大小只能退化为
    // Content-Length 头（未声明该头时全部记成 0）。
    const socket = res.socket ?? null;
    const startBytesSent = socket?.bytesWritten ?? 0;

    let recorded = false;
    const finalize = (event: 'finish' | 'close'): void => {
      if (recorded) return;
      const bytesSent = (socket?.bytesWritten ?? 0) - startBytesSent;
      // 客户端提前断开时（大文件流式下载被截断、Telegram 链接预览爬虫固定只抓前几 MB、
      // 用户取消下载等）Node 只 emit 'close'，不 emit 'finish'。此前只监听 finish，
      // 使这类请求一条都不落库——Bot 直链成功下载的访问日志长期为空即源于此。
      // 但若响应头都还没发出（连接在服务端处理阶段就断了），不算一次已提供的响应，跳过。
      if (event === 'close' && !res.headersSent && bytesSent <= 0) return;
      recorded = true;
      this.enqueue(req, res, Date.now() - start, rawPath, bytesSent, userId);
    };

    res.on('finish', () => finalize('finish'));
    res.on('close', () => finalize('close'));

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

      // Bot 直链身份：控制器在开始处理时挂到 req 上（finish/close 阶段读取同一对象）
      const botContext = req as Request & BotAccessContext;

      const entry: Partial<AccessLog> = {
        ip,
        method: req.method,
        path: path.substring(0, 500),
        statusCode: res.statusCode,
        responseSize,
        duration,
        userAgent: (req.headers['user-agent'] as string)?.substring(0, 500) || null,
        referer: sanitizeRefererForLog(req.headers['referer'] as string | undefined),
        userId, // 仅记录认证链路提供的可信用户 ID
        botGrantId: botContext.botGrantId ?? null,
        botTelegramUserId: botContext.botTelegramUserId ?? null,
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
    const pendingCount = this.buffer.length;
    const completed = await Promise.race([
      this.flush().then(() => true),
      new Promise<false>(resolve => {
        const timer = setTimeout(() => resolve(false), 5000);
        timer.unref?.();
      }),
    ]);
    if (!completed) {
      this.logger.error(`访问日志关闭刷新超时，最多 ${pendingCount} 条记录未写入`);
    }
  }
}
