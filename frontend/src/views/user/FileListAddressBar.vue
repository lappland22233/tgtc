<template>
  <div class="fl-addressbar">
    <div class="fl-path-row">
      <button
        v-if="showDirectoryButton"
        type="button"
        class="fl-directory-toggle"
        aria-controls="file-workspace-directory"
        :aria-expanded="directoryOpen"
        @click="emit('open-directory')"
      >
        <t-icon name="view-list" aria-hidden="true" />
        目录
      </button>
      <button
        v-if="showMobileBack"
        type="button"
        class="fl-mobile-back"
        @click="emit('navigate', parentFolderId)"
      >
        <t-icon name="chevron-left" aria-hidden="true" />
        返回上级
      </button>
      <nav class="fl-path" aria-label="当前位置">
        <button
          type="button"
          class="fl-path-item"
          :class="{ 'is-current': currentFolderId === null, 'drag-over': dragOverFolderId === rootDropTarget }"
          :aria-current="currentFolderId === null ? 'page' : undefined"
          @click="emit('navigate', null)"
          @dragover.prevent="emit('folder-drag-over', $event, rootDropTarget)"
          @dragenter.prevent="emit('folder-drag-over', $event, rootDropTarget)"
          @dragleave="emit('folder-drag-leave', $event, rootDropTarget)"
          @drop.prevent.stop="emit('drop-on-folder', $event, rootDropTarget)"
        >
          <t-icon name="home" class="fl-path-home" aria-hidden="true" />
          我的文件
        </button>
        <template v-for="(folder, idx) in breadcrumb" :key="folder.id">
          <t-icon name="chevron-right" class="fl-path-sep" aria-hidden="true" />
          <button
            type="button"
            class="fl-path-item"
            :class="{ 'is-current': idx === breadcrumb.length - 1 }"
            :title="folder.name"
            :aria-current="idx === breadcrumb.length - 1 ? 'page' : undefined"
            @click="emit('navigate', folder.id)"
          >
            <span>{{ folder.name }}</span>
          </button>
        </template>
      </nav>
    </div>
    <div class="fl-folder-heading">
      <div class="fl-folder-title">
        <h1>{{ folderName }}</h1>
        <p v-if="folderCount !== undefined && fileCount !== undefined" class="fl-folder-count">
          {{ folderCount }} 个文件夹 · {{ fileCount }} 个文件
        </p>
      </div>
      <div class="fl-addressbar-actions">
        <t-button
          class="fl-new-folder"
          theme="default"
          variant="outline"
          aria-label="新建文件夹"
          title="新建文件夹"
          @click="emit('create-folder')"
        >
          <template #icon><t-icon name="folder-add" aria-hidden="true" /></template>
        </t-button>
        <t-button class="fl-upload" theme="primary" @click="emit('upload')">
          <template #icon><t-icon name="upload" aria-hidden="true" /></template>
          上传文件
        </t-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Folder } from '../../stores/folders';

withDefaults(defineProps<{
  /** 当前打开的文件夹 ID；null 表示根目录 */
  currentFolderId: string | null;
  /** 根到当前文件夹的路径 */
  breadcrumb: Folder[];
  /** 当前悬停的放置目标文件夹 ID（用于高亮） */
  dragOverFolderId: string | null;
  /** 宿主的根目录放置标记（ROOT_DROP_TARGET） */
  rootDropTarget: string;
  /** 是否展示移动端「返回上级」 */
  showMobileBack: boolean;
  /** 当前文件夹的父级 ID（可能为 null，表示回到根） */
  parentFolderId: string | null;
  folderName?: string;
  folderCount?: number;
  fileCount?: number;
  showDirectoryButton?: boolean;
  directoryOpen?: boolean;
}>(), {
  currentFolderId: null,
  breadcrumb: () => [],
  dragOverFolderId: null,
  showMobileBack: false,
  parentFolderId: null,
  folderName: '我的文件',
  showDirectoryButton: false,
  directoryOpen: false,
});

