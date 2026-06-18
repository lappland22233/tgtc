import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
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
export class FileAccessLog {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @ManyToOne(() => File)
  @JoinColumn({ name: 'fileId' })
  file: File;

  @Column()
  fileId: string;

  @Column({ nullable: true })
  ip: string;

  @Column({ type: 'varchar', length: 50 })
  action: string;

  @Column({ nullable: true })
  uploaderId: string;

  @CreateDateColumn()
  createdAt: Date;
}
