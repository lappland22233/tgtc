/**
 * A-19：下载调度配置的键、默认值、区间与规范化函数。
 *
 * 此前这些纯常量/纯函数住在 file 域的调度器实现文件里，admin 域为了拿配置键
 * 不得不 import 该内部实现，使实现细节成为跨模块公共 API（层次缠绕 admin→file→mirror→pool）。
 * 移到 common/constants 后，管理端与运行时共用同一份定义而不依赖调度器实现。
 */

/** 下载调度动态配置键（走 SystemConfig；不重命名既有 FILE_CACHE_* 键） */
export const DOWNLOAD_CONFIG_KEYS = {
  /** 全部在途任务未写入预约总上限（GB，0 = 仅受物理空间约束） */
  MAX_RESERVED_GB: 'FILE_DOWNLOAD_MAX_RESERVED_GB',
  /** 上游冷回源的**全局权重预算**（不是连接数，也不是账号池 maxInflight） */
  MAX_CONCURRENT_UPSTREAMS: 'FILE_DOWNLOAD_MAX_CONCURRENT_UPSTREAMS',
  /** 等待队列容量（磁盘与上游共用该上限） */
  QUEUE_CAPACITY: 'FILE_DOWNLOAD_QUEUE_CAPACITY',
  /** 排队等待上限（秒） */
  QUEUE_TIMEOUT_SECONDS: 'FILE_DOWNLOAD_QUEUE_TIMEOUT_SECONDS',
  /** spool 最后一个消费者离开后的复用宽限期（秒） */
  SPOOL_GRACE_SECONDS: 'FILE_DOWNLOAD_SPOOL_GRACE_SECONDS',
  /** 有界滚动缓冲直通的窗口大小（MB） */
  DIRECT_WINDOW_MB: 'FILE_DOWNLOAD_DIRECT_WINDOW_MB',
  /** 直接下载端点（非任务化）允许的有限等待上限（秒） */
  DIRECT_WAIT_SECONDS: 'FILE_DOWNLOAD_DIRECT_WAIT_SECONDS',
  /** 下载任务状态保留时间（秒） */
  TASK_RETENTION_SECONDS: 'FILE_DOWNLOAD_TASK_RETENTION_SECONDS',
  /** 上游等待项选择策略（`strict_fifo` 紧急回退 / `bounded_fit` 适配优先） */
  UPSTREAM_QUEUE_POLICY: 'FILE_DOWNLOAD_UPSTREAM_QUEUE_POLICY',
  /** 全局权重预算自动扩缩容开关（kill switch） */
  AUTO_CAPACITY_ENABLED: 'FILE_DOWNLOAD_AUTO_CAPACITY_ENABLED',
  /**
   * 与缓存卷**同一物理卷**的邻近目录（TDLib workdir）预留余量（GB）。
   *
   * 为什么需要：生产上 `backend/tmp/Cache` 与 `telegram-bot-api/workdir` 同在 `/dev/vda3`。
   * 两套独立写前 `statfs` 会**同时**看到同一份空闲空间并各自放行，于是
   * 「2 个 4GB 冷分卷 + TDLib 新本地媒体副本」叠加后把卷写满——而每一方都以为自己合法。
   * 该值表示「必须留给邻近目录（含 TDLib 媒体副本增长）的空间」，从缓存侧可用空间里扣除，
   * 使两侧的峰值占用之和受一个总水位约束。
   *
   * 默认 0（不扣除）：只有确认同卷部署且 0 会掩盖问题时才应显式配置。
   */
  VOLUME_PEER_RESERVE_GB: 'FILE_DOWNLOAD_VOLUME_PEER_RESERVE_GB',
  /**
   * 下载是否优先使用 Premium 用户账号（MTProto）回源。
   *
   * 临时能力（30 天回退窗口）：置 `false` 即回到纯 Bot 链路，无需改代码/重启。
   * 布尔键，因此**不加入** `DOWNLOAD_CONFIG_RANGES`（那是数值区间表）。
   */
  PREFER_USER_ACCOUNT: 'DOWNLOAD_PREFER_USER_ACCOUNT',
  /** 单 user 账号同时开出的 MTProto 回源流上限（每账号独立计数） */
  USER_STREAM_MAX_CONCURRENCY: 'FILE_DOWNLOAD_USER_STREAM_MAX_CONCURRENCY',
  /**
   * user 账号**瞬时失败**（network / other）的冷却时长（秒）。
   *
   * 只影响可重试的瞬时错误：flood 仍按 `retry_after`、auth 30 分钟、
   * permission / not_found 10 分钟，均不读该值。
   */
  USER_FAILURE_COOLDOWN_SECONDS: 'FILE_DOWNLOAD_USER_FAILURE_COOLDOWN_SECONDS',
} as const;