const emit = defineEmits<{
  navigate: [folderId: string | null];
  'create-folder': [];
  'open-directory': [];
  upload: [];
  'folder-drag-over': [event: DragEvent, folderId: string];
  'folder-drag-leave': [event: DragEvent, folderId: string];
  'drop-on-folder': [event: DragEvent, folderId: string];
}>();
</script>

<style scoped>
.fl-addressbar {
  min-width: 0;
  margin-bottom: 18px;
}

:deep(:is(.fl-path-row, .fl-path, .fl-addressbar-actions)) {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.fl-path {
  flex-wrap: wrap;
  color: var(--workspace-muted);
  font-size: 12px;
}

.fl-path-row :where(.fl-path-item, .fl-directory-toggle, .fl-mobile-back) {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 0;
  background: transparent;
  color: var(--workspace-muted);
  font: inherit;
  cursor: pointer;
}

.fl-path-item {
  max-width: min(220px, 100%);
  min-height: 28px;
  padding: 4px 6px;
  border-radius: 6px;
  overflow: hidden;
  white-space: nowrap;
}

.fl-path-item > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fl-path-item.is-current {
  color: var(--workspace-text);
  font-weight: 560;
}

.fl-path-row :is(.fl-path-item, .fl-directory-toggle, .fl-mobile-back):hover {
  color: var(--workspace-accent);
  background: var(--workspace-selected);
}

.fl-path-item.drag-over {
  color: var(--workspace-accent);
  background: var(--workspace-selected);
  outline: 1px dashed var(--workspace-accent);
}

.fl-path :is(.fl-path-home, .fl-path-sep) {
  flex: none;
  font-size: 14px;
}

.fl-folder-heading {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 10px 16px;
  flex-wrap: wrap;
  margin-top: 5px;
}

.fl-folder-title {
  flex: 1 1 12rem;
  min-width: 0;
}

.fl-folder-title h1 {
  margin: 0;
  font-size: clamp(24px, 3.2vw, 34px);
  font-weight: 690;
  letter-spacing: -0.035em;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.fl-folder-count {
  margin: 4px 0 0;
  color: var(--workspace-muted);
  font-size: 12px;
}

.fl-addressbar-actions {
  flex: none;
  gap: 8px;
}

.fl-addressbar-actions > button {
  min-height: 36px;
  border-radius: 8px;
  font-weight: 560;
}

.fl-addressbar-actions .fl-new-folder {
  width: 36px;
  padding: 0;
  border-color: var(--workspace-border);
  background: var(--workspace-surface);
  color: var(--workspace-text);
}

.fl-addressbar-actions .fl-new-folder:hover {
  background: var(--workspace-selected);
  color: var(--workspace-accent);
}

.fl-addressbar-actions .fl-upload {
  background: var(--workspace-accent);
  color: var(--workspace-on-accent);
}

.fl-addressbar-actions .fl-upload:hover {
  background: color-mix(in srgb, var(--workspace-accent) 86%, var(--workspace-text));
}

.fl-path-row > :where(.fl-directory-toggle, .fl-mobile-back) {
  min-height: 36px;
  padding: 4px 8px;
  border-radius: 8px;
  flex: none;
  font-size: 13px;
  white-space: nowrap;
}

.fl-directory-toggle {
  border: 1px solid var(--workspace-border);
  color: var(--workspace-text);
}

.fl-directory-toggle[aria-expanded='true'] {
  background: var(--workspace-selected);
  color: var(--workspace-accent);
}

@media (max-width: 768px) {
  .fl-addressbar {
    margin-bottom: 14px;
  }

  .fl-path-row {
    flex-wrap: wrap;
  }

  .fl-path {
    flex-basis: 100%;
  }

  .fl-folder-title {
    flex-basis: 8rem;
  }

  .fl-path-item {
    max-width: min(150px, 100%);
    min-height: 44px;
  }

  .fl-path-row > button,
  .fl-addressbar-actions > button {
    min-height: 44px;
  }

  .fl-addressbar-actions .fl-new-folder {
    width: 44px;
  }
}
</style>
