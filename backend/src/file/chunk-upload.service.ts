import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

interface ChunkSession {
  uploadId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  totalChunks: number;
  chunkSize: number;
  uploadedBy: string;
  createdAt: Date;
  /** 合并状态 */
  mergeStatus: 'pending' | 'merging' | 'uploading' | 'done' | 'error';
  /** 合并结果（成功后填充） */
  mergeResult?: { id: string; originalName: string };
  /** 合并错误信息 */
  mergeError?: string;
}

@Injectable()
export class ChunkUploadService {
  private readonly logger = new Logger(ChunkUploadService.name);
  private readonly sessions = new Map<string, ChunkSession>();
  private readonly baseDir: string;

  /** 每用户最大并发会话数 */
  private static readonly MAX_SESSIONS_PER_USER = 10;
  /** 会话过期时间 (ms) */
  private static readonly SESSION_TTL = 24 * 60 * 60 * 1000;

  constructor() {
    this.baseDir = path.resolve(process.cwd(), 'tmp', 'uploads');
    fs.mkdirSync(this.baseDir, { recursive: true });
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
    // 并发会话数限制
    const userSessions = [...this.sessions.values()].filter((s) => s.uploadedBy === userId);
    if (userSessions.length >= ChunkUploadService.MAX_SESSIONS_PER_USER) {
      throw new BadRequestException('上传会话过多，请完成或取消现有上传');
    }

    const uploadId = uuidv4();
    const session: ChunkSession = {
      uploadId,
      fileName,
      fileSize,
      mimeType,
      totalChunks,
      chunkSize,
      uploadedBy: userId,
      createdAt: new Date(),
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

    if (chunkIndex < 0 || chunkIndex >= session.totalChunks) {
      throw new BadRequestException(`分片索引 ${chunkIndex} 超出范围 [0, ${session.totalChunks - 1}]`);
    }

    if (buffer.length === 0) {
      throw new BadRequestException('分片数据为空');
    }

    const dir = this.getChunkDir(uploadId);
    const filePath = path.join(dir, String(chunkIndex));

    // 原子写入：先写临时文件，再 rename
    const tmpPath = filePath + '.tmp';
    await fsp.writeFile(tmpPath, buffer);
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
      });
  }

  private async doMerge(
    session: ChunkSession,
    uploadFn: (file: Express.Multer.File) => Promise<{ id: string; originalName: string }>,
  ): Promise<{ id: string; originalName: string }> {
    const dir = this.getChunkDir(session.uploadId);
    const chunks: Buffer[] = [];

    for (let i = 0; i < session.totalChunks; i++) {
      const chunkPath = path.join(dir, String(i));
      try {
        const data = await fsp.readFile(chunkPath);
        if (data.length === 0) {
          throw new Error(`分片 ${i} 为空`);
        }
        chunks.push(data);
      } catch {
        throw new Error(`分片 ${i} 缺失，请重新上传`);
      }
    }

    const merged = Buffer.concat(chunks);

    if (merged.length !== session.fileSize) {
      throw new Error(`文件大小校验失败: 期望 ${session.fileSize}, 实际 ${merged.length}`);
    }

    session.mergeStatus = 'uploading';

    const mockFile: Express.Multer.File = {
      fieldname: 'file',
      originalname: session.fileName,
      encoding: '7bit',
      mimetype: session.mimeType,
      buffer: merged,
      size: merged.length,
      destination: '',
      filename: session.fileName,
      path: '',
      stream: null as any,
    };

    return uploadFn(mockFile);
  }

  /** 延迟清理会话和临时文件 */
  private scheduleCleanup(uploadId: string): void {
    setTimeout(() => {
      this.sessions.delete(uploadId);
      const dir = this.getChunkDir(uploadId);
      fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }, 5 * 60 * 1000); // 5 分钟后清理，允许客户端查询结果
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

  /** 定时清理过期会话 */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    let cleaned = 0;
    for (const [uploadId, session] of this.sessions) {
      if (now - session.createdAt.getTime() > ChunkUploadService.SESSION_TTL) {
        this.sessions.delete(uploadId);
        const dir = this.getChunkDir(uploadId);
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.log(`[分片上传] 清理 ${cleaned} 个过期会话`);
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
    // 双重校验防止路径穿越
    const resolved = path.resolve(this.baseDir, uploadId);
    if (!resolved.startsWith(this.baseDir)) {
      throw new Error('非法的分片目录路径');
    }
    return resolved;
  }
}
