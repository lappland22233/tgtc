import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Readable } from 'stream';
import { TelegramCopyOwnerType } from '../common/entities/telegram-file-copy.entity';
import { DownloadResourceCoordinatorService } from '../file/download-resource-coordinator.service';
import { FileCacheService } from '../file/file-cache.service';
import { TelegramMainChatAnchorService } from '../telegram-mirror/telegram-main-chat-anchor.service';
import { UserAccountDirectoryService, RelayUserAccount } from './user-account-directory.service';
import { TelegramUserClientError, TelegramUserClientService } from '../telegram-user/telegram-user-client.service';

/** 用户账号级冷却的默认时长（无 retry_after 时的保守值） */
const DEFAULT_COOLDOWN_MS = 60_000;
/** 单账号并发上限：MTProto 单 session 并发过高会被限流，这里保守取 2 */
const MAX_CONCURRENT_STREAMS = 2;

/**
 * 下载时「优先使用 Premium 用户账号（MTProto）回源」。
 *
 * 这是**临时能力**（30 天回退窗口）：开关 `DOWNLOAD_PREFER_USER_ACCOUNT` 关闭时
 * 本服务完全不介入，下载行为与改造前逐字节一致。
 *
 * 三条不可违背的约束：
 * 1. **fail-open**：无开关 / 无账号 / 无锚点 / 取流失败，一律返回 null 让调用方
 *    回退现有 Bot 链路。下载绝不能因为这条新路径而报错或变慢（除命中时）。
 * 2. **user 账号读不到 Bot 私聊**：锚点必须是主群（群/频道）里的消息，
 *    由 `TelegramMainChatAnchorService.findReadyAnchorForDownload` 只读提供。
 * 3. **共享上行预算**：取流前必须占 `DownloadResourceCoordinatorService` 的 slot，
 *    否则会与前台下载抢带宽——而本能力的初衷恰恰是改善下载。
 */
@Injectable()
export class UserPreferredDownloadService {
  private readonly logger = new Logger(UserPreferredDownloadService.name);
  /** 账号级冷却（accountId → 到期时间戳） */
  private readonly cooldownUntil = new Map<string, number>();
  /** 账号级在飞流数（进程内；单实例是部署硬约束） */
  private readonly inflight = new Map<string, number>();

  constructor(
    private readonly userClient: TelegramUserClientService,
    private readonly directory: UserAccountDirectoryService,
    private readonly anchors: TelegramMainChatAnchorService,
    @Optional() @Inject(FileCacheService)
    private readonly cacheConfig: FileCacheService | null = null,
    @Optional() @Inject(DownloadResourceCoordinatorService)
    private readonly resources: DownloadResourceCoordinatorService | null = null,
  ) {}

  /** 开关是否开启（关闭时调用方应直接跳过本服务） */
  isEnabled(): boolean {
    return this.cacheConfig?.isPreferUserAccount() === true;
  }

