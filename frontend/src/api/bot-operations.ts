import api from './client';

const base = '/admin/bot-operations';

export type QueueStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type GrantStatus = 'active' | 'expired' | 'revoked';
export type BotListKind = 'queue' | 'grants' | 'audit';

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

async function get<T>(path: string, signal?: AbortSignal, params?: ListParams): Promise<T> {
  const response = await api.get(base + path, { signal, params });
  return response.data.data;
}

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
