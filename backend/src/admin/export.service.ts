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

/** 单次导出的最大行数，防止全量加载进内存 */
const MAX_EXPORT_LIMIT = 10000;

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
    const limit = Math.min(Math.max(options.limit || MAX_EXPORT_LIMIT, 1), MAX_EXPORT_LIMIT);
    const rows = await this.fetchData(options.type, since, limit);

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
        const bans = await this.bannedIPRepo.find({
          where: { createdAt: MoreThanOrEqual(since) },
          order: { createdAt: 'DESC' },
          take: limit,
        });
        return bans.map(b => ({
          ip: b.ip, reason: b.reason, isPermanent: b.isPermanent,
          expiresAt: b.expiresAt?.toISOString(), createdAt: b.createdAt?.toISOString(),
        }));
      }
      case 'alerts': {
        const alerts = await this.alertRepo.find({
          where: { createdAt: MoreThanOrEqual(since) },
          order: { createdAt: 'DESC' },
          take: limit,
        });
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

  /**
   * G7-09：估算导出行数，供审计记录。JSON 解析后取数组长度；CSV 按换行减表头计数。
   * 解析失败时保守返回 0（不影响导出结果，仅审计元数据）。
   */
  countRows(data: string, format: 'csv' | 'json'): number {
    try {
      if (format === 'json') {
        const parsed = JSON.parse(data);
        return Array.isArray(parsed) ? parsed.length : 0;
      }
      const lines = data.split('\n');
      // 去掉 BOM 表头行与可能的尾随空行
      let count = 0;
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() !== '') count++;
      }
      return count;
    } catch {
      return 0;
    }
  }

  private toCSV(rows: Record<string, any>[]): string {
    if (rows.length === 0) return '';
    const headers = Object.keys(rows[0]);
    const escape = (v: any) => {
      let s = String(v ?? '');
      // 防 CSV 公式注入：以 = + - @ 或制表符/回车开头的值前缀单引号，
      // 避免被 Excel/WPS 等解析为公式执行
      if (/^[=+\-@\t\r]/.test(s)) {
        s = `'${s}`;
      }
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
