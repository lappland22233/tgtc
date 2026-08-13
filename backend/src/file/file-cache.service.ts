import { Injectable, Logger, OnApplicationShutdown, ServiceUnavailableException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { Readable } from 'stream';
import { createReadStream, createWriteStream } from 'fs';
import { promises as fsp } from 'fs';
import { FileHandle } from 'fs/promises';
import { EventEmitter } from 'events';
import * as path from 'path';
import { ConfigCacheService } from '../common/services/config-cache.service';

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

interface CacheBuildSession {
  fileId: string;
  expectedSize: number;
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
interface SpoolSession {
  fileId: string;
  expectedSize: number;
  spoolPath: string;
  bytesWritten: number;
  completed: boolean;
  error?: Error;
  events: EventEmitter;
  completion: Promise<void>;
  abort: (error: Error) => void;
  upstream?: Readable;
  output?: ReturnType<typeof createWriteStream>;
  /** 活跃消费者数；完成后全部离开时清理 spool 文件 */
  consumerCount: number;
}

@Injectable()
export class FileCacheService implements OnApplicationShutdown {
  private readonly logger = new Logger(FileCacheService.name);
  private readonly cacheDir: string;

  /** 运行时配置（可从管理后台动态调整） */
  private maxCacheSizeBytes = parseInt(CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.MAX_SIZE_GB]) * 1024 * 1024 * 1024;
  private minFreeDiskBytes = parseInt(CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.MIN_FREE_DISK_GB]) * 1024 * 1024 * 1024;
  private cacheTtlMs = parseInt(CACHE_CONFIG_DEFAULTS[CACHE_CONFIG_KEYS.TTL_DAYS]) * 24 * 60 * 60 * 1000;
  /** 无缓存模式：文件下载实时回源直通，不读写本地缓存（可从管理后台动态调整） */
  private noCacheMode = process.env.FILE_CACHE_NO_CACHE_MODE === 'true';

  /** 当前是否处于无缓存模式 */
  isNoCacheMode(): boolean {
    return this.noCacheMode;
  }

  /** 文件最近访问时间追踪 (fileId → lastAccessTimestamp)，用于 LRU 淘汰 */
  private readonly fileAccessMap = new Map<string, number>();
  /** 同一业务文件只允许一个上游回源；消费者从临时文件独立跟随读取。 */
  private readonly buildSessions = new Map<string, CacheBuildSession>();
  /** 可重放 spool 会话（无缓存直通 / 容量不足时使用）。 */
  private readonly spoolSessions = new Map<string, SpoolSession>();
  /** 关闭信号：置位后不再新建 build/spool 会话，正在进行的会话按策略收尾 */
  private shuttingDown = false;
  /** 当前活跃上游回源数（build + spool），用于冷回源全局并发预算 */
  private activeUpstreams = 0;
  /** 上游并发预算：同一时间允许的 Telegram 冷回源上限（可配置） */
  private readonly maxConcurrentUpstreams = 8;
  private readonly buildIdleTimeoutMs = this.readPositiveTimeout('FILE_CACHE_BUILD_IDLE_TIMEOUT_MS', 60_000);
  private readonly buildTotalTimeoutMs = this.readPositiveTimeout('FILE_CACHE_BUILD_TOTAL_TIMEOUT_MS', 30 * 60_000);

  constructor(private readonly configCache: ConfigCacheService) {
    this.cacheDir = path.resolve(process.cwd(), 'tmp', 'Cache');
    fsp.mkdir(this.cacheDir, { recursive: true }).catch(() => {});
    // 异步加载持久化配置
    this.reloadConfig();
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
        this.abortAllBuildSessions();
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
      return this.getNoCacheStream(fileId, expectedSize, fetchFn);
    }

    const cached = this.getCachedReadStream(fileId, expectedSize);
    if (cached) return { stream: cached, fromCache: true };

    if (!(await this.prepareCacheCapacity(expectedSize))) {
      // 容量/磁盘不足：改用可重放 spool（C-04 修复），迟到消费者从 offset 0 完整重放
      this.logger.warn(`缓存容量或磁盘余量不足，文件 ${fileId} 走可重放 spool`);
      return this.getSpooledStream(fileId, expectedSize, fetchFn);
    }

    // 容量准备期间模式可能已翻转，复查避免在无缓存模式下新建构建会话
    if (this.noCacheMode) {
      return this.getNoCacheStream(fileId, expectedSize, fetchFn);
    }

    const session = this.getOrCreateBuildSession(fileId, expectedSize, fetchFn);
    await this.waitForSessionReadable(session);
    return { stream: this.createFollowerStream(session), fromCache: false };
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

    const session = this.getOrCreateBuildSession(fileId, expectedSize, fetchFn);
    return this.createFollowerStream(session, start, end);
  }

  private getOrCreateBuildSession(
    fileId: string,
    expectedSize: number,
    fetchFn: () => Promise<{ stream: Readable; info: { file_size: number } }>,
  ): CacheBuildSession {
    let session = this.buildSessions.get(fileId);
    if (session) {
      if (session.expectedSize !== expectedSize) throw new Error('活动缓存会话的文件大小不一致');
      return session;
    }
    // 冷回源并发预算（H-06）：达到上限或正在关闭时拒绝新建，调用方回退 503
    if (!this.canStartUpstream()) {
      throw new ServiceUnavailableException('系统回源繁忙，请稍后重试');
    }

    const events = new EventEmitter();
    events.setMaxListeners(0);
    session = {
      fileId,
      expectedSize,
      tmpPath: this.getCachePath(fileId) + '.tmp',
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
    session.completion = this.runBuildSession(session, fetchFn);
    session.completion.catch(() => {});
    return session;
  }

  /**
   * 无缓存直通：中止该文件的既有构建会话，实时回源并直通上游流。
   * 同一文件并发消费者共享一个 Telegram 上游连接（in-flight 合并）。
   * 不读缓存、不写缓存（无 .tmp/rename）、不计算容量、不触发 LRU。
   */
  async getNoCacheStream(
    fileId: string,
    expectedSize: number,
    fetchFn: () => Promise<{ stream: Readable; info: { file_size: number } }>,
  ): Promise<{ stream: Readable; fromCache: boolean }> {
    await this.abortBuildSession(fileId);
    return this.getSpooledStream(fileId, expectedSize, fetchFn);
  }

  /** 是否允许开启新的冷回源（关闭中或达到并发预算则拒绝，调用方应回退 503） */
  private canStartUpstream(): boolean {
    return !this.shuttingDown && this.activeUpstreams < this.maxConcurrentUpstreams;
  }

  // ---------- 可重放 spool（C-04：迟到消费者完整重放，不接已前进的 live source） ----------

  /** 获取/创建 spool 会话，返回从 offset 0 独立跟随读取的消费者流 */
  private async getSpooledStream(
    fileId: string,
    expectedSize: number,
    fetchFn: () => Promise<{ stream: Readable; info: { file_size: number } }>,
  ): Promise<{ stream: Readable; fromCache: boolean }> {
    const session = await this.getOrCreateSpoolSession(fileId, expectedSize, fetchFn);
    const stream = this.createSpoolFollowerStream(session);
    return { stream, fromCache: false };
  }

  private async getOrCreateSpoolSession(
    fileId: string,
    expectedSize: number,
    fetchFn: () => Promise<{ stream: Readable; info: { file_size: number } }>,
  ): Promise<SpoolSession> {
    let session = this.spoolSessions.get(fileId);
    if (session) {
      if (session.expectedSize === expectedSize) return session;
      // 大小不一致（覆盖 / 数据异常）：先清理旧 spool 再重建，避免旧大小消费者串流
      await this.teardownSpoolSession(session);
    }
    // 冷回源并发预算（H-06）：达到上限或正在关闭时拒绝新建，调用方回退 503
    if (!this.canStartUpstream()) {
      throw new ServiceUnavailableException('系统回源繁忙，请稍后重试');
    }
    const events = new EventEmitter();
    events.setMaxListeners(0);
    session = {
      fileId,
      expectedSize,
      spoolPath: this.getCachePath(fileId) + '.spool',
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
    session.completion = this.runSpoolSession(session, fetchFn);
    session.completion.catch(() => {});
    return session;
  }

  private async runSpoolSession(
    session: SpoolSession,
    fetchFn: () => Promise<{ stream: Readable; info: { file_size: number } }>,
  ): Promise<void> {
    let idleTimer: NodeJS.Timeout | undefined;
    let totalTimer: NodeJS.Timeout | undefined;
    const resetIdleDeadline = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        session.abort(new Error(`spool 写入空闲超时（${this.buildIdleTimeoutMs}ms）`));
      }, this.buildIdleTimeoutMs);
      idleTimer.unref?.();
    };
    let rejectTotal: ((error: Error) => void) | undefined;
    const totalDeadline = new Promise<never>((_, reject) => { rejectTotal = reject; });
    totalTimer = setTimeout(() => {
      const error = new Error(`spool 写入总超时（${this.buildTotalTimeoutMs}ms）`);
      session.abort(error);
      rejectTotal?.(error);
    }, this.buildTotalTimeoutMs);
    totalTimer.unref?.();

    let upstreamPromise: Promise<{ stream: Readable; info: { file_size: number } }> | undefined;
    this.activeUpstreams++;
    try {
      await fsp.unlink(session.spoolPath).catch(() => {});
      // 在请求上游前先创建 spool 文件，保证首个进度事件到达时跟随者可安全打开。
      await fsp.writeFile(session.spoolPath, Buffer.alloc(0), { flag: 'wx' });
      // 与 build 路径一致的竞速保护：上游无响应时按总超时失败，
      // 避免会话永久卡在 fetchFn 导致 activeUpstreams 永不归零。
      const upstreamPromise = fetchFn();
      const { stream, info } = await Promise.race([upstreamPromise, totalDeadline]);
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
      try {
        for await (const rawChunk of stream) {
          resetIdleDeadline();
          if (session.error) throw session.error;
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          if (session.bytesWritten + chunk.length > session.expectedSize) {
            throw new Error('上游流超过预期文件大小');
          }
          await new Promise<void>((resolve, reject) => {
            output.write(chunk, error => error ? reject(error) : resolve());
          });
          session.bytesWritten += chunk.length;
          session.events.emit('progress');
          resetIdleDeadline();
        }
        if (idleTimer) clearTimeout(idleTimer);
        await new Promise<void>((resolve, reject) => {
          output.once('error', reject);
          output.end(resolve);
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
      // 完成后清理：若已完成由 teardown 管理；失败时立即清理
      if (!session.completed) {
        await fsp.unlink(session.spoolPath).catch(() => {});
        if (this.spoolSessions.get(session.fileId) === session) {
          this.spoolSessions.delete(session.fileId);
        }
      }
      session.events.emit('failed', session.error);
      throw session.error;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      session.upstream = undefined;
      session.output = undefined;
      this.activeUpstreams = Math.max(0, this.activeUpstreams - 1);
    }
  }

  /** 新增一个从 offset 0 独立跟随读取的消费者流 */
  private createSpoolFollowerStream(session: SpoolSession): Readable {
    const service = this;
    const stream = Readable.from((async function* follow(): AsyncGenerator<Buffer> {
      let offset = 0;
      const buffer = Buffer.allocUnsafe(256 * 1024);
      try {
        while (offset < session.expectedSize) {
          while (offset < session.bytesWritten && offset < session.expectedSize) {
            const available = Math.min(buffer.length, session.bytesWritten - offset, session.expectedSize - offset);
            let handle: FileHandle | undefined;
            try {
              handle = await fsp.open(session.spoolPath, 'r');
            } catch (error) {
              if (!session.completed) throw error;
              handle = await fsp.open(session.spoolPath, 'r');
            }
            const { bytesRead } = await handle.read(buffer, 0, available, offset);
            await handle.close();
            if (bytesRead <= 0) break;
            offset += bytesRead;
            yield Buffer.from(buffer.subarray(0, bytesRead));
          }
          if (session.error) throw session.error;
          if (offset >= session.expectedSize || session.completed) break;
          await service.waitForSessionChange(session);
        }
      } finally {
        service.fileAccessMap.set(session.fileId, Date.now());
      }
    })());

    session.consumerCount++;
    stream.once('close', () => {
      session.consumerCount--;
      // 完成后所有消费者离开 → 清理 spool 文件与会话
      if (session.consumerCount <= 0) {
        void service.teardownSpoolSession(session);
      }
    });
    return stream;
  }

  /** 清理 spool 会话：删除 spool 文件并从 map 移除（幂等） */
  private async teardownSpoolSession(session: SpoolSession): Promise<void> {
    if (this.spoolSessions.get(session.fileId) === session) {
      this.spoolSessions.delete(session.fileId);
    }
    session.upstream?.destroy();
    session.output?.destroy();
    await fsp.unlink(session.spoolPath).catch(() => {});
    session.events.removeAllListeners();
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
  private abortAllBuildSessions(): void {
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
  ): Promise<void> {
    const cachePath = this.getCachePath(session.fileId);
    let idleTimer: NodeJS.Timeout | undefined;
    let totalTimer: NodeJS.Timeout | undefined;
    let rejectTotal: ((error: Error) => void) | undefined;
    const totalDeadline = new Promise<never>((_, reject) => { rejectTotal = reject; });
    const resetIdleDeadline = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        session.abort(new Error(`缓存构建空闲超时（${this.buildIdleTimeoutMs}ms）`));
      }, this.buildIdleTimeoutMs);
      idleTimer.unref?.();
    };
    totalTimer = setTimeout(() => {
      const error = new Error(`缓存构建总超时（${this.buildTotalTimeoutMs}ms）`);
      session.abort(error);
      rejectTotal?.(error);
    }, this.buildTotalTimeoutMs);
    totalTimer.unref?.();

    let upstreamPromise: Promise<{ stream: Readable; info: { file_size: number } }> | undefined;
    this.activeUpstreams++;
    try {
      await fsp.unlink(session.tmpPath).catch(() => {});
      // 在请求上游前先创建临时文件，保证首个进度事件到达时跟随者可安全打开。
      await fsp.writeFile(session.tmpPath, Buffer.alloc(0), { flag: 'wx' });
      // 持有在途上游句柄：若 totalDeadline 先触发，catch 中销毁其 stream 防连接泄漏
      const upstreamPromise = fetchFn();
      const { stream, info } = await Promise.race([upstreamPromise, totalDeadline]);
      session.upstream = stream;
      resetIdleDeadline();
      if (!Number.isSafeInteger(info.file_size) || info.file_size !== session.expectedSize) {
        stream.destroy();
        throw new Error(`上游文件大小不一致: 期望 ${session.expectedSize}, 实际 ${info.file_size}`);
      }

      const output = createWriteStream(session.tmpPath, { flags: 'r+' });
      session.output = output;
      try {
        for await (const rawChunk of stream) {
          resetIdleDeadline();
          if (session.error) throw session.error;
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          if (session.bytesWritten + chunk.length > session.expectedSize) {
            throw new Error('上游流超过预期文件大小');
          }
          await new Promise<void>((resolve, reject) => {
            output.write(chunk, error => error ? reject(error) : resolve());
          });
          session.bytesWritten += chunk.length;
          session.events.emit('progress');
          resetIdleDeadline();
        }
        if (idleTimer) clearTimeout(idleTimer);
        await new Promise<void>((resolve, reject) => {
          output.once('error', reject);
          output.end(resolve);
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
      await fsp.rename(session.tmpPath, cachePath);
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
      session.upstream = undefined;
      session.output = undefined;
      this.activeUpstreams = Math.max(0, this.activeUpstreams - 1);
      setImmediate(() => {
        if (this.buildSessions.get(session.fileId) === session) {
          this.buildSessions.delete(session.fileId);
        }
        session.events.removeAllListeners();
      });
    }
  }

  private waitForSessionChange(session: Pick<CacheBuildSession, 'events'> | Pick<SpoolSession, 'events'>): Promise<void> {
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
    });
  }

  private async waitForSessionReadable(session: CacheBuildSession): Promise<void> {
    while (session.bytesWritten === 0 && !session.completed && !session.error) {
      await this.waitForSessionChange(session);
    }
    if (session.error) throw session.error;
  }

  private createFollowerStream(session: CacheBuildSession, start = 0, end = session.expectedSize - 1): Readable {
    const service = this;
    async function* follow(): AsyncGenerator<Buffer> {
      let offset = start;
      const buffer = Buffer.allocUnsafe(256 * 1024);
      try {
        while (offset <= end) {
          while (offset < session.bytesWritten && offset <= end) {
            const available = Math.min(buffer.length, session.bytesWritten - offset, end - offset + 1);
            let handle: FileHandle | undefined;
            try {
              // 每轮短暂持有句柄，兼容 Windows 上活动读句柄会阻止 rename 的行为。
              // 缓存发布后临时路径消失，自动切换到正式缓存文件。
              handle = await fsp.open(session.completed ? service.getCachePath(session.fileId) : session.tmpPath, 'r');
            } catch (error) {
              if (!session.completed) throw error;
              handle = await fsp.open(service.getCachePath(session.fileId), 'r');
            }
            const { bytesRead } = await handle.read(buffer, 0, available, offset);
            await handle.close();
            if (bytesRead <= 0) break;
            offset += bytesRead;
            yield Buffer.from(buffer.subarray(0, bytesRead));
          }
          if (session.error) throw session.error;
          if (offset > end || (session.completed && offset >= session.expectedSize)) break;
          await service.waitForSessionChange(session);
        }
      } finally {
        service.fileAccessMap.set(session.fileId, Date.now());
      }
    }
    return Readable.from(follow());
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
          if (f.endsWith('.tmp') && this.buildSessions.has(f.slice(0, -4))) {
            surviving.add(f);
          } else if (now - stat.mtimeMs > this.cacheTtlMs) {
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
  private readPositiveTimeout(key: string, fallback: number): number {
    const value = Number(process.env[key]);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }

  private pruneAccessMap(): void {
    if (this.fileAccessMap.size <= FileCacheService.ACCESS_MAP_MAX) return;
    // Map 按插入序迭代；先按访问时间升序排列再删除最旧的若干条
    const entries = [...this.fileAccessMap.entries()].sort((a, b) => a[1] - b[1]);
    const removeCount = this.fileAccessMap.size - FileCacheService.ACCESS_MAP_MAX;
    for (let i = 0; i < removeCount; i++) {
      this.fileAccessMap.delete(entries[i][0]);
    }
  }

  private async prepareCacheCapacity(expectedSize: number): Promise<boolean> {
    const totalSize = await this.getTotalCacheSize();
    if (totalSize + expectedSize > this.maxCacheSizeBytes) {
      await this.evictLRU(totalSize + expectedSize - this.maxCacheSizeBytes);
      if ((await this.getTotalCacheSize()) + expectedSize > this.maxCacheSizeBytes) return false;
    }
    if (!this.hasEnoughDiskSpace()) {
      await this.evictLRU(Math.max(expectedSize, this.minFreeDiskBytes));
      if (!this.hasEnoughDiskSpace()) return false;
    }
    return true;
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
        if (f.endsWith('.tmp') || f.endsWith('.spool')) continue; // 跳过构建/重放临时文件
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

  /**
   * 应用关闭钩子（H-09/C-04 配套）：
   * 1. 置位关闭信号，不再新建 build/spool 会话（canStartUpstream 返回 false）；
   * 2. 中止全部进行中的缓存构建（abort → 清理 .tmp）；
   * 3. 等待活跃上游回源收尾（最多 3s，超时强制 destroy）；
   * 4. 清理 spool 临时文件并移除监听器。
   */
  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.logger.log(`缓存服务关闭：中止 ${this.buildSessions.size} 个构建会话、${this.spoolSessions.size} 个 spool 会话`);

    for (const session of this.buildSessions.values()) {
      session.abort(new Error('应用关闭，缓存构建已中止'));
      session.completion.catch(() => {});
    }
    // 等待活跃上游收尾（spool 与 build 共用计数）
    const deadline = Date.now() + 3000;
    while (this.activeUpstreams > 0 && Date.now() < deadline) {
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

  /** 获取缓存目录总大小 */
  private async getTotalCacheSize(): Promise<number> {
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
    if (!this.hasEnoughDiskSpace()) {
      this.logger.warn(`磁盘空间不足，尝试 LRU 淘汰`);
      await this.evictLRU(this.minFreeDiskBytes);
      if (!this.hasEnoughDiskSpace()) {
        this.logger.warn(`磁盘剩余空间仍不足，跳过缓存 ${fileId}`);
        return;
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
        this.logger.warn(`缓存文件大小不一致 ${fileId}: 期望 ${expectedSize}, 实际 ${stat.size}`);
        return;
      }
      await fsp.rename(tmpPath, cachePath);
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
    }
    // 可重放 spool 会话一并销毁（文件删除 / 覆盖更新时终止在途上游）
    const spool = this.spoolSessions.get(fileId);
    if (spool) await this.teardownSpoolSession(spool);
    const cachePath = this.getCachePath(fileId);
    await Promise.all([
      fsp.unlink(cachePath).catch(() => {}),
      fsp.unlink(cachePath + '.tmp').catch(() => {}),
      fsp.unlink(cachePath + '.spool').catch(() => {}),
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
    return path.join(this.cacheDir, fileId);
  }
}
