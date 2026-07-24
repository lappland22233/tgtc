import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { PassThrough, Readable } from 'stream';
import { createReadStream, createWriteStream } from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { ConfigCacheService } from '../common/services/config-cache.service';

export const CACHE_CONFIG_KEYS = {
  MAX_SIZE_GB: 'FILE_CACHE_MAX_SIZE_GB',
  MIN_FREE_DISK_GB: 'FILE_CACHE_MIN_FREE_DISK_GB',
  TTL_DAYS: 'FILE_CACHE_TTL_DAYS',
} as const;

export const CACHE_CONFIG_DEFAULTS: Record<string, string> = {
  [CACHE_CONFIG_KEYS.MAX_SIZE_GB]: '10',
  [CACHE_CONFIG_KEYS.MIN_FREE_DISK_GB]: '1',
  [CACHE_CONFIG_KEYS.TTL_DAYS]: '3',
};

@Injectable()
export class FileCacheService {
  private readonly logger = new Logger(FileCacheService.name);
  private readonly cacheDir: string;

  /** 运行时配置（可从管理后台动态调整） */
  private maxCacheSizeBytes = parseInt(CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.MAX_SIZE_GB]) * 1024 * 1024 * 1024;
  private minFreeDiskBytes = parseInt(CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.MIN_FREE_DISK_GB]) * 1024 * 1024 * 1024;
  private cacheTtlMs = parseInt(CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.TTL_DAYS]) * 24 * 60 * 60 * 1000;

  /** 文件最近访问时间追踪 (fileId → lastAccessTimestamp)，用于 LRU 淘汰 */
  private readonly fileAccessMap = new Map<string, number>();

  /** 同一文件的回源请求去重，避免并发写入同一缓存文件。 */
  private readonly inflight = new Map<string, Promise<void>>();
  /** 串行化容量检查与原子发布，避免跨文件并发突破缓存上限。 */
  private capacityChain: Promise<void> = Promise.resolve();

  constructor(private readonly configCache: ConfigCacheService) {
    this.cacheDir = path.resolve(process.cwd(), 'tmp', 'Cache');
    fsp.mkdir(this.cacheDir, { recursive: true }).catch(() => {});
    // 异步加载持久化配置
    this.reloadConfig();
  }

  /** 从配置缓存加载阈值 */
  private async reloadConfig(): Promise<void> {
    try {
      const [maxSizeStr, minFreeStr, ttlStr] = await Promise.all([
        this.configCache.get(CACHE_CONFIG_KEYS.MAX_SIZE_GB, CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.MAX_SIZE_GB]),
        this.configCache.get(CACHE_CONFIG_KEYS.MIN_FREE_DISK_GB, CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.MIN_FREE_DISK_GB]),
        this.configCache.get(CACHE_CONFIG_KEYS.TTL_DAYS, CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.TTL_DAYS]),
      ]);
      this.maxCacheSizeBytes = Math.max(1, parseInt(maxSizeStr) || 10) * 1024 * 1024 * 1024;
      this.minFreeDiskBytes = Math.max(0.5, parseFloat(minFreeStr) || 1) * 1024 * 1024 * 1024;
      this.cacheTtlMs = Math.max(1, parseInt(ttlStr) || 3) * 24 * 60 * 60 * 1000;
      this.logger.log(
        `缓存配置: 上限 ${this.maxCacheSizeBytes / 1024 / 1024 / 1024}GB, ` +
        `剩余 ${this.minFreeDiskBytes / 1024 / 1024 / 1024}GB, ` +
        `TTL ${this.cacheTtlMs / 86400000}天`,
      );
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

  /**
   * 获取缓存的读取流。命中返回 Readable，未命中返回 null。
   * 检查文件大小一致性和 TTL 过期。
   */
  async openCachedReadStream(
    fileId: string,
    expectedSize: number,
    range?: { start: number; end: number },
  ): Promise<Readable | null> {
    this.validateFileId(fileId);
    const cachePath = this.getCachePath(fileId);
    let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
    try {
      // 以实际打开的句柄做 fstat，消除 stat 与 createReadStream 之间文件被淘汰的竞态。
      handle = await fsp.open(cachePath, 'r');
      const stat = await handle.stat();
      const age = Date.now() - stat.mtimeMs;
      if (stat.size !== expectedSize || stat.size <= 0 || age > this.cacheTtlMs) {
        await handle.close();
        handle = undefined;
        await fsp.unlink(cachePath).catch(() => {});
        return null;
      }
      if (range && (range.start < 0 || range.end < range.start || range.end >= stat.size)) {
        await handle.close();
        handle = undefined;
        return null;
      }
      this.fileAccessMap.set(fileId, Date.now());
      const stream = handle.createReadStream({
        autoClose: true,
        ...(range ? { start: range.start, end: range.end } : {}),
      });
      handle = undefined;
      return stream;
    } catch (error) {
      await handle?.close().catch(() => {});
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ESTALE') {
        this.logger.warn(`缓存文件打开失败: ${fileId}, code=${code || 'UNKNOWN'}`);
      }
      return null;
    }
  }

  /** @deprecated 新下载流程应使用 openCachedReadStream，避免异步 open 错误。 */
  getCachedReadStream(fileId: string, expectedSize: number): Readable | null {
    this.validateFileId(fileId);
    const cachePath = this.getCachePath(fileId);
    try {
      const stat = require('fs').statSync(cachePath);
      if (stat.size !== expectedSize || stat.size <= 0 || Date.now() - stat.mtimeMs > this.cacheTtlMs) return null;
      this.fileAccessMap.set(fileId, Date.now());
      const stream = createReadStream(cachePath);
      // 兼容遗留同步调用：至少保证 open 失败不会成为未处理 error。
      stream.once('error', () => {});
      return stream;
    } catch {
      return null;
    }
  }

  /** 定时清理过期缓存（每 6 小时执行一次） */
  @Cron('0 */6 * * *')
  async cleanupExpiredCache(): Promise<void> {
    try {
      const files = await fsp.readdir(this.cacheDir);
      const now = Date.now();
      let cleaned = 0;
      const surviving = new Set<string>();
      for (const f of files) {
        const fullPath = path.join(this.cacheDir, f);
        try {
          const stat = await fsp.stat(fullPath);
          if (now - stat.mtimeMs > this.cacheTtlMs) {
            await fsp.unlink(fullPath);
            this.fileAccessMap.delete(f); // 同步清理 LRU 记录，防止 Map 泄漏
            cleaned++;
          } else {
            surviving.add(f);
          }
        } catch {
          // 文件可能已被删除
        }
      }
      // 清理 fileAccessMap 中已不存在于磁盘的条目（被外部删除/淘汰的文件）
      for (const id of this.fileAccessMap.keys()) {
        if (!surviving.has(id)) this.fileAccessMap.delete(id);
      }
      this.pruneAccessMap();
      if (cleaned > 0) {
        this.logger.log(`清理 ${cleaned} 个过期缓存文件`);
      }
    } catch (err) {
      this.logger.warn(`缓存清理失败: ${(err as Error).message}`);
    }
  }

  /** fileAccessMap 容量上限，超过则淘汰最久未访问的条目，杜绝无界增长 */
  private static readonly ACCESS_MAP_MAX = 100000;

  /** 约束 fileAccessMap 规模：超限时从最久未访问的条目开始删除 */
  private pruneAccessMap(): void {
    if (this.fileAccessMap.size <= FileCacheService.ACCESS_MAP_MAX) return;
    // Map 按插入序迭代；先按访问时间升序排列再删除最旧的若干条
    const entries = [...this.fileAccessMap.entries()].sort((a, b) => a[1] - b[1]);
    const removeCount = this.fileAccessMap.size - FileCacheService.ACCESS_MAP_MAX;
    for (let i = 0; i < removeCount; i++) {
      this.fileAccessMap.delete(entries[i][0]);
    }
  }

  /** 检查磁盘空间是否充足 */
  private hasEnoughDiskSpace(): boolean {
    try {
      const { statfsSync } = require('fs');
      const stats = statfsSync(this.cacheDir);
      const freeBytes = stats.bsize * stats.bfree;
      return freeBytes >= this.minFreeDiskBytes;
    } catch {
      // 无法获取磁盘信息时保守允许缓存
      return true;
    }
  }

  /**
   * LRU 淘汰：按最近访问时间从远到近逐个删除缓存文件，
   * 直到释放足够的空间或没有更多可淘汰文件。
   * @returns 被淘汰的文件数
   */
  private async evictLRU(targetFreeBytes: number): Promise<number> {
    let evicted = 0;

    try {
      const files = await fsp.readdir(this.cacheDir);
      // 收集所有缓存文件的访问时间和大小
      const entries: { name: string; accessTime: number; size: number }[] = [];
      for (const f of files) {
        if (f.endsWith('.tmp')) continue; // 跳过临时文件
        try {
          const stat = await fsp.stat(path.join(this.cacheDir, f));
          const accessTime = this.fileAccessMap.get(f) || stat.atimeMs;
          entries.push({ name: f, accessTime, size: stat.size });
        } catch {
          continue;
        }
      }

      // 按访问时间升序排列（最久未访问的排前面）
      entries.sort((a, b) => a.accessTime - b.accessTime);

      // 逐个淘汰直到空间充足（目标：释放 targetFreeBytes 字节）
      let freedBytes = 0;
      for (const entry of entries) {
        if (freedBytes >= targetFreeBytes) break;
        try {
          await fsp.unlink(path.join(this.cacheDir, entry.name));
          this.fileAccessMap.delete(entry.name);
          freedBytes += entry.size;
          evicted++;
        } catch {
          continue;
        }
      }

      if (evicted > 0) {
        this.logger.log(
          `LRU 淘汰完成: 移除了 ${evicted} 个缓存文件，释放 ${(freedBytes / 1024 / 1024).toFixed(1)}MB`,
        );
      }
    } catch {
      // 淘汰过程失败不影响主流程
    }

    return evicted;
  }

  /** 获取缓存目录总大小 */
  private async getTotalCacheSize(): Promise<number> {
    try {
      const files = await fsp.readdir(this.cacheDir);
      let total = 0;
      for (const f of files) {
        try {
          const stat = await fsp.stat(path.join(this.cacheDir, f));
          total += stat.size;
        } catch { /* skip */ }
      }
      return total;
    } catch {
      return 0;
    }
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
   * 获取缓存流；未命中时回源并将数据同时写入客户端和本地缓存。
   * 首次回源保持真流式，成功后才通过原子 rename 发布缓存。
   */
  async getOrCacheStream(
    fileId: string,
    expectedSize: number,
    fetchFn: () => Promise<{ stream: Readable; info: { file_id: string; file_path: string; file_size: number } }>,
  ): Promise<{ stream: Readable; fromCache: boolean }> {
    this.validateFileId(fileId);

    const cachedStream = await this.openCachedReadStream(fileId, expectedSize);
    if (cachedStream) return { stream: cachedStream, fromCache: true };

    const existing = this.inflight.get(fileId);
    if (existing) {
      await existing;
      const stream = await this.openCachedReadStream(fileId, expectedSize);
      if (!stream) throw new Error(`文件缓存建立失败: ${fileId}`);
      return { stream, fromCache: true };
    }

    // 在等待上游首字节前先登记 inflight，避免多个并发请求同时启动 Bot API 回源。
    let resolveInflight!: () => void;
    let rejectInflight!: (error: unknown) => void;
    const inflight = new Promise<void>((resolve, reject) => {
      resolveInflight = resolve;
      rejectInflight = reject;
    });
    this.inflight.set(fileId, inflight);
    inflight.finally(() => this.inflight.delete(fileId)).catch(() => {});

    try {
      // 先完成上游连接和首字节探测，再把流返回给 Controller，确保路径刷新发生在响应头发送前。
      const fetched = await fetchFn();
      const pass = new PassThrough();
      this.populateCache(fileId, expectedSize, fetched.stream, pass).then(resolveInflight, rejectInflight);
      return { stream: pass, fromCache: false };
    } catch (error) {
      rejectInflight(error);
      throw error;
    }
  }

  private async populateCache(
    fileId: string,
    expectedSize: number,
    source: Readable,
    clientStream: PassThrough,
  ): Promise<void> {
    const cachePath = this.getCachePath(fileId);
    const tmpPath = cachePath + '.tmp';
    const output = createWriteStream(tmpPath);
    let bytes = 0;
    const onData = (chunk: Buffer | string) => {
      bytes += Buffer.byteLength(chunk);
    };
    source.on('data', onData);
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const resolveOnce = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        const rejectOnce = (err: Error) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        };
        source.once('error', rejectOnce);
        output.once('error', rejectOnce);
        output.once('finish', resolveOnce);
        // 客户端断开只停止该输出分支，缓存构建继续完成，供后续请求复用。
        clientStream.once('close', () => source.unpipe(clientStream));
        source.pipe(clientStream);
        source.pipe(output);
      });
      const stat = await fsp.stat(tmpPath);
      if (bytes !== expectedSize || stat.size !== expectedSize) {
        throw new Error(`回源文件大小不一致: 期望 ${expectedSize}, 实际 ${stat.size}`);
      }
      await this.withCapacityLock(async () => {
        await this.ensureCacheCapacity(expectedSize, tmpPath);
        await fsp.rename(tmpPath, cachePath);
      });
    } catch (err) {
      source.destroy();
      output.destroy();
      clientStream.destroy(err as Error);
      await fsp.unlink(tmpPath).catch(() => {});
      await fsp.unlink(cachePath).catch(() => {});
      throw err;
    } finally {
      source.off('data', onData);
    }
  }

  private async withCapacityLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.capacityChain;
    let release!: () => void;
    this.capacityChain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /** 确保回源缓存写入不会突破配置的空间护栏。tmp 已计入目录总量，不重复加 expectedSize。 */
  private async ensureCacheCapacity(expectedSize: number, tmpPath?: string): Promise<void> {
    const totalSize = await this.getTotalCacheSize();
    const tmpSize = tmpPath ? (await fsp.stat(tmpPath).catch(() => ({ size: 0 }))).size : 0;
    const projected = totalSize + Math.max(0, expectedSize - tmpSize);
    if (projected > this.maxCacheSizeBytes) {
      await this.evictLRU(projected - this.maxCacheSizeBytes);
      const newTotal = await this.getTotalCacheSize();
      if (newTotal + Math.max(0, expectedSize - tmpSize) > this.maxCacheSizeBytes) {
        throw new Error('缓存空间不足');
      }
    }
    if (!this.hasEnoughDiskSpace()) {
      await this.evictLRU(this.minFreeDiskBytes);
      if (!this.hasEnoughDiskSpace()) throw new Error('磁盘空间不足');
    }
  }

  /**
   * 缓存文件到本地
   * @param fileId 文件 UUID
   * @param buffer 文件内容
   */
  async cacheFile(fileId: string, buffer: Buffer): Promise<void> {
    this.validateFileId(fileId);

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
    if (!this.hasEnoughDiskSpace()) {
      this.logger.warn(`磁盘空间不足，尝试 LRU 淘汰`);
      await this.evictLRU(this.minFreeDiskBytes);
      if (!this.hasEnoughDiskSpace()) {
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
  async cacheFileFromPath(
    fileId: string,
    sourcePath: string,
    expectedSize: number,
  ): Promise<{ cached: boolean; reason?: string }> {
    this.validateFileId(fileId);

    // 缓存总大小检查：超限时尝试 LRU 淘汰
    const totalSize = await this.getTotalCacheSize();
    if (totalSize + expectedSize > this.maxCacheSizeBytes) {
      const needFree = totalSize + expectedSize - this.maxCacheSizeBytes;
      this.logger.warn(`缓存总量超限，尝试 LRU 淘汰 (需释放 ${(needFree / 1024 / 1024).toFixed(0)}MB)`);
      await this.evictLRU(needFree);
      const newTotal = await this.getTotalCacheSize();
      if (newTotal + expectedSize > this.maxCacheSizeBytes) {
        const reason = 'LRU 淘汰后缓存空间仍不足';
        this.logger.warn(`${reason}，跳过缓存 ${fileId}`);
        return { cached: false, reason };
      }
    }

    // 磁盘空间检查：不足时尝试 LRU 淘汰
    if (!this.hasEnoughDiskSpace()) {
      this.logger.warn(`磁盘空间不足，尝试 LRU 淘汰`);
      await this.evictLRU(this.minFreeDiskBytes);
      if (!this.hasEnoughDiskSpace()) {
        const reason = '磁盘剩余空间不足';
        this.logger.warn(`${reason}，跳过缓存 ${fileId}`);
        return { cached: false, reason };
      }
    }

    const cachePath = this.getCachePath(fileId);
    const tmpPath = cachePath + '.tmp';
    const { createReadStream, createWriteStream } = await import('fs');
    const { pipeline } = await import('stream/promises');

    try {
      await pipeline(
        createReadStream(sourcePath),
        createWriteStream(tmpPath),
      );
      const stat = await fsp.stat(tmpPath);
      if (stat.size !== expectedSize) {
        await fsp.unlink(tmpPath).catch(() => {});
        const reason = `缓存文件大小不一致: 期望 ${expectedSize}, 实际 ${stat.size}`;
        this.logger.warn(`${fileId}: ${reason}`);
        return { cached: false, reason };
      }
      await fsp.rename(tmpPath, cachePath);
      this.logger.log(`缓存预热完成: ${fileId} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
      return { cached: true };
    } catch (err) {
      await fsp.unlink(tmpPath).catch(() => {});
      const reason = (err as Error).message;
      this.logger.warn(`缓存预热失败 ${fileId}: ${reason}`);
      return { cached: false, reason };
    }
  }

  /**
   * 使缓存失效（文件删除/更新时调用）
   */
  async invalidate(fileId: string): Promise<void> {
    this.validateFileId(fileId);
    const pending = this.inflight.get(fileId);
    if (pending) await pending.catch(() => {});
    const cachePath = this.getCachePath(fileId);
    await Promise.all([
      fsp.unlink(cachePath).catch(() => {}),
      fsp.unlink(cachePath + '.tmp').catch(() => {}),
    ]);
    this.fileAccessMap.delete(fileId);
    this.logger.debug(`缓存失效: ${fileId}`);
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

  /** UUID 格式 + 路径穿越双重校验 */
  private validateFileId(fileId: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) {
      throw new Error(`非法的 fileId: ${fileId}`);
    }
    const resolved = path.resolve(this.cacheDir, fileId);
    // 含分隔符前缀校验，防止兄弟目录绕过 startsWith
    if (resolved !== this.cacheDir && !resolved.startsWith(this.cacheDir + path.sep)) {
      throw new Error(`路径穿越攻击: ${fileId}`);
    }
  }

  /**
   * 获取已缓存文件的磁盘路径
   * 文件存在且未过期时返回路径，否则返回 null。
   */
  getCachedPath(fileId: string): string | null {
    this.validateFileId(fileId);
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
    return path.join(this.cacheDir, fileId);
  }
}
