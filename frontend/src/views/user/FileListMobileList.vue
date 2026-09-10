<template>
  <div class="os-mobile">
    <div v-if="selectableCount > 0" class="mobile-selection-toolbar">
      <t-checkbox
        :checked="isAllSelected"
        :indeterminate="isIndeterminate"
        :disabled="busy"
        @change="emit('toggle-select-all')"
      >
        全选当前已加载的 {{ selectableCount }} 个可操作文件
      </t-checkbox>
      <span v-if="selectedIds.length > 0" class="mobile-selection-count">已选 {{ selectedIds.length }} 项</span>
    </div>
    <div
      v-for="folder in subfolders"
      :key="`m-folder-${folder.id}`"
      class="mobile-folder-row"
      @click="emit('folder-click', folder)"
      @contextmenu.prevent.stop="emit('folder-ctxmenu', $event, folder)"
      @touchstart="emit('touch-start', $event, 'folder', folder)"
      @touchmove="emit('touch-move', $event)"
      @touchend="emit('touch-end', $event)"
    >
      <t-icon name="folder" class="os-folder-icon" />
      <div class="mobile-folder-info">
        <div class="mobile-folder-name">{{ folder.name }}</div>
        <div class="mobile-folder-meta">文件夹 · {{ formatDate(folder.createdAt) }}</div>
      </div>
      <t-icon name="chevron-right" class="mobile-folder-arrow" />
    </div>

    <div
      v-for="file in files"
      :key="`m-file-${file.id}`"
      class="mobile-file-card"
      @contextmenu.prevent.stop="emit('file-ctxmenu', $event, file)"
      @touchstart="emit('touch-start', $event, 'file', file)"
      @touchmove="emit('touch-move', $event)"
      @touchend="emit('touch-end', $event)"
    >
      <div class="mobile-file-card-header">
        <t-checkbox
          v-if="isFileActionable(file)"
          class="mobile-file-select"
          :checked="selectedIds.includes(file.id)"
          :disabled="busy"
          :aria-label="`选择 ${file.originalName}`"
          @change="emit('file-select', file)"
          @click.stop
        />
        <ThumbnailImg :file-id="file.id" :mime-type="file.mimeType" :size="40" :file-name="file.originalName" :context="thumbnailContext" :version="file.uploadVersion" />
        <div class="mobile-file-main">
          <div class="mobile-file-name" :class="{ 'deleted-name': file.isDeleted }">{{ file.originalName }}</div>
          <div class="mobile-file-meta">{{ formatSize(file.size) }} · {{ formatDate(file.createdAt) }}</div>
          <div class="mobile-file-tags">
            <t-tag v-if="file.isDeleted && file.deletedByAdmin" theme="danger" size="small">被管理员删除</t-tag>
            <t-tag v-else-if="file.isDeleted" theme="warning" size="small">删除中</t-tag>
            <t-tag v-else-if="file.accessType === 'public'" theme="success" size="small">公开</t-tag>
            <t-tag v-else theme="default" size="small">私有</t-tag>
            <t-tag v-if="file.hasPassword" theme="warning" size="small">已加密</t-tag>
            <span
              v-for="tag in file.tags?.slice(0, 2)"
              :key="tag.id"
              class="os-tag-click"
              @click.stop="emit('tag-filter', tag.id)"
            >
              <t-tag
                size="small"
                variant="light"
                :style="{ background: tag.color + '18', color: tag.color, borderColor: tag.color + '33' }"
              >
                {{ tag.name }}
              </t-tag>
            </span>
            <span v-if="file.tags && file.tags.length > 2" class="mobile-tag-more">+{{ file.tags.length - 2 }}</span>
          </div>
        </div>
      </div>
      <div v-if="!file.isDeleted" class="mobile-file-card-actions">
        <t-button size="small" theme="primary" variant="text" @click="emit('copy-link', file)">复制</t-button>
        <t-button v-if="canPreviewFile(file)" size="small" variant="text" @click="emit('preview', file)">预览</t-button>
        <t-button size="small" variant="text" @click="emit('download', file)">下载</t-button>
        <t-button size="small" variant="text" @click="emit('tag-editor', file)">标签</t-button>
        <t-button size="small" theme="danger" variant="text" @click="emit('delete', file)">删除</t-button>
      </div>
      <div v-else class="mobile-file-card-actions">
        <t-button
          size="small"
          theme="success"
          variant="text"
          :disabled="file.deletedByAdmin && !isAdmin"
          @click="emit('restore', file.id)"
        >
          恢复
        </t-button>
        <t-button v-if="isAdmin" size="small" theme="danger" variant="text" @click="emit('force-delete', file.id)">
          强制删除
        </t-button>
        <t-button
          v-else-if="!file.deletedByAdmin && file.deleteRequestedAt && selfForceDeleteReady(file)"
          size="small"
          theme="danger"
          variant="text"
          @click="emit('force-delete', file.id)"
        >
          永久删除
        </t-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 文件列表移动端视图（M6 拆分：从 FileList.vue 拆出）。
 *
 * 纯展示组件：文件夹行 + 文件卡片。所有行为（进入目录、长按菜单、选择、
 * 预览/下载/标签/删除/恢复）均以事件回传给宿主。
 *
 * 注意两处刻意的语义保留：
 * - 文件夹行的 click 只回传 `folder-click`，由宿主执行 `consumeLongPressClick()`
 *   判定是否抑制（长按弹出菜单后不应再导航）；若在组件内判断会丢失该状态。
 * - 行判定（isFileActionable / canPreviewFile / selfForceDeleteReady）统一走
 *   utils/file-row-predicates，与桌面列表共用，避免两处逻辑漂移。
 */
