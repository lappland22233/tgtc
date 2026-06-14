import { Injectable, Logger } from '@nestjs/common';
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
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private auditLogRepository: Repository<AuditLog>,
  ) {}

  /**
   * 异步记录审计日志，失败不影响主业务流程
   */
  log(entry: AuditEntry): void {
    this.writeLogAsync(entry).catch((error: Error) => {
      this.logger.warn(`审计日志写入失败: ${error.message}`, error.stack);
    });
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
   * 批量记录审计日志
   */
  logBatch(entries: AuditEntry[]): void {
    if (entries.length === 0) return;

    this.writeBatchAsync(entries).catch((error: Error) => {
      this.logger.warn(`批量审计日志写入失败: ${error.message}`, error.stack);
    });
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
