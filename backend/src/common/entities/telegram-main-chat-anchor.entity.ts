import { databaseColumnType } from '../../database/database-types';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { TelegramCopyOwnerType } from './telegram-file-copy.entity';

/**
 * 锚点状态：
 * - `pending`=已预留（**先落库再执行**：预留成功才允许产生主群消息，租约超时后可接管重搬）；
 * - `ready`=主群消息已确认可用；
 * - `failed`=搬运失败（无副作用残留，重试可直接接管，保留失败原因供运维定位）。
 */
export type TelegramMainChatAnchorStatus = 'pending' | 'ready' | 'failed';

/**
 * 主群锚点表（副本扩散的唯一中转落点）。
 *
 * ## 为什么必须有这张表
 *
 * 副本扩散链路是「持有源消息的 Bot 先把消息转发进**主群**，再由用户账号(userbot)从主群
 * 服务端转发到各镜像群」。用户账号读不到「Bot 与用户的私聊」，也未必是各账号存储 Chat 的
 * 成员，因此源锚点必须先落到主群才能被中继。
 *
 * Bot API 的 `forwardMessage` **没有幂等键**：重试会再搬一次并在主群留下重复消息。
 * 因此搬运必须**先落库（预留 `pending`）再执行**，且落点必须是**所有镜像规则共享**的一行——
 * 若把锚点写在各条任务行上（每条规则一行），同一文件会被搬运 N 次。
 *
 * ## 约束
 *
 * - `(ownerType, ownerId)` 唯一：同一个逻辑归属对象在主群只有一个落点；
 * - `anchorChatId + anchorMessageId` 是 MTProto 中继的源锚点（消息 ID 与 Bot API 同源）；
 * - 主群变更（管理员改规则的 `sourceChatId`）时，锚点行会被**重写**为新主群
 *   （接管路径统一走「删旧行 + 重新插入」的唯一键 CAS，行 id 会变），
 *   旧主群里的历史消息保留为孤儿（不删除、无法自动清理，需人工处理）；
 * - 不建外键：与站内文件/授权体系解耦，便于按归属对象独立清理。
 */
@Entity('telegram_main_chat_anchors')
@Index('uq_tg_main_chat_anchors_owner', ['ownerType', 'ownerId'], { unique: true })
@Index('idx_tg_main_chat_anchors_anchor', ['anchorChatId', 'anchorMessageId'])
export class TelegramMainChatAnchor {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16, comment: '归属对象类型：file|grant|fileUnique' })
  ownerType: TelegramCopyOwnerType;

  @Column({ type: 'varchar', length: 64, comment: '归属对象 ID（files.id / grant.id / file_unique_id）' })
  ownerId: string;

  @Column({ type: 'varchar', length: 32, comment: '主群 chat id（中转落点，硬约束：必须为群/频道）' })
  anchorChatId: string;

  /** 主群消息 ID：MTProto 中继的源锚点；搬运失败时为空 */
  @Column({ type: 'varchar', length: 32, nullable: true, comment: '主群消息 ID（中继源锚点）' })
  anchorMessageId: string | null;

  /** 执行搬运的 Bot 账号：只允许是「持有该消息的那个账号」，绝不跨账号代搬 */
  @Column({ type: 'varchar', length: 64, nullable: true, comment: '执行搬运的 Bot 账号 ID' })
  plantedByAccountId: string | null;

  /** 原锚点 chat id（审计与排障：私聊 → 主群 的搬运留痕） */
  @Column({ type: 'varchar', length: 32, nullable: true, comment: '原锚点 chat id（审计）' })
  sourceChatId: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true, comment: '原锚点消息 ID（审计）' })
  sourceMessageId: string | null;

  @Column({ type: 'varchar', length: 16, default: 'ready', comment: '状态：pending|ready|failed' })
  status: TelegramMainChatAnchorStatus;

  /** 失败原因摘要（**已脱敏**，仅保留 500 字符） */
  @Column({ type: 'varchar', length: 500, nullable: true, comment: '最近失败原因（脱敏）' })
  lastError: string | null;

  /**
   * 时间戳（列名保留不改，语义按状态区分，避免为「预留时间」再加一列）：
   * - `pending`：预留时间（租约起算点，超时后可被接管重搬）；
   * - `ready`：最近一次搬运完成时间。
   */
  @Column({ type: databaseColumnType('timestamptz') as 'timestamptz', nullable: true, comment: 'pending=预留时间（租约）；ready=搬运完成时间' })
  plantedAt: Date | null;

  @CreateDateColumn({ comment: '创建时间' })
  createdAt: Date;

  @UpdateDateColumn({ comment: '更新时间' })
  updatedAt: Date;
}
