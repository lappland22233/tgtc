import {
  TelegramAccount,
  TelegramAccountCapabilities,
  TelegramAccountStatus,
  TelegramAccountType,
} from '../common/entities/telegram-account.entity';
import { AccountPoolAccountSnapshot } from '../telegram-account-pool/telegram-account-pool.types';

/**
 * 账号池运行态视图（进程内画像的脱敏投影）。
 * 只含计数、带宽、健康与冷却信息，**不含任何凭据**。
 */
export interface TelegramAccountRuntimeView {
  inflight: number;
  maxInflight: number;
  bandwidthMbps: number;
  successRate: number;
  latencyMs: number;
  coolingDown: boolean;
  cooldownRemainingMs: number;
  consecutiveFailures: number;
  totalRequests: number;
  failures: number;
  lastErrorKind: string | null;
  /** 是否配置了存储 Chat（false 时该账号只参与下载回源，不会被选为上传/镜像目标） */
  storageConfigured: boolean;
}

/**
 * 环境变量账号只读视图。
 *
 * 用途：后台「Telegram 账号池」必须能看到 `.env` 配置的主 Bot（来源、健康、负载、是否参与调度），
 * 否则管理员无法判断「账号池是否真的生效」。该视图**永不含**完整 Token：
 * 只给出 `tokenPreview`（token 前缀 + 少量掩码）与 chatId。
 * `readOnly` 恒为 true：密钥轮换只能改 `.env`，后台不提供编辑/删除/轮换。
 */
export interface TelegramEnvAccountView {
  id: string;
  primary: boolean;
  source: 'env';
  readOnly: true;
  tokenPreview: string;
  chatId: string | null;
  enabled: boolean;
  weight: number;
  maxInflight: number;
  note: string | null;
  runtime: TelegramAccountRuntimeView;
}

/** 账号池快照条目 → 运行态视图 */
export function toRuntimeView(snapshot: AccountPoolAccountSnapshot): TelegramAccountRuntimeView {
  return {
    inflight: snapshot.inflight,
    maxInflight: snapshot.maxInflight,
    bandwidthMbps: snapshot.bandwidthMbps,
    successRate: snapshot.successRate,
    latencyMs: snapshot.latencyMs,
    coolingDown: snapshot.coolingDown,
    cooldownRemainingMs: snapshot.cooldownRemainingMs,
    consecutiveFailures: snapshot.consecutiveFailures,
    totalRequests: snapshot.totalRequests,
    failures: snapshot.failures,
    lastErrorKind: snapshot.lastErrorKind ?? null,
    storageConfigured: snapshot.storageConfigured,
  };
}

/** 账号池快照条目 → 环境变量账号只读视图 */
export function toEnvAccountView(snapshot: AccountPoolAccountSnapshot): TelegramEnvAccountView {
  return {
    id: snapshot.id,
    primary: snapshot.primary,
    source: 'env',
    readOnly: true,
    tokenPreview: snapshot.tokenPreview,
    chatId: snapshot.chatId || null,
    enabled: snapshot.enabled,
    weight: snapshot.weight,
    maxInflight: snapshot.maxInflight,
    note: snapshot.note ?? null,
    runtime: toRuntimeView(snapshot),
  };
}

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
  /** 配置来源：panel=仅数据库账号；both=数据库账号与环境变量账号同属一个 Bot（合并展示，避免重复操作） */
  source?: 'panel' | 'both';
  /** 账号池运行态（bot 账号已在池内注册时有值；用户账号为 null） */
  runtime?: TelegramAccountRuntimeView | null;
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
  options: {
    credentialConfigured?: boolean;
    runtime?: TelegramAccountRuntimeView | null;
    source?: 'panel' | 'both';
  } = {},
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
    source: options.source ?? 'panel',
    runtime: options.runtime ?? null,
  };
}
