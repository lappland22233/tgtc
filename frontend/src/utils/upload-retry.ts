/**
 * 上传错误分类与条目级自动重试基座。
 *
 * 重试语义（保守原则：拿不准就不重试，宁可用户手动重传也不产生重复文件）：
 * - transient（可重试）：axios 无 response 的传输层失败（ERR_NETWORK / ECONNABORTED / ETIMEDOUT，
 *   或 message 含 Network Error / timeout）、CDN 代理层非 JSON 错误转成的裸 Error
 *   （文案含“上传超时（CDN 代理层”/“源站暂时不可用”/“CDN 代理层错误”）、HTTP 429。
 * - 不重试：带 response 的 5xx（服务器内部错误）、全部业务 4xx（400/401/403/404/413）、
 *   CDN 413 文案“文件过大（超过代理层 100MB 限制）”、后端 job 业务失败
 *   （'上传处理超时' / '合并失败' / '服务暂时不可用，合并仍在后台进行' 及 job.error 裸 Error——
 *   重试会产生重复文件）、用户取消、未知裸 Error。
 */

/** 单个队列条目最大自动重试次数 */
export const MAX_ENTRY_RETRIES = 2;

/** 条目级重试基础退避 (ms)，实际延迟 = base × 2^(attempt-1) + 0-1000ms 抖动 */
export const ENTRY_RETRY_BASE_DELAY = 3000;

export type UploadErrorKind = 'cancelled' | 'server' | 'business' | 'transient' | 'unknown';

export interface UploadErrorClassification {
  retryable: boolean;
  kind: UploadErrorKind;
}

/** 后端 job / 合并阶段的业务失败文案（裸 Error，重试会产生重复文件，必须排除） */
const JOB_BUSINESS_MESSAGES = [
  '上传处理超时',
  '合并失败',
  '服务暂时不可用，合并仍在后台进行',
];

/**
 * 将任意错误分类为是否可自动重试。纯函数，无副作用。
 *
 * 判定顺序：取消 → 带 response 的 HTTP 错误 → CDN 代理层裸 Error →
 * job 业务裸 Error → 传输层 code/message → 未知（保守不重试）。
 */
export function classifyUploadError(error: unknown): UploadErrorClassification {
  const err = (error ?? {}) as {
    name?: string;
    code?: string;
    message?: string;
    response?: { status?: number };
  };
  const message = typeof err.message === 'string' ? err.message : '';
  const status = err.response?.status;

  // 1. 用户取消（AbortError / ERR_CANCELED / message 含“上传已取消”）
  if (
    err.name === 'AbortError' ||
    err.name === 'CanceledError' ||
    err.code === 'ERR_CANCELED' ||
    message.includes('上传已取消')
  ) {
    return { retryable: false, kind: 'cancelled' };
  }

  // 2. 带 response 的 HTTP 错误：429 限流可重试；5xx 服务器内部错误不重试
  //    （后端已受理请求，重试可能产生重复文件）；其余 4xx 均为业务错误不重试。
  if (typeof status === 'number') {
    if (status === 429) return { retryable: true, kind: 'transient' };
    if (status >= 500) return { retryable: false, kind: 'server' };
    return { retryable: false, kind: 'business' };
  }

  // 3. 无 response 的裸 Error
  // 3a. CDN 413 代理层限制：确定性失败，不重试
  if (message.includes('文件过大（超过代理层 100MB 限制）')) {
    return { retryable: false, kind: 'business' };
  }
  // 3b. CDN 代理层瞬时错误（api/client.ts 拦截器将非 JSON 错误页转成裸 Error）：可重试
  if (
    message.includes('上传超时（CDN 代理层') ||
    message.includes('源站暂时不可用') ||
    message.includes('CDN 代理层错误')
  ) {
    return { retryable: true, kind: 'transient' };
  }
  // 3c. 后端 job 业务失败（files.ts uploadFileAsync / 合并轮询抛出的裸 Error）：不重试
  if (JOB_BUSINESS_MESSAGES.some((m) => message.includes(m))) {
    return { retryable: false, kind: 'business' };
  }
  // 3d. axios 传输层失败（无 response）：可重试
  if (
    err.code === 'ERR_NETWORK' ||
    err.code === 'ECONNABORTED' ||
    err.code === 'ETIMEDOUT' ||
    message.includes('Network Error') ||
    message.includes('timeout')
  ) {
    return { retryable: true, kind: 'transient' };
  }

  // 4. 未知裸 Error：保守不重试
  return { retryable: false, kind: 'unknown' };
}

/**
 * 计算第 attempt 次重试（从 1 开始）前的退避时长：
 * 3000ms × 2^(attempt-1) + 0-1000ms 随机抖动（避免雷群效应）。
 */
export function getRetryDelay(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return ENTRY_RETRY_BASE_DELAY * Math.pow(2, exponent) + Math.floor(Math.random() * 1000);
}

/**
 * 可中断的退避等待：到时 resolve；signal abort 时立即 reject 并清理定时器/监听器。
 * 实现模式与 stores/files.ts 中 uploadFileAsync 的 abortableSleep 保持一致。
 */
export function abortableBackoff(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('上传已取消'));
      return;
    }
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { cleanup(); reject(new Error('上传已取消')); };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
