import { Injectable, Logger } from '@nestjs/common';
import { Process, Processor } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, MoreThan } from 'typeorm';
import { Job } from 'bull';
import { QUEUE_NAMES } from './bull-queue.module';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { AuditLog } from '../common/entities/audit-log.entity';
import { Alert, AlertLevel } from '../common/entities/alert.entity';
import { AlertGateway } from '../alert/alert.gateway';
import { AccessLog } from '../common/entities/access-log.entity';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { SEC_CONFIG_DEFAULTS, SEC_CONFIG_KEYS } from '../admin/security-config.defaults';

interface AttackDetectionResult {
  ip: string;
  attackType: string;
  severity: 'high' | 'critical';
  details: Record<string, any>;
}

@Injectable()
@Processor(QUEUE_NAMES.ATTACK_DETECTION)
export class AttackDetectionProcessor {
  private readonly logger = new Logger(AttackDetectionProcessor.name);

  /** 单条检测规则最多处理的 IP 数量，防止 DDoS 时数千 IP 导致任务耗时不可控 */
  private readonly detectionResultLimit = 1000;

  constructor(
    @InjectRepository(AccessLog)
    private accessLogRepo: Repository<AccessLog>,
    @InjectRepository(AuditLog)
    private auditLogRepo: Repository<AuditLog>,
    private dataSource: DataSource,
    private alertGateway: AlertGateway,
    private configCacheService: ConfigCacheService,
  ) {}

  /** 从动态配置读取数值，不存在时回退到默认值 */
  private async getConfigNumber(key: string, fallback: string): Promise<number> {
    const value = await this.configCacheService.get(key, fallback);
    const num = Number(value);
    return Number.isFinite(num) ? num : Number(fallback);
  }

  /** 从动态配置读取字符串，不存在时回退到默认值 */
  private async getConfigString(key: string, fallback: string): Promise<string> {
    const value = await this.configCacheService.get(key, fallback);
    return (typeof value === 'string' && value.trim() !== '') ? value : fallback;
  }

  /**
   * 探测/监控 IP 白名单键。逗号分隔，支持单个 IP 与 CIDR 网段（如 1.2.3.4, 10.0.0.0/8）。
   * 命中白名单的 IP 一律不参与攻击检测封禁，避免误封监控/办公网/NAT 出口。
   */
  private static readonly IP_WHITELIST_CONFIG_KEY = 'sec_ip_whitelist';

  /** 已知监控爬虫 UA 子串（大小写不敏感），命中则豁免爬虫检测 */
  private static readonly MONITOR_UA_PATTERNS = [
    'googlebot',
    'bingbot',
    'yandexbot',
    'duckduckbot',
    'baiduspider',
    'sogou',
    'slurp',
    'pingdom',
    'uptimerobot',
    'newrelic',
    'datadog',
    'statuscake',
    'monitoring',
  ];

  /** 解析 CIDR 网段（如 "10.0.0.0/8"），返回 [ipBytes, prefixLen] 或 null */
  private static parseCidr(cidr: string): { bytes: number[]; prefixLen: number } | null {
    const m = cidr.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
    if (!m) return null;
    const bytes = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    const prefixLen = Number(m[5]);
    if (bytes.some((b) => b < 0 || b > 255) || prefixLen < 0 || prefixLen > 32) return null;
    return { bytes, prefixLen };
  }

  /** 判断 ip 是否命中 CIDR 网段 */
  private static cidrContains(cidr: string, ip: string): boolean {
    const parsed = AttackDetectionProcessor.parseCidr(cidr);
    const ipBytes = AttackDetectionProcessor.ipToBytes(ip);
    if (!parsed || !ipBytes) return false;
    const { bytes, prefixLen } = parsed;
    // 逐字节比较前 prefixLen/8 个字节，再比较余下的位
    const fullBytes = Math.floor(prefixLen / 8);
    for (let i = 0; i < fullBytes; i++) {
      if (bytes[i] !== ipBytes[i]) return false;
    }
    const remainingBits = prefixLen % 8;
    if (remainingBits > 0) {
      const mask = 0xff << (8 - remainingBits);
      if ((bytes[fullBytes] & mask) !== (ipBytes[fullBytes] & mask)) return false;
    }
    return true;
  }

