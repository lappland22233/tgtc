import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from './user.entity';
import { databaseColumnType } from '../../database/database-types';
import { Folder } from './folder.entity';

export enum FileAccessType {
  PUBLIC = 'public',
  PRIVATE = 'private',
}

@Entity('files')
@Index('idx_files_uploader_folder_deleted', ['uploaderId', 'folderId', 'isDeleted'])
export class File {
  @PrimaryGeneratedColumn('uuid')
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

  /** 本地缩略图路径（相对于 THUMBNAIL_DIR，如 {id}.webp） */
  @Column({ type: 'varchar', length: 512, nullable: true, default: null })
  thumbnailPath: string | null;

  /** 所属文件夹 ID（null 表示位于用户网盘根目录） */
  @Index()
  @Column({ nullable: true })
  folderId: string | null;

  @ManyToOne(() => Folder, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'folderId' })
  folder: Folder | null;

  @Column({ type: databaseColumnType('enum') as 'enum', enum: FileAccessType, default: FileAccessType.PUBLIC })
  accessType: FileAccessType;

  /**
   * @deprecated Phase 2 起由 ShareLink.maxAccessCount 管理。此字段保留用于数据迁移兼容，将在下一个 major 版本删除。
   */
  @Column({ default: -1 })
  maxAccessCount: number;

  /**
   * @deprecated Phase 2 起由 ShareLink.expiresIn 管理。此字段保留用于数据迁移兼容，将在下一个 major 版本删除。
   */
  @Column({ nullable: true, type: 'int' })
  expiresIn: number | null;

  /**
   * @deprecated Phase 2 起由 ShareLink.expiresStartAt 管理。此字段保留用于数据迁移兼容，将在下一个 major 版本删除。
   */
  @Column({ nullable: true, type: databaseColumnType('timestamp') as 'timestamp' })
  expiresStartAt: Date | null;

  /**
   * @deprecated Phase 2 起由 ShareLink.currentAccessCount 管理。此字段保留用于数据迁移兼容，将在下一个 major 版本删除。
   */
  @Column({ default: 0 })
  currentAccessCount: number;

  /**
   * @deprecated Phase 2 起由 ShareLink.password 管理。此字段保留用于数据迁移兼容，将在下一个 major 版本删除。
   */
  @Column({ nullable: true, type: 'varchar' })
  password: string | null;

  @Column({ default: false })
  isDeleted: boolean;

  /** 请求删除的时间（延迟删除机制），null 表示未请求删除 */
  @Column({ nullable: true, type: databaseColumnType('timestamp') as 'timestamp' })
  deleteRequestedAt: Date | null;

  /** 计划执行永久删除的时间（deleteRequestedAt + 7 天） */
  @Column({ nullable: true, type: databaseColumnType('timestamp') as 'timestamp' })
  deleteScheduledAt: Date | null;

  /** 删除操作冷却窗口截止时间（10 分钟），防止短时间内重复请求 */
  @Column({ nullable: true, type: databaseColumnType('timestamp') as 'timestamp' })
  deleteCooldownUntil: Date | null;

  /** 是否由管理员删除（管理员删除时普通用户不可恢复） */
  @Column({ default: false })
  deletedByAdmin: boolean;

  @ManyToOne(() => User, (user) => user.files)
  @JoinColumn({ name: 'uploaderId' })
  uploader: User;

  @Column()
  uploaderId: string;

  @Column({ type: 'varchar', default: 'ready' })
  status: 'processing' | 'ready' | 'error';

  /** 每次创建或覆盖内容时递增，用于生成确定性 Bull jobId。 */
  @Column({ type: 'int', default: 1 })
  uploadVersion: number;

  /** Telegram 原文件提交点与衍生媒体处理解耦的持久化状态机。 */
  @Column({ type: 'varchar', length: 32, default: 'committed' })
  uploadStage: 'pending' | 'uploading' | 'remote_committed' | 'committed' | 'recoverable' | 'failed';

  /**
   * 最终上传失败的安全诊断原因（内部诊断用，默认查询不加载该字段）。
   * 不保存堆栈、Token、本地路径或文件内容；成功提交与覆盖上传时会清空。
   */
  @Column({ type: 'varchar', length: 1000, nullable: true, select: false })
  uploadFailureReason: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
