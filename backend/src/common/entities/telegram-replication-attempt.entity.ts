import { databaseColumnType } from '../../database/database-types';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { TelegramCopyOwnerType } from './telegram-file-copy.entity';

/**
 * 副本扩散轮次状态（对外语义稳定）。
 *
 * 为什么必须持久化而不是只留一条 `logger.warn`：生产的核心问题是
 * 「副本明明没补齐，后台却只能从账号池冷却日志反查」。状态机把「卡在哪一步」
 * 变成可查询事实：
 * - `planned`：已算出目标与缺口，尚未判定前置能力；
 * - `blocked_*`：策略 B 的前置条件不满足（配置 / 客户端 / 账号 / 源锚点 / 目标群 / 人工）；
 * - `relay_running` / `waiting_claims`：中继进行中与等待 Bot 认领；
 * - `succeeded` / `partial_success` / `claim_timeout` / `retryable_failed`：终态。
 */
export type ReplicationAttemptStatus =
  | 'planned'
  | 'blocked_not_configured'
  | 'blocked_user_client'
  | 'blocked_no_user_account'
  | 'blocked_source_anchor'
  | 'blocked_target_chat'
  | 'blocked_manual'
  | 'relay_running'
  | 'waiting_claims'
  | 'succeeded'
  | 'partial_success'
  | 'claim_timeout'
  | 'retryable_failed';

/**
 * 标准化中继失败原因（`UserRelayService` 返回值、轮次记录与告警共用）。
 *
 * 为什么不用自由文本：告警阈值、后台 Top N 分布、重试策略都按分类聚合；
 * 自由文本会让同一类故障散成几十个键，统计与告警全部失效。
 */
export type UserRelayFailureReason =
  | 'not_configured'
  | 'client_unavailable'
  | 'no_account'
  | 'source_missing'
  | 'target_missing'
  | 'permission_denied'
  | 'auth_invalid'
  | 'rate_limited'
  | 'network'
  | 'unknown';

/** 轮次触发来源：lazy=下载期懒扩散；manual=后台手动重试 */
export type ReplicationAttemptTrigger = 'lazy' | 'manual';

/**
 * 副本扩散轮次（策略 B：用户账号服务端中继 + Bot 入站认领）。
 *
 * 设计要点：
 * - **每逻辑文件每轮一行**，生命周期时间戳可重建时间线（startedAt → relayCompletedAt
 *   → claimDeadlineAt → completedAt）；同一 owner 在合并窗口内的重复阻塞/失败轮次
 *   **更新既有行**并累加 `retryCount`，避免懒扩散高频触发把表写爆；
 * - **不设 `bytesTransferred` 列**：策略 B 不发生文件字节二次传输，
 *   展示恒为 0 即可，留一列反而会诱导误读为「有字节流动」；
 * - `targetChatId` 内部存储、出参脱敏；`relayAccountId` / `relayMessageId` 仅存内部引用，
 *   不含任何凭据；
 * - 不建外键：与账号体系解耦，便于按保留窗口独立清理。
 */
