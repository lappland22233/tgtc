import { AlertLevel } from '../common/entities/alert.entity';
import { ConfigCacheService } from '../common/services/config-cache.service';
import { SEC_CONFIG_KEYS } from '../admin/security-config.defaults';

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
  evaluate: (metrics: AggregatedMetrics) => Promise<string | null>;
}

/** 评估结果 */
export interface AlertRuleEvaluation {
  ruleId: string;
  level: AlertLevel;
  title: string;
  message: string;
  context: Record<string, any>;
}

/**
 * 根据 ConfigCacheService 动态创建告警规则
 * 所有流量/错误阈值和冷却时间均可通过管理面板「安全配置→告警阈值配置」热更新
 */
export async function createAlertRules(configCache: ConfigCacheService): Promise<AlertRule[]> {
  const getNum = async (key: string, defaultVal: string) =>
    parseFloat(await configCache.get(key, defaultVal));
  const getInt = async (key: string, defaultVal: string) =>
    parseInt(await configCache.get(key, defaultVal), 10);

  // 流量告警阈值
  const qpsWarning = () => getNum(SEC_CONFIG_KEYS.ALERT_QPS_WARNING, '100');
  const qpsCritical = () => getNum(SEC_CONFIG_KEYS.ALERT_QPS_CRITICAL, '300');
  const bandwidthMbps = () => getNum(SEC_CONFIG_KEYS.ALERT_BANDWIDTH_MBPS, '100');

  // 错误告警阈值
  const err5xxRate = () => getNum(SEC_CONFIG_KEYS.ALERT_5XX_RATE, '0.1');
  const err5xxSpike = () => getNum(SEC_CONFIG_KEYS.ALERT_5XX_SPIKE, '50');
  const err4xxSpike = () => getNum(SEC_CONFIG_KEYS.ALERT_4XX_SPIKE, '200');

  // 冷却时间
  const cooldownQpsWarn = () => getInt(SEC_CONFIG_KEYS.ALERT_COOLDOWN_QPS_WARN, '10');
  const cooldownQpsCrit = () => getInt(SEC_CONFIG_KEYS.ALERT_COOLDOWN_QPS_CRIT, '5');
  const cooldownBandwidth = () => getInt(SEC_CONFIG_KEYS.ALERT_COOLDOWN_BANDWIDTH, '10');
  const cooldown5xxRate = () => getInt(SEC_CONFIG_KEYS.ALERT_COOLDOWN_5XX_RATE, '15');
  const cooldown5xxSpike = () => getInt(SEC_CONFIG_KEYS.ALERT_COOLDOWN_5XX_SPIKE, '5');
  const cooldown4xxSpike = () => getInt(SEC_CONFIG_KEYS.ALERT_COOLDOWN_4XX_SPIKE, '10');

  return [
    // ===== 流量告警 =====
    {
      id: 'TRAFFIC_QPS',
      name: 'QPS 偏高',
      level: AlertLevel.WARNING,
      cooldownMinutes: await cooldownQpsWarn(),
      evaluate: async (m) => {
        const threshold = await qpsWarning();
        return m.qpsAvg > threshold
          ? `当前 QPS: ${m.qpsAvg.toFixed(1)}，阈值: ${threshold}，请求数: ${m.totalRequests}/min`
          : null;
      },
    },
    {
      id: 'TRAFFIC_QPS_CRIT',
      name: 'QPS 严重偏高',
      level: AlertLevel.CRITICAL,
      cooldownMinutes: await cooldownQpsCrit(),
      evaluate: async (m) => {
        const threshold = await qpsCritical();
        return m.qpsAvg > threshold
          ? `当前 QPS: ${m.qpsAvg.toFixed(1)}，阈值: ${threshold}，请求数: ${m.totalRequests}/min`
          : null;
      },
    },
    {
      id: 'TRAFFIC_BANDWIDTH',
      name: '带宽偏高',
      level: AlertLevel.WARNING,
      cooldownMinutes: await cooldownBandwidth(),
      evaluate: async (m) => {
        const mbps = Number(m.totalBandwidth) / (60 * 1024 * 1024);
        const threshold = await bandwidthMbps();
        return mbps > threshold ? `带宽: ${mbps.toFixed(1)} Mbps，阈值: ${threshold} Mbps` : null;
      },
    },

    // ===== 错误告警 =====
    {
      id: 'ERROR_5XX_RATE',
      name: '5xx 错误率偏高',
      level: AlertLevel.CRITICAL,
      cooldownMinutes: await cooldown5xxRate(),
      evaluate: async (m) => {
        if (m.totalRequests === 0) return null;
        const rate = m.error5xxCount / m.totalRequests;
        const threshold = await err5xxRate();
        return rate > threshold
          ? `5xx: ${m.error5xxCount}/${m.totalRequests} (${(rate * 100).toFixed(1)}%)，阈值: ${(threshold * 100).toFixed(1)}%`
          : null;
      },
    },
    {
      id: 'ERROR_5XX_SPIKE',
      name: '5xx 错误激增',
      level: AlertLevel.WARNING,
      cooldownMinutes: await cooldown5xxSpike(),
      evaluate: async (m) => {
        const threshold = await err5xxSpike();
        return m.error5xxCount > threshold
          ? `5xx 错误: ${m.error5xxCount} 次，阈值: ${threshold} 次`
          : null;
      },
    },
    {
      id: 'ERROR_404_SPIKE',
      name: '404 错误激增',
      level: AlertLevel.WARNING,
      cooldownMinutes: await cooldown4xxSpike(),
      evaluate: async (m) => {
        const threshold = await err4xxSpike();
        return m.error4xxCount > threshold
          ? `4xx 错误: ${m.error4xxCount} 次，阈值: ${threshold} 次`
          : null;
      },
    },

    // ===== 安全告警（由 attack-detection processor 触发） =====
    {
      id: 'SEC_IP_FLOOD',
      name: '单IP高频访问',
      level: AlertLevel.CRITICAL,
      cooldownMinutes: 5,
      evaluate: async () => null,
    },
    {
      id: 'SEC_BRUTE_FORCE',
      name: '登录爆破',
      level: AlertLevel.CRITICAL,
      cooldownMinutes: 15,
      evaluate: async () => null,
    },
    {
      id: 'SEC_ABNORMAL_DOWNLOAD',
      name: '异常下载',
      level: AlertLevel.WARNING,
      cooldownMinutes: 30,
      evaluate: async () => null,
    },
  ];
}

