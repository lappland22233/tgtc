/**
 * 文件列表查询域 composable（FileList.vue 专用）
 *
 * 职责：
 * - 查询状态：搜索关键字 / 排序字段与方向 / 标签筛选（与 URL query 双向同步）。
 * - 游标无限滚动：页码驱动 loadMore（偏移分页支持自定义排序），结合 IntersectionObserver 哨兵。
 * - 标签筛选动作（增 / 删 / 清空 / 面板切换）。
 * - 排序切换。
 *
 * 依赖注入：
 * - fileStore / folderStore / route / router：查询所需 store 与路由上下文。
 *
 * 边界：
 * - 文件夹导航（route.query.folder watch → openFolder → 刷新）由宿主组件负责，
 *   本模块仅提供 refetchFiles 供其复用。
 * - 选择 / 批量操作 / 弹窗 / 预览等动作域不属于本模块。
 */
import { ref, computed, watch, onUnmounted } from 'vue';
import type { RouteLocationNormalizedLoaded } from 'vue-router';
import type { Router } from 'vue-router';
import { useFileStore } from '../stores/files';
import { useFolderStore } from '../stores/folders';
import { useCursorPagination } from './useCursorPagination';
import type { FileItem } from '../types/file';

export interface FileListQueryOptions {
  fileStore: ReturnType<typeof useFileStore>;
  folderStore: ReturnType<typeof useFolderStore>;
  route: RouteLocationNormalizedLoaded;
  router: Router;
}

