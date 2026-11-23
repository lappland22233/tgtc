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
      role="button"
      tabindex="0"
      @keydown.enter.self.prevent="emit('folder-click', folder)"
      @keydown.space.self.prevent="emit('folder-click', folder)"
      @click="emit('folder-click', folder)"
      @contextmenu.prevent.stop="emit('folder-ctxmenu', $event, folder)"
      @touchstart="emit('touch-start', $event, 'folder', folder)"
      @touchmove="emit('touch-move', $event)"
      @touchend="emit('touch-end', $event)"
    >
      <span class="workspace-folder-icon" aria-hidden="true">
        <t-icon name="folder" />
      </span>
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
      :class="{ 'is-inspected': inspectedFileId === file.id }"
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
          <button
            type="button"
            class="mobile-file-name workspace-file-name"
            :class="{ 'deleted-name': file.isDeleted }"
            aria-controls="file-workspace-detail"
            :aria-expanded="inspectedFileId === file.id"
            :aria-label="`查看 ${file.originalName} 的详情`"
            @click.stop="emit('inspect', file)"
          >
            {{ file.originalName }}
          </button>
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
                class="workspace-file-tag"
                :style="{ '--file-tag-color': tag.color }"
              >
                {{ tag.name }}
              </t-tag>
            </span>
            <span v-if="file.tags && file.tags.length > 2" class="mobile-tag-more">+{{ file.tags.length - 2 }}</span>
          </div>
        </div>
        <button
          type="button"
          class="mobile-file-more"
          :aria-label="`${file.originalName} 的更多操作`"
          :aria-expanded="openedActionsId === file.id"
          @touchstart.stop
          @click.stop="openedActionsId = openedActionsId === file.id ? null : file.id"
        >
          <span aria-hidden="true">···</span>
        </button>
      </div>
      <template v-if="openedActionsId === file.id">
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
      </template>
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
import { ref } from 'vue';
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
  inspectedFileId?: string | null;
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
  inspectedFileId: null,
  isAllSelected: false,
  isIndeterminate: false,
  busy: false,
  isAdmin: false,
  thumbnailContext: '',
});

const openedActionsId = ref<string | null>(null);

const emit = defineEmits<{
  'toggle-select-all': [];
  'folder-click': [folder: Folder];
  'folder-ctxmenu': [event: MouseEvent, folder: Folder];
  'file-ctxmenu': [event: MouseEvent, file: FileItem];
  'touch-start': [event: TouchEvent, kind: 'file' | 'folder', item: FileItem | Folder];
  'touch-move': [event: TouchEvent];
  'touch-end': [event: TouchEvent];
  'file-select': [file: FileItem];
  inspect: [file: FileItem];
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

<style scoped>
.mobile-folder-row,
.mobile-file-card {
  border-bottom: 1px solid var(--workspace-border);
}

.mobile-folder-row {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 54px;
  padding: 6px;
  cursor: pointer;
}

.mobile-folder-row:hover,
.mobile-file-more:hover {
  background: var(--workspace-canvas);
}

.mobile-folder-info {
  flex: 1;
  min-width: 0;
}

.mobile-folder-info .mobile-folder-meta,
.mobile-file-main .mobile-file-meta {
  margin-top: 2px;
}

.mobile-folder-arrow {
  flex: none;
  color: var(--workspace-muted);
}

.mobile-file-card {
  content-visibility: auto;
  contain-intrinsic-size: auto 78px;
  padding: 5px 0 5px 6px;
}

.mobile-selection-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  padding-block: 2px;
  border-bottom: 1px solid var(--workspace-border);
  color: var(--workspace-muted);
  font-size: 12px;
}

.mobile-selection-toolbar :deep(.t-checkbox) {
  min-height: 44px;
}

.mobile-selection-count {
  flex: none;
  color: var(--workspace-accent);
  font-size: 12px;
  font-weight: 600;
}

.mobile-file-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mobile-file-select {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  flex: none;
  width: 44px;
  min-height: 44px;
}

.mobile-file-main {
  flex: 1;
  min-width: 0;
}

.mobile-file-name {
  width: 100%;
  min-height: 44px;
  margin-bottom: -7px;
  padding: 4px 0 10px;
}

.mobile-file-tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  margin-block: 4px 3px;
}

.mobile-tag-more {
  color: var(--workspace-muted);
  font-size: 11px;
}

.mobile-file-more {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 44px;
  min-height: 44px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--workspace-muted);
  font-size: 19px;
  letter-spacing: 0.04em;
  cursor: pointer;
}

.mobile-file-more[aria-expanded='true'] {
  background: var(--workspace-selected);
  color: var(--workspace-accent);
}

.mobile-file-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0 4px;
  margin-top: 5px;
  padding: 3px;
  border-top: 1px solid var(--workspace-border);
}

.mobile-file-card-actions :deep(.t-button.t-size-s) {
  min-inline-size: 44px;
  min-block-size: 44px;
}
</style>