/**
 * 同步获取所有告警规则的元数据（不含阈值评估逻辑）
 * 用于 AlertService.getRules() 返回给前端展示
 */
export function getAlertRuleMetadata() {
  return [
    { id: 'TRAFFIC_QPS', name: 'QPS 偏高', level: AlertLevel.WARNING },
    { id: 'TRAFFIC_QPS_CRIT', name: 'QPS 严重偏高', level: AlertLevel.CRITICAL },
    { id: 'TRAFFIC_BANDWIDTH', name: '带宽偏高', level: AlertLevel.WARNING },
    { id: 'ERROR_5XX_RATE', name: '5xx 错误率偏高', level: AlertLevel.CRITICAL },
    { id: 'ERROR_5XX_SPIKE', name: '5xx 错误激增', level: AlertLevel.WARNING },
    { id: 'ERROR_404_SPIKE', name: '404 错误激增', level: AlertLevel.WARNING },
    { id: 'SEC_IP_FLOOD', name: '单IP高频访问', level: AlertLevel.CRITICAL },
    { id: 'SEC_BRUTE_FORCE', name: '登录爆破', level: AlertLevel.CRITICAL },
    { id: 'SEC_ABNORMAL_DOWNLOAD', name: '异常下载', level: AlertLevel.WARNING },
  ];
}
