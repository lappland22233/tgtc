import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
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
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Column()
  filename: string;

  @Column()
  originalName: string;

  @Column()
  mimeType: string;

  /**
   * 文件大小（字节）。
   * PostgreSQL 列类型为 bigint，TypeScript 类型为 number。
   * 项目支持的最大文件为 600MB，远小于 Number.MAX_SAFE_INTEGER (2^53 ≈ 9PB)，
   * 不会发生精度丢失。如未来支持超大文件需改为 string/BigInt。
   */
  @Column('bigint')
  size: number;

  @Column()
  telegramFileId: string;

  @Column({ nullable: true })
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

  /** 请求删除的时间（延迟删除机制），null 表示未请求删除 */
  @Column({ nullable: true, type: 'timestamp' })
  deleteRequestedAt: Date | null;

  /** 计划执行永久删除的时间（deleteRequestedAt + 7 天） */
  @Column({ nullable: true, type: 'timestamp' })
  deleteScheduledAt: Date | null;

  /** 删除操作冷却窗口截止时间（10 分钟），防止短时间内重复请求 */
  @Column({ nullable: true, type: 'timestamp' })
  deleteCooldownUntil: Date | null;

  /** 是否由管理员删除（管理员删除时普通用户不可恢复） */
  @Column({ default: false })
  deletedByAdmin: boolean;

  @ManyToOne(() => User, (user) => user.files)
  @JoinColumn({ name: 'uploaderId' })
  uploader: User;

  @Column()
  uploaderId: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
