import api from './client';

/**
 * API 密钥管理接口封装。
 *
 * - 明文密钥（key）在创建/轮换响应中出现一次；v1.2.6 起新密钥加密保存，
 *   所有者可随时通过 reveal 重新查看；
 * - 列表仅返回元信息，不含任何密钥摘要/密文；
 * - IP 白名单按每把密钥独立配置，空数组 = 不限制来源；
 * - 使用记录中的 IP 已由服务端脱敏（仅保留首段与末段）。
 */
export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** 是否支持所有者重显明文（v1.2.6 起创建的密钥为 true） */
  revealable: boolean;
}

export interface CreatedApiKey {
  id: string;
  name: string;
  prefix: string;
  /** 明文密钥 */
  key: string;
  createdAt: string;
}

export interface ApiKeyUsageItem {
  id: string;
  method: string;
  route: string;
  result: 'allowed' | 'denied_ip';
  statusCode: number | null;
  /** 脱敏 IP：IPv4 192.*.*.2；IPv6 保留首末 hextet */
  maskedIp: string;
  createdAt: string;
}

export interface ApiKeyUsagePage {
  items: ApiKeyUsageItem[];
  total: number;
  page: number;
  limit: number;
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

/** 所有者重显完整明文（仅登录会话；历史不可回显密钥会报错） */
export async function revealApiKey(id: string): Promise<{ key: string }> {
  const res = await api.get(`/api-keys/${id}/reveal`);
  return res.data?.data;
}

export async function getApiKeyAllowlist(id: string): Promise<string[]> {
  const res = await api.get(`/api-keys/${id}/allowlist`);
  return res.data?.data?.rules ?? [];
}

export async function setApiKeyAllowlist(id: string, rules: string[]): Promise<string[]> {
  const res = await api.put(`/api-keys/${id}/allowlist`, { rules });
  return res.data?.data?.rules ?? [];
}

export async function listApiKeyUsage(
  id: string,
  page = 1,
  limit = 10,
): Promise<ApiKeyUsagePage> {
  const res = await api.get(`/api-keys/${id}/usage-logs`, { params: { page, limit } });
  return res.data?.data;
}
