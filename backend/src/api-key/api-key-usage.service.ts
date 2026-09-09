import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiKeyUsageLog, ApiKeyUsageResult } from '../common/entities/api-key-usage-log.entity';
import { ApiKey } from '../common/entities/api-key.entity';
import { maskIp } from '../common/utils/ip-allowlist';

/** 使用记录留存上限：7 天（计划硬性要求，独立于 30 天访问日志策略） */
const USAGE_RETENTION_MS = 7 * 24 * 3600 * 1000;

export interface ApiKeyUsageEntry {
  apiKeyId: string;
  userId: string;
  method: string;
  route: string;
  result: ApiKeyUsageResult;
  statusCode: number | null;
  ip: string;
}

/** 所有者可见的使用记录（IP 已脱敏：仅保留最前与最后一段） */
export interface ApiKeyUsageItem {
  id: string;
  method: string;
  route: string;
  result: ApiKeyUsageResult;
  statusCode: number | null;
  maskedIp: string;
  createdAt: Date;
}

@Injectable()
export class ApiKeyUsageService {
  private readonly logger = new Logger(ApiKeyUsageService.name);

  constructor(
    @InjectRepository(ApiKeyUsageLog)
    private readonly usageRepository: Repository<ApiKeyUsageLog>,
    @InjectRepository(ApiKey)
    private readonly apiKeyRepository: Repository<ApiKey>,
  ) {}

  /**
   * 写入一条使用记录。fire-and-forget：审计写入失败仅记日志，
   * 绝不影响业务请求（与 AuditService 的降级语义一致）。
   */
  record(entry: ApiKeyUsageEntry): void {
    this.usageRepository
      .insert({
        apiKeyId: entry.apiKeyId,
        userId: entry.userId,
        method: entry.method.slice(0, 10),
        route: entry.route.slice(0, 255),
        result: entry.result,
        statusCode: entry.statusCode,
        ip: (entry.ip || '').slice(0, 64),
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `记录 API 密钥使用日志失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  /** 每小时清理超过 7 天的使用记录（独立于 30 天访问日志留存策略） */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - USAGE_RETENTION_MS);
    const result = await this.usageRepository
      .createQueryBuilder()
      .delete()
      .where('"createdAt" < :cutoff', { cutoff })
      .execute();
    const deleted = result.affected ?? 0;
    if (deleted > 0) {
      this.logger.log(`已清理 ${deleted} 条过期 API 密钥使用记录（>7 天）`);
    }
    return deleted;
  }

  /** 断言密钥属于当前用户（不泄露他人密钥存在性） */
  private async assertOwnedKey(userId: string, apiKeyId: string): Promise<ApiKey> {
    const key = await this.apiKeyRepository.findOne({ where: { id: apiKeyId } });
    if (!key || key.userId !== userId) {
      throw new NotFoundException('API 密钥不存在');
    }
    return key;
  }

  /** 密钥所有者查询使用记录：IP 脱敏，只保留最前与最后一段 */
  async listForKey(
    user: { id: string },
    apiKeyId: string,
    page = 1,
    limit = 20,
  ): Promise<{ items: ApiKeyUsageItem[]; total: number; page: number; limit: number }> {
    await this.assertOwnedKey(user.id, apiKeyId);
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const safePage = Math.max(page, 1);

    const [rows, total] = await this.usageRepository.findAndCount({
      where: { apiKeyId },
      order: { createdAt: 'DESC' },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        method: row.method,
        route: row.route,
        result: row.result,
        statusCode: row.statusCode,
        maskedIp: maskIp(row.ip),
        createdAt: row.createdAt,
      })),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  /** 管理员审计：完整可信 IP（不脱敏） */
  async listForAdmin(
    page = 1,
    limit = 50,
    userId?: string,
  ): Promise<{ items: ApiKeyUsageLog[]; total: number; page: number; limit: number }> {
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const safePage = Math.max(page, 1);
    const [items, total] = await this.usageRepository.findAndCount({
      where: userId ? { userId } : {},
      order: { createdAt: 'DESC' },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    });
    return { items, total, page: safePage, limit: safeLimit };
  }

  /** 白名单管理断言：仅所有者可维护（拒绝他人/不存在，统一 404 语义） */
  async assertKeyOwnedForMutation(user: { id: string }, apiKeyId: string): Promise<ApiKey> {
    const key = await this.assertOwnedKey(user.id, apiKeyId);
    if (key.revokedAt) {
      throw new ForbiddenException('密钥已撤销，无法维护 IP 白名单');
    }
    return key;
  }
}
