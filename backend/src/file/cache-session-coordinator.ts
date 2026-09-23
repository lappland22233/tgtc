/**
 * 缓存会话协调器（FileCacheService 拆分出的非 Nest provider 类）
 *
 * 职责：
 * - CacheBuildSession / SpoolSession 的创建、运行、teardown 与中止。
 * - 冷回源并发预算（上游租约，来自 DownloadResourceCoordinatorService 的 FIFO 队列）。
 * - 空闲 / 总超时竞速（与 fetchFn 的 Promise.race + 在途连接防泄漏）。
 * - follower 流：消费者从临时文件 offset 0 独立跟随读取。
 *
 * 设计说明：
 * - 非 @Injectable，由 FileCacheService 在构造时创建并注入依赖。
 * - 持有 buildSessions / spoolSessions / shuttingDown 等会话状态，
 *   FileCacheService 通过 getter 暴露给测试与外部（保持 spec 兼容）。
 * - 磁盘路径/容量等由 CacheDiskManager 提供；fileAccessMap 与 service 共享同一实例。
 * - 磁盘与缓存容量预约、上游并发租约统一由 DownloadResourceCoordinatorService 管理，
 *   leader 会话在创建前取得租约，follower 直接合流不重复占用。
 */
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { Readable } from 'stream';
import { createWriteStream } from 'fs';
import { promises as fsp } from 'fs';
import { FileHandle } from 'fs/promises';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { CacheDiskManager } from './cache-disk-manager';
import {
  DownloadResourceCoordinatorService,
  type DownloadReservation,
  type DownloadUpstreamLease,
} from './download-resource-coordinator.service';

export interface CacheBuildSession {
  fileId: string;
  expectedSize: number;
  /** 内容版本（覆盖上传时递增）：用于避免复用过期内容的会话 */
  contentVersion?: string | number;
  tmpPath: string;
  bytesWritten: number;
  completed: boolean;
  error?: Error;
  events: EventEmitter;
  completion: Promise<void>;
  abort: (error: Error) => void;
  upstream?: Readable;
  output?: ReturnType<typeof createWriteStream>;
}

/**
 * 无缓存直通 / 容量不足场景的「可重放 spool」会话（C-04 修复）。
 *
 * 与 CacheBuildSession 的区别：
 * - 写入独立 `.spool` 临时文件，**完成后不发布为正式缓存**（rename），
 *   而是保留 spool 文件直到所有消费者关闭，保证迟到消费者可从 offset 0 完整重放；
 * - 每个消费者通过 createSpoolFollowerStream 从 offset 0 独立跟随读取，
 *   绝不把已前进的 live source 直接 pipe 给后加入的消费者；
 * - 磁盘无法建立 spool 时，各消费者独立回源（不共享已前进的上游流）。
 */
export interface SpoolSession {
  fileId: string;
  expectedSize: number;
  /** 内容版本（覆盖上传时递增）：用于避免复用过期内容的会话 */
  contentVersion?: string | number;
  spoolPath: string;
  bytesWritten: number;
  completed: boolean;
  error?: Error;
  events: EventEmitter;
  completion: Promise<void>;
  abort: (error: Error) => void;
  upstream?: Readable;
  output?: ReturnType<typeof createWriteStream>;
  /** 活跃消费者数；完成后全部离开时进入宽限保活 */
  consumerCount: number;
  /** 最后一个消费者离开后的延迟清理 timer */
  teardownTimer?: NodeJS.Timeout;
}

export interface SessionCoordinatorDeps {
  diskManager: CacheDiskManager;
  fileAccessMap: Map<string, number>;
  logger: Logger;
  /** 关闭信号：置位后不再新建 build/spool 会话，正在进行的会话按策略收尾 */
  isShuttingDown: () => boolean;
  setShuttingDown: (value: boolean) => void;
  /**
   * 下载资源协调器（DI 单例）：磁盘/缓存逻辑容量预约与上游并发租约。
   * 统一在此处申请，保证 build 与 spool 走同一套预算与 FIFO 队列。
   */
  resources: DownloadResourceCoordinatorService;
}

/** leader 会话所需的资源集合（会话创建前申请，会话结束时释放） */
export interface SessionResourceLease {
  reservation: DownloadReservation;
  upstream: DownloadUpstreamLease;
  /** 释放全部资源（幂等） */
  release(): void;
}

/**
 * follower 读块大小（字节）。
 *
 * 与历史实现一致（256KiB），同时兼作 follower 流的 `highWaterMark`：
 * 水位线等于单块大小时，流内最多只有一块数据，缓冲复用的判定条件才成立。
 */
const FOLLOWER_READ_CHUNK_BYTES = 256 * 1024;

/** direct（有界滚动直通）窗口下限（字节） */
const DIRECT_WINDOW_MIN_BYTES = 1 * 1024 * 1024;
/**
 * direct 窗口硬上限（字节）。
 *
 * 与 `DOWNLOAD_CONFIG_RANGES[DIRECT_WINDOW_MB]`（1-4 MiB）保持一致：
 * 字节模式下的 `highWaterMark` 是**内存上限**，任何来源的越界值都必须被收敛。
 */
const DIRECT_WINDOW_MAX_BYTES = 4 * 1024 * 1024;

/** direct 流释放原因（首个生效者被记录，用于解释租约何时归还） */
type DirectReleaseReason = 'relay_completed' | 'upstream_error' | 'stream_closed' | 'caller';

/**
 * follower 数据源（spool / build 两种会话的差异全部收敛于此）。
 *
 * 所有权契约：`readInto` 写入的缓冲由读取器提供，push 之后其所有权**完全移交下游**，
 * 读取器不再触碰（因此下一块必须新分配缓冲）。详见 `createFollowerReadable()` 的说明。
 */
interface FollowerReadSource {
  /** 请求范围起点（含） */
  start: number;
  /** 请求范围终点（含） */
  end: number;
  /** 当前已写入、可供读取的字节上限 */
  readLimit: () => number;
  /** 会话错误（有值时按流错误抛出） */
  getError: () => Error | undefined;
  /** 是否已到终止条件（不会再产生新数据） */
  isTerminal: (offset: number) => boolean;
  /** 读取 `bytes` 字节到 `buffer` 的 `fileOffset` 位置，返回实际读取字节数 */
  readInto: (buffer: Buffer, fileOffset: number, bytes: number) => Promise<number>;
  /** 等待会话产生新数据（progress / complete / failed），禁止忙轮询 */
  waitForChange: (offset: number) => Promise<void>;
}

