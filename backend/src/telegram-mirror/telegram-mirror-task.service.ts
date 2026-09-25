import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { Repository } from 'typeorm';
import { databaseQuery, getDatabaseType } from '../database/database-types';
import {
  TelegramMirrorTask,
  TelegramMirrorTaskStatus,
} from '../common/entities/telegram-mirror-task.entity';
import { TelegramMirrorMode } from '../common/entities/telegram-mirror-rule.entity';
import { AuditService } from '../common/services/audit.service';
import { MIRROR_QUEUE_NAME, MIRROR_MAX_ATTEMPTS, MIRROR_RETRY_BASE_MS, MIRROR_RETRY_MAX_MS, MirrorTaskSummary } from './telegram-mirror.types';

/** 镜像任务 job 数据（最小载荷：任务详情以数据库为事实来源） */
export interface MirrorJobData {
  taskId: string;
  ruleId: string;
}

/**
 * 建单参数。
 *
 * 没有 `mode`：副本扩散只有「用户账号从主群服务端转发到镜像群」一条链路，
 * 任务行的 `mode` 恒为 `user_copy`（历史行可能仍是 `bot_upload`，仅用于追溯）。
 */
export interface EnqueueMirrorParams {
  ruleId: string;
  ownerType: 'file' | 'grant' | 'fileUnique';
  ownerId: string;
  sourceVersion: number;
  sourceAccountId?: string | null;
  sourceChatId?: string | null;
  sourceMessageId?: string | null;
}

/**
 * 镜像任务的持久化与状态机。
 *
 * 幂等（三层）：
 * 1. 数据库唯一键 `(ruleId, ownerType, ownerId, sourceVersion)`：并发/重复触发只会有一条记录；
 * 2. Bull 确定性 jobId：同一任务不会重复入队；
 * 3. 领取式状态流转（`queued|retrying → running`）：重复投递的 job 抢不到状态即直接返回。
 *
 * 重启恢复：进程重启后在途的 `running` 任务会被 `resumeInterrupted()` 重置为 `retrying`，
 * 因此「主文件成功但备份永远缺失且无人知晓」不可能发生。
 */
@Injectable()
export class TelegramMirrorTaskService {
  private readonly logger = new Logger(TelegramMirrorTaskService.name);

  constructor(
    @InjectRepository(TelegramMirrorTask)
    private readonly repo: Repository<TelegramMirrorTask>,
    @InjectQueue(MIRROR_QUEUE_NAME)
    private readonly queue: Queue<MirrorJobData>,
    private readonly audit: AuditService,
  ) {}

  /** 幂等键（数据库唯一索引与 Bull jobId 的共同来源） */
  buildJobId(task: Pick<TelegramMirrorTask, 'ruleId' | 'ownerType' | 'ownerId' | 'sourceVersion'>): string {
    return `${task.ruleId}:${task.ownerType}:${task.ownerId}:${task.sourceVersion}`;
  }

  /**
   * 幂等建单 + 入队。
   * @returns `created=false` 表示已存在同幂等键任务（直接复用，不重复入队）
   */
  async enqueue(params: EnqueueMirrorParams): Promise<{ task: TelegramMirrorTask; created: boolean }> {
    const existing = await this.repo.findOne({
      where: {
        ruleId: params.ruleId,
        ownerType: params.ownerType,
        ownerId: params.ownerId,
        sourceVersion: params.sourceVersion,
      },
    });
    if (existing) {
      // 已完成的任务永不重复投递；未完成的（queued/retrying）确保队列里有 job
      if (existing.status === 'queued') {
        await this.safeAddJob(existing);
      } else if (existing.status === 'retrying') {
        await this.scheduleRetry(existing, 0);
      }
      return { task: existing, created: false };
    }

    const task = this.repo.create({
      ruleId: params.ruleId,
      ownerType: params.ownerType,
      ownerId: params.ownerId,
      sourceVersion: params.sourceVersion,
      // 唯一执行链路：主群 → userbot → 镜像群（`mode` 列保留仅为兼容历史行，取值恒定）
      mode: 'user_copy' as TelegramMirrorMode,
      status: 'queued',
      attempts: 0,
      sourceAccountId: params.sourceAccountId ?? null,
      sourceChatId: params.sourceChatId ?? null,
      sourceMessageId: params.sourceMessageId ?? null,
      receiptPending: false,
    });
    let saved: TelegramMirrorTask;
    try {
      saved = await this.repo.save(task);
    } catch (error) {
      // 并发插入撞唯一键：回读既有记录，保持幂等语义
      const raced = await this.repo.findOne({
        where: {
          ruleId: params.ruleId,
          ownerType: params.ownerType,
          ownerId: params.ownerId,
          sourceVersion: params.sourceVersion,
        },
      });
      if (!raced) throw error;
      return { task: raced, created: false };
    }
    await this.safeAddJob(saved);
    this.logger.log(
      `镜像任务已入队：${params.ownerType}:${params.ownerId}@v${params.sourceVersion}（规则 ${params.ruleId}）`,
    );
    return { task: saved, created: true };
  }

