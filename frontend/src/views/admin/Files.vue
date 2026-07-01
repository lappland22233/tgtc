<template>
  <div>
    <div class="page-header">
      <h1>文件管理</h1>
      <p>管理系统所有文件，支持批量操作</p>
    </div>

    <div class="card">
      <div style="display: flex; justify-content: space-between; margin-bottom: 16px;">
        <div style="display: flex; gap: 12px;">
          <t-input v-model="searchFile" placeholder="搜索文件名..." style="width: 250px;" />
          <t-select v-model="filterUploader" placeholder="筛选上传者" clearable style="width: 200px;">
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
      >
        <template #filename="{ row }">
          <div style="display: flex; align-items: center; gap: 12px;">
            <ThumbnailImg :file-id="row.id" :mime-type="row.mimeType" :size="36" :emoji="getFileEmoji(row.mimeType)" />
            <div>
              <div :class="{ 'deleted-name': row.isDeleted }">{{ row.originalName }}</div>
              <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                <span style="font-size: 12px; color: var(--text-secondary);">
                  上传者: {{ row.uploader?.email || '未知' }}
                </span>
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

      <div style="margin-top: 16px; display: flex; justify-content: center;">
        <t-pagination
          v-model="page"
          :total="total"
          :page-size="20"
          @change="fetchFiles"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import { api } from '../../stores/auth';
import { formatSize, formatDate, getFileEmoji } from '@/utils/format';
import { getErrorMessage } from '../../utils/error';
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
const searchFile = ref('');
const filterUploader = ref('');
const selectedRows = ref<string[]>([]);

const columns = [
  { colKey: 'row-select', type: 'multiple' as const, width: '50' },
  { colKey: 'filename', title: '文件名', width: '360', ellipsis: true },
  { colKey: 'size', title: '大小', width: '100' },
  { colKey: 'accessType', title: '访问权限', width: '110' },
  { colKey: 'createdAt', title: '上传时间', width: '170' },
  { colKey: 'operations', title: '操作', width: '180' },
];

function getRowClassName({ row }: { row: AdminFileItem }) {
  return row.isDeleted ? 'row-deleted' : '';
}

async function fetchFiles() {
  const res = await api.get('/admin/files', { params: { page: page.value } });
  files.value = res.data.data.files;
  total.value = res.data.data.total;

  const uploaderMap = new Map<string, { id: string; email: string }>();
  files.value.forEach(f => {
    if (f.uploader && !uploaderMap.has(f.uploader.id)) {
      uploaderMap.set(f.uploader.id, f.uploader);
    }
  });
  uploaders.value = Array.from(uploaderMap.values());
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
    fetchFiles();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

/** 恢复已删除文件 */
async function restoreFile(id: string) {
  try {
    await api.post(`/files/${id}/restore`);
    MessagePlugin.success('文件已恢复');
    fetchFiles();
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
    fetchFiles();
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
    fetchFiles();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

onMounted(fetchFiles);
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