export class CacheSessionCoordinator {
  /** 同一业务文件只允许一个上游回源；消费者从临时文件独立跟随读取。 */
  readonly buildSessions = new Map<string, CacheBuildSession>();
  /** 可重放 spool 会话（无缓存直通 / 容量不足时使用）。 */
  readonly spoolSessions = new Map<string, SpoolSession>();
  /**
   * 构建首字节超时（毫秒）：只覆盖「等待 Telegram 返回第一个数据块」的阶段。
   * 冷文件需要 TDLib 先回源，必须显著长于传输空闲超时；0 表示禁用。
   */
  buildFirstByteTimeoutMs = this.readNonNegativeTimeout('FILE_CACHE_BUILD_FIRST_BYTE_TIMEOUT_MS', 210_000);
  /** 构建空闲超时（毫秒）：传输期间无数据则中止会话；每收到数据即刷新 */
  buildIdleTimeoutMs = this.readPositiveTimeout('FILE_CACHE_BUILD_IDLE_TIMEOUT_MS', 150_000);
  /**
   * 构建总超时（毫秒）：**0 表示禁用**（默认）。
   *
   * 历史实现固定 30 分钟，且从会话开始计时、不随进度刷新，导致 4GiB 文件在平均速度
   * 低于约 2.28MiB/s 时必然被误杀——即使全程都有数据。卡死由首字节/空闲超时判定，
   * 需要绝对上限的场景再显式配置。
   */
  buildTotalTimeoutMs = this.readNonNegativeTimeout('FILE_CACHE_BUILD_TOTAL_TIMEOUT_MS', 0);
  /** spool 宽限期显式覆盖值（测试/诊断使用；未设置时取资源协调器配置，支持热更新） */
  private spoolGraceOverrideMs: number | null = null;
  /** 领导者选举串行化锁（会话键 → 排队链尾） */
  private readonly sessionLocks = new Map<string, Promise<void>>();
  /** 未知大小直通的每文件互斥锁 */
  private readonly directLocks = new Map<string, Promise<void>>();

  // ---------- 观测计数（进程内，单实例语义） ----------
  /** 活跃 direct 直通流数 */
  private activeDirectStreams = 0;
  /** 活跃 direct 流的窗口字节总量（= 直通路径的潜在外部内存上限） */
  private activeDirectWindowBytes = 0;
  /** follower 读缓冲分配累计次数（256KiB/次；用于区分「复用生效」与「逐块新分配」） */
  private followerBufferAllocations = 0;

  constructor(private readonly deps: SessionCoordinatorDeps) {}

  private get logger(): Logger {
    return this.deps.logger;
  }

  private get diskManager(): CacheDiskManager {
    return this.deps.diskManager;
  }

  private get resources(): DownloadResourceCoordinatorService {
    return this.deps.resources;
  }

  private get fileAccessMap(): Map<string, number> {
    return this.deps.fileAccessMap;
  }

  /** 活跃 direct 直通流数（观测） */
  get activeDirectStreamCount(): number {
    return this.activeDirectStreams;
  }

  /** 活跃 direct 流的窗口字节总量（观测：直通路径的外部内存上限） */
  get activeDirectWindowBytesTotal(): number {
    return this.activeDirectWindowBytes;
  }

  /** follower 读缓冲分配累计次数（观测：内存压力的直接来源） */
  get followerBufferAllocationCount(): number {
    return this.followerBufferAllocations;
  }

  /** 活跃 build 会话数（每个会话至少有一个 follower 消费者） */
  get activeBuildSessionCount(): number {
    return this.buildSessions.size;
  }

  /** 活跃 spool 会话数 */
  get activeSpoolSessionCount(): number {
    return this.spoolSessions.size;
  }

  /** 活跃 spool 消费者流数 */
  get activeSpoolConsumerCount(): number {
    let total = 0;
    for (const session of this.spoolSessions.values()) total += session.consumerCount;
    return total;
  }

  private get shuttingDown(): boolean {
    return this.deps.isShuttingDown();
  }

  private readPositiveTimeout(key: string, fallback: number): number {
    const value = Number(process.env[key]);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }

  /**
   * 读取非负超时配置：0 是合法值，表示「禁用该超时」。
   * 只有非法值（NaN / 负数 / 非整数 / 空串）才回退默认值。
   */
  private readNonNegativeTimeout(key: string, fallback: number): number {
    const raw = process.env[key];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  }

  /** 当前活跃上游回源数（来自资源协调器的租约计数） */
  get activeUpstreams(): number {
    return this.resources.activeUpstreamCount;
  }

  /** 兼容既有测试：直接设置活跃上游数（仅测试/诊断使用） */
  set activeUpstreams(value: number) {
    this.resources.setActiveUpstreamCount(value);
  }

  /** 上游并发预算（来自资源协调器配置） */
  get maxConcurrentUpstreams(): number {
    return this.resources.getConfig().maxConcurrentUpstreams;
  }

  set maxConcurrentUpstreams(value: number) {
    this.resources.configure({ maxConcurrentUpstreams: Math.max(1, Math.floor(value) || 1) });
  }

  /**
   * 是否允许开启新的冷回源（关闭中或**权重预算**已满则返回 false）。
   * 注意：准入的唯一权威是 `DownloadResourceCoordinatorService.acquireUpstreamSlot`；
   * 本方法只用于粗粒度判断，不可用于「已持有租约」的 leader 路径（会把自己的租约算进去）。
   */
  canStartUpstream(): boolean {
    if (this.shuttingDown) return false;
    const budget = Math.max(1, this.resources.getConfig().maxConcurrentUpstreams);
    return this.resources.activeUpstreamWeightTotal < budget;
  }

  /**
   * spool 最后一个消费者离开后的会话复用宽限期（毫秒）。
   * 默认取资源协调器配置（FILE_DOWNLOAD_SPOOL_GRACE_SECONDS，热更新生效）；
   * 显式赋值用于测试/诊断覆盖。
   */
  get spoolConsumerGracePeriodMs(): number {
    return this.spoolGraceOverrideMs ?? this.resources.getConfig().spoolGraceMs;
  }

  set spoolConsumerGracePeriodMs(value: number) {
    this.spoolGraceOverrideMs = value;
  }

  /**
   * 等待上游并发名额（兼容既有调用/测试）：等待到有名额后立即归还，
   * 真正的名额占用由 `acquireSessionResources` 取得的租约负责。
   */
  async waitForUpstreamSlot(timeoutMs = 60_000): Promise<boolean> {
    if (this.shuttingDown) return false;
    try {
      const lease = await this.resources.acquireUpstreamSlot({ waitTimeoutMs: timeoutMs });
      lease.release();
      return true;
    } catch {
      return false;
    }
  }

  /** buildFirstByteTimeoutMs 供测试覆盖 */
  setBuildFirstByteTimeoutMs(value: number): void {
    this.buildFirstByteTimeoutMs = value;
  }

  /** buildIdleTimeoutMs 供测试覆盖 */
  setBuildIdleTimeoutMs(value: number): void {
    this.buildIdleTimeoutMs = value;
  }

