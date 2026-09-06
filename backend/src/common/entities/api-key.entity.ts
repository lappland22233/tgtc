import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { databaseColumnType } from '../../database/database-types';

/**
 * API 密钥实体。
 *
 * 安全设计：
 * - 服务端只保存密钥的 SHA-256 摘要（keyHash，唯一索引），明文仅在创建响应中返回一次；
 * - prefix 保存展示用前缀（如 tgtc_a1b2c3d4），用于界面识别与脱敏日志；
 * - 撤销为软撤销（revokedAt 时间戳），认证时即时生效；
 * - lastUsedAt 做节流更新（每分钟最多一次），避免每个请求都写库。
 */
@Entity('api_keys')
@Index('idx_api_keys_userId', ['userId'])
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 关联账号（owner-only 边界的锚点） */
  @Column({ type: databaseColumnType('uuid') as 'uuid' })
  userId: string;

  /** 用户自定义名称，便于识别用途 */
  @Column({ type: 'varchar', length: 64 })
  name: string;

  /** 明文密钥展示前缀（创建后仅能凭此识别密钥） */
  @Column({ type: 'varchar', length: 16 })
  prefix: string;

  /** SHA-256(key) 十六进制摘要，唯一；原始密钥永不落库 */
  @Index('uq_api_keys_keyHash', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  keyHash: string;

  @Column({ type: databaseColumnType('timestamptz') as 'timestamptz', nullable: true })
  lastUsedAt: Date | null;

  /** 软撤销时间；非 null 即失效 */
  @Column({ type: databaseColumnType('timestamptz') as 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
