export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

export const FILE_DELETE_GRACE_MS = 7 * MS_PER_DAY;
export const FILE_DELETE_COOLDOWN_MS = 10 * MS_PER_MINUTE;
/** 用户自助强制删除的冷静期：软删除满 1 分钟后才可永久删除（管理员豁免） */
export const FILE_FORCE_DELETE_WAIT_MS = 1 * MS_PER_MINUTE;
export const CHUNK_CLEANUP_DELAY_MS = 5 * MS_PER_MINUTE;
// G3-01：合并/入队中的会话不会被按空闲时间删除，达到该阈值只输出一次「未收敛」告警。
// 阈值必须大于合并超时（MERGE_TIMEOUT_MS=30min），否则慢合并会被误判为滞留。
export const CHUNK_SESSION_MAX_IDLE_MS = 35 * MS_PER_MINUTE;
// pending（init 后尚未开始合并）会话没有长任务，空闲 10 分钟即回收并释放严格模式磁盘租约。
// 合并/入队中会话不使用该阈值，避免把慢合并在写盘中途当作空闲会话清理。
export const CHUNK_SESSION_PENDING_MAX_IDLE_MS = 10 * MS_PER_MINUTE;
