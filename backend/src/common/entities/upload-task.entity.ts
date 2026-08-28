import { databaseColumnType } from '../../database/database-types';
import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * 异步上传任务持久化实体
 * 用于在进程重启后恢复任务状态，将未完成的任务标记为失败
 */
@Entity('upload_tasks')
@Index('idx_upload_tasks_updatedAt', ['updatedAt'])
export class UploadTask {
  /** 上传任务 ID，由调用方传入 uuid v4，不设 default（避免隐式生成） */
  @PrimaryColumn({ type: databaseColumnType('uuid') })
  jobId: string;

  @Column({ type: databaseColumnType('uuid') })
  userId: string;

  @Column()
  filename: string;

  @Column({ default: 'pending' })
  status: 'pending' | 'uploading' | 'completed' | 'failed';

  @Column({ default: 0 })
  progress: number;

  @Column({ nullable: true, type: 'text' })
  result: string | null; // JSON-serialized result

  @Column({ nullable: true, type: 'text' })
  error: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
