import { Processor, Process } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bull';
import { Repository } from 'typeorm';
import { AuditService } from '../common/services/audit.service';
import { File } from '../common/entities/file.entity';
import { TelegramMirrorTask } from '../common/entities/telegram-mirror-task.entity';
import { TelegramMirrorRule } from '../common/entities/telegram-mirror-rule.entity';
import { TelegramAccountFeatureService } from '../telegram-accounts/telegram-account-feature.service';
import { TelegramMirrorTaskService, MirrorJobData } from './telegram-mirror-task.service';
import { TelegramMirrorConfigService } from './telegram-mirror-config.service';
import { TelegramMirrorBotService } from './telegram-mirror-bot.service';
import { TelegramUserCopyService } from './telegram-user-copy.service';
import { TelegramMirrorMetricsService } from './telegram-mirror-metrics.service';
import { MirrorExecutionResult, MIRROR_QUEUE_NAME } from './telegram-mirror.types';
import { backoffMsFor, classifyMirrorError } from './telegram-mirror.errors';

/** 消费者并发：镜像会占用出口带宽，默认串行度较低，避免抢占下载体验 */
const MIRROR_CONCURRENCY = 2;

/**
 * 镜像任务的 Bull 消费者。
 *
 * 执行契约（按顺序，任何一步失败都不产生「疑似成功」）：
 * 1. **原子领取**：只有把 `queued|retrying` 成功改成 `running` 的 job 才执行，
 *    重复投递直接返回（幂等）；
 * 2. **回执优先**：若上次已保存目标侧回执（上传成功但落库失败），直接按回执确认成功，
 *    **绝不重复上传**；
 * 3. **规则与开关**：规则缺失 → blocked；镜像功能关闭 → 退回 queued（不执行、不丢弃）；
 * 4. **覆盖上传作废**：`file` 归属任务校验 `uploadVersion`，不一致即 cancelled；
 * 5. **模式与降级**：auto 优先用户无源复制，失败仅在规则显式允许时降级 Bot 重新上传并写审计；
 * 6. **错误分类**：429 尊重 retry_after、权限/源失效 → blocked、网络 → 指数退避重试。
 */
@Injectable()
@Processor(MIRROR_QUEUE_NAME)
export class TelegramMirrorProcessor {
  private readonly logger = new Logger(TelegramMirrorProcessor.name);

  constructor(
    private readonly tasks: TelegramMirrorTaskService,
    private readonly config: TelegramMirrorConfigService,
    private readonly feature: TelegramAccountFeatureService,
    private readonly bot: TelegramMirrorBotService,
    private readonly userCopy: TelegramUserCopyService,
    private readonly metrics: TelegramMirrorMetricsService,
    private readonly audit: AuditService,
    @InjectRepository(File)
    private readonly files: Repository<File>,
  ) {}

  @Process({ name: 'mirror', concurrency: MIRROR_CONCURRENCY })
  async handle(job: Job<MirrorJobData>): Promise<void> {
    const taskId = job?.data?.taskId;
    if (!taskId) return;

    const claimed = await this.tasks.claim(taskId);
    if (!claimed) {
      // 已被其它 job 领取、已完成或已取消：静默返回（幂等）
      return;
    }

    try {
      await this.execute(claimed);
    } catch (error) {
      // execute 内部已处理业务错误；这里只兜底意外异常，避免任务永久停留在 running
      const classification = classifyMirrorError(error);
      this.logger.error(`镜像任务异常（${taskId}）：${classification.summary}`);
      const result = await this.tasks.markRetrying(taskId, {
        code: classification.code,
        summary: classification.summary,
        delayMs: classification.retryAfterMs ?? backoffMsFor(claimed.attempts),
        attempts: claimed.attempts,
      });
      this.metrics.bump('tasksRetried');
      if (!result.exhausted) {
        await this.tasks.scheduleRetry({ ...claimed, attempts: claimed.attempts }, classification.retryAfterMs ?? backoffMsFor(claimed.attempts));
      } else {
        this.metrics.bump('tasksFailed');
      }
    }
  }