export const DOWNLOAD_CONFIG_DEFAULTS: Record<string, string> = {
  [DOWNLOAD_CONFIG_KEYS.MAX_RESERVED_GB]: '0',
  [DOWNLOAD_CONFIG_KEYS.MAX_CONCURRENT_UPSTREAMS]: '8',
  [DOWNLOAD_CONFIG_KEYS.QUEUE_CAPACITY]: '128',
  [DOWNLOAD_CONFIG_KEYS.QUEUE_TIMEOUT_SECONDS]: '1800',
  [DOWNLOAD_CONFIG_KEYS.SPOOL_GRACE_SECONDS]: '120',
  /** 默认 1 MiB：直通内存量由窗口大小决定，而非文件总大小 */
  [DOWNLOAD_CONFIG_KEYS.DIRECT_WINDOW_MB]: '1',
  [DOWNLOAD_CONFIG_KEYS.DIRECT_WAIT_SECONDS]: '60',
  [DOWNLOAD_CONFIG_KEYS.TASK_RETENTION_SECONDS]: '900',
  [DOWNLOAD_CONFIG_KEYS.UPSTREAM_QUEUE_POLICY]: 'strict_fifo',
  [DOWNLOAD_CONFIG_KEYS.AUTO_CAPACITY_ENABLED]: 'true',
  [DOWNLOAD_CONFIG_KEYS.VOLUME_PEER_RESERVE_GB]: '0',
  [DOWNLOAD_CONFIG_KEYS.PREFER_USER_ACCOUNT]: 'false',
  /**
   * 默认 4：MTProto 单 session 并发过高会被限流，但 2 会在仅有一个 user 账号时
   * 让第 3 个并发下载直接回退 Bot（账号容量被闲置）。4 是两者的折中，可按账号
   * 实际 Premium 配额上调。
   */
  [DOWNLOAD_CONFIG_KEYS.USER_STREAM_MAX_CONCURRENCY]: '4',
  [DOWNLOAD_CONFIG_KEYS.USER_FAILURE_COOLDOWN_SECONDS]: '10',
};

/**
 * 下载调度配置的取值区间。
 *
 * 管理端 DTO 校验、管理端 GET 展示与运行时规范化**共用同一份区间**，
 * 避免「管理端接受范围与运行时接受范围不一致」（历史缺陷：管理端限 1-64，
 * 运行时无上限；直通窗口管理端限 1024MB，运行时无上限）。
 */
export const DOWNLOAD_CONFIG_RANGES: Record<string, { min: number; max: number }> = {
  [DOWNLOAD_CONFIG_KEYS.MAX_RESERVED_GB]: { min: 0, max: 10_000 },
  [DOWNLOAD_CONFIG_KEYS.MAX_CONCURRENT_UPSTREAMS]: { min: 1, max: 128 },
  [DOWNLOAD_CONFIG_KEYS.QUEUE_CAPACITY]: { min: 1, max: 10_000 },
  [DOWNLOAD_CONFIG_KEYS.QUEUE_TIMEOUT_SECONDS]: { min: 5, max: 86_400 },
  [DOWNLOAD_CONFIG_KEYS.SPOOL_GRACE_SECONDS]: { min: 0, max: 3_600 },
  /** 上限先设 4 MiB：单请求异常配置不得重新制造大块外部内存 */
  [DOWNLOAD_CONFIG_KEYS.DIRECT_WINDOW_MB]: { min: 1, max: 4 },
  [DOWNLOAD_CONFIG_KEYS.DIRECT_WAIT_SECONDS]: { min: 0, max: 600 },
  [DOWNLOAD_CONFIG_KEYS.TASK_RETENTION_SECONDS]: { min: 60, max: 86_400 },
  [DOWNLOAD_CONFIG_KEYS.VOLUME_PEER_RESERVE_GB]: { min: 0, max: 10_000 },
  [DOWNLOAD_CONFIG_KEYS.USER_STREAM_MAX_CONCURRENCY]: { min: 1, max: 32 },
  [DOWNLOAD_CONFIG_KEYS.USER_FAILURE_COOLDOWN_SECONDS]: { min: 1, max: 600 },
};

/** 上游等待项选择策略取值 */
export const UPSTREAM_QUEUE_POLICIES = ['strict_fifo', 'bounded_fit'] as const;
export type UpstreamQueuePolicy = (typeof UPSTREAM_QUEUE_POLICIES)[number];

/**
 * 统一规范化下载调度数值配置（管理 GET、管理校验与运行时加载共用）：
 * 1. `null` / `undefined` / 空串视为「未配置」并回退仓库默认值
 *    （历史缺陷：`Number('') === 0` 让「未配置」被展示成 0，而运行时按默认值 8 运行）；
 * 2. 非数值同样回退默认值；
 * 3. 越界值裁剪进 `DOWNLOAD_CONFIG_RANGES`。
 */
export function normalizeDownloadConfigNumber(
  key: string,
  raw: string | number | null | undefined,
): number {
  const fallback = Number(DOWNLOAD_CONFIG_DEFAULTS[key]);
  const safeFallback = Number.isFinite(fallback) ? fallback : 0;
  if (raw === null || raw === undefined) return safeFallback;
  const text = typeof raw === 'string' ? raw.trim() : raw;
  if (text === '') return safeFallback;
  const parsed = typeof text === 'number' ? text : Number(text);
  if (!Number.isFinite(parsed)) return safeFallback;
  const range = DOWNLOAD_CONFIG_RANGES[key];
  if (!range) return parsed;
  return Math.min(range.max, Math.max(range.min, parsed));
}

/** 规范化上游队列策略（缺失或非法值回退仓库默认值，当前为 strict_fifo） */
export function normalizeUpstreamQueuePolicy(raw: string | null | undefined): UpstreamQueuePolicy {
  const fallback = DOWNLOAD_CONFIG_DEFAULTS[DOWNLOAD_CONFIG_KEYS.UPSTREAM_QUEUE_POLICY] as UpstreamQueuePolicy;
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return (UPSTREAM_QUEUE_POLICIES as readonly string[]).includes(value)
    ? (value as UpstreamQueuePolicy)
    : fallback;
}

/** 规范化布尔开关配置（缺失或非法值回退指定默认值） */
export function normalizeBooleanFlag(raw: string | null | undefined, fallback: boolean): boolean {
  if (raw === null || raw === undefined) return fallback;
  const value = String(raw).trim().toLowerCase();
  if (value === '') return fallback;
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') return true;
  if (value === 'false' || value === '0' || value === 'no' || value === 'off') return false;
  return fallback;
}

/** 结构化业务错误码（供 HTTP 层与前端映射文案） */
