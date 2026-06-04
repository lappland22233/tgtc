import { Injectable, NotFoundException, ForbiddenException, BadRequestException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Readable } from 'stream';
import { File, FileAccessType } from '../common/entities/file.entity';
import { FileAccessLog } from '../common/entities/file-access-log.entity';
import { TelegramService } from '../telegram/telegram.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { User, UserRole } from '../common/entities/user.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { ShareAudit } from '../common/entities/share-audit.entity';
import { RateLimitService } from '../common/services/rate-limit.service';
import { UploadJobService, UploadJob } from './upload-job.service';
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
   * 从文件名提取扩展名（小写，含点号）
   * 只取最后一个点之后的部分，防止 .php.jpg 等复合扩展名绕过检查
   */
  private extractExtension(filename: string): string {
    const name = filename.toLowerCase();
    const lastDot = name.lastIndexOf('.');
    return lastDot > 0 ? '.' + name.slice(lastDot + 1) : '';
  }

  /**
   * 检查文件类型是否被允许
   * - 黑名单 + 空过滤 = 允许所有
   * - 黑名单 + 有过滤 = 拒绝匹配的
   * - 白名单 + 空过滤 = 拒绝所有
   * - 白名单 + 有过滤 = 允许匹配的
   */
  private isFileTypeAllowed(filename: string): boolean {
    if (this.fileTypeMode === 'blacklist' && this.fileTypeFilter.length === 0) {
      return true;
    }

    if (this.fileTypeMode === 'whitelist' && this.fileTypeFilter.length === 0) {
      return false;
    }

    const lowerName = filename.toLowerCase();
    const matched = this.fileTypeFilter.some(f => lowerName.endsWith(f));

    if (this.fileTypeMode === 'blacklist') {
      return !matched;
    } else {
      return matched;
    }
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

  async upload(file: Express.Multer.File, user: User): Promise<File> {
    if (file.size > this.maxFileSize) {
      throw new BadRequestException(`文件大小不能超过 ${this.maxFileSize / 1024 / 1024}MB`);
    }

    const originalName = this.fixFilenameEncoding(file.originalname);

    const isAllowed = this.isFileTypeAllowed(originalName);

    if (!isAllowed) {
      throw new BadRequestException('不允许上传此类型的文件');
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

    qb.select(['file.id', 'file.filename', 'file.originalName', 'file.mimeType', 'file.size', 'file.accessType', 'file.maxAccessCount', 'file.currentAccessCount', 'file.expiresIn', 'file.expiresStartAt', 'file.createdAt', 'uploader'])
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
    await this.fileRepository.update(id, { password: hashedPassword });
  }

  async updateExpires(id: string, expiresIn: number | null, user: User): Promise<void> {
    const file = await this.fileRepository.findOne({
      where: { id, isDeleted: false },
    });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    if (file.uploaderId !== user.id && user.role === UserRole.USER) {
      throw new ForbiddenException('无权修改此文件');
    }

    await this.fileRepository.update(id, { expiresIn, expiresStartAt: expiresIn !== null ? new Date() : null });
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
  async checkAndIncrementAccess(id: string, ip?: string): Promise<{ allowed: boolean; reason?: string }> {
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
        .set({ currentAccessCount: () => 'currentAccessCount + 1' })
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
    const banResult = await this.rateLimitService.checkAndIncrement(
      banLimitKey, 'ban_count',
      this.BAN_COUNT_LIMIT, 0, this.BAN_WINDOW,
    );

    // 获取当前错误计数和封禁计数
    const now = Date.now();
    const currentBanCount = await this.rateLimitService.getAttemptCount(banLimitKey);

    if (currentBanCount >= this.BAN_COUNT_LIMIT) {
      // 第5次封禁 → 升级为6小时
      const expiresAt = new Date(now + this.BAN_6H);
      const reason = `密码错误${this.ERROR_LIMIT}次，1小时内第${currentBanCount}次触发封禁，升级为6小时`;

      const existingBan = await this.bannedIPRepository.findOne({ where: { ip } });
      if (existingBan) {
        await this.bannedIPRepository.update(existingBan.id, { expiresAt, reason });
      } else {
        await this.bannedIPRepository.save({ ip, reason, isPermanent: false, expiresAt } as BannedIP);
      }

      await this.rateLimitService.reset(banLimitKey);
    } else {
      // 第1-4次封禁 → 5分钟
      const expiresAt = new Date(now + this.BAN_5M);
      const reason = `密码错误${this.ERROR_LIMIT}次，1小时内第${currentBanCount}次触发封禁`;

      const existingBan = await this.bannedIPRepository.findOne({ where: { ip } });
      if (existingBan) {
        await this.bannedIPRepository.update(existingBan.id, { expiresAt, reason });
      } else {
        await this.bannedIPRepository.save({ ip, reason, isPermanent: false, expiresAt } as BannedIP);
      }
    }

    // 重置错误计数器
    await this.rateLimitService.reset(pwdLimitKey);
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

    // 先从 Telegram 拉取文件内容（成功后才扣次数，避免拉取失败浪费次数）
    const content = await this.telegramService.getFile(file.telegramFileId || file.filename);

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

    const mimeType = file.mimeType || 'application/octet-stream';
    let filename = file.originalName;
    if (!filename.includes('.')) {
      const ext = mimeType.split('/')[1] || 'bin';
      filename = `${filename}.${ext}`;
    }

    return { content, contentType: mimeType, filename, size: content.length };
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
   * 获取文件预览流（不计数，用于缩略图展示）
   * @deprecated 请使用 getThumbnailStream
   */
  async getFilePreviewStream(id: string, user: User): Promise<{
    stream: Readable;
    contentType: string;
    size: number;
  }> {
    const result = await this.getThumbnailStream(id, user);
    return { ...result, size: 0 };
  }

  /**
   * 流式下载文件内容（后端代理，不暴露 Telegram URL）
   * 用于避免大文件全部加载到内存
   */
  async getFileContentStream(id: string, user: User): Promise<{
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
        ip: '',
        action: 'download',
        uploaderId: file.uploaderId,
      });
    } catch {
      // 日志记录失败不影响主流程
    }

    const mimeType = file.mimeType || 'application/octet-stream';
    let filename = file.originalName;
    if (!filename.includes('.')) {
      const ext = mimeType.split('/')[1] || 'bin';
      filename = `${filename}.${ext}`;
    }

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

    if (file.uploaderId !== user.id && user.role === UserRole.USER) {
      throw new ForbiddenException('无权分享此文件');
    }

    const baseUrl = this.configService.get<string>('APP_URL') || 'http://localhost:3000';
    return `${baseUrl}/files/public/${id}`;
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
          });
        } catch (dbError) {
          // 唯一约束冲突 = token 已被消费
          throw new Error('access token 已被使用过');
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('已被使用过')) {
        throw new ForbiddenException('访问链接已被使用，请重新获取');
      }
      throw new ForbiddenException('访问链接已失效，请重新获取');
    }
  }

  /**
   * 验证一次性访问 token（保留以兼容旧接口，仅用于快速校验）
   * @deprecated 请使用 consumeAccessToken 进行原子性消费
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
   * 通过短效访问 token 流式获取文件内容（重新校验文件状态，防止 token 有效期内外界状态变更）
   */
  async getPublicFileContentStreamWithAccess(id: string): Promise<{
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

    const actualSize = info.file_size > 0 ? info.file_size : Number(file.size);
    return { stream, contentType: mimeType, filename, size: actualSize, isInline };
  }

  /**
   * 流式获取公开文件内容（用于无约束公开文件和一次性链接）
   */
  async getPublicFileContentStream(id: string): Promise<{
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

    const { stream, info } = await this.telegramService.getFileStream(file.telegramFileId || file.filename);

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
   */
  async uploadAsync(file: Express.Multer.File, user: User): Promise<{ jobId: string }> {
    if (file.size > this.maxFileSize) {
      throw new BadRequestException(`文件大小不能超过 ${this.maxFileSize / 1024 / 1024}MB`);
    }

    const originalName = this.fixFilenameEncoding(file.originalname);

    if (!this.isFileTypeAllowed(originalName)) {
      throw new BadRequestException('不允许上传此类型的文件');
    }

    const job = this.uploadJobService.createJob(user, originalName);
    // 后台处理：不阻塞响应
    this.processAsyncUpload(job.jobId, file, user, originalName);
    return { jobId: job.jobId };
  }

  /**
   * 异步批量上传
   */
  async uploadMultipleAsync(files: Express.Multer.File[], user: User) {
    const job = this.uploadJobService.createJob(user, `${files.length} 个文件`, files.length);

    setImmediate(async () => {
      const success: File[] = [];
      const failed: BatchUploadFailedItem[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          const originalName = this.fixFilenameEncoding(file.originalname);
          if (!this.isFileTypeAllowed(originalName)) {
            failed.push({ name: originalName, reason: '不允许上传此类型的文件' });
            continue;
          }
          if (file.size > this.maxFileSize) {
            failed.push({ name: originalName, reason: `文件大小超过 ${this.maxFileSize / 1024 / 1024}MB` });
            continue;
          }
          const uploadedFile = await this.uploadToTelegram(file, user, originalName);
          success.push(uploadedFile);
        } catch (error: unknown) {
          failed.push({
            name: file.originalname,
            reason: error instanceof Error ? error.message : '上传失败',
          });
        }
        this.uploadJobService.updateJob(job.jobId, {
          progress: Math.round(((i + 1) / files.length) * 100),
        });
      }

      this.uploadJobService.updateJob(job.jobId, {
        status: 'completed',
        progress: 100,
        result: { success, failed },
      });
    });

    return { jobId: job.jobId, total: files.length };
  }

  getUploadJob(jobId: string): UploadJob | undefined {
    return this.uploadJobService.getJob(jobId);
  }

  /**
   * 后台处理单个文件上传到 Telegram
   */
  private async processAsyncUpload(jobId: string, file: Express.Multer.File, user: User, originalName: string) {
    try {
      this.uploadJobService.updateJob(jobId, { status: 'uploading' });

      const savedFile = await this.uploadToTelegram(file, user, originalName);

      this.uploadJobService.updateJob(jobId, {
        status: 'completed',
        progress: 100,
        result: savedFile,
      });
    } catch (error: unknown) {
      this.uploadJobService.updateJob(jobId, {
        status: 'failed',
        error: error instanceof Error ? error.message : '上传失败',
      });
    }
  }

  /**
   * 上传文件到 Telegram 并保存数据库记录
   */
  private async uploadToTelegram(file: Express.Multer.File, user: User, originalName: string): Promise<File> {
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

    return this.fileRepository.save(newFile);
  }
}
