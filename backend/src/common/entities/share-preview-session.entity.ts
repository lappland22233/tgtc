import { databaseColumnType } from '../../database/database-types';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
} from 'typeorm';

/**
 * 服务端分享预览会话（C-03 修复核心）。
 *
 * 用途：把原本进程内 `previewSessions` Map（无访客隔离、非原子、非多实例一致）
 * 外置到 PostgreSQL，用「唯一约束 + 事务」实现首次返回文件字节前的原子扣次，
 * 同会话后续 Range / 连接重建 / 缓存冷热切换幂等免扣。
 *
 * 会话身份 = 分享链接 + 文件 + 高熵访客会话标识的不可逆摘要。
 * 键为 hash（sha256），绝不落库原始 Cookie / JWT 明文。
 *
 * 唯一约束 (shareLinkId, fileId, visitorHash) 保证：
 * - INSERT 成功 = 该访客对「该分享 + 该文件」的首次预览会话创建成功，此时才扣一次 maxAccessCount；
 * - INSERT 冲突 = 同一会话重试（同访客、同窗口内的 Range / 封面 / 重连），幂等免扣。
 */
@Entity('share_preview_sessions')
@Unique('uq_share_preview_sessions_link_file_visitor', ['shareLinkId', 'fileId', 'visitorHash'])
@Index('idx_share_preview_sessions_expires_at', ['expiresAt'])
export class SharePreviewSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 分享链接 ID（share_links.id） */
  @Index()
  @Column({ type: databaseColumnType('uuid') })
  shareLinkId: string;

  /** 文件 ID（files.id） */
  @Column({ type: databaseColumnType('uuid') })
  fileId: string;

  /** 访客会话标识的 sha256 摘要（64 位 hex）。派生自短期 HttpOnly 分享访客凭据，不可逆。 */
  @Column({ type: 'varchar', length: 64 })
  visitorHash: string;

  /**
   * 消费状态：会话创建时即代表该访客已对该分享+文件消费一次额度。
   * 保留字段用于审计与未来扩展（如分阶段计数），当前恒为 true。
   */
  @Column({ default: true })
  consumed: boolean;

  /** 会话创建时间 */
  @CreateDateColumn()
  createdAt: Date;

  /** 会话有效期（与 access JWT 5 分钟对齐）；过期后再次预览视为新会话重新扣次 */
  @Column({ type: databaseColumnType('timestamp') as 'timestamp' })
  expiresAt: Date;
}
