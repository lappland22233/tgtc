import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 异步上传任务持久化实体
 * 用于在进程重启后恢复任务状态，将未完成的任务标记为失败
 */
@Entity('upload_tasks')
export class UploadTask {
  @PrimaryColumn({ type: 'uuid' })
  jobId: string;

  @Column({ type: 'uuid' })
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
