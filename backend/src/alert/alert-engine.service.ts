import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { Alert } from '../common/entities/alert.entity';
import { ALERT_RULES, AlertRuleEvaluation } from './alert.rules';

@Injectable()
export class AlertEngineService {
  private readonly logger = new Logger(AlertEngineService.name);

  constructor(
    @InjectRepository(Alert)
    private alertRepo: Repository<Alert>,
  ) {}

  /**
   * 评估所有规则的触发条件
   * @param metrics 预聚合指标（来自 access_log_metrics_1min）
   */
  async evaluate(metrics: {
    totalRequests: number;
    qpsAvg: number;
    error5xxCount: number;
    error4xxCount: number;
    totalBandwidth: number;
    p95Duration: number;
    uniqueIps: number;
  }): Promise<AlertRuleEvaluation[]> {
    const evaluations: AlertRuleEvaluation[] = [];

    for (const rule of ALERT_RULES) {
      const reason = rule.evaluate(metrics);
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
   * 检查冷却期：同规则在冷却期内是否已有告警
   * @returns true = 冷却中，不应再发
   */
  async isInCooldown(ruleId: string, cooldownMinutes: number): Promise<boolean> {
    const since = new Date(Date.now() - cooldownMinutes * 60 * 1000);
    const count = await this.alertRepo.count({
      where: { ruleId, createdAt: MoreThan(since) },
    });
    return count > 0;
  }

  /** 批量创建告警记录（带冷却过滤） */
  async createAlerts(evaluations: AlertRuleEvaluation[]): Promise<Alert[]> {
    const alerts: Alert[] = [];
    for (const eval_ of evaluations) {
      const rule = ALERT_RULES.find((r) => r.id === eval_.ruleId);
      const cooldownMinutes = rule?.cooldownMinutes || 5;

      if (await this.isInCooldown(eval_.ruleId, cooldownMinutes)) {
        continue;
      }

      const alert = this.alertRepo.create({
        ruleId: eval_.ruleId,
        level: eval_.level,
        title: eval_.title,
        message: eval_.message,
        context: eval_.context,
      });
      await this.alertRepo.save(alert);
      alerts.push(alert);
    }

    if (alerts.length > 0) {
      this.logger.warn(`创建 ${alerts.length} 条告警: ${alerts.map((a) => a.title).join(', ')}`);
    }

    return alerts;
  }

  /** 获取未确认告警数量 */
  async getUnacknowledgedCount(): Promise<number> {
    return this.alertRepo.count({ where: { acknowledgedAt: null } as any });
  }
}
