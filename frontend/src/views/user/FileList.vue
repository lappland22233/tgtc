<template>
  <div
    @dragover.prevent="isDraggedOver = true"
    @dragenter="handleDragEnter"
    @dragleave="handleDragLeave"
    @drop.prevent="handleDrop"
    style="position: relative;"
  >
    <!-- 拖拽上传覆盖层 -->
    <div v-if="isDraggedOver" class="drop-overlay">
      <div class="drop-overlay-content">
        <div style="font-size: 64px; margin-bottom: 16px;">📤</div>
        <h2>释放文件以上传</h2>
      </div>
    </div>

    <div class="page-header">
      <h1>我的文件</h1>
      <p>管理您上传的所有文件，支持拖拽上传</p>
    </div>

    <div class="card">
      <div style="display: flex; justify-content: space-between; margin-bottom: 16px; align-items: center; flex-wrap: wrap; gap: 12px;">
        <div style="display: flex; gap: 8px;">
          <t-input v-model="search" placeholder="搜索文件名..." style="width: 300px;" @enter="handleSearch" />
          <t-button theme="default" @click="handleSearch">搜索</t-button>
          <t-button theme="default" variant="text" v-if="search" @click="handleClearSearch">清除</t-button>
        </div>
        <div style="display: flex; gap: 8px;">
          <t-button
            v-if="selectedImages.length > 0"
            theme="primary"
            variant="outline"
            @click="convertToMarkdown"
          >
            📋 批量 MK（{{ selectedImages.length }}）
          </t-button>
          <t-button theme="primary" @click="showUploadModal = true">
            + 上传文件
          </t-button>
        </div>
      </div>

      <!-- Markdown 结果区域 -->
      <div v-if="markdownResult" style="margin-bottom: 16px; padding: 16px; background: var(--bg-secondary); border-radius: 8px; border: 1px solid var(--border-color);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span style="font-weight: 500;">Markdown 结果</span>
          <div style="display: flex; gap: 8px;">
            <t-button size="small" theme="primary" variant="outline" @click="copyMarkdown">复制</t-button>
            <t-button size="small" theme="default" variant="text" @click="markdownResult = ''">关闭</t-button>
          </div>
        </div>
        <t-input v-model="markdownResult" type="textarea" readonly :rows="6" />
      </div>

      <!-- 拖拽提示（空状态） -->
      <div v-if="fileStore.files.length === 0 && !fileStore.loading"
        class="upload-zone"
        @click="showUploadModal = true"
      >
        <div style="font-size: 48px; margin-bottom: 16px;">📁</div>
        <h3>拖拽文件到此处，或点击上传</h3>
        <p style="color: var(--text-secondary); margin-top: 8px;">
          支持图片、PDF、ZIP 等格式，单文件最大限制见系统配置
        </p>
      </div>

      <t-loading v-if="fileStore.loading" />
      <div v-else-if="fileStore.files.length > 0">
        <t-table
          :data="fileStore.files"
          :columns="columns"
          row-key="id"
          hover
          :selected-row-keys="selectedImageIds"
          @select-change="handleSelectChange"
        >
          <template #filename="{ row }">
            <div style="display: flex; align-items: center; gap: 12px;">
              <ThumbnailImg :file-id="row.id" :mime-type="row.mimeType" :size="36" :emoji="getFileEmoji(row.mimeType)" />
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
          <template #password="{ row }">
            <t-button
              size="small"
              :theme="row.hasPassword ? 'warning' : 'default'"
              variant="outline"
              @click="openPasswordDialog(row)"
            >
              {{ row.hasPassword ? '🔒 已加密' : '🔓 未加密' }}
            </t-button>
          </template>
          <template #expiresIn="{ row }">
            <t-select
              :value="row.expiresIn"
              @change="(val: number | null) => handleExpiresChange(row.id, val)"
              :options="expiresOptions"
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
            @change="() => fileStore.fetchFiles(page, 20, search)"
          />
        </div>
      </div>
    </div>

    <!-- 上传弹窗 -->
    <UploadModal :visible="showUploadModal" :initial-files="dropFiles" @close="handleUploadModalClose" @uploaded="onUploaded" />

    <!-- 密码设置弹窗 -->
    <t-dialog v-model:visible="passwordDialog.visible" header="设置访问密码" width="400px" @confirm="savePassword" @close="passwordDialog.visible = false">
      <t-input
        v-model="passwordDialog.value"
        type="password"
        placeholder="输入密码（留空则移除密码）"
        clearable
      />
      <div style="margin-top: 8px; color: var(--text-secondary); font-size: 12px;">
        设置密码后，访问者需要输入密码才能查看该文件
      </div>
    </t-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, reactive, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { MessagePlugin } from 'tdesign-vue-next';
import { useFileStore } from '../../stores/files';
import { api } from '../../stores/auth';
import { getErrorMessage } from '../../utils/error';
import { formatSize, formatDate, getFileEmoji } from '@/utils/format';
import UploadModal from '../../components/UploadModal.vue';
import ThumbnailImg from '../../components/ThumbnailImg.vue';
import type { FileItem } from '../../types/file';

const fileStore = useFileStore();
const router = useRouter();
const route = useRoute();
const page = ref(Number(route.query.page) || 1);
const search = ref((route.query.search as string) || '');
const showUploadModal = ref(false);
const isDraggedOver = ref(false);
const markdownResult = ref('');
const selectedImageIds = ref<string[]>([]);
const dropFiles = ref<File[]>([]);