  /**
   * 领取任务（原子）：只有 `queued|retrying → running` 的转移成功者才会执行。
   * 必须走 `databaseQuery()`：PG 的 `UPDATE ... RETURNING` 返回 `[rows, count]` 元组，
   * 直接读返回值会把「行数」判断成 2（历史上已造成两起静默失效）。
   */
  async claim(taskId: string): Promise<TelegramMirrorTask | null> {
    const dbType = getDatabaseType();
    const rows = await databaseQuery<TelegramMirrorTask[]>(
      this.repo.manager,
      `UPDATE "telegram_mirror_tasks"
         SET "status" = 'running',
             "attempts" = "attempts" + 1,
             "startedAt" = ${dbType === 'sqlite' ? "datetime('now')" : 'now()'},
             "updatedAt" = ${dbType === 'sqlite' ? "datetime('now')" : 'now()'}
       WHERE "id" = $1 AND "status" IN ('queued', 'retrying')
       RETURNING *`,
      [taskId],
      dbType,
    );
    const claimed = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    return claimed ? this.repo.create(claimed as TelegramMirrorTask) : null;
  }

  async markSucceeded(
    taskId: string,
    result: {
      targetAccountId: string;
      targetChatId: string;
      targetMessageId: string;
      targetTelegramFileId: string;
    },
  ): Promise<void> {
    await this.repo.update({ id: taskId }, {
      status: 'succeeded',
      targetAccountId: result.targetAccountId,
      targetChatId: result.targetChatId,
      targetMessageId: result.targetMessageId,
      targetTelegramFileId: result.targetTelegramFileId,
      mode: 'user_copy' as TelegramMirrorMode,
      receiptPending: false,
      lastErrorCode: null,
      lastErrorSummary: null,
      nextRetryAt: null,
      completedAt: new Date(),
    });
  }

  async markRetrying(
    taskId: string,
    params: { code: string; summary: string; delayMs: number; attempts: number },
  ): Promise<{ exhausted: boolean }> {
    if (params.attempts >= MIRROR_MAX_ATTEMPTS) {
      await this.markFailed(taskId, params.code, params.summary);
      return { exhausted: true };
    }
    const delay = Math.min(params.delayMs, MIRROR_RETRY_MAX_MS);
    await this.repo.update({ id: taskId }, {
      status: 'retrying',
      lastErrorCode: params.code.slice(0, 64),
      lastErrorSummary: params.summary.slice(0, 500),
      nextRetryAt: new Date(Date.now() + delay),
      completedAt: null,
    });
    return { exhausted: false };
  }

  async markBlocked(taskId: string, code: string, summary: string): Promise<void> {
    await this.repo.update({ id: taskId }, {
      status: 'blocked',
      lastErrorCode: code.slice(0, 64),
      lastErrorSummary: summary.slice(0, 500),
      nextRetryAt: null,
      completedAt: new Date(),
    });
  }