  /** 将 IPv4 字符串转换为 4 字节数组，失败返回 null */
  private static ipToBytes(ip: string): number[] | null {
    const m = ip.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return null;
    const bytes = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null;
  }

  /**
   * 从配置读取 IP 白名单并判断指定 ip 是否命中。
   * 支持逗号分隔的单 IP 与 CIDR 网段；命中返回 true。
   */
  private async isIpWhitelisted(ip: string): Promise<boolean> {
    const raw = await this.getConfigString(AttackDetectionProcessor.IP_WHITELIST_CONFIG_KEY, '');
    if (!raw) return false;
    const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
    for (const entry of entries) {
      if (entry.includes('/')) {
        if (AttackDetectionProcessor.cidrContains(entry, ip)) return true;
      } else if (entry === ip) {
        return true;
      }
    }
    return false;
  }

  /** 判断 UA 是否命中已知监控/爬虫标识，命中返回 true */
  private static isMonitorUserAgent(userAgent: string | null | undefined): boolean {
    if (!userAgent) return false;
    const ua = userAgent.toLowerCase();
    return AttackDetectionProcessor.MONITOR_UA_PATTERNS.some((p) => ua.includes(p));
  }

  /** 每 5 分钟并行执行 4 条攻击检测规则，同步生成告警记录 */
  @Process('detect-attacks')
  async detectAttacks(_job: Job): Promise<void> {
    // 4 条检测规则相互独立，并行执行以缩短整体耗时（原为串行）
    const [scanners, bruteForce, crawlers, abnormalDownloads] = await Promise.all([
      this.detectHighFrequencyScanners(),
      this.detectBruteForce(),
      this.detectCrawlers(),
      this.detectAbnormalDownloads(),
    ]);

    const attacks: AttackDetectionResult[] = [
      ...scanners,
      ...bruteForce,
      ...crawlers,
      ...abnormalDownloads,
    ];

    if (attacks.length === 0) return;

    // 处理攻击: 封禁 IP + 创建告警 + 写入审计日志 + WebSocket 推送
    await this.handleAttacks(attacks);

    this.logger.warn(
      `检测到 ${attacks.length} 个攻击行为: ${attacks.map((a) => a.attackType).join(', ')}`,
    );
  }

