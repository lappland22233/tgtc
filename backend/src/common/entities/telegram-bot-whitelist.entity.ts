import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Telegram Bot 白名单。
 *
 * - 仅永久加入/移除，无过期语义（D3）；
 * - `enabled=false` 用于撤销（保留审计痕迹）；
 * - `source` 标记来源（env / admin），`createdBy` 记录操作者 TG 用户 ID；
 * - 白名单仅豁免每日配额，不豁免大小/频率/并发/TTL/管理员安全校验。
 */
@Entity('telegram_bot_whitelist')
@Index('uq_tg_bot_whitelist_tgUser', ['telegramUserId'], { unique: true })
export class TelegramBotWhitelist {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 32, comment: 'TG 用户 ID' })
  telegramUserId: string;

  @Column({ type: 'boolean', default: true, comment: '是否启用（false 表示已移除）' })
  enabled: boolean;

  /** 来源：env（启动导入） / admin（管理员命令添加） */
  @Column({ type: 'varchar', length: 16, default: 'admin', comment: '来源' })
  source: string;

  @Column({ type: 'varchar', length: 32, nullable: true, comment: '操作者 TG 用户 ID' })
  createdBy: string | null;

  @CreateDateColumn({ comment: '创建时间' })
  createdAt: Date;

  @UpdateDateColumn({ comment: '更新时间' })
  updatedAt: Date;
}
