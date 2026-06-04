import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { SystemConfig } from '../common/entities/system-config.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { File } from '../common/entities/file.entity';
import { User } from '../common/entities/user.entity';
import { FileAccessLog } from '../common/entities/file-access-log.entity';
import { FileService } from '../file/file.service';
import { ConfigCacheService } from '../common/services/config-cache.service';

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(SystemConfig)
    private systemConfigRepository: Repository<SystemConfig>,
    @InjectRepository(BannedIP)
    private bannedIPRepository: Repository<BannedIP>,
    @InjectRepository(File)
    private fileRepository: Repository<File>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(FileAccessLog)
    private accessLogRepository: Repository<FileAccessLog>,
    private fileService: FileService,
    private configCacheService: ConfigCacheService,
  ) {}

  async getStats(): Promise<{
    totalUsers: number;
    totalFiles: number;
    totalStorage: number;
    bannedUsers: number;
    activeUsers: number;
    totalAccessCount: number;
    monthlyAccess: { month: string; count: number }[];
  }> {
    // D-1: 合并查询为并行执行，减少数据库往返
    const [[userStats], [fileStats], [accessStats], monthlyAccess] = await Promise.all([
      this.userRepository
        .createQueryBuilder('user')
        .select([
          'COUNT(*) as "totalUsers"',
          'SUM(CASE WHEN user.isBanned = true THEN 1 ELSE 0 END) as "bannedUsers"',
        ])
        .getRawMany(),
      this.fileRepository
        .createQueryBuilder('file')
        .select([
          'COUNT(*) as "totalFiles"',
          'COALESCE(SUM(file.size), 0) as "totalStorage"',
        ])
        .where('file.isDeleted = false')
        .getRawMany(),
      this.accessLogRepository
        .createQueryBuilder('log')
        .select('COUNT(*) as "count"')
        .getRawMany(),
      this.getMonthlyAccessStats(),
    ]);

    const totalUsers = Number(userStats?.totalUsers || 0);
    const bannedUsers = Number(userStats?.bannedUsers || 0);

    return {
      totalUsers,
      totalFiles: Number(fileStats?.totalFiles || 0),
      totalStorage: Number(fileStats?.totalStorage || 0),
      bannedUsers,
      activeUsers: totalUsers - bannedUsers,
      totalAccessCount: Number(accessStats?.count || 0),
      monthlyAccess,
    };
  }

  private async getMonthlyAccessStats(): Promise<{ month: string; count: number }[]> {
    const raw = await this.accessLogRepository
      .createQueryBuilder('log')
      .select("TO_CHAR(log.createdAt, 'YYYY-MM')", 'month')
      .addSelect('COUNT(*)', 'count')
      .where("log.createdAt >= :since", { since: new Date(Date.now() - 365 * 24 * 3600 * 1000) })
      .groupBy('month')
      .orderBy('month', 'ASC')
      .getRawMany<{ month: string; count: string }>();

    return raw.map((r) => ({ month: r.month, count: Number(r.count) }));
  }

  async getAdminFileStats(userId: string): Promise<{ fileCount: number; totalSize: number; totalAccessCount: number }> {
    const [fileStats] = await this.fileRepository
      .createQueryBuilder('file')
      .select([
        'COUNT(*) as "fileCount"',
        'COALESCE(SUM(file.size), 0) as "totalSize"',
      ])
      .where('file.uploaderId = :userId', { userId })
      .andWhere('file.isDeleted = false')
      .getRawMany();

    const [accessStats] = await this.accessLogRepository
      .createQueryBuilder('log')
      .select('COUNT(*) as "count"')
      .where('log.uploaderId = :userId', { userId })
      .getRawMany();

    return {
      fileCount: Number(fileStats?.fileCount || 0),
      totalSize: Number(fileStats?.totalSize || 0),
      totalAccessCount: Number(accessStats?.count || 0),
    };
  }

  async getConfig(): Promise<SystemConfig[]> {
    return this.systemConfigRepository.find();
  }

  async getConfigByKey(key: string): Promise<string | null> {
    return this.configCacheService.get(key, '');
  }

  async updateConfig(key: string, value: string, description?: string): Promise<void> {
    await this.configCacheService.set(key, value, description);
  }

  async updateConfigs(configs: { key: string; value: string; description?: string }[]): Promise<void> {
    await this.configCacheService.setBatch(configs);
  }

  async getBannedIPs(): Promise<BannedIP[]> {
    return this.bannedIPRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  async banIP(ip: string, reason?: string, permanent = true, expiresAt?: Date): Promise<void> {
    const existing = await this.bannedIPRepository.findOne({ where: { ip } });
    
    if (existing) {
      throw new BadRequestException('该IP已被封禁');
    }

    const bannedIP = new BannedIP();
    bannedIP.ip = ip;
    bannedIP.reason = reason ?? null;
    bannedIP.isPermanent = permanent;
    bannedIP.expiresAt = permanent ? null : (expiresAt ?? null);

    await this.bannedIPRepository.save(bannedIP);
  }

  async unbanIP(ip: string): Promise<void> {
    const bannedIP = await this.bannedIPRepository.findOne({ where: { ip } });
    
    if (!bannedIP) {
      throw new NotFoundException('该IP未被封禁');
    }

    await this.bannedIPRepository.delete(bannedIP.id);
  }

  async cleanupExpiredBans(): Promise<void> {
    await this.bannedIPRepository.delete({
      isPermanent: false,
      expiresAt: LessThan(new Date()),
    });
  }

  async getAllFiles(page = 1, limit = 20): Promise<{ files: File[]; total: number }> {
    return this.fileService.findAll(page, limit);
  }

  async deleteFile(id: string): Promise<void> {
    const file = await this.fileRepository.findOne({ where: { id } });
    
    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    file.isDeleted = true;
    await this.fileRepository.save(file);
  }

  async batchDeleteFiles(ids: string[]): Promise<void> {
    await this.fileRepository.update(ids, { isDeleted: true });
  }

  async getAuthConfig(): Promise<{
    registrationEnabled: boolean;
    emailVerificationEnabled: boolean;
  }> {
    const [registrationEnabled, emailVerificationEnabled] = await Promise.all([
      this.getConfigByKey('REGISTRATION_ENABLED'),
      this.getConfigByKey('EMAIL_VERIFICATION_ENABLED'),
    ]);

    return {
      registrationEnabled: registrationEnabled === 'true',
      emailVerificationEnabled: emailVerificationEnabled === 'true',
    };
  }

  async updateAuthConfig(config: {
    registrationEnabled?: boolean;
    emailVerificationEnabled?: boolean;
  }): Promise<void> {
    if (config.registrationEnabled !== undefined) {
      await this.updateConfig('REGISTRATION_ENABLED', config.registrationEnabled.toString(), '是否允许新用户注册');
    }
    if (config.emailVerificationEnabled !== undefined) {
      await this.updateConfig('EMAIL_VERIFICATION_ENABLED', config.emailVerificationEnabled.toString(), '是否开启邮箱验证码');
    }
  }

  async getSMTPConfig(): Promise<{
    host: string;
    port: number;
    secure: boolean;
    user: string;
    from: string;
  }> {
    const [host, port, secure, user, from] = await Promise.all([
      this.getConfigByKey('SMTP_HOST'),
      this.getConfigByKey('SMTP_PORT'),
      this.getConfigByKey('SMTP_SECURE'),
      this.getConfigByKey('SMTP_USER'),
      this.getConfigByKey('SMTP_FROM'),
    ]);

    return {
      host: host || '',
      port: parseInt(port || '587'),
      secure: secure === 'true',
      user: user || '',
      from: from || '',
    };
  }

  async updateSMTPConfig(config: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    from: string;
  }): Promise<void> {
    await this.updateConfigs([
      { key: 'SMTP_HOST', value: config.host, description: 'SMTP服务器地址' },
      { key: 'SMTP_PORT', value: config.port.toString(), description: 'SMTP服务器端口' },
      { key: 'SMTP_SECURE', value: config.secure.toString(), description: '是否使用SSL' },
      { key: 'SMTP_USER', value: config.user, description: 'SMTP用户名' },
      { key: 'SMTP_PASSWORD', value: config.password, description: 'SMTP密码' },
      { key: 'SMTP_FROM', value: config.from, description: '发件人邮箱' },
    ]);
  }

  async getUploadConfig(): Promise<{
    maxFileSize: number;
    fileTypeMode: string;
    fileTypeFilter: string;
  }> {
    const [maxFileSize, fileTypeMode, fileTypeFilter] = await Promise.all([
      this.getConfigByKey('MAX_FILE_SIZE'),
      this.getConfigByKey('FILE_TYPE_MODE'),
      this.getConfigByKey('FILE_TYPE_FILTER'),
    ]);

    return {
      maxFileSize: parseInt(maxFileSize || '20971520'),
      fileTypeMode: fileTypeMode || 'blacklist',
      fileTypeFilter: fileTypeFilter || '',
    };
  }

  async updateUploadConfig(config: {
    maxFileSize?: number;
    fileTypeMode?: string;
    fileTypeFilter?: string;
  }): Promise<void> {
    if (config.maxFileSize !== undefined) {
      await this.updateConfig('MAX_FILE_SIZE', config.maxFileSize.toString(), '最大文件大小（字节）');
    }

    if (config.fileTypeMode !== undefined) {
      await this.updateConfig('FILE_TYPE_MODE', config.fileTypeMode, '文件类型过滤模式（blacklist/whitelist）');
    }

    if (config.fileTypeFilter !== undefined) {
      await this.updateConfig('FILE_TYPE_FILTER', config.fileTypeFilter, '文件类型过滤列表（逗号分隔）');
    }
  }
}