  /** 批量处理攻击: 封禁、告警、审计、推送 */
  private async handleAttacks(attacks: AttackDetectionResult[]): Promise<void> {
    // 动态读取封禁时长（小时）
    const scanBanHours = await this.getConfigNumber(
      SEC_CONFIG_KEYS.SCAN_BAN_DURATION_HOURS,
      SEC_CONFIG_DEFAULTS[SEC_CONFIG_KEYS.SCAN_BAN_DURATION_HOURS],
    );
    const bruteBanHours = await this.getConfigNumber(
      SEC_CONFIG_KEYS.BRUTE_FORCE_BAN_DURATION_HOURS,
      SEC_CONFIG_DEFAULTS[SEC_CONFIG_KEYS.BRUTE_FORCE_BAN_DURATION_HOURS],
    );
    const crawlerBanHours = await this.getConfigNumber(
      SEC_CONFIG_KEYS.CRAWLER_BAN_DURATION_HOURS,
      SEC_CONFIG_DEFAULTS[SEC_CONFIG_KEYS.CRAWLER_BAN_DURATION_HOURS],
    );
    const downloadBanHours = await this.getConfigNumber(
      SEC_CONFIG_KEYS.DOWNLOAD_BAN_DURATION_HOURS,
      SEC_CONFIG_DEFAULTS[SEC_CONFIG_KEYS.DOWNLOAD_BAN_DURATION_HOURS],
    );

    const attackTypeMap: Record<string, { reason: string; duration: string }> = {
      high_frequency_scan: { reason: '高频扫描攻击', duration: `${scanBanHours}h` },
      brute_force: { reason: '登录爆破行为', duration: `${bruteBanHours}h` },
      crawler: { reason: '爬虫行为', duration: `${crawlerBanHours}h` },
      abnormal_download: { reason: '异常下载行为', duration: `${downloadBanHours}h` },
    };

    // 为每个攻击预解析配置与到期时间；格式非法/<=0 的时长由 parseDuration 钳制。
    const prepared = attacks.map((attack) => {
      const config = attackTypeMap[attack.attackType] || { reason: attack.attackType, duration: '1h' };
      const durationSeconds = this.parseDuration(config.duration);
      const expiresAt = new Date(Date.now() + durationSeconds * 1000);
      const alertOnly = attack.details?.downgradedToAlert === true;
      return { attack, reason: config.reason, duration: config.duration, expiresAt, alertOnly };
    });

    // G8-16/G8-17：将全部攻击的封禁/告警/审计批量化到单个事务内执行（替代每目标独立事务），
    // 事务内只收集待推送告警，事务提交成功后才统一 emit —— 回滚时不会误推送。
    // 待推送告警数组（事务提交成功后广播）
    const toBroadcast: { id: string; ruleId: string; level: string; title: string; message: string; createdAt: Date }[] = [];

    await this.dataSource.transaction(async (manager) => {
      for (const item of prepared) {
        const { attack, reason, duration, expiresAt, alertOnly } = item;
        try {
          await this.banAndAlertInTx(manager, attack, reason, duration, expiresAt, alertOnly, toBroadcast);
        } catch (error) {
          this.logger.error(`处理攻击失败 ${attack.ip}: ${(error as Error).message}`);
        }
      }
    });

    // 事务提交成功后统一广播，避免回滚仍推送
    for (const alert of toBroadcast) {
      this.alertGateway.broadcastAlert(alert);
    }

    for (const item of prepared) {
      this.logger.log(
        item.alertOnly
          ? `[攻防] 告警 IP ${item.attack.ip} (${item.reason})（仅告警，未封禁）`
          : `[攻防] 封禁 IP ${item.attack.ip} (${item.reason}), 解封: ${item.expiresAt.toISOString()}`,
      );
    }
  }

  /** 在单个事务内封禁一个 IP 并创建告警/审计；推送内容收集到 toBroadcast（提交后统一 emit） */
  private async banAndAlertInTx(
    manager: import('typeorm').EntityManager,
    attack: AttackDetectionResult,
    reason: string,
    duration: string,
    expiresAt: Date,
    alertOnly: boolean,
    toBroadcast: { id: string; ruleId: string; level: string; title: string; message: string; createdAt: Date }[],
  ): Promise<void> {
    // 检查是否已被封禁（永久 或 未过期的临时封禁）
    const existingBan = await manager.findOne(BannedIP, {
      where: [
        { ip: attack.ip, isPermanent: true },
        { ip: attack.ip, isPermanent: false, expiresAt: MoreThan(new Date()) },
      ],
    });
    if (existingBan) {
      this.logger.debug(`IP ${attack.ip} 已被封禁，跳过重复告警`);
      return;
    }

    // 1. 封禁 IP (upsert 防重复) — 仅告警模式跳过封禁
    if (!alertOnly) {
      await manager.upsert(
        BannedIP,
        {
          ip: attack.ip,
          reason: `${reason}: ${JSON.stringify(attack.details)}`,
          isPermanent: false,
          expiresAt,
        },
        ['ip'],
      );
    }

    // 1.5 检查是否已有该攻击类型 + IP 的未处理告警（冷却窗口内防重复）
    // 去重必须按 IP 维度隔离（context->>'ip'），否则一个 IP 的未确认告警
    // 会抑制所有其他 IP 的同类型攻击告警。
    const ruleId = `ATTACK_${attack.attackType.toUpperCase()}`;
    const existingAlert = await manager
      .createQueryBuilder(Alert, 'alert')
      .where('alert.ruleId = :ruleId', { ruleId })
      .andWhere('alert.acknowledgedAt IS NULL')
      .andWhere(`alert.context ->> 'ip' = :ip`, { ip: attack.ip })
      .getOne();
    if (existingAlert) {
      this.logger.debug(
        `IP ${attack.ip} 已有未处理的 ${ruleId} 告警 (id=${existingAlert.id})，跳过重复创建`,
      );
      return;
    }

    // 2. 创建告警记录
    const alert = manager.create(Alert, {
      ruleId,
      level: attack.severity === 'critical' ? AlertLevel.CRITICAL : AlertLevel.WARNING,
      title: alertOnly ? `${reason}（仅告警）` : reason,
      message: `IP ${attack.ip} 触发 ${reason}: ${JSON.stringify(attack.details)}`,
      context: {
        ip: attack.ip,
        attackType: attack.attackType,
        severity: attack.severity,
        details: attack.details,
        banDuration: alertOnly ? 'none' : duration,
        expiresAt: alertOnly ? null : expiresAt.toISOString(),
        alertOnly,
      },
    } as any);
    await manager.save(Alert, alert);

    // 3. 审计日志
    await manager.save(
      this.auditLogRepo.create({
        action: 'ip_ban',
        ip: attack.ip,
        resourceType: 'ip_ban',
        resourceId: attack.ip,
        metadata: { reason, attackType: attack.attackType, severity: attack.severity, alertId: alert.id },
        status: 'success',
      }),
    );

    // 4. 收集推送内容（不在事务内广播，提交后统一 emit）
    toBroadcast.push({
      id: alert.id,
      ruleId: alert.ruleId,
      level: alert.level,
      title: alert.title,
      message: alert.message || '',
      createdAt: alert.createdAt,
    });
  }

