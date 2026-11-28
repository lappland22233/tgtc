import { Injectable, Logger } from '@nestjs/common';
import { Readable } from 'stream';
import { TelegramCopyOwnerType } from '../common/entities/telegram-file-copy.entity';
import {
  DOWNLOAD_ERROR_CODES,
  DownloadResourceCoordinatorService,
  DownloadResourceException,
} from './download-resource-coordinator.service';
import { FileCacheService } from './file-cache.service';
import { TelegramMainChatAnchorService } from '../telegram-mirror/telegram-main-chat-anchor.service';
import { UserAccountDirectoryService, RelayUserAccount } from '../telegram-account-pool/user-account-directory.service';
import { TelegramUserClientError, TelegramUserClientService } from '../telegram-user/telegram-user-client.service';

/** 限流冷却的下限：即使没有 retry_after，也至少冷却这么久，避免立刻重试加剧 flood */
const FLOOD_MIN_COOLDOWN_MS = 60_000;
/**
 * 容量类拒绝的业务码：等待上行预算超时 / 队列满 / 请求取消 / 服务关闭。
 *
 * 这些是**调度容量**信号，与「账号本身能不能用」无关。历史缺陷：`tryOpen` 的
 * 单个 catch 把它们也交给了 `recordFailure`，于是一次等 slot 超时就把唯一的
 * user 账号冷却 60s，随后所有下载全部回退 Bot。
 */
const CAPACITY_ERROR_CODES: ReadonlySet<string> = new Set([
  DOWNLOAD_ERROR_CODES.SERVER_BUSY,
  DOWNLOAD_ERROR_CODES.QUEUE_TIMEOUT,
  DOWNLOAD_ERROR_CODES.QUEUE_FULL,
  DOWNLOAD_ERROR_CODES.QUEUE_CANCELLED,
  DOWNLOAD_ERROR_CODES.SHUTTING_DOWN,
]);

