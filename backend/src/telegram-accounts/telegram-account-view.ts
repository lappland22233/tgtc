import {
  TelegramAccount,
  TelegramAccountCapabilities,
  TelegramAccountStatus,
  TelegramAccountType,
} from '../common/entities/telegram-account.entity';

/**
 * 账号脱敏视图（**唯一允许对外序列化的形状**）。
 *
 * 安全约束：明文 Token / session / API Hash / 2FA 密码 / 手机号完整值一律不出现；
 * `externalId` 只返回脱敏摘要（如 `***7890`），凭据只返回「是否已配置」与密文版本。
 */
export interface TelegramAccountView {
  id: string;
  type: TelegramAccountType;
  name: string;
  externalId: string | null;
  status: TelegramAccountStatus;
  enabled: boolean;
  weight: number;
  maxInflight: number;
  /** Bot 主存储 Chat / 用户账号可选源 Chat（Chat ID 非凭据，可展示） */
  primaryChatId: string | null;
  capabilities: TelegramAccountCapabilities | null;
  credentialConfigured: boolean;
  credentialVersion: string | null;
  lastHealthCheckAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
  lastFailureSummary: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 标识脱敏：只保留末 4 位（Bot ID / TG 用户 ID 均按此处理） */
export function maskIdentifier(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (trimmed.length <= 4) return '***';
  return `***${trimmed.slice(-4)}`;
}

/** 手机号脱敏：保留国家码与末 2 位，中间打码 */
export function maskPhoneNumber(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const digits = String(value).replace(/[^\d+]/g, '');
  if (digits.length <= 4) return '***';
  return `${digits.slice(0, 2)}***${digits.slice(-2)}`;
}

export function toIso(value: Date | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

/**
 * 实体 → 脱敏视图。
 * `credentialConfigured` 由调用方给出：实体的凭据列是 `select: false`，
 * 只有显式选择的查询才知道它是否存在（视图本身**永不**读取其内容）。
 */
export function toAccountView(
  account: TelegramAccount,
  options: { credentialConfigured?: boolean } = {},
): TelegramAccountView {
  return {
    id: account.id,
    type: account.type,
    name: account.name,
    externalId: maskIdentifier(account.externalId),
    status: account.status,
    enabled: Boolean(account.enabled),
    weight: Number(account.weight),
    maxInflight: Number(account.maxInflight),
    primaryChatId: account.primaryChatId ?? null,
    capabilities: account.capabilities ?? null,
    credentialConfigured: options.credentialConfigured ?? false,
    credentialVersion: account.credentialVersion ?? null,
    lastHealthCheckAt: toIso(account.lastHealthCheckAt),
    lastSuccessAt: toIso(account.lastSuccessAt),
    lastFailureAt: toIso(account.lastFailureAt),
    lastFailureCode: account.lastFailureCode ?? null,
    lastFailureSummary: account.lastFailureSummary ?? null,
    note: account.note ?? null,
    createdAt: toIso(account.createdAt) ?? '',
    updatedAt: toIso(account.updatedAt) ?? '',
  };
}
