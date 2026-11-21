import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { databaseColumnType } from '../../database/database-types';

@Entity('telegram_bot_user_bans')
export class TelegramBotUserBan {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  telegramUserId: string;

  @Column({ type: 'varchar', length: 500 })
  reason: string;

  @Column({ type: 'varchar', length: 64 })
  bannedBy: string;

  @CreateDateColumn({ type: databaseColumnType('timestamptz') as 'timestamptz' })
  bannedAt: Date;
}
