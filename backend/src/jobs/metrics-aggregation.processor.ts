import { Injectable, Logger } from '@nestjs/common';
import { Process, Processor } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bull';
import { AccessLog } from '../common/entities/access-log.entity';
import { QUEUE_NAMES } from './bull-queue.module';

@Injectable()
@Processor(QUEUE_NAMES.METRICS_AGGREGATION)
export class MetricsAggregationProcessor {
  private readonly logger = new Logger(MetricsAggregationProcessor.name);

  constructor(
    @InjectRepository(AccessLog)
    private accessLogRepo: Repository<AccessLog>,
  ) {}

  /**
   * 每分钟聚合 access_logs → access_log_metrics_1min
   *
   * G8-19：滞后一个窗口（聚合上一个已完整结束的分钟，而非当前分钟）。
   * 原实现在 N:00 立即统计 [N-1:00, N:00) 窗口，而 N-1 分钟尾部（如 N-1:59.9）
   * 的日志可能尚未落库，导致该窗口系统性漏计。滞后一个窗口（-60s）后，
   * 聚合的是已完全结束的上一分钟，配合 5s 缓冲日志窗口的写入延迟，指标不再低估。
   */
  @Process('aggregate-1min')
  async aggregate1Min(job: Job<{ windowTime?: string }>): Promise<void> {
    // 滞后一个窗口：聚合「上一分钟」而非当前分钟，避免 N:00 立即统计时 N-1 分钟尾部日志
    // 尚未落库导致漏计。窗口时间 = (now - 60s) 截断到分钟。
    const now = job.data?.windowTime
      ? new Date(new Date(job.data.windowTime).getTime() - 60 * 1000)
      : new Date(Date.now() - 60 * 1000);
    // 使用 UTC 时间截断到分钟，避免跨时区聚合偏差
    const windowTime = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
      0,
      0,
    ));
    // 聚合窗口 = [windowTime - 60s, windowTime)
    const windowStart = new Date(windowTime.getTime() - 60 * 1000);

    try {
      const result = await this.accessLogRepo
        .createQueryBuilder('a')
        .select('COUNT(*)', 'totalRequests')
        // 平均 QPS = 本 1 分钟窗口请求数 / 60s。
        // 原实现按 MAX-MIN 时间跨度做分母（GREATEST 兜底为 1s），仅 1 条记录时跨度为 0，
        // 会把 qpsAvg 错算成原始计数；固定窗口长度作分母语义更准确且稳定。
        .addSelect(
          'ROUND(CAST(CAST(COUNT(*) AS NUMERIC) / 60 AS NUMERIC), 2)',
          'qpsAvg',
        )
        .addSelect(
          `SUM(CASE WHEN a."statusCode" >= 500 THEN 1 ELSE 0 END)`,
          'error5xxCount',
        )
        .addSelect(
          `SUM(CASE WHEN a."statusCode" >= 400 AND a."statusCode" < 500 THEN 1 ELSE 0 END)`,
          'error4xxCount',
        )
        .addSelect('COALESCE(SUM(a."responseSize"), 0)', 'totalBandwidth')
        .addSelect(
          'COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY a.duration), 0)',
          'p95Duration',
        )
        .addSelect(
          'COUNT(DISTINCT a.ip)',
          'uniqueIps',
        )
        .where('a.createdAt >= :windowStart AND a.createdAt < :windowTime', {
          windowStart,
          windowTime,
        })
        .getRawOne<{
          totalRequests: string;
          qpsAvg: string;
          error5xxCount: string;
          error4xxCount: string;
          totalBandwidth: string;
          p95Duration: string;
          uniqueIps: string;
        }>();

      if (result && Number(result.totalRequests || 0) > 0) {
        await this.accessLogRepo.manager.query(
          `INSERT INTO "access_log_metrics_1min" ("windowTime", "totalRequests", "qpsAvg", "error5xxCount", "error4xxCount", "totalBandwidth", "p95Duration", "uniqueIps")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT ("windowTime") DO UPDATE SET
             "totalRequests" = EXCLUDED."totalRequests",
             "qpsAvg" = EXCLUDED."qpsAvg",
             "error5xxCount" = EXCLUDED."error5xxCount",
             "error4xxCount" = EXCLUDED."error4xxCount",
             "totalBandwidth" = EXCLUDED."totalBandwidth",
             "p95Duration" = EXCLUDED."p95Duration",
             "uniqueIps" = EXCLUDED."uniqueIps"`,
          [
            windowTime,
            Number(result.totalRequests),
            Number(result.qpsAvg),
            Number(result.error5xxCount),
            Number(result.error4xxCount),
            Number(result.totalBandwidth),
            Number(result.p95Duration),
            Number(result.uniqueIps),
          ],
        );
      }
    } catch (error) {
      this.logger.warn(
        `Metrics aggregation failed for window ${windowTime.toISOString()}: ${(error as Error).message}`,
      );
      throw error; // Bull will retry
    }
  }
}
