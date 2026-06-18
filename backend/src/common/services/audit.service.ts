import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog, AuditAction, AuditStatus } from '../entities/audit-log.entity';

export interface AuditEntry {
  action: AuditAction;
  userId?: string | null;
  ip?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown> | null;
  status?: AuditStatus;
}

@Injectable()
export class AuditService implements OnApplicationShutdown {
  private readonly logger = new Logger(AuditService.name);
  /** 追踪未完成的审计写入 Promise，确保优雅关闭时不丢失数据 */
  private pendingWrites: Set<Promise<void>> = new Set();

  constructor(
    @InjectRepository(AuditLog)
    private auditLogRepository: Repository<AuditLog>,
  ) {}

  /**
   * 异步记录审计日志（fire-and-forget），失败不影响主业务流程。
   * 适用于非关键操作的审计记录。
   */
  log(entry: AuditEntry): void {
    const promise = this.writeLogAsync(entry).catch((error: Error) => {
      this.logger.warn(`审计日志写入失败: ${error.message}`, error.stack);
    });
    this.pendingWrites.add(promise);
    promise.finally(() => this.pendingWrites.delete(promise));
  }

  /**
   * 同步等待审计日志写入完成。
   * 适用于高敏感操作（role_change、config_change、delete 等），
   * 确保审计记录在操作响应前已持久化。
   */
  async logAwait(entry: AuditEntry): Promise<void> {
    try {
      await this.writeLogAsync(entry);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`审计日志写入失败（await）: ${message}`);
      // 不抛出，避免影响主业务返回
    }
  }

  async onApplicationShutdown(_signal?: string): Promise<void> {
    if (this.pendingWrites.size > 0) {
      this.logger.log(`等待 ${this.pendingWrites.size} 条审计日志写入完成...`);
      await Promise.allSettled(this.pendingWrites);
      this.logger.log('所有待处理审计日志已写入');
    }
  }

  private async writeLogAsync(entry: AuditEntry): Promise<void> {
    // AuditLog entity has nullable: true for user/id/ip/resource fields,
    // but TypeScript type inference doesn't reflect this; cast accordingly
    const logData: Record<string, unknown> = {
      action: entry.action,
      status: entry.status ?? AuditStatus.SUCCESS,
    };
    if (entry.userId !== undefined) logData.userId = entry.userId ?? null;
    if (entry.ip !== undefined) logData.ip = entry.ip ?? null;
    if (entry.resourceType !== undefined) logData.resourceType = entry.resourceType ?? null;
    if (entry.resourceId !== undefined) logData.resourceId = entry.resourceId ?? null;
    if (entry.metadata !== undefined) logData.metadata = entry.metadata ?? null;

    const auditLog = this.auditLogRepository.create(logData as unknown as AuditLog);
    await this.auditLogRepository.save(auditLog);
  }

  /**
   * 批量异步记录审计日志
   */
  logBatch(entries: AuditEntry[]): void {
    if (entries.length === 0) return;

    const promise = this.writeBatchAsync(entries).catch((error: Error) => {
      this.logger.warn(`批量审计日志写入失败: ${error.message}`, error.stack);
    });
    this.pendingWrites.add(promise);
    promise.finally(() => this.pendingWrites.delete(promise));
  }

  private async writeBatchAsync(entries: AuditEntry[]): Promise<void> {
    const auditLogs = entries.map((entry) => {
      const logData: Record<string, unknown> = {
        action: entry.action,
        status: entry.status ?? AuditStatus.SUCCESS,
      };
      if (entry.userId !== undefined) logData.userId = entry.userId ?? null;
      if (entry.ip !== undefined) logData.ip = entry.ip ?? null;
      if (entry.resourceType !== undefined) logData.resourceType = entry.resourceType ?? null;
      if (entry.resourceId !== undefined) logData.resourceId = entry.resourceId ?? null;
      if (entry.metadata !== undefined) logData.metadata = entry.metadata ?? null;

      return this.auditLogRepository.create(logData as unknown as AuditLog);
    });

    await this.auditLogRepository.save(auditLogs);
  }
}
