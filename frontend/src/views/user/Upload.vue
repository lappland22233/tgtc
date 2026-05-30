<template>
  <div>
    <div class="page-header">
      <h1>上传文件</h1>
      <p>支持拖拽上传，单文件最大 {{ maxFileSizeMB }}MB</p>
    </div>

    <div class="card">
      <div
        class="upload-zone"
        :class="{ dragover: isDragover }"
        @dragover.prevent="isDragover = true"
        @dragleave="isDragover = false"
        @drop.prevent="handleDrop"
        @click="triggerInput"
      >
        <input
          ref="fileInput"
          type="file"
          multiple
          :accept="acceptTypes"
          @change="handleFileSelect"
          style="display: none;"
        />
        <div style="font-size: 48px; margin-bottom: 16px;">⬆️</div>
        <h3>拖拽文件到此处，或点击选择文件</h3>
        <p style="color: var(--text-secondary); margin-top: 8px;">
          支持图片、PDF、ZIP等格式
        </p>
      </div>

      <t-loading v-if="uploading" />

      <!-- 上传结果汇总 -->
      <div v-if="batchResult && uploadQueue.length > 0" style="margin-top: 24px;">
        <div class="batch-result-summary">
          <t-tag v-if="batchResult.failed.length === 0" theme="success" size="large">
            全部 {{ batchResult.success.length }} 个文件上传成功
          </t-tag>
          <t-tag v-else theme="warning" size="large">
            {{ batchResult.success.length }} 个成功，{{ batchResult.failed.length }} 个失败
          </t-tag>
        </div>

        <!-- 失败文件列表 -->
        <div v-if="batchResult.failed.length > 0" class="failed-list">
          <div v-for="(item, index) in batchResult.failed" :key="'fail-' + index" class="failed-item">
            <span style="color: var(--color-error);">❌</span>
            <span style="margin-left: 8px; font-weight: 500;">{{ item.name }}</span>
            <span style="margin-left: 8px; color: var(--text-secondary);">{{ item.reason }}</span>
          </div>
        </div>
      </div>

      <div v-if="uploadQueue.length > 0" class="file-list" style="margin-top: 16px;">
        <h3 style="margin-bottom: 16px;">上传队列</h3>
        <div v-for="(item, index) in uploadQueue" :key="index" class="file-item">
          <div class="file-icon" :class="getFileIcon(item.file.type)">
            {{ getFileEmoji(item.file.type) }}
          </div>
          <div class="file-info">
            <div class="file-name">{{ item.file.name }}</div>
            <div class="file-meta">
              {{ formatSize(item.file.size) }}
              <t-tag v-if="item.status === 'success'" theme="success" size="small">上传成功</t-tag>
              <t-tag v-else-if="item.status === 'error'" theme="danger" size="small">上传失败</t-tag>
              <t-tag v-else theme="primary" size="small">等待上传...</t-tag>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top: 20px;">
      <h3 style="margin-bottom: 16px;">批量转换为 Markdown</h3>
      <p style="color: var(--text-secondary); margin-bottom: 16px;">
        选择图片文件，一键生成 Markdown 格式的引用链接
      </p>
      <t-button theme="primary" :disabled="selectedFiles.length === 0" @click="convertToMarkdown">
        转换为 Markdown
      </t-button>
      <div v-if="markdownResult" style="margin-top: 16px;">
        <t-input
          v-model="markdownResult"
          type="textarea"
          readonly
          :rows="6"
        />
        <t-button theme="primary" variant="outline" style="margin-top: 8px;" @click="copyMarkdown">
          复制结果
        </t-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import { useFileStore } from '../../stores/files';
import { api } from '../../stores/auth';
import { getErrorMessage } from '../../utils/error';
import type { BatchUploadResult } from '../../types/file';

type QueueStatus = 'pending' | 'success' | 'error';

const maxFileSizeBytes = ref(20 * 1024 * 1024);
const maxFileSizeMB = ref(20);
const acceptTypes = ref('image/*,.pdf,.zip,.rar,.txt');

