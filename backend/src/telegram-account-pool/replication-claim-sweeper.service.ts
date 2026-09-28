import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ReplicationAttemptService } from './replication-attempt.service';
import { FileCopyService } from './file-copy.service';
import { ReplicaTargetResolver } from './replica-target.resolver';
import { TelegramAccountPoolService } from './telegram-account-pool.service';

/** 清扫周期：认领到达的典型延迟是秒级，30s 足够；过密只会白白查库 */
const SWEEP_INTERVAL_MS = 30_000;
/** 单轮最多结算的轮次数（避免一次清扫占用过久；积压会在下一轮继续处理） */
const SWEEP_BATCH_LIMIT = 50;

/**
 * 认领窗口清扫：把「中继成功、等待群内 Bot 认领」的轮次结算到终态。
 *
 * ## 为什么必须存在
 *
 * 扩散完成的口径是「镜像群内各 Bot 各自认领到副本」，而**转发成功本身不算完成**。
 * 改造前这件事由「下载期懒扩散」顺带完成（下次有人下载时才结算），
 * 现在下载路径不再触发扩散——若无人清扫，`waiting_claims` 会**永久停放**，
 * 后台看到的是「中继成功但永远没有结论」，认领超时告警也永远不会触发。
 *
 * ## 边界
 *
 * - 只读副本表 + 只写轮次表，不触发任何转发：**不产生新的执行路径**；
 * - 仓库读失败只记日志（degraded）并等下一轮，绝不因为观测故障影响下载/扩散；
 * - 结算口径复用 `ReplicationAttemptService.settleClaims`（新增 ≥1 = partial_success，
 *   达到目标数 = succeeded，零新增 = claim_timeout）。
 */
@Injectable()
export class ReplicationClaimSweeperService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ReplicationClaimSweeperService.name);
  private timer: NodeJS.Timeout | null = null;
  /** 重入保护：上一轮未跑完时跳过本轮 */
  private running = false;

  constructor(
    private readonly attempts: ReplicationAttemptService,
    private readonly copies: FileCopyService,
    private readonly replicaTargets: ReplicaTargetResolver,
    private readonly pool: TelegramAccountPoolService,
  ) {}

  onModuleInit(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweepOnce(); }, SWEEP_INTERVAL_MS);
    // 不因为清扫定时器阻止进程退出
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 执行一轮清扫（可被测试直接调用）。
   *
   * @returns 本轮结算的轮次数
   */
  async sweepOnce(now: Date = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const due = await this.attempts.listDueClaimWindows(SWEEP_BATCH_LIMIT, now);
      if (due.length === 0) return 0;

      let settled = 0;
      for (const attempt of due) {
        try {
          const readyAccountIds = await this.copies.readyAccountIds(attempt.ownerType, attempt.ownerId);
          // 目标数以轮次开立时的快照为准（`desiredCount` 为 0 的旧行才回退到当前配置），
          // 避免管理员中途改配置把历史轮次的结论改写
          const desiredCount = attempt.desiredCount > 0
            ? attempt.desiredCount
            : Math.max(1, (await this.replicaTargets.desiredReplicas()) ?? 1);
          const settledRow = await this.attempts.settleClaims(attempt.id, {
            desiredCount,
            baselineReadyCount: attempt.baselineReadyCount,
            readyAccountIds,
          });
          settled += 1;
          if (settledRow?.status === 'claim_timeout') {
            // 认领零新增：这是「转发成功但没人领到副本」的信号，必须计入告警口径
            this.pool.bumpCounter('relayClaimsMissed');
            this.logger.warn(
              `扩散轮次认领超时（${attempt.ownerType}:${attempt.ownerId} / 目标 ${attempt.targetChatId ?? '未知'}）：`
              + '中继已成功但窗口内无 Bot 认领副本，请检查镜像群内 Bot 的隐私模式/管理员权限',
            );
          }
        } catch (error) {
          // 单条失败不影响其它轮次：它会在下一轮清扫中重试
          this.logger.warn(
            `扩散轮次结算失败（${attempt.id}）：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return settled;
    } catch (error) {
      // 库不可用等整体故障：只记日志（不抛出，避免影响进程内其它链路）
      this.logger.warn(
        `认领窗口清扫失败（将在下个周期重试）：${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
