import { Injectable, NotFoundException, ForbiddenException, BadRequestException, HttpException, OnModuleInit, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, IsNull, EntityManager } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Readable } from 'stream';
import { Request } from 'express';
import { spawn } from 'child_process';
import * as fs from 'fs';
import { createReadStream, writeFileSync } from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { QUEUE_NAMES } from '../jobs/bull-queue.module';
import { File, FileAccessType } from '../common/entities/file.entity';
import { Folder } from '../common/entities/folder.entity';
import { FileAccessLog } from '../common/entities/file-access-log.entity';
import { TelegramService } from '../telegram/telegram.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { User, UserRole } from '../common/entities/user.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { ShareAudit } from '../common/entities/share-audit.entity';
import { RateLimitService } from '../common/services/rate-limit.service';
import { AuditService } from '../common/services/audit.service';
import { UploadJobService, UploadJob } from './upload-job.service';
import { FileCacheService } from './file-cache.service';
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { BCRYPT_ROUNDS } from '../common/constants/bcrypt';
import { FILE_DELETE_GRACE_MS, FILE_DELETE_COOLDOWN_MS } from '../common/constants/durations';

export class RangeNotSatisfiableException extends HttpException {
  constructor(public readonly total: number) {
    super('Range 范围无效', 416);
  }
}

export interface BatchUploadFailedItem {
  name: string;
  reason: string;
}

export interface BatchUploadResult {
  success: File[];
  failed: BatchUploadFailedItem[];
}

/** 已知复合扩展名列表（优先匹配，防止 .tar.gz 被错误识别为 .gz） */
const COMPOUND_EXTENSIONS = ['.tar.gz', '.tar.bz2', '.tar.xz'] as const;

/** 视频标准封面最大宽度（FFmpeg scale 上限） */
const VIDEO_COVER_MAX_WIDTH = 480;
/** 高清视频封面最大宽度（前端检测到标准封面低于阈值时切换到高清接口） */
const VIDEO_HD_COVER_MAX_WIDTH = 1280;
/** 高清封面 WebP 质量 */
const VIDEO_HD_COVER_QUALITY = 75;

@Injectable()
export class FileService implements OnModuleInit {
  private readonly logger = new Logger(FileService.name);
  private maxFileSize: number;
  private fileTypeMode: 'blacklist' | 'whitelist' = 'blacklist';
  private fileTypeFilter: string[] = [];
  private accessCountDefault = -1;
  private accessCountMax = -1;
  private readonly thumbnailDir: string;
  /** 同一进程内按文件合并缩略图生成，避免在线请求、上传回调和启动扫描竞写。 */
  private readonly thumbnailBuilds = new Map<string, Promise<void>>();
  private readonly videoCoverBuilds = new Map<string, Promise<void>>();

  constructor(
    @InjectRepository(File)
    private fileRepository: Repository<File>,
    @InjectRepository(Folder)
    private folderRepository: Repository<Folder>,
    @InjectRepository(FileAccessLog)
    private accessLogRepository: Repository<FileAccessLog>,
    @InjectRepository(BannedIP)
    private bannedIPRepository: Repository<BannedIP>,
    @InjectRepository(ShareAudit)
    private shareAuditRepository: Repository<ShareAudit>,
    private telegramService: TelegramService,
    private configService: ConfigService,
    private jwtService: JwtService,
    private configCacheService: ConfigCacheService,
    private rateLimitService: RateLimitService,
    private uploadJobService: UploadJobService,
    private auditService: AuditService,
    private fileCacheService: FileCacheService,
    @InjectQueue(QUEUE_NAMES.FILE_UPLOAD)
    private fileUploadQueue: Queue,
  ) {
    this.maxFileSize = this.parseFileSize(this.configService.get<string>('MAX_FILE_SIZE'));
    this.thumbnailDir = this.configService.get<string>('THUMBNAIL_DIR') || path.join(process.cwd(), 'tmp', 'thumbnails');
  }

  async onModuleInit() {
    await this.reloadUploadConfig();
    // 确保缩略图目录存在
    if (!fs.existsSync(this.thumbnailDir)) {
      fs.mkdirSync(this.thumbnailDir, { recursive: true });
      this.logger.log(`缩略图目录已创建: ${this.thumbnailDir}`);
    }
    // 异步扫描并补齐缺失的缩略图（不阻塞启动）
    this.syncMissingThumbnails().catch(err => {
      this.logger.warn(`缩略图同步失败: ${err.message}`);
    });
  }

  @OnEvent('config.changed')
  async handleConfigChanged(payload: { key: string; value: string }) {
    if (
      payload.key === 'MAX_FILE_SIZE'
      || payload.key === 'FILE_TYPE_MODE'
      || payload.key === 'FILE_TYPE_FILTER'
      || payload.key === 'FILE_ACCESS_COUNT_DEFAULT'
      || payload.key === 'FILE_ACCESS_COUNT_MAX'
    ) {
      await this.reloadUploadConfig();
    }
  }

  private async reloadUploadConfig() {
    const [maxFileSize, fileTypeMode, fileTypeFilter, accessCountDefault, accessCountMax] = await Promise.all([
      this.configCacheService.get('MAX_FILE_SIZE', '20971520'),
      this.configCacheService.get('FILE_TYPE_MODE', 'blacklist'),
      this.configCacheService.get('FILE_TYPE_FILTER', ''),
      this.configCacheService.get('FILE_ACCESS_COUNT_DEFAULT', '-1'),
      this.configCacheService.get('FILE_ACCESS_COUNT_MAX', '-1'),
    ]);
    this.maxFileSize = this.parseFileSize(maxFileSize);
    this.fileTypeMode = (fileTypeMode === 'whitelist' ? 'whitelist' : 'blacklist');
    this.fileTypeFilter = fileTypeFilter
      ? fileTypeFilter.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      : [];
    this.accessCountDefault = this.parseAccessCount(accessCountDefault);
    this.accessCountMax = this.parseAccessCount(accessCountMax);
  }

  private parseFileSize(val: string | undefined): number {
    const parsed = Number(val);
    return Number.isFinite(parsed) ? parsed : 20971520;
  }

  private parseAccessCount(val: string | undefined): number {
    const parsed = Number(val);
    return Number.isInteger(parsed) && parsed >= -1 ? parsed : -1;
  }

  private async assertUploadFolder(folderId: string | null | undefined, userId: string): Promise<void> {
    if (!folderId) return;
    const folder = await this.folderRepository.findOne({
      where: { id: folderId, ownerId: userId, isDeleted: false },
      select: ['id'],
    });
    if (!folder) {
      throw new NotFoundException('目标文件夹不存在或无权访问');
    }
  }

  /**
   * 校验"上传覆盖"目标文件：必须存在且未删除、仅归属当前用户（不走 admin 放行）、
   * 所在目录与上传目标目录一致（null 对 null）、非 processing（防与在途 Bull job 竞写）。
   * 不存在/已删 → NotFoundException；归属/目录不符/processing → BadRequestException。
   */
  async assertOverwriteTarget(overwriteFileId: string, user: User, expectFolderId: string | null): Promise<File> {
    const target = await this.fileRepository.findOne({
      where: { id: overwriteFileId, isDeleted: false },
    });
    if (!target) {
      throw new NotFoundException('覆盖目标文件不存在或已被删除');
    }
    if (target.uploaderId !== user.id) {
      throw new BadRequestException('覆盖目标文件不属于当前用户');
    }
    if ((target.folderId ?? null) !== (expectFolderId ?? null)) {
      throw new BadRequestException('覆盖目标文件与上传目标目录不一致');
    }
    if (target.status === 'processing') {
      throw new BadRequestException('覆盖目标文件正在处理中，请稍后重试');
    }
    return target;
  }