const fileStore = useFileStore();
const fileInput = ref<HTMLInputElement>();
const isDragover = ref(false);
const uploading = ref(false);
const uploadQueue = ref<{ file: File; status: QueueStatus; errorReason?: string }[]>([]);
const selectedFiles = ref<string[]>([]);
const markdownResult = ref('');
const batchResult = ref<BatchUploadResult | null>(null);

function validateFiles(files: File[]): File[] {
  return files.filter((f) => {
    if (f.size > maxFileSizeBytes.value) {
      MessagePlugin.warning(`文件 "${f.name}" 超过 ${maxFileSizeMB.value}MB 限制，已跳过`);
      return false;
    }
    return true;
  });
}

async function handleDrop(e: DragEvent) {
  isDragover.value = false;
  const files = Array.from(e.dataTransfer?.files || []);
  await uploadFiles(validateFiles(files));
}

function triggerInput() {
  fileInput.value?.click();
}

async function handleFileSelect(e: Event) {
  const target = e.target as HTMLInputElement;
  const files = Array.from(target.files || []);
  await uploadFiles(validateFiles(files));
  // 允许重复选择相同文件
  target.value = '';
}

async function uploadFiles(files: File[]) {
  if (files.length === 0) return;

  uploading.value = true;
  batchResult.value = null;

  // 构建初始队列（全部标记为 pending）
  const queueMap = new Map<string, { file: File; status: QueueStatus; errorReason?: string }>(
    files.map((f) => [f.name, { file: f, status: 'pending', errorReason: undefined }])
  );
  uploadQueue.value = Array.from(queueMap.values());

  // 新批次前清理 selectedFiles 数据
  selectedFiles.value = [];

  try {
    // 批量上传，一次请求
    const result = await fileStore.uploadMultiple(files);
    batchResult.value = result;

    // 标记成功
    for (const item of result.success) {
      const entry = queueMap.get(item.originalName);
      if (entry) entry.status = 'success';
      selectedFiles.value.push(item.originalName);
    }

    // 标记失败（按文件名匹配）
    for (const fail of result.failed) {
      const entry = queueMap.get(fail.name);
      if (entry) {
        entry.status = 'error';
        entry.errorReason = fail.reason;
      }
    }

    // 刷新列表
    if (result.success.length > 0) {
      await fileStore.fetchFiles();
    }

    // 全成功提示
    if (result.failed.length === 0) {
      MessagePlugin.success('全部文件上传成功');
    } else {
      MessagePlugin.warning(`${result.failed.length} 个文件上传失败，请查看详情`);
    }
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
    // 网络层错误：所有文件标记为失败
    for (const entry of queueMap.values()) {
      entry.status = 'error';
      entry.errorReason = msg;
    }
    batchResult.value = { success: [], failed: files.map((f) => ({ name: f.name, reason: '网络错误，请重试' })) };
    MessagePlugin.error('批量上传失败');
  } finally {
    uploading.value = false;
  }
}

async function convertToMarkdown() {
  const images = fileStore.files.filter(f =>
    f.mimeType.startsWith('image/') &&
    selectedFiles.value.includes(f.originalName)
  );

  if (images.length === 0) {
    MessagePlugin.warning('请先上传图片文件');
    return;
  }

  try {
    const ids = images.map((i) => i.id);
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

async function fetchUploadConfig() {
  try {
    const res = await api.get('/files/upload-config');
    const data = res.data.data;
    if (data.maxFileSize) {
      maxFileSizeBytes.value = data.maxFileSize;
      maxFileSizeMB.value = Math.round((data.maxFileSize / 1024 / 1024) * 100) / 100;
    }
    if (data.allowedTypes?.length) {
      acceptTypes.value = data.allowedTypes.join(',');
    }
  } catch {
    // 使用默认值
  }
}

onMounted(fetchUploadConfig);

function formatSize(bytes: number) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.includes('pdf')) return 'pdf';
  return 'default';
}

function getFileEmoji(mimeType: string) {
  if (mimeType.startsWith('image/')) return '🖼️';
  if (mimeType.includes('pdf')) return '📄';
  if (mimeType.includes('zip') || mimeType.includes('rar')) return '📦';
  return '📎';
}
</script>
