import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { SEC_CONFIG_KEYS } from '../admin/security-config.defaults';

export interface AnomalyDetectionResult {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  message: string;
  details: Record<string, string | number | undefined>;
}

/**
 * 指标名 → SQL 列表达式白名单。
 * 基线计算仅允许从此 Map 取列表达式，杜绝字符串拼接列名带来的脆弱性/潜在注入面。
 * 注意：值为受信任的固定 SQL 片段（非用户输入），不可参数化。
 */
const METRIC_COLUMN_MAP: Record<string, string> = {
  qps: '"qpsAvg"',
  error_rate: '(CASE WHEN "totalRequests" > 0 THEN CAST("error5xxCount" AS FLOAT) / "totalRequests" ELSE 0 END)',
  bandwidth: '"totalBandwidth"',
  unique_ips: '"uniqueIps"',
  p95_duration: '"p95Duration"',
};

@Injectable()
export class BehaviorAnalyzer {
  private readonly logger = new Logger(BehaviorAnalyzer.name);

  constructor(
    private dataSource: DataSource,
    private configCache: ConfigCacheService,
  ) {}

  /**
   * 计算 7 天基线数据并写入 baseline_stats 表
   * 从 access_log_metrics_1min 预聚合表读取，性能优异
   */
  async calculateBaselines(): Promise<void> {
    this.logger.log('开始计算 7 天基线...');

    const metrics = Object.keys(METRIC_COLUMN_MAP);
    const counts: Record<string, number> = {};

    for (const metric of metrics) {
      try {
        // 仅从白名单 Map 取列表达式，未知指标直接跳过（防御性，正常不会发生）
        const column = METRIC_COLUMN_MAP[metric];
        if (!column) {
          this.logger.warn(`未知指标 "${metric}"，跳过基线计算`);
          continue;
        }

        await this.dataSource.query(
          `INSERT INTO "baseline_stats" ("metricName", "hourBucket", "dayOfWeek", "mean", "stddev", "sampleCount", "updatedAt")
           SELECT $1,
             EXTRACT(HOUR FROM "windowTime")::int,
             EXTRACT(DOW FROM "windowTime")::int,
             AVG(${column}) AS mean,
             COALESCE(STDDEV(${column}), 0) AS stddev,
             COUNT(*) AS sample_count,
             NOW()
           FROM "access_log_metrics_1min"
           WHERE "windowTime" >= NOW() - INTERVAL '7 days'
             AND "totalRequests" > 0
           GROUP BY EXTRACT(HOUR FROM "windowTime"), EXTRACT(DOW FROM "windowTime")
           ON CONFLICT ("metricName", "hourBucket", "dayOfWeek") DO UPDATE SET
             "mean" = EXCLUDED."mean",
             "stddev" = EXCLUDED."stddev",
             "sampleCount" = EXCLUDED."sampleCount",
             "updatedAt" = NOW()`,
          [metric],
        );

        const countResult = await this.dataSource.query(
          `SELECT COUNT(*) as cnt FROM "baseline_stats" WHERE "metricName" = $1`,
          [metric],
        );
        counts[metric] = countResult[0]?.cnt || 0;
      } catch (error) {
        this.logger.warn(`基线计算失败 (${metric}): ${(error as Error).message}`);
      }
    }

    this.logger.log(
      `基线计算完成: qps=${counts['qps']}, error_rate=${counts['error_rate']}, ` +
      `bandwidth=${counts['bandwidth']}, unique_ips=${counts['unique_ips']}, p95=${counts['p95_duration']} 条`,
    );
  }

  /**
   * 检测 6 种异常行为模式
   * 每 15 分钟执行一次
   */
  async detectAnomalies(): Promise<AnomalyDetectionResult[]> {
    const results: AnomalyDetectionResult[] = [];

    results.push(...(await this.detectAbnormalDownloads()));
    results.push(...(await this.detectAbnormalUploads()));
    results.push(...(await this.detectAbnormalSharing()));
    results.push(...(await this.detectTimeAnomaly()));
    results.push(...(await this.detectCrawlerEnhanced()));
    results.push(...(await this.detectBaselineDeviation()));

    if (results.length > 0) {
      this.logger.warn(`检测到 ${results.length} 个异常行为`);
    }

    return results;
  }