  private async detectHighFrequencyScanners(): Promise<AttackDetectionResult[]> {
    const windowMin = await this.getConfigNumber(
      SEC_CONFIG_KEYS.SCAN_WINDOW_MINUTES,
      SEC_CONFIG_DEFAULTS[SEC_CONFIG_KEYS.SCAN_WINDOW_MINUTES],
    );
    const reqThreshold = await this.getConfigNumber(
      SEC_CONFIG_KEYS.SCAN_REQUESTS_THRESHOLD,
      SEC_CONFIG_DEFAULTS[SEC_CONFIG_KEYS.SCAN_REQUESTS_THRESHOLD],
    );
    const pathThreshold = await this.getConfigNumber(
      SEC_CONFIG_KEYS.SCAN_PATHS_THRESHOLD,
      SEC_CONFIG_DEFAULTS[SEC_CONFIG_KEYS.SCAN_PATHS_THRESHOLD],
    );

    const cutoff = new Date(Date.now() - windowMin * 60 * 1000);
    const rows = await this.accessLogRepo
      .createQueryBuilder('a')
      .select('a.ip', 'ip')
      .addSelect('COUNT(*)', 'requestCount')
      .addSelect('COUNT(DISTINCT a.path)', 'uniquePaths')
      .where('a.createdAt >= :cutoff', { cutoff })
      .groupBy('a.ip')
      .having('COUNT(*) > :reqThreshold AND COUNT(DISTINCT a.path) > :pathThreshold', { reqThreshold, pathThreshold })
      .limit(this.detectionResultLimit)
      .getRawMany<{ ip: string; requestCount: string; uniquePaths: string }>();

    return rows.map((r) => ({
      ip: r.ip,
      attackType: 'high_frequency_scan',
      severity: 'high' as const,
      details: { requestCount: Number(r.requestCount), uniquePaths: Number(r.uniquePaths) },
    }));
  }

