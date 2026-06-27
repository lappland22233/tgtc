import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { UAParser } from 'ua-parser-js';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, SelectQueryBuilder } from 'typeorm';
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
import { ExportService, ExportOptions } from './export.service';
import {
  TopFilesQueryDto,
  TopPathsQueryDto,
  DateRangeQueryDto,
  StatusByPathQueryDto,
  AbnormalIpsQueryDto,
  RefererAnalysisQueryDto,
  UserAgentAnalysisQueryDto,
  BandwidthQueryDto,
  FileTypeQueryDto,
} from './admin-stats.dto';

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
    private exportService: ExportService,
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

  /** 审计日志中需脱敏的敏感配置键 */
  private readonly SENSITIVE_KEYS = new Set([
    'SMTP_PASSWORD',
    'TELEGRAM_BOT_TOKEN',
    'JWT_SECRET',
    'COOKIE_SECRET',
    'DB_PASSWORD',
  ]);

  async updateConfig(user: User, key: string, value: string, description?: string): Promise<void> {
    await this.setConfigValue(key, value, description);

    // 审计日志：配置变更（敏感键脱敏）
    const sanitizedValue = this.SENSITIVE_KEYS.has(key)
      ? '***'
      : value.substring(0, 100);

    this.auditService.log({
      action: 'config_change',
      userId: user.id,
      resourceType: 'config',
      resourceId: key,
      metadata: { value: sanitizedValue, description },
    });
  }

  /** 仅写入配置不记录审计（供批量操作内部调用，避免重复记录） */
  private async setConfigValue(key: string, value: string, description?: string): Promise<void> {
    await this.configCacheService.set(key, value, description);
  }

  async updateConfigs(user: User, configs: { key: string; value: string; description?: string }[]): Promise<void> {
    await this.configCacheService.setBatch(configs);

    // 审计日志：批量配置变更
    this.auditService.log({
      action: 'config_change',
      userId: user.id,
      resourceType: 'config',
      resourceId: 'batch',
      metadata: { keys: configs.map(c => c.key) },
    });
  }

  async getBannedIPs(): Promise<BannedIP[]> {
    return this.bannedIPRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  async banIP(user: User, ip: string, reason?: string, permanent = true, expiresAt?: Date): Promise<void> {
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
      userId: user.id,
      resourceType: 'ip',
      resourceId: ip,
      metadata: { reason, permanent },
    });
  }

  async unbanIP(user: User, ip: string): Promise<void> {
    const bannedIP = await this.bannedIPRepository.findOne({ where: { ip } });

    if (!bannedIP) {
      throw new NotFoundException('该IP未被封禁');
    }

    await this.bannedIPRepository.delete(bannedIP.id);

    // 审计日志：IP 解封
    this.auditService.log({
      action: 'ip_unban',
      userId: user.id,
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

  async deleteFile(user: User, id: string): Promise<void> {
    const file = await this.fileRepository.findOne({ where: { id } });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    file.isDeleted = true;
    await this.fileRepository.save(file);

    // 审计日志：管理员删除文件
    this.auditService.log({
      action: 'file_delete',
      userId: user.id,
      resourceType: 'file',
      resourceId: id,
      metadata: { filename: file.originalName },
    });
  }

  async batchDeleteFiles(user: User, ids: string[]): Promise<void> {
    await this.fileRepository.update(ids, { isDeleted: true });

    // 审计日志：批量删除文件
    this.auditService.log({
      action: 'batch_delete_files',
      userId: user.id,
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

  async updateAuthConfig(user: User, config: {
    registrationEnabled?: boolean;
    emailVerificationEnabled?: boolean;
  }): Promise<void> {
    if (config.registrationEnabled !== undefined) {
      await this.setConfigValue('REGISTRATION_ENABLED', config.registrationEnabled.toString(), '是否允许新用户注册');
    }
    if (config.emailVerificationEnabled !== undefined) {
      await this.setConfigValue('EMAIL_VERIFICATION_ENABLED', config.emailVerificationEnabled.toString(), '是否开启邮箱验证码');
    }

    // 审计日志：认证配置变更
    this.auditService.log({
      action: 'auth_config_change',
      userId: user.id,
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

  async updateSMTPConfig(user: User, config: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    from: string;
  }): Promise<void> {
    await this.configCacheService.setBatch([
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
      userId: user.id,
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

  async updateUploadConfig(user: User, config: {
    maxFileSize?: number;
    fileTypeMode?: string;
    fileTypeFilter?: string;
  }): Promise<void> {
    if (config.maxFileSize !== undefined) {
      await this.setConfigValue('MAX_FILE_SIZE', config.maxFileSize.toString(), '最大文件大小（字节）');
    }

    if (config.fileTypeMode !== undefined) {
      await this.setConfigValue('FILE_TYPE_MODE', config.fileTypeMode, '文件类型过滤模式（blacklist/whitelist）');
    }

    if (config.fileTypeFilter !== undefined) {
      await this.setConfigValue('FILE_TYPE_FILTER', config.fileTypeFilter, '文件类型过滤列表（逗号分隔）');
    }

    // 审计日志：上传配置变更
    this.auditService.log({
      action: 'upload_config_change',
      userId: user.id,
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
  }): Promise<{ items: (AuditLog & { username?: string })[]; total: number }> {
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const since = this.parseTimeRange(query.timeRange || '24h');

    // 基础条件查询（供 count 和 items 共用）
    const baseQb = this.auditLogRepo
      .createQueryBuilder('log')
      .where('log.createdAt >= :since', { since });

    if (query.action) {
      baseQb.andWhere('log.action = :action', { action: query.action });
    }

    if (query.userId) {
      baseQb.andWhere('log.userId = :userId', { userId: query.userId });
    }

    const total = await baseQb.getCount();

    // 带用户名联查的数据查询
    const items = await baseQb
      .leftJoin(User, 'u', 'CAST(u.id AS varchar) = log.userId')
      .select([
        'log.id', 'log.userId', 'log.action', 'log.ip',
        'log.resourceType', 'log.resourceId', 'log.metadata',
        'log.status', 'log.createdAt',
      ])
      .addSelect('u.email', 'username')
      .orderBy('log.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getRawMany();

    return {
      items: items.map(item => ({
        id: item.log_id,
        userId: item.log_userId,
        username: item.username || null,
        action: item.log_action,
        ip: item.log_ip,
        resourceType: item.log_resourceType,
        resourceId: item.log_resourceId,
        metadata: item.log_metadata,
        status: item.log_status,
        createdAt: item.log_createdAt,
      })),
      total,
    };
  }

  // ==================== 高级统计 API ====================

  async getTopFiles(query: TopFilesQueryDto) {
    let since: Date;
    if (query.startDate) {
      since = new Date(query.startDate);
    } else {
      since = this.parseTimeRange(query.timeRange || '24h');
    }

    const limit = query.limit || 10;
    const sortBy = query.sortBy || 'accessCount';

    const qb = this.accessLogRepository
      .createQueryBuilder('fal')
      .leftJoin(File, 'f', 'f.id = fal.fileId')
      .select('f.id', 'fileId')
      .addSelect('f."originalName"', 'fileName')
      .addSelect('f."mimeType"', 'mimeType')
      .addSelect('f.size', 'fileSize')
      .addSelect('COUNT(*)::int', 'accessCount')
      .addSelect('SUM(f.size)::bigint', 'totalBandwidth')
      .where('fal.createdAt >= :since', { since })
      .andWhere('f."isDeleted" = false');

    if (query.endDate) {
      qb.andWhere('fal.createdAt <= :until', { until: new Date(query.endDate) });
    }

    if (query.action) {
      qb.andWhere('fal.action = :action', { action: query.action });
    }

    qb.groupBy('f.id, f."originalName", f."mimeType", f.size');

    if (sortBy === 'bandwidth') {
      qb.orderBy('"totalBandwidth"', 'DESC');
    } else {
      qb.orderBy('"accessCount"', 'DESC');
    }

    qb.limit(limit);

    const raw = await qb.getRawMany<{
      fileId: string;
      fileName: string;
      mimeType: string;
      fileSize: string;
      accessCount: string;
      totalBandwidth: string;
    }>();

    return raw.map((r) => ({
      fileId: r.fileId,
      fileName: r.fileName,
      mimeType: r.mimeType,
      fileSize: Number(r.fileSize),
      accessCount: Number(r.accessCount),
      totalBandwidth: r.totalBandwidth,
    }));
  }

  async getTopPaths(query: TopPathsQueryDto) {
    const since = this.parseTimeRange(query.timeRange || '24h');
    const limit = query.limit || 20;

    const qb = this.accessLogRepo
      .createQueryBuilder('log')
      .select('log.path', 'path')
      .addSelect('COUNT(*)::int', 'requestCount')
      .addSelect('SUM(log."responseSize")::bigint', 'totalBandwidth')
      .addSelect('AVG(log.duration)::numeric(10,2)', 'avgDuration')
      .where('log.createdAt >= :since', { since });

    if (query.excludePaths) {
      const patterns = query.excludePaths.split(',').map((p) => p.trim());
      patterns.forEach((pattern, i) => {
        qb.andWhere(`log.path NOT LIKE :exclude${i}`, { [`exclude${i}`]: `%${pattern.replace(/[%_]/g, '\\$&')}%` });
      });
    }

    qb.groupBy('log.path')
      .orderBy('"requestCount"', 'DESC')
      .limit(limit);

    const raw = await qb.getRawMany<{
      path: string;
      requestCount: string;
      totalBandwidth: string;
      avgDuration: string;
    }>();

    return raw.map((r) => ({
      path: r.path,
      requestCount: Number(r.requestCount),
      totalBandwidth: r.totalBandwidth,
      avgDuration: Number(r.avgDuration),
    }));
  }

  async getLatencyStats(query: DateRangeQueryDto) {
    let since: Date;
    if (query.startDate) {
      since = new Date(query.startDate);
    } else {
      since = this.parseTimeRange(query.timeRange || '24h');
    }

    // 先获取总数，判断是否需要采样
    const totalCount = await this.accessLogRepo
      .createQueryBuilder('log')
      .where('log.createdAt >= :since', { since })
      .getCount();

    const samplingThreshold = 1_000_000;
    const sampled = totalCount > samplingThreshold;

    let baseQb: SelectQueryBuilder<AccessLog>;
    if (sampled) {
      // TABLESAMPLE 在 TypeORM 中难以直用，使用 MOD 哈希采样替代
      baseQb = this.accessLogRepo
        .createQueryBuilder('log')
        .where('log.createdAt >= :since', { since })
        .andWhere("(MOD(hashtext(log.id::text), 100)) < 10");
    } else {
      baseQb = this.accessLogRepo
        .createQueryBuilder('log')
        .where('log.createdAt >= :since', { since });
    }

    if (query.endDate) {
      baseQb.andWhere('log.createdAt <= :until', { until: new Date(query.endDate) });
    }

    const stats = await baseQb
      .select([
        'AVG(log.duration)::numeric(10,2) as "avgDuration"',
        'PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY log.duration)::numeric(10,2) as "p50Duration"',
        'PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY log.duration)::numeric(10,2) as "p95Duration"',
        'PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY log.duration)::numeric(10,2) as "p99Duration"',
      ])
      .getRawOne<{
        avgDuration: string;
        p50Duration: string;
        p95Duration: string;
        p99Duration: string;
      }>();

    return {
      avgDuration: Number(stats?.avgDuration || 0),
      p50Duration: Number(stats?.p50Duration || 0),
      p95Duration: Number(stats?.p95Duration || 0),
      p99Duration: Number(stats?.p99Duration || 0),
      totalRequests: totalCount,
      ...(sampled ? { sampled: true } : {}),
    };
  }

  async getStatusByPath(query: StatusByPathQueryDto) {
    const since = this.parseTimeRange(query.timeRange || '24h');
    const limit = query.limit || 50;
    const minCount = query.minCount || 5;

    const qb = this.accessLogRepo
      .createQueryBuilder('log')
      .select('log.path', 'path')
      .addSelect(
        'SUM(CASE WHEN log."statusCode" >= 200 AND log."statusCode" < 300 THEN 1 ELSE 0 END)::int',
        'count2xx',
      )
      .addSelect(
        'SUM(CASE WHEN log."statusCode" >= 300 AND log."statusCode" < 400 THEN 1 ELSE 0 END)::int',
        'count3xx',
      )
      .addSelect(
        'SUM(CASE WHEN log."statusCode" >= 400 AND log."statusCode" < 500 THEN 1 ELSE 0 END)::int',
        'count4xx',
      )
      .addSelect(
        'SUM(CASE WHEN log."statusCode" >= 500 AND log."statusCode" < 600 THEN 1 ELSE 0 END)::int',
        'count5xx',
      )
      .addSelect('COUNT(*)::int', 'totalCount')
      .where('log.createdAt >= :since', { since });

    if (query.statusCode !== undefined) {
      qb.andWhere('log."statusCode" = :statusCode', { statusCode: query.statusCode });
    }

    qb.groupBy('log.path')
      .having('COUNT(*) >= :minCount', { minCount })
      .orderBy('"totalCount"', 'DESC')
      .limit(limit);

    const raw = await qb.getRawMany<{
      path: string;
      count2xx: string;
      count3xx: string;
      count4xx: string;
      count5xx: string;
      totalCount: string;
    }>();

    return raw.map((r) => {
      const total = Number(r.totalCount);
      const errorCount = Number(r.count4xx || 0) + Number(r.count5xx || 0);
      return {
        path: r.path,
        count2xx: Number(r.count2xx),
        count3xx: Number(r.count3xx),
        count4xx: Number(r.count4xx),
        count5xx: Number(r.count5xx),
        totalCount: total,
        errorRate: total > 0 ? parseFloat(((errorCount / total) * 100).toFixed(2)) : 0,
      };
    });
  }

  async getDownloadStats(query: DateRangeQueryDto) {
    let since: Date;
    if (query.startDate) {
      since = new Date(query.startDate);
    } else {
      since = this.parseTimeRange(query.timeRange || '24h');
    }

    // 下载总量
    const [downloadStats] = await this.accessLogRepository
      .createQueryBuilder('fal')
      .select([
        'COUNT(*)::int as "totalDownloads"',
        'SUM(fal."responseSize")::bigint as "totalBandwidth"',
      ])
      .where('fal.action = :action', { action: 'download' })
      .andWhere('fal.createdAt >= :since', { since })
      .getRawMany<{ totalDownloads: string; totalBandwidth: string }>();

    // 下载趋势（按小时聚合）
    const trendRaw = await this.accessLogRepository
      .createQueryBuilder('fal')
      .select("DATE_TRUNC('hour', fal.createdAt)", 'time')
      .addSelect('COUNT(*)::int', 'count')
      .where('fal.action = :action', { action: 'download' })
      .andWhere('fal.createdAt >= :since', { since })
      .groupBy('time')
      .orderBy('time', 'ASC')
      .getRawMany<{ time: string; count: string }>();

    // Top 下载者（按 IP）
    const topDownloadersRaw = await this.accessLogRepository
      .createQueryBuilder('fal')
      .select('fal.ip', 'ip')
      .addSelect('COUNT(*)::int', 'count')
      .addSelect('SUM(fal."responseSize")::bigint', 'bandwidth')
      .where('fal.action = :action', { action: 'download' })
      .andWhere('fal.createdAt >= :since', { since })
      .groupBy('fal.ip')
      .orderBy('count', 'DESC')
      .limit(20)
      .getRawMany<{ ip: string; count: string; bandwidth: string }>();

    return {
      totalDownloads: Number(downloadStats?.totalDownloads || 0),
      totalBandwidth: downloadStats?.totalBandwidth || '0',
      trend: trendRaw.map((r) => ({
        time: r.time,
        count: Number(r.count),
      })),
      topDownloaders: topDownloadersRaw.map((r) => ({
        ip: r.ip,
        count: Number(r.count),
        bandwidth: r.bandwidth,
      })),
    };
  }

  async getAbnormalIps(query: AbnormalIpsQueryDto) {
    const since = this.parseTimeRange(query.timeRange || '24h');
    const limit = query.limit || 20;
    const minRequests = query.minRequests || 100;
    const sortBy = query.sortBy || 'requestCount';

    const raw = await this.accessLogRepo
      .createQueryBuilder('log')
      .select('log.ip', 'ip')
      .addSelect('COUNT(*)::int', 'requestCount')
      .addSelect(
        'SUM(CASE WHEN log."statusCode" >= 400 THEN 1 ELSE 0 END)::int',
        'errorCount',
      )
      .addSelect('SUM(log."responseSize")::bigint', 'bandwidth')
      .addSelect('COUNT(DISTINCT log.path)::int', 'uniquePaths')
      .where('log.createdAt >= :since', { since })
      .groupBy('log.ip')
      .having('COUNT(*) >= :minCount', { minCount: minRequests })
      .orderBy(sortBy === 'errorRate'
        ? 'SUM(CASE WHEN log."statusCode" >= 400 THEN 1 ELSE 0 END) * 1.0 / COUNT(*)'
        : sortBy === 'bandwidth' ? '"bandwidth"' : '"requestCount"',
        'DESC')
      .limit(limit)
      .getRawMany<{
        ip: string;
        requestCount: string;
        errorCount: string;
        bandwidth: string;
        uniquePaths: string;
      }>();

    return raw.map((r) => {
      const requestCount = Number(r.requestCount);
      const errorCount = Number(r.errorCount);
      const errorRate = requestCount > 0
        ? parseFloat(((errorCount / requestCount) * 100).toFixed(2))
        : 0;
      const uniquePaths = Number(r.uniquePaths);

      let riskLevel: string;
      if (errorRate >= 50 || requestCount >= 10000) {
        riskLevel = 'critical';
      } else if (errorRate >= 30 || requestCount >= 5000) {
        riskLevel = 'high';
      } else if (errorRate >= 10 || requestCount >= 1000) {
        riskLevel = 'medium';
      } else {
        riskLevel = 'low';
      }

      return {
        ip: r.ip,
        requestCount,
        errorRate,
        bandwidth: r.bandwidth,
        uniquePaths,
        riskLevel,
      };
    });
  }

  async getBanStats() {
    const [
      [banCounts],
      recentBans,
      unbanAuditCount,
    ] = await Promise.all([
      this.bannedIPRepository
        .createQueryBuilder('b')
        .select([
          'COUNT(*)::int as "totalBanned"',
          'SUM(CASE WHEN b."isPermanent" = false AND (b."expiresAt" IS NULL OR b."expiresAt" > NOW()) THEN 1 ELSE 0 END)::int as "activeTemporary"',
          'SUM(CASE WHEN b."isPermanent" = true THEN 1 ELSE 0 END)::int as "permanentBans"',
        ])
        .getRawMany<{ totalBanned: string; activeTemporary: string; permanentBans: string }>(),
      this.bannedIPRepository
        .createQueryBuilder('b')
        .select(['b.ip', 'b.reason', 'b."isPermanent"', 'b."createdAt"'])
        .orderBy('b."createdAt"', 'DESC')
        .limit(10)
        .getRawMany<{ b_ip: string; b_reason: string | null; b_isPermanent: boolean; b_createdAt: Date }>(),
      this.auditLogRepo
        .createQueryBuilder('a')
        .where('a.action = :action', { action: 'ip_unban' })
        .getCount(),
    ]);

    const permanentBans = Number(banCounts?.permanentBans || 0);
    const activeTemporary = Number(banCounts?.activeTemporary || 0);
    const totalBanned = Number(banCounts?.totalBanned || 0);
    const temporaryBans = totalBanned - permanentBans;
    const unbanCount = unbanAuditCount;
    const totalActions = totalBanned + unbanCount;
    const unbanRatio = totalActions > 0
      ? parseFloat(((unbanCount / totalActions) * 100).toFixed(2))
      : 0;

    return {
      totalBanned,
      activeBans: permanentBans + activeTemporary,
      permanentBans,
      temporaryBans,
      recentBans: recentBans.map((r) => ({
        ip: r.b_ip,
        reason: r.b_reason || null,
        createdAt: r.b_createdAt,
      })),
      unbanRatio,
    };
  }

  // ==================== Phase 2: 来源分析 ====================

  async getRefererAnalysis(query: RefererAnalysisQueryDto) {
    const since = this.parseTimeRange(query.timeRange || '7d');

    const raw = await this.accessLogRepo.manager.query(
      `SELECT referer, COUNT(*)::int as count
       FROM access_logs
       WHERE "createdAt" >= $1 AND referer IS NOT NULL AND referer != ''
       GROUP BY referer
       ORDER BY count DESC
       LIMIT 200`,
      [since],
    ) as { referer: string; count: number }[];

    const total = raw.reduce((sum, r) => sum + r.count, 0);

    // 分类规则
    const searchDomains = ['google.com', 'bing.com', 'baidu.com', 'sogou.com', 'yandex.com', 'duckduckgo.com'];
    const socialDomains = ['facebook.com', 'twitter.com', 'x.com', 'linkedin.com', 't.me', 'reddit.com', 'weibo.com', 'zhihu.com'];
    const siteDomain = process.env.APP_URL ? new URL(process.env.APP_URL).hostname : '';

    const categories = new Map<string, number>();
    categories.set('搜索引擎', 0);
    categories.set('社交媒体', 0);
    categories.set('直接访问', 0);
    categories.set('本站内链', 0);
    categories.set('外部网站', 0);

    // Add direct access count
    const directResult = await this.accessLogRepo.manager.query(
      `SELECT COUNT(*)::int as count FROM access_logs
       WHERE "createdAt" >= $1 AND (referer IS NULL OR referer = '')`,
      [since],
    );
    const directCount = directResult[0]?.count || 0;
    categories.set('直接访问', directCount);

    const totalWithDirect = total + directCount;

    // Categorize referers
    for (const r of raw) {
      let hostname = '';
      try { hostname = new URL(r.referer).hostname.replace(/^www\./, '').toLowerCase(); } catch { continue; }

      if (searchDomains.some((d) => hostname.includes(d))) {
        categories.set('搜索引擎', (categories.get('搜索引擎') || 0) + r.count);
      } else if (socialDomains.some((d) => hostname.includes(d))) {
        categories.set('社交媒体', (categories.get('社交媒体') || 0) + r.count);
      } else if (siteDomain && hostname.includes(siteDomain)) {
        categories.set('本站内链', (categories.get('本站内链') || 0) + r.count);
      } else {
        categories.set('外部网站', (categories.get('外部网站') || 0) + r.count);
      }
    }

    // Extract search keywords
    const keywords = new Map<string, number>();
    for (const r of raw) {
      try {
        const url = new URL(r.referer);
        let keyword = '';
        const host = url.hostname.replace(/^www\./, '').toLowerCase();
        if (host.includes('google.com')) {
          keyword = url.searchParams.get('q') || '';
        } else if (host.includes('baidu.com')) {
          keyword = url.searchParams.get('wd') || '';
        } else if (host.includes('bing.com')) {
          keyword = url.searchParams.get('q') || '';
        }
        if (keyword) {
          keywords.set(keyword, (keywords.get(keyword) || 0) + r.count);
        }
      } catch { /* ignore parse errors */ }
    }

    const topKeywords = Array.from(keywords.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([keyword, count]) => ({ keyword, count }));

    return {
      categories: Array.from(categories.entries()).map(([name, count]) => ({
        name,
        count,
        percentage: totalWithDirect > 0
          ? parseFloat(((count / totalWithDirect) * 100).toFixed(2))
          : 0,
      })),
      topReferers: raw.slice(0, 20).map((r) => ({
        referer: r.referer,
        count: r.count,
      })),
      topKeywords: topKeywords.length > 0 ? topKeywords : undefined,
    };
  }

  async getUserAgentAnalysis(query: UserAgentAnalysisQueryDto) {
    const since = this.parseTimeRange(query.timeRange || '7d');
    const topN = query.topN || 500;

    const raw = await this.accessLogRepo.manager.query(
      `SELECT "userAgent", COUNT(*)::int as count
       FROM access_logs
       WHERE "createdAt" >= $1 AND "userAgent" IS NOT NULL AND "userAgent" != ''
       GROUP BY "userAgent"
       ORDER BY count DESC
       LIMIT $2`,
      [since, topN],
    ) as { userAgent: string; count: number }[];

    const parser = new UAParser();
    const total = raw.reduce((sum, r) => sum + r.count, 0);

    // Aggregate browsers
    const browserMap = new Map<string, { count: number; versions: Map<string, number> }>();
    const osMap = new Map<string, { count: number; versions: Map<string, number> }>();
    const deviceMap = new Map<string, number>();

    for (const r of raw) {
      try {
        parser.setUA(r.userAgent);
        const ua = parser.getResult();

        // Browser
        const browserName = ua.browser.name || 'Other';
        const browserVersion = ua.browser.version || 'Unknown';
        const browserKey = `${browserName}|${browserVersion}`;
        if (!browserMap.has(browserKey)) {
          browserMap.set(browserKey, { count: 0, versions: new Map() });
        }
        const b = browserMap.get(browserKey)!;
        b.count += r.count;
        b.versions.set(browserVersion, (b.versions.get(browserVersion) || 0) + r.count);

        // OS
        const osName = ua.os.name || 'Other';
        const osVersion = ua.os.version || 'Unknown';
        const osKey = `${osName}|${osVersion}`;
        if (!osMap.has(osKey)) {
          osMap.set(osKey, { count: 0, versions: new Map() });
        }
        const o = osMap.get(osKey)!;
        o.count += r.count;
        o.versions.set(osVersion, (o.versions.get(osVersion) || 0) + r.count);

        // Device
        const deviceType = ua.device.type || (r.userAgent.toLowerCase().includes('bot') ? 'bot' : 'desktop');
        deviceMap.set(deviceType, (deviceMap.get(deviceType) || 0) + r.count);
      } catch { /* ignore parse errors */ }
    }

    const browsers = Array.from(browserMap.entries())
      .map(([key, v]) => {
        const [name, version] = key.split('|');
        return { name, version, count: v.count, percentage: parseFloat(((v.count / total) * 100).toFixed(2)) };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const os = Array.from(osMap.entries())
      .map(([key, v]) => {
        const [name, version] = key.split('|');
        return { name, version, count: v.count, percentage: parseFloat(((v.count / total) * 100).toFixed(2)) };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const devices = Array.from(deviceMap.entries())
      .map(([type, count]) => ({ type, count, percentage: parseFloat(((count / total) * 100).toFixed(2)) }))
      .sort((a, b) => b.count - a.count);

    return {
      browsers,
      os,
      devices,
      topUserAgents: raw.slice(0, 30).map((r) => ({
        userAgent: r.userAgent.substring(0, 200),
        count: r.count,
      })),
    };
  }

  // ==================== Phase 3: 活动与消耗分析 ====================

  async getBandwidthAnalysis(query: BandwidthQueryDto) {
    const since = this.parseTimeRange(query.timeRange || '24h');

    const [topFilesRaw, topIpsRaw, trendRaw] = await Promise.all([
      // Top files by bandwidth
      this.accessLogRepository
        .createQueryBuilder('fal')
        .leftJoin(File, 'f', 'f.id = fal.fileId')
        .select('f.id', 'fileId')
        .addSelect('f."originalName"', 'fileName')
        .addSelect('f."mimeType"', 'mimeType')
        .addSelect('SUM(COALESCE(NULLIF(fal."responseSize", 0), f."size"))::bigint', 'totalBandwidth')
        .addSelect('COUNT(*)::int', 'accessCount')
        .where('fal.createdAt >= :since', { since })
        .andWhere('f."isDeleted" = false')
        .groupBy('f.id, f."originalName", f."mimeType"')
        .orderBy('"totalBandwidth"', 'DESC')
        .limit(20)
        .getRawMany<{
          fileId: string;
          fileName: string;
          mimeType: string;
          totalBandwidth: string;
          accessCount: string;
        }>(),
      // Top IPs by bandwidth
      this.accessLogRepository
        .createQueryBuilder('fal')
        .leftJoin(File, 'f', 'f.id = fal.fileId')
        .select('fal.ip', 'ip')
        .addSelect('SUM(COALESCE(NULLIF(fal."responseSize", 0), f.size))::bigint', 'bandwidth')
        .addSelect('COUNT(*)::int', 'requestCount')
        .where('fal.createdAt >= :since', { since })
        .groupBy('fal.ip')
        .orderBy('"bandwidth"', 'DESC')
        .limit(20)
        .getRawMany<{ ip: string; bandwidth: string; requestCount: string }>(),
      // Bandwidth trend (hourly)
      this.accessLogRepository
        .createQueryBuilder('fal')
        .leftJoin(File, 'f', 'f.id = fal.fileId')
        .select("DATE_TRUNC('hour', fal.createdAt)", 'time')
        .addSelect('SUM(COALESCE(NULLIF(fal."responseSize", 0), f.size))::bigint', 'bandwidth')
        .where('fal.createdAt >= :since', { since })
        .groupBy('time')
        .orderBy('time', 'ASC')
        .getRawMany<{ time: string; bandwidth: string }>(),
    ]);

    return {
      topFiles: topFilesRaw.map((r) => ({
        fileId: r.fileId,
        fileName: r.fileName,
        mimeType: r.mimeType,
        totalBandwidth: r.totalBandwidth,
        accessCount: Number(r.accessCount),
      })),
      topIps: topIpsRaw.map((r) => ({
        ip: r.ip,
        bandwidth: r.bandwidth,
        requestCount: Number(r.requestCount),
      })),
      trend: trendRaw.map((r) => ({
        time: r.time,
        bandwidth: r.bandwidth,
      })),
    };
  }

  async getFileTypeStats(_query: FileTypeQueryDto) {
    const files = await this.fileRepository
      .createQueryBuilder('f')
      .select(['f."mimeType"', 'f.size', 'f."accessType"'])
      .where('f."isDeleted" = false')
      .getRawMany<{ f_mimeType: string; f_size: string; f_accessType: string }>();

    const mimeCategories: { name: string; fileCount: number; totalSize: bigint }[] = [
      { name: '图片', fileCount: 0, totalSize: BigInt(0) },
      { name: '视频', fileCount: 0, totalSize: BigInt(0) },
      { name: '音频', fileCount: 0, totalSize: BigInt(0) },
      { name: '文档', fileCount: 0, totalSize: BigInt(0) },
      { name: '压缩包', fileCount: 0, totalSize: BigInt(0) },
      { name: '其他', fileCount: 0, totalSize: BigInt(0) },
    ];

    let totalSize = BigInt(0);

    for (const f of files) {
      const mime = (f.f_mimeType || '').toLowerCase();
      const size = BigInt(f.f_size || '0');
      totalSize += size;

      let category: string;
      if (mime.startsWith('image/')) {
        category = '图片';
      } else if (mime.startsWith('video/')) {
        category = '视频';
      } else if (mime.startsWith('audio/')) {
        category = '音频';
      } else if (/pdf|document|spreadsheet|presentation|text|msword|officedocument|opendocument/.test(mime)) {
        category = '文档';
      } else if (/zip|rar|7z|tar|gz|compress|archive/.test(mime)) {
        category = '压缩包';
      } else {
        category = '其他';
      }

      const cat = mimeCategories.find((c) => c.name === category)!;
      cat.fileCount++;
      cat.totalSize += size;
    }

    const categories = mimeCategories.map((c) => ({
      name: c.name,
      fileCount: c.fileCount,
      totalSize: c.totalSize.toString(),
      percentage: totalSize > BigInt(0)
        ? parseFloat(((Number(c.totalSize) / Number(totalSize)) * 100).toFixed(2))
        : 0,
    }));

    return { categories };
  }

  async getUserActivityStats(query: DateRangeQueryDto) {
    let since: Date;
    if (query.startDate) {
      since = new Date(query.startDate);
    } else {
      since = this.parseTimeRange(query.timeRange || '24h');
    }

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const monthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);

    const [dauResult, wauResult, mauResult, newUsersResult, topUsersRaw] = await Promise.all([
      this.accessLogRepo
        .createQueryBuilder('log')
        .select('COUNT(DISTINCT log.ip)', 'count')
        .where('log.createdAt >= :today', { today: todayStart })
        .getRawOne<{ count: string }>(),
      this.accessLogRepo
        .createQueryBuilder('log')
        .select('COUNT(DISTINCT log.ip)', 'count')
        .where('log.createdAt >= :weekAgo', { weekAgo })
        .getRawOne<{ count: string }>(),
      this.accessLogRepo
        .createQueryBuilder('log')
        .select('COUNT(DISTINCT log.ip)', 'count')
        .where('log.createdAt >= :monthAgo', { monthAgo })
        .getRawOne<{ count: string }>(),
      this.userRepository
        .createQueryBuilder('u')
        .select('COUNT(*)', 'count')
        .where('u.createdAt >= :since', { since })
        .getRawOne<{ count: string }>(),
      this.accessLogRepo
        .createQueryBuilder('log')
        .select('log.userId', 'userId')
        .addSelect('log.ip', 'ip')
        .addSelect('COUNT(*)::int', 'requestCount')
        .addSelect('MAX(log.createdAt)', 'lastSeen')
        .where('log.createdAt >= :since', { since })
        .andWhere('log.userId IS NOT NULL')
        .groupBy('log.userId, log.ip')
        .orderBy('"requestCount"', 'DESC')
        .limit(20)
        .getRawMany<{ userId: string; ip: string; requestCount: string; lastSeen: string }>(),
    ]);

    return {
      dau: Number(dauResult?.count || 0),
      wau: Number(wauResult?.count || 0),
      mau: Number(mauResult?.count || 0),
      newUsers: Number(newUsersResult?.count || 0),
      topActiveUsers: topUsersRaw.map((r) => ({
        userId: r.userId,
        ip: r.ip,
        requestCount: Number(r.requestCount),
        lastSeen: r.lastSeen,
      })),
    };
  }

  // ==================== Phase 7: 导出 & 对比 ====================

  async exportData(options: ExportOptions) {
    return this.exportService.export(options);
  }

  async getComparison(timeRange: string) {
    const hours = { '1h': 1, '24h': 24, '7d': 168, '30d': 720 }[timeRange] || 168;
    const now = new Date();
    const periodMs = hours * 3600 * 1000;
    const currentSince = new Date(now.getTime() - periodMs);
    const previousSince = new Date(now.getTime() - 2 * periodMs);
    const previousUntil = new Date(now.getTime() - periodMs);

    // 当前周期统计
    const [currentStats] = await this.accessLogRepo.manager.query(
      `SELECT COUNT(*)::int as requests,
              SUM("responseSize")::bigint as bandwidth,
              COUNT(DISTINCT ip)::int as uv
       FROM access_logs WHERE "createdAt" >= $1`,
      [currentSince],
    );

    // 上一周期统计
    const [previousStats] = await this.accessLogRepo.manager.query(
      `SELECT COUNT(*)::int as requests,
              SUM("responseSize")::bigint as bandwidth,
              COUNT(DISTINCT ip)::int as uv
       FROM access_logs WHERE "createdAt" >= $1 AND "createdAt" < $2`,
      [previousSince, previousUntil],
    );

    const calcChange = (current: number, previous: number) => {
      if (previous === 0) return current > 0 ? 100 : 0;
      return parseFloat((((current - previous) / previous) * 100).toFixed(2));
    };

    return {
      period: timeRange,
      current: {
        requests: Number(currentStats?.requests || 0),
        bandwidth: currentStats?.bandwidth || '0',
        uv: Number(currentStats?.uv || 0),
      },
      previous: {
        requests: Number(previousStats?.requests || 0),
        bandwidth: previousStats?.bandwidth || '0',
        uv: Number(previousStats?.uv || 0),
      },
      changes: {
        requests: calcChange(Number(currentStats?.requests || 0), Number(previousStats?.requests || 0)),
        bandwidth: calcChange(Number(currentStats?.bandwidth || 0), Number(previousStats?.bandwidth || 0)),
        uv: calcChange(Number(currentStats?.uv || 0), Number(previousStats?.uv || 0)),
      },
    };
  }
}
