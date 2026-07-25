<template>
  <t-dialog
    v-model:visible="dialogVisible"
    header="上传文件"
    :width="isMobile ? '100%' : '560px'"
    :footer="false"
    @close="handleClose"
    destroy-on-close
  >
    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
      <span style="font-size: 14px; color: var(--text-secondary);">同时上传文件数：</span>
      <t-select v-model="concurrency" :options="concurrencyOptions" style="width: 80px;" size="small" />
    </div>

    <!-- 标签选择 -->
    <div style="margin-bottom: 12px;">
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
        <span style="font-size: 12px; color: var(--text-secondary);">上传时添加标签：</span>
        <t-button size="small" variant="text" @click="showTagSelector = !showTagSelector">
          {{ selectedTagIds.length > 0 ? `已选 ${selectedTagIds.length} 个标签` : (tagStore.tags?.length ? '选择标签' : '新建标签') }}
        </t-button>
      </div>
      <div v-if="showTagSelector" style="padding: 8px; background: var(--bg-secondary); border-radius: 6px; border: 1px solid var(--border-color);">
        <!-- 已有标签选择 -->
        <div v-if="tagStore.tags && tagStore.tags.length > 0" style="display: flex; gap: 6px; flex-wrap: wrap;">
          <t-tag
            v-for="tag in tagStore.tags"
            :key="tag.id"
            :theme="selectedTagIds.includes(tag.id) ? 'primary' : 'default'"
            :variant="selectedTagIds.includes(tag.id) ? 'dark' : 'outline'"
            style="cursor: pointer;"
            @click="toggleTag(tag.id)"
          >
            <span :style="{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: tag.color, marginRight: '4px' }" />
            {{ tag.name }}
          </t-tag>
        </div>
        <!-- 在已有标签下方/独立区域：新建标签 -->
        <div style="display: flex; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border-color);">
          <t-input
            v-model="newTagName"
            placeholder="新建标签名称"
            size="small"
            style="flex: 1; min-width: 0;"
            autocomplete="off"
            name="upload-tag-name"
          />
          <t-button size="small" theme="primary" :disabled="!newTagName.trim()" @click="handleCreateTag">
            新建
          </t-button>
        </div>
      </div>
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
      <div style="font-size: 48px; margin-bottom: 16px;">📤</div>
      <h3>拖拽文件到此处，或点击选择文件</h3>
      <p style="color: var(--text-secondary); margin-top: 8px;">
        单文件最大 {{ maxFileSizeMB }}MB，支持图片、PDF、ZIP 等格式
      </p>
    </div>

    <t-loading v-if="uploading" style="margin-top: 16px;" />

    <!-- 上传队列（含进度条） -->
    <div v-if="uploadQueue.length > 0" style="margin-top: 16px;">
      <div v-for="(item, index) in uploadQueue" :key="index"
        style="padding: 12px; background: var(--bg-secondary); border-radius: 8px; margin-bottom: 8px; border: 1px solid var(--border-color);">
        <div style="display: flex; align-items: center; gap: 12px;">
          <img v-if="item.file.type.startsWith('image/')" :src="getPreviewUrl(item.file)" loading="lazy" style="width: 32px; height: 32px; object-fit: cover; border-radius: 4px; flex-shrink: 0;" />
          <span v-else style="font-size: 20px;">📎</span>
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ item.file.name }}</div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
              {{ formatModalSize(item.file.size) }}
              <t-tag v-if="item.status === 'success'" theme="success" size="small" variant="light">成功</t-tag>
              <t-tag v-else-if="item.status === 'error'" theme="danger" size="small" variant="light">失败</t-tag>
              <t-tag v-else-if="item.status === 'processing'" theme="warning" size="small" variant="light">处理中</t-tag>
              <t-tag v-else-if="item.progress > 0" theme="primary" size="small" variant="light">{{ item.progress }}%</t-tag>
              <t-tag v-else theme="primary" size="small" variant="light">等待</t-tag>
            </div>
          </div>
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

    <div v-if="batchResult && uploadQueue.length > 0" style="margin-top: 16px;">
      <t-tag v-if="batchResult.failed.length === 0" theme="success">
        全部 {{ batchResult.success.length }} 个文件已接收，正在后台处理中...
      </t-tag>
      <t-tag v-else theme="warning">
        {{ batchResult.success.length }} 个成功，{{ batchResult.failed.length }} 个失败
      </t-tag>

      <div v-if="batchResult.failed.length > 0" style="margin-top: 12px;">
        <div v-for="(item, index) in batchResult.failed" :key="'fail-' + index"
          style="padding: 8px 12px; background: var(--bg-secondary); border-radius: 8px; margin-bottom: 8px; border: 1px solid var(--border-color);">
          <span style="color: var(--error);">❌</span>
          <span style="margin-left: 8px; font-weight: 500;">{{ item.name }}</span>
          <span style="margin-left: 8px; color: var(--text-secondary);">{{ item.reason }}</span>
        </div>
      </div>

      <div style="margin-top: 16px; text-align: right;">
        <t-button v-if="batchResult.failed.length === 0" theme="primary" @click="handleClose">
          完成
        </t-button>
        <t-button v-else theme="primary" variant="outline" @click="resetQueue">
          重新选择
        </t-button>
      </div>
    </div>
  </t-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import MessagePlugin from '@/utils/message';
