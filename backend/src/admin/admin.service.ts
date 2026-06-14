import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { SystemConfig } from '../common/entities/system-config.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { File } from '../common/entities/file.entity';
import { User } from '../common/entities/user.entity';
import { FileAccessLog } from '../common/entities/file-access-log.entity';
import { AccessLog } from '../common/entities/access-log.entity';
import { AuditLog } from '../common/entities/audit-log.entity';
import { FileService } from '../file/file.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { AuditService } from '../common/services/audit.service';
import { encryptPassword } from '../common/utils/crypto.util';

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
    @InjectRepository(AccessLog)
    private accessLogRepo: Repository<AccessLog>,
    @InjectRepository(AuditLog)
    private auditLogRepo: Repository<AuditLog>,
    private fileService: FileService,
    private configCacheService: ConfigCacheService,
    private auditService: AuditService,
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

    // 审计日志：配置变更
    this.auditService.log({
      action: 'config_change',
      resourceType: 'config',
      resourceId: key,
      metadata: { value: value.substring(0, 100), description },
    });
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

    // 审计日志：IP 封禁
    this.auditService.log({
      action: 'ip_ban',
      resourceType: 'ip',
      resourceId: ip,
      metadata: { reason, permanent },
    });
  }

  async unbanIP(ip: string): Promise<void> {
    const bannedIP = await this.bannedIPRepository.findOne({ where: { ip } });
    
    if (!bannedIP) {
      throw new NotFoundException('该IP未被封禁');
    }

    await this.bannedIPRepository.delete(bannedIP.id);

    // 审计日志：IP 解封
    this.auditService.log({
      action: 'ip_unban',
      resourceType: 'ip',
      resourceId: ip,
    });
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

    // 审计日志：管理员删除文件
    this.auditService.log({
      action: 'file_delete',
      resourceType: 'file',
      resourceId: id,
      metadata: { filename: file.originalName },
    });
  }

  async batchDeleteFiles(ids: string[]): Promise<void> {
    await this.fileRepository.update(ids, { isDeleted: true });

    // 审计日志：批量删除文件
    this.auditService.log({
      action: 'batch_delete_files',
      resourceType: 'file',
      metadata: { count: ids.length, ids },
    });
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

    // 审计日志：认证配置变更
    this.auditService.log({
      action: 'auth_config_change',
      resourceType: 'config',
      resourceId: 'auth',
      metadata: config,
    });
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
      { key: 'SMTP_PASSWORD', value: encryptPassword(config.password), description: 'SMTP密码（已加密）' },
      { key: 'SMTP_FROM', value: config.from, description: '发件人邮箱' },
    ]);

    // 审计日志：SMTP 配置变更
    this.auditService.log({
      action: 'smtp_config_change',
      resourceType: 'config',
      resourceId: 'smtp',
    });
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

    // 审计日志：上传配置变更
    this.auditService.log({
      action: 'upload_config_change',
      resourceType: 'config',
      resourceId: 'upload',
      metadata: config,
    });
  }

  // ==================== 访问日志统计 ====================

  private parseTimeRange(timeRange: string): Date {
    const now = new Date();
    switch (timeRange) {
      case '1h': return new Date(now.getTime() - 60 * 60 * 1000);
      case '24h': return new Date(now.getTime() - 24 * 60 * 60 * 1000);
      case '7d': return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      case '30d': return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      default: return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    }
  }

  async getAccessLogs(query: {
    page?: number;
    limit?: number;
    path?: string;
    statusCode?: number;
    timeRange?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<{ items: AccessLog[]; total: number }> {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));

    let since: Date;
    if (query.startDate) {
      since = new Date(query.startDate);
    } else {
      since = this.parseTimeRange(query.timeRange || '24h');
    }

    const qb = this.accessLogRepo
      .createQueryBuilder('log')
      .where('log.createdAt >= :since', { since });

    if (query.endDate) {
      qb.andWhere('log.createdAt <= :until', { until: new Date(query.endDate) });
    }

    if (query.path) {
      qb.andWhere('log.path ILIKE :path', { path: `%${query.path.replace(/[%_]/g, '\\$&')}%` });
    }

    if (query.statusCode) {
      qb.andWhere('log.statusCode = :statusCode', { statusCode: query.statusCode });
    }

    const total = await qb.getCount();

    const items = await qb
      .orderBy('log.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return { items, total };
  }

  async getAccessLogStats(timeRange?: string): Promise<{
    totalRequests: number;
    totalBandwidth: number;
    uniqueVisitors: number;
    peakQPS: number;
    statusDistribution: { statusCode: number; count: number }[];
    errorRate: number;
  }> {
    const since = this.parseTimeRange(timeRange || '24h');

    // 基本统计
    const [raw] = await this.accessLogRepo
      .createQueryBuilder('log')
      .select([
        'COUNT(*) as "totalRequests"',
        'COALESCE(SUM(log.responseSize), 0) as "totalBandwidth"',
        'COUNT(DISTINCT log.ip) as "uniqueVisitors"',
      ])
      .where('log.createdAt >= :since', { since })
      .getRawMany();

    // 状态码分布
    const statusDistribution = await this.accessLogRepo
      .createQueryBuilder('log')
      .select('log.statusCode', 'statusCode')
      .addSelect('COUNT(*)', 'count')
      .where('log.createdAt >= :since', { since })
      .groupBy('log.statusCode')
      .orderBy('count', 'DESC')
      .getRawMany<{ statusCode: string; count: string }>();

    // 高峰期 QPS（按 1 分钟窗口统计的最大值）
    let peakQPS = 0;
    try {
      const peak = await this.accessLogRepo
        .createQueryBuilder('log')
        .select("DATE_TRUNC('minute', log.createdAt)", 'bucket')
        .addSelect('COUNT(*)', 'count')
        .where('log.createdAt >= :since', { since })
        .groupBy('bucket')
        .orderBy('count', 'DESC')
        .limit(1)
        .getRawOne<{ count: string }>();
      if (peak) {
        peakQPS = Math.ceil(Number(peak.count) / 60);
      }
    } catch {
      // DATE_TRUNC 在部分 PostgreSQL 版本不兼容时忽略
    }

    const totalRequests = Number(raw?.totalRequests || 0);
    const errorCount = statusDistribution
      .filter((s) => Number(s.statusCode) >= 400)
      .reduce((sum, s) => sum + Number(s.count), 0);
    const errorRate = totalRequests > 0 ? parseFloat(((errorCount / totalRequests) * 100).toFixed(2)) : 0;

    return {
      totalRequests,
      totalBandwidth: Number(raw?.totalBandwidth || 0),
      uniqueVisitors: Number(raw?.uniqueVisitors || 0),
      peakQPS,
      statusDistribution: statusDistribution.map((s) => ({
        statusCode: Number(s.statusCode),
        count: Number(s.count),
      })),
      errorRate,
    };
  }

  async getAccessLogTrend(timeRange?: string): Promise<{ time: string; requests: number; bandwidth: number }[]> {
    const since = this.parseTimeRange(timeRange || '24h');

    // 根据时间范围选择聚合粒度
    let trunc: string;
    switch (timeRange) {
      case '1h': trunc = 'minute'; break;
      case '24h': trunc = 'hour'; break;
      case '7d': trunc = 'hour'; break;
      default: trunc = 'day';
    }

    const raw = await this.accessLogRepo
      .createQueryBuilder('log')
      .select(`DATE_TRUNC('${trunc}', log.createdAt)`, 'time')
      .addSelect('COUNT(*)', 'requests')
      .addSelect('COALESCE(SUM(log.responseSize), 0)', 'bandwidth')
      .where('log.createdAt >= :since', { since })
      .groupBy('time')
      .orderBy('time', 'ASC')
      .getRawMany<{ time: string; requests: string; bandwidth: string }>();

    return raw.map((r) => ({
      time: r.time,
      requests: Number(r.requests),
      bandwidth: Number(r.bandwidth),
    }));
  }

  // ==================== 审计日志查询 ====================

  async getAuditLogs(query: {
    page?: number;
    limit?: number;
    action?: string;
    userId?: string;
    timeRange?: string;
  }): Promise<{ items: AuditLog[]; total: number }> {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const since = this.parseTimeRange(query.timeRange || '24h');

    const qb = this.auditLogRepo
      .createQueryBuilder('log')
      .where('log.createdAt >= :since', { since });

    if (query.action) {
      qb.andWhere('log.action = :action', { action: query.action });
    }

    if (query.userId) {
      qb.andWhere('log.userId = :userId', { userId: query.userId });
    }

    const total = await qb.getCount();

    const items = await qb
      .orderBy('log.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return { items, total };
  }
}
