import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { UAParser } from 'ua-parser-js';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, IsNull, SelectQueryBuilder, In } from 'typeorm';
import { SystemConfig } from '../common/entities/system-config.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { File } from '../common/entities/file.entity';
import { User } from '../common/entities/user.entity';
import { FileAccessLog } from '../common/entities/file-access-log.entity';
import { AccessLog } from '../common/entities/access-log.entity';
import { AuditLog } from '../common/entities/audit-log.entity';
import { FileService } from '../file/file.service';
import { MailerService } from '../mailer/mailer.service';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { AuditService } from '../common/services/audit.service';
import { encryptPassword } from '../common/utils/crypto.util';
import { FILE_DELETE_GRACE_MS, FILE_DELETE_COOLDOWN_MS, MS_PER_DAY } from '../common/constants/durations';
import { ExportService, ExportOptions } from './export.service';
import { SEC_CONFIG_META, SEC_CONFIG_DEFAULTS } from './security-config.defaults';
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

/** getStats 仪表盘短 TTL 缓存（毫秒）：30 秒。避免每次刷新都对 users/files/access_logs
 *  全表 COUNT，造成慢查询；可接受秒级延迟的仪表盘指标。 */
const STATS_CACHE_TTL_MS = 30 * 1000;

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  /** G7-04：getStats 结果缓存（短 TTL），避免全表 COUNT 慢查询 */
  private statsCache: { expiresAt: number; value: Awaited<ReturnType<AdminService['computeStats']>> } | null = null;

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
    private mailerService: MailerService,
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
    // G7-04：短 TTL 缓存，避免仪表盘每次刷新都全表 COUNT 造成慢查询
    const now = Date.now();
    if (this.statsCache && this.statsCache.expiresAt > now) {
      return this.statsCache.value;
    }
    const value = await this.computeStats();
    this.statsCache = { expiresAt: now + STATS_CACHE_TTL_MS, value };
    return value;
  }

  private async computeStats(): Promise<{
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
    const rows = await this.systemConfigRepository.find();
    // G7-03：敏感配置键（SMTP_PASSWORD 等凭据）不回显给任何 ADMIN，返回掩码 `***`，
    // 防止管理端读取密文/明文凭据造成泄漏面。
    return rows.map((row) => {
      if (this.SENSITIVE_KEYS.has(row.key)) {
        return { ...row, value: '***' };
      }
      return row;
    });
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
    'TURNSTILE_SECRET_KEY',
  ]);

  /**
   * 通用配置写入的 key 白名单。
   * 仅允许通过通用入口修改此白名单内的普通配置键；安全规则（sec_*）与敏感凭据
   * （SMTP_PASSWORD 等）一律走各自专用端点（updateSecurityConfig / updateSMTPConfig），
   * 防止通过通用入口绕过安全校验或写入明文密码。
   */
  private static readonly GENERIC_CONFIG_KEY_WHITELIST = new Set([
    'MAX_FILE_SIZE',
    'FILE_TYPE_MODE',
    'FILE_TYPE_FILTER',
    'FILE_ACCESS_COUNT_DEFAULT',
    'FILE_ACCESS_COUNT_MAX',
    'FILE_CACHE_MAX_SIZE_GB',
    'FILE_CACHE_MIN_FREE_DISK_GB',
    'FILE_CACHE_TTL_DAYS',
    'FILE_CACHE_NO_CACHE_MODE',
    'REGISTRATION_ENABLED',
    'EMAIL_VERIFICATION_ENABLED',
    'TURNSTILE_ENABLED',
    'TURNSTILE_SITE_KEY',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_SECURE',
    'SMTP_USER',
    'SMTP_FROM',
  ]);

  /** 必须走专用加密/安全端点、禁止通用写入的键 */
  private static readonly GENERIC_CONFIG_FORBIDDEN_KEYS = new Set([
    'SMTP_PASSWORD',
    'TELEGRAM_BOT_TOKEN',
    'JWT_SECRET',
    'COOKIE_SECRET',
    'DB_PASSWORD',
    'TURNSTILE_SECRET_KEY',
  ]);

  /**
   * 校验通用配置写入的 key 是否被允许。
   * sec_* 安全键、敏感凭据键、以及白名单之外的未知键一律拒绝。
   */
  private assertGenericConfigKeyAllowed(key: string): void {
    if (key.startsWith('sec_')) {
      throw new BadRequestException(`安全配置键 ${key} 必须通过安全配置专用端点更新`);
    }
    if (AdminService.GENERIC_CONFIG_FORBIDDEN_KEYS.has(key)) {
      throw new BadRequestException(`敏感配置键 ${key} 必须通过专用端点更新`);
    }
    if (!AdminService.GENERIC_CONFIG_KEY_WHITELIST.has(key)) {
      throw new BadRequestException(`不允许通过通用配置端点修改未声明的键: ${key}`);
    }
  }

  async updateConfig(user: User, key: string, value: string, description?: string): Promise<void> {
    this.assertGenericConfigKeyAllowed(key);
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
    // 逐键执行通用写入白名单校验，防止批量入口绕过安全规则/明文写敏感键
    for (const c of configs) {
      this.assertGenericConfigKeyAllowed(c.key);
    }
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
    const normalizedExpiry = permanent ? null : expiresAt;
    if (!permanent && (!normalizedExpiry || !Number.isFinite(normalizedExpiry.getTime()) || normalizedExpiry <= new Date())) {
      throw new BadRequestException('临时封禁必须提供晚于当前时间的到期时间');
    }

    // 单条 UPSERT 同时覆盖首次封禁和历史记录重新激活；活跃记录不更新。
    // 避免 findOne→insert/update 的 TOCTOU，并确保并发请求只有一个成功。
    const rows = await this.bannedIPRepository.manager.query(
      `INSERT INTO banned_ips (id, ip, reason, "isPermanent", "expiresAt", "unbanned_at", "createdAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, NULL, NOW())
       ON CONFLICT (ip) DO UPDATE SET
         reason = COALESCE(EXCLUDED.reason, banned_ips.reason),
         "isPermanent" = EXCLUDED."isPermanent",
         "expiresAt" = EXCLUDED."expiresAt",
         "unbanned_at" = NULL,
         "createdAt" = NOW()
       WHERE banned_ips."unbanned_at" IS NOT NULL
       RETURNING id`,
      [ip, reason ?? null, permanent, normalizedExpiry ?? null],
    );
    if (!rows || rows.length === 0) {
      throw new BadRequestException('该IP已被封禁');
    }

    await this.auditService.logAwait({
      action: 'ip_ban',
      userId: user.id,
      resourceType: 'ip',
      resourceId: ip,
      metadata: { reason, permanent, expiresAt: normalizedExpiry?.toISOString() ?? null },
    });
  }

  async unbanIP(user: User, ip: string): Promise<void> {
    const bannedIP = await this.bannedIPRepository
      .createQueryBuilder('b')
      .where('b.ip = :ip', { ip })
      .andWhere('b.unbannedAt IS NULL')
      .getOne();

    if (!bannedIP) {
      throw new NotFoundException('该IP未被封禁');
    }

    await this.bannedIPRepository.update(bannedIP.id, { unbannedAt: new Date() });

    this.auditService.log({
      action: 'ip_unban',
      userId: user.id,
      resourceType: 'ip',
      resourceId: ip,
    });
  }

  async cleanupExpiredBans(): Promise<void> {
    await this.bannedIPRepository.update(
      { isPermanent: false, expiresAt: LessThan(new Date()), unbannedAt: IsNull() },
      { unbannedAt: new Date() },
    );
  }

  async getAllFiles(page = 1, limit = 20, keyword?: string, userId?: string, sortBy?: string, sortOrder?: string, cursor?: string): Promise<{ files: File[]; total: number; nextCursor?: string | null }> {
    return this.fileService.findAll(page, limit, userId, keyword, true, sortBy, sortOrder, cursor);
  }

  /**
   * 管理员删除用户文件（双重确认机制）：
   * - 第一次请求：标记文件进入 7 天冷静期（deletedByAdmin=true，普通用户不可恢复）
   * - 第二次请求：永久强制删除（从 Telegram + 数据库移除，无视冷静期）
   * 管理员不受 10 分钟冷却窗口限制，可立即请求第二次确认删除
   */
  async deleteFile(user: User, id: string): Promise<{ message: string }> {
    const file = await this.fileRepository.findOne({ where: { id } });

    if (!file) {
      throw new NotFoundException('文件不存在');
    }

    const now = new Date();

    // 第二步：文件已标记删除 → 永久强制删除
    if (file.isDeleted && file.deletedByAdmin) {
      await this.fileService.forceDelete(id, user);
      return { message: '文件已永久删除' };
    }

    // 第一步：标记为已删除（管理员无视冷却窗口，直接覆盖）
    file.isDeleted = true;
    file.deletedByAdmin = true;
    file.deleteRequestedAt = now;
    file.deleteScheduledAt = new Date(now.getTime() + FILE_DELETE_GRACE_MS);
    file.deleteCooldownUntil = new Date(now.getTime() + FILE_DELETE_COOLDOWN_MS);
    await this.fileRepository.save(file);

    // 审计日志：管理员标记删除
    await this.auditService.logAwait({
      action: 'file_delete_by_admin',
      userId: user.id,
      resourceType: 'file',
      resourceId: id,
      metadata: {
        filename: file.originalName,
        scheduledAt: file.deleteScheduledAt.toISOString(),
      },
    });

    return { message: `文件已标记为待删除（7 天后永久删除），再次请求将立即强制删除` };
  }

  async batchDeleteFiles(user: User, ids: string[]): Promise<void> {
    // 先查询存在的、未删除的文件
    const existingFiles = await this.fileRepository.find({
      where: { id: In(ids), isDeleted: false },
      select: ['id', 'originalName'],
    });

    if (existingFiles.length === 0) {
      throw new NotFoundException('未找到可删除的文件');
    }

    const now = new Date();
    const scheduledAt = new Date(now.getTime() + FILE_DELETE_GRACE_MS);
    const cooldownUntil = new Date(now.getTime() + FILE_DELETE_COOLDOWN_MS);

    const existingIds = existingFiles.map(f => f.id);
    await this.fileRepository.update(existingIds, {
      isDeleted: true,
      deletedByAdmin: true,
      deleteRequestedAt: now,
      deleteScheduledAt: scheduledAt,
      deleteCooldownUntil: cooldownUntil,
    });

    // 审计日志：批量删除文件，记录实际删除数量
    await this.auditService.logAwait({
      action: 'batch_delete_files_by_admin',
      userId: user.id,
      resourceType: 'file',
      metadata: {
        count: existingIds.length,
        requestedCount: ids.length,
        ids: existingIds,
        files: existingFiles.map(f => f.originalName),
        scheduledAt: scheduledAt.toISOString(),
      },
    });
  }

  async getAuthConfig(): Promise<{
    registrationEnabled: boolean;
    emailVerificationEnabled: boolean;
    turnstileEnabled: boolean;
    siteKey: string;
    secretKey: string;
    hostnames: string;
  }> {
    const [registrationEnabled, emailVerificationEnabled, turnstileEnabled, siteKey, secretKey, hostnames] = await Promise.all([
      this.getConfigByKey('REGISTRATION_ENABLED'),
      this.getConfigByKey('EMAIL_VERIFICATION_ENABLED'),
      this.getConfigByKey('TURNSTILE_ENABLED'),
      this.getConfigByKey('TURNSTILE_SITE_KEY'),
      this.getConfigByKey('TURNSTILE_SECRET_KEY'),
      this.getConfigByKey('TURNSTILE_HOSTNAMES'),
    ]);

    return {
      registrationEnabled: registrationEnabled === 'true',
      emailVerificationEnabled: emailVerificationEnabled === 'true',
      turnstileEnabled: turnstileEnabled === 'true',
      siteKey: siteKey || '',
      // 管理端只接收掩码；密钥从不回显明文，留空提交时由服务端保留原密文。
      secretKey: secretKey ? '***' : '',
      hostnames: hostnames || '',
    };
  }

  async updateAuthConfig(user: User, config: {
    registrationEnabled?: boolean;
    emailVerificationEnabled?: boolean;
    turnstileEnabled?: boolean;
    siteKey?: string;
    secretKey?: string;
    hostnames?: string;
  }): Promise<void> {
    const current = await Promise.all([
      this.getConfigByKey('TURNSTILE_SITE_KEY'),
      this.getConfigByKey('TURNSTILE_SECRET_KEY'),
      this.getConfigByKey('TURNSTILE_HOSTNAMES'),
    ]);
    const enabled = config.turnstileEnabled ?? (await this.getConfigByKey('TURNSTILE_ENABLED')) === 'true';
    const siteKey = (config.siteKey ?? current[0] ?? '').trim();
    const hostnames = (config.hostnames ?? current[2] ?? '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
    const secretKey = config.secretKey?.trim();
    const hasSecret = secretKey && secretKey !== '***' ? true : Boolean(current[1]);
    if (enabled && (!siteKey || !hasSecret || hostnames.length === 0)) {
      throw new BadRequestException('开启 Turnstile 时必须完整配置 Site Key、Secret Key 和可信 Hostname');
    }
    const entries = [
      { key: 'REGISTRATION_ENABLED', value: String(config.registrationEnabled ?? (await this.getConfigByKey('REGISTRATION_ENABLED'))), description: '是否允许新用户注册' },
      { key: 'EMAIL_VERIFICATION_ENABLED', value: String(config.emailVerificationEnabled ?? (await this.getConfigByKey('EMAIL_VERIFICATION_ENABLED'))), description: '是否开启邮箱验证码' },
      { key: 'TURNSTILE_ENABLED', value: String(enabled), description: '是否开启 Cloudflare Turnstile' },
      { key: 'TURNSTILE_SITE_KEY', value: siteKey, description: 'Cloudflare Turnstile Site Key' },
      { key: 'TURNSTILE_HOSTNAMES', value: hostnames.join(','), description: 'Cloudflare Turnstile 可信 Hostname 列表' },
      ...(secretKey && secretKey !== '***' ? [{ key: 'TURNSTILE_SECRET_KEY', value: encryptPassword(secretKey), description: 'Cloudflare Turnstile Secret Key（已加密）' }] : []),
    ];
    await this.configCacheService.setBatch(entries);

    this.auditService.log({
      action: 'auth_config_change',
      userId: user.id,
      resourceType: 'config',
      resourceId: 'auth',
      metadata: {
        ...config,
        secretKey: config.secretKey ? '***' : undefined,
        hostnames: hostnames.join(','),
      },
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
    password?: string;
    from: string;
  }): Promise<void> {
    // 密码留空/未传时保留数据库中已有密文（GET 接口不回显密码，前端二次保存不会重输）
    let passwordValue: string;
    if (config.password) {
      passwordValue = encryptPassword(config.password);
    } else {
      passwordValue = await this.configCacheService.get('SMTP_PASSWORD', '');
    }

    await this.configCacheService.setBatch([
      { key: 'SMTP_HOST', value: config.host, description: 'SMTP服务器地址' },
      { key: 'SMTP_PORT', value: config.port.toString(), description: 'SMTP服务器端口' },
      { key: 'SMTP_SECURE', value: config.secure.toString(), description: '是否使用SSL' },
      { key: 'SMTP_USER', value: config.user, description: 'SMTP用户名' },
      { key: 'SMTP_PASSWORD', value: passwordValue, description: 'SMTP密码（已加密）' },
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

  /** 发送 SMTP 测试邮件，使用当前生效配置（含刚保存未重启的 DB 配置） */
  async sendTestSMTPMail(user: User, recipient: string): Promise<void> {
    await this.mailerService.sendTestEmail(recipient);

    // 审计日志：SMTP 测试发送
    this.auditService.log({
      action: 'smtp_test_mail',
      userId: user.id,
      resourceType: 'config',
      resourceId: 'smtp',
      metadata: { recipient },
    });
  }

  async getUploadConfig(): Promise<{
    maxFileSize: number;
    fileTypeMode: string;
    fileTypeFilter: string;
    accessCountDefault: number;
    accessCountMax: number;
  }> {
    const [maxFileSize, fileTypeMode, fileTypeFilter, accessCountDefault, accessCountMax] = await Promise.all([
      this.getConfigByKey('MAX_FILE_SIZE'),
      this.getConfigByKey('FILE_TYPE_MODE'),
      this.getConfigByKey('FILE_TYPE_FILTER'),
      this.getConfigByKey('FILE_ACCESS_COUNT_DEFAULT'),
      this.getConfigByKey('FILE_ACCESS_COUNT_MAX'),
    ]);

    return {
      maxFileSize: parseInt(maxFileSize || '20971520'),
      fileTypeMode: fileTypeMode || 'blacklist',
      fileTypeFilter: fileTypeFilter || '',
      accessCountDefault: parseInt(accessCountDefault || '-1'),
      accessCountMax: parseInt(accessCountMax || '-1'),
    };
  }

  async updateUploadConfig(user: User, config: {
    maxFileSize?: number;
    fileTypeMode?: string;
    fileTypeFilter?: string;
    accessCountDefault?: number;
    accessCountMax?: number;
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

    if (config.accessCountMax !== undefined && config.accessCountMax > 0) {
      if (config.accessCountDefault === undefined || config.accessCountDefault <= 0 || config.accessCountDefault > config.accessCountMax) {
        throw new BadRequestException('存在最大访问次数限制时，默认访问次数必须为 1 到最大值之间');
      }
    }

    if (config.accessCountDefault !== undefined) {
      await this.setConfigValue('FILE_ACCESS_COUNT_DEFAULT', String(config.accessCountDefault), '新上传文件默认访问次数（-1 为不限）');
    }

    if (config.accessCountMax !== undefined) {
      await this.setConfigValue('FILE_ACCESS_COUNT_MAX', String(config.accessCountMax), '用户可设置的最大访问次数（-1 为不限）');
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

  // ==================== 缓存配置 ====================

  async getCacheConfig(): Promise<{
    maxSizeGB: number;
    minFreeDiskGB: number;
    ttlDays: number;
    noCacheMode: boolean;
  }> {
    const [maxSize, minFree, ttl, noCacheMode] = await Promise.all([
      this.getConfigByKey('FILE_CACHE_MAX_SIZE_GB'),
      this.getConfigByKey('FILE_CACHE_MIN_FREE_DISK_GB'),
      this.getConfigByKey('FILE_CACHE_TTL_DAYS'),
      this.getConfigByKey('FILE_CACHE_NO_CACHE_MODE'),
    ]);
    return {
      maxSizeGB: parseFloat(maxSize || '10'),
      minFreeDiskGB: parseFloat(minFree || '1'),
      ttlDays: parseInt(ttl || '3'),
      noCacheMode: noCacheMode === 'true',
    };
  }

  async updateCacheConfig(user: User, config: {
    maxSizeGB?: number;
    minFreeDiskGB?: number;
    ttlDays?: number;
    noCacheMode?: boolean;
  }): Promise<void> {
    if (config.maxSizeGB !== undefined) {
      if (config.maxSizeGB < 1 || config.maxSizeGB > 1000) {
        throw new BadRequestException('缓存上限应在 1-1000 GB 之间');
      }
      await this.setConfigValue('FILE_CACHE_MAX_SIZE_GB', String(config.maxSizeGB), '文件缓存总大小上限 (GB)');
    }
    if (config.minFreeDiskGB !== undefined) {
      if (config.minFreeDiskGB < 0.5 || config.minFreeDiskGB > 100) {
        throw new BadRequestException('磁盘最低剩余空间应在 0.5-100 GB 之间');
      }
      await this.setConfigValue('FILE_CACHE_MIN_FREE_DISK_GB', String(config.minFreeDiskGB), '缓存磁盘最低剩余空间 (GB)');
    }
    if (config.ttlDays !== undefined) {
      if (config.ttlDays < 1 || config.ttlDays > 365) {
        throw new BadRequestException('缓存有效期应在 1-365 天之间');
      }
      await this.setConfigValue('FILE_CACHE_TTL_DAYS', String(config.ttlDays), '文件缓存有效期 (天)');
    }
    if (config.noCacheMode !== undefined) {
      await this.setConfigValue('FILE_CACHE_NO_CACHE_MODE', String(config.noCacheMode), '无缓存模式：文件下载实时回源直通，不读写本地缓存');
    }

    this.auditService.log({
      action: 'cache_config_change',
      userId: user.id,
      resourceType: 'config',
      resourceId: 'file_cache',
      metadata: config,
    });
  }

  // ==================== 访问日志统计 ====================

  private parseTimeRange(timeRange: string): Date {
    const now = new Date();
    switch (timeRange) {
      case '1h': return new Date(now.getTime() - 60 * 60 * 1000);
      case '24h': return new Date(now.getTime() - 24 * 60 * 60 * 1000);
      case '7d': return new Date(now.getTime() - 7 * MS_PER_DAY);
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
    } catch (error) {
      // DATE_TRUNC 在部分 PostgreSQL 版本不兼容时记录警告，peakQPS 保持为 0
      this.logger.warn(`peakQPS 计算失败: ${error instanceof Error ? error.message : String(error)}`);
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
      .select('DATE_TRUNC(:trunc, log.createdAt)', 'time')
      .addSelect('COUNT(*)', 'requests')
      .addSelect('COALESCE(SUM(log.responseSize), 0)', 'bandwidth')
      .where('log.createdAt >= :since', { since })
      .setParameter('trunc', trunc)
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
    // 将 log.userId（存 UUID 的 varchar）转换为 uuid 与 users 主键关联，
    // 避免对 u.id 做 CAST 导致 users 主键索引失效全表扫描；
    // 用 UUID 正则保护转换，非法/历史脏值安全地返回 NULL 而不抛错。
    const items = await baseQb
      .leftJoin(
        User,
        'u',
        `u.id = CASE
           WHEN log.userId ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           THEN CAST(log.userId AS uuid)
           ELSE NULL
         END`,
      )
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
    // 白名单校验
    if (!['accessCount', 'bandwidth'].includes(sortBy)) {
      throw new BadRequestException(`不支持的排序字段: ${sortBy}`);
    }

    const qb = this.accessLogRepository
      .createQueryBuilder('fal')
      .leftJoin(File, 'f', 'f.id = fal.fileId')
      .select('f.id', 'fileId')
      .addSelect('f."originalName"', 'fileName')
      .addSelect('f."mimeType"', 'mimeType')
      .addSelect('f.size', 'fileSize')
      .addSelect('COUNT(*)::int', 'accessCount')
      .addSelect('SUM(COALESCE(NULLIF(fal."responseSize", 0), f.size))::bigint', 'totalBandwidth')
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
    qb.addOrderBy('f.id', 'ASC');

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
    // G7-05：count 查询与下方数据查询同步追加 endDate 条件，保证区间统计口径一致。
    const countQb = this.accessLogRepo
      .createQueryBuilder('log')
      .where('log.createdAt >= :since', { since });
    if (query.endDate) {
      countQb.andWhere('log.createdAt <= :until', { until: new Date(query.endDate) });
    }
    const totalCount = await countQb.getCount();

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
      banHistory,
      unbanCount,
    ] = await Promise.all([
      this.bannedIPRepository
        .createQueryBuilder('b')
        .select([
          'COUNT(*)::int as "totalBanned"',
          'SUM(CASE WHEN b.unbannedAt IS NOT NULL THEN 1 ELSE 0 END)::int as "historicalBans"',
          'SUM(CASE WHEN b.unbannedAt IS NULL AND (b.isPermanent = true OR b.expiresAt > NOW()) THEN 1 ELSE 0 END)::int as "activeBans"',
          'SUM(CASE WHEN b.unbannedAt IS NULL AND b.isPermanent = true THEN 1 ELSE 0 END)::int as "permanentBans"',
        ])
        .getRawMany<{ totalBanned: string; historicalBans: string; activeBans: string; permanentBans: string }>(),
      this.bannedIPRepository
        .createQueryBuilder('b')
        .select(['b.ip', 'b.reason', 'b.isPermanent', 'b.createdAt', 'b.expiresAt'])
        .where('b.unbannedAt IS NULL')
        .orderBy('b.createdAt', 'DESC')
        .limit(20)
        .getRawMany<{ b_ip: string; b_reason: string | null; b_isPermanent: boolean; b_createdAt: Date; b_expiresAt: Date | null }>(),
      this.bannedIPRepository
        .createQueryBuilder('b')
        .select(['b.ip', 'b.reason', 'b.isPermanent', 'b.createdAt', 'b.unbannedAt'])
        .where('b.unbannedAt IS NOT NULL')
        .orderBy('b.unbannedAt', 'DESC')
        .limit(20)
        .getRawMany<{ b_ip: string; b_reason: string | null; b_isPermanent: boolean; b_createdAt: Date; b_unbannedAt: Date }>(),
      this.auditLogRepo
        .createQueryBuilder('a')
        .where('a.action = :action', { action: 'ip_unban' })
        .getCount(),
    ]);

    const permanentBans = Number(banCounts?.permanentBans || 0);
    const activeBans = Number(banCounts?.activeBans || 0);
    const totalBanned = Number(banCounts?.totalBanned || 0);
    const historicalBans = Number(banCounts?.historicalBans || 0);
    const unbanTotal = totalBanned + unbanCount;
    const unbanRatio = unbanTotal > 0
      ? parseFloat(((unbanCount / unbanTotal) * 100).toFixed(2))
      : 0;

    return {
      totalBanned,
      activeBans,
      permanentBans,
      temporaryBans: activeBans - permanentBans,
      historicalBans,
      recentBans: recentBans.map((r) => ({
        ip: r.b_ip,
        reason: r.b_reason || null,
        isPermanent: r.b_isPermanent,
        createdAt: r.b_createdAt,
        expiresAt: r.b_expiresAt,
      })),
      banHistory: banHistory.map((r) => ({
        ip: r.b_ip,
        reason: r.b_reason || null,
        isPermanent: r.b_isPermanent,
        createdAt: r.b_createdAt,
        unbannedAt: r.b_unbannedAt,
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
    const limit = query.limit || 20;

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
        .addOrderBy('f.id', 'ASC')
        .limit(limit)
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
    // 使用 SQL GROUP BY 在数据库侧完成分类与聚合，避免将全部文件加载进内存
    // （原实现 getRawMany 全量加载后逐条分类，数十万文件易 OOM）
    const rows = await this.fileRepository
      .createQueryBuilder('f')
      .select(
        `CASE
           WHEN LOWER(COALESCE(f."mimeType", '')) LIKE 'image/%' THEN '图片'
           WHEN LOWER(COALESCE(f."mimeType", '')) LIKE 'video/%' THEN '视频'
           WHEN LOWER(COALESCE(f."mimeType", '')) LIKE 'audio/%' THEN '音频'
           WHEN LOWER(COALESCE(f."mimeType", '')) ~ '(pdf|document|spreadsheet|presentation|text|msword|officedocument|opendocument)' THEN '文档'
           WHEN LOWER(COALESCE(f."mimeType", '')) ~ '(zip|rar|7z|tar|gz|compress|archive)' THEN '压缩包'
           ELSE '其他'
         END`,
        'category',
      )
      .addSelect('COUNT(*)', 'fileCount')
      .addSelect('COALESCE(SUM(f.size), 0)', 'totalSize')
      .where('f."isDeleted" = false')
      .groupBy('category')
      .getRawMany<{ category: string; fileCount: string; totalSize: string }>();

    // 固定分类顺序（含零计数分类），与原实现的输出结构保持一致
    const categoryOrder = ['图片', '视频', '音频', '文档', '压缩包', '其他'];
    const byCategory = new Map<string, { fileCount: number; totalSize: bigint }>();
    let totalSize = BigInt(0);

    for (const r of rows) {
      const size = BigInt(r.totalSize || '0');
      byCategory.set(r.category, {
        fileCount: Number(r.fileCount) || 0,
        totalSize: size,
      });
      totalSize += size;
    }

    const categories = categoryOrder.map((name) => {
      const c = byCategory.get(name) || { fileCount: 0, totalSize: BigInt(0) };
      return {
        name,
        fileCount: c.fileCount,
        totalSize: c.totalSize.toString(),
        percentage: totalSize > BigInt(0)
          ? parseFloat(((Number(c.totalSize) / Number(totalSize)) * 100).toFixed(2))
          : 0,
      };
    });

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

  async exportData(user: User, options: ExportOptions) {
    // G7-09：导出入口审计。记录操作人/类型/时间范围；行数在导出完成后回填。
    const result = await this.exportService.export(options);
    const rowCount = this.exportService.countRows(result.data, options.format);
    this.auditService.log({
      action: 'data_export',
      userId: user.id,
      resourceType: 'export',
      resourceId: options.type,
      metadata: {
        format: options.format,
        type: options.type,
        timeRange: options.timeRange,
        rowCount,
        filename: result.filename,
      },
    });
    return result;
  }

  async getComparison(timeRange: string = '7d') {
    const hoursMap: Record<string, number> = { '1h': 1, '24h': 24, '7d': 168, '30d': 720 };
    const hours = hoursMap[timeRange] ?? 168;
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

  // ==================== 安全规则可配置化 ====================

  /**
   * 获取安全配置（含所有规则的当前值、默认值和元数据）
   */
  async getSecurityConfig() {
    const items = await Promise.all(
      SEC_CONFIG_META.map(async (meta) => {
        const current = await this.configCacheService.get(meta.key, SEC_CONFIG_DEFAULTS[meta.key] || '');
        return {
          key: meta.key,
          label: meta.label,
          description: meta.description,
          type: meta.type,
          min: meta.min,
          max: meta.max,
          step: meta.step,
          unit: meta.unit,
          category: meta.category,
          currentValue: current || SEC_CONFIG_DEFAULTS[meta.key] || '',
          defaultValue: SEC_CONFIG_DEFAULTS[meta.key] || '',
        };
      }),
    );

    return items;
  }

  /**
   * 批量更新安全配置
   */
  async updateSecurityConfig(
    user: User,
    configs: { key: string; value: string }[],
  ): Promise<void> {
    // 整批验证 key、数值类型与元数据范围；任一非法时不提交任何配置。
    for (const c of configs) {
      const meta = SEC_CONFIG_META.find(m => m.key === c.key);
      if (!meta) {
        throw new BadRequestException(`无效的安全配置键: ${c.key}`);
      }
      const value = Number(c.value);
      if (!Number.isFinite(value)) {
        throw new BadRequestException(`${meta.label} 必须为有效数值`);
      }
      if (meta.min !== undefined && value < meta.min) {
        throw new BadRequestException(`${meta.label} 不能小于 ${meta.min}`);
      }
      if (meta.max !== undefined && value > meta.max) {
        throw new BadRequestException(`${meta.label} 不能大于 ${meta.max}`);
      }
      if (meta.step !== undefined) {
        const precision = String(meta.step).split('.')[1]?.length || 0;
        const scale = 10 ** precision;
        const base = meta.min ?? 0;
        if (Math.abs(Math.round((value - base) * scale) % Math.round(meta.step * scale)) !== 0) {
          throw new BadRequestException(`${meta.label} 必须按步长 ${meta.step} 设置`);
        }
      }
    }

    // G7-06：入库前归一化数值，`String(Number(c.value))`。避免 '1e1' 等指数形式
    // 在后续 parseInt/parseFloat 解析时发生漂移（如 '1e1' 存库后按整数读取为 10 的
    // 表示不一致）。上方校验已保证 Number.isFinite，此处归一化不会改变语义。
    const entries = configs.map((c) => ({
      key: c.key,
      value: String(Number(c.value)),
      description: `安全规则 - ${SEC_CONFIG_META.find(m => m.key === c.key)?.label || c.key}`,
    }));

    await this.configCacheService.setBatch(entries);

    // 审计日志：仅记录变更的配置键与数量，避免把配置明文值写入审计存储
    this.auditService.log({
      action: 'config_change',
      userId: user.id,
      resourceType: 'security_config',
      resourceId: 'batch',
      metadata: { keys: configs.map(c => c.key), count: configs.length },
    });

    this.logger.log(`安全配置已由用户 ${user.email} 更新: ${configs.map(c => `${c.key}=${c.value}`).join(', ')}`);
  }

  // ==================== 存量旧路径清理 ====================

  /**
   * 固定旧根目录前缀（服务端硬编码，不接受参数，防止误配造成大面积清空）。
   * 目录已从 /data/cb/tgtc-beta/ 迁移到 /root/cb。
   */
  private static readonly STALE_PATH_PREFIX = '/data/cb/tgtc-beta/';

  /**
   * 存量旧路径清理（仅 SUPER_ADMIN）：
   * - dry-run：统计满足 isDeleted=false AND telegramFilePath LIKE '/data/cb/tgtc-beta/%' 的记录数，不修改任何记录。
   * - apply：条件更新将这些记录的 telegramFilePath 清空为 NULL（幂等），不改变文件 status。
   * 返回 { mode, matched, updated }；审计仅记录模式与数量，不记录完整路径/Token/文件信息。
   */
  async cleanupStalePaths(
    user: User,
    mode: 'dry-run' | 'apply' = 'dry-run',
  ): Promise<{ mode: 'dry-run' | 'apply'; matched: number; updated: number }> {
    const prefix = AdminService.STALE_PATH_PREFIX;
    // 精确匹配该目录下：prefix 含尾斜杠，追加 % 通配以匹配目录内任意文件
    const prefixWithWildcard = `${prefix}%`;

    // dry-run：仅统计命中数量，不修改
    const matched = await this.fileRepository
      .createQueryBuilder('file')
      .where('file.isDeleted = false')
      .andWhere('file."telegramFilePath" IS NOT NULL')
      .andWhere('file."telegramFilePath" LIKE :prefix', { prefix: prefixWithWildcard })
      .getCount();

    if (mode === 'dry-run') {
      // 审计：仅记录模式与数量，脱敏
      this.auditService.log({
        action: 'file_stale_path_cleanup',
        userId: user.id,
        resourceType: 'file',
        resourceId: 'stale-path-cleanup',
        metadata: { mode: 'dry-run', matched, updated: 0 },
      });
      this.logger.log(`存量旧路径清理 dry-run：命中 ${matched} 条旧路径（未修改）`);
      return { mode: 'dry-run', matched, updated: 0 };
    }

    // apply：条件更新清空 telegramFilePath（幂等，二次执行命中 0）
    const result = await this.fileRepository
      .createQueryBuilder()
      .update(File)
      .set({ telegramFilePath: null as unknown as string })
      .where('isDeleted = false')
      .andWhere('"telegramFilePath" IS NOT NULL')
      .andWhere('"telegramFilePath" LIKE :prefix', { prefix: prefixWithWildcard })
      .execute();
    const updated = result.affected ?? 0;

    // apply 为高敏感写操作，使用 logAwait 确保审计在响应前持久化
    await this.auditService.logAwait({
      action: 'file_stale_path_cleanup',
      userId: user.id,
      resourceType: 'file',
      resourceId: 'stale-path-cleanup',
      metadata: { mode: 'apply', matched, updated },
    });
    this.logger.log(`存量旧路径清理 apply：命中 ${matched} 条，已清空 ${updated} 条`);
    return { mode: 'apply', matched, updated };
  }
}
