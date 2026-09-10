<template>
  <!-- 表头 -->
  <div class="os-row os-head">
    <div class="os-cell os-check">
      <t-checkbox
        :checked="isAllSelected"
        :indeterminate="isIndeterminate"
        :disabled="busy"
        aria-label="全选当前已加载的可操作文件"
        @change="emit('toggle-select-all')"
      />
    </div>
    <div class="os-cell os-name os-sortable">
      <button
        type="button"
        class="os-sort-btn"
        role="columnheader"
        :aria-sort="sortBy === 'originalName' ? (sortOrder === 'ASC' ? 'ascending' : 'descending') : 'none'"
        @click="emit('toggle-sort', 'originalName')"
        @keydown.enter.prevent="emit('toggle-sort', 'originalName')"
        @keydown.space.prevent="emit('toggle-sort', 'originalName')"
      >
        名称
        <t-icon
          :name="sortBy === 'originalName' ? (sortOrder === 'DESC' ? 'caret-down-small' : 'caret-up-small') : 'view-list'"
          class="os-sort-icon"
          :class="{ active: sortBy === 'originalName' }"
        />
      </button>
    </div>
    <div class="os-cell os-size">大小</div>
    <div class="os-cell os-date os-sortable">
      <button
        type="button"
        class="os-sort-btn"
        role="columnheader"
        :aria-sort="sortBy === 'createdAt' ? (sortOrder === 'ASC' ? 'ascending' : 'descending') : 'none'"
        @click="emit('toggle-sort', 'createdAt')"
        @keydown.enter.prevent="emit('toggle-sort', 'createdAt')"
        @keydown.space.prevent="emit('toggle-sort', 'createdAt')"
      >
        上传时间
        <t-icon
          :name="sortBy === 'createdAt' ? (sortOrder === 'DESC' ? 'caret-down-small' : 'caret-up-small') : 'view-list'"
          class="os-sort-icon"
          :class="{ active: sortBy === 'createdAt' }"
        />
      </button>
    </div>
  </div>

  <!-- 文件夹行（OS 风格，双击进入；R9：支持键盘 Tab + Enter/Space 进入） -->
  <div
    v-for="folder in subfolders"
    :key="`folder-${folder.id}`"
    class="os-row os-folder"
    :class="{ 'drag-over': dragOverFolderId === folder.id }"
    role="button"
    tabindex="0"
    :aria-label="`打开文件夹 ${folder.name}`"
    @dblclick="emit('folder-open', folder)"
    @keydown.enter.self.prevent="emit('folder-open', folder)"
    @keydown.space.self.prevent="emit('folder-open', folder)"
    @contextmenu.prevent.stop="emit('folder-ctxmenu', $event, folder)"
    @touchstart="emit('touch-start', $event, 'folder', folder)"
    @touchmove="emit('touch-move', $event)"
    @touchend="emit('touch-end', $event)"
    @dragover.prevent="emit('folder-drag-over', $event, folder.id)"
    @dragenter.prevent="emit('folder-drag-over', $event, folder.id)"
    @dragleave="emit('folder-drag-leave', $event, folder.id)"
    @drop.prevent.stop="emit('drop-on-folder', $event, folder.id)"
  >
    <div class="os-cell os-check"></div>
    <div class="os-cell os-name" :title="folder.name">
      <t-icon name="folder" class="os-folder-icon" />
      <span class="os-name-text">{{ folder.name }}</span>
      <t-tag size="small" theme="warning" variant="light" class="os-kind-tag">文件夹</t-tag>
    </div>
    <div class="os-cell os-size os-muted">{{ folder.children?.length ? `${folder.children.length} 项` : '—' }}</div>
    <div class="os-cell os-date os-muted">{{ formatDate(folder.createdAt) }}</div>
  </div>

  <!-- 文件行 -->
  <div
    v-for="file in files"
    :key="file.id"
    class="os-row os-file"
    :class="[getFileRowClassName(file), { dragging: draggingFileIds.includes(file.id) }]"
    :draggable="isFileActionable(file)"
    :tabindex="isFileActionable(file) ? 0 : -1"
    :role="isFileActionable(file) ? 'button' : undefined"
    :aria-label="isFileActionable(file) ? `下载 ${file.originalName}` : undefined"
    @dragstart="emit('file-drag-start', $event, file)"
    @dragend="emit('file-drag-end')"
    @contextmenu.prevent.stop="emit('file-ctxmenu', $event, file)"
    @touchstart="emit('touch-start', $event, 'file', file)"
    @touchmove="emit('touch-move', $event)"
    @touchend="emit('touch-end', $event)"
    @dblclick="isFileActionable(file) && emit('download', file)"
    @keydown.enter.self.prevent="isFileActionable(file) && emit('download', file)"
  >
    <div class="os-cell os-check">
      <t-checkbox
        v-if="!file.isDeleted && file.status !== 'processing'"
        :checked="selectedIds.includes(file.id)"
        @change="emit('file-select', file)"
      />
    </div>
    <div class="os-cell os-name">
      <span
        v-if="canPreviewFile(file)"
        class="os-thumb-click"
        :title="'点击预览 ' + file.originalName"
        role="button"
        tabindex="0"
        :aria-label="`预览 ${file.originalName}`"
        @click.stop="emit('preview', file)"
        @keydown.enter.prevent="emit('preview', file)"
        @keydown.space.prevent="emit('preview', file)"
      >
        <ThumbnailImg :file-id="file.id" :mime-type="file.mimeType" :size="32" :file-name="file.originalName" :context="thumbnailContext" :version="file.uploadVersion" />
      </span>
      <ThumbnailImg v-else :file-id="file.id" :mime-type="file.mimeType" :size="32" :file-name="file.originalName" :context="thumbnailContext" :version="file.uploadVersion" />
      <div class="os-name-block">
        <span class="os-name-text" :class="{ 'deleted-name': file.isDeleted }" :title="file.originalName">
          {{ file.originalName }}
        </span>
        <div class="os-name-sub">
          <t-tag v-if="file.status === 'error'" theme="danger" size="small">上传失败</t-tag>
          <t-tag v-else-if="file.status === 'processing'" theme="primary" size="small">处理中</t-tag>
          <t-tag v-else-if="file.isDeleted && file.deletedByAdmin" theme="danger" size="small">被管理员删除</t-tag>
          <t-tag v-else-if="file.isDeleted" theme="warning" size="small">删除中</t-tag>
          <span
            v-for="tag in file.tags"
            :key="tag.id"
            class="os-tag-click"
            role="button"
            tabindex="0"
            :aria-label="`按标签 ${tag.name} 筛选`"
            @click.stop="emit('tag-filter', tag.id)"
            @keydown.enter.prevent="emit('tag-filter', tag.id)"
            @keydown.space.prevent="emit('tag-filter', tag.id)"
          >
            <t-tag
              size="small"
              variant="light"
              :style="{ background: tag.color + '20', color: tag.color, borderColor: tag.color + '40' }"
            >
              {{ tag.name }}
            </t-tag>
          </span>
        </div>
      </div>
    </div>
    <div class="os-cell os-size os-mono">{{ formatSize(file.size) }}</div>
    <div class="os-cell os-date">
      <div>{{ formatDate(file.createdAt) }}</div>
      <div v-if="file.isDeleted && file.deleteRequestedAt" class="os-deleted-date">
        删除于 {{ formatDate(file.deleteRequestedAt) }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 文件列表桌面端行视图（M6 拆分：从 FileList.vue 拆出）。
 *
 * 纯展示组件（多根节点：表头 + 文件夹行 + 文件行），渲染在宿主的
 * `.os-list-inner` 内，与拆分前的 DOM 层级一致：
 *
 *   .os-list-scroll > .os-list-inner > [ 本组件行内容 ] [ 无限滚动哨兵 ]
 *
 * 无限滚动哨兵**刻意留在宿主**：`scrollSentinel` 是宿主从 useFileListQuery
 * 拿到的模板 ref（IntersectionObserver 观察目标），放入子组件需要额外的
 * 引用转接，收益为零而风险更高。
 *
 * 关于 `isMobile`：拆分前桌面行使用 `!isMobile && isFileActionable(file)`，
 * 而本组件仅在 `!isMobile` 分支渲染，故该条件恒为真，已直接省略（语义等价）。
 *
 * 行判定统一走 utils/file-row-predicates，与移动端列表共用。
 */
import { formatDate, formatSize } from '@/utils/format';
import ThumbnailImg from '../../components/ThumbnailImg.vue';
import { canPreviewFile, getFileRowClassName, isFileActionable } from '../../utils/file-row-predicates';
import type { FileItem } from '../../types/file';
import type { Folder } from '../../stores/folders';

withDefaults(defineProps<{
  /** 当前目录下的子文件夹 */
  subfolders: Folder[];
  /** 当前展示的文件（含已删除/处理中项） */
  files: FileItem[];
  /** 已选文件 ID */
  selectedIds: string[];
  /** 是否已全选 */
  isAllSelected: boolean;
  /** 是否半选 */
  isIndeterminate: boolean;
  /** 批量操作进行中（禁用全选） */
  busy: boolean;
  /** 当前排序列 */
  sortBy: string;
  /** 当前排序方向（ASC / DESC） */
  sortOrder: string;
  /** 拖拽悬停的目标文件夹 ID（用于行高亮） */
  dragOverFolderId: string | null;
  /** 正在被拖动的文件 ID（用于行半透明反馈） */
  draggingFileIds: string[];
  /** 缩略图访问上下文 */
  thumbnailContext: string;
}>(), {
  subfolders: () => [],
  files: () => [],
  selectedIds: () => [],
  isAllSelected: false,
  isIndeterminate: false,
  busy: false,
  sortBy: 'createdAt',
  sortOrder: 'DESC',
  dragOverFolderId: null,
  draggingFileIds: () => [],
  thumbnailContext: '',
});

const emit = defineEmits<{
  'toggle-sort': [field: string];
  'toggle-select-all': [];
  'file-select': [file: FileItem];
  'folder-open': [folder: Folder];
  'folder-ctxmenu': [event: MouseEvent, folder: Folder];
  'file-ctxmenu': [event: MouseEvent, file: FileItem];
  'touch-start': [event: TouchEvent, kind: 'file' | 'folder', item: FileItem | Folder];
  'touch-move': [event: TouchEvent];
  'touch-end': [event: TouchEvent];
  'folder-drag-over': [event: DragEvent, folderId: string];
  'folder-drag-leave': [event: DragEvent, folderId: string];
  'drop-on-folder': [event: DragEvent, folderId: string];
  'file-drag-start': [event: DragEvent, file: FileItem];
  'file-drag-end': [];
  download: [file: FileItem];
  preview: [file: FileItem];
  'tag-filter': [tagId: string];
}>();
</script>

<style scoped src="./file-list-shared.css"></style>

<style scoped>
.os-row {
  display: grid;
  content-visibility: auto;
  contain-intrinsic-size: 48px;
  grid-template-columns:
    44px
    minmax(240px, 1fr)
    96px
    150px;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  min-height: 52px;
  border-bottom: 1px solid var(--border-default);
  transition: background var(--duration-fast);
}

.os-row:last-child {
  border-bottom: none;
}

/* 表头 */
.os-head {
  min-height: 44px;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--border-strong);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-tertiary);
}

