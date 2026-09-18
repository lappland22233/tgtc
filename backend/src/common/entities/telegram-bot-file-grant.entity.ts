import { databaseColumnType } from '../../database/database-types';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Telegram Bot 直链授权记录（grant）。
 *
 * 设计要点：
 * - TG 用户 ID 可能超出 32 位整数，统一以字符串（varchar）存储（R5）；
 * - Token 双轨存储：`tokenHash`（SHA-256，校验用，不可逆）+
 *   `tokenCipher`（AES-256-GCM，仅管理员查询时解密回放，可缺失）（C-3/R9）；
 * - `(telegramUserId, chatId, messageId)` 唯一：同一条消息重投时幂等命中，
 *   不重复扣配额、不重复签发（R7）；
 * - 用户名/显示名为签发时刻快照（TG 用户名可随时修改，R6）；
 * - `accessCount` 仅供统计，任何路径不得据此拦截（D2）。
 */
@Entity('telegram_bot_file_grants')
@Index('idx_tg_bot_grants_tgUser', ['telegramUserId'])
@Index('idx_tg_bot_grants_expiresAt', ['expiresAt'])
@Index('uq_tg_bot_grants_tokenHash', ['tokenHash'], { unique: true })
@Index('uq_tg_bot_grants_message', ['telegramUserId', 'chatId', 'messageId'], { unique: true })
export class TelegramBotFileGrant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 上传者 TG 用户 ID（身份唯一依据，字符串存储） */
  @Column({ type: 'varchar', length: 32, comment: 'TG 用户 ID（身份依据）' })
  telegramUserId: string;

  /** 签发时刻的用户名快照（可空，仅审计展示，不参与权限判定） */
  @Column({ type: 'varchar', length: 64, nullable: true, comment: 'TG 用户名快照' })
  telegramUsername: string | null;

  /** 签发时刻的显示名快照 */
  @Column({ type: 'varchar', length: 128, nullable: true, comment: 'TG 显示名快照' })
  telegramDisplayName: string | null;

  @Column({ type: 'varchar', length: 32, comment: '聊天 ID（私聊）' })
  chatId: string;

  @Column({ type: 'varchar', length: 32, comment: '消息 ID（幂等锚点）' })
  messageId: string;

  /** Telegram 文件标识，用于取流 */
  @Column({ type: 'varchar', length: 512, comment: 'Telegram file_id' })
  telegramFileId: string;

  @Column({ type: 'varchar', length: 255, nullable: true, comment: '文件名' })
  fileName: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true, comment: 'MIME 类型' })
  mimeType: string | null;

  @Column({ type: 'bigint', nullable: true, comment: '文件大小（字节）' })
  fileSize: string | null;

  /** SHA-256(token) 十六进制摘要，校验用 */
  @Column({ type: 'varchar', length: 64, comment: 'SHA-256(token)' })
  tokenHash: string;

  /** AES-256-GCM 密文（可回放），根密钥缺失时为 null */
  @Column({ type: 'varchar', length: 1024, nullable: true, comment: 'AES-256-GCM 密文（可回放）' })
  tokenCipher: string | null;

  /** 展示用 Token 前缀（如 tgl_a1b2c3d4） */
  @Column({ type: 'varchar', length: 16, comment: 'Token 展示前缀' })
  tokenPrefix: string;

  @Column({ type: 'varchar', length: 16, nullable: true, comment: '密文算法版本' })
  cipherVersion: string | null;

  @Column({ type: databaseColumnType('timestamptz') as 'timestamptz', comment: '过期时间' })
  expiresAt: Date;

  @Column({ type: databaseColumnType('timestamptz') as 'timestamptz', nullable: true, comment: '软撤销时间' })
  revokedAt: Date | null;

  /** 撤销者 TG 用户 ID（管理员撤销时记录） */
  @Column({ type: 'varchar', length: 32, nullable: true, comment: '撤销者 TG 用户 ID' })
  revokedBy: string | null;

  /** 访问计数（仅供统计，不用于拦截） */
  @Column({ type: 'int', default: 0, comment: '访问计数（仅统计）' })
  accessCount: number;

  @Column({ type: databaseColumnType('timestamptz') as 'timestamptz', nullable: true, comment: '最近访问时间' })
  lastAccessedAt: Date | null;

  @CreateDateColumn({ comment: '签发时间' })
  createdAt: Date;
}
