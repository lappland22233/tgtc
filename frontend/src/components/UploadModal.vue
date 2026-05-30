<template>
  <t-dialog
    v-model:visible="visible"
    header="上传文件"
    width="560px"
    :footer="false"
    @close="handleClose"
    destroy-on-close
  >
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

    <div v-if="batchResult && uploadQueue.length > 0" style="margin-top: 16px;">
      <t-tag v-if="batchResult.failed.length === 0" theme="success">
        全部 {{ batchResult.success.length }} 个文件上传成功
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
import { ref, computed, watch } from 'vue';
import { MessagePlugin } from 'tdesign-vue-next';
import { useFileStore } from '../stores/files';
import { api } from '../stores/auth';
import { getErrorMessage } from '../utils/error';
import type { BatchUploadResult } from '../types/file';

const props = defineProps<{
  visible: boolean;
  initialFiles?: File[];
}>();
const emit = defineEmits<{
  close: [];
  uploaded: [];
}>();

const visible = computed({
  get: () => props.visible,
  set: (val) => { if (!val) emit('close'); },
});

type QueueStatus = 'pending' | 'success' | 'error';

const maxFileSizeBytes = ref(20 * 1024 * 1024);
const maxFileSizeMB = ref(20);
const acceptTypes = ref('image/*,.pdf,.zip,.rar,.txt');

const fileStore = useFileStore();
const fileInput = ref<HTMLInputElement>();
const isDragover = ref(false);
const uploading = ref(false);
const uploadQueue = ref<{ file: File; status: QueueStatus; errorReason?: string }[]>([]);
const batchResult = ref<BatchUploadResult | null>(null);

function resetQueue() {
  uploadQueue.value = [];
  batchResult.value = null;
}

function handleClose() {
  resetQueue();
  emit('close');
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

async function uploadFiles(files: File[]) {
  if (files.length === 0) return;

  uploading.value = true;
  batchResult.value = null;

  const queueMap = new Map<string, { file: File; status: QueueStatus; errorReason?: string }>(
    files.map((f) => [f.name, { file: f, status: 'pending', errorReason: undefined }])
  );
  uploadQueue.value = Array.from(queueMap.values());

  try {
    const result = await fileStore.uploadMultiple(files);
    batchResult.value = result;

    for (const item of result.success) {
      const entry = queueMap.get(item.originalName);
      if (entry) entry.status = 'success';
    }

    for (const fail of result.failed) {
      const entry = queueMap.get(fail.name);
      if (entry) {
        entry.status = 'error';
        entry.errorReason = fail.reason;
      }
    }

    emit('uploaded');

    if (result.failed.length === 0) {
      MessagePlugin.success('全部文件上传成功');
    } else {
      MessagePlugin.warning(`${result.failed.length} 个文件上传失败`);
    }
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
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

// 初始化获取上传配置
fetchUploadConfig();

// 当弹窗打开且有预置文件时，自动上传
watch(() => props.visible, async (isVisible) => {
  if (isVisible && props.initialFiles && props.initialFiles.length > 0) {
    await uploadFiles(validateFiles(Array.from(props.initialFiles)));
  }
});
</script>
