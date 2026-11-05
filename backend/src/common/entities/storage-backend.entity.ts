import { databaseColumnType } from '../../database/database-types';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** 存储后端类型：telegram 为历史默认后端（不入本表，由既有账号池体系管理） */
export type StorageBackendType = 'telegram' | 's3' | 'webdav' | 'gdrive';

/** 本表管理的远端存储后端（Telegram 由 telegram_accounts 体系管理，不在此登记） */
export type RemoteStorageBackendType = Exclude<StorageBackendType, 'telegram'>;

/**
 * 存储账号生命周期状态（与 TG 账号池同一状态机语义）：
 * - `active`：允许参与新任务
 * - `disabled`：管理员主动停用
 * - `degraded`：可用但连续失败/凭据异常，默认不选为新任务源
 * - `revoked`：凭据失效或已撤销，不参与任务（文件仍引用该账号，回源返回可诊断失败）
 * - `draining`：不接新任务，仅等待在途任务结束
 */
export type StorageAccountStatus =
  | 'active'
  | 'disabled'
  | 'degraded'
  | 'revoked'
  | 'draining';

/** S3 兼容端点配置（MinIO / Cloudflare R2 / 阿里 OSS / AWS S3） */
export interface S3BackendConfig {
  /** 自定义端点（缺省走 AWS 官方域名） */
  endpoint?: string;
  region: string;
  bucket: string;
  /** MinIO 等自建端点通常需要 path-style 寻址 */
  forcePathStyle?: boolean;
  /** bucket 内根前缀（对象隔离命名空间） */
  prefix?: string;
}

/** WebDAV 端点配置（Nextcloud / Alist / 坚果云等） */
export interface WebDavBackendConfig {
  /** WebDAV 根 URL（含路径前缀，如 https://host/remote.php/dav/files/user/） */
  url: string;
  /** 根 URL 下的存储子目录（缺省直接落在根 URL） */
  rootPath?: string;
}

/** Google Drive 账号配置（凭据为 OAuth refresh_token，单独加密存放） */
export interface GDriveBackendConfig {
  /** 应用根文件夹 ID（首次上传时自动创建 TGTC/ 并回填） */
  rootFolderId?: string;
  /** 授权账号邮箱（脱敏展示用） */
  email?: string;
}

export type StorageBackendConfigPayload = S3BackendConfig | WebDavBackendConfig | GDriveBackendConfig;

/**
 * 存储后端账号主数据（每行 = 一个存储账号/端点）。
 *
 * 为什么需要这张表：存储不再限于 Telegram——S3 一套密钥、WebDAV 一个端点、
 * GDrive 一个 Google 账号都是一行「存储账号」，由通用调度器按
 * 「带宽 × 健康度 × 容量 × 权重（× 剩余配额）」选号，实现账号池扩容。
 *
 * 安全约束（与 telegram_accounts 同口径）：
 * - **只存密文**：`credentialCiphertext` 为 AES-256-GCM 密文（独立根密钥
 *   `STORAGE_ENCRYPTION_KEY`），永不对外序列化；接口、审计、日志一律不得出现
 *   明文密钥 / refresh_token；
 * - `(type, name)` 唯一：同一后端类型下不允许重名账号；
 * - 撤销（revoked）只清凭据停任务，不删行——存量文件仍引用该账号，
 *   回源侧按 fail-closed 返回可诊断失败，绝不跨账号猜测。
 */
@Entity('storage_backends')
@Index('uq_storage_backends_type_name', ['type', 'name'], { unique: true })
@Index('idx_storage_backends_status', ['status'])
@Index('idx_storage_backends_enabled', ['enabled'])
export class StorageBackend {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16, comment: '后端类型：s3|webdav|gdrive' })
  type: RemoteStorageBackendType;

  @Column({ type: 'varchar', length: 64, comment: '管理员可读名称' })
  name: string;

  @Column({ type: 'varchar', length: 16, default: 'active', comment: '生命周期状态' })
  status: StorageAccountStatus;

  @Column({ type: 'boolean', default: false, comment: '是否允许参与新任务' })
  enabled: boolean;

  @Column({ type: 'int', default: 1, comment: '调度静态权重' })
  weight: number;

  @Column({ type: 'int', default: 8, comment: '每账号在飞上限' })
  maxInflight: number;

  /** 端点/桶/目录等非敏感配置（敏感凭据一律走 credentialCiphertext） */
  @Column({ type: databaseColumnType('jsonb') as 'jsonb', nullable: true, comment: '后端配置（非敏感）' })
  config: StorageBackendConfigPayload | null;

  /** AES-256-GCM 密文；根密钥缺失或加密不可用时为 null（禁止明文落库） */
  @Column({ type: 'text', nullable: true, comment: '加密凭据（AES-256-GCM，永不回显）', select: false })
  credentialCiphertext: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true, comment: '凭据密文版本' })
  credentialVersion: string | null;

  /** 配额上限（字节）；S3/WebDAV 无配额概念时为 null（调度不启用配额因子） */
  @Column({ type: 'bigint', nullable: true, comment: '配额上限（字节），null=无限制' })
  quotaTotalBytes: number | null;

  @Column({ type: 'bigint', nullable: true, comment: '已用配额（字节）' })
  quotaUsedBytes: number | null;

  @Column({ type: databaseColumnType('timestamptz') as 'timestamptz', nullable: true, comment: '最近配额刷新时间' })
  lastQuotaCheckAt: Date | null;

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

  @Column({ type: 'varchar', length: 255, nullable: true, comment: '管理员备注' })
  note: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: '创建人（管理员用户 ID）' })
  createdBy: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, comment: '最近修改人（管理员用户 ID）' })
  updatedBy: string | null;

  @CreateDateColumn({ comment: '创建时间' })
  createdAt: Date;

  @UpdateDateColumn({ comment: '更新时间' })
  updatedAt: Date;
}