import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { TelegramBotDailyUsage } from '../common/entities/telegram-bot-daily-usage.entity';
import { TelegramBotWhitelist } from '../common/entities/telegram-bot-whitelist.entity';
import { TelegramBotUserQuota } from '../common/entities/telegram-bot-user-quota.entity';
import { databaseQuery, databaseRawQuery, getDatabaseType } from '../database/database-types';

export interface QuotaConsumeResult {
  allowed: boolean;
  /** 扣减后的当日已用量（allowed=false 时为当前已用量） */
  used: number;
}

/** 生效额度的来源：白名单不限 / 单账号覆盖 / 全局通用 */
export type QuotaSource = 'whitelist' | 'user' | 'global';

/** 某用户在某业务日的生效额度快照（签发、/quota、后台详情共用同一口径） */
export interface ResolvedQuota {
  whitelisted: boolean;
  /** null 表示不限（白名单） */
  limit: number | null;
  source: QuotaSource;
  used: number;
  remaining: number | null;
  usageDate: string;
}

/**
 * 每日配额与白名单服务。
 *
 * 关键约束（R3）：配额扣减必须原子（单条 `UPDATE ... WHERE issuedCount < limit RETURNING`），
 * 禁止「先查后写」。白名单仅永久加入/移除（D3），启用状态仅用于撤销。
 */
@Injectable()
export class TelegramBotQuotaService {
  private readonly logger = new Logger(TelegramBotQuotaService.name);

  constructor(
    @InjectRepository(TelegramBotDailyUsage)
    private readonly usageRepository: Repository<TelegramBotDailyUsage>,
    @InjectRepository(TelegramBotWhitelist)
    private readonly whitelistRepository: Repository<TelegramBotWhitelist>,
    @InjectRepository(TelegramBotUserQuota)
    private readonly userQuotaRepository: Repository<TelegramBotUserQuota>,
    private readonly dataSource: DataSource,
  ) {}

