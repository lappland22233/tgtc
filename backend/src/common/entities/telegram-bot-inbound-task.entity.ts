import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { databaseColumnType } from '../../database/database-types';

export type InboundTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
const timestamp = databaseColumnType('timestamptz') as 'timestamptz';

@Entity('telegram_bot_inbound_tasks')
@Index('uq_bot_inbound_id', ['id'], { unique: true })
@Index('uq_bot_inbound_message', ['receiverBotId', 'telegramUserId', 'chatId', 'messageId'], { unique: true })
@Index('uq_bot_inbound_running', ['receiverBotId'], { unique: true, where: '"leaseToken" IS NOT NULL' })
@Index('idx_bot_inbound_fifo', ['receiverBotId', 'status', 'sequence'])
@Index('idx_bot_inbound_cooldown', ['receiverBotId', 'botCooldownUntil'], { where: '"botCooldownUntil" IS NOT NULL' })
@Index('idx_bot_inbound_notice_lease', ['receiverBotId', 'noticeLeaseUntil'], { where: '"noticeLeaseUntil" IS NOT NULL' })
@Index('idx_bot_inbound_terminal_notice', ['receiverBotId', 'sequence'], {
  where: `"status" IN ('completed','failed','cancelled') AND ("noticeStatus" IS NULL OR "noticeStatus" <> "status")`,
})
@Index('idx_bot_inbound_user', ['telegramUserId', 'sequence'])
export class TelegramBotInboundTask {
  /** The database assigns arrival order, including jobs created within the same clock tick. */
  @PrimaryGeneratedColumn({ type: 'integer' })
  sequence: number;

  @Column({ type: 'varchar', length: 36 })
  id: string;

  @Column({ type: 'varchar', length: 32 })
  receiverBotId: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  sourceAccountId: string | null;

  @Column({ type: 'varchar', length: 32 })
  telegramUserId: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  telegramUsername: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  telegramDisplayName: string | null;

  @Column({ type: 'varchar', length: 32 })
  chatId: string;

  @Column({ type: 'varchar', length: 32 })
  messageId: string;

  @Column({ type: 'varchar', length: 512 })
  telegramFileId: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  fileUniqueId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  fileName: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  mimeType: string | null;

  @Column({ type: 'bigint', nullable: true, transformer: {
    to: (value: string | null) => value,
    from: (value: string | number | null) => value === null ? null : String(value),
  } })
  fileSize: string | null;

  @Column({ type: 'varchar', length: 16 })
  status: InboundTaskStatus;

  @Column({ type: 'int', nullable: true })
  waitingMsgId: number | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  noticeStatus: InboundTaskStatus | null;

  @Column({ type: 'int', nullable: true })
  noticePosition: number | null;

  @Column({ type: timestamp, nullable: true })
  nextNoticeAt: Date | null;

  @Column({ type: timestamp, nullable: true })
  noticeLeaseUntil: Date | null;

  @Column({ type: timestamp, nullable: true })
  availableAt: Date | null;

  @Column({ type: timestamp, nullable: true })
  botCooldownUntil: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  failureReason: string | null;

  @Column({ type: 'varchar', length: 10 })
  usageDate: string;

  @Column({ type: 'boolean' })
  quotaConsumed: boolean;

  @Column({ type: 'int' })
  quotaUsed: number;

  @Column({ type: 'varchar', length: 36, nullable: true })
  leaseToken: string | null;

  @Column({ type: timestamp, nullable: true })
  leaseExpiresAt: Date | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  grantId: string | null;

  @Column({ type: timestamp })
  createdAt: Date;

  @Column({ type: timestamp })
  updatedAt: Date;

  @Column({ type: timestamp, nullable: true })
  startedAt: Date | null;

  @Column({ type: timestamp, nullable: true })
  finishedAt: Date | null;
}
