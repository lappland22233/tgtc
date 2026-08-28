import { databaseColumnType } from '../../database/database-types';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('verification_codes')
@Index('IDX_verification_codes_email_type_isUsed_expiresAt', ['email', 'type', 'isUsed', 'expiresAt'])
export class VerificationCode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  email: string;

  @Column({ length: 64, comment: 'SHA256 hashed verification code' })
  code: string;

  @Column()
  type: string;

  @Column({ default: false })
  isUsed: boolean;

  @Column({ type: databaseColumnType('timestamp') as 'timestamp' })
  expiresAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
