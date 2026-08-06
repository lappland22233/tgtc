import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Tree,
  TreeChildren,
  TreeParent,
  Index,
} from 'typeorm';
import { User } from './user.entity';

/**
 * 文件夹实体（网盘层级）。
 *
 * 采用闭包表（closure-table）存储层级关系，TypeORM 原生 @Tree('closure-table') 支持。
 * folderId = null 的 File 视为位于用户网盘根目录，与历史数据兼容。
 *
 * 软删除策略与 files 表一致：标记 isDeleted=true，7 天延迟后由清理任务物理删除。
 */
@Entity('folders')
// closureTableName 必须显式指定：TypeORM 默认按实体表名解析闭包联结表（即 folders_closure），
// 但迁移 1790400000000-AddFoldersTable 实际建的表是 folder_closure（synchronize=false，不会自动建表）。
// 指定 closureTableName: 'folder' 后 TypeORM 拼 `_closure` 后缀解析为 folder_closure，与迁移及裸 SQL 对齐。
@Tree('closure-table', { closureTableName: 'folder' })
@Index('idx_folders_owner_parent_deleted', ['ownerId', 'parentId', 'isDeleted'])
export class Folder {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Column({ length: 255 })
  name: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ownerId' })
  owner: User;

  @Column()
  ownerId: string;

  @TreeParent()
  parent: Folder | null;

  @Index()
  @Column({ nullable: true })
  parentId: string | null;

  @TreeChildren()
  children: Folder[];

  @Column({ default: false })
  isDeleted: boolean;

  /** 请求删除的时间（延迟删除机制），null 表示未请求删除 */
  @Column({ nullable: true, type: 'timestamp' })
  deleteRequestedAt: Date | null;

  /** 计划执行永久删除的时间（deleteRequestedAt + 7 天） */
  @Column({ nullable: true, type: 'timestamp' })
  deleteScheduledAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