.os-sortable {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  user-select: none;
  transition: color var(--duration-fast);
}

.os-sortable:hover {
  color: var(--text-primary);
}

/* G11-07：排序表头改为可聚焦按钮，重置原生 button 样式并保持原有视觉 */
.os-sort-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  user-select: none;
}
.os-sort-btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
  border-radius: 4px;
}

.os-sort-icon {
  font-size: 14px;
  opacity: 0.35;
}

.os-sort-icon.active {
  opacity: 1;
  color: var(--color-accent);
}

/* 行 hover */
.os-folder,
.os-file {
  cursor: default;
}

.os-folder:hover,
.os-file:hover {
  background: var(--color-bg-hover);
}

.os-folder {
  cursor: pointer;
}

/* ============ 拖拽移动视觉反馈 ============ */
/* 正在被拖动的文件行：半透明 + 虚线轮廓 */
.os-file.dragging {
  opacity: 0.4;
  outline: 1px dashed var(--color-accent);
  outline-offset: -1px;
}
/* 拖拽悬停的文件夹行：高亮提示可放置 */
.os-folder.drag-over {
  background: var(--color-accent-soft) !important;
  outline: 2px dashed var(--color-accent);
  outline-offset: -2px;
}
/* 可拖动的文件行使用抓取光标提示 */
.os-file[draggable='true'] {
  cursor: grab;
}
.os-file[draggable='true']:active {
  cursor: grabbing;
}

