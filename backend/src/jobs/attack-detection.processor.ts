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

  constructor(
    @InjectRepository(AccessLog)
    private accessLogRepo: Repository<AccessLog>,
    @InjectRepository(AuditLog)
    private auditLogRepo: Repository<AuditLog>,
    private dataSource: DataSource,
    private alertGateway: AlertGateway,
  ) {}

  /** 每 5 分钟并行执行 4 条攻击检测规则，同步生成告警记录 */
  @Process('detect-attacks')
  async detectAttacks(_job: Job): Promise<void> {
    const attacks: AttackDetectionResult[] = [];

    // Rule 1: 高频扫描 — IP 每分钟 >300 次 + uniquePaths >50
    const scanners = await this.detectHighFrequencyScanners();
    attacks.push(...scanners);

    // Rule 2: 爆破行为 — /api/auth/login 401 >=20次/5min
    const bruteForce = await this.detectBruteForce();
    attacks.push(...bruteForce);

    // Rule 3: 爬虫行为 — IP 24h >50000 且 GET >99%
    const crawlers = await this.detectCrawlers();
    attacks.push(...crawlers);

    // Rule 4: 异常下载 — IP 下载 >1000/24h
    const abnormalDownloads = await this.detectAbnormalDownloads();
    attacks.push(...abnormalDownloads);

    if (attacks.length === 0) return;

    // 处理攻击: 封禁 IP + 创建告警 + 写入审计日志 + WebSocket 推送
    await this.handleAttacks(attacks);

    this.logger.warn(
      `检测到 ${attacks.length} 个攻击行为: ${attacks.map((a) => a.attackType).join(', ')}`,
    );
  }

  /** 批量处理攻击: 封禁、告警、审计、推送 */
  private async handleAttacks(attacks: AttackDetectionResult[]): Promise<void> {
    const attackTypeMap: Record<string, { reason: string; duration: string }> = {
      high_frequency_scan: { reason: '高频扫描攻击', duration: '1h' },
      brute_force: { reason: '登录爆破行为', duration: '2h' },
      crawler: { reason: '爬虫行为', duration: '24h' },
      abnormal_download: { reason: '异常下载行为', duration: '6h' },
    };

    for (const attack of attacks) {
      const config = attackTypeMap[attack.attackType] || { reason: attack.attackType, duration: '1h' };
      try {
        await this.banAndAlert(attack, config.reason, config.duration);
      } catch (error) {
        this.logger.error(`处理攻击失败 ${attack.ip}: ${(error as Error).message}`);
      }
    }
  }

  /** 封禁 IP 并创建告警 */
  private async banAndAlert(
    attack: AttackDetectionResult,
    reason: string,
    duration: string,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + this.parseDuration(duration) * 1000);

    await this.dataSource.transaction(async (manager) => {
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

      // 1. 封禁 IP (upsert 防重复)
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

      // 2. 创建告警记录
      const alert = manager.create(Alert, {
        ruleId: `ATTACK_${attack.attackType.toUpperCase()}`,
        level: attack.severity === 'critical' ? AlertLevel.CRITICAL : AlertLevel.WARNING,
        title: reason,
        message: `IP ${attack.ip} 触发 ${reason}: ${JSON.stringify(attack.details)}`,
        context: {
          ip: attack.ip,
          attackType: attack.attackType,
          severity: attack.severity,
          details: attack.details,
          banDuration: duration,
          expiresAt: expiresAt.toISOString(),
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

      // 4. WebSocket 实时推送告警
      this.alertGateway.broadcastAlert({
        id: alert.id,
        ruleId: alert.ruleId,
        level: alert.level,
        title: alert.title,
        message: alert.message || '',
        createdAt: alert.createdAt,
      });
    });

    this.logger.log(`[攻防] 封禁 IP ${attack.ip} (${reason}), 解封: ${expiresAt.toISOString()}`);
  }

  private async detectHighFrequencyScanners(): Promise<AttackDetectionResult[]> {
    const cutoff = new Date(Date.now() - 5 * 60 * 1000);
    const rows = await this.accessLogRepo
      .createQueryBuilder('a')
      .select('a.ip', 'ip')
      .addSelect('COUNT(*)', 'requestCount')
      .addSelect('COUNT(DISTINCT a.path)', 'uniquePaths')
      .where('a.createdAt >= :cutoff', { cutoff })
      .groupBy('a.ip')
      .having('COUNT(*) > 300 AND COUNT(DISTINCT a.path) > 50')
      .getRawMany<{ ip: string; requestCount: string; uniquePaths: string }>();

    return rows.map((r) => ({
      ip: r.ip,
      attackType: 'high_frequency_scan',
      severity: 'high' as const,
      details: { requestCount: Number(r.requestCount), uniquePaths: Number(r.uniquePaths) },
    }));
  }

  private async detectBruteForce(): Promise<AttackDetectionResult[]> {
    const cutoff = new Date(Date.now() - 5 * 60 * 1000);
    const rows = await this.accessLogRepo
      .createQueryBuilder('a')
      .select('a.ip', 'ip')
      .addSelect('COUNT(*)', 'loginAttempts')
      .where('a.createdAt >= :cutoff', { cutoff })
      .andWhere("a.path LIKE :loginPath", { loginPath: '/api/auth/login%' })
      .andWhere('a.statusCode = 401')
      .groupBy('a.ip')
      .having('COUNT(*) >= 20')
      .getRawMany<{ ip: string; loginAttempts: string }>();

    return rows.map((r) => ({
      ip: r.ip,
      attackType: 'brute_force',
      severity: 'critical' as const,
      details: { loginAttempts: Number(r.loginAttempts) },
    }));
  }

  private async detectCrawlers(): Promise<AttackDetectionResult[]> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await this.accessLogRepo
      .createQueryBuilder('a')
      .select('a.ip', 'ip')
      .addSelect('COUNT(*)', 'totalRequests')
      .addSelect(
        `SUM(CASE WHEN a.method = 'GET' THEN 1 ELSE 0 END)`,
        'getCount',
      )
      .where('a.createdAt >= :cutoff', { cutoff })
      .groupBy('a.ip')
      .having('COUNT(*) > 50000')
      .getRawMany<{ ip: string; totalRequests: string; getCount: string }>();

    return rows
      .filter(
        (r) =>
          Number(r.totalRequests) > 0 &&
          Number(r.getCount) / Number(r.totalRequests) > 0.99,
      )
      .map((r) => ({
        ip: r.ip,
        attackType: 'crawler',
        severity: 'high' as const,
        details: {
          totalRequests: Number(r.totalRequests),
          getRatio: Math.round((Number(r.getCount) / Number(r.totalRequests)) * 100),
        },
      }));
  }

  private async detectAbnormalDownloads(): Promise<AttackDetectionResult[]> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await this.accessLogRepo
      .createQueryBuilder('a')
      .select('a.ip', 'ip')
      .addSelect('COUNT(*)', 'downloadCount')
      .where('a.createdAt >= :cutoff', { cutoff })
      .andWhere(
        "(a.path LIKE :downloadPath OR a.path LIKE :fileDownloadPath)",
        {
          downloadPath: '/api/files/%/download%',
          fileDownloadPath: '/files/public/%/download%',
        },
      )
      .groupBy('a.ip')
      .having('COUNT(*) > 1000')
      .getRawMany<{ ip: string; downloadCount: string }>();

    return rows.map((r) => ({
      ip: r.ip,
      attackType: 'abnormal_download',
      severity: 'high' as const,
      details: { downloadCount: Number(r.downloadCount) },
    }));
  }

  private parseDuration(duration: string): number {
    const match = duration.match(/^(\d+)([hms])$/);
    if (!match) return 3600;
    const num = parseInt(match[1], 10);
    switch (match[2]) {
      case 'h': return num * 3600;
      case 'm': return num * 60;
      case 's': return num;
      default: return 3600;
    }
  }
}
