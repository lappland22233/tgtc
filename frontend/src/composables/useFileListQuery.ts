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

  /** 当前文件夹 ID 的 API 表示（null → root） */
  const currentFolderIdForApi = computed(() => {
    return folderStore.currentFolderId === null ? 'root' : folderStore.currentFolderId;
  });

  /** 当前列表文件（store 持有，模板直接消费） */
  const displayFiles = computed(() => fileStore.files);

  // ─── 游标无限滚动（页码驱动） ───
  /** 无限滚动每批加载条数（不再提供分页，固定批次） */
  const BATCH_SIZE = 20;
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
  const listError = ref<unknown>(null);

  /** 开始目录切换：在 openFolder 请求开始前立即清空旧列表，并使旧请求失效。 */
  function beginFolderTransition() {
    fileListGeneration++;
    resetCursor();
    fileStore.replaceFiles([]);
    listError.value = null;
    folderLoading.value = true;
    return fileListGeneration;
  }

  async function loadInitialFiles(generation = fileListGeneration + 1, folderId = currentFolderIdForApi.value) {
    if (generation !== fileListGeneration) return;
    fileListGeneration = generation;
    resetCursor();
    fileStore.replaceFiles([]);
    listError.value = null;
    try {
      await loadMoreFiles(folderId, true);
    } catch (error) {
      if (generation === fileListGeneration) listError.value = error;
      throw error;
    } finally {
      if (generation === fileListGeneration) folderLoading.value = false;
    }
  }

  async function loadMoreFiles(folderId = currentFolderIdForApi.value, isInitialLoad = false) {
    if ((!isInitialLoad && folderLoading.value) || !hasMore.value) return;
    const generation = fileListGeneration;
    await loadMore(async (cursor, signal) => {
      const page = cursor ? parseInt(cursor, 10) : 1;
      const tagIds = selectedTagIds.value.length > 0 ? selectedTagIds.value : undefined;
      try {
        const result = await fileStore.fetchFilesPage(
          page,
          BATCH_SIZE,
          search.value || undefined,
          sortBy.value || undefined,
          sortOrder.value || undefined,
          tagIds,
          folderId,
          signal,
        );
        // 即使底层请求未遵守 AbortSignal，也禁止旧筛选/目录请求污染当前列表。
        if (generation !== fileListGeneration) {
          return { data: [], nextCursor: cursor, hasMore: true };
        }
        fileStore.appendFiles(result.files);
        fileStore.total = result.total;
        const loadedAll = fileStore.files.length >= result.total || result.files.length === 0;
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
    });
  }

  function getFileListGeneration() {
    return fileListGeneration;
  }

  /** 统一的重新获取文件列表（无限滚动：从头加载） */
  async function refetchFiles() {
    const generation = ++fileListGeneration;
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
    refetchFiles();
  }

  function handleClearSearch() {
    search.value = '';
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
    scrollObserver = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMoreFiles();
        }
      },
      { rootMargin: '600px' },
    );
    scrollObserver.observe(el);
  });

  // ─── URL 双向同步（搜索/排序/标签，保留 folder 参数） ───
  watch([search, sortBy, sortOrder, selectedTagIds], ([newSearch, newSortBy, newSortOrder, newTagIds]) => {
    const query: Record<string, string> = {};
    if (newSearch) query.search = newSearch;
    if (newSortBy) query.sortBy = newSortBy;
    if (newSortOrder) query.sortOrder = newSortOrder;
    if (newTagIds && newTagIds.length > 0) query.tagIds = newTagIds.join(',');
    if (folderStore.currentFolderId) query.folder = folderStore.currentFolderId;
    router.replace({ query });
  }, { flush: 'post' });

  onUnmounted(() => {
    if (scrollObserver) {
      scrollObserver.disconnect();
      scrollObserver = null;
    }
  });

  return {
    search,
    sortBy,
    sortOrder,
    selectedTagIds,
    currentFolderIdForApi,
    displayFiles,
    hasMore,
    cursorLoading,
    folderLoading,
    listError,
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
