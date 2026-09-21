import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService } from '../common/services/audit.service';
import { File } from '../common/entities/file.entity';
import { TelegramMirrorTask } from '../common/entities/telegram-mirror-task.entity';
import { TelegramMirrorConfigService } from './telegram-mirror-config.service';
import { TelegramMirrorTriggerService } from './telegram-mirror-trigger.service';
import { TelegramAccountFeatureService } from '../telegram-accounts/telegram-account-feature.service';

/** 单批扫描条数与批间隔（限速：避免补偿任务抢占正常上传/下载的带宽与队列） */
const BACKFILL_BATCH_SIZE = 20;
const BACKFILL_BATCH_DELAY_MS = 1_000;
/** 单次补偿最多处理的文件数上限（防止一次误操作把整个历史库塞进队列） */
const BACKFILL_MAX_LIMIT = 5_000;

export type BackfillStatus = 'idle' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';

export interface BackfillJobState {
  status: BackfillStatus;
  mode: 'dry-run' | 'apply';
  limit: number;
  scanned: number;
  queued: number;
  skipped: number;
  /** dry-run 模式下将入队的样本（最多 20 条），便于管理员评估影响面 */
  sample: string[];
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  lastError: string | null;
  /** 当前批次游标（file.createdAt + id），仅用于进度展示 */
  cursor: string | null;
}

/**
 * 历史文件补偿镜像（阶段 3）。
 *
 * 为什么必须显式限速与可暂停：
 * - 镜像会把文件字节再次上传到备份群，历史库全量回填会突然产生巨量出口流量；
 * - 补偿**不改变**现有下载链接，也不跨账号复用 `file_id`；
 * - 任务全部走同一个幂等键，重复运行不会产生重复备份（可安全重跑）。
 *
 * 边界：临时补跑只处理「站内文件」；Bot 私聊入站历史消息无法在不重新拉取
 * Telegram 更新的前提下可靠重建源消息定位，故不纳入本次补偿（会明确跳过并计数）。
 */
@Injectable()
export class TelegramMirrorBackfillService {
  private readonly logger = new Logger(TelegramMirrorBackfillService.name);
  private state: BackfillJobState = createIdleState();
  private pauseRequested = false;
  private cancelRequested = false;

  constructor(
    @InjectRepository(File)
    private readonly files: Repository<File>,
    @InjectRepository(TelegramMirrorTask)
    private readonly tasks: Repository<TelegramMirrorTask>,
    private readonly config: TelegramMirrorConfigService,
    private readonly trigger: TelegramMirrorTriggerService,
    private readonly feature: TelegramAccountFeatureService,
    private readonly audit: AuditService,
  ) {}

  status(): BackfillJobState {
    return { ...this.state, sample: [...this.state.sample] };
  }

  /**
   * 启动补偿（`dry-run` 只统计不入队，`apply` 真正入队）。
   * 幂等：重复运行时已存在任务的文件会被跳过。
   */
  async start(input: { mode: 'dry-run' | 'apply'; limit?: number }, actorId: string): Promise<BackfillJobState> {
    if (this.state.status === 'running') {
      throw new BadRequestException('已有补偿任务在运行中，请先暂停或取消');
    }
    if (!(await this.feature.isMirrorEnabled())) {
      throw new BadRequestException('镜像功能开关未开启，无法执行历史补偿');
    }
    const rule = await this.config.getRule();
    if (!rule?.enabled) {
      throw new BadRequestException('镜像规则未启用（且未通过权限测试），无法执行历史补偿');
    }

    const limit = Math.min(Math.max(Number(input.limit) || 200, 1), BACKFILL_MAX_LIMIT);
    this.pauseRequested = false;
    this.cancelRequested = false;
    this.state = {
      status: 'running',
      mode: input.mode,
      limit,
      scanned: 0,
      queued: 0,
      skipped: 0,
      sample: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: null,
      lastError: null,
      cursor: null,
    };

    this.audit.log({
      action: 'telegram_mirror_backfill_started',
      userId: actorId,
      resourceType: 'telegram_mirror_backfill',
      resourceId: 'backfill',
      metadata: { mode: input.mode, limit, ruleId: rule.id },
    });

    // 后台执行：接口立即返回 job 状态，进度由 GET 轮询
    void this.run(rule.id).catch((error: unknown) => {
      this.state.status = 'failed';
      this.state.lastError = error instanceof Error ? error.message : String(error);
      this.state.updatedAt = new Date().toISOString();
      this.state.finishedAt = this.state.updatedAt;
      this.logger.error(`历史补偿失败：${this.state.lastError}`);
    });
    return this.status();
  }

  pause(): BackfillJobState {
    if (this.state.status !== 'running') throw new BadRequestException('当前没有正在运行的补偿任务');
    this.pauseRequested = true;
    return this.status();
  }

