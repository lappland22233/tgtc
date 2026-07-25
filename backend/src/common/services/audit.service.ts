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
  private static readonly MAX_PENDING_WRITES = 10000;
  private droppedWrites = 0;

  constructor(
    @InjectRepository(AuditLog)
    private auditLogRepository: Repository<AuditLog>,
  ) {}

  /**
   * 异步记录审计日志（fire-and-forget），失败不影响主业务流程。
   * 适用于非关键操作的审计记录。
   */
  log(entry: AuditEntry): void {
    if (this.pendingWrites.size >= AuditService.MAX_PENDING_WRITES) {
      this.droppedWrites++;
      if (this.droppedWrites === 1 || this.droppedWrites % 1000 === 0) {
        this.logger.error(`审计写入队列已满，已丢弃 ${this.droppedWrites} 条非关键审计日志`);
      }
      return;
    }
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
   * 写入失败会短暂重试（默认 3 次）以提升持久性；重试耗尽后仍不抛出，
   * 避免影响主业务返回，但会以 error 级别记录（破坏不可否认性时需告警）。
   */
  async logAwait(entry: AuditEntry, retries = 3): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this.writeLogAsync(entry);
        return;
      } catch (error: unknown) {
        lastError = error;
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
        }
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    this.logger.error(`审计日志写入失败（await，已重试 ${retries} 次）: ${message}`);
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
    if (this.pendingWrites.size >= AuditService.MAX_PENDING_WRITES) {
      this.droppedWrites += entries.length;
      this.logger.error(`审计写入队列已满，累计丢弃 ${this.droppedWrites} 条非关键审计日志`);
      return;
    }

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
