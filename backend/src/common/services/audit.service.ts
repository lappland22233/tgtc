import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { AuditLog, AuditAction, AuditStatus } from '../entities/audit-log.entity';
import { ConfigCacheService } from './config-cache.service';

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

  /** 审计降级文件的默认目录（可用 AUDIT_DEGRADED_DIR 覆盖） */
  private readonly degradedDir = process.env.AUDIT_DEGRADED_DIR
    || path.join(process.cwd(), 'tmp', 'degraded-audit');
  /** 审计降级文件的写入是否已就绪（懒初始化） */
  private degradedInitDone = false;

  constructor(
    @InjectRepository(AuditLog)
    private auditLogRepository: Repository<AuditLog>,
    private configCacheService: ConfigCacheService,
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
    // 高敏审计失败：触发 CRITICAL 级告警（日志告警通道）+ 写本地降级文件供后续补录，
    // 避免高敏感操作（role_change/config_change/user_delete）无审计成功返回。
    this.logger.error(`审计日志写入失败（await，已重试 ${retries} 次）: ${message}`);
    await this.writeDegradedFile(entry, message);

    // 审计失败即操作失败开关（配置项 AUDIT_FAIL_FAST，默认关闭避免阻断主流程）：
    // 仅当显式开启时才抛出，使高敏操作随审计失败而失败。
    const failFast = await this.isAuditFailFastEnabled();
    if (failFast) {
      throw new Error(`高敏审计写入失败，按配置中止操作: ${message}`);
    }
  }

  /**
   * G8-20：返回累计丢弃的审计写入数（供指标/健康检查查询）。
   * 审计缺口可量化，避免 pending 满 10000 时静默丢弃无人察觉。
   */
  getDroppedWrites(): number {
    return this.droppedWrites;
  }

  async onApplicationShutdown(_signal?: string): Promise<void> {
    if (this.pendingWrites.size > 0) {
      const pendingCount = this.pendingWrites.size;
      this.logger.log(`等待 ${pendingCount} 条审计日志写入完成...`);
      const completed = await Promise.race([
        Promise.allSettled([...this.pendingWrites]).then(() => true),
        new Promise<false>(resolve => {
          const timer = setTimeout(() => resolve(false), 5000);
          timer.unref?.();
        }),
      ]);
      if (completed) {
        this.logger.log('所有待处理审计日志已写入');
      } else {
        this.logger.error(`审计日志关闭刷新超时，仍有 ${this.pendingWrites.size} 条未完成`);
      }
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

  /**
   * 审计写入失败时，将条目追加写入本地降级文件（按天滚动），供运维后续补录。
   * 异步 append，失败仅记录日志，不影响主流程。
   */
  private async writeDegradedFile(entry: AuditEntry, reason: string): Promise<void> {
    try {
      if (!this.degradedInitDone) {
        fs.mkdirSync(this.degradedDir, { recursive: true });
        this.degradedInitDone = true;
      }
      // 按天滚动文件名，避免单文件无限增长
      const day = new Date().toISOString().slice(0, 10);
      const filePath = path.join(this.degradedDir, `audit-${day}.ndjson`);
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        reason,
        entry,
      }) + '\n';
      fs.appendFile(filePath, line, (err) => {
        if (err) {
          this.logger.error(`审计降级文件写入失败: ${err.message}`);
        }
      });
    } catch (error) {
      this.logger.error(`审计降级文件写入失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 读取"审计失败即失败"开关（AUDIT_FAIL_FAST，默认 false）。
   * 配置读取失败时保守回退为 false（不阻断主流程）。
   */
  private async isAuditFailFastEnabled(): Promise<boolean> {
    try {
      const value = await this.configCacheService.get('AUDIT_FAIL_FAST', 'false');
      return value === 'true';
    } catch {
      return false;
    }
  }
}
