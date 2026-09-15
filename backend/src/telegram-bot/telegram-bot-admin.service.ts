import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AuditService } from '../common/services/audit.service';
import { AuditStatus } from '../common/entities/audit-log.entity';
import {
  databaseCast,
  databaseDateBucket,
  getDatabaseType,
} from '../database/database-types';
import { TelegramBotFileGrant } from '../common/entities/telegram-bot-file-grant.entity';
import { TelegramBotGrantService } from './telegram-bot-grant.service';
import { TelegramBotQuotaService } from './telegram-bot-quota.service';
import { TelegramBotConfigService } from './telegram-bot-config.service';
import { TelegramBotIdentity } from './telegram-bot.types';

export interface BotUsageSummary {
  timeRange: string;
  downloads: number;
  uniqueUsers: number;
  totalBytes: string;
  trend: { bucket: string; downloads: number; bytes: string }[];
}

const TIME_RANGE_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/**
 * Bot 管理能力：管理员身份判定、白名单维护、直链查询/撤销，以及 Bot 使用情况汇总。
 *
 * 安全约束：
 * - 身份一律以数字 TG 用户 ID 判定（`@username` 绝不参与权限判定，R6）；
 * - 审计只记 Token 前缀与 grantId，绝不记完整 Token/URL（R12）；
 * - 所有管理动作全审计（D11）。
 */
@Injectable()
export class TelegramBotAdminService {
  constructor(
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly grantService: TelegramBotGrantService,
    private readonly quotaService: TelegramBotQuotaService,
    private readonly configServiceForDomain: TelegramBotConfigService,
    private readonly dataSource: DataSource,
  ) {}

