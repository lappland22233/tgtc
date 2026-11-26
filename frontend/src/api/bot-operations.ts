import api from './client';

const base = '/admin/bot-operations';

export type QueueStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type GrantStatus = 'active' | 'expired' | 'revoked';
export type BotListKind = 'queue' | 'grants' | 'audit';
export type OverviewRange = '24h' | '7d' | '30d';
export type UserGroupScope = 'queue' | 'grants' | 'audit';

export interface UserGroupRow {
  telegramUserId: string;
  telegramUsername: string | null;
  total: number;
  byStatus: Record<string, number>;
  bytes: string;
  downloads: number;
  lastAt: string | null;
}

export interface UserGroupPage {
  scope: UserGroupScope;
  page: number;
  pageSize: number;
  total: number;
  rows: UserGroupRow[];
}

export interface UserGroupParams {
  scope: UserGroupScope;
  page: number;
  pageSize: number;
  keyword?: string;
  from?: string;
  to?: string;
  receiverBotId?: string;
}

export interface OverviewTrendRow {
  bucket: string;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
}

export interface BotOperationsOverview {
  timeRange: OverviewRange;
  generatedAt: string;
  queue: {
    total: number;
    byStatus: Record<QueueStatus, number>;
    pending: number;
    running: number;
    bytes: string;
    successRate: number | null;
  };
  grants: {
    total: number;
    byStatus: Record<GrantStatus, number>;
    activeNow: number;
    downloads: number;
  };
  trend: OverviewTrendRow[];
  topBots: { receiverBotId: string; total: number; failed: number; bytes: string }[];
}

interface ReceivedFile {
  id: string;
  receiverBotId: string | null;
  telegramUserId: string;
  telegramUsername: string | null;
  telegramDisplayName: string | null;
  fileName: string | null;
  fileSize: string | null;
  createdAt: string;
}

export interface QueueRow extends ReceivedFile {
  status: QueueStatus;
  position: number | null;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  grantId: string | null;
  failureReason: string | null;
}

export interface GrantRow extends ReceivedFile {
  status: GrantStatus;
  sourceAccountId: string | null;
  storageBackend: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  accessCount: number;
  tokenPrefix: string;
  /** Google 双写状态（none | pending | ready | failed） */
  gdriveCacheStatus?: 'none' | 'pending' | 'ready' | 'failed' | null;
  /** Google 双写已尝试次数 */
  gdriveCacheAttempts?: number | null;
  /** Google 双写最近失败原因 */
  gdriveCacheLastError?: string | null;
}

export interface AuditRow {
  id: string;
  action: string;
  userId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  status: string;
}

export interface BotUserOverview {
  telegramUserId: string;
  ban: { telegramUserId: string; reason: string; bannedBy: string | null; bannedAt: string } | null;
  quota: { used: number; limit: number | null; remaining: number | null; usageDate: string; whitelisted: boolean };
  downloads: { requests: number; bytes: string };
  uploads: { total: number; byStatus: Record<QueueStatus, number> };
  grants: { total: number; active: number };
}

export interface ListParams {
  page: number;
  pageSize: number;
  receiverBotId?: string;
  telegramUserId?: string;
  from?: string;
  to?: string;
  status?: QueueStatus | GrantStatus | 'all';
}

interface Page<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

async function get<T>(path: string, signal?: AbortSignal, params?: ListParams | UserGroupParams | Record<string, unknown>): Promise<T> {
  const response = await api.get(base + path, { signal, params });
  return response.data.data;
}

export const getOverview = (timeRange: OverviewRange, signal: AbortSignal) =>
  get<BotOperationsOverview>('/overview', signal, { timeRange });
export const listUserGroups = (params: UserGroupParams, signal: AbortSignal) =>
  get<UserGroupPage>('/user-groups', signal, params);
export const listQueue = (params: ListParams, signal: AbortSignal) => get<Page<QueueRow>>('/queue', signal, params);
export const listGrants = (params: ListParams, signal: AbortSignal) => get<Page<GrantRow>>('/grants', signal, params);
const userPath = (id: string) => '/users/' + encodeURIComponent(id);
export const getBotUser = (id: string, signal: AbortSignal) => get<BotUserOverview>(userPath(id), signal);
export const listUserAudit = (id: string, params: ListParams, signal: AbortSignal) => get<Page<AuditRow>>(userPath(id) + '/audit', signal, params);
export const getGrantLink = (id: string, signal: AbortSignal) => get<{ url: string | null }>('/grants/' + encodeURIComponent(id) + '/link', signal);

export async function cancelTask(id: string): Promise<{ changed: boolean }> {
  return (await api.post(base + '/queue/' + encodeURIComponent(id) + '/cancel')).data.data;
}
export async function revokeGrant(id: string): Promise<{ changed: boolean }> {
  return (await api.post(base + '/grants/' + encodeURIComponent(id) + '/revoke')).data.data;
}
export async function banBotUser(id: string, reason: string): Promise<{ cancelledTasks: number; revokedGrants: number }> {
  return (await api.post(base + userPath(id) + '/ban', { reason })).data.data;
}