@Entity('telegram_replication_attempts')
@Index('idx_tg_replication_attempts_owner', ['ownerType', 'ownerId', 'createdAt'])
@Index('idx_tg_replication_attempts_status', ['status'])
@Index('idx_tg_replication_attempts_reason', ['failureReason'])
@Index('idx_tg_replication_attempts_updated', ['updatedAt'])
export class TelegramReplicationAttempt {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16, comment: '归属对象类型：file|fileUnique|grant' })
  ownerType: TelegramCopyOwnerType;

  @Column({ type: 'varchar', length: 64, comment: '归属对象 ID（files.id / file_unique_id / grant.id）' })
  ownerId: string;

  /** 源副本账号（产生中继锚点 file_id 的账号）；仅内部 ID，出参可展示 */
  @Column({ type: 'varchar', length: 64, nullable: true, comment: '源副本账号 ID（仅内部 ID）' })
  sourceAccountId: string | null;

  /** 副本可见群（内部存储；出参必须脱敏，绝不返回完整原始地址） */
  @Column({ type: 'varchar', length: 32, nullable: true, comment: '副本可见群（内部存储，出参脱敏）' })
  targetChatId: string | null;

  /**
   * 幂等键：**同一逻辑操作的所有重试必须相同**。
   * 它同时决定中继选号种子与 MTProto `random_id`，因此重试不会在目标群产生重复消息。
   */
  @Column({ type: 'varchar', length: 160, nullable: true, comment: '幂等键（重试不变）' })
  idempotencyKey: string | null;

  @Column({ type: 'int', default: 0, comment: '期望副本数（effectiveTarget）' })
  desiredCount: number;

  @Column({ type: 'int', default: 0, comment: '本轮开始前已持有的 ready 副本数' })
  baselineReadyCount: number;

  /** 已认领账号 ID 列表（不含任何凭据；仅内部 ID） */
  @Column({
    type: databaseColumnType('jsonb') as 'jsonb',
    nullable: true,
    comment: '已认领账号 ID 列表（不含凭据）',
  })
  claimedAccountIds: string[] | null;

  @Column({ type: 'int', default: 0, comment: '结束时仍缺的副本数' })
  missingCount: number;

  @Column({ type: 'varchar', length: 24, default: 'planned', comment: '轮次状态' })
  status: ReplicationAttemptStatus;

  @Column({ type: 'varchar', length: 32, nullable: true, comment: '标准化失败原因（脱敏）' })
  failureReason: UserRelayFailureReason | null;

  @Column({ type: 'varchar', length: 500, nullable: true, comment: '失败摘要（已脱敏，长度上限）' })
  failureSummary: string | null;

  @Column({ type: 'int', default: 0, comment: '合并窗口内累计重试次数' })
  retryCount: number;

  /** 实际执行中继的用户账号（`telegram_accounts.id`，不含任何凭据） */
  @Column({ type: 'varchar', length: 64, nullable: true, comment: '执行中继的用户账号 ID（仅内部 ID）' })
  relayAccountId: string | null;

  /** 中继在目标群产生的消息 ID（脱敏引用，用于把认领与转发对齐） */
  @Column({ type: 'varchar', length: 32, nullable: true, comment: '中继产生的群消息 ID（脱敏引用）' })
  relayMessageId: string | null;

  @Column({ type: databaseColumnType('timestamptz') as 'timestamptz', nullable: true, comment: '本轮开始时间' })
  startedAt: Date | null;

  @Column({ type: databaseColumnType('timestamptz') as 'timestamptz', nullable: true, comment: '中继完成时间' })
  relayCompletedAt: Date | null;

  @Column({ type: databaseColumnType('timestamptz') as 'timestamptz', nullable: true, comment: '认领窗口截止时间' })
  claimDeadlineAt: Date | null;

  @Column({ type: databaseColumnType('timestamptz') as 'timestamptz', nullable: true, comment: '终态时间' })
  completedAt: Date | null;

  /**
   * 下次可重试时间（指数退避）。
   * 未到期时新一轮懒扩散直接跳过，既避免打爆 Telegram，也控制本表行数增长。
   */
  @Column({ type: databaseColumnType('timestamptz') as 'timestamptz', nullable: true, comment: '下次可重试时间' })
  nextRetryAt: Date | null;

  @Column({ type: 'varchar', length: 16, default: 'lazy', comment: '触发来源：lazy|manual' })
  triggeredBy: ReplicationAttemptTrigger;

  /** 手动重试操作人（`users.id`，仅内部 ID；自动轮次为 null） */
  @Column({ type: 'varchar', length: 64, nullable: true, comment: '手动重试操作人（仅内部 ID）' })
  operatorUserId: string | null;

  /** 手动重试的来源轮次 ID（用于审计链路追溯） */
  @Column({ type: databaseColumnType('uuid') as 'uuid', nullable: true, comment: '手动重试的来源轮次 ID' })
  retriedFromId: string | null;

  @CreateDateColumn({ comment: '创建时间' })
  createdAt: Date;

  @UpdateDateColumn({ comment: '更新时间' })
  updatedAt: Date;
}
