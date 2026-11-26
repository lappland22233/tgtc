/**
 * Google 缓存双写（网页上传 files / Bot 直链 grants）共用的重试策略。
 *
 * 只用常量而不是环境变量：重试节奏属于实现细节，暴露成配置只会扩大运维面。
 */
export const GDRIVE_CACHE_LEASE_MS = 10 * 60 * 1000;
export const GDRIVE_CACHE_BACKOFF_BASE_MS = 5 * 60 * 1000;
export const GDRIVE_CACHE_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
export const GDRIVE_CACHE_BACKLOG_THRESHOLD = 5;

/** 第 n 次失败后的等待时长：5min 起，指数退避，上限 6h */
export function gdriveCacheBackoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts) || 1);
  return Math.min(GDRIVE_CACHE_BACKOFF_MAX_MS, GDRIVE_CACHE_BACKOFF_BASE_MS * 2 ** (n - 1));
}
