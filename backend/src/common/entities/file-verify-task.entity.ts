import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type FileVerifyMode = 'dry-run' | 'apply';
export type FileVerifyTaskStatus = 'queued' | 'running' | 'completed' | 'failed';

/** 备用：活动任务的状态集合（queued / running） */
export const FILE_VERIFY_ACTIVE_STATUSES: FileVerifyTaskStatus[] = ['queued', 'running'];

/**
 * 文件体检异步任务持久化实体
 * 用于在后台通过 Bull 队列执行文件体检，并将进度/统计持久化，支持查询进度。
 * 同一时间全局最多 1 个活动任务（queued/running），由数据库部分唯一索引保证。
 */
@Entity('file_verify_tasks')
@Index('idx_file_verify_tasks_createdAt', ['createdAt'])
@Index('uq_file_verify_tasks_active_slot', ['isActive'], { unique: true, where: '"isActive" = true' })
export class FileVerifyTask {
  /** 任务 ID，由调用方传入 uuid v4，不设 default（避免隐式生成） */
  @PrimaryColumn({ type: 'uuid' })
  taskId: string;

  /** 发起人（管理员）ID */
  @Column({ type: 'uuid' })
  createdBy: string;

  /** dry-run：仅统计不修改（默认）；apply：按结果标记 error / 回填 telegramFilePath */
  @Column({ type: 'varchar', length: 16, default: 'dry-run' })
  mode: FileVerifyMode;

  /** true：校验全部 ready 文件；false（默认）：仅校验 telegramFilePath 为空的候选 */
  @Column({ default: false })
  allReady: boolean;

  /** 候选文件上限 */
  @Column({ type: 'int', default: 500 })
  limit: number;

  /** 有限并发数 */
  @Column({ type: 'int', default: 4 })
  concurrency: number;

  /** 活动槽位标记：终态（completed/failed）时置 false，部分唯一索引据此限制唯一活动任务 */
  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'varchar', length: 16, default: 'queued' })
  status: FileVerifyTaskStatus;

  @Column({ type: 'int', default: 0 })
  totalCandidates: number;

  @Column({ type: 'int', default: 0 })
  processed: number;

  @Column({ type: 'int', default: 0 })
  valid: number;

  @Column({ type: 'int', default: 0 })
  invalid: number;

  @Column({ type: 'int', default: 0 })
  emptyFileId: number;

  @Column({ type: 'int', default: 0 })
  temporaryFailure: number;

  @Column({ type: 'int', default: 0 })
  sizeMismatch: number;

  @Column({ type: 'int', default: 0 })
  backfilled: number;

  @Column({ type: 'int', default: 0 })
  markedError: number;

  /** 失败时的脱敏错误摘要 */
  @Column({ nullable: true, type: 'text' })
  errorSummary: string | null;

  @Column({ nullable: true, type: 'timestamptz' })
  startedAt: Date | null;

  @Column({ nullable: true, type: 'timestamptz' })
  completedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
