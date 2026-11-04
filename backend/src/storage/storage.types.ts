import { ServiceUnavailableException } from '@nestjs/common';
import { Readable } from 'stream';
import type {
  GDriveBackendConfig,
  RemoteStorageBackendType,
  S3BackendConfig,
  StorageBackendType,
  WebDavBackendConfig,
} from '../common/entities/storage-backend.entity';

export type { StorageBackendType, RemoteStorageBackendType };

/**
 * 存储账号失败分类（冷却基数与 TG 账号池同口径，另增 auth/quota 两类）：
 * - `flood`：上游限流（429 / rateLimitExceeded）
 * - `quota`：配额耗尽（GDrive storageQuotaExceeded / WebDAV 507）
 * - `auth`：凭据失效（401/403 权限类、invalid_grant）——通常不可自愈，账号转 degraded/revoked
 * - `unavailable`：上游 5xx / 资源锁定（WebDAV 423）
 * - `timeout` / `network` / `other`：传输层失败
 */
export type StorageFailureKind =
  | 'flood'
  | 'quota'
  | 'auth'
  | 'unavailable'
  | 'timeout'
  | 'network'
  | 'other';

/** 驱动层统一错误：携带失败分类供调度器冷却与换号决策 */
export class StorageAccountError extends Error {
  constructor(
    message: string,
    readonly kind: StorageFailureKind,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'StorageAccountError';
  }
}

/** 上传选号全部候选暂不可用（可重试 503；admissionOnly=尚未发出任何远端请求） */
export class StorageUploadUnavailableError extends ServiceUnavailableException {
  constructor(readonly admissionOnly: boolean = false, readonly retryAfterMs: number = 5000) {
    super('存储账号当前繁忙或不可用，请稍后重试');
  }
}

/** 回源不可用（账号撤销/凭据失效/限流）：fail-closed，绝不跨账号猜测 */
export class StorageDownloadUnavailableError extends ServiceUnavailableException {
  constructor(readonly reason: string, message: string = '文件暂不可用：存储账号当前不可用，请稍后重试或联系管理员') {
    super(message);
  }
}

/** 解密后的账号执行上下文（只在进程内传递，绝不序列化到接口/日志） */
export interface StorageAccountContext {
  accountId: string;
  type: RemoteStorageBackendType;
  config: S3BackendConfig | WebDavBackendConfig | GDriveBackendConfig;
  /** 解密凭据载荷：s3={accessKeyId,secretAccessKey}；webdav={username,password}；gdrive={refreshToken} */
  credential: Record<string, unknown>;
}

export interface StorageUploadParams {
  /** 展示名（已 sanitize）；驱动负责生成全局唯一对象键，覆盖上传绝不冲突 */
  objectName: string;
  /** 每次尝试必须新开流（流只能消费一次），与 TG 池化上传同一契约 */
  openStream: () => Readable;
  knownLength: number;
  mimeType?: string;
  signal?: AbortSignal;
}

export interface StorageUploadResult {
  /** 不透明对象引用：S3 key / WebDAV 路径 / GDrive fileId */
  objectRef: string;
  size: number;
}

export interface StorageDownloadParams {
  objectRef: string;
  /** 闭区间字节范围（end 缺省表示到对象末尾）；驱动原生透传 */
  range?: { start: number; end?: number };
  signal?: AbortSignal;
}

export interface StorageDownloadResult {
  stream: Readable;
  /** 对象总大小（不是本次范围长度），与 TG 回源 info.file_size 口径一致 */
  size: number;
}

export interface StorageQuota {
  /** null = 无配额概念（S3/WebDAV），调度不启用配额因子 */
  totalBytes: number | null;
  usedBytes: number;
}

export interface StorageProbeResult {
  ok: boolean;
  latencyMs?: number;
  /** 脱敏错误摘要（绝不包含凭据） */
  error?: string;
}

/**
 * 存储后端驱动接口（S3 / WebDAV / GDrive 各一实现）。
 *
 * Telegram 不实现本接口：TG 链路（账号池选号、镜像扩散、副本表、严格磁盘租约）
 * 原样保留在 file/telegram 模块内，由 FileService 按 `file.storageBackend` 分发，
 * 避免 storage → file → storage 的循环依赖，也保证 TG 行为逐字节不变。
 *
 * 驱动只做「单账号上的对象操作」，不发选号决策：选号/冷却/换号由
 * StorageAccountSchedulerService + StorageRouterService 承担。
 */
export interface StorageBackendDriver {
  readonly type: RemoteStorageBackendType;
  upload(ctx: StorageAccountContext, params: StorageUploadParams): Promise<StorageUploadResult>;
  openDownloadStream(ctx: StorageAccountContext, params: StorageDownloadParams): Promise<StorageDownloadResult>;
  headObject(ctx: StorageAccountContext, objectRef: string): Promise<{ exists: boolean; size?: number }>;
  /** best-effort 删除；对象不存在视为成功（幂等） */
  deleteObject(ctx: StorageAccountContext, objectRef: string): Promise<void>;
  probeAccount(ctx: StorageAccountContext): Promise<StorageProbeResult>;
  getQuota?(ctx: StorageAccountContext): Promise<StorageQuota>;
}

/** 统一上传回执（FileService / FileUploadProcessor 共用形状） */
export interface StorageUploadReceipt {
  backendType: StorageBackendType;
  /** 实际上传账号（storage_backends.id）；TG 链路为 null（归属走 telegramSourceAccountId） */
  accountId: string | null;
  objectRef: string;
  size: number;
}

/** 对象键 sanitize：去除路径分隔与控制字符（各驱动在此基础上追加唯一前缀） */
export function sanitizeObjectName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001F\u007F]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  return (cleaned || 'file').slice(0, 180);
}

/** 判断文件是否落在非 TG 存储后端（存量数据缺省视为 telegram） */
export function isRemoteStorageBackend(value: string | null | undefined): value is RemoteStorageBackendType {
  return value === 's3' || value === 'webdav' || value === 'gdrive';
}