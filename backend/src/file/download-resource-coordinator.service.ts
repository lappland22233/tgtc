import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

/**
 * 下载资源协调器（DI 单例）
 *
 * 职责（统一调度下载相关的三类稀缺资源）：
 * 1. 物理磁盘预约：以「尚未写入的峰值增量」记账，避免并发任务复用同一份空闲空间；
 * 2. 缓存逻辑容量预约：正式缓存构建在建期间按整文件占位，防止并发构建突破缓存上限；
 * 3. 上游并发租约：Telegram 冷回源名额，严格 FIFO，替代轮询抢占。
 *
 * 核心不变量：
 * - 准入 = 物理空闲 − 最低安全余量 − 其他任务未写入预约 ≥ 本次新增；
 * - 每成功写入 chunk 调用 `consume()`，已落盘部分由 statfs 反映，不再重复扣减；
 * - 已授予的租约不会被新任务或配置热更新撤销（只影响后续准入判断）；
 * - 同一任务的所有终止分支（成功/失败/取消/超时/关闭）都必须 `release()`，释放幂等。
 *
 * 设计边界：
 * - 管理的是后端缓存卷（`tmp/Cache`）；Telegram Bot API/TDLib workdir 是独立磁盘域，
 *   同卷部署时仍可能互相抢占，需分卷或分别配置最低余量；
 * - 单后端进程内的协调，与仓库「拒绝多实例部署」的约束一致。
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
  [DOWNLOAD_CONFIG_KEYS.MAX_CONCURRENT_UPSTREAMS]: { min: 1, max: 64 },
  [DOWNLOAD_CONFIG_KEYS.QUEUE_CAPACITY]: { min: 1, max: 10_000 },
  [DOWNLOAD_CONFIG_KEYS.QUEUE_TIMEOUT_SECONDS]: { min: 5, max: 86_400 },
  [DOWNLOAD_CONFIG_KEYS.SPOOL_GRACE_SECONDS]: { min: 0, max: 3_600 },
  /** 上限先设 4 MiB：单请求异常配置不得重新制造大块外部内存 */
  [DOWNLOAD_CONFIG_KEYS.DIRECT_WINDOW_MB]: { min: 1, max: 4 },
  [DOWNLOAD_CONFIG_KEYS.DIRECT_WAIT_SECONDS]: { min: 0, max: 600 },
  [DOWNLOAD_CONFIG_KEYS.TASK_RETENTION_SECONDS]: { min: 60, max: 86_400 },
  [DOWNLOAD_CONFIG_KEYS.VOLUME_PEER_RESERVE_GB]: { min: 0, max: 10_000 },
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
export const DOWNLOAD_ERROR_CODES = {
  /** 等待队列已满 */
  QUEUE_FULL: 'DOWNLOAD_QUEUE_FULL',
  /** 排队等待超时 */
  QUEUE_TIMEOUT: 'DOWNLOAD_QUEUE_TIMEOUT',
  /** 排队期间被取消（用户取消 / 请求断开） */
  QUEUE_CANCELLED: 'DOWNLOAD_QUEUE_CANCELLED',
  /** 上游并发或服务器综合负载过高 */
  SERVER_BUSY: 'DOWNLOAD_SERVER_BUSY',
  /** Telegram file_id 来源账号未知或不再可用；禁止跨账号猜测 */
  SOURCE_ACCOUNT_UNAVAILABLE: 'DOWNLOAD_SOURCE_ACCOUNT_UNAVAILABLE',
  /** 来源账号已知，但当前账号池回源容量暂满 */
  ACCOUNT_POOL_BUSY: 'DOWNLOAD_ACCOUNT_POOL_BUSY',
  /** 磁盘空间探测失败 */
  STORAGE_PROBE_UNAVAILABLE: 'DOWNLOAD_STORAGE_PROBE_UNAVAILABLE',
  /** 结构上无法满足（完整暂存不可行 / 单文件超过缓存上限），调用方应降级直通 */
  INSUFFICIENT_STORAGE: 'DOWNLOAD_INSUFFICIENT_STORAGE',
  /** 服务正在关闭 */
  SHUTTING_DOWN: 'DOWNLOAD_SHUTTING_DOWN',
} as const;

export type DownloadErrorCode = (typeof DOWNLOAD_ERROR_CODES)[keyof typeof DOWNLOAD_ERROR_CODES];

/** 排队原因：磁盘、上游回源、服务器负载（含缓存逻辑容量饱和） */
export type DownloadQueueReason = 'disk' | 'upstream' | 'server_load';

/** 受限资源类别（决定调用方的降级策略） */
export type DownloadResourceScope = 'disk' | 'cache' | 'upstream' | 'global' | 'system';

/** 客户端已断开（Nginx 约定 499；Nest HttpStatus 未内置，此处显式声明） */
export const HTTP_STATUS_CLIENT_CLOSED_REQUEST = 499;

export interface DownloadResourceErrorInit {
  status: number;
  errorCode: DownloadErrorCode;
  message: string;
  scope: DownloadResourceScope;
  retryAfterMs?: number;
  queueReason?: DownloadQueueReason;
  queuePosition?: number;
}

/**
 * 下载资源拒绝异常：以 HttpException 形式抛出，body 中保留 errorCode / retryAfterMs，
 * 由全局异常过滤器与流式响应统一透传（并写 Retry-After / X-Tgtc-Error-Code）。
 */
export class DownloadResourceException extends HttpException {
  readonly errorCode: DownloadErrorCode;
  readonly scope: DownloadResourceScope;
  readonly retryAfterMs?: number;
  readonly queueReason?: DownloadQueueReason;
  readonly queuePosition?: number;

  constructor(init: DownloadResourceErrorInit) {
    super(
      {
        statusCode: init.status,
        // 业务码：全局过滤器与前端错误映射读取该字段（保持与上传磁盘预算一致的结构）
        code: init.errorCode,
        errorCode: init.errorCode,
        message: init.message,
        scope: init.scope,
        ...(init.retryAfterMs !== undefined ? { retryAfterMs: init.retryAfterMs } : {}),
        ...(init.queueReason !== undefined ? { queueReason: init.queueReason } : {}),
        ...(init.queuePosition !== undefined ? { queuePosition: init.queuePosition } : {}),
      },
      init.status,
    );
    this.errorCode = init.errorCode;
    this.scope = init.scope;
    this.retryAfterMs = init.retryAfterMs;
    this.queueReason = init.queueReason;
    this.queuePosition = init.queuePosition;
  }
}

/** 资源协调器的运行时配置（由 FileCacheService 加载并下发） */
export interface DownloadResourceConfig {
  /** 缓存卷最低安全余量（字节） */
  minFreeBytes: number;
  /** 全部在途任务未写入预约总上限（字节，<=0 表示不限制） */
  maxReservedBytes: number;
  /** 等待队列容量 */
  queueCapacity: number;
  /** 排队等待上限（毫秒） */
  queueTimeoutMs: number;
  /** 上游冷回源并发上限 */
  maxConcurrentUpstreams: number;
  /** spool 复用宽限期（毫秒） */
  spoolGraceMs: number;
  /** 有界滚动缓冲直通窗口（字节） */
  directWindowBytes: number;
  /** 直接下载端点有限等待上限（毫秒） */
  directWaitMs: number;
  /** 下载任务状态保留时间（毫秒） */
  taskRetentionMs: number;
  /** 上游等待项选择策略（默认 strict_fifo，保持既有行为） */
  upstreamQueuePolicy: UpstreamQueuePolicy;
  /**
   * 与缓存卷同一物理卷的邻近目录（TDLib workdir）预留量（字节，0 表示不扣除）。
   *
   * 生效位置：`probeFreeBytes()` 的**有效可用空间**判定。用于防止两套独立
   * 写前探测同时放行、叠加写满同一块盘（生产事故场景：Cache 与 workdir 同卷）。
   */
  volumePeerReserveBytes: number;
}

