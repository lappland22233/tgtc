<template>
  <div>
    <div class="page-header">
      <h1>文件管理</h1>
      <p>管理系统所有文件，支持批量操作</p>
    </div>

    <div class="card">
      <div style="display: flex; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 12px;">
        <div style="display: flex; gap: 12px; flex-wrap: wrap;">
          <t-input v-model="searchFile" placeholder="搜索文件名..." style="width: 250px;" @enter="loadInitialFiles" autocomplete="off" name="admin-search-file" />
          <t-select v-model="filterUploader" placeholder="筛选上传者" clearable style="width: 200px;" @change="loadInitialFiles">
            <t-option v-for="u in uploaders" :key="u.id" :value="u.id" :label="u.email" />
          </t-select>
        </div>
        <div style="display: flex; gap: 12px; flex-wrap: wrap;">
          <t-button v-if="!isMobile" theme="primary" variant="outline" @click="batchDelete">批量删除（冷静期）</t-button>
          <t-button theme="warning" variant="outline" @click="openVerifyDialog">文件体检</t-button>
        </div>
      </div>

      <t-table
        v-if="!isMobile"
        v-model:selected-row-keys="selectedRows"
        :data="files"
        :columns="columns"
        :loading="cursorLoading && files.length === 0"
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
            <ThumbnailImg :file-id="row.id" :mime-type="row.mimeType" :size="36" :file-name="row.originalName" />
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

      <!-- 移动端：卡片列表 -->
      <div v-if="isMobile" class="mobile-card-list">
        <div v-for="file in files" :key="file.id" class="mobile-file-admin-card">
          <div style="display: flex; align-items: flex-start; gap: 12px;">
            <ThumbnailImg :file-id="file.id" :mime-type="file.mimeType" :size="40" :file-name="file.originalName" />
            <div style="flex: 1; min-width: 0;">
              <div :class="{ 'deleted-name': file.isDeleted }" style="font-weight: 500; word-break: break-all; font-size: 14px;">
                {{ file.originalName }}
              </div>
              <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
                {{ formatSize(file.size) }} · 上传者: {{ file.uploader?.email || '未知' }}
              </div>
              <div style="display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap;">
                <t-tag v-if="file.isDeleted && file.deletedByAdmin" theme="danger" size="small">管理员已删除</t-tag>
                <t-tag v-else-if="file.isDeleted" theme="warning" size="small">用户删除中</t-tag>
                <t-tag v-else-if="file.accessType === 'public'" theme="success" size="small">公开</t-tag>
                <t-tag v-else theme="default" size="small">私有</t-tag>
              </div>
            </div>
          </div>
          <div style="display: flex; gap: 4px; margin-top: 8px; flex-wrap: wrap; border-top: 1px solid var(--border-color); padding-top: 8px;">
            <template v-if="file.isDeleted">
              <t-button size="small" theme="success" variant="outline" @click="restoreFile(file.id)">恢复</t-button>
              <t-button size="small" theme="danger" variant="outline" @click="forceDeleteFile(file)">强制删除</t-button>
            </template>
            <template v-else>
              <t-button size="small" theme="danger" variant="outline" @click="deleteFile(file)">删除</t-button>
            </template>
          </div>
        </div>
      </div>

      <div ref="scrollSentinel" style="margin-top: 16px; text-align: center; padding: 8px 0;">
        <t-loading v-if="cursorLoading" size="small" text="加载中..." />
        <span v-else-if="!hasMore && files.length > 0" style="color: var(--text-secondary);">已加载全部 {{ total }} 个文件</span>
      </div>
    </div>

    <!-- 文件体检确认弹窗 -->
    <t-dialog
      v-model:visible="verifyDialogVisible"
      header="文件体检"
      width="480px"
      :confirm-btn="null"
      cancel-btn="关闭"
      @close="verifyDialogVisible = false"
    >
      <div style="display: flex; flex-direction: column; gap: 12px; color: var(--text-secondary); font-size: 14px;">
        <div>体检将校验 ready 文件的 Telegram file_id 是否仍然有效（默认仅检查路径为空的历史文件）。</div>
        <div style="color: var(--color-warning); font-weight: 500;">⚠ apply 模式会修改数据：确认失效的文件标记为"上传失败"，有效的文件回填路径。</div>
        <div style="display: flex; gap: 8px; margin-top: 8px;">
          <t-button theme="primary" variant="outline" style="flex: 1;" :loading="verifyRunning" @click="runVerify('dry-run')">仅预览统计（dry-run）</t-button>
          <t-button theme="danger" variant="outline" style="flex: 1;" :loading="verifyRunning" @click="runVerify('apply')">执行修复（apply）</t-button>
        </div>
      </div>
    </t-dialog>

    <!-- 文件体检结果弹窗 -->
    <t-dialog
      v-model:visible="verifyResultVisible"
      :header="verifyResultHeader"
      width="460px"
      confirm-btn="确定"
      :cancel-btn="null"
      @confirm="closeVerifyResult"
      @close="verifyResultVisible = false"
    >
      <div style="display: flex; flex-direction: column; gap: 8px; font-size: 14px;">
        <div v-for="line in verifyResultLines" :key="line">{{ line }}</div>
      </div>
    </t-dialog>

    <!-- 文件体检进度弹窗 -->
    <t-dialog
      v-model:visible="verifyProgressVisible"
      header="文件体检进度"
      width="480px"
      :confirm-btn="null"
      :cancel-btn="null"
      :footer="false"
      :close-on-overlay-click="false"
      :close-btn="false"
    >
      <div style="display: flex; flex-direction: column; gap: 16px; font-size: 14px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: 500;">状态：{{ verifyStatusText }}</span>
          <span style="color: var(--text-secondary);">{{ verifyProgress }}%</span>
        </div>
        <t-progress :percentage="verifyProgress" :label="false" />
        <div style="color: var(--text-secondary);">
          已处理：{{ verifyProcessedText }}
        </div>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; color: var(--text-secondary);">
          <div>有效：{{ verifyTask?.valid ?? 0 }}</div>
          <div>永久失效：{{ verifyTask?.invalid ?? 0 }}</div>
          <div>缺少 file_id：{{ verifyTask?.emptyFileId ?? 0 }}</div>
          <div>暂时性失败：{{ verifyTask?.temporaryFailure ?? 0 }}</div>
          <div>大小不一致：{{ verifyTask?.sizeMismatch ?? 0 }}</div>
          <template v-if="verifyTask?.mode === 'apply'">
            <div>已回填路径：{{ verifyTask?.backfilled ?? 0 }}</div>
            <div>已标记 error：{{ verifyTask?.markedError ?? 0 }}</div>
          </template>
        </div>
      </div>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { DialogPlugin } from 'tdesign-vue-next';