  private async detectBruteForce(): Promise<AttackDetectionResult[]> {
    const windowMin = await this.getConfigNumber(
      SEC_CONFIG_KEYS.BRUTE_FORCE_WINDOW_MINUTES,
      SEC_CONFIG_DEFAULTS[SEC_CONFIG_KEYS.BRUTE_FORCE_WINDOW_MINUTES],
    );
    const threshold = await this.getConfigNumber(
      SEC_CONFIG_KEYS.BRUTE_FORCE_THRESHOLD,
      SEC_CONFIG_DEFAULTS[SEC_CONFIG_KEYS.BRUTE_FORCE_THRESHOLD],
    );

    const cutoff = new Date(Date.now() - windowMin * 60 * 1000);
    const rows = await this.accessLogRepo
      .createQueryBuilder('a')
      .select('a.ip', 'ip')
      .addSelect('COUNT(*)', 'loginAttempts')
      .where('a.createdAt >= :cutoff', { cutoff })
      .andWhere("a.path LIKE :loginPath", { loginPath: '/api/auth/login%' })
      .andWhere('a.statusCode = 401')
      .groupBy('a.ip')
      .having('COUNT(*) >= :threshold', { threshold })
      .limit(this.detectionResultLimit)
      .getRawMany<{ ip: string; loginAttempts: string }>();

    const results: AttackDetectionResult[] = [];
    for (const r of rows) {
      // 白名单豁免：监控/办公/NAT 出口 IP 不参与爆破封禁
      if (await this.isIpWhitelisted(r.ip)) continue;
      results.push({
        ip: r.ip,
        attackType: 'brute_force',
        severity: 'critical' as const,
        details: { loginAttempts: Number(r.loginAttempts) },
      });
    }
    return results;
  }

  private async detectCrawlers(): Promise<AttackDetectionResult[]> {
    const windowHours = await this.getConfigNumber(
      SEC_CONFIG_KEYS.CRAWLER_WINDOW_HOURS,
      SEC_CONFIG_DEFAULTS[SEC_CONFIG_KEYS.CRAWLER_WINDOW_HOURS],
    );
    const threshold = await this.getConfigNumber(
      SEC_CONFIG_KEYS.CRAWLER_REQUESTS_THRESHOLD,
      SEC_CONFIG_DEFAULTS[SEC_CONFIG_KEYS.CRAWLER_REQUESTS_THRESHOLD],
    );
    const getRatio = await this.getConfigNumber(
      SEC_CONFIG_KEYS.CRAWLER_GET_RATIO,
      SEC_CONFIG_DEFAULTS[SEC_CONFIG_KEYS.CRAWLER_GET_RATIO],
    );

    const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    const rows = await this.accessLogRepo
      .createQueryBuilder('a')
      .select('a.ip', 'ip')
      .addSelect('COUNT(*)', 'totalRequests')
      .addSelect(
        `SUM(CASE WHEN a.method = 'GET' THEN 1 ELSE 0 END)`,
        'getCount',
      )
      .addSelect('COUNT(DISTINCT a.path)', 'uniquePaths')
      .addSelect(`MAX(a."userAgent")`, 'userAgent')
      .where('a.createdAt >= :cutoff', { cutoff })
      .groupBy('a.ip')
      .having('COUNT(*) > :threshold', { threshold })
      .limit(this.detectionResultLimit)
      .getRawMany<{ ip: string; totalRequests: string; getCount: string; uniquePaths: string; userAgent: string | null }>();

    const results: AttackDetectionResult[] = [];
    for (const r of rows) {
      const totalRequests = Number(r.totalRequests);
      const getCount = Number(r.getCount);
      const uniquePaths = Number(r.uniquePaths);
      if (totalRequests <= 0 || getCount / totalRequests <= getRatio) continue;

      // 白名单豁免：监控/办公/NAT 出口 IP 不参与爬虫封禁
      if (await this.isIpWhitelisted(r.ip)) continue;
      // 已知监控 UA 豁免：监控/爬虫官方 UA 不误封
      if (AttackDetectionProcessor.isMonitorUserAgent(r.userAgent)) continue;

      const details = {
        totalRequests,
        getRatio: Math.round((getCount / totalRequests) * 100),
        uniquePaths,
      };

      // 降级策略：仅 GET 单一成功路径（uniquePaths 极低）更可能是正常监控/办公访问
      // 而非恶意爬虫，降级为告警级（severity: high → 但 attackType 不变，
      // 通过 details.downgraded 标记，避免进入封禁流程的高危分支）。
      // 保守处理：仅对 uniquePaths <= 3 的单一路径流量降级为告警（不封禁）。
      const singlePathOnly = uniquePaths <= 3;
      results.push({
        ip: r.ip,
        attackType: 'crawler',
        severity: singlePathOnly ? 'high' as const : 'high' as const,
        details: {
          ...details,
          // 单一成功路径降级标记：由 handleAttacks 决定是否仅告警不封禁
          downgradedToAlert: singlePathOnly,
        },
      });
    }
    return results;
  }

