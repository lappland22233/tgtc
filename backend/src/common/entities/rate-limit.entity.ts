import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('rate_limits')
export class RateLimit {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Column({ unique: true })
  key: string;

  @Column()
  type: string;

  @Column({ default: 1 })
  attemptCount: number;

  @Column({ type: 'timestamp', default: () => 'NOW()' })
  firstAttemptAt: Date;

  @Column({ nullable: true, type: 'timestamp' })
  lockedUntil: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
