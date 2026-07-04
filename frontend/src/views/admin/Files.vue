<template>
  <div>
    <div class="page-header">
      <h1>文件管理</h1>
      <p>管理系统所有文件，支持批量操作</p>
    </div>

    <div class="card">
      <div style="display: flex; justify-content: space-between; margin-bottom: 16px;">
        <div style="display: flex; gap: 12px;">
          <t-input v-model="searchFile" placeholder="搜索文件名..." style="width: 250px;" @enter="fetchFiles" autocomplete="off" />
          <t-select v-model="filterUploader" placeholder="筛选上传者" clearable style="width: 200px;" @change="fetchFiles">
            <t-option v-for="u in uploaders" :key="u.id" :value="u.id" :label="u.email" />
          </t-select>
        </div>
        <div style="display: flex; gap: 12px;">
          <t-button theme="primary" variant="outline" @click="batchDelete">批量删除（冷静期）</t-button>
        </div>
      </div>

      <t-table
        v-model:selected-row-keys="selectedRows"
        :data="files"
        :columns="columns"
        :row-class-name="getRowClassName"
        row-key="id"
        hover
        table-layout="auto"
        @sort-change="handleSortChange"
      >
        <template #uploader="{ row }">
          <span style="font-size: 13px;">{{ row.uploader?.email || '未知' }}</span>
        </template>
        <template #filename="{ row }">
          <div style="display: flex; align-items: center; gap: 12px;">
            <ThumbnailImg :file-id="row.id" :mime-type="row.mimeType" :size="36" :emoji="getFileEmoji(row.mimeType)" />
            <div>
              <div :class="{ 'deleted-name': row.isDeleted }">{{ row.originalName }}</div>
              <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                <t-tag v-if="row.isDeleted && row.deletedByAdmin" theme="danger" size="small">管理员已删除</t-tag>
                <t-tag v-else-if="row.isDeleted" theme="warning" size="small">用户删除中</t-tag>
              </div>
            </div>
          </div>
        </template>
        <template #size="{ row }">{{ formatSize(row.size) }}</template>
        <template #accessType="{ row }">
          <t-tag v-if="!row.isDeleted" :theme="row.accessType === 'public' ? 'success' : 'warning'" size="small">
            {{ row.accessType === 'public' ? '公开' : '私有' }}
          </t-tag>
          <span v-else style="color: var(--text-disabled); font-size: 12px;">不可访问</span>
        </template>
        <template #createdAt="{ row }">
          <div>
            <div>{{ formatDate(row.createdAt) }}</div>
            <div v-if="row.isDeleted && row.deleteRequestedAt" style="font-size: 11px; color: var(--color-warning); margin-top: 2px;">
              删除于 {{ formatDate(row.deleteRequestedAt) }}
            </div>
          </div>
        </template>
        <template #operations="{ row }">
          <!-- 已删除状态：显示恢复和强制删除 -->
          <template v-if="row.isDeleted">
            <t-button size="small" theme="success" variant="text" @click="restoreFile(row.id)">
              恢复
            </t-button>
            <t-button size="small" theme="danger" variant="text" @click="forceDeleteFile(row)">
              强制删除
            </t-button>
          </template>
          <!-- 正常状态：显示普通删除 -->
          <template v-else>
            <t-button size="small" theme="danger" variant="text" @click="deleteFile(row)">
              删除
            </t-button>
          </template>
        </template>
      </t-table>

      <div style="margin-top: 16px; display: flex; justify-content: center; align-items: center; gap: 16px;">
        <t-select v-model="pageSize" :options="pageSizeOptions" style="width: 130px;" @change="handlePageSizeChange" />

        <t-pagination
          v-if="pageMode === 'paginated'"
          v-model="page"
          :total="total"
          :page-size="Math.abs(pageSize)"
          :show-page-size="false"
          @change="handlePageChange"
        />

        <div v-else ref="scrollSentinel" style="text-align: center; padding: 8px 0;">
          <t-loading v-if="cursorLoading" size="small" text="加载中..." />
          <span v-else-if="!hasMore" style="color: var(--text-secondary);">已加载全部 {{ total }} 个文件</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, computed } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import { api } from '../../stores/auth';