  resume(actorId: string): BackfillJobState {
    if (this.state.status !== 'paused') throw new BadRequestException('当前没有已暂停的补偿任务');
    this.pauseRequested = false;
    this.state.status = 'running';
    this.state.updatedAt = new Date().toISOString();
    this.audit.log({
      action: 'telegram_mirror_backfill_resumed',
      userId: actorId,
      resourceType: 'telegram_mirror_backfill',
      resourceId: 'backfill',
      metadata: { resumed: true, scanned: this.state.scanned, queued: this.state.queued },
    });
    void this.run(this.currentRuleId ?? '').catch((error: unknown) => {
      this.state.status = 'failed';
      this.state.lastError = error instanceof Error ? error.message : String(error);
    });
    return this.status();
  }

  cancel(): BackfillJobState {
    if (this.state.status !== 'running' && this.state.status !== 'paused') {
      throw new BadRequestException('当前没有可取消的补偿任务');
    }
    this.cancelRequested = true;
    this.state.status = 'cancelled';
    this.state.updatedAt = new Date().toISOString();
    this.state.finishedAt = this.state.updatedAt;
    return this.status();
  }

  private currentRuleId: string | null = null;

  /**
   * 补偿主循环：按 `createdAt DESC, id DESC` 游标分页扫描（避免深分页性能陷阱），
   * 每批之间主动让出 1s，保证不抢占正常链路带宽。
   */
  private async run(ruleId: string): Promise<void> {
    this.currentRuleId = ruleId;
    let cursor: { createdAt: Date; id: string } | null = null;

    while (this.state.scanned < this.state.limit) {
      if (this.cancelRequested) {
        this.state.status = 'cancelled';
        this.state.finishedAt = new Date().toISOString();
        return;
      }
      if (this.pauseRequested) {
        this.state.status = 'paused';
        this.state.updatedAt = new Date().toISOString();
        return;
      }

      const remaining = this.state.limit - this.state.scanned;
      const batchSize = Math.min(BACKFILL_BATCH_SIZE, remaining);
      const builder = this.files.createQueryBuilder('file')
        .where('file.isDeleted = :isDeleted', { isDeleted: false })
        .andWhere('file.status = :status', { status: 'ready' })
        .andWhere('file.uploadStage = :stage', { stage: 'committed' })
        .orderBy('file.createdAt', 'DESC')
        .addOrderBy('file.id', 'DESC')
        .take(batchSize);

      if (cursor) {
        builder.andWhere(
          '(file.createdAt < :cursorCreatedAt OR (file.createdAt = :cursorCreatedAt AND file.id < :cursorId))',
          { cursorCreatedAt: cursor.createdAt, cursorId: cursor.id },
        );
      }

      const batch = await builder.getMany();
      if (batch.length === 0) {
        this.state.status = 'completed';
        this.state.finishedAt = new Date().toISOString();
        this.state.updatedAt = this.state.finishedAt;
        this.logger.log(
          `历史补偿完成：扫描 ${this.state.scanned}，入队 ${this.state.queued}，跳过 ${this.state.skipped}`,
        );
        return;
      }

      for (const file of batch) {
        this.state.scanned += 1;
        const last = batch[batch.length - 1];
        cursor = { createdAt: new Date(last.createdAt), id: last.id };
        this.state.cursor = `${new Date(last.createdAt).toISOString()}/${last.id}`;

        const sourceVersion = Number(file.uploadVersion) || 1;
        const existing = await this.tasks.findOne({
          where: { ruleId, ownerType: 'file', ownerId: file.id, sourceVersion },
        });
        if (existing) {
          this.state.skipped += 1;
          continue;
        }
        if (this.state.mode === 'dry-run') {
          this.state.queued += 1;
          if (this.state.sample.length < 20) this.state.sample.push(file.id);
          continue;
        }
        const created = await this.trigger.onFileCommitted(
          {
            ownerType: 'file',
            ownerId: file.id,
            sourceVersion,
            sourceAccountId: file.telegramSourceAccountId ?? null,
            sourceChatId: file.telegramChatId ?? null,
            sourceMessageId: file.telegramMessageId ?? null,
          },
          'web_upload',
        );
        if (created) {
          this.state.queued += 1;
          if (this.state.sample.length < 20) this.state.sample.push(file.id);
        } else {
          // 事件范围被规则过滤（例如 includeWebUploads=false）或触发失败
          this.state.skipped += 1;
        }
      }

      this.state.updatedAt = new Date().toISOString();
      await sleep(BACKFILL_BATCH_DELAY_MS);
    }

    this.state.status = 'completed';
    this.state.finishedAt = new Date().toISOString();
    this.logger.log(`历史补偿达到上限并结束：扫描 ${this.state.scanned}，入队 ${this.state.queued}`);
  }
}

function createIdleState(): BackfillJobState {
  return {
    status: 'idle',
    mode: 'dry-run',
    limit: 0,
    scanned: 0,
    queued: 0,
    skipped: 0,
    sample: [],
    startedAt: null,
    updatedAt: new Date().toISOString(),
    finishedAt: null,
    lastError: null,
    cursor: null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