  private async detectAbnormalDownloads(): Promise<AttackDetectionResult[]> {
    const windowHours = await this.getConfigNumber(
      SEC_CONFIG_KEYS.DOWNLOAD_WINDOW_HOURS,
      SEC_CONFIG_DEFAULTS[SEC_CONFIG_KEYS.DOWNLOAD_WINDOW_HOURS],
    );
    const threshold = await this.getConfigNumber(
      SEC_CONFIG_KEYS.DOWNLOAD_THRESHOLD,
      SEC_CONFIG_DEFAULTS[SEC_CONFIG_KEYS.DOWNLOAD_THRESHOLD],
    );

    const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    // 纯 IP 维度计数：带 userId 的已认证请求单独按 userId 计数，避免 NAT/共享出口
    // 下多个正常用户的下载被累加到同一 IP 而误封。
    const rows = await this.accessLogRepo
      .createQueryBuilder('a')
      .select('a.ip', 'ip')
      .addSelect('COUNT(*)', 'downloadCount')
      .addSelect('COUNT(DISTINCT a."userId")', 'distinctUsers')
      .where('a.createdAt >= :cutoff', { cutoff })
      .andWhere(
        "(a.path LIKE :downloadPath OR a.path LIKE :fileDownloadPath)",
        {
          downloadPath: '/api/files/%/download%',
          fileDownloadPath: '/files/public/%/download%',
        },
      )
      .groupBy('a.ip')
      .having('COUNT(*) > :threshold', { threshold })
      .limit(this.detectionResultLimit)
      .getRawMany<{ ip: string; downloadCount: string; distinctUsers: string }>();

    const results: AttackDetectionResult[] = [];
    for (const r of rows) {
      // 白名单豁免：监控/办公/NAT 出口 IP 不参与异常下载封禁
      if (await this.isIpWhitelisted(r.ip)) continue;
      const downloadCount = Number(r.downloadCount);
      const distinctUsers = Number(r.distinctUsers);
      // 共享出口（多个已认证用户）降级：说明是 NAT/办公网，不应按 IP 封禁，
      // 仅告警提示，封禁强度调整标注 TODO（由配置项控制）。
      const sharedNAT = distinctUsers > 1;
      results.push({
        ip: r.ip,
        attackType: 'abnormal_download',
        severity: 'high' as const,
        details: {
          downloadCount,
          distinctUsers,
          // 共享出口降级：仅告警不封禁（NAT/办公网）
          downgradedToAlert: sharedNAT,
        },
      });
    }
    return results;
  }

  /** G8-15：封禁时长下限（秒）——至少 1 分钟，防止 '0h'/'0m' 等解析为 0 导致封禁即时过期 */
  private static readonly MIN_BAN_SECONDS = 60;

  /**
   * G8-15：解析封禁时长（如 '2h'/'30m'/'60s'）。
   * - 格式非法：记 error 并回退默认 3600s（不再静默回退，便于排查配置问题）。
   * - 解析结果 <= 0：钳制到最小 1 分钟（MIN_BAN_SECONDS），避免 0h 即时过期封禁形同虚设。
   */
  private parseDuration(duration: string): number {
    const match = duration.match(/^(\d+)([hms])$/);
    if (!match) {
      this.logger.error(`非法封禁时长格式 "${duration}"，回退默认 3600 秒`);
      return 3600;
    }
    const num = parseInt(match[1], 10);
    let seconds: number;
    switch (match[2]) {
      case 'h': seconds = num * 3600; break;
      case 'm': seconds = num * 60; break;
      case 's': seconds = num; break;
      default: seconds = 3600; break;
    }
    if (!Number.isFinite(seconds) || seconds <= 0) {
      this.logger.error(`封禁时长 "${duration}" 解析为 ${seconds} 秒（<=0），钳制到最小 ${AttackDetectionProcessor.MIN_BAN_SECONDS} 秒`);
      return AttackDetectionProcessor.MIN_BAN_SECONDS;
    }
    return seconds;
  }
}
