import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { TelegramMirrorMode } from '../common/entities/telegram-mirror-rule.entity';
import { TelegramAccountFeatureService } from '../telegram-accounts/telegram-account-feature.service';
import { TelegramMirrorConfigService } from './telegram-mirror-config.service';
import { TelegramMirrorTaskService } from './telegram-mirror-task.service';
import { TelegramMirrorMetricsService } from './telegram-mirror-metrics.service';

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
 * 1. 主文件远端提交成功且站内状态已提交 → 才建单入队；
 * 2. `fileId + uploadVersion + ruleId` 幂等：重复事件/重试/重启都不产生重复备份；
 * 3. 镜像成败**不回滚主文件上传**；主文件可用性与备份状态分开展示；
 * 4. 功能开关关闭时**不建新单**；已建单未执行的任务保留在队列（不执行、不丢弃）；
 * 5. 事件范围按规则开关过滤（Web 上传 / Bot 入站）；
 * 6. 源群等于备份群的事件直接跳过（防止备份群消息被再次镜像形成回环）。
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
  ) {}

  async onModuleInit(): Promise<void> {
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

      const rule = await this.config.getRule();
      if (!rule || !rule.enabled) return false;
      if (trigger === 'web_upload' && !rule.includeWebUploads) return false;
      if (trigger === 'bot_inbound' && !rule.includeBotInboundFiles) return false;
      // 备份群自身的消息不得再次触发镜像（幂等抑制：防止镜像产生的新消息形成回环）
      if (input.sourceChatId && rule.targetChatId && String(input.sourceChatId) === String(rule.targetChatId)) {
        return false;
      }

      const { created } = await this.tasks.enqueue({
        ruleId: rule.id,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        sourceVersion: input.sourceVersion,
        mode: rule.mode as TelegramMirrorMode,
        sourceAccountId: input.sourceAccountId ?? null,
        sourceChatId: input.sourceChatId ?? null,
        sourceMessageId: input.sourceMessageId ?? null,
      });
      if (created) this.metrics.bump('tasksQueued');
      return created;
    } catch (error) {
      this.logger.warn(
        `镜像触发失败（不影响主文件）：${input.ownerType}:${input.ownerId} ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * 周期对账：把「已持久化但队列里没有」的 queued 任务重新入队。
   * 为什么需要：入队时 Redis 不可用、Redis 重启、开关关闭期间退回排队等情况
   * 都会让任务永远不执行；对账保证最终一致（jobId 去重保证不重复执行）。
   */
  async reconcile(): Promise<void> {
    try {
      if (!(await this.feature.isMirrorEnabled())) return;
      const rule = await this.config.getRule();
      if (!rule?.enabled) return;
      const count = await this.tasks.reconcileQueued();
      if (count > 0) this.logger.log(`镜像对账：重新入队 ${count} 个排队任务`);
    } catch (error) {
      this.logger.warn(`镜像对账失败（下轮重试）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
