import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { databaseColumnType } from '../../database/database-types';

/** API 密钥使用结果 */
export enum ApiKeyUsageResult {
  /** 允许 */
  ALLOWED = 'allowed',
  /** IP 白名单拒绝 */
  DENIED_IP = 'denied_ip',
}

/**
 * API 密钥使用审计（v1.2.6）。
 *
 * - 记录每次经 API Key 认证的调用：时间、方法、路由、结果状态、可信客户端 IP；
 * - 由认证 Guard 之后的拦截器写入（AccessLogMiddleware 发生在 Guard 之前，
 *   无法可靠归因 API Key 身份）；白名单拒绝由认证链路直接写入；
 * - 保留上限 7 天，由定时任务清理，不复用 30 天访问日志留存策略；
 * - 所有者查询时 IP 脱敏（仅首段 + 末段）；明文 IP 仅管理端审计可见。
 */
@Entity('api_key_usage_logs')
@Index('idx_api_key_usage_logs_keyId_createdAt', ['apiKeyId', 'createdAt'])
@Index('idx_api_key_usage_logs_userId_createdAt', ['userId', 'createdAt'])
@Index('idx_api_key_usage_logs_createdAt', ['createdAt'])
export class ApiKeyUsageLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 使用的 API 密钥 */
  @Column({ type: databaseColumnType('uuid') as 'uuid' })
  apiKeyId: string;

  /** 密钥所有者 */
  @Column({ type: databaseColumnType('uuid') as 'uuid' })
  userId: string;

  /** HTTP 方法 */
  @Column({ type: 'varchar', length: 10 })
  method: string;

  /** 请求路由（去 query 的路径） */
  @Column({ type: 'varchar', length: 255 })
  route: string;

  /** 结果：allowed / denied_ip */
  @Column({ type: 'varchar', length: 20, default: ApiKeyUsageResult.ALLOWED })
  result: ApiKeyUsageResult;

  /** 响应状态码；认证链路拒绝时为 401 */
  @Column({ type: 'int', nullable: true })
  statusCode: number | null;

  /** 可信客户端 IP（认证链路写入；存储原文，展示按角色脱敏） */
  @Column({ type: 'varchar', length: 64 })
  ip: string;

  @CreateDateColumn()
  createdAt: Date;
}
