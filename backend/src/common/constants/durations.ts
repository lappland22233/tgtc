export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

export const FILE_DELETE_GRACE_MS = 7 * MS_PER_DAY;
export const FILE_DELETE_COOLDOWN_MS = 10 * MS_PER_MINUTE;
export const CHUNK_CLEANUP_DELAY_MS = 5 * MS_PER_MINUTE;
// G3-01：会话空闲上限必须大于合并超时（MERGE_TIMEOUT_MS=30min），
// 否则慢合并期间会话会被按 lastActivityAt 清理中断。35min > 30min。
export const CHUNK_SESSION_MAX_IDLE_MS = 35 * MS_PER_MINUTE;