  /**
   * in-place 覆盖：保留原 File.id，仅替换内容引用（分享链接/标签/访问统计存活）。
   * 事务内悲观行锁重新查询复核条件（防 TOCTOU）；旧 TG 对象绝不删除
   * （telegramFileId 可能被多条记录共享）。
   */
  async applyOverwrite(
    target: File,
    params: {
      telegramFileId: string;
      telegramFilePath: string;
      filename: string;
      originalName: string;
      size: number;
      mimeType: string;
      user: User;
    },
  ): Promise<File> {
    const expectFolderId = target.folderId ?? null;
    let oldTelegramFileId: string | null = null;

    await this.fileRepository.manager.transaction(async (manager) => {
      const locked = await manager.getRepository(File).findOne({
        where: { id: target.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked || locked.isDeleted) {
        throw new NotFoundException('覆盖目标文件不存在或已被删除');
      }
      if (locked.uploaderId !== params.user.id) {
        throw new BadRequestException('覆盖目标文件不属于当前用户');
      }
      if ((locked.folderId ?? null) !== expectFolderId) {
        throw new BadRequestException('覆盖目标文件与上传目标目录不一致');
      }
      if (locked.status === 'processing') {
        throw new BadRequestException('覆盖目标文件正在处理中，请稍后重试');
      }
      oldTelegramFileId = locked.telegramFileId;
      await manager.getRepository(File).update(target.id, {
        filename: params.filename,
        originalName: params.originalName,
        size: params.size,
        mimeType: params.mimeType,
        telegramFileId: params.telegramFileId,
        telegramFilePath: params.telegramFilePath,
        thumbnailPath: null,
      } as any);
    });

    // 事务外使本地缓存和旧衍生图失效，固定文件 ID 覆盖后不得继续展示旧内容。
    this.fileCacheService.invalidate(target.id);
    await Promise.all([
      fs.promises.unlink(path.join(this.thumbnailDir, `${target.id}.webp`)).catch(() => {}),
      fs.promises.unlink(path.join(this.thumbnailDir, `${target.id}.video.webp`)).catch(() => {}),
    ]);

    this.auditService.log({
      action: 'file_overwrite',
      userId: params.user.id,
      resourceType: 'file',
      resourceId: target.id,
      metadata: {
        filename: params.originalName,
        size: params.size,
        oldTelegramFileId,
        newTelegramFileId: params.telegramFileId,
      },
    });

    return Object.assign(target, {
      filename: params.filename,
      originalName: params.originalName,
      size: params.size,
      mimeType: params.mimeType,
      telegramFileId: params.telegramFileId,
      telegramFilePath: params.telegramFilePath,
      thumbnailPath: null,
    });
  }

  /**
   * 覆盖写入前对已上传字节做兜底：目标失效（NotFound/BadRequest）时返回 null 由调用方降级为新建，
   * 其余异常原样抛出，绝不丢弃已上传字节。
   */
  private async tryApplyOverwriteOrNull(
    overwriteFileId: string,
    user: User,
    expectFolderId: string | null,
    apply: (target: File) => Promise<File>,
    context: string,
  ): Promise<File | null> {
    try {
      const target = await this.assertOverwriteTarget(overwriteFileId, user, expectFolderId);
      return await apply(target);
    } catch (err) {
      if (err instanceof NotFoundException || err instanceof BadRequestException) {
        this.logger.warn(`覆盖目标失效，降级为新建 (${context}, overwriteFileId=${overwriteFileId}): ${err.message}`);
        this.auditService.log({
          action: 'file_overwrite_fallback',
          userId: user.id,
          resourceType: 'file',
          metadata: { overwriteFileId, context, reason: err.message },
        });
        return null;
      }
      throw err;
    }
  }

  async getMaxFileSize(): Promise<number> {
    return this.maxFileSize;
  }

  async getFileTypeConfig(): Promise<{
    fileTypeMode: 'blacklist' | 'whitelist';
    fileTypeFilter: string[];
  }> {
    return {
      fileTypeMode: this.fileTypeMode,
      fileTypeFilter: [...this.fileTypeFilter],
    };
  }

  /**
   * 从 Multer 文件对象中提取前 maxBytes 字节用于 magic bytes 检测。
   * 同时支持内存存储 (buffer) 和磁盘存储 (path) 模式。
   */
  private getFileSample(
    file: Express.Multer.File,
    maxBytes: number = 4100,
  ): Buffer {
    if (file.buffer && file.buffer.length > 0) {
      const end = Math.min(file.buffer.length, maxBytes);
      return file.buffer.subarray(0, end);
    }

    if (file.path && fs.existsSync(file.path)) {
      let fd: number | undefined;
      try {
        fd = fs.openSync(file.path, 'r');
        const buffer = Buffer.alloc(maxBytes);
        const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
        return bytesRead === 0 ? Buffer.alloc(0) : buffer.subarray(0, bytesRead);
      } finally {
        if (fd !== undefined) {
          fs.closeSync(fd);
        }
      }
    }

    return Buffer.alloc(0);
  }

  /**
   * 从文件路径读取前 maxBytes 字节（供分片上传合并后使用）
   */
  getFileSampleFromPath(
    filePath: string,
    maxBytes: number = 4100,
  ): Buffer {
    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(maxBytes);
      const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
      return bytesRead === 0 ? Buffer.alloc(0) : buffer.subarray(0, bytesRead);
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
    }
  }

  /**
   * 检查文件类型是否被允许（含 magic bytes 检测）
   *
   * - 有 buffer → 使用 fileTypeFromBuffer() 检测 magic bytes
   *   - 检测到类型 → 使用检测结果进行过滤
   *   - 未检测到 → 白名单直接拒绝，黑名单回退到文件名后缀匹配
   * - 无 buffer → 回退到后缀规则（向后兼容）
   */
  async isFileTypeAllowed(
    filename: string,
    buffer?: Buffer,
  ): Promise<{ allowed: boolean; reason?: string }> {
    // === 阶段 1: Magic bytes 检测 ===
    let detectedExt: string | null = null;

    if (buffer && buffer.length > 0) {
      const lowerName = filename.toLowerCase();
      const hasZipSignature = buffer.length >= 4
        && buffer[0] === 0x50
        && buffer[1] === 0x4b
        && (
          (buffer[2] === 0x03 && buffer[3] === 0x04)
          || (buffer[2] === 0x05 && buffer[3] === 0x06)
          || (buffer[2] === 0x07 && buffer[3] === 0x08)
        );

      // file-type 会深入遍历 ZIP entry。对仅含文件前缀的样本，首个 entry
      // 超出样本边界时会抛 EndOfStreamError；ZIP 文件只需验证容器签名即可。
      if (lowerName.endsWith('.zip') && hasZipSignature) {
        detectedExt = 'zip';
      } else {
        try {
          const result = await fileTypeFromBuffer(buffer);
          if (result) {
            detectedExt = result.ext;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(`文件类型解析失败，按未识别类型处理: ${filename} (${message})`);
        }
      }
    }

    // === 阶段 2: 确定用于过滤的扩展名 ===
    let effectiveExt: string;

    if (detectedExt) {
      const dotExt = `.${detectedExt}`;
      let matchedCompound: string | null = null;
      for (const ce of COMPOUND_EXTENSIONS) {
        if (filename.toLowerCase().endsWith(ce) && ce.endsWith(dotExt)) {
          matchedCompound = ce;
          break;
        }
      }
      effectiveExt = matchedCompound || dotExt;
    } else if (this.fileTypeMode === 'whitelist') {
      return {
        allowed: false,
        reason: '无法识别文件类型，白名单模式下仅允许可明确识别的文件类型',
      };
    } else {
      // 黑名单模式：回退到文件名后缀匹配
      const lowerName = filename.toLowerCase();
      let ext = '(无扩展名)';
      for (const ce of COMPOUND_EXTENSIONS) {
        if (lowerName.endsWith(ce)) {
          ext = ce;
          break;
        }
      }
      if (ext === '(无扩展名)') {
        const lastDot = lowerName.lastIndexOf('.');
        ext = lastDot > 0 ? '.' + lowerName.slice(lastDot + 1) : '(无扩展名)';
      }
      effectiveExt = ext;
    }

    // === 阶段 3: 特殊规则 ===
    if (this.fileTypeMode === 'blacklist' && this.fileTypeFilter.length === 0) {
      return { allowed: true };
    }
    if (this.fileTypeMode === 'whitelist' && this.fileTypeFilter.length === 0) {
      return {
        allowed: false,
        reason: `文件类型 ${effectiveExt} 被拒绝：白名单模式未配置允许类型`,
      };
    }

    // === 阶段 4: 过滤器匹配 ===
    const matched = this.fileTypeFilter.includes(effectiveExt);

    if (this.fileTypeMode === 'blacklist') {
      if (matched) {
        return { allowed: false, reason: `文件类型 ${effectiveExt} 被拒绝：该类型在禁止列表中` };
      }
    } else {
      if (!matched) {
        return { allowed: false, reason: `文件类型 ${effectiveExt} 被拒绝：该类型不在允许列表中` };
      }
    }

    return { allowed: true };
  }

  /**
   * 修复 Multer 中文文件名乱码：浏览器发送文件名时若未使用 RFC 5987 编码，
   * Multer/busboy 会将 UTF-8 字节误解析为 latin1，导致乱码。
   * 检测并修复：若文件名不含中文字符但含 latin1 高位字节，尝试 latin1→utf8 恢复。
   */
  private fixFilenameEncoding(originalName: string): string {
    // 已含中文字符 = 没有被误解析，直接返回
    if (/[\u4e00-\u9fff]/u.test(originalName)) {
      return originalName;
    }
    // 不含高位字节 = ASCII 文件名，无需修复
    if (!/[\x80-\xFF]/.test(originalName)) {
      return originalName;
    }
    // 尝试 latin1→utf8 恢复原始 UTF-8 编码
    const decoded = Buffer.from(originalName, 'latin1').toString('utf8');
    // 若恢复后包含 CJK 字符，说明原先被误解析了
    if (/[\u4e00-\u9fff]/u.test(decoded)) {
      return decoded;
    }
    return originalName;
  }

  /**
   * 确保文件名有扩展名，若无则从 MIME 类型提取
   */
  private ensureFileExtension(filename: string, mimeType: string): string {
    if (filename.includes('.')) return filename;
    const ext = mimeType.split('/')[1] || 'bin';
    return `${filename}.${ext}`;
  }

  /**
   * 清理 Multer 磁盘临时文件（上传到 Telegram 完成后调用，避免临时文件堆积）。
   * 内存存储（无 path）或文件不存在时静默跳过；删除失败仅告警，不影响主流程。
   */
  private cleanupTempFile(file: Express.Multer.File): void {
    if (file.path && fs.existsSync(file.path)) {
      fs.promises.unlink(file.path).catch((err) => {
        this.logger.warn(`清理临时文件失败 ${file.path}: ${(err as Error).message}`);
      });
    }
  }

  /**
   * 创建处理中的文件记录（磁盘文件→DB record=processing）
   * Telegram 上传由 FileUploadProcessor 后台异步执行
   */
  async createProcessingFile(
    file: Express.Multer.File,
    originalName: string,
    user: User,
    tagIds?: string[],
    skipTypeCheck?: boolean,
    folderId?: string | null,
    overwriteFileId?: string,
  ): Promise<File> {
    if (file.size > this.maxFileSize) {
      throw new BadRequestException(`文件大小不能超过 ${this.maxFileSize / 1024 / 1024}MB`);
    }

    const fileName = this.fixFilenameEncoding(originalName);

    await this.assertUploadFolder(folderId, user.id);

    if (!skipTypeCheck) {
      const fileSample = this.getFileSample(file);
      const typeCheck = await this.isFileTypeAllowed(fileName, fileSample);
      if (!typeCheck.allowed) {
        throw new BadRequestException(typeCheck.reason || '不允许上传此类型的文件');
      }
    }

    const tempId = uuidv4();
    const resolvedFolderId = folderId ?? null;
    let savedFile: File | undefined;

    if (overwriteFileId) {
      // 覆盖分支：复用旧记录（id 不变），目标失效时降级为原新建逻辑（绝不丢已传字节）
      const reused = await this.tryApplyOverwriteOrNull(
        overwriteFileId,
        user,
        resolvedFolderId,
        async (target) => {
          const oldTelegramFileId = target.telegramFileId;
          // tempId 占位语义与新记录一致，由 FileUploadProcessor 按 fileId 更新为真实 TG 引用
          target.status = 'processing';
          target.uploadVersion = (target.uploadVersion || 1) + 1;
          target.uploadStage = 'pending';
          target.uploadFailureReason = null; // 覆盖上传即视为重新开始，清空历史失败原因
          target.originalName = fileName;
          target.size = file.size;
          target.mimeType = file.mimetype || 'application/octet-stream';
          target.filename = tempId;
          target.telegramFileId = tempId;
          target.telegramFilePath = '';
          target.thumbnailPath = null;
          await Promise.all([
            fs.promises.unlink(path.join(this.thumbnailDir, `${target.id}.webp`)).catch(() => {}),
            fs.promises.unlink(path.join(this.thumbnailDir, `${target.id}.video.webp`)).catch(() => {}),
          ]);
          await this.fileRepository.save(target);
          // 审计覆盖意图（status=processing，真实引用由 processor 落库后另有流程记录）
          this.auditService.log({
            action: 'file_overwrite',
            userId: user.id,
            resourceType: 'file',
            resourceId: target.id,
            metadata: { filename: fileName, size: file.size, status: 'processing', oldTelegramFileId },
          });
          return target;
        },
        'createProcessingFile',
      );
      if (reused) {
        savedFile = reused;
      }
    }

    if (!savedFile) {
      const newFile = this.fileRepository.create({
        filename: tempId,
        originalName: fileName,
        mimeType: file.mimetype || 'application/octet-stream',
        size: file.size,
        telegramFileId: tempId,
        telegramFilePath: '',
        uploaderId: user.id,
        folderId: resolvedFolderId,
        accessType: FileAccessType.PUBLIC,
        maxAccessCount: this.accessCountDefault,
        status: 'processing',
        uploadVersion: 1,
        uploadStage: 'pending',
      });
      savedFile = await this.fileRepository.save(newFile);

      if (tagIds?.length) {
        await this.insertFileTags(this.fileRepository.manager, savedFile.id, tagIds);
      }

      this.auditService.log({
        action: 'file_upload',
        userId: user.id,
        resourceType: 'file',
        resourceId: savedFile.id,
        metadata: { filename: fileName, size: file.size, status: 'processing' },
      });
    }
    // 覆盖不新增标签：跳过 insertFileTags，保留旧记录既有标签（新建分支才关联 tagIds）

    const finalFile = savedFile;

    // 预热缓存：将文件直接放入缓存目录，首次下载无需等待 TG 回源（按同一 id 对覆盖记录天然生效）
    // 无缓存模式下跳过整块预热：status 保持 processing，由 file-upload.processor 在 TG 上传完成后补齐 ready
    if (!this.fileCacheService.isNoCacheMode() && file.path && fs.existsSync(file.path)) {
      this.fileCacheService.cacheFileFromPath(finalFile.id, file.path, file.size)
        .then(() => {
          // 缓存预热完成 → 文件立即可用，无需等待 TG 上传；同时清空历史失败原因
          this.fileRepository.update(finalFile.id, { status: 'ready', uploadFailureReason: null } as any).catch(() => {});
          this.logger.log(`文件缓存就绪: ${finalFile.id}`);
        })
        .catch((err) => {
          this.logger.warn(`缓存预热失败 (${finalFile.id}): ${err.message}`);
        });
    }

    return finalFile;
  }

  async upload(file: Express.Multer.File, user: User, tagIds?: string[]): Promise<File> {
    if (file.size > this.maxFileSize) {
      throw new BadRequestException(`文件大小不能超过 ${this.maxFileSize / 1024 / 1024}MB`);
    }

    const originalName = this.fixFilenameEncoding(file.originalname);

    const fileSample = await this.getFileSample(file);
    const typeCheck = await this.isFileTypeAllowed(originalName, fileSample);

    if (!typeCheck.allowed) {
      throw new BadRequestException(typeCheck.reason || '不允许上传此类型的文件');
    }

    // GIF 文件加 .bin 后缀防止 Telegram 转码为 MP4
    const uploadName = file.mimetype === 'image/gif' ? originalName + '.bin' : originalName;

    const useStream = file.path && fs.existsSync(file.path);
    const uploadSource = useStream ? createReadStream(file.path) : file.buffer;
    const telegramFile = await this.telegramService.uploadFile(
      uploadSource,
      uploadName,
      undefined,
      useStream ? file.size : undefined,
    );

    const newFile = this.fileRepository.create({
      filename: telegramFile.file_id,
      originalName: originalName,
      mimeType: file.mimetype,
      size: file.size,
      telegramFileId: telegramFile.file_id,
      telegramFilePath: telegramFile.file_path || '',
      uploaderId: user.id,
      accessType: FileAccessType.PUBLIC,
      maxAccessCount: this.accessCountDefault,
    });

    const savedFile = await this.fileRepository.save(newFile);

    if (tagIds && tagIds.length > 0) {
      await this.insertFileTags(this.fileRepository.manager, savedFile.id, tagIds);
    }

    this.auditService.log({
      action: 'file_upload',
      userId: user.id,
      resourceType: 'file',
      resourceId: savedFile.id,
      metadata: { filename: originalName, size: file.size, mimeType: file.mimetype },
    });

    if (file.mimetype.startsWith('video/')) {
      await this.generateAndSaveVideoCover(savedFile, { sourcePath: file.path, sourceBuffer: file.buffer });
    } else if (file.mimetype.startsWith('image/')) {
      await this.generateAndSaveThumbnail(savedFile);
    }
    this.cleanupTempFile(file);

    return savedFile;
  }

  async uploadMultiple(files: Express.Multer.File[], user: User, tagIds?: string[]): Promise<BatchUploadResult> {
    // 预验证阶段：先检查所有文件的类型和大小，避免部分上传后因一个文件失败产生垃圾数据
    const preCheckFailed: BatchUploadFailedItem[] = [];
    const passPreCheck: Express.Multer.File[] = [];

    for (const file of files) {
      if (file.size > this.maxFileSize) {
        preCheckFailed.push({
          name: file.originalname,
          reason: `文件大小超过 ${this.maxFileSize / 1024 / 1024}MB 限制`,
        });
        continue;
      }
      const originalName = this.fixFilenameEncoding(file.originalname);
      const fileSample = this.getFileSample(file);
      const typeCheck = await this.isFileTypeAllowed(originalName, fileSample);
      if (!typeCheck.allowed) {
        preCheckFailed.push({
          name: file.originalname,
          reason: typeCheck.reason || '不允许上传此类型的文件',
        });
        continue;
      }
      passPreCheck.push(file);
    }

    // 全部预检失败 → 直接返回，不上传任何文件
    if (passPreCheck.length === 0) {
      return { success: [], failed: preCheckFailed };
    }

    // 上传阶段：创建处理中记录 + 入队后台上传（不再同步等待 Telegram）
    const success: File[] = [];
    const failed = [...preCheckFailed];

    for (const file of passPreCheck) {
      try {
        const originalName = this.fixFilenameEncoding(file.originalname);
        const savedFile = await this.createProcessingFile(file, originalName, user, tagIds, true);
        // 将文件写入持久化路径供后台 processor 读取
        const pendingDir = path.join(process.cwd(), 'tmp', 'uploads', 'pending');
        if (!fs.existsSync(pendingDir)) fs.mkdirSync(pendingDir, { recursive: true });
        const pendingPath = path.join(pendingDir, `${savedFile.id}`);
        if (file.path && fs.existsSync(file.path)) {
          await fs.promises.rename(file.path, pendingPath);
        } else if (file.buffer) {
          writeFileSync(pendingPath, file.buffer);
        }
        await this.fileUploadQueue.add('upload',
          { fileId: savedFile.id, filePath: pendingPath, uploadVersion: savedFile.uploadVersion },
          {
            jobId: `file-upload:${savedFile.id}:${savedFile.uploadVersion}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 10000 },
            removeOnComplete: 100,
            removeOnFail: 50,
          },
        );
        success.push(savedFile);
      } catch (error: unknown) {
        failed.push({
          name: file.originalname,
          reason: error instanceof Error ? error.message : '未知错误',
        });
      }
    }

    return { success, failed };
  }

  async findAll(
    page = 1,
    limit = 20,
    userId?: string,
    keyword?: string,
    includeDeleted = false,
    sortBy?: string,
    sortOrder?: string,
    cursor?: string,
    tagIds?: string[],
    folderId?: string,
  ): Promise<{ files: File[]; total: number; nextCursor?: string | null }> {
    const where: Record<string, unknown> = {};
    if (!includeDeleted) {
      where.isDeleted = false;
    }
    if (userId) {
      where.uploaderId = userId;
    }
    // 网盘文件夹作用域：
    // - folderId 未传：不添加过滤（admin 视图与旧逻辑兼容）
    // - folderId === 'root'：仅返回位于网盘根目录（folderId IS NULL）的文件
    // - folderId 为 UUID：仅返回该 folder 下的文件
    if (folderId === 'root') {
      where.folderId = IsNull();
    } else if (folderId && folderId.length === 36) {
      // 简单 UUID 长度校验，避免 'root' 等非 UUID 误入
      where.folderId = folderId;
    }

    const qb = this.fileRepository.createQueryBuilder('file')
      .leftJoinAndSelect('file.uploader', 'uploader')
      .where(where);

    if (keyword) {
      qb.andWhere('LOWER(file.originalName) LIKE :keyword', { keyword: `%${this.escapeLike(keyword.toLowerCase())}%` });
    }

    // 标签筛选：AND 逻辑 —— 文件必须同时拥有所有指定标签
    if (tagIds && tagIds.length > 0) {
      qb.innerJoin('file_tags', 'ft_filter', 'ft_filter."fileId" = file.id')
        .andWhere('ft_filter."tagId" IN (:...tagIds)', { tagIds });
      // 多标签时使用 GROUP BY + HAVING 确保文件拥有所有指定标签
      if (tagIds.length > 1) {
        qb.groupBy('file.id')
          .addGroupBy('uploader.id')
          .having('COUNT(DISTINCT ft_filter."tagId") = :tagCount', { tagCount: tagIds.length });
      }
    }

    // 游标分页：解析游标并添加 WHERE 条件（使用元组比较，PostgreSQL 可高效利用索引）
    if (cursor) {
      const decoded = this.decodeCursor(cursor);
      qb.andWhere(
        '(file.createdAt, file.id) < (:cursorDate, :cursorId)',
        { cursorDate: new Date(decoded.createdAt), cursorId: decoded.id },
      );
    }

    qb.select([
      'file.id', 'file.filename', 'file.originalName', 'file.mimeType', 'file.size',
      'file.accessType', 'file.maxAccessCount', 'file.currentAccessCount',
      'file.expiresIn', 'file.expiresStartAt', 'file.createdAt',
      'file.isDeleted', 'file.deletedByAdmin', 'file.deleteRequestedAt', 'file.deleteScheduledAt',
      'file.uploadVersion', 'file.status',
      'uploader',
    ])
      .addSelect('CASE WHEN file.password IS NOT NULL THEN true ELSE false END', 'file_hasPassword');

    // 游标模式：固定按 createdAt DESC, id DESC 排序，只用 take
    // 传统模式：动态排序 + skip/take
    if (cursor) {
      qb.orderBy('file.createdAt', 'DESC').addOrderBy('file.id', 'DESC').take(limit);
    } else {
      const allowedSortFields = ['originalName', 'createdAt', 'size', 'uploader.email'];
      // uploader.email 走 JOIN 的 uploader 别名，其余字段加 file. 前缀，避免拼出 file.uploader.email 非法列名
      const safeSortBy = !allowedSortFields.includes(sortBy || '')
        ? 'file.createdAt'
        : sortBy === 'uploader.email'
          ? 'uploader.email'
          : `file.${sortBy}`;
      const safeSortOrder = (sortOrder || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
      qb.orderBy(safeSortBy, safeSortOrder as 'ASC' | 'DESC').skip((page - 1) * limit).take(limit);
    }

    const { entities, raw } = await qb.getRawAndEntities();

    // 使用独立的 count 查询（不受 skip/take 影响）
    let total: number;
    if (tagIds && tagIds.length > 0) {
      // 标签筛选的计数使用原始 SQL，避免 TypeORM query builder 的 getRawMany + JOIN 兼容问题
      const tagParams: any[] = [tagIds];
      let tagIdx = 2;
      const tagWheres: string[] = ['ft."tagId" = ANY($1::uuid[])'];
      if (userId) { tagWheres.push(`file."uploaderId" = $${tagIdx++}`); tagParams.push(userId); }
      if (!includeDeleted) { tagWheres.push('file."isDeleted" = false'); }
      if (keyword) { tagWheres.push(`LOWER(file."originalName") LIKE $${tagIdx++}`); tagParams.push(`%${this.escapeLike(keyword.toLowerCase())}%`); }
      const tagWhere = tagWheres.join(' AND ');

      if (tagIds.length > 1) {
        tagParams.push(tagIds.length);
        const res = await this.fileRepository.manager.query(
          `SELECT COUNT(*)::int AS cnt FROM (
            SELECT 1 FROM files file
            INNER JOIN file_tags ft ON ft."fileId" = file.id
            WHERE ${tagWhere}
            GROUP BY file.id HAVING COUNT(DISTINCT ft."tagId") = $${tagIdx}
          ) sub`,
          tagParams,
        );
        total = parseInt(res[0]?.cnt || '0', 10);
      } else {
        const res = await this.fileRepository.manager.query(
          `SELECT COUNT(*)::int AS cnt FROM files file
          INNER JOIN file_tags ft ON ft."fileId" = file.id
          WHERE ${tagWhere}`,
          tagParams,
        );
        total = parseInt(res[0]?.cnt || '0', 10);
      }
    } else {
      const countQb = this.fileRepository.createQueryBuilder('file').where(where);
      if (keyword) {
        countQb.andWhere('LOWER(file.originalName) LIKE :keyword', { keyword: `%${this.escapeLike(keyword.toLowerCase())}%` });
      }
      total = await countQb.getCount();
    }

    const files = entities.map((entity, i) => ({
      ...entity,
      hasPassword: raw[i]?.file_hasPassword === true,
    } as File & { hasPassword: boolean }));

    // 批量加载所有文件的标签
    const fileIds = files.map(f => f.id);
    if (fileIds.length > 0) {
      const tagRows = await this.fileRepository.manager.query(
        `SELECT ft."fileId", t.id, t.name, t.color, t."userId", t."createdAt"
         FROM file_tags ft
         INNER JOIN tags t ON t.id = ft."tagId"
         WHERE ft."fileId" = ANY($1::uuid[])`,
        [fileIds],
      );
      const tagsMap = new Map<string, { id: string; name: string; color: string }[]>();
      for (const row of tagRows) {
        if (!tagsMap.has(row.fileId)) tagsMap.set(row.fileId, []);
        tagsMap.get(row.fileId)!.push({ id: row.id, name: row.name, color: row.color });
      }
      for (const file of files) {
        (file as any).tags = tagsMap.get(file.id) || [];
      }
    }

    // 游标模式下计算 nextCursor（结果数达到 limit 表示可能还有更多）
    let nextCursor: string | null = null;
    if (files.length === limit) {
      const lastFile = files[files.length - 1];
      nextCursor = this.encodeCursor(lastFile.createdAt, lastFile.id);
    }

    return { files, total, nextCursor };
  }

  /** 编码游标：base64({ createdAt, id }) */
  private encodeCursor(createdAt: Date, id: string): string {
    return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id })).toString('base64');
  }

  /** 解码游标（非法游标返回 400 而非 500） */
  private decodeCursor(cursor: string): { createdAt: string; id: string } {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
      if (
        !decoded ||
        typeof decoded.createdAt !== 'string' ||
        typeof decoded.id !== 'string' ||
        isNaN(Date.parse(decoded.createdAt))
      ) {
        throw new Error('游标结构非法');
      }
      return { createdAt: decoded.createdAt, id: decoded.id };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException('非法的分页游标');
    }
  }

  /** 转义 LIKE 通配符（% _ \），让用户关键词按字面匹配而非通配 */
  private escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  }

  /**
   * 统一权限校验：登录用户只能读取自己的文件，管理员可读取所有文件
   */
  private async assertFileReadable(file: File, user: User): Promise<void> {
    const adminRoles: UserRole[] = [UserRole.ADMIN, UserRole.SUPER_ADMIN];
    if (file.uploaderId !== user.id && !adminRoles.includes(user.role)) {
      throw new ForbiddenException('无权访问此文件');
    }
  }

  /**
   * 统一权限校验：仅文件所有者和管理员可修改文件
   * @param file 文件对象
   * @param user 当前用户
   * @throws ForbiddenException 如果无权修改
   */
  private assertFileWritable(file: File, user: User): void {
    if (file.uploaderId !== user.id && user.role === UserRole.USER) {
      throw new ForbiddenException('无权修改此文件');
    }
  }

  async findOne(id: string, user: User): Promise<File> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
      relations: ['uploader'],
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    await this.assertFileReadable(file, user);
    return file;
  }

  /**
   * 查询文件是否已有正式本地缓存。
   * 供前端在视频预览前判断冷资源单连接策略：未缓存时不走动态分片，
   * 播放期间钳制 seek；缓存完成后恢复 Range 跳转。
   */
  async getCacheStatus(id: string, user: User): Promise<{ cached: boolean }> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    await this.assertFileReadable(file, user);
    return { cached: this.isFileCached(id) };
  }

  /** 仅查缓存路径，不做用户权限断言（分享链路复用）。 */
  isFileCached(fileId: string): boolean {
    return this.fileCacheService.getCachedPath(fileId) !== null;
  }

  /**
   * 请求删除文件（延迟删除机制）：
   * 1. 前端立即标记文件为"删除中"并停止访问
   * 2. 后端将文件标记为已删除，进入 7 天等待期
   * 3. 等待期内可调用 restoreDelete() 恢复
   * 4. 请求后 10 分钟内不可重复请求删除（冷却窗口）
   * 5. 7 天后定时任务执行永久删除
   */
  async delete(id: string, user: User): Promise<{ status: string; scheduledAt?: Date }> {
    // 先查找文件（无论是否已删除）
    const file = await this.fileRepository.findOne({
      where: { id },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    this.assertFileWritable(file, user);

    const now = new Date();

    // 文件已被管理员删除 → 普通用户不可操作
    if (file.isDeleted && file.deletedByAdmin) {
      if (user.role !== UserRole.ADMIN && user.role !== UserRole.SUPER_ADMIN) {
        throw new ForbiddenException('该文件由管理员删除，请联系管理员处理');
      }
      // 管理员可以直接强制删除
      await this.forceDelete(id, user);
      return { status: 'permanently_deleted' };
    }

    // 文件已处于待删除状态（自主删除）
    if (file.isDeleted) {
      return {
        status: 'already_deleted',
        scheduledAt: file.deleteScheduledAt || undefined,
      };
    }

    // 检查冷却窗口：10 分钟内不可重复请求
    if (file.deleteCooldownUntil && now < file.deleteCooldownUntil) {
      const remainingSeconds = Math.ceil((file.deleteCooldownUntil.getTime() - now.getTime()) / 1000);
      throw new BadRequestException(`删除请求过于频繁，请 ${remainingSeconds} 秒后再试`);
    }

    // 标记删除状态（用户自主删除，非管理员操作）
    file.isDeleted = true;
    file.deletedByAdmin = false;
    file.deleteRequestedAt = now;
    file.deleteScheduledAt = new Date(now.getTime() + FILE_DELETE_GRACE_MS);
    file.deleteCooldownUntil = new Date(now.getTime() + FILE_DELETE_COOLDOWN_MS);
    await this.fileRepository.save(file);

    // 审计日志：文件请求删除
    this.auditService.log({
      action: 'file_delete_request',
      userId: user.id,
      resourceType: 'file',
      resourceId: id,
      metadata: { filename: file.originalName, scheduledAt: file.deleteScheduledAt.toISOString() },
    });

    return { status: 'pending', scheduledAt: file.deleteScheduledAt };
  }

  /**
   * 恢复已请求删除的文件（在 7 天等待期内）
   */
  async restoreDelete(id: string, user: User): Promise<void> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: true },
    });

    if (!file) {
      throw new NotFoundException('文件不存在或未被标记为删除');
    }

    if (!file.deleteRequestedAt) {
      throw new BadRequestException('该文件未处于待删除状态');
    }

    // 管理员删除的文件，普通用户不可恢复
    if (file.deletedByAdmin && user.role !== UserRole.ADMIN && user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('该文件由管理员删除，普通用户不可恢复。请联系管理员处理');
    }

    this.assertFileWritable(file, user);

    const now = new Date();
    // 如果已过 scheduledAt，文件已被永久删除
    if (file.deleteScheduledAt && now >= file.deleteScheduledAt) {
      throw new BadRequestException('删除等待期已过，文件已永久删除');
    }

    file.isDeleted = false;
    file.deletedByAdmin = false;
    file.deleteRequestedAt = null;
    file.deleteScheduledAt = null;
    file.deleteCooldownUntil = null;
    await this.fileRepository.save(file);

    // 审计日志：文件恢复
    this.auditService.log({
      action: 'file_restore',
      userId: user.id,
      resourceType: 'file',
      resourceId: id,
      metadata: { filename: file.originalName },
    });
  }

  /**
   * 文件所有者或管理员强制永久删除本站文件记录，不等待 7 天冷静期。
   * 不调用 Telegram deleteMessage：当前仅保存 file_id，且引用副本可能共享远端对象。
   */
  async forceDelete(id: string, user: User): Promise<void> {
    const file = await this.fileRepository.findOne({
      where: { id },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    // 安全校验：只能强制删除自己上传的文件或管理员/超级管理员可删所有
    this.assertFileWritable(file, user);

    // telegramFileId 是 Telegram file_id，并非 deleteMessage 所需的 message_id。
    // 同一远端对象还可能被“引用复制”的多条 File 记录共享，因此此处禁止误删远端消息。
    // 数据库元数据与外键关联在事务内删除，行锁避免并发恢复/重复删除竞态。
    await this.fileRepository.manager.transaction(async (manager) => {
      const lockedFile = await manager.getRepository(File).findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!lockedFile) {
        throw new NotFoundException('文件不存在');
      }
      this.assertFileWritable(lockedFile, user);
      await manager.getRepository(FileAccessLog).delete({ fileId: id });
      await manager.getRepository(File).remove(lockedFile);
    });

    // 数据库删除成功后再清理可重建的本地衍生数据。
    this.deleteLocalThumbnail(file);
    this.fileCacheService.invalidate(id);

    // 审计日志：管理员强制删除
    await this.auditService.logAwait({
      action: 'file_delete_by_admin',
      userId: user.id,
      resourceType: 'file',
      resourceId: id,
      metadata: { filename: file.originalName, forced: true },
    });
  }

  /**
   * 每小时清理具备完整删除时间链且已到期的软删除文件。
   * 必须同时满足 isDeleted=true、deleteRequestedAt 非空、
   * deleteScheduledAt 非空且计划时间已到；异常残缺记录绝不永久删除。
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sweepPendingDeletions(): Promise<number> {
    const now = new Date();

    const batchSize = 100;
    let deletedCount = 0;
    let lastId: string | null = null;
    let iterations = 0;
    const maxIterations = 10000; // 安全护栏，防止异常数据导致死循环

    // 分页（按 id 游标推进）拉取待删除文件，避免一次性载入全部软删文件导致 OOM
    while (iterations++ < maxIterations) {
      const qb = this.fileRepository
        .createQueryBuilder('file')
        .where('file.isDeleted = true')
        // 永久删除必须具备完整时间链，禁止仅凭 isDeleted/updatedAt 推断。
        .andWhere('file.deleteRequestedAt IS NOT NULL')
        .andWhere('file.deleteScheduledAt IS NOT NULL')
        .andWhere('file.deleteScheduledAt <= :now', { now })
        .orderBy('file.id', 'ASC')
        .take(batchSize);
      if (lastId) {
        qb.andWhere('file.id > :lastId', { lastId });
      }

      const batch = await qb.getMany();
      if (batch.length === 0) break;

      for (const file of batch) {
        // 在 remove() 前保存标识：TypeORM 成功移除后可能清空传入实体的主键。
        const fileId = file.id;
        // 无论成功失败都推进游标：失败的文件留待下次定时任务重试，不阻塞本批后续文件
        lastId = fileId;
        try {
          // 删除前再次确认记录仍处于到期删除状态，避免批次处理期间状态变化后继续误删。
          const stillPending = await this.fileRepository
            .createQueryBuilder('pendingFile')
            .where('pendingFile.id = :fileId', { fileId })
            .andWhere('pendingFile.isDeleted = true')
            .andWhere('pendingFile.deleteRequestedAt IS NOT NULL')
            .andWhere('pendingFile.deleteScheduledAt IS NOT NULL')
            .andWhere('pendingFile.deleteScheduledAt <= :now', { now })
            .getOne();
          if (!stillPending) {
            this.logger.warn(`跳过状态已变化或不再到期的文件: ${file.originalName} (${fileId})`);
            continue;
          }

          // telegramFileId 是 file_id，不是 deleteMessage 所需的 message_id；且引用复制会共享
          // 同一远端对象。永久删除这里只移除本站元数据，不误删 Telegram 远端消息。
          const removed = await this.fileRepository.manager.transaction(async (manager) => {
            const lockedFile = await manager.getRepository(File).findOne({
              where: { id: fileId },
              lock: { mode: 'pessimistic_write' },
            });
            if (
              !lockedFile ||
              !lockedFile.isDeleted ||
              !lockedFile.deleteRequestedAt ||
              !lockedFile.deleteScheduledAt ||
              lockedFile.deleteScheduledAt > now
            ) {
              return false;
            }
            await manager.getRepository(FileAccessLog).delete({ fileId });
            await manager.getRepository(File).remove(lockedFile);
            return true;
          });
          if (!removed) {
            this.logger.warn(`跳过事务复核后不再到期的文件: ${file.originalName} (${fileId})`);
            continue;
          }
          this.deleteLocalThumbnail(file);
          this.fileCacheService.invalidate(fileId);
          deletedCount++;
          await this.auditService.logAwait({
            action: 'file_delete',
            userId: file.uploaderId,
            resourceType: 'file',
            resourceId: fileId,
            metadata: {
              filename: file.originalName,
              source: 'scheduled_sweep',
              requestedAt: file.deleteRequestedAt?.toISOString(),
              scheduledAt: file.deleteScheduledAt?.toISOString(),
              deletedByAdmin: file.deletedByAdmin,
            },
          });
          this.logger.log(`已永久删除文件数据库记录: ${file.originalName} (${fileId})`);
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : '未知错误';
          this.logger.warn(
            `清除文件数据库记录失败，保留记录待下次重试: ${file.originalName} (${fileId}), 错误: ${errMsg}`,
          );
        }
      }

      if (batch.length < batchSize) break; // 已是最后一批
    }

    return deletedCount;
  }

  async updateAccessType(id: string, accessType: FileAccessType, user: User): Promise<void> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    this.assertFileWritable(file, user);

    await this.fileRepository.update(id, { accessType });

    // 审计日志：文件访问类型变更
    this.auditService.log({
      action: 'file_access_change',
      userId: user.id,
      resourceType: 'file',
      resourceId: id,
      metadata: { accessType },
    });
  }

  async updateAccessCount(id: string, maxAccessCount: number, user: User): Promise<void> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    this.assertFileWritable(file, user);

    if (this.accessCountMax > 0 && (maxAccessCount < 1 || maxAccessCount > this.accessCountMax)) {
      throw new BadRequestException(`访问次数必须为 1 到 ${this.accessCountMax} 之间`);
    }

    await this.fileRepository.update(id, { maxAccessCount });

    // 审计日志：访问次数限制变更
    this.auditService.log({
      action: 'file_access_change',
      userId: user.id,
      resourceType: 'file',
      resourceId: id,
      metadata: { maxAccessCount },
    });
  }

  async setPassword(id: string, password: string, user: User): Promise<void> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    this.assertFileWritable(file, user);

    const hashedPassword = password ? await bcrypt.hash(password, BCRYPT_ROUNDS) : null;
    await this.fileRepository.update(id, { password: hashedPassword });

    // 审计日志：文件密码设置/移除
    this.auditService.log({
      action: password ? 'file_password_set' : 'file_password_remove',
      userId: user.id,
      resourceType: 'file',
      resourceId: id,
    });
  }

  async updateExpires(id: string, expiresIn: number | null, user: User): Promise<void> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    this.assertFileWritable(file, user);

    await this.fileRepository.update(id, { expiresIn, expiresStartAt: expiresIn !== null ? new Date() : null });

    // 审计日志：文件有效期设置
    this.auditService.log({
      action: 'file_expiry_set',
      userId: user.id,
      resourceType: 'file',
      resourceId: id,
      metadata: { expiresIn },
    });
  }

  async verifyPassword(id: string, password: string): Promise<boolean> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file || !file.password) {
      return true;
    }

    return bcrypt.compare(password, file.password);
  }

  /**
   * 检查文件访问约束并递增计数器，返回是否允许访问
   */
  async checkAndIncrementAccess(id: string): Promise<{ allowed: boolean; reason?: string }> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
      select: ['maxAccessCount', 'currentAccessCount', 'expiresIn', 'expiresStartAt'],
    });

    if (!file) return { allowed: false, reason: '文件不存在' };

    // 检查时效限制（用设置时间 expiresStartAt 计算过期）
    if (file.expiresIn !== null && file.expiresIn !== undefined && file.expiresStartAt) {
      const expiresAt = new Date(file.expiresStartAt.getTime() + file.expiresIn * 3600 * 1000);
      if (new Date() > expiresAt) {
        return { allowed: false, reason: '文件分享已过期' };
      }
    }

    // 检查访问次数（原子 UPDATE，防止并发超发）
    if (file.maxAccessCount > 0) {
      const result = await this.fileRepository
        .createQueryBuilder()
        .update(File)
        .set({ currentAccessCount: () => '"currentAccessCount" + 1' })
        .where('id = :id', { id })
        .andWhere('"currentAccessCount" < "maxAccessCount"')
        .andWhere('"isDeleted" = false')
        .execute();

      if (result.affected === 0) {
        return { allowed: false, reason: '文件访问次数已用尽' };
      }
    }

    return { allowed: true };
  }

  async hasPassword(id: string): Promise<boolean> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
      select: ['password'],
    });
    return !!(file && file.password);
  }

  async isPrivateFile(id: string): Promise<boolean> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
      select: ['accessType'],
    });
    return !!(file && file.accessType === FileAccessType.PRIVATE);
  }

  /** 从安全配置动态读取密码错误限流阈值（热更新） */
  private async getPwdErrorLimit(): Promise<number> { return Number(await this.configCacheService.get('sec_pwd_error_limit', '5')) || 5; }
  private async getPwdBanDuration(): Promise<number> { return (Number(await this.configCacheService.get('sec_pwd_ban_duration', '5')) || 5) * 60 * 1000; }

  private readonly BAN_6H = 6 * 3600 * 1000; // 第5次封禁升级为6小时
  private readonly BAN_COUNT_LIMIT = 5;     // 1小时内被封禁5次触发升级
  private readonly BAN_WINDOW = 3600 * 1000; // 1小时窗口
  private readonly PWD_WINDOW = 3600 * 1000; // 密码错误窗口

  async isIPBanned(ip: string): Promise<{ banned: boolean; message?: string }> {
    const now = new Date();
    const ban = await this.bannedIPRepository
      .createQueryBuilder('bannedIP')
      .where('bannedIP.ip = :ip', { ip })
      .andWhere(
        '(bannedIP.isPermanent = true OR (bannedIP.isPermanent = false AND bannedIP.expiresAt > :now))',
        { now },
      )
      .getOne();

    if (ban) {
      const remaining = ban.isPermanent
        ? '永久'
        : Math.ceil((ban.expiresAt!.getTime() - now.getTime()) / 60000) + '分钟';
      return {
        banned: true,
        message: `该IP因多次密码错误已被封禁，剩余 ${remaining}`,
      };
    }
    return { banned: false };
  }

  /**
   * 记录失败的密码尝试
   * 每5次错误 → 封禁1小时
   * 1小时内被封禁5次 → 升级为封禁6小时
   */
  async recordFailedPasswordAttempt(ip: string): Promise<void> {
    const pwdLimitKey = `pwd:${ip}`;
    const banLimitKey = `ban:${ip}`;
    const pwdErrorLimit = await this.getPwdErrorLimit();
    const pwdBanDuration = await this.getPwdBanDuration();

    // 密码错误计数（仅计数，不锁定——达到阈值后才触发封禁）
    const pwdResult = await this.rateLimitService.incrementCounter(
      pwdLimitKey, 'password_error', pwdErrorLimit, this.PWD_WINDOW,
    );

    // 未达到阈值，仅记录
    if (!pwdResult.thresholdReached) {
      return;
    }

    // 达到阈值，原子递增 1 小时内封禁触发次数
    const banResult = await this.rateLimitService.incrementCounter(
      banLimitKey, 'ban_count', this.BAN_COUNT_LIMIT, this.BAN_WINDOW,
    );

    const now = Date.now();
    const currentBanCount = banResult.count;

    // T3-5: 使用 UPSERT 原子化封禁记录的创建/更新，消除 findOne→save 的 TOCTOU 窗口
    if (currentBanCount >= this.BAN_COUNT_LIMIT) {
      // 连续封禁 → 升级为6小时
      const expiresAt = new Date(now + this.BAN_6H);
      const reason = `密码错误${pwdErrorLimit}次，1小时内第${currentBanCount}次触发封禁，升级为6小时`;
      await this.bannedIPRepository.upsert(
        { ip, reason, isPermanent: false, expiresAt } as BannedIP,
        ['ip'],
      );
      await this.rateLimitService.reset(banLimitKey);
    } else {
      // 首次封禁 → 动态时长
      const expiresAt = new Date(now + pwdBanDuration);
      const reason = `密码错误${pwdErrorLimit}次，1小时内第${currentBanCount}次触发封禁`;
      await this.bannedIPRepository.upsert(
        { ip, reason, isPermanent: false, expiresAt } as BannedIP,
        ['ip'],
      );
    }

    // 重置错误计数器
    await this.rateLimitService.reset(pwdLimitKey);
  }

  /**
   * 获取缩略图流（仅权限校验，不受类型/密码/次数/过期限制）
   */
  async getThumbnailStream(id: string, user: User): Promise<{
    stream: Readable;
    contentType: string;
  }> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    await this.assertFileReadable(file, user);

    // 优先读取本地缩略图
    let localThumb = await this.readLocalThumbnail(file);
    if (!localThumb && file.mimeType?.startsWith('video/')) {
      const inferredCover = `${file.id}.video.webp`;
      const inferredPath = path.join(this.thumbnailDir, inferredCover);
      if (fs.existsSync(inferredPath)) {
        file.thumbnailPath = inferredCover;
        await this.fileRepository.save(file);
        localThumb = await fs.promises.readFile(inferredPath);
      }
    }
    if (localThumb) {
      return {
        stream: Readable.from(localThumb),
        contentType: 'image/webp',
      };
    }

    // 缩略图文件缺失（如 tmp/thumbnails 重建后丢失）→ 同步重新生成
    // 等待生成完成，避免返回源文件（既浪费带宽也违反缩略图设计意图）
    if (file.mimeType?.startsWith('image/')) {
      await this.generateAndSaveThumbnail(file);
      const regenerated = await this.readLocalThumbnail(file);
      if (regenerated) {
        return {
          stream: Readable.from(regenerated),
          contentType: 'image/webp',
        };
      }
    } else if (file.mimeType?.startsWith('video/')) {
      await this.generateAndSaveVideoCover(file);
      const regenerated = await this.readLocalThumbnail(file);
      if (regenerated) {
        return {
          stream: Readable.from(regenerated),
          contentType: 'image/webp',
        };
      }
      throw new NotFoundException('视频封面尚未生成');
    }

    if (file.mimeType?.startsWith('image/')) {
      throw new NotFoundException('图片缩略图尚未生成');
    }
    throw new BadRequestException('该文件类型不支持缩略图');
  }

  /** 读取已存在的媒体缩略图，不校验业务权限、不生成且不触发远端回源。 */
  async getExistingMediaThumbnailStream(fileId: string): Promise<{
    stream: Readable;
    contentType: string;
  }> {
    const file = await this.fileRepository.findOne({ where: { id: fileId, isDeleted: false } });
    if (!file) throw new NotFoundException('文件不存在');
    const isImage = file.mimeType?.startsWith('image/');
    const isVideo = file.mimeType?.startsWith('video/');
    if (!isImage && !isVideo) throw new BadRequestException('仅图片和视频支持缩略图');

    const expectedName = isVideo ? `${file.id}.video.webp` : `${file.id}.webp`;
    const expectedPath = path.join(this.thumbnailDir, expectedName);
    try {
      const buffer = await fs.promises.readFile(expectedPath);
      return { stream: Readable.from(buffer), contentType: 'image/webp' };
    } catch {
      throw new NotFoundException(isVideo ? '视频封面尚未生成' : '图片缩略图尚未生成');
    }
  }

  /**
   * 获取高清视频封面流（登录态，带权限校验）。
   * 优先读取已生成的高清封面；缺失时仅从本地正式缓存生成（不触发整视频回源）；
   * 仍不可用时回退标准封面，保证前端至少有一张可展示的图。
   */
  async getHdThumbnailStream(id: string, user: User): Promise<{
    stream: Readable;
    contentType: string;
  }> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });
    if (!file) throw new NotFoundException('文件不存在');
    await this.assertFileReadable(file, user);
    if (!file.mimeType?.startsWith('video/')) {
      throw new BadRequestException('仅视频支持高清封面');
    }

    let buffer = await this.readHdLocalThumbnail(file);
    if (!buffer) {
      await this.generateAndSaveHdVideoCover(file);
      buffer = await this.readHdLocalThumbnail(file);
    }
    if (buffer) return { stream: Readable.from(buffer), contentType: 'image/webp' };

    const standard = await this.readLocalThumbnail(file);
    if (standard) return { stream: Readable.from(standard), contentType: 'image/webp' };
    throw new NotFoundException('视频封面尚未生成');
  }

  /**
   * 读取/生成高清封面，不校验业务权限、不触发远端回源（供分享链路复用）。
   */
  async getExistingHdMediaThumbnailStream(fileId: string): Promise<{
    stream: Readable;
    contentType: string;
  }> {
    const file = await this.fileRepository.findOne({
      where: { id: fileId, isDeleted: false },
    });
    if (!file) throw new NotFoundException('文件不存在');
    if (!file.mimeType?.startsWith('video/')) {
      throw new BadRequestException('仅视频支持高清封面');
    }

    let buffer = await this.readHdLocalThumbnail(file);
    if (!buffer) {
      await this.generateAndSaveHdVideoCover(file);
      buffer = await this.readHdLocalThumbnail(file);
    }
    if (buffer) return { stream: Readable.from(buffer), contentType: 'image/webp' };

    const standard = await this.readLocalThumbnail(file);
    if (standard) return { stream: Readable.from(standard), contentType: 'image/webp' };
    throw new NotFoundException('视频封面尚未生成');
  }

  /**
   * 批量获取缩略图 base64（合并为一次 API 调用，消除浏览器连接池瓶颈）
   * 返回 { [fileId]: 'data:image/...;base64,...' }
   */
  async generateAndSaveVideoCover(
    file: File,
    options: { sourcePath?: string; sourceBuffer?: Buffer; allowRemoteSource?: boolean } = {},
  ): Promise<void> {
    if (!file.mimeType?.startsWith('video/')) return;
    const existing = this.videoCoverBuilds.get(file.id);
    if (existing) return existing;

    const build = this.buildVideoCover(file, options).finally(() => {
      if (this.videoCoverBuilds.get(file.id) === build) this.videoCoverBuilds.delete(file.id);
    });
    this.videoCoverBuilds.set(file.id, build);
    return build;
  }

  private async buildVideoCover(
    file: File,
    options: { sourcePath?: string; sourceBuffer?: Buffer; allowRemoteSource?: boolean },
  ): Promise<void> {
    const coverFilename = `${file.id}.video.webp`;
    const coverPath = path.join(this.thumbnailDir, coverFilename);
    if (fs.existsSync(coverPath)) {
      if (file.thumbnailPath !== coverFilename) {
        file.thumbnailPath = coverFilename;
        await this.fileRepository.save(file);
      }
      return;
    }

    const buildId = uuidv4();
    const tmpSource = path.join(this.thumbnailDir, `${file.id}.${buildId}.video.tmp`);
    const tmpCover = path.join(this.thumbnailDir, `${file.id}.${buildId}.cover.tmp.webp`);
    let sourcePath = options.sourcePath && fs.existsSync(options.sourcePath)
      ? options.sourcePath
      : this.fileCacheService.getCachedPath(file.id);
    try {
      if (!sourcePath && options.sourceBuffer?.length) {
        await fs.promises.writeFile(tmpSource, options.sourceBuffer);
        sourcePath = tmpSource;
      }
      if (!sourcePath && options.allowRemoteSource) {
        const { stream } = await this.telegramService.getFileStream(file.telegramFileId || file.filename);
        const { pipeline } = await import('stream/promises');
        await pipeline(stream, fs.createWriteStream(tmpSource));
        sourcePath = tmpSource;
      }
      if (!sourcePath) return; // 页面封面请求不得触发整视频回源
      const resolvedSourcePath: string = sourcePath;

      await this.extractVideoFrame(resolvedSourcePath, tmpCover, VIDEO_COVER_MAX_WIDTH, 65);
      await fs.promises.rename(tmpCover, coverPath);
      file.thumbnailPath = coverFilename;
      await this.fileRepository.save(file);
    } catch (error) {
      this.logger.warn(`视频封面生成失败 id=${file.id}: ${(error as Error).message}`);
    } finally {
      await Promise.all([
        fs.promises.unlink(tmpSource).catch(() => {}),
        fs.promises.unlink(tmpCover).catch(() => {}),
      ]);
    }
  }

  /**
   * 抽取视频单帧为 WebP（标准/高清封面共用）。
   * 输出目录须由调用方保证存在；失败时抛出 FFmpeg stderr 摘要。
   */
  private async extractVideoFrame(
    sourcePath: string,
    outputPath: string,
    scaleWidth: number,
    quality: number,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ffmpeg = spawn(process.env.FFMPEG_PATH || 'ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', '1', '-i', sourcePath,
        '-frames:v', '1', '-vf', `scale=${scaleWidth}:-2:force_original_aspect_ratio=decrease`,
        '-c:v', 'libwebp', '-quality', String(quality), '-f', 'webp', outputPath,
      ], { windowsHide: true });
      let stderr = '';
      ffmpeg.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2048); });
      ffmpeg.once('error', reject);
      ffmpeg.once('close', code => code === 0 ? resolve() : reject(new Error(stderr || `FFmpeg 退出码 ${code}`)));
    });
  }

  /**
   * 生成高清视频封面（按文件合并去重）。
   * 仅从本地正式缓存提取，绝不因封面请求触发整视频远端回源；冷资源直接跳过。
   */
  async generateAndSaveHdVideoCover(file: File): Promise<void> {
    if (!file.mimeType?.startsWith('video/')) return;
    const key = `hd:${file.id}`;
    const existing = this.videoCoverBuilds.get(key);
    if (existing) return existing;

    const build = this.buildHdVideoCover(file).finally(() => {
      if (this.videoCoverBuilds.get(key) === build) this.videoCoverBuilds.delete(key);
    });
    this.videoCoverBuilds.set(key, build);
    return build;
  }

  private async buildHdVideoCover(file: File): Promise<void> {
    const coverFilename = `${file.id}.video.hd.webp`;
    const coverPath = path.join(this.thumbnailDir, coverFilename);
    if (fs.existsSync(coverPath)) return;

    const sourcePath = this.fileCacheService.getCachedPath(file.id);
    if (!sourcePath) return; // 冷资源不生成高清封面（避免整视频回源）

    const buildId = uuidv4();
    const tmpCover = path.join(this.thumbnailDir, `${file.id}.${buildId}.hd-cover.tmp.webp`);
    try {
      await this.extractVideoFrame(sourcePath, tmpCover, VIDEO_HD_COVER_MAX_WIDTH, VIDEO_HD_COVER_QUALITY);
      await fs.promises.rename(tmpCover, coverPath);
    } catch (error) {
      this.logger.warn(`高清封面生成失败 id=${file.id}: ${(error as Error).message}`);
    } finally {
      await fs.promises.unlink(tmpCover).catch(() => {});
    }
  }

  /**
   * 从 Telegram 下载原图，用 sharp 生成十分之一分辨率缩略图，存到本地。
   * 成功后将缩略图路径写入 File 实体。
   */
  async generateAndSaveThumbnail(file: File): Promise<void> {
    if (!file.mimeType?.startsWith('image/')) return;

    const activeBuild = this.thumbnailBuilds.get(file.id);
    if (activeBuild) return activeBuild;

    const build = this.buildAndSaveThumbnail(file).finally(() => {
      if (this.thumbnailBuilds.get(file.id) === build) {
        this.thumbnailBuilds.delete(file.id);
      }
    });
    this.thumbnailBuilds.set(file.id, build);
    return build;
  }

  private async buildAndSaveThumbnail(file: File): Promise<void> {
    if (file.thumbnailPath) {
      const fullPath = path.join(this.thumbnailDir, file.thumbnailPath);
      if (fs.existsSync(fullPath)) return;
    }

    // 唯一临时文件 + 原子发布，避免并发任务或异常退出留下半成品。
    const buildId = uuidv4();
    const tmpSource = path.join(this.thumbnailDir, `${file.id}.${buildId}.src.tmp`);
    const tmpThumbnail = path.join(this.thumbnailDir, `${file.id}.${buildId}.webp.tmp`);
    const thumbFilename = `${file.id}.webp`;
    const thumbPath = path.join(this.thumbnailDir, thumbFilename);
    try {
      const { stream } = await this.telegramService.getFileStream(file.telegramFileId || file.filename);
      const { pipeline } = await import('stream/promises');
      await pipeline(stream, fs.createWriteStream(tmpSource));

      const metadata = await sharp(tmpSource).metadata();
      const width = metadata.width || 0;
      const height = metadata.height || 0;
      if (width <= 0 || height <= 0) throw new Error('无法读取图片尺寸');

      // 小图也统一生成 WebP，持久化完成状态，避免每次请求及每次启动重复回源探测。
      const isSmallImage = width < 300 && height < 300;
      const thumbWidth = isSmallImage ? width : Math.max(16, Math.round(width / 10));
      const thumbHeight = isSmallImage ? height : Math.max(16, Math.round(height / 10));

      await sharp(tmpSource)
        .resize(thumbWidth, thumbHeight, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 60 })
        .toFile(tmpThumbnail);
      await fs.promises.rename(tmpThumbnail, thumbPath);

      file.thumbnailPath = thumbFilename;
      await this.fileRepository.save(file);
    } catch (err) {
      this.logger.warn(`缩略图生成失败 id=${file.id}: ${(err as Error).message}`);
    } finally {
      await Promise.all([
        fs.promises.unlink(tmpSource).catch(() => {}),
        fs.promises.unlink(tmpThumbnail).catch(() => {}),
      ]);
    }
  }

  /**
   * 启动时扫描数据库，为所有图片/视频补齐缩略图或封面。
   * 视频允许在后台实时回源生成；串行处理避免启动瞬间占满 Telegram 与 FFmpeg。
   */
  async syncMissingThumbnails(): Promise<void> {
    const batchSize = 25;
    let lastId: string | null = null;
    let totalProcessed = 0;

    // 使用主键游标遍历全部媒体，而不是只查 thumbnailPath=NULL：
    // 数据库路径存在但磁盘产物丢失时同样需要重新生成。
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const query = this.fileRepository
        .createQueryBuilder('file')
        .select(['file.id', 'file.mimeType', 'file.telegramFileId', 'file.filename', 'file.thumbnailPath'])
        .where('file.isDeleted = false')
        .andWhere('(file.mimeType LIKE :imagePrefix OR file.mimeType LIKE :videoPrefix)', {
          imagePrefix: 'image/%',
          videoPrefix: 'video/%',
        })
        .orderBy('file.id', 'ASC')
        .take(batchSize);
      if (lastId) query.andWhere('file.id > :lastId', { lastId });
      const files = await query.getMany();

      if (files.length === 0) break;
      for (const file of files) {
        const expectedName = file.mimeType.startsWith('video/') ? `${file.id}.video.webp` : `${file.id}.webp`;
        const expectedPath = path.join(this.thumbnailDir, expectedName);
        if (!fs.existsSync(expectedPath)) {
          if (file.mimeType.startsWith('video/')) {
            await this.generateAndSaveVideoCover(file, { allowRemoteSource: true });
          } else {
            await this.generateAndSaveThumbnail(file);
          }
          totalProcessed++;
        } else if (file.thumbnailPath !== expectedName) {
          file.thumbnailPath = expectedName;
          await this.fileRepository.save(file);
        }
      }
      lastId = files[files.length - 1].id;
      await new Promise<void>(resolve => setImmediate(resolve));
    }

    if (totalProcessed > 0) {
      this.logger.log(`媒体缩略图同步完成: 处理了 ${totalProcessed} 个缺失产物`);
    }
  }

  /**
   * 删除本地缩略图文件。
   */
  private deleteLocalThumbnail(file: File): void {
    if (!file.thumbnailPath) return;
    const fullPath = path.join(this.thumbnailDir, file.thumbnailPath);
    try {
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    } catch (err) {
      this.logger.warn(`删除缩略图文件失败: ${fullPath}, ${(err as Error).message}`);
    }
  }

  /**
   * 读取本地缩略图文件内容（异步，避免 readFileSync 阻塞事件循环）。
   */
  private async readLocalThumbnail(file: File): Promise<Buffer | null> {
    if (!file.thumbnailPath) return null;
    const fullPath = path.join(this.thumbnailDir, file.thumbnailPath);
    try {
      return await fs.promises.readFile(fullPath);
    } catch {
      // 文件不存在或读取失败
      return null;
    }
  }

  /** 读取已生成的高清视频封面文件内容，不存在返回 null。 */
  private async readHdLocalThumbnail(file: File): Promise<Buffer | null> {
    const coverName = `${file.id}.video.hd.webp`;
    const fullPath = path.join(this.thumbnailDir, coverName);
    try {
      return await fs.promises.readFile(fullPath);
    } catch {
      return null;
    }
  }


  /** 统一选择正式缓存或二次开发 Bot API 的实时冷回源。 */
  private async getDownloadStream(file: File, opts?: { noCache?: boolean }): Promise<{
    stream: Readable;
    actualSize: number;
  }> {
    const expectedSize = Number(file.size);
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
      throw new BadRequestException('文件大小无效');
    }
    if (file.status === 'error') {
      throw new BadRequestException('文件上传失败，无法下载或预览');
    }
    if (file.status === 'processing' && !this.fileCacheService.getCachedPath(file.id)) {
      throw new BadRequestException('文件正在处理中，请稍后刷新重试');
    }
    // 请求级强制无缓存优先，其次跟随全局配置
    const noCache = opts?.noCache ?? this.fileCacheService.isNoCacheMode();
    if (noCache) {
      const result = await this.fileCacheService.getNoCacheStream(
        file.id,
        expectedSize,
        // 无缓存直通：携带 X-Telegram-No-Cache 头，传输完成后由 Bot API 清理 workdir 本地副本
        () => this.telegramService.getRealtimeFileStream(file.telegramFileId || file.filename, expectedSize, { noCache: true }),
      );
      return { stream: result.stream, actualSize: expectedSize };
    }
    const result = await this.fileCacheService.getOrCacheStream(
      file.id,
      expectedSize,
      // 调用时动态评估：默认构建缓存路径不带头；若容量准备期间模式翻转进入无缓存早退分支则带头
      () => this.telegramService.getRealtimeFileStream(file.telegramFileId || file.filename, expectedSize, { noCache: this.fileCacheService.isNoCacheMode() }),
    );
    return { stream: result.stream, actualSize: expectedSize };
  }

  /**
   * 流式下载文件内容（后端代理，不暴露 Telegram URL）
   * 用于避免大文件全部加载到内存
   */
  async getFileContentStream(id: string, user: User, ip?: string, opts?: { noCache?: boolean }): Promise<{
    stream: Readable;
    contentType: string;
    filename: string;
    size: number;
    accessLogId?: string;
  }> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    await this.assertFileReadable(file, user);

    // 原子递增访问计数（先扣次数，再拉取文件，避免拉取成功但计数失败）
    const updateResult = await this.fileRepository
      .createQueryBuilder()
      .update(File)
      .set({ currentAccessCount: () => 'currentAccessCount + 1' })
      .where('id = :id', { id })
      .andWhere('(maxAccessCount <= 0 OR currentAccessCount < maxAccessCount)')
      .andWhere('isDeleted = false')
      .execute();

    if (updateResult.affected === 0) {
      throw new ForbiddenException('访问次数已用尽或文件不存在');
    }

    const { stream } = await this.getDownloadStream(file, opts);

    // 写访问日志（responseSize 先占位为 0，流式传输完成后由 controller 更新为实际字节数）
    let accessLogId: string | undefined;
    try {
      const saved = await this.accessLogRepository.save({
        fileId: id,
        ip: ip || '',
        action: 'download',
        uploaderId: file.uploaderId,
        responseSize: 0,
      });
      accessLogId = saved.id;
    } catch {
      // 日志记录失败不影响主流程
    }

    const mimeType = file.mimeType || 'application/octet-stream';
    const filename = this.ensureFileExtension(file.originalName, mimeType);

    return { stream, contentType: mimeType, filename, size: Number(file.size), accessLogId };
  }

  /**
   * 流式下载支持 Range 请求（仅缓存命中时可用）
   * 返回 206 范围流或 null（表示不支持 Range，回退完整下载）
   */
  async getFileContentStreamWithRange(
    id: string,
    user: User,
    rangeHeader: string,
    opts?: { noCache?: boolean },
  ): Promise<{
    stream: Readable;
    contentType: string;
    filename: string;
    size: number;
    start: number;
    end: number;
    total: number;
    accessLogId?: string;
  } | null> {
    // 解析 Range: bytes=start-end
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!match) return null;

    // 请求级无缓存：Range 依赖本地缓存文件，无缓存时回退完整下载
    if (opts?.noCache) return null;

    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : undefined;

    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });
    if (!file) throw new NotFoundException('文件不存在');

    await this.assertFileReadable(file, user);

    // 仅对本地缓存的文件支持 Range
    const cachedPath = this.fileCacheService.getCachedPath(file.id);
    if (!cachedPath) {
      // 未缓存的文件回退到完整下载（Telegram API 不支持 Range）
      return null;
    }

    if (file.status === 'error') {
      throw new BadRequestException('文件上传失败，无法下载或预览');
    }
    // 文件仍在处理中（TG 未同步）→ 拒绝范围下载，避免用临时 UUID 回源
    if (file.status === 'processing') {
      throw new BadRequestException('文件正在处理中，请稍后刷新重试');
    }

    const total = Number(file.size);
    const actualEnd = end !== undefined ? Math.min(end, total - 1) : total - 1;

    if (start >= total || start > actualEnd) {
      throw new RangeNotSatisfiableException(total);
    }

    // 读取指定范围的文件片段
    const chunkSize = actualEnd - start + 1;
    const readStream = createReadStream(cachedPath, { start, end: actualEnd });

    // 原子访问计数：与完整下载路径一致，强制 maxAccessCount 上限并校验 affected，
    // 防止受限文件被无限次范围下载绕过。
    const updateResult = await this.fileRepository
      .createQueryBuilder()
      .update(File)
      .set({ currentAccessCount: () => 'currentAccessCount + 1' })
      .where('id = :id', { id })
      .andWhere('(maxAccessCount <= 0 OR currentAccessCount < maxAccessCount)')
      .andWhere('isDeleted = false')
      .execute();

    if (updateResult.affected === 0) {
      readStream.destroy();
      throw new ForbiddenException('访问次数已用尽或文件不存在');
    }

    const mimeType = file.mimeType || 'application/octet-stream';
    const filename = this.ensureFileExtension(file.originalName, mimeType);

    return {
      stream: readStream,
      contentType: mimeType,
      filename,
      size: chunkSize,
      start,
      end: actualEnd,
      total,
    };
  }

  async generateShareLink(id: string, user: User): Promise<string> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    this.assertFileWritable(file, user);

    const baseUrl = this.configService.get<string>('APP_URL') || 'http://localhost:3000';
    const shareLink = `${baseUrl}/files/public/${id}`;

    // 审计日志：生成分享链接
    this.auditService.log({
      action: 'file_share',
      userId: user.id,
      resourceType: 'file',
      resourceId: id,
    });

    return shareLink;
  }


  /**
   * 检查文件是否为无约束公开文件（无需任何凭证即可访问）
   * PUBLIC + 无密码 + 无访问次数限制 + 未过期
   */
  async isUnrestrictedPublic(id: string): Promise<boolean> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false, accessType: FileAccessType.PUBLIC },
      select: ['password', 'maxAccessCount', 'expiresIn', 'expiresStartAt'],
    });
    if (!file || file.password || file.maxAccessCount > 0) {
      return false;
    }
    // 检查是否设置了有效期且已过期
    if (file.expiresIn !== null && file.expiresIn !== undefined && file.expiresStartAt) {
      const expiresAt = new Date(file.expiresStartAt.getTime() + file.expiresIn * 3600 * 1000);
      if (new Date() > expiresAt) {
        return false;
      }
    }
    return true;
  }

  /**
   * 生成短效访问 token（30 秒有效期，jti 防重放攻击）
   */
  generateAccessToken(fileId: string): string {
    const jti = uuidv4();
    return this.jwtService.sign(
      { sub: fileId, purpose: 'stream', jti },
      { expiresIn: '30s' },
    );
  }

  /**
   * 验证并消费短效访问 token（原子性消费 jti 防止重复使用）
   */
  async consumeAccessToken(token: string, fileId: string): Promise<void> {
    try {
      const payload = this.jwtService.verify(token);
      if (payload.sub !== fileId || payload.purpose !== 'stream') {
        throw new Error('token 用途不匹配');
      }
      if (payload.jti) {
        // 持久化消费状态：写入 share_audits 表，利用 jti 唯一约束防重放
        try {
          await this.shareAuditRepository.save({
            jti: payload.jti,
            fileId,
            userId: null,
            action: 'consume',
            ip: null,
          } as unknown as ShareAudit);
        } catch (dbError: unknown) {
          // PostgreSQL unique_violation (23505) = token 已被消费
          const code = (dbError as { code?: string }).code;
          if (code === '23505') {
            throw new ForbiddenException('访问链接已被使用，请重新获取');
          }
          throw dbError;
        }
      }
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }
      throw new ForbiddenException('访问链接已失效，请重新获取');
    }
  }

  /**
   * 通过短效访问 token 流式获取文件内容（重新校验文件状态，防止 token 有效期内外界状态变更）
   */
  async getPublicFileContentStreamWithAccess(id: string, ip?: string): Promise<{
    stream: Readable;
    contentType: string;
    filename: string;
    size: number;
    isInline: boolean;
    accessLogId?: string;
  }> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在或已被删除');
    }

    // 重新校验文件是否仍为公开访问
    if (file.accessType !== FileAccessType.PUBLIC) {
      throw new ForbiddenException('文件已设为私有，不再提供公开访问');
    }

    // 校验有效期
    if (file.expiresIn !== null && file.expiresIn !== undefined && file.expiresStartAt) {
      const expiresAt = new Date(file.expiresStartAt.getTime() + file.expiresIn * 3600 * 1000);
      if (new Date() > expiresAt) {
        throw new BadRequestException('文件分享已过期');
      }
    }

    const { stream, actualSize } = await this.getDownloadStream(file);

    let accessLogId: string | undefined;
    try {
      const saved = await this.accessLogRepository.save({
        fileId: id,
        ip: ip || '',
        action: 'public_direct',
        uploaderId: file.uploaderId,
        responseSize: 0,
      });
      accessLogId = saved.id;
    } catch {
      // ignore
    }

    const mimeType = file.mimeType || 'application/octet-stream';
    const isInline = /^(image|video|audio)\//.test(mimeType);
    const filename = this.ensureFileExtension(file.originalName, mimeType);

    return { stream, contentType: mimeType, filename, size: actualSize, isInline, accessLogId };
  }

  /**
   * 获取公开媒体直链的文件流。仅允许无密码、未过期、无次数限制的公开图片/音频/视频，
   * 避免裸文件 ID 绕过分享约束，同时复用统一的 Telegram 冷回源与本地缓存链路。
   */
  async getPublicMediaStream(id: string, ip?: string): Promise<{
    stream: Readable;
    contentType: string;
    filename: string;
    size: number;
    accessLogId?: string;
  }> {
    const file = await this.getPublicMediaFile(id);
    const { stream, actualSize } = await this.getDownloadStream(file);
    const accessLogId = await this.createPublicMediaAccessLog(file, ip);
    return {
      stream,
      contentType: file.mimeType,
      filename: this.ensureFileExtension(file.originalName, file.mimeType),
      size: actualSize,
      accessLogId,
    };
  }

  /** 公开媒体 Range：仅正式缓存命中时返回范围流，冷文件由控制器回退完整响应。 */
  async getPublicMediaStreamWithRange(id: string, rangeHeader: string, ip?: string): Promise<{
    stream: Readable;
    contentType: string;
    filename: string;
    size: number;
    start: number;
    end: number;
    total: number;
    accessLogId?: string;
  } | null> {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!match) return null;

    const file = await this.getPublicMediaFile(id);
    const cachedPath = this.fileCacheService.getCachedPath(file.id);
    if (!cachedPath) return null;

    const total = Number(file.size);
    const start = Number.parseInt(match[1], 10);
    const requestedEnd = match[2] ? Number.parseInt(match[2], 10) : total - 1;
    const end = Math.min(requestedEnd, total - 1);
    if (!Number.isSafeInteger(total) || total <= 0 || start >= total || start > end) {
      throw new RangeNotSatisfiableException(total);
    }

    return {
      stream: createReadStream(cachedPath, { start, end }),
      contentType: file.mimeType,
      filename: this.ensureFileExtension(file.originalName, file.mimeType),
      size: end - start + 1,
      start,
      end,
      total,
      accessLogId: await this.createPublicMediaAccessLog(file, ip),
    };
  }

  private async getPublicMediaFile(id: string): Promise<File> {
    const file = await this.fileRepository.findOne({ where: { id, isDeleted: false } });
    if (!file) throw new NotFoundException('媒体文件不存在');
    if (file.accessType !== FileAccessType.PUBLIC) {
      throw new ForbiddenException('此文件为私有文件，不提供媒体直链');
    }
    if (!/^(image|video|audio)\//i.test(file.mimeType || '')) {
      throw new BadRequestException('仅图片、音频和视频文件支持媒体直链');
    }
    if (file.password || file.maxAccessCount > 0) {
      throw new ForbiddenException('受密码或访问次数保护的文件不能使用媒体直链');
    }
    if (file.expiresIn !== null && file.expiresIn !== undefined) {
      if (file.expiresStartAt) {
        const expiresAt = new Date(file.expiresStartAt.getTime() + file.expiresIn * 3600 * 1000);
        if (new Date() > expiresAt) throw new ForbiddenException('媒体文件已过期');
      }
      throw new ForbiddenException('限时文件不能使用永久媒体直链');
    }
    if (file.status === 'error') {
      throw new BadRequestException('文件上传失败，无法下载或预览');
    }
    if (file.status === 'processing' && !this.fileCacheService.getCachedPath(file.id)) {
      throw new BadRequestException('文件正在处理中，请稍后刷新重试');
    }
    return file;
  }

  private async createPublicMediaAccessLog(file: File, ip?: string): Promise<string | undefined> {
    try {
      const saved = await this.accessLogRepository.save({
        fileId: file.id,
        ip: ip || '',
        action: 'public_media',
        uploaderId: file.uploaderId,
        responseSize: 0,
      });
      return saved.id;
    } catch {
      return undefined;
    }
  }

  /**
   * 流式获取公开文件内容（遗留公开访问能力）。
   */
  async getPublicFileContentStream(id: string, ip?: string): Promise<{
    stream: Readable;
    contentType: string;
    filename: string;
    size: number;
    isInline: boolean;
    accessLogId?: string;
  }> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    if (file.accessType !== FileAccessType.PUBLIC) {
      throw new ForbiddenException('此文件为私有文件，不提供公开访问');
    }

    const { stream, actualSize } = await this.getDownloadStream(file);
    const accessLogId = await this.createPublicMediaAccessLog(file, ip);
    const mimeType = file.mimeType || 'application/octet-stream';
    const isInline = /^(image|video|audio)\//.test(mimeType);
    const filename = this.ensureFileExtension(file.originalName, mimeType);
    return { stream, contentType: mimeType, filename, size: actualSize, isInline, accessLogId };
  }

  /**
   * 批量生成 Markdown：无约束公开文件用永久公开 URL，含约束文件用分享链接
   */
  async batchToMarkdown(ids: string[], user: User): Promise<string[]> {
    const files = await this.fileRepository.find({
      where: { id: In(ids), isDeleted: false, uploaderId: user.id },
    });

    const results: string[] = [];
    const baseUrl = this.configService.get<string>('APP_URL') || 'http://localhost:3000';

    for (const file of files) {
      if (!file.mimeType.startsWith('image/')) continue;
      const appUrl = `${baseUrl}/media/${file.id}`;
      results.push(`![${file.originalName}](${appUrl})`);
    }

    return results;
  }

  /**
   * 异步上传（用于大文件，避免 Cloudflare/CDN 代理超时）
   * 文件接收后立即返回 jobId，Telegram 上传在后台异步执行。
   * 前端通过 GET /api/files/upload-status/:jobId 轮询结果。
   *
   * @warning 任务存于内存（UploadJobService Map），进程崩溃或重启会丢失进行中的任务。
   *          如需持久化请迁移至 Bull 队列（项目已集成 @nestjs/bull）。
   *
   * @param req Express Request，用于监听客户端连接关闭事件，
   *            客户端断开后 30 秒未恢复则放弃 Telegram 上传任务
   */
  async uploadAsync(
    file: Express.Multer.File,
    user: User,
    tagIds?: string[],
    _req?: Request,
    folderId?: string | null,
    overwriteFileId?: string,
  ): Promise<{ jobId: string; warning: string }> {
    if (file.size > this.maxFileSize) {
      throw new BadRequestException(`文件大小不能超过 ${this.maxFileSize / 1024 / 1024}MB`);
    }

    const originalName = this.fixFilenameEncoding(file.originalname);

    await this.assertUploadFolder(folderId, user.id);

    const fileSample = await this.getFileSample(file);
    const typeCheck = await this.isFileTypeAllowed(originalName, fileSample);
    if (!typeCheck.allowed) {
      throw new BadRequestException(typeCheck.reason || '不允许上传此类型的文件');
    }

    const job = this.uploadJobService.createJob(user, originalName);

    // 文件已由 Multer 完整接收后，后台任务与原 HTTP 连接解耦；
    // 正常响应结束也会触发 request close，不能据此取消仍在进行的 Telegram 上传。
    const abortController = new AbortController();
    const cleanup = () => {};

    // 后台处理：不阻塞响应
    this.processAsyncUpload(job.jobId, file, user, originalName, abortController.signal, cleanup, tagIds, folderId, overwriteFileId);
    return { jobId: job.jobId, warning: '任务在内存中处理，进程重启会丢失' };
  }

  /**
   * 异步批量上传
   *
   * @warning 任务存于内存（UploadJobService Map），进程崩溃或重启会丢失进行中的任务。
   *          如需持久化请迁移至 Bull 队列（项目已集成 @nestjs/bull）。
   *
   * @param req Express Request，用于监听客户端连接关闭事件，
   *            客户端断开后 30 秒未恢复则放弃 Telegram 上传任务
   */
  async uploadMultipleAsync(
    files: Express.Multer.File[],
    user: User,
    tagIds?: string[],
    _req?: Request,
  ): Promise<{ jobId: string; total: number; warning: string }> {
    const job = this.uploadJobService.createJob(user, `${files.length} 个文件`, files.length);

    // 文件已由 Multer 完整接收后，后台任务与原 HTTP 连接解耦；
    // 正常响应结束也会触发 request close，不能据此取消仍在进行的 Telegram 上传。
    const abortController = new AbortController();
    const cleanup = () => {};

    setImmediate(async () => {
      const success: File[] = [];
      const failed: BatchUploadFailedItem[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          // 每个文件上传前检查是否已被放弃
          if (abortController.signal.aborted) {
            throw new Error('任务已被放弃（客户端连接断开）');
          }
          const originalName = this.fixFilenameEncoding(file.originalname);
          const fileSample = this.getFileSample(file);
          const typeCheck = await this.isFileTypeAllowed(originalName, fileSample);
          if (!typeCheck.allowed) {
            failed.push({ name: originalName, reason: typeCheck.reason || '不允许上传此类型的文件' });
            continue;
          }
          if (file.size > this.maxFileSize) {
            failed.push({ name: originalName, reason: `文件大小超过 ${this.maxFileSize / 1024 / 1024}MB` });
            continue;
          }
          const uploadedFile = await this.uploadToTelegram(file, user, originalName, abortController.signal);
          // 上传完成后关联标签（参数化查询）
          if (tagIds && tagIds.length > 0) {
            await this.insertFileTags(this.fileRepository.manager, uploadedFile.id, tagIds);
          }
          success.push(uploadedFile);
        } catch (error: unknown) {
          // 任务被放弃时直接退出循环
          if (abortController.signal.aborted) {
            this.logger.warn(`批量上传任务 ${job.jobId} 已被放弃，剩余 ${files.length - i} 个文件未处理`);
            break;
          }
          failed.push({
            name: file.originalname,
            reason: error instanceof Error ? error.message : '上传失败',
          });
        }
        this.uploadJobService.updateJob(job.jobId, {
          progress: Math.round(((i + 1) / files.length) * 100),
        });
      }

      // 若任务已被放弃，processAsyncUpload 的清理逻辑会标记 failed，此处不覆盖
      if (!abortController.signal.aborted) {
        this.uploadJobService.updateJob(job.jobId, {
          status: 'completed',
          progress: 100,
          result: { success, failed },
        });
      }
      cleanup();
    });

    return { jobId: job.jobId, total: files.length, warning: '任务在内存中处理，进程重启会丢失' };
  }

  getUploadJob(jobId: string): UploadJob | undefined {
    return this.uploadJobService.getJob(jobId);
  }

  /**
   * 后台处理单个文件上传到 Telegram
   *
   * @param abortSignal 客户端连接断开 30 秒后触发 abort，中止上传
   * @param cleanup 任务完成/失败时调用，清理 req 监听器和 timer
   */
  private async processAsyncUpload(
    jobId: string,
    file: Express.Multer.File,
    user: User,
    originalName: string,
    abortSignal?: AbortSignal,
    cleanup: () => void = () => {},
    tagIds?: string[],
    folderId?: string | null,
    overwriteFileId?: string,
  ): Promise<void> {
    try {
      this.uploadJobService.updateJob(jobId, { status: 'uploading' });

      // 任务开始前检查是否已被放弃
      if (abortSignal?.aborted) {
        throw new Error('任务已被放弃');
      }

      const savedFile = await this.uploadToTelegram(file, user, originalName, abortSignal, folderId, overwriteFileId);

      // 上传完成后关联标签（参数化查询）
      if (tagIds && tagIds.length > 0) {
        await this.insertFileTags(this.fileRepository.manager, savedFile.id, tagIds);
      }

      // 完成前再次检查，避免连接断开后仍写入成功结果
      if (abortSignal?.aborted) {
        throw new Error('任务已被放弃');
      }

      this.uploadJobService.updateJob(jobId, {
        status: 'completed',
        progress: 100,
        result: savedFile,
      });
    } catch (error: unknown) {
      // 若任务已被放弃，setupAbortOnDisconnect 已标记 failed，此处不覆盖
      const job = this.uploadJobService.getJob(jobId);
      if (job && job.status !== 'failed') {
        this.uploadJobService.updateJob(jobId, {
          status: 'failed',
          error: error instanceof Error ? error.message : '上传失败',
        });
      }
    } finally {
      cleanup();
    }
  }

  /**
   * 上传文件到 Telegram 并保存数据库记录
   *
   * @param abortSignal 透传到 Telegram axios 请求，支持中途取消
   */
  private async uploadToTelegram(
    file: Express.Multer.File,
    user: User,
    originalName: string,
    abortSignal?: AbortSignal,
    folderId?: string | null,
    overwriteFileId?: string,
  ): Promise<File> {
    // GIF 文件加 .bin 后缀防止 Telegram 转码为 MP4
    const uploadName = file.mimetype === 'image/gif' ? originalName + '.bin' : originalName;
    const useStream = file.path && fs.existsSync(file.path);
    const uploadSource = useStream ? createReadStream(file.path) : file.buffer;
    const telegramFile = await this.telegramService.uploadFile(
      uploadSource,
      uploadName,
      abortSignal,
      useStream ? file.size : undefined,
    );

    // 覆盖分支：TG 上传成功后优先 in-place 覆盖目标记录（保留原 id），目标失效则降级新建
    if (overwriteFileId) {
      const overwritten = await this.tryApplyOverwriteOrNull(
        overwriteFileId,
        user,
        folderId ?? null,
        (target) => this.applyOverwrite(target, {
          telegramFileId: telegramFile.file_id,
          telegramFilePath: telegramFile.file_path || '',
          filename: telegramFile.file_id,
          originalName,
          size: file.size,
          mimeType: file.mimetype,
          user,
        }),
        'uploadToTelegram',
      );
      if (overwritten) {
        await this.generateUploadedMediaThumbnail(overwritten, file);
        this.cleanupTempFile(file);
        return overwritten;
      }
    }

    const newFile = this.fileRepository.create({
      filename: telegramFile.file_id,
      originalName: originalName,
      mimeType: file.mimetype,
      size: file.size,
      telegramFileId: telegramFile.file_id,
      telegramFilePath: telegramFile.file_path || '',
      uploaderId: user.id,
      folderId: folderId ?? null,
      accessType: FileAccessType.PUBLIC,
      maxAccessCount: this.accessCountDefault,
    });

    const savedFile = await this.fileRepository.save(newFile);
    await this.generateUploadedMediaThumbnail(savedFile, file);
    this.cleanupTempFile(file);
    return savedFile;
  }

  private async generateUploadedMediaThumbnail(savedFile: File, source: Express.Multer.File): Promise<void> {
    if (savedFile.mimeType?.startsWith('video/')) {
      await this.generateAndSaveVideoCover(savedFile, {
        sourcePath: source.path,
        sourceBuffer: source.buffer,
        allowRemoteSource: !source.path && !source.buffer,
      });
    } else if (savedFile.mimeType?.startsWith('image/')) {
      await this.generateAndSaveThumbnail(savedFile);
    }
  }

  /**
   * 设置文件标签（全量替换模式，事务内执行）
   */
  async setFileTags(fileId: string, user: User, tagIds: string[]): Promise<void> {
    const file = await this.fileRepository.findOne({ where: { id: fileId } });
    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    // 权限校验：文件所有者或管理员
    if (file.uploaderId !== user.id && user.role !== UserRole.ADMIN && user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('无权操作此文件');
    }

    const uniqueTagIds = [...new Set(tagIds)].sort();

    // 固定锁顺序：files → 排序后的 tags → file_tags，避免与父表级联删除形成环形等待。
    await this.fileRepository.manager.transaction(async (manager) => {
      const lockedFiles = await manager.query(
        'SELECT id FROM files WHERE id = $1 FOR UPDATE',
        [fileId],
      );
      if (lockedFiles.length === 0) {
        throw new NotFoundException('文件不存在');
      }
      if (uniqueTagIds.length > 0) {
        await manager.query(
          'SELECT id FROM tags WHERE id = ANY($1::uuid[]) ORDER BY id FOR KEY SHARE',
          [uniqueTagIds],
        );
      }
      await manager.query('DELETE FROM file_tags WHERE "fileId" = $1', [fileId]);
      if (uniqueTagIds.length > 0) {
        await this.insertFileTags(manager, fileId, uniqueTagIds);
      }
    });

    this.auditService.log({
      action: 'tag_set_file',
      userId: user.id,
      resourceType: 'file',
      resourceId: fileId,
      metadata: { tagIds },
    });
  }

  /**
   * 移除文件单个标签
   */
  async removeFileTag(fileId: string, user: User, tagId: string): Promise<void> {
    const file = await this.fileRepository.findOne({ where: { id: fileId } });
    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    if (file.uploaderId !== user.id && user.role !== UserRole.ADMIN && user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('无权操作此文件');
    }

    const result = await this.fileRepository.manager.query(
      'DELETE FROM file_tags WHERE "fileId" = $1 AND "tagId" = $2',
      [fileId, tagId],
    );

    if (result[1] === 0) { // affected rows = 0
      throw new NotFoundException('标签关联不存在');
    }

    this.auditService.log({
      action: 'tag_set_file',
      userId: user.id,
      resourceType: 'file',
      resourceId: fileId,
      metadata: { removedTagId: tagId },
    });
  }

  /**
   * 参数化插入 file_tags 关联，防止 SQL 注入
   * tagIds 必须先通过 UUID 格式校验后才调用此方法
   */
  private async insertFileTags(
    manager: EntityManager,
    fileId: string,
    tagIds: string[],
  ): Promise<void> {
    if (!tagIds || tagIds.length === 0) return;
    // UUID 格式防御性校验
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const tagId of tagIds) {
      if (!uuidRegex.test(tagId)) {
        throw new BadRequestException(`无效的 tagId 格式: ${tagId}`);
      }
    }
    // 参数化批量 INSERT，避免 SQL 注入
    const placeholders = tagIds.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
    const params: any[] = [];
    tagIds.forEach((tagId) => { params.push(fileId, tagId); });
    await manager.query(
      `INSERT INTO file_tags ("fileId", "tagId") VALUES ${placeholders}`,
      params,
    );
  }

  /**
   * 流式传输完成后，更新 FileAccessLog.responseSize 为实际传输字节数。
   * 由 FileController 在 pipeline 结束后调用。
   */
  async updateAccessLogResponseSize(logId: string, bytesTransferred: number): Promise<void> {
    if (!logId || bytesTransferred < 0) return;
    try {
      await this.accessLogRepository.update(logId, {
        responseSize: bytesTransferred,
      });
    } catch {
      // 日志更新失败不影响业务
    }
  }

  /**
   * 为分享链接下载流式返回文件内容（Phase 2 新增）。
   *
   * 与 getPublicFileContentStream 的区别：
   * 1. 不检查 accessType —— ShareLink 本身就是访问凭证，private 文件也能通过分享链接下载。
   * 2. 访问日志记录 action='share_download'，便于按渠道统计。
   *
   * 由 ShareService 在校验完 token + access JWT 后调用。
   */
  async getStreamForShareDownload(id: string, ip?: string): Promise<{
    stream: Readable;
    contentType: string;
    filename: string;
    size: number;
    isInline: boolean;
    accessLogId?: string;
  }> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });
    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    const { stream, actualSize } = await this.getDownloadStream(file);

    let accessLogId: string | undefined;
    try {
      const saved = await this.accessLogRepository.save({
        fileId: id,
        ip: ip || '',
        action: 'share_download',
        uploaderId: file.uploaderId,
        responseSize: 0,
      });
      accessLogId = saved.id;
    } catch {
      // 日志写入失败不影响下载
    }

    const mimeType = file.mimeType || 'application/octet-stream';
    const isInline = /^(image|video|audio)\//.test(mimeType);
    const filename = this.ensureFileExtension(file.originalName, mimeType);

    return { stream, contentType: mimeType, filename, size: actualSize, isInline, accessLogId };
  }

  /**
   * 为 inline 预览流式返回文件内容（镜像 getFileContentStream）。
   * 与下载的差异：
   * 1. 不递增 currentAccessCount —— 预览不消耗访问次数配额。
   * 2. 访问日志 action 记为 'preview'。
   */
  async getPreviewStream(id: string, user: User, ip?: string): Promise<{
    stream: Readable;
    contentType: string;
    filename: string;
    size: number;
    accessLogId?: string;
  }> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    await this.assertFileReadable(file, user);

    const { stream } = await this.getDownloadStream(file);

    // 写访问日志（action=preview，responseSize 先占位为 0，流式传输完成后由 controller 更新为实际字节数）
    let accessLogId: string | undefined;
    try {
      const saved = await this.accessLogRepository.save({
        fileId: id,
        ip: ip || '',
        action: 'preview',
        uploaderId: file.uploaderId,
        responseSize: 0,
      });
      accessLogId = saved.id;
    } catch {
      // 日志记录失败不影响主流程
    }

    const mimeType = file.mimeType || 'application/octet-stream';
    const filename = this.ensureFileExtension(file.originalName, mimeType);

    return { stream, contentType: mimeType, filename, size: Number(file.size), accessLogId };
  }

  /**
   * 预览的 RANGE 版本（镜像 getFileContentStreamWithRange）。
   * 仅本地缓存命中时返回 206 范围流，未命中返回 null 由 controller 回退全量预览。
   * 与下载的差异：不递增 currentAccessCount，访问日志 action 记为 'preview'。
   */
  async getPreviewStreamWithRange(
    id: string,
    user: User,
    rangeHeader: string,
    ip?: string,
  ): Promise<{
    stream: Readable;
    contentType: string;
    filename: string;
    size: number;
    start: number;
    end: number;
    total: number;
    accessLogId?: string;
  } | null> {
    // 解析 Range: bytes=start-end
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!match) return null;

    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : undefined;

    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });
    if (!file) throw new NotFoundException('文件不存在');

    await this.assertFileReadable(file, user);

    if (file.status === 'error') {
      throw new BadRequestException('文件上传失败，无法下载或预览');
    }
    // 文件仍在处理中（TG 未同步）→ 拒绝范围预览，避免用临时 UUID 回源

    if (file.status === 'processing') {
      throw new BadRequestException('文件正在处理中，请稍后刷新重试');
    }

    const total = Number(file.size);
    const actualEnd = end !== undefined ? Math.min(end, total - 1) : total - 1;

    if (start >= total || start > actualEnd) {
      throw new RangeNotSatisfiableException(total);
    }

    const chunkSize = actualEnd - start + 1;
    // 冷资源（无正式缓存）不支持真实分片：返回 null 交由控制器回退全量预览，
    // 由 getPreviewStream → getOrCacheStream 复用同一缓存构建会话，保证单连接加载；
    // 前端在冷资源阶段钳制 seek，拖动进度条不再触发新的动态分段回源。
    const cachedPath = this.fileCacheService.getCachedPath(file.id);
    if (!cachedPath) return null;
    const readStream = createReadStream(cachedPath, { start, end: actualEnd });

    // 预览不递增 currentAccessCount，仅写访问日志（action=preview）

    let accessLogId: string | undefined;
    try {
      const saved = await this.accessLogRepository.save({
        fileId: id,
        ip: ip || '',
        action: 'preview',
        uploaderId: file.uploaderId,
        responseSize: 0,
      });
      accessLogId = saved.id;
    } catch {
      // 日志记录失败不影响主流程
    }

    const mimeType = file.mimeType || 'application/octet-stream';
    const filename = this.ensureFileExtension(file.originalName, mimeType);

    return {
      stream: readStream,
      contentType: mimeType,
      filename,
      size: chunkSize,
      start,
      end: actualEnd,
      total,
      accessLogId,
    };
  }

  /**
   * 分享预览的 RANGE 版本（与 getPublicMediaStreamWithRange 同构）。
   * 不做 accessType 检查 —— 分享链接本身就是凭证，校验链由 ShareService 负责；
   * 仅正式缓存命中时返回范围流，冷文件返回 null 由上层回退完整响应。
   * 访问日志 action 记为 'share_preview'。
   */
  async getSharePreviewStreamWithRange(fileId: string, rangeHeader: string, ip?: string): Promise<{
    stream: Readable;
    contentType: string;
    filename: string;
    size: number;
    isInline: boolean;
    start: number;
    end: number;
    total: number;
    accessLogId?: string;
  } | null> {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!match) return null;

    const file = await this.fileRepository.findOne({ where: { id: fileId, isDeleted: false } });
    if (!file) throw new NotFoundException('文件不存在');

    if (file.status === 'error') {
      throw new BadRequestException('文件上传失败，无法下载或预览');
    }

    const cachedPath = this.fileCacheService.getCachedPath(file.id);
    if (!cachedPath) return null;

    const total = Number(file.size);
    const start = Number.parseInt(match[1], 10);
    const requestedEnd = match[2] ? Number.parseInt(match[2], 10) : total - 1;
    const end = Math.min(requestedEnd, total - 1);
    if (!Number.isSafeInteger(total) || total <= 0 || start >= total || start > end) {
      throw new RangeNotSatisfiableException(total);
    }

    const mimeType = file.mimeType || 'application/octet-stream';
    return {
      stream: createReadStream(cachedPath, { start, end }),
      contentType: mimeType,
      filename: this.ensureFileExtension(file.originalName, mimeType),
      size: end - start + 1,
      isInline: /^(image|video|audio)\//.test(mimeType),
      start,
      end,
      total,
      accessLogId: await this.createSharePreviewAccessLog(file, ip),
    };
  }

  private async createSharePreviewAccessLog(file: File, ip?: string): Promise<string | undefined> {
    try {
      const saved = await this.accessLogRepository.save({
        fileId: file.id,
        ip: ip || '',
        action: 'share_preview',
        uploaderId: file.uploaderId,
        responseSize: 0,
      });
      return saved.id;
    } catch {
      return undefined;
    }
  }
}
