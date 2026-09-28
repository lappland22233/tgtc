import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { TelegramBotDailyUsage } from '../common/entities/telegram-bot-daily-usage.entity';
import { TelegramBotWhitelist } from '../common/entities/telegram-bot-whitelist.entity';
import { databaseQuery, getDatabaseType } from '../database/database-types';

export interface QuotaConsumeResult {
  allowed: boolean;
  /** 扣减后的当日已用量（allowed=false 时为当前已用量） */
  used: number;
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
      await this.dataSource.query(
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
