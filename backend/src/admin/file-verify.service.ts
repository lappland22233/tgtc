import { Injectable, Logger, ServiceUnavailableException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Repository, In } from 'typeorm';
import { Queue } from 'bull';
import { v4 as uuidv4 } from 'uuid';
import { FileVerifyTask, FILE_VERIFY_ACTIVE_STATUSES } from '../common/entities/file-verify-task.entity';
import { File } from '../common/entities/file.entity';
import { User } from '../common/entities/user.entity';
import { TelegramService } from '../telegram/telegram.service';
import { TelegramFileNotFoundError } from '../telegram/telegram.errors';
import { AuditService } from '../common/services/audit.service';
import { QUEUE_NAMES } from '../jobs/bull-queue.module';
import { databaseCurrentTimestamp } from '../database/database-types';

interface FileVerifyStats {
  totalCandidates: number;
  checked: number;
  valid: number;
  invalid: number;
  emptyFileId: number;
  temporaryFailure: number;
  sizeMismatch: number;
  backfilled: number;
  markedError: number;
}

@Injectable()
export class FileVerifyService implements OnModuleInit {
  private readonly logger = new Logger(FileVerifyService.name);

  constructor(
    @InjectRepository(FileVerifyTask)
    private fileVerifyTaskRepository: Repository<FileVerifyTask>,
    @InjectRepository(File)
    private fileRepository: Repository<File>,
    private telegramService: TelegramService,
    private auditService: AuditService,
    @InjectQueue(QUEUE_NAMES.FILE_VERIFY)
    private fileVerifyQueue: Queue,
  ) {}

  /**
   * 启动期孤儿任务恢复：进程可能在"任务入库"与"投递 Bull 队列"之间崩溃，
   * 导致 DB 残留 isActive=true/status='queued' 但队列中不存在对应 job 的任务，
   * 永久占用唯一活动槽位。启动时扫描并校验队列，无对应 job 的任务标记为 failed。
   */
  async onModuleInit(): Promise<void> {
    await this.recoverOrphanTasks();
  }

  /** running 任务的合理存活上限（分钟）：超过后即使队列仍存在 job 也视为卡死孤儿 */
  private static readonly RUNNING_ORPHAN_TIMEOUT_MIN = 60;

