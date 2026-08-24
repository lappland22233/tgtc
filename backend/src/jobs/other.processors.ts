import { Injectable, Logger } from '@nestjs/common';
import { Process, Processor } from '@nestjs/bull';
import { DataSource } from 'typeorm';
import { Job } from 'bull';
import { QUEUE_NAMES } from './bull-queue.module';
import { AlertEngineService } from '../alert/alert-engine.service';
import { AlertGateway } from '../alert/alert.gateway';
import { BehaviorAnalyzer } from '../security/behavior-analyzer.service';

@Injectable()
@Processor(QUEUE_NAMES.ALERT_EVALUATION)
export class AlertEvaluationProcessor {
  private readonly logger = new Logger(AlertEvaluationProcessor.name);

  constructor(
    private dataSource: DataSource,
    private alertEngine: AlertEngineService,
    private alertGateway: AlertGateway,
  ) {}

  /** 每 1 分钟评估告警规则 */
  @Process('evaluate-alerts')
  async evaluateAlerts(_job: Job): Promise<void> {
    try {
      // 从预聚合表读取最近 1 分钟的指标
      // 使用 UTC 时间截断到分钟，与 metrics-aggregation 处理器写入窗口保持一致；
      // 若用本地时间截断，非 UTC 部署时永远查不到预聚合窗口，告警系统会静默失效。
      // 评估上一完整分钟，确保聚合任务已有机会写入对应窗口。
      const now = new Date(Date.now() - 60 * 1000);
      const windowTime = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        now.getUTCHours(),
        now.getUTCMinutes(),
        0,
        0,
      ));

      const [metrics] = await this.dataSource.query(
        `SELECT "totalRequests", "qpsAvg", "error5xxCount", "error4xxCount",
                "totalBandwidth", "p95Duration", "uniqueIps"
         FROM "access_log_metrics_1min"
         WHERE "windowTime" = $1`,
        [windowTime],
      );

      if (!metrics) {
        // G3-16：预聚合缺失时静默 return 会漏报告警。改为记录 warn 并 throw，
        // 触发 Bull 重试（与下方 L64-68 的 DB 故障处理一致），待聚合延迟追上后补上评估。
        this.logger.warn(`告警评估缺失预聚合窗口 ${windowTime.toISOString()}，触发重试`);
        throw new Error(`预聚合窗口 ${windowTime.toISOString()} 缺失`);
      }

      // 评估 + 创建告警（规则配置仅读取一次，冷却期原子去重）
      const alerts = await this.alertEngine.evaluateAndCreateAlerts(metrics);
      for (const alert of alerts) {
        this.alertGateway.broadcastAlert({
          id: alert.id,
          ruleId: alert.ruleId,
          level: alert.level,
          title: alert.title,
          message: alert.message || '',
          createdAt: alert.createdAt,
        });
      }
    } catch (error) {
      this.logger.warn(`告警评估失败: ${(error as Error).message}`);
      // 抛出以触发 Bull 重试，避免 DB 暂时不可用导致本次评估永久丢失
      throw error;
    }
  }
}

@Injectable()
@Processor(QUEUE_NAMES.BASELINE_CALCULATION)
export class BaselineCalculationProcessor {
  private readonly logger = new Logger(BaselineCalculationProcessor.name);

  constructor(private behaviorAnalyzer: BehaviorAnalyzer) {}

  /** 每日 04:00 计算过去 7 天基线 */
  @Process('calculate-baseline')
  async calculateBaseline(_job: Job): Promise<void> {
    try {
      await this.behaviorAnalyzer.calculateBaselines();
      this.logger.log('基线计算完成');
    } catch (error) {
      this.logger.error(`基线计算失败: ${(error as Error).message}`);
      throw error;
    }
  }
}

/** Phase 5: 异常行为检测 — 每 15 分钟执行 */
@Injectable()
@Processor(QUEUE_NAMES.ATTACK_DETECTION)
export class AnomalyDetectionProcessor {
  private readonly logger = new Logger(AnomalyDetectionProcessor.name);

  constructor(
    private behaviorAnalyzer: BehaviorAnalyzer,
    private alertEngine: AlertEngineService,
    private alertGateway: AlertGateway,
  ) {}

  @Process('detect-anomalies')
  async detectAnomalies(_job: Job): Promise<void> {
    try {
      const anomalies = await this.behaviorAnalyzer.detectAnomalies();
      if (anomalies.length > 0) {
        const alerts = await this.alertEngine.createAlerts(
          anomalies.map((a) => ({
            ruleId: `ANOMALY_${a.type.toUpperCase()}`,
            level: a.severity === 'critical' ? 'critical' as any : a.severity === 'high' ? 'warning' as any : 'info' as any,
            title: a.title,
            message: a.message,
            context: a.details,
          })),
        );

        for (const alert of alerts) {
          this.alertGateway.broadcastAlert({
            id: alert.id,
            ruleId: alert.ruleId,
            level: alert.level,
            title: alert.title,
            message: alert.message || '',
            createdAt: alert.createdAt,
          });
        }
      }
    } catch (error) {
      this.logger.warn(`异常检测失败: ${(error as Error).message}`);
      // 抛出以触发 Bull 重试，避免 DB 暂时不可用导致本次检测永久丢失
      throw error;
    }
  }
}

