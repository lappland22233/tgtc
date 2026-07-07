import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { Readable } from 'stream';
import { createReadStream } from 'fs';
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
  getCachedReadStream(fileId: string, expectedSize: number): Readable | null {
    this.validateFileId(fileId);
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
      return createReadStream(cachePath);
    } catch {
      // 缓存不存在
    }

    return null;
  }

  /** 定时清理过期缓存（每 6 小时执行一次） */
  @Cron('0 */6 * * *')
  async cleanupExpiredCache(): Promise<void> {
    try {
      const files = await fsp.readdir(this.cacheDir);
      const now = Date.now();
      let cleaned = 0;
      for (const f of files) {
        const fullPath = path.join(this.cacheDir, f);
        try {
          const stat = await fsp.stat(fullPath);
          if (now - stat.mtimeMs > this.cacheTtlMs) {
            await fsp.unlink(fullPath);
            cleaned++;
          }
        } catch {
          // 文件可能已被删除
        }
      }
      if (cleaned > 0) {
        this.logger.log(`清理 ${cleaned} 个过期缓存文件`);
      }
    } catch (err) {
      this.logger.warn(`缓存清理失败: ${(err as Error).message}`);
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
   * 缓存文件到本地
   * @param fileId 文件 UUID
   * @param buffer 文件内容
   */
  async cacheFile(fileId: string, buffer: Buffer): Promise<void> {
    this.validateFileId(fileId);

    // 磁盘空间检查
    if (!this.hasEnoughDiskSpace()) {
      this.logger.warn(`磁盘剩余空间不足，跳过缓存 ${fileId}`);
      return;
    }

    // 缓存总大小检查
    const totalSize = await this.getTotalCacheSize();
    if (totalSize + buffer.length > this.maxCacheSizeBytes) {
      this.logger.warn(`缓存总量超限 (${totalSize / 1024 / 1024 / 1024}GB)，跳过缓存 ${fileId}`);
      return;
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
   * 使缓存失效（文件删除/更新时调用）
   */
  async invalidate(fileId: string): Promise<void> {
    this.validateFileId(fileId);
    const cachePath = this.getCachePath(fileId);
    await fsp.unlink(cachePath).catch(() => {});
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
    if (!resolved.startsWith(this.cacheDir)) {
      throw new Error(`路径穿越攻击: ${fileId}`);
    }
  }

  private getCachePath(fileId: string): string {
    return path.join(this.cacheDir, fileId);
  }
}
