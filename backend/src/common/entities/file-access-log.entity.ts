import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { File } from './file.entity';

export enum AccessAction {
  DOWNLOAD = 'download',
  PUBLIC_SHARE = 'public_share',
  PREVIEW = 'preview',
}

@Entity('file_access_logs')
@Index('idx_access_logs_uploader_created', ['uploaderId', 'createdAt'])
@Index('idx_access_logs_file_created', ['fileId', 'createdAt'])
export class FileAccessLog {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @ManyToOne(() => File)
  @JoinColumn({ name: 'fileId' })
  file: File;

  @Column()
  @Index()
  fileId: string;

  @Column({ nullable: true })
  ip: string;

  @Column({ type: 'varchar', length: 50 })
  action: string;

  @Column({ nullable: true })
  uploaderId: string;

  @Column({ type: 'bigint', default: 0, comment: '实际传输字节数（带宽精确统计）' })
  responseSize: number;

  @CreateDateColumn()
  createdAt: Date;
}