  async markFailed(taskId: string, code: string, summary: string): Promise<void> {
    await this.repo.update({ id: taskId }, {
      status: 'failed',
      lastErrorCode: code.slice(0, 64),
      lastErrorSummary: summary.slice(0, 500),
      nextRetryAt: null,
      completedAt: new Date(),
    });
  }

  /**
   * 保存目标侧回执（上传已成功但状态提交失败时的可恢复凭据）。
   *
   * 为什么必须单独保存：目标上传成功、但写库失败时，如果直接置为 retrying，
   * 下一次尝试会**重复上传**并产生重复备份。先把回执落库（即使状态是 retrying），
   * 重试时就能凭回执直接确认成功，不需要再次上传。
   */
  async saveReceipt(
    taskId: string,
    receipt: { targetAccountId: string; targetChatId: string; targetMessageId: string; targetTelegramFileId: string },
  ): Promise<void> {
    await this.repo.update({ id: taskId }, {
      targetAccountId: receipt.targetAccountId,
      targetChatId: receipt.targetChatId,
      targetMessageId: receipt.targetMessageId,
      targetTelegramFileId: receipt.targetTelegramFileId,
      receiptPending: true,
    });
  }

  /**
   * 把任务退回排队（镜像功能开关关闭时使用）。
   *
   * 语义：**不执行、也不丢弃**——关闭开关只阻止新任务开始，任务保留在 queued，
   * 待开关重新打开后由对账逻辑重新入队，不会造成「文件永远没有备份且无人知晓」。
   */
  async returnToQueue(taskId: string, code: string, summary: string): Promise<void> {
    await this.repo.update({ id: taskId }, {
      status: 'queued',
      // 退回排队时归还本次尝试计数：任务并未真正执行
      attempts: 0,
      lastErrorCode: code.slice(0, 64),
      lastErrorSummary: summary.slice(0, 500),
      nextRetryAt: null,
      startedAt: null,
    });
  }

  /** 覆盖上传/删除等导致源内容版本变化的旧任务作废 */
  async markCancelled(taskId: string, reason: string): Promise<void> {
    await this.repo.update({ id: taskId }, {
      status: 'cancelled',
      lastErrorCode: 'cancelled',
      lastErrorSummary: reason.slice(0, 500),
      nextRetryAt: null,
      completedAt: new Date(),
    });
  }

  /**
   * 重启恢复：把「上次进程留下的 running 任务」重置为 retrying 并重新入队。
   * 回执未落库（receiptPending）的任务在重试时会先查既有副本，避免重复备份。
   */
  async resumeInterrupted(): Promise<number> {
    const stuck = await this.repo.find({ where: { status: 'running' } });
    for (const task of stuck) {
      await this.repo.update({ id: task.id }, {
        status: 'retrying',
        lastErrorCode: 'interrupted',
        lastErrorSummary: '进程重启导致任务中断，已自动恢复重试',
        nextRetryAt: new Date(),
      });
      await this.scheduleRetry({ ...task, status: 'retrying' } as TelegramMirrorTask, 0);
    }
    if (stuck.length > 0) this.logger.warn(`已恢复 ${stuck.length} 个中断的镜像任务（重置为 retrying 并重新入队）`);
    return stuck.length;
  }

  /**
   * 对账：把队列中缺失的 `queued` 任务重新入队（有界批量）。
   *
   * 为什么需要：Bull 入队失败、Redis 重启丢队列、镜像开关关闭期间退回排队的任务，
   * 都会导致「任务已持久化但永远不会被执行」。周期对账保证最终一致，
   * 而 jobId 去重保证不会重复执行。
   */
  async reconcileQueued(limit = 50): Promise<number> {
    const queued = await this.repo.find({ where: { status: 'queued' }, order: { createdAt: 'ASC' }, take: limit });
    for (const task of queued) {
      await this.safeAddJob(task);
    }
    return queued.length;
  }

