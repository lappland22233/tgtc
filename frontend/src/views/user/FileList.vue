<template>
  <div>
    <div class="page-header">
      <h1>我的文件</h1>
      <p>管理您上传的所有文件</p>
    </div>

    <div class="card">
      <div style="display: flex; justify-content: space-between; margin-bottom: 16px;">
        <t-input v-model="search" placeholder="搜索文件..." style="width: 300px;" />
        <t-button theme="primary" @click="$router.push('/upload')">+ 上传文件</t-button>
      </div>

      <t-loading v-if="fileStore.loading" />
      <div v-else-if="filteredFiles.length === 0" style="text-align: center; padding: 48px; color: var(--text-secondary);">
        暂无文件，点击上方按钮上传
      </div>
      <div v-else>
        <t-table :data="filteredFiles" :columns="columns" row-key="id" hover>
          <template #filename="{ row }">
            <div style="display: flex; align-items: center; gap: 12px;">
              <span style="font-size: 20px;">{{ getFileEmoji(row.mimeType) }}</span>
              <span>{{ row.originalName }}</span>
            </div>
          </template>
          <template #size="{ row }">{{ formatSize(row.size) }}</template>
          <template #accessType="{ row }">
            <t-select
              :value="row.accessType"
              @change="(val: string) => handleAccessTypeChange(row.id, val)"
              :options="[
                { label: '公开', value: 'public' },
                { label: '私有', value: 'private' }
              ]"
              style="width: 100px;"
            />
          </template>
          <template #maxAccessCount="{ row }">
            <t-input-number
              :value="row.maxAccessCount"
              :min="-1"
              @change="(val: number) => handleAccessCountChange(row.id, val)"
              style="width: 120px;"
            />
          </template>
          <template #createdAt="{ row }">{{ formatDate(row.createdAt) }}</template>
          <template #operations="{ row }">
            <t-button size="small" theme="primary" variant="text" @click="copyLink(row)">复制链接</t-button>
            <t-button size="small" theme="default" variant="text" @click="downloadFile(row)">下载</t-button>
            <t-button size="small" theme="danger" variant="text" @click="handleDelete(row.id)">删除</t-button>
          </template>
        </t-table>

        <div style="margin-top: 16px; display: flex; justify-content: center;">
          <t-pagination
            v-model="page"
            :total="fileStore.total"
            :page-size="20"
            @change="() => { fileStore.fetchFiles(page); search = ''; }"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import { useFileStore } from '../../stores/files';
import { api } from '../../stores/auth';
import { getErrorMessage } from '../../utils/error';
import type { FileItem } from '../../types/file';

const fileStore = useFileStore();
const page = ref(1);
const search = ref('');

const filteredFiles = computed(() => {
  if (!search.value.trim()) return fileStore.files;
  const keyword = search.value.trim().toLowerCase();
  return fileStore.files.filter((f) =>
    f.originalName.toLowerCase().includes(keyword),
  );
});

const columns = [
  { colKey: 'filename', title: '文件名', width: '250' },
  { colKey: 'size', title: '大小', width: '100' },
  { colKey: 'accessType', title: '访问权限', width: '120' },
  { colKey: 'maxAccessCount', title: '访问次数限制', width: '140' },
  { colKey: 'createdAt', title: '上传时间', width: '150' },
  { colKey: 'operations', title: '操作', width: '180' },
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
  if (mimeType.includes('text')) return '📝';
  return '📎';
}

async function handleAccessTypeChange(id: string, accessType: string) {
  try {
    await fileStore.updateAccessType(id, accessType);
    MessagePlugin.success('更新成功');
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function handleAccessCountChange(id: string, maxAccessCount: number) {
  try {
    await fileStore.updateAccessCount(id, maxAccessCount);
    MessagePlugin.success('更新成功');
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function copyLink(row: Pick<FileItem, 'id'>) {
  try {
    const response = await api.get(`/files/${row.id}/share`);
    const link = response.data.data.link;
    await navigator.clipboard.writeText(link);
    MessagePlugin.success('分享链接已复制');
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function downloadFile(row: Pick<FileItem, 'id'>) {
  try {
    const response = await api.get(`/files/${row.id}/download`);
    if (response.data.data?.url) {
      window.open(response.data.data.url, '_blank');
    } else {
      MessagePlugin.error('获取下载链接失败');
    }
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function handleDelete(id: string) {
  await fileStore.deleteFile(id);
  MessagePlugin.success('删除成功');
}

onMounted(() => {
  fileStore.fetchFiles();
});
</script>
