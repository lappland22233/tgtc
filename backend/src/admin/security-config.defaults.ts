/**
 * 安全规则可配置化 — 默认值与 key 定义
 * 所有阈值通过 system_configs 表存储，支持热更新（无需重启）
 */

export const SEC_CONFIG_KEYS = {
  // --- 高频扫描检测 ---
  SCAN_REQUESTS_THRESHOLD: 'sec_scan_requests',
  SCAN_PATHS_THRESHOLD: 'sec_scan_paths',
  SCAN_WINDOW_MINUTES: 'sec_scan_window',
  SCAN_BAN_DURATION_HOURS: 'sec_scan_ban_duration',

  // --- 登录爆破检测 ---
  BRUTE_FORCE_THRESHOLD: 'sec_bruteforce_attempts',
  BRUTE_FORCE_WINDOW_MINUTES: 'sec_bruteforce_window',
  BRUTE_FORCE_BAN_DURATION_HOURS: 'sec_bruteforce_ban_duration',

  // --- 爬虫检测 ---
  CRAWLER_REQUESTS_THRESHOLD: 'sec_crawler_requests',
  CRAWLER_WINDOW_HOURS: 'sec_crawler_window',
  CRAWLER_GET_RATIO: 'sec_crawler_get_ratio',
  CRAWLER_BAN_DURATION_HOURS: 'sec_crawler_ban_duration',

  // --- 异常下载检测 ---
  DOWNLOAD_THRESHOLD: 'sec_download_count',
  DOWNLOAD_WINDOW_HOURS: 'sec_download_window',
  DOWNLOAD_BAN_DURATION_HOURS: 'sec_download_ban_duration',
} as const;

/** 安全配置项的后端默认值（硬编码回退） */
export const SEC_CONFIG_DEFAULTS: Record<string, string> = {
  [SEC_CONFIG_KEYS.SCAN_REQUESTS_THRESHOLD]: '300',
  [SEC_CONFIG_KEYS.SCAN_PATHS_THRESHOLD]: '50',
  [SEC_CONFIG_KEYS.SCAN_WINDOW_MINUTES]: '5',
  [SEC_CONFIG_KEYS.SCAN_BAN_DURATION_HOURS]: '1',

  [SEC_CONFIG_KEYS.BRUTE_FORCE_THRESHOLD]: '20',
  [SEC_CONFIG_KEYS.BRUTE_FORCE_WINDOW_MINUTES]: '5',
  [SEC_CONFIG_KEYS.BRUTE_FORCE_BAN_DURATION_HOURS]: '2',

  [SEC_CONFIG_KEYS.CRAWLER_REQUESTS_THRESHOLD]: '50000',
  [SEC_CONFIG_KEYS.CRAWLER_WINDOW_HOURS]: '24',
  [SEC_CONFIG_KEYS.CRAWLER_GET_RATIO]: '0.99',
  [SEC_CONFIG_KEYS.CRAWLER_BAN_DURATION_HOURS]: '24',

  [SEC_CONFIG_KEYS.DOWNLOAD_THRESHOLD]: '1000',
  [SEC_CONFIG_KEYS.DOWNLOAD_WINDOW_HOURS]: '24',
  [SEC_CONFIG_KEYS.DOWNLOAD_BAN_DURATION_HOURS]: '6',
};

/** 安全配置前端展示元数据 */
export interface SecurityConfigMeta {
  key: string;
  label: string;
  description: string;
  type: 'number';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  category: string;
}

