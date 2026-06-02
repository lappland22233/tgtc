import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from './user.entity';

export enum FileAccessType {
  PUBLIC = 'public',
  PRIVATE = 'private',
}

@Entity('files')
export class File {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  filename: string;

  @Column()
  originalName: string;

  @Column()
  mimeType: string;

  @Column('bigint')
  size: number;

  @Column()
  telegramFileId: string;

  @Column()
  telegramFilePath: string;

  @Column({ type: 'enum', enum: FileAccessType, default: FileAccessType.PUBLIC })
  accessType: FileAccessType;

  @Column({ default: -1 })
  maxAccessCount: number;

  @Column({ nullable: true, type: 'int' })
  expiresIn: number | null;

  @Column({ nullable: true, type: 'timestamp' })
  expiresStartAt: Date | null;

  @Column({ default: 0 })
  currentAccessCount: number;

  @Column({ nullable: true, type: 'varchar' })
  password: string | null;

  @Column({ default: false })
  isDeleted: boolean;

  @ManyToOne(() => User, (user) => user.files)
  @JoinColumn({ name: 'uploaderId' })
  uploader: User;

  @Column()
  uploaderId: string;

  @CreateDateColumn()
  createdAt: Date;
}