  private async execute(claimed: TelegramMirrorTask): Promise<void> {
    const taskId = claimed.id;

    // 2) 回执优先：上次上传/复制成功但状态未落库 → 直接确认，绝不重复执行。
    //
    // 判据是「目标消息已产生」，**不能要求 file_id 非空**：用户无源复制路径按设计
    // 没有 Bot 可用的 file_id（`targetTelegramFileId=''`），把它当必要条件会让重试
    // 再次执行 copyMessages，在备份群留下重复消息。
    if (claimed.receiptPending && claimed.targetMessageId) {
      await this.tasks.markSucceeded(taskId, {
        targetAccountId: claimed.targetAccountId ?? '',
        targetChatId: claimed.targetChatId ?? '',
        targetMessageId: claimed.targetMessageId,
        targetTelegramFileId: claimed.targetTelegramFileId ?? '',
        mode: claimed.mode === 'user_copy' ? 'user_copy' : 'bot_upload',
      });
      this.metrics.bump('tasksSucceeded');
      this.logger.log(`镜像任务按已保存回执确认成功（${taskId}），未重复上传`);
      return;
    }

    // 3) 规则与开关
    const rule = await this.config.getRuleById(claimed.ruleId);
    if (!rule) {
      await this.tasks.markBlocked(taskId, 'rule_missing', '镜像规则已被删除');
      this.metrics.bump('tasksBlocked');
      return;
    }
    if (!rule.enabled) {
      await this.tasks.markBlocked(taskId, 'rule_disabled', '镜像规则未启用');
      this.metrics.bump('tasksBlocked');
      return;
    }
    if (!(await this.feature.isMirrorEnabled())) {
      await this.tasks.returnToQueue(taskId, 'mirror_feature_disabled', '镜像功能开关已关闭，任务保留在队列等待重新开启');
      this.logger.log(`镜像功能已关闭，任务 ${taskId} 退回排队（未执行）`);
      return;
    }

    // 4) 覆盖上传作废
    if (claimed.ownerType === 'file') {
      const file = await this.files.findOne({ where: { id: claimed.ownerId } });
      if (!file) {
        await this.tasks.markBlocked(taskId, 'source_file_missing', '站内文件不存在');
        this.metrics.bump('tasksBlocked');
        return;
      }
      if (Number(file.uploadVersion) !== Number(claimed.sourceVersion)) {
        await this.tasks.markCancelled(
          taskId,
          `文件已被覆盖上传（版本 ${claimed.sourceVersion} → ${file.uploadVersion}），旧任务作废，避免把旧内容写入备份群`,
        );
        this.logger.warn(`镜像任务作废：文件 ${file.id} 版本已变化（任务版本 ${claimed.sourceVersion}）`);
        return;
      }
    }

    // 5) 模式与降级
    const mode = await this.resolveMode(claimed, rule);
    let result: MirrorExecutionResult;
    try {
      result = mode === 'user_copy'
        ? await this.userCopy.execute(claimed, rule)
        : await this.bot.execute(claimed, rule);
    } catch (error) {
      const fallback = await this.tryFallback(claimed, rule, mode, error);
      if (fallback.kind === 'blocked' || fallback.kind === 'failed' || fallback.kind === 'retrying' || fallback.kind === 'cancelled') return;
      result = fallback.result as MirrorExecutionResult;
    }

    // 6) 成功落库；记录失败时先保存回执，重试时凭回执确认（不重复上传）
    try {
      await this.tasks.markSucceeded(taskId, {
        targetAccountId: result.targetAccountId,
        targetChatId: result.targetChatId,
        targetMessageId: result.targetMessageId,
        targetTelegramFileId: result.targetTelegramFileId,
        mode: result.mode,
      });
      this.metrics.recordSuccess(result);
    } catch (error) {
      this.logger.error(`镜像成功但状态落库失败（${taskId}）：${error instanceof Error ? error.message : String(error)}`);
      try {
        await this.tasks.saveReceipt(taskId, {
          targetAccountId: result.targetAccountId,
          targetChatId: result.targetChatId,
          targetMessageId: result.targetMessageId,
          targetTelegramFileId: result.targetTelegramFileId,
        });
      } catch (receiptError) {
        this.logger.error(
          `回执落库同样失败（${taskId}）：${receiptError instanceof Error ? receiptError.message : String(receiptError)}`,
        );
      }
      await this.tasks.markRetrying(taskId, {
        code: 'persist_receipt_failed',
        summary: '备份已完成但状态提交失败，重试将凭回执确认（不会重复上传）',
        delayMs: backoffMsFor(claimed.attempts),
        attempts: claimed.attempts,
      });
      this.metrics.bump('tasksRetried');
      await this.tasks.scheduleRetry(claimed, backoffMsFor(claimed.attempts));
    }
  }

