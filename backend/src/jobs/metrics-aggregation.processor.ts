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

  /** 每分钟聚合 access_logs → access_log_metrics_1min */
  @Process('aggregate-1min')
  async aggregate1Min(job: Job<{ windowTime?: string }>): Promise<void> {
    const now = job.data?.windowTime
      ? new Date(job.data.windowTime)
      : new Date();
    const windowTime = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      now.getHours(),
      now.getMinutes(),
      0,
      0,
    );
    const windowStart = new Date(windowTime.getTime() - 60 * 1000);

    try {
      const result = await this.accessLogRepo
        .createQueryBuilder('a')
        .select('COUNT(*)', 'totalRequests')
        .addSelect(
          'ROUND(CAST(COUNT(*) AS FLOAT) / GREATEST(EXTRACT(EPOCH FROM (MAX("createdAt") - MIN("createdAt"))), 1), 2)',
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
