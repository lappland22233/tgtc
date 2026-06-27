import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import { AccessLog } from '../common/entities/access-log.entity';
import { FileAccessLog } from '../common/entities/file-access-log.entity';
import { BannedIP } from '../common/entities/banned-ip.entity';
import { Alert } from '../common/entities/alert.entity';

export interface ExportOptions {
  format: 'csv' | 'json';
  timeRange: string;
  type: 'access-logs' | 'top-files' | 'bans' | 'alerts';
  limit?: number;
}

@Injectable()
export class ExportService {
  constructor(
    @InjectRepository(AccessLog)
    private accessLogRepo: Repository<AccessLog>,
    @InjectRepository(FileAccessLog)
    private fileAccessLogRepo: Repository<FileAccessLog>,
    @InjectRepository(BannedIP)
    private bannedIPRepo: Repository<BannedIP>,
    @InjectRepository(Alert)
    private alertRepo: Repository<Alert>,
  ) {}

  async export(options: ExportOptions): Promise<{ data: string; filename: string; contentType: string }> {
    const since = this.parseTimeRange(options.timeRange);
    const rows = await this.fetchData(options.type, since, options.limit || 10000);

    if (options.format === 'json') {
      return {
        data: JSON.stringify(rows, null, 2),
        filename: `${options.type}-${new Date().toISOString().split('T')[0]}.json`,
        contentType: 'application/json',
      };
    }

    // CSV export
    const csv = this.toCSV(rows);
    return {
      data: csv,
      filename: `${options.type}-${new Date().toISOString().split('T')[0]}.csv`,
      contentType: 'text/csv; charset=utf-8',
    };
  }

  private async fetchData(type: string, since: Date, limit: number): Promise<Record<string, any>[]> {
    switch (type) {
      case 'access-logs': {
        const logs = await this.accessLogRepo.find({
          where: { createdAt: MoreThanOrEqual(since) },
          order: { createdAt: 'DESC' },
          take: limit,
        });
        return logs.map(l => ({
          id: l.id, ip: l.ip, method: l.method, path: l.path,
          statusCode: l.statusCode, responseSize: String(l.responseSize),
          duration: l.duration, userAgent: l.userAgent, referer: l.referer,
          createdAt: l.createdAt?.toISOString(),
        }));
      }
      case 'top-files': {
        const logs = await this.fileAccessLogRepo
          .createQueryBuilder('fal')
          .select('fal."fileId"', 'fileId')
          .addSelect('COUNT(*)::int', 'accessCount')
          .addSelect('SUM(fal."responseSize")::bigint', 'totalBandwidth')
          .where('fal."createdAt" >= :since', { since })
          .groupBy('fal."fileId"')
          .orderBy('accessCount', 'DESC')
          .limit(limit)
          .getRawMany();
        return logs.map(l => ({ ...l, totalBandwidth: String(l.totalBandwidth) }));
      }
      case 'bans': {
        const bans = await this.bannedIPRepo.find({ order: { createdAt: 'DESC' }, take: limit });
        return bans.map(b => ({
          ip: b.ip, reason: b.reason, isPermanent: b.isPermanent,
          expiresAt: b.expiresAt?.toISOString(), createdAt: b.createdAt?.toISOString(),
        }));
      }
      case 'alerts': {
        const alerts = await this.alertRepo.find({ order: { createdAt: 'DESC' }, take: limit });
        return alerts.map(a => ({
          id: a.id, ruleId: a.ruleId, level: a.level, title: a.title,
          message: a.message, acknowledgedAt: a.acknowledgedAt?.toISOString(),
          createdAt: a.createdAt?.toISOString(),
        }));
      }
      default:
        return [];
    }
  }

  private toCSV(rows: Record<string, any>[]): string {
    if (rows.length === 0) return '';
    const headers = Object.keys(rows[0]);
    const escape = (v: any) => {
      const s = String(v ?? '');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [
      '\uFEFF' + headers.join(','), // BOM for Excel UTF-8 compatibility
      ...rows.map(r => headers.map(h => escape(r[h])).join(',')),
    ].join('\n');
  }

  private parseTimeRange(timeRange: string): Date {
    const hours: Record<string, number> = { '1h': 1, '24h': 24, '7d': 168, '30d': 720 };
    const h = hours[timeRange] || 168;
    return new Date(Date.now() - h * 3600 * 1000);
  }
}