export const DOWNLOAD_RESOURCE_DEFAULTS = {
  /** 队列满/服务器繁忙时的建议重试间隔（毫秒） */
  RETRY_AFTER_MS: 5_000,
  /** 探测失败时的建议重试间隔（毫秒） */
  PROBE_RETRY_AFTER_MS: 15_000,
  /** 队列兜底复查间隔（毫秒，事件驱动之外的有界退避，不做忙轮询） */
  POLL_INTERVAL_MS: 30_000,
  /** LRU 淘汰请求的最小间隔（毫秒，避免队头阻塞时反复全目录扫描） */
  EVICTION_THROTTLE_MS: 1_000,
  /** 任务票据交接后的预约保留上限（毫秒）：超时未被子请求采用则归还，避免预约泄漏 */
  HANDOFF_TTL_MS: 120_000,
} as const;

/** 上游等待项被授予的原因（诊断：解释「为什么它是被放行的那个」） */
export type UpstreamGrantReason = 'head' | 'head_after_wait' | 'fit_skip';

/**
 * `bounded_fit` 公平策略参数（首版为代码常量，避免第一版引入过多运维配置）。
 *
 * 目标不是让小文件无条件插队，而是在队首大文件无法适配当前剩余预算时，
 * 利用已经空闲的权重；同时保证大文件不会被连续小任务饿死。
 */
export const UPSTREAM_FIT_POLICY_DEFAULTS = {
  /** 队列仍按入队顺序保存，绕过时只扫描队首之后的前 N 个等待项（不做全队列扫描） */
  SCAN_WINDOW: 8,
  /** 单个队首任务最多被绕过的次数 */
  MAX_HEAD_BYPASS: 8,
  /** 队首公平等待阈值（毫秒）：超过后进入「队首保留」状态 */
  HEAD_FAIR_WAIT_MS: 10_000,
} as const;

/** 大文件阈值（字节）：超过即按大文件权重占用并发预算 */
const LARGE_FILE_THRESHOLD_BYTES = 1024 ** 3;
/** 中等文件阈值（字节） */
const MEDIUM_FILE_THRESHOLD_BYTES = 256 * 1024 ** 2;
/** 大文件权重（等于默认预算 8 → 默认一次只跑 1 个） */
const LARGE_FILE_WEIGHT = 8;
/** 中等文件权重 */
const MEDIUM_FILE_WEIGHT = 2;
/** 小文件权重 */
const SMALL_FILE_WEIGHT = 1;

/**
 * 上游并发权重：大文件按体量占用更多「并发预算」，避免 3×4GiB 冷分卷同秒全部回源。
 *
 * `FILE_DOWNLOAD_MAX_CONCURRENT_UPSTREAMS` 在本实现中是**权重预算**（默认 8）：
 * - `>1GiB`：权重 8 → 默认预算下同时只允许 1 个大文件冷回源（把预算提到 16 即可跑 2 个）；
 * - `256MiB–1GiB`：权重 2 → 最多 4 个；
 * - `<256MiB`：权重 1 → 最多 budget 个。
 *
 * 权重超过预算时被裁剪到预算（否则会产生永远无法满足的等待项）。
 * 等待项选择策略由 `FILE_DOWNLOAD_UPSTREAM_QUEUE_POLICY` 决定：
 * - `strict_fifo`：严格 FIFO，大任务不会被持续到达的小任务插队饿死（队头阻塞时小任务也要等）；
 * - `bounded_fit`：队首暂时放不下时，只在前 N 个等待项内适配放行，并按绕过次数与公平等待
 *   阈值进入「队首保留」，兼顾小文件时延与大文件公平性（见 `UPSTREAM_FIT_POLICY_DEFAULTS`）。
 */
export function upstreamWeightForSize(bytes: number, budget: number): number {
  const total = Math.max(1, Math.floor(budget) || 1);
  if (!Number.isFinite(bytes) || bytes <= 0) return Math.min(SMALL_FILE_WEIGHT, total);
  if (bytes > LARGE_FILE_THRESHOLD_BYTES) return Math.min(LARGE_FILE_WEIGHT, total);
  if (bytes > MEDIUM_FILE_THRESHOLD_BYTES) return Math.min(MEDIUM_FILE_WEIGHT, total);
  return Math.min(SMALL_FILE_WEIGHT, total);
}

/** 磁盘/缓存预约句柄 */
export interface DownloadReservation {
  readonly id: string;
  readonly sessionKey: string;
  /** 授予的总量（缓存逻辑容量按此值占位，不随写入递减） */
  readonly grantedBytes: number;
  /** 尚未写入的剩余量（物理磁盘按此值记账） */
  readonly remainingBytes: number;
  readonly countsTowardCache: boolean;
  readonly active: boolean;
  /** 每成功写入一段数据后调用，核销对应预约 */
  consume(bytes: number): void;
  /** 释放剩余预约并唤醒等待队列（幂等） */
  release(): void;
}

/** 上游并发槽位租约 */
export interface DownloadUpstreamLease {
  readonly id: string;
  readonly active: boolean;
  /** 该租约占用的并发权重（大文件 >1），释放时等额归还预算 */
  readonly weight: number;
  /** 释放槽位并唤醒等待队列（幂等） */
  release(): void;
}

export interface ReserveOptions {
  /** 会话键（建议 fileId + 内容版本），同键并发只应有一个 leader */
  sessionKey: string;
  /** 预测的峰值新增磁盘占用（字节） */
  bytes: number;
  /** 是否同时占用正式缓存逻辑容量（仅正式缓存构建为 true） */
  countsTowardCache?: boolean;
  /** 覆盖默认排队等待上限（毫秒） */
  waitTimeoutMs?: number;
  /** 取消信号：用户取消 / HTTP 请求关闭 */
  signal?: AbortSignal;
  /** 进入队列时回调（供任务服务上报排队原因与近似位置） */
  onQueued?: (info: { reason: DownloadQueueReason; position: number; retryAfterMs: number }) => void;
}

export interface AcquireUpstreamOptions {
  waitTimeoutMs?: number;
  signal?: AbortSignal;
  onQueued?: (info: { reason: DownloadQueueReason; position: number; retryAfterMs: number }) => void;
  /** 预计文件大小（字节）：用于计算并发权重；未提供时按权重 1 处理 */
  bytes?: number;
  /** 显式权重覆盖（测试/诊断用）；优先级高于 bytes */
  weight?: number;
}

/**
 * 磁盘等待时长直方图分桶上界（毫秒，左闭右开，最后一桶为「≥ 末位」）。
 *
 * 为什么需要直方图而不是只有 `oldestDiskWaitMs`：后者是**瞬时值**，
 * 只在采样那一刻有意义——一次持续 40 秒的磁盘等待，如果恰好在它结束时采样，
 * 看到的 `oldestDiskWaitMs` 是 0，问题被完全隐藏。P3 的验收口径是
 * 「磁盘等待 P95 < 30s」，必须有每次等待的分布才能算。
 */
export const DISK_WAIT_HISTOGRAM_BUCKETS_MS = [1_000, 5_000, 10_000, 30_000, 60_000, 180_000] as const;

/** 每次磁盘等待的**终止原因**（用于区分「等到了」与「等超时/被取消/队满」） */
export type DiskWaitOutcome =
  /** 等到空间并授予预约 */
  | 'granted'
  /** 等待超时（503 DOWNLOAD_QUEUE_TIMEOUT / DOWNLOAD_SERVER_BUSY） */
  | 'timeout'
  /** 客户端/任务取消（499，不计入容量问题） */
  | 'cancelled'
  /** 队列已满，未进入等待（429 DOWNLOAD_QUEUE_FULL） */
  | 'queue_full'
  /** 结构性不足，直接降级直通（不等待） */
  | 'direct_degrade'
  /** 服务关闭 */
  | 'shutdown';