  /** 管理员集合（env 固定超管；第一版不引入 DB 管理员表） */
  getAdminIds(): Set<string> {
    const raw = this.configService.get<string>('TELEGRAM_BOT_ADMIN_IDS') || '';
    return new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^\d{1,20}$/.test(s)),
    );
  }

  isAdmin(telegramUserId: string): boolean {
    return this.getAdminIds().has(telegramUserId);
  }

  /** 越权调用管理命令的审计（不泄露命令内容） */
  auditCommandDenied(identity: TelegramBotIdentity, command: string, chatType: string): void {
    this.auditService.log({
      action: 'telegram_bot_command_denied',
      resourceType: 'telegram_bot_command',
      resourceId: command,
      status: AuditStatus.FAILURE,
      metadata: {
        telegramUserId: identity.telegramUserId,
        telegramUsername: identity.username,
        chatType,
        command,
      },
    });
  }

  // ---------------- 白名单 ----------------

  async addWhitelist(
    operator: TelegramBotIdentity,
    targetUserId: string,
  ): Promise<{ created: boolean }> {
    const result = await this.quotaService.addToWhitelist(targetUserId, operator.telegramUserId, 'admin');
    this.auditService.log({
      action: 'telegram_bot_whitelist_add',
      resourceType: 'telegram_bot_whitelist',
      resourceId: targetUserId,
      metadata: {
        operatorTelegramUserId: operator.telegramUserId,
        operatorTelegramUsername: operator.username,
        targetTelegramUserId: targetUserId,
        created: result.created,
      },
    });
    return result;
  }

  async removeWhitelist(operator: TelegramBotIdentity, targetUserId: string): Promise<boolean> {
    const removed = await this.quotaService.removeFromWhitelist(targetUserId);
    this.auditService.log({
      action: 'telegram_bot_whitelist_remove',
      resourceType: 'telegram_bot_whitelist',
      resourceId: targetUserId,
      metadata: {
        operatorTelegramUserId: operator.telegramUserId,
        operatorTelegramUsername: operator.username,
        targetTelegramUserId: targetUserId,
        removed,
      },
    });
    return removed;
  }

  async listWhitelist(): Promise<{ telegramUserId: string; createdAt: Date }[]> {
    const list = await this.quotaService.listWhitelist();
    return list.map((item) => ({ telegramUserId: item.telegramUserId, createdAt: item.createdAt }));
  }

  // ---------------- 直链查询 / 撤销 ----------------

  /**
   * 按 TG 用户 ID 查询**完整有效直链**（D11）。
   * 每次调用全审计，审计只记录查询者/目标与命中条数，不记完整链接。
   */
  async queryLinks(
    operator: TelegramBotIdentity,
    targetUserId: string,
  ): Promise<{ url: string | null; grant: TelegramBotFileGrant; prefix: string }[]> {
    const grants = await this.grantService.listActiveByUser(targetUserId);
    const origin = await this.configServiceForDomain.resolveSiteOriginAsync();
    const results = grants.map((grant) => {
      const token = this.grantService.replayToken(grant);
      return {
        grant,
        prefix: grant.tokenPrefix,
        url: token && origin ? this.grantService.buildUrl(origin, token) : null,
      };
    });

    this.auditService.log({
      action: 'telegram_bot_link_queried',
      resourceType: 'telegram_bot_grant',
      resourceId: targetUserId,
      metadata: {
        operatorTelegramUserId: operator.telegramUserId,
        operatorTelegramUsername: operator.username,
        targetTelegramUserId: targetUserId,
        hitCount: results.length,
        replayable: results.filter((r) => r.url !== null).length,
      },
    });
    return results;
  }

  /** 从直链 URL 或裸 Token 中提取 Token（D12） */
  extractToken(input: string): string | null {
    const raw = input.trim();
    if (!raw) return null;
    // 完整 URL：取最后一段路径
    if (/^https?:\/\//i.test(raw)) {
      try {
        const url = new URL(raw);
        const segments = url.pathname.split('/').filter(Boolean);
        const last = segments[segments.length - 1];
        return last && /^[A-Za-z0-9_-]{16,}$/.test(last) ? last : null;
      } catch {
        return null;
      }
    }
    return /^[A-Za-z0-9_-]{16,}$/.test(raw) ? raw : null;
  }

  /** 按直链 URL/Token 撤销（D12）；审计只记 grantId 与前缀 */
  async revokeByToken(
    operator: TelegramBotIdentity,
    tokenOrUrl: string,
  ): Promise<{ ok: boolean; reason?: string; grant?: TelegramBotFileGrant }> {
    const token = this.extractToken(tokenOrUrl);
    if (!token) {
      return { ok: false, reason: 'invalid_input' };
    }
    const prefix = this.grantService.tokenPrefixOf(token);
    const grant = await this.grantService.findByToken(token);
    if (!grant) {
      this.auditService.log({
        action: 'telegram_bot_link_revoked',
        resourceType: 'telegram_bot_grant',
        status: AuditStatus.FAILURE,
        metadata: {
          operatorTelegramUserId: operator.telegramUserId,
          operatorTelegramUsername: operator.username,
          tokenPrefix: prefix,
          reason: 'not_found',
        },
      });
      return { ok: false, reason: 'not_found' };
    }

    const revoked = await this.grantService.revoke(grant, operator.telegramUserId);
    this.auditService.log({
      action: 'telegram_bot_link_revoked',
      resourceType: 'telegram_bot_grant',
      resourceId: grant.id,
      metadata: {
        operatorTelegramUserId: operator.telegramUserId,
        operatorTelegramUsername: operator.username,
        grantId: grant.id,
        tokenPrefix: grant.tokenPrefix,
        targetTelegramUserId: grant.telegramUserId,
        alreadyRevoked: !revoked,
      },
    });
    return { ok: true, grant };
  }

  // ---------------- Bot 使用情况（D13） ----------------

  /** 基于 access_logs 的 Bot 使用情况汇总（SQL 侧聚合，bigint 安全） */
  async getUsageSummary(timeRange = '7d'): Promise<BotUsageSummary> {
    const type = getDatabaseType();
    const range = TIME_RANGE_MS[timeRange] ? timeRange : '7d';
    const since = new Date(Date.now() - TIME_RANGE_MS[range]);
    const sinceParam = type === 'sqlite'
      ? since.toISOString().replace('T', ' ').replace('Z', '')
      : since;

    const where = `"botGrantId" IS NOT NULL AND "createdAt" >= $1`;

    const totals = await this.dataSource.query(
      `SELECT COUNT(*) AS "downloads",
              COUNT(DISTINCT "botTelegramUserId") AS "uniqueUsers",
              ${databaseCast('COALESCE(SUM("responseSize"), 0)', 'bigint')} AS "totalBytes"
         FROM "access_logs"
        WHERE ${where}`,
      [sinceParam],
    );

    const bucket = databaseDateBucket('"createdAt"', 'day');
    const trendRows = await this.dataSource.query(
      `SELECT ${bucket} AS "bucket",
              COUNT(*) AS "downloads",
              ${databaseCast('COALESCE(SUM("responseSize"), 0)', 'bigint')} AS "bytes"
         FROM "access_logs"
        WHERE ${where}
        GROUP BY ${bucket}
        ORDER BY ${bucket} ASC`,
      [sinceParam],
    );

    const totalRow = Array.isArray(totals) && totals.length > 0 ? totals[0] : {};
    return {
      timeRange: range,
      downloads: Number(totalRow.downloads ?? 0),
      uniqueUsers: Number(totalRow.uniqueUsers ?? 0),
      totalBytes: String(totalRow.totalBytes ?? '0'),
      trend: (Array.isArray(trendRows) ? trendRows : []).map(
        (row: { bucket: string; downloads: number | string; bytes: number | string }) => ({
          bucket: String(row.bucket),
          downloads: Number(row.downloads ?? 0),
          bytes: String(row.bytes ?? '0'),
        }),
      ),
    };
  }
}
