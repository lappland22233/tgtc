import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from './user.entity';

/**
 * 分享目标类型：
 * - FILE: 分享单个文件
 * - FOLDER: 分享整个文件夹（含子层级）
 */
export enum ShareTargetType {
  FILE = 'file',
  FOLDER = 'folder',
}

/**
 * 分享链接状态：
 * - ACTIVE: 正常可用
 * - DISABLED: 创建者主动取消
 * - EXPIRED: 已超过有效期
 * - EXHAUSTED: 访问次数已耗尽
 *
 * 状态由 Service 在每次访问时计算并更新，不依赖定时任务。
 */
export enum ShareLinkStatus {
  ACTIVE = 'active',
  DISABLED = 'disabled',
  EXPIRED = 'expired',
  EXHAUSTED = 'exhausted',
}

/**
 * 分享链接实体（独立分享模型）。
 *
 * 设计要点：
 * 1. 同一个文件/文件夹可以有多条 ShareLink（不同密码、不同有效期）。
 * 2. token 是 URL 段，用 crypto.randomBytes(9).toString('base64url')，12 字符熵 ~72 bit。
 * 3. password 字段存 bcrypt hash，null 表示公开分享。
 * 4. expiresIn 是秒数，expiresStartAt 是首次访问时间（首次访问触发计时）。
 * 5. maxAccessCount = -1 表示不限。
 *
 * 严格模式密码保护关键设计：
 * getSharePublicInfo 在 link.password != null && !accessJwt 时直接返回
 *   { requiresPassword: true }，**不查询 target 表**，杜绝元数据泄露。
 */
@Entity('share_links')
export class ShareLink {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  /** URL 段 token，全局唯一，12 字符 base64url */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 32 })
  token: string;

  @Column({ type: 'enum', enum: ShareTargetType })
  targetType: ShareTargetType;

  /** 关联的 file.id 或 folder.id，按 targetType 解释 */
  @Index()
  @Column({ type: 'uuid' })
  targetId: string;

  @Column({ type: 'uuid' })
  creatorId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'creatorId' })
  creator: User;

  /** bcrypt hash；null 表示公开分享 */
  @Column({ nullable: true, type: 'varchar' })
  password: string | null;

  /** 访问上限，-1 表示不限 */
  @Column({ default: -1 })
  maxAccessCount: number;

  /** 已访问次数（仅成功访问+下载计数） */
  @Column({ default: 0 })
  currentAccessCount: number;

  /** 有效期（秒）；null 表示永久有效 */
  @Column({ nullable: true, type: 'int' })
  expiresIn: number | null;

  /** 首次访问时间，expiresStartAt + expiresIn = 过期时间 */
  @Column({ nullable: true, type: 'timestamp' })
  expiresStartAt: Date | null;

  @Column({
    type: 'enum',
    enum: ShareLinkStatus,
    default: ShareLinkStatus.ACTIVE,
  })
  status: ShareLinkStatus;

  /** 软删除（取消分享） */
  @Column({ default: false })
  isDeleted: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
