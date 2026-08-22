import { Injectable, NotFoundException, ForbiddenException, BadRequestException, GoneException, OnModuleInit, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, IsNull, EntityManager } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Readable } from 'stream';
import { Request } from 'express';
import * as fs from 'fs';
import { createReadStream, writeFileSync } from 'fs';
import * as path from 'path';
import { fileTypeFromBuffer } from 'file-type';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { QUEUE_NAMES } from '../jobs/bull-queue.module';
import { File, FileAccessType } from '../common/entities/file.entity';
import { Folder } from '../common/entities/folder.entity';
import { FileAccessLog } from '../common/entities/file-access-log.entity';
import { ShareLink, ShareLinkStatus, ShareTargetType } from '../common/entities/share-link.entity';
import { TelegramService } from '../telegram/telegram.service';
import { TelegramFileNotFoundError } from '../telegram/telegram.errors';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { User, UserRole } from '../common/entities/user.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { ShareAudit } from '../common/entities/share-audit.entity';
import { RateLimitService } from '../common/services/rate-limit.service';
import { AuditService } from '../common/services/audit.service';
import { UploadJobService, UploadJob } from './upload-job.service';
import { FileCacheService } from './file-cache.service';
import { ThumbnailService } from './thumbnail.service';
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { BCRYPT_ROUNDS } from '../common/constants/bcrypt';
import { FILE_DELETE_GRACE_MS, FILE_DELETE_COOLDOWN_MS } from '../common/constants/durations';
import { isSafePublicInlineContentType } from '../common/utils/preview-content-type';
import { parseByteRange } from '../common/utils/byte-range';
import {
  RangeNotSatisfiableException,
  encodeCursor,
  decodeCursor,
  escapeLike,
  fixFilenameEncoding,
  ensureFileExtension,
  parseFileSize,
  parseAccessCount,
} from './file-utils';

export { RangeNotSatisfiableException };

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

@Injectable()
export class FileService implements OnModuleInit {
  private readonly logger = new Logger(FileService.name);
  private maxFileSize: number;
  private fileTypeMode: 'blacklist' | 'whitelist' = 'blacklist';
  private fileTypeFilter: string[] = [];
  private accessCountDefault = -1;
  private accessCountMax = -1;
  /** 最近标记为 error 的文件 id → 时间戳，用于下载降级去重，避免并发下载造成审计/日志风暴 */
  private readonly invalidMarkedAt = new Map<string, number>();

