<template>
  <div class="fl-addressbar">
    <nav class="fl-path" aria-label="当前位置">
      <button
        type="button"
        class="fl-path-item"
        :class="{ 'is-current': currentFolderId === null, 'drag-over': dragOverFolderId === rootDropTarget }"
        @click="emit('navigate', null)"
        @dragover.prevent="emit('folder-drag-over', $event, rootDropTarget)"
        @dragenter.prevent="emit('folder-drag-over', $event, rootDropTarget)"
        @dragleave="emit('folder-drag-leave', $event, rootDropTarget)"
        @drop.prevent.stop="emit('drop-on-folder', $event, rootDropTarget)"
      >
        <t-icon name="home" class="fl-path-home" />
        我的文件
      </button>
      <template v-for="(folder, idx) in breadcrumb" :key="folder.id">
        <t-icon name="chevron-right" class="fl-path-sep" />
        <button
          type="button"
          class="fl-path-item"
          :class="{ 'is-current': idx === breadcrumb.length - 1 }"
          :title="folder.name"
          :aria-current="idx === breadcrumb.length - 1 ? 'page' : undefined"
          @click="emit('navigate', folder.id)"
        >
          {{ folder.name }}
        </button>
      </template>
    </nav>
    <div class="fl-addressbar-actions">
      <t-button theme="default" variant="outline" @click="emit('create-folder')">
        <template #icon><t-icon name="folder-add" /></template>
        新建文件夹
      </t-button>
      <t-button theme="primary" @click="emit('upload')">
        <template #icon><t-icon name="upload" /></template>
        上传文件
      </t-button>
    </div>
  </div>

  <button
    v-if="showMobileBack"
    type="button"
    class="fl-mobile-back"
    @click="emit('navigate', parentFolderId)"
  >
    <t-icon name="chevron-left" />
    返回上级
  </button>
</template>

<script setup lang="ts">
/**
 * 文件列表地址栏（M6 拆分：从 FileList.vue 拆出）。
 *
 * 纯展示组件：只负责路径面包屑、根目录放置区与「新建文件夹 / 上传」入口的呈现，
 * 所有导航与拖放行为均以事件回传宿主（拖放目标标识 rootDropTarget 由宿主注入，
 * 保持 ROOT_DROP_TARGET 常量仍是宿主的唯一来源）。
 *
 * 移动端「返回上级」按钮与地址栏同级（拆分前即为兄弟节点），故本组件为多根节点，
 * 渲染位置与 DOM 顺序与拆分前一致。
 */
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
}>(), {
  currentFolderId: null,
  breadcrumb: () => [],
  dragOverFolderId: null,
  showMobileBack: false,
  parentFolderId: null,
});

const emit = defineEmits<{
  navigate: [folderId: string | null];
  'create-folder': [];
  upload: [];
  'folder-drag-over': [event: DragEvent, folderId: string];
  'folder-drag-leave': [event: DragEvent, folderId: string];
  'drop-on-folder': [event: DragEvent, folderId: string];
}>();
</script>

<style scoped>
/* ============ 地址栏（文件路径） ============ */
.fl-addressbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 10px 14px;
  margin-bottom: 16px;
}

.fl-path {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  min-width: 0;
  font-size: 14px;
}

.fl-path-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* G11-08：面包屑改为可聚焦按钮，重置原生 button 样式 */
  background: none;
  border: none;
  font: inherit;
  text-align: left;
  transition: background var(--duration-fast), color var(--duration-fast);
}
.fl-path-item:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.fl-path-item:hover {
  background: var(--color-accent-soft);
  color: var(--text-primary);
}

.fl-path-item.is-current {
  color: var(--text-primary);
  font-weight: 500;
  cursor: default;
}

.fl-path-item.is-current:hover {
  background: transparent;
}

.fl-path-home {
  font-size: 15px;
  color: var(--color-accent);
}

.fl-path-sep {
  color: var(--text-tertiary);
  font-size: 14px;
  flex-shrink: 0;
}

.fl-addressbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

/* 拖放高亮：拆分前定义在宿主样式块内，随地址栏一并迁移 */
.fl-path-item.drag-over {
  background: var(--color-accent-soft);
  color: var(--color-accent);
  outline: 1px dashed var(--color-accent);
}

@media (max-width: 768px) {
  .fl-addressbar {
    padding: 8px 10px;
  }

  .fl-path-item {
    max-width: 140px;
  }

  .fl-mobile-back {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: -4px 0 12px;
    padding: 4px 0;
    border: 0;
    background: transparent;
    color: var(--text-secondary);
    font: inherit;
    cursor: pointer;
  }

  .fl-mobile-back:hover {
    color: var(--color-accent);
  }
}
</style>
