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
 * 预聚合指标的时间窗口（秒）。access_log_metrics_1min 按 1 分钟窗口聚合，
 * 带宽 Mbps 换算依赖该窗口，集中定义为常量避免硬编码假设（P2）。
 */
const AGGREGATION_WINDOW_SECONDS = 60;

/**
 * 根据 ConfigCacheService 动态创建告警规则
 * 所有流量/错误阈值和冷却时间均可通过管理面板「安全配置→告警阈值配置」热更新
 *
 * 性能：所有配置项在创建时通过单次 Promise.all 并行读取（P3），
 * 规则闭包捕获解析后的数值；配置非法（NaN）时回退到默认值。
 */
export async function createAlertRules(configCache: ConfigCacheService): Promise<AlertRule[]> {
  const getNum = async (key: string, defaultVal: string): Promise<number> => {
    const parsed = parseFloat(await configCache.get(key, defaultVal));
    return Number.isFinite(parsed) ? parsed : parseFloat(defaultVal);
  };
  const getInt = async (key: string, defaultVal: string): Promise<number> => {
    const parsed = parseInt(await configCache.get(key, defaultVal), 10);
    return Number.isFinite(parsed) ? parsed : parseInt(defaultVal, 10);
  };

  // 并行读取全部阈值与冷却配置（原实现为 12 次串行 await）
  const [
    qpsWarning,
    qpsCritical,
    bandwidthMbps,
    err5xxRate,
    err5xxSpike,
    err4xxSpike,
    cooldownQpsWarn,
    cooldownQpsCrit,
    cooldownBandwidth,
    cooldown5xxRate,
    cooldown5xxSpike,
    cooldown4xxSpike,
  ] = await Promise.all([
    // 流量告警阈值
    getNum(SEC_CONFIG_KEYS.ALERT_QPS_WARNING, '100'),
    getNum(SEC_CONFIG_KEYS.ALERT_QPS_CRITICAL, '300'),
    getNum(SEC_CONFIG_KEYS.ALERT_BANDWIDTH_MBPS, '100'),
    // 错误告警阈值
    getNum(SEC_CONFIG_KEYS.ALERT_5XX_RATE, '0.1'),
    getNum(SEC_CONFIG_KEYS.ALERT_5XX_SPIKE, '50'),
    getNum(SEC_CONFIG_KEYS.ALERT_4XX_SPIKE, '200'),
    // 冷却时间
    getInt(SEC_CONFIG_KEYS.ALERT_COOLDOWN_QPS_WARN, '10'),
    getInt(SEC_CONFIG_KEYS.ALERT_COOLDOWN_QPS_CRIT, '5'),
    getInt(SEC_CONFIG_KEYS.ALERT_COOLDOWN_BANDWIDTH, '10'),
    getInt(SEC_CONFIG_KEYS.ALERT_COOLDOWN_5XX_RATE, '15'),
    getInt(SEC_CONFIG_KEYS.ALERT_COOLDOWN_5XX_SPIKE, '5'),
    getInt(SEC_CONFIG_KEYS.ALERT_COOLDOWN_4XX_SPIKE, '10'),
  ]);

  return [
    // ===== 流量告警 =====
    {
      id: 'TRAFFIC_QPS',
      name: 'QPS 偏高',
      level: AlertLevel.WARNING,
      cooldownMinutes: cooldownQpsWarn,
      evaluate: async (m) => {
        return m.qpsAvg > qpsWarning
          ? `当前 QPS: ${m.qpsAvg.toFixed(1)}，阈值: ${qpsWarning}，请求数: ${m.totalRequests}/min`
          : null;
      },
    },
    {
      id: 'TRAFFIC_QPS_CRIT',
      name: 'QPS 严重偏高',
      level: AlertLevel.CRITICAL,
      cooldownMinutes: cooldownQpsCrit,
      evaluate: async (m) => {
        return m.qpsAvg > qpsCritical
          ? `当前 QPS: ${m.qpsAvg.toFixed(1)}，阈值: ${qpsCritical}，请求数: ${m.totalRequests}/min`
          : null;
      },
    },
    {
      id: 'TRAFFIC_BANDWIDTH',
      name: '带宽偏高',
      level: AlertLevel.WARNING,
      cooldownMinutes: cooldownBandwidth,
      evaluate: async (m) => {
        const mbps = Number(m.totalBandwidth) / (AGGREGATION_WINDOW_SECONDS * 1024 * 1024);
        return mbps > bandwidthMbps ? `带宽: ${mbps.toFixed(1)} Mbps，阈值: ${bandwidthMbps} Mbps` : null;
      },
    },

    // ===== 错误告警 =====
    {
      id: 'ERROR_5XX_RATE',
      name: '5xx 错误率偏高',
      level: AlertLevel.CRITICAL,
      cooldownMinutes: cooldown5xxRate,
      evaluate: async (m) => {
        if (m.totalRequests === 0) return null;
        const rate = m.error5xxCount / m.totalRequests;
        return rate > err5xxRate
          ? `5xx: ${m.error5xxCount}/${m.totalRequests} (${(rate * 100).toFixed(1)}%)，阈值: ${(err5xxRate * 100).toFixed(1)}%`
          : null;
      },
    },
    {
      id: 'ERROR_5XX_SPIKE',
      name: '5xx 错误激增',
      level: AlertLevel.WARNING,
      cooldownMinutes: cooldown5xxSpike,
      evaluate: async (m) => {
        return m.error5xxCount > err5xxSpike
          ? `5xx 错误: ${m.error5xxCount} 次，阈值: ${err5xxSpike} 次`
          : null;
      },
    },
    {
      id: 'ERROR_404_SPIKE',
      name: '404 错误激增',
      level: AlertLevel.WARNING,
      cooldownMinutes: cooldown4xxSpike,
      evaluate: async (m) => {
        return m.error4xxCount > err4xxSpike
          ? `4xx 错误: ${m.error4xxCount} 次，阈值: ${err4xxSpike} 次`
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