import { formatDate, formatSize } from '@/utils/format';
import ThumbnailImg from '../../components/ThumbnailImg.vue';
import { canPreviewFile, isFileActionable, selfForceDeleteReady } from '../../utils/file-row-predicates';
import type { FileItem } from '../../types/file';
import type { Folder } from '../../stores/folders';

withDefaults(defineProps<{
  /** 当前目录下的子文件夹 */
  subfolders: Folder[];
  /** 当前展示的文件（含已删除项，按状态渲染） */
  files: FileItem[];
  /** 可被选中的文件数量（宿主依据 isFileActionable 派生） */
  selectableCount: number;
  /** 已选文件 ID */
  selectedIds: string[];
  /** 是否已全选 */
  isAllSelected: boolean;
  /** 是否半选 */
  isIndeterminate: boolean;
  /** 批量操作进行中（禁用选择） */
  busy: boolean;
  /** 当前用户是否管理员 */
  isAdmin: boolean;
  /** 缩略图访问上下文 */
  thumbnailContext: string;
}>(), {
  subfolders: () => [],
  files: () => [],
  selectableCount: 0,
  selectedIds: () => [],
  isAllSelected: false,
  isIndeterminate: false,
  busy: false,
  isAdmin: false,
  thumbnailContext: '',
});

const emit = defineEmits<{
  'toggle-select-all': [];
  'folder-click': [folder: Folder];
  'folder-ctxmenu': [event: MouseEvent, folder: Folder];
  'file-ctxmenu': [event: MouseEvent, file: FileItem];
  'touch-start': [event: TouchEvent, kind: 'file' | 'folder', item: FileItem | Folder];
  'touch-move': [event: TouchEvent];
  'touch-end': [event: TouchEvent];
  'file-select': [file: FileItem];
  'tag-filter': [tagId: string];
  'copy-link': [file: FileItem];
  preview: [file: FileItem];
  download: [file: FileItem];
  'tag-editor': [file: FileItem];
  delete: [file: FileItem];
  restore: [fileId: string];
  'force-delete': [fileId: string];
}>();
</script>

<style scoped src="./file-list-shared.css"></style>

<style scoped>
/* ============ 移动端 ============ */
.os-mobile {
  padding: 12px;
}

.mobile-folder-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-default);
  margin-bottom: 10px;
  cursor: pointer;
  transition: border-color var(--duration-fast);
}

.mobile-folder-row:hover {
  border-color: var(--border-accent);
}

.mobile-folder-info {
  flex: 1;
  min-width: 0;
}

.mobile-folder-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mobile-folder-meta {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.mobile-folder-arrow {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.mobile-file-card {
  content-visibility: auto;
  contain-intrinsic-size: 132px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 14px;
  margin-bottom: 10px;
  transition: border-color var(--duration-fast);
}

.mobile-file-card:hover {
  border-color: var(--border-accent);
}

.mobile-selection-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 2px 12px;
  color: var(--text-secondary);
}

.mobile-selection-count {
  color: var(--color-accent);
  font-size: 12px;
  font-weight: 600;
}

.mobile-file-card-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 10px;
}

.mobile-file-select {
  flex-shrink: 0;
  margin-top: 4px;
}

.mobile-file-main {
  flex: 1;
  min-width: 0;
}

.mobile-file-name {
  font-weight: 500;
  word-break: break-all;
  line-height: 1.4;
  font-size: 14px;
}

.mobile-file-meta {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.mobile-file-tags {
  display: flex;
  gap: 4px;
  margin-top: 4px;
  flex-wrap: wrap;
}

.mobile-tag-more {
  font-size: 11px;
  color: var(--text-secondary);
}

.mobile-file-card-actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  border-top: 1px solid var(--border-default);
  padding-top: 8px;
}
</style>