/** 磁盘等待统计（累计值，进程内自启动） */
export interface DiskWaitStats {
  /** 各分桶的样本数（长度 = DISK_WAIT_HISTOGRAM_BUCKETS_MS.length + 1，最后一桶为 ≥ 最大值） */
  histogram: number[];
  /** 分桶上界（毫秒），与 histogram 前 N 项一一对应 */
  bucketBoundsMs: number[];
  /** 各终止原因的累计次数 */
  outcomes: Record<DiskWaitOutcome, number>;
  /**
   * 已计入直方图的样本总数。
   *
   * 口径：只有**真正进入等待队列并结束**的样本（授予 / 超时 / 取消）。
   * 立即授予（零等待）与「未进入等待」的终止（队满 / 结构性降级 / 关闭）只计入
   * `outcomes`，以免稀释 P95。
   */
  sampledWaits: number;
  /** 等待总时长（毫秒，用于算平均值；与 sampledWaits 配套） */
  totalWaitMs: number;
  /**
   * 等待时长 P95（毫秒；样本不足时为 null）。
   *
   * 用桶上界近似：命中的是「该样本落在哪个桶」，因此 P95 只会**偏大**，
   * 作为验收阈值（< 30s）的判定是保守的——不会因为近似而误判达标。
   */
  p95WaitMs: number | null;
  /** 等待时长 P50（毫秒；样本不足时为 null） */
  p50WaitMs: number | null;
}

/** 运行状态快照（管理后台观测） */
export interface DownloadResourceSnapshot {
  /** 卷真实可用空间（展示口径） */
  freeBytes: number;
  /**
   * 准入用的有效可用空间 = `freeBytes − volumePeerReserveBytes`。
   *
   * 与 `freeBytes` 并列展示：两者差异即「为同卷邻近目录（TDLib workdir）预留的量」。
   * 排查「磁盘明明有余量却一直排队」时，先看这两个值的差。
   */
  admissionFreeBytes: number;
  /** 为同卷邻近目录（TDLib workdir）预留的字节数 */
  volumePeerReserveBytes: number;
  minimumFreeBytes: number;
  reservedRemainingBytes: number;
  cacheReservedBytes: number;
  activeReservations: number;
  waitingDiskTasks: number;
  waitingUpstreamTasks: number;
  activeUpstreams: number;
  /** 已占用的上游并发权重（大文件按体量加权，权重预算见 maxConcurrentUpstreams） */
  activeUpstreamWeight: number;
  maxConcurrentUpstreams: number;
  queueCapacity: number;
  oldestDiskWaitMs: number;
  /** 磁盘等待时长分布与终止原因（瞬时值之外的分布口径，P3 验收依据） */
  diskWait: DiskWaitStats;
  /** 队首上游等待项的等待年龄（毫秒）：503 归因与「队首保留」判定依据 */
  oldestUpstreamWaitMs: number;
  /** 当前上游等待项选择策略 */
  upstreamQueuePolicy: UpstreamQueuePolicy;
  /** 队首处于「保留」状态（达绕过上限或公平等待阈值）：此时不再放行后续小任务 */
  upstreamHeadReserved: boolean;
  /** 队首任务累计被绕过的次数 */
  upstreamHeadBypassCount: number;
  /** 累计绕过队首次数（进程内自启动累计，用于观测公平策略是否被频繁触发） */
  upstreamBypassTotal: number;
  shuttingDown: boolean;
}

interface ReservationRecord {
  id: string;
  sessionKey: string;
  grantedBytes: number;
  remainingBytes: number;
  countsTowardCache: boolean;
  createdAt: number;
  active: boolean;
}

interface DiskWaiter {
  id: string;
  sessionKey: string;
  bytes: number;
  countsTowardCache: boolean;
  enqueuedAt: number;
  resolve: (reservation: DownloadReservation) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  abortHandler?: () => void;
  settled: boolean;
  onQueued?: ReserveOptions['onQueued'];
}

interface UpstreamWaiter {
  id: string;
  enqueuedAt: number;
  /** 入队时按当时预算计算的请求权重 */
  weight: number;
  /** 按**当前**预算裁剪后的生效权重（每次 pump 刷新，用于解释 503 与观测） */
  effectiveWeight: number;
  /** 作为队首时被后续任务绕过的累计次数（`bounded_fit` 专用） */
  bypassCount: number;
  /** 最终授予原因（诊断用） */
  grantReason?: UpstreamGrantReason;
  resolve: (lease: DownloadUpstreamLease) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  abortHandler?: () => void;
  settled: boolean;
  onQueued?: AcquireUpstreamOptions['onQueued'];
}

export type GrantResult =
  | { granted: true; reservation: DownloadReservation }
  | { granted: false; structural: boolean; reason: DownloadResourceScope };

@Injectable()
export class DownloadResourceCoordinatorService {
  private readonly logger = new Logger(DownloadResourceCoordinatorService.name);

  /** statfs 探测目标目录（缓存卷），由 FileCacheService 在启动时配置 */
  private probeDir: string | null = null;
  /** 缓存容量提供者：返回「已发布缓存总量」与「缓存上限」 */
  private cacheCapacityProvider: (() => { committedBytes: number; maxBytes: number }) | null = null;
  /** 队头阻塞时的 LRU 淘汰钩子（由 FileCacheService 注入，异步、带节流） */
  private evictionHook: (() => Promise<void>) | null = null;
  private evictionInFlight = false;
  private lastEvictionAt = 0;

  /** 全部在途预约「尚未写入」字节之和（物理磁盘记账） */
  private reservedPendingBytes = 0;
  /** 正式缓存在建占位之和（缓存逻辑容量记账，按 grantedBytes） */
  private cacheReservedBytes = 0;
  /** 活跃预约 */
  private readonly reservations = new Map<string, ReservationRecord>();

  /** 磁盘 FIFO 等待队列 */
  private readonly waitingDisk: DiskWaiter[] = [];
  /** 上游 FIFO 等待队列 */
  private readonly waitingUpstream: UpstreamWaiter[] = [];
  /** 活跃上游回源数（连接数，用于展示） */
  private activeUpstreams = 0;
  /** 活跃上游并发权重之和（准入按权重判断，大文件独占预算） */
  private activeUpstreamWeight = 0;
  /** `bounded_fit` 累计绕过队首次数（观测公平策略触发频率） */
  private upstreamBypassTotal = 0;
  /** 活跃上游租约 */
  private readonly upstreamLeases = new Map<string, DownloadUpstreamLease>();
  /**
   * 任务票据交接池：下载任务持有的磁盘预约在正文 GET 到达前暂存在此，
   * 由 `reserve()` 按会话键采用（原子消费，避免正文请求重新排队）。
   */
  private readonly handedOffReservations = new Map<string, { reservation: DownloadReservation; expiresAt: number }>();

  private pollTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  /** 磁盘等待时长直方图（长度 = 分桶数 + 1，末桶为 ≥ 最大上界） */
  private readonly diskWaitHistogram = new Array<number>(DISK_WAIT_HISTOGRAM_BUCKETS_MS.length + 1).fill(0);
  /** 各终止原因的累计计数 */
  private readonly diskWaitOutcomes: Record<DiskWaitOutcome, number> = {
    granted: 0,
    timeout: 0,
    cancelled: 0,
    queue_full: 0,
    direct_degrade: 0,
    shutdown: 0,
  };
  /** 已纳入分布的等待样本数 */
  private diskWaitSampled = 0;
  /** 等待总时长（毫秒） */
  private diskWaitTotalMs = 0;

  private config: DownloadResourceConfig = {
    minFreeBytes: 0,
    maxReservedBytes: 0,
    queueCapacity: 128,
    queueTimeoutMs: 1_800_000,
    maxConcurrentUpstreams: 8,
    spoolGraceMs: 120_000,
    directWindowBytes: 1 * 1024 * 1024,
    directWaitMs: 60_000,
    taskRetentionMs: 900_000,
    upstreamQueuePolicy: 'strict_fifo',
    volumePeerReserveBytes: 0,
  };

  // ---------- 依赖注入（由 FileCacheService 在启动/热更新时配置） ----------

  /** 配置 statfs 探测目录（缓存卷路径） */
  setProbeDir(dir: string): void {
    this.probeDir = dir;
  }

  /** 注入缓存容量提供者（已发布总量 + 上限），用于缓存逻辑容量预约判断 */
  setCacheCapacityProvider(provider: () => { committedBytes: number; maxBytes: number }): void {
    this.cacheCapacityProvider = provider;
  }

