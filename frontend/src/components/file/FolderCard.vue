<template>
  <div
    class="folder-card"
    :class="{ selected: selected }"
    @click="onCardClick"
    @dblclick="onCardDoubleClick"
    @contextmenu.prevent="onContextMenu"
  >
    <div v-if="selectable" class="folder-checkbox" @click.stop="onToggleSelect">
      <t-checkbox :checked="selected" />
    </div>

    <div class="folder-preview">
      <!-- 文件夹折角图标 -->
      <div class="folder-icon-wrapper">
        <t-icon name="folder" class="folder-icon" />
        <div v-if="itemCount !== undefined" class="folder-count">
          {{ itemCount }}
        </div>
      </div>
    </div>

    <div class="folder-info">
      <div class="folder-name" :title="folder.name">{{ folder.name }}</div>
      <div class="folder-meta">
        <span class="meta-label">文件夹</span>
        <span class="meta-divider">·</span>
        <span class="meta-date">{{ formatRelativeDate(folder.createdAt) }}</span>
      </div>
    </div>

    <div class="folder-actions-overlay">
      <t-button size="small" theme="default" variant="outline" shape="circle" title="进入" @click.stop="emit('open', folder)">
        <template #icon><t-icon name="folder-opened" /></template>
      </t-button>
      <t-button size="small" theme="default" variant="outline" shape="circle" title="重命名" @click.stop="emit('rename', folder)">
        <template #icon><t-icon name="edit" /></template>
      </t-button>
      <t-button size="small" theme="default" variant="outline" shape="circle" title="移动到..." @click.stop="emit('move', folder)">
        <template #icon><t-icon name="folder-move" /></template>
      </t-button>
      <t-button size="small" theme="danger" variant="outline" shape="circle" title="删除" @click.stop="emit('delete', folder)">
        <template #icon><t-icon name="delete" /></template>
      </t-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { formatRelativeDate } from '@/utils/format';
import type { Folder } from '../../stores/folders';

const props = withDefaults(defineProps<{
  folder: Folder;
  selected?: boolean;
  selectable?: boolean;
  itemCount?: number;
}>(), {
  selected: false,
  selectable: false,
});

const emit = defineEmits<{
  click: [folder: Folder];
  dblclick: [folder: Folder];
  contextmenu: [folder: Folder, event: MouseEvent];
  toggleSelect: [folder: Folder];
  open: [folder: Folder];
  rename: [folder: Folder];
  move: [folder: Folder];
  delete: [folder: Folder];
}>();

function onCardClick() {
  emit('click', props.folder);
}

function onCardDoubleClick() {
  emit('dblclick', props.folder);
}

function onContextMenu(event: MouseEvent) {
  emit('contextmenu', props.folder, event);
}

function onToggleSelect() {
  emit('toggleSelect', props.folder);
}
</script>

<style scoped>
.folder-card {
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

.folder-card:hover {
  border-color: var(--td-brand-color);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  transform: translateY(-2px);
}

.folder-card.selected {
  border-color: var(--td-brand-color);
  background: var(--td-brand-color-focus);
}

.folder-checkbox {
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

.folder-card:hover .folder-checkbox,
.folder-card.selected .folder-checkbox {
  opacity: 1;
}

/* 触屏设备（无 hover 能力）常驻显示规则已抽到全局 assets/styles.css（G13-08） */

.folder-preview {
  width: 100%;
  aspect-ratio: 1.4 / 1;
  background: linear-gradient(135deg, var(--td-warning-color-1) 0%, var(--td-bg-color-secondarycontainer) 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.folder-icon-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.folder-icon {
  font-size: 64px;
  color: var(--td-warning-color);
}

.folder-count {
  position: absolute;
  bottom: -4px;
  right: -8px;
  background: var(--td-bg-color-container);
  color: var(--td-text-color-primary);
  border-radius: 10px;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--td-warning-color);
  font-weight: 600;
}

.folder-info {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.folder-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--td-text-color-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.4;
}

.folder-meta {
  font-size: 11px;
  color: var(--td-text-color-secondary);
  display: flex;
  align-items: center;
  gap: 4px;
}

.meta-divider {
  color: var(--td-text-color-placeholder);
}

.folder-actions-overlay {
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

.folder-card:hover .folder-actions-overlay {
  opacity: 1;
}
</style>