/* 单元格 */
.os-cell {
  min-width: 0;
}

.os-name {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.os-folder-icon {
  font-size: 22px;
  color: var(--color-warning);
  flex-shrink: 0;
}

.os-name-block {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.os-name-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 450;
}

.os-name-sub {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.os-kind-tag {
  flex-shrink: 0;
}

.os-tag-click {
  cursor: pointer;
  display: inline-flex;
}

.os-mono {
  font-family: var(--font-mono);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.os-processing-hint {
  font-size: 12px;
}

.os-deleted-date {
  font-size: 11px;
  color: var(--color-warning);
  margin-top: 2px;
}

/* 行状态 */
.os-file.row-deleted {
  background: var(--color-bg-elevated);
  opacity: 0.85;
}

.os-file.row-processing {
  background: var(--color-accent-soft);
  opacity: 0.9;
}

/* 桌面端缩略图可点击预览 */
.os-thumb-click {
  display: inline-flex;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: opacity var(--duration-fast);
}
.os-thumb-click:hover {
  opacity: 0.8;
}

/* R9：键盘焦点可见性 —— 仅 :focus-visible 生效，不影响鼠标点击体验 */
.os-row:focus-visible {
  outline: 2px solid var(--color-accent, var(--td-brand-color, #4d7cfe));
  outline-offset: -2px;
  border-radius: var(--radius-sm);
}
.os-thumb-click:focus-visible,
.os-tag-click:focus-visible {
  outline: 2px solid var(--color-accent, var(--td-brand-color, #4d7cfe));
  outline-offset: 1px;
}
</style>
