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
          <t-button theme="primary" variant="outline" @click="batchDelete">批量删除</t-button>
        </div>
      </div>

      <t-table
        v-model:selected-row-keys="selectedRows"
        :data="files"
        :columns="columns"
        row-key="id"
        hover
        select-on-row-click
      >
        <template #filename="{ row }">
          <div style="display: flex; align-items: center; gap: 12px;">
            <ThumbnailImg :file-id="row.id" :mime-type="row.mimeType" :size="36" :emoji="getFileEmoji(row.mimeType)" />
            <div>
              <div>{{ row.originalName }}</div>
              <div style="font-size: 12px; color: var(--text-secondary);">
                上传者: {{ row.uploader?.email || '未知' }}
              </div>
            </div>
          </div>
        </template>
        <template #size="{ row }">{{ formatSize(row.size) }}</template>
        <template #accessType="{ row }">
          <t-tag :theme="row.accessType === 'public' ? 'success' : 'warning'" size="small">
            {{ row.accessType === 'public' ? '公开' : '私有' }}
          </t-tag>
        </template>
        <template #createdAt="{ row }">{{ formatDate(row.createdAt) }}</template>
        <template #operations="{ row }">
          <t-button size="small" theme="danger" variant="text" @click="deleteFile(row.id)">
            删除
          </t-button>
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
import { getErrorMessage } from '../../utils/error';
import ThumbnailImg from '../../components/ThumbnailImg.vue';

const files = ref<{ id: string; originalName: string; mimeType: string; size: number; accessType: string; createdAt: string; uploader: { id: string; email: string } | null }[]>([]);
const uploaders = ref<{ id: string; email: string }[]>([]);
const total = ref(0);
const page = ref(1);
const searchFile = ref('');
const filterUploader = ref('');
const selectedRows = ref<string[]>([]);

const columns = [
  { colKey: 'row-select', type: 'multiple', width: '50' },
  { colKey: 'filename', title: '文件名', width: '300' },
  { colKey: 'size', title: '大小', width: '100' },
  { colKey: 'accessType', title: '访问权限', width: '100' },
  { colKey: 'createdAt', title: '上传时间', width: '150' },
  { colKey: 'operations', title: '操作', width: '100' },
];

function formatSize(bytes: number) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(date: string) {
  return new Date(date).toLocaleDateString('zh-CN');
}

function getFileEmoji(mimeType: string) {
  if (mimeType.startsWith('image/')) return '🖼️';
  if (mimeType.includes('pdf')) return '📄';
  if (mimeType.includes('zip') || mimeType.includes('rar')) return '📦';
  return '📎';
}

async function fetchFiles() {
  const res = await api.get('/admin/files', { params: { page: page.value } });
  files.value = res.data.data.files;
  total.value = res.data.data.total;

  // Extract unique uploaders
  const uploaderMap = new Map();
  files.value.forEach(f => {
    if (f.uploader && !uploaderMap.has(f.uploader.id)) {
      uploaderMap.set(f.uploader.id, f.uploader);
    }
  });
  uploaders.value = Array.from(uploaderMap.values());
}

async function deleteFile(id: string) {
  if (!confirm('确定要删除此文件吗？')) return;
  try {
    await api.delete(`/admin/files/${id}`);
    MessagePlugin.success('删除成功');
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
  if (!confirm(`确定要删除选中的 ${selectedRows.value.length} 个文件吗？`)) return;
  try {
    await api.post('/admin/files/batch-delete', { ids: selectedRows.value });
    MessagePlugin.success('批量删除成功');
    selectedRows.value = [];
    fetchFiles();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

onMounted(fetchFiles);
</script>