import { formatSize, formatDate, getFileEmoji } from '@/utils/format';
import { getErrorMessage } from '../../utils/error';
import { useCursorPagination } from '../../composables/useCursorPagination';
import ThumbnailImg from '../../components/ThumbnailImg.vue';

interface AdminFileItem {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  accessType: string;
  createdAt: string;
  isDeleted?: boolean;
  deletedByAdmin?: boolean;
  deleteRequestedAt?: string | null;
  uploader: { id: string; email: string } | null;
}

const files = ref<AdminFileItem[]>([]);
const uploaders = ref<{ id: string; email: string }[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const searchFile = ref('');
const filterUploader = ref('');
const selectedRows = ref<string[]>([]);
const sortBy = ref<string>('');
const sortOrder = ref<string>('');

// 分页模式
const pageMode = ref<'paginated' | 'infinite'>('paginated');

// 游标无限滚动
const {
  hasMore,
  loading: cursorLoading,
  loadMore,
  reset: resetCursor,
} = useCursorPagination<AdminFileItem>();

const scrollSentinel = ref<HTMLElement | null>(null);
let scrollObserver: IntersectionObserver | null = null;

const pageSizeOptions = computed(() => [
  { label: '10 条/页', value: 10 },
  { label: '20 条/页', value: 20 },
  { label: '50 条/页', value: 50 },
  { label: '100 条/页', value: 100 },
  { label: '无限滚动', value: -1 },
]);

const columns = [
  { colKey: 'row-select', type: 'multiple' as const, width: '50' },
  { colKey: 'uploader', title: '上传者', width: '160', sorter: true },
  { colKey: 'filename', title: '文件名', width: '280', ellipsis: true, sorter: true },
  { colKey: 'size', title: '大小', width: '100' },
  { colKey: 'accessType', title: '访问权限', width: '110' },
  { colKey: 'createdAt', title: '上传时间', width: '170', sorter: true },
  { colKey: 'operations', title: '操作', width: '180' },
];

function getRowClassName({ row }: { row: AdminFileItem }) {
  return row.isDeleted ? 'row-deleted' : '';
}

/** 提取上传者列表 */
function extractUploaders(fileList: AdminFileItem[]) {
  const uploaderMap = new Map<string, { id: string; email: string }>();
  fileList.forEach(f => {
    if (f.uploader && !uploaderMap.has(f.uploader.id)) {
      uploaderMap.set(f.uploader.id, f.uploader);
    }
  });
  // 合并现有上传者（无限模式下需要累积）
  const existing = new Map(uploaders.value.map(u => [u.id, u]));
  uploaderMap.forEach((v, k) => existing.set(k, v));
  uploaders.value = Array.from(existing.values());
}

/** 传统分页请求 */
async function fetchFiles() {
  const sortField = sortBy.value === 'uploader' ? 'uploader.email' : sortBy.value;
  const res = await api.get('/admin/files', {
    params: {
      page: page.value,
      limit: Math.abs(pageSize.value),
      keyword: searchFile.value || undefined,
      userId: filterUploader.value || undefined,
      sortBy: sortField || undefined,
      sortOrder: sortOrder.value || undefined,
    },
  });
  files.value = res.data.data.files;
  total.value = res.data.data.total;
  extractUploaders(files.value);
}

/** 游标分页请求 */
async function fetchFilesCursor(cursor?: string | null) {
  const res = await api.get('/admin/files', {
    params: {
      limit: 20,
      keyword: searchFile.value || undefined,
      userId: filterUploader.value || undefined,
      cursor: cursor || undefined,
    },
  });
  return {
    files: res.data.data.files as AdminFileItem[],
    nextCursor: res.data.data.nextCursor as string | null,
    total: res.data.data.total as number,
  };
}

/** 初始加载 / 重置加载 */
async function loadInitialFiles(resetCursorState = false) {
  if (pageMode.value === 'paginated') {
    await fetchFiles();
  } else {
    if (resetCursorState) {
      resetCursor();
      files.value = [];
    }
    await loadMore(async (cursor) => {
      const result = await fetchFilesCursor(cursor);
      files.value = [...files.value, ...result.files];
      total.value = result.total;
      extractUploaders(result.files);
      return {
        data: result.files,
        nextCursor: result.nextCursor,
        hasMore: result.nextCursor !== null,
      };
    });
  }
}

/** 加载更多（IntersectionObserver 触发） */
async function loadMoreFiles() {
  if (!hasMore.value || cursorLoading.value) return;
  await loadMore(async (cursor) => {
    const result = await fetchFilesCursor(cursor);
    files.value = [...files.value, ...result.files];
    total.value = result.total;
    extractUploaders(result.files);
    return {
      data: result.files,
      nextCursor: result.nextCursor,
      hasMore: result.nextCursor !== null,
    };
  });
}

/** 设置滚动监听 */
function setupScrollObserver() {
  if (scrollObserver) scrollObserver.disconnect();
  if (!scrollSentinel.value) return;
  scrollObserver = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting) loadMoreFiles();
    },
    { rootMargin: '600px' },
  );
  scrollObserver.observe(scrollSentinel.value);
}

