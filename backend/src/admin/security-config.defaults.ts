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

  // --- 流量与限流 ---
  DOWNLOAD_RATE_LIMIT: 'sec_download_rate_limit',
  DOWNLOAD_RATE_WINDOW: 'sec_download_rate_window',
  DOWNLOAD_RATE_BAN: 'sec_download_rate_ban',
  LOGIN_MAX_FAILURES: 'sec_login_max_failures',
  LOGIN_LOCK_DURATION: 'sec_login_lock_duration',
  CODE_MAX_ERRORS: 'sec_code_max_errors',
  PWD_ERROR_LIMIT: 'sec_pwd_error_limit',
  PWD_BAN_DURATION: 'sec_pwd_ban_duration',
  SEARCH_RATE_LIMIT: 'sec_search_rate_limit',
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

  // --- 流量与限流默认值 ---
  [SEC_CONFIG_KEYS.DOWNLOAD_RATE_LIMIT]: '10',
  [SEC_CONFIG_KEYS.DOWNLOAD_RATE_WINDOW]: '60',
  [SEC_CONFIG_KEYS.DOWNLOAD_RATE_BAN]: '1',
  [SEC_CONFIG_KEYS.LOGIN_MAX_FAILURES]: '5',
  [SEC_CONFIG_KEYS.LOGIN_LOCK_DURATION]: '15',
  [SEC_CONFIG_KEYS.CODE_MAX_ERRORS]: '5',
  [SEC_CONFIG_KEYS.PWD_ERROR_LIMIT]: '5',
  [SEC_CONFIG_KEYS.PWD_BAN_DURATION]: '5',
  [SEC_CONFIG_KEYS.SEARCH_RATE_LIMIT]: '30',
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

  // --- 流量与限流 ---
  {
    key: SEC_CONFIG_KEYS.DOWNLOAD_RATE_LIMIT,
    label: '下载频率上限',
    description: '同一 IP 每分钟允许的最大下载次数',
    type: 'number', min: 1, max: 200, step: 1,
    unit: '次/分钟',
    category: '流量与限流',
  },
  {
    key: SEC_CONFIG_KEYS.DOWNLOAD_RATE_WINDOW,
    label: '下载限流窗口',
    description: '下载次数计数的滑动窗口',
    type: 'number', min: 10, max: 600, step: 10,
    unit: '秒',
    category: '流量与限流',
  },
  {
    key: SEC_CONFIG_KEYS.DOWNLOAD_RATE_BAN,
    label: '下载超限封禁时长',
    description: '超出下载频率上限后的自动封禁时长',
    type: 'number', min: 1, max: 60, step: 1,
    unit: '分钟',
    category: '流量与限流',
  },
  {
    key: SEC_CONFIG_KEYS.LOGIN_MAX_FAILURES,
    label: '登录失败上限',
    description: '窗口内登录失败超过此次数触发锁定',
    type: 'number', min: 3, max: 20, step: 1,
    unit: '次',
    category: '流量与限流',
  },
  {
    key: SEC_CONFIG_KEYS.LOGIN_LOCK_DURATION,
    label: '登录锁定时长',
    description: '登录失败超限后的锁定时间',
    type: 'number', min: 5, max: 120, step: 5,
    unit: '分钟',
    category: '流量与限流',
  },
  {
    key: SEC_CONFIG_KEYS.CODE_MAX_ERRORS,
    label: '验证码错误上限',
    description: '验证码连续错误超过此次数触发锁定',
    type: 'number', min: 3, max: 10, step: 1,
    unit: '次',
    category: '流量与限流',
  },
  {
    key: SEC_CONFIG_KEYS.PWD_ERROR_LIMIT,
    label: '密码错误上限',
    description: '文件密码连续错误超过此次数触发 IP 封禁',
    type: 'number', min: 3, max: 20, step: 1,
    unit: '次',
    category: '流量与限流',
  },
  {
    key: SEC_CONFIG_KEYS.PWD_BAN_DURATION,
    label: '密码错误封禁时长',
    description: '密码错误超限后的 IP 封禁时长',
    type: 'number', min: 1, max: 60, step: 1,
    unit: '分钟',
    category: '流量与限流',
  },
  {
    key: SEC_CONFIG_KEYS.SEARCH_RATE_LIMIT,
    label: '搜索频率上限',
    description: '同一 IP 每分钟允许的最大文件搜索次数',
    type: 'number', min: 10, max: 200, step: 5,
    unit: '次/分钟',
    category: '流量与限流',
  },
];
