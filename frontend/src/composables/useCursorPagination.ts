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
  data: Ref<T[]>;
  nextCursor: Ref<string | null>;
  hasMore: Ref<boolean>;
  loading: Ref<boolean>;
  loadMore: (
    fetchFn: (cursor: string | null, signal: AbortSignal) => Promise<CursorPageResult<T>>,
  ) => Promise<void>;
  reset: () => void;
}

/**
 * 游标分页 composable（无限滚动模式）
 *
 * 使用代际计数器 (generation) 解决 reset() 后旧 loadMore 数据污染新状态的竞态问题。
 * 每次 reset() 递增 generation，loadMore 完成时检查 generation 是否匹配，不匹配则丢弃结果。
 *
 * @example
 * ```ts
 * const { data, hasMore, loading, loadMore, reset } = useCursorPagination<FileItem>();
 *
 * await loadMore((cursor, signal) =>
 *   api.get('/admin/files', { params: { cursor, limit: 20 }, signal })
 *     .then(res => res.data.data)
 * );
 *
 * // 切换筛选条件时
 * reset();
 * ```
 */
export function useCursorPagination<T = unknown>(): UseCursorPaginationReturn<T> {
  const _data = ref<T[]>([]) as Ref<T[]>;
  const _nextCursor = ref<string | null>(null);
  const _hasMore = ref<boolean>(true);
  const _loading = ref<boolean>(false);

  // 代际计数器：每次 reset() 递增，loadMore 结束时比对
  let generation = 0;
  // 当前代际的 AbortController（仅 cancel 同代请求）
  let currentAbortController: AbortController | null = null;

  /**
   * 加载下一页数据，追加到 data 末尾
   */
  async function loadMore(
    fetchFn: (cursor: string | null, signal: AbortSignal) => Promise<CursorPageResult<T>>,
  ): Promise<void> {
    if (_loading.value) return;
    if (!_hasMore.value) return;

    const gen = generation;

    // 取消同代前一个请求
    if (currentAbortController) {
      currentAbortController.abort();
    }
    const controller = new AbortController();
    currentAbortController = controller;

    _loading.value = true;
    try {
      const cursorBefore = _nextCursor.value;
      // 传入 AbortSignal，fetchFn 内部可检测取消
      const result = await fetchFn(_nextCursor.value, controller.signal);

      // 代际检查：如果在此请求期间发生了 reset()，丢弃结果
      if (gen !== generation) return;

      // 防护 1: 空页停止
      if (!result.data || result.data.length === 0) {
        _hasMore.value = false;
        return;
      }
      // 防护 2: 游标未推进停止
      if (result.nextCursor !== null && result.nextCursor === cursorBefore) {
        _hasMore.value = false;
        return;
      }

      _data.value = [..._data.value, ...result.data];
      _nextCursor.value = result.nextCursor;
      _hasMore.value = result.hasMore;
    } finally {
      // 仅当还是当前代际时更新 loading 状态
      if (gen === generation) {
        _loading.value = false;
        if (currentAbortController === controller) {
          currentAbortController = null;
        }
      }
    }
  }

  /**
   * 重置分页状态，取消所有进行中的加载
   */
  function reset(): void {
    generation++;
    _data.value = [];
    _nextCursor.value = null;
    _hasMore.value = true;
    _loading.value = false;
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
  }

  return {
    data: _data,
    nextCursor: _nextCursor,
    hasMore: _hasMore,
    loading: _loading,
    loadMore,
    reset,
  };
}