  /**
   * 注入 LRU 淘汰钩子：队列队头因物理/缓存容量阻塞时按节流触发一次淘汰，
   * 使被旧缓存占满的空间可以被回收给等待中的任务（不抢占活动任务）。
   */
  setEvictionHook(hook: () => Promise<void>): void {
    this.evictionHook = hook;
  }

  /** 更新运行时配置（只影响后续准入判断，已授予租约不撤销） */
  configure(partial: Partial<DownloadResourceConfig>): void {
    this.config = { ...this.config, ...partial };
    // 上限提高后立即尝试唤醒排队任务
    this.pumpDisk();
    this.pumpUpstream();
  }

  getConfig(): DownloadResourceConfig {
    return { ...this.config };
  }

  /** spool 复用宽限期（供会话协调器读取，配置热更新即时生效于新会话） */
  get spoolGraceMs(): number {
    return this.config.spoolGraceMs;
  }

  // ---------- 只读状态 ----------

  get waitingDiskCount(): number {
    return this.waitingDisk.length;
  }

  get waitingUpstreamCount(): number {
    return this.waitingUpstream.length;
  }

  get pendingReservedBytes(): number {
    return this.reservedPendingBytes;
  }

  get cacheReservedTotalBytes(): number {
    return this.cacheReservedBytes;
  }

  get activeReservationCount(): number {
    return this.reservations.size;
  }

  get activeUpstreamCount(): number {
    return this.activeUpstreams;
  }

  /** 已占用的上游并发权重（大文件按体量加权，>= 活跃连接数） */
  get activeUpstreamWeightTotal(): number {
    return this.activeUpstreamWeight;
  }

  /** 上游队首等待年龄（毫秒）：0 表示队列为空 */
  get oldestUpstreamWaitMs(): number {
    return this.waitingUpstream.length > 0 ? Date.now() - this.waitingUpstream[0].enqueuedAt : 0;
  }

  /** 队首是否处于「保留」状态（`bounded_fit` 下不再放行后续小任务） */
  get upstreamHeadReserved(): boolean {
    if (this.waitingUpstream.length === 0) return false;
    if (this.config.upstreamQueuePolicy !== 'bounded_fit') return false;
    return this.isHeadReserved(this.waitingUpstream[0]);
  }

  /** 队首累计被绕过次数 */
  get upstreamHeadBypassCount(): number {
    return this.waitingUpstream.length > 0 ? this.waitingUpstream[0].bypassCount : 0;
  }

  /** 累计绕过队首次数（进程内累计） */
  get upstreamBypassCount(): number {
    return this.upstreamBypassTotal;
  }

  /** 兼容既有测试：直接设置活跃上游数（仅测试/诊断使用；按单位权重记账） */
  setActiveUpstreamCount(value: number): void {
    const normalized = Math.max(0, Math.floor(value) || 0);
    this.activeUpstreams = normalized;
    this.activeUpstreamWeight = normalized;
    this.pumpUpstream();
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** 运行状态快照（管理后台观测） */
  getSnapshot(): DownloadResourceSnapshot {
    return {
      freeBytes: this.probeFreeBytes(),
      admissionFreeBytes: this.probeAdmissionFreeBytes(),
      volumePeerReserveBytes: Math.max(0, Math.floor(this.config.volumePeerReserveBytes) || 0),
      minimumFreeBytes: this.config.minFreeBytes,
      reservedRemainingBytes: this.reservedPendingBytes,
      cacheReservedBytes: this.cacheReservedBytes,
      activeReservations: this.reservations.size,
      waitingDiskTasks: this.waitingDisk.length,
      waitingUpstreamTasks: this.waitingUpstream.length,
      activeUpstreams: this.activeUpstreams,
      activeUpstreamWeight: this.activeUpstreamWeight,
      maxConcurrentUpstreams: this.config.maxConcurrentUpstreams,
      queueCapacity: this.config.queueCapacity,
      oldestDiskWaitMs: this.waitingDisk.length > 0 ? Date.now() - this.waitingDisk[0].enqueuedAt : 0,
      diskWait: this.getDiskWaitStats(),
      oldestUpstreamWaitMs: this.oldestUpstreamWaitMs,
      upstreamQueuePolicy: this.config.upstreamQueuePolicy,
      upstreamHeadReserved: this.upstreamHeadReserved,
      upstreamHeadBypassCount: this.upstreamHeadBypassCount,
      upstreamBypassTotal: this.upstreamBypassTotal,
      shuttingDown: this.shuttingDown,
    };
  }

  /**
   * 磁盘等待统计快照（分位数用分桶上界近似，偏大不偏小）。
   *
   * 采样范围：只有**真正进入等待队列并结束**的样本（granted/timeout/cancelled）计入
   * 直方图与分位数；queue_full / direct_degrade 属于「没有等待」，只计入 outcomes。
   * 这样 P95 不会被大量「瞬间授予」稀释成无意义的小值。
   */
  getDiskWaitStats(): DiskWaitStats {
    const bucketCount = DISK_WAIT_HISTOGRAM_BUCKETS_MS.length + 1;
    const histogram = [...this.diskWaitHistogram];
    const sampled = this.diskWaitSampled;
    const quantile = (ratio: number): number | null => {
      if (sampled <= 0) return null;
      const target = Math.ceil(sampled * ratio);
      let cumulative = 0;
      for (let i = 0; i < histogram.length; i += 1) {
        cumulative += histogram[i];
        if (cumulative >= target) {
          // 最后一桶（≥ 最大上界）用配置最大上界作为代表值（保守低估，避免虚高）
          return i < DISK_WAIT_HISTOGRAM_BUCKETS_MS.length
            ? DISK_WAIT_HISTOGRAM_BUCKETS_MS[i]
            : DISK_WAIT_HISTOGRAM_BUCKETS_MS[DISK_WAIT_HISTOGRAM_BUCKETS_MS.length - 1];
        }
      }
      return null;
    };
    return {
      histogram: histogram.slice(0, bucketCount),
      bucketBoundsMs: [...DISK_WAIT_HISTOGRAM_BUCKETS_MS],
      outcomes: { ...this.diskWaitOutcomes },
      sampledWaits: sampled,
      totalWaitMs: this.diskWaitTotalMs,
      p95WaitMs: quantile(0.95),
      p50WaitMs: quantile(0.5),
    };
  }

  /**
   * 记录一次磁盘等待的终止结果。
   *
   * `waitMs` **只在真正进过等待队列时**传入（进入队列后：授予 / 超时 / 取消）。
   * 未传时只累计终止原因，不进入分布——原因有两类，都不能混进分位数：
   * - 立即授予（零等待）与 queue_full / direct_degrade / shutdown：
   *   它们不是「等待」样本，混入后会把 P95 稀释成无意义的小值，
   *   使「磁盘等待是否变短」这个验收问题失去意义；
   * - shutdown 属系统级终止，重启不该抬高等待 P95。
   */
  private recordDiskWaitOutcome(outcome: DiskWaitOutcome, waitMs?: number): void {
    this.diskWaitOutcomes[outcome] += 1;
    if (waitMs === undefined) return;
    const duration = Math.max(0, Math.floor(waitMs));
    this.diskWaitSampled += 1;
    this.diskWaitTotalMs += duration;
    const index = DISK_WAIT_HISTOGRAM_BUCKETS_MS.findIndex((bound) => duration < bound);
    const bucket = index >= 0 ? index : DISK_WAIT_HISTOGRAM_BUCKETS_MS.length;
    this.diskWaitHistogram[bucket] += 1;
  }

  // ---------- 物理空间探测 ----------

  /**
   * **准入用**的有效可用空间：物理可用 − 同卷邻近目录（TDLib workdir）预留量。
   *
   * 为什么必须与展示用的 `probeFreeBytes()` 分开：Cache 与 workdir 同卷时，
   * 两套独立写前探测会各自看到同一份空闲并同时放行，叠加后写满卷——每一方都「合法」。
   * 从缓存侧扣掉留给 workdir 的余量后，两侧峰值占用之和才受一个总水位约束。
   * 结果可能为负（表示已越过水位），调用方按不足处理。
   */
  private probeAdmissionFreeBytes(): number {
    const raw = this.probeFreeBytes();
    if (raw < 0) return raw;
    const reserve = Math.max(0, Math.floor(this.config.volumePeerReserveBytes) || 0);
    return raw - reserve;
  }

  /**
   * 探测物理可用空间（bavail，无特权可用块）。
   * 失败返回 -1（保守按不可用处理，fail-closed）。
   *
   * 注意：本方法是**展示口径**（真实空闲），准入判定必须用 `probeAdmissionFreeBytes()`，
   * 否则同卷邻近目录的预留量不生效。
   */
  probeFreeBytes(): number {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { statfsSync } = require('fs');
      const dir = this.probeDir ?? process.cwd();
      const stats = statfsSync(dir);
      const availBlocks = stats.bavail > 0 ? stats.bavail : 0;
      return stats.bsize * availBlocks;
    } catch {
      return -1;
    }
  }