  /** 过期任务清理：retrying 但重试时间已过很久（例如规则被禁用）时标记 failed，避免无限悬挂 */
  async reapStaleRetrying(olderThanMinutes = 24 * 60): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
    const stale = await this.repo.createQueryBuilder('task')
      .where('task.status = :status', { status: 'retrying' })
      .andWhere('task.nextRetryAt < :cutoff', { cutoff })
      .limit(200)
      .getMany();
    for (const task of stale) {
      await this.markFailed(task.id, 'retry_expired', `重试窗口已过期（超过 ${olderThanMinutes} 分钟未恢复）`);
    }
    return stale.length;
  }

  async findById(id: string): Promise<TelegramMirrorTask | null> {
    return this.repo.findOne({ where: { id } });
  }

  async list(query: {
    status?: string;
    mode?: string;
    ownerId?: string;
    accountId?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ items: TelegramMirrorTask[]; total: number }> {
    const page = Number.isSafeInteger(query.page) && (query.page as number) > 0 ? Number(query.page) : 1;
    const rawSize = Number.isSafeInteger(query.pageSize) && (query.pageSize as number) > 0 ? Number(query.pageSize) : 20;
    const pageSize = Math.min(rawSize, 100);

    const builder = this.repo.createQueryBuilder('task').orderBy('task.createdAt', 'DESC');
    if (query.status) builder.andWhere('task.status = :status', { status: query.status });
    if (query.mode) builder.andWhere('task.mode = :mode', { mode: query.mode });
    if (query.ownerId) builder.andWhere('task.ownerId = :ownerId', { ownerId: query.ownerId });
    if (query.accountId) {
      builder.andWhere('(task.targetAccountId = :accountId OR task.sourceAccountId = :accountId)', {
        accountId: query.accountId,
      });
    }
    const [items, total] = await builder.skip((page - 1) * pageSize).take(pageSize).getManyAndCount();
    return { items, total };
  }

  /** 任务概览：按状态计数 + 当日成败 + 最近一次错误（后台总览与告警共用口径） */
  async summary(): Promise<MirrorTaskSummary> {
    const grouped = await this.repo.createQueryBuilder('task')
      .select('task.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('task.status')
      .getRawMany<{ status: TelegramMirrorTaskStatus; count: string | number }>();

    const byStatus = new Map<string, number>();
    for (const row of grouped) {
      byStatus.set(row.status, Number(row.count) || 0);
    }

    const dayStart = startOfLocalDay();
    const [todaySucceeded, todayFailed, todayBlocked] = await Promise.all([
      this.repo.createQueryBuilder('task')
        .where('task.status = :status', { status: 'succeeded' })
        .andWhere('task.completedAt >= :start', { start: dayStart })
        .getCount(),
      this.repo.createQueryBuilder('task')
        .where('task.status = :status', { status: 'failed' })
        .andWhere('task.completedAt >= :start', { start: dayStart })
        .getCount(),
      this.repo.createQueryBuilder('task')
        .where('task.status = :status', { status: 'blocked' })
        .andWhere('task.completedAt >= :start', { start: dayStart })
        .getCount(),
    ]);

    const [lastErrorTask] = await this.repo.createQueryBuilder('task')
      .where('task.lastErrorCode IS NOT NULL')
      .orderBy('task.updatedAt', 'DESC')
      .take(1)
      .getMany();

    return {
      queued: byStatus.get('queued') ?? 0,
      running: byStatus.get('running') ?? 0,
      succeeded: byStatus.get('succeeded') ?? 0,
      retrying: byStatus.get('retrying') ?? 0,
      failed: byStatus.get('failed') ?? 0,
      blocked: byStatus.get('blocked') ?? 0,
      cancelled: byStatus.get('cancelled') ?? 0,
      todaySucceeded,
      todayFailed,
      todayBlocked,
      lastError: lastErrorTask
        ? {
          code: lastErrorTask.lastErrorCode ?? null,
          summary: lastErrorTask.lastErrorSummary ?? null,
          at: new Date(lastErrorTask.updatedAt).toISOString(),
        }
        : null,
    };
  }

  /** 手动重试：blocked/failed/cancelled 的任务重置为 queued 并重新入队 */
  async retry(id: string, actorId: string): Promise<TelegramMirrorTask> {
    const task = await this.repo.findOne({ where: { id } });
    if (!task) throw new NotFoundException('镜像任务不存在');
    if (task.status === 'succeeded') throw new BadRequestException('任务已成功，无需重试');
    if (task.status === 'running') throw new BadRequestException('任务正在执行中');

    await this.repo.update({ id }, {
      status: 'queued',
      attempts: 0,
      receiptPending: task.receiptPending,
      nextRetryAt: null,
      completedAt: null,
    });
    const refreshed = (await this.repo.findOne({ where: { id } })) as TelegramMirrorTask;
    await this.safeAddJob(refreshed);
    this.audit.log({
      action: 'telegram_mirror_task_retried',
      userId: actorId,
      resourceType: 'telegram_mirror_task',
      resourceId: id,
      metadata: { ownerType: task.ownerType, previousStatus: task.status, mode: task.mode },
    });
    return refreshed;
  }

  /** 取消：只允许取消尚未开始的任务（running 不允许中断，避免留下半个备份） */
  async cancel(id: string, actorId: string): Promise<TelegramMirrorTask> {
    const task = await this.repo.findOne({ where: { id } });
    if (!task) throw new NotFoundException('镜像任务不存在');
    if (task.status === 'running') {
      throw new BadRequestException('任务正在执行，无法取消（避免产生半个备份）；请等待其结束');
    }
    if (task.status === 'succeeded') throw new BadRequestException('任务已成功，无需取消');

    await this.repo.update({ id }, {
      status: 'cancelled',
      lastErrorCode: 'cancelled',
      lastErrorSummary: '管理员取消',
      nextRetryAt: null,
      completedAt: new Date(),
    });
    this.audit.log({
      action: 'telegram_mirror_task_cancelled',
      userId: actorId,
      resourceType: 'telegram_mirror_task',
      resourceId: id,
      metadata: { ownerType: task.ownerType, previousStatus: task.status },
    });
    return (await this.repo.findOne({ where: { id } })) as TelegramMirrorTask;
  }

  /**
   * 该归属对象在某条规则上**最新版本**的任务（手动重试的定位入口）。
   *
   * 按 `sourceVersion DESC` 取一条：文件被覆盖上传后会有多版本任务，
   * 重试必须落在最新版本上，否则等于把旧内容重新扩散一遍。
   */
  async findLatestForOwner(
    ruleId: string,
    ownerType: TelegramMirrorTask['ownerType'],
    ownerId: string,
  ): Promise<TelegramMirrorTask | null> {
    return this.repo.findOne({
      where: { ruleId, ownerType, ownerId },
      order: { sourceVersion: 'DESC', createdAt: 'DESC' },
    });
  }

  /** 终态集合：这些状态的任务可以被「手动重试」重新激活（在途状态不重复投递） */
  static readonly TERMINAL_STATUSES: TelegramMirrorTask['status'][] = ['succeeded', 'failed', 'blocked', 'cancelled'];

  /**
   * 把终态任务重置为 `queued` 并重新入队（管理员手动重试的唯一入口）。
   *
   * 与「新建任务」的区别：复用同一行（保留幂等键与历史），因此不会产生重复备份；
   * 回执字段一并清理，避免旧的 `receiptPending` 让消费者误判为「已经转发过」。
   */
  async requeueTerminal(task: TelegramMirrorTask, operatorUserId: string): Promise<boolean> {
    if (!TelegramMirrorTaskService.TERMINAL_STATUSES.includes(task.status)) return false;
    await this.repo.update({ id: task.id }, {
      status: 'queued',
      attempts: 0,
      lastErrorCode: null,
      lastErrorSummary: null,
      nextRetryAt: null,
      receiptPending: false,
      targetAccountId: null,
      targetChatId: null,
      targetMessageId: null,
      targetTelegramFileId: null,
      startedAt: null,
      completedAt: null,
    });
    const fresh: TelegramMirrorTask = {
      ...task,
      status: 'queued',
      attempts: 0,
      lastErrorCode: null,
      lastErrorSummary: null,
      nextRetryAt: null,
      receiptPending: false,
      targetAccountId: null,
      targetChatId: null,
      targetMessageId: null,
      targetTelegramFileId: null,
      startedAt: null,
      completedAt: null,
    };
    await this.safeAddJob(fresh);
    this.audit.log({
      action: 'config_change',
      userId: operatorUserId,
      resourceType: 'telegram_mirror_task',
      resourceId: task.id,
      metadata: {
        reason: 'manual_retry',
        previousStatus: task.status,
        ruleId: task.ruleId,
        ownerType: task.ownerType,
        sourceVersion: task.sourceVersion,
      },
    });
    this.logger.log(`镜像任务已按人工重试重新入队（${task.id} / 规则 ${task.ruleId}）`);
    return true;
  }

  /**
   * 延迟重试入队。
   *
   * 为什么 jobId 要带后缀：首次入队用确定性 jobId 去重（同一任务不重复入队），
   * 而 Bull 会**拒绝复用已存在的 jobId**——重试若沿用同一个 jobId，job 会被静默丢弃。
   * 因此重试使用「幂等键 + 尝试次数 + 时间」的唯一 jobId；重复投递由状态机
   * 的原子领取（claim）兜底，不会重复备份。
   */
  async scheduleRetry(task: TelegramMirrorTask, delayMs: number): Promise<void> {
    const jobId = `${this.buildJobId(task)}#r${task.attempts}-${Date.now()}`;
    try {
      await this.queue.add(
        'mirror',
        { taskId: task.id, ruleId: task.ruleId },
        {
          jobId,
          delay: Math.min(Math.max(0, delayMs), MIRROR_RETRY_MAX_MS),
          attempts: 1,             // 重试由任务状态机 + 延迟入队控制（避免 Bull 与 DB 双重计数）
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch (error) {
      this.logger.error(
        `镜像任务重试入队失败（任务 ${task.id} 已持久化，等待恢复）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 首次入队（失败不抛出：任务已持久化，重启恢复时会重新入队）。
   *
   * 必须先释放同 jobId 的终态 job：Bull 的 addJob 脚本遇到已存在的 jobId 会
   * **静默返回旧 job（不新建、不执行）**。确定性 jobId 用于「同一任务不重复入队」，
   * 但任务也可能**再次需要执行**（开关关闭→退回 queued、管理员手动重试），
   * 若此时旧 job 仍留在 completed/failed 集合里，新 job 会被静默丢弃，
   * 任务将永远停留在 queued（直接违背「关开关不丢任务」的承诺）。
   */
  private async safeAddJob(task: TelegramMirrorTask): Promise<void> {
    const jobId = this.buildJobId(task);
    await this.releaseTerminalJob(jobId);
    try {
      await this.queue.add(
        'mirror',
        { taskId: task.id, ruleId: task.ruleId },
        {
          jobId,
          attempts: 1,
          // 终态 job 立即清除：任务事实以数据库为唯一来源，Bull 不需要保留历史
          // （保留还会长期占用 jobId，阻断同任务再次入队）
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch (error) {
      this.logger.error(
        `镜像任务入队失败（任务 ${task.id} 已持久化，等待恢复）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 移除同 jobId 的终态 job（completed/failed），为「再次执行」腾出 jobId */
  private async releaseTerminalJob(jobId: string): Promise<void> {
    try {
      const existing = await this.queue.getJob(jobId);
      if (!existing) return;
      const state = await existing.getState();
      if (state === 'completed' || state === 'failed') {
        await existing.remove();
      }
    } catch (error) {
      // 清理失败不阻断入队：process 侧的原子领取仍保证幂等
      this.logger.warn(
        `清理旧镜像 job 失败（jobId=${jobId}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** 当日 0 点（按服务器本地时区；仅用于「今日概况」口径，不参与幂等判定） */
function startOfLocalDay(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

export { MIRROR_RETRY_BASE_MS };