const selectedImages = computed(() =>
  fileStore.files.filter(f =>
    f.mimeType.startsWith('image/') &&
    selectedImageIds.value.includes(f.id)
  )
);

// 密码弹窗状态
const passwordDialog = reactive({
  visible: false,
  value: '',
  fileId: '',
});

function openPasswordDialog(row: FileItem) {
  passwordDialog.fileId = row.id;
  passwordDialog.value = '';
  passwordDialog.visible = true;
}

async function savePassword() {
  try {
    await fileStore.setPassword(passwordDialog.fileId, passwordDialog.value);
    MessagePlugin.success(passwordDialog.value ? '密码已设置' : '密码已移除');
    passwordDialog.visible = false;
    // 刷新以更新 hasPassword 状态
    fileStore.fetchFiles(page.value, 20, search.value || undefined);
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

// 限时访问选项
const expiresOptions = [
  { label: '永久', value: null },
  { label: '1 小时', value: 1 },
  { label: '6 小时', value: 6 },
  { label: '12 小时', value: 12 },
  { label: '24 小时', value: 24 },
  { label: '3 天', value: 72 },
  { label: '7 天', value: 168 },
  { label: '30 天', value: 720 },
];

async function handleExpiresChange(id: string, expiresIn: number | null) {
  try {
    await fileStore.updateExpires(id, expiresIn);
    MessagePlugin.success('有效期已更新');
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

let dragLeaveTimeout: ReturnType<typeof setTimeout> | null = null;
let dragCounter = 0;

function handleDragEnter(_e: DragEvent) {
  dragCounter++;
  isDraggedOver.value = true;
}

function handleDragLeave(_e: DragEvent) {
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    isDraggedOver.value = false;
  }
}

function handleDrop(e: DragEvent) {
  dragCounter = 0;
  isDraggedOver.value = false;
  if (dragLeaveTimeout) clearTimeout(dragLeaveTimeout);
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length > 0) {
    dropFiles.value = files;
    showUploadModal.value = true;
  }
}

function handleUploadModalClose() {
  showUploadModal.value = false;
  dropFiles.value = [];
}

function onUploaded() {
  fileStore.fetchFiles(page.value, 20, search.value || undefined);
  selectedImageIds.value = [];
}

function handleSelectChange(selectedRowKeys: (string | number)[]) {
  selectedImageIds.value = selectedRowKeys.filter(k =>
    fileStore.files.find(f => f.id === k && f.mimeType.startsWith('image/'))
  ) as string[];
}

function handleSearch() {
  page.value = 1;
  fileStore.fetchFiles(1, 20, search.value || undefined);
}

function handleClearSearch() {
  search.value = '';
  page.value = 1;
  fileStore.fetchFiles(1, 20);
}

const columns = [
  { colKey: 'row-select', type: 'multiple' as const, width: '50' },
  { colKey: 'filename', title: '文件名', width: '200' },
  { colKey: 'size', title: '大小', width: '90' },
  { colKey: 'accessType', title: '访问权限', width: '110' },
  { colKey: 'password', title: '加密访问', width: '120' },
  { colKey: 'maxAccessCount', title: '访问次数', width: '120' },
  { colKey: 'expiresIn', title: '限时访问', width: '110' },
  { colKey: 'createdAt', title: '上传时间', width: '130' },
  { colKey: 'operations', title: '操作', width: '180' },
];

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

async function copyLink(row: FileItem) {
  try {
    const link = `${window.location.origin}/files/public/${row.id}`;
    await navigator.clipboard.writeText(link);
    MessagePlugin.success('分享链接已复制');
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function downloadFile(row: Pick<FileItem, 'id'>) {
  try {
    const response = await api.get(`/files/${row.id}/download`, { responseType: 'blob' });
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    // 从 Content-Disposition 头部提取文件名
    const disposition = response.headers['content-disposition'];
    let filename = `file-${row.id}`;
    if (disposition) {
      const match = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
      if (match?.[1]) {
        filename = decodeURIComponent(match[1].replace(/['"]/g, ''));
      }
    }
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  } catch (error: unknown) {
    MessagePlugin.error('下载失败：' + getErrorMessage(error));
  }
}

async function handleDelete(id: string) {
  await fileStore.deleteFile(id);
  MessagePlugin.success('删除成功');
}

async function convertToMarkdown() {
  if (selectedImages.value.length === 0) {
    MessagePlugin.warning('请先选择图片文件');
    return;
  }

  try {
    const ids = selectedImages.value.map((i) => i.id);
    const res = await api.post('/files/batch-markdown', { ids });
    markdownResult.value = res.data.data?.markdown?.join('\n') || '';
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

function copyMarkdown() {
  navigator.clipboard.writeText(markdownResult.value);
  MessagePlugin.success('已复制到剪贴板');
}

// 同步分页和搜索到 URL 查询参数
watch([page, search], ([newPage, newSearch]) => {
  const query: Record<string, string> = {};
  if (newPage > 1) query.page = String(newPage);
  if (newSearch) query.search = newSearch;
  router.replace({ query });
});

onMounted(() => {
  fileStore.fetchFiles();
});
</script>

<style scoped>
.drop-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 82, 217, 0.15);
  border: 3px dashed var(--primary-color);
  border-radius: 12px;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(4px);
}

.drop-overlay-content {
  text-align: center;
  color: var(--primary-color);
}

.drop-overlay-content h2 {
  font-size: 24px;
  font-weight: 600;
}
</style>
