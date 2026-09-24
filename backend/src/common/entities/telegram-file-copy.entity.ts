import { databaseColumnType } from '../../database/database-types';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 副本归属对象类型（逻辑文件主键）：
 * - `fileUnique`（**默认、推荐**）：以 Telegram `file_unique_id` 为主键——
 *   它跨账号稳定（"same over time and for different bots"），是跨账号聚合副本的唯一可靠锚点；
 * - `file`：站内文件（files.id），用于后台上传的文件；
 * - `grant`：Bot 直链授权记录（grant.id），用于以直链为锚点的场景。
 */
export type TelegramCopyOwnerType = 'fileUnique' | 'file' | 'grant';

/** 副本状态：ready=可直接用于取流；pending=复制中；failed=复制失败（可重试） */
export type TelegramCopyStatus = 'ready' | 'pending' | 'failed';

/** 副本来源：inbound=该账号直接收到/上传；replicated=由其它副本扩散而来；relayed=用户账号中继后本账号取得 */
export type TelegramCopySource = 'inbound' | 'replicated' | 'relayed';

/**
 * Telegram 文件副本表（多账号回源的核心）。
 *
 * 为什么必须有这张表：**`file_id` 是账号隔离的**，同一个文件在不同 Bot 账号下
 * 是不同的 `file_id`；因此「按负载挑一个账号回源」的前提是**该账号持有自己的副本
 * 记录**。本表即「逻辑文件 → 各账号的 file_id 映射」。
 *
 * 关键约束：
 * - `(ownerType, ownerId, accountId)` 唯一：同账号同文件只允许一条，重投幂等；
 * - `telegramFileId` 与产生它的账号绑定，**禁止跨账号复用**（跨实例复用会得到
 *   上游 `Exact file size is unavailable from Telegram`）；
 * - 不建外键：与站内用户体系、Bot 授权体系解耦，便于独立清理。
 */
@Entity('telegram_file_copies')
@Index('uq_tg_file_copies_owner_account', ['ownerType', 'ownerId', 'accountId'], { unique: true })
@Index('idx_tg_file_copies_owner', ['ownerType', 'ownerId'])
@Index('idx_tg_file_copies_status', ['status'])
@Index('idx_tg_file_copies_anchor', ['chatId', 'messageId'])
@Index('idx_tg_file_copies_anchor_owner', ['chatId', 'messageId', 'ownerType', 'ownerId'])
/**
 * 锚点一致性（**只约束 `fileUnique` 命名空间，且按账号维度**）。
 *
 * 语义：**同一个账号**在同一条消息上只能登记一个逻辑主键。
 *
 * 为什么不是「(chatId, messageId) 唯一」：那会直接打断两处**合法**场景——
 * 1. 同一备份群里多个 Bot 都会收到**同一条消息**，各自以自己的 `accountId` 登记
 *    自己的 `file_id`（同一 `file_unique_id`、不同账号）；若锚点唯一，第二个 Bot
 *    将永远登记失败（副本分布就再也扩不出去）；
 * 2. 桥接双写：`bridgeInboundCopyToLogicalFile` 会把同一锚点额外写到 `file`
 *    命名空间（`file_unique_id` 可能命中多条站内文件），同一锚点对应多个 `ownerId`
 *    是设计内行为。
 *
 * 因此唯一键取 `(chatId, messageId, ownerType, ownerId, accountId)` 之外的
 * **最小可靠约束**：`(chatId, messageId, accountId) where ownerType='fileUnique'`。
 * 它挡住的是真正的脏数据来源——同一账号在同一条消息上登记互相矛盾的逻辑主键
 * （重复登记 / 锚点串号），而这类脏数据正是「回源候选集合在命名空间之间漂移、
 * 同一个文件看起来总压在同一账号」的成因。
 *
 * 跨账号的分歧（两个账号对同一消息给出不同 `file_unique_id`）无法用单索引表达，
 * 由 `FileCopyService.findByAnchor` 的确定性收敛 + `anchorConflicts` 计数暴露给审计。
 */
@Index('uq_tg_file_copies_anchor_account', ['chatId', 'messageId', 'accountId'], {
  unique: true,
  where: `"ownerType" = 'fileUnique' AND "chatId" IS NOT NULL AND "messageId" IS NOT NULL`,
})
export class TelegramFileCopy {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16, comment: '归属对象类型：file|grant' })
  ownerType: TelegramCopyOwnerType;

  @Column({ type: 'varchar', length: 64, comment: '归属对象 ID（files.id 或 grant.id）' })
  ownerId: string;

  /** 账号标识：默认 bot token 的数字前缀（botId），与账号池 id 一致 */
  @Column({ type: 'varchar', length: 64, comment: 'Bot 账号标识（botId）' })
  accountId: string;

  /** 该账号自己的 file_id（**不可跨账号复用**） */
  @Column({ type: 'varchar', length: 512, comment: '该账号的 Telegram file_id' })
  telegramFileId: string;

  /** 产生该 file_id 的 chat（用于中继/转发定位） */
  @Column({ type: 'varchar', length: 32, nullable: true, comment: '产生 file_id 的 chat id' })
  chatId: string | null;

  /** 产生该 file_id 的消息 ID（转发/中继用） */
  @Column({ type: 'varchar', length: 32, nullable: true, comment: '消息 ID（转发锚点）' })
  messageId: string | null;

  @Column({ type: 'bigint', nullable: true, comment: '文件大小（字节）' })
  fileSize: string | null;

  @Column({ type: 'varchar', length: 16, default: 'inbound', comment: '副本来源：inbound|replicated|relayed' })
  source: TelegramCopySource;

  @Column({ type: 'varchar', length: 16, default: 'ready', comment: '状态：ready|pending|failed' })
  status: TelegramCopyStatus;

  /** 失败原因摘要（**已脱敏**，仅保留 500 字符） */
  @Column({ type: 'varchar', length: 500, nullable: true, comment: '最近失败原因（脱敏）' })
  lastError: string | null;

  @Column({ type: databaseColumnType('timestamptz') as 'timestamptz', nullable: true, comment: '最近一次用于取流的时间' })
  lastUsedAt: Date | null;

  @CreateDateColumn({ comment: '创建时间' })
  createdAt: Date;

  @UpdateDateColumn({ comment: '更新时间' })
  updatedAt: Date;
}
