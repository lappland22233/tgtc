import { databaseColumnType } from '../../database/database-types';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { TelegramMirrorMode } from './telegram-mirror-rule.entity';

/**
 * 镜像任务的归属对象类型：
 * - `file`：站内文件（files.id），普通 Web 上传与私有文件；
 * - `grant`：Bot 直链授权记录（telegram_bot_file_grants.id），Bot 私聊入站文件；
 * - `fileUnique`：Telegram `file_unique_id`（跨账号稳定的逻辑主键兜底）。
 */
export type TelegramMirrorOwnerType = 'file' | 'grant' | 'fileUnique';

/**
 * 镜像任务状态机：
 * queued → running → succeeded
 *                  ↘ retrying → running | failed | blocked
 * retrying 之外还可由人工 → cancelled（仅未开始的任务）
 */
export type TelegramMirrorTaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'retrying'
  | 'failed'
  | 'blocked'
  | 'cancelled';

/**
 * Telegram 文件镜像任务（持久化，取代进程内 Map）。
 *
 * 为什么必须持久化：镜像要能重试、能在重启后恢复、能在失败时被管理员看见并重试；
 * 进程内 Map 一旦重启即丢失，会出现「主文件成功但备份永远缺失且无人知晓」。
 *
 * 幂等键 = `(ruleId, ownerType, ownerId, sourceVersion)`：
 * - 重复事件、Bull 重试、进程重启都收敛到同一条任务记录；
 * - Bull 侧使用同一字符串生成确定性 jobId 做入队去重。
 *
 * 覆盖上传：`sourceVersion` 绑定 `File.uploadVersion`，旧任务检测到版本变化后
 * 终止或标记过期，绝不把旧内容写进备份群。
 */
@Entity('telegram_mirror_tasks')
@Index('uq_tg_mirror_tasks_idempotency', ['ruleId', 'ownerType', 'ownerId', 'sourceVersion'], { unique: true })
@Index('idx_tg_mirror_tasks_status', ['status'])
@Index('idx_tg_mirror_tasks_rule_status', ['ruleId', 'status'])
@Index('idx_tg_mirror_tasks_next_retry', ['nextRetryAt'])
export class TelegramMirrorTask {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: databaseColumnType('uuid') as 'uuid', comment: '所属镜像规则' })
  ruleId: string;

  @Column({ type: 'varchar', length: 16, comment: '归属对象类型：file|grant|fileUnique' })
  ownerType: TelegramMirrorOwnerType;

  @Column({ type: 'varchar', length: 64, comment: '归属对象 ID' })
  ownerId: string;

  /** 覆盖上传递增版本；绑定 File.uploadVersion，用于作废旧任务 */
  @Column({ type: 'int', default: 1, comment: '源内容版本（覆盖上传递增）' })
  sourceVersion: number;

  /** 源副本所属账号（产生 source file_id 的账号），为空表示归属不明 */
  @Column({ type: 'varchar', length: 64, nullable: true, comment: '源副本账号 ID' })
  sourceAccountId: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true, comment: '源 Chat' })
  sourceChatId: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true, comment: '源消息 ID（用户复制依赖）' })
  sourceMessageId: string | null;

  /** 实际执行账号（Bot 或用户账号 ID）；失败不得跨账号代发 */
  @Column({ type: 'varchar', length: 64, nullable: true, comment: '实际执行账号 ID' })
  targetAccountId: string | null;

  @Column({ type: 'varchar', length: 16, comment: '实际执行模式：bot_upload|user_copy' })
  mode: TelegramMirrorMode;

  @Column({ type: 'varchar', length: 16, default: 'queued', comment: '任务状态' })
  status: TelegramMirrorTaskStatus;

  @Column({ type: 'int', default: 0, comment: '已尝试次数' })
  attempts: number;

  @Column({ type: 'varchar', length: 32, nullable: true, comment: '备份群消息 ID' })
  targetMessageId: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true, comment: '目标账号自己的 file_id（仅该账号可用）' })
  targetTelegramFileId: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true, comment: '目标 Chat' })
  targetChatId: string | null;

  /**
   * 可恢复回执：目标侧已成功产生消息、但站内状态尚未提交时为 true。
   * 重试前必须先用回执与既有副本做幂等判定，避免重复备份。
   */
  @Column({ type: 'boolean', default: false, comment: '存在待落库的目标侧回执' })
  receiptPending: boolean;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: '最近错误分类（脱敏）' })
  lastErrorCode: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true, comment: '最近错误摘要（脱敏）' })
  lastErrorSummary: string | null;

  @Column({ type: databaseColumnType('timestamptz') as 'timestamptz', nullable: true, comment: '下次重试时间' })
  nextRetryAt: Date | null;

  @Column({ type: databaseColumnType('timestamptz') as 'timestamptz', nullable: true, comment: '开始执行时间' })
  startedAt: Date | null;

  @Column({ type: databaseColumnType('timestamptz') as 'timestamptz', nullable: true, comment: '完成时间' })
  completedAt: Date | null;

  @CreateDateColumn({ comment: '创建时间' })
  createdAt: Date;

  @UpdateDateColumn({ comment: '更新时间' })
  updatedAt: Date;
}
