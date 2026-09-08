import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { databaseColumnType } from '../../database/database-types';

/** 目录名称归属的实体类型 */
export type DirectoryNameEntityType = 'file' | 'folder';

/**
 * 统一目录命名空间表（v1.2.6）。
 *
 * 背景：files 与 folders 是两张独立的表，任何单表唯一索引都无法阻止
 * 「同目录下文件与文件夹重名」；服务层 findOne 预检查在并发上传/创建时
 * 存在 TOCTOU 竞态。本表是跨表名称唯一性的最终裁决层：
 *
 * - 唯一约束 (ownerId, scopeKey, nameKey)（仅对 isDeleted=false 生效，
 *   PG 部分唯一索引 / SQLite 部分唯一索引均支持）；
 * - nameKey = 名称 Unicode NFC 归一化 + 小写折叠，实现大小写不敏感判定；
 * - scopeKey = 目录 ID，根目录用固定哨兵值 '__root__'，规避 NULL 索引语义差异；
 * - 软删除实体时置 isDeleted=true 释放名称；物理删除时删除行；
 * - 恢复时重新置 isDeleted=false，与其他活跃名称冲突即失败。
 */
@Entity('directory_names')
@Index('uq_directory_names_active', ['ownerId', 'scopeKey', 'nameKey'], {
  unique: true,
  where: '"isDeleted" = false',
})
@Index('idx_directory_names_entity', ['entityType', 'entityId'])
export class DirectoryName {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 名称空间所属用户（与 files.uploaderId / folders.ownerId 对齐） */
  @Column({ type: databaseColumnType('uuid') as 'uuid' })
  ownerId: string;

  /** 目录范围键：folder uuid 或根目录哨兵 '__root__' */
  @Column({ type: 'varchar', length: 64 })
  scopeKey: string;

  /** 规范化名称键：NFC 归一化 + 小写折叠 */
  @Column({ type: 'varchar', length: 255 })
  nameKey: string;

  /** 名称归属的实体类型 */
  @Column({ type: 'varchar', length: 10 })
  entityType: DirectoryNameEntityType;

  /** 名称归属的实体 ID */
  @Column({ type: databaseColumnType('uuid') as 'uuid' })
  entityId: string;

  /** 软删除（实体进入回收站）即释放名称 */
  @Column({ default: false })
  isDeleted: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
