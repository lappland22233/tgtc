import { StorageAccountError, StorageFailureKind } from './storage.types';

/** HTTP 状态码 → 失败分类（各驱动共用口径，冷却基数见调度器） */
export function classifyHttpStatus(status: number): StorageFailureKind {
  if (status === 429) return 'flood';
  if (status === 401 || status === 403) return 'auth';
  if (status === 507) return 'quota';
  if (status === 423) return 'unavailable';
  if (status >= 500) return 'unavailable';
  return 'other';
}

/** 从响应头提取 Retry-After（秒）；非法值返回 undefined */
export function retryAfterSecondsOf(headers: Record<string, unknown> | undefined): number | undefined {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (raw === undefined || raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(3600, seconds);
  return undefined;
}

/** axios 风格错误 → 统一 StorageAccountError（脱敏：只保留状态码与分类，不回显凭据） */
export function toStorageAccountError(error: unknown, fallbackMessage: string): StorageAccountError {
  if (error instanceof StorageAccountError) return error;
  const candidate = error as {
    response?: { status?: number; headers?: Record<string, unknown> };
    status?: number;
    statusCode?: number;
    code?: string;
    name?: string;
    message?: string;
  } | null;
  const status = candidate?.response?.status ?? candidate?.status ?? candidate?.statusCode;
  if (typeof status === 'number') {
    return new StorageAccountError(
      `${fallbackMessage}（HTTP ${status}）`,
      classifyHttpStatus(status),
      status,
      retryAfterSecondsOf(candidate?.response?.headers),
    );
  }
  const code = candidate?.code ?? candidate?.name ?? '';
  if (/abort/i.test(code) || /abort/i.test(candidate?.message ?? '')) {
    return new StorageAccountError(fallbackMessage, 'other');
  }
  if (/timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(code)) {
    return new StorageAccountError(fallbackMessage, 'timeout');
  }
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|network/i.test(code)) {
    return new StorageAccountError(fallbackMessage, 'network');
  }
  return new StorageAccountError(
    `${fallbackMessage}：${(candidate?.message || String(error)).slice(0, 200)}`,
    'other',
  );
}