  /**
   * 尝试用 user 账号开流。**任何失败都返回 null**，由调用方继续 Bot 链路。
   *
   * @param ownerType 归属命名空间（`file` 用于站内文件，`grant` 用于 Bot 直链）
   * @param ownerId 对应归属 ID
   * @param expectedSize 已知文件大小（用于预算权重与完整性校验）
   * @param signal 客户端取消信号
   */
  async tryOpen(params: {
    ownerType: TelegramCopyOwnerType;
    ownerId: string;
    expectedSize?: number;
    signal?: AbortSignal;
    /**
     * 调用方**已经持有**上行租约（例如镜像重试路径先申请了预算）。
     * 此时不得再申请第二次：两次同权重申请会在预算 8 时互相等待到超时，
     * 白白让本次下载冷却并回退。
     */
    upstreamLeaseHeld?: boolean;
    /** `file` 归属的当前源消息，用于拒绝指向旧版本的锚点 */
    expectedSourceMessageId?: string | null;
  }): Promise<{ stream: Readable; info: { file_id: string; file_size: number } } | null> {
    if (!this.isEnabled()) return null;
    if (!this.userClient.isAvailable()) return null;

    const account = await this.pickAccount().catch(() => null);
    if (!account) return null;

    const anchor = await this.anchors.findReadyAnchorForDownload(
      params.ownerType,
      params.ownerId,
      params.expectedSourceMessageId,
    );
    if (!anchor) {
      // 无锚点是常态（文件没跑过镜像扩散），不记失败、不打 warn，避免刷日志
      this.logger.debug(
        `无 user 可读锚点，回退 Bot 链路（${params.ownerType}:${params.ownerId}）`,
      );
      return null;
    }

    const current = this.inflight.get(account.id) ?? 0;
    if (current >= MAX_CONCURRENT_STREAMS) {
      this.logger.debug(`user 账号 ${account.id} 已达并发上限 ${MAX_CONCURRENT_STREAMS}，回退 Bot 链路`);
      return null;
    }

    let lease: Awaited<ReturnType<DownloadResourceCoordinatorService['acquireUpstreamSlot']>> | null = null;
    this.inflight.set(account.id, current + 1);
    // 账号槽位必须活到流结束：`tryOpen` 返回时传输才刚开始，此时释放会让并发下载
    // 在同一个账号上开出远超上限的 MTProto 流。
    let slotReleased = false;
    const releaseSlot = (): void => {
      if (slotReleased) return;
      slotReleased = true;
      const left = (this.inflight.get(account.id) ?? 1) - 1;
      if (left > 0) this.inflight.set(account.id, left);
      else this.inflight.delete(account.id);
    };
    try {
      // 与前台下载共用全局上行预算：按真实体量申请权重。
      // 调用方已持租约时直接复用，避免嵌套申请互相等待。
      lease = this.resources && !params.upstreamLeaseHeld
        ? await this.resources.acquireUpstreamSlot({
          bytes: params.expectedSize,
          waitTimeoutMs: 15_000,
          signal: params.signal,
        })
        : null;

      const opened = await this.userClient.openUserStream(
        { apiId: account.apiId, apiHash: account.apiHash, session: account.session },
        {
          chatId: anchor.chatId,
          messageId: anchor.messageId,
          expectedSize: params.expectedSize,
          signal: params.signal,
        },
      );

      this.logger.log(
        `user 账号 ${account.id} 回源命中（owner=${params.ownerType}:${params.ownerId}，`
        + `reason=prefer_user_account，chat=${anchor.chatId}）`,
      );
      // 成功路径：预算与账号槽位都交给流的生命周期回收
      const releaseAll = (): void => {
        lease?.release();
        lease = null;
        releaseSlot();
      };
      opened.stream.once('end', releaseAll);
      opened.stream.once('error', releaseAll);
      opened.stream.once('close', releaseAll);
      return {
        stream: opened.stream,
        info: {
          file_id: `${params.ownerType}:${params.ownerId}`,
          file_size: opened.size ?? params.expectedSize ?? 0,
        },
      };
    } catch (error) {
      lease?.release();
      lease = null;
      releaseSlot();
      this.recordFailure(account, error);
      return null;
    }
  }

  /** 选一个可用的用户账号：权重降序、跳过冷却中的 */
  private async pickAccount(): Promise<RelayUserAccount | null> {
    const accounts = await this.directory.listEnabled();
    if (accounts.length === 0) return null;
    const now = Date.now();
    const available = accounts
      .filter((item) => {
        if (!item.session) return false;
        const until = this.cooldownUntil.get(item.id) ?? 0;
        return until <= now;
      })
      .sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1));
    return available[0] ?? null;
  }

  /**
   * 记录一次失败：限流按 `retry_after` 进冷却，其余按保守默认值。
   * 认证类失败冷却更久（需要人工重新授权，反复重试没有意义）。
   */
  private recordFailure(account: RelayUserAccount, error: unknown): void {
    const failure = error instanceof TelegramUserClientError
      ? error
      : new TelegramUserClientError(error instanceof Error ? error.message : String(error), 'other');
    const cooldownMs = failure.kind === 'flood'
      ? Math.max(DEFAULT_COOLDOWN_MS, (failure.retryAfterSeconds ?? 0) * 1000)
      : failure.kind === 'auth'
        ? 30 * 60_000
        : failure.kind === 'permission' || failure.kind === 'not_found'
          ? 10 * 60_000
          : DEFAULT_COOLDOWN_MS;
    this.cooldownUntil.set(account.id, Date.now() + cooldownMs);
    this.logger.warn(
      `user 账号 ${account.id} 回源失败（${failure.kind}），冷却 ${Math.round(cooldownMs / 1000)}s 后重试：`
      + failure.message,
    );
  }
}