  /** 按配置时区计算业务日期（YYYY-MM-DD） */
  getBusinessDate(timezone: string, now: Date = new Date()): string {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(now);
      const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
      const year = get('year');
      const month = get('month');
      const day = get('day');
      if (year && month && day) return `${year}-${month}-${day}`;
    } catch {
      // 时区非法时回退 UTC
    }
    return now.toISOString().slice(0, 10);
  }

  async isWhitelisted(telegramUserId: string): Promise<boolean> {
    const record = await this.whitelistRepository.findOne({
      where: { telegramUserId },
    });
    return Boolean(record && record.enabled);
  }

  /**
   * 解析某用户的生效额度（**签发链路的唯一入口**）。
   *
   * 优先级：白名单（不限）> 单账号覆盖 > 全局 dailyLimit。
   * 白名单分支不查 usage：额度为 null，used/remaining 也无意义。
   *
   * 每次签发都重新解析（不做进程内缓存）：管理员改额度或加白名单必须立即生效，
   * 而这两次查询都很轻（主键 / 唯一索引命中）。
   */
  async resolveQuota(
    telegramUserId: string,
    globalLimit: number,
    usageDate: string,
  ): Promise<ResolvedQuota> {
    const [whitelisted, override] = await Promise.all([
      this.isWhitelisted(telegramUserId),
      this.userQuotaRepository.findOne({ where: { telegramUserId } }),
    ]);

    if (whitelisted) {
      return { whitelisted: true, limit: null, source: 'whitelist', used: 0, remaining: null, usageDate };
    }

    const limit = override ? override.dailyLimit : globalLimit;
    const used = await this.getUsed(telegramUserId, usageDate);
    return {
      whitelisted: false,
      limit,
      source: override ? 'user' : 'global',
      used,
      remaining: Math.max(0, limit - used),
      usageDate,
    };
  }

  // ---------------- 单账号额度覆盖 ----------------

  async getOverride(telegramUserId: string): Promise<TelegramBotUserQuota | null> {
    return this.userQuotaRepository.findOne({ where: { telegramUserId } });
  }

  /** 设置/更新单账号额度；返回变更前的值用于回执与审计（此前无覆盖则为 null） */
  async setOverride(
    telegramUserId: string,
    dailyLimit: number,
    createdBy: string | null,
  ): Promise<{ created: boolean; before: number | null }> {
    const existing = await this.userQuotaRepository.findOne({ where: { telegramUserId } });
    if (existing) {
      const before = existing.dailyLimit;
      existing.dailyLimit = dailyLimit;
      existing.createdBy = createdBy ?? existing.createdBy;
      await this.userQuotaRepository.save(existing);
      return { created: false, before };
    }
    await this.userQuotaRepository.insert({ telegramUserId, dailyLimit, createdBy });
    return { created: true, before: null };
  }

  /** 清除覆盖（回落全局额度）；原本不存在覆盖时返回 false */
  async clearOverride(telegramUserId: string): Promise<boolean> {
    const result = await this.userQuotaRepository.delete({ telegramUserId });
    return (result.affected ?? 0) > 0;
  }

  async listOverrides(): Promise<TelegramBotUserQuota[]> {
    return this.userQuotaRepository.find({ order: { updatedAt: 'DESC' } });
  }

  /**
   * 原子扣减当日配额。
   * 返回值 allowed=true 表示扣减成功（可用于签发）；false 表示已达上限。
   */
  async consume(telegramUserId: string, usageDate: string, limit: number): Promise<QuotaConsumeResult> {
    const type = getDatabaseType();
    await this.ensureUsageRow(telegramUserId, usageDate, type);

    const nowExpr = type === 'sqlite' ? "datetime('now')" : 'now()';
    const rows = await databaseQuery<Array<{ issuedCount: number | string }>>(
      this.dataSource,
      `UPDATE "telegram_bot_daily_usage"
         SET "issuedCount" = "issuedCount" + 1, "updatedAt" = ${nowExpr}
       WHERE "telegramUserId" = $1 AND "usageDate" = $2 AND "issuedCount" < $3
       RETURNING "issuedCount"`,
      [telegramUserId, usageDate, limit],
      type,
    );

    if (Array.isArray(rows) && rows.length > 0) {
      return { allowed: true, used: Number(rows[0].issuedCount) };
    }
    // 未更新成功 → 已达上限（或行缺失的极端情况），读取当前值用于审计
    const used = await this.getUsed(telegramUserId, usageDate);
    return { allowed: false, used };
  }

  /** 查询当日已用量 */
  async getUsed(telegramUserId: string, usageDate: string): Promise<number> {
    const record = await this.usageRepository.findOne({ where: { telegramUserId, usageDate } });
    return record ? record.issuedCount : 0;
  }

  /**
   * 归还一次配额（失败补偿）：签发过程中出现非配额类错误时调用，
   * 避免用户因内部错误白白损失一次额度。永远不会低于 0。
   */
  async refund(telegramUserId: string, usageDate: string): Promise<void> {
    try {
      const type = getDatabaseType();
      const nowExpr = type === 'sqlite' ? "datetime('now')" : 'now()';
      await databaseQuery(
        this.dataSource,
        `UPDATE "telegram_bot_daily_usage"
           SET "issuedCount" = "issuedCount" - 1, "updatedAt" = ${nowExpr}
         WHERE "telegramUserId" = $1 AND "usageDate" = $2 AND "issuedCount" > 0`,
        [telegramUserId, usageDate],
        type,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`配额归还失败（忽略）: ${message}`);
    }
  }

  private async ensureUsageRow(
    telegramUserId: string,
    usageDate: string,
    type: 'postgres' | 'sqlite',
  ): Promise<void> {
    const id = randomUUID();
    if (type === 'sqlite') {
      await databaseRawQuery(this.dataSource,
        `INSERT OR IGNORE INTO "telegram_bot_daily_usage"
           ("id","telegramUserId","usageDate","issuedCount","createdAt","updatedAt")
         VALUES ($1,$2,$3,0,datetime('now'),datetime('now'))`,
        [id, telegramUserId, usageDate],
      );
      return;
    }
    await this.dataSource.query(
      `INSERT INTO "telegram_bot_daily_usage"
         ("id","telegramUserId","usageDate","issuedCount","createdAt","updatedAt")
       VALUES ($1,$2,$3,0,now(),now())
       ON CONFLICT ("telegramUserId","usageDate") DO NOTHING`,
      [id, telegramUserId, usageDate],
    );
  }

  // ---------------- 白名单 ----------------

  async listWhitelist(): Promise<TelegramBotWhitelist[]> {
    return this.whitelistRepository.find({
      where: { enabled: true },
      order: { createdAt: 'ASC' },
    });
  }

  /** 永久加入白名单（幂等：已存在且启用则返回 created=false） */
  async addToWhitelist(
    telegramUserId: string,
    createdBy: string | null,
    source: 'env' | 'admin' = 'admin',
  ): Promise<{ created: boolean }> {
    const existing = await this.whitelistRepository.findOne({ where: { telegramUserId } });
    if (existing) {
      if (existing.enabled) return { created: false };
      // 重新启用（保留原记录，更新操作者）
      existing.enabled = true;
      existing.createdBy = createdBy ?? existing.createdBy;
      await this.whitelistRepository.save(existing);
      return { created: true };
    }
    await this.whitelistRepository.insert({
      telegramUserId,
      enabled: true,
      source,
      createdBy,
    });
    return { created: true };
  }

  /** 移出白名单（保留记录，enabled=false） */
  async removeFromWhitelist(telegramUserId: string): Promise<boolean> {
    const existing = await this.whitelistRepository.findOne({ where: { telegramUserId } });
    if (!existing || !existing.enabled) return false;
    existing.enabled = false;
    await this.whitelistRepository.save(existing);
    return true;
  }
}