export const SEC_CONFIG_META: SecurityConfigMeta[] = [
  {
    key: SEC_CONFIG_KEYS.SCAN_REQUESTS_THRESHOLD,
    label: '请求次数阈值',
    description: '检测窗口内超过此次数触发高频扫描判定',
    type: 'number', min: 50, max: 10000, step: 50,
    unit: '次',
    category: '高频扫描检测',
  },
  {
    key: SEC_CONFIG_KEYS.SCAN_PATHS_THRESHOLD,
    label: '唯一路径阈值',
    description: '检测窗口内不同路径数超过此值触发判定',
    type: 'number', min: 10, max: 1000, step: 5,
    unit: '条',
    category: '高频扫描检测',
  },
  {
    key: SEC_CONFIG_KEYS.SCAN_WINDOW_MINUTES,
    label: '检测窗口',
    description: '高频扫描检测的时间窗口',
    type: 'number', min: 1, max: 60, step: 1,
    unit: '分钟',
    category: '高频扫描检测',
  },
  {
    key: SEC_CONFIG_KEYS.SCAN_BAN_DURATION_HOURS,
    label: '自动封禁时长',
    description: '触发高频扫描后自动封禁的时长',
    type: 'number', min: 1, max: 168, step: 1,
    unit: '小时',
    category: '高频扫描检测',
  },
  {
    key: SEC_CONFIG_KEYS.BRUTE_FORCE_THRESHOLD,
    label: '失败次数阈值',
    description: '检测窗口内 401 次数超过此值触发爆破判定',
    type: 'number', min: 5, max: 500, step: 5,
    unit: '次',
    category: '登录爆破检测',
  },
  {
    key: SEC_CONFIG_KEYS.BRUTE_FORCE_WINDOW_MINUTES,
    label: '检测窗口',
    description: '登录爆破检测的时间窗口',
    type: 'number', min: 1, max: 60, step: 1,
    unit: '分钟',
    category: '登录爆破检测',
  },
  {
    key: SEC_CONFIG_KEYS.BRUTE_FORCE_BAN_DURATION_HOURS,
    label: '自动封禁时长',
    description: '触发登录爆破后自动封禁的时长',
    type: 'number', min: 1, max: 168, step: 1,
    unit: '小时',
    category: '登录爆破检测',
  },
  {
    key: SEC_CONFIG_KEYS.CRAWLER_REQUESTS_THRESHOLD,
    label: '请求次数阈值',
    description: '检测窗口内超过此次数触发爬虫判定',
    type: 'number', min: 1000, max: 1000000, step: 1000,
    unit: '次',
    category: '爬虫检测',
  },
  {
    key: SEC_CONFIG_KEYS.CRAWLER_WINDOW_HOURS,
    label: '检测窗口',
    description: '爬虫检测的时间窗口',
    type: 'number', min: 1, max: 168, step: 1,
    unit: '小时',
    category: '爬虫检测',
  },
  {
    key: SEC_CONFIG_KEYS.CRAWLER_GET_RATIO,
    label: 'GET 请求比例',
    description: 'GET 请求占比超过此值触发爬虫判定',
    type: 'number', min: 0.5, max: 1, step: 0.01,
    category: '爬虫检测',
  },
  {
    key: SEC_CONFIG_KEYS.CRAWLER_BAN_DURATION_HOURS,
    label: '自动封禁时长',
    description: '触发爬虫检测后自动封禁的时长',
    type: 'number', min: 1, max: 720, step: 1,
    unit: '小时',
    category: '爬虫检测',
  },
  {
    key: SEC_CONFIG_KEYS.DOWNLOAD_THRESHOLD,
    label: '下载次数阈值',
    description: '检测窗口内下载次数超过此值触发异常下载判定',
    type: 'number', min: 100, max: 100000, step: 100,
    unit: '次',
    category: '异常下载检测',
  },
  {
    key: SEC_CONFIG_KEYS.DOWNLOAD_WINDOW_HOURS,
    label: '检测窗口',
    description: '异常下载检测的时间窗口',
    type: 'number', min: 1, max: 168, step: 1,
    unit: '小时',
    category: '异常下载检测',
  },
  {
    key: SEC_CONFIG_KEYS.DOWNLOAD_BAN_DURATION_HOURS,
    label: '自动封禁时长',
    description: '触发异常下载后自动封禁的时长',
    type: 'number', min: 1, max: 168, step: 1,
    unit: '小时',
    category: '异常下载检测',
  },
];
