import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bull';
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
  createdAt: Date;
  /** 最后一次活动时间（分片上传/状态查询/合并触发时更新） */
  lastActivityAt: Date;
  /** 合并状态 */
  mergeStatus: 'pending' | 'merging' | 'uploading' | 'done' | 'error';
  /** 合并结果（成功后填充） */
  mergeResult?: { id: string; originalName: string };
  /** 合并错误信息 */
  mergeError?: string;
}

@Injectable()
export class ChunkUploadService implements OnModuleInit {
  private readonly logger = new Logger(ChunkUploadService.name);
  private readonly sessions = new Map<string, ChunkSession>();
  private readonly baseDir: string;

  /** 每用户最大并发会话数 */
  private static readonly MAX_SESSIONS_PER_USER = 10;
  /** 会话最大空闲时间 (ms) — 超过此时间无活动则清理 */
  private static readonly SESSION_MAX_IDLE = CHUNK_SESSION_MAX_IDLE_MS;

  constructor(
    private fileService: FileService,
    @InjectQueue(QUEUE_NAMES.FILE_UPLOAD)
    private fileUploadQueue: Queue,
  ) {
    this.baseDir = path.resolve(process.cwd(), 'tmp', 'uploads');
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  /**
   * 启动时扫描清理孤儿分片目录。
   * 会话仅存内存，进程崩溃/重启后磁盘上的分片目录失去对应会话，成为永久残留。
   * 启动时 baseDir 下凡 UUID 命名、非活跃会话、非 'pending' 子目录的目录均视为孤儿并删除。
   * 异步执行，不阻塞启动。
   */
  async onModuleInit(): Promise<void> {
    this.cleanupOrphanChunkDirs().catch((err) => {
      this.logger.warn(`[分片上传] 启动清理孤儿分片目录失败: ${(err as Error).message}`);
    });
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

    // 并发会话数限制
    const userSessions = [...this.sessions.values()].filter((s) => s.uploadedBy === userId);
    if (userSessions.length >= ChunkUploadService.MAX_SESSIONS_PER_USER) {
      throw new BadRequestException('上传会话过多，请完成或取消现有上传');
    }

    const uploadId = uuidv4();
    const now = new Date();
    const session: ChunkSession = {
      uploadId,
      fileName,
      fileSize,
      mimeType,
      totalChunks,
      chunkSize,
      uploadedBy: userId,
      createdAt: now,
      lastActivityAt: now,
      mergeStatus: 'pending',
    };

    this.sessions.set(uploadId, session);

    // 创建分片存储目录
    const dir = this.getChunkDir(uploadId);
    await fsp.mkdir(dir, { recursive: true });

    this.logger.log(`[分片上传] 初始化会话 ${uploadId}: ${fileName} (${fileSize} bytes, ${totalChunks} chunks)`);
    return { uploadId };
  }

  /** 保存单个分片 */
  async saveChunk(uploadId: string, chunkIndex: number, buffer: Buffer, userId: string): Promise<void> {
    const session = this.getSession(uploadId, userId);

    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= session.totalChunks) {
      throw new BadRequestException(`分片索引 ${chunkIndex} 超出范围 [0, ${session.totalChunks - 1}]`);
    }

    if (buffer.length === 0) {
      throw new BadRequestException('分片数据为空');
    }

    // 校验分片实际大小不超过声明的 chunkSize（最后一片可更小，但任何分片都不应更大），
    // 防止超写字节绕过 fileSize 上限写满磁盘。
    if (buffer.length > session.chunkSize) {
      throw new BadRequestException(`分片大小 ${buffer.length} 超过声明的 chunkSize ${session.chunkSize}`);
    }

    session.lastActivityAt = new Date();

    const dir = this.getChunkDir(uploadId);
    const filePath = path.join(dir, String(chunkIndex));

    // 原子写入：先写临时文件，再 rename
    const tmpPath = filePath + '.tmp';
    await fsp.writeFile(tmpPath, buffer);
    await fsp.rename(tmpPath, filePath);
  }

  /** 从 Multer 磁盘临时文件流式保存分片，避免大 Buffer 常驻内存。 */
  async saveChunkFromPath(
    uploadId: string,
    chunkIndex: number,
    sourcePath: string,
    size: number,
    userId: string,
  ): Promise<void> {
    const session = this.getSession(uploadId, userId);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= session.totalChunks) {
      throw new BadRequestException(`分片索引 ${chunkIndex} 超出范围 [0, ${session.totalChunks - 1}]`);
    }
    if (!Number.isSafeInteger(size) || size <= 0 || size > session.chunkSize) {
      throw new BadRequestException(`分片大小 ${size} 非法或超过声明的 chunkSize ${session.chunkSize}`);
    }
    session.lastActivityAt = new Date();
    const filePath = path.join(this.getChunkDir(uploadId), String(chunkIndex));
    const tmpPath = filePath + '.tmp';
    await pipelineAsync(createReadStream(sourcePath), createWriteStream(tmpPath));
    const stat = await fsp.stat(tmpPath);
    if (stat.size !== size) {
      await fsp.unlink(tmpPath).catch(() => {});
      throw new BadRequestException('分片写入大小校验失败');
    }
    await fsp.rename(tmpPath, filePath);
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

