import { Injectable, NotFoundException, ForbiddenException, BadRequestException, OnModuleInit, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Readable } from 'stream';
import { Request } from 'express';
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
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { BCRYPT_ROUNDS } from '../common/constants/bcrypt';

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

@Injectable()
export class FileService implements OnModuleInit {
  private readonly logger = new Logger(FileService.name);
  private maxFileSize: number;
  private fileTypeMode: 'blacklist' | 'whitelist' = 'blacklist';
  private fileTypeFilter: string[] = [];

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
  ) {
    this.maxFileSize = this.parseFileSize(this.configService.get<string>('MAX_FILE_SIZE'));
  }

  async onModuleInit() {
    await this.reloadUploadConfig();
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
    const lastDot = lowerName.lastIndexOf('.');
    const ext = lastDot > 0 ? lowerName.substring(lastDot) : '(无扩展名)';

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
    if (allowed && mimeType) {
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

  async upload(file: Express.Multer.File, user: User): Promise<File> {
    if (file.size > this.maxFileSize) {
      throw new BadRequestException(`文件大小不能超过 ${this.maxFileSize / 1024 / 1024}MB`);
    }

    const originalName = this.fixFilenameEncoding(file.originalname);

    const typeCheck = this.isFileTypeAllowed(originalName, file.mimetype);

    if (!typeCheck.allowed) {
      throw new BadRequestException(typeCheck.reason || '不允许上传此类型的文件');
    }

    let telegramFile;
    if (file.mimetype.startsWith('image/')) {
      telegramFile = await this.telegramService.uploadPhoto(file.buffer, originalName);
    } else {
      telegramFile = await this.telegramService.uploadFile(file.buffer, originalName);
    }

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

    // 审计日志：文件上传
    this.auditService.log({
      action: 'file_upload',
      userId: user.id,
      resourceType: 'file',
      resourceId: savedFile.id,
      metadata: { filename: originalName, size: file.size, mimeType: file.mimetype },
    });

    return savedFile;
  }

  async uploadMultiple(files: Express.Multer.File[], user: User): Promise<BatchUploadResult> {
    const success: File[] = [];
    const failed: BatchUploadFailedItem[] = [];

    for (const file of files) {
      try {
        const uploadedFile = await this.upload(file, user);
        success.push(uploadedFile);
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
  ): Promise<{ files: File[]; total: number }> {
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

    qb.select([
      'file.id', 'file.filename', 'file.originalName', 'file.mimeType', 'file.size',
      'file.accessType', 'file.maxAccessCount', 'file.currentAccessCount',
      'file.expiresIn', 'file.expiresStartAt', 'file.createdAt',
      'file.isDeleted', 'file.deletedByAdmin', 'file.deleteRequestedAt', 'file.deleteScheduledAt',
      'uploader',
    ])
      .addSelect('CASE WHEN file.password IS NOT NULL THEN true ELSE false END', 'file_hasPassword')
      .skip((page - 1) * limit)
      .take(limit)
      .orderBy('file.createdAt', 'DESC');

    const { entities, raw } = await qb.getRawAndEntities();

    // 使用独立的 count 查询（不受 skip/take 影响）
    const countQb = this.fileRepository.createQueryBuilder('file').where(where);
    if (keyword) {
      countQb.andWhere('LOWER(file.originalName) LIKE :keyword', { keyword: `%${keyword.toLowerCase()}%` });
    }
    const total = await countQb.getCount();

    const files = entities.map((entity, i) => ({
      ...entity,
      hasPassword: raw[i]?.file_hasPassword === true,
    } as File & { hasPassword: boolean }));

    return { files, total };
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
    file.deleteScheduledAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    file.deleteCooldownUntil = new Date(now.getTime() + 10 * 60 * 1000);
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
    const adminRecoverWindow = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

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
        await this.accessLogRepository.delete({ fileId: file.id });
        await this.fileRepository.remove(file);
        deletedCount++;
        this.logger.log(`已永久删除文件: ${file.originalName} (${file.id})`);
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : '未知错误';
        this.logger.warn(`永久删除文件失败: ${file.originalName} (${file.id}), 错误: ${errMsg}`);
        // 即使 Telegram 删除失败，也从数据库移除（避免数据库积压）
        try {
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

  private readonly ERROR_LIMIT = 5;        // 5次错误触发封禁
  private readonly BAN_5M = 5 * 60 * 1000;   // 错误5次封禁5分钟
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

    // 密码错误计数（仅计数，不锁定——5次错误后才触发封禁）
    const pwdResult = await this.rateLimitService.checkAndIncrement(
      pwdLimitKey, 'password_error',
      this.ERROR_LIMIT, 0, this.PWD_WINDOW,
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
      // 第5次封禁 → 升级为6小时
      const expiresAt = new Date(now + this.BAN_6H);
      const reason = `密码错误${this.ERROR_LIMIT}次，1小时内第${currentBanCount}次触发封禁，升级为6小时`;
      await this.bannedIPRepository.upsert(
        { ip, reason, isPermanent: false, expiresAt } as BannedIP,
        ['ip'],
      );
      await this.rateLimitService.reset(banLimitKey);
    } else {
      // 第1-4次封禁 → 5分钟
      const expiresAt = new Date(now + this.BAN_5M);
      const reason = `密码错误${this.ERROR_LIMIT}次，1小时内第${currentBanCount}次触发封禁`;
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

    const { stream } = await this.telegramService.getFileStream(file.telegramFileId || file.filename);

    return {
      stream,
      contentType: file.mimeType || 'application/octet-stream',
    };
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
  }> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    await this.assertFileReadable(file, user);

    // 先从 Telegram 拉取文件流（成功后才扣次数，避免拉取失败浪费次数）
    const { stream, info } = await this.telegramService.getFileStream(file.telegramFileId || file.filename);

    // 原子递增访问计数
    const result = await this.fileRepository
      .createQueryBuilder()
      .update(File)
      .set({ currentAccessCount: () => 'currentAccessCount + 1' })
      .where('id = :id', { id })
      .andWhere('(maxAccessCount <= 0 OR currentAccessCount < maxAccessCount)')
      .andWhere('isDeleted = false')
      .execute();

    if (result.affected === 0) {
      throw new ForbiddenException('访问次数已用尽或文件不存在');
    }

    try {
      await this.accessLogRepository.save({
        fileId: id,
        ip: ip || '',
        action: 'download',
        uploaderId: file.uploaderId,
        responseSize: file.size,
      });
    } catch {
      // 日志记录失败不影响主流程
    }

    const mimeType = file.mimeType || 'application/octet-stream';
    const filename = this.ensureFileExtension(file.originalName, mimeType);

    const actualSize = info.file_size > 0 ? info.file_size : Number(file.size);
    return { stream, contentType: mimeType, filename, size: actualSize };
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
            userId: '',
            action: 'consume',
            ip: '',
          } as ShareAudit);
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

    const { stream, info } = await this.telegramService.getFileStream(file.telegramFileId || file.filename);

    try {
      await this.accessLogRepository.save({
        fileId: id,
        ip: ip || '',
        action: 'public_direct',
        uploaderId: file.uploaderId,
        responseSize: file.size,
      });
    } catch {
      // ignore
    }

    const mimeType = file.mimeType || 'application/octet-stream';
    const isInline = /^(image|video|audio)\//.test(mimeType);
    const filename = this.ensureFileExtension(file.originalName, mimeType);

    const actualSize = info.file_size > 0 ? info.file_size : Number(file.size);
    return { stream, contentType: mimeType, filename, size: actualSize, isInline };
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

    const { stream, info } = await this.telegramService.getFileStream(file.telegramFileId || file.filename);

    try {
      await this.accessLogRepository.save({
        fileId: id,
        ip: ip || '',
        action: 'public_direct',
        uploaderId: file.uploaderId,
        responseSize: file.size,
      });
    } catch {
      // ignore
    }

    const mimeType = file.mimeType || 'application/octet-stream';
    const isInline = /^(image|video|audio)\//.test(mimeType);
    const filename = this.ensureFileExtension(file.originalName, mimeType);

    // 使用 Telegram API 返回的真实文件大小，避免 Content-Length 不匹配导致下载卡死
    const actualSize = info.file_size > 0 ? info.file_size : Number(file.size);
    return { stream, contentType: mimeType, filename, size: actualSize, isInline };
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
    this.processAsyncUpload(job.jobId, file, user, originalName, abortController.signal, cleanup);
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
  ): Promise<void> {
    try {
      this.uploadJobService.updateJob(jobId, { status: 'uploading' });

      // 任务开始前检查是否已被放弃
      if (abortSignal?.aborted) {
        throw new Error('任务已被放弃');
      }

      const savedFile = await this.uploadToTelegram(file, user, originalName, abortSignal);

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
    let telegramFile;
    if (file.mimetype.startsWith('image/')) {
      telegramFile = await this.telegramService.uploadPhoto(file.buffer, originalName, abortSignal);
    } else {
      telegramFile = await this.telegramService.uploadFile(file.buffer, originalName, abortSignal);
    }

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
}
