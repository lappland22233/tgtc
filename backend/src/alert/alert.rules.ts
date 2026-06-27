import { AlertLevel } from '../common/entities/alert.entity';

/** 预聚合指标（来自 access_log_metrics_1min 表） */
export interface AggregatedMetrics {
  totalRequests: number;
  qpsAvg: number;
  error5xxCount: number;
  error4xxCount: number;
  totalBandwidth: number;
  p95Duration: number;
  uniqueIps: number;
}

/** 告警规则定义 */
export interface AlertRule {
  id: string;
  name: string;
  level: AlertLevel;
  cooldownMinutes: number;
  evaluate: (metrics: AggregatedMetrics) => string | null;
}

/** 评估结果 */
export interface AlertRuleEvaluation {
  ruleId: string;
  level: AlertLevel;
  title: string;
  message: string;
  context: Record<string, any>;
}

/** 9 条告警规则 */
export const ALERT_RULES: AlertRule[] = [
  // ===== 流量告警 =====
  {
    id: 'TRAFFIC_QPS',
    name: 'QPS 偏高',
    level: AlertLevel.WARNING,
    cooldownMinutes: 10,
    evaluate: (m) => m.qpsAvg > 100
      ? `当前 QPS: ${m.qpsAvg.toFixed(1)}，请求数: ${m.totalRequests}/min`
      : null,
  },
  {
    id: 'TRAFFIC_QPS_CRIT',
    name: 'QPS 严重偏高',
    level: AlertLevel.CRITICAL,
    cooldownMinutes: 5,
    evaluate: (m) => m.qpsAvg > 300
      ? `当前 QPS: ${m.qpsAvg.toFixed(1)}，请求数: ${m.totalRequests}/min`
      : null,
  },
  {
    id: 'TRAFFIC_BANDWIDTH',
    name: '带宽偏高',
    level: AlertLevel.WARNING,
    cooldownMinutes: 10,
    evaluate: (m) => {
      const mbps = Number(m.totalBandwidth) / (60 * 1024 * 1024);
      return mbps > 100 ? `带宽: ${mbps.toFixed(1)} Mbps` : null;
    },
  },

  // ===== 错误告警 =====
  {
    id: 'ERROR_5XX_RATE',
    name: '5xx 错误率偏高',
    level: AlertLevel.CRITICAL,
    cooldownMinutes: 15,
    evaluate: (m) => {
      if (m.totalRequests === 0) return null;
      const rate = m.error5xxCount / m.totalRequests;
      return rate > 0.1
        ? `5xx: ${m.error5xxCount}/${m.totalRequests} (${(rate * 100).toFixed(1)}%)`
        : null;
    },
  },
  {
    id: 'ERROR_5XX_SPIKE',
    name: '5xx 错误激增',
    level: AlertLevel.WARNING,
    cooldownMinutes: 5,
    evaluate: (m) => m.error5xxCount > 50
      ? `5xx 错误: ${m.error5xxCount} 次`
      : null,
  },
  {
    id: 'ERROR_404_SPIKE',
    name: '404 错误激增',
    level: AlertLevel.WARNING,
    cooldownMinutes: 10,
    evaluate: (m) => m.error4xxCount > 200
      ? `4xx 错误: ${m.error4xxCount} 次`
      : null,
  },

  // ===== 安全告警（由 attack-detection processor 触发） =====
  {
    id: 'SEC_IP_FLOOD',
    name: '单IP高频访问',
    level: AlertLevel.CRITICAL,
    cooldownMinutes: 5,
    evaluate: () => null,
  },
  {
    id: 'SEC_BRUTE_FORCE',
    name: '登录爆破',
    level: AlertLevel.CRITICAL,
    cooldownMinutes: 15,
    evaluate: () => null,
  },
  {
    id: 'SEC_ABNORMAL_DOWNLOAD',
    name: '异常下载',
    level: AlertLevel.WARNING,
    cooldownMinutes: 30,
    evaluate: () => null,
  },
];