  private async recoverOrphanTasks(): Promise<void> {
    try {
      // 恢复扫描纳入 queued + running：running 任务被 kill 后 DB 可能永久停留 running/isActive=true，
      // 占用唯一活动槽位并阻塞新任务。queued 按队列校验；running 若队列中无 job，
      // 或 startedAt 超过合理上限（进程崩溃前已开始但从未完成）则标记失败释放槽位。
      const orphanCandidates = await this.fileVerifyTaskRepository.find({
        where: { isActive: true, status: In(['queued', 'running']) },
      });
      const runningTimeoutMs = FileVerifyService.RUNNING_ORPHAN_TIMEOUT_MIN * 60 * 1000;
      for (const task of orphanCandidates) {
        // 仅当 Bull 队列中不存在对应 job 时才视为孤儿（正常排队任务不受影响）
        const job = await this.fileVerifyQueue.getJob(task.taskId);
        if (!job) {
          this.logger.warn(`清理孤儿文件体检任务 taskId=${task.taskId}`);
          await this.markFailed(task.taskId, new Error('任务在入队前中断，已由系统标记失败'));
          continue;
        }
        // running 任务即使队列中存在 job，若 startedAt 远早于当前时间（进程崩溃后
        // Bull stalled job 未重投递），判定为卡死孤儿并标记失败释放活动槽位。
        if (task.status === 'running' && task.startedAt) {
          const startedMs = new Date(task.startedAt).getTime();
          if (Number.isFinite(startedMs) && Date.now() - startedMs > runningTimeoutMs) {
            this.logger.warn(`清理卡死运行中的文件体检任务 taskId=${task.taskId} startedAt=${task.startedAt.toISOString()}`);
            await this.markFailed(task.taskId, new Error('任务运行超过合理上限，已由系统标记失败'));
          }
        }
      }
    } catch (error) {
      // 清理失败不影响应用启动，仅记录
      this.logger.warn(`孤儿文件体检任务清理失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 创建文件体检异步任务：立即持久化任务并投递 Bull 队列（HTTP 202 语义）。
   * 若已有活动任务（唯一索引冲突），返回现有活动任务且不重复入队。
   */
  async createTask(
    user: User,
    dto: { mode?: 'dry-run' | 'apply'; allReady?: boolean; limit?: number; concurrency?: number },
  ): Promise<{ task: FileVerifyTask; isNewTask: boolean }> {
    const mode = dto.mode === 'apply' ? 'apply' : 'dry-run';
    const limit = Math.max(1, Math.min(2000, dto.limit ?? 500));
    const concurrency = Math.max(1, Math.min(8, dto.concurrency ?? 4));

    const taskId = uuidv4();
    const task = this.fileVerifyTaskRepository.create({
      taskId,
      createdBy: user.id,
      mode,
      allReady: !!dto.allReady,
      limit,
      concurrency,
    });

    try {
      await this.fileVerifyTaskRepository.insert(task);
    } catch (error) {
      // 唯一约束冲突：已有活动任务（isActive=true 的部分唯一索引）
      if ((error as any)?.code === '23505' || (error as any)?.driverError?.code === '23505') {
        const active = await this.fileVerifyTaskRepository.findOne({ where: { isActive: true } });
        if (active) {
          return { task: active, isNewTask: false };
        }
      }
      throw error;
    }

    try {
      // G8-21：瞬时 DB/Redis 抖动不应直接终态失败且清空 job 记录。提高 attempts 并配
      // exponential backoff 实现自动重试；removeOnFail:false 保留失败 job 供排查。
      // markStarted 已支持 running 接管（running → running），重试安全。
      await this.fileVerifyQueue.add(
        'verify',
        { taskId },
        {
          jobId: taskId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
    } catch (error) {
      // 入队失败（Redis 不可用等）：标记失败并释放槽位，避免永久占用活动槽位
      const summary = this.sanitizeSummary(
        `体检任务入队失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.fileVerifyTaskRepository
        .createQueryBuilder()
        .update(FileVerifyTask)
        .set({ status: 'failed', isActive: false, errorSummary: summary, completedAt: () => databaseCurrentTimestamp() })
        .where('taskId = :taskId', { taskId })
        .andWhere("status = 'queued'")
        .execute();
      throw new ServiceUnavailableException('体检任务创建失败，请稍后重试');
    }

    return { task, isNewTask: true };
  }

  /** 获取当前活动任务（queued/running） */
  async getActiveTask(): Promise<FileVerifyTask | null> {
    return this.fileVerifyTaskRepository.findOne({
      where: { isActive: true, status: In(FILE_VERIFY_ACTIVE_STATUSES) },
    });
  }

  /** 按 taskId 查询任务 */
  async getTask(taskId: string): Promise<FileVerifyTask | null> {
    return this.fileVerifyTaskRepository.findOne({ where: { taskId } });
  }

  /**
   * 转换为对外视图：附带 progress（0～100）。
   * 总数大于零时按 processed / totalCandidates 计算并限制在 0～100；
   * 零候选完成任务返回 100，零候选未完成返回 0。
   */
  toView(task: FileVerifyTask): {
    taskId: string;
    status: FileVerifyTask['status'];
    mode: FileVerifyTask['mode'];
    allReady: boolean;
    limit: number;
    concurrency: number;
    totalCandidates: number;
    processed: number;
    progress: number;
    valid: number;
    invalid: number;
    emptyFileId: number;
    temporaryFailure: number;
    sizeMismatch: number;
    backfilled: number;
    markedError: number;
    errorSummary: string | null;
    createdAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
  } {
    const { totalCandidates, processed, status } = task;
    let progress: number;
    if (totalCandidates === 0) {
      progress = status === 'completed' ? 100 : 0;
    } else {
      progress = Math.min(100, Math.floor((processed / totalCandidates) * 100));
    }
    return {
      taskId: task.taskId,
      status: task.status,
      mode: task.mode,
      allReady: task.allReady,
      limit: task.limit,
      concurrency: task.concurrency,
      totalCandidates,
      processed,
      progress,
      valid: task.valid,
      invalid: task.invalid,
      emptyFileId: task.emptyFileId,
      temporaryFailure: task.temporaryFailure,
      sizeMismatch: task.sizeMismatch,
      backfilled: task.backfilled,
      markedError: task.markedError,
      errorSummary: task.errorSummary,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
    };
  }

  /**
   * 文件体检执行体（由 Bull 队列触发）。
   * 增量更新任务状态与进度，所有写库更新均带 status IN ('queued','running') 守卫。
   */
  async runVerification(taskId: string): Promise<void> {
    const task = await this.markStarted(taskId);
    if (!task) {
      // 任务已达终态（completed/failed），直接返回，避免重复执行
      return;
    }
    const createdBy = task.createdBy;

    const stats: FileVerifyStats = {
      totalCandidates: 0,
      checked: 0,
      valid: 0,
      invalid: 0,
      emptyFileId: 0,
      temporaryFailure: 0,
      sizeMismatch: 0,
      backfilled: 0,
      markedError: 0,
    };

    const qb = this.fileRepository
      .createQueryBuilder('file')
      .select(['file.id', 'file.originalName', 'file.size', 'file.telegramFileId', 'file.telegramFilePath', 'file.uploadVersion'])
      .where('file.isDeleted = false')
      .andWhere("file.status = 'ready'");

    if (task.allReady !== true) {
      qb.andWhere('(file."telegramFilePath" IS NULL OR file."telegramFilePath" = \'\')');
    }
    qb.orderBy('file."createdAt"', 'ASC').limit(task.limit);

    const candidates = await qb.getMany();
    stats.totalCandidates = candidates.length;

    // 空候选：直接完成，不调用 Telegram
    if (candidates.length === 0) {
      await this.markCompleted(taskId, stats);
      this.logger.log(`文件体检完成 taskId=${taskId} checked=0 totalCandidates=0`);
      return;
    }

    this.logger.log(`文件体检开始 taskId=${taskId} mode=${task.mode} totalCandidates=${candidates.length} concurrency=${task.concurrency}`);

    // 有限并发分批执行校验，单条临时错误不中止整批
    let cursor = 0;
    while (cursor < candidates.length) {
      const batch = candidates.slice(cursor, cursor + task.concurrency);
      cursor += task.concurrency;
      await Promise.all(
        batch.map(async (file) => {
          stats.checked++;
          const remoteFileId = file.telegramFileId?.trim?.();
          if (!remoteFileId) {
            // 无 file_id 必然不可下载，apply 时标记 error（条件更新）
            if (task.mode === 'apply') {
              await this.fileRepository
                .createQueryBuilder()
                .update(File)
                .set({
                  status: 'error' as const,
                  uploadStage: 'failed' as const,
                  uploadFailureReason: 'Telegram 文件引用缺失，已标记上传失败',
                })
                .where('id = :id', { id: file.id })
                .andWhere("status = 'ready'")
                .andWhere('uploadVersion = :version', { version: file.uploadVersion })
                .execute();
              stats.markedError++;
            }
            stats.emptyFileId++;
            return;
          }

          try {
            // 轻量探测仅调用 Telegram /getFile；成功返回元数据即视为文件有效，不下载内容。
            const meta = await this.telegramService.verifyFileExists(remoteFileId);
            if (meta.file_size > 0 && file.size !== meta.file_size) {
              // 大小差异仅保留观察统计，不影响 valid 判定，也不会触发内容下载复核。
              stats.sizeMismatch++;
            }
            // 标准 getFile 可回填路径；metadata_only 响应不含本地路径时跳过，避免空值回填与误计数。
            if (task.mode === 'apply' && (!file.telegramFilePath || !file.telegramFilePath.trim()) && meta.file_path) {
              await this.fileRepository
                .createQueryBuilder()
                .update(File)
                .set({ telegramFilePath: meta.file_path })
                .where('id = :id', { id: file.id })
                .andWhere("status = 'ready'")
                .andWhere('uploadVersion = :version', { version: file.uploadVersion })
                .execute();
              stats.backfilled++;
            }
            stats.valid++;
          } catch (error) {
            if (error instanceof TelegramFileNotFoundError) {
              // 永久失效：apply 时条件标记 error
              if (task.mode === 'apply') {
                await this.fileRepository
                  .createQueryBuilder()
                  .update(File)
                  .set({
                    status: 'error' as const,
                    uploadStage: 'failed' as const,
                    uploadFailureReason: 'Telegram 文件不存在或已失效，已标记上传失败',
                  })
                  .where('id = :id', { id: file.id })
                  .andWhere("status = 'ready'")
                  .andWhere('uploadVersion = :version', { version: file.uploadVersion })
                  .execute();
                stats.markedError++;
              }
              stats.invalid++;
            } else {
              // 暂时性错误（超时/429/5xx/Bot 暂时不可用）：仅统计，不修改
              stats.temporaryFailure++;
            }
          }
        }),
      );

      // 每批完成后更新进度（带 status 守卫，终态不可被回写）
      await this.updateProgress(taskId, stats);
      this.logger.log(
        `文件体检批次 taskId=${taskId} checked=${stats.checked}/${stats.totalCandidates}`,
      );
    }

    // 脱敏审计：仅记录统计摘要，不记录完整 file_id / 文件名列表
    const auditEntry = {
      action: 'file_verify' as const,
      userId: createdBy,
      resourceType: 'file' as const,
      resourceId: taskId,
      metadata: { ...stats, taskId },
    };
    if (task.mode === 'apply') {
      // G8-22：apply 模式会批量将文件标记 error（不可逆），属高敏审计。改用 logAwait 确保
      // 落库，避免 fire-and-forget 在审计队列满时（audit.service 上限）被静默丢弃。
      // logAwait 内置重试 + 降级文件；FAIL_FAST 默认关闭，不会阻断体检主流程。
      try {
        await this.auditService.logAwait(auditEntry);
      } catch {
        // 显式开启 AUDIT_FAIL_FAST 时 logAwait 可能抛出，审计失败不阻断体检主流程
        this.logger.warn(`apply 体检审计写入失败（不阻断） taskId=${taskId}`);
      }
    } else {
      // dry-run 仅统计、不修改数据，非高敏，沿用 fire-and-forget
      this.auditService.log(auditEntry);
    }

    await this.markCompleted(taskId, stats);
    this.logger.log(
      `文件体检完成 taskId=${taskId} checked=${stats.checked} valid=${stats.valid} invalid=${stats.invalid} ` +
        `emptyFileId=${stats.emptyFileId} temporaryFailure=${stats.temporaryFailure} markedError=${stats.markedError} backfilled=${stats.backfilled}`,
    );
  }

  /**
   * 标记任务开始（queued → running），返回任务实体；已达终态（completed/failed）返回 null。
   * 同时允许 running → running（Bull 在进程崩溃后对 stalled job 重新投递，视为"接管执行"），
   * 避免任务卡死在 running 而永久占用活动槽位。全局单任务 + processor concurrency:1
   * + Bull 锁机制保证正常情况不会并发执行同一任务。
   */
  private async markStarted(taskId: string): Promise<FileVerifyTask | null> {
    const result = await this.fileVerifyTaskRepository
      .createQueryBuilder()
      .update(FileVerifyTask)
      .set({ status: 'running', startedAt: () => databaseCurrentTimestamp() })
      .where('taskId = :taskId', { taskId })
      .andWhere("status IN ('queued','running')")
      .execute();
    if ((result.affected ?? 0) === 0) {
      return null;
    }
    return this.fileVerifyTaskRepository.findOne({ where: { taskId } });
  }

  /** 增量更新进度（带 status 守卫，终态不可被回写） */
  private async updateProgress(taskId: string, stats: FileVerifyStats): Promise<void> {
    await this.fileVerifyTaskRepository
      .createQueryBuilder()
      .update(FileVerifyTask)
      .set({
        totalCandidates: stats.totalCandidates,
        processed: stats.checked,
        valid: stats.valid,
        invalid: stats.invalid,
        emptyFileId: stats.emptyFileId,
        temporaryFailure: stats.temporaryFailure,
        sizeMismatch: stats.sizeMismatch,
        backfilled: stats.backfilled,
        markedError: stats.markedError,
      })
      .where('taskId = :taskId', { taskId })
      .andWhere("status IN ('queued','running')")
      .execute();
  }

  /** 标记任务完成并释放活动槽位（带 status 守卫） */
  private async markCompleted(taskId: string, stats: FileVerifyStats): Promise<void> {
    await this.fileVerifyTaskRepository
      .createQueryBuilder()
      .update(FileVerifyTask)
      .set({
        status: 'completed',
        isActive: false,
        totalCandidates: stats.totalCandidates,
        processed: stats.checked,
        valid: stats.valid,
        invalid: stats.invalid,
        emptyFileId: stats.emptyFileId,
        temporaryFailure: stats.temporaryFailure,
        sizeMismatch: stats.sizeMismatch,
        backfilled: stats.backfilled,
        markedError: stats.markedError,
        completedAt: () => databaseCurrentTimestamp(),
      })
      .where('taskId = :taskId', { taskId })
      .andWhere("status IN ('queued','running')")
      .execute();
  }

  /** 标记任务失败并释放活动槽位（带 status 守卫），脱敏错误摘要 */
  async markFailed(taskId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const summary = this.sanitizeSummary(message);
    await this.fileVerifyTaskRepository
      .createQueryBuilder()
      .update(FileVerifyTask)
      .set({ status: 'failed', isActive: false, errorSummary: summary, completedAt: () => databaseCurrentTimestamp() })
      .where('taskId = :taskId', { taskId })
      .andWhere("status IN ('queued','running')")
      .execute();
    this.logger.error(`文件体检任务失败 taskId=${taskId} errorSummary=${summary}`);
  }

  /**
   * 将错误摘要安全化为可持久化的诊断文本：
   * 不保存本地路径、Token、控制字符或冗长堆栈，长度受限后写入 DB。
   */
  private sanitizeSummary(message: string): string {
    return message
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      // 本地/远端路径脱敏：Windows 盘符路径（C:\...）与 Unix 多段路径（/a/b/c）
      .replace(/([A-Za-z]:[\\/][^\s:]*|\/(?:[^\/\s]+\/)+[^\/\s]+)/g, '[path]')
      // 长 token / file_id / JWT 脱敏
      .replace(/[A-Za-z0-9_-]{24,}/g, '[token]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1000);
  }
}
