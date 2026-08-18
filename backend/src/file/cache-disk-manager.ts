/**
 * 缓存磁盘管理器（FileCacheService 拆分出的非 Nest provider 类）
 *
 * 职责：
 * - 缓存路径解析与 fileId 校验（防路径穿越）。
 * - 目录总大小统计 / 磁盘空间检查（`.tmp`/`.spool` 跳过）。
 * - LRU 淘汰与 fileAccessMap 容量约束。
 * - 过期缓存清理（TTL）与失效文件的批量删除。
 * - 容量准备（超限/磁盘不足时先尝试 LRU 淘汰）。
 *
 * 设计说明：
 * - 不持有配置阈值（由调用方传入），保持无状态可复用。
 * - fileAccessMap 由 FileCacheService 持有并传入（会话协调器共用同一实例）。
 */
import { promises as fsp } from 'fs';
import * as path from 'path';

export class CacheDiskManager {
  /**
   * 内存维护的缓存总大小（G4-03）。
   * - null = 尚未同步（首次需要时做一次全目录扫描初始化）。
   * - 之后每次 发布/淘汰/清理/失效 都在内存增量增减，容量判断 O(1)，
   *   避免每次冷未命中全目录 readdir+stat。
   */
  private cachedSizeBytes: number | null = null;

  constructor(private readonly cacheDir: string) {}

  getCachePath(fileId: string): string {
    return path.join(this.cacheDir, fileId);
  }