    // 异步执行合并（不 await，不阻塞 HTTP 响应）
    this.doMerge(session, uploadFn)
      .then((result) => {
        session.mergeResult = result;
        session.mergeStatus = 'done';
        this.logger.log(`[分片上传] ${uploadId} 合并完成: ${result.originalName}`);
        // 延迟清理
        this.scheduleCleanup(uploadId);
      })
      .catch((err: Error) => {
        session.mergeStatus = 'error';
        session.mergeError = err.message;
        this.logger.error(`[分片上传] ${uploadId} 合并失败: ${err.message}`);
        // 合并失败也清理临时文件和会话，防止磁盘残留
        this.scheduleCleanup(uploadId);
      });
  }

  /**
   * 小文件内存合并（< 10MB）：先 Buffer.concat 再一次性写入磁盘
   * 避免逐个 stream pipe 的多次 I/O 开销
   */
  private async doMergeSmall(
    session: ChunkSession,
  ): Promise<{ id: string; originalName: string }> {
    const dir = this.getChunkDir(session.uploadId);
    const mergedPath = path.join(dir, 'merged');

    // 顺序读取所有分片到内存拼接
    const buffers: Buffer[] = [];
    for (let i = 0; i < session.totalChunks; i++) {
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
    await fsp.writeFile(mergedPath, merged);
    this.logger.log(`[分片上传] ${session.uploadId} 内存合并完成: ${(merged.length / 1024 / 1024).toFixed(1)}MB`);

    return this.finalizeMerge(session, mergedPath, merged.length);
  }

  private async doMerge(
    session: ChunkSession,
    _uploadFn: (file: Express.Multer.File) => Promise<{ id: string; originalName: string }>,
  ): Promise<{ id: string; originalName: string }> {
    const dir = this.getChunkDir(session.uploadId);
    const mergedPath = path.join(dir, 'merged');

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
      return this.doMergeSmall(session);
    }

    // 大文件：流式合并分片到磁盘文件（避免 Buffer.concat 对大文件造成 OOM）
    const writeStream: WriteStream = createWriteStream(mergedPath, {
      flags: 'w',
      highWaterMark: 64 * 1024, // 64KB 缓冲区，提升写入吞吐
    });
    let written = 0;

    for (let i = 0; i < session.totalChunks; i++) {
      const chunkPath = path.join(dir, String(i));
      try {
        const stat = await fsp.stat(chunkPath);
        if (stat.size === 0) {
          throw new Error(`分片 ${i} 为空`);
        }
        const readStream = createReadStream(chunkPath);
        await pipelineAsync(readStream, writeStream, { end: false });
        written += stat.size;
      } catch (err) {
        writeStream.destroy();
        // 清理未完成的合并文件
        await fsp.unlink(mergedPath).catch(() => {});
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`分片 ${i} 缺失，请重新上传`);
        }
        if ((err as NodeJS.ErrnoException).code === 'ENOSPC') {
          throw new Error(`磁盘空间不足，无法合并 ${(session.fileSize / 1024 / 1024).toFixed(1)}MB 文件，请联系管理员清理空间后重试`);
        }
        throw err;
      }
    }

    // 关闭写入流
    await new Promise<void>((resolve, reject) => {
      writeStream.end((err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });

    if (written !== session.fileSize) {
      await fsp.unlink(mergedPath).catch(() => {});
      throw new Error(`文件大小校验失败: 期望 ${session.fileSize}, 实际 ${written}`);
    }

    this.logger.log(`[分片上传] ${session.uploadId} 合并完成: ${(written / 1024 / 1024).toFixed(1)}MB`);

    return this.finalizeMerge(session, mergedPath, written);
  }

  /**
   * 合并后处理：创建文件记录 → 复制到持久化目录 → 入队后台上传
   */
  private async finalizeMerge(
    session: ChunkSession,
    mergedPath: string,
    fileSize: number,
  ): Promise<{ id: string; originalName: string }> {
    session.mergeStatus = 'uploading';

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

    const savedFile = await this.fileService.createProcessingFile(
      mockFile,
      session.fileName,
      { id: session.uploadedBy } as User,
      undefined,   // tagIds
      true,        // skipTypeCheck
    );

    const pendingDir = path.resolve(process.cwd(), 'tmp', 'uploads', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    const pendingPath = path.join(pendingDir, savedFile.id);
    await fsp.copyFile(mergedPath, pendingPath);

    await this.fileUploadQueue.add(
      'upload',
      { fileId: savedFile.id, filePath: pendingPath },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    );

    this.logger.log(`[分片上传] ${session.uploadId} 已入队后台上传: ${savedFile.id}`);

    return { id: savedFile.id, originalName: savedFile.originalName };
  }

  /** 延迟清理会话和临时文件 */
  private scheduleCleanup(uploadId: string): void {
    setTimeout(() => {
      this.sessions.delete(uploadId);
      const dir = this.getChunkDir(uploadId);
      fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }, CHUNK_CLEANUP_DELAY_MS); // 允许客户端查询结果
  }

  /** 取消上传并清理 */
  async abort(uploadId: string, userId: string): Promise<void> {
    const session = this.sessions.get(uploadId);
    if (!session) return; // 已清理，幂等

    if (session.uploadedBy !== userId) {
      throw new ForbiddenException('无权操作此上传会话');
    }

    this.sessions.delete(uploadId);

    const dir = this.getChunkDir(uploadId);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    this.logger.log(`[分片上传] 取消会话 ${uploadId}`);
  }

  /** 定时清理空闲过久的会话（基于 lastActivityAt） */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    let cleaned = 0;
    for (const [uploadId, session] of this.sessions) {
      if (now - session.lastActivityAt.getTime() > ChunkUploadService.SESSION_MAX_IDLE) {
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
