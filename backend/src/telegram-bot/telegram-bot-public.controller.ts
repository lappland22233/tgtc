import { Controller, Get, HttpException, HttpStatus, NotFoundException, Param, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import { AuditService } from '../common/services/audit.service';
import { AuditStatus } from '../common/entities/audit-log.entity';
import { RateLimitService } from '../common/services/rate-limit.service';
import { StreamResponderService } from '../common/services/stream-responder.service';
import {
  BotAccessContext,
  TransferOutcomeContext,
  TransferTerminationReason,
} from '../common/middleware/access-log.middleware';
import { getClientIp } from '../common/utils/client-ip';
import { buildContentDisposition } from '../common/utils/content-disposition';
import { buildOpaqueETag, matchesIfRange } from '../common/utils/file-range-validator';
import { parseByteRange } from '../common/utils/byte-range';
import { TelegramService } from '../telegram/telegram.service';
import { FileCacheService } from '../file/file-cache.service';
import { RangeNotSatisfiableException } from '../file/file-utils';
import { TelegramBotGrantService } from './telegram-bot-grant.service';

/** 单 Token 与单 IP 的下载限流参数（宽松阈值，仅用于阻断滥用） */
const IP_LIMIT = { key: 'bot-dl:ip', max: 300, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 };
const TOKEN_LIMIT = { key: 'bot-dl:token', max: 600, windowMs: 15 * 60 * 1000, lockMs: 15 * 60 * 1000 };

/** 允许透传为 Content-Type 的 MIME（其余回退 octet-stream，避免头注入/嗅探） */
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i;

/**
 * Bot 直链匿名下载端点：`GET /api/bot-dl/:token`。
 *
 * 安全设计（D2/R2）：
 * - 无需登录；不复用 JWT，不暴露 Bot Token / file_id / 本站用户凭据；
 * - 校验链仅时间限制：hash 命中 → 未撤销 → 未过期；**不做次数拦截**；
 * - 过期/不存在/已撤销统一返回 404，避免枚举探测；
 * - 只读 attachment + no-store + nosniff + no-referrer。
 *
 * Range 支持（与其他下载端点一致，复用 `FileCacheService`）：
 * - 单区间 Range 返回真实 `206` + `Content-Range`，因此**断点续传可用**；
 * - 稳定强 `ETag`（命名空间 + `file_id` 摘要 + 大小）配合 `If-Range`：强 ETag 精确
 *   匹配才认 Range，弱标签 / 版本不匹配 / 日期值一律忽略 Range 回完整 `200`，
 *   避免客户端把不同版本的分段拼成损坏文件；
 * - 上游始终单路顺序构建，未回源区间由 follower 等待补齐，故**并发多线程下载
 *   尚未回源的部分无法立即应答**（不会返回错误，只是等待）；
 * - 总长未知（Telegram 未上报 `file_size`）时无法生成 `Content-Range`，
 *   退化为完整 `200` 且不声明 `Accept-Ranges`。
 *
 * 统计语义：仅当 pipeline 真正把响应完整写完才计入 `accessCount` 与成功审计；
 * 传输中断 / 上游失败只记失败审计，并由访问日志的传输结果字段区分。
 */
@Controller('bot-dl')
export class TelegramBotPublicController {
  constructor(
    private readonly grantService: TelegramBotGrantService,
    private readonly telegramService: TelegramService,
    private readonly fileCacheService: FileCacheService,
    private readonly rateLimitService: RateLimitService,
    private readonly streamResponder: StreamResponderService,
    private readonly auditService: AuditService,
  ) {}

  @Get(':token')
  async download(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const ip = getClientIp(req);
    const tokenKey = this.safeTokenKey(token);

    await this.assertRateLimit(`${IP_LIMIT.key}:${ip}`, IP_LIMIT);
    await this.assertRateLimit(`${TOKEN_LIMIT.key}:${tokenKey}`, TOKEN_LIMIT);

    // 统一 404（不存在 / 已撤销 / 已过期），不区分原因，避免枚举探测
    if (!token || !/^[A-Za-z0-9_-]{16,}$/.test(token)) {
      throw new NotFoundException('链接无效或已过期');
    }
    const grant = await this.grantService.findByToken(token);
    if (!grant || !this.grantService.isActive(grant)) {
      throw new NotFoundException('链接无效或已过期');
    }

    // 挂载 Bot 身份，供 AccessLogMiddleware 写入 access_logs（D8/C-2）
    const botContext = req as Request & BotAccessContext & TransferOutcomeContext;
    botContext.botGrantId = grant.id;
    botContext.botTelegramUserId = grant.telegramUserId;

    try {
      // Telegram 上报的 file_size 决定能否生成 Content-Range/Content-Length
      const reported = Number(grant.fileSize);
      const expectedSize = grant.fileSize && Number.isSafeInteger(reported) && reported > 0
        ? reported
        : undefined;

      // 稳定强 ETag：不含明文凭据，跨不同 grant 保持一致，客户端据此判断续传版本
      const etag = expectedSize !== undefined
        ? buildOpaqueETag('telegram-bot', grant.telegramFileId, expectedSize)
        : undefined;
      // 提前写入响应头，使后续抛出的 416 也携带 ETag（客户端可据此刷新本地版本）
      if (etag) res.set('ETag', etag);

      const cacheKey = this.cacheKeyFor(grant.telegramFileId);
      // noCache=true：让上游在本次流结束后回收 TDLib workdir 中的本地副本（引用计数安全，
      // 无其他监听者时才删）。后端若保留正式缓存，它就是唯一持久副本；否则（无缓存/直通）
      // 本就不该长期占用 workdir。这是把「Cache 12G + workdir 12G」两份完整副本收敛为
      // 一份的关键：不删除时 TDLib 会一直保留整份文件。
      const fetchFn = () => this.telegramService.getRealtimeFileStream(grant.telegramFileId, expectedSize, {
        noCache: true,
      });

      const rangeHeader = req.headers.range;
      const ifRange = typeof req.headers['if-range'] === 'string' ? req.headers['if-range'] : undefined;
      // If-Range 不匹配（弱 ETag / 内容已变 / 日期值）时按 RFC 7233 忽略 Range 回完整 200，
      // 否则客户端会把不同版本的分段拼成损坏文件。
      const ifRangeMismatch = Boolean(
        rangeHeader && expectedSize !== undefined && etag && !matchesIfRange(ifRange, etag),
      );

      let stream: Readable;
      let status: number | undefined;
      let range: { start: number; end: number; total: number } | undefined;
      let contentLength: number | undefined;

      if (rangeHeader && expectedSize !== undefined && !ifRangeMismatch) {
        // 严格单 Range：非法/越界统一 416（含 Content-Range: bytes */total），
        // 不静默回退 200，避免垃圾 Range 与错误 Content-Length 组合。
        const parsed = parseByteRange(rangeHeader, expectedSize);
        if (!parsed.ok) {
          throw new RangeNotSatisfiableException(expectedSize);
        }
        const { start, end } = parsed.range;
        const ranged = await this.fileCacheService.getOrCacheRangeStream(
          cacheKey,
          expectedSize,
          start,
          end,
          fetchFn,
        );
        if (!ranged) {
          throw new RangeNotSatisfiableException(expectedSize);
        }
        stream = ranged;
        status = 206;
        range = { start, end, total: expectedSize };
        contentLength = end - start + 1;
      } else if (expectedSize !== undefined) {
        // 完整下载也走缓存：后续 Range 请求可直接命中本地缓存完成断点续传
        const result = await this.fileCacheService.getOrCacheStream(cacheKey, expectedSize, fetchFn);
        stream = result.stream;
        contentLength = expectedSize;
      } else {
        // 文件大小未知：无法预测磁盘占用、也无从生成 Content-Length / Content-Range，
        // 走有界滚动缓冲直通（不落盘、受上游并发租约约束），保证文件始终可下载。
        stream = await this.fileCacheService.getDirectOnlyStream(cacheKey, () =>
          this.telegramService.getRealtimeFileStream(grant.telegramFileId),
        );
      }

      // 只有真正走到「要输出文件正文」才标记为可分类传输：
      // 416/404 等错误响应不应被统计成一次下载完成。
      botContext.transferTracked = true;
      botContext.ranged = Boolean(range);
      // 上游/缓存失败会先在源流上 emit 'error'，随后 pipeline 才销毁响应；
      // 在此同步分类，访问日志才能区分「上游失败」与「客户端主动中断」。
      this.trackTermination(stream, botContext);

      await this.streamResponder.send({
        res,
        status,
        range,
        headers: {
          'Content-Type': this.resolveContentType(grant.mimeType),
          'Content-Disposition': buildContentDisposition('attachment', grant.fileName || 'download'),
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          // 仅在已知总长（可计算 Content-Range）时声明 Range 能力与版本标识
          ...(contentLength !== undefined
            ? { 'Content-Length': String(contentLength), 'Accept-Ranges': 'bytes' }
            : {}),
          ...(etag ? { ETag: etag } : {}),
        },
        stream,
      });

      // 统计计数：pipeline 正常返回才说明响应完整写完，此时才计入访问次数与成功审计。
      // 此前在输出前就计数，导致客户端中断、上游失败都被统计成「一次成功下载」。
      void this.grantService.recordAccess(grant.id);
      this.auditService.log({
        action: 'telegram_bot_link_accessed',
        resourceType: 'telegram_bot_grant',
        resourceId: grant.id,
        metadata: {
          grantId: grant.id,
          tokenPrefix: grant.tokenPrefix,
          telegramUserId: grant.telegramUserId,
          clientIp: ip,
          success: true,
          ranged: Boolean(range),
          terminationReason: 'completed' satisfies TransferTerminationReason,
        },
      });
    } catch (error) {
      const terminationReason = botContext.terminationReason ?? this.classifyTermination(error);
      botContext.terminationReason = terminationReason;
      this.auditService.log({
        action: 'telegram_bot_link_accessed',
        resourceType: 'telegram_bot_grant',
        resourceId: grant.id,
        status: AuditStatus.FAILURE,
        metadata: {
          grantId: grant.id,
          tokenPrefix: grant.tokenPrefix,
          telegramUserId: grant.telegramUserId,
          clientIp: ip,
          success: false,
          terminationReason,
          reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        },
      });
      this.streamResponder.handleError(res, error, '文件下载失败，请稍后重试', req);
    }
  }

  /**
   * 在源流上监听错误并同步分类传输结束原因。
   *
   * 时序：源流 emit 'error' → 本监听器写入 terminationReason → pipeline 销毁响应 → 'close'。
   * 必须早于 `StreamResponderService.send()` 挂载，否则写入时响应已关闭、字段不会生效。
   */
  private trackTermination(stream: Readable, context: TransferOutcomeContext): void {
    stream.once('error', (error: unknown) => {
      context.terminationReason = this.classifyTermination(error);
    });
  }

  /**
   * 异常 → 传输结束原因。
   * pipeline 在客户端断开时抛 ERR_STREAM_PREMATURE_CLOSE；缓存 watchdog 超时带「超时」文案。
   */
  private classifyTermination(error: unknown): TransferTerminationReason {
    const code = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (code === 'ERR_STREAM_PREMATURE_CLOSE' || /premature close|aborted/i.test(message)) {
      return 'client_abort';
    }
    if (/超时|[Ee][Tt][Ii][Mm][Ee][Oo][Uu][Tt]|timeout/i.test(message)) return 'timeout';
    if (/shutdown|关闭|正在退出/i.test(message)) return 'server_shutdown';
    return 'upstream_error';
  }

  private async assertRateLimit(
    key: string,
    config: { key: string; max: number; windowMs: number; lockMs: number },
  ): Promise<void> {
    const result = await this.rateLimitService.checkAndIncrement(
      key,
      config.key,
      config.max,
      config.lockMs,
      config.windowMs,
    );
    if (!result.allowed) {
      throw new HttpException('请求过于频繁，请稍后重试', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /**
   * 限流键中的 Token 摘要。
   *
   * 明文 Token 不能写进 `rate_limits` 表；而只用 8 字符前缀会在前缀碰撞时让不同
   * 链接共享额度。这里改用完整 Token 的 SHA-256 摘要：不可逆、无碰撞放大；
   * 审计展示仍由 DB 中的 `tokenPrefix` 承担。
   */
  private safeTokenKey(token: string): string {
    return createHash('sha256').update(token || '').digest('hex');
  }

  /**
   * Bot 直链的本地缓存键。
   *
   * `FileCacheService` 只接受 UUID 形状的键（防路径穿越），而 Telegram `file_id`
   * 是任意字符串；这里用带命名空间的 SHA-256 派生稳定 UUID，使同一 Telegram 文件
   * 在多次直链访问间复用同一份缓存，并与本站 File 的缓存键空间天然隔离。
   */
  private cacheKeyFor(telegramFileId: string): string {
    const hex = createHash('sha256').update(`telegram-bot:${telegramFileId}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  private resolveContentType(mimeType: string | null): string {
    if (mimeType && MIME_PATTERN.test(mimeType)) return mimeType;
    return 'application/octet-stream';
  }
}
