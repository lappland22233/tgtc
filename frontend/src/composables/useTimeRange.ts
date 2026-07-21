import { ref, computed, getCurrentScope, onScopeDispose, type ComputedRef, type Ref } from 'vue';

/**
 * 时间范围选项与中文标签映射
 */
export const timeRangeOptions: { value: string; label: string }[] = [
  { value: '1h', label: '最近 1 小时' },
  { value: '24h', label: '最近 24 小时' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
];

/**
 * 返回时间范围值对应的中文标签
 */
export function formatTimeRangeLabel(range: string): string {
  const option = timeRangeOptions.find((o) => o.value === range);
  return option?.label ?? range;
}

/** 默认时间窗口（24h），用于非法格式的兜底 */
const DEFAULT_RANGE_MS = 24 * 60 * 60 * 1000;

/**
 * 解析时间范围字符串为毫秒数
 */
function parseRangeMs(range: string): number {
  const match = range.match(/^(\d+)([hd])$/);
  if (!match) {
    // 非法格式不再静默返回 0（会导致 since===until 空窗口），告警并回退到 24h
    console.warn(`[useTimeRange] 非法时间范围格式: "${range}"，已回退到 24h`);
    return DEFAULT_RANGE_MS;
  }
  const num = parseInt(match[1], 10);
  const unit = match[2];
  return unit === 'h' ? num * 60 * 60 * 1000 : num * 24 * 60 * 60 * 1000;
}

export interface UseTimeRangeReturn {
  /** 当前选中的时间范围值 (ref) */
  timeRange: Ref<string>;
  /** 起始时间 (UTC ISO8601 字符串) */
  since: ComputedRef<string>;
  /** 结束时间 (UTC ISO8601 字符串) */
  until: ComputedRef<string>;
  /** 时间范围选项列表 */
  timeRangeOptions: { value: string; label: string }[];
}

/**
 * 时间范围选择 composable
 *
 * @param defaultRange - 默认时间范围，如 '24h'
 *
 * @example
 * ```ts
 * const { timeRange, since, until } = useTimeRange('24h');
 * // 用于 API 调用（UTC 时间戳）
 * api.get('/stats', { params: { since: since.value, until: until.value } });
 * // 用于本地显示（转为本地时区）
 * new Date(since.value).toLocaleString('zh-CN');
 * ```
 */
export function useTimeRange(defaultRange: string = '24h'): UseTimeRangeReturn {
  const timeRange = ref<string>(defaultRange);

  // 响应式“当前时间”：周期性刷新，使 since/until 随时间推移重新计算。
  // 否则 computed 仅在 timeRange 变化时重算，自动刷新时时间窗口会“冻结”在首次计算值。
  const now = ref<number>(Date.now());
  if (getCurrentScope()) {
    const nowTimer = setInterval(() => { now.value = Date.now(); }, 30 * 1000);
    onScopeDispose(() => clearInterval(nowTimer));
  }

  /** UTC 起始时间 — 根据选中范围计算 */
  const since = computed<string>(() => {
    const ms = parseRangeMs(timeRange.value);
    return new Date(now.value - ms).toISOString();
  });

  /** UTC 结束时间 — 当前时刻 */
  const until = computed<string>(() => {
    return new Date(now.value).toISOString();
  });

  return {
    timeRange,
    since,
    until,
    timeRangeOptions,
  };
}
