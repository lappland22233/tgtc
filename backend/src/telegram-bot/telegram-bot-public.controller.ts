import { Controller, Get, HttpException, HttpStatus, Inject, Logger, NotFoundException, Optional, Param, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { createHash, randomUUID } from 'crypto';
import { Readable } from 'stream';
import { TelegramBotFileGrant } from '../common/entities/telegram-bot-file-grant.entity';
import { AccountAwareDownloadService } from '../telegram-account-pool/account-aware-download.service';
import { AccountAwareDownloadFailure } from '../telegram-account-pool/account-aware-stream.types';
import { FileCopyService } from '../telegram-account-pool/file-copy.service';
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
import { DOWNLOAD_ERROR_CODES, DownloadResourceException } from '../file/download-resource-coordinator.service';
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
  private readonly logger = new Logger(TelegramBotPublicController.name);

  constructor(
    private readonly grantService: TelegramBotGrantService,
    private readonly telegramService: TelegramService,
    private readonly fileCacheService: FileCacheService,
    private readonly rateLimitService: RateLimitService,
    private readonly streamResponder: StreamResponderService,
    private readonly auditService: AuditService,
    // 账号池增强（可选）：启用时由账号池按负载选账号回源；未启用时全部走原单账号链路。
    // 必须显式 `@Inject(X)`：`X | null` 联合类型发出的是 `Object`，
    // 否则 `@Optional()` 会把解析失败静默降级成 `null`（池化回源整条链路失效）。
    @Optional() @Inject(AccountAwareDownloadService)
    private readonly accountPoolDownload: AccountAwareDownloadService | null = null,
    @Optional() @Inject(FileCopyService)
    private readonly fileCopies: FileCopyService | null = null,
    @Optional() @Inject(ConfigService)
    private readonly configService: ConfigService | null = null,
  ) {}

  /**
   * 取上游流（账号池感知）。
   *
   * **回退矩阵（安全优先，fail-closed）**：
   *
   * | 条件 | 处理 |
   * | --- | --- |
   * | 账号池未启用 | 原单账号链路（与改造前调用形状逐字一致） |
   * | 池化可用（有 ready 副本） | 加权选号回源；失败换号 ≤3，按错误分类冷却 |
   * | 池化失败，但 `sourceAccountId` 可确认（在池内） | 用**源账号**回源 + 回退计数/告警 |
   * | `sourceAccountId` 不在池内但等于默认 Token 的账号 | 与默认账号同一身份，走原单账号链路 |
   * | 归属不明（`sourceAccountId` 为空或身份无法确认） | **不回退默认账号**，返回可诊断失败 |
   *
   * 为什么必须 fail-closed：`file_id` 按账号隔离，把 A 账号的 `file_id` 交给 B 账号会得到
   * 上游 `Exact file size is unavailable from Telegram`。宁可返回可诊断错误，也不跨账号误用。
   */
  private async acquireUpstreamStream(
    grant: TelegramBotFileGrant,
    expectedSize?: number,
    noCache = false,
    requestId = randomUUID(),
  ): Promise<{ stream: Readable; info: { file_id: string; file_size: number } }> {
    const pool = this.accountPoolDownload;

    if (pool?.isActive()) {
      const failures: { pooled?: AccountAwareDownloadFailure; source?: AccountAwareDownloadFailure } = {};
      const pooled = await this.tryPooledStream(
        pool,
        grant,
        expectedSize,
        noCache,
        (failure) => { failures.pooled = failure; },
      );
      if (pooled) return pooled;

      const fallback = await this.trySourceAccountStream(
        pool,
        grant,
        expectedSize,
        noCache,
        (failure) => { failures.source = failure; },
      );
      if (fallback) return fallback;

      const sourceAccountId = (grant.sourceAccountId || '').trim();
      const failure = failures.source
        ? {
          ...failures.source,
          readyAccountCount: failures.source.readyAccountCount ?? failures.pooled?.readyAccountCount,
          attemptedAccountCount: failures.source.attemptedAccountCount ?? failures.pooled?.attemptedAccountCount,
        }
        : failures.pooled;
      // `sourceAccountId` 已写入但不在当前池内，是可识别的配置/账号不可用，不是身份未知。
      const identityUnknown = !sourceAccountId;
      if (identityUnknown) pool.bumpCounter('unresolved');

      const capacityBusy = failure?.reason === 'source_cooling_down'
        || failure?.reason === 'source_capacity_busy'
        || failure?.reason === 'all_candidates_busy';
      const retryAfterMs = Math.max(5_000, failure?.retryAfterMs ?? 0);
      const errorCode = identityUnknown
        ? DOWNLOAD_ERROR_CODES.SOURCE_ACCOUNT_UNAVAILABLE
        : capacityBusy
          ? DOWNLOAD_ERROR_CODES.ACCOUNT_POOL_BUSY
          : DOWNLOAD_ERROR_CODES.SOURCE_ACCOUNT_UNAVAILABLE;
      const message = identityUnknown
        ? '文件来源账号无法确认；为避免跨账号误用 file_id，暂不提供下载'
        : capacityBusy
          ? '文件来源账号当前繁忙或正在限流，请稍后重试'
          : '文件来源账号暂不可用，请稍后重试';
      this.logger.error(
        `[requestId=${requestId}] Bot grant ${grant.id} 池化回源失败：`
        + `reason=${failure?.reason ?? 'source_identity_unresolved'} `
        + `readyAccounts=${failure?.readyAccountCount ?? 0} `
        + `attemptedAccounts=${failure?.attemptedAccountCount ?? 0} `
        + `sourceAccount=${sourceAccountId || 'unknown'} `
        + `identityUnknown=${identityUnknown}; 拒绝跨账号使用 file_id`,
      );
      throw new DownloadResourceException({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        errorCode,
        message,
        scope: 'upstream',
        queueReason: 'upstream',
        retryAfterMs,
      });
    }

    return this.singleAccountStream(grant, expectedSize, noCache);
  }

  /** 池化回源：锚点定位副本集合 → 加权选号；任何异常都记录后返回 null，交由回退矩阵处理。 */
  private async tryPooledStream(
    pool: AccountAwareDownloadService,
    grant: TelegramBotFileGrant,
    expectedSize?: number,
    noCache = false,
    onUnavailable?: (failure: AccountAwareDownloadFailure) => void,
  ): Promise<{ stream: Readable; info: { file_id: string; file_size: number } } | null> {
    if (!this.fileCopies || !grant.chatId || !grant.messageId) {
      onUnavailable?.({ reason: 'copy_lookup_failed', retryAfterMs: 5_000 });
      return null;
    }
    try {
      // 入站时以 file_unique_id 为主键登记副本，这里用「用户私聊 chat + 消息 id」反查主键。
      // findByAnchor 定位逻辑归属，openStream 会读取该归属下的全部 ready 账号副本。
      const anchor = await this.fileCopies.findByAnchor(String(grant.chatId), String(grant.messageId));
      if (!anchor) {
        onUnavailable?.({ reason: 'no_ready_copies', retryAfterMs: 5_000, readyAccountCount: 0 });
        return null;
      }
      const opened = await pool.openStream({
        ownerType: anchor.ownerType,
        ownerId: anchor.ownerId,
        expectedSize,
        noCache,
        fileName: grant.fileName || 'download',
        onUnavailable,
      });
      return opened ? { stream: opened.stream, info: opened.info } : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onUnavailable?.({ reason: 'copy_lookup_failed', retryAfterMs: 5_000 });
      this.logger.warn(`账号池回源异常，进入源账号回退（grant=${grant.id}）：${message}`);
      return null;
    }
  }

  /**
   * 回退矩阵：仅当「源账号身份可确认」时才回退。
   * 返回 null 表示身份不可确认——调用方据此返回可诊断失败，**绝不使用默认账号**。
   */
  private async trySourceAccountStream(
    pool: AccountAwareDownloadService,
    grant: TelegramBotFileGrant,
    expectedSize?: number,
    noCache = false,
    onUnavailable?: (failure: AccountAwareDownloadFailure) => void,
  ): Promise<{ stream: Readable; info: { file_id: string; file_size: number } } | null> {
    const sourceAccountId = (grant.sourceAccountId || '').trim();
    if (!sourceAccountId) {
      onUnavailable?.({ reason: 'source_account_unknown', retryAfterMs: 5_000 });
      return null;
    }

    if (pool.hasAccount(sourceAccountId)) {
      const opened = await pool.openSourceStream({
        accountId: sourceAccountId,
        fileId: grant.telegramFileId,
        expectedSize,
        noCache,
        onUnavailable,
      });
      if (!opened) return null;
      pool.bumpCounter('fallbacks');
      this.logger.warn(
        `账号池回源失败，已回退到源账号 ${sourceAccountId} 回源（请关注回退率指标）`,
      );
      return { stream: opened.stream, info: opened.info };
    }

    // 源账号不在池内，但与默认 Token 同属一个账号：身份一致，可安全走原单账号链路
    if (sourceAccountId === this.defaultBotId()) {
      this.logger.warn(
        `源账号 ${sourceAccountId} 不在账号池内，但等于默认 Bot Token 的账号，按单账号链路回源`,
      );
      return this.singleAccountStream(grant, expectedSize, noCache);
    }

    onUnavailable?.({ reason: 'source_account_unknown', retryAfterMs: 5_000 });
    return null;
  }

  /**
   * 原单账号链路。
   * 严格保持改造前的调用形状（含 noCache 语义与实参个数），
   * 确保「关闭开关 = 原行为」不被本次改造改变。
   */
  private async singleAccountStream(
    grant: TelegramBotFileGrant,
    expectedSize?: number,
    noCache = false,
  ): Promise<{ stream: Readable; info: { file_id: string; file_size: number } }> {
    if (noCache) {
      return this.telegramService.getRealtimeFileStream(grant.telegramFileId, expectedSize, { noCache: true });
    }
    return expectedSize === undefined
      ? this.telegramService.getRealtimeFileStream(grant.telegramFileId)
      : this.telegramService.getRealtimeFileStream(grant.telegramFileId, expectedSize);
  }

  /** 默认 Bot Token 的账号 ID（botId）；无法解析（未配置/占位符）时返回 null。 */
  private defaultBotId(): string | null {
    const token = (this.configService?.get<string>('TELEGRAM_BOT_TOKEN') || '').trim();
    const botId = token.split(':')[0]?.trim();
    return botId && /^\d+$/.test(botId) ? botId : null;
  }

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
    const requestId = randomUUID();
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
      const fetchFn = () => this.acquireUpstreamStream(grant, expectedSize, true, requestId);

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
        //
        // 同样传 noCache=true：本分支**不产生任何本地持久副本**（不落盘、不进正式缓存），
        // 因此 TDLib workdir 里的本地媒体副本在本次流结束后应立即回收。
        // 此前该分支漏传该头（与同控制器其余分支不一致），未知大小的文件每下完一次
        // 就在 workdir 里长期占一份完整副本——而这份副本无人使用、也无缓存可替代它。
        stream = await this.fileCacheService.getDirectOnlyStream(cacheKey, () =>
          this.acquireUpstreamStream(grant, undefined, true, requestId),
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
          requestId,
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
          requestId,
          success: false,
          terminationReason,
          reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        },
      });
      this.streamResponder.handleError(res, error, '文件下载失败，请稍后重试', req, requestId);
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
