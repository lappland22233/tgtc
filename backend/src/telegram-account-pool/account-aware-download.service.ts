import { Injectable, Logger } from '@nestjs/common';
import { Readable } from 'stream';
import { TelegramCopyOwnerType } from '../common/entities/telegram-file-copy.entity';
import { AccountAwareStreamResult } from './account-aware-stream.types';
import { AccountAttemptAdmission, AccountAttemptSample, AccountPoolCounterKey } from './telegram-account-pool.types';
import { TelegramAccountClientService, TelegramAccountError } from './telegram-account-client.service';
import { TelegramAccountPoolService } from './telegram-account-pool.service';
import { FileCopyService } from './file-copy.service';

/** 单次下载最多尝试的账号数（失败换号），避免长尾把请求拖死 */
const MAX_ACCOUNT_ATTEMPTS = 3;
/** 全部候选都在冷却时的最大等待（超过此值不再等待，交由上层回退判定） */
const MAX_COOLDOWN_WAIT_MS = 3_000;
/** 后台扩散失败后的退避窗口（防止持续失败随下载量放大上传请求） */
const REPLICATION_FAILURE_BACKOFF_MS = 5 * 60 * 1000;
/** 退避表清理阈值（超过该规模才做一次过期清理，避免每轮遍历） */
const REPLICATION_BACKOFF_PRUNE_THRESHOLD = 1024;
/**
 * 源账号兜底的**应急配额**等待上限（毫秒）。
 *
 * 语义变化（2026-09 计划 P2）：源账号兜底从「完全不检查冷却/在飞」改为受限应急配额。
 * 满载（或大文件槽位被占）时先做一次有限等待：等到了就用源账号回源（保住可用性），
 * 等不到就返回带 `Retry-After` 的可诊断失败——绝不在该账号冷却期间硬打。
 */
const SOURCE_FALLBACK_WAIT_MS = 3_000;
/** 源兜底等待的重试间隔（毫秒）：避免忙等，同时保证有限等待内能抓住释放窗口 */
const SOURCE_FALLBACK_POLL_MS = 250;
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
 * - **非阻断懒扩散**：副本不足时只在后台触发复制，不等待复制完成——首个字节不被上传带宽阻塞；
 * - **不替调用方做跨账号兜底**：本服务返回 `null` 表示「本服务无法回源」，是否回退到源账号
 *   或返回可诊断失败由调用方按回退矩阵决定（归属不明时绝不回退默认账号）。
 */
