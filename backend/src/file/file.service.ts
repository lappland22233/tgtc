import { Injectable, NotFoundException, ForbiddenException, BadRequestException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { File, FileAccessType } from '../common/entities/file.entity';
import { ShareAudit } from '../common/entities/share-audit.entity';
import { FileAccessLog } from '../common/entities/file-access-log.entity';
import { TelegramService } from '../telegram/telegram.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { User, UserRole } from '../common/entities/user.entity';
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

export interface BatchUploadFailedItem {
  name: string;
  reason: string;
}

export interface BatchUploadResult {
  success: File[];
  failed: BatchUploadFailedItem[];
}

@Injectable()
export class FileService implements OnModuleInit {
  private maxFileSize: number;
  private allowedTypes: string[];

  constructor(
    @InjectRepository(File)
    private fileRepository: Repository<File>,
    @InjectRepository(ShareAudit)
    private shareAuditRepository: Repository<ShareAudit>,
    @InjectRepository(FileAccessLog)
    private accessLogRepository: Repository<FileAccessLog>,
    private telegramService: TelegramService,
    private configService: ConfigService,
    private jwtService: JwtService,
    private configCacheService: ConfigCacheService,
  ) {
    this.maxFileSize = this.parseFileSize(this.configService.get<string>('MAX_FILE_SIZE'));
    this.allowedTypes = (this.configService.get<string>('ALLOWED_FILE_TYPES') || 'image/*,application/pdf,application/zip,text/*').split(',');
  }

  async onModuleInit() {
    // 启动时从配置缓存加载最新的上传配置
    await this.reloadUploadConfig();
  }

  @OnEvent('config.changed')
  async handleConfigChanged(payload: { key: string; value: string }) {
    if (payload.key === 'MAX_FILE_SIZE' || payload.key === 'ALLOWED_FILE_TYPES') {
      await this.reloadUploadConfig();
    }
  }

  private async reloadUploadConfig() {
    const [maxFileSize, allowedFileTypes] = await Promise.all([
      this.configCacheService.get('MAX_FILE_SIZE', '20971520'),
      this.configCacheService.get('ALLOWED_FILE_TYPES', 'image/*,application/pdf,application/zip,text/*'),
    ]);
    this.maxFileSize = this.parseFileSize(maxFileSize);
    this.allowedTypes = allowedFileTypes.split(',');
  }

  private parseFileSize(val: string | undefined): number {
    const parsed = Number(val);
    return Number.isFinite(parsed) ? parsed : 20971520;
  }

  async upload(file: Express.Multer.File, user: User): Promise<File> {
    if (file.size > this.maxFileSize) {
      throw new BadRequestException(`文件大小不能超过 ${this.maxFileSize / 1024 / 1024}MB`);
    }

    const isAllowed = this.allowedTypes.some(type => {
      if (type.endsWith('/*')) {
        const category = type.split('/')[0];
        return file.mimetype.startsWith(category + '/');
      }
      return file.mimetype === type;
    });

    if (!isAllowed) {
      throw new BadRequestException('不允许上传此类型的文件');
    }

    let telegramFile;
    if (file.mimetype.startsWith('image/')) {
      telegramFile = await this.telegramService.uploadPhoto(file.buffer, file.originalname);
    } else {
      telegramFile = await this.telegramService.uploadFile(file.buffer, file.originalname);
    }

    const newFile = this.fileRepository.create({
      filename: telegramFile.file_id,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      telegramFileId: telegramFile.file_id,
      telegramFilePath: telegramFile.file_path,
      uploaderId: user.id,
      accessType: FileAccessType.PUBLIC,
      maxAccessCount: -1,
    });

    return this.fileRepository.save(newFile);
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

  async findAll(page = 1, limit = 20, userId?: string): Promise<{ files: File[]; total: number }> {
    const where: Record<string, unknown> = { isDeleted: false };
    if (userId) {
      where.uploaderId = userId;
    }

    const [files, total] = await this.fileRepository.findAndCount({
      where,
      relations: ['uploader'],
      select: ['id', 'filename', 'originalName', 'mimeType', 'size', 'accessType', 'maxAccessCount', 'currentAccessCount', 'createdAt', 'uploader'],
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    return { files, total };
  }

  async findOne(id: string): Promise<File> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
      relations: ['uploader'],
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    return file;
  }

  async delete(id: string, user: User): Promise<void> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    if (file.uploaderId !== user.id && user.role === UserRole.USER) {
      throw new ForbiddenException('无权删除此文件');
    }

    file.isDeleted = true;
    await this.fileRepository.save(file);
  }

  async updateAccessType(id: string, accessType: FileAccessType, user: User): Promise<void> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    if (file.uploaderId !== user.id && user.role === UserRole.USER) {
      throw new ForbiddenException('无权修改此文件');
    }

    await this.fileRepository.update(id, { accessType });
  }

  async updateAccessCount(id: string, maxAccessCount: number, user: User): Promise<void> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    if (file.uploaderId !== user.id && user.role === UserRole.USER) {
      throw new ForbiddenException('无权修改此文件');
    }

    await this.fileRepository.update(id, { maxAccessCount });
  }

  async setPassword(id: string, password: string, user: User): Promise<void> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    if (file.uploaderId !== user.id && user.role === UserRole.USER) {
      throw new ForbiddenException('无权修改此文件');
    }

    const hashedPassword = password ? await bcrypt.hash(password, 10) : null;
    await this.fileRepository.update(id, { password: hashedPassword || undefined });
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

  async getFileContent(id: string, password?: string): Promise<{ url: string; file: File }> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    if (file.accessType === FileAccessType.PRIVATE) {
      if (!await this.verifyPassword(id, password || '')) {
        throw new ForbiddenException('需要密码访问');
      }
    }

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

    // 记录访问日志
    try {
      await this.accessLogRepository.save({
        fileId: id,
        ip: '',
        action: 'download',
        uploaderId: file.uploaderId,
      });
    } catch {
      // 日志记录失败不影响主流程
    }

    const updatedFile = await this.fileRepository.findOne({ where: { id } });
    if (!updatedFile) {
      throw new NotFoundException('文件不存在');
    }
    const url = this.telegramService.getFileUrl(updatedFile.telegramFilePath);

    return { url, file: updatedFile };
  }

  /**
   * 公开文件访问：验证 token 并返回文件内容用于浏览器预览/下载
   * - image/video/audio → Content-Disposition: inline（浏览器直接预览）
   * - 其他 → Content-Disposition: attachment（触发下载）
   */
  async getPublicFileContent(id: string, token: string, ip?: string): Promise<{
    content: Buffer;
    contentType: string;
    filename: string;
    size: number;
    isInline: boolean;
  }> {
    // 复用 token 验证和审计逻辑
    const { file } = await this.getPublicFileByToken(id, token, ip);

    // 从 Telegram 获取实际文件内容
    const content = await this.telegramService.getFile(file.telegramFileId || file.filename);

    // 记录访问日志
    try {
      await this.accessLogRepository.save({
        fileId: id,
        ip: ip || '',
        action: 'public_share',
        uploaderId: file.uploaderId,
      });
    } catch {
      // 日志记录失败不影响主流程
    }

    const mimeType = file.mimeType || 'application/octet-stream';
    const isInline = /^(image|video|audio)\//.test(mimeType);

    // 使用原始文件名，确保扩展名正确
    let filename = file.originalName;
    // 如果原始文件名没有扩展名，根据 mimeType 补充
    if (!filename.includes('.')) {
      const ext = mimeType.split('/')[1] || 'bin';
      filename = `${filename}.${ext}`;
    }

    return {
      content,
      contentType: mimeType,
      filename,
      size: content.length,
      isInline,
    };
  }

  async getPublicFileByToken(id: string, token: string, ip?: string): Promise<{ url: string; file: File }> {
    // 验证 JWT 签名
    let payload: { sub: string; jti?: string; userId?: string };
    try {
      payload = this.jwtService.verify(token);
    } catch {
      throw new ForbiddenException('分享链接无效或已过期');
    }

    // 校验 payload 中的 fileId 与路由 id 一致
    if (payload.sub !== id) {
      throw new ForbiddenException('分享链接与文件不匹配');
    }

    // 检查 jti 是否已被撤销
    if (payload.jti) {
      const revoked = await this.shareAuditRepository.findOne({
        where: { jti: payload.jti, action: 'revoke' },
      });
      if (revoked) {
        throw new ForbiddenException('分享链接已被撤销');
      }

      // 记录访问审计日志
      await this.shareAuditRepository.save({
        jti: payload.jti,
        fileId: id,
        userId: payload.userId || '',
        action: 'access',
        ip: ip || '',
      });
    }

    // 获取文件并原子递增访问计数
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    // 原子递增访问计数，防止并发竞态
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

    const updatedFile = await this.fileRepository.findOne({ where: { id } });
    if (!updatedFile) {
      throw new NotFoundException('文件不存在');
    }
    const url = this.telegramService.getFileUrl(updatedFile.telegramFilePath);

    return { url, file: updatedFile };
  }

  async generateShareLink(id: string, user: User, expiresIn?: number): Promise<string> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    if (file.uploaderId !== user.id && user.role === UserRole.USER) {
      throw new ForbiddenException('无权分享此文件');
    }

    const jti = uuidv4();
    const expSeconds = expiresIn ? expiresIn * 3600 : 7 * 24 * 3600; // 默认7天

    const payload = {
      sub: id,
      jti,
      userId: user.id,
      permissions: 'read',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + expSeconds,
    };

    const shareToken = this.jwtService.sign(payload);

    // 记录生成审计日志
    await this.shareAuditRepository.save({
      jti,
      fileId: id,
      userId: user.id,
      action: 'create',
    });

    const baseUrl = this.configService.get<string>('APP_URL') || 'http://localhost:3000';
    return `${baseUrl}/files/public/${id}?token=${shareToken}`;
  }

  async revokeShareLink(id: string, user: User): Promise<void> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    if (file.uploaderId !== user.id && user.role === UserRole.USER) {
      throw new ForbiddenException('无权撤销此文件的分享');
    }

    // 一次性查询该文件所有已创建的分享中未撤销的 jti
    const activeShares = await this.shareAuditRepository.find({
      where: { fileId: id, action: 'create' },
    });

    if (activeShares.length === 0) return;

    const jtis = activeShares.map((s) => s.jti);

    // 一次性查询已撤销记录
    const revokedRecords = await this.shareAuditRepository.find({
      where: { jti: In(jtis), action: 'revoke' },
    });
    const revokedJtis = new Set(revokedRecords.map((r) => r.jti));

    // 批量生成未撤销的 jti 项
    const toRevoke = jtis
      .filter((jti) => !revokedJtis.has(jti))
      .map((jti) => ({
        jti,
        fileId: id,
        userId: user.id,
        action: 'revoke' as const,
      }));

    if (toRevoke.length > 0) {
      await this.shareAuditRepository.save(toRevoke);
    }
  }

  async batchToMarkdown(ids: string[]): Promise<string[]> {
    const files = await this.fileRepository.findBy({ id: In(ids) });
    
    const results: string[] = [];
    for (const file of files) {
      if (file.mimeType.startsWith('image/')) {
        const url = this.telegramService.getFileUrl(file.telegramFilePath);
        results.push(`![${file.originalName}](${url})`);
      }
    }
    return results;
  }
}