  // ---------- 磁盘 / 缓存预约 ----------

  /**
   * 申请磁盘（可选含缓存逻辑容量）预约。
   * - 立即满足：同步登记并返回句柄；
   * - 暂时不足：进入有界 FIFO 排队，释放事件或兜底轮询唤醒；
   * - 结构上不可能（`空闲 − 安全余量 < 新增`，或单文件超过缓存上限）：抛 507，
   *   调用方应据此降级为有界滚动缓冲直通，绝不因文件过大拒绝下载。
   */
  async reserve(options: ReserveOptions): Promise<DownloadReservation> {
    const { sessionKey, bytes, countsTowardCache = false, signal } = options;
    if (this.shuttingDown) throw this.shuttingDownError();
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new Error(`非法的下载磁盘预约大小: ${bytes}`);
    }
    if (signal?.aborted) throw this.cancelledError('下载任务已取消');

    // 任务票据交接：同会话已有预授权预约时直接采用（原子消费），不再重新排队
    const handedOff = this.takeHandedOffReservation(sessionKey);
    if (handedOff) {
      if (handedOff.grantedBytes >= bytes) return handedOff;
      // 预授权不足以覆盖本次请求（例如内容大小已变化）：归还后按常规路径重新申请
      handedOff.release();
    }

    const freeBytes = this.probeAdmissionFreeBytes();
    if (freeBytes < 0) {
      throw this.probeUnavailableError();
    }

    const result = this.tryGrant({ sessionKey, bytes, countsTowardCache, freeBytes });
    if (result.granted) {
      // 立即授予（未进队列）：只累计“授予”次数，不带等待时长——零等待样本若进入
      // 分布会把 P95 稀释成无意义的小值
      this.recordDiskWaitOutcome('granted');
      return result.reservation;
    }
    if (result.structural) {
      // 结构性不足：调用方会降级受限直通（不写本地副本），不计入等待分布
      this.recordDiskWaitOutcome('direct_degrade');
      throw this.insufficientStorageError(result.reason, bytes, freeBytes);
    }

    if (this.waitingDisk.length >= this.config.queueCapacity) {
      this.recordDiskWaitOutcome('queue_full');
      throw this.queueFullError();
    }