  /** UUID 格式 + 路径穿越双重校验 */
  validateFileId(fileId: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) {
      throw new Error(`非法的 fileId: ${fileId}`);
    }
    const resolved = path.resolve(this.cacheDir, fileId);
    // 含分隔符前缀校验，防止兄弟目录绕过 startsWith
    if (resolved !== this.cacheDir && !resolved.startsWith(this.cacheDir + path.sep)) {
      throw new Error(`路径穿越攻击: ${fileId}`);
    }
  }

  /** 获取缓存目录总大小（跳过 .tmp / .spool 临时文件）——O(1) 内存计数 */
  async getTotalCacheSize(): Promise<number> {
    if (this.cachedSizeBytes === null) {
      this.cachedSizeBytes = await this.scanCacheSize();
    }
    return this.cachedSizeBytes;
  }

  /** 全目录扫描统计总大小（仅在内存计数缺失时执行一次） */
  private async scanCacheSize(): Promise<number> {
    try {
      const files = await fsp.readdir(this.cacheDir);
      let total = 0;
      for (const f of files) {
        if (f.endsWith('.tmp') || f.endsWith('.spool')) continue;
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

  /** 记录一次缓存发布（rename 完成后），增量维护内存总大小（G4-03） */
  registerCache(_fileId: string, size: number): void {
    this.cachedSizeBytes = (this.cachedSizeBytes ?? 0) + size;
  }

  /** 从内存计数中扣减某文件的占用（淘汰/清理/失效时调用） */
  private unregisterCache(_fileId: string, size?: number): void {
    if (this.cachedSizeBytes === null) return; // 尚未同步，无需扣减（后续同步会重建）
    this.cachedSizeBytes = Math.max(0, this.cachedSizeBytes - (size ?? 0));
  }

  /** 检查磁盘空间是否充足 */
  hasEnoughDiskSpace(minFreeDiskBytes: number): boolean {
    try {
      const { statfsSync } = require('fs');
      const stats = statfsSync(this.cacheDir);
      // 用 bavail（无特权进程实际可用的块数）而非 bfree（物理剩余块数）：
      // bfree 会把为 root/保留块计作可用，导致"看起来有空间实则写入 ENOSPC"。
      const availBlocks = stats.bavail > 0 ? stats.bavail : 0;
      const freeBytes = stats.bsize * availBlocks;
      return freeBytes >= minFreeDiskBytes;
    } catch {
      // 无法获取磁盘信息时保守判定为空间不足（走 spool/直通），
      // 避免在磁盘不可用时乐观放行导致写入失败（G4-07）。
      this.warnOnStatfsFailure();
      return false;
    }
  }

  /** 告警抑制：避免 statfs 持续失败时每次调用都刷一条 warn */
  private statfsWarned = false;

  private warnOnStatfsFailure(): void {
    if (this.statfsWarned) return;
    this.statfsWarned = true;
    // eslint-disable-next-line no-console
    console.warn(`[CacheDiskManager] statfs 失败，无法获取缓存盘剩余空间，将按空间不足处理（走 spool/直通）`);
  }

  /**
   * LRU 淘汰：按最近访问时间从远到近逐个删除缓存文件，
   * 直到释放足够的空间或没有更多可淘汰文件。
   * @returns 被淘汰的文件数
   */
  async evictLRU(targetFreeBytes: number, fileAccessMap: Map<string, number>): Promise<number> {
    let evicted = 0;

    try {
      const files = await fsp.readdir(this.cacheDir);
      // 收集所有缓存文件的访问时间和大小
      const entries: { name: string; accessTime: number; size: number }[] = [];
      for (const f of files) {
        if (f.endsWith('.tmp') || f.endsWith('.spool')) continue; // 跳过构建/重放临时文件
        try {
          const stat = await fsp.stat(path.join(this.cacheDir, f));
          const accessTime = fileAccessMap.get(f) || stat.atimeMs;
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
          fileAccessMap.delete(entry.name);
          freedBytes += entry.size;
          evicted++;
          this.unregisterCache(entry.name, entry.size);
        } catch {
          continue;
        }
      }
    } catch {
      // 淘汰过程失败不影响主流程
    }

    return evicted;
  }

  /** fileAccessMap 容量上限，超过则淘汰最久未访问的条目，杜绝无界增长 */
  static readonly ACCESS_MAP_MAX = 100000;

  /** 约束 fileAccessMap 规模：超限时从最久未访问的条目开始删除 */
  pruneAccessMap(fileAccessMap: Map<string, number>): void {
    if (fileAccessMap.size <= CacheDiskManager.ACCESS_MAP_MAX) return;
    // Map 按插入序迭代；先按访问时间升序排列再删除最旧的若干条
    const entries = [...fileAccessMap.entries()].sort((a, b) => a[1] - b[1]);
    const removeCount = fileAccessMap.size - CacheDiskManager.ACCESS_MAP_MAX;
    for (let i = 0; i < removeCount; i++) {
      fileAccessMap.delete(entries[i][0]);
    }
  }

  /**
   * LRU 淘汰节流窗口（G4-03）：冷未命中频繁触发时，同一窗口内只执行一次全目录
   * LRU 淘汰，其余请求直接按容量不足处理（走 spool），避免每次冷下载都阻塞在
   * readdir+stat+sort 上。
   */
  static readonly EVICT_THROTTLE_MS = 1000;

  /** 最近一次实际执行 LRU 淘汰的时间戳（0 = 尚未执行） */
  private lastEvictAt = 0;

  /**
   * 容量准备：超限 / 磁盘不足时尝试 LRU 淘汰（带节流），仍不满足则返回 false（走 spool）。
   * 容量判断基于 O(1) 内存计数，淘汰通过 evictLRU 更新同一计数，无需二次全目录扫描。
   */
  async prepareCacheCapacity(
    expectedSize: number,
    maxCacheSizeBytes: number,
    minFreeDiskBytes: number,
    fileAccessMap: Map<string, number>,
  ): Promise<boolean> {
    const totalSize = await this.getTotalCacheSize();
    if (totalSize + expectedSize > maxCacheSizeBytes) {
      if (this.shouldEvict()) {
        await this.evictLRU(totalSize + expectedSize - maxCacheSizeBytes, fileAccessMap);
      }
      if ((await this.getTotalCacheSize()) + expectedSize > maxCacheSizeBytes) return false;
    }
    if (!this.hasEnoughDiskSpace(minFreeDiskBytes)) {
      if (this.shouldEvict()) {
        await this.evictLRU(Math.max(expectedSize, minFreeDiskBytes), fileAccessMap);
      }
      if (!this.hasEnoughDiskSpace(minFreeDiskBytes)) return false;
    }
    return true;
  }

  /** 是否允许执行一次 LRU 淘汰（节流窗口内返回 false） */
  private shouldEvict(): boolean {
    const now = Date.now();
    if (now - this.lastEvictAt < CacheDiskManager.EVICT_THROTTLE_MS) return false;
    this.lastEvictAt = now;
    return true;
  }

  /**
   * 定时清理过期缓存（TTL）并同步清理 fileAccessMap 中已不存在的条目。
   * @returns 清理的文件数
   */
  async cleanupExpiredCache(
    cacheTtlMs: number,
    fileAccessMap: Map<string, number>,
    isBuilding: (fileId: string) => boolean,
  ): Promise<number> {
    const files = await fsp.readdir(this.cacheDir);
    const now = Date.now();
    let cleaned = 0;
    const surviving = new Set<string>();
    for (const f of files) {
      const fullPath = path.join(this.cacheDir, f);
      try {
        const stat = await fsp.stat(fullPath);
        if (f.endsWith('.tmp') && isBuilding(f.slice(0, -4))) {
          surviving.add(f);
        } else if (now - stat.mtimeMs > cacheTtlMs) {
          await fsp.unlink(fullPath);
          fileAccessMap.delete(f); // 同步清理 LRU 记录，防止 Map 泄漏
          if (!f.endsWith('.tmp') && !f.endsWith('.spool')) {
            this.unregisterCache(f, stat.size);
          }
          cleaned++;
        } else {
          surviving.add(f);
        }
      } catch {
        // 文件可能已被删除
      }
    }
    // 清理 fileAccessMap 中已不存在于磁盘的条目（被外部删除/淘汰的文件）
    for (const id of fileAccessMap.keys()) {
      if (!surviving.has(id)) fileAccessMap.delete(id);
    }
    return cleaned;
  }

  /** 失效文件：删除正式缓存 + .tmp + .spool 三件套（幂等） */
  async unlinkAllCacheFiles(fileId: string): Promise<void> {
    const cachePath = this.getCachePath(fileId);
    // 正式缓存删除前记录大小，供内存计数扣减（G4-03）
    let cacheSize: number | undefined;
    try {
      const stat = await fsp.stat(cachePath);
      cacheSize = stat.size;
    } catch { /* 不存在则忽略 */ }
    await Promise.all([
      fsp.unlink(cachePath).catch(() => {}),
      fsp.unlink(cachePath + '.tmp').catch(() => {}),
      fsp.unlink(cachePath + '.spool').catch(() => {}),
    ]);
    if (cacheSize !== undefined) this.unregisterCache(fileId, cacheSize);
  }
}
