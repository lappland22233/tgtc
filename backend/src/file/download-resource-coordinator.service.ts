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
  /** 上游冷回源并发上限 */
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
} as const;

export const DOWNLOAD_CONFIG_DEFAULTS: Record<string, string> = {
  [DOWNLOAD_CONFIG_KEYS.MAX_RESERVED_GB]: '0',
  [DOWNLOAD_CONFIG_KEYS.MAX_CONCURRENT_UPSTREAMS]: '8',
  [DOWNLOAD_CONFIG_KEYS.QUEUE_CAPACITY]: '128',
  [DOWNLOAD_CONFIG_KEYS.QUEUE_TIMEOUT_SECONDS]: '1800',
  [DOWNLOAD_CONFIG_KEYS.SPOOL_GRACE_SECONDS]: '120',
  [DOWNLOAD_CONFIG_KEYS.DIRECT_WINDOW_MB]: '16',
  [DOWNLOAD_CONFIG_KEYS.DIRECT_WAIT_SECONDS]: '60',
  [DOWNLOAD_CONFIG_KEYS.TASK_RETENTION_SECONDS]: '900',
};

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
} as const;

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
}

/** 运行状态快照（管理后台观测） */
export interface DownloadResourceSnapshot {
  freeBytes: number;
  minimumFreeBytes: number;
  reservedRemainingBytes: number;
  cacheReservedBytes: number;
  activeReservations: number;
  waitingDiskTasks: number;
  waitingUpstreamTasks: number;
  activeUpstreams: number;
  maxConcurrentUpstreams: number;
  queueCapacity: number;
  oldestDiskWaitMs: number;
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
  /** 活跃上游回源数 */
  private activeUpstreams = 0;
  /** 活跃上游租约 */
  private readonly upstreamLeases = new Map<string, DownloadUpstreamLease>();

  private pollTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  private config: DownloadResourceConfig = {
    minFreeBytes: 0,
    maxReservedBytes: 0,
    queueCapacity: 128,
    queueTimeoutMs: 1_800_000,
    maxConcurrentUpstreams: 8,
    spoolGraceMs: 120_000,
    directWindowBytes: 16 * 1024 * 1024,
    directWaitMs: 60_000,
    taskRetentionMs: 900_000,
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

  /** 兼容既有测试：直接设置活跃上游数（仅测试/诊断使用） */
  setActiveUpstreamCount(value: number): void {
    this.activeUpstreams = Math.max(0, Math.floor(value) || 0);
    this.pumpUpstream();
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** 运行状态快照（管理后台观测） */
  getSnapshot(): DownloadResourceSnapshot {
    return {
      freeBytes: this.probeFreeBytes(),
      minimumFreeBytes: this.config.minFreeBytes,
      reservedRemainingBytes: this.reservedPendingBytes,
      cacheReservedBytes: this.cacheReservedBytes,
      activeReservations: this.reservations.size,
      waitingDiskTasks: this.waitingDisk.length,
      waitingUpstreamTasks: this.waitingUpstream.length,
      activeUpstreams: this.activeUpstreams,
      maxConcurrentUpstreams: this.config.maxConcurrentUpstreams,
      queueCapacity: this.config.queueCapacity,
      oldestDiskWaitMs: this.waitingDisk.length > 0 ? Date.now() - this.waitingDisk[0].enqueuedAt : 0,
      shuttingDown: this.shuttingDown,
    };
  }

  // ---------- 物理空间探测 ----------

  /**
   * 探测物理可用空间（bavail，无特权可用块）。
   * 失败返回 -1（保守按不可用处理，fail-closed）。
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

    const freeBytes = this.probeFreeBytes();
    if (freeBytes < 0) {
      throw this.probeUnavailableError();
    }

    const result = this.tryGrant({ sessionKey, bytes, countsTowardCache, freeBytes });
    if (result.granted) return result.reservation;
    if (result.structural) throw this.insufficientStorageError(result.reason, bytes, freeBytes);

    if (this.waitingDisk.length >= this.config.queueCapacity) {
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
        waiter.reject(this.queueTimeoutError(waiter));
      }, input.waitTimeoutMs);
      timer.unref?.();
      waiter.timer = timer;
      if (input.signal) {
        waiter.abortHandler = () => {
          if (!this.removeDiskWaiter(waiter)) return;
          waiter.settled = true;
          waiter.reject(this.cancelledError('下载任务已取消'));
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
    const freeBytes = this.probeFreeBytes();
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
    if (verdict.ok && activeUpstreams < this.config.maxConcurrentUpstreams && waitingUpstream === 0) {
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
   * 获取上游回源槽位租约（严格 FIFO）。
   * 并发满额时排队等待，超时抛 `DOWNLOAD_SERVER_BUSY`。
   */
  async acquireUpstreamSlot(options?: AcquireUpstreamOptions): Promise<DownloadUpstreamLease> {
    if (this.shuttingDown) throw this.shuttingDownError();
    if (options?.signal?.aborted) throw this.cancelledError('下载任务已取消');
    if (this.activeUpstreams < this.config.maxConcurrentUpstreams) {
      return this.grantUpstreamLease();
    }
    if (this.waitingUpstream.length >= this.config.queueCapacity) {
      throw this.queueFullError('upstream');
    }
    const waitTimeoutMs = options?.waitTimeoutMs ?? this.config.queueTimeoutMs;
    return new Promise<DownloadUpstreamLease>((resolve, reject) => {
      const waiter: UpstreamWaiter = {
        id: randomUUID(),
        enqueuedAt: Date.now(),
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
      }, waitTimeoutMs);
      timer.unref?.();
      waiter.timer = timer;
      if (options?.signal) {
        waiter.abortHandler = () => {
          if (!this.removeUpstreamWaiter(waiter)) return;
          waiter.settled = true;
          waiter.reject(this.cancelledError('下载任务已取消'));
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

  private grantUpstreamLease(): DownloadUpstreamLease {
    this.activeUpstreams += 1;
    const id = randomUUID();
    const service = this;
    let active = true;
    const lease: DownloadUpstreamLease = {
      id,
      get active(): boolean {
        return active;
      },
      release(): void {
        if (!active) return;
        active = false;
        service.upstreamLeases.delete(id);
        service.activeUpstreams = Math.max(0, service.activeUpstreams - 1);
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
    const freeBytes = this.probeFreeBytes();
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
      head.resolve(result.reservation);
    }
    this.stopPollTimer();
  }

  /** 上游队列泵 */
  private pumpUpstream(): void {
    while (
      this.waitingUpstream.length > 0
      && this.activeUpstreams < this.config.maxConcurrentUpstreams
    ) {
      const head = this.waitingUpstream[0];
      if (!this.removeUpstreamWaiter(head)) continue;
      head.settled = true;
      head.resolve(this.grantUpstreamLease());
    }
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
    for (const waiter of this.waitingDisk.splice(0)) {
      this.detachWaiter(waiter);
      if (waiter.settled) continue;
      waiter.settled = true;
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
