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
// 未确认告警查询（acknowledgedAt IS NULL）的部分索引：
// IDX_alerts_acknowledged 已由迁移 1785000000000 创建，此处声明使实体与库 schema 一致；
// IDX_alerts_unacknowledged_createdAt 直接服务「未确认 + 按时间倒序」的常见查询。
@Index('IDX_alerts_acknowledged', ['acknowledgedAt'], { where: '"acknowledgedAt" IS NULL' })
@Index('IDX_alerts_unacknowledged_createdAt', ['createdAt'], { where: '"acknowledgedAt" IS NULL' })
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
  context: Record<string, unknown> | null;

  @Column({ nullable: true, type: 'timestamptz' })
  acknowledgedAt: Date | null;

  @Column({ nullable: true, type: 'uuid' })
  acknowledgedBy: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