@Injectable()
export class AccountAwareDownloadService {
  private readonly logger = new Logger(AccountAwareDownloadService.name);
  /** 后台扩散去重（同一逻辑文件只保留一个扩散任务） */
  private readonly replicationInflight = new Set<string>();
  /**
   * 扩散失败后的退避截止时间（key=ownerType:ownerId）。
   *
   * 为什么需要背压：副本不足时每次下载都会触发一次扩散；若目标账号存储 Chat 无效/无权限，
   * 持续失败会随下载量线性放大上传请求（每次最多 4 个目标）。失败即进入退避窗口，
   * 避免无限放大上游请求（与「换号次数有限」同一原则）。
   */
  private readonly replicationBackoffUntil = new Map<string, number>();

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
   * @param desiredReplicas 期望副本数（不足时**后台**懒扩散，不阻塞本次）
   */
  async openStream(params: {
    ownerType: TelegramCopyOwnerType;
    ownerId: string;
    expectedSize?: number;
    noCache?: boolean;
    fileName?: string;
    desiredReplicas?: number;
  }): Promise<AccountAwareStreamResult | null> {
    if (!this.pool.isActive()) return null;

    let ready = await this.copies.listReady(params.ownerType, params.ownerId);
    if (ready.length === 0) return null;

    // 懒扩散：下载时才补齐副本，但**不等待**——先把现有副本服务出去（非阻断）。
    if (
      params.desiredReplicas
      && ready.length < params.desiredReplicas
      && params.fileName
      && params.expectedSize
    ) {
      this.scheduleReplication({
        ownerType: params.ownerType,
        ownerId: params.ownerId,
        fileName: params.fileName,
        expectedSize: params.expectedSize,
        desiredCount: params.desiredReplicas,
      });
    }

    const excluded = new Set<string>();
    // 大文件（>1GiB）回源：选号时即排除「已达每账号大文件槽位」的账号，
    // 准入再用同一口径复核——两处一致才能既避免无效尝试，又保证不会被并发绕开。
    const largeFile = isLargeFile(params.expectedSize);
    for (let attempt = 0; attempt < MAX_ACCOUNT_ATTEMPTS; attempt += 1) {
      const candidateIds = ready
        .map((copy) => copy.accountId)
        .filter((accountId) => !excluded.has(accountId));
      if (candidateIds.length === 0) break;

      const selection = this.pool.select(candidateIds, Date.now(), { largeFile });
      if (!selection) {
        // 全部候选都在冷却/满载：等待最短冷却后重试一次，仍不可用则交由上层回退
        const waitMs = this.shortestCooldownMs(candidateIds);
        if (waitMs > 0 && waitMs <= MAX_COOLDOWN_WAIT_MS && attempt < MAX_ACCOUNT_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        break;
      }

      const account = this.pool.getConfig(selection.accountId);
      const copy = ready.find((item) => item.accountId === selection.accountId);
      if (!account || !copy) break;

      // 原子准入（冷却 + 在飞 + 大文件槽位）；被拒时记可诊断计数并按建议间隔决定是否继续换号
      const admission = this.pool.admit({
        accountId: account.id,
        role: 'download',
        bytes: params.expectedSize,
      });
      if (!admission.granted || !admission.admission) {
        if (admission.reason === 'large_inflight_full') this.pool.bumpCounter('largeFileSlotThrottled');
        excluded.add(account.id);
        this.logger.debug(
          `账号 ${account.id} 准入被拒（${admission.reason ?? 'unknown'}），换下一个候选账号`,
        );
        continue;
      }

      if (attempt > 0) this.pool.bumpCounter('failovers');
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
        // 失败样本必须由该次准入归还（禁止同时调用 release，否则在飞额度会被双重扣减，
        // 让账号看起来比实际空闲——这正是「限流保护被绕过」的一类隐蔽成因）
        this.finishFailed(admission.admission, error);
        excluded.add(account.id);
        this.logger.warn(
          `账号 ${account.id} 回源失败（${error instanceof TelegramAccountError ? error.kind : 'other'}），尝试换号：`
          + `${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
        );
      }
    }

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
  }): Promise<AccountAwareStreamResult | null> {
    const account = this.pool.getConfig(params.accountId);
    if (!account) return null;
    // 尊重运维的下线意图：被禁用的账号不再用于回源（fail-closed，宁可返回可诊断失败）。
    if (!account.enabled) {
      this.logger.warn(`源账号 ${account.id} 已被禁用，跳过源账号回退（将按归属不明处理）`);
      return null;
    }

    // **受限应急配额**（2026-09 计划 P2 的核心改动）：
    // 历史实现对本路径完全不检查冷却与在飞上限，理由是「超额使用同一账号没有跨账号风险」。
    // 生产证明这个理由不成立：源账号正是那个已经独扛全部 4GB 回源的账号，在它被 DC-5
    // 限流（`flood` 冷却中）时继续硬打，会把冷却窗口不断延长，形成
    // 「越限流越重试 → 越重试越限流」的正反馈。现在的语义是：
    // - 冷却期间**一律拒绝**（不再硬打，返回 null 交由上层给可诊断失败/Retry-After）；
    // - 满载（在飞/大文件槽位）时做一次**有限等待**：等到了仍走源账号（保住可用性），
    //   等不到同样拒绝——这里绝不阻塞到上层超时。
    const bytes = params.expectedSize;
    const deadline = Date.now() + SOURCE_FALLBACK_WAIT_MS;
    let admission = this.pool.admit({ accountId: account.id, role: 'download', bytes });
    while (!admission.granted) {
      // 冷却中只能等冷却结束：这类拒绝是「保护」而非「拥塞」，不做补救性重试
      if (admission.reason === 'cooling_down') {
        this.pool.bumpCounter('fallbackThrottled');
        this.logger.warn(
          `源账号 ${account.id} 正在限流冷却（剩余 ${Math.round((admission.retryAfterMs ?? 0) / 1000)}s），`
          + '拒绝源账号兜底以免延长冷却',
        );
        return null;
      }
      if (admission.reason === 'large_inflight_full') this.pool.bumpCounter('largeFileSlotThrottled');
      if (Date.now() >= deadline) {
        this.pool.bumpCounter('fallbackThrottled');
        this.logger.warn(
          `源账号 ${account.id} 满载（${admission.reason ?? 'unknown'}），等待 ${SOURCE_FALLBACK_WAIT_MS}ms 后仍无法兜底`,
        );
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, SOURCE_FALLBACK_POLL_MS));
      admission = this.pool.admit({ accountId: account.id, role: 'download', bytes });
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
      return null;
    }
  }

  /** 后台触发副本扩散（去重 + 失败退避 + 失败不影响当前下载） */
  private scheduleReplication(params: {
    ownerType: TelegramCopyOwnerType;
    ownerId: string;
    fileName: string;
    expectedSize: number;
    desiredCount: number;
  }): void {
    const key = `${params.ownerType}:${params.ownerId}`;
    const now = Date.now();

    // 熔断窗口内不再触发：目标账号存储 Chat 无效时，持续失败会随下载量放大上传请求
    if ((this.replicationBackoffUntil.get(key) ?? 0) > now) return;
    if (this.replicationInflight.has(key)) return;

    this.pruneReplicationBackoff(now);
    this.replicationInflight.add(key);
    void this.copies.ensureCopies({
      ownerType: params.ownerType,
      ownerId: params.ownerId,
      fileName: params.fileName,
      expectedSize: params.expectedSize,
      desiredCount: params.desiredCount,
    }).then((result) => {
      // 本轮一个都没成功、且存在失败 → 进入退避窗口
      if (result.failed.length > 0 && result.created.length === 0) {
        this.replicationBackoffUntil.set(key, Date.now() + REPLICATION_FAILURE_BACKOFF_MS);
        this.logger.warn(
          `后台副本扩散未成功（${key}，失败 ${result.failed.length} 个目标），`
          + `${REPLICATION_FAILURE_BACKOFF_MS / 60_000} 分钟内暂停该文件的扩散`,
        );
      }
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.replicationBackoffUntil.set(key, Date.now() + REPLICATION_FAILURE_BACKOFF_MS);
      this.logger.warn(`后台副本扩散异常（不影响当前下载，已退避）: ${message}`);
    }).finally(() => {
      this.replicationInflight.delete(key);
    });
  }

  /** 清理过期退避记录，避免 Map 无界增长（仅在规模较大时做一次遍历） */
  private pruneReplicationBackoff(now: number): void {
    if (this.replicationBackoffUntil.size < REPLICATION_BACKOFF_PRUNE_THRESHOLD) return;
    for (const [key, until] of this.replicationBackoffUntil) {
      if (until <= now) this.replicationBackoffUntil.delete(key);
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

  private shortestCooldownMs(accountIds: string[]): number {
    const snapshot = this.pool.snapshot();
    const relevant = snapshot.accounts.filter((item) => accountIds.includes(item.id) && item.coolingDown);
    if (relevant.length === 0) return 0;
    return Math.min(...relevant.map((item) => item.cooldownRemainingMs));
  }
}
