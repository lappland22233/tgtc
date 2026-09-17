import { Injectable, Logger, OnApplicationShutdown, ServiceUnavailableException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { Readable } from 'stream';
import { createReadStream, constants as fsConstants } from 'fs';
import { promises as fsp } from 'fs';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { CacheDiskManager } from './cache-disk-manager';
import { CacheSessionCoordinator, type CacheBuildSession, type SessionResourceLease, type SpoolSession } from './cache-session-coordinator';
import {
  DOWNLOAD_CONFIG_DEFAULTS,
  DOWNLOAD_CONFIG_KEYS,
  DOWNLOAD_ERROR_CODES,
  DownloadResourceCoordinatorService,
  DownloadResourceException,
  type DownloadReservation,
  type DownloadResourceSnapshot,
} from './download-resource-coordinator.service';

export const CACHE_CONFIG_KEYS = {
  MAX_SIZE_GB: 'FILE_CACHE_MAX_SIZE_GB',
  MIN_FREE_DISK_GB: 'FILE_CACHE_MIN_FREE_DISK_GB',
  TTL_DAYS: 'FILE_CACHE_TTL_DAYS',
  NO_CACHE_MODE: 'FILE_CACHE_NO_CACHE_MODE',
} as const;

export const CACHE_CONFIG_DEFAULTS: Record<string, string> = {
  [CACHE_CONFIG_KEYS.MAX_SIZE_GB]: '10',
  [CACHE_CONFIG_KEYS.MIN_FREE_DISK_GB]: '1',
  [CACHE_CONFIG_KEYS.TTL_DAYS]: '3',
  [CACHE_CONFIG_KEYS.NO_CACHE_MODE]: 'false',
};

/** 解析非负数值配置（非法值回退默认值） */
function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * 是否属于「结构上无法完整暂存」的拒绝（单文件超过缓存上限、卷内可用空间不足）。
 * 这类情况下不允许拒绝下载，必须降级为有界滚动缓冲直通。
 */
function isInsufficientStorage(error: unknown): boolean {
  return error instanceof DownloadResourceException
    && error.errorCode === DOWNLOAD_ERROR_CODES.INSUFFICIENT_STORAGE;
}

/** 任一侧未提供内容版本时不视为变更（保持既有行为） */
function sameContentVersion(
  sessionVersion: string | number | undefined,
  requestVersion: string | number | undefined,
): boolean {
  if (requestVersion === undefined || sessionVersion === undefined) return true;
  return String(sessionVersion) === String(requestVersion);
}

@Injectable()
export class FileCacheService implements OnApplicationShutdown {
  private readonly logger = new Logger(FileCacheService.name);
  private readonly cacheDir: string;
  /** 磁盘管理器：路径/容量/LRU/过期清理 */
  private readonly diskManager: CacheDiskManager;
  /** 会话协调器：build/spool 会话生命周期、并发预算、超时竞速 */
  private readonly sessionCoordinator: CacheSessionCoordinator;
  /** 下载资源协调器（DI 单例）：磁盘/缓存逻辑容量预约与上游 FIFO 租约 */
  readonly resources: DownloadResourceCoordinatorService;

  /** 运行时配置（可从管理后台动态调整） */
  private maxCacheSizeBytes = parseInt(CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.MAX_SIZE_GB]) * 1024 * 1024 * 1024;
  private minFreeDiskBytes = parseInt(CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.MIN_FREE_DISK_GB]) * 1024 * 1024 * 1024;
  private cacheTtlMs = parseInt(CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.TTL_DAYS]) * 24 * 60 * 60 * 1000;
  /** 直接下载端点（非任务化）允许的有限等待上限；超时返回结构化错误而非无限悬挂 */
  private directWaitMs = parsePositiveNumber(DOWNLOAD_CONFIG_DEFAULTS[DOWNLOAD_CONFIG_KEYS.DIRECT_WAIT_SECONDS], 60) * 1000;
  /** 下载任务状态保留时间（阶段 B/D 任务服务使用） */
  private taskRetentionMs = parsePositiveNumber(DOWNLOAD_CONFIG_DEFAULTS[DOWNLOAD_CONFIG_KEYS.TASK_RETENTION_SECONDS], 900) * 1000;
  /** 无缓存模式：文件下载实时回源直通，不读写本地缓存（可从管理后台动态调整） */
  private noCacheMode = process.env.FILE_CACHE_NO_CACHE_MODE === 'true';

  /** 关闭信号：置位后不再新建 build/spool 会话，正在进行的会话按策略收尾 */
  private shuttingDown = false;

  /** 文件最近访问时间追踪 (fileId → lastAccessTimestamp)，用于 LRU 淘汰 */
  private readonly fileAccessMap = new Map<string, number>();

  /**
   * 正在被读取的已发布缓存引用计数（fileId → 活跃读者数）。
   * LRU/TTL 清理跳过 pin 中的文件：Windows 下删除打开中的文件会 EBUSY 失败，
   * 且删除会让在途 follower / Range 下载中断。
   */
  private readonly pinnedCacheRefs = new Map<string, number>();

  /** 增加一个缓存读者（返回的流关闭时自动释放） */
  private withCachePin(fileId: string, stream: Readable): Readable {
    this.pinCache(fileId);
    stream.once('close', () => this.unpinCache(fileId));
    return stream;
  }

  private pinCache(fileId: string): void {
    this.pinnedCacheRefs.set(fileId, (this.pinnedCacheRefs.get(fileId) ?? 0) + 1);
  }

  private unpinCache(fileId: string): void {
    const next = (this.pinnedCacheRefs.get(fileId) ?? 0) - 1;
    if (next <= 0) this.pinnedCacheRefs.delete(fileId);
    else this.pinnedCacheRefs.set(fileId, next);
  }

  /** 该 fileId 的缓存当前是否不可淘汰（正在被读取或正在构建/发布中） */
  private isPinnedCache(fileId: string): boolean {
    return this.pinnedCacheRefs.has(fileId) || this.buildSessions.has(fileId);
  }

  /** 会话状态委托（供测试 / 外部检查，保持既有 spec 兼容） */
  get buildSessions(): Map<string, CacheBuildSession> {
    return this.sessionCoordinator.buildSessions;
  }

  get spoolSessions(): Map<string, SpoolSession> {
    return this.sessionCoordinator.spoolSessions;
  }

  get activeUpstreams(): number {
    return this.sessionCoordinator.activeUpstreams;
  }

  set activeUpstreams(value: number) {
    this.sessionCoordinator.activeUpstreams = value;
  }

  get maxConcurrentUpstreams(): number {
    return this.sessionCoordinator.maxConcurrentUpstreams;
  }

  set maxConcurrentUpstreams(value: number) {
    this.sessionCoordinator.maxConcurrentUpstreams = value;
  }

  get buildIdleTimeoutMs(): number {
    return this.sessionCoordinator.buildIdleTimeoutMs;
  }

  set buildIdleTimeoutMs(value: number) {
    this.sessionCoordinator.setBuildIdleTimeoutMs(value);
  }

  get buildTotalTimeoutMs(): number {
    return this.sessionCoordinator.buildTotalTimeoutMs;
  }

  set buildTotalTimeoutMs(value: number) {
    this.sessionCoordinator.setBuildTotalTimeoutMs(value);
  }

  constructor(
    private readonly configCache: ConfigCacheService,
    resources?: DownloadResourceCoordinatorService,
  ) {
    this.cacheDir = (require('path') as typeof import('path')).resolve(process.cwd(), 'tmp', 'Cache');
    // G4-04 增强：启动异步探测缓存目录可写性。mkdir 失败或目录不可写时给出明确告警
    // （运行时 prepareCacheCapacity 遇磁盘满会自动走 spool/直通降级，但启动期应尽早暴露问题）。
    fsp.mkdir(this.cacheDir, { recursive: true })
      .then(() => fsp.access(this.cacheDir, fsConstants.W_OK))
      .catch(() => {
        this.logger.warn(
          `缓存目录不可写或创建失败（${this.cacheDir}）：缓存功能将降级为直通回源，请检查磁盘挂载与权限`,
        );
      });
    this.diskManager = new CacheDiskManager(this.cacheDir);
    // 资源协调器为 Nest 单例（未注入时自建，保持既有单测构造方式可用）：
    // 磁盘/缓存容量预约与上游 FIFO 租约集中在此，避免"模块 provider 一份、手工 new 一份"的双实例。
    this.resources = resources ?? new DownloadResourceCoordinatorService();
    this.resources.setProbeDir(this.cacheDir);
    this.resources.setCacheCapacityProvider(() => ({
      // 首次扫描完成前保守按 0 计；build 路径在此之前已通过 prepareCacheCapacity 触发过扫描
      committedBytes: this.diskManager.getTotalCacheSizeSync() ?? 0,
      maxBytes: this.maxCacheSizeBytes,
    }));
    // 队头因空间阻塞时回收已发布旧缓存（只淘汰已发布项，绝不删除活动临时文件）
    this.resources.setEvictionHook(() => this.evictForWaitingTasks());
    this.sessionCoordinator = new CacheSessionCoordinator({
      diskManager: this.diskManager,
      fileAccessMap: this.fileAccessMap,
      logger: this.logger,
      isShuttingDown: () => this.shuttingDown,
      setShuttingDown: (value: boolean) => { this.shuttingDown = value; },
      resources: this.resources,
    });
    // 预热缓存总量内存计数：容量预约依赖同步计数，启动时先完成一次全目录扫描
    void this.diskManager.getTotalCacheSize().catch(() => {});
    // 异步加载持久化配置
    this.reloadConfig();
  }

  /**
   * 下载资源运行状态快照（管理后台观测）：
   * 磁盘余量、预约量、队列长度、活跃回源、缓存占用与上限。
   */
  getDownloadRuntimeSnapshot(): DownloadResourceSnapshot & {
    cacheCommittedBytes: number;
    cacheMaxBytes: number;
    noCacheMode: boolean;
  } {
    return {
      ...this.resources.getSnapshot(),
      cacheCommittedBytes: this.diskManager.getTotalCacheSizeSync() ?? 0,
      cacheMaxBytes: this.maxCacheSizeBytes,
      noCacheMode: this.noCacheMode,
    };
  }

  /**
   * 只读准入探测：供下载任务服务上报"能否立即开始/排队原因/近似位置"，
   * 不排队、不占用任何预约，避免状态查询影响真实调度。
   */
  probeDownloadAdmission(expectedSize: number, options?: { countsTowardCache?: boolean }): {
    admitted: boolean;
    reason?: string;
    structural: boolean;
    queuePosition: number;
    waitingDiskTasks: number;
    activeUpstreams: number;
    freeBytes: number;
    retryAfterMs: number;
  } {
    return this.resources.probeAdmission(expectedSize, options?.countsTowardCache ?? true);
  }

  /** 队列队头阻塞时回收空间：淘汰已发布缓存直到满足最低余量（节流由协调器负责） */
  private async evictForWaitingTasks(): Promise<void> {
    const evicted = await this.diskManager.evictLRU(this.minFreeDiskBytes, this.fileAccessMap);
    if (evicted > 0) {
      this.logger.log(`下载排队期间 LRU 回收完成: 移除 ${evicted} 个缓存文件`);
    }
  }

  /** 直接下载端点（非任务化）的有限等待上限 */
  get directDownloadWaitMs(): number {
    return this.directWaitMs;
  }

  /** 下载任务状态保留时间（任务服务读取） */
  get downloadTaskRetentionMs(): number {
    return this.taskRetentionMs;
  }

  /** 当前是否处于无缓存模式 */
  isNoCacheMode(): boolean {
    return this.noCacheMode;
  }

  /** 从配置缓存加载阈值 */
  private async reloadConfig(): Promise<void> {
    try {
      const d = DOWNLOAD_CONFIG_KEYS;
      const dd = DOWNLOAD_CONFIG_DEFAULTS;
      const [
        maxSizeStr, minFreeStr, ttlStr, noCacheStr,
        maxReservedStr, upstreamsStr, queueCapacityStr, queueTimeoutStr,
        spoolGraceStr, directWindowStr, directWaitStr, taskRetentionStr,
      ] = await Promise.all([
        this.configCache.get(CACHE_CONFIG_KEYS.MAX_SIZE_GB, CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.MAX_SIZE_GB]),
        this.configCache.get(CACHE_CONFIG_KEYS.MIN_FREE_DISK_GB, CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.MIN_FREE_DISK_GB]),
        this.configCache.get(CACHE_CONFIG_KEYS.TTL_DAYS, CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.TTL_DAYS]),
        this.configCache.get(CACHE_CONFIG_KEYS.NO_CACHE_MODE, CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.NO_CACHE_MODE]),
        this.configCache.get(d.MAX_RESERVED_GB, dd[d.MAX_RESERVED_GB]),
        this.configCache.get(d.MAX_CONCURRENT_UPSTREAMS, dd[d.MAX_CONCURRENT_UPSTREAMS]),
        this.configCache.get(d.QUEUE_CAPACITY, dd[d.QUEUE_CAPACITY]),
        this.configCache.get(d.QUEUE_TIMEOUT_SECONDS, dd[d.QUEUE_TIMEOUT_SECONDS]),
        this.configCache.get(d.SPOOL_GRACE_SECONDS, dd[d.SPOOL_GRACE_SECONDS]),
        this.configCache.get(d.DIRECT_WINDOW_MB, dd[d.DIRECT_WINDOW_MB]),
        this.configCache.get(d.DIRECT_WAIT_SECONDS, dd[d.DIRECT_WAIT_SECONDS]),
        this.configCache.get(d.TASK_RETENTION_SECONDS, dd[d.TASK_RETENTION_SECONDS]),
      ]);
      this.maxCacheSizeBytes = Math.max(1, parseInt(maxSizeStr) || 10) * 1024 * 1024 * 1024;
      this.minFreeDiskBytes = Math.max(0.5, parseFloat(minFreeStr) || 1) * 1024 * 1024 * 1024;
      this.cacheTtlMs = Math.max(1, parseInt(ttlStr) || 3) * 24 * 60 * 60 * 1000;

      // 下载调度配置：热更新只影响后续任务的准入判断，已授予的租约不被撤销
      const maxReservedGb = parsePositiveNumber(maxReservedStr, 0);
      const upstreams = Math.max(1, Math.floor(parsePositiveNumber(upstreamsStr, 8)) || 8);
      const queueCapacity = Math.max(1, Math.floor(parsePositiveNumber(queueCapacityStr, 128)) || 128);
      const queueTimeoutMs = Math.max(1, parsePositiveNumber(queueTimeoutStr, 1800)) * 1000;
      const spoolGraceMs = parsePositiveNumber(spoolGraceStr, 120) * 1000;
      const directWindowBytes = Math.max(1, parsePositiveNumber(directWindowStr, 16)) * 1024 * 1024;
      this.directWaitMs = parsePositiveNumber(directWaitStr, 60) * 1000;
      this.taskRetentionMs = Math.max(60, parsePositiveNumber(taskRetentionStr, 900)) * 1000;
      this.resources.configure({
        minFreeBytes: this.minFreeDiskBytes,
        maxReservedBytes: maxReservedGb > 0 ? maxReservedGb * 1024 * 1024 * 1024 : 0,
        maxConcurrentUpstreams: upstreams,
        queueCapacity,
        queueTimeoutMs,
        spoolGraceMs,
        directWindowBytes,
        directWaitMs: this.directWaitMs,
        taskRetentionMs: this.taskRetentionMs,
      });

      // 无缓存模式翻转：false → true 时中止所有进行中的缓存构建
      const prevNoCacheMode = this.noCacheMode;
      this.noCacheMode = noCacheStr === 'true';
      this.logger.log(
        `缓存配置: 上限 ${this.maxCacheSizeBytes / 1024 / 1024 / 1024}GB, ` +
        `剩余 ${this.minFreeDiskBytes / 1024 / 1024 / 1024}GB, ` +
        `TTL ${this.cacheTtlMs / 86400000}天, ` +
        `无缓存模式 ${this.noCacheMode ? '开启' : '关闭'}`,
      );
      this.logger.log(
        `下载调度配置: 预约上限 ${maxReservedGb > 0 ? `${maxReservedGb}GB` : '不限'}, ` +
        `上游并发 ${upstreams}, 队列容量 ${queueCapacity}, ` +
        `排队超时 ${queueTimeoutMs / 1000}s, spool 宽限期 ${spoolGraceMs / 1000}s, ` +
        `直通窗口 ${directWindowBytes / 1024 / 1024}MB`,
      );
      if (!prevNoCacheMode && this.noCacheMode) {
        this.logger.warn('无缓存模式已启用：中止所有进行中的缓存构建，后续下载实时回源直通');
        this.sessionCoordinator.abortAllBuildSessions();
      }
    } catch (err) {
      this.logger.warn(`加载缓存配置失败，使用默认值: ${(err as Error).message}`);
    }
  }

  /** 配置变更热更新 */
  @OnEvent('config.changed')
  async onConfigChanged(payload: { key: string; value: string }): Promise<void> {
    const keys = this.watchedConfigKeys();
    if (keys.includes(payload.key)) {
      await this.reloadConfig();
    }
  }

  /** 批量配置变更热更新（ConfigCacheService.setBatch 只发此事件） */
  @OnEvent('config.batch-changed')
  async onBatchConfigChanged(payload: { key: string; value: string; description?: string }[]): Promise<void> {
    const keys = this.watchedConfigKeys();
    if (Array.isArray(payload) && payload.some(item => keys.includes(item.key))) {
      await this.reloadConfig();
    }
  }

  /** 需要热更新的配置键（缓存 + 下载调度） */
  private watchedConfigKeys(): string[] {
    return [
      ...Object.values(CACHE_CONFIG_KEYS),
      ...Object.values(DOWNLOAD_CONFIG_KEYS),
    ] as string[];
  }

  /**
   * 获取缓存的读取流。命中返回 Readable，未命中返回 null。
   * 检查文件大小一致性和 TTL 过期。
   */
  getCachedReadStream(fileId: string, expectedSize: number): Readable | null {
    this.validateFileId(fileId);
    if (this.noCacheMode) return null;
    const cachePath = this.getCachePath(fileId);

    try {
      const stat = require('fs').statSync(cachePath);
      if (stat.size !== expectedSize || stat.size <= 0) {
        this.logger.debug(`缓存大小不匹配: ${fileId} (期望 ${expectedSize}, 实际 ${stat.size})`);
        // 删除的同时扣减内存计数，避免缓存总量漂移（plan 3.9）
        this.diskManager.unregisterCache(fileId, stat.size);
        void fsp.unlink(cachePath).catch(() => {});
        return null;
      }
      // TTL 过期检查
      const age = Date.now() - stat.mtimeMs;
      if (age > this.cacheTtlMs) {
        this.logger.debug(`缓存过期: ${fileId} (${Math.round(age / 3600000)}h)`);
        this.diskManager.unregisterCache(fileId, stat.size);
        void fsp.unlink(cachePath).catch(() => {});
        return null;
      }
      this.logger.debug(`缓存命中: ${fileId} (${stat.size} bytes, ${Math.round(age / 3600000)}h)`);
      // 记录最近访问时间（用于 LRU 淘汰）
      this.fileAccessMap.set(fileId, Date.now());
      return this.withCachePin(fileId, createReadStream(cachePath));
    } catch {
      // 缓存不存在
    }

    return null;
  }

  /**
   * 获取正式缓存，或创建/加入实时缓存构建会话。
   * 每个消费者从临时文件 offset 0 独立读取，客户端断开不会取消上游构建。
   */
  async getOrCacheStream(
    fileId: string,
    expectedSize: number,
    fetchFn: () => Promise<{ stream: Readable; info: { file_size: number } }>,
    contentVersion?: string | number,
    options?: { waitTimeoutMs?: number },
  ): Promise<{ stream: Readable; fromCache: boolean }> {
    this.validateFileId(fileId);
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
      throw new Error(`非法的文件大小: ${expectedSize}`);
    }
    this.assertNotShuttingDown();

    // 无缓存模式：不读缓存、不发布正式缓存，走可重放 spool / 有界直通
    if (this.noCacheMode) {
      return this.sessionCoordinator.getNoCacheStream(fileId, expectedSize, fetchFn, 0, expectedSize - 1, contentVersion);
    }

    const cached = this.getCachedReadStream(fileId, expectedSize);
    if (cached) return { stream: cached, fromCache: true };

    // 已有构建会话（且内容版本一致）→ follower：直接合流，不重复申请磁盘/上游资源
    const existing = this.buildSessions.get(fileId);
    if (existing && sameContentVersion(existing.contentVersion, contentVersion)) {
      await this.sessionCoordinator.waitForSessionReadable(existing);
      return { stream: this.sessionCoordinator.createFollowerStream(existing), fromCache: false };
    }

    if (!(await this.prepareCacheCapacity(expectedSize))) {
      // 容量/磁盘不足：改用可重放 spool（C-04 修复），迟到消费者从 offset 0 完整重放
      this.logger.warn(`缓存容量或磁盘余量不足，文件 ${fileId} 走可重放 spool`);
      return this.getDegradableSpooledStream(fileId, expectedSize, fetchFn, 0, expectedSize - 1, contentVersion);
    }

    // 容量准备期间模式可能已翻转，复查避免在无缓存模式下新建构建会话
    if (this.noCacheMode) {
      return this.sessionCoordinator.getNoCacheStream(fileId, expectedSize, fetchFn, 0, expectedSize - 1, contentVersion);
    }

    let lease: SessionResourceLease;
    try {
      // 正式缓存构建：磁盘 + 缓存逻辑容量同时预约；等待磁盘/上游期间不写盘
      lease = await this.sessionCoordinator.acquireSessionResources(fileId, expectedSize, {
        countsTowardCache: true,
        contentVersion,
        waitTimeoutMs: options?.waitTimeoutMs,
      });
    } catch (error) {
      if (isInsufficientStorage(error)) {
        // 单文件超过缓存容量上限：降级 spool/直通，绝不因此拒绝下载（网盘文件必须可下载）
        this.logger.warn(`文件 ${fileId} 超过缓存容量上限，降级为 spool/直通`);
        return this.getDegradableSpooledStream(fileId, expectedSize, fetchFn, 0, expectedSize - 1, contentVersion);
      }
      throw error;
    }

    const session = this.sessionCoordinator.getOrCreateBuildSession(
      fileId,
      expectedSize,
      fetchFn,
      lease,
      contentVersion,
    );
    await this.sessionCoordinator.waitForSessionReadable(session);
    return { stream: this.sessionCoordinator.createFollowerStream(session), fromCache: false };
  }

  /**
   * 可降级 spool：完整暂存无法满足（空间/缓存上限）时自动改用有界滚动缓冲直通，
   * 保证任何已上传文件都能下载，只损失整文件缓存发布与 follower 重放能力。
   */
  private async getDegradableSpooledStream(
    fileId: string,
    expectedSize: number,
    fetchFn: () => Promise<{ stream: Readable; info: { file_size: number } }>,
    start = 0,
    end = expectedSize - 1,
    contentVersion?: string | number,
  ): Promise<{ stream: Readable; fromCache: boolean }> {
    try {
      return await this.sessionCoordinator.getSpooledStream(
        fileId,
        expectedSize,
        fetchFn,
        start,
        end,
        contentVersion,
      );
    } catch (error) {
      if (!isInsufficientStorage(error)) throw error;
      this.logger.warn(`文件 ${fileId} 无法完整暂存，降级有界滚动缓冲直通（不写本地副本）`);
      const direct = await this.sessionCoordinator.getDirectStream(fileId, fetchFn, start, end);
      return { stream: direct.stream, fromCache: false };
    }
  }

  /** 服务关闭中：拒绝新下载（结构化 503），已在进行中的会话由关闭钩子收尾 */
  private assertNotShuttingDown(): void {
    if (this.shuttingDown) {
      throw new ServiceUnavailableException('服务正在关闭，下载请求已取消，请稍后重试');
    }
  }

  /**
   * 冷缓存 Range：上游仍保持单路顺序构建完整缓存，客户端只读取所需字节区间。
   * 这样首个媒体请求保持 206，不会退化成浏览器端整文件下载；已写入区间可立即 seek。
   */
  async getOrCacheRangeStream(
    fileId: string,
    expectedSize: number,
    start: number,
    end: number,
    fetchFn: () => Promise<{ stream: Readable; info: { file_size: number } }>,
    options?: { noCache?: boolean; contentVersion?: string | number; waitTimeoutMs?: number },
  ): Promise<Readable | null> {
    this.validateFileId(fileId);
    if (start < 0 || end < start || end >= expectedSize) return null;
    this.assertNotShuttingDown();
    const contentVersion = options?.contentVersion;
    // 请求级无缓存必须与全局无缓存使用同一 spool 语义，绝不发布正式缓存。
    if (this.noCacheMode || options?.noCache) {
      const result = await this.sessionCoordinator.getNoCacheStream(
        fileId,
        expectedSize,
        fetchFn,
        start,
        end,
        contentVersion,
      );
      return result.stream;
    }

    const cachedPath = this.getCachedPath(fileId);
    if (cachedPath) {
      this.fileAccessMap.set(fileId, Date.now());
      return this.withCachePin(fileId, createReadStream(cachedPath, { start, end }));
    }
    // 已有构建会话（内容版本一致）→ follower：直接合流读取所需区间，不重复申请资源
    const existing = this.buildSessions.get(fileId);
    if (existing && sameContentVersion(existing.contentVersion, contentVersion)) {
      return this.sessionCoordinator.createFollowerStream(existing, start, end);
    }
    if (!(await this.prepareCacheCapacity(expectedSize))) {
      // 无法建立正式缓存时仍保持 Range 语义：使用可重放 spool / 有界直通，而不是回退 200。
      const result = await this.getDegradableSpooledStream(fileId, expectedSize, fetchFn, start, end, contentVersion);
      return result.stream;
    }
    // 容量准备期间模式可能翻转；无缓存模式由协调器提供 spool/直通 Range。
    if (this.noCacheMode) {
      const result = await this.sessionCoordinator.getNoCacheStream(
        fileId,
        expectedSize,
        fetchFn,
        start,
        end,
        contentVersion,
      );
      return result.stream;
    }

    let lease: SessionResourceLease;
    try {
      lease = await this.sessionCoordinator.acquireSessionResources(fileId, expectedSize, {
        countsTowardCache: true,
        contentVersion,
        waitTimeoutMs: options?.waitTimeoutMs,
      });
    } catch (error) {
      if (isInsufficientStorage(error)) {
        this.logger.warn(`文件 ${fileId}（Range）超过缓存容量上限，降级为 spool/直通`);
        const result = await this.getDegradableSpooledStream(fileId, expectedSize, fetchFn, start, end, contentVersion);
        return result.stream;
      }
      throw error;
    }

    const session = this.sessionCoordinator.getOrCreateBuildSession(
      fileId,
      expectedSize,
      fetchFn,
      lease,
      contentVersion,
    );
    return this.sessionCoordinator.createFollowerStream(session, start, end);
  }

  /**
   * 文件大小未知（Bot 直链的元数据缺失场景）时的有界滚动缓冲直通：
   * 不落盘、不发布缓存、无从预测占用，仅受上游并发租约约束，
   * 保证任何文件都能下载且不因未知大小被拒绝。
   */
  async getDirectOnlyStream(
    sessionKey: string,
    fetchFn: () => Promise<{ stream: Readable; info: { file_size: number } }>,
    options?: { signal?: AbortSignal },
  ): Promise<Readable> {
    this.assertNotShuttingDown();
    const direct = await this.sessionCoordinator.getDirectStream(sessionKey, fetchFn, 0, undefined, {
      signal: options?.signal,
      waitTimeoutMs: this.directWaitMs,
    });
    return direct.stream;
  }

  /** 无缓存直通：委托会话协调器（C-04 可重放 spool）。 */
  async getNoCacheStream(
    fileId: string,
    expectedSize: number,
    fetchFn: () => Promise<{ stream: Readable; info: { file_size: number } }>,
    start = 0,
    end = expectedSize - 1,
    contentVersion?: string | number,
  ): Promise<{ stream: Readable; fromCache: boolean }> {
    return this.sessionCoordinator.getNoCacheStream(fileId, expectedSize, fetchFn, start, end, contentVersion);
  }

  /** 中止指定文件的进行中缓存构建会话（委托会话协调器） */
  async abortBuildSession(fileId: string): Promise<void> {
    await this.sessionCoordinator.abortBuildSession(fileId);
  }

  /** 定时清理过期缓存（每 6 小时执行一次） */
  @Cron('0 */6 * * *')
  async cleanupExpiredCache(): Promise<void> {
    try {
      const cleaned = await this.diskManager.cleanupExpiredCache(
        this.cacheTtlMs,
        this.fileAccessMap,
        fileId => this.buildSessions.has(fileId),
        fileId => this.isPinnedCache(fileId),
      );
      this.diskManager.pruneAccessMap(this.fileAccessMap);
      if (cleaned > 0) {
        this.logger.log(`清理 ${cleaned} 个过期缓存文件`);
      }
    } catch (err) {
      this.logger.warn(`缓存清理失败: ${(err as Error).message}`);
    }
  }

  private async prepareCacheCapacity(expectedSize: number): Promise<boolean> {
    return this.diskManager.prepareCacheCapacity(expectedSize, this.maxCacheSizeBytes, this.minFreeDiskBytes, this.fileAccessMap);
  }

  /** LRU 淘汰（委托磁盘管理器，供测试 spy 观察） */
  async evictLRU(targetFreeBytes: number): Promise<number> {
    const evicted = await this.diskManager.evictLRU(
      targetFreeBytes,
      this.fileAccessMap,
      fileId => this.isPinnedCache(fileId),
    );
    if (evicted > 0) {
      this.logger.log(`LRU 淘汰完成: 移除了 ${evicted} 个缓存文件`);
    }
    return evicted;
  }

  /** 获取缓存目录总大小（委托磁盘管理器，供测试 spy 观察） */
  async getTotalCacheSize(): Promise<number> {
    return this.diskManager.getTotalCacheSize();
  }

  /**
   * 应用关闭钩子（H-09/C-04 配套）：
   * 置位关闭信号、中止构建、等待上游收尾、清理 spool。
   */
  async onApplicationShutdown(): Promise<void> {
    // 先拒绝新任务与队列中的等待项，再中止进行中的会话（会话收尾会释放剩余预约与上游租约）
    this.resources.shutdown();
    await this.sessionCoordinator.shutdown();
  }

  /**
   * 异步获取缓存流（Promise 版本）
   * @deprecated Use getCachedReadStream for sync access
   */
  async getCachedStream(
    fileId: string,
    expectedSize: number,
    fetchFn: () => Promise<{ stream: Readable; info: { file_id: string; file_path: string; file_size: number } }>,
  ): Promise<{ stream: Readable; fromCache: boolean }> {
    this.validateFileId(fileId);
    const cachePath = this.getCachePath(fileId);

    // 缓存命中校验
    try {
      const stat = await fsp.stat(cachePath);
      if (stat.size === expectedSize && stat.size > 0) {
        this.logger.debug(`缓存命中: ${fileId} (${stat.size} bytes)`);
        return { stream: createReadStream(cachePath), fromCache: true };
      }
      // 大小不一致 = 缓存失效
      this.logger.debug(`缓存失效: ${fileId} (期望 ${expectedSize}, 实际 ${stat.size})`);
    } catch {
      // 缓存不存在，正常回源
    }

    // 回源获取
    const { stream, info } = await fetchFn();
    this.logger.debug(`缓存回源: ${fileId} (${info.file_size} bytes)`);

    return { stream, fromCache: false };
  }

  /**
   * 缓存文件到本地
   * @param fileId 文件 UUID
   * @param buffer 文件内容
   */
  async cacheFile(fileId: string, buffer: Buffer): Promise<void> {
    this.validateFileId(fileId);
    if (this.noCacheMode) return;

    // 缓存总大小检查：超限时尝试 LRU 淘汰
    const totalSize = await this.getTotalCacheSize();
    if (totalSize + buffer.length > this.maxCacheSizeBytes) {
      const needFree = totalSize + buffer.length - this.maxCacheSizeBytes;
      this.logger.warn(`缓存总量超限，尝试 LRU 淘汰 (需释放 ${(needFree / 1024 / 1024).toFixed(0)}MB)`);
      await this.evictLRU(needFree);
      // 淘汰后再次检查
      const newTotal = await this.getTotalCacheSize();
      if (newTotal + buffer.length > this.maxCacheSizeBytes) {
        this.logger.warn(`LRU 淘汰后仍超限，跳过缓存 ${fileId}`);
        return;
      }
    }

    // 磁盘空间检查：不足时尝试 LRU 淘汰
    if (!this.diskManager.hasEnoughDiskSpace(this.minFreeDiskBytes)) {
      this.logger.warn(`磁盘空间不足，尝试 LRU 淘汰`);
      await this.evictLRU(this.minFreeDiskBytes);
      if (!this.diskManager.hasEnoughDiskSpace(this.minFreeDiskBytes)) {
        this.logger.warn(`磁盘剩余空间仍不足，跳过缓存 ${fileId}`);
        return;
      }
    }

    const reservation = await this.tryReserveForWarmup(fileId, buffer.length);
    if (!reservation) return;

    const cachePath = this.getCachePath(fileId);

    // 原子写入：临时文件 + rename
    const tmpPath = cachePath + '.tmp';
    try {
      await fsp.writeFile(tmpPath, buffer);
      await fsp.rename(tmpPath, cachePath);
      this.diskManager.registerCache(fileId, buffer.length);
      reservation.consume(buffer.length);
    } catch (err) {
      // 清理临时文件
      await fsp.unlink(tmpPath).catch(() => {});
      throw err;
    } finally {
      reservation.release();
    }
  }

  /**
   * 预热/非关键路径的预约尝试：取不到预约（空间不足/队列满/服务关闭）直接跳过缓存写入，
   * 绝不与正在进行的下载任务争抢磁盘预算。
   */
  private async tryReserveForWarmup(fileId: string, bytes: number): Promise<DownloadReservation | null> {
    try {
      return await this.resources.reserve({
        sessionKey: `warmup:${fileId}`,
        bytes,
        countsTowardCache: true,
        // 预热不等队列：取不到就本次跳过，避免长期占用队列名额
        waitTimeoutMs: 1,
      });
    } catch (error) {
      if (error instanceof DownloadResourceException) {
        this.logger.warn(`缓存预热跳过（${error.errorCode}）: ${fileId}`);
        return null;
      }
      throw error;
    }
  }

  /**
   * 从磁盘路径缓存文件（流式拷贝，避免大文件 OOM）
   * @param fileId 文件 UUID
   * @param sourcePath 源文件路径
   * @param expectedSize 期望的文件大小，用于拷贝后验证
   */
  async cacheFileFromPath(fileId: string, sourcePath: string, expectedSize: number): Promise<void> {
    this.validateFileId(fileId);
    if (this.noCacheMode) return;

    // 缓存总大小检查：超限时尝试 LRU 淘汰
    const totalSize = await this.getTotalCacheSize();
    if (totalSize + expectedSize > this.maxCacheSizeBytes) {
      const needFree = totalSize + expectedSize - this.maxCacheSizeBytes;
      this.logger.warn(`缓存总量超限，尝试 LRU 淘汰 (需释放 ${(needFree / 1024 / 1024).toFixed(0)}MB)`);
      await this.evictLRU(needFree);
      const newTotal = await this.getTotalCacheSize();
      if (newTotal + expectedSize > this.maxCacheSizeBytes) {
        this.logger.warn(`LRU 淘汰后仍超限，跳过缓存 ${fileId}`);
        return;
      }
    }

    // 磁盘空间检查：不足时尝试 LRU 淘汰
    if (!this.diskManager.hasEnoughDiskSpace(this.minFreeDiskBytes)) {
      this.logger.warn(`磁盘空间不足，尝试 LRU 淘汰`);
      await this.evictLRU(this.minFreeDiskBytes);
      if (!this.diskManager.hasEnoughDiskSpace(this.minFreeDiskBytes)) {
        this.logger.warn(`磁盘剩余空间仍不足，跳过缓存 ${fileId}`);
        return;
      }
    }

    const reservation = await this.tryReserveForWarmup(fileId, expectedSize);
    if (!reservation) return;

    const cachePath = this.getCachePath(fileId);
    const tmpPath = cachePath + '.tmp';
    const { createReadStream, createWriteStream } = require('fs');
    const { pipeline } = require('stream/promises');

    try {
      await pipeline(
        createReadStream(sourcePath),
        createWriteStream(tmpPath),
      );
      const stat = await fsp.stat(tmpPath);
      if (stat.size !== expectedSize) {
        await fsp.unlink(tmpPath).catch(() => {});
        this.logger.warn(`缓存文件大小不一致 ${fileId}: 期望 ${expectedSize}, 实际 ${stat.size}`);
        return;
      }
      await fsp.rename(tmpPath, cachePath);
      this.diskManager.registerCache(fileId, expectedSize);
      reservation.consume(expectedSize);
      this.logger.log(`缓存预热完成: ${fileId} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
    } catch (err) {
      await fsp.unlink(tmpPath).catch(() => {});
      this.logger.warn(`缓存预热失败 ${fileId}: ${(err as Error).message}`);
    } finally {
      reservation.release();
    }
  }

  /**
   * 使缓存失效（文件删除/更新时调用）
   */
  async invalidate(fileId: string): Promise<void> {
    this.validateFileId(fileId);
    const session = this.buildSessions.get(fileId);
    if (session) {
      session.abort(new Error('缓存构建已失效'));
      await Promise.race([
        session.completion.catch(() => {}),
        new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 5000);
          timer.unref?.();
        }),
      ]);
      // 等 runBuildSession 的 finally 中 setImmediate 从 map 移除已失效会话，
      // 以便下方能区分"旧会话收尾"与"新会话已创建"。
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    // 可重放 spool 会话一并销毁（文件删除 / 覆盖更新时终止在途上游）
    const spool = this.spoolSessions.get(fileId);
    if (spool) await this.sessionCoordinator.teardownSpoolSession(spool);

    // G4-05：abort/teardown 等待期间可能已有新会话（新请求/覆盖上传）为该 fileId 建立。
    // 复查活动会话后再 unlink，避免无条件删除新会话的 .tmp/.spool 导致新构建被破坏。
    const hasActiveSession =
      this.buildSessions.has(fileId) || this.spoolSessions.has(fileId);
    if (!hasActiveSession) {
      await this.diskManager.unlinkAllCacheFiles(fileId);
    }
    this.fileAccessMap.delete(fileId);
    this.logger.debug(`缓存失效: ${fileId}${hasActiveSession ? '（存在新活动会话，跳过 unlink）' : ''}`);
  }

  /**
   * 批量使缓存失效
   */
  async invalidateMany(fileIds: string[]): Promise<void> {
    for (const id of fileIds) {
      await this.invalidate(id);
    }
  }

  /**
   * 获取缓存文件大小（用于统计），不存在返回 0
   */
  async getCacheSize(fileId: string): Promise<number> {
    this.validateFileId(fileId);
    try {
      const stat = await fsp.stat(this.getCachePath(fileId));
      return stat.size;
    } catch {
      return 0;
    }
  }

  /** UUID 格式 + 路径穿越双重校验（委托磁盘管理器） */
  private validateFileId(fileId: string): void {
    this.diskManager.validateFileId(fileId);
  }

  /**
   * 获取已缓存文件的磁盘路径
   * 文件存在且未过期时返回路径，否则返回 null。
   */
  getCachedPath(fileId: string): string | null {
    this.validateFileId(fileId);
    if (this.noCacheMode) return null;
    const cachePath = this.getCachePath(fileId);
    try {
      const stat = require('fs').statSync(cachePath);
      if (stat.size <= 0) return null;
      // 检查 TTL 是否过期（过期即删除并扣减计数，避免总量漂移）
      if (Date.now() - stat.mtimeMs > this.cacheTtlMs) {
        this.diskManager.unregisterCache(fileId, stat.size);
        void fsp.unlink(cachePath).catch(() => {});
        return null;
      }
      this.fileAccessMap.set(fileId, Date.now());
      return cachePath;
    } catch {
      return null;
    }
  }

  private getCachePath(fileId: string): string {
    return this.diskManager.getCachePath(fileId);
  }
}
