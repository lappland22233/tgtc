import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Telegram Bot 每日配额用量。
 *
 * - `usageDate` 为按配置时区（默认 Asia/Shanghai）计算的业务日期（YYYY-MM-DD）；
 * - `(telegramUserId, usageDate)` 唯一；配额扣减必须使用原子 UPDATE
 *   （`SET issuedCount = issuedCount + 1 WHERE issuedCount < limit`），禁止先查后写（R3）。
 */
@Entity('telegram_bot_daily_usage')
@Index('uq_tg_bot_daily_usage_user_date', ['telegramUserId', 'usageDate'], { unique: true })
export class TelegramBotDailyUsage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 32, comment: 'TG 用户 ID' })
  telegramUserId: string;

  /** 业务日期（按切日时区计算），格式 YYYY-MM-DD */
  @Column({ type: 'varchar', length: 10, comment: '业务日期（切日时区）' })
  usageDate: string;

  @Column({ type: 'int', default: 0, comment: '当日已签发直链数' })
  issuedCount: number;

  @CreateDateColumn({ comment: '创建时间' })
  createdAt: Date;

  @UpdateDateColumn({ comment: '更新时间' })
  updatedAt: Date;
}