import MessagePlugin from '@/utils/message';
import { api } from '../../stores/auth';
import {
  fetchAllAdminFiles,
  createFileVerifyTask,
  fetchActiveFileVerifyTask,
  fetchFileVerifyTask,
  type AdminFileItem,
  type FileVerifyTask,
} from '../../api/admin-files';
import { formatSize, formatDate } from '@/utils/format';
import { getErrorMessage } from '../../utils/error';
import { useCursorPagination } from '../../composables/useCursorPagination';
import { useMobile } from '../../composables/useMobile';
import ThumbnailImg from '../../components/ThumbnailImg.vue';

const files = ref<AdminFileItem[]>([]);
const uploaders = ref<{ id: string; email: string }[]>([]);
const total = ref(0);
const searchFile = ref('');
const filterUploader = ref('');
const selectedRows = ref<string[]>([]);
const sortBy = ref<string>('');
const sortOrder = ref<string>('');

const isMobile = useMobile();

// 无限滚动（以页码为游标，偏移分页保留排序能力）
const {
  hasMore,
  loading: cursorLoading,
  loadMore,
  reset: resetCursor,
} = useCursorPagination<AdminFileItem>();

const scrollSentinel = ref<HTMLElement | null>(null);
let scrollObserver: IntersectionObserver | null = null;

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

/** 无限滚动每批加载条数 */
const BATCH_SIZE = 20;

