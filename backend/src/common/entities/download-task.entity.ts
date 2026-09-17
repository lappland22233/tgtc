import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { databaseColumnType } from '../../database/database-types';

/**
 * 下载任务（持久化）。
 *
 * 设计边界：
 * - 内存中的任务表仍是运行时的权威来源（排队位置、预约量等只在进程内有效）；
 *   本实体只持久化「任务是否曾经存在 + 最终状态」，用于服务重启后把未完成任务
 *   标记为过期（前端据此重新发起），以及过期记录清理。
 * - 只保存 ownerKey（`user:<id>` / `share:<token-hash 前缀>`），不落库分享 token 明文。
 * - 不保存文件内容或本地临时路径：临时文件由缓存会话负责回收，重启后本就无需保留。
 */
@Entity('download_tasks')
export class DownloadTask {
  @PrimaryColumn('uuid')
  id: string;

  /** 任务归属：user:<id>；分享来源使用不可逆摘要。 */
  @Index('idx_download_tasks_owner')
  @Column({ type: 'varchar', length: 128 })
  ownerKey: string;

  @Index('idx_download_tasks_file')
  @Column({ type: databaseColumnType('uuid') as 'uuid' })
  fileId: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  fileName: string | null;

  @Index('idx_download_tasks_status')
  @Column({ type: 'varchar', length: 16 })
  status: string;

  @Column({ type: 'varchar', length: 16, nullable: true })
  queueReason: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  errorCode: string | null;

  /** bigint 列在 PG 以字符串返回，读取方需 Number() 归一化 */
  @Column({ type: 'bigint', default: 0 })
  expectedSize: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  /**
   * 过期时刻：超过后任务视为 expired，可由定时清理删除。
   * 必须走 databaseColumnType：PG 只接受 timestamptz/timestamp，
   * 直接写 SQLite 的 'datetime' 会让 PG 在 DataSource.initialize() 阶段抛
   * DataTypeNotSupportedError（迁移与启动双阻断）。
   */
  @Index('idx_download_tasks_expires')
  @Column({ type: databaseColumnType('timestamptz') as 'timestamptz' })
  expiresAt: Date;
}