/** 容量类拒绝判定（只有调度器抛出的结构化异常才可能是容量问题） */
function isCapacityError(error: unknown): boolean {
  return error instanceof DownloadResourceException && CAPACITY_ERROR_CODES.has(error.errorCode);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
 *
 * ## 为什么本服务属于 `FileModule`（装配约束，改动前必读）
 *
 * 它的依赖是「开关 + 预算 + 锚点 + 用户账号」四件事的组合，只有 `FileModule` 的
 * 导入图同时闭合这些依赖且不成环：`FileModule` 已导入 `TelegramMirrorModule`（锚点）
 * 与 `TelegramAccountPoolModule`（账号目录），并自行提供 `FileCacheService` /
 * `DownloadResourceCoordinatorService`（开关与预算）。反过来把本服务放进上述任一
 * 模块，都需要该模块反向导入 `FileModule`，直接成环。
 *
 * `FileCacheService` / `DownloadResourceCoordinatorService` **不得改成可选**：
 * 它们是开关与预算的唯一来源，一旦解析失败变成 `null`，`isEnabled()` 恒为 false，
 * 整个能力会静默失效（比启动崩溃更难发现）。
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
    private readonly cacheConfig: FileCacheService,
    private readonly resources: DownloadResourceCoordinatorService,
  ) {}

  /** 开关是否开启（关闭时调用方应直接跳过本服务） */
  isEnabled(): boolean {
    return this.cacheConfig.isPreferUserAccount() === true;
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

    // 先拿到锚点再占槽位：无锚点的文件是多数，不该白白占用账号并发。
    // 选号与占位在同一个同步段完成（见 acquireAccount），并发下载不会抢到同一名额。
    const picked = await this.acquireAccount();
    if (!picked) {
      this.logger.debug(
        `无空闲 user 账号（全部冷却或已达并发上限 ${this.currentMaxStreams()}），回退 Bot 链路`,
      );
      return null;
    }
    const { account, release: releaseSlot } = picked;

    let lease: Awaited<ReturnType<DownloadResourceCoordinatorService['acquireUpstreamSlot']>> | null = null;
    if (!params.upstreamLeaseHeld) {
      // 预算等待与开流**必须分段处理**：等 slot 超时/队满/取消是容量信号，
      // 不得归咎账号（否则一次等待超时就会冷却唯一 user 账号，随后全部回退 Bot）。
      try {
        lease = await this.resources.acquireUpstreamSlot({
          bytes: params.expectedSize,
          // 未持租约的调用方（如 Bot 直链）与直接下载端点共用同一有限等待上限，
          // 不再硬编码 15s：超时后本方法回退 Bot，对用户等价，只是不冷却账号。
          waitTimeoutMs: this.resources.getConfig().directWaitMs,
          signal: params.signal,
        });
      } catch (error) {
        releaseSlot();
        this.logger.debug(
          `user 上行预算等待失败（容量问题，不冷却账号），回退 Bot 链路：${errorMessage(error)}`,
        );
        return null;
      }
    }

    try {
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
      // 客户端取消 / 容量类拒绝都不归咎账号，只回退 Bot。
      if (params.signal?.aborted || isCapacityError(error)) {
        this.logger.debug(
          `user 回源中止（客户端取消或容量问题，不冷却账号），回退 Bot 链路：${errorMessage(error)}`,
        );
        return null;
      }
      this.recordFailure(account, error);
      return null;
    }
  }

  /**
   * 选一个有空闲并发名额的用户账号，并**在同一同步段内占位**。
   *
   * 选号与占位必须原子：`listEnabled()` 是异步的，若先选后占，两个并发下载会
   * 同时选中同一账号并各自把计数读到 1。这里先 await 目录，再在纯同步代码里
   * 过滤 + 递增，中间没有 await，事件循环不会插入其它下载。
   *
   * 选号策略：权重降序，**跳过已达并发上限的账号**——高权重账号占满时应当
   * 转用次高权重的空闲账号，而不是直接回退 Bot 把用户 session 闲置着。
   */
  private async acquireAccount(): Promise<{ account: RelayUserAccount; release: () => void } | null> {
    const accounts = await this.directory.listEnabled();
    if (accounts.length === 0) return null;

    const now = Date.now();
    const maxStreams = this.currentMaxStreams();
    const available = accounts
      .filter((item) => {
        if (!item.session) return false;
        const until = this.cooldownUntil.get(item.id) ?? 0;
        if (until > now) return false;
        return (this.inflight.get(item.id) ?? 0) < maxStreams;
      })
      .sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1));

    const account = available[0];
    if (!account) return null;

    // ↓ 从这里到 return 全是同步代码：占位不会被并发调用穿插
    this.inflight.set(account.id, (this.inflight.get(account.id) ?? 0) + 1);
    // 账号槽位必须活到流结束：`tryOpen` 返回时传输才刚开始，此时释放会让并发下载
    // 在同一个账号上开出远超上限的 MTProto 流。
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const left = (this.inflight.get(account.id) ?? 1) - 1;
      if (left > 0) this.inflight.set(account.id, left);
      else this.inflight.delete(account.id);
    };
    return { account, release };
  }

  /**
   * 单账号并发上限（SystemConfig 热更新即生效）。
   * 异常值（非正/非有限）回退 4：宁可保守，也不要让坏配置把并发变成 0 或无穷。
   */
  private currentMaxStreams(): number {
    const value = Math.floor(this.resources.getConfig().userStreamMaxConcurrency);
    return Number.isFinite(value) && value > 0 ? value : 4;
  }

  /**
   * 记录一次失败：限流按 `retry_after` 进冷却，其余按分类时长。
   * 认证类失败冷却更久（需要人工重新授权，反复重试没有意义）。
   * **容量类拒绝不得到达这里**（见 tryOpen 的分段 catch）。
   */
  private recordFailure(account: RelayUserAccount, error: unknown): void {
    const failure = error instanceof TelegramUserClientError
      ? error
      : new TelegramUserClientError(error instanceof Error ? error.message : String(error), 'other');
    const transientCooldownMs = this.resources.getConfig().userFailureCooldownMs;
    const cooldownMs = failure.kind === 'flood'
      ? Math.max(FLOOD_MIN_COOLDOWN_MS, (failure.retryAfterSeconds ?? 0) * 1000)
      : failure.kind === 'auth'
        ? 30 * 60_000
        : failure.kind === 'permission' || failure.kind === 'not_found'
          ? 10 * 60_000
          : Number.isFinite(transientCooldownMs) && transientCooldownMs > 0
            ? transientCooldownMs
            : 10_000;
    this.cooldownUntil.set(account.id, Date.now() + cooldownMs);
    this.logger.warn(
      `user 账号 ${account.id} 回源失败（${failure.kind}），冷却 ${Math.round(cooldownMs / 1000)}s 后重试：`
      + failure.message,
    );
  }
}