  // G2-15：Range 下载配额扣次短期去重（30s 内同文件同 IP 只扣一次）。
  // 视频播放/断点续传会产生大量 Range 请求，若每个 Range 都扣一次 maxAccessCount，
  // 单次播放即可耗尽有限次数的分享/下载配额。此 Map 以「fileId|ip|user」为键缓存
  // 最近一次扣次时间，窗口内命中则幂等免扣。接受秒级误差，内存有界（超限即清空）。
  private static readonly RANGE_QUOTA_DEDUP_MS = 30 * 1000;
  private readonly rangeQuotaDedup = new Map<string, number>();

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
    @InjectRepository(ShareLink)
    private shareLinkRepository: Repository<ShareLink>,
    private telegramService: TelegramService,
    private configService: ConfigService,
    private jwtService: JwtService,
    private configCacheService: ConfigCacheService,
    private rateLimitService: RateLimitService,
    private uploadJobService: UploadJobService,
    private auditService: AuditService,
    private fileCacheService: FileCacheService,
    private thumbnailService: ThumbnailService,
    @InjectQueue(QUEUE_NAMES.FILE_UPLOAD)
    private fileUploadQueue: Queue,
  ) {
    this.maxFileSize = parseFileSize(this.configService.get<string>('MAX_FILE_SIZE'));
  }

  async onModuleInit() {
    await this.reloadUploadConfig();
    // 确保缩略图目录存在
    this.thumbnailService.ensureThumbnailDir();
    // 异步扫描并补齐缺失的缩略图（不阻塞启动）
    this.thumbnailService.syncMissingThumbnails().catch(err => {
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
    this.maxFileSize = parseFileSize(maxFileSize);
    this.fileTypeMode = (fileTypeMode === 'whitelist' ? 'whitelist' : 'blacklist');
    this.fileTypeFilter = fileTypeFilter
      ? fileTypeFilter.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      : [];
    this.accessCountDefault = parseAccessCount(accessCountDefault);
    this.accessCountMax = parseAccessCount(accessCountMax);
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
    // C-05 修复：必须等待 invalidate 完成（含在途 build/spool 会话终结）后再返回，
    // 禁止 fire-and-forget——否则旧缓存可能在新元数据生效后仍被读取，造成「旧内容配新元数据」。
    await this.fileCacheService.invalidate(target.id);
    await this.thumbnailService.deleteThumbnailsForFileId(target.id);

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

    const fileName = fixFilenameEncoding(originalName);

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
          // C-05 修复：进入 processing/replacing 前必须等待旧缓存（正式缓存 + spool + 在途 build）
          // 完全失效，避免覆盖上传期间旧缓存与新元数据错配。
          await this.fileCacheService.invalidate(target.id);
          await this.thumbnailService.deleteThumbnailsForFileId(target.id);
          // G2-05 修复：uploadVersion+1 是读-改-写，必须放入事务 + 悲观行锁原子执行，
          // 防止并发覆盖时两个事务各自基于旧版本递增导致版本丢失、内容不一致。
          const updated = await this.fileRepository.manager.transaction(async (manager) => {
            const repo = manager.getRepository(File);
            const locked = await repo.findOne({
              where: { id: target.id },
              lock: { mode: 'pessimistic_write' },
            });
            if (!locked || locked.isDeleted) {
              throw new NotFoundException('覆盖目标文件不存在或已被删除');
            }
            if (locked.uploaderId !== user.id) {
              throw new BadRequestException('覆盖目标文件不属于当前用户');
            }
            if ((locked.folderId ?? null) !== resolvedFolderId) {
              throw new BadRequestException('覆盖目标文件与上传目标目录不一致');
            }
            if (locked.status === 'processing') {
              throw new BadRequestException('覆盖目标文件正在处理中，请稍后重试');
            }
            // tempId 占位语义与新记录一致，由 FileUploadProcessor 按 fileId 更新为真实 TG 引用
            locked.status = 'processing';
            locked.uploadVersion = (locked.uploadVersion || 1) + 1;
            locked.uploadStage = 'pending';
            locked.uploadFailureReason = null; // 覆盖上传即视为重新开始，清空历史失败原因
            locked.originalName = fileName;
            locked.size = file.size;
            locked.mimeType = file.mimetype || 'application/octet-stream';
            locked.filename = tempId;
            locked.telegramFileId = tempId;
            locked.telegramFilePath = '';
            locked.thumbnailPath = null;
            await repo.save(locked);
            return locked;
          });
          // 审计覆盖意图（status=processing，真实引用由 processor 落库后另有流程记录）
          this.auditService.log({
            action: 'file_overwrite',
            userId: user.id,
            resourceType: 'file',
            resourceId: target.id,
            metadata: { filename: fileName, size: file.size, status: 'processing', oldTelegramFileId },
          });
          return updated;
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
          // 缓存预热完成 → 文件立即可用，无需等待 TG 上传；同时清空历史失败原因。
          // G2-06 修复：条件更新（id + status=processing + uploadVersion=当前值）并检查 affected，
          // 防止并发覆盖时 v1 收尾任务把已递增到 v2 的记录误标 ready。写法与
          // maybeWriteBackRecoveredPath / markFileInvalidOnDownload 的版本条件一致。
          const criteria: Record<string, unknown> = { id: finalFile.id, status: 'processing' };
          if (finalFile.uploadVersion) criteria.uploadVersion = finalFile.uploadVersion;
          this.fileRepository
            .update(criteria as any, { status: 'ready', uploadFailureReason: null } as any)
            .then((res) => {
              if (res.affected === 0) {
                this.logger.warn(`缓存就绪条件更新未命中（疑似并发覆盖），跳过置 ready: ${finalFile.id} (v${finalFile.uploadVersion})`);
              }
            })
            .catch(() => {});
          this.logger.log(`文件缓存就绪: ${finalFile.id}`);
        })
        .catch((err) => {
          this.logger.warn(`缓存预热失败 (${finalFile.id}): ${err.message}`);
        });
    }

    return finalFile;
  }

  /**
   * G3-06：分片上传 error 后重试 complete 时复用已创建的 File 记录。
   * 按 id + uploadVersion 取出既有 processing 记录；不存在或版本不匹配则抛错（触发重新合并新建）。
   */
  async getProcessingFileOrThrow(
    id: string,
    uploadVersion: number,
  ): Promise<{ id: string; uploadVersion: number; originalName: string }> {
    const file = await this.fileRepository.findOne({ where: { id } });
    if (!file || file.uploadVersion !== uploadVersion) {
      throw new NotFoundException('已创建的上传记录不可复用，请重新合并');
    }
    return { id: file.id, uploadVersion: file.uploadVersion, originalName: file.originalName };
  }

  /**
   * G3-07：分片上传入队后检测到中止时清理刚创建的 File 记录（非覆盖路径）。
   * 软删（isDeleted=true + status=error）保留审计痕迹，避免直接硬删导致引用残缺。
   */
  /** G3-03：判断 File 记录是否存在（含软删），供上传 pending 临时文件启动清理使用 */
  async fileRecordExists(id: string): Promise<boolean> {
    const found = await this.fileRepository.findOne({
      where: { id },
      withDeleted: true,
      select: { id: true },
    });
    return !!found;
  }

  async softDeleteProcessingFile(id: string): Promise<void> {
    await this.fileRepository.update(
      { id, status: 'processing' },
      { isDeleted: true, status: 'error', uploadStage: 'failed' } as Partial<File>,
    );
  }

  async upload(file: Express.Multer.File, user: User, tagIds?: string[]): Promise<File> {
    if (file.size > this.maxFileSize) {
      throw new BadRequestException(`文件大小不能超过 ${this.maxFileSize / 1024 / 1024}MB`);
    }

    const originalName = fixFilenameEncoding(file.originalname);

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
      const originalName = fixFilenameEncoding(file.originalname);
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
        const originalName = fixFilenameEncoding(file.originalname);
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
    // G2-11：服务层钳制 limit。非法值（非正整数）回退默认 20，
    // 超大 limit 钳制到上限 100，避免 limit=0 触发除零/空结果 500，
    // 以及超大 limit 造成内存与查询压力。
    const rawLimit = Number(limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1) {
      limit = 20;
    } else if (rawLimit > 100) {
      limit = 100;
    }
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
      qb.andWhere('LOWER(file.originalName) LIKE :keyword', { keyword: `%${escapeLike(keyword.toLowerCase())}%` });
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
      const decoded = decodeCursor(cursor);
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
      if (keyword) { tagWheres.push(`LOWER(file."originalName") LIKE $${tagIdx++}`); tagParams.push(`%${escapeLike(keyword.toLowerCase())}%`); }
      // G2-09：标签计数 SQL 与主查询共用 folderId 条件，避免筛选计数与列表不一致
      if (folderId === 'root') {
        tagWheres.push('file."folderId" IS NULL');
      } else if (folderId && folderId.length === 36) {
        tagWheres.push(`file."folderId" = $${tagIdx++}`);
        tagParams.push(folderId);
      }
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
        countQb.andWhere('LOWER(file.originalName) LIKE :keyword', { keyword: `%${escapeLike(keyword.toLowerCase())}%` });
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
      nextCursor = encodeCursor(lastFile.createdAt, lastFile.id);
    }

    return { files, total, nextCursor };
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
  async getCacheStatus(id: string, user: User): Promise<{ status: 'cached' | 'cold'; cached: boolean }> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    await this.assertFileReadable(file, user);
    const cached = this.isFileCached(id);
    return { status: cached ? 'cached' : 'cold', cached };
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

    // G2-08：恢复与清扫（sweepPendingDeletions）存在竞态 —— 清扫可能在 restore 的
    // save 前删除行，导致 save 退化为 INSERT（重新插入一条幽灵记录）。
    // 改为事务内锁定行 + 条件 UPDATE：仅在记录仍存在且仍为待删除态时更新，
    // affected=0 表示清扫已删除该行，此时抛出"已永久删除"，绝不再 INSERT。
    await this.fileRepository.manager.transaction(async (manager) => {
      const locked = await manager.getRepository(File).findOne({
        where: { id, isDeleted: true },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) {
        throw new BadRequestException('删除等待期已过，文件已永久删除');
      }
      const updated = await manager.getRepository(File)
        .createQueryBuilder()
        .update()
        .set({
          isDeleted: false,
          deletedByAdmin: false,
          deleteRequestedAt: null,
          deleteScheduledAt: null,
          deleteCooldownUntil: null,
        })
        .where('id = :id', { id })
        .andWhere('isDeleted = true')
        .execute();
      if (!updated.affected) {
        throw new BadRequestException('删除等待期已过，文件已永久删除');
      }
    });

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

    // 纵深防御：文件转私有后，软删「遗留型」公开分享链接（token = fileId 的隐式分享），
    // 防止攻击者用已知文件 ID 通过 /api/s/<fileId>/download/<fileId> 继续下载已转私有的文件。
    // 显式创建的随机 token 分享不受影响。
    let revokedLegacyShares = 0;
    if (accessType === FileAccessType.PRIVATE) {
      const revokeResult = await this.shareLinkRepository
        .createQueryBuilder()
        .update(ShareLink)
        .set({ isDeleted: true })
        .where('"targetType" = :targetType', { targetType: ShareTargetType.FILE })
        .andWhere('"targetId" = :id', { id })
        .andWhere('"token" = "targetId"')
        .andWhere('"isDeleted" = false')
        .execute();
      revokedLegacyShares = revokeResult.affected ?? 0;
    }

    // 审计日志：文件访问类型变更
    this.auditService.log({
      action: 'file_access_change',
      userId: user.id,
      resourceType: 'file',
      resourceId: id,
      metadata: { accessType, ...(revokedLegacyShares > 0 ? { revokedLegacyShares } : {}) },
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

    this.assertFileUsable(file);

    // 优先读取本地缩略图
    let localThumb = await this.thumbnailService.readLocalThumbnail(file);
    if (!localThumb && file.mimeType?.startsWith('video/')) {
      const inferredCover = `${file.id}.video.webp`;
      const inferredPath = this.thumbnailService.getInferredThumbnailPath(file.id, 'video');
      if (fs.existsSync(inferredPath)) {
        await this.fileRepository.update(
          { id: file.id },
          { thumbnailPath: inferredCover },
        );
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
      await this.thumbnailService.generateAndSaveThumbnail(file);
      const regenerated = await this.thumbnailService.readLocalThumbnail(file);
      if (regenerated) {
        return {
          stream: Readable.from(regenerated),
          contentType: 'image/webp',
        };
      }
    } else if (file.mimeType?.startsWith('video/')) {
      await this.thumbnailService.generateAndSaveVideoCover(file);
      const regenerated = await this.thumbnailService.readLocalThumbnail(file);
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
    this.assertFileUsable(file);
    const isImage = file.mimeType?.startsWith('image/');
    const isVideo = file.mimeType?.startsWith('video/');
    if (!isImage && !isVideo) throw new BadRequestException('仅图片和视频支持缩略图');

    const expectedPath = this.thumbnailService.getInferredThumbnailPath(file.id, isVideo ? 'video' : 'image');
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
    this.assertFileUsable(file);
    if (!file.mimeType?.startsWith('video/')) {
      throw new BadRequestException('仅视频支持高清封面');
    }

    let buffer = await this.thumbnailService.readHdLocalThumbnail(file);
    if (!buffer) {
      await this.thumbnailService.generateAndSaveHdVideoCover(file);
      buffer = await this.thumbnailService.readHdLocalThumbnail(file);
    }
    if (buffer) return { stream: Readable.from(buffer), contentType: 'image/webp' };

    const standard = await this.thumbnailService.readLocalThumbnail(file);
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
    this.assertFileUsable(file);
    if (!file.mimeType?.startsWith('video/')) {
      throw new BadRequestException('仅视频支持高清封面');
    }

    let buffer = await this.thumbnailService.readHdLocalThumbnail(file);
    if (!buffer) {
      await this.thumbnailService.generateAndSaveHdVideoCover(file);
      buffer = await this.thumbnailService.readHdLocalThumbnail(file);
    }
    if (buffer) return { stream: Readable.from(buffer), contentType: 'image/webp' };

    const standard = await this.thumbnailService.readLocalThumbnail(file);
    if (standard) return { stream: Readable.from(standard), contentType: 'image/webp' };
    throw new NotFoundException('视频封面尚未生成');
  }

  /**
   * 生成视频标准封面（委托 ThumbnailService，保持公开 API 不变）。
   */
  async generateAndSaveVideoCover(
    file: File,
    options: { sourcePath?: string; sourceBuffer?: Buffer; allowRemoteSource?: boolean } = {},
  ): Promise<void> {
    return this.thumbnailService.generateAndSaveVideoCover(file, options);
  }

  /**
   * 生成高清视频封面（委托 ThumbnailService，保持公开 API 不变）。
   */
  async generateAndSaveHdVideoCover(file: File): Promise<void> {
    return this.thumbnailService.generateAndSaveHdVideoCover(file);
  }

  /**
   * 生成图片缩略图（委托 ThumbnailService，保持公开 API 不变）。
   */
  async generateAndSaveThumbnail(file: File): Promise<void> {
    return this.thumbnailService.generateAndSaveThumbnail(file);
  }

  /**
   * 启动扫描补齐缺失缩略图（委托 ThumbnailService，保持公开 API 不变）。
   */
  async syncMissingThumbnails(): Promise<void> {
    return this.thumbnailService.syncMissingThumbnails();
  }

  /**
   * 删除本地缩略图文件（委托 ThumbnailService，保持公开 API 不变）。
   */
  deleteLocalThumbnail(file: File): void {
    this.thumbnailService.deleteLocalThumbnail(file);
  }


  /**
   * R5：已 error 文件在所有读取入口统一抛 410，避免各自复制错误文本与状态判定。
   * 判定点必须在提交响应头之前（各流式入口在组装响应前调用）。
   */
  private assertFileUsable(file: File): void {
    if (file.status === 'error') {
      throw new GoneException('文件已不可用');
    }
  }

  /**
   * R4：恢复成功且路径确实变化时，用并发守卫条件更新 telegramFilePath。
   * - 仅在 info.file_path 非空且与当前值不同时触发数据库写入（普通读取不写库）；
   * - 条件更新 WHERE id=? AND status='ready' AND uploadVersion=?，防止覆盖并发上传结果；
   * - 回写失败仅记日志，绝不阻断主流程。
   */
  private async maybeWriteBackRecoveredPath(file: File, info?: { file_path?: string }): Promise<void> {
    if (!info || !info.file_path) return;
    if (file.telegramFilePath === info.file_path) return;
    try {
      const criteria: Record<string, unknown> = { id: file.id, status: 'ready' };
      if (file.uploadVersion) criteria.uploadVersion = file.uploadVersion;
      await this.fileRepository.update(
        criteria as any,
        { telegramFilePath: info.file_path } as Partial<File>,
      );
      this.logger.log(`Telegram 路径恢复成功并回写: ${file.id}`);
    } catch (error) {
      this.logger.warn(
        `回写恢复路径失败 ${file.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    this.assertFileUsable(file);
    if (file.status === 'processing' && !this.fileCacheService.getCachedPath(file.id)) {
      throw new BadRequestException('文件正在处理中，请稍后刷新重试');
    }
    // 请求级强制无缓存优先，其次跟随全局配置
    const noCache = opts?.noCache ?? this.fileCacheService.isNoCacheMode();
    try {
      // 捕获回源后的最新 info（仅当实际触发回源/恢复时才有值；缓存命中或 spool 重放时不回写）
      let recoveredInfo: { file_path: string } | undefined;
      // 请求级强制无缓存（管理员 ?nocache=1）时仍携带 X-Telegram-No-Cache 头；
      // 否则动态跟随全局配置（默认构建缓存路径不带头，容量准备期间翻转进入无缓存早退分支则带头）。
      const forceNoCache = noCache && !this.fileCacheService.isNoCacheMode();
      const fetch = async () => {
        const result = await this.telegramService.getRealtimeFileStream(
          file.telegramFileId || file.filename,
          expectedSize,
          { noCache: this.fileCacheService.isNoCacheMode() || forceNoCache },
        );
        recoveredInfo = result.info;
        return result;
      };

      if (noCache) {
        const result = await this.fileCacheService.getNoCacheStream(file.id, expectedSize, fetch);
        this.attachDownloadInvalidHandler(file, result.stream);
        await this.maybeWriteBackRecoveredPath(file, recoveredInfo);
        return { stream: result.stream, actualSize: expectedSize };
      }
      const result = await this.fileCacheService.getOrCacheStream(file.id, expectedSize, fetch);
      this.attachDownloadInvalidHandler(file, result.stream);
      await this.maybeWriteBackRecoveredPath(file, recoveredInfo);
      return { stream: result.stream, actualSize: expectedSize };
    } catch (error) {
      // 仅将明确的 Telegram 永久资源不存在错误降级为 error；
      // 网络超时/429/5xx 等暂时性错误保持原状态（不误标数据损坏）。
      if (error instanceof TelegramFileNotFoundError) {
        await this.markFileInvalidOnDownload(file);
      }
      throw error;
    }
  }

  /**
   * 下载链路确认 Telegram file_id 永久失效时，条件标记文件为 error 并失效缓存。
   * 约束：
   * - 仅处理 TelegramFileNotFoundError（invalid file_id / file not found）；
   * - 条件更新 WHERE id=? AND status='ready'，避免覆盖并发上传；
   * - 5 分钟内同一文件只处理一次，防止并发下载造成审计/日志风暴；
   * - 状态更新失败不覆盖原始下载错误（本方法内部捕获）。
   */
  private async markFileInvalidOnDownload(file: File): Promise<void> {
    const now = Date.now();
    // 惰性清理过期 key，防止 Map 无限增长
    if (this.invalidMarkedAt.size > 1000) {
      for (const [id, ts] of this.invalidMarkedAt) {
        if (now - ts > 5 * 60 * 1000) this.invalidMarkedAt.delete(id);
      }
    }
    const last = this.invalidMarkedAt.get(file.id) ?? 0;
    if (now - last < 5 * 60 * 1000) return;
    this.invalidMarkedAt.set(file.id, now);
    try {
      // 条件更新带 uploadVersion：覆盖上传会使 uploadVersion 递增，
      // 若期间文件已被重新上传（新的 file_id），旧失败不得误标新文件。
      const criteria: Record<string, unknown> = { id: file.id, status: 'ready' };
      if (file.uploadVersion) criteria.uploadVersion = file.uploadVersion;
      await this.fileRepository.update(
        criteria as any,
        {
          status: 'error',
          uploadStage: 'failed',
          uploadFailureReason: 'Telegram 文件不存在或已失效，下载已失败',
        } as Partial<File>,
      );
      await this.fileCacheService.invalidate(file.id);
      this.auditService.log({
        action: 'file_verify',
        userId: file.uploaderId,
        resourceType: 'file',
        resourceId: file.id,
        metadata: { reason: 'download_telegram_file_not_found' },
      });
      this.logger.warn(`下载命中 Telegram 永久失效 file_id，已标记 error: ${file.id}`);
    } catch (error) {
      this.logger.warn(
        `标记文件 ${file.id} 为 error 失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 为 spool/follower 流挂载错误监听：Telegram 永久失效错误在上游构建失败时
   * 以 stream error 事件形式到达，此处捕获并触发降级（不吞掉错误，其他监听器仍可处理）。
   */
  private attachDownloadInvalidHandler(file: File, stream: Readable): void {
    stream.on('error', (error: Error) => {
      if (error instanceof TelegramFileNotFoundError) {
        void this.markFileInvalidOnDownload(file);
      }
    });
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
    const filename = ensureFileExtension(file.originalName, mimeType);

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
    opts?: { noCache?: boolean; ip?: string },
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
    // 请求级无缓存：Range 依赖本地缓存文件，无缓存时回退完整下载
    if (opts?.noCache) return null;

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

    this.assertFileUsable(file);
    // 文件仍在处理中（TG 未同步）→ 拒绝范围下载，避免用临时 UUID 回源
    if (file.status === 'processing') {
      throw new BadRequestException('文件正在处理中，请稍后刷新重试');
    }

    const total = Number(file.size);
    // 严格单 Range 解析：closed/open-ended/suffix；非法/越界统一 416，
    // 不再静默回退 200，避免垃圾 Range 与错误 Content-Length 组合的解析问题。
    const parsed = parseByteRange(rangeHeader, total);
    if (!parsed.ok) {
      throw new RangeNotSatisfiableException(total);
    }
    const start = parsed.range.start;
    const actualEnd = parsed.range.end;

    // 读取指定范围的文件片段
    const chunkSize = actualEnd - start + 1;
    const readStream = createReadStream(cachedPath, { start, end: actualEnd });

    // G2-15：Range 配额扣次幂等去重 —— 30s 内同文件同（用户+IP）只扣一次，
    // 避免一次视频播放的多个 Range 请求耗尽 maxAccessCount。
    const dedupKey = `${id}|${user.id}|${opts?.ip || ''}`;
    const now = Date.now();
    const lastDedup = this.rangeQuotaDedup.get(dedupKey);
    const shouldConsume = !lastDedup || now - lastDedup >= FileService.RANGE_QUOTA_DEDUP_MS;
    if (shouldConsume) {
      // 原子访问计数：与完整下载路径一致，强制 maxAccessCount 上限并校验 affected，
      // 防止受限文件被无限次范围下载绕过。
      const updateResult = await this.fileRepository
        .createQueryBuilder()
        .update(File)
        .set({ currentAccessCount: () => '"currentAccessCount" + 1' })
        .where('id = :id', { id })
        .andWhere('("maxAccessCount" <= 0 OR "currentAccessCount" < "maxAccessCount")')
        .andWhere('"isDeleted" = false')
        .execute();

      if (updateResult.affected === 0) {
        readStream.destroy();
        throw new ForbiddenException('访问次数已用尽或文件不存在');
      }
      // 记录本次扣次时间；Map 有界，超出容量即整体清空（低频操作，可接受）
      if (this.rangeQuotaDedup.size > 10_000) this.rangeQuotaDedup.clear();
      this.rangeQuotaDedup.set(dedupKey, now);
    }

    // G2-14：Range 下载也记录访问日志（action='download_range'），与全量路径审计一致。
    let accessLogId: string | undefined;
    try {
      const saved = await this.accessLogRepository.save({
        fileId: id,
        ip: opts?.ip || '',
        action: 'download_range',
        uploaderId: file.uploaderId,
        responseSize: 0,
      });
      accessLogId = saved.id;
    } catch {
      // 日志记录失败不影响主流程
    }

    const mimeType = file.mimeType || 'application/octet-stream';
    const filename = ensureFileExtension(file.originalName, mimeType);

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
    const filename = ensureFileExtension(file.originalName, mimeType);

    return { stream, contentType: mimeType, filename, size: actualSize, isInline, accessLogId };
  }

  /**
   * 兼容老 URL /files/public/:id 的「懒创建 + 重定向」：
   * - 查找文件，校验存在且公开
   * - 查找 ShareLink（token = file.id），不存在则自动创建（复制遗留约束字段）
   * - 返回 { file, shareLink }，由 controller 完成 302 重定向
   *
   * 将原本散落在 controller 的 Repository 直接访问下沉到 Service，
   * 满足「Controller 只做输入校验与响应装配」的架构治理要求。
   */
  async ensureLegacyPublicShare(id: string): Promise<{ file: File; shareLink: ShareLink | null }> {
    // 1. 查找文件，校验存在且未删除（select 包含遗留约束字段，用于懒创建 ShareLink）
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
      select: ['id', 'accessType', 'uploaderId', 'originalName', 'password', 'maxAccessCount', 'expiresIn', 'expiresStartAt'],
    });
    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    // 2. 私有文件不允许公开访问
    if (file.accessType !== FileAccessType.PUBLIC) {
      throw new ForbiddenException('此文件为私有文件，不提供公开访问');
    }

    // 3. 懒创建 ShareLink（如果不存在）——复制文件的遗留约束字段
    let shareLink = await this.shareLinkRepository.findOne({
      where: { token: id, isDeleted: false },
    });
    if (!shareLink) {
      shareLink = this.shareLinkRepository.create({
        token: id, // 用文件 id 作为 token，确保老链接兼容
        targetType: ShareTargetType.FILE,
        targetId: id,
        creatorId: file.uploaderId,
        // 复制文件的遗留约束（Phase 2 之前通过 /files/:id/password 等端点设置的）
        password: file.password ?? null,
        maxAccessCount: file.maxAccessCount ?? -1,
        expiresIn: file.expiresIn ?? null,
        expiresStartAt: file.expiresStartAt ?? null,
        status: ShareLinkStatus.ACTIVE,
      });
      try {
        await this.shareLinkRepository.save(shareLink);
      } catch {
        // 并发创建时可能触发唯一约束冲突，忽略——另一个请求已创建
        shareLink = await this.shareLinkRepository.findOne({
          where: { token: id, isDeleted: false },
        });
      }
    }

    // 重校：并发创建/即时取消等边界下 shareLink 仍可能为空，避免带着空链接重定向
    if (!shareLink) {
      throw new NotFoundException('分享不存在或已被取消');
    }

    return { file, shareLink };
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
      filename: ensureFileExtension(file.originalName, file.mimeType),
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
    const file = await this.getPublicMediaFile(id);
    const total = Number(file.size);
    const parsed = parseByteRange(rangeHeader, total);
    // 非法/越界统一 416（含正确 Content-Range）；语法性错误同样按不可满足处理，
    // 避免把垃圾 Range 悄悄回退为 200 造成客户端按完整长度解析出错。
    if (!parsed.ok) {
      throw new RangeNotSatisfiableException(total);
    }
    const { start, end } = parsed.range;

    const cachedPath = this.fileCacheService.getCachedPath(file.id);
    if (!cachedPath) return null;

    return {
      stream: createReadStream(cachedPath, { start, end }),
      contentType: file.mimeType,
      filename: ensureFileExtension(file.originalName, file.mimeType),
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
    // C-01 修复：公开 /media 直链只允许白名单内的安全位图与受支持音视频。
    // SVG、XML、HTML、脚本型内容及任何 MIME/魔数不一致的类型一律拒绝 inline，
    // 杜绝同源持久型 XSS 面。此阻断不可通过功能开关关闭。
    if (!isSafePublicInlineContentType(file.mimeType || '')) {
      throw new BadRequestException('该类型不支持媒体直链');
    }
    // G5-12：访问次数限制语义统一为 maxAccessCount > 0 表示「有限制」。
    // 该语义与 checkAndIncrement / isUnrestrictedPublic 全链路一致：
    // 0 与负数均视为「无次数限制」，此处 0 不被当作无限次保护（保持既有数据语义，
    // 避免破坏存量 maxAccessCount=0 的文件被媒体直链拒绝的回归）。> 0 的文件拒绝直链。
    if (file.password || file.maxAccessCount > 0) {
      throw new ForbiddenException('受密码或访问次数保护的文件不能使用媒体直链');
    }
    // G5-12：清理冗余的过期判断死代码。
    // 原实现中一旦 expiresIn 非空，无论是否已过期最终都会抛异常（要么「已过期」，
    // 要么「限时不能直链」），即所有限时文件一律禁止永久媒体直链。
    // 简化为单一拒绝分支，行为不变、逻辑更清晰。
    if (file.expiresIn !== null && file.expiresIn !== undefined) {
      throw new ForbiddenException('限时文件不能使用永久媒体直链');
    }
    this.assertFileUsable(file);
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
   * 批量生成 Markdown：无约束公开文件用永久公开 URL，含约束文件用分享链接。
   *
   * G2-12 修复：
   * - originalName 中的 Markdown 特殊字符（[]()\ 等）会被转义，防止文件名注入链接结构；
   * - 仅对无约束公开文件生成 /media/ 直链；含密码/次数/时效约束的文件改用分享链接 /s/:id，
   *   避免生成不可访问或绕过约束的裸文件链接。
   */
  async batchToMarkdown(ids: string[], user: User): Promise<string[]> {
    const files = await this.fileRepository.find({
      where: { id: In(ids), isDeleted: false, uploaderId: user.id },
    });

    const results: string[] = [];
    const baseUrl = this.configService.get<string>('APP_URL') || 'http://localhost:3000';

    for (const file of files) {
      if (!file.mimeType.startsWith('image/')) continue;
      const safeName = escapeMarkdownAlt(file.originalName);
      if (await this.isUnrestrictedPublic(file.id)) {
        const appUrl = `${baseUrl}/media/${file.id}`;
        results.push(`![${safeName}](${appUrl})`);
      } else {
        // 含约束文件生成分享链接（/s/:id 由 ShareLink 懒创建支撑），不放裸文件直链
        const shareUrl = `${baseUrl}/s/${file.id}`;
        results.push(`[${safeName}](${shareUrl})`);
      }
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

    const originalName = fixFilenameEncoding(file.originalname);

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
          const originalName = fixFilenameEncoding(file.originalname);
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
   * 特性（G2-13 后不再有 getPublicFileContentStream 遗留死代码）：
   * 1. 不检查 accessType —— ShareLink 本身就是访问凭证，private 文件也能通过分享链接下载。
   * 2. 访问日志记录 action='share_download'，便于按渠道统计。
   *
   * 由 ShareService 在校验完 token + access JWT 后调用。
   */
  async getStreamForShareDownload(id: string, ip?: string, shareToken?: string): Promise<{
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

    // 纵深防御：遗留型分享（token = fileId）实质依赖文件自身的公开状态。
    // 若文件已转私有，即使遗留分享链接未被软删（如并发窗口），也必须拒绝下载，
    // 防止攻击者用已知文件 ID 访问 /api/s/<fileId>/download/<fileId> 下载已转私有的文件。
    if (shareToken && shareToken === id && file.accessType !== FileAccessType.PUBLIC) {
      throw new ForbiddenException('此文件已转为私有，公开分享已失效');
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
    const filename = ensureFileExtension(file.originalName, mimeType);

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
    const filename = ensureFileExtension(file.originalName, mimeType);

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
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });
    if (!file) throw new NotFoundException('文件不存在');

    await this.assertFileReadable(file, user);

    this.assertFileUsable(file);
    // 文件仍在处理中（TG 未同步）→ 拒绝范围预览，避免用临时 UUID 回源

    if (file.status === 'processing') {
      throw new BadRequestException('文件正在处理中，请稍后刷新重试');
    }

    const total = Number(file.size);
    // 严格单 Range 解析：支持 closed/open-ended/suffix；非法/越界统一 416
    const parsed = parseByteRange(rangeHeader, total);
    if (!parsed.ok) {
      throw new RangeNotSatisfiableException(total);
    }
    const start = parsed.range.start;
    const actualEnd = parsed.range.end;
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
    const filename = ensureFileExtension(file.originalName, mimeType);

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
    const file = await this.fileRepository.findOne({ where: { id: fileId, isDeleted: false } });
    if (!file) throw new NotFoundException('文件不存在');

    this.assertFileUsable(file);

    const total = Number(file.size);
    // 严格单 Range 解析：支持 closed/open-ended/suffix；非法/越界统一 416
    const parsed = parseByteRange(rangeHeader, total);
    if (!parsed.ok) {
      throw new RangeNotSatisfiableException(total);
    }
    const start = parsed.range.start;
    const end = parsed.range.end;

    const cachedPath = this.fileCacheService.getCachedPath(file.id);
    if (!cachedPath) return null;

    const mimeType = file.mimeType || 'application/octet-stream';
    return {
      stream: createReadStream(cachedPath, { start, end }),
      contentType: mimeType,
      filename: ensureFileExtension(file.originalName, mimeType),
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

/**
 * 转义 Markdown 图片/链接 alt 文本中的特殊字符（G2-12）。
 * 文件名中若包含 `[` `]` `(` `)` `\` 等字符，会破坏或注入 Markdown 链接结构，
 * 故统一反斜杠转义。其余 Unicode 字符（含中文、空格）原样保留。
 */
function escapeMarkdownAlt(name: string): string {
  if (!name) return name;
  return name.replace(/[\\[\]()]/g, (ch) => `\\${ch}`);
}
