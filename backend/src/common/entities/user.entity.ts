import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  OneToMany,
} from 'typeorm';
import { File } from './file.entity';
import { Folder } from './folder.entity';

export enum UserRole {
  USER = 'user',
  ADMIN = 'admin',
  SUPER_ADMIN = 'super_admin',
}

@Entity('users')
export class User {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  /**
   * 用户邮箱（唯一）。
   * 注意：唯一约束大小写敏感，且当前无 lower(email) 函数索引，
   * 'A@x.com' 与 'a@x.com' 被视为不同邮箱。完整的归一化需配合
   * auth.service 登录/注册流程及存量数据迁移（lowercase）统一处理，
   * 此处仅在服务层对管理员创建的邮箱做 trim+lowercase 归一化。
   */
  @Column({ unique: true })
  email: string;

  @Column({ length: 255, comment: 'bcrypt hashed password, never store plaintext' })
  password: string;

  @Column({ type: 'varchar', default: UserRole.USER })
  role: UserRole;

  @Column({ default: false })
  isBanned: boolean;

  @Column({ default: false })
  emailVerified: boolean;

  @Column({ nullable: true })
  lastLoginIP: string;

  @Column({ nullable: true })
  lastLoginAt: Date;

  @OneToMany(() => File, (file) => file.uploader)
  files: File[];

  @OneToMany(() => Folder, (folder) => folder.owner)
  folders: Folder[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  /** 密码或安全凭证最后变更时间，用于 JWT token 吊销检测 */
  @Column({ type: 'timestamptz', nullable: true })
  passwordUpdatedAt: Date | null;

  /**
   * 软删除时间戳。用户删除采用软删除（保留行），
   * 避免 files.uploaderId 外键（无 ON DELETE 策略）导致硬删除恒失败；
   * TypeORM 会在常规查询中自动排除已软删除的用户。
   */
  @DeleteDateColumn({ type: 'timestamp', nullable: true })
  deletedAt: Date | null;
}
