import { databaseColumnType } from '../../database/database-types';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('access_logs')
@Index(['createdAt'])
@Index(['path'])
@Index(['statusCode'])
// 组合查询（时间范围 + IP / 时间范围 + 状态码）的复合索引，优于独立单列索引（P2）
@Index('IDX_access_logs_createdAt_ip', ['createdAt', 'ip'])
@Index('IDX_access_logs_createdAt_statusCode', ['createdAt', 'statusCode'])
export class AccessLog {
  @PrimaryGeneratedColumn('uuid')
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
   * PostgreSQL bigint，TypeScript number。单响应体最大 4GiB（Bot 直链分卷下载）
   * 远小于 MAX_SAFE_INTEGER。
   * 注意：跨行 SUM 聚合可能超过 2^53，必须在 SQL 侧以 ::bigint 计算并以字符串返回
   * （统计查询已如此处理），不要在前端/JS 侧直接累加 number。
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
  @Column({ nullable: true, type: databaseColumnType('uuid'), comment: '关联用户 ID（已登录请求）' })
  userId: string | null;

  /**
   * Bot 直链下载标识（D8/C-2）：匿名直链请求会把 Bot 身份挂到 req，
   * 由中间件在 res 结束时写入，用于统计 Bot 使用情况。非 Bot 请求为 null。
   */
  @Index('IDX_access_logs_botGrantId')
  @Column({ nullable: true, type: databaseColumnType('uuid'), comment: 'Bot 直链 grant ID' })
  botGrantId: string | null;

  /** Bot 直链下载者 TG 用户 ID（字符串存储，非 Bot 请求为 null） */
  @Column({ nullable: true, type: 'varchar', length: 32, comment: 'Bot 下载者 TG 用户 ID' })
  botTelegramUserId: string | null;

  /**
   * 传输结果字段（仅下载类请求写入，其他请求为 null）。
   *
   * 历史缺陷：Bot 直链在 pipeline 真正开始前就写入访问计数与成功审计，
   * 于是客户端中断、上游失败都仍被统计为「一次下载」，且多段 Range 会被
   * 重复计为完整下载。这四个字段把「请求数 / 分段数 / 完整完成数 / 中断数」
   * 拆开，使续传（206）与中断可以在管理后台被直接核验。
   */
  @Column({ nullable: true, type: 'boolean', comment: '下载传输是否完整写完响应' })
  transferCompleted: boolean | null;

  /** 传输是否被中断（客户端断开 / 上游失败 / 超时 / 服务关闭） */
  @Column({ nullable: true, type: 'boolean', comment: '下载传输是否被中断' })
  transferAborted: boolean | null;

  /** 是否为 Range 分段响应（206） */
  @Column({ nullable: true, type: 'boolean', comment: '是否 Range 分段响应' })
  ranged: boolean | null;

  /** 传输结束原因：completed / client_abort / upstream_error / timeout / server_shutdown */
  @Column({ nullable: true, type: 'varchar', length: 24, comment: '传输结束原因' })
  terminationReason: string | null;

  /**
   * 实际写入客户端的正文字节。
   * 完整响应取 Content-Length（精确）；中断响应由 socket 字节差扣除响应头估算。
   * PostgreSQL 侧为 bigint，读取时是字符串，聚合必须走 SQL。
   */
  @Column({ nullable: true, type: 'bigint', comment: '实际响应体字节（bigint 字符串）' })
  responseBodyBytes: string | null;

  @CreateDateColumn({ comment: '请求时间' })
  createdAt: Date;
}
