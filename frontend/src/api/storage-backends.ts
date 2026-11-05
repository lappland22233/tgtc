import api from './client';

/**
 * 可插拔存储后端管理端点（仅 SUPER_ADMIN，JWT Cookie）。
 *
 * 安全约定（与后端 `storage-backends.controller.ts` 对齐）：
 * - 后端所有响应都是**脱敏视图**，不含密钥 / 密码 / refresh_token / client_secret；
 * - 前端只做透传：凭据只在调用处短暂持有，
 *   **禁止写入 Pinia 持久化、localStorage 或控制台日志**。
 */

export type StorageBackendType = 'telegram' | 's3' | 'webdav' | 'gdrive';
export type RemoteStorageBackendType = Exclude<StorageBackendType, 'telegram'>;

export type StorageAccountStatus = 'active' | 'disabled' | 'degraded' | 'revoked' | 'draining';

/** 存储账号脱敏视图（与后端 StorageBackendView 一一对应） */
export interface StorageBackendView {
  id: string;
  type: RemoteStorageBackendType;
  name: string;
  status: StorageAccountStatus;
  enabled: boolean;
  weight: number;
  maxInflight: number;
  config: Record<string, unknown> | null;
  hasCredential: boolean;
  quotaTotalBytes: number | null;
  quotaUsedBytes: number | null;
  lastQuotaCheckAt: string | null;
  lastHealthCheckAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
  lastFailureSummary: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 调度器运行态快照（脱敏，不含凭据） */
export interface StorageSchedulerSnapshot {
  accountId: string;
  type: RemoteStorageBackendType;
  enabled: boolean;
  status: string;
  inflight: number;
  maxInflight: number;
  ewmaBandwidthMbps: number | null;
  ewmaSuccess: number;
  cooldownRemainingMs: number;
  quotaTotalBytes: number | null;
  quotaUsedBytes: number;
}

export interface StorageOverview {
  accounts: StorageBackendView[];
  scheduler: StorageSchedulerSnapshot[];
  driverTypes: RemoteStorageBackendType[];
  credentialAvailable: boolean;
  defaultBackend: StorageBackendType;
  availableBackends: StorageBackendType[];
  gdriveOAuthConfigured: boolean;
}

export interface CreateStorageBackendInput {
  type: RemoteStorageBackendType;
  name: string;
  config: Record<string, unknown>;
  credential: Record<string, unknown>;
  weight?: number;
  maxInflight?: number;
  enabled?: boolean;
  note?: string;
}

export interface UpdateStorageBackendInput {
  name?: string;
  config?: Record<string, unknown>;
  weight?: number;
  maxInflight?: number;
  enabled?: boolean;
  note?: string;
}

/** 总览：账号列表 + 调度快照 + 默认后端 + 凭据加密可用性 */
export async function fetchStorageOverview(signal?: AbortSignal): Promise<StorageOverview> {
  const response = await api.get('/admin/storage-backends/overview', { signal });
  return response.data.data as StorageOverview;
}

/** 账号列表（可按类型筛选） */
export async function fetchStorageBackends(
  type?: RemoteStorageBackendType,
  signal?: AbortSignal,
): Promise<StorageBackendView[]> {
  const response = await api.get('/admin/storage-backends', {
    params: type ? { type } : {},
    signal,
  });
  return response.data.data as StorageBackendView[];
}

/** 默认存储后端热更新（仅影响新上传会话） */
export async function setDefaultStorageBackend(
  backend: StorageBackendType,
): Promise<{ message: string; defaultBackend: StorageBackendType }> {
  const response = await api.put('/admin/storage-backends/default-backend', { backend });
  return response.data.data as { message: string; defaultBackend: StorageBackendType };
}

/** 添加存储账号（创建即连通性测试，失败不落库） */
export async function createStorageBackend(
  input: CreateStorageBackendInput,
): Promise<{ message: string; account: StorageBackendView }> {
  const response = await api.post('/admin/storage-backends', input);
  return response.data.data as { message: string; account: StorageBackendView };
}

/** 更新账号（启停、权重、并发、配置、备注） */
export async function updateStorageBackend(
  id: string,
  input: UpdateStorageBackendInput,
): Promise<{ message: string; account: StorageBackendView }> {
  const response = await api.patch(`/admin/storage-backends/${encodeURIComponent(id)}`, input);
  return response.data.data as { message: string; account: StorageBackendView };
}

/** 撤销账号（清凭据停任务；存量文件引用保留） */
export async function revokeStorageBackend(
  id: string,
): Promise<{ message: string; account: StorageBackendView }> {
  const response = await api.delete(`/admin/storage-backends/${encodeURIComponent(id)}`);
  return response.data.data as { message: string; account: StorageBackendView };
}

/** 连通性测试（GDrive 顺带刷新配额） */
export async function testStorageBackend(
  id: string,
): Promise<{ message: string; view: StorageBackendView; probe: { ok: boolean; latencyMs?: number; error?: string } }> {
  const response = await api.post(`/admin/storage-backends/${encodeURIComponent(id)}/test`);
  return response.data.data as {
    message: string;
    view: StorageBackendView;
    probe: { ok: boolean; latencyMs?: number; error?: string };
  };
}

/** 轮换凭据（先测试后落库；撤销账号凭此重新启用） */
export async function rotateStorageCredential(
  id: string,
  credential: Record<string, unknown>,
): Promise<{ message: string; account: StorageBackendView }> {
  const response = await api.post(`/admin/storage-backends/${encodeURIComponent(id)}/rotate`, { credential });
  return response.data.data as { message: string; account: StorageBackendView };
}

/** 手动刷新配额（GDrive 等有配额概念的后端） */
export async function refreshStorageQuota(
  id: string,
): Promise<{ message: string; quota: { totalBytes: number | null; usedBytes: number } | null }> {
  const response = await api.post(`/admin/storage-backends/${encodeURIComponent(id)}/refresh-quota`);
  return response.data.data as {
    message: string;
    quota: { totalBytes: number | null; usedBytes: number } | null;
  };
}

// ============================================================
// Google Drive OAuth
// ============================================================

/** OAuth Client 配置状态（绝不回显 secret） */
export async function fetchGDriveOAuthClient(): Promise<{ configured: boolean; clientId: string | null }> {
  const response = await api.get('/admin/storage-backends/gdrive/oauth-client');
  return response.data.data as { configured: boolean; clientId: string | null };
}

/** 配置 OAuth Client（secret 加密落库） */
export async function setGDriveOAuthClient(
  clientId: string,
  clientSecret: string,
): Promise<{ message: string }> {
  const response = await api.put('/admin/storage-backends/gdrive/oauth-client', { clientId, clientSecret });
  return response.data.data as { message: string };
}

/** 生成授权 URL（管理员浏览器打开，授权后从回调 URL 复制 code） */
export async function fetchGDriveAuthUrl(redirectUri: string): Promise<{ url: string }> {
  const response = await api.post('/admin/storage-backends/gdrive/auth-url', { redirectUri });
  return response.data.data as { url: string };
}

/** 提交授权码：换取 refresh_token 并创建 GDrive 存储账号 */
export async function completeGDriveAuth(input: {
  code: string;
  redirectUri: string;
  name: string;
  accountId?: string;
}): Promise<{ message: string; account: StorageBackendView }> {
  const response = await api.post('/admin/storage-backends/gdrive/complete-auth', input);
  return response.data.data as { message: string; account: StorageBackendView };
}
