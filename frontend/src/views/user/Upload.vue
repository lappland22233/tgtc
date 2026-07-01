<template>
  <div>
    <div class="page-header">
      <h1>上传文件</h1>
      <p>支持拖拽上传，单文件最大 {{ maxFileSizeMB }}MB</p>
    </div>

    <div class="card">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
        <span style="font-size: 14px; color: var(--text-secondary);">同时上传文件数：</span>
        <t-select v-model="concurrency" :options="concurrencyOptions" style="width: 80px;" size="small" />
      </div>
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
            <img v-if="item.file.type.startsWith('image/')" :src="getPreviewUrl(item.file)" style="width: 48px; height: 48px; object-fit: cover; border-radius: 6px;" />
            <span v-else style="font-size: 24px;">{{ getFileEmoji(item.file.type) }}</span>
          </div>
          <div class="file-info" style="flex: 1;">
            <div class="file-name">{{ item.file.name }}</div>
            <div class="file-meta">
              {{ formatSize(item.file.size) }}
              <t-tag v-if="item.status === 'success'" theme="success" size="small">上传成功</t-tag>
              <t-tag v-else-if="item.status === 'error'" theme="danger" size="small">上传失败</t-tag>
              <t-tag v-else-if="item.progress > 0" theme="primary" size="small">{{ item.progress }}%</t-tag>
              <t-tag v-else theme="primary" size="small">等待上传...</t-tag>
            </div>
            <div v-if="item.progress > 0 && item.status !== 'success' && item.status !== 'error'" style="margin-top: 8px;">
              <t-progress :percentage="item.progress" size="small" />
              <div style="display: flex; gap: 16px; margin-top: 4px; font-size: 12px; color: var(--text-secondary);">
                <span>{{ item.speed }}</span>
                <span>剩余 {{ item.eta }}</span>
              </div>
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
import { ref, onMounted, onUnmounted } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import { useFileStore } from '../../stores/files';
import { api } from '../../stores/auth';
import { formatSize, getFileEmoji } from '@/utils/format';
import { getErrorMessage } from '../../utils/error';
import type { BatchUploadResult, BatchUploadSuccessItem } from '../../types/file';

type QueueStatus = 'pending' | 'success' | 'error';

interface QueueEntry {
  file: File;
  status: QueueStatus;
  errorReason?: string;
  progress: number;
  totalBytes: number;
  loadedBytes: number;
  speed: string;
  eta: string;
  checkpointTime: number;
  checkpointBytes: number;
}

const maxFileSizeBytes = ref(20 * 1024 * 1024);
const maxFileSizeMB = ref(20);
const acceptTypes = ref('');

const fileStore = useFileStore();
const fileInput = ref<HTMLInputElement>();
const isDragover = ref(false);
const uploading = ref(false);
const uploadQueue = ref<QueueEntry[]>([]);
const selectedFiles = ref<string[]>([]); // 存储成功上传的文件 ID
const markdownResult = ref('');
const batchResult = ref<BatchUploadResult | null>(null);
const concurrency = ref(3);
const concurrencyOptions = Array.from({ length: 10 }, (_, i) => ({ label: `${i + 1}`, value: i + 1 }));

// 速度/ETA 计算定时器
let speedTimer: ReturnType<typeof setInterval> | null = null;

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '计算中...';
  if (bytesPerSec >= 1048576) return (bytesPerSec / 1048576).toFixed(1) + ' MB/s';
  if (bytesPerSec >= 1024) return (bytesPerSec / 1024).toFixed(0) + ' KB/s';
  return bytesPerSec.toFixed(0) + ' B/s';
}

function formatETA(seconds: number): string {
  if (seconds <= 0 || !isFinite(seconds)) return '计算中...';
  if (seconds >= 3600) return Math.ceil(seconds / 3600) + ' 小时';
  if (seconds >= 60) return Math.ceil(seconds / 60) + ' 分钟';
  return Math.ceil(seconds) + ' 秒';
}

function updateSpeeds() {
  const now = Date.now();
  for (const entry of uploadQueue.value) {
    if (entry.status === 'pending' || entry.status === 'success' || entry.status === 'error') continue;
    const timeDiff = (now - entry.checkpointTime) / 1000;
    if (timeDiff <= 0) continue;
    const bytesDiff = entry.loadedBytes - entry.checkpointBytes;
    const speed = bytesDiff / timeDiff;
    entry.speed = formatSpeed(speed);
    const remaining = entry.totalBytes - entry.loadedBytes;
    entry.eta = formatETA(speed > 0 ? remaining / speed : 0);
    // 更新检查点
    entry.checkpointTime = now;
    entry.checkpointBytes = entry.loadedBytes;
  }
}

function startSpeedTimer() {
  stopSpeedTimer();
  speedTimer = setInterval(updateSpeeds, 3000);
}

