import { Injectable, Logger } from '@nestjs/common';
import { Readable } from 'stream';
import { TelegramCopyOwnerType } from '../common/entities/telegram-file-copy.entity';
import { AccountAwareDownloadFailure, AccountAwareStreamResult } from './account-aware-stream.types';
import { AccountAttemptAdmission, AccountAttemptSample, AccountPoolCounterKey } from './telegram-account-pool.types';
import { TelegramAccountClientService, TelegramAccountError } from './telegram-account-client.service';
import { TelegramAccountPoolService } from './telegram-account-pool.service';
import { FileCopyService } from './file-copy.service';

/** 单次下载最多尝试的 ready 副本账号数；副本表正常情况下每逻辑文件最多 8 个账号 */
const MAX_ACCOUNT_ATTEMPTS = 8;
/** 账号容量满载时向客户端建议的最小重试间隔 */
const CAPACITY_RETRY_AFTER_MS = 5_000;
/** 大文件阈值（字节）：与账号池的每账号大文件回源槽位口径保持一致（>1GiB） */
const LARGE_FILE_THRESHOLD_BYTES = 1024 ** 3;

/** 是否为大文件（非有限值/非正数一律按小文件处理，避免误占大文件槽位） */
function isLargeFile(bytes?: number): boolean {
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes > LARGE_FILE_THRESHOLD_BYTES;
}

/**
 * 账号感知的下载（回源）入口。
 *
 * 这是「按负载选择其中一个 Bot 回源」的落地点：
 * 1. 取出该逻辑文件的**全部 ready 副本**（每副本对应一个账号的 file_id）；
 * 2. 由账号池按「带宽 × 健康度 × 容量」加权选出账号；
 * 3. 用该账号打开流；失败（限流/文件不可用/超时）→ 账号进入冷却 → **换下一个账号**；
 * 4. 传输结束后把字节数/耗时回报账号池，带宽 EWMA 实时更新。
 *
 * 两条约束（安全与可用性）：
 * - **本服务不执行扩散、不搬字节**：副本扩散由「提交即触发」+「下载期懒触发补齐」负责
 *   （后者只在副本不足时补建镜像任务，零字节，见 `TelegramMirrorLazyTriggerService`）；
 *   本服务只负责在**已有副本**之间按负载选号回源，绝不在此处补副本、也绝不参与扩散时机判定
 *   ——否则「谁下载谁触发」会让扩散时机不可预测、也无法在后台按镜像群统计；
 * - **不替调用方做跨账号兜底**：本服务返回 `null` 表示「本服务无法回源」，是否回退到源账号
 *   或返回可诊断失败由调用方按回退矩阵决定（归属不明时绝不回退默认账号）。
 */
@Injectable()
export class AccountAwareDownloadService {
  private readonly logger = new Logger(AccountAwareDownloadService.name);

  constructor(
    private readonly pool: TelegramAccountPoolService,
    private readonly client: TelegramAccountClientService,
    private readonly copies: FileCopyService,
  ) {}

  isActive(): boolean {
    return this.pool.isActive();
  }

  /** 未生效原因（用于区分「服务健康」与「账号池已启用但未生效」） */
  inactiveReason(): string | null {
    return this.pool.inactiveReason();
  }

  /** 池内是否存在该账号（回退矩阵判定「源账号身份是否可确认」） */
  hasAccount(accountId: string): boolean {
    return Boolean(this.pool.getConfig(accountId));
  }

  /** 计数透传（诊断与告警用） */
  bumpCounter(key: AccountPoolCounterKey, delta = 1): void {
    this.pool.bumpCounter(key, delta);
  }

