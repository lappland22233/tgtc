import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { File } from './file.entity';

export enum UserRole {
  USER = 'user',
  ADMIN = 'admin',
  SUPER_ADMIN = 'super_admin',
}

@Entity('users')
export class User {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Column({ unique: true })
  email: string;

  @Column({ length: 255, comment: 'bcrypt hashed password, never store plaintext' })
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
  lastLoginAt: Date;

  @OneToMany(() => File, (file) => file.uploader)
  files: File[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
