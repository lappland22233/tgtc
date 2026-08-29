import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Alert } from '../common/entities/alert.entity';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { randomUUID } from 'crypto';
import { databaseCurrentTimestamp, databaseQuery, getDatabaseType } from '../database/database-types';
import { createAlertRules, AlertRuleEvaluation, AlertRule, AggregatedMetrics } from './alert.rules';

@Injectable()
export class AlertEngineService {
  private readonly logger = new Logger(AlertEngineService.name);

  constructor(
    @InjectRepository(Alert)
    private alertRepo: Repository<Alert>,
    private configCache: ConfigCacheService,
  ) {}

  /**
   * 评估所有规则的触发条件
   * @param metrics 预聚合指标（来自 access_log_metrics_1min）
   */
  async evaluate(metrics: AggregatedMetrics): Promise<AlertRuleEvaluation[]> {
    const rules = await createAlertRules(this.configCache);
    return this.evaluateWithRules(metrics, rules);
  }

  /**
   * 评估并创建告警（一体化入口）
   * 规则配置仅读取一次，随后评估 + 原子化创建，避免 evaluate()/createAlerts()
   * 分别调用时重复读取配置（P2）。
   */
  async evaluateAndCreateAlerts(metrics: AggregatedMetrics): Promise<Alert[]> {
    const rules = await createAlertRules(this.configCache);
    const evaluations = await this.evaluateWithRules(metrics, rules);
    if (evaluations.length === 0) return [];
    return this.createAlerts(evaluations, rules);
  }

  private async evaluateWithRules(
    metrics: AggregatedMetrics,
    rules: AlertRule[],
  ): Promise<AlertRuleEvaluation[]> {
    const evaluations: AlertRuleEvaluation[] = [];
    for (const rule of rules) {
      const reason = await rule.evaluate(metrics);
      if (reason) {
        evaluations.push({
          ruleId: rule.id,
          level: rule.level,
          title: rule.name,
          message: reason,
          context: { qps: metrics.qpsAvg, errors: metrics.error5xxCount },
        });
      }
    }
    return evaluations;
  }

  /**
   * 批量创建告警记录（带冷却过滤）
   *
   * 冷却去重使用单条原子 INSERT ... WHERE NOT EXISTS 完成（P1 修复 TOCTOU）：
   * 原实现「先 COUNT 检查冷却 → 再 INSERT」在两步之间存在竞态，多实例/并发下
   * 冷却期内会重复创建告警。改为单语句后，检查与写入原子化。
   *
   * @param evaluations 评估结果
   * @param preloadedRules 可选，已加载的规则（避免重复读取配置）
   */
  async createAlerts(
    evaluations: AlertRuleEvaluation[],
    preloadedRules?: AlertRule[],
  ): Promise<Alert[]> {
    const rules = preloadedRules ?? (await createAlertRules(this.configCache));
    const alerts: Alert[] = [];

    for (const eval_ of evaluations) {
      const rule = rules.find((r) => r.id === eval_.ruleId);
      const cooldownMinutes = rule?.cooldownMinutes || 5;

      const alert = await this.insertAlertIfNotCoolingDown(eval_, cooldownMinutes);
      if (alert) {
        alerts.push(alert);
      }
    }

    if (alerts.length > 0) {
      this.logger.warn(`创建 ${alerts.length} 条告警: ${alerts.map((a) => a.title).join(', ')}`);
    }

    return alerts;
  }

  /**
   * 原子化创建告警：仅当冷却期内不存在同规则告警时才插入。
   * 单条 SQL 完成「冷却检查 + 插入」，消除 read-then-write 竞态。
   * @returns 新创建的告警；冷却中则返回 null
   */
  private async insertAlertIfNotCoolingDown(
    eval_: AlertRuleEvaluation,
    cooldownMinutes: number,
  ): Promise<Alert | null> {
    const cooldownSince = new Date(Date.now() - cooldownMinutes * 60 * 1000);
    const databaseType = getDatabaseType();
    // PG 18 会分别从 INSERT 目标列和比较运算推断重复参数 $1；显式统一为 varchar，
    // 避免 ruleId 列的 varchar 与比较上下文的 text 产生类型推断冲突。
    const ruleIdParameter = databaseType === 'postgres' ? '$1::varchar' : '$1';
    try {
      const rows = await this.alertRepo.manager.transaction(async (manager) => {
        // PostgreSQL 使用事务级 advisory lock；SQLite 写事务本身串行化，不执行 PG 专用锁。
        if (databaseType === 'postgres') {
          await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [eval_.ruleId]);
        }
        return databaseQuery(manager,
          `INSERT INTO alerts (id, "ruleId", level, title, message, context, "createdAt")
           SELECT $7, ${ruleIdParameter}, $2, $3, $4, $5, ${databaseCurrentTimestamp()}
           WHERE NOT EXISTS (
             SELECT 1 FROM alerts WHERE "ruleId" = ${ruleIdParameter} AND "createdAt" > $6
           )
           RETURNING id, "ruleId", level, title, message, context,
                     "acknowledgedAt", "acknowledgedBy", "createdAt"`,
          [
            eval_.ruleId,
            eval_.level,
            eval_.title,
            eval_.message,
            JSON.stringify(eval_.context ?? {}),
            cooldownSince,
            randomUUID(),
          ],
          databaseType,
        );
      });
      const resultRows = rows as Array<Record<string, unknown>>;
      return resultRows.length > 0 ? (resultRows[0] as unknown as Alert) : null;
    } catch (error) {
      this.logger.error(`创建告警失败 (${eval_.ruleId}): ${(error as Error).message}`);
      throw error;
    }
  }

  /** 获取未确认告警数量 */
  async getUnacknowledgedCount(): Promise<number> {
    return this.alertRepo.count({ where: { acknowledgedAt: null } as any });
  }
}
