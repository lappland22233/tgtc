import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { TelegramAccountFeatureService } from '../telegram-accounts/telegram-account-feature.service';
import { maskIdentifier } from '../telegram-accounts/telegram-account-view';
import { TelegramReplicationAuditService } from '../telegram-accounts/telegram-replication-audit.service';
import { TelegramMirrorConfigService } from './telegram-mirror-config.service';
import { TelegramMirrorTaskService } from './telegram-mirror-task.service';
import { TelegramMirrorMetricsService } from './telegram-mirror-metrics.service';
import { TelegramMirrorSourceService } from './telegram-mirror-source.service';

/** 对账与告警周期（毫秒） */
const RECONCILE_INTERVAL_MS = 60_000;

export type MirrorTrigger = 'web_upload' | 'bot_inbound';

export interface MirrorTriggerInput {
  ownerType: 'file' | 'grant' | 'fileUnique';
  ownerId: string;
  /** 内容版本（覆盖上传递增）；Bot 入站场景为 1 */
  sourceVersion: number;
  sourceAccountId?: string | null;
  sourceChatId?: string | null;
  sourceMessageId?: string | null;
}

/**
 * 镜像触发入口（主文件远端提交成功后才调用）。
 *
 * 触发时机契约（与产品决策一致）：
 * 1. **提交即触发**：主文件远端提交成功、或 Bot 收到文件并登记副本后立即建单，
 *    不再等「下载时发现副本不足」才补扩散（下载路径不再有任何扩散副作用）；
 * 2. `fileId + uploadVersion + ruleId` 幂等：重复事件/重试/重启都不产生重复备份；
 * 3. 镜像成败**不回滚主文件上传**；主文件可用性与备份状态分开展示；
 * 4. 功能开关关闭时**不建新单**；已建单未执行的任务保留在队列（不执行、不丢弃）；
 * 5. **每条启用规则各建一条任务**（一个镜像群一条），事件范围（Web 上传 / Bot 入站）
 *    按规则开关过滤；单条规则失败不影响其它镜像群；
 * 6. 源 chat 等于该规则镜像群的事件按规则跳过（防止镜像群消息被再次镜像形成回环放大）。
 */
