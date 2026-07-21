import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/** 遥测数据类型 */
export enum TelemetryType {
  ERROR = 'error',
  PERFORMANCE = 'performance',
  ENVIRONMENT = 'environment',
}

@Entity('telemetry_records')
@Index(['createdAt'])
// 核心查询为 type + createdAt 组合条件，复合索引优于两个单列索引（P2）；
// ip 索引服务 COUNT(DISTINCT ip) 统计（P3）。
@Index('IDX_telemetry_records_type_createdAt', ['type', 'createdAt'])
@Index('IDX_telemetry_records_ip', ['ip'])
export class TelemetryRecord {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Column({ type: 'varchar', length: 20, comment: '遥测类型：error/performance/environment' })
  type: string;

  /**
   * 遥测数据，JSON 格式存储：
   * - error: { message, stack, source, lineno, colno, tag }
   * - performance: { pageLoad, domReady, firstPaint, url }
   * - environment: { screen, viewport, platform, language, timezone }
   */
  @Column({ type: 'jsonb', comment: '遥测数据载荷' })
  data: Record<string, any>;

  @Column({ comment: '客户端 IP 地址' })
  ip: string;

  @Index()
  @Column({ nullable: true, type: 'uuid', comment: '关联用户 ID（已登录时）' })
  userId: string | null;

  @Column({ nullable: true, type: 'varchar', length: 500, comment: 'User-Agent' })
  userAgent: string | null;

  /** 客户端时间戳（毫秒），用于保持事件时间线准确性 */
  @Column({ type: 'bigint', nullable: true, comment: '客户端时间戳（ms）' })
  clientTimestamp: number | null;

  @CreateDateColumn({ comment: '记录创建时间' })
  createdAt: Date;
}