/** 按页获取系统全部文件（不修改 files 列表，供无限滚动累加）。 */
async function fetchAdminPage(pageNum: number, signal?: AbortSignal): Promise<{ files: AdminFileItem[]; total: number }> {
  const sortField = sortBy.value === 'uploader' ? 'uploader.email' : sortBy.value;
  return fetchAllAdminFiles({
    page: pageNum,
    limit: BATCH_SIZE,
    keyword: searchFile.value || undefined,
    userId: filterUploader.value || undefined,
    sortBy: sortField || undefined,
    sortOrder: sortOrder.value || undefined,
    signal,
  });
}

/** 初始加载 / 重置加载（无限滚动：从头加载） */
async function loadInitialFiles() {
  resetCursor();
  files.value = [];
  await loadMoreFiles(1);
}

/** 加载更多（以页码为游标驱动，偏移分页保留排序能力） */
async function loadMoreFiles(pageNum?: number) {
  if (!hasMore.value || cursorLoading.value) return;
  await loadMore(async (cursor, signal) => {
    const page = pageNum ?? (cursor ? parseInt(cursor, 10) : 1);
    try {
      const result = await fetchAdminPage(page, signal);
      files.value = [...files.value, ...result.files];
      total.value = result.total;
      extractUploaders(result.files);
      const loadedAll = files.value.length >= result.total || result.files.length === 0;
      return {
        data: result.files,
        nextCursor: loadedAll ? null : String(page + 1),
        hasMore: !loadedAll,
      };
    } catch (error) {
      const canceled =
        (error as { code?: string })?.code === 'ERR_CANCELED' ||
        (error instanceof Error && error.name === 'AbortError');
      if (!canceled) {
        MessagePlugin.error(getErrorMessage(error) || '加载文件列表失败');
      }
      return { data: [], nextCursor: cursor, hasMore: true };
    }
  });
}

/**
 * 哨兵元素变化时重新挂载 IntersectionObserver。
 * 修复无限滚动失效：列表清空重载时哨兵元素会卸载重建，旧 observer 指向已脱离
 * DOM 的元素而永不触发，这里监听哨兵 ref 变化即重新 observe。
 */
watch(scrollSentinel, (el) => {
  if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }
  if (!el) return;
  scrollObserver = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting) loadMoreFiles();
    },
    { rootMargin: '600px' },
  );
  scrollObserver.observe(el);
});

/** 刷新列表（操作后调用） */
async function refreshList() {
  await loadInitialFiles();
}

