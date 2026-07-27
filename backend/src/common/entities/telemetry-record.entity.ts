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
  API_ERROR = 'api_error',
  UPLOAD_ERROR = 'upload_error',
  PERFORMANCE = 'performance',
  ENVIRONMENT = 'environment',
  CLICK_CONTEXT = 'click_context',
}

@Entity('telemetry_records')
@Index(['createdAt'])
// 记录检索以时间倒序为主，并支持类型、IP、用户多维筛选。
@Index('IDX_telemetry_records_type_createdAt', ['type', 'createdAt'])
@Index('IDX_telemetry_records_ip_createdAt', ['ip', 'createdAt'])
@Index('IDX_telemetry_records_userId_createdAt', ['userId', 'createdAt'])
export class TelemetryRecord {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Column({ type: 'varchar', length: 32, comment: '遥测类型：error/api_error/upload_error/performance/environment/click_context' })
  type: string;

  /**
   * 遥测数据，JSON 格式存储：
   * - error: { message, stack, source, lineno, colno, tag }
   * - api_error: { message, url, method, status, duration, errorCode }
   * - upload_error: { message, stage, fileName, fileSize, uploadId, status }
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
