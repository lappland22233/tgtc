<template>
  <div class="upload-queue-row" :title="entry.fileName">
    <div class="upload-queue-row__main">
      <img v-if="previewUrl" :src="previewUrl" class="upload-queue-row__preview" alt="" />
      <FileTypeIcon v-else :mimeType="entry.mimeType" :fileName="entry.fileName" :size="20" />
      <div class="upload-queue-row__info">
        <div class="upload-queue-row__name">{{ entry.fileName }}</div>
        <div v-if="entry.relativePath" class="upload-queue-row__path">{{ entry.relativePath }}</div>
        <div class="upload-queue-row__meta">
          {{ formatSize(entry.totalBytes) }}
          <t-tag v-if="entry.status === 'success'" theme="success" size="small" variant="light">成功</t-tag>
          <t-tag v-else-if="entry.status === 'error'" theme="danger" size="small" variant="light">失败</t-tag>
          <t-tag v-else-if="entry.status === 'cancelled'" theme="default" size="small" variant="light">已取消</t-tag>
          <t-tag v-else-if="entry.status === 'processing' && (entry.retryCount ?? 0) > 0" theme="warning" size="small" variant="light">重试 {{ entry.retryCount }}/2</t-tag>
          <t-tag v-else-if="entry.status === 'processing'" theme="warning" size="small" variant="light">处理中</t-tag>
          <t-tag v-else theme="primary" size="small" variant="light">{{ entry.progress > 0 ? `${entry.progress}%` : '等待' }}</t-tag>
        </div>
      </div>
      <t-button v-if="entry.status === 'pending' || entry.status === 'processing'" size="small" variant="text" shape="square" :aria-label="`取消上传 ${entry.fileName}`" @click="$emit('cancel', entry.uid)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
      </t-button>
    </div>
    <div v-if="entry.progress > 0 && entry.status === 'processing'" class="upload-queue-row__progress">
      <t-progress :percentage="entry.progress" size="small" />
      <span>{{ entry.speed }} · 剩余 {{ entry.eta }}</span>
    </div>
    <div v-if="entry.status === 'error' && entry.errorReason" class="upload-queue-row__error" :title="entry.errorReason">{{ entry.errorReason }}</div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import FileTypeIcon from '@/components/FileTypeIcon.vue';
import type { QueueEntry } from '@/stores/upload';
import { formatSize } from '@/utils/format';

const props = defineProps<{ entry: QueueEntry; allowPreview: boolean }>();
defineEmits<{ cancel: [uid: string] }>();

const previewUrl = ref('');
if (props.allowPreview && props.entry.file && props.entry.mimeType.startsWith('image/')) {
  previewUrl.value = URL.createObjectURL(props.entry.file);
}

onBeforeUnmount(() => {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
});
</script>

<style scoped>
.upload-queue-row { box-sizing: border-box; height: 104px; padding: 10px 12px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden; }
.upload-queue-row__main { display: flex; align-items: center; gap: 12px; }
.upload-queue-row__preview { width: 32px; height: 32px; object-fit: cover; border-radius: 4px; flex-shrink: 0; }
.upload-queue-row__info { flex: 1; min-width: 0; }
.upload-queue-row__name, .upload-queue-row__path, .upload-queue-row__error { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.upload-queue-row__name { font-weight: 500; }
.upload-queue-row__path { margin-top: 2px; font-size: 12px; color: var(--text-tertiary); }
.upload-queue-row__meta { margin-top: 2px; font-size: 12px; color: var(--text-secondary); }
.upload-queue-row__progress { margin-top: 6px; display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; font-size: 11px; color: var(--text-secondary); }
.upload-queue-row__error { margin-top: 5px; font-size: 12px; color: var(--error); }
</style>