    const waitTimeoutMs = options.waitTimeoutMs ?? this.config.queueTimeoutMs;
    const waiter = this.enqueueDisk({
      sessionKey,
      bytes,
      countsTowardCache,
      waitTimeoutMs,
      signal,
      onQueued: options.onQueued,
    });
    this.ensurePollTimer();
    return waiter;
  }

  /**
   * 同步尝试立即授予预约（不排队、不抛结构性异常）。
   *
   * 供下载任务在创建时"顺手"持有真实预约：只读探测已确认可准入时无需异步排队，
   * 保持 `create()` 同步返回 `streamable` 的既有契约；不可立即满足时返回 null，
   * 由调用方改用异步 `reserve()` 真实排队。
   */
  tryReserveNow(options: {
    sessionKey: string;
    bytes: number;
    countsTowardCache?: boolean;
  }): DownloadReservation | null {
    if (this.shuttingDown) return null;
    const { sessionKey, bytes, countsTowardCache = false } = options;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return null;

    const handedOff = this.takeHandedOffReservation(sessionKey);
    if (handedOff) {
      if (handedOff.grantedBytes >= bytes) return handedOff;
      handedOff.release();
      return null;
    }

    const freeBytes = this.probeAdmissionFreeBytes();
    if (freeBytes < 0) return null;
    const result = this.tryGrant({ sessionKey, bytes, countsTowardCache, freeBytes });
    return result.granted ? result.reservation : null;
  }

  /**
   * 把下载任务已持有的预约交接给同会话的正文请求（两阶段下载的第二阶段）。
   * 覆盖同键旧条目时立即归还，避免预约泄漏；超时未采用由 `purgeExpiredHandOffs` 回收。
   */
  handOffToSession(sessionKey: string, reservation: DownloadReservation): void {
    this.purgeExpiredHandOffs();
    const existing = this.handedOffReservations.get(sessionKey);
    if (existing && existing.reservation !== reservation) existing.reservation.release();
    this.handedOffReservations.set(sessionKey, {
      reservation,
      expiresAt: Date.now() + DOWNLOAD_RESOURCE_DEFAULTS.HANDOFF_TTL_MS,
    });
  }

  /** 取出并采用一次交接预约（原子：无论有效与否都从池中移除） */
  private takeHandedOffReservation(sessionKey: string): DownloadReservation | null {
    const entry = this.handedOffReservations.get(sessionKey);
    if (!entry) return null;
    this.handedOffReservations.delete(sessionKey);
    if (entry.expiresAt <= Date.now() || !entry.reservation.active) {
      entry.reservation.release();
      return null;
    }
    return entry.reservation;
  }

  /** 回收超时未采用的交接预约（返回回收数量） */
  purgeExpiredHandOffs(): number {
    const now = Date.now();
    let purged = 0;
    for (const [key, entry] of this.handedOffReservations) {
      if (entry.expiresAt > now) continue;
      this.handedOffReservations.delete(key);
      entry.reservation.release();
      purged++;
    }
    return purged;
  }

  /** 当前暂存的交接预约数（观测用） */
  get handedOffReservationCount(): number {
    return this.handedOffReservations.size;
  }

  private enqueueDisk(input: {
    sessionKey: string;
    bytes: number;
    countsTowardCache: boolean;
    waitTimeoutMs: number;
    signal?: AbortSignal;
    onQueued?: ReserveOptions['onQueued'];
  }): Promise<DownloadReservation> {
    return new Promise<DownloadReservation>((resolve, reject) => {
      const waiter: DiskWaiter = {
        id: randomUUID(),
        sessionKey: input.sessionKey,
        bytes: input.bytes,
        countsTowardCache: input.countsTowardCache,
        enqueuedAt: Date.now(),
        resolve,
        reject,
        settled: false,
        signal: input.signal,
        onQueued: input.onQueued,
      };
      const timer = setTimeout(() => {
        if (!this.removeDiskWaiter(waiter)) return;
        waiter.settled = true;
        // 超时是「容量问题」的直接证据：必须计入分布（这是 P95 判定的主要样本来源）
        this.recordDiskWaitOutcome('timeout', Date.now() - waiter.enqueuedAt);
        waiter.reject(this.queueTimeoutError(waiter));
        // 队首被移除后其后继可能已可准入：显式唤醒（与上游队列同一处理）
        this.pumpDisk();
      }, input.waitTimeoutMs);
      timer.unref?.();
      waiter.timer = timer;
      if (input.signal) {
        waiter.abortHandler = () => {
          if (!this.removeDiskWaiter(waiter)) return;
          waiter.settled = true;
          // 取消不计入「容量问题」：客户端主动放弃与服务器磁盘压力是两件事，
          // 但等待时长本身仍是真实发生的排队（纳入分布，用于观察排队时长的尾部）
          this.recordDiskWaitOutcome('cancelled', Date.now() - waiter.enqueuedAt);
          waiter.reject(this.cancelledError('下载任务已取消'));
          this.pumpDisk();
        };
        input.signal.addEventListener('abort', waiter.abortHandler, { once: true });
      }
      this.waitingDisk.push(waiter);
      this.logger.debug(
        `下载磁盘预约排队: session=${input.sessionKey} bytes=${input.bytes} 位置=${this.waitingDisk.length}`,
      );
      input.onQueued?.({
        reason: this.classifyQueueReason(input.bytes, input.countsTowardCache),
        position: this.waitingDisk.length,
        retryAfterMs: DOWNLOAD_RESOURCE_DEFAULTS.RETRY_AFTER_MS,
      });
    });
  }

  /** 准入评估（纯函数，不改变任何计数）：供 grant 与只读探测复用 */
  private evaluateGrant(input: {
    bytes: number;
    countsTowardCache: boolean;
    freeBytes: number;
  }): { ok: true } | { ok: false; structural: boolean; reason: DownloadResourceScope } {
    const { bytes, countsTowardCache, freeBytes } = input;
    const { minFreeBytes, maxReservedBytes } = this.config;

    // 结构性不可行：即使没有任何其他预约也容纳不下完整暂存
    if (freeBytes - minFreeBytes < bytes) {
      return { ok: false, structural: true, reason: 'disk' };
    }

    // 全局预约上限：旧任务释放后可能满足，属于可等待的暂时不足
    if (maxReservedBytes > 0 && this.reservedPendingBytes + bytes > maxReservedBytes) {
      return { ok: false, structural: false, reason: 'global' };
    }

    // 缓存逻辑容量：仅"文件本身即超过缓存上限"属于结构性不可行（调用方应改走 spool/direct）；
    // 已发布缓存可被 LRU 回收，因此其余情况属于可等待的暂时不足。
    if (countsTowardCache) {
      const cache = this.cacheCapacityProvider?.();
      if (cache) {
        if (bytes > cache.maxBytes) {
          return { ok: false, structural: true, reason: 'cache' };
        }
        if (cache.committedBytes + this.cacheReservedBytes + bytes > cache.maxBytes) {
          return { ok: false, structural: false, reason: 'cache' };
        }
      }
    }

    // 真实并发争用：其他任务尚未写入的预约必须扣除
    if (freeBytes - minFreeBytes - this.reservedPendingBytes < bytes) {
      return { ok: false, structural: false, reason: 'disk' };
    }

    return { ok: true };
  }

  /** 尝试立即授予；返回结构性不可行标记供调用方降级 */
  private tryGrant(input: {
    sessionKey: string;
    bytes: number;
    countsTowardCache: boolean;
    freeBytes: number;
  }): GrantResult {
    const verdict = this.evaluateGrant(input);
    if (!verdict.ok) {
      return { granted: false, structural: verdict.structural, reason: verdict.reason };
    }
    return {
      granted: true,
      reservation: this.createReservation(input.sessionKey, input.bytes, input.countsTowardCache),
    };
  }

  /**
   * 只读准入探测（不排队、不占名额）：用于下载任务的状态上报。
   * 返回是否可以立即开始、排队原因、近似队列位置与建议重试间隔。
   */
  probeAdmission(bytes: number, countsTowardCache = false): {
    admitted: boolean;
    structural: boolean;
    reason?: DownloadQueueReason;
    scope?: DownloadResourceScope;
    queuePosition: number;
    waitingDiskTasks: number;
    waitingUpstreamTasks: number;
    activeUpstreams: number;
    freeBytes: number;
    retryAfterMs: number;
  } {
    const waitingDisk = this.waitingDisk.length;
    const waitingUpstream = this.waitingUpstream.length;
    const activeUpstreams = this.activeUpstreams;
    const base = {
      queuePosition: waitingDisk + 1,
      waitingDiskTasks: waitingDisk,
      waitingUpstreamTasks: waitingUpstream,
      activeUpstreams,
      retryAfterMs: DOWNLOAD_RESOURCE_DEFAULTS.RETRY_AFTER_MS,
    };

    if (this.shuttingDown) {
      return { admitted: false, structural: false, reason: 'server_load', scope: 'system', freeBytes: -1, ...base };
    }
    const freeBytes = this.probeAdmissionFreeBytes();
    if (freeBytes < 0) {
      return {
        ...base,
        admitted: false,
        structural: false,
        reason: 'disk',
        scope: 'disk',
        freeBytes: -1,
        retryAfterMs: DOWNLOAD_RESOURCE_DEFAULTS.PROBE_RETRY_AFTER_MS,
      };
    }

    const verdict = this.evaluateGrant({ bytes, countsTowardCache, freeBytes });
    const weight = upstreamWeightForSize(bytes, this.config.maxConcurrentUpstreams);
    // 注意：这是**保守近似**。真实准入（`acquireUpstreamSlot`）在预算足够时总是即时放行，
    // 不检查队列是否非空（历史行为，本次未改变）；因此队列非空但仍有空闲权重时，
    // 探测可能报告「排队」而实际请求会被立即放行——仅用于状态展示，不作为准入结论。
    const upstreamReady = waitingUpstream === 0 && this.canGrantUpstream(weight);
    if (verdict.ok && upstreamReady) {
      return { admitted: true, structural: false, freeBytes, ...base };
    }
    // 磁盘/缓存已可就绪但上游名额吃紧：排队原因记为上游
    if (verdict.ok) {
      return {
        ...base,
        admitted: false,
        structural: false,
        reason: 'upstream',
        scope: 'upstream',
        freeBytes,
        queuePosition: waitingUpstream + 1,
      };
    }
    return {
      admitted: false,
      structural: verdict.structural,
      reason: verdict.reason === 'disk' ? 'disk' : 'server_load',
      scope: verdict.reason,
      freeBytes,
      ...base,
    };
  }

  private createReservation(sessionKey: string, bytes: number, countsTowardCache: boolean): DownloadReservation {
    const record: ReservationRecord = {
      id: randomUUID(),
      sessionKey,
      grantedBytes: bytes,
      remainingBytes: bytes,
      countsTowardCache,
      createdAt: Date.now(),
      active: true,
    };
    this.reservations.set(record.id, record);
    this.reservedPendingBytes += bytes;
    if (countsTowardCache) this.cacheReservedBytes += bytes;
    return this.buildReservationHandle(record);
  }

  private buildReservationHandle(record: ReservationRecord): DownloadReservation {
    const service = this;
    return {
      id: record.id,
      sessionKey: record.sessionKey,
      get grantedBytes(): number {
        return record.grantedBytes;
      },
      get remainingBytes(): number {
        return record.remainingBytes;
      },
      get countsTowardCache(): boolean {
        return record.countsTowardCache;
      },
      get active(): boolean {
        return record.active;
      },
      consume(bytes: number): void {
        service.consumeReservation(record, bytes);
      },
      release(): void {
        service.releaseReservation(record);
      },
    };
  }

  /**
   * 核销已写入的预约量：剩余预约只保留「尚未写入」的峰值增量。
   * 已写入字节已由 statfs 反映，若此处不递减会造成物理/逻辑双重扣减（利用率过低）。
   */
  private consumeReservation(record: ReservationRecord, bytes: number): void {
    if (!record.active) return;
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    const consumed = Math.min(record.remainingBytes, Math.floor(bytes));
    if (consumed <= 0) return;
    record.remainingBytes -= consumed;
    this.reservedPendingBytes = Math.max(0, this.reservedPendingBytes - consumed);
  }

  /** 释放剩余预约并唤醒等待队列（幂等） */
  private releaseReservation(record: ReservationRecord): void {
    if (!record.active) return;
    record.active = false;
    this.reservations.delete(record.id);
    this.reservedPendingBytes = Math.max(0, this.reservedPendingBytes - record.remainingBytes);
    record.remainingBytes = 0;
    if (record.countsTowardCache) {
      this.cacheReservedBytes = Math.max(0, this.cacheReservedBytes - record.grantedBytes);
    }
    this.pumpDisk();
  }

  // ---------- 上游并发租约 ----------

  /**
   * 获取上游回源槽位租约（严格 FIFO + 大文件加权）。
   * 权重预算或连接数不足时排队等待，超时抛 `DOWNLOAD_SERVER_BUSY`。
   */
  async acquireUpstreamSlot(options?: AcquireUpstreamOptions): Promise<DownloadUpstreamLease> {
    if (this.shuttingDown) throw this.shuttingDownError();
    if (options?.signal?.aborted) throw this.cancelledError('下载任务已取消');
    const weight = this.resolveUpstreamWeight(options);
    if (this.canGrantUpstream(weight)) {
      return this.grantUpstreamLease(weight);
    }
    if (this.waitingUpstream.length >= this.config.queueCapacity) {
      throw this.queueFullError('upstream');
    }
    const waitTimeoutMs = options?.waitTimeoutMs ?? this.config.queueTimeoutMs;
    return new Promise<DownloadUpstreamLease>((resolve, reject) => {
      const waiter: UpstreamWaiter = {
        id: randomUUID(),
        enqueuedAt: Date.now(),
        weight,
        effectiveWeight: this.effectiveWaiterWeight(weight),
        bypassCount: 0,
        resolve,
        reject,
        settled: false,
        signal: options?.signal,
        onQueued: options?.onQueued,
      };
      const timer = setTimeout(() => {
        if (!this.removeUpstreamWaiter(waiter)) return;
        waiter.settled = true;
        waiter.reject(this.serverBusyError('下载连接等待超时，请稍后重试'));
        // 移除队首后其后继可能已可放入预算：上游队列没有兜底轮询，
        // 必须显式唤醒，否则后续等待项会被饿到自身超时。
        this.pumpUpstream();
      }, waitTimeoutMs);
      timer.unref?.();
      waiter.timer = timer;
      if (options?.signal) {
        waiter.abortHandler = () => {
          if (!this.removeUpstreamWaiter(waiter)) return;
          waiter.settled = true;
          waiter.reject(this.cancelledError('下载任务已取消'));
          this.pumpUpstream();
        };
        options.signal.addEventListener('abort', waiter.abortHandler, { once: true });
      }
      this.waitingUpstream.push(waiter);
      options?.onQueued?.({
        reason: 'upstream',
        position: this.waitingUpstream.length,
        retryAfterMs: DOWNLOAD_RESOURCE_DEFAULTS.RETRY_AFTER_MS,
      });
    });
  }

  /** 当前全局上游权重预算（下限 1，避免异常配置造成永久阻塞） */
  private currentUpstreamBudget(): number {
    return Math.max(1, Math.floor(this.config.maxConcurrentUpstreams) || 1);
  }

  /** 按当前预算裁剪单个权重（入队时与每次 pump 都刷新，避免降预算后产生无法满足的等待项） */
  private effectiveWaiterWeight(weight: number): number {
    return Math.min(Math.max(1, Math.floor(weight) || 1), this.currentUpstreamBudget());
  }

  /** 解析本次请求的上游并发权重（显式值优先，其次按文件体量；结果不超过预算） */
  private resolveUpstreamWeight(options?: AcquireUpstreamOptions): number {
    const budget = this.currentUpstreamBudget();
    const requested = options?.weight !== undefined && Number.isFinite(options.weight)
      ? Math.floor(options.weight)
      : upstreamWeightForSize(options?.bytes ?? 0, budget);
    return Math.min(Math.max(1, requested), budget);
  }

  /**
   * 上游权重预算是否足够。
   * 预算即 `maxConcurrentUpstreams`：大文件权重等于预算 → 同时只放行 1 个。
   */
  private canGrantUpstream(weight: number): boolean {
    return this.activeUpstreamWeight + weight <= this.currentUpstreamBudget();
  }

  private grantUpstreamLease(weight = 1): DownloadUpstreamLease {
    this.activeUpstreams += 1;
    this.activeUpstreamWeight += weight;
    const id = randomUUID();
    const service = this;
    let active = true;
    const lease: DownloadUpstreamLease = {
      id,
      get active(): boolean {
        return active;
      },
      get weight(): number {
        return weight;
      },
      release(): void {
        if (!active) return;
        active = false;
        service.upstreamLeases.delete(id);
        service.activeUpstreams = Math.max(0, service.activeUpstreams - 1);
        service.activeUpstreamWeight = Math.max(0, service.activeUpstreamWeight - weight);
        service.pumpUpstream();
      },
    };
    this.upstreamLeases.set(id, lease);
    return lease;
  }

  // ---------- 队列泵 ----------

  /** 磁盘队列泵：事件驱动 + 队头不跳过（FIFO，避免大任务饥饿） */
  private pumpDisk(): void {
    if (this.waitingDisk.length === 0) {
      this.stopPollTimer();
      return;
    }
    // 必须用准入口径（扣除同卷邻近目录预留），否则队头会在「展示空闲充足、
    // 实际已越总水位」时被放行，两个大分卷叠加写满卷
    const freeBytes = this.probeAdmissionFreeBytes();
    if (freeBytes < 0) {
      return;
    }

    while (this.waitingDisk.length > 0) {
      const head = this.waitingDisk[0];
      const result = this.tryGrant({
        sessionKey: head.sessionKey,
        bytes: head.bytes,
        countsTowardCache: head.countsTowardCache,
        freeBytes,
      });
      if (!result.granted) {
        // 队头无法满足：不跳过（防止大任务被小任务持续插队），尝试回收空间后等待
        this.requestEviction();
        return;
      }
      this.removeDiskWaiter(head);
      head.settled = true;
      // 授予样本：等待时长即入队到授予的真实间隔（P95 的另一个样本来源）
      this.recordDiskWaitOutcome('granted', Date.now() - head.enqueuedAt);
      head.resolve(result.reservation);
    }
    this.stopPollTimer();
  }

  /**
   * 上游队列泵。
   *
   * - `strict_fifo`（默认/紧急回退）：队首权重不足时直接返回，保持既有行为；
   * - `bounded_fit`：队首放不下时，只在队首之后的前 N 个等待项中寻找最早的、能适配
   *   剩余预算的任务放行，避免 4GB 队首把后续小文件阻塞到 60 秒超时；
   *   每次绕过累加队首 `bypassCount`，达到绕过上限或公平等待阈值后进入「队首保留」，
   *   不再发放任何非队首任务，直到队首被放行/取消/超时或切回 `strict_fifo`。
   *
   * 权重按**当前**预算重新裁剪：运行中调低预算后，入队时按旧预算计算的权重
   * 可能永远无法满足，会让队头及其后续等待项全部阻塞到超时。
   */
  private pumpUpstream(): void {
    while (this.waitingUpstream.length > 0) {
      const head = this.waitingUpstream[0];
      const headWeight = this.effectiveWaiterWeight(head.weight);
      head.effectiveWeight = headWeight;

      if (this.canGrantUpstream(headWeight)) {
        if (!this.removeUpstreamWaiter(head)) continue;
        head.settled = true;
        head.grantReason = head.bypassCount > 0 ? 'head_after_wait' : 'head';
        head.resolve(this.grantUpstreamLease(headWeight));
        continue;
      }

      // 严格 FIFO 或队首处于保留状态：不绕过，等待资源释放
      if (this.config.upstreamQueuePolicy !== 'bounded_fit') return;
      if (this.isHeadReserved(head)) return;

      const candidateIndex = this.findFitCandidateIndex();
      if (candidateIndex < 0) return;
      const candidate = this.waitingUpstream[candidateIndex];
      const weight = this.effectiveWaiterWeight(candidate.weight);
      if (!this.removeUpstreamWaiter(candidate)) continue;

      // 绕过队首一次：累计用于队首保留判定与观测
      head.bypassCount += 1;
      this.upstreamBypassTotal += 1;
      candidate.settled = true;
      candidate.grantReason = 'fit_skip';
      this.logger.debug(
        `上游队列适配优先放行: session=${candidate.id} 权重=${weight} 队首旁路次数=${head.bypassCount}`,
      );
      candidate.resolve(this.grantUpstreamLease(weight));
    }
  }

  /**
   * 在队首之后的前 `SCAN_WINDOW` 个等待项中寻找最早的、能放入剩余预算的任务。
   * 返回其在 `waitingUpstream` 中的索引；找不到返回 -1。不做全队列扫描。
   */
  private findFitCandidateIndex(): number {
    const limit = Math.min(
      this.waitingUpstream.length,
      UPSTREAM_FIT_POLICY_DEFAULTS.SCAN_WINDOW + 1,
    );
    for (let i = 1; i < limit; i++) {
      const waiter = this.waitingUpstream[i];
      if (waiter.settled) continue;
      if (this.canGrantUpstream(this.effectiveWaiterWeight(waiter.weight))) return i;
    }
    return -1;
  }

  /** 队首是否进入「保留」状态（达绕过上限或公平等待阈值） */
  private isHeadReserved(head: UpstreamWaiter): boolean {
    if (head.bypassCount >= UPSTREAM_FIT_POLICY_DEFAULTS.MAX_HEAD_BYPASS) return true;
    return Date.now() - head.enqueuedAt >= UPSTREAM_FIT_POLICY_DEFAULTS.HEAD_FAIR_WAIT_MS;
  }

  private removeDiskWaiter(waiter: DiskWaiter): boolean {
    const index = this.waitingDisk.indexOf(waiter);
    if (index < 0) return false;
    this.waitingDisk.splice(index, 1);
    this.detachWaiter(waiter);
    return true;
  }

  private removeUpstreamWaiter(waiter: UpstreamWaiter): boolean {
    const index = this.waitingUpstream.indexOf(waiter);
    if (index < 0) return false;
    this.waitingUpstream.splice(index, 1);
    this.detachWaiter(waiter);
    return true;
  }

  private detachWaiter(waiter: { timer?: NodeJS.Timeout; signal?: AbortSignal; abortHandler?: () => void }): void {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abortHandler) {
      waiter.signal.removeEventListener('abort', waiter.abortHandler);
    }
  }

  /** 兜底轮询：事件遗漏或外部程序释放空间时周期复查（30s，不忙轮询） */
  private ensurePollTimer(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (this.waitingDisk.length === 0) {
        this.stopPollTimer();
        return;
      }
      this.pumpDisk();
    }, DOWNLOAD_RESOURCE_DEFAULTS.POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  private stopPollTimer(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** 触发一次 LRU 淘汰（带节流与并发保护），失败仅记录日志不影响队列 */
  private requestEviction(): void {
    if (!this.evictionHook || this.evictionInFlight) return;
    const now = Date.now();
    if (now - this.lastEvictionAt < DOWNLOAD_RESOURCE_DEFAULTS.EVICTION_THROTTLE_MS) return;
    this.lastEvictionAt = now;
    this.evictionInFlight = true;
    void this.evictionHook()
      .catch(error => {
        this.logger.warn(`下载队列触发缓存淘汰失败: ${(error as Error).message}`);
      })
      .finally(() => {
        this.evictionInFlight = false;
        this.pumpDisk();
      });
  }

  /** 队列原因分类：用于前端文案（磁盘 / 服务器负载） */
  private classifyQueueReason(bytes: number, countsTowardCache: boolean): DownloadQueueReason {
    const { maxReservedBytes } = this.config;
    if (maxReservedBytes > 0 && this.reservedPendingBytes + bytes > maxReservedBytes) return 'server_load';
    if (countsTowardCache) {
      const cache = this.cacheCapacityProvider?.();
      if (cache && cache.committedBytes + this.cacheReservedBytes + bytes > cache.maxBytes) {
        return 'server_load';
      }
    }
    return 'disk';
  }

  // ---------- 关闭 ----------

  /** 关闭：拒绝全部等待项并停止轮询（已授予租约由各自会话收尾释放） */
  shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.stopPollTimer();
    // 关闭时不会再有正文请求来采用交接预约：全部归还，避免预约残留
    for (const [key, entry] of this.handedOffReservations) {
      entry.reservation.release();
      this.handedOffReservations.delete(key);
    }
    for (const waiter of this.waitingDisk.splice(0)) {
      this.detachWaiter(waiter);
      if (waiter.settled) continue;
      waiter.settled = true;
      // 关闭属系统级终止，不计入等待分布（否则重启会污染 P95），只累计次数
      this.recordDiskWaitOutcome('shutdown');
      waiter.reject(this.shuttingDownError());
    }
    for (const waiter of this.waitingUpstream.splice(0)) {
      this.detachWaiter(waiter);
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.reject(this.shuttingDownError());
    }
    this.logger.log('下载资源协调器已关闭：拒绝全部等待中的下载任务');
  }

  /** 进程退出/关闭后重新开始接纳（仅供测试与热重启场景） */
  reset(): void {
    this.shuttingDown = false;
    this.stopPollTimer();
  }

  // ---------- 错误构造 ----------

  private shuttingDownError(): DownloadResourceException {
    return new DownloadResourceException({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      errorCode: DOWNLOAD_ERROR_CODES.SHUTTING_DOWN,
      message: '服务正在关闭，下载请求已取消',
      scope: 'system',
    });
  }

  private probeUnavailableError(): DownloadResourceException {
    return new DownloadResourceException({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      errorCode: DOWNLOAD_ERROR_CODES.STORAGE_PROBE_UNAVAILABLE,
      message: '磁盘空间探测失败，暂时无法开始下载，请稍后重试',
      scope: 'disk',
      retryAfterMs: DOWNLOAD_RESOURCE_DEFAULTS.PROBE_RETRY_AFTER_MS,
    });
  }

  private insufficientStorageError(reason: DownloadResourceScope, bytes: number, freeBytes: number): DownloadResourceException {
    const scope: DownloadResourceScope = reason === 'cache' ? 'cache' : 'disk';
    const message = scope === 'cache'
      ? `文件大小超过服务器缓存容量上限（需要 ${bytes} 字节）`
      : `服务器可用空间不足，无法完整暂存该文件（需要 ${bytes} 字节，可用 ${freeBytes} 字节）`;
    return new DownloadResourceException({
      status: HttpStatus.INSUFFICIENT_STORAGE,
      errorCode: DOWNLOAD_ERROR_CODES.INSUFFICIENT_STORAGE,
      message,
      scope,
      retryAfterMs: DOWNLOAD_RESOURCE_DEFAULTS.RETRY_AFTER_MS,
    });
  }

  private queueFullError(reason: DownloadQueueReason = 'disk'): DownloadResourceException {
    return new DownloadResourceException({
      status: HttpStatus.TOO_MANY_REQUESTS,
      errorCode: DOWNLOAD_ERROR_CODES.QUEUE_FULL,
      message: '服务器当前下载任务较多，请稍后重试',
      scope: reason === 'upstream' ? 'upstream' : 'global',
      queueReason: reason,
      retryAfterMs: DOWNLOAD_RESOURCE_DEFAULTS.RETRY_AFTER_MS,
    });
  }

  private queueTimeoutError(waiter: DiskWaiter): DownloadResourceException {
    return new DownloadResourceException({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      errorCode: DOWNLOAD_ERROR_CODES.QUEUE_TIMEOUT,
      message: '等待服务器释放下载空间超时，请稍后重新下载',
      scope: 'disk',
      queueReason: this.classifyQueueReason(waiter.bytes, waiter.countsTowardCache),
      retryAfterMs: DOWNLOAD_RESOURCE_DEFAULTS.RETRY_AFTER_MS,
    });
  }

  private serverBusyError(message: string): DownloadResourceException {
    return new DownloadResourceException({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      errorCode: DOWNLOAD_ERROR_CODES.SERVER_BUSY,
      message,
      scope: 'upstream',
      queueReason: 'upstream',
      retryAfterMs: DOWNLOAD_RESOURCE_DEFAULTS.RETRY_AFTER_MS,
    });
  }

  private cancelledError(message: string): DownloadResourceException {
    return new DownloadResourceException({
      status: HTTP_STATUS_CLIENT_CLOSED_REQUEST,
      errorCode: DOWNLOAD_ERROR_CODES.QUEUE_CANCELLED,
      message,
      scope: 'system',
    });
  }
}
 