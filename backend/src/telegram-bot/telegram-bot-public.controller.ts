import { Controller, Get, HttpException, HttpStatus, NotFoundException, Param, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import { AuditService } from '../common/services/audit.service';
import { AuditStatus } from '../common/entities/audit-log.entity';
import { RateLimitService } from '../common/services/rate-limit.service';
import { StreamResponderService } from '../common/services/stream-responder.service';
import { BotAccessContext } from '../common/middleware/access-log.middleware';
import { getClientIp } from '../common/utils/client-ip';
import { buildContentDisposition } from '../common/utils/content-disposition';
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
 * - 上游始终单路顺序构建，未回源区间由 follower 等待补齐，故**并发多线程下载
 *   尚未回源的部分无法立即应答**（不会返回错误，只是等待）；
 * - 总长未知（Telegram 未上报 `file_size`）时无法生成 `Content-Range`，
 *   退化为完整 `200` 且不声明 `Accept-Ranges`。
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
    const botContext = req as Request & BotAccessContext;
    botContext.botGrantId = grant.id;
    botContext.botTelegramUserId = grant.telegramUserId;

    try {
      // Telegram 上报的 file_size 决定能否生成 Content-Range/Content-Length
      const reported = Number(grant.fileSize);
      const expectedSize = grant.fileSize && Number.isSafeInteger(reported) && reported > 0
        ? reported
        : undefined;

      const cacheKey = this.cacheKeyFor(grant.telegramFileId);
      const fetchFn = () => this.telegramService.getRealtimeFileStream(grant.telegramFileId, expectedSize);

      let stream: Readable;
      let status: number | undefined;
      let range: { start: number; end: number; total: number } | undefined;
      let contentLength: number | undefined;

      const rangeHeader = req.headers.range;
      if (rangeHeader && expectedSize !== undefined) {
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
        const result = await this.telegramService.getRealtimeFileStream(grant.telegramFileId);
        stream = result.stream;
      }

      // 统计计数（不影响下载）
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
        },
      });

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
          // 仅在已知总长（可计算 Content-Range）时声明 Range 能力
          ...(contentLength !== undefined
            ? { 'Content-Length': String(contentLength), 'Accept-Ranges': 'bytes' }
            : {}),
        },
        stream,
      });
    } catch (error) {
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
          reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        },
      });
      this.streamResponder.handleError(res, error, '文件下载失败，请稍后重试', req);
    }
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

  /** 限流键中的 Token 片段（避免把完整 Token 写入限流表） */
  private safeTokenKey(token: string): string {
    return this.grantService.tokenPrefixOf(token || '');
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
