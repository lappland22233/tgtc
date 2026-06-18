import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('verification_codes')
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

  @Column({ default: 0 })
  attempts: number;

  @Column()
  expiresAt: Date;

  @CreateDateColumn()
  createdAt: Date;
}
