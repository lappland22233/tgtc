<template>
  <div
    class="file-card"
    :class="{ selected: selected, deleted: file.isDeleted }"
    @click="onCardClick"
    @dblclick="onCardDoubleClick"
  >
    <div v-if="selectable" class="card-checkbox" @click.stop="onToggleSelect">
      <t-checkbox :checked="selected" />
    </div>

    <div v-if="file.hasPassword" class="card-lock-badge">
      <t-icon name="lock-on" size="14px" />
    </div>

    <div class="card-preview">
      <ThumbnailImg
        :file-id="file.id"
        :mime-type="file.mimeType"
        :size="160"
        :emoji="getFileEmoji(file.mimeType)"
      />
    </div>

    <div class="card-info">
      <div class="card-name" :title="file.originalName">{{ file.originalName }}</div>
      <div class="card-meta">
        <span class="meta-size">{{ formatSize(file.size) }}</span>
        <span class="meta-divider">·</span>
        <span class="meta-date">{{ formatRelativeDate(file.createdAt) }}</span>
      </div>
    </div>

    <div class="card-actions-overlay" v-if="!file.isDeleted">
      <t-button size="small" theme="primary" variant="outline" shape="circle" title="下载" @click.stop="emit('download', file)">
        <template #icon><t-icon name="download" /></template>
      </t-button>
      <t-button size="small" theme="default" variant="outline" shape="circle" title="复制分享链接" @click.stop="emit('share', file)">
        <template #icon><t-icon name="link" /></template>
      </t-button>
      <t-button size="small" theme="default" variant="outline" shape="circle" title="移动到..." @click.stop="emit('move', file)">
        <template #icon><t-icon name="folder-move" /></template>
      </t-button>
      <t-button size="small" theme="default" variant="outline" shape="circle" title="标签" @click.stop="emit('tag', file)">
        <template #icon><t-icon name="tag" /></template>
      </t-button>
      <t-button size="small" theme="danger" variant="outline" shape="circle" title="删除" @click.stop="emit('delete', file)">
        <template #icon><t-icon name="delete" /></template>
      </t-button>
    </div>

    <div v-if="file.status === 'processing'" class="card-status-overlay">
      <t-loading size="small" text="上传中..." />
    </div>
    <div v-else-if="file.status === 'error'" class="card-status-overlay card-error">
      <t-icon name="error-circle" size="24px" />
      <span>上传失败</span>
    </div>
    <div v-else-if="file.isDeleted" class="card-status-overlay card-deleted-overlay">
      <span>回收站中</span>
      <span v-if="file.deleteScheduledAt" class="delete-date">
        {{ formatDate(file.deleteScheduledAt) }} 永久删除
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import ThumbnailImg from '../ThumbnailImg.vue';
import { formatSize, formatDate, getFileEmoji } from '@/utils/format';
import type { FileItem } from '../../types/file';

const props = withDefaults(defineProps<{
  file: FileItem;
  selected?: boolean;
  selectable?: boolean;
}>(), {
  selected: false,
  selectable: false,
});

const emit = defineEmits<{
  click: [file: FileItem];
  dblclick: [file: FileItem];
  toggleSelect: [file: FileItem];
  download: [file: FileItem];
  share: [file: FileItem];
  move: [file: FileItem];
  tag: [file: FileItem];
  delete: [file: FileItem];
}>();

function onCardClick() {
  emit('click', props.file);
}

function onCardDoubleClick() {
  emit('dblclick', props.file);
}

function onToggleSelect() {
  emit('toggleSelect', props.file);
}

/** 格式化为相对时间，降级为 formatDate */
function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  if (days < 7) return `${days} 天前`;
  if (days < 365) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return formatDate(dateStr);
}
</script>

<style scoped>
.file-card {
  position: relative;
  background: var(--td-bg-color-container);
  border: 2px solid var(--td-border-level-1-color);
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  flex-direction: column;
}

.file-card:hover {
  border-color: var(--td-brand-color);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  transform: translateY(-2px);
}

.file-card.selected {
  border-color: var(--td-brand-color);
  background: var(--td-brand-color-focus);
}

.file-card.deleted {
  opacity: 0.55;
  cursor: not-allowed;
}

.card-checkbox {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 3;
  background: var(--td-bg-color-container);
  border-radius: 4px;
  padding: 2px;
  opacity: 0;
  transition: opacity 0.2s;
}

.file-card:hover .card-checkbox,
.file-card.selected .card-checkbox {
  opacity: 1;
}

.card-lock-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 3;
  background: var(--td-warning-color);
  color: #fff;
  border-radius: 4px;
  padding: 2px 4px;
  display: flex;
  align-items: center;
}

.card-preview {
  width: 100%;
  aspect-ratio: 1.4 / 1;
  background: var(--td-bg-color-secondarycontainer);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.card-info {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.card-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--td-text-color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.4;
}

.card-meta {
  font-size: 11px;
  color: var(--td-text-color-secondary);
  display: flex;
  align-items: center;
  gap: 4px;
}

.meta-divider {
  color: var(--td-text-color-placeholder);
}

.card-actions-overlay {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.75), transparent);
  padding: 12px 8px;
  display: flex;
  justify-content: center;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.2s;
}

.file-card:hover .card-actions-overlay {
  opacity: 1;
}

.card-status-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #fff;
  font-size: 12px;
}

.card-status-overlay.card-error {
  color: var(--td-error-color);
}

.card-deleted-overlay .delete-date {
  font-size: 11px;
  opacity: 0.8;
}
</style>
