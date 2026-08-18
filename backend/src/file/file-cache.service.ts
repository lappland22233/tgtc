import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { Readable } from 'stream';
import { createReadStream, constants as fsConstants } from 'fs';
import { promises as fsp } from 'fs';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { CacheDiskManager } from './cache-disk-manager';
import { CacheSessionCoordinator, type CacheBuildSession, type SpoolSession } from './cache-session-coordinator';

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

@Injectable()
export class FileCacheService implements OnApplicationShutdown {
  private readonly logger = new Logger(FileCacheService.name);
  private readonly cacheDir: string;
  /** 磁盘管理器：路径/容量/LRU/过期清理 */
  private readonly diskManager: CacheDiskManager;
  /** 会话协调器：build/spool 会话生命周期、并发预算、超时竞速 */
  private readonly sessionCoordinator: CacheSessionCoordinator;

  /** 运行时配置（可从管理后台动态调整） */
  private maxCacheSizeBytes = parseInt(CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.MAX_SIZE_GB]) * 1024 * 1024 * 1024;
  private minFreeDiskBytes = parseInt(CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.MIN_FREE_DISK_GB]) * 1024 * 1024 * 1024;
  private cacheTtlMs = parseInt(CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.TTL_DAYS]) * 24 * 60 * 60 * 1000;
  /** 无缓存模式：文件下载实时回源直通，不读写本地缓存（可从管理后台动态调整） */
  private noCacheMode = process.env.FILE_CACHE_NO_CACHE_MODE === 'true';

  /** 关闭信号：置位后不再新建 build/spool 会话，正在进行的会话按策略收尾 */
  private shuttingDown = false;

  /** 文件最近访问时间追踪 (fileId → lastAccessTimestamp)，用于 LRU 淘汰 */
  private readonly fileAccessMap = new Map<string, number>();

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

  constructor(private readonly configCache: ConfigCacheService) {
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
    this.sessionCoordinator = new CacheSessionCoordinator({
      diskManager: this.diskManager,
      fileAccessMap: this.fileAccessMap,
      logger: this.logger,
      isShuttingDown: () => this.shuttingDown,
      setShuttingDown: (value: boolean) => { this.shuttingDown = value; },
    });
    // 异步加载持久化配置
    this.reloadConfig();
  }

  /** 当前是否处于无缓存模式 */
  isNoCacheMode(): boolean {
    return this.noCacheMode;
  }

  /** 从配置缓存加载阈值 */
  private async reloadConfig(): Promise<void> {
    try {
      const [maxSizeStr, minFreeStr, ttlStr, noCacheStr] = await Promise.all([
        this.configCache.get(CACHE_CONFIG_KEYS.MAX_SIZE_GB, CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.MAX_SIZE_GB]),
        this.configCache.get(CACHE_CONFIG_KEYS.MIN_FREE_DISK_GB, CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.MIN_FREE_DISK_GB]),
        this.configCache.get(CACHE_CONFIG_KEYS.TTL_DAYS, CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.TTL_DAYS]),
        this.configCache.get(CACHE_CONFIG_KEYS.NO_CACHE_MODE, CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.NO_CACHE_MODE]),
      ]);
      this.maxCacheSizeBytes = Math.max(1, parseInt(maxSizeStr) || 10) * 1024 * 1024 * 1024;
      this.minFreeDiskBytes = Math.max(0.5, parseFloat(minFreeStr) || 1) * 1024 * 1024 * 1024;
      this.cacheTtlMs = Math.max(1, parseInt(ttlStr) || 3) * 24 * 60 * 60 * 1000;
      // 无缓存模式翻转：false → true 时中止所有进行中的缓存构建
      const prevNoCacheMode = this.noCacheMode;
      this.noCacheMode = noCacheStr === 'true';
      this.logger.log(
        `缓存配置: 上限 ${this.maxCacheSizeBytes / 1024 / 1024 / 1024}GB, ` +
        `剩余 ${this.minFreeDiskBytes / 1024 / 1024 / 1024}GB, ` +
        `TTL ${this.cacheTtlMs / 86400000}天, ` +
        `无缓存模式 ${this.noCacheMode ? '开启' : '关闭'}`,
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
    const keys = Object.values(CACHE_CONFIG_KEYS) as string[];
    if (keys.includes(payload.key)) {
      await this.reloadConfig();
    }
  }

  /** 批量配置变更热更新（ConfigCacheService.setBatch 只发此事件） */
  @OnEvent('config.batch-changed')
  async onBatchConfigChanged(payload: { key: string; value: string; description?: string }[]): Promise<void> {
    const keys = Object.values(CACHE_CONFIG_KEYS) as string[];
    if (Array.isArray(payload) && payload.some(item => keys.includes(item.key))) {
      await this.reloadConfig();
    }
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
        fsp.unlink(cachePath).catch(() => {});
        return null;
      }
      // TTL 过期检查
      const age = Date.now() - stat.mtimeMs;
      if (age > this.cacheTtlMs) {
        this.logger.debug(`缓存过期: ${fileId} (${Math.round(age / 3600000)}h)`);
        fsp.unlink(cachePath).catch(() => {});
        return null;
      }
      this.logger.debug(`缓存命中: ${fileId} (${stat.size} bytes, ${Math.round(age / 3600000)}h)`);
      // 记录最近访问时间（用于 LRU 淘汰）
      this.fileAccessMap.set(fileId, Date.now());
      return createReadStream(cachePath);
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
  ): Promise<{ stream: Readable; fromCache: boolean }> {
    this.validateFileId(fileId);
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
      throw new Error(`非法的文件大小: ${expectedSize}`);
    }

    // 无缓存模式：不读缓存、不写缓存、不计算容量，上游流实时直通
    if (this.noCacheMode) {
      return this.sessionCoordinator.getNoCacheStream(fileId, expectedSize, fetchFn);
    }

    const cached = this.getCachedReadStream(fileId, expectedSize);
    if (cached) return { stream: cached, fromCache: true };

    if (!(await this.prepareCacheCapacity(expectedSize))) {
      // 容量/磁盘不足：改用可重放 spool（C-04 修复），迟到消费者从 offset 0 完整重放
      this.logger.warn(`缓存容量或磁盘余量不足，文件 ${fileId} 走可重放 spool`);
      return this.sessionCoordinator.getSpooledStream(fileId, expectedSize, fetchFn);
    }

    // 容量准备期间模式可能已翻转，复查避免在无缓存模式下新建构建会话
    if (this.noCacheMode) {
      return this.sessionCoordinator.getNoCacheStream(fileId, expectedSize, fetchFn);
    }

    const session = this.sessionCoordinator.getOrCreateBuildSession(fileId, expectedSize, fetchFn);
    await this.sessionCoordinator.waitForSessionReadable(session);
    return { stream: this.sessionCoordinator.createFollowerStream(session), fromCache: false };
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
  ): Promise<Readable | null> {
    this.validateFileId(fileId);
    if (this.noCacheMode || start < 0 || end < start || end >= expectedSize) return null;

    const cachedPath = this.getCachedPath(fileId);
    if (cachedPath) {
      this.fileAccessMap.set(fileId, Date.now());
      return createReadStream(cachedPath, { start, end });
    }
    if (!(await this.prepareCacheCapacity(expectedSize)) || this.noCacheMode) return null;

    const session = this.sessionCoordinator.getOrCreateBuildSession(fileId, expectedSize, fetchFn);
    return this.sessionCoordinator.createFollowerStream(session, start, end);
  }

  /** 无缓存直通：委托会话协调器（C-04 可重放 spool）。 */
  async getNoCacheStream(
    fileId: string,
    expectedSize: number,
    fetchFn: () => Promise<{ stream: Readable; info: { file_size: number } }>,
  ): Promise<{ stream: Readable; fromCache: boolean }> {
    return this.sessionCoordinator.getNoCacheStream(fileId, expectedSize, fetchFn);
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
    const evicted = await this.diskManager.evictLRU(targetFreeBytes, this.fileAccessMap);
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

    const cachePath = this.getCachePath(fileId);

    // 原子写入：临时文件 + rename
    const tmpPath = cachePath + '.tmp';
    try {
      await fsp.writeFile(tmpPath, buffer);
      await fsp.rename(tmpPath, cachePath);
      this.diskManager.registerCache(fileId, buffer.length);
    } catch (err) {
      // 清理临时文件
      await fsp.unlink(tmpPath).catch(() => {});
      throw err;
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
      this.logger.log(`缓存预热完成: ${fileId} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
    } catch (err) {
      await fsp.unlink(tmpPath).catch(() => {});
      this.logger.warn(`缓存预热失败 ${fileId}: ${(err as Error).message}`);
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
      // 检查 TTL 是否过期
      if (Date.now() - stat.mtimeMs > this.cacheTtlMs) return null;
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
