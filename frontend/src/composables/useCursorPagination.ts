import { ref, type Ref } from 'vue';

/**
 * fetchFn 的返回结构 — 与后端游标分页 API 对齐
 */
export interface CursorPageResult<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface UseCursorPaginationReturn<T> {
  /** 累积加载的全部数据 */
  data: Ref<T[]>;
  /** 下一页游标，null 表示无更多页可加载 */
  nextCursor: Ref<string | null>;
  /** 是否还有更多数据 */
  hasMore: Ref<boolean>;
  /** 是否正在加载 */
  loading: Ref<boolean>;
  /** 加载下一页（追加到 data 末尾） */
  loadMore: (
    fetchFn: (cursor: string | null) => Promise<CursorPageResult<T>>,
  ) => Promise<void>;
  /** 重置到初始状态 */
  reset: () => void;
}

/**
 * 游标分页 composable（无限滚动模式）
 *
 * 适用于 Phase 1 游标分页 API。每次 loadMore 会将新数据追加到已有列表末尾，
 * 并通过 loading 守卫防止并发重复请求。
 *
 * @example
 * ```ts
 * const { data, hasMore, loading, loadMore, reset } = useCursorPagination<FileItem>();
 *
 * // 首次加载 / 加载更多
 * await loadMore((cursor) =>
 *   api.get('/admin/files', { params: { cursor, limit: 20 } })
 *     .then(res => res.data.data)
 * );
 *
 * // 重置（切换筛选条件时）
 * reset();
 * ```
 */
export function useCursorPagination<T = unknown>(): UseCursorPaginationReturn<T> {
  const data = ref<T[]>([]) as Ref<T[]>;
  const nextCursor = ref<string | null>(null);
  const hasMore = ref<boolean>(true);
  const loading = ref<boolean>(false);

  /**
   * 加载下一页数据，追加到 data 末尾
   */
  async function loadMore(
    fetchFn: (cursor: string | null) => Promise<CursorPageResult<T>>,
  ): Promise<void> {
    // 加载守卫：防止并发重复请求
    if (loading.value) return;
    // 无更多数据时跳过
    if (!hasMore.value) return;

    loading.value = true;
    try {
      const result = await fetchFn(nextCursor.value);
      data.value = [...data.value, ...result.data];
      nextCursor.value = result.nextCursor;
      hasMore.value = result.hasMore;
    } finally {
      loading.value = false;
    }
  }

  /**
   * 重置分页状态（切换筛选条件或重新加载时使用）
   */
  function reset(): void {
    data.value = [];
    nextCursor.value = null;
    hasMore.value = true;
    loading.value = false;
  }

  return {
    data,
    nextCursor,
    hasMore,
    loading,
    loadMore,
    reset,
  };
}