  /** 模式 1: 异常下载 — 同 IP 1h 内下载不同文件 > 50 种 */
  private async detectAbnormalDownloads(): Promise<AnomalyDetectionResult[]> {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const rows = await this.dataSource.query(
      `SELECT fal.ip, COUNT(DISTINCT fal."fileId")::int as unique_files, COUNT(*)::int as total_downloads
       FROM "file_access_logs" fal
       WHERE fal."createdAt" >= $1 AND fal.action = 'download'
       GROUP BY fal.ip
       HAVING COUNT(DISTINCT fal."fileId") > 50`,
      [cutoff],
    );

    return rows.map((r: { ip: string; unique_files: number; total_downloads: number }) => ({
      type: 'abnormal_download',
      severity: 'high' as const,
      title: '异常下载行为',
      message: `IP ${r.ip} 1小时内下载了 ${r.unique_files} 个不同文件 (共 ${r.total_downloads} 次)`,
      details: { ip: r.ip, uniqueFiles: r.unique_files, totalDownloads: r.total_downloads },
    }));
  }

  /** 模式 2: 异常上传 — 单用户 1h 内上传 > 100 个文件 */
  private async detectAbnormalUploads(): Promise<AnomalyDetectionResult[]> {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const rows = await this.dataSource.query(
      `SELECT f."uploaderId", COUNT(*)::int as upload_count
       FROM "files" f
       WHERE f."createdAt" >= $1 AND f."isDeleted" = false
       GROUP BY f."uploaderId"
       HAVING COUNT(*) > 100`,
      [cutoff],
    );

    return rows.map((r: any) => ({
      type: 'abnormal_upload',
      severity: 'medium' as const,
      title: '异常上传行为',
      message: `用户 ${r.uploaderId} 1小时内上传了 ${r.upload_count} 个文件`,
      details: { userId: r.uploaderId, uploadCount: r.upload_count },
    }));
  }

  /** 模式 3: 异常分享 — 单文件 1h 内不同 IP 访问 > 200 */
  private async detectAbnormalSharing(): Promise<AnomalyDetectionResult[]> {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const rows = await this.dataSource.query(
      `SELECT fal."fileId", COUNT(DISTINCT fal.ip)::int as unique_ips, COUNT(*)::int as total_access
       FROM "file_access_logs" fal
       WHERE fal."createdAt" >= $1 AND (fal.action = 'public_share' OR fal.action = 'public_direct')
       GROUP BY fal."fileId"
       HAVING COUNT(DISTINCT fal.ip) > 200`,
      [cutoff],
    );

    return rows.map((r: any) => ({
      type: 'abnormal_sharing',
      severity: 'high' as const,
      title: '异常分享行为',
      message: `文件 ${r.fileId} 1小时内被 ${r.unique_ips} 个不同 IP 访问了 ${r.total_access} 次`,
      details: { fileId: r.fileId, uniqueIps: r.unique_ips, totalAccess: r.total_access },
    }));
  }

  /** 模式 4: 时间异常 — 深夜 (2-5点) 请求量 > 全天均值 × 2 */
  private async detectTimeAnomaly(): Promise<AnomalyDetectionResult[]> {
    // 获取过去 24 小时内深夜时段 (2-5点) 和全天每小时平均请求数
    // 使用条件聚合（COUNT FILTER）单次扫描完成，替代原双子查询的全表重复扫描
    const rows = await this.dataSource.query(
      `SELECT
         COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM "createdAt") BETWEEN 2 AND 5)::float / 3 as night_avg,
         COUNT(*)::float / 24 as all_avg
       FROM "access_logs"
       WHERE "createdAt" >= NOW() - INTERVAL '24 hours'`,
    );

    if (rows.length === 0) return [];
    const r = rows[0];
    const nightAvg = Number(r.night_avg) || 0;
    const allAvg = Number(r.all_avg) || 1;

    if (nightAvg > allAvg * 2) {
      return [{
        type: 'time_anomaly',
        severity: 'low' as const,
        title: '深夜时段流量异常',
        message: `深夜 (2-5点) 平均请求 ${nightAvg.toFixed(1)}/h，远超全天均值 ${allAvg.toFixed(1)}/h`,
        details: { nightAvg, allAvg, ratio: (nightAvg / allAvg).toFixed(2) },
      }];
    }
    return [];
  }

