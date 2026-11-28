import { pendingUploadDirectory, pendingUploadName } from '../file/pending-upload';
import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, IsNull, Brackets } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { readFile, readdir, stat, unlink } from 'fs/promises';
import * as path from 'path';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { ShareAudit } from '../common/entities/share-audit.entity';
import { RateLimit } from '../common/entities/rate-limit.entity';
import { AuditLog } from '../common/entities/audit-log.entity';
import { JwtRevokedToken } from '../common/entities/jwt-revoked-token.entity';
import { File } from '../common/entities/file.entity';
import { TelegramBotFileGrant } from '../common/entities/telegram-bot-file-grant.entity';
import { StorageRouterService } from '../storage/storage-router.service';
import { BotTransferTrackerService } from '../telegram-bot/bot-transfer-tracker.service';
import { QUEUE_NAMES } from '../jobs/bull-queue.module';
import { isRemoteStorageBackend } from '../storage/storage.types';

/** 僵尸 processing 自动恢复的固定失败原因（不复用可能失效的旧 Telegram 引用） */
export const STALE_PROCESSING_FAILURE_REASON = '上传任务超时，已自动标记失败，请重新上传';

/** 远端引用是否有效（TG 校验 file_id；非 TG 校验对象引用，可插拔存储恢复口径） */
function hasValidRemoteRef(file: File): boolean {
  if (isRemoteStorageBackend(file.storageBackend)) {
    return Boolean(file.storageObjectRef?.trim());
  }
  return Boolean(file.telegramFileId?.trim());
}

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    @InjectRepository(BannedIP)
    private bannedIPRepository: Repository<BannedIP>,
    @InjectRepository(ShareAudit)
    private shareAuditRepository: Repository<ShareAudit>,
    @InjectRepository(RateLimit)
    private rateLimitRepository: Repository<RateLimit>,
    @InjectRepository(AuditLog)
    private auditLogRepository: Repository<AuditLog>,
    @InjectRepository(JwtRevokedToken)
    private revokedTokenRepository: Repository<JwtRevokedToken>,
    @InjectRepository(File)
    private fileRepository: Repository<File>,
    @InjectQueue(QUEUE_NAMES.FILE_UPLOAD)
    private fileUploadQueue: Queue,
    @Optional() @InjectRepository(TelegramBotFileGrant)
    private grantRepository?: Repository<TelegramBotFileGrant>,
    @Optional() @Inject(StorageRouterService)
    private storageRouter: StorageRouterService | null = null,
    @Optional() @Inject(BotTransferTrackerService)
    private transferTracker?: BotTransferTrackerService,
  ) {}

  /** 失败的远端清理记录重试调度（grantId -> { attempts, nextRetry }），防止失败记录饥饿后续正常文件 */
  private readonly purgeRetrySchedule = new Map<string, { attempts: number; nextRetry: number }>();

  /**
   * 定时清理已过期的 Bot 远端文件（Google 云端硬盘），并打上清理时间戳。
   * 每 10 分钟执行一次。
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async cleanupExpiredBotRemoteFiles() {
    // 独立清理 tmp/bot-transfers/ 下残留超过 2 小时的本地孤儿文件（进程异常重启产生），
    // 绝不因远端 grant 数量为 0 或存储模块未装配而跳过
    await this.cleanupOrphanBotTransferFiles();

    if (!this.storageRouter || !this.grantRepository) return;
    try {
      const now = new Date();
      const nowMs = now.getTime();

      // 分页扫描待清理记录，跳过重试冷却中的记录，防止失败记录（如凭据已吊销的账号）饥饿阻塞后续正常文件
      const BATCH_SIZE = 100;
      const MAX_SCAN_PAGES = 5;
      const eligibleGrants: TelegramBotFileGrant[] = [];

      const inCoolingIds = Array.from(this.purgeRetrySchedule.entries())
        .filter(([_, r]) => nowMs < r.nextRetry)
        .map(([id]) => id)
        .slice(0, 500);

      for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
        const qb = this.grantRepository
          .createQueryBuilder('grant')
          .where(
            '((grant.storageBackend = :backend AND grant.storageObjectRef IS NOT NULL) OR (grant.gdriveCacheObjectRef IS NOT NULL))',
            { backend: 'gdrive' },
          )
          .andWhere('grant.storagePurgedAt IS NULL')
          .andWhere('(grant.expiresAt < :now OR grant.revokedAt IS NOT NULL)', { now });

        if (inCoolingIds.length > 0) {
          qb.andWhere('grant.id NOT IN (:...inCoolingIds)', { inCoolingIds });
        }

        qb.orderBy('grant.expiresAt', 'ASC');

        if (typeof (qb as any).offset === 'function') {
          (qb as any).offset(page * BATCH_SIZE);
        } else if (typeof (qb as any).skip === 'function') {
          (qb as any).skip(page * BATCH_SIZE);
        }

        const grants = await qb.limit(BATCH_SIZE).getMany();
        if (!grants || grants.length === 0) break;

        for (const grant of grants) {
          const retry = this.purgeRetrySchedule.get(grant.id);
          if (!retry || nowMs >= retry.nextRetry) {
            eligibleGrants.push(grant);
            if (eligibleGrants.length >= BATCH_SIZE) break;
          }
        }

        if (eligibleGrants.length >= BATCH_SIZE) break;
      }

      if (eligibleGrants.length === 0) return;

      let deletedCount = 0;
      for (const grant of eligibleGrants) {
        const accountId = grant.storageBackend === 'gdrive' ? grant.storageAccountId : grant.gdriveCacheAccountId;
        const objectRef = grant.storageBackend === 'gdrive' ? grant.storageObjectRef : grant.gdriveCacheObjectRef;
        if (!accountId || !objectRef) continue;
        try {
          const success = await this.storageRouter.deleteRemoteObject('gdrive', accountId, objectRef);
          // [P0-06 Fix]: 校验 deleteRemoteObject 返回值，仅当删除确认成功时才置 storagePurgedAt
          if (success) {
            grant.storagePurgedAt = new Date();
            await this.grantRepository.save(grant);
            this.purgeRetrySchedule.delete(grant.id);
            deletedCount += 1;
          } else {
            const attempts = (this.purgeRetrySchedule.get(grant.id)?.attempts ?? 0) + 1;
            const backoffMs = Math.min(24 * 60 * 60 * 1000, 10 * 60 * 1000 * Math.pow(2, attempts - 1));
            this.purgeRetrySchedule.set(grant.id, { attempts, nextRetry: nowMs + backoffMs });
            this.logger.warn(
              `清理过期 Bot GDrive 文件未确认成功（连续失败 ${attempts} 次），将在 ${Math.round(backoffMs / 60000)} 分钟后重试（grant=${grant.id}, objectRef=${grant.storageObjectRef}）`,
            );
          }
        } catch (error) {
          const attempts = (this.purgeRetrySchedule.get(grant.id)?.attempts ?? 0) + 1;
          const backoffMs = Math.min(24 * 60 * 60 * 1000, 10 * 60 * 1000 * Math.pow(2, attempts - 1));
          this.purgeRetrySchedule.set(grant.id, { attempts, nextRetry: nowMs + backoffMs });
          this.logger.warn(
            `清理过期 Bot GDrive 文件失败（grant=${grant.id}, objectRef=${grant.storageObjectRef}）: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (deletedCount > 0) {
        this.logger.log(`已成功从 Google 云端硬盘彻底删除 ${deletedCount} 个到期的 Bot 临时文件`);
      }
    } catch (error) {
      this.logger.error('执行到期 Bot 远端文件自动清理任务失败', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 定期清理本地缓冲目录 tmp/bot-transfers/ 中残留超过 2 小时的孤儿临时文件
   */
  private async cleanupOrphanBotTransferFiles(): Promise<void> {
    try {
      const tempDir = path.join(process.cwd(), 'tmp', 'bot-transfers');
      const files = await readdir(tempDir).catch(() => []);
      const now = Date.now();
      const MAX_ORPHAN_AGE_MS = 2 * 60 * 60 * 1000; // 2 小时
      for (const file of files) {
        const fullPath = path.join(tempDir, file);
        // 若该临时文件正属于活跃转存传输任务，绝不清理（防止大文件长耗时上传被误删导致 failover 失败）
        if (this.transferTracker?.isTransferActive(fullPath)) {
          continue;
        }
        try {
          const fileStat = await stat(fullPath);
          if (now - fileStat.mtimeMs > MAX_ORPHAN_AGE_MS) {
            await unlink(fullPath).catch(() => {});
            this.logger.debug(`已清理残留超过 2 小时的本地临时转存文件: ${file}`);
          }
        } catch {
          // ignore individual file stat/unlink errors
        }
      }
    } catch {
      // ignore
    }
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async cleanupExpiredRateLimits() {
    try {
      // 只清理已过期且未锁定的记录，避免误删仍在生效的限流记录
      // 使用 Brackets 显式分组 OR 条件，避免 orWhere 优先级脆弱导致误删
      const now = new Date();
      const cutoff = new Date(Date.now() - 60 * 60 * 1000);
      const result = await this.rateLimitRepository
        .createQueryBuilder()
        .delete()
        .from(RateLimit)
        .where(
          new Brackets((qb) => {
            qb.where('("lockedUntil" IS NOT NULL AND "lockedUntil" < :now)', { now })
              .orWhere('("lockedUntil" IS NULL AND "updatedAt" < :cutoff)', { cutoff });
          }),
        )
        .execute();
      if ((result.affected ?? 0) > 0) {
        this.logger.log(`已清理 ${result.affected} 条过期限流记录`);
      }
    } catch (error: unknown) {
      this.logger.error('清理过期限流记录失败', error instanceof Error ? error.message : String(error));
    }
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async cleanupExpiredAccessTokens() {
    try {
      // 清理超过 5 分钟的已消费 token 记录（正常 token 30s 过期，留足余量）
      const cutoff = new Date(Date.now() - 5 * 60 * 1000);
      const result = await this.shareAuditRepository.delete({
        action: 'consume',
        createdAt: LessThan(cutoff),
      });
      if ((result.affected ?? 0) > 0) {
        this.logger.log(`已清理 ${result.affected} 条过期访问 token 记录`);
      }
    } catch (error: unknown) {
      this.logger.error('清理过期 token 记录失败', error instanceof Error ? error.message : String(error));
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredRevokedTokens() {
    try {
      const result = await this.revokedTokenRepository.delete({ expiresAt: LessThan(new Date()) });
      if ((result.affected ?? 0) > 0) {
        this.logger.log(`已清理 ${result.affected} 条过期 JWT 吊销记录`);
      }
    } catch (error: unknown) {
      this.logger.error('清理过期 JWT 吊销记录失败', error instanceof Error ? error.message : String(error));
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredBans() {
    try {
      const result = await this.bannedIPRepository.update(
        { isPermanent: false, expiresAt: LessThan(new Date()), unbannedAt: IsNull() },
        { unbannedAt: new Date() },
      );
      if ((result.affected ?? 0) > 0) {
        this.logger.log(`已清理 ${result.affected} 条过期封禁记录`);
      }
    } catch (error: unknown) {
      this.logger.error('清理过期封禁记录失败', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 清理过期的审计日志（每天凌晨 3 点执行）
   * 保留策略：默认保留最近 90 天，可通过 AUDIT_LOG_RETENTION_DAYS 配置
   * 使用分批删除防止大表一次性 DELETE 导致长事务和大量 WAL
   */
  @Cron('0 3 * * *')
  async cleanupExpiredAuditLogs() {
    try {
      // 校验保留期：Math.max(7, ...) 确保最少保留 7 天，
      // parseInt(...) || 90 防止 NaN/0/负数误删全部审计日志
      const retentionDays = Math.max(
        7,
        parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '90', 10) || 90,
      );
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      const BATCH_SIZE = 1000;
      // 单次任务最大分批次数（1000 批 = 100 万条），防止千万级记录耗时超 1 小时
      const MAX_BATCHES = 1000;

      let totalDeleted = 0;
      let batches = 0;
      let batchDeleted: number;
      do {
        const result = await this.auditLogRepository
          .createQueryBuilder()
          .delete()
          .where('id IN (SELECT id FROM audit_logs WHERE "createdAt" < :cutoff LIMIT :limit)')
          .setParameter('cutoff', cutoff)
          .setParameter('limit', BATCH_SIZE)
          .execute();
        batchDeleted = result.affected ?? 0;
        totalDeleted += batchDeleted;
        batches++;
      } while (batchDeleted === BATCH_SIZE && batches < MAX_BATCHES);

      if (batches >= MAX_BATCHES && batchDeleted === BATCH_SIZE) {
        this.logger.warn(
          `审计日志清理达到单次任务批次上限 (${MAX_BATCHES})，剩余记录将在下次任务继续清理`,
        );
      }

      if (totalDeleted > 0) {
        this.logger.log(
          `已清理 ${totalDeleted} 条过期审计日志（保留期限：${retentionDays} 天）`,
        );
      }
    } catch (error: unknown) {
      this.logger.error(
        '清理过期审计日志失败',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * 自动恢复卡死的 processing 上传记录（每 30 分钟执行）。
   *
   * 背景：上传通过 Bull 队列异步提交到 Telegram，若进程异常退出 / 队列任务丢失，
   * 文件会长期停留在 processing 状态既不下发也不报错，用户永远无法下载。
   * 本任务按 updatedAt 超时阈值扫描并标记为 error（保留记录，前端显示"上传失败"）。
   *
   * 安全约束：
   * - 超时阈值可配置（FILE_PROCESSING_STALE_MINUTES，默认 60 分钟）；
   * - 仅处理 uploadStage 为 pending/uploading 的未提交记录，避免误伤已 remote_committed 的文件；
   * - 分批（每批 200 条）+ 条件更新，避免长事务与覆盖刚恢复的上传；
   * - 固定失败原因，不复用可能失效的旧 Telegram 引用。
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async recoverStaleProcessingFiles() {
    const staleMinutes = Math.max(
      5,
      parseInt(process.env.FILE_PROCESSING_STALE_MINUTES || '60', 10) || 60,
    );
    const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000);
    const BATCH_SIZE = 200;
    const MAX_BATCHES = 100;

    try {
      // 先恢复远端已提交的记录：committed 可安全补齐 ready，remote_committed 重新走收尾队列。
      await this.recoverCommittedFiles();
      // G3-14：再尝试恢复 uploadStage='recoverable' 的记录（远端已上传成功但 DB 提交失败、有回执）。
      // 以确定性 jobId 重新入队，processor 会先 loadReceipt，凭回执完成 DB 提交而不再重传原文件。
      await this.recoverReceiptCommittableFiles();

      let totalMarked = 0;
      let batches = 0;
      let marked = 0;
      do {
        const batchIds = await this.fileRepository
          .createQueryBuilder('file')
          .select('file.id')
          .where('file.status = :status', { status: 'processing' })
          .andWhere('file.uploadStage IN (:...stages)', { stages: ['pending', 'uploading'] })
          // 已回填 telegramFilePath 的文件不算僵尸（可能有有效引用）
          .andWhere('(file."telegramFilePath" IS NULL OR file."telegramFilePath" = \'\')')
          .andWhere('file.updatedAt < :cutoff', { cutoff })
          .orderBy('file.updatedAt', 'ASC')
          .limit(BATCH_SIZE)
          .getMany();

        if (batchIds.length === 0) break;

        const result = await this.fileRepository
          .createQueryBuilder()
          .update(File)
          .set({
            status: 'error' as const,
            uploadStage: 'failed' as const,
            uploadFailureReason: STALE_PROCESSING_FAILURE_REASON,
          })
          .where('id IN (:...ids)', { ids: batchIds.map((f) => f.id) })
          .andWhere('status = :status', { status: 'processing' })
          .andWhere('uploadStage IN (:...stages)', { stages: ['pending', 'uploading'] })
          .andWhere('updatedAt < :cutoff', { cutoff })
          .execute();

        marked = result.affected ?? 0;
        totalMarked += marked;
        batches++;
      } while (marked === BATCH_SIZE && batches < MAX_BATCHES);

      if (batches >= MAX_BATCHES && marked === BATCH_SIZE) {
        this.logger.warn(
          `僵尸 processing 恢复达到单次任务批次上限 (${MAX_BATCHES})，剩余记录将在下次任务继续`,
        );
      }

      if (totalMarked > 0) {
        this.logger.log(
          `已自动恢复 ${totalMarked} 条僵尸 processing 记录（超时 ${staleMinutes} 分钟）`,
        );
      }
    } catch (error: unknown) {
      this.logger.error(
        '僵尸 processing 恢复失败',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async recoveryReceipt(filePath: string, uploadVersion: number): Promise<{ strictDiskLease?: boolean } | undefined> {
    try {
      const receipt = JSON.parse(await readFile(`${filePath}.telegram.json`, 'utf8'));
      return receipt.uploadVersion === uploadVersion ? receipt : undefined;
    } catch {
      return undefined;
    }
  }

  private async recoverUpload(file: File): Promise<boolean> {
    const originalId = `file-upload:${file.id}:${file.uploadVersion}`;
    let jobId = originalId;
    let job = await this.fileUploadQueue.getJob(jobId);
    const originalData = job?.data;
    if (job && await job.getState() === 'completed') {
      // Keep the completed record. Concurrent scans for this DB revision converge on one recovery job.
      jobId = `${originalId}:resume:${file.updatedAt.getTime()}`;
      job = await this.fileUploadQueue.getJob(jobId);
    }
    if (job) {
      if (await job.getState() !== 'failed') return false;
      try {
        await job.retry();
      } catch (error) {
        if (await job.getState() === 'failed') throw error;
        return false;
      }
      return true;
    }
    const dir = pendingUploadDirectory();
    let filePath = path.join(dir, pendingUploadName(file.id, file.uploadVersion));
    let receipt = await this.recoveryReceipt(filePath, file.uploadVersion);
    if (!receipt) {
      const legacy = path.join(dir, file.id);
      const legacyReceipt = await this.recoveryReceipt(legacy, file.uploadVersion);
      if (legacyReceipt || (originalData?.filePath === legacy && originalData.uploadVersion === file.uploadVersion)) {
        filePath = legacy;
        receipt = legacyReceipt;
      }
    }
    await this.fileUploadQueue.add('upload', {
      filePath, fileId: file.id, uploadVersion: file.uploadVersion,
      strictDiskLease: originalData?.strictDiskLease === true || receipt?.strictDiskLease === true,
    }, {
      jobId, attempts: 3, backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: 100, removeOnFail: false,
    });
    return true;
  }

  /** 恢复远端已有有效引用但状态仍为 processing 的存量文件。 */
  private async recoverCommittedFiles(): Promise<void> {
    const batch = await this.fileRepository.find({
      where: { status: 'processing' as const, uploadStage: 'committed' as any },
      take: 200,
    });
    let requeuedCommitted = 0;
    let requeued = 0;
    for (const file of batch) {
      if (!hasValidRemoteRef(file)) continue;
      try {
        // 不直接置 ready：那会绕过 processor 收尾的主副本定位登记、镜像触发与 GDrive 双写，
        // 文件将永远没有主副本行与镜像任务（双写重试扫描只扫 pending/failed，两条恢复路径都不再尝试）。
        // 以确定性 jobId 重新入队，processor 读到 committed 提交点后幂等收尾，绝不重传原文件。
        if (await this.recoverUpload(file)) requeuedCommitted++;
      } catch (error: unknown) {
        this.logger.warn(`恢复 committed 文件入队失败 fileId=${file.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const remoteBatch = await this.fileRepository.find({
      where: { status: 'processing' as const, uploadStage: 'remote_committed' as any },
      take: 200,
    });
    for (const file of remoteBatch) {
      if (!hasValidRemoteRef(file)) continue;
      try {
        if (await this.recoverUpload(file)) requeued++;
      } catch (error: unknown) {
        this.logger.warn(`恢复 remote_committed 文件入队失败 fileId=${file.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (requeuedCommitted || requeued) {
      this.logger.log(`已恢复远端提交文件：${requeuedCommitted} 条 committed 重新入队收尾，${requeued} 条 remote_committed 重新入队`);
    }
  }

  /**
   * G3-14：凭回执恢复可提交的文件（uploadStage='recoverable'）。
   *
   * recoverable 表示 Telegram 远端已成功（回执已落盘）但 DB 提交失败、Bull 重试耗尽。
   * 这里以确定性 jobId 重新入队 FILE_UPLOAD 队列；processor 启动时会先 loadReceipt，
   * 命中回执则跳过重传、直接完成 DB 提交。若回执缺失（进程重启时本地文件被误清理），
   * processor 会按正常路径重新上传原文件，因此无需在此标记 error。
   */
  private async recoverReceiptCommittableFiles(): Promise<void> {
    const batch = await this.fileRepository.find({
      where: { status: 'processing', uploadStage: 'recoverable' as any },
      take: 200,
    });
    if (batch.length === 0) return;

    let requeued = 0;
    for (const file of batch) {
      try {
        if (await this.recoverUpload(file)) requeued++;
      } catch (error: unknown) {
        this.logger.warn(
          `恢复可提交文件入队失败 fileId=${file.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (requeued > 0) {
      this.logger.log(`已重新入队 ${requeued} 条 recoverable 文件，凭回执恢复 DB 提交`);
    }
  }
}