  /** buildTotalTimeoutMs 供测试覆盖 */
  setBuildTotalTimeoutMs(value: number): void {
    this.buildTotalTimeoutMs = value;
  }

  /**
   * 申请 leader 会话资源：磁盘（可选缓存逻辑容量）预约 + 上游并发租约。
   * 先取磁盘预约再取上游名额（等待磁盘期间不占用 Telegram 连接）；
   * 上游等待失败时归还磁盘预约，避免预约泄漏。
   */
  async acquireSessionResources(
    fileId: string,
    expectedSize: number,
    options?: {
      countsTowardCache?: boolean;
      signal?: AbortSignal;
      waitTimeoutMs?: number;
      contentVersion?: string | number;
    },
  ): Promise<SessionResourceLease> {
    const reservation = await this.resources.reserve({
      sessionKey: this.buildSessionKey(fileId, options?.contentVersion),
      bytes: expectedSize,
      countsTowardCache: options?.countsTowardCache ?? false,
      signal: options?.signal,
      waitTimeoutMs: options?.waitTimeoutMs,
    });
    let upstream: DownloadUpstreamLease;
    try {
      upstream = await this.resources.acquireUpstreamSlot({
        signal: options?.signal,
        waitTimeoutMs: options?.waitTimeoutMs,
        // 大文件按体量占用更多并发预算，避免 3×4GiB 冷分卷同秒全部回源
        bytes: expectedSize,
      });
    } catch (error) {
      reservation.release();
      throw error;
    }
    let released = false;
    return {
      reservation,
      upstream,
      release: () => {
        if (released) return;
        released = true;
        reservation.release();
        upstream.release();
      },
    };
  }

  /** 预约会话键：fileId + 内容版本（覆盖上传后不与旧会话共用预算） */
  private buildSessionKey(fileId: string, contentVersion?: string | number): string {
    return contentVersion === undefined ? `file:${fileId}` : `file:${fileId}:v${contentVersion}`;
  }

  /** 会话键（公开给 FileCacheService 做领导者选举串行化） */
  sessionKeyFor(fileId: string, contentVersion?: string | number): string {
    return this.buildSessionKey(fileId, contentVersion);
  }

