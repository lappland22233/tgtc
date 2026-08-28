import { databaseColumnType, databaseCurrentTimestamp } from '../../database/database-types';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('rate_limits')
@Index('IDX_rate_limits_lockedUntil', ['lockedUntil'])
@Index('IDX_rate_limits_updatedAt', ['updatedAt'])
export class RateLimit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  key: string;

  @Column()
  type: string;

  @Column({ default: 1 })
  attemptCount: number;

  @Column({ type: databaseColumnType('timestamp') as 'timestamp', default: () => databaseCurrentTimestamp() })
  firstAttemptAt: Date;

  @Column({ nullable: true, type: databaseColumnType('timestamp') as 'timestamp' })
  lockedUntil: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
