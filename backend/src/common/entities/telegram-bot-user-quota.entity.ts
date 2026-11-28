import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { databaseColumnType } from '../../database/database-types';

/**
 * Telegram Bot 单账号每日额度覆盖。
 *
 * 优先级（见 TelegramBotQuotaService.resolveQuota）：白名单（不限）> 本表 > 全局 dailyLimit。
 *
 * 为什么用 `PrimaryColumn` 而非自增 uuid + 唯一索引：一个用户至多一条覆盖，
 * 「一个用户一行」本身就是主键语义，与 `telegram_bot_user_bans` 同构；
 * upsert 直接按 `telegramUserId` 冲突更新，不需要额外的唯一索引。
 *
 * 与白名单的关系：加白名单**不会**删除本行。白名单只是优先级更高；
 * 一旦移出白名单，原覆盖额度立即重新生效，避免管理员丢失已配置的数值。
 */
@Entity('telegram_bot_user_quotas')
export class TelegramBotUserQuota {
  @PrimaryColumn({ type: 'varchar', length: 32, comment: 'TG 用户 ID' })
  telegramUserId: string;

  @Column({ type: 'int', comment: '该用户每日可签发的直链数' })
  dailyLimit: number;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: '设置者 TG 用户 ID' })
  createdBy: string | null;

  @CreateDateColumn({ type: databaseColumnType('timestamptz') as 'timestamptz', comment: '创建时间' })
  createdAt: Date;

  @UpdateDateColumn({ type: databaseColumnType('timestamptz') as 'timestamptz', comment: '更新时间' })
  updatedAt: Date;
}