  /** 模式 5: 爬虫增强 — UA 缺失 + 请求间隔标准差 < 100ms */
  private async detectCrawlerEnhanced(): Promise<AnomalyDetectionResult[]> {
    const cutoff = new Date(Date.now() - 15 * 60 * 1000);
    const rows = await this.dataSource.query(
      `SELECT ip, COUNT(*)::int as request_count
       FROM "access_logs"
       WHERE "createdAt" >= $1 AND ("userAgent" IS NULL OR "userAgent" = '')
       GROUP BY ip
       HAVING COUNT(*) > 100`,
      [cutoff],
    );

    // 批量获取所有候选 IP 的时间戳（每 IP 最多 200 条），消除原逐 IP 的 N+1 查询
    const results: AnomalyDetectionResult[] = [];
    if (rows.length === 0) return results;

    const candidateIps = rows.map((r: { ip: string }) => r.ip);
    const timestampRows = await this.dataSource.query(
      `SELECT ip, "createdAt" FROM (
         SELECT ip, "createdAt",
           ROW_NUMBER() OVER (PARTITION BY ip ORDER BY "createdAt" ASC) as rn
         FROM "access_logs"
         WHERE "createdAt" >= $1 AND ip = ANY($2) AND ("userAgent" IS NULL OR "userAgent" = '')
       ) t WHERE rn <= 200 ORDER BY ip, "createdAt" ASC`,
      [cutoff, candidateIps],
    );

    // 按 IP 分组时间戳（查询已按 ip, createdAt 排序，分组后保持时间升序）
    const timestampsByIp = new Map<string, Date[]>();
    for (const tr of timestampRows) {
      const arr = timestampsByIp.get(tr.ip) ?? [];
      arr.push(new Date(tr.createdAt));
      timestampsByIp.set(tr.ip, arr);
    }

    // 对每个候选 IP 计算请求间隔的标准差
    for (const row of rows) {
      const timestamps = timestampsByIp.get(row.ip) ?? [];
      if (timestamps.length < 10) continue;

      const intervals: number[] = [];
      for (let i = 1; i < timestamps.length; i++) {
        intervals.push(timestamps[i].getTime() - timestamps[i - 1].getTime());
      }

      const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const stddev = Math.sqrt(intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / intervals.length);

      if (stddev < 100) { // 间隔标准差 < 100ms
        results.push({
          type: 'crawler_enhanced',
          severity: 'medium' as const,
          title: '疑似爬虫行为(增强)',
          message: `IP ${row.ip} 无UA请求 ${row.request_count} 次，请求间隔标准差 ${stddev.toFixed(1)}ms`,
          details: { ip: row.ip, requestCount: row.request_count, intervalStddev: stddev, meanInterval: mean },
        });
      }
    }

    return results;
  }

