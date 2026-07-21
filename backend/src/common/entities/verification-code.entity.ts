import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('verification_codes')
@Index('IDX_verification_codes_email_type_isUsed_expiresAt', ['email', 'type', 'isUsed', 'expiresAt'])
export class VerificationCode {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Column()
  email: string;

  @Column({ length: 64, comment: 'SHA256 hashed verification code' })
  code: string;

  @Column()
  type: string;

  @Column({ default: false })
  isUsed: boolean;

  @Column()
  expiresAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
