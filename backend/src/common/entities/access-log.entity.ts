import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('access_logs')
@Index(['createdAt'])
@Index(['path'])
@Index(['statusCode'])
export class AccessLog {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Index()
  @Column({ comment: '客户端 IP 地址' })
  ip: string;

  @Column({ type: 'varchar', length: 10, comment: 'HTTP 方法' })
  method: string;

  @Column({ type: 'varchar', length: 500, comment: '请求路径' })
  path: string;

  @Column({ type: 'int', comment: 'HTTP 状态码' })
  statusCode: number;

  /**
   * 响应体大小（字节），用于带宽统计。
   * PostgreSQL bigint，TypeScript number。单请求最大 600MB 远小于 MAX_SAFE_INTEGER。
   */
  @Column({ type: 'bigint', default: 0, comment: '响应体大小（字节），用于带宽统计' })
  responseSize: number;

  @Column({ type: 'int', default: 0, comment: '请求耗时（毫秒）' })
  duration: number;

  @Column({ nullable: true, type: 'varchar', length: 500, comment: 'User-Agent' })
  userAgent: string | null;

  @Column({ nullable: true, type: 'varchar', length: 300, comment: 'Referer' })
  referer: string | null;

  @Index()
  @Column({ nullable: true, type: 'uuid', comment: '关联用户 ID（已登录请求）' })
  userId: string | null;

  @CreateDateColumn({ comment: '请求时间' })
  createdAt: Date;
}
