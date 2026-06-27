import { ref, onUnmounted, watch, type Ref } from 'vue';

/**
 * 自动刷新间隔选项（秒）
 * 0 表示关闭自动刷新
 */
export const AUTO_REFRESH_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: '关闭' },
  { value: 30, label: '30 秒' },
  { value: 60, label: '1 分钟' },
  { value: 300, label: '5 分钟' },
];

export interface UseAutoRefreshReturn {
  /** 刷新间隔（秒），0 = 关闭 */
  refreshInterval: Ref<number>;
  /** 最近一次刷新时间 */
  lastRefreshTime: Ref<Date | null>;
  /** 是否正在刷新中 */
  isRefreshing: Ref<boolean>;
  /** 手动触发一次刷新 */
  refresh: () => Promise<void>;
}

/**
 * 自动刷新 composable
 *
 * 按可配置的时间间隔定时执行刷新回调。
 * 组件卸载时自动清理计时器，支持动态切换间隔。
 *
 * @param onRefresh - 刷新时执行的异步回调函数
 *
 * @example
 * ```ts
 * const { refreshInterval, lastRefreshTime, isRefreshing } = useAutoRefresh(async () => {
 *   await fetchStats();
 * });
 * ```
 */
export function useAutoRefresh(
  onRefresh: () => Promise<void>,
): UseAutoRefreshReturn {
  const refreshInterval = ref<number>(0);
  const lastRefreshTime = ref<Date | null>(null);
  const isRefreshing = ref(false);

  let timer: ReturnType<typeof setInterval> | null = null;

  /**
   * 执行一次刷新
   */
  async function refresh(): Promise<void> {
    if (isRefreshing.value) return;
    isRefreshing.value = true;
    try {
      await onRefresh();
      lastRefreshTime.value = new Date();
    } finally {
      isRefreshing.value = false;
    }
  }

  /**
   * 根据间隔值启停定时器
   */
  function setupTimer(seconds: number) {
    // 清除已有定时器
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }

    if (seconds > 0) {
      timer = setInterval(() => {
        refresh();
      }, seconds * 1000);
    }
  }

  // 监听间隔变化，动态调整定时器
  watch(refreshInterval, (newVal) => {
    setupTimer(newVal);
  }, { immediate: true });

  // 组件卸载时清理
  onUnmounted(() => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  });

  return {
    refreshInterval,
    lastRefreshTime,
    isRefreshing,
    refresh,
  };
}
