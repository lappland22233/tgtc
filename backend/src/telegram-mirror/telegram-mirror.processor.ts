import { Processor, Process } from '@nestjs/bull';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bull';
import { Repository } from 'typeorm';
import { File } from '../common/entities/file.entity';
import { TelegramMirrorTask } from '../common/entities/telegram-mirror-task.entity';
import { TelegramAccountFeatureService } from '../telegram-accounts/telegram-account-feature.service';
import { TelegramMirrorTaskService, MirrorJobData } from './telegram-mirror-task.service';
import { TelegramMirrorConfigService } from './telegram-mirror-config.service';
import { TelegramUserCopyService } from './telegram-user-copy.service';
import { TelegramMirrorMetricsService } from './telegram-mirror-metrics.service';
import { MIRROR_QUEUE_NAME } from './telegram-mirror.types';
import { backoffMsFor, classifyMirrorError } from './telegram-mirror.errors';

/** 消费者并发：镜像会占用账号出口带宽，默认串行度较低，避免抢占下载体验 */
const MIRROR_CONCURRENCY = 2;

/**
 * 镜像任务的 Bull 消费者。
 *
 * 执行契约（按顺序，任何一步失败都不产生「疑似成功」）：
 * 1. **原子领取**：只有把 `queued|retrying` 成功改成 `running` 的 job 才执行，
 *    重复投递直接返回（幂等）；
 * 2. **回执优先**：若上次已保存目标侧回执（转发成功但落库失败），直接按回执确认成功，
 *    **绝不重复转发**；
 * 3. **规则与开关**：规则缺失/未启用 → blocked；镜像功能关闭 → 退回 queued（不执行、不丢弃）；
 * 4. **覆盖上传作废**：`file` 归属任务校验 `uploadVersion`，不一致即 cancelled；
 * 5. **唯一执行路径**：用户账号从主群服务端转发到镜像群（`TelegramUserCopyService`）——
 *    不存在「Bot 重新上传」分支，也不存在任何降级路径；
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
    private readonly userCopy: TelegramUserCopyService,
    private readonly metrics: TelegramMirrorMetricsService,
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

    // 2) 回执优先：上次转发成功但状态未落库 → 直接确认，绝不重复执行。
    //
    // 判据是「目标消息已产生」，**不能要求 file_id 非空**：用户账号转发路径按设计
    // 没有 Bot 可用的 file_id（`targetTelegramFileId=''`），把它当必要条件会让重试
    // 再次执行 forwardMessages，在镜像群留下重复消息。
    if (claimed.receiptPending && claimed.targetMessageId) {
      await this.tasks.markSucceeded(taskId, {
        targetAccountId: claimed.targetAccountId ?? '',
        targetChatId: claimed.targetChatId ?? '',
        targetMessageId: claimed.targetMessageId,
        targetTelegramFileId: claimed.targetTelegramFileId ?? '',
      });
      this.metrics.bump('tasksSucceeded');
      this.logger.log(`镜像任务按已保存回执确认成功（${taskId}），未重复转发`);
      return;
    }

    // 2.5) 历史遗留任务（旧的「Bot 重新上传」链路）显式阻塞，不静默改写为新链路。
    //      静默改写成中继会让同一文件被再转一次，也会把「旧链路是否还可用」这一事实掩盖掉。
    if (claimed.mode && claimed.mode !== 'user_copy') {
      await this.tasks.markBlocked(
        taskId,
        'legacy_mode_retired',
        `该任务产生于已下线的旧链路（mode=${claimed.mode}：Bot 重新上传到镜像群）；`
        + '请确认文件是否已在镜像群，必要时用「历史补偿」按当前规则重新建单',
      );
      this.metrics.bump('tasksBlocked');
      this.logger.warn(`镜像任务 ${taskId} 因旧链路下线而阻塞（mode=${claimed.mode}）`);
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
          `文件已被覆盖上传（版本 ${claimed.sourceVersion} → ${file.uploadVersion}），旧任务作废，避免把旧内容写入镜像群`,
        );
        this.logger.warn(`镜像任务作废：文件 ${file.id} 版本已变化（任务版本 ${claimed.sourceVersion}）`);
        return;
      }
    }

    // 5) 唯一执行路径：主群 → userbot → 镜像群（失败按分类收敛，无降级）
    let result;
    try {
      result = await this.userCopy.execute(claimed, rule);
    } catch (error) {
      const classification = classifyMirrorError(error);
      this.logger.warn(`镜像执行失败（${classification.code}）：${classification.summary}`);
      const settled = await this.settle(taskId, claimed, classification.code, classification.summary, classification.kind, classification.retryAfterMs);
      void settled;
      return;
    }

    // 6) 成功落库；记录失败时先保存回执，重试时凭回执确认（不重复转发）
    try {
      await this.tasks.markSucceeded(taskId, {
        targetAccountId: result.targetAccountId,
        targetChatId: result.targetChatId,
        targetMessageId: result.targetMessageId,
        targetTelegramFileId: result.targetTelegramFileId,
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
        summary: '镜像已完成但状态提交失败，重试将凭回执确认（不会重复转发）',
        delayMs: backoffMsFor(claimed.attempts),
        attempts: claimed.attempts,
      });
      this.metrics.bump('tasksRetried');
      await this.tasks.scheduleRetry(claimed, backoffMsFor(claimed.attempts));
    }
  }

  /** 按分类把任务收敛到 blocked / failed / retrying（无任何降级路径） */
  private async settle(
    taskId: string,
    task: TelegramMirrorTask,
    code: string,
    summary: string,
    kind: 'retryable' | 'blocked' | 'permanent',
    retryAfterMs?: number,
  ): Promise<'blocked' | 'failed' | 'retrying'> {
    if (kind === 'blocked') {
      await this.tasks.markBlocked(taskId, code, summary);
      this.metrics.bump('tasksBlocked');
      return 'blocked';
    }
    if (kind === 'permanent') {
      await this.tasks.markFailed(taskId, code, summary);
      this.metrics.bump('tasksFailed');
      return 'failed';
    }
    const delay = retryAfterMs ?? backoffMsFor(task.attempts);
    const result = await this.tasks.markRetrying(taskId, {
      code,
      summary,
      delayMs: delay,
      attempts: task.attempts,
    });
    if (result.exhausted) {
      this.metrics.bump('tasksFailed');
      return 'failed';
    }
    this.metrics.bump('tasksRetried');
    await this.tasks.scheduleRetry(task, delay);
    return 'retrying';
  }
}
