import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum AlertLevel {
  INFO = 'info',
  WARNING = 'warning',
  CRITICAL = 'critical',
}

@Entity('alerts')
@Index(['ruleId', 'createdAt'])
export class Alert {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Column({ type: 'varchar', length: 100 })
  ruleId: string;

  @Column({ type: 'varchar', length: 20, default: AlertLevel.INFO })
  level: AlertLevel;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  message: string | null;

  @Column({ type: 'jsonb', nullable: true })
  context: Record<string, any> | null;

  @Column({ nullable: true, type: 'timestamptz' })
  acknowledgedAt: Date | null;

  @Column({ nullable: true, type: 'uuid' })
  acknowledgedBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
