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

  async getMaxFileSize(): Promise<number> {
    return this.maxFileSize;
  }

  async getAllowedTypes(): Promise<string[]> {
    return [...this.allowedTypes];
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

  async findAll(page = 1, limit = 20, userId?: string, keyword?: string): Promise<{ files: File[]; total: number }> {
    const where: Record<string, unknown> = { isDeleted: false };
    if (userId) {
      where.uploaderId = userId;
    }

    const qb = this.fileRepository.createQueryBuilder('file')
      .leftJoinAndSelect('file.uploader', 'uploader')
      .where(where);

    if (keyword) {
      qb.andWhere('LOWER(file.originalName) LIKE :keyword', { keyword: `%${keyword.toLowerCase()}%` });
    }

    qb.select(['file.id', 'file.filename', 'file.originalName', 'file.mimeType', 'file.size', 'file.accessType', 'file.maxAccessCount', 'file.currentAccessCount', 'file.createdAt', 'uploader'])
      .skip((page - 1) * limit)
      .take(limit)
      .orderBy('file.createdAt', 'DESC');

    const [files, total] = await qb.getManyAndCount();

    return { files, total };
  }

  /**
   * 统一权限校验：登录用户只能读取自己的文件，管理员可读取所有文件
   */
  private async assertFileReadable(file: File, user: User): Promise<void> {
    if (file.uploaderId !== user.id && user.role === UserRole.USER) {
      throw new ForbiddenException('无权访问此文件');
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

  /**
   * 下载文件内容（后端代理，不暴露 Telegram URL）
   */
  async getFileContent(id: string, user: User): Promise<{
    content: Buffer;
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
        ip: '',
        action: 'download',
        uploaderId: file.uploaderId,
      });
    } catch {
      // 日志记录失败不影响主流程
    }

    const content = await this.telegramService.getFile(file.telegramFileId || file.filename);

    const mimeType = file.mimeType || 'application/octet-stream';
    let filename = file.originalName;
    if (!filename.includes('.')) {
      const ext = mimeType.split('/')[1] || 'bin';
      filename = `${filename}.${ext}`;
    }

    return { content, contentType: mimeType, filename, size: content.length };
  }

  /**
   * 验证分享 token 并处理访问计数，返回文件实体和是否受限
   */
  async validateShareToken(
    id: string,
    token: string,
    ip?: string,
    password?: string,
  ): Promise<{ file: File; isConstrained: boolean }> {
    let payload: { sub: string; jti?: string; userId?: string; exp?: number; iat?: number };
    try {
      payload = this.jwtService.verify(token);
    } catch {
      throw new ForbiddenException('分享链接无效或已过期');
    }

    if (payload.sub !== id) {
      throw new ForbiddenException('分享链接与文件不匹配');
    }

    if (payload.jti) {
      const revoked = await this.shareAuditRepository.findOne({
        where: { jti: payload.jti, action: 'revoke' },
      });
      if (revoked) {
        throw new ForbiddenException('分享链接已被撤销');
      }

      await this.shareAuditRepository.save({
        jti: payload.jti,
        fileId: id,
        userId: payload.userId || '',
        action: 'access',
        ip: ip || '',
      });
    }

    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    if (file.accessType === FileAccessType.PRIVATE) {
      if (!await this.verifyPassword(id, password || '')) {
        throw new ForbiddenException('此文件为私有文件，需要密码访问');
      }
    }

    const isConstrained = file.maxAccessCount > 0
      || (payload.exp !== undefined && payload.iat !== undefined && payload.exp > payload.iat);

    if (file.maxAccessCount > 0) {
      const result = await this.fileRepository
        .createQueryBuilder()
        .update(File)
        .set({ currentAccessCount: () => 'currentAccessCount + 1' })
        .where('id = :id', { id })
        .andWhere('(maxAccessCount <= 0 OR currentAccessCount < maxAccessCount)')
        .andWhere('isDeleted = false')
        .execute();

      if (result.affected === 0) {
        throw new ForbiddenException('访问次数已用尽');
      }
    }

    const updatedFile = await this.fileRepository.findOne({ where: { id } });
    if (!updatedFile) {
      throw new NotFoundException('文件不存在');
    }

    return { file: updatedFile, isConstrained };
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
    const expSeconds = expiresIn ? expiresIn * 3600 : 7 * 24 * 3600;

    const payload = {
      sub: id,
      jti,
      userId: user.id,
      permissions: 'read',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + expSeconds,
    };

    const shareToken = this.jwtService.sign(payload);

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

    const activeShares = await this.shareAuditRepository.find({
      where: { fileId: id, action: 'create' },
    });

    if (activeShares.length === 0) return;

    const jtis = activeShares.map((s) => s.jti);
    const revokedRecords = await this.shareAuditRepository.find({
      where: { jti: In(jtis), action: 'revoke' },
    });
    const revokedJtis = new Set(revokedRecords.map((r) => r.jti));

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

  /**
   * 检查文件是否为无约束公开文件（无需任何凭证即可访问）
   * PUBLIC + 无密码 + 无访问次数限制
   */
  async isUnrestrictedPublic(id: string): Promise<boolean> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false, accessType: FileAccessType.PUBLIC },
      select: ['password', 'maxAccessCount'],
    });
    return file !== null && !file.password && file.maxAccessCount <= 0;
  }

  /**
   * 生成一次性访问 token（30 秒短寿，用于重定向防 CDN 缓存）
   */
  generateAccessToken(fileId: string): string {
    return this.jwtService.sign(
      { sub: fileId, purpose: 'stream' },
      { expiresIn: '30s' },
    );
  }

  /**
   * 验证一次性访问 token
   */
  validateAccessToken(token: string, fileId: string): void {
    try {
      const payload = this.jwtService.verify(token);
      if (payload.sub !== fileId || payload.purpose !== 'stream') {
        throw new Error();
      }
    } catch {
      throw new ForbiddenException('访问链接已失效，请重新获取');
    }
  }

  /**
   * 直接获取文件内容（用于一次性链接和无约束公开文件）
   */
  async getPublicFileContentDirect(id: string): Promise<{
    content: Buffer;
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

    const content = await this.telegramService.getFile(file.telegramFileId || file.filename);

    try {
      await this.accessLogRepository.save({
        fileId: id,
        ip: '',
        action: 'public_direct',
        uploaderId: file.uploaderId,
      });
    } catch {
      // ignore
    }

    const mimeType = file.mimeType || 'application/octet-stream';
    const isInline = /^(image|video|audio)\//.test(mimeType);
    let filename = file.originalName;
    if (!filename.includes('.')) {
      const ext = mimeType.split('/')[1] || 'bin';
      filename = `${filename}.${ext}`;
    }

    return { content, contentType: mimeType, filename, size: content.length, isInline };
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

      // 无约束公开文件：永久公开 URL，无需 token
      if (file.accessType === FileAccessType.PUBLIC && !file.password && file.maxAccessCount <= 0) {
        const appUrl = `${baseUrl}/files/public/${file.id}`;
        results.push(`![${file.originalName}](${appUrl})`);
        continue;
      }

      // 有约束文件：生成分享链接
      const jti = uuidv4();
      const expSeconds = 30 * 24 * 3600;
      const payload = {
        sub: file.id,
        jti,
        userId: user.id,
        permissions: 'read',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + expSeconds,
      };
      const shareToken = this.jwtService.sign(payload);

      await this.shareAuditRepository.save({
        jti,
        fileId: file.id,
        userId: user.id,
        action: 'create',
      });

      const appUrl = `${baseUrl}/files/public/${file.id}?token=${shareToken}`;
      results.push(`![${file.originalName}](${appUrl})`);
    }

    return results;
  }
}
