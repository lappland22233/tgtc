import { Injectable, BadRequestException, NotFoundException, ForbiddenException, ConflictException, HttpException, HttpStatus, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bull';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bull';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { createWriteStream, createReadStream, WriteStream } from 'fs';
import { pipeline } from 'stream';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import { CHUNK_CLEANUP_DELAY_MS, CHUNK_SESSION_MAX_IDLE_MS } from '../common/constants/durations';
import { QUEUE_NAMES } from '../jobs/bull-queue.module';
import { FileService } from './file.service';
import { UploadDiskBudgetService } from './upload-disk-budget.service';
import { User } from '../common/entities/user.entity';

const pipelineAsync = promisify(pipeline);

interface ChunkSession {
  uploadId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  totalChunks: number;
  chunkSize: number;
  uploadedBy: string;
  folderId: string | null;
  /** 覆盖目标 File 记录 id（可选）：合并完成后 in-place 覆盖该记录 */
  overwriteFileId?: string | null;
  /** 首次 finalizeMerge 已创建的 File 记录 id（非覆盖路径）。重试时复用，避免产生重复记录（G3-06） */
  savedFileId?: string;
  /** 与 savedFileId 对应的 uploadVersion，用于重试入队时保持幂等 jobId */
  savedFileUploadVersion?: number;
  /** 严格小盘模式下已从会话目录原子交接的唯一上传源；队列入队失败时可直接重试，不重建分片。 */
  handoffPath?: string;
  /** 在 init 时固定的严格磁盘租约，配置热切换不会改变在途会话的所有权与清理规则。 */
  strictDiskLease?: boolean;
  createdAt: Date;
  /** 最后一次活动时间（分片上传/状态查询/合并触发时更新） */
  lastActivityAt: Date;
  /** 合并状态 */
  mergeStatus: 'pending' | 'merging' | 'uploading' | 'done' | 'error';
  /** 合并结果（成功后填充） */
  mergeResult?: { id: string; originalName: string };
  /** 合并错误信息 */
  mergeError?: string;
  mergeAbortController?: AbortController;
  mergePromise?: Promise<void>;
}

/** G3-04：简单信号量，控制合并并发上限 */
class MergeSemaphore {
  private count: number;
  private waiters: Array<() => void> = [];

  constructor(max: number) {
    this.count = max;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.count++;
  }
}

@Injectable()
export class ChunkUploadService implements OnModuleInit {
  private readonly logger = new Logger(ChunkUploadService.name);
  private readonly sessions = new Map<string, ChunkSession>();
  private readonly baseDir: string;
  private readonly incomingDir: string;
  private readonly maxConcurrentRequestsPerUser: number;
  private readonly maxInFlightRequests: number;
  private readonly maxInFlightBytes: number;
  private readonly minFreeDiskBytes: number;
  private inFlightRequests = 0;
  private inFlightBytes = 0;
  private readonly inFlightRequestsByUser = new Map<string, number>();
  /** 严格模式下每个文件只允许一条分片接收请求，避免 incoming 临时分片突破 2S 预算。 */
  private readonly inFlightRequestsBySession = new Map<string, number>();
  /** G3-04：合并并发信号量（全局 3 + 每用户 1），防止多账号并发大文件合并 OOM */
  private readonly mergeSemaphoreGlobal = new MergeSemaphore(3);
  private readonly mergeSemaphorePerUser = new Map<string, MergeSemaphore>();

  /** 获取/创建用户级合并信号量 */
  private getUserMergeSemaphore(userId: string): MergeSemaphore {
    let sem = this.mergeSemaphorePerUser.get(userId);
    if (!sem) {
      sem = new MergeSemaphore(1);
      this.mergeSemaphorePerUser.set(userId, sem);
    }
    return sem;
  }

  /** 每用户最大并发会话数 */
  private static readonly MAX_SESSIONS_PER_USER = 10;
  /** 会话最大空闲时间 (ms) — 超过此时间无活动则清理 */
  private static readonly SESSION_MAX_IDLE = CHUNK_SESSION_MAX_IDLE_MS;
  private static readonly MERGE_TIMEOUT_MS = 30 * 60 * 1000;
  private static readonly MERGE_ABORT_GRACE_MS = 5000;

  constructor(
    private fileService: FileService,
    @InjectQueue(QUEUE_NAMES.FILE_UPLOAD)
    private fileUploadQueue: Queue,
    private readonly configService: ConfigService,
    private readonly uploadDiskBudget?: UploadDiskBudgetService,
  ) {
    this.baseDir = path.resolve(process.cwd(), 'tmp', 'uploads');
    this.incomingDir = path.join(this.baseDir, 'incoming');
    fs.mkdirSync(this.incomingDir, { recursive: true });
    this.maxConcurrentRequestsPerUser = this.readPositiveConfig('CHUNK_UPLOAD_USER_CONCURRENCY', 3);
    this.maxInFlightRequests = this.readPositiveConfig('CHUNK_UPLOAD_GLOBAL_CONCURRENCY', 24);
    this.maxInFlightBytes = this.readPositiveConfig('CHUNK_UPLOAD_INFLIGHT_BYTES', 256 * 1024 * 1024);
    this.minFreeDiskBytes = this.readPositiveConfig('CHUNK_UPLOAD_MIN_FREE_DISK_BYTES', 1024 * 1024 * 1024);
  }

  /**
   * 启动时扫描清理孤儿分片目录。
   * 会话仅存内存，进程崩溃/重启后磁盘上的分片目录失去对应会话，成为永久残留。
   * 启动时 baseDir 下凡 UUID 命名、非活跃会话、非 'pending' 子目录的目录均视为孤儿并删除。
   * 异步执行，不阻塞启动。
   */
  async onModuleInit(): Promise<void> {
    // 严格小盘模式在接受新会话前先完成遗留临时数据收敛；否则重启后的孤儿分片会与
    // 新文件短暂重叠，占用不属于任何活动预算。
    await Promise.all([
      this.cleanupOrphanChunkDirs(),
      this.cleanupIncomingChunks(),
      this.cleanupOrphanPendingFiles(),
    ].map(async (task) => {
      try {
        await task;
      } catch (err) {
        this.logger.warn(`[分片上传] 启动清理临时数据失败: ${(err as Error).message}`);
      }
    }));
  }

  private isStrictDiskMode(): boolean {
    return this.uploadDiskBudget?.isStrictMode() === true;
  }

  private readPositiveConfig(key: string, fallback: number): number {
    const value = Number(this.configService.get<string>(key));
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }

  private async cleanupIncomingChunks(): Promise<void> {
    const entries = await fsp.readdir(this.incomingDir).catch(() => [] as string[]);
    await Promise.all(entries.map((name) => this.removeIncomingChunk(path.join(this.incomingDir, name))));
  }

  /** G3-03：启动扫描 pending 目录，清理 DB 无对应记录（崩溃窗口残留）的孤儿临时文件与回执 */
  private async cleanupOrphanPendingFiles(): Promise<void> {
    const pendingDir = path.resolve(process.cwd(), 'tmp', 'uploads', 'pending');
    const entries = await fsp.readdir(pendingDir).catch(() => [] as string[]);
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let cleaned = 0;
    for (const name of entries) {
      // 只处理 UUID 命名的主文件（跳过 .telegram.json 回执伴生文件，随主文件一并删除）
      if (!uuidRe.test(name)) continue;
      const exists = await this.fileService.fileRecordExists(name).catch(() => true);
      if (exists) continue; // DB 有记录（处理中/待处理/已完成），保留
      await fsp.rm(path.join(pendingDir, name), { force: true }).catch(() => {});
      await fsp.rm(path.join(pendingDir, `${name}.telegram.json`), { force: true }).catch(() => {});
      cleaned++;
    }
    if (cleaned > 0) {
      this.logger.log(`[分片上传] 启动清理 ${cleaned} 个孤儿 pending 文件（DB 无对应记录）`);
    }
  }

  private async cleanupOrphanChunkDirs(): Promise<void> {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let entries: string[];
    try {
      entries = await fsp.readdir(this.baseDir);
    } catch {
      return; // 目录不存在或不可读，忽略
    }

    let cleaned = 0;
    for (const name of entries) {
      // 仅处理 UUID 命名的目录（分片会话目录），保留 'pending' 等其他子目录
      if (!uuidRe.test(name)) continue;
      if (this.sessions.has(name)) continue; // 活跃会话（启动时通常为空）
      const full = path.join(this.baseDir, name);
      try {
        const stat = await fsp.stat(full);
        if (!stat.isDirectory()) continue;
        await fsp.rm(full, { recursive: true, force: true });
        cleaned++;
      } catch {
        // 单个目录清理失败不影响其余
      }
    }
    if (cleaned > 0) {
      this.logger.log(`[分片上传] 启动清理 ${cleaned} 个孤儿分片目录`);
    }
  }

  /** 初始化上传会话，返回 uploadId */
  async init(
    fileName: string,
    fileSize: number,
    mimeType: string,
    totalChunks: number,
    chunkSize: number,
    userId: string,
    folderId?: string | null,
    overwriteFileId?: string | null,
  ): Promise<{ uploadId: string }> {
    // 文件大小上限校验：结合动态 MAX_FILE_SIZE，防止绕过限制写满磁盘（DoS）
    const maxFileSize = await this.fileService.getMaxFileSize();
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      throw new BadRequestException('非法的 fileSize');
    }
    if (fileSize > maxFileSize) {
      throw new BadRequestException(`文件大小不能超过 ${maxFileSize / 1024 / 1024}MB`);
    }

    // 交叉校验：totalChunks * chunkSize 必须能容纳声明的 fileSize，且不为溢出值
    const declaredCapacity = totalChunks * chunkSize;
    if (!Number.isSafeInteger(declaredCapacity) || declaredCapacity < fileSize) {
      throw new BadRequestException('totalChunks 与 chunkSize 不足以容纳声明的 fileSize');
    }
    if (totalChunks !== Math.ceil(fileSize / chunkSize)) {
      throw new BadRequestException('totalChunks 必须与 fileSize/chunkSize 精确匹配');
    }

    // 覆盖目标预校验：存在 + 归属 + 目录一致，无效直接 400，避免大文件传完才发现目标不可覆盖。
    // init 处只有 userId 字符串，与 finalizeMerge 一致构造 { id } 部分 User。
    // finalizeMerge → createProcessingFile 内部会二次校验兜底。
    if (overwriteFileId) {
      try {
        await this.fileService.assertOverwriteTarget(
          overwriteFileId,
          { id: userId } as User,
          folderId ?? null,
        );
      } catch (err) {
        throw new BadRequestException(`覆盖目标无效: ${(err as Error).message}`);
      }
    }

    // 仅活动状态占用配额。终态会话会短期保留供客户端查询，但不能阻塞后续批量上传。
    // 从配额检查到 sessions.set 之间不执行 await，保证单进程事件循环内检查与注册原子化。
    const activeUserSessions = [...this.sessions.values()].filter(
      (s) => s.uploadedBy === userId && this.isActiveSession(s),
    );
    if (activeUserSessions.length >= ChunkUploadService.MAX_SESSIONS_PER_USER) {
      throw new BadRequestException('上传会话过多，请完成或取消现有上传');
    }

    const uploadId = uuidv4();
    // 严格模式的峰值由“已接收分片 S + 合并输出 S”或“上传源 S + Bot API 媒体 S”组成。
    // 在正文落盘前一次性核验 2S，后续阶段不再额外要求一份完整文件的可用空间。
    const strictDiskLease = this.isStrictDiskMode();
    if (strictDiskLease) {
      await this.ensureDiskSpace(2 * fileSize);
      await this.uploadDiskBudget!.acquireSession(uploadId, fileSize);
    }
    const now = new Date();
    const session: ChunkSession = {
      uploadId,
      fileName,
      fileSize,
      mimeType,
      totalChunks,
      chunkSize,
      uploadedBy: userId,
      folderId: folderId ?? null,
      overwriteFileId: overwriteFileId ?? null,
      strictDiskLease,
      createdAt: now,
      lastActivityAt: now,
      mergeStatus: 'pending',
    };

    this.sessions.set(uploadId, session);

    // 创建分片存储目录；失败时回滚刚注册的会话与可能生成的残留目录。
    const dir = this.getChunkDir(uploadId);
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (error) {
      this.sessions.delete(uploadId);
      this.uploadDiskBudget?.releaseSession(uploadId);
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }

    this.logger.log(`[分片上传] 初始化会话 ${uploadId}: ${fileName} (${fileSize} bytes, ${totalChunks} chunks)`);
    return { uploadId };
  }

  async acquireChunkRequest(
    uploadId: string,
    userId: string,
    contentLength: number,
  ): Promise<() => void> {
    const session = this.getSession(uploadId, userId);
    const reservedBytes = Number.isSafeInteger(contentLength) && contentLength > 0
      ? contentLength
      : session.chunkSize;
    if (reservedBytes > session.chunkSize + 1024 * 1024) {
      throw new BadRequestException('请求体超过声明的分片大小');
    }
    const userRequests = this.inFlightRequestsByUser.get(userId) || 0;
    const sessionRequests = this.inFlightRequestsBySession.get(uploadId) || 0;
    if (userRequests >= this.maxConcurrentRequestsPerUser
      || this.inFlightRequests >= this.maxInFlightRequests
      || this.inFlightBytes + reservedBytes > this.maxInFlightBytes
      || (session.strictDiskLease && sessionRequests >= 1)) {
      throw new HttpException(
        session.strictDiskLease
          ? { statusCode: HttpStatus.TOO_MANY_REQUESTS, code: 'UPLOAD_DISK_BUDGET_BUSY', retryAfterMs: 5000, message: '正在按小盘模式接收上一分片，请稍候' }
          : '上传请求过多，请稍后重试',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await this.ensureDiskSpace(reservedBytes);

    this.inFlightRequests++;
    this.inFlightBytes += reservedBytes;
    this.inFlightRequestsByUser.set(userId, userRequests + 1);
    this.inFlightRequestsBySession.set(uploadId, sessionRequests + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlightRequests = Math.max(0, this.inFlightRequests - 1);
      this.inFlightBytes = Math.max(0, this.inFlightBytes - reservedBytes);
      const remaining = (this.inFlightRequestsByUser.get(userId) || 1) - 1;
      if (remaining > 0) this.inFlightRequestsByUser.set(userId, remaining);
      else this.inFlightRequestsByUser.delete(userId);
      const remainingSession = (this.inFlightRequestsBySession.get(uploadId) || 1) - 1;
      if (remainingSession > 0) this.inFlightRequestsBySession.set(uploadId, remainingSession);
      else this.inFlightRequestsBySession.delete(uploadId);
    };
  }

  private async ensureDiskSpace(requiredBytes: number): Promise<void> {
    try {
      const stats = await fsp.statfs(this.baseDir);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      if (freeBytes - requiredBytes < this.minFreeDiskBytes) {
        throw new HttpException('上传临时磁盘空间不足，请稍后重试', HttpStatus.INSUFFICIENT_STORAGE);
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`[分片上传] 无法检查临时分区空间: ${(error as Error).message}`);
      throw new HttpException('无法确认上传临时磁盘空间', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  async removeIncomingChunk(filePath: string): Promise<void> {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(this.incomingDir + path.sep)) return;
    await fsp.unlink(resolved).catch(() => {});
  }

  /** 将 Multer 已流式落盘的分片原子提交到会话目录。 */
  async saveChunkFromPath(
    uploadId: string,
    chunkIndex: number,
    incomingPath: string,
    actualSize: number,
    userId: string,
  ): Promise<void> {
    const session = this.getSession(uploadId, userId);
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= session.totalChunks) {
      throw new BadRequestException(`分片索引 ${chunkIndex} 超出范围 [0, ${session.totalChunks - 1}]`);
    }
    const expectedSize = chunkIndex === session.totalChunks - 1
      ? session.fileSize - session.chunkSize * (session.totalChunks - 1)
      : session.chunkSize;
    if (expectedSize <= 0 || actualSize !== expectedSize) {
      throw new BadRequestException(`分片大小校验失败: 期望 ${expectedSize}, 实际 ${actualSize}`);
    }
    const stat = await fsp.stat(incomingPath);
    if (!stat.isFile() || stat.size !== actualSize) {
      throw new BadRequestException('分片临时文件大小不一致');
    }

    session.lastActivityAt = new Date();
    const filePath = path.join(this.getChunkDir(uploadId), String(chunkIndex));
    await fsp.rename(incomingPath, filePath);
  }

  /** 查询已传分片状态（断点续传） */
  async getStatus(uploadId: string, userId: string): Promise<{
    uploadId: string;
    totalChunks: number;
    uploaded: number[];
    mergeStatus: string;
    mergeResult: { id: string; originalName: string } | null;
    mergeError: string | null;
  }> {
    const session = this.getSession(uploadId, userId);
    session.lastActivityAt = new Date();
    const dir = this.getChunkDir(uploadId);

    const uploaded: number[] = [];
    try {
      const files = await fsp.readdir(dir);
      for (const f of files) {
        const idx = parseInt(f, 10);
        if (!isNaN(idx) && idx >= 0 && idx < session.totalChunks) {
          const stat = await fsp.stat(path.join(dir, f));
          if (stat.size > 0) {
            uploaded.push(idx);
          }
        }
      }
    } catch {
      // 目录不存在视为无已传分片
    }

    return {
      uploadId,
      totalChunks: session.totalChunks,
      uploaded: uploaded.sort((a, b) => a - b),
      mergeStatus: session.mergeStatus,
      mergeResult: session.mergeResult || null,
      mergeError: session.mergeError || null,
    };
  }

  /**
   * 启动异步合并（立即返回，后台执行合并+上传）。
   * 合并状态通过 getStatus 查询。
   */
  triggerMerge(
    uploadId: string,
    userId: string,
    uploadFn: (file: Express.Multer.File) => Promise<{ id: string; originalName: string }>,
  ): void {
    const session = this.getSession(uploadId, userId);

    if (session.mergeStatus === 'merging' || session.mergeStatus === 'uploading') {
      this.logger.warn(`[分片上传] ${uploadId} 已在合并中`);
      return;
    }
    if (session.mergeStatus === 'done') {
      this.logger.warn(`[分片上传] ${uploadId} 已完成合并`);
      return;
    }

    session.lastActivityAt = new Date();
    session.mergeStatus = 'merging';
    session.mergeAbortController = new AbortController();

    // G3-04：合并受全局 + 用户级信号量约束，防止多账号并发大文件合并造成 OOM/磁盘放大。
    // 等待信号量不计入合并超时窗口（deadline 从真正开始合并时计时）。
    const mergePromise = this.runMergeWithSemaphore(session, uploadFn, uploadId);
    session.mergePromise = mergePromise;
  }

  /** G3-04：在全局 + 用户级信号量保护下执行合并，统一结果写入/失败处理/收尾 */
  private async runMergeWithSemaphore(
    session: ChunkSession,
    uploadFn: (file: Express.Multer.File) => Promise<{ id: string; originalName: string }>,
    uploadId: string,
  ): Promise<void> {
    const userSem = this.getUserMergeSemaphore(session.uploadedBy);
    await this.mergeSemaphoreGlobal.acquire();
    await userSem.acquire();
    try {
      const controller = session.mergeAbortController!;
      const result = await this.withDeadline(
        this.doMerge(session, uploadFn, controller.signal),
        ChunkUploadService.MERGE_TIMEOUT_MS,
        controller,
      );
      if (controller.signal.aborted) return;
      session.mergeResult = result;
      session.mergeStatus = 'done';
      this.logger.log(`[分片上传] ${uploadId} 合并完成: ${result.originalName}`);
      this.scheduleCleanup(uploadId);
    } catch (err) {
      session.mergeStatus = 'error';
      session.mergeError = (err as Error).message;
      this.logger.error(`[分片上传] ${uploadId} 合并失败: ${(err as Error).message}`);
      this.scheduleCleanup(uploadId);
    } finally {
      userSem.release();
      this.mergeSemaphoreGlobal.release();
      session.mergeAbortController = undefined;
      session.mergePromise = undefined;
    }
  }

  /**
   * 小文件内存合并（< 10MB）：先 Buffer.concat 再一次性写入磁盘
   * 避免逐个 stream pipe 的多次 I/O 开销
   */
  private async doMergeSmall(
    session: ChunkSession,
    signal: AbortSignal,
  ): Promise<{ id: string; originalName: string }> {
    const dir = this.getChunkDir(session.uploadId);
    const mergedPath = path.join(dir, 'merged');

    // 顺序读取所有分片到内存拼接
    const buffers: Buffer[] = [];
    for (let i = 0; i < session.totalChunks; i++) {
      this.throwIfAborted(signal);
      const chunkPath = path.join(dir, String(i));
      try {
        const buf = await fsp.readFile(chunkPath);
        if (buf.length === 0) {
          throw new Error(`分片 ${i} 为空`);
        }
        buffers.push(buf);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`分片 ${i} 缺失，请重新上传`);
        }
        throw err;
      }
    }

    const merged = Buffer.concat(buffers);
    if (merged.length !== session.fileSize) {
      throw new Error(`文件大小校验失败: 期望 ${session.fileSize}, 实际 ${merged.length}`);
    }

    // 一次性写入磁盘
    this.throwIfAborted(signal);
    await fsp.writeFile(mergedPath, merged);
    this.logger.log(`[分片上传] ${session.uploadId} 内存合并完成: ${(merged.length / 1024 / 1024).toFixed(1)}MB`);

    return this.finalizeMerge(session, mergedPath, merged.length, signal);
  }

  private async doMerge(
    session: ChunkSession,
    _uploadFn: (file: Express.Multer.File) => Promise<{ id: string; originalName: string }>,
    signal: AbortSignal,
  ): Promise<{ id: string; originalName: string }> {
    const dir = this.getChunkDir(session.uploadId);
    const mergedPath = path.join(dir, 'merged');

    // Redis 入队短暂失败时，唯一上传源可能仍在 pending，或已安全回退为 merged；重试
    // complete 只重试交接/入队，不重建文件或误报分片缺失。
    if (session.handoffPath) {
      const handoffStat = await fsp.stat(session.handoffPath).catch(() => undefined);
      if (!handoffStat?.isFile() || handoffStat.size !== session.fileSize) {
        throw new Error('已交接的上传源缺失或大小不一致，请重新上传');
      }
      return this.finalizeMerge(session, session.handoffPath, handoffStat.size, signal);
    }
    if (session.savedFileId) {
      const existingMerged = await fsp.stat(mergedPath).catch(() => undefined);
      if (existingMerged?.isFile() && existingMerged.size === session.fileSize) {
        return this.finalizeMerge(session, mergedPath, existingMerged.size, signal);
      }
    }

    // 日志：记录合并开始（用于排查 OOM/磁盘问题）
    this.logger.log(`[分片上传] ${session.uploadId} 开始合并 ${session.totalChunks} 个分片 (${(session.fileSize / 1024 / 1024).toFixed(1)}MB)`);

    // 检查 baseDir 可访问性
    try {
      await fsp.access(this.baseDir, fsp.constants.W_OK);
    } catch {
      throw new Error(`上传目录不可写: ${this.baseDir}`);
    }

    // 小文件 (< 10MB)：使用 Buffer.concat 内存合并，减少磁盘 I/O
    const SMALL_FILE_THRESHOLD = 10 * 1024 * 1024; // 10MB
    if (session.fileSize < SMALL_FILE_THRESHOLD) {
      return this.doMergeSmall(session, signal);
    }

    // 大文件：流式合并分片到磁盘文件（避免 Buffer.concat 对大文件造成 OOM）
    const writeStream: WriteStream = createWriteStream(mergedPath, {
      flags: 'w',
      highWaterMark: 64 * 1024, // 64KB 缓冲区，提升写入吞吐
    });

    // 单管道：顺序异步生成器逐片打开/读取/关闭，经一次 pipeline 写入目标文件。
    // 旧实现对同一 WriteStream 循环 pipeline({ end: false })，目标流监听器随分片数
    // 累积并触发 MaxListenersExceededWarning（125 片实际报告）；此处监听器数量恒定。
    let currentReadStream: fs.ReadStream | undefined;
    let written = 0;
    const abortError = new Error('分片合并已取消');

    async function* chunkSequence(): AsyncGenerator<Buffer> {
      for (let i = 0; i < session.totalChunks; i++) {
        if (signal.aborted) throw abortError;
        const chunkPath = path.join(dir, String(i));
        let stat: fs.Stats;
        try {
          stat = await fsp.stat(chunkPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(`分片 ${i} 缺失，请重新上传`);
          }
          throw err;
        }
        if (stat.size === 0) {
          throw new Error(`分片 ${i} 为空`);
        }
        const readStream = createReadStream(chunkPath);
        currentReadStream = readStream;
        try {
          for await (const buf of readStream) {
            if (signal.aborted) throw abortError;
            written += buf.length;
            yield buf;
          }
        } finally {
          currentReadStream = undefined;
          readStream.destroy();
        }
      }
    }

    // 取消需在写背压/读盘等待期间同样生效：销毁正在读取的分片流
    //（目标流与生成器源由 pipeline 的 signal 统一销毁，生成器 finally 关闭分片流）
    const onAbort = () => {
      currentReadStream?.destroy(abortError);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      try {
        // 取消信号传入管道：abort 时源与目标流由 pipeline 统一销毁
        await pipelineAsync(chunkSequence(), writeStream, { signal });
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    } catch (err) {
      writeStream.destroy();
      // 清理未完成的合并文件（原分片保留，仍有重试价值）
      await fsp.unlink(mergedPath).catch(() => {});
      if (signal.aborted) {
        throw abortError;
      }
      if ((err as NodeJS.ErrnoException).code === 'ENOSPC') {
        throw new Error(`磁盘空间不足，无法合并 ${(session.fileSize / 1024 / 1024).toFixed(1)}MB 文件，请联系管理员清理空间后重试`);
      }
      throw err;
    }

    if (written !== session.fileSize) {
      await fsp.unlink(mergedPath).catch(() => {});
      throw new Error(`文件大小校验失败: 期望 ${session.fileSize}, 实际 ${written}`);
    }

    this.logger.log(`[分片上传] ${session.uploadId} 合并完成: ${(written / 1024 / 1024).toFixed(1)}MB`);

    return this.finalizeMerge(session, mergedPath, written, signal);
  }

  /**
   * 合并后处理：创建文件记录 → 原子交接唯一上传源 → 入队后台上传。
   *
   * 交接不再复制完整 `merged` 为 `pending`：同一 `tmp/uploads` 文件系统内使用 rename，
   * 随后立即释放原分片目录。无缓存严格模式的峰值因此为“分片 S + 合并 S”或
   * “pending S + Bot API 媒体 S”，而不是三份或更多完整文件重叠。
   */
  private async finalizeMerge(
    session: ChunkSession,
    mergedPath: string,
    fileSize: number,
    signal: AbortSignal,
  ): Promise<{ id: string; originalName: string }> {
    this.throwIfAborted(signal);
    session.mergeStatus = 'uploading';

    // 非严格模式仍保留一份交接所需的可用空间检查；严格模式已在 init 预留完整 2S，
    // 此处不得再要求额外两份空间，否则小盘永远无法进入最终交接阶段。
    if (!session.strictDiskLease) {
      try {
        await this.ensureDiskSpace(fileSize);
      } catch (error) {
        session.mergeStatus = 'error';
        session.mergeError = (error as Error).message || '磁盘空间不足';
        throw error;
      }
    }

    // magic bytes 类型检查
    const fileSample = this.fileService.getFileSampleFromPath(mergedPath);
    const typeCheck = await this.fileService.isFileTypeAllowed(
      session.fileName,
      fileSample,
    );
    if (!typeCheck.allowed) {
      session.mergeStatus = 'error';
      session.mergeError = typeCheck.reason || '不允许上传此类型的文件';
      throw new BadRequestException(typeCheck.reason || '不允许上传此类型的文件');
    }

    const mockFile: Express.Multer.File = {
      fieldname: 'file',
      originalname: session.fileName,
      encoding: '7bit',
      mimetype: session.mimeType,
      buffer: null as any,
      size: fileSize,
      destination: '',
      filename: session.fileName,
      path: mergedPath,
      stream: null as any,
    };

    // 首次成功 createProcessingFile 后复用同一记录；预热延后到原子交接完成，避免异步
    // 缓存读取即将被 rename 的路径。已经交接却暂未入队时，只重新尝试入队，不重建分片。
    let savedFile: { id: string; uploadVersion: number; originalName: string };
    this.throwIfAborted(signal);
    if (session.savedFileId && session.savedFileUploadVersion !== undefined) {
      savedFile = await this.fileService.getProcessingFileOrThrow(
        session.savedFileId,
        session.savedFileUploadVersion,
      );
    } else {
      const created = await this.fileService.createProcessingFile(
        mockFile,
        session.fileName,
        { id: session.uploadedBy } as User,
        undefined,
        true,
        session.folderId,
        session.overwriteFileId ?? undefined,
        { deferCachePrewarm: true },
      );
      session.savedFileId = created.id;
      session.savedFileUploadVersion = created.uploadVersion;
      savedFile = { id: created.id, uploadVersion: created.uploadVersion, originalName: created.originalName };
    }

    this.throwIfAborted(signal);
    const pendingDir = path.resolve(process.cwd(), 'tmp', 'uploads', 'pending');
    await fsp.mkdir(pendingDir, { recursive: true });
    const pendingPath = path.join(pendingDir, savedFile.id);
    const alreadyHandedOff = session.handoffPath === pendingPath;
    if (!alreadyHandedOff) {
      // 覆盖上传复用同一 pendingPath：移除陈旧版本回执，避免 v2 读到 v1 的远端结果。
      await fsp.rm(`${pendingPath}.telegram.json`, { force: true }).catch(() => {});
      try {
        await fsp.rename(mergedPath, pendingPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
          throw new Error('上传暂存目录与 pending 目录必须位于同一文件系统，严格模式拒绝创建额外完整副本');
        }
        throw error;
      }
      session.handoffPath = pendingPath;
    }

    // 普通缓存模式在入队前完成预热，避免 Worker 删除 pending 时与预热流竞争。
    // 严格无缓存模式跳过这一步，因此此处只会保留 pending 这一份上传源。
    if (!session.strictDiskLease && typeof this.fileService.startCachePrewarm === 'function') {
      await this.fileService.startCachePrewarm(savedFile, pendingPath, fileSize);
    }

    // Bull 在 add 成功后可能立刻开始 Worker。严格模式必须先释放分片 S，确保 Worker
    // 上传期间只有 pending S 与 Bot API 媒体副本最多重叠；若 add 失败，下方会把 pending
    // 原子回退为 merged，保留完整恢复源。
    if (session.strictDiskLease && !alreadyHandedOff) {
      await fsp.rm(this.getChunkDir(session.uploadId), { recursive: true, force: true });
    }

    this.throwIfAborted(signal);
    const jobId = `file-upload:${savedFile.id}:${savedFile.uploadVersion}`;
    const leaseTransferred = session.strictDiskLease
      ? this.uploadDiskBudget!.transferSessionToJob(session.uploadId, savedFile.id, savedFile.uploadVersion)
      : true;
    if (!leaseTransferred) {
      throw new Error('上传磁盘预算租约已丢失，请重新上传');
    }
    try {
      await this.fileUploadQueue.add(
        'upload',
        {
          fileId: savedFile.id,
          filePath: pendingPath,
          uploadVersion: savedFile.uploadVersion,
          strictDiskLease: session.strictDiskLease === true,
        },
        {
          jobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 10000 },
          removeOnComplete: 100,
          removeOnFail: 50,
        },
      );
    } catch (err) {
      // 入队失败时保留已交接的唯一源并把租约还给会话。分片目录可能已释放；下次
      // complete 通过 handoffPath 仅重试入队，绝不能吞掉回迁失败后再尝试重建分片。
      this.uploadDiskBudget?.transferJobToSession(session.uploadId, savedFile.id, savedFile.uploadVersion);
      throw err;
    }

    // withDeadline 超时 abort 与 queue.add 的竞态：成功入队后仍可能收到取消，移除任务并清理。
    if (signal.aborted || !this.isActiveSession(session)) {
      this.logger.warn(
        `[分片上传] ${session.uploadId} 入队后检测到中止，移除任务 ${jobId} 并清理记录 ${savedFile.id}`,
      );
      const queuedJob = await this.fileUploadQueue.getJob(jobId).catch(() => undefined);
      if (queuedJob) await queuedJob.remove().catch(() => {});
      await this.cleanupUploadingSideEffects(session);
      throw new Error('分片合并已取消');
    }

    // 队列接管后 pending 是唯一恢复源，原分片立即删除，避免固定 5 分钟的额外 S 占用。
    await fsp.rm(this.getChunkDir(session.uploadId), { recursive: true, force: true }).catch((error) => {
      this.logger.warn(`[分片上传] 入队后清理分片目录失败: ${(error as Error).message}`);
    });
    this.logger.log(`[分片上传] ${session.uploadId} 已入队后台上传: ${savedFile.id}`);
    return { id: savedFile.id, originalName: savedFile.originalName };
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('分片合并已取消');
  }

  private async withDeadline<T>(
    promise: Promise<T>,
    timeoutMs: number,
    controller: AbortController,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`分片合并超时（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref?.();
      promise.then(
        value => { clearTimeout(timer); resolve(value); },
        error => { clearTimeout(timer); reject(error); },
      );
    });
  }

  private async cancelMerge(session: ChunkSession): Promise<void> {
    session.mergeAbortController?.abort();
    if (!session.mergePromise) return;
    await Promise.race([
      session.mergePromise.catch(() => {}),
      new Promise<void>(resolve => {
        const timer = setTimeout(resolve, ChunkUploadService.MERGE_ABORT_GRACE_MS);
        timer.unref?.();
      }),
    ]);
  }

  private isActiveSession(session: ChunkSession): boolean {
    return session.mergeStatus === 'pending'
      || session.mergeStatus === 'merging'
      || session.mergeStatus === 'uploading';
  }

  /** 延迟清理会话查询状态；错误会话的分片与严格预算在此收敛。 */
  private scheduleCleanup(uploadId: string): void {
    setTimeout(() => {
      const session = this.sessions.get(uploadId);
      this.sessions.delete(uploadId);
      const dir = this.getChunkDir(uploadId);
      fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      // 成功会话的租约已转交给 Worker job；错误会话仍持有 session 租约，清理后归还。
      if (session?.mergeStatus === 'error') this.uploadDiskBudget?.releaseSession(uploadId);
    }, CHUNK_CLEANUP_DELAY_MS); // 允许客户端查询结果
  }

  /** 取消上传并清理 */
  async abort(uploadId: string, userId: string): Promise<void> {
    const session = this.sessions.get(uploadId);
    if (!session) return; // 已清理，幂等

    if (session.uploadedBy !== userId) {
      throw new ForbiddenException('无权操作此上传会话');
    }

    await this.cancelMerge(session);

    // 入队任务可能已被 Worker 取得并打开 pending 文件。此时强行取消会破坏回执恢复并让
    // 严格预算错误释放；明确返回冲突，由后台任务安全收尾。尚未开始的 waiting/delayed 任务可取消。
    if (session.savedFileId && session.handoffPath) {
      const removedBeforeStart = await this.cleanupUploadingSideEffects(session);
      if (!removedBeforeStart) {
        throw new ConflictException('上传已被后台处理接管，无法安全取消，请等待任务完成');
      }
    }

    this.sessions.delete(uploadId);
    const dir = this.getChunkDir(uploadId);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    this.uploadDiskBudget?.releaseSession(uploadId);
    this.logger.log(`[分片上传] 取消会话 ${uploadId}`);
  }

  /** 仅清理尚未开始的队列任务；返回是否已确认删除其 pending 上传源。 */
  private async cleanupUploadingSideEffects(session: ChunkSession): Promise<boolean> {
    const fileId = session.savedFileId!;
    const uploadVersion = session.savedFileUploadVersion ?? 1;
    const jobId = `file-upload:${fileId}:${uploadVersion}`;
    let safelyRemovedBeforeStart = false;
    try {
      const queuedJob = await this.fileUploadQueue.getJob(jobId).catch(() => undefined);
      if (queuedJob) {
        const state = typeof queuedJob.getState === 'function' ? await queuedJob.getState().catch(() => 'unknown') : 'unknown';
        if (state === 'waiting' || state === 'delayed' || state === 'paused') {
          await queuedJob.remove();
          safelyRemovedBeforeStart = true;
        }
      }
    } catch {
      // active/failed/remove race：保留上传源和严格预算，由 Worker 的终态清理收尾。
    }
    if (!safelyRemovedBeforeStart) return false;

    // 只有确认 Worker 尚未取得任务时才结束 processing／删除源；活跃 Worker 可能仍持有打开的
    // 文件描述符，过早改变数据库状态或释放预算会破坏回执恢复与严格空间保证。
    if (session.overwriteFileId) {
      await this.fileService.markProcessingFileFailed?.(fileId).catch(() => {});
    } else {
      await this.fileService.softDeleteProcessingFile(fileId).catch(() => {});
    }

    // 活跃 Worker 可能仍持有打开的
    // 文件描述符，过早释放会让严格模式在同一物理空间上错误放行下一份大文件。
    const pendingDir = path.resolve(process.cwd(), 'tmp', 'uploads', 'pending');
    const pendingPath = path.join(pendingDir, fileId);
    const sourceRemoved = await fsp.rm(pendingPath, { force: true }).then(() => true).catch(() => false);
    await fsp.rm(`${pendingPath}.telegram.json`, { force: true }).catch(() => {});
    if (sourceRemoved) this.uploadDiskBudget?.releaseJob(fileId, uploadVersion);
    return sourceRemoved;
  }

  /** 定时清理空闲过久的会话（基于 lastActivityAt） */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    let cleaned = 0;
    for (const [uploadId, session] of this.sessions) {
      // G3-01：跳过进行中的活跃会话（pending/merging/uploading），
      // 避免慢合并（最长 MERGE_TIMEOUT=30min）被本清理任务按 lastActivityAt 误中断。
      if (this.isActiveSession(session)) continue;
      if (now - session.lastActivityAt.getTime() > ChunkUploadService.SESSION_MAX_IDLE) {
        await this.cancelMerge(session);
        this.sessions.delete(uploadId);
        const dir = this.getChunkDir(uploadId);
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.log(`[分片上传] 清理 ${cleaned} 个空闲过期会话`);
    }
  }

  /** 获取会话并校验归属 */
  private getSession(uploadId: string, userId: string): ChunkSession {
    // UUID 格式校验
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId)) {
      throw new BadRequestException('无效的 uploadId 格式');
    }

    const session = this.sessions.get(uploadId);
    if (!session) {
      throw new NotFoundException('上传会话不存在或已过期');
    }

    if (session.uploadedBy !== userId) {
      throw new ForbiddenException('无权操作此上传会话');
    }

    return session;
  }

  /** 获取分片目录并确保安全 */
  private getChunkDir(uploadId: string): string {
    // 双重校验防止路径穿越：要求解析结果必须位于 baseDir 之内（含分隔符前缀，防兄弟目录绕过）
    const resolved = path.resolve(this.baseDir, uploadId);
    if (resolved !== this.baseDir && !resolved.startsWith(this.baseDir + path.sep)) {
      throw new Error('非法的分片目录路径');
    }
    return resolved;
  }
}