  /**
   * 模式 6: 基线偏离 — 当前值偏离 7 天同时段基线 > 3σ
   *
   * 两级判断避免误报：
   * 1. z-score 阈值：> 5 为 critical，> 3 为 high
   * 2. 百分比偏差阈值：bandwidth/qps 至少偏离 20%，防止 stddev 极小
   *    （如 7 天同一时段带宽稳定在 ~8.6M 时 stddev 仅 65K，8% 的波动也会产生 10σ+ 的 z-score）
   *    但需要对均值的 20% 以上才发出告警。error_rate 指标使用纯 z-score
   *    （因为小基数百分比变化也能反映真实异常）。
   */
  private async detectBaselineDeviation(): Promise<AnomalyDetectionResult[]> {
    const results: AnomalyDetectionResult[] = [];

    const minDeviationPct = parseFloat(
      await this.configCache.get(SEC_CONFIG_KEYS.ALERT_BASELINE_MIN_DEVIATION_PCT, '0.2'),
    );
    const zScoreCrit = parseFloat(
      await this.configCache.get(SEC_CONFIG_KEYS.ALERT_BASELINE_ZSCORE_CRIT, '5'),
    );
    const zScoreWarn = parseFloat(
      await this.configCache.get(SEC_CONFIG_KEYS.ALERT_BASELINE_ZSCORE_WARN, '3'),
    );

    try {
      // 获取当前时刻对应的 hour bucket 和 day of week
      // 统一使用 UTC，与指标聚合（UTC）保持一致，避免非 UTC 部署时时区错位导致查不到基线
      const now = new Date();
      const hourBucket = now.getUTCHours();
      const dayOfWeek = now.getUTCDay();

      // 获取过去 5 分钟的实际指标
      const [currentMetrics] = await this.dataSource.query(
        `SELECT "qpsAvg", "totalRequests", "error5xxCount", "totalBandwidth"
         FROM "access_log_metrics_1min"
         WHERE "windowTime" >= $1
         ORDER BY "windowTime" DESC LIMIT 1`,
        [new Date(Date.now() - 5 * 60 * 1000)],
      );

      if (!currentMetrics) return results;

      // 获取对应时段的基线
      const baselines = await this.dataSource.query(
        `SELECT "metricName", "mean", "stddev"
         FROM "baseline_stats"
         WHERE "hourBucket" = $1 AND "dayOfWeek" = $2 AND "sampleCount" >= 5`,
        [hourBucket, dayOfWeek],
      );

      if (baselines.length === 0) return results;

      for (const bl of baselines) {
        const metricName = bl.metricName;
        const mean = Number(bl.mean);
        const stddev = Math.max(Number(bl.stddev), 0.01);

        let currentValue: number;
        switch (metricName) {
          case 'qps': currentValue = Number(currentMetrics.qpsAvg) || 0; break;
          case 'error_rate': currentValue = currentMetrics.totalRequests > 0 ? Number(currentMetrics.error5xxCount) / Number(currentMetrics.totalRequests) : 0; break;
          case 'bandwidth': currentValue = Number(currentMetrics.totalBandwidth) || 0; break;
          default: continue;
        }

        // 百分比偏差门槛：bandwidth/qps 防 stddev 极小导致的误报
        // error_rate 不适用百分比门槛（0→0.03 是 ∞% 但确实异常）
        const isCountMetric = metricName === 'bandwidth' || metricName === 'qps';
        if (isCountMetric && mean > 0) {
          const deviationPct = Math.abs(currentValue - mean) / mean;
          if (deviationPct < minDeviationPct) {
            continue; // 百分比偏差不足，跳过
          }
        }

        const zScore = Math.abs((currentValue - mean) / stddev);
        if (zScore > zScoreCrit) {
          results.push({
            type: 'baseline_deviation',
            severity: 'critical' as const,
            title: `${metricName} 严重偏离基线`,
            message: `当前 ${metricName}=${currentValue.toFixed(2)}, 基线均值=${mean.toFixed(2)}, z-score=${zScore.toFixed(1)}`,
            details: { metricName, currentValue, mean, stddev, zScore },
          });
        } else if (zScore > zScoreWarn) {
          results.push({
            type: 'baseline_deviation',
            severity: 'high' as const,
            title: `${metricName} 偏离基线`,
            message: `当前 ${metricName}=${currentValue.toFixed(2)}, 基线均值=${mean.toFixed(2)}, z-score=${zScore.toFixed(1)}`,
            details: { metricName, currentValue, mean, stddev, zScore },
          });
        }
      }
    } catch (error) {
      this.logger.warn(`基线偏离检测失败: ${(error as Error).message}`);
    }

    return results;
  }
}
