import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { ShareAudit } from '../common/entities/share-audit.entity';
import { RateLimit } from '../common/entities/rate-limit.entity';
import { AccessLog } from '../common/entities/access-log.entity';
import { AuditLog } from '../common/entities/audit-log.entity';

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
    @InjectRepository(AccessLog)
    private accessLogRepository: Repository<AccessLog>,
    @InjectRepository(AuditLog)
    private auditLogRepository: Repository<AuditLog>,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async cleanupExpiredRateLimits() {
    try {
      // 只清理已过期且未锁定的记录，避免误删仍在生效的限流记录
      const result = await this.rateLimitRepository
        .createQueryBuilder()
        .delete()
        .from(RateLimit)
        .where('("lockedUntil" IS NOT NULL AND "lockedUntil" < :now)', { now: new Date() })
        .orWhere('("lockedUntil" IS NULL AND "updatedAt" < :cutoff)', { cutoff: new Date(Date.now() - 60 * 60 * 1000) })
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
  async cleanupExpiredBans() {
    try {
      const result = await this.bannedIPRepository.delete({
        isPermanent: false,
        expiresAt: LessThan(new Date()),
      });
      if ((result.affected ?? 0) > 0) {
        this.logger.log(`已清理 ${result.affected} 条过期封禁记录`);
      }
    } catch (error: unknown) {
      this.logger.error('清理过期封禁记录失败', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 清理过期的访问日志（每天凌晨 2 点执行）
   * 保留策略：默认保留最近 30 天，可通过 ACCESS_LOG_RETENTION_DAYS 配置
   * 使用分批删除防止大表一次性 DELETE 导致长事务和大量 WAL
   */
  @Cron('0 2 * * *')
  async cleanupExpiredAccessLogs() {
    try {
      const retentionDays = parseInt(process.env.ACCESS_LOG_RETENTION_DAYS || '30', 10);
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      const BATCH_SIZE = 1000;

      let totalDeleted = 0;
      let batchDeleted: number;
      do {
        const result = await this.accessLogRepository
          .createQueryBuilder()
          .delete()
          .where('id IN (SELECT id FROM access_logs WHERE "createdAt" < :cutoff LIMIT :limit)')
          .setParameter('cutoff', cutoff)
          .setParameter('limit', BATCH_SIZE)
          .execute();
        batchDeleted = result.affected ?? 0;
        totalDeleted += batchDeleted;
      } while (batchDeleted === BATCH_SIZE);

      if (totalDeleted > 0) {
        this.logger.log(
          `已清理 ${totalDeleted} 条过期访问日志（保留期限：${retentionDays} 天）`,
        );
      }
    } catch (error: unknown) {
      this.logger.error(
        '清理过期访问日志失败',
        error instanceof Error ? error.message : String(error),
      );
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
      const retentionDays = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '90', 10);
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      const BATCH_SIZE = 1000;

      let totalDeleted = 0;
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
      } while (batchDeleted === BATCH_SIZE);

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
}
