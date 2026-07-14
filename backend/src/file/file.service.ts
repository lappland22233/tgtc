import { Injectable, NotFoundException, ForbiddenException, BadRequestException, OnModuleInit, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, EntityManager } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Readable } from 'stream';
import { Request } from 'express';
import * as fs from 'fs';
import { createReadStream, writeFileSync } from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { QUEUE_NAMES } from '../jobs/bull-queue.module';
import { File, FileAccessType } from '../common/entities/file.entity';
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

export interface BatchUploadFailedItem {
  name: string;
  reason: string;
}

export interface BatchUploadResult {
  success: File[];
  failed: BatchUploadFailedItem[];
}

/** MIME 类型与扩展名映射，用于验证上传文件的 MIME 类型与扩展名是否一致 */
const MIME_EXTENSION_MAP: Record<string, string[]> = {
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png': ['image/png'],
  '.gif': ['image/gif'],
  '.webp': ['image/webp'],
  '.svg': ['image/svg+xml'],
  '.bmp': ['image/bmp'],
  '.ico': ['image/x-icon', 'image/vnd.microsoft.icon'],
  '.pdf': ['application/pdf'],
  '.txt': ['text/plain'],
  '.md': ['text/markdown', 'text/plain'],
  '.csv': ['text/csv'],
  '.json': ['application/json'],
  '.xml': ['application/xml', 'text/xml'],
  '.html': ['text/html'],
  '.css': ['text/css'],
  '.js': ['text/javascript', 'application/javascript'],
  '.ts': ['text/typescript', 'application/typescript'],
  '.zip': ['application/zip', 'application/x-zip-compressed'],
  '.rar': ['application/vnd.rar', 'application/x-rar-compressed'],
  '.7z': ['application/x-7z-compressed'],
  '.tar': ['application/x-tar'],
  '.gz': ['application/gzip', 'application/x-gzip'],
  '.doc': ['application/msword'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.xls': ['application/vnd.ms-excel'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.ppt': ['application/vnd.ms-powerpoint'],
  '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  '.mp3': ['audio/mpeg', 'audio/mp3'],
  '.mp4': ['video/mp4'],
  '.avi': ['video/x-msvideo'],
  '.mov': ['video/quicktime'],
  '.webm': ['video/webm'],
  '.m4a': ['audio/mp4', 'audio/x-m4a'],
  '.ogg': ['audio/ogg', 'video/ogg'],
  '.wav': ['audio/wav', 'audio/x-wav'],
  '.flac': ['audio/flac'],
};

/** 已知复合扩展名列表（优先匹配，防止 .tar.gz 被错误识别为 .gz） */
const COMPOUND_EXTENSIONS = ['.tar.gz', '.tar.bz2', '.tar.xz'] as const;

@Injectable()
export class FileService implements OnModuleInit {
  private readonly logger = new Logger(FileService.name);
  private maxFileSize: number;
  private fileTypeMode: 'blacklist' | 'whitelist' = 'blacklist';
  private fileTypeFilter: string[] = [];
  private readonly thumbnailDir: string;

  constructor(
    @InjectRepository(File)
    private fileRepository: Repository<File>,
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
    if (payload.key === 'MAX_FILE_SIZE' || payload.key === 'FILE_TYPE_MODE' || payload.key === 'FILE_TYPE_FILTER') {
      await this.reloadUploadConfig();
    }
  }

  private async reloadUploadConfig() {
    const [maxFileSize, fileTypeMode, fileTypeFilter] = await Promise.all([
      this.configCacheService.get('MAX_FILE_SIZE', '20971520'),
      this.configCacheService.get('FILE_TYPE_MODE', 'blacklist'),
      this.configCacheService.get('FILE_TYPE_FILTER', ''),
    ]);
    this.maxFileSize = this.parseFileSize(maxFileSize);
    this.fileTypeMode = (fileTypeMode === 'whitelist' ? 'whitelist' : 'blacklist');
    this.fileTypeFilter = fileTypeFilter
      ? fileTypeFilter.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      : [];
  }

  private parseFileSize(val: string | undefined): number {
    const parsed = Number(val);
    return Number.isFinite(parsed) ? parsed : 20971520;
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
   * @deprecated 保留供未来使用，当前文件类型检查使用内联逻辑。
   *            如需重新启用，恢复此方法并更新 isFileTypeAllowed。
   *
   * 从文件名提取扩展名（小写，含点号）
   * 只取最后一个点之后的部分，防止 .php.jpg 等复合扩展名绕过检查
   */
  // private _extractExtension(filename: string): string {
  //   const name = filename.toLowerCase();
  //   const lastDot = name.lastIndexOf('.');
  //   return lastDot > 0 ? '.' + name.slice(lastDot + 1) : '';
  // }

  /**
   * 检查文件类型是否被允许
   * - 黑名单 + 空过滤 = 允许所有
   * - 黑名单 + 有过滤 = 拒绝匹配的
   * - 白名单 + 空过滤 = 拒绝所有
   * - 白名单 + 有过滤 = 允许匹配的
   * 同时验证 MIME 类型与扩展名的一致性
   */
  private isFileTypeAllowed(filename: string, mimeType?: string): { allowed: boolean; reason?: string } {
    if (this.fileTypeMode === 'blacklist' && this.fileTypeFilter.length === 0) {
      return { allowed: true };
    }

    const lowerName = filename.toLowerCase();

    // 优先检查复合扩展名，防止 .tar.gz 被 lastIndexOf 错误识别为 .gz
    let ext = '(无扩展名)';
    let matchedCompound: string | null = null;
    for (const ce of COMPOUND_EXTENSIONS) {
      if (lowerName.endsWith(ce)) {
        ext = ce;
        matchedCompound = ce;
        break;
      }
    }

    // 无复合扩展名匹配 → 使用 lastIndexOf 取最后一个点之后的部分
    if (!matchedCompound) {
      const lastDot = lowerName.lastIndexOf('.');
      ext = lastDot > 0 ? '.' + lowerName.slice(lastDot + 1) : '(无扩展名)';
    }

    if (this.fileTypeMode === 'whitelist' && this.fileTypeFilter.length === 0) {
      return { allowed: false, reason: `文件类型 ${ext} 被拒绝：白名单模式未配置允许类型` };
    }

    // 使用已提取的 ext 做精确扩展名比较，避免 endsWith 对完整文件名的模糊匹配
    const matched = this.fileTypeFilter.includes(ext);

    let allowed: boolean;
    let reason: string | undefined;
    if (this.fileTypeMode === 'blacklist') {
      allowed = !matched;
      if (!allowed) {
        reason = `文件类型 ${ext} 被拒绝：该类型在禁止列表中`;
      }
    } else {
      allowed = matched;
      if (!allowed) {
        reason = `文件类型 ${ext} 被拒绝：该类型不在允许列表中`;
      }
    }

    // 额外检查：如果提供了 MIME 类型，验证其与扩展名的一致性
    // 复合扩展名跳过 MIME 一致性校验（.tar.gz 的 MIME 是 application/gzip）
    if (allowed && mimeType && !matchedCompound) {
      const lastDot = lowerName.lastIndexOf('.');
      if (lastDot > 0) {
        const expectedTypes = MIME_EXTENSION_MAP[ext];
        if (expectedTypes && !expectedTypes.includes(mimeType)) {
          return {
            allowed: false,
            reason: `文件扩展名 ${ext} 与 MIME 类型 ${mimeType} 不匹配`,
          };
        }
      }
    }

    return { allowed, reason };
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
   * 创建处理中的文件记录（磁盘文件→DB record=processing）
   * Telegram 上传由 FileUploadProcessor 后台异步执行
   */
  async createProcessingFile(
    file: Express.Multer.File,
    originalName: string,
    user: User,
    tagIds?: string[],
  ): Promise<File> {
    if (file.size > this.maxFileSize) {
      throw new BadRequestException(`文件大小不能超过 ${this.maxFileSize / 1024 / 1024}MB`);
    }

    const fileName = this.fixFilenameEncoding(originalName);

    const typeCheck = this.isFileTypeAllowed(fileName, file.mimetype);
    if (!typeCheck.allowed) {
      throw new BadRequestException(typeCheck.reason || '不允许上传此类型的文件');
    }

    const tempId = uuidv4();
    const newFile = this.fileRepository.create({
      filename: tempId,
      originalName: fileName,
      mimeType: file.mimetype || 'application/octet-stream',
      size: file.size,
      telegramFileId: tempId,
      telegramFilePath: '',
      uploaderId: user.id,
      accessType: FileAccessType.PUBLIC,
      maxAccessCount: -1,
      status: 'processing',
    });
    const savedFile = await this.fileRepository.save(newFile);

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

    // 预热缓存：将文件直接放入缓存目录，首次下载无需等待 TG 回源
    if (file.path && fs.existsSync(file.path)) {
      this.fileCacheService.cacheFileFromPath(savedFile.id, file.path, file.size)
        .then(() => {
          // 缓存预热完成 → 文件立即可用，无需等待 TG 上传
          this.fileRepository.update(savedFile.id, { status: 'ready' } as any).catch(() => {});
          this.logger.log(`文件缓存就绪: ${savedFile.id}`);
        })
        .catch((err) => {
          this.logger.warn(`缓存预热失败 (${savedFile.id}): ${err.message}`);
        });
    }

    return savedFile;
  }

  async upload(file: Express.Multer.File, user: User, tagIds?: string[]): Promise<File> {
    if (file.size > this.maxFileSize) {
      throw new BadRequestException(`文件大小不能超过 ${this.maxFileSize / 1024 / 1024}MB`);
    }

    const originalName = this.fixFilenameEncoding(file.originalname);

    const typeCheck = this.isFileTypeAllowed(originalName, file.mimetype);

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
      maxAccessCount: -1,
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

    if (file.mimetype.startsWith('image/')) {
      this.generateAndSaveThumbnail(savedFile).catch(err =>
        this.logger.warn(`上传后缩略图生成失败 id=${savedFile.id}: ${(err as Error).message}`),
      );
    }

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
      const typeCheck = this.isFileTypeAllowed(originalName, file.mimetype);
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
        const savedFile = await this.createProcessingFile(file, originalName, user, tagIds);
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
          { fileId: savedFile.id, filePath: pendingPath },
          { attempts: 3, backoff: { type: 'exponential', delay: 10000 }, removeOnComplete: 100, removeOnFail: 50 },
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
  ): Promise<{ files: File[]; total: number; nextCursor?: string | null }> {
    const where: Record<string, unknown> = {};
    if (!includeDeleted) {
      where.isDeleted = false;
    }
    if (userId) {
      where.uploaderId = userId;
    }

    const qb = this.fileRepository.createQueryBuilder('file')
      .leftJoinAndSelect('file.uploader', 'uploader')
      .where(where);

    if (keyword) {
      qb.andWhere('LOWER(file.originalName) LIKE :keyword', { keyword: `%${keyword.toLowerCase()}%` });
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
      'uploader',
    ])
      .addSelect('CASE WHEN file.password IS NOT NULL THEN true ELSE false END', 'file_hasPassword');

    // 游标模式：固定按 createdAt DESC, id DESC 排序，只用 take
    // 传统模式：动态排序 + skip/take
    if (cursor) {
      qb.orderBy('file.createdAt', 'DESC').addOrderBy('file.id', 'DESC').take(limit);
    } else {
      const allowedSortFields = ['originalName', 'createdAt', 'size', 'uploader.email'];
      const safeSortBy = allowedSortFields.includes(sortBy || '') ? `file.${sortBy}` : 'file.createdAt';
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
      if (keyword) { tagWheres.push(`LOWER(file."originalName") LIKE $${tagIdx++}`); tagParams.push(`%${keyword.toLowerCase()}%`); }
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
        countQb.andWhere('LOWER(file.originalName) LIKE :keyword', { keyword: `%${keyword.toLowerCase()}%` });
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

  /** 解码游标 */
  private decodeCursor(cursor: string): { createdAt: string; id: string } {
    return JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
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
   * 管理员强制永久删除文件（双重确认第二步）
   * 直接从 Telegram 和数据库中永久移除，不等待 7 天冷静期
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

    // 从 Telegram 删除（忽略错误，避免阻塞）
    if (file.telegramFileId) {
      try {
        await this.telegramService.deleteFile(file.telegramFileId);
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : '未知错误';
        this.logger.warn(`强制删除文件时 Telegram 删除失败: ${file.originalName}, 错误: ${errMsg}`);
      }
    }

    // 先清理关联的访问日志（外键约束）
    await this.accessLogRepository.delete({ fileId: id });

    // 清理本地缩略图
    this.deleteLocalThumbnail(file);

    // 清理本地文件缓存
    this.fileCacheService.invalidate(file.id);

    // 硬删除文件记录
    await this.fileRepository.remove(file);

    // 审计日志：管理员强制删除
    this.auditService.log({
      action: 'file_delete_by_admin',
      userId: user.id,
      resourceType: 'file',
      resourceId: id,
      metadata: { filename: file.originalName, forced: true },
    });
  }

  /**
   * 永久删除到期文件（定时任务调用，每小时执行一次）
   * 处理两种情况：
   * 1. 用户延迟删除：deleteScheduledAt 已到期
   * 2. 管理员即时删除：isDeleted=true 超过 7 天（留足恢复窗口）
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sweepPendingDeletions(): Promise<number> {
    const now = new Date();
    const adminRecoverWindow = new Date(now.getTime() - FILE_DELETE_GRACE_MS);

    // 查询所有待删除文件
    const deletedFiles = await this.fileRepository.find({
      where: { isDeleted: true },
    });

    // 筛选需要永久删除的文件
    const expiredFiles = deletedFiles.filter(
      (f) =>
        // 用户延迟删除到期
        (f.deleteScheduledAt && now >= f.deleteScheduledAt) ||
        // 管理员即时删除超过 7 天
        (!f.deleteScheduledAt && f.updatedAt < adminRecoverWindow),
    );

    if (expiredFiles.length === 0) {
      return 0;
    }

    let deletedCount = 0;
    for (const file of expiredFiles) {
      try {
        await this.telegramService.deleteFile(file.telegramFileId);
        this.deleteLocalThumbnail(file);
        await this.accessLogRepository.delete({ fileId: file.id });
        await this.fileRepository.remove(file);
        deletedCount++;
        this.logger.log(`已永久删除文件: ${file.originalName} (${file.id})`);
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : '未知错误';
        this.logger.warn(`永久删除文件失败: ${file.originalName} (${file.id}), 错误: ${errMsg}`);
        // 即使 Telegram 删除失败，也从数据库移除（避免数据库积压）
        try {
          this.deleteLocalThumbnail(file);
          await this.accessLogRepository.delete({ fileId: file.id });
          await this.fileRepository.remove(file);
        } catch (e: unknown) {
          this.logger.error(`强制清理文件失败: ${file.id}`, e instanceof Error ? e.message : String(e));
        }
        deletedCount++;
      }
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
    const pwdResult = await this.rateLimitService.checkAndIncrement(
      pwdLimitKey, 'password_error',
      pwdErrorLimit, 0, this.PWD_WINDOW,
    );

    // 未达到阈值，仅记录
    if (pwdResult.allowed) {
      return;
    }

    // 达到 5 次错误，触发封禁
    // banCount 也使用 RateLimitService 持久化
    await this.rateLimitService.checkAndIncrement(
      banLimitKey, 'ban_count',
      this.BAN_COUNT_LIMIT, 0, this.BAN_WINDOW,
    );

    // 获取当前错误计数和封禁计数（RateLimitService 已原子化）
    const now = Date.now();
    const currentBanCount = await this.rateLimitService.getAttemptCount(banLimitKey);

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
    const localThumb = this.readLocalThumbnail(file);
    if (localThumb) {
      return {
        stream: Readable.from(localThumb),
        contentType: 'image/webp',
      };
    }

    // 回退到 Telegram（同时触发异步生成缩略图）
    this.generateAndSaveThumbnail(file).catch(() => {});
    const { stream } = await this.telegramService.getFileStream(file.telegramFileId || file.filename);

    return {
      stream,
      contentType: file.mimeType || 'application/octet-stream',
    };
  }

  /**
   * 批量获取缩略图 base64（合并为一次 API 调用，消除浏览器连接池瓶颈）
   * 返回 { [fileId]: 'data:image/...;base64,...' }
   */
  /**
   * 从 Telegram 下载原图，用 sharp 生成十分之一分辨率缩略图，存到本地。
   * 成功后将缩略图路径写入 File 实体。
   */
  async generateAndSaveThumbnail(file: File): Promise<void> {
    if (!file.mimeType?.startsWith('image/')) return;
    if (file.thumbnailPath) {
      const fullPath = path.join(this.thumbnailDir, file.thumbnailPath);
      if (fs.existsSync(fullPath)) return; // 已存在
    }

    try {
      const { stream } = await this.telegramService.getFileStream(file.telegramFileId || file.filename);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);

      // 获取原图尺寸
      const metadata = await sharp(buffer).metadata();
      const width = metadata.width || 0;
      const height = metadata.height || 0;

      // 小于 300×300 的图片不需要缩略图
      if (width < 300 && height < 300) return;

      const thumbWidth = Math.max(16, Math.round(width / 10));
      const thumbHeight = Math.max(16, Math.round(height / 10));

      // 生成 webp 缩略图（比 jpg/png 小得多）
      const thumbBuffer = await sharp(buffer)
        .resize(thumbWidth, thumbHeight, { fit: 'inside' })
        .webp({ quality: 60 })
        .toBuffer();

      const thumbFilename = `${file.id}.webp`;
      fs.writeFileSync(path.join(this.thumbnailDir, thumbFilename), thumbBuffer);

      file.thumbnailPath = thumbFilename;
      await this.fileRepository.save(file);
    } catch (err) {
      this.logger.warn(`缩略图生成失败 id=${file.id}: ${(err as Error).message}`);
    }
  }

  /**
   * 启动时扫描数据库，为所有缺少缩略图的图片创建缩略图。
   * 使用 LIMIT 分页读取，避免一次性加载所有图片到内存。
   */
  async syncMissingThumbnails(): Promise<void> {
    const batchSize = 50;
    let offset = 0;
    let totalProcessed = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const files = await this.fileRepository.find({
        where: { isDeleted: false },
        select: ['id', 'mimeType', 'telegramFileId', 'filename', 'thumbnailPath'],
        skip: offset,
        take: batchSize,
      });

      if (files.length === 0) break;

      const images = files.filter(f => f.mimeType?.startsWith('image/') && !f.thumbnailPath);
      if (images.length > 0) {
        this.logger.log(`同步缩略图: 处理 ${offset + 1}-${offset + files.length}，找到 ${images.length} 个缺失`);
        for (const file of images) {
          await this.generateAndSaveThumbnail(file);
          totalProcessed++;
        }
      }

      offset += batchSize;
    }

    if (totalProcessed > 0) {
      this.logger.log(`缩略图同步完成: 创建了 ${totalProcessed} 个缩略图`);
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
   * 读取本地缩略图文件内容。
   */
  private readLocalThumbnail(file: File): Buffer | null {
    if (!file.thumbnailPath) return null;
    const fullPath = path.join(this.thumbnailDir, file.thumbnailPath);
    try {
      if (fs.existsSync(fullPath)) return fs.readFileSync(fullPath);
    } catch {
      // ignore
    }
    return null;
  }


  /**
   * 流式下载文件内容（后端代理，不暴露 Telegram URL）
   * 用于避免大文件全部加载到内存
   */
  async getFileContentStream(id: string, user: User, ip?: string): Promise<{
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

    // 尝试从本地缓存获取（二次访问加速，减少 Telegram API 调用）
    const cachedStream = this.fileCacheService.getCachedReadStream(file.id, Number(file.size));

    // 缓存未命中且文件仍在处理中（TG 未同步）→ 拒绝下载，避免用临时 UUID 回源
    if (!cachedStream && file.status === 'processing') {
      throw new BadRequestException('文件正在处理中，请稍后刷新重试');
    }

    const { stream } = cachedStream
      ? { stream: cachedStream }
      : { stream: (await this.telegramService.getFileStream(file.telegramFileId || file.filename)).stream };

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

    // 仅对本地缓存的文件支持 Range
    const cachedPath = this.fileCacheService.getCachedPath(file.id);
    if (!cachedPath) {
      // 未缓存的文件回退到完整下载（Telegram API 不支持 Range）
      return null;
    }

    const total = Number(file.size);
    const actualEnd = end !== undefined ? Math.min(end, total - 1) : total - 1;

    if (start >= total || start > actualEnd) {
      throw new BadRequestException('Range 范围无效');
    }

    // 读取指定范围的文件片段
    const chunkSize = actualEnd - start + 1;
    const readStream = createReadStream(cachedPath, { start, end: actualEnd });

    // 原子访问计数
    await this.fileRepository
      .createQueryBuilder()
      .update(File)
      .set({ currentAccessCount: () => 'currentAccessCount + 1' })
      .where('id = :id', { id })
      .andWhere('(maxAccessCount <= 0 OR currentAccessCount < maxAccessCount)')
      .execute();

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

    const cachedStream = this.fileCacheService.getCachedReadStream(file.id, Number(file.size));
    const { stream, info } = cachedStream
      ? { stream: cachedStream, info: { file_id: file.telegramFileId, file_path: '', file_size: Number(file.size) } }
      : await this.telegramService.getFileStream(file.telegramFileId || file.filename);

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

    const actualSize = info.file_size > 0 ? info.file_size : Number(file.size);
    return { stream, contentType: mimeType, filename, size: actualSize, isInline, accessLogId };
  }

  /**
   * 流式获取公开文件内容（用于无约束公开文件和一次性链接）
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

    // 校验文件是否为公开访问类型
    if (file.accessType !== FileAccessType.PUBLIC) {
      throw new ForbiddenException('此文件为私有文件，不提供公开访问');
    }

    const cachedStream = this.fileCacheService.getCachedReadStream(file.id, Number(file.size));
    const { stream, info } = cachedStream
      ? { stream: cachedStream, info: { file_id: file.telegramFileId, file_path: '', file_size: Number(file.size) } }
      : await this.telegramService.getFileStream(file.telegramFileId || file.filename);

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

    // 使用 Telegram API 返回的真实文件大小，避免 Content-Length 不匹配导致下载卡死
    const actualSize = info.file_size > 0 ? info.file_size : Number(file.size);
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
      const appUrl = `${baseUrl}/files/public/${file.id}`;
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
    req?: Request,
  ): Promise<{ jobId: string; warning: string }> {
    if (file.size > this.maxFileSize) {
      throw new BadRequestException(`文件大小不能超过 ${this.maxFileSize / 1024 / 1024}MB`);
    }

    const originalName = this.fixFilenameEncoding(file.originalname);

    const typeCheck = this.isFileTypeAllowed(originalName, file.mimetype);
    if (!typeCheck.allowed) {
      throw new BadRequestException(typeCheck.reason || '不允许上传此类型的文件');
    }

    const job = this.uploadJobService.createJob(user, originalName);

    // 创建 AbortController：客户端连接断开 30 秒后中止后台上传
    const abortController = new AbortController();
    const cleanup = this.setupAbortOnDisconnect(req, abortController, job.jobId);

    // 后台处理：不阻塞响应
    this.processAsyncUpload(job.jobId, file, user, originalName, abortController.signal, cleanup, tagIds);
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
    req?: Request,
  ): Promise<{ jobId: string; total: number; warning: string }> {
    const job = this.uploadJobService.createJob(user, `${files.length} 个文件`, files.length);

    // 创建 AbortController：客户端连接断开 30 秒后中止后台上传
    const abortController = new AbortController();
    const cleanup = this.setupAbortOnDisconnect(req, abortController, job.jobId);

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
          const typeCheck = this.isFileTypeAllowed(originalName, file.mimetype);
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

  /**
   * 设置 AbortController：监听 req close 事件，客户端断开 30 秒后触发 abort
   * 并将任务标记为 failed。返回 cleanup 函数用于清理监听器。
   */
  private setupAbortOnDisconnect(
    req: Request | undefined,
    abortController: AbortController,
    jobId: string,
  ): () => void {
    if (!req) {
      // 无 req 时不启用 abort 机制（向后兼容）
      return () => {};
    }

    let disconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const onConnectionClose = (): void => {
      if (disconnectTimer || abortController.signal.aborted) return;
      this.logger.warn(`上传任务 ${jobId} 客户端连接已断开，30 秒后放弃任务`);
      disconnectTimer = setTimeout(() => {
        if (!abortController.signal.aborted) {
          abortController.abort();
          this.uploadJobService.updateJob(jobId, {
            status: 'failed',
            error: '客户端连接断开超过 30 秒，任务已放弃',
          });
        }
      }, 30 * 1000);
    };

    req.on('close', onConnectionClose);
    req.socket?.on('close', onConnectionClose);

    return (): void => {
      req.off('close', onConnectionClose);
      req.socket?.off('close', onConnectionClose);
      if (disconnectTimer) {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
      }
    };
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
  ): Promise<void> {
    try {
      this.uploadJobService.updateJob(jobId, { status: 'uploading' });

      // 任务开始前检查是否已被放弃
      if (abortSignal?.aborted) {
        throw new Error('任务已被放弃');
      }

      const savedFile = await this.uploadToTelegram(file, user, originalName, abortSignal);

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

    const newFile = this.fileRepository.create({
      filename: telegramFile.file_id,
      originalName: originalName,
      mimeType: file.mimetype,
      size: file.size,
      telegramFileId: telegramFile.file_id,
      telegramFilePath: telegramFile.file_path || '',
      uploaderId: user.id,
      accessType: FileAccessType.PUBLIC,
      maxAccessCount: -1,
    });

    return this.fileRepository.save(newFile);
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

    // 事务内原子执行：清除旧关联 + 插入新关联（参数化查询）
    await this.fileRepository.manager.transaction(async (manager) => {
      await manager.query('DELETE FROM file_tags WHERE "fileId" = $1', [fileId]);
      if (tagIds.length > 0) {
        await this.insertFileTags(manager, fileId, tagIds);
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
}