@Injectable()
@Processor(QUEUE_NAMES.DATA_ARCHIVAL)
export class DataArchivalProcessor {
  private readonly logger = new Logger(DataArchivalProcessor.name);

  constructor(private _dataSource: DataSource) {}

  /** 每日 02:00 归档超过保留期的日志 */
  @Process('archive-data')
  async archiveData(_job: Job): Promise<void> {
    // 校验保留期：防止误设为 0/负数/NaN 导致删除全部日志
    const retentionDays = Math.max(
      1,
      parseInt(process.env.ACCESS_LOG_RETENTION_DAYS || '30', 10) || 30,
    );
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const BATCH_SIZE = 1000;
    // 单次任务最大分批次数上限（1000 批 = 100 万条），防止无限循环
    const MAX_BATCHES = 1000;

    try {
      let deleted = 0;
      let batches = 0;
      // 分批删除（每批 1000 条），防止大表一次性删除导致长事务
      while (batches < MAX_BATCHES) {
        const result = await this._dataSource.query(
          `DELETE FROM "access_logs" WHERE "createdAt" < $1 AND "id" IN (SELECT "id" FROM "access_logs" WHERE "createdAt" < $1 LIMIT $2)`,
          [cutoff, BATCH_SIZE],
        );
        const count = Array.isArray(result) ? result[0]?.rowCount ?? 0 : (result[1] ?? 0);
        deleted += count;
        batches++;
        if (count < BATCH_SIZE) break;
      }

      // G8-13：file_access_logs 同样纳入保留期清理，避免该表随文件访问无限膨胀。
      // 复用同一 retentionDays 与分批删除策略。
      let fileAccessDeleted = 0;
      let fileAccessBatches = 0;
      while (fileAccessBatches < MAX_BATCHES) {
        const result = await this._dataSource.query(
          `DELETE FROM "file_access_logs" WHERE "createdAt" < $1 AND "id" IN (SELECT "id" FROM "file_access_logs" WHERE "createdAt" < $1 LIMIT $2)`,
          [cutoff, BATCH_SIZE],
        );
        const count = Array.isArray(result) ? result[0]?.rowCount ?? 0 : (result[1] ?? 0);
        fileAccessDeleted += count;
        fileAccessBatches++;
        if (count < BATCH_SIZE) break;
      }

      if (batches >= MAX_BATCHES || fileAccessBatches >= MAX_BATCHES) {
        this.logger.warn(`数据归档达到单次任务批次上限，剩余记录将在下次任务继续归档`);
      }

      if (deleted > 0 || fileAccessDeleted > 0) {
        this.logger.log(`已归档 ${deleted} 条过期访问日志、${fileAccessDeleted} 条过期文件访问日志 (${retentionDays}天前)`);
      }
    } catch (error) {
      this.logger.warn(`数据归档失败: ${(error as Error).message}`);
      throw error;
    }
  }
}

/** Phase 7: 每周一 09:00 生成并发送周报 */
@Injectable()
@Processor(QUEUE_NAMES.DATA_ARCHIVAL)
export class WeeklyReportProcessor {
  private readonly logger = new Logger(WeeklyReportProcessor.name);

  constructor(private dataSource: DataSource) {}

  @Process('weekly-report')
  async generateWeeklyReport(_job: Job): Promise<void> {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    try {
      const [stats] = await this.dataSource.query(
        `SELECT
           COUNT(*)::int as total_requests,
           COUNT(DISTINCT ip)::int as unique_visitors,
           SUM("responseSize")::bigint as total_bandwidth,
           SUM(CASE WHEN "statusCode" >= 500 THEN 1 ELSE 0 END)::int as errors_5xx,
           SUM(CASE WHEN "statusCode" >= 400 AND "statusCode" < 500 THEN 1 ELSE 0 END)::int as errors_4xx
         FROM access_logs WHERE "createdAt" >= $1`,
        [since],
      );

      const [userStats] = await this.dataSource.query(
        `SELECT COUNT(*)::int as new_users FROM "users" WHERE "createdAt" >= $1`,
        [since],
      );

      const [alertStats] = await this.dataSource.query(
        `SELECT COUNT(*)::int as total_alerts,
                SUM(CASE WHEN "acknowledgedAt" IS NULL THEN 1 ELSE 0 END)::int as unacknowledged
         FROM alerts WHERE "createdAt" >= $1`,
        [since],
      );

      this.logger.log(
        `[周报] 请求: ${stats?.total_requests}, UV: ${stats?.unique_visitors}, ` +
        `带宽: ${(Number(stats?.total_bandwidth || 0) / 1024 / 1024 / 1024).toFixed(2)} GB, ` +
        `5xx: ${stats?.errors_5xx}, 4xx: ${stats?.errors_4xx}, ` +
        `新用户: ${userStats?.new_users}, 告警: ${alertStats?.total_alerts} (${alertStats?.unacknowledged} 未确认)`,
      );
    } catch (error) {
      this.logger.warn(`周报生成失败: ${(error as Error).message}`);
      // 抛出以触发 Bull 重试，避免暂时性故障导致周报永久缺失
      throw error;
    }
  }
}