import { useFileStore } from '../stores/files';
import { useTagStore } from '../stores/tags';
import { api } from '../stores/auth';
import { useMobile } from '../composables/useMobile';
import { formatSize as formatModalSize } from '../utils/format';
import { getErrorMessage } from '../utils/error';
import { useChunkedUpload } from '../composables/useChunkedUpload';
import type { BatchUploadResult } from '../types/file';

const isMobile = useMobile();

const props = defineProps<{
  visible: boolean;
  initialFiles?: File[];
}>();
const emit = defineEmits<{
  close: [];
  uploaded: [];
}>();

// 弹窗双向绑定代理（重命名避免与 props.visible 遮蔽混淆）
const dialogVisible = computed({
  get: () => props.visible,
  set: (val) => { if (!val) emit('close'); },
});

type QueueStatus = 'pending' | 'processing' | 'success' | 'error';

interface QueueEntry {
  uid: string;           // 唯一标识，防止同名文件覆盖
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
const fileTypeMode = ref<'blacklist' | 'whitelist'>('blacklist');

const fileStore = useFileStore();
const tagStore = useTagStore();
const fileInput = ref<HTMLInputElement>();
const isDragover = ref(false);
const uploading = ref(false);
const uploadQueue = ref<QueueEntry[]>([]);
const batchResult = ref<BatchUploadResult | null>(null);
const selectedTagIds = ref<string[]>([]);
const showTagSelector = ref(false);
const newTagName = ref('');
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
    // 尚未开始传输或 checkpointTime 未初始化 → 跳过
    if (entry.checkpointTime === 0) continue;
    const timeDiff = (now - entry.checkpointTime) / 1000;
    if (timeDiff <= 0) continue;
    const bytesDiff = entry.loadedBytes - entry.checkpointBytes;
    const speed = bytesDiff / timeDiff;
    entry.speed = formatSpeed(speed);
    const remaining = entry.totalBytes - entry.loadedBytes;
    entry.eta = formatETA(speed > 0 ? remaining / speed : 0);
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

// 本地文件预览 URL 缓存
const previewUrls = new Map<File, string>();
function getPreviewUrl(file: File): string {
  if (!previewUrls.has(file)) {
    previewUrls.set(file, URL.createObjectURL(file));
  }
  return previewUrls.get(file)!;
}

function resetQueue() {
  uploadQueue.value = [];
  batchResult.value = null;
  // 释放本地预览 ObjectURL，避免反复选择文件时累积内存泄漏
  for (const url of previewUrls.values()) {
    URL.revokeObjectURL(url);
  }
  previewUrls.clear();
}

function toggleTag(tagId: string) {
  const idx = selectedTagIds.value.indexOf(tagId);
  if (idx === -1) {
    selectedTagIds.value.push(tagId);
  } else {
    selectedTagIds.value.splice(idx, 1);
  }
}

async function handleCreateTag() {
  const name = newTagName.value.trim();
  if (!name) return;
  try {
    const tag = await tagStore.createTag(name);
    selectedTagIds.value = [...selectedTagIds.value, tag.id];
    newTagName.value = '';
  } catch (err) {
    MessagePlugin.error(getErrorMessage(err) || '创建标签失败');
  }
}

// 进行中的全部上传 AbortController 集合：关闭弹窗时统一中止，避免孤儿请求
const activeControllers = new Set<AbortController>();
let uploadBatchGeneration = 0;

function abortAllUploads() {
  uploadBatchGeneration++;
  for (const controller of activeControllers) {
    try {
      controller.abort();
    } catch {
      // 忽略个别 abort 异常
    }
  }
  activeControllers.clear();
}

function handleClose() {
  stopSpeedTimer();
  abortAllUploads();
  resetQueue();
  emit('close');
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('上传已取消'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error('上传已取消'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 校验单个文件是否匹配 acceptTypes 规则（MIME 精确 / image/* 前缀 / .ext 后缀） */
function matchesAcceptTypes(file: File): boolean {
  const accept = acceptTypes.value;
  if (!accept) return true; // 黑名单或未配置模式：前端不限制类型，交由后端校验
  const fileName = file.name.toLowerCase();
  const mime = file.type.toLowerCase();
  return accept.split(',').some((rule) => {
    const r = rule.trim().toLowerCase();
    if (!r) return true;
    if (r.endsWith('/*')) return mime.startsWith(r.slice(0, -1)); // 'image/*' → 'image/'
    if (r.startsWith('.')) return fileName.endsWith(r);           // '.pdf'
    return mime === r;                                            // 'application/pdf'
  });
}

function validateFiles(files: File[]): File[] {
  return files.filter((f) => {
    if (f.size > maxFileSizeBytes.value) {
      MessagePlugin.warning(`文件 "${f.name}" 超过 ${maxFileSizeMB.value}MB 限制，已跳过`);
      return false;
    }
    // 白名单模式下前端同步校验类型，避免 accept 属性被绕过
    if (fileTypeMode.value === 'whitelist' && !matchesAcceptTypes(f)) {
      MessagePlugin.warning(`文件 "${f.name}" 类型不受支持，已跳过`);
      return false;
    }
    return true;
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
    fileTypeMode.value = data.fileTypeMode || 'blacklist';
    const filterList: string[] = data.fileTypeFilter || [];
    if (fileTypeMode.value === 'whitelist' && filterList.length > 0) {
      acceptTypes.value = filterList.join(',');
    } else {
      acceptTypes.value = '';
    }
  } catch {
    // 使用默认值
  }
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
  target.value = '';
}

/**
 * 生成唯一 ID。
 * crypto.randomUUID() 需要安全上下文且属 ES2022 运行时 API，
 * 构建 target 为 es2020 或 HTTP 部署时可能缺失，这里做逐级降级避免运行时崩溃。
 */
function genUid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // 设置 v4 UUID 的版本位与变体位
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function uploadFiles(files: File[]) {
  if (files.length === 0 || uploading.value) return;

  uploading.value = true;
  batchResult.value = null;
  const batchGeneration = ++uploadBatchGeneration;
  const isCurrentBatch = () => batchGeneration === uploadBatchGeneration;

  const queueEntries: QueueEntry[] = files.map((f) => ({
    uid: genUid(),  // 唯一标识
    file: f,
    status: 'pending' as QueueStatus,
    errorReason: undefined,
    progress: 0,
    totalBytes: f.size,
    loadedBytes: 0,
    speed: '-',
    eta: '-',
    checkpointTime: 0,  // 延迟到首次 onUploadProgress 回调时记录，排除排队等待时间
    checkpointBytes: 0,
  }));

  // 先赋值给 ref 触发 Vue 响应式包装，再从响应式数组中建 Map
  uploadQueue.value = queueEntries;
  const queueMap = new Map<string, QueueEntry>(
    uploadQueue.value.map((e) => [e.uid, e])
  );

  const successList: { id: string; originalName: string }[] = [];
  const failedList: { name: string; reason: string }[] = [];

  // 启动速度计算定时器
  startSpeedTimer();

  // 滑动窗口并发：始终保持 concurrency 个文件在上传中，
  // 每完成一个立即启动下一个，而非等待整批全部完成
  let nextFileIndex = 0;
  let staggerCounter = 0;

  /** 大文件分片上传逻辑 */
  const uploadSingleChunked = async (
    file: File,
    entry: QueueEntry,
    abortController: AbortController,
  ): Promise<void> => {
    // 每个文件使用独立 composable 状态，避免并发文件共享 uploadId/progress。
    const chunkedUpload = useChunkedUpload(3);
    try {
      const result = await chunkedUpload.uploadFile(
        file,
        (p) => {
          if (!isCurrentBatch() || abortController.signal.aborted) return;
          entry.progress = p.totalChunks > 0 ? Math.round((p.uploadedChunks / p.totalChunks) * 100) : 0;
          entry.loadedBytes = p.loadedBytes;
          entry.speed = p.speed;
          entry.eta = p.eta;
          if (entry.checkpointTime === 0) entry.checkpointTime = Date.now();
        },
        abortController.signal,
      );
      if (!isCurrentBatch() || abortController.signal.aborted) return;
      entry.status = 'success';
      successList.push({ id: result.id, originalName: result.originalName });
    } catch (error: unknown) {
      if (!isCurrentBatch() || abortController.signal.aborted) return;
      entry.status = 'error';
      entry.errorReason = getErrorMessage(error);
      failedList.push({ name: file.name, reason: getErrorMessage(error) });
    }
  };

  const uploadSingle = async (file: File, uid: string, stagger: number): Promise<void> => {
    const abortController = new AbortController();
    activeControllers.add(abortController);
    try {
      // 分级延迟启动，将请求分散到 300ms 窗口内；延时同样响应取消。
      await abortableDelay(stagger * 300, abortController.signal);
      if (!isCurrentBatch()) return;

      const entry = queueMap.get(uid);
      if (!entry) return;

      const CHUNK_THRESHOLD = 5 * 1024 * 1024;
      if (file.size > CHUNK_THRESHOLD) {
        await uploadSingleChunked(file, entry, abortController);
        return;
      }

      const result = await fileStore.uploadFileAsync(
        file,
        (loaded, total) => {
          if (!isCurrentBatch() || abortController.signal.aborted) return;
          entry.progress = total > 0 ? Math.round((loaded / total) * 100) : 0;
          entry.loadedBytes = loaded;
          if (entry.checkpointBytes === 0 && loaded > 0) {
            entry.checkpointTime = Date.now();
          }
        },
        (status) => {
          if (isCurrentBatch() && !abortController.signal.aborted && status === 'uploading') {
            entry.status = 'processing';
          }
        },
        abortController.signal,
      );
      if (!isCurrentBatch() || abortController.signal.aborted) return;
      entry.status = 'success';
      successList.push({ id: result.id, originalName: result.originalName });
    } catch (error: unknown) {
      if (!isCurrentBatch() || abortController.signal.aborted) return;
      const entry = queueMap.get(uid);
      if (entry) {
        entry.status = 'error';
        entry.errorReason = getErrorMessage(error);
      }
      failedList.push({ name: file.name, reason: getErrorMessage(error) });
    } finally {
      activeControllers.delete(abortController);
    }
  };

  // 每个协程通过 while 循环迭代消费队列（替代尾递归，避免超大批量栈溢出且便于中止）
  const runWorker = async (): Promise<void> => {
    while (true) {
      const idx = nextFileIndex++;
      if (idx >= files.length) return; // 队列耗尽
      const myStagger = staggerCounter++;
      await uploadSingle(files[idx], queueEntries[idx].uid, myStagger);
      // 当前文件完成 → 继续取下一个，保持窗口满载
    }
  };

  // 启动初始 concurrency 个协程
  await Promise.all(
    Array.from({ length: Math.min(concurrency.value, files.length) }, () => runWorker())
  );

  if (!isCurrentBatch()) return;

  // 最后一次更新速度
  updateSpeeds();
  stopSpeedTimer();

  batchResult.value = { success: successList, failed: failedList };

  // 上传完成后关联标签（并发关联，单个失败不影响其他文件）
  if (selectedTagIds.value.length > 0 && successList.length > 0) {
    const tagIds = selectedTagIds.value;
    await Promise.allSettled(
      successList.map((file) => api.put(`/files/${file.id}/tags`, { tagIds }))
    );
  }

  emit('uploaded');

  if (failedList.length === 0) {
    MessagePlugin.success('文件接收完成，正在后台处理中，请稍后刷新查看');
  } else if (successList.length > 0) {
    MessagePlugin.success(`${successList.length} 个文件已接收，${failedList.length} 个失败。正在后台处理中`);
  } else {
  }

  uploading.value = false;
}

// 上传配置改为弹窗打开时惰性获取（见下方 visible 监听），避免未打开弹窗也发请求

// 当弹窗打开且有预置文件时，自动上传
watch(() => props.visible, async (isVisible) => {
  if (isVisible) {
    // 打开时获取上传配置（大小上限/类型白名单），确保校验使用最新服务端配置
    await fetchUploadConfig();
    await tagStore.fetchTags();
    selectedTagIds.value = [];
    showTagSelector.value = false;
    newTagName.value = '';
    if (props.initialFiles && props.initialFiles.length > 0) {
      await uploadFiles(validateFiles(Array.from(props.initialFiles)));
    }
  }
});

onUnmounted(() => {
  stopSpeedTimer();
  abortAllUploads();
  for (const url of previewUrls.values()) {
    URL.revokeObjectURL(url);
  }
  previewUrls.clear();
});
</script>

<style scoped>
@media (max-width: 768px) {
  :deep(.t-dialog) {
    margin: 16px;
  }
  :deep(.t-dialog__body) {
    padding: 12px;
  }
}
</style>
