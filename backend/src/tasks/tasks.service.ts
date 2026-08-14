import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, IsNull, Brackets } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { ShareAudit } from '../common/entities/share-audit.entity';
import { RateLimit } from '../common/entities/rate-limit.entity';
import { AuditLog } from '../common/entities/audit-log.entity';
import { JwtRevokedToken } from '../common/entities/jwt-revoked-token.entity';
import { File } from '../common/entities/file.entity';

/** 僵尸 processing 自动恢复的固定失败原因（不复用可能失效的旧 Telegram 引用） */
export const STALE_PROCESSING_FAILURE_REASON = '上传任务超时，已自动标记失败，请重新上传';

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
  ) {}

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
}