@Injectable()
export class TelegramMirrorTriggerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(TelegramMirrorTriggerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly tasks: TelegramMirrorTaskService,
    private readonly config: TelegramMirrorConfigService,
    private readonly feature: TelegramAccountFeatureService,
    private readonly metrics: TelegramMirrorMetricsService,
    private readonly source: TelegramMirrorSourceService,
    // 可选依赖：账号模块未装配时（极简部署）不阻断镜像链路的启动
    @Optional() @Inject(TelegramReplicationAuditService)
    private readonly replicationAudit: TelegramReplicationAuditService | null = null,
  ) {}

  async onModuleInit(): Promise<void> {
    // 把「扩散重试」能力注册给账号模块：镜像模块依赖账号模块（账号主数据），
    // 反向注入会成环，因此用回调注册（与账号池的探测回调同一处理方式）。
    this.replicationAudit?.registerDiffusionRetryHandler((input) => this.retryForOwner(input));
    // 启动恢复：进程重启后把中断的 running 任务重新排队
    try {
      await this.tasks.resumeInterrupted();
    } catch (error) {
      this.logger.warn(`中断任务恢复失败（忽略）：${error instanceof Error ? error.message : String(error)}`);
    }
    this.timer = setInterval(() => void this.reconcile(), RECONCILE_INTERVAL_MS);
    this.timer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 主文件提交成功后触发镜像（**不抛出**：镜像失败绝不影响主业务链路）。
   * @returns 是否创建了新任务
   */
  async onFileCommitted(input: MirrorTriggerInput, trigger: MirrorTrigger): Promise<boolean> {
    try {
      if (!(await this.feature.isMirrorEnabled())) return false;

      const rules = await this.config.listEnabledRules();
      if (rules.length === 0) return false;

      let createdAny = false;
      for (const rule of rules) {
        try {
          if (trigger === 'web_upload' && !rule.includeWebUploads) continue;
          if (trigger === 'bot_inbound' && !rule.includeBotInboundFiles) continue;
          // 该镜像群自身的消息不得再次触发镜像（按规则精确抑制，防止回环放大）
          if (input.sourceChatId && rule.targetChatId && String(input.sourceChatId) === String(rule.targetChatId)) {
            continue;
          }

          const { created } = await this.tasks.enqueue({
            ruleId: rule.id,
            ownerType: input.ownerType,
            ownerId: input.ownerId,
            sourceVersion: input.sourceVersion,
            sourceAccountId: input.sourceAccountId ?? null,
            sourceChatId: input.sourceChatId ?? null,
            sourceMessageId: input.sourceMessageId ?? null,
          });
          if (created) {
            createdAny = true;
            this.metrics.bump('tasksQueued');
          }
        } catch (error) {
          // 单个镜像群建单失败不得影响其它镜像群（例如某规则的数据形状异常）
          this.logger.warn(
            `镜像触发失败（规则 ${rule.id} / ${input.ownerType}:${input.ownerId}，不影响其它镜像群）：`
            + `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return createdAny;
    } catch (error) {
      this.logger.warn(
        `镜像触发失败（不影响主文件）：${input.ownerType}:${input.ownerId} ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * 管理员手动重试某个归属对象的扩散（后台「扩散轮次」页的重试入口）。
   *
   * 语义：**不产生新的执行路径**，而是把该文件在各镜像群上的扩散重新交给镜像任务队列 ——
   * - 已有任务且处于终态（succeeded/failed/blocked/cancelled）→ 重置为 queued 并重新入队；
   * - 已有任务仍在途（queued/running/retrying）→ 跳过（重复投递没有意义）；
   * - 没有任何任务（改造前的老文件）→ 按当前源事实**补建**任务。
   *
   * @param params.targetChatId 只重试某个镜像群（轮次记录带目标群时有值）；为空则覆盖全部启用规则
   */
  async retryForOwner(params: {
    ownerType: MirrorTriggerInput['ownerType'];
    ownerId: string;
    targetChatId?: string | null;
    operatorUserId: string;
  }): Promise<{ requeued: number; created: number; ruleIds: string[] }> {
    const targetChatId = (params.targetChatId ?? '').trim();
    const rules = (await this.config.listEnabledRules())
      .filter((rule) => !targetChatId || rule.targetChatId === targetChatId);
    if (rules.length === 0) {
      throw new BadRequestException(
        targetChatId
          ? `没有启用中的镜像规则指向镜像群 ${targetChatId}（规则可能已被删除或停用），无法重试`
          : '没有启用中的镜像规则，无法重试扩散',
      );
    }

    let requeued = 0;
    let created = 0;
    const ruleIds: string[] = [];
    for (const rule of rules) {
      ruleIds.push(rule.id);
      const existing = await this.tasks.findLatestForOwner(rule.id, params.ownerType, params.ownerId);
      if (existing) {
        const done = await this.tasks.requeueTerminal(existing, params.operatorUserId);
        if (done) requeued += 1;
        continue;
      }

      // 改造前的文件没有任务行：按当前源事实补建（源不可定位时抛 blocked 由上层提示）
      const descriptor = await this.source.describe(params.ownerType, params.ownerId);
      const { created: isNew } = await this.tasks.enqueue({
        ruleId: rule.id,
        ownerType: params.ownerType,
        ownerId: params.ownerId,
        sourceVersion: descriptor.sourceVersion,
        sourceAccountId: descriptor.sourceAccountId,
        sourceChatId: descriptor.chatId,
        sourceMessageId: descriptor.messageId,
      });
      if (isNew) {
        created += 1;
        this.metrics.bump('tasksQueued');
      }
    }

    this.logger.log(
      `管理员 ${params.operatorUserId} 手动重试扩散（${params.ownerType}:${params.ownerId}`
      + `${targetChatId ? ` / 目标镜像群 ${maskIdentifier(targetChatId)}` : ''}）：重置 ${requeued} 条、补建 ${created} 条`,
    );
    return { requeued, created, ruleIds };
  }

  /**
   * 周期对账：把「已持久化但队列里没有」的 queued 任务重新入队。
   * 为什么需要：入队时 Redis 不可用、Redis 重启、开关关闭期间退回排队等情况
   * 都会让任务永远不执行；对账保证最终一致（jobId 去重保证不重复执行）。
   */
  async reconcile(): Promise<void> {
    try {
      if (!(await this.feature.isMirrorEnabled())) return;
      // 只要还有启用中的镜像群就继续对账；没有任何启用规则时无可扩散目标
      const rules = await this.config.listEnabledRules();
      if (rules.length === 0) return;
      const count = await this.tasks.reconcileQueued();
      if (count > 0) this.logger.log(`镜像对账：重新入队 ${count} 个排队任务`);
    } catch (error) {
      this.logger.warn(`镜像对账失败（下轮重试）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
