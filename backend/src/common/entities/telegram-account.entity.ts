import { databaseColumnType } from '../../database/database-types';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** 账号类型：bot=Bot Token 认证；user=MTProto 用户账号 */
export type TelegramAccountType = 'bot' | 'user';

/**
 * 账号生命周期状态：
 * - `pending_auth`：用户账号等待完成登录授权（Bot 账号不会停留在该状态）
 * - `active`：允许参与新任务
 * - `disabled`：管理员主动停用
 * - `degraded`：可用但连续失败/能力缺失，默认不选为新任务源
 * - `revoked`：凭据失效或已删除，不参与任务
 * - `draining`：不接新任务，仅等待在途任务结束
 */
export type TelegramAccountStatus =
  | 'pending_auth'
  | 'active'
  | 'disabled'
  | 'degraded'
  | 'revoked'
  | 'draining';

/** 经测试确认的能力快照（只保存布尔结论，不保存凭据） */
export interface TelegramAccountCapabilities {
  canUpload?: boolean;
  canReadSource?: boolean;
  canWriteMirror?: boolean;
  supportsPolling?: boolean;
}

/**
 * Telegram 账号主数据（Bot 与用户账号统一建模）。
 *
 * 为什么需要这张表：账号池当前只能从环境变量解析账号，管理员无法在后台查看、
 * 添加、停用或轮换账号，也无法记录健康与能力状态。环境变量从此只保留
 * 「首次默认值 + 紧急强制关闭」语义，日常运营以本表为事实来源。
 *
 * 安全约束：
 * - **只存密文**：`credentialCiphertext` 为 AES-256-GCM 密文，永不对外序列化；
 *   接口、审计、日志、异常与前端状态中一律不得出现明文 Token/session/验证码；
 * - `externalId` 允许为空（用户账号授权完成前未知），返回时脱敏；
 * - `(type, externalId)` 唯一：同一 Bot / 同一 Telegram 用户不允许重复登记。
 */
@Entity('telegram_accounts')
@Index('uq_tg_accounts_type_external', ['type', 'externalId'], { unique: true })
@Index('idx_tg_accounts_status', ['status'])
@Index('idx_tg_accounts_enabled', ['enabled'])
export class TelegramAccount {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 8, comment: '账号类型：bot|user' })
  type: TelegramAccountType;

  @Column({ type: 'varchar', length: 64, comment: '管理员可读名称' })
  name: string;

  /** Bot ID 或 Telegram 用户 ID；用户账号授权完成前为空。对外只返回脱敏摘要 */
  @Column({ type: 'varchar', length: 64, nullable: true, comment: '外部标识（Bot ID / TG 用户 ID），脱敏返回' })
  externalId: string | null;

  @Column({ type: 'varchar', length: 16, default: 'pending_auth', comment: '生命周期状态' })
  status: TelegramAccountStatus;

  /** 是否允许参与新任务；关闭只阻止新任务，不中断在途流量 */
  @Column({ type: 'boolean', default: false, comment: '是否允许参与新任务' })
  enabled: boolean;

  @Column({ type: 'int', default: 1, comment: '调度静态权重' })
  weight: number;

  @Column({ type: 'int', default: 8, comment: '每账号在飞上限' })
  maxInflight: number;

  /** Bot 主存储 Chat；用户账号为可选源 Chat 权限配置 */
  @Column({ type: 'varchar', length: 32, nullable: true, comment: '主存储 Chat / 可选源 Chat' })
  primaryChatId: string | null;

  /** AES-256-GCM 密文；根密钥缺失或加密不可用时为 null（禁止明文落库） */
  @Column({ type: 'text', nullable: true, comment: '加密凭据（AES-256-GCM，永不回显）', select: false })
  credentialCiphertext: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true, comment: '凭据密文版本' })
  credentialVersion: string | null;

  @Column({ type: databaseColumnType('jsonb') as 'jsonb', nullable: true, comment: '能力快照（测试结论）' })
  capabilities: TelegramAccountCapabilities | null;

  @Column({ type: databaseColumnType('timestamptz') as 'timestamptz', nullable: true, comment: '最近健康检查时间' })
  lastHealthCheckAt: Date | null;

  @Column({ type: databaseColumnType('timestamptz') as 'timestamptz', nullable: true, comment: '最近成功时间' })
  lastSuccessAt: Date | null;

  @Column({ type: databaseColumnType('timestamptz') as 'timestamptz', nullable: true, comment: '最近失败时间' })
  lastFailureAt: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: '最近失败分类（脱敏）' })
  lastFailureCode: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true, comment: '最近失败摘要（脱敏）' })
  lastFailureSummary: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, comment: '管理员备注（脱敏）' })
  note: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: '创建人（管理员用户 ID）' })
  createdBy: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: '最近修改人（管理员用户 ID）' })
  updatedBy: string | null;

  @Column({ type: databaseColumnType('timestamptz') as 'timestamptz', nullable: true, comment: '停用时间' })
  disabledAt: Date | null;

  @CreateDateColumn({ comment: '创建时间' })
  createdAt: Date;

  @UpdateDateColumn({ comment: '更新时间' })
  updatedAt: Date;
}
