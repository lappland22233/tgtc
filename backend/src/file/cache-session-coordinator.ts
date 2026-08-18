/**
 * 缓存会话协调器（FileCacheService 拆分出的非 Nest provider 类）
 *
 * 职责：
 * - CacheBuildSession / SpoolSession 的创建、运行、teardown 与中止。
 * - 冷回源并发预算（activeUpstreams + maxConcurrentUpstreams）。
 * - 空闲 / 总超时竞速（与 fetchFn 的 Promise.race + 在途连接防泄漏）。
 * - follower 流：消费者从临时文件 offset 0 独立跟随读取。
 *
 * 设计说明：
 * - 非 @Injectable，由 FileCacheService 在构造时创建并注入依赖。
 * - 持有 buildSessions / spoolSessions / activeUpstreams / shuttingDown 等会话状态，
 *   FileCacheService 通过 getter 暴露给测试与外部（保持 spec 兼容）。
 * - 磁盘路径/容量等由 CacheDiskManager 提供；fileAccessMap 与 service 共享同一实例。
 */
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { Readable } from 'stream';
import { createWriteStream } from 'fs';
import { promises as fsp } from 'fs';
import { FileHandle } from 'fs/promises';
import { EventEmitter } from 'events';
import type { CacheDiskManager } from './cache-disk-manager';

export interface CacheBuildSession {
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
export interface SpoolSession {
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

export interface SessionCoordinatorDeps {
  diskManager: CacheDiskManager;
  fileAccessMap: Map<string, number>;
  logger: Logger;
  /** 关闭信号：置位后不再新建 build/spool 会话，正在进行的会话按策略收尾 */
  isShuttingDown: () => boolean;
  setShuttingDown: (value: boolean) => void;
}

export class CacheSessionCoordinator {
  /** 同一业务文件只允许一个上游回源；消费者从临时文件独立跟随读取。 */
  readonly buildSessions = new Map<string, CacheBuildSession>();
  /** 可重放 spool 会话（无缓存直通 / 容量不足时使用）。 */
  readonly spoolSessions = new Map<string, SpoolSession>();
  /** 当前活跃上游回源数（build + spool），用于冷回源全局并发预算 */
  activeUpstreams = 0;
  /** 上游并发预算：同一时间允许的 Telegram 冷回源上限（可配置） */
  maxConcurrentUpstreams = 8;
  /** 构建空闲超时（毫秒）：写期间无数据则中止会话 */
  buildIdleTimeoutMs = this.readPositiveTimeout('FILE_CACHE_BUILD_IDLE_TIMEOUT_MS', 60_000);
  /** 构建总超时（毫秒）：整个上游回源超过该时长则中止 */
  buildTotalTimeoutMs = this.readPositiveTimeout('FILE_CACHE_BUILD_TOTAL_TIMEOUT_MS', 30 * 60_000);

  constructor(private readonly deps: SessionCoordinatorDeps) {}

  private get logger(): Logger {
    return this.deps.logger;
  }

  private get diskManager(): CacheDiskManager {
    return this.deps.diskManager;
  }

  private get fileAccessMap(): Map<string, number> {
    return this.deps.fileAccessMap;
  }

  private get shuttingDown(): boolean {
    return this.deps.isShuttingDown();
  }

  private readPositiveTimeout(key: string, fallback: number): number {
    const value = Number(process.env[key]);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }

  /** 是否允许开启新的冷回源（关闭中或达到并发预算则拒绝，调用方应回退 503） */
  canStartUpstream(): boolean {
    return !this.shuttingDown && this.activeUpstreams < this.maxConcurrentUpstreams;
  }

  /** buildIdleTimeoutMs 供测试覆盖 */
  setBuildIdleTimeoutMs(value: number): void {
    this.buildIdleTimeoutMs = value;
  }

  /** buildTotalTimeoutMs 供测试覆盖 */
  setBuildTotalTimeoutMs(value: number): void {
    this.buildTotalTimeoutMs = value;
  }

  // ---------- build 会话 ----------

  getOrCreateBuildSession(
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
      tmpPath: this.diskManager.getCachePath(fileId) + '.tmp',
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
  ): Promise<void> {
    const cachePath = this.diskManager.getCachePath(session.fileId);
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
      upstreamPromise = fetchFn();
      const { stream, info } = await Promise.race([upstreamPromise, totalDeadline]);
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

  // ---------- spool 会话 ----------

  /** 获取/创建 spool 会话，返回从 offset 0 独立跟随读取的消费者流 */
  async getSpooledStream(
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
      spoolPath: this.diskManager.getCachePath(fileId) + '.spool',
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
      upstreamPromise = fetchFn();
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
    const coordinator = this;
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
          await coordinator.waitForSessionChange(session);
        }
      } finally {
        coordinator.fileAccessMap.set(session.fileId, Date.now());
      }
    })());

    session.consumerCount++;
    stream.once('close', () => {
      session.consumerCount--;
      // 完成后所有消费者离开 → 清理 spool 文件与会话
      if (session.consumerCount <= 0) {
        void coordinator.teardownSpoolSession(session);
      }
    });
    return stream;
  }

  /** 清理 spool 会话：删除 spool 文件并从 map 移除（幂等） */
  async teardownSpoolSession(session: SpoolSession): Promise<void> {
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

  async waitForSessionReadable(session: CacheBuildSession): Promise<void> {
    while (session.bytesWritten === 0 && !session.completed && !session.error) {
      await this.waitForSessionChange(session);
    }
    if (session.error) throw session.error;
  }

  createFollowerStream(session: CacheBuildSession, start = 0, end = session.expectedSize - 1): Readable {
    const coordinator = this;
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
              handle = await fsp.open(session.completed ? coordinator.diskManager.getCachePath(session.fileId) : session.tmpPath, 'r');
            } catch (error) {
              if (!session.completed) throw error;
              handle = await fsp.open(coordinator.diskManager.getCachePath(session.fileId), 'r');
            }
            const { bytesRead } = await handle.read(buffer, 0, available, offset);
            await handle.close();
            if (bytesRead <= 0) break;
            offset += bytesRead;
            yield Buffer.from(buffer.subarray(0, bytesRead));
          }
          if (session.error) throw session.error;
          if (offset > end || (session.completed && offset >= session.expectedSize)) break;
          await coordinator.waitForSessionChange(session);
        }
      } finally {
        coordinator.fileAccessMap.set(session.fileId, Date.now());
      }
    }
    return Readable.from(follow());
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
}