  /** auto 模式：具备用户账号路径条件时优先无源复制（只上传一次字节） */
  private async resolveMode(
    task: TelegramMirrorTask,
    rule: TelegramMirrorRule,
  ): Promise<'bot_upload' | 'user_copy'> {
    // 任务里已经确定过的模式（例如降级后写回的 bot_upload）优先，避免反复摇摆
    if (task.mode === 'bot_upload' || task.mode === 'user_copy') return task.mode;
    if (rule.mode === 'bot_upload') return 'bot_upload';
    if (rule.mode === 'user_copy') return 'user_copy';
    return (await this.userCopy.isUserPathViable()) ? 'user_copy' : 'bot_upload';
  }

  /**
   * 失败处理：显式允许时才降级为 Bot 重新上传；否则按错误分类收敛为 blocked / failed / retrying。
   */
  private async tryFallback(
    task: TelegramMirrorTask,
    rule: TelegramMirrorRule,
    mode: 'bot_upload' | 'user_copy',
    error: unknown,
  ): Promise<
    | { kind: 'ok'; result: MirrorExecutionResult }
    | { kind: 'blocked' }
    | { kind: 'failed' }
    | { kind: 'retrying' }
    | { kind: 'cancelled' }
  > {
    const classification = classifyMirrorError(error);
    // 凭据类错误的账号降级在**执行器内部**完成（只有它们知道实际使用的账号行 ID），
    // 这里只负责任务状态收敛，避免把「账号标识」与「账号主数据 ID」混用。

    // 「复制请求已被接受、但无法确认目标消息 ID」**禁止降级为 Bot 重新上传**：源侧副作用
    // 可能已经发生，降级会在备份群再增加一条 Bot 重传的副本，把「结果不确定」变成
    // 「确定的重复」。此类任务必须停在 blocked，等人工核对备份群后再决定重试或清理。
    if (classification.code === 'user_copy_receipt_unresolved') {
      return this.settle(task, classification.code, classification.summary, classification.kind, classification.retryAfterMs);
    }

    if (mode === 'user_copy' && rule.fallbackMode === 'bot_upload') {
      this.logger.warn(
        `用户无源复制失败（${classification.code}），按规则显式降级为 Bot 重新上传：${classification.summary}`,
      );
      try {
        const result = await this.bot.execute(task, rule);
        this.audit.log({
          action: 'telegram_mirror_fallback_applied',
          userId: null,
          resourceType: 'telegram_mirror_task',
          resourceId: task.id,
          metadata: {
            // 降级会产生第二次上传，必须留痕（产品决策要求）
            from: 'user_copy',
            to: 'bot_upload',
            reasonCode: classification.code,
            ownerType: task.ownerType,
          },
        });
        return { kind: 'ok', result: { ...result, fallbackApplied: true, fallbackReason: classification.code } };
      } catch (fallbackError) {
        const second = classifyMirrorError(fallbackError);
        this.logger.warn(`降级后的 Bot 上传同样失败（${second.code}）：${second.summary}`);
        return this.settle(task, second.code, second.summary, second.kind, second.retryAfterMs);
      }
    }

    return this.settle(task, classification.code, classification.summary, classification.kind, classification.retryAfterMs);
  }

  /** 按分类把任务收敛到 blocked / failed / retrying */
  private async settle(
    task: TelegramMirrorTask,
    code: string,
    summary: string,
    kind: 'retryable' | 'blocked' | 'permanent',
    retryAfterMs?: number,
  ): Promise<{ kind: 'blocked' | 'failed' | 'retrying' }> {
    if (kind === 'blocked') {
      await this.tasks.markBlocked(task.id, code, summary);
      this.metrics.bump('tasksBlocked');
      return { kind: 'blocked' };
    }
    if (kind === 'permanent') {
      await this.tasks.markFailed(task.id, code, summary);
      this.metrics.bump('tasksFailed');
      return { kind: 'failed' };
    }
    const delay = retryAfterMs ?? backoffMsFor(task.attempts);
    const result = await this.tasks.markRetrying(task.id, {
      code,
      summary,
      delayMs: delay,
      attempts: task.attempts,
    });
    if (result.exhausted) {
      this.metrics.bump('tasksFailed');
      return { kind: 'failed' };
    }
    this.metrics.bump('tasksRetried');
    await this.tasks.scheduleRetry(task, delay);
    return { kind: 'retrying' };
  }
}