/** 刷新列表（操作后调用） */
async function refreshList() {
  if (pageMode.value === 'infinite') {
    resetCursor();
    files.value = [];
    loadInitialFiles(true);
  } else {
    await fetchFiles();
  }
}

/** 管理员删除文件（7天冷静期，再次点击强制删除） */
async function deleteFile(row: AdminFileItem) {
  const isFirstDelete = !row.isDeleted;
  const message = isFirstDelete
    ? `确定要删除文件 "${row.originalName}" 吗？文件将进入 7 天冷静期。`
    : `文件 "${row.originalName}" 已处于待删除状态，再次确认将立即永久删除！`;

  if (!confirm(message)) return;

  try {
    const result = await api.delete(`/admin/files/${row.id}`);
    const msg = result.data?.message || '删除成功';
    MessagePlugin.success(msg);
    refreshList();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

/** 恢复已删除文件 */
async function restoreFile(id: string) {
  try {
    await api.post(`/files/${id}/restore`);
    MessagePlugin.success('文件已恢复');
    refreshList();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

/** 强制永久删除（管理员第二次确认） */
async function forceDeleteFile(row: AdminFileItem) {
  if (!confirm(`确定要永久删除文件 "${row.originalName}" 吗？此操作不可恢复！`)) return;

  try {
    await api.delete(`/admin/files/${row.id}`);
    MessagePlugin.success('文件已永久删除');
    refreshList();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function batchDelete() {
  if (selectedRows.value.length === 0) {
    MessagePlugin.warning('请先选择要删除的文件');
    return;
  }
  if (!confirm(`确定要批量删除选中的 ${selectedRows.value.length} 个文件吗？文件将进入 7 天冷静期。`)) return;
  try {
    await api.post('/admin/files/batch-delete', { ids: selectedRows.value });
    MessagePlugin.success('批量删除成功（已进入 7 天冷静期）');
    selectedRows.value = [];
    refreshList();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

function handleSortChange(sortInfo: { sortBy: string; descending: boolean } | { sortBy: string; descending: boolean }[]) {
  const info = Array.isArray(sortInfo) ? sortInfo[0] : sortInfo;
  if (!info) return;
  sortBy.value = info.sortBy;
  sortOrder.value = info.descending ? 'DESC' : 'ASC';
  // 排序时切换到传统模式
  if (pageMode.value === 'infinite') {
    pageMode.value = 'paginated';
    pageSize.value = 20;
    resetCursor();
  }
  page.value = 1;
  fetchFiles();
}

function handlePageChange(pageInfo: { current: number }) {
  page.value = pageInfo.current;
  fetchFiles();
}

function handlePageSizeChange(pageSizeVal: number) {
  selectedRows.value = [];
  if (pageSizeVal === -1) {
    pageMode.value = 'infinite';
    page.value = 1;
    resetCursor();
    files.value = [];
    loadInitialFiles(true);
    nextTick(setupScrollObserver);
  } else {
    pageMode.value = 'paginated';
    page.value = 1;
    pageSize.value = pageSizeVal;
    fetchFiles();
  }
}

onMounted(() => {
  fetchFiles();
});

onUnmounted(() => {
  if (scrollObserver) scrollObserver.disconnect();
});
</script>

<style scoped>
.deleted-name {
  text-decoration: line-through;
  opacity: 0.6;
}

:deep(.row-deleted) {
  background: rgba(255, 255, 255, 0.02);
  opacity: 0.85;
}
</style>
