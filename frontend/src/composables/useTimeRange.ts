import { ref, computed, type ComputedRef, type Ref } from 'vue';

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

/**
 * 解析时间范围字符串为毫秒数
 */
function parseRangeMs(range: string): number {
  const match = range.match(/^(\d+)([hd])$/);
  if (!match) return 0;
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

  /** UTC 起始时间 — 根据选中范围计算 */
  const since = computed<string>(() => {
    const now = Date.now();
    const ms = parseRangeMs(timeRange.value);
    return new Date(now - ms).toISOString();
  });

  /** UTC 结束时间 — 当前时刻 */
  const until = computed<string>(() => {
    return new Date().toISOString();
  });

  return {
    timeRange,
    since,
    until,
    timeRangeOptions,
  };
}
