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
   * 用户邮箱。
   * G6-12：唯一性由 UNIQUE(lower(email)) 函数索引保证（见迁移
   * CreateLowerEmailUniqueIndex），使邮箱大小写不敏感唯一。
   * 注意：此处不再声明 `unique: true`（该单列唯一约束已在迁移中 DROP，
   * 避免大小写敏感约束与新函数索引双重限制）；全链路归一化由服务层
   * （auth.service / user.service）统一 trim + lowercase。
   */
  @Column()
  email: string;

  @Column({ length: 255, comment: 'bcrypt hashed password, never store plaintext', select: false })
  password: string;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.USER })
  role: UserRole;

  @Column({ default: false })
  isBanned: boolean;

  @Column({ default: false })
  emailVerified: boolean;

  @Column({ nullable: true })
  lastLoginIP: string;

  @Column({ nullable: true })
  lastLoginAt: Date | null;

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
