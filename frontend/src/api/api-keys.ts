import api from './client';

/**
 * API 密钥管理接口封装。
 *
 * - 明文密钥（key）仅创建/轮换响应中出现一次，之后只能凭前缀识别；
 * - 列表仅返回元信息，不含任何密钥摘要。
 */
export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreatedApiKey {
  id: string;
  name: string;
  prefix: string;
  /** 明文密钥，仅本次可见 */
  key: string;
  createdAt: string;
}

export async function listApiKeys(): Promise<ApiKeySummary[]> {
  const res = await api.get('/api-keys');
  return res.data?.data?.keys ?? [];
}

export async function createApiKey(name?: string): Promise<CreatedApiKey> {
  const res = await api.post('/api-keys', { name: name || undefined });
  return res.data?.data;
}

export async function revokeApiKey(id: string): Promise<void> {
  await api.delete(`/api-keys/${id}`);
}

export async function rotateApiKey(id: string, name?: string): Promise<CreatedApiKey> {
  const res = await api.post(`/api-keys/${id}/rotate`, { name: name || undefined });
  return res.data?.data;
}
