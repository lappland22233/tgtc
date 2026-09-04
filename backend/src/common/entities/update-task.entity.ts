import { databaseColumnType } from '../../database/database-types';
import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/** 更新任务状态机的全部状态（唯一事实来源见 update/update-state-machine.ts） */
export type UpdateTaskStatus =
  | 'queued' | 'downloading' | 'verifying' | 'prechecking' | 'backing_up'
  | 'extracting' | 'migrating' | 'activating' | 'restarting' | 'health_checking'
  | 'succeeded'
  | 'rollback_pending' | 'rolling_back' | 'rolled_back' | 'rollback_failed'
  | 'cancelled';

/** 程序回退状态快照（仅激活后失败时有意义） */
export type UpdateRollbackStatus = 'not_needed' | 'needed' | 'in_progress' | 'completed' | 'failed';

/**
 * 系统更新任务持久化实体。
 *
 * 同一时间全局最多 1 个活动任务（非终态），由 isActive 部分唯一索引保证；
 * API 对外绝不返回 metadata 中的内部路径（备份位置、旧发行目录等）。
 */
@Entity('update_tasks')
@Index('idx_update_tasks_createdAt', ['createdAt'])
@Index('uq_update_tasks_active_slot', ['isActive'], { unique: true, where: '"isActive" = true' })
export class UpdateTask {
  /** 任务 ID（uuid v4，由服务生成） */
  @PrimaryColumn({ type: databaseColumnType('uuid') })
  taskId: string;

  /** 发起人（必须为 super_admin） */
  @Column({ type: databaseColumnType('uuid') })
  requestedBy: string;

  /** 发起时的当前版本（审计与升级前比对） */
  @Column({ type: 'varchar', length: 32 })
  currentVersion: string;

  /** 目标版本 */
  @Column({ type: 'varchar', length: 32 })
  targetVersion: string;

  /** GitHub Release 数字 ID（安装前二次核验的锚点） */
  @Column({ type: 'int' })
  releaseId: number;

  /** Release tag（vX.Y.Z） */
  @Column({ type: 'varchar', length: 64 })
  releaseTag: string;

  @Column({ type: 'varchar', length: 24, default: 'queued' })
  status: UpdateTaskStatus;

  /** 阶段进度（0-100，执行器心跳回传） */
  @Column({ type: 'int', default: 0 })
  progress: number;

  /** 活动槽位：终态（succeeded/rolled_back/rollback_failed/cancelled）时置 false */
  @Column({ default: true })
  isActive: boolean;

  @Column({ nullable: true, type: 'varchar', length: 64 })
  errorCode: string | null;

  /** 脱敏后的错误摘要（不含路径、Token、堆栈） */
  @Column({ nullable: true, type: 'text' })
  errorSummary: string | null;

  @Column({ nullable: true, type: 'varchar', length: 24 })
  rollbackStatus: UpdateRollbackStatus | null;

  /**
   * 兼容性/制品摘要快照（version、assetSha256、includesDbMigration 等）。
   * 同时存放内部备份位置与旧发行目录（仅服务端使用，禁止对外序列化）。
   */
  @Column({ type: databaseColumnType('jsonb'), nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ nullable: true, type: databaseColumnType('timestamptz') })
  startedAt: Date | null;

  @Column({ nullable: true, type: databaseColumnType('timestamptz') })
  finishedAt: Date | null;

  /** 执行器心跳时间；用于重启后判断任务是否仍在运行 */
  @Column({ nullable: true, type: databaseColumnType('timestamptz') })
  heartbeatAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