/** 管理员删除文件（7天冷静期，再次点击强制删除） */
function deleteFile(row: AdminFileItem) {
  const isFirstDelete = !row.isDeleted;
  const message = isFirstDelete
    ? `确定要删除文件 "${row.originalName}" 吗？文件将进入 7 天冷静期。`
    : `文件 "${row.originalName}" 已处于待删除状态，再次确认将立即永久删除！`;

  const confirmDialog = DialogPlugin.confirm({
    header: '删除文件',
    body: message,
    theme: 'warning',
    confirmBtn: '确定',
    cancelBtn: '取消',
    onConfirm: async () => {
      try {
        const result = await api.delete(`/admin/files/${row.id}`);
        const msg = result.data?.message || '删除成功';
        MessagePlugin.success(msg);
        refreshList();
      } catch (error: unknown) {
        MessagePlugin.error(getErrorMessage(error));
      }
      confirmDialog.destroy();
    },
    onClose: () => confirmDialog.destroy(),
  });
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
function forceDeleteFile(row: AdminFileItem) {
  const confirmDialog = DialogPlugin.confirm({
    header: '永久删除文件',
    body: `确定要永久删除文件 "${row.originalName}" 吗？此操作不可恢复！`,
    theme: 'danger',
    confirmBtn: '永久删除',
    cancelBtn: '取消',
    onConfirm: async () => {
      try {
        await api.delete(`/admin/files/${row.id}`);
        MessagePlugin.success('文件已永久删除');
        refreshList();
      } catch (error: unknown) {
        MessagePlugin.error(getErrorMessage(error));
      }
      confirmDialog.destroy();
    },
    onClose: () => confirmDialog.destroy(),
  });
}

function batchDelete() {
  if (selectedRows.value.length === 0) {
    MessagePlugin.warning('请先选择要删除的文件');
    return;
  }
  const count = selectedRows.value.length;
  const confirmDialog = DialogPlugin.confirm({
    header: '批量删除文件',
    body: `确定要批量删除选中的 ${count} 个文件吗？文件将进入 7 天冷静期。`,
    theme: 'warning',
    confirmBtn: '批量删除',
    cancelBtn: '取消',
    onConfirm: async () => {
      try {
        await api.post('/admin/files/batch-delete', { ids: selectedRows.value });
        MessagePlugin.success('批量删除成功（已进入 7 天冷静期）');
        selectedRows.value = [];
        refreshList();
      } catch (error: unknown) {
        MessagePlugin.error(getErrorMessage(error));
      }
      confirmDialog.destroy();
    },
    onClose: () => confirmDialog.destroy(),
  });
}

function handleSortChange(sortInfo: { sortBy: string; descending: boolean } | { sortBy: string; descending: boolean }[]) {
  const info = Array.isArray(sortInfo) ? sortInfo[0] : sortInfo;
  if (!info) return;
  sortBy.value = info.sortBy;
  sortOrder.value = info.descending ? 'DESC' : 'ASC';
  loadInitialFiles();
}

/** 体检确认弹窗可见性 */
const verifyDialogVisible = ref(false);

/** 体检结果弹窗状态 */
const verifyResultVisible = ref(false);
const verifyResultHeader = ref('');
const verifyResultLines = ref<string[]>([]);
const verifyResultApplied = ref(false);

/** 是否正在创建体检任务（按钮 loading，仅至创建请求完成） */
const verifyRunning = ref(false);

/** 体检进度弹窗状态 */
const verifyProgressVisible = ref(false);
const verifyTask = ref<FileVerifyTask | null>(null);

/** 轮询定时器与在途请求控制器 */
let verifyPollTimer: ReturnType<typeof setInterval> | null = null;
let verifyPollAbortController: AbortController | null = null;
let verifyPageHidden = false;

/** 打开体检确认弹窗 */
function openVerifyDialog() {
  verifyDialogVisible.value = true;
}

/** 状态中文文案 */
const verifyStatusText = computed(() => {
  switch (verifyTask.value?.status) {
    case 'queued': return '排队中';
    case 'running': return '执行中';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    default: return '未知';
  }
});

/** 已处理文本（totalCandidates 为 0 时显示等待开始） */
const verifyProcessedText = computed(() => {
  const t = verifyTask.value;
  if (!t) return '等待开始…';
  return t.totalCandidates > 0 ? `${t.processed} / ${t.totalCandidates}` : '等待开始…';
});

/** 进度百分比（0~100，后端已算好） */
const verifyProgress = computed(() => verifyTask.value?.progress ?? 0);

/** 执行文件体检：创建任务后立即返回，进入进度跟踪 */
async function runVerify(mode: 'dry-run' | 'apply') {
  if (verifyRunning.value) return;
  verifyRunning.value = true;
  try {
    const { task, isNewTask } = await createFileVerifyTask({ mode });
    verifyDialogVisible.value = false;
    if (!isNewTask) {
      MessagePlugin.info('已有体检任务正在进行，将跟踪当前任务');
    }
    startVerifyTracking(task);
  } catch (error) {
    MessagePlugin.error(getErrorMessage(error) || '体检请求失败');
  } finally {
    verifyRunning.value = false;
  }
}

/** 进入进度跟踪状态（从创建结果或刷新恢复进入） */
function startVerifyTracking(task: FileVerifyTask) {
  stopVerifyPolling();
  verifyTask.value = task;
  verifyProgressVisible.value = true;
  pollVerifyTask();
}

/** 停止轮询并 abort 在途请求 */
function stopVerifyPolling() {
  if (verifyPollTimer) {
    clearInterval(verifyPollTimer);
    verifyPollTimer = null;
  }
  if (verifyPollAbortController) {
    verifyPollAbortController.abort();
    verifyPollAbortController = null;
  }
}

/** 轮询体检任务进度 */
function pollVerifyTask() {
  const taskId = verifyTask.value?.taskId;
  if (!taskId) return;
  void fetchVerifyOnce(taskId);
  if (!verifyPollTimer) {
    verifyPollTimer = setInterval(() => {
      if (verifyPageHidden) return; // 页面隐藏时暂停轮询
      void fetchVerifyOnce(taskId);
    }, 1500);
  }
}

/** 发起一次轮询请求并处理结果 */
async function fetchVerifyOnce(taskId: string) {
  if (verifyPollAbortController) {
    verifyPollAbortController.abort();
  }
  const controller = new AbortController();
  verifyPollAbortController = controller;
  try {
    const task = await fetchFileVerifyTask(taskId, controller.signal);
    verifyPollAbortController = null;
    // 竞态防护：若期间已停止跟踪，丢弃结果
    if (verifyTask.value?.taskId !== taskId) return;
    verifyTask.value = task;
    if (task.status === 'completed' || task.status === 'failed') {
      stopVerifyPolling();
      handleVerifyTerminal(task);
    }
  } catch (error) {
    const canceled =
      (error as { code?: string })?.code === 'ERR_CANCELED' ||
      (error instanceof Error && error.name === 'AbortError');
    if (canceled) return;
    // 轮询失败不打断用户，静默继续，终态由后续轮询补齐
  }
}

/** 处理体检终态 */
function handleVerifyTerminal(task: FileVerifyTask) {
  verifyProgressVisible.value = false;
  if (task.status === 'failed') {
    MessagePlugin.error(task.errorSummary || '体检任务失败');
    return;
  }
  // completed
  showVerifyResult(task.mode, task);
}

/** 展示体检统计结果 */
function showVerifyResult(mode: 'dry-run' | 'apply', task: FileVerifyTask) {
  const isApply = mode === 'apply';
  const lines = [
    `模式：${isApply ? '执行修复（apply）' : '仅预览统计（dry-run）'}`,
    `本次检查候选：${task.totalCandidates} 个`,
    `已校验：${task.processed}`,
    `有效：${task.valid}`,
    `永久失效：${task.invalid}`,
    `缺少 file_id：${task.emptyFileId}`,
    `暂时性失败（未修改）：${task.temporaryFailure}`,
    `大小不一致（仅报告）：${task.sizeMismatch}`,
  ];
  if (isApply) {
    lines.push(`已标记 error：${task.markedError}`);
    lines.push(`已回填路径：${task.backfilled}`);
  }
  verifyResultHeader.value = isApply ? '体检完成（已应用修复）' : '体检预览结果';
  verifyResultLines.value = lines;
  verifyResultApplied.value = isApply;
  verifyResultVisible.value = true;
}

/** 关闭结果弹窗，apply 后刷新列表 */
function closeVerifyResult() {
  verifyResultVisible.value = false;
  if (verifyResultApplied.value) refreshList();
}

/** 页面可见性变化：隐藏时暂停轮询，恢复时继续 */
function handleVisibilityChange() {
  verifyPageHidden = document.hidden;
}

onMounted(() => {
  loadInitialFiles();
  // 刷新恢复：存在进行中的活动任务时自动进入进度跟踪
  fetchActiveFileVerifyTask()
    .then((task) => {
      if (task && (task.status === 'queued' || task.status === 'running')) {
        startVerifyTracking(task);
      }
    })
    .catch(() => {
      // 刷新恢复失败不打扰用户
    });
  document.addEventListener('visibilitychange', handleVisibilityChange);
});

onUnmounted(() => {
  if (scrollObserver) scrollObserver.disconnect();
  stopVerifyPolling();
  document.removeEventListener('visibilitychange', handleVisibilityChange);
});
</script>

<style scoped>
.deleted-name {
  text-decoration: line-through;
  opacity: 0.6;
}

:deep(.row-deleted) {
  background: var(--color-bg-elevated);
  opacity: 0.85;
}

@media (max-width: 768px) {
  .mobile-file-admin-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 10px;
  }
}
</style>