export function useFileListQuery(options: FileListQueryOptions) {
  const { fileStore, folderStore, route, router } = options;

  // ─── 查询状态（与 URL query 双向同步） ───
  const search = ref((route.query.search as string) || '');
  const sortBy = ref<string>(route.query.sortBy as string || '');
  const sortOrder = ref<string>(route.query.sortOrder as string || '');
  const selectedTagIds = ref<string[]>(
    (route.query.tagIds as string || '').split(',').filter(Boolean),
  );

  /**
   * 已生效查询关键词快照（搜索修复）：
   * - searchRef 是输入框实时值，submit/clear 时才写入 submittedSearch；
   * - 分页/续页一律读取 submittedSearch，避免旧输入混入新请求；
   * - displayedSearch 在新代际首页成功后原子切换，供目录列表等展示层过滤使用，
   *   保证"文件结果"与"文件夹结果"始终来自同一时刻的查询。
   */
  const submittedSearch = ref(search.value);
  const displayedSearch = ref(search.value);

  /** 当前文件夹 ID 的 API 表示（null → root） */
  const currentFolderIdForApi = computed(() => {
    return folderStore.currentFolderId === null ? 'root' : folderStore.currentFolderId;
  });

  /** 当前列表文件（store 持有，模板直接消费） */
  const displayFiles = computed(() => fileStore.files);

  // ─── 游标无限滚动（页码驱动） ───
  /** 无限滚动每批加载条数（不再提供分页，固定批次） */
  const BATCH_SIZE = 20;
  /**
   * 有界加载上限：防止无限滚动持续追加 DOM 行导致节点 / 缩略图观察器线性增长。
   * 达到该上限后停止自动加载，提示"已加载 N 条 / 继续加载"，用户可手动继续。
   */
  const MAX_LOAD_LIMIT = 500;
  /** 是否已达到加载上限（触发"继续加载"提示） */
  const loadLimitExceeded = ref(false);
  const {
    hasMore,
    loading: cursorLoading,
    loadMore,
    reset: resetCursor,
  } = useCursorPagination<FileItem>();

  /** 滚动哨兵 ref（宿主模板挂载） */
  const scrollSentinel = ref<HTMLElement | null>(null);
  let scrollObserver: IntersectionObserver | null = null;
  /** 列表代际：筛选 / 目录变化时递增，防止旧请求污染新列表 */
  let fileListGeneration = 0;
  const folderLoading = ref(false);
  /** G11-12：搜索/排序重拉时保留旧列表并在其上叠加半透明 loading，避免列表闪空 */
  const refreshing = ref(false);
  /** G11-12：是否在下一页返回时用新数据整体替换旧列表（首次搜索/排序拉取时为 true） */
  let pendingReplaceNextPage = false;
  const listError = ref<unknown>(null);
  /** R6：续页（非首屏）加载失败状态，由哨兵处展示“加载失败，重试”入口 */
  const loadMoreError = ref<unknown>(null);

  /** 开始目录切换：在 openFolder 请求开始前立即清空旧列表，并使旧请求失效。 */
  function beginFolderTransition() {
    fileListGeneration++;
    resetCursor();
    loadLimitExceeded.value = false;
    fileStore.replaceFiles([]);
    listError.value = null;
    loadMoreError.value = null;
    folderLoading.value = true;
    return fileListGeneration;
  }

  async function loadInitialFiles(generation = fileListGeneration + 1, folderId = currentFolderIdForApi.value) {
    if (generation !== fileListGeneration) return;
    fileListGeneration = generation;
    resetCursor();
    listError.value = null;
    // G11-12：搜索/排序重拉时保留旧列表，等待新数据到达后再整体替换，避免列表闪空。
    // 目录切换路径（beginFolderTransition）已先清空列表并展示 folderLoading，此处列表为空时
    // 不额外叠加 refreshing，仅在有旧内容时叠加半透明 loading。
    const hasExistingList = fileStore.files.length > 0;
    pendingReplaceNextPage = true;
    if (hasExistingList) refreshing.value = true;
    try {
      await loadMoreFiles(folderId, true);
    } catch (error) {
      if (generation === fileListGeneration) listError.value = error;
      throw error;
    } finally {
      // 仅当代际未变时清理共享替换标记：旧请求被新筛选取代后，
      // 其 finally 不得清掉新请求的 pendingReplaceNextPage（R5 竞态修复）。
      if (generation === fileListGeneration) {
        pendingReplaceNextPage = false;
        refreshing.value = false;
        folderLoading.value = false;
      }
    }
  }

  /** 构造单页拉取函数（供自动滚动与手动"继续加载"复用） */
  function buildFetchPageFn(folderId: string) {
    // R5：请求级代际捕获。闭包持有构建时刻的不可变代际，
    // 旧请求完成时与当前 fileListGeneration 比较的是自身快照，
    // 修复旧实现共享 pageGeneration 被新请求改写后旧请求误判为“当前代际”的缺口。
    const myGeneration = fileListGeneration;
    return async (cursor: string | null, signal: AbortSignal) => {
      const page = cursor ? parseInt(cursor, 10) : 1;
      const tagIds = selectedTagIds.value.length > 0 ? selectedTagIds.value : undefined;
      try {
        const result = await fileStore.fetchFilesPage(
          page,
          BATCH_SIZE,
          submittedSearch.value || undefined,
          sortBy.value || undefined,
          sortOrder.value || undefined,
          tagIds,
          folderId,
          signal,
        );
        // 即使底层请求未遵守 AbortSignal，也禁止旧筛选/目录请求污染当前列表。
        if (fileListGeneration !== myGeneration) {
          return { data: [], nextCursor: cursor, hasMore: true };
        }
        // G11-12：搜索/排序重拉时，首页返回后用新数据整体替换旧列表（避免追加导致新旧混排）；
        // 其余分页照常追加。首页为空（如搜索无结果）时同样用空数组替换，避免残留旧列表。
        if (pendingReplaceNextPage) {
          fileStore.replaceFiles(result.files);
          pendingReplaceNextPage = false;
          // 搜索修复：新代际首页成功返回后，展示层关键词（目录过滤依据）才原子切换。
          // 首屏失败/取消时不切换，保持"新目录+旧文件"不再出现的旧展示一致性。
          displayedSearch.value = submittedSearch.value;
        } else {
          fileStore.appendFiles(result.files);
        }
        fileStore.total = result.total;
        const loadedAll = fileStore.files.length >= result.total || result.files.length === 0;
        // 有界加载：达到上限后停止自动追加（hasMore=false 使哨兵不再触发），
        // 由用户手动点击"继续加载"突破上限。
        if (!loadedAll && fileStore.files.length >= MAX_LOAD_LIMIT) {
          loadLimitExceeded.value = true;
          return {
            data: result.files,
            nextCursor: String(page + 1),
            hasMore: false,
          };
        }
        loadLimitExceeded.value = false;
        return {
          data: result.files,
          nextCursor: loadedAll ? null : String(page + 1),
          hasMore: !loadedAll,
        };
      } catch (err) {
        const e = err as { name?: string; code?: string };
        if (e.name === 'AbortError' || e.code === 'ERR_CANCELED') {
          return { data: [], nextCursor: cursor, hasMore: true };
        }
        throw err;
      }
    };
  }

  async function loadMoreFiles(folderId = currentFolderIdForApi.value, isInitialLoad = false) {
    if ((!isInitialLoad && folderLoading.value) || !hasMore.value) return;
    const generation = fileListGeneration;
    try {
      await loadMore(buildFetchPageFn(folderId));
      if (generation === fileListGeneration) loadMoreError.value = null;
    } catch (err) {
      const e = err as { name?: string; code?: string };
      if (e.name === 'AbortError' || e.code === 'ERR_CANCELED') return;
      if (generation === fileListGeneration) loadMoreError.value = err;
      if (isInitialLoad) throw err; // 首屏错误沿用 listError 呈现
      // R6：续页失败不再向外抛出（哨兵观察器为 fire-and-forget，避免未处理 rejection），
      // 错误状态由哨兵处“加载失败，重试”入口消费。
      console.warn('[FileList] 续页加载失败（可重试）:', err);
    }
  }

  /**
   * 达到有界加载上限后，手动继续加载下一页。
   * 通过 force 绕过 useCursorPagination 的 hasMore 拦截，单次加载一批后若再次触顶仍会停下。
   */
  async function continueLoadMore() {
    if (folderLoading.value || cursorLoading.value) return;
    try {
      await loadMore(buildFetchPageFn(currentFolderIdForApi.value), true);
      loadMoreError.value = null;
    } catch (err) {
      const e = err as { name?: string; code?: string };
      if (e.name === 'AbortError' || e.code === 'ERR_CANCELED') return;
      loadMoreError.value = err;
      console.warn('[FileList] 手动继续加载失败（可重试）:', err);
    }
  }

  /** R6：续页失败后的就地重试（沿用当前游标/页码，不刷新整张列表） */
  function retryLoadMore() {
    if (folderLoading.value || cursorLoading.value) return;
    loadMoreError.value = null;
    // hasMore 在失败时保持原值（useCursorPagination 不会因错误翻转 hasMore），
    // 失败若发生在触顶后的手动继续（hasMore=false），需走 force 路径。
    if (hasMore.value) {
      void loadMoreFiles();
    } else {
      void continueLoadMore();
    }
  }

  function getFileListGeneration() {
    return fileListGeneration;
  }

  /** 统一的重新获取文件列表（无限滚动：从头加载） */
  async function refetchFiles() {
    // 排序/标签/目录等入口也重走此处：先对齐已生效关键词，保证所有触发路径
    // 的文件查询与目录过滤使用同一关键词快照（搜索修复）。
    submittedSearch.value = search.value;
    const generation = ++fileListGeneration;
    loadMoreError.value = null;
    await loadInitialFiles(generation);
  }

  function applyFilters() {
    refetchFiles();
  }

  // ─── 排序 ───
  function toggleSort(field: string) {
    if (sortBy.value === field) {
      sortOrder.value = sortOrder.value === 'DESC' ? 'ASC' : 'DESC';
    } else {
      sortBy.value = field;
      sortOrder.value = field === 'createdAt' ? 'DESC' : 'ASC';
    }
    refetchFiles();
  }

  // ─── 搜索 ───
  function handleSearch() {
    // 搜索修复：提交时才把输入框值提升为"已生效关键词"并推进代际，
    // 分页/目录过滤从此读取该快照；未提交的输入只影响 URL 同步。
    submittedSearch.value = search.value;
    refetchFiles();
  }

  function handleClearSearch() {
    search.value = '';
    submittedSearch.value = '';
    refetchFiles();
  }

  // ─── 标签筛选 ───
  function addTagFilter(tagId: string) {
    if (!selectedTagIds.value.includes(tagId)) {
      selectedTagIds.value = [...selectedTagIds.value, tagId];
      applyFilters();
    }
  }

  function removeTagFilter(tagId: string) {
    selectedTagIds.value = selectedTagIds.value.filter(id => id !== tagId);
    applyFilters();
  }

  function clearTagFilters() {
    selectedTagIds.value = [];
    applyFilters();
  }

  function handleTagManagerFilter(tagId: string) {
    if (selectedTagIds.value.includes(tagId)) {
      removeTagFilter(tagId);
    } else {
      addTagFilter(tagId);
    }
  }

  // ─── 哨兵无限滚动观察器 ───
  /**
   * 哨兵元素变化时重新挂载 IntersectionObserver。
   * 修复无限滚动失效 Bug：切换文件夹 / 筛选时列表会先清空再重载，os-list 及其内部
   * 哨兵元素随之卸载并重建，旧 observer 仍指向已脱离 DOM 的元素而永不触发。
   */
  watch(scrollSentinel, (el) => {
    if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }
    if (!el) return;
    // G11-25：记录哨兵挂载时刻的代际与目录。目录切换瞬间（代际推进中）哨兵仍可能触发
    // 回调，此时若用旧 folderId 发请求会产生无效/浪费请求——回调内先比对代际，变了则跳过。
    const observerGeneration = fileListGeneration;
    scrollObserver = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && observerGeneration === fileListGeneration) {
          loadMoreFiles();
        }
      },
      { rootMargin: '600px' },
    );
    scrollObserver.observe(el);
  });

  // ─── URL 双向同步（搜索/排序/标签，保留 folder 参数） ───
  // G11-24：搜索框每键入一次都写 URL 会造成大量 router.replace 与历史记录噪音。
  // 这里对 search 相关同步做防抖（仅提交/停顿后写一次），排序/标签即时同步。
  let urlSyncTimer: ReturnType<typeof setTimeout> | null = null;
  function syncUrlToQuery() {
    const query: Record<string, string> = {};
    if (search.value) query.search = search.value;
    if (sortBy.value) query.sortBy = sortBy.value;
    if (sortOrder.value) query.sortOrder = sortOrder.value;
    if (selectedTagIds.value.length > 0) query.tagIds = selectedTagIds.value.join(',');
    if (folderStore.currentFolderId) query.folder = folderStore.currentFolderId;
    router.replace({ query });
  }
  function scheduleUrlSync() {
    if (urlSyncTimer) clearTimeout(urlSyncTimer);
    urlSyncTimer = setTimeout(() => {
      urlSyncTimer = null;
      syncUrlToQuery();
    }, 400);
  }

  watch([search, sortBy, sortOrder, selectedTagIds], (vals, oldVals) => {
    // 仅搜索变化时防抖；排序/标签变化立即同步，保证 URL 与筛选即时一致
    if (vals[0] !== oldVals?.[0]) {
      scheduleUrlSync();
    } else {
      if (urlSyncTimer) clearTimeout(urlSyncTimer);
      urlSyncTimer = null;
      syncUrlToQuery();
    }
  }, { flush: 'post' });

  onUnmounted(() => {
    if (scrollObserver) {
      scrollObserver.disconnect();
      scrollObserver = null;
    }
    if (urlSyncTimer) {
      clearTimeout(urlSyncTimer);
      urlSyncTimer = null;
    }
  });

  return {
    search,
    sortBy,
    sortOrder,
    selectedTagIds,
    currentFolderIdForApi,
    displayFiles,
    displayedSearch,
    submittedSearch,
    hasMore,
    cursorLoading,
    folderLoading,
    refreshing,
    listError,
    loadMoreError,
    retryLoadMore,
    loadLimitExceeded,
    continueLoadMore,
    beginFolderTransition,
    getFileListGeneration,
    scrollSentinel,
    toggleSort,
    handleSearch,
    handleClearSearch,
    refetchFiles,
    applyFilters,
    addTagFilter,
    removeTagFilter,
    clearTagFilters,
    handleTagManagerFilter,
    loadInitialFiles,
    loadMoreFiles,
  };
}