  /**
   * 打开回源流（按负载选号 + 失败换号）。
   *
   * 只使用**已有**副本：扩散由镜像任务负责（主群 → userbot → 各镜像群），
   * 无副本时返回 `no_ready_copies` 交由调用方走回退矩阵；老文件的副本补齐发生在
   * **调用方之前**（`file` 层的懒触发只建单），本服务不做扩散判定、不搬字节。
   */
  async openStream(params: {
    ownerType: TelegramCopyOwnerType;
    ownerId: string;
    expectedSize?: number;
    noCache?: boolean;
    fileName?: string;
    onUnavailable?: (failure: AccountAwareDownloadFailure) => void;
  }): Promise<AccountAwareStreamResult | null> {
    if (!this.pool.isActive()) {
      params.onUnavailable?.({ reason: 'pool_inactive', retryAfterMs: 5_000 });
      return null;
    }

    const ready = await this.copies.listReady(params.ownerType, params.ownerId);
    const readyAccountIds = Array.from(new Set(ready.map((copy) => copy.accountId)));
    if (readyAccountIds.length === 0) {
      params.onUnavailable?.({ reason: 'no_ready_copies', retryAfterMs: 5_000, readyAccountCount: 0 });
      return null;
    }

    const excluded = new Set<string>();
    let lastFailure: AccountAwareDownloadFailure = { reason: 'all_candidates_busy', retryAfterMs: 5_000 };
    let attempts = 0;
    // 每个持有 ready 副本的账号最多尝试一次；容量拒绝时立即切下一个，不等待槽位释放。
    const maxAttempts = Math.min(MAX_ACCOUNT_ATTEMPTS, readyAccountIds.length);
    // 大文件（>1GiB）回源：选号时排除已达槽位的账号，原子准入时再复核。
    const largeFile = isLargeFile(params.expectedSize);
    while (attempts < maxAttempts) {
      const candidateIds = readyAccountIds.filter((accountId) => !excluded.has(accountId));
      if (candidateIds.length === 0) break;

      const selection = this.pool.select(candidateIds, Date.now(), { largeFile });
      if (!selection) {
        lastFailure = this.describeUnavailableCandidates(candidateIds);
        break;
      }

      const account = this.pool.getConfig(selection.accountId);
      const copy = ready.find((item) => item.accountId === selection.accountId);
      if (!account || !copy) {
        excluded.add(selection.accountId);
        lastFailure = { reason: 'all_candidates_busy', retryAfterMs: 5_000 };
        continue;
      }

      attempts += 1;
      const admission = this.pool.admit({
        accountId: account.id,
        role: 'download',
        bytes: params.expectedSize,
      });
      if (!admission.granted || !admission.admission) {
        if (admission.reason === 'large_inflight_full') this.pool.bumpCounter('largeFileSlotThrottled');
        lastFailure = { reason: 'all_candidates_busy', retryAfterMs: admission.retryAfterMs ?? CAPACITY_RETRY_AFTER_MS };
        excluded.add(account.id);
        this.logger.debug(
          `账号 ${account.id} 准入被拒（${admission.reason ?? 'unknown'}），换下一个候选账号`,
        );
        continue;
      }

      if (attempts > 1) this.pool.bumpCounter('failovers');
      this.pool.bumpCounter('selections');

      try {
        const session = await this.client.openRealtimeStream(
          account.id,
          account.token,
          copy.telegramFileId,
          params.expectedSize,
          { noCache: params.noCache },
        );
        this.attachSampling(admission.admission, session.stream, session.sample);
        void this.copies.touchUsed(copy);
        this.logger.log(
          `按负载选择账号 ${account.id} 回源（${params.ownerType}:${params.ownerId}，依据 ${selection.reason}）`,
        );
        return {
          stream: session.stream,
          info: session.info,
          accountId: account.id,
          copy,
          selectionReason: selection.reason,
        };
      } catch (error) {
        this.pool.bumpCounter('streamFailures');
        this.finishFailed(admission.admission, error);
        excluded.add(account.id);
        lastFailure = {
          reason: 'upstream_attempts_failed',
          retryAfterMs: error instanceof TelegramAccountError && error.retryAfterSeconds
            ? error.retryAfterSeconds * 1000
            : 5_000,
        };
        this.logger.warn(
          `账号 ${account.id} 回源失败（${error instanceof TelegramAccountError ? error.kind : 'other'}），尝试换号：`
          + `${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
        );
      }
    }

    params.onUnavailable?.({
      ...lastFailure,
      readyAccountCount: readyAccountIds.length,
      attemptedAccountCount: attempts,
    });
    return null;
  }

  /**
   * 用**指定账号（源账号）**回源：不参与加权选择，只使用该账号自己的 `file_id`。
   *
   * 用途：池化选号失败（全池不可用/副本表异常）但源账号身份可确认时的安全回退
   * ——这是「不把 A 账号的 file_id 交给 B 账号」的关键。
   */
  async openSourceStream(params: {
    accountId: string;
    fileId: string;
    expectedSize?: number;
    noCache?: boolean;
    onUnavailable?: (failure: AccountAwareDownloadFailure) => void;
  }): Promise<AccountAwareStreamResult | null> {
    const account = this.pool.getConfig(params.accountId);
    if (!account) {
      params.onUnavailable?.({ reason: 'source_account_unknown', retryAfterMs: 5_000 });
      return null;
    }
    // 尊重运维的下线意图：被禁用的账号不再用于回源，不误报为归属未知。
    if (!account.enabled) {
      this.logger.warn(`源账号 ${account.id} 已被禁用，跳过源账号回退`);
      params.onUnavailable?.({ reason: 'source_account_disabled', retryAfterMs: 5_000 });
      return null;
    }

    // 源账号兜底也遵守硬限制：冷却或满载立即拒绝；不等待，不绕过配额。
    const bytes = params.expectedSize;
    const admission = this.pool.admit({ accountId: account.id, role: 'download', bytes });
    if (!admission.granted) {
      if (admission.reason === 'cooling_down') {
        this.pool.bumpCounter('fallbackThrottled');
        this.logger.warn(
          `源账号 ${account.id} 正在限流冷却（剩余 ${Math.round((admission.retryAfterMs ?? 0) / 1000)}s），`
          + '拒绝源账号兜底以免延长冷却',
        );
        params.onUnavailable?.({
          reason: 'source_cooling_down',
          retryAfterMs: Math.max(5_000, admission.retryAfterMs ?? 0),
        });
        return null;
      }
      if (admission.reason === 'large_inflight_full') this.pool.bumpCounter('largeFileSlotThrottled');
      this.pool.bumpCounter('fallbackThrottled');
      this.logger.warn(`源账号 ${account.id} 满载（${admission.reason ?? 'unknown'}），立即拒绝兜底`);
      params.onUnavailable?.({
        reason: 'source_capacity_busy',
        retryAfterMs: Math.max(CAPACITY_RETRY_AFTER_MS, admission.retryAfterMs ?? 0),
      });
      return null;
    }
    const granted = admission.admission;
    if (!granted) return null;

    try {
      const session = await this.client.openRealtimeStream(
        account.id,
        account.token,
        params.fileId,
        params.expectedSize,
        { noCache: params.noCache },
      );
      this.attachSampling(granted, session.stream, session.sample);
      return {
        stream: session.stream,
        info: session.info,
        accountId: account.id,
        copy: null,
        selectionReason: 'source-account-fallback',
      };
    } catch (error) {
      this.pool.bumpCounter('streamFailures');
      this.finishFailed(granted, error);
      this.logger.warn(
        `源账号 ${account.id} 回退回源失败：`
        + `${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
      );
      params.onUnavailable?.({
        reason: 'source_stream_failed',
        retryAfterMs: error instanceof TelegramAccountError && error.retryAfterSeconds
          ? error.retryAfterSeconds * 1000
          : CAPACITY_RETRY_AFTER_MS,
      });
      return null;
    }
  }

  /** 记录一次失败的尝试（按错误分类进入冷却），并归还该次准入额度 */
  private finishFailed(admission: AccountAttemptAdmission, error: unknown): void {
    const accountError = error instanceof TelegramAccountError ? error : null;
    admission.finish({
      ok: false,
      failureKind: accountError?.kind ?? 'other',
      status: accountError?.status,
      retryAfterSeconds: accountError?.retryAfterSeconds,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  /** 把采样回报绑定到流的结束事件上（保证成功与失败都能更新账号画像，且只回报一次） */
  private attachSampling(
    admission: AccountAttemptAdmission,
    stream: Readable,
    sample: () => AccountAttemptSample,
  ): void {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      admission.finish(sample());
    };
    stream.once('close', settle);
    stream.once('end', settle);
    stream.once('error', settle);
  }

  private describeUnavailableCandidates(accountIds: string[]): AccountAwareDownloadFailure {
    const relevant = this.pool.snapshot().accounts.filter((item) => accountIds.includes(item.id));
    const enabled = relevant.filter((item) => item.enabled);
    const cooling = enabled.filter((item) => item.coolingDown);
    const retryAfterMs = cooling.length > 0 && cooling.length === enabled.length
      ? Math.max(CAPACITY_RETRY_AFTER_MS, Math.min(...cooling.map((item) => item.cooldownRemainingMs)))
      : CAPACITY_RETRY_AFTER_MS;
    return {
      reason: 'all_candidates_busy',
      retryAfterMs,
      readyAccountCount: accountIds.length,
    };
  }

}