function stopSpeedTimer() {
  if (speedTimer) {
    clearInterval(speedTimer);
    speedTimer = null;
  }
}

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

  // 构建初始队列
  const now = Date.now();
  const queueEntries: QueueEntry[] = files.map((f) => ({
    file: f,
    status: 'pending' as QueueStatus,
    errorReason: undefined,
    progress: 0,
    totalBytes: f.size,
    loadedBytes: 0,
    speed: '-',
    eta: '-',
    checkpointTime: now,
    checkpointBytes: 0,
  }));

  // 先赋值给 ref 触发 Vue 响应式包装，再从响应式数组中建 Map
  uploadQueue.value = queueEntries;
  const queueMap = new Map<string, QueueEntry>(
    uploadQueue.value.map((e) => [
      `${e.file.name}-${e.file.size}-${e.file.lastModified}`,
      e,
    ])
  );

  // 新批次前清理 selectedFiles 数据
  selectedFiles.value = [];

  const successList: BatchUploadSuccessItem[] = [];
  const failedList: { name: string; reason: string }[] = [];

  // 启动速度计算定时器
  startSpeedTimer();

  // 逐文件上传，每批 concurrency 个文件并发执行
  for (let i = 0; i < files.length; i += concurrency.value) {
    const batch = files.slice(i, i + concurrency.value);
    await Promise.allSettled(
      batch.map(async (file) => {
        const entry = queueMap.get(`${file.name}-${file.size}-${file.lastModified}`);
        try {
          const result = await fileStore.uploadFile(file, (loaded, total) => {
            if (entry) {
              entry.progress = total > 0 ? Math.round((loaded / total) * 100) : 0;
              entry.loadedBytes = loaded;
            }
          });
          if (entry) entry.status = 'success';
          successList.push({ id: result.id, originalName: result.originalName });
          selectedFiles.value.push(result.id);
        } catch (error: unknown) {
          if (entry) {
            entry.status = 'error';
            entry.errorReason = getErrorMessage(error);
          }
          failedList.push({ name: file.name, reason: getErrorMessage(error) });
        }
      })
    );
  }

  // 最后一次更新速度
  updateSpeeds();
  stopSpeedTimer();

  batchResult.value = { success: successList, failed: failedList };

  // 刷新列表
  if (successList.length > 0) {
    await fileStore.fetchFiles();
  }

  // 全成功提示
  if (failedList.length === 0) {
    MessagePlugin.success('全部文件上传成功');
  } else {
    MessagePlugin.warning(`${failedList.length} 个文件上传失败，请查看详情`);
  }

  uploading.value = false;
}

async function convertToMarkdown() {
  // 直接从上传成功的图片文件 ID 中筛选
  const imageIds = selectedFiles.value.filter(id => {
    const file = fileStore.files.find(f => f.id === id);
    return file && file.mimeType.startsWith('image/');
  });

  if (imageIds.length === 0) {
    MessagePlugin.warning('请先上传图片文件');
    return;
  }

  try {
    const res = await api.post('/files/batch-markdown', { ids: imageIds });
    markdownResult.value = res.data.data?.markdown?.join('\n') || '';
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

function copyMarkdown() {
  if (!navigator.clipboard) {
    MessagePlugin.warning('当前浏览器不支持剪贴板操作，请手动复制');
    return;
  }
  navigator.clipboard.writeText(markdownResult.value).then(() => {
    MessagePlugin.success('已复制到剪贴板');
  }).catch(() => {
    MessagePlugin.warning('复制失败，请手动选择文本复制');
  });
}

async function fetchUploadConfig() {
  try {
    const res = await api.get('/files/upload-config');
    const data = res.data.data;
    if (data.maxFileSize) {
      maxFileSizeBytes.value = data.maxFileSize;
      maxFileSizeMB.value = Math.round((data.maxFileSize / 1024 / 1024) * 100) / 100;
    }
    if (data.fileTypeMode === 'whitelist' && data.fileTypeFilter?.length > 0) {
      acceptTypes.value = data.fileTypeFilter.join(',');
    } else {
      acceptTypes.value = '';
    }
  } catch {
    // 使用默认值
  }
}

onMounted(fetchUploadConfig);

onUnmounted(() => {
  stopSpeedTimer();
  for (const url of previewUrls.values()) {
    URL.revokeObjectURL(url);
  }
  previewUrls.clear();
});

// 本地文件预览 URL 缓存
const previewUrls = new Map<File, string>();
function getPreviewUrl(file: File): string {
  if (!previewUrls.has(file)) {
    previewUrls.set(file, URL.createObjectURL(file));
  }
  return previewUrls.get(file)!;
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.includes('pdf')) return 'pdf';
  return 'default';
}
</script>