  /**
   * 按会话键串行化「冷回源领导者选举」。
   *
   * 为什么需要：`getOrCacheStream` 的会话查找与资源申请之间存在 await 窗口，
   * 两个并发请求可能都判定「无活动会话」，各自申请完整磁盘预约与上游槽位，
   * 后者再在 `getOrCreateBuildSession` 中释放并降级为 follower——瞬时双占用会污染
   * 排队与运行指标，对 4GiB 这种「整块磁盘」的请求尤其危险。
   * 串行化后，第二个请求在锁内复查会话并直接合流为 follower。
   */
  async withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.sessionLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => gate, () => gate);
    this.sessionLocks.set(key, queued);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      // 队列已空则清理，避免 Map 按会话键无界增长
      if (this.sessionLocks.get(key) === queued) this.sessionLocks.delete(key);
    }
  }

  /**
   * 未知大小直通的每文件互斥（带有限等待）。
   *
   * 未知大小无法预估磁盘占用，也就无法用 build/spool 去重；若放任并发，
   * 同一文件的多个请求会各自建立一条 Telegram 上游连接。等待超过 `waitTimeoutMs`
   * 时返回 null，由调用方返回结构化「服务器繁忙 + Retry-After」，绝不把请求挂死。
   */
  async acquireDirectLock(fileId: string, waitTimeoutMs: number): Promise<(() => void) | null> {
    const deadline = Date.now() + Math.max(0, waitTimeoutMs);
    for (;;) {
      const current = this.directLocks.get(fileId);
      if (!current) {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        this.directLocks.set(fileId, gate);
        return () => {
          if (this.directLocks.get(fileId) === gate) this.directLocks.delete(fileId);
          release();
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await Promise.race([
        current,
        new Promise<void>(resolve => {
          const timer = setTimeout(resolve, Math.min(remaining, 250));
          timer.unref?.();
        }),
      ]);
    }
  }

  /**
   * 会话内容是否与本次请求一致。
   * 任一侧未提供版本时保持既有行为（不因版本缺失而重建会话）。
   */
  private sameContentVersion(
    session: { contentVersion?: string | number },
    contentVersion?: string | number,
  ): boolean {
    if (contentVersion === undefined || session.contentVersion === undefined) return true;
    return String(session.contentVersion) === String(contentVersion);
  }

  // ---------- build 会话 ----------

  /**
   * 创建（或复用）正式缓存构建会话。
   * - 已存在同文件会话：视为 follower，立即释放本次申请的资源；
   * - 新建：消费调用方已取得的资源租约（在 runBuildSession 的 finally 中释放）。
   */
  getOrCreateBuildSession(
    fileId: string,
    expectedSize: number,
    fetchFn: () => Promise<{ stream: Readable; info: { file_size: number } }>,
    lease: SessionResourceLease,
    contentVersion?: string | number,
  ): CacheBuildSession {
    let existing = this.buildSessions.get(fileId);
    if (existing && !this.sameContentVersion(existing, contentVersion)) {
      // 覆盖上传：旧会话内容是过期版本，中止并重建，避免向新请求返回旧内容
      this.logger.warn(`文件内容版本已变更，重建缓存构建会话: ${fileId}`);
      existing.abort(new Error('文件内容已更新，缓存构建已中止'));
      if (this.buildSessions.get(fileId) === existing) this.buildSessions.delete(fileId);
      existing = undefined;
    }
    if (existing) {
      // follower：不重复占用磁盘/上游资源
      lease.release();
      if (existing.expectedSize !== expectedSize) throw new Error('活动缓存会话的文件大小不一致');
      return existing;
    }
    // 关闭中拒绝新建。并发预算**不在此判断**：上游名额已由 acquireSessionResources 通过
    // 权重预算（acquireUpstreamSlot）唯一把关；此处再判会因为「连接数 vs 权重预算」单位不一致
    // 而误拒刚拿到租约的 leader（maxConcurrentUpstreams=1 时每个 leader 都会失败）。
    if (this.shuttingDown) {
      lease.release();
      throw new ServiceUnavailableException('系统回源繁忙，请稍后重试');
    }

    const events = new EventEmitter();
    events.setMaxListeners(0);
    const session: CacheBuildSession = {
      fileId,
      expectedSize,
      contentVersion,
      tmpPath: `${this.diskManager.getCachePath(fileId)}.${randomUUID()}.tmp`,
      bytesWritten: 0,
      completed: false,
      events,
      completion: Promise.resolve(),
      abort: (error: Error) => {
        if (session?.error || session?.completed) return;
        session!.error = error;
        session!.upstream?.destroy(error);
        session!.output?.destroy();
        session!.events.emit('failed', error);
      },
    };
    this.buildSessions.set(fileId, session);
    session.completion = this.runBuildSession(session, fetchFn, lease);
    session.completion.catch(() => {});
    return session;
  }

  /**
   * 无缓存直通：中止该文件的既有构建会话，实时回源并直通上游流。
   * 同一文件并发消费者共享一个 Telegram 上游连接（in-flight 合并）。
   * 不读缓存、不写正式缓存（无 rename）、不触发 LRU。
   */
  async getNoCacheStream(
    fileId: string,
    expectedSize: number,
    fetchFn: () => Promise<{ stream: Readable; info: { file_size: number } }>,
    start = 0,
    end = expectedSize - 1,
    contentVersion?: string | number,
    options?: { waitTimeoutMs?: number },
  ): Promise<{ stream: Readable; fromCache: boolean }> {
    await this.abortBuildSession(fileId);
    return this.getSpooledStream(fileId, expectedSize, fetchFn, start, end, contentVersion, options);
  }

  /**
   * 中止指定文件的进行中缓存构建会话（不删除已发布的正式缓存文件、不清 fileAccessMap）。
   * 参照 invalidate 的 5 秒赛跑，等待构建收尾（含 .tmp 清理），避免与后续直通流竞态。
   */
  async abortBuildSession(fileId: string): Promise<void> {
    const session = this.buildSessions.get(fileId);
    if (!session) return;
    // 先挂 rejection 处理器再 abort：abort 同步 emit 'failed' 会使 completion reject，
    // 若放到 Promise.race 内才挂载会晚一个微任务，产生 unhandled rejection
    const completionSettled = session.completion.catch(() => {});
    session.abort(new Error('无缓存模式已启用，缓存构建已中止'));
    await Promise.race([
      completionSettled,
      new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 5000);
        timer.unref?.();
      }),
    ]);
  }

  /** 中止所有进行中的缓存构建会话（无缓存模式开启时调用） */
  abortAllBuildSessions(): void {
    const count = this.buildSessions.size;
    if (count === 0) return;
    for (const session of this.buildSessions.values()) {
      session.abort(new Error('无缓存模式已启用，缓存构建已中止'));
      // 防 unhandled rejection：构建收尾会 reject，这里显式吞掉
      session.completion.catch(() => {});
    }
    this.logger.warn(`已中止 ${count} 个进行中的缓存构建会话`);
  }

  private async runBuildSession(
    session: CacheBuildSession,
    fetchFn: () => Promise<{ stream: Readable; info: { file_size: number } }>,
    lease: SessionResourceLease,
  ): Promise<void> {
    const cachePath = this.diskManager.getCachePath(session.fileId);
    let idleTimer: NodeJS.Timeout | undefined;
    let totalTimer: NodeJS.Timeout | undefined;
    let firstByteTimer: NodeJS.Timeout | undefined;
    let rejectTotal: ((error: Error) => void) | undefined;
    // 总时限：0 = 禁用（默认）。禁用时该 Promise 永不 settle，由首字节/空闲超时兜底。
    const totalDeadline = new Promise<never>((_, reject) => { rejectTotal = reject; });
    // 首字节超时：与空闲超时分离，冷启动允许 TDLib 更长时间才吐出首块
    const firstByteDeadline = new Promise<never>((_, reject) => {
      if (this.buildFirstByteTimeoutMs <= 0) return;
      firstByteTimer = setTimeout(() => {
        const error = new Error(`缓存构建首字节超时（${this.buildFirstByteTimeoutMs}ms）`);
        session.abort(error);
        reject(error);
      }, this.buildFirstByteTimeoutMs);
      firstByteTimer.unref?.();
    });
    const resetIdleDeadline = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        session.abort(new Error(`缓存构建空闲超时（${this.buildIdleTimeoutMs}ms）`));
      }, this.buildIdleTimeoutMs);
      idleTimer.unref?.();
    };
    if (this.buildTotalTimeoutMs > 0) {
      totalTimer = setTimeout(() => {
        const error = new Error(`缓存构建总超时（${this.buildTotalTimeoutMs}ms）`);
        session.abort(error);
        rejectTotal?.(error);
      }, this.buildTotalTimeoutMs);
      totalTimer.unref?.();
    }

    let upstreamPromise: Promise<{ stream: Readable; info: { file_size: number } }> | undefined;
    try {
      await fsp.unlink(session.tmpPath).catch(() => {});
      // 在请求上游前先创建临时文件，保证首个进度事件到达时跟随者可安全打开。
      await fsp.writeFile(session.tmpPath, Buffer.alloc(0), { flag: 'wx' });
      // 持有在途上游句柄：若超时先触发，catch 中销毁其 stream 防连接泄漏
      upstreamPromise = fetchFn();
      const { stream, info } = await Promise.race([upstreamPromise, totalDeadline, firstByteDeadline]);
      if (firstByteTimer) {
        clearTimeout(firstByteTimer);
        firstByteTimer = undefined;
      }
      session.upstream = stream;
      resetIdleDeadline();
      if (!Number.isSafeInteger(info.file_size) || info.file_size !== session.expectedSize) {
        stream.destroy();
        throw new Error(`上游文件大小不一致: 期望 ${session.expectedSize}, 实际 ${info.file_size}`);
      }

      const output = createWriteStream(session.tmpPath, { flags: 'r+' });
      session.output = output;
      let outputError: Error | undefined;
      // 必须在首次 write 前监听；destroy() 期间的异步写回调可能晚于 error 事件。
      output.on('error', error => {
        outputError = error;
      });
      try {
        for await (const rawChunk of stream) {
          resetIdleDeadline();
          if (session.error) throw session.error;
          if (outputError) throw outputError;
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          if (session.bytesWritten + chunk.length > session.expectedSize) {
            throw new Error('上游流超过预期文件大小');
          }
          await new Promise<void>((resolve, reject) => {
            output.write(chunk, error => {
              if (error || outputError) reject(error ?? outputError);
              else resolve();
            });
          });
          if (outputError) throw outputError;
          session.bytesWritten += chunk.length;
          // 已写入字节由 statfs 反映，同步核销逻辑预约（避免物理/逻辑双重扣减）
          lease.reservation.consume(chunk.length);
          session.events.emit('progress');
          resetIdleDeadline();
        }
        if (idleTimer) clearTimeout(idleTimer);
        if (outputError) throw outputError;
        await new Promise<void>((resolve, reject) => {
          output.once('error', reject);
          output.end(() => outputError ? reject(outputError) : resolve());
        });
      } catch (error) {
        stream.destroy();
        output.destroy();
        throw error;
      }

      if (session.error) throw session.error;
      const stat = await fsp.stat(session.tmpPath);
      if (session.bytesWritten !== session.expectedSize || stat.size !== session.expectedSize) {
        throw new Error(`缓存文件大小不一致: 期望 ${session.expectedSize}, 实际 ${stat.size}`);
      }
      // G4-06：Windows 下 follower 的读句柄可能仍短暂占用临时文件，
      // rename 会抛 EPERM/EBUSY；做有限退避重试，避免整次回源失败。
      await this.renameWithRetry(session.tmpPath, cachePath);
      // 先登记已发布缓存、再释放缓存逻辑容量占位，保证计数切换无空窗
      this.diskManager.registerCache(session.fileId, session.expectedSize);
      this.fileAccessMap.set(session.fileId, Date.now());
      session.completed = true;
      session.events.emit('progress');
      session.events.emit('complete');
      this.logger.log(`实时缓存构建完成: ${session.fileId} (${session.expectedSize} bytes)`);
    } catch (error) {
      session.error = error instanceof Error ? error : new Error('缓存构建失败');
      // 总超时竞态：fetchFn 可能仍在飞行，settle 后立即销毁其 stream 防连接泄漏
      upstreamPromise?.then(({ stream: s }) => s.destroy()).catch(() => {});
      session.upstream?.destroy();
      session.output?.destroy();
      await fsp.unlink(session.tmpPath).catch(() => {});
      session.events.emit('failed', session.error);
      throw session.error;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      if (firstByteTimer) clearTimeout(firstByteTimer);
      session.upstream = undefined;
      session.output = undefined;
      // 任意分支（成功/失败/超时/中止/关闭）都必须归还剩余预约与上游租约
      lease.release();
      setImmediate(() => {
        if (this.buildSessions.get(session.fileId) === session) {
          this.buildSessions.delete(session.fileId);
        }
        session.events.removeAllListeners();
      });
    }
  }

  // ---------- spool 会话 ----------

  /** 获取/创建 spool 会话，返回从 offset 0 独立跟随读取的消费者流 */
  async getSpooledStream(
    fileId: string,
    expectedSize: number,
    fetchFn: () => Promise<{ stream: Readable; info: { file_size: number } }>,
    start = 0,
    end = expectedSize - 1,
    contentVersion?: string | number,
    options?: { waitTimeoutMs?: number },
  ): Promise<{ stream: Readable; fromCache: boolean }> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= expectedSize) {
      throw new Error(`非法的 Range: ${start}-${end}`);
    }
    const existing = this.spoolSessions.get(fileId);
    if (
      existing
      && existing.expectedSize === expectedSize
      && this.sameContentVersion(existing, contentVersion)
    ) {
      return { stream: this.createSpoolFollowerStream(existing, start, end), fromCache: false };
    }
    // leader：先申请磁盘预约与上游租约（等待期间不写盘、不占用 Telegram 连接）
    const lease = await this.acquireSessionResources(fileId, expectedSize, {
      countsTowardCache: false,
      contentVersion,
      waitTimeoutMs: options?.waitTimeoutMs,
    });
    try {
      const session = await this.getOrCreateSpoolSession(fileId, expectedSize, fetchFn, lease, contentVersion);
      return { stream: this.createSpoolFollowerStream(session, start, end), fromCache: false };
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  /** 创建 spool 会话；若等待期间已有其他请求建立同文件会话则释放本次资源并复用。 */
  private async getOrCreateSpoolSession(
    fileId: string,
    expectedSize: number,
    fetchFn: () => Promise<{ stream: Readable; info: { file_size: number } }>,
    lease: SessionResourceLease,
    contentVersion?: string | number,
  ): Promise<SpoolSession> {
    const current = this.spoolSessions.get(fileId);
    if (current) {
      if (current.expectedSize === expectedSize && this.sameContentVersion(current, contentVersion)) {
        lease.release();
        return current;
      }
      // 大小不一致（覆盖 / 数据异常）或内容版本已更新：先清理旧 spool 再重建，避免串流过期内容
      await this.teardownSpoolSession(current);
    }
    // 冷回源并发预算（H-06）：关闭中拒绝新建（资源申请已在调用方完成）
    if (this.shuttingDown) {
      lease.release();
      throw new ServiceUnavailableException('系统回源繁忙，请稍后重试');
    }

    const events = new EventEmitter();
    events.setMaxListeners(0);
    const session: SpoolSession = {
      fileId,
      expectedSize,
      contentVersion,
      spoolPath: `${this.diskManager.getCachePath(fileId)}.${randomUUID()}.spool`,
      bytesWritten: 0,
      completed: false,
      events,
      consumerCount: 0,
      completion: Promise.resolve(),
      abort: (error: Error) => {
        if (session?.error || session?.completed) return;
        session!.error = error;
        session!.upstream?.destroy(error);
        session!.output?.destroy();
        session!.events.emit('failed', error);
      },
    };
    this.spoolSessions.set(fileId, session);
    session.completion = this.runSpoolSession(session, fetchFn, lease);
    session.completion.catch(() => {});
    return session;
  }

  private async runSpoolSession(
    session: SpoolSession,
    fetchFn: () => Promise<{ stream: Readable; info: { file_size: number } }>,
    lease: SessionResourceLease,
  ): Promise<void> {
    let idleTimer: NodeJS.Timeout | undefined;
    let totalTimer: NodeJS.Timeout | undefined;
    let firstByteTimer: NodeJS.Timeout | undefined;
    const resetIdleDeadline = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        session.abort(new Error(`spool 写入空闲超时（${this.buildIdleTimeoutMs}ms）`));
      }, this.buildIdleTimeoutMs);
      idleTimer.unref?.();
    };
    let rejectTotal: ((error: Error) => void) | undefined;
    // 总时限：0 = 禁用（默认）；首字节超时独立计时
    const totalDeadline = new Promise<never>((_, reject) => { rejectTotal = reject; });
    const firstByteDeadline = new Promise<never>((_, reject) => {
      if (this.buildFirstByteTimeoutMs <= 0) return;
      firstByteTimer = setTimeout(() => {
        const error = new Error(`spool 首字节超时（${this.buildFirstByteTimeoutMs}ms）`);
        session.abort(error);
        reject(error);
      }, this.buildFirstByteTimeoutMs);
      firstByteTimer.unref?.();
    });
    if (this.buildTotalTimeoutMs > 0) {
      totalTimer = setTimeout(() => {
        const error = new Error(`spool 写入总超时（${this.buildTotalTimeoutMs}ms）`);
        session.abort(error);
        rejectTotal?.(error);
      }, this.buildTotalTimeoutMs);
      totalTimer.unref?.();
    }

    let upstreamPromise: Promise<{ stream: Readable; info: { file_size: number } }> | undefined;
    try {
      await fsp.unlink(session.spoolPath).catch(() => {});
      // 在请求上游前先创建 spool 文件，保证首个进度事件到达时跟随者可安全打开。
      await fsp.writeFile(session.spoolPath, Buffer.alloc(0), { flag: 'wx' });
      // 与 build 路径一致的竞速保护：上游无响应时按总超时失败，
      // 避免会话永久卡在 fetchFn 导致租约永不归零。
      upstreamPromise = fetchFn();
      const { stream, info } = await Promise.race([upstreamPromise, totalDeadline, firstByteDeadline]);
      if (firstByteTimer) {
        clearTimeout(firstByteTimer);
        firstByteTimer = undefined;
      }
      // 竞态防护：等待上游期间会话可能已随最后一个消费者离开而被 teardown，
      // 此时直接释放刚获取的上游，避免连接泄漏。
      if (this.spoolSessions.get(session.fileId) !== session) {
        stream.destroy();
        return;
      }
      session.upstream = stream;
      resetIdleDeadline();
      if (!Number.isSafeInteger(info.file_size) || info.file_size !== session.expectedSize) {
        stream.destroy();
        throw new Error(`上游文件大小不一致: 期望 ${session.expectedSize}, 实际 ${info.file_size}`);
      }

      const output = createWriteStream(session.spoolPath, { flags: 'r+' });
      session.output = output;
      let outputError: Error | undefined;
      // 必须在首次 write 前监听；destroy() 期间的异步写回调可能晚于 error 事件。
      output.on('error', error => {
        outputError = error;
      });
      try {
        for await (const rawChunk of stream) {
          resetIdleDeadline();
          if (session.error) throw session.error;
          if (outputError) throw outputError;
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          if (session.bytesWritten + chunk.length > session.expectedSize) {
            throw new Error('上游流超过预期文件大小');
          }
          await new Promise<void>((resolve, reject) => {
            output.write(chunk, error => {
              if (error || outputError) reject(error ?? outputError);
              else resolve();
            });
          });
          if (outputError) throw outputError;
          session.bytesWritten += chunk.length;
          // 已写入字节由 statfs 反映，同步核销逻辑预约
          lease.reservation.consume(chunk.length);
          session.events.emit('progress');
          resetIdleDeadline();
        }
        if (idleTimer) clearTimeout(idleTimer);
        if (outputError) throw outputError;
        await new Promise<void>((resolve, reject) => {
          output.once('error', reject);
          output.end(() => outputError ? reject(outputError) : resolve());
        });
      } catch (error) {
        stream.destroy();
        output.destroy();
        throw error;
      }

      if (session.error) throw session.error;
      const stat = await fsp.stat(session.spoolPath);
      if (session.bytesWritten !== session.expectedSize || stat.size !== session.expectedSize) {
        throw new Error(`spool 文件大小不一致: 期望 ${session.expectedSize}, 实际 ${stat.size}`);
      }
      session.completed = true;
      session.events.emit('progress');
      session.events.emit('complete');
      this.logger.log(`spool 构建完成: ${session.fileId} (${session.expectedSize} bytes)`);
    } catch (error) {
      session.error = error instanceof Error ? error : new Error('spool 构建失败');
      // 总超时竞态：fetchFn 可能仍在飞行，settle 后立即销毁其 stream 防连接泄漏
      upstreamPromise?.then(({ stream: s }) => s.destroy()).catch(() => {});
      session.upstream?.destroy();
      session.output?.destroy();
      // 上游错误/超时必须立即清理，不受消费者宽限期影响。
      if (session.teardownTimer) {
        clearTimeout(session.teardownTimer);
        session.teardownTimer = undefined;
      }
      await fsp.unlink(session.spoolPath).catch(() => {});
      if (this.spoolSessions.get(session.fileId) === session) {
        this.spoolSessions.delete(session.fileId);
      }
      session.events.emit('failed', session.error);
      throw session.error;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      if (firstByteTimer) clearTimeout(firstByteTimer);
      session.upstream = undefined;
      session.output = undefined;
      // 会话结束（完成/失败/并发抢占退出）归还剩余磁盘预约与上游租约；
      // spool 文件在宽限期后才真正删除，其保留期占用已体现在物理空闲中。
      lease.release();
    }
  }

  /**
   * 有界滚动缓冲直通（direct 模式）：
   * 完整暂存（build/spool）在当前卷无论如何都无法满足时使用，保证「已上传的文件始终可下载」。
   * - 不写本地副本，内存占用由 Node 流的背压（highWaterMark）约束，与文件大小无关；
   * - 上游流式端点不支持 Range，因此 Range 请求从首部读取并丢弃 start 之前的字节，
   *   仍由调用方返回正确的 206 响应头；
   * - 不发布正式缓存、不参与 follower 重放，仅受上游并发租约约束。
   */
  async getDirectStream(
    fileId: string,
    fetchFn: () => Promise<{ stream: Readable; info: { file_size: number } }>,
    start = 0,
    end?: number,
    options?: { signal?: AbortSignal; waitTimeoutMs?: number; windowBytes?: number; expectedSize?: number },
  ): Promise<{ stream: Readable; release: () => void }> {
    const lease = await this.resources.acquireUpstreamSlot({
      signal: options?.signal,
      waitTimeoutMs: options?.waitTimeoutMs,
      bytes: options?.expectedSize,
    });
    let upstream: Readable;
    try {
      upstream = (await fetchFn()).stream;
    } catch (error) {
      lease.release();
      throw error;
    }

    this.logger.log(
      `有界滚动缓冲直通: ${fileId}${start > 0 || end !== undefined ? ` range=${start}-${end ?? 'EOF'}` : ''}`,
    );

    // 有界缓冲窗口：只允许窗口大小的预读（highWaterMark），内存占用与文件大小无关。
    // 显式规范化：任何来源（配置热更新 / 调用方覆盖）都必须落在 [1MiB, 4MiB]，
    // 避免单请求异常配置重新制造大块外部内存。
    const windowBytes = this.normalizeDirectWindow(options?.windowBytes);
    this.activeDirectStreams += 1;
    this.activeDirectWindowBytes += windowBytes;

    /**
     * 释放上游连接与并发租约（幂等）。
     * 三个终止分支（消费者关闭 / 上游报错 / 生成器正常结束）都会走到这里，
     * 但只有第一次调用生效，且记录首个释放原因供观测归因。
     */
    let released = false;
    const release = (reason: DirectReleaseReason) => {
      if (released) return;
      released = true;
      this.activeDirectStreams = Math.max(0, this.activeDirectStreams - 1);
      this.activeDirectWindowBytes = Math.max(0, this.activeDirectWindowBytes - windowBytes);
      upstream.destroy();
      lease.release();
      this.logger.debug(
        `有界滚动缓冲直通释放: ${fileId} reason=${reason} window=${windowBytes}B`
          + `${options?.expectedSize ? ` size=${options.expectedSize}` : ''}`
          + `${start > 0 || end !== undefined ? ` range=${start}-${end ?? 'EOF'}` : ''}`,
      );
    };

    const stream = Readable.from((async function* relay(): AsyncGenerator<Buffer> {
      let offset = 0;
      try {
        for await (const raw of upstream) {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
          const chunkStart = offset;
          offset += chunk.length;
          // 已越过请求范围末尾：停止后续读取（上游随之释放）
          if (end !== undefined && chunkStart > end) break;
          let sliceStart = 0;
          if (chunkStart < start) sliceStart = Math.min(chunk.length, start - chunkStart);
          if (sliceStart >= chunk.length) continue;
          const sliceEnd = end === undefined
            ? chunk.length
            : Math.min(chunk.length, end - chunkStart + 1);
          if (sliceEnd <= sliceStart) continue;
          yield chunk.subarray(sliceStart, sliceEnd);
        }
      } catch (error) {
        release('upstream_error');
        throw error;
      } finally {
        release('relay_completed');
      }
    })(), {
      // 必须是**字节模式**：object-mode 下 `highWaterMark` 表示「可排队对象数量」，
      // 会把 16（= 16MiB 的数值）误当成「可以排队 16 个任意大小的块」，内存无界。
      objectMode: false,
      highWaterMark: windowBytes,
    });

    // 消费者提前断开（浏览器取消、代理超时）时也要释放上游连接与租约
    stream.once('close', () => release('stream_closed'));
    return { stream, release: () => release('caller') };
  }

  /** 规范化 direct 窗口：非有限值/越界值一律收敛到 [1MiB, 4MiB]（字节模式水位线） */
  private normalizeDirectWindow(override?: number): number {
    const fallback = this.resources.getConfig().directWindowBytes;
    const candidate = typeof override === 'number' && Number.isFinite(override) && override > 0
      ? override
      : fallback;
    return Math.min(DIRECT_WINDOW_MAX_BYTES, Math.max(DIRECT_WINDOW_MIN_BYTES, Math.floor(candidate)));
  }

  /** 新增一个按指定 Range 独立跟随读取的消费者流。 */
  private createSpoolFollowerStream(
    session: SpoolSession,
    start = 0,
    end = session.expectedSize - 1,
  ): Readable {
    const coordinator = this;
    if (session.teardownTimer) {
      clearTimeout(session.teardownTimer);
      session.teardownTimer = undefined;
    }
    const stream = coordinator.createFollowerReadable(session.fileId, {
      start,
      end,
      readLimit: () => session.bytesWritten,
      getError: () => session.error,
      isTerminal: () => session.completed,
      readInto: (buffer, fileOffset, bytes) => coordinator.readFollowerBytes(
        () => session.spoolPath,
        // spool 文件在整个保活期内路径不变：仅当会话已完成时才允许重试同路径
        () => (session.completed ? session.spoolPath : null),
        buffer,
        fileOffset,
        bytes,
      ),
      waitForChange: (offset) => coordinator.waitForSessionChange(
        session,
        () => offset < session.bytesWritten || session.completed || Boolean(session.error),
      ),
    });

    session.consumerCount++;
    stream.once('close', () => {
      session.consumerCount = Math.max(0, session.consumerCount - 1);
      if (session.consumerCount !== 0) return;
      // 上游错误/超时会直接从 runSpoolSession 清理；正常无消费者时保留会话，
      // 让短暂断线后的 Range 请求复用已写入 spool，避免重新连接 Telegram。
      if (session.error || coordinator.shuttingDown) {
        void coordinator.teardownSpoolSession(session);
        return;
      }
      const sessionAtSchedule = session;
      if (session.teardownTimer) clearTimeout(session.teardownTimer);
      session.teardownTimer = setTimeout(() => {
        session.teardownTimer = undefined;
        if (
          coordinator.spoolSessions.get(sessionAtSchedule.fileId) === sessionAtSchedule &&
          sessionAtSchedule.consumerCount === 0 &&
          !sessionAtSchedule.error
        ) {
          void coordinator.teardownSpoolSession(sessionAtSchedule);
        }
      }, coordinator.spoolConsumerGracePeriodMs);
      session.teardownTimer.unref?.();
    });
    return stream;
  }

  /** 清理 spool 会话：删除 spool 文件并从 map 移除（幂等） */
  async teardownSpoolSession(session: SpoolSession): Promise<void> {
    if (session.teardownTimer) {
      clearTimeout(session.teardownTimer);
      session.teardownTimer = undefined;
    }
    if (this.spoolSessions.get(session.fileId) === session) {
      this.spoolSessions.delete(session.fileId);
    }
    session.upstream?.destroy();
    session.output?.destroy();
    await fsp.unlink(session.spoolPath).catch(() => {});
    session.events.removeAllListeners();
  }

  // ---------- 发布辅助 ----------

  /**
   * 有限退避重试的 rename（G4-06）。
   * Windows 上临时文件可能被 follower 的读句柄短暂占用，rename 会抛 EPERM/EBUSY。
   * 最多重试 5 次（约 620ms），仍失败则抛错（由调用方 catch 清理临时文件）。
   */
  private async renameWithRetry(from: string, to: string): Promise<void> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; ; attempt++) {
      try {
        await fsp.rename(from, to);
        return;
      } catch (error: unknown) {
        const code = (error as { code?: string }).code;
        const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
        if (attempt >= MAX_ATTEMPTS || !retryable) throw error;
        await new Promise(resolve => setTimeout(resolve, 20 * attempt));
      }
    }
  }

  // ---------- follower / 等待 ----------

  private waitForSessionChange(
    session: Pick<CacheBuildSession, 'events'> | Pick<SpoolSession, 'events'>,
    isReady?: () => boolean,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        session.events.off('progress', onProgress);
        session.events.off('failed', onFailed);
      };
      const onProgress = () => {
        cleanup();
        resolve();
      };
      const onFailed = (error: Error) => {
        cleanup();
        reject(error);
      };
      session.events.once('progress', onProgress);
      session.events.once('failed', onFailed);
      // 注册监听后再次检查状态，封闭“先检查、后监听”窗口，避免错过唯一一次进度通知。
      if (isReady?.()) {
        cleanup();
        resolve();
      }
    });
  }

  async waitForSessionReadable(session: CacheBuildSession): Promise<void> {
    while (session.bytesWritten === 0 && !session.completed && !session.error) {
      await this.waitForSessionChange(
        session,
        () => session.bytesWritten > 0 || session.completed || Boolean(session.error),
      );
    }
    if (session.error) throw session.error;
  }

  /**
   * follower 数据源：spool 与 build 会话的全部差异收敛在这里
   * （可读字节上限、终止条件、读路径与读失败回退）。
   *
   * 内存所有权契约（**硬约束，改动前务必读**）：
   * - 每块数据由**独立分配**的缓冲承载，push 后其所有权完全移交下游；
   * - **禁止复用已 push 的缓冲**。`readableLength === 0` 只说明数据已离开本流的内部缓冲，
   *   **不代表下游已释放**：经 `pipeline(stream, res)` 消费时，`res.write()` 会把缓冲留在
   *   socket 写队列里（尚未刷入内核），此时复用同一块内存会造成**静默内容损坏**
   *   （表现为下载到的字节被后一块覆盖）。
   * - 因此这里不做「固定缓冲 + 复用」优化：相比改造前，仅去掉每次读取的
   *   `Buffer.from(subarray)` 拷贝与每流的常驻缓冲，分配次数与数据块数同阶。
   */
  private createFollowerReadable(fileId: string, source: FollowerReadSource): Readable {
    let offset = source.start;
    let pumping = false;
    let finished = false;
    let destroyed = false;

    const readable = new Readable({
      // 显式字节模式：highWaterMark 是字节上限（不是对象个数）
      objectMode: false,
      highWaterMark: FOLLOWER_READ_CHUNK_BYTES,
      read: () => {
        void pump();
      },
      destroy: (error, callback) => {
        destroyed = true;
        callback(error ?? null);
      },
    });

    const finish = (): void => {
      if (finished) return;
      finished = true;
      readable.push(null);
    };

    const pump = async (): Promise<void> => {
      if (pumping || finished || destroyed) return;
      pumping = true;
      try {
        while (!finished && !destroyed) {
          if (offset > source.end) {
            finish();
            return;
          }
          const limit = source.readLimit();
          if (offset < limit) {
            const available = Math.min(FOLLOWER_READ_CHUNK_BYTES, limit - offset, source.end - offset + 1);
            if (available > 0) {
              // 每块独立分配：push 后所有权移交下游，绝不复用（见方法头部的所有权契约）
              const buffer = this.allocateFollowerBuffer();
              const bytesRead = await source.readInto(buffer, offset, available);
              if (destroyed || finished) return;
              if (bytesRead > 0) {
                offset += bytesRead;
                // 直接把该块内存的视图交给下游（不再 Buffer.from(subarray) 复制）
                if (!readable.push(buffer.subarray(0, bytesRead))) return; // 背压：等下一次 _read
                continue;
              }
            }
          }
          const error = source.getError();
          if (error) throw error;
          if (source.isTerminal(offset)) {
            finish();
            return;
          }
          // 没有新数据可用：等待 progress/complete/failed 事件，绝不忙轮询
          await source.waitForChange(offset);
        }
      } catch (error) {
        finished = true;
        readable.destroy(error as Error);
      } finally {
        pumping = false;
      }
    };

    // 释放会话引用（访问时间回写）：正常结束、错误与消费者提前断开都会走到 close
    readable.once('close', () => {
      destroyed = true;
      this.fileAccessMap.set(fileId, Date.now());
    });
    return readable;
  }

  /**
   * 分配一块 follower 读缓冲并计入观测（内存压力的直接来源）。
   * 每块数据一块缓冲：push 后所有权移交下游，禁止复用（见 `createFollowerReadable`）。
   */
  private allocateFollowerBuffer(): Buffer {
    this.followerBufferAllocations += 1;
    return Buffer.allocUnsafe(FOLLOWER_READ_CHUNK_BYTES);
  }

  /**
   * 从 follower 文件读取一段字节（每轮短暂持有句柄）。
   *
   * `fallbackPath` 为 null 表示「不允许回退重试」；返回非 null 时代表首选路径打开失败
   * 后改用该路径（缓存发布后 tmp 路径消失 → 切到正式缓存路径）。
   */
  private async readFollowerBytes(
    primaryPath: () => string,
    fallbackPath: () => string | null,
    buffer: Buffer,
    fileOffset: number,
    bytes: number,
  ): Promise<number> {
    let handle: FileHandle;
    try {
      handle = await fsp.open(primaryPath(), 'r');
    } catch (error) {
      const fallback = fallbackPath();
      if (!fallback) throw error;
      handle = await fsp.open(fallback, 'r');
    }
    try {
      const { bytesRead } = await handle.read(buffer, 0, bytes, fileOffset);
      return bytesRead;
    } finally {
      await handle.close();
    }
  }

  createFollowerStream(session: CacheBuildSession, start = 0, end = session.expectedSize - 1): Readable {
    const coordinator = this;
    return coordinator.createFollowerReadable(session.fileId, {
      start,
      end,
      readLimit: () => session.bytesWritten,
      getError: () => session.error,
      // 完成且已读到期望大小即为终止（避免缓存文件尾部补齐前的空转等待）
      isTerminal: (offset) => session.completed && offset >= session.expectedSize,
      readInto: (buffer, fileOffset, bytes) => coordinator.readFollowerBytes(
        // 每轮短暂持有句柄，兼容 Windows 上活动读句柄会阻止 rename 的行为。
        // 缓存发布后临时路径消失，自动切换到正式缓存文件。
        () => (session.completed
          ? coordinator.diskManager.getCachePath(session.fileId)
          : session.tmpPath),
        () => (session.completed ? coordinator.diskManager.getCachePath(session.fileId) : null),
        buffer,
        fileOffset,
        bytes,
      ),
      waitForChange: (offset) => coordinator.waitForSessionChange(
        session,
        () => offset < session.bytesWritten || session.completed || Boolean(session.error),
      ),
    });
  }

  /**
   * 应用关闭钩子（H-09/C-04 配套）：
   * 1. 置位关闭信号，不再新建 build/spool 会话（canStartUpstream 返回 false）；
   * 2. 中止全部进行中的缓存构建（abort → 清理 .tmp）；
   * 3. 等待活跃上游回源收尾（最多 3s，超时强制 destroy）；
   * 4. 清理 spool 临时文件并移除监听器。
   */
  async shutdown(): Promise<void> {
    this.deps.setShuttingDown(true);
    this.logger.log(`缓存服务关闭：中止 ${this.buildSessions.size} 个构建会话、${this.spoolSessions.size} 个 spool 会话`);

    for (const session of this.buildSessions.values()) {
      session.abort(new Error('应用关闭，缓存构建已中止'));
      session.completion.catch(() => {});
    }
    // 等待活跃上游收尾（spool 与 build 共用租约计数）
    const deadline = Date.now() + 3000;
    while (this.resources.activeUpstreamCount > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    for (const session of this.spoolSessions.values()) {
      session.upstream?.destroy();
      session.output?.destroy();
      await fsp.unlink(session.spoolPath).catch(() => {});
    }
    this.spoolSessions.clear();
    this.logger.log('缓存服务关闭完成');
  }
}
