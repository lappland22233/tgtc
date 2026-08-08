<template>
  <div
    class="filelist-page"
    @dragenter="handlePageDragEnter"
    @dragover="handlePageDragOver"
    @dragleave="handlePageDragLeave"
    @drop="handlePageDrop"
  >
    <!-- 拖拽上传覆盖层 -->
    <div v-if="isDraggedOver" class="drop-overlay">
      <div class="drop-overlay-content">
        <t-icon name="upload" class="drop-overlay-icon" />
        <h2>释放文件以上传</h2>
      </div>
    </div>

    <!-- ① 地址栏：文件路径 + 新建文件夹 / 上传 -->
    <div class="fl-addressbar">
      <nav class="fl-path" aria-label="当前位置">
        <span
          class="fl-path-item"
          :class="{ 'is-current': folderStore.currentFolderId === null, 'drag-over': dragOverFolderId === ROOT_DROP_TARGET }"
          @click="onFolderNavigate(null)"
          @dragover.prevent="onFolderDragOver($event, ROOT_DROP_TARGET)"
          @dragenter.prevent="onFolderDragOver($event, ROOT_DROP_TARGET)"
          @dragleave="onFolderDragLeave($event, ROOT_DROP_TARGET)"
          @drop.prevent.stop="onDropOnFolder($event, ROOT_DROP_TARGET)"
        >
          <t-icon name="home" class="fl-path-home" />
          我的文件
        </span>
        <template v-for="(folder, idx) in folderStore.breadcrumb" :key="folder.id">
          <t-icon name="chevron-right" class="fl-path-sep" />
          <span
            class="fl-path-item"
            :class="{ 'is-current': idx === folderStore.breadcrumb.length - 1 }"
            :title="folder.name"
            @click="onFolderNavigate(folder.id)"
          >
            {{ folder.name }}
          </span>
        </template>
      </nav>
      <div class="fl-addressbar-actions">
        <t-button theme="default" variant="outline" @click="openCreateFolderDialog">
          <template #icon><t-icon name="folder-add" /></template>
          新建文件夹
        </t-button>
        <t-button theme="primary" @click="showUploadModal = true">
          <template #icon><t-icon name="upload" /></template>
          上传文件
        </t-button>
      </div>
    </div>

    <!-- ② 工具栏：搜索 + 标签 -->
    <div class="fl-toolbar">
      <form autocomplete="off" class="fl-search-form" @submit.prevent="handleSearch">
        <t-input
          v-model="search"
          placeholder="搜索当前文件夹..."
          class="fl-search-input"
          autocomplete="off"
          name="q-file-search"
          clearable
          @enter="handleSearch"
          @clear="handleClearSearch"
        >
          <template #prefix-icon><t-icon name="search" /></template>
        </t-input>
        <t-button theme="default" @click="handleSearch">搜索</t-button>
      </form>
      <div class="fl-toolbar-right">
        <t-button size="medium" variant="outline" @click="showTagManager = true">
          <template #icon><t-icon name="tag" /></template>
          {{ (tagStore.tags && tagStore.tags.length > 0) || selectedTagIds.length > 0 ? '标签筛选' : '管理标签' }}
        </t-button>
      </div>
    </div>

    <!-- ③ 批量操作栏：仅在选中文件时出现 -->
    <div v-if="selectedFileIds.length > 0" class="fl-batchbar">
      <span class="fl-batchbar-count">已选 {{ selectedFileIds.length }} 项</span>
      <t-button
        v-if="selectedImages.length > 0 && selectedImages.length === selectedFileIds.length"
        theme="primary"
        variant="outline"
        size="small"
        @click="convertToMarkdown"
      >
        批量 MK（{{ selectedImages.length }}）
      </t-button>
      <t-button
        v-if="!(selectedImages.length === selectedFileIds.length)"
        theme="default"
        variant="outline"
        size="small"
        @click="copyDownloadLinks"
      >
        复制下载链接
      </t-button>
      <t-button theme="default" variant="outline" size="small" @click="openBatchTagDialog">批量标签</t-button>
      <t-button theme="default" variant="outline" size="small" @click="openMoveDialogForFiles()">移动到...</t-button>
      <t-button theme="default" variant="text" size="small" @click="clearSelection">清除选择</t-button>
    </div>

    <!-- ④ 已选标签筛选 -->
    <div v-if="selectedTagIds.length > 0" class="fl-tagfilters">
      <t-tag
        v-for="tagId in selectedTagIds"
        :key="tagId"
        closable
        size="small"
        theme="primary"
        variant="light"
        @close="removeTagFilter(tagId)"
      >
        {{ getTagName(tagId) }}
      </t-tag>
      <t-button size="small" variant="text" @click="clearTagFilters">清除全部</t-button>
    </div>

    <!-- ⑤ Markdown 结果区域 -->
    <div v-if="markdownResult" class="fl-markdown">
      <div class="fl-markdown-head">
        <span class="fl-markdown-title">Markdown 结果</span>
        <div class="fl-markdown-actions">
          <t-button size="small" theme="primary" variant="outline" @click="copyMarkdown">复制</t-button>
          <t-button size="small" theme="default" variant="text" @click="markdownResult = ''">关闭</t-button>
        </div>
      </div>
      <t-input v-model="markdownResult" type="textarea" readonly :rows="6" autocomplete="off" />
    </div>

    <!-- ⑥ 空状态：当前文件夹下既无文件也无子文件夹 -->
    <div
      v-if="fileStore.files.length === 0 && subfoldersInCurrentFolder.length === 0 && !fileStore.loading && !cursorLoading"
      class="upload-zone"
      @click="!consumeLongPressClick() && (showUploadModal = true)"
      @contextmenu.prevent="openBlankCtxMenu"
      @touchstart="handleTouchStart($event, 'blank')"
      @touchmove="handleTouchMove"
      @touchend="handleTouchEnd"
    >
      <t-icon name="folder-add" class="empty-upload-icon" />
      <h3>拖拽文件到此处，或点击上传</h3>
      <p class="empty-upload-hint">支持图片、PDF、ZIP 等格式，单文件最大限制见系统配置</p>
    </div>

    <!-- ⑦ OS 风格统一列表：文件夹与文件混排（文件夹在前） -->
    <t-loading
      v-if="(fileStore.loading || cursorLoading) && displayFiles.length === 0 && subfoldersInCurrentFolder.length === 0"
      class="fl-loading"
    />
    <div
      v-else-if="displayFiles.length > 0 || subfoldersInCurrentFolder.length > 0"
      class="os-list card"
      @contextmenu.prevent="openBlankCtxMenu"
    >
      <!-- 桌面端：表格式列表 -->
      <div v-if="!isMobile" class="os-list-scroll">
        <div class="os-list-inner">
          <!-- 表头 -->
          <div class="os-row os-head">
            <div class="os-cell os-check">
              <t-checkbox
                :checked="isAllSelected"
                :indeterminate="isIndeterminate"
                @change="toggleSelectAll"
              />
            </div>
            <div class="os-cell os-name os-sortable" @click="toggleSort('originalName')">
              名称
              <t-icon
                :name="sortBy === 'originalName' ? (sortOrder === 'DESC' ? 'caret-down-small' : 'caret-up-small') : 'view-list'"
                class="os-sort-icon"
                :class="{ active: sortBy === 'originalName' }"
              />
            </div>
            <div class="os-cell os-size">大小</div>
            <div class="os-cell os-date os-sortable" @click="toggleSort('createdAt')">
              上传时间
              <t-icon
                :name="sortBy === 'createdAt' ? (sortOrder === 'DESC' ? 'caret-down-small' : 'caret-up-small') : 'view-list'"
                class="os-sort-icon"
                :class="{ active: sortBy === 'createdAt' }"
              />
            </div>
          </div>

          <!-- 文件夹行（OS 风格，双击进入） -->
          <div
            v-for="folder in subfoldersInCurrentFolder"
            :key="`folder-${folder.id}`"
            class="os-row os-folder"
            :class="{ 'drag-over': dragOverFolderId === folder.id }"
            @dblclick="onFolderOpen(folder)"
            @contextmenu.prevent.stop="openFolderCtxMenu($event, folder)"
            @touchstart="handleTouchStart($event, 'folder', folder)"
            @touchmove="handleTouchMove"
            @touchend="handleTouchEnd"
            @dragover.prevent="onFolderDragOver($event, folder.id)"
            @dragenter.prevent="onFolderDragOver($event, folder.id)"
            @dragleave="onFolderDragLeave($event, folder.id)"
            @drop.prevent.stop="onDropOnFolder($event, folder.id)"
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
            v-for="file in displayFiles"
            :key="file.id"
            class="os-row os-file"
            :class="[getRowClassName({ row: file }), { dragging: draggingFileIds.includes(file.id) }]"
            :draggable="!isMobile && isFileActionable(file)"
            @dragstart="onFileDragStart($event, file)"
            @dragend="onFileDragEnd"
            @contextmenu.prevent.stop="openFileCtxMenu($event, file)"
            @touchstart="handleTouchStart($event, 'file', file)"
            @touchmove="handleTouchMove"
            @touchend="handleTouchEnd"
            @dblclick="isFileActionable(file) && downloadFile(file)"
          >
            <div class="os-cell os-check">
              <t-checkbox
                v-if="!file.isDeleted && file.status !== 'processing'"
                :checked="selectedFileIds.includes(file.id)"
                @change="toggleFileSelect(file)"
              />
            </div>
            <div class="os-cell os-name">
              <span
                v-if="canPreviewFile(file)"
                class="os-thumb-click"
                :title="'点击预览 ' + file.originalName"
                @click.stop="openPreview(file)"
              >
                <ThumbnailImg :file-id="file.id" :mime-type="file.mimeType" :size="32" :file-name="file.originalName" />
              </span>
              <ThumbnailImg v-else :file-id="file.id" :mime-type="file.mimeType" :size="32" :file-name="file.originalName" />
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
                    @click.stop="addTagFilter(tag.id)"
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

          <!-- 无限滚动哨兵 -->
          <div ref="scrollSentinel" class="os-sentinel">
            <t-loading v-if="cursorLoading" size="small" text="加载中..." />
            <span v-else-if="!hasMore" class="os-muted">已加载全部 {{ fileStore.total }} 个文件</span>
          </div>
        </div>
      </div>

      <!-- 移动端：文件夹行 + 文件卡片 -->
      <div v-else class="os-mobile">
        <div
          v-for="folder in subfoldersInCurrentFolder"
          :key="`m-folder-${folder.id}`"
          class="mobile-folder-row"
          @click="!consumeLongPressClick() && onFolderOpen(folder)"
          @contextmenu.prevent.stop="openFolderCtxMenu($event, folder)"
          @touchstart="handleTouchStart($event, 'folder', folder)"
          @touchmove="handleTouchMove"
          @touchend="handleTouchEnd"
        >
          <t-icon name="folder" class="os-folder-icon" />
          <div class="mobile-folder-info">
            <div class="mobile-folder-name">{{ folder.name }}</div>
            <div class="mobile-folder-meta">文件夹 · {{ formatDate(folder.createdAt) }}</div>
          </div>
          <t-icon name="chevron-right" class="mobile-folder-arrow" />
        </div>

        <div
          v-for="file in displayFiles"
          :key="`m-file-${file.id}`"
          class="mobile-file-card"
          @contextmenu.prevent.stop="openFileCtxMenu($event, file)"
          @touchstart="handleTouchStart($event, 'file', file)"
          @touchmove="handleTouchMove"
          @touchend="handleTouchEnd"
        >
          <div class="mobile-file-card-header">
            <ThumbnailImg :file-id="file.id" :mime-type="file.mimeType" :size="40" :file-name="file.originalName" />
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
                  @click.stop="addTagFilter(tag.id)"
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
            <t-button size="small" theme="primary" variant="text" @click="copyLink(file)">复制</t-button>
            <t-button v-if="canPreviewFile(file)" size="small" variant="text" @click="openPreview(file)">预览</t-button>
            <t-button size="small" variant="text" @click="downloadFile(file)">下载</t-button>
            <t-button size="small" variant="text" @click="openTagEditor(file)">标签</t-button>
            <t-button size="small" theme="danger" variant="text" @click="handleDelete(file)">删除</t-button>
          </div>
          <div v-else class="mobile-file-card-actions">
            <t-button
              size="small"
              theme="success"
              variant="text"
              :disabled="file.deletedByAdmin && !isAdmin"
              @click="handleRestore(file.id)"
            >
              恢复
            </t-button>
            <t-button v-if="isAdmin" size="small" theme="danger" variant="text" @click="handleForceDelete(file.id)">
              强制删除
            </t-button>
          </div>
        </div>
      </div>
    </div>

    <!-- 上传弹窗 -->
    <UploadModal :visible="showUploadModal" :initial-files="dropFiles" :initial-drop-result="dropCollected" :folder-id="folderStore.currentFolderId" @close="handleUploadModalClose" @uploaded="onUploaded" />

    <!-- 标签管理弹窗 -->
    <TagManager v-model:visible="showTagManager" :selected-tag-ids="selectedTagIds" @filter="handleTagManagerFilter" />

    <!-- 文件标签编辑器 -->
    <FileTagEditor
      v-model:visible="tagEditorVisible"
      :file-id="tagEditorFileId"
      :file-tags="tagEditorFileTags"
      @saved="onTagSaved"
    />

    <!-- 密码设置弹窗 -->
    <t-dialog v-model:visible="passwordDialog.visible" header="设置访问密码" width="400px" @confirm="savePassword" @close="passwordDialog.visible = false">
      <t-input
        v-model="passwordDialog.value"
        type="password"
        placeholder="输入密码（留空则移除密码）"
        clearable
        autocomplete="off"
        name="file-password"
      />
      <div class="fl-dialog-hint">设置密码后，访问者需要输入密码才能查看该文件</div>
    </t-dialog>

    <!-- 访问次数限制弹窗 -->
    <t-dialog v-model:visible="accessCountDialog.visible" header="设置访问次数限制" width="400px" @confirm="saveAccessCount" @close="accessCountDialog.visible = false">
      <t-input-number v-model="accessCountDialog.value" :min="-1" theme="normal" style="width: 100%" />
      <div class="fl-dialog-hint">-1 表示不限制访问次数；超过上限后文件将无法再被访问</div>
    </t-dialog>

    <!-- 限时访问弹窗 -->
    <t-dialog v-model:visible="expiresDialog.visible" header="设置限时访问" width="400px" @confirm="saveExpires" @close="expiresDialog.visible = false">
      <t-select v-model="expiresDialog.value" :options="expiresOptions" style="width: 100%" />
      <div class="fl-dialog-hint">选择「永久」表示不限时；限时到期后文件将无法再被访问</div>
    </t-dialog>

    <!-- 删除确认弹窗 -->
    <t-dialog
      v-model:visible="deleteDialog.visible"
      header="确认删除文件"
      width="420px"
      @confirm="confirmDelete"
      @close="deleteDialog.visible = false"
    >
      <div class="fl-delete-body">
        <p>确定要删除文件 <strong>{{ deleteDialog.fileName }}</strong> 吗？</p>
        <div class="fl-delete-note">
          <p class="fl-delete-note-title">删除说明：</p>
          <ul>
            <li>文件将进入 <strong>7 天冷静期</strong>，期间可以恢复</li>
            <li>冷静期内文件不可访问和下载</li>
            <li>7 天后文件将被永久删除</li>
            <li>删除后 10 分钟内不可重复请求</li>
          </ul>
        </div>
      </div>
    </t-dialog>

    <!-- 批量添加标签弹窗 -->
    <t-dialog v-model:visible="batchTagDialog.visible" header="批量添加标签" width="420px" @confirm="confirmBatchTags" @close="batchTagDialog.visible = false">
      <div class="fl-delete-body">
        <p>为 <strong>{{ selectedFileIds.length }}</strong> 个文件添加标签：</p>
        <div class="fl-batch-tags">
          <t-tag
            v-for="tag in tagStore.tags"
            :key="tag.id"
            size="small"
            :theme="batchTagDialog.selectedTagIds.includes(tag.id) ? 'primary' : 'default'"
            variant="light"
            class="fl-batch-tag"
            @click="toggleBatchTag(tag.id)"
          >
            {{ tag.name }}
          </t-tag>
          <span v-if="!tagStore.tags || tagStore.tags.length === 0" class="os-muted">暂无标签，请先在标签管理中创建</span>
        </div>
      </div>
    </t-dialog>

    <!-- 文件夹相关弹窗 -->
    <FolderCreateDialog v-model:visible="showCreateFolderDialog" :parent-id="folderStore.currentFolderId" @created="onFolderCreated" />
    <FolderRenameDialog v-model:visible="showRenameFolderDialog" :folder="renameTargetFolder" />
    <FolderMoveDialog
      v-model:visible="showMoveDialog"
      :target-kind="moveTargetKind"
      :target-ids="moveTargetIds"
      :disabled-ids="moveDisabledIds"
      @moved="onFolderMoved"
    />
    <CreateShareDialog
      v-model:visible="showShareDialog"
      :target-type="shareTargetType"
      :target-id="shareTargetId"
      :target-name="shareTargetName"
    />

    <!-- 文件重命名弹窗 -->
    <FileRenameDialog v-model:visible="showRenameFileDialog" :file="renameTargetFile" />

    <!-- 自定义右键菜单（桌面右键 / 移动端长按） -->
    <FileContextMenu
      v-model:visible="ctxMenu.visible"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :target="ctxMenu.target"
      :clipboard-count="fileClipboard.length"
      :is-admin="isAdmin"
      @action="onCtxAction"
    />

    <!-- 文件在线预览弹窗 -->
    <FilePreviewDialog
      :visible="previewTarget !== null"
      :name="previewTarget?.originalName"
      :mime-type="previewTarget?.mimeType"
      :size="previewTarget?.size"
      :kind="previewTarget ? getPreviewKind(previewTarget.mimeType, previewTarget.originalName) : null"
      :src="previewTarget ? buildFilePreviewUrl(previewTarget.id) : null"
      :download-url="previewTarget ? `/api/files/${previewTarget.id}/download` : undefined"
      :playlist="activeMediaPlaylist"
      :playlist-index="activeMediaPlaylistIndex"
      @update:visible="onPreviewVisibleChange"
      @update:playlist-index="onPlaylistIndexChange"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, reactive, watch, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import MessagePlugin from '@/utils/message';
import { DialogPlugin } from 'tdesign-vue-next';
import { useFileStore } from '../../stores/files';
import { useAuthStore, api } from '../../stores/auth';
import { getErrorMessage } from '../../utils/error';
import { formatSize, formatDate } from '@/utils/format';
import { triggerBrowserDownload } from '@/utils/download';
import { useCursorPagination } from '../../composables/useCursorPagination';
import { useMobile } from '../../composables/useMobile';
import UploadModal from '../../components/UploadModal.vue';
import { collectFromDrop } from '../../utils/folder-traverse';
import type { DropCollectResult } from '../../utils/folder-traverse';
import TagManager from '../../components/TagManager.vue';
import FileTagEditor from '../../components/FileTagEditor.vue';
import ThumbnailImg from '../../components/ThumbnailImg.vue';
import FolderCreateDialog from '../../components/folder/FolderCreateDialog.vue';
import FolderRenameDialog from '../../components/folder/FolderRenameDialog.vue';
import FolderMoveDialog from '../../components/folder/FolderMoveDialog.vue';
import CreateShareDialog from '../../components/share/CreateShareDialog.vue';
import FileContextMenu, { type CtxTarget } from '../../components/file/FileContextMenu.vue';
import FileRenameDialog from '../../components/file/FileRenameDialog.vue';
import FilePreviewDialog, { type PlaylistItem } from '../../components/file/FilePreviewDialog.vue';
import { isPreviewable, getPreviewKind, isMediaDirectLinkKind, buildFilePreviewUrl } from '../../utils/preview';
import { useTagStore } from '../../stores/tags';
import { useFolderStore, type Folder } from '../../stores/folders';
import type { FileItem } from '../../types/file';

const fileStore = useFileStore();
const authStore = useAuthStore();
const tagStore = useTagStore();
const folderStore = useFolderStore();
const router = useRouter();
const route = useRoute();
const search = ref((route.query.search as string) || '');
const showUploadModal = ref(false);
const isDraggedOver = ref(false);
const markdownResult = ref('');
const selectedFileIds = ref<string[]>([]);
const dropFiles = ref<File[]>([]);
/** 页面级拖拽采集结果（含目录结构），转发给上传弹窗处理，避免双重入队 */
const dropCollected = ref<DropCollectResult | null>(null);
const sortBy = ref<string>(route.query.sortBy as string || '');
const sortOrder = ref<string>(route.query.sortOrder as string || '');
const selectedTagIds = ref<string[]>(
  (route.query.tagIds as string || '').split(',').filter(Boolean)
);
const showTagManager = ref(false);
const tagEditorVisible = ref(false);
const batchTagDialog = reactive({
  visible: false,
  selectedTagIds: [] as string[],
});
const tagEditorFileId = ref('');
const tagEditorFileTags = ref<{ id: string; name: string; color: string }[]>([]);

// ============ 文件夹相关状态 ============
const showCreateFolderDialog = ref(false);
const showRenameFolderDialog = ref(false);
const renameTargetFolder = ref<Folder | null>(null);
const showMoveDialog = ref(false);
const moveTargetKind = ref<'folder' | 'file'>('file');
const moveTargetIds = ref<string[]>([]);
const moveDisabledIds = ref<string[]>([]);

// ============ 分享弹窗状态 ============
const showShareDialog = ref(false);
const shareTargetType = ref<'file' | 'folder'>('file');
const shareTargetId = ref('');
const shareTargetName = ref('');

// ============ 自定义右键菜单状态 ============
const ctxMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  target: null as CtxTarget | null,
});
/** 文件剪贴板：复制（copy）后暂存，粘贴（paste）时生成副本到当前文件夹 */
const fileClipboard = ref<FileItem[]>([]);

// ============ 文件预览状态 ============
/** 当前预览目标；null 表示弹窗关闭 */
const previewTarget = ref<FileItem | null>(null);

/** 是否可点击预览：类型可预览且文件处于可用状态（非删除/处理中） */
function canPreviewFile(file: FileItem): boolean {
  return isPreviewable(file.mimeType, file.originalName)
    && !file.isDeleted
    && file.status !== 'processing';
}

/** 打开在线预览弹窗 */
function openPreview(file: FileItem) {
  if (!canPreviewFile(file)) return;
  previewTarget.value = file;
}

function onPreviewVisibleChange(v: boolean) {
  if (!v) previewTarget.value = null;
}

// ============ 媒体快速预览列表 ============
/** 当前文件夹已加载且可用的媒体文件，按图片 / 视频 / 音乐分别组成列表。 */
function buildMediaPlaylist(kind: 'image' | 'video' | 'audio'): PlaylistItem[] {
  return fileStore.files
    .filter((file) => getPreviewKind(file.mimeType, file.originalName) === kind && !file.isDeleted && file.status !== 'processing')
    .map((file) => ({
      id: file.id,
      name: file.originalName,
      mimeType: file.mimeType,
      kind,
      size: file.size,
      src: buildFilePreviewUrl(file.id),
      downloadUrl: `/api/files/${file.id}/download`,
    }));
}

const videoPlaylist = computed<PlaylistItem[]>(() => buildMediaPlaylist('video'));
const audioPlaylist = computed<PlaylistItem[]>(() => buildMediaPlaylist('audio'));
const imagePlaylist = computed<PlaylistItem[]>(() => buildMediaPlaylist('image'));

const activeMediaPlaylist = computed<PlaylistItem[]>(() => {
  if (!previewTarget.value) return [];
  const kind = getPreviewKind(previewTarget.value.mimeType, previewTarget.value.originalName);
  if (kind === 'video') return videoPlaylist.value;
  if (kind === 'audio') return audioPlaylist.value;
  if (kind === 'image') return imagePlaylist.value;
  return [];
});

const activeMediaPlaylistIndex = computed(() => {
  if (!previewTarget.value) return -1;
  return activeMediaPlaylist.value.findIndex((item) => item.id === previewTarget.value!.id);
});

/** 列表切换时更新 previewTarget，父组件继续作为当前文件的单一数据源。 */
function onPlaylistIndexChange(idx: number) {
  const item = activeMediaPlaylist.value[idx];
  if (!item) return;
  const file = fileStore.files.find((candidate) => candidate.id === item.id);
  if (file) previewTarget.value = file;
}
// ============ 文件重命名弹窗状态 ============
const showRenameFileDialog = ref(false);
const renameTargetFile = ref<FileItem | null>(null);

/** 把 folderStore.currentFolderId (null | uuid) 转换为 API 期望的字符串 */
const currentFolderIdForApi = computed(() => {
  return folderStore.currentFolderId === null ? 'root' : folderStore.currentFolderId;
});

/**
 * 用户点击地址栏路径、双击/右键打开文件夹时触发。
 * 只更新 URL（folder query 参数），状态同步统一由下方 route watch 驱动，
 * 避免「直接改 store + 改 URL」双写竞态；URL 是当前目录的唯一事实来源。
 * 保留 search/sortBy/sortOrder/tagIds 等既有 query 参数不丢失。
 */
function onFolderNavigate(folderId: string | null) {
  if (folderId === folderStore.currentFolderId) return; // 已在目标目录，不产生多余历史记录
  const query = { ...route.query };
  if (folderId) query.folder = folderId;
  else delete query.folder; // 根目录对应 /files（不带 folder 参数），保持既有链接兼容
  router.push({ query });
}

/**
 * URL → 目录状态（单向同步，天然支持浏览器前进/后退与 F5 刷新保持）。
 * 进入/变更路由时读取 folder 参数 → openFolder → 刷新文件列表；
 * 参数非法（文件夹不存在/无权限）时友好提示并 router.replace 清除参数回退根目录。
 */
let folderRouteSynced = false;
watch(() => route.query.folder, async (raw) => {
  // 非法参数形态（如 folder=a&folder=b）：直接清除并回退根目录
  if (raw != null && typeof raw !== 'string') {
    const query = { ...route.query };
    delete query.folder;
    router.replace({ query });
    return;
  }
  const targetId = raw || null;
  // 已同步则跳过（如 search/sort replace 未改变目录）；首次挂载必须执行初始加载
  if (folderRouteSynced && targetId === folderStore.currentFolderId) return;
  folderRouteSynced = true;

  if (targetId) {
    const valid = await folderStore.openFolder(targetId);
    if (!valid) {
      MessagePlugin.warning('目标文件夹不存在或无权访问，已回到我的文件');
      const query = { ...route.query };
      delete query.folder;
      router.replace({ query }); // replace 后 watch 以 null 再次触发，完成重置与加载
      return;
    }
  } else {
    await folderStore.openFolder(null);
  }
  selectedFileIds.value = [];
  try {
    await refetchFiles();
  } catch {
    // 初始/切换加载失败保留空列表，用户可手动刷新
  }
}, { immediate: true });

function openCreateFolderDialog() {
  showCreateFolderDialog.value = true;
}

function onFolderOpen(folder: Folder) {
  onFolderNavigate(folder.id);
}

function onFolderRename(folder: Folder) {
  renameTargetFolder.value = folder;
  showRenameFolderDialog.value = true;
}

function onFolderMove(folder: Folder) {
  moveTargetKind.value = 'folder';
  moveTargetIds.value = [folder.id];
  moveDisabledIds.value = [folder.id];
  showMoveDialog.value = true;
}

function onFolderShare(folder: Folder) {
  shareTargetType.value = 'folder';
  shareTargetId.value = folder.id;
  shareTargetName.value = folder.name;
  showShareDialog.value = true;
}

function onFileShare(file: FileItem) {
  shareTargetType.value = 'file';
  shareTargetId.value = file.id;
  shareTargetName.value = file.originalName;
  showShareDialog.value = true;
}

function openMoveDialogForFiles(fileIds?: string[]) {
  const ids = fileIds && fileIds.length > 0 ? fileIds : selectedFileIds.value;
  if (ids.length === 0) {
    MessagePlugin.warning('请先选择要移动的文件');
    return;
  }
  moveTargetKind.value = 'file';
  moveTargetIds.value = ids;
  moveDisabledIds.value = [];
  showMoveDialog.value = true;
}

async function onFolderMoved() {
  refetchFiles();
  selectedFileIds.value = [];
}

/** 新建文件夹成功：乐观插入内存树，避免树刷新失败/竞态时新文件夹不显示 */
function onFolderCreated(folder: Folder) {
  folderStore.insertIntoTree(folder, folder.parentId);
}

function onFolderDelete(folder: Folder) {
  const confirmDialog = DialogPlugin.confirm({
    header: '删除文件夹',
    body: `确定删除「${folder.name}」及其所有子文件夹和文件吗？此操作可在 7 天内撤销。`,
    theme: 'warning',
    confirmBtn: '删除',
    cancelBtn: '取消',
    onConfirm: async () => {
      try {
        await folderStore.deleteFolder(folder.id);
        MessagePlugin.success('文件夹已放入回收站，7 天后永久删除');
        if (folderStore.currentFolderId === folder.id) {
          onFolderNavigate(null);
        }
      } catch (err: any) {
        MessagePlugin.error(err?.response?.data?.message || '删除失败');
      }
      confirmDialog.destroy();
    },
    onClose: () => confirmDialog.destroy(),
  });
}

// ============ 自定义右键菜单（桌面右键 / 移动端长按） ============
function openCtxMenuAt(x: number, y: number, target: CtxTarget) {
  ctxMenu.target = target;
  ctxMenu.x = x;
  ctxMenu.y = y;
  ctxMenu.visible = true;
}
function openFileCtxMenu(e: MouseEvent, file: FileItem) {
  openCtxMenuAt(e.clientX, e.clientY, { kind: 'file', file });
}
function openFolderCtxMenu(e: MouseEvent, folder: Folder) {
  openCtxMenuAt(e.clientX, e.clientY, { kind: 'folder', folder });
}
function openBlankCtxMenu(e: MouseEvent) {
  openCtxMenuAt(e.clientX, e.clientY, { kind: 'blank' });
}

// ---- 移动端长按弹出（替代右键） ----
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressFired = false;
const touchStartPos = { x: 0, y: 0 };

function handleTouchStart(e: TouchEvent, kind: 'file' | 'folder' | 'blank', item?: FileItem | Folder) {
  if (e.touches.length !== 1) return;
  const t = e.touches[0];
  touchStartPos.x = t.clientX;
  touchStartPos.y = t.clientY;
  longPressFired = false;
  if (longPressTimer) clearTimeout(longPressTimer);
  longPressTimer = setTimeout(() => {
    longPressFired = true;
    try { navigator.vibrate?.(10); } catch { /* 部分浏览器不支持震动 */ }
    if (kind === 'file') openCtxMenuAt(touchStartPos.x, touchStartPos.y, { kind: 'file', file: item as FileItem });
    else if (kind === 'folder') openCtxMenuAt(touchStartPos.x, touchStartPos.y, { kind: 'folder', folder: item as Folder });
    else openCtxMenuAt(touchStartPos.x, touchStartPos.y, { kind: 'blank' });
  }, 550);
}
function handleTouchMove(e: TouchEvent) {
  if (!longPressTimer) return;
  const t = e.touches[0];
  if (Math.abs(t.clientX - touchStartPos.x) > 10 || Math.abs(t.clientY - touchStartPos.y) > 10) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}
function handleTouchEnd() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}
/** 长按触发后抑制随后的 click（避免长按打开菜单的同时又触发导航/下载） */
function consumeLongPressClick(): boolean {
  if (longPressFired) {
    longPressFired = false;
    return true;
  }
  return false;
}

/** 菜单动作统一分发 */
async function onCtxAction(action: string, target: CtxTarget | null) {
  if (!target) return;

  if (target.kind === 'file') {
    const file = target.file;
    switch (action) {
      case 'copy-link': copyLink(file); break;
      case 'copy-media-link': copyMediaLink(file); break;
      case 'preview': openPreview(file); break;
      case 'download': downloadFile(file); break;
      case 'rename':
        renameTargetFile.value = file;
        showRenameFileDialog.value = true;
        break;
      case 'copy':
        fileClipboard.value = [file];
        MessagePlugin.success(`已复制「${file.originalName}」，在空白处右键/长按可粘贴`);
        break;
      case 'move': openMoveDialogForFiles([file.id]); break;
      case 'tag': openTagEditor(file); break;
      case 'share': onFileShare(file); break;
      case 'delete': handleDelete(file); break;
      // 访问控制（原表格内联列）
      case 'toggle-access':
        handleAccessTypeChange(file.id, file.accessType === 'public' ? 'private' : 'public');
        break;
      case 'password': openPasswordDialog(file); break;
      case 'access-count': openAccessCountDialog(file); break;
      case 'expires': openExpiresDialog(file); break;
      // 已删除文件的恢复操作
      case 'restore': handleRestore(file.id); break;
      case 'force-delete': handleForceDelete(file.id); break;
    }
    return;
  }

  if (target.kind === 'folder') {
    const folder = target.folder;
    switch (action) {
      case 'open': onFolderOpen(folder); break;
      case 'rename': onFolderRename(folder); break;
      case 'move': onFolderMove(folder); break;
      case 'share': onFolderShare(folder); break;
      case 'delete': onFolderDelete(folder); break;
    }
    return;
  }

  // 空白处
  if (action === 'new-folder') {
    openCreateFolderDialog();
  } else if (action === 'upload') {
    showUploadModal.value = true;
  } else if (action === 'paste') {
    await pasteFiles();
  }
}

/** 粘贴：把剪贴板中的文件逐个复制（生成副本）到当前文件夹 */
async function pasteFiles() {
  const items = fileClipboard.value;
  if (items.length === 0) {
    MessagePlugin.warning('剪贴板为空，请先复制文件');
    return;
  }
  const targetFolderId = folderStore.currentFolderId; // null = 根目录
  const results = await Promise.allSettled(
    items.map((f) => fileStore.copyFile(f.id, targetFolderId)),
  );
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed === 0) {
    MessagePlugin.success(`已粘贴 ${items.length} 个文件（生成副本）`);
  } else {
    MessagePlugin.warning(`${items.length - failed} 个成功，${failed} 个失败`);
  }
  // 粘贴完成后清空剪贴板并刷新列表
  fileClipboard.value = [];
  onFolderMoved();
}

// ============ 当前文件夹下的直接子文件夹（OS 列表文件夹行数据源） ============
const subfoldersInCurrentFolder = computed<Folder[]>(() => {
  const parentId = folderStore.currentFolderId;
  if (parentId === null) {
    return folderStore.tree.filter(f => !f.isDeleted);
  }
  const find = (nodes: Folder[], id: string): Folder | null => {
    for (const n of nodes) {
      if (n.id === id) return n;
      if (n.children?.length) {
        const found = find(n.children, id);
        if (found) return found;
      }
    }
    return null;
  };
  const current = find(folderStore.tree, parentId);
  return (current?.children ?? []).filter(f => !f.isDeleted);
});

// ============ 选择（自定义列表） ============
function toggleFileSelect(file: FileItem) {
  const idx = selectedFileIds.value.indexOf(file.id);
  if (idx >= 0) {
    selectedFileIds.value.splice(idx, 1);
  } else {
    selectedFileIds.value.push(file.id);
  }
}

/** 当前可被选中的文件（未删除、非处理中） */
const selectableFiles = computed(() =>
  displayFiles.value.filter(f => !f.isDeleted && f.status !== 'processing')
);

const isAllSelected = computed(() =>
  selectableFiles.value.length > 0 &&
  selectableFiles.value.every(f => selectedFileIds.value.includes(f.id))
);

const isIndeterminate = computed(() => {
  const count = selectableFiles.value.filter(f => selectedFileIds.value.includes(f.id)).length;
  return count > 0 && count < selectableFiles.value.length;
});

function toggleSelectAll() {
  if (isAllSelected.value) {
    const ids = new Set(selectableFiles.value.map(f => f.id));
    selectedFileIds.value = selectedFileIds.value.filter(id => !ids.has(id));
  } else {
    const existing = new Set(selectedFileIds.value);
    const all = [...selectedFileIds.value];
    for (const f of selectableFiles.value) {
      if (!existing.has(f.id)) all.push(f.id);
    }
    selectedFileIds.value = all;
  }
}

function clearSelection() {
  selectedFileIds.value = [];
}

// ============ 排序（自定义表头） ============
function toggleSort(field: string) {
  if (sortBy.value === field) {
    sortOrder.value = sortOrder.value === 'DESC' ? 'ASC' : 'DESC';
  } else {
    sortBy.value = field;
    sortOrder.value = field === 'createdAt' ? 'DESC' : 'ASC';
  }
  refetchFiles();
}

// 无限滚动每批加载条数（不再提供分页，固定批次）
const BATCH_SIZE = 20;

// 游标无限滚动 composable
const {
  hasMore,
  loading: cursorLoading,
  loadMore,
  reset: resetCursor,
} = useCursorPagination<FileItem>();

// 滚动哨兵 ref
const scrollSentinel = ref<HTMLElement | null>(null);
let scrollObserver: IntersectionObserver | null = null;

const displayFiles = computed(() => fileStore.files);

const isAdmin = computed(() => {
  const role = authStore.user?.role || fileStore.currentUserRole;
  return role === 'admin' || role === 'super_admin';
});

const isMobile = useMobile();

watch(() => authStore.user?.role, (role) => {
  if (role) fileStore.setCurrentUserRole(role);
}, { immediate: true });

const selectedFileIdSet = computed(() => new Set(selectedFileIds.value));

const selectedImages = computed(() =>
  displayFiles.value.filter(f =>
    f.mimeType.startsWith('image/') &&
    selectedFileIdSet.value.has(f.id) &&
    !f.isDeleted
  )
);

function getRowClassName({ row }: { row: FileItem }) {
  if (row.status === 'processing') return 'row-processing';
  return row.isDeleted ? 'row-deleted' : '';
}

function isFileActionable(row: FileItem): boolean {
  return row.status !== 'processing' && !row.isDeleted;
}

// 密码弹窗状态
const passwordDialog = reactive({
  visible: false,
  value: '',
  fileId: '',
});

// 访问次数限制弹窗状态
const accessCountDialog = reactive({
  visible: false,
  value: -1,
  fileId: '',
});

// 限时访问弹窗状态
const expiresDialog = reactive({
  visible: false,
  value: null as number | null,
  fileId: '',
});

// 删除确认弹窗
const deleteDialog = reactive({
  visible: false,
  fileId: '',
  fileName: '',
});

function openDeleteDialog(row: FileItem) {
  deleteDialog.fileId = row.id;
  deleteDialog.fileName = row.originalName;
  deleteDialog.visible = true;
}

function openPasswordDialog(row: FileItem) {
  passwordDialog.fileId = row.id;
  passwordDialog.value = '';
  passwordDialog.visible = true;
}

async function savePassword() {
  try {
    await fileStore.setPassword(passwordDialog.fileId, passwordDialog.value);
    MessagePlugin.success(passwordDialog.value ? '密码已设置' : '密码已移除');
    passwordDialog.visible = false;
    refetchFiles();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

function openAccessCountDialog(row: FileItem) {
  accessCountDialog.fileId = row.id;
  accessCountDialog.value = row.maxAccessCount ?? -1;
  accessCountDialog.visible = true;
}

async function saveAccessCount() {
  try {
    await fileStore.updateAccessCount(accessCountDialog.fileId, accessCountDialog.value);
    MessagePlugin.success('访问次数限制已更新');
    accessCountDialog.visible = false;
    refreshCurrentList();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

function openExpiresDialog(row: FileItem) {
  expiresDialog.fileId = row.id;
  expiresDialog.value = row.expiresIn ?? null;
  expiresDialog.visible = true;
}

async function saveExpires() {
  try {
    await fileStore.updateExpires(expiresDialog.fileId, expiresDialog.value);
    MessagePlugin.success('限时访问已更新');
    expiresDialog.visible = false;
    refreshCurrentList();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

/** 刷新文件列表（供访问控制类弹窗保存后复用） */
function refreshCurrentList() {
  refetchFiles();
}

// 限时访问选项
const expiresOptions = [
  { label: '永久', value: null },
  { label: '1 小时', value: 1 },
  { label: '6 小时', value: 6 },
  { label: '12 小时', value: 12 },
  { label: '24 小时', value: 24 },
  { label: '3 天', value: 72 },
  { label: '7 天', value: 168 },
  { label: '30 天', value: 720 },
];

let dragLeaveTimeout: ReturnType<typeof setTimeout> | null = null;
let dragCounter = 0;

// ============ 拖拽（上传 + 文件移动） ============
// 内部文件移动拖拽使用的自定义 MIME 类型（区别于外部文件拖入的 'Files'）
const INTERNAL_DRAG_MIME = 'application/x-tgtc-file-ids';
// 拖到地址栏「我的文件」表示移动到根目录，用特殊标记区分真实文件夹 ID
const ROOT_DROP_TARGET = '__root__';

/** 正在被拖动的文件 ID 列表（用于拖动中的视觉反馈） */
const draggingFileIds = ref<string[]>([]);
/** 当前悬停的放置目标文件夹 ID（ROOT_DROP_TARGET 表示根目录），用于高亮 */
const dragOverFolderId = ref<string | null>(null);

function hasExternalFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types || []).includes('Files');
}
function isInternalFileDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types || []).includes(INTERNAL_DRAG_MIME);
}

// ---- 页面级：仅响应外部文件拖入（上传），内部移动拖拽由文件夹行自行处理 ----
function handlePageDragEnter(e: DragEvent) {
  if (!hasExternalFiles(e)) return;
  dragCounter++;
  isDraggedOver.value = true;
}
function handlePageDragOver(e: DragEvent) {
  if (!hasExternalFiles(e)) return;
  e.preventDefault(); // 允许放置外部文件
}
function handlePageDragLeave(e: DragEvent) {
  if (!hasExternalFiles(e)) return;
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    isDraggedOver.value = false;
  }
}
async function handlePageDrop(e: DragEvent) {
  if (!hasExternalFiles(e)) return;
  e.preventDefault();
  dragCounter = 0;
  isDraggedOver.value = false;
  if (dragLeaveTimeout) clearTimeout(dragLeaveTimeout);
  const items = e.dataTransfer?.items;
  if (items && items.length > 0) {
    // 采集在 drop 事件内同步启动（保留目录结构），结果转发给弹窗统一处理
    try {
      const result = await collectFromDrop(items);
      if (result.parsed.length > 0 || result.plainFiles.length > 0) {
        dropFiles.value = [];
        dropCollected.value = result;
        showUploadModal.value = true;
        return;
      }
    } catch {
      // 采集异常：回退原有平铺转发
    }
  }
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length > 0) {
    dropCollected.value = null;
    dropFiles.value = files;
    showUploadModal.value = true;
  }
}

// ---- 文件行：拖动开始 / 结束 ----
function onFileDragStart(e: DragEvent, file: FileItem) {
  if (!isFileActionable(file)) {
    e.preventDefault();
    return;
  }
  // 若被拖文件已在选中集合中，则一并拖动所有已选文件；否则仅拖动该文件
  const ids = selectedFileIds.value.includes(file.id)
    ? [...selectedFileIds.value]
    : [file.id];
  e.dataTransfer?.setData(INTERNAL_DRAG_MIME, JSON.stringify(ids));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  draggingFileIds.value = ids;
}
function onFileDragEnd() {
  draggingFileIds.value = [];
  dragOverFolderId.value = null;
}

// ---- 文件夹行 / 根目录：放置目标 ----
function onFolderDragOver(e: DragEvent, target: string) {
  if (!isInternalFileDrag(e)) return;
  e.preventDefault(); // 允许放置
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  dragOverFolderId.value = target;
}
function onFolderDragLeave(e: DragEvent, target: string) {
  if (!isInternalFileDrag(e)) return;
  // 仍在本行内部移动（进入子元素）时不清除高亮
  const current = e.currentTarget as Node | null;
  const related = e.relatedTarget as Node | null;
  if (current && related && current.contains(related)) return;
  if (dragOverFolderId.value === target) dragOverFolderId.value = null;
}
function onDropOnFolder(e: DragEvent, target: string) {
  e.preventDefault();
  e.stopPropagation();
  dragOverFolderId.value = null;
  const raw = e.dataTransfer?.getData(INTERNAL_DRAG_MIME);
  if (!raw) return;
  let ids: string[] = [];
  try {
    ids = JSON.parse(raw);
  } catch {
    return;
  }
  if (ids.length === 0) return;
  const folderId = target === ROOT_DROP_TARGET ? null : target;
  moveFilesToFolder(ids, folderId);
}

/** 执行文件移动（并发，单个失败不影响其他），完成后刷新列表 */
async function moveFilesToFolder(ids: string[], folderId: string | null) {
  const results = await Promise.allSettled(
    ids.map((fid) => folderStore.moveFile(fid, folderId)),
  );
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed === 0) {
    MessagePlugin.success(`已移动 ${ids.length} 个文件`);
  } else {
    MessagePlugin.warning(`${ids.length - failed} 个成功，${failed} 个失败`);
  }
  draggingFileIds.value = [];
  onFolderMoved(); // 复用既有刷新逻辑（重新拉取列表 + 清空选择）
}

function getTagName(tagId: string): string {
  return tagStore.tags.find(t => t.id === tagId)?.name || tagId;
}

function addTagFilter(tagId: string) {
  if (!selectedTagIds.value.includes(tagId)) {
    selectedTagIds.value = [...selectedTagIds.value, tagId];
    applyFilters();
  }
}

function handleTagManagerFilter(tagId: string) {
  if (selectedTagIds.value.includes(tagId)) {
    removeTagFilter(tagId);
  } else {
    addTagFilter(tagId);
  }
}

function removeTagFilter(tagId: string) {
  selectedTagIds.value = selectedTagIds.value.filter(id => id !== tagId);
  applyFilters();
}

function clearTagFilters() {
  selectedTagIds.value = [];
  applyFilters();
}

/** 统一的重新获取文件列表（无限滚动：从头加载） */
async function refetchFiles() {
  await loadInitialFiles();
}

function applyFilters() {
  refetchFiles();
}

function openTagEditor(file: { id: string; tags?: { id: string; name: string; color: string }[] }) {
  tagEditorFileId.value = file.id;
  tagEditorFileTags.value = file.tags || [];
  tagEditorVisible.value = true;
}

function onTagSaved() {
  applyFilters();
}

function handleUploadModalClose() {
  showUploadModal.value = false;
  dropFiles.value = [];
  dropCollected.value = null;
}

// 消费全局上传指示器「查看详情」注入的 uploadDialog=1 query：打开上传弹窗后立即清除该参数
watch(() => route.query.uploadDialog, (val) => {
  if (val === '1') {
    showUploadModal.value = true;
    const query = { ...route.query };
    delete query.uploadDialog;
    router.replace({ query });
  }
}, { immediate: true });

// 上传完成刷新防抖：store 每个文件成功即触发一次 uploaded，多文件并发完成时合并为一次全量重取
let uploadedRefetchTimer: ReturnType<typeof setTimeout> | null = null;

function onUploaded() {
  selectedFileIds.value = [];
  if (uploadedRefetchTimer) clearTimeout(uploadedRefetchTimer);
  uploadedRefetchTimer = setTimeout(() => {
    uploadedRefetchTimer = null;
    refetchFiles();
    // 文件夹上传会在目标目录下新建子目录：同步刷新目录树（失败静默）
    folderStore.fetchTree().catch(() => {});
  }, 800);
}

function handleSearch() {
  refetchFiles();
}

function handleClearSearch() {
  search.value = '';
  refetchFiles();
}

// ==== 无限滚动加载逻辑（唯一加载方式，不再分页） ====
// 用「页码」作为游标驱动 loadMore：偏移分页支持自定义排序，
// 既保留排序/搜索/标签能力，又提供无限滚动体验。
let fileListGeneration = 0;

async function loadInitialFiles() {
  fileListGeneration++;
  resetCursor();
  fileStore.replaceFiles([]);
  await loadMoreFiles();
}

async function loadMoreFiles() {
  if (!hasMore.value) return;
  const generation = fileListGeneration;
  await loadMore(async (cursor, signal) => {
    const page = cursor ? parseInt(cursor, 10) : 1;
    const tagIds = selectedTagIds.value.length > 0 ? selectedTagIds.value : undefined;
    try {
      const result = await fileStore.fetchFilesPage(
        page,
        BATCH_SIZE,
        search.value || undefined,
        sortBy.value || undefined,
        sortOrder.value || undefined,
        tagIds,
        currentFolderIdForApi.value,
        signal,
      );
      // 即使底层请求未遵守 AbortSignal，也禁止旧筛选/目录请求污染当前列表。
      if (generation !== fileListGeneration) {
        return { data: [], nextCursor: cursor, hasMore: true };
      }
      fileStore.appendFiles(result.files);
      fileStore.total = result.total;
      const loadedAll = fileStore.files.length >= result.total || result.files.length === 0;
      return {
        data: result.files,
        nextCursor: loadedAll ? null : String(page + 1),
        hasMore: !loadedAll,
      };
    } catch (err) {
      const e = err as { name?: string; code?: string };
      if (e.name === 'AbortError' || e.code === 'ERR_CANCELED') {
        return { data: [], nextCursor: cursor, hasMore: true };
      }
      throw err;
    }
  });
}

/**
 * 哨兵元素变化时重新挂载 IntersectionObserver。
 * 修复无限滚动失效 Bug：切换文件夹 / 筛选时列表会先清空再重载，os-list 及其内部
 * 哨兵元素随之卸载并重建，旧 observer 仍指向已脱离 DOM 的元素而永不触发。
 * 用 watch 监听哨兵 ref，元素一变化即重新 observe，保证任何重挂载后都能继续加载。
 */
watch(scrollSentinel, (el) => {
  if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }
  if (!el) return;
  scrollObserver = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting) {
        loadMoreFiles();
      }
    },
    { rootMargin: '600px' },
  );
  scrollObserver.observe(el);
});

async function handleAccessTypeChange(id: string, accessType: string) {
  try {
    await fileStore.updateAccessType(id, accessType);
    MessagePlugin.success('更新成功');
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function copyLink(row: FileItem) {
  try {
    const link = `${window.location.origin}/files/public/${row.id}`;
    await navigator.clipboard.writeText(link);
    if (row.accessType === 'private') {
      MessagePlugin.warning('链接已复制，但该文件为私有，仅你自己可访问；如需分享给他人请使用「分享」功能');
    } else {
      MessagePlugin.success('分享链接已复制');
    }
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function copyMediaLink(row: FileItem) {
  if (!isMediaDirectLinkKind(getPreviewKind(row.mimeType, row.originalName))) {
    MessagePlugin.warning('仅图片、音频和视频支持媒体直链');
    return;
  }
  if (row.accessType !== 'public' || row.hasPassword || row.maxAccessCount > 0 || row.expiresIn != null) {
    MessagePlugin.warning('媒体直链仅适用于公开且无密码、次数或时效限制的文件');
    return;
  }
  try {
    await navigator.clipboard.writeText(`${window.location.origin}/media/${row.id}`);
    MessagePlugin.success('媒体直链已复制');
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

function downloadFile(row: FileItem) {
  // 直接调用浏览器原生下载（后端返回 attachment，浏览器下载器接管进度/保存）
  triggerBrowserDownload(`/api/files/${row.id}/download`, row.originalName);
}

function handleDelete(row: FileItem) {
  openDeleteDialog(row);
}

async function confirmDelete() {
  try {
    const result = await fileStore.deleteFile(deleteDialog.fileId);
    if (result.status === 'permanently_deleted') {
      MessagePlugin.success('文件已永久删除');
    } else if (result.status === 'already_deleted') {
      const scheduledDate = result.scheduledAt ? formatDate(result.scheduledAt) : '7天后';
      MessagePlugin.warning(`文件已处于待删除状态，将于 ${scheduledDate} 永久删除`);
    } else {
      const scheduledDate = result.scheduledAt ? formatDate(result.scheduledAt) : '7天后';
      MessagePlugin.success(`文件已标记为待删除，将于 ${scheduledDate} 永久删除，期间可恢复`);
    }
    deleteDialog.visible = false;
    await refetchFiles();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function handleRestore(id: string) {
  try {
    await fileStore.restoreFile(id);
    MessagePlugin.success('文件已恢复');
    await refetchFiles();
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function handleForceDelete(id: string) {
  try {
    await fileStore.forceDeleteFile(id);
    MessagePlugin.success('文件已永久删除');
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

function convertToMarkdown() {
  if (selectedImages.value.length === 0) {
    MessagePlugin.warning('请先选择图片文件');
    return;
  }
  const unavailable = selectedImages.value.filter(img =>
    img.accessType !== 'public' || img.hasPassword || img.maxAccessCount > 0 || img.expiresIn != null
  );
  if (unavailable.length > 0) {
    MessagePlugin.warning('媒体直链仅适用于公开且无密码、次数或时效限制的图片');
    return;
  }
  const baseUrl = window.location.origin;
  markdownResult.value = selectedImages.value
    .map((img) => `![${img.originalName}](${baseUrl}/media/${img.id})`)
    .join('\n');
}

function copyMarkdown() {
  navigator.clipboard.writeText(markdownResult.value);
  MessagePlugin.success('已复制到剪贴板');
}

function copyDownloadLinks() {
  const files = displayFiles.value.filter(f => selectedFileIds.value.includes(f.id) && !f.isDeleted);
  if (files.length === 0) {
    MessagePlugin.warning('没有可复制的文件');
    return;
  }
  const baseUrl = window.location.origin;
  const links = files.map(f => `${baseUrl}/files/public/${f.id}`).join('\n');
  navigator.clipboard.writeText(links);
  MessagePlugin.success(`已复制 ${files.length} 个下载链接`);
}

function openBatchTagDialog() {
  batchTagDialog.selectedTagIds = [];
  batchTagDialog.visible = true;
}

function toggleBatchTag(tagId: string) {
  const idx = batchTagDialog.selectedTagIds.indexOf(tagId);
  if (idx >= 0) {
    batchTagDialog.selectedTagIds.splice(idx, 1);
  } else {
    batchTagDialog.selectedTagIds.push(tagId);
  }
}

async function confirmBatchTags() {
  const fileIds = selectedFileIds.value.filter(id =>
    displayFiles.value.find(f => f.id === id && !f.isDeleted)
  );
  if (fileIds.length === 0) {
    MessagePlugin.warning('没有可添加标签的文件');
    return;
  }
  const results = await Promise.allSettled(
    fileIds.map(fileId => api.put(`/files/${fileId}/tags`, { tagIds: batchTagDialog.selectedTagIds })),
  );
  const successCount = results.filter(r => r.status === 'fulfilled').length;
  const failCount = results.length - successCount;
  batchTagDialog.visible = false;
  if (failCount === 0) {
    MessagePlugin.success(`已为 ${successCount} 个文件添加标签`);
  } else {
    MessagePlugin.warning(`完成: ${successCount} 成功, ${failCount} 失败`);
  }
  applyFilters();
}

// 同步搜索、排序、标签到 URL 查询参数（无限滚动，不再同步分页参数）
// 注意：replace 时必须保留 folder 参数，否则搜索/排序会丢失当前目录
watch([search, sortBy, sortOrder, selectedTagIds], ([newSearch, newSortBy, newSortOrder, newTagIds]) => {
  const query: Record<string, string> = {};
  if (newSearch) query.search = newSearch;
  if (newSortBy) query.sortBy = newSortBy;
  if (newSortOrder) query.sortOrder = newSortOrder;
  if (newTagIds && newTagIds.length > 0) query.tagIds = newTagIds.join(',');
  if (folderStore.currentFolderId) query.folder = folderStore.currentFolderId;
  router.replace({ query });
}, { flush: 'post' });

onMounted(async () => {
  try { await tagStore.fetchTags(); } catch { /* 标签加载失败不阻塞页面 */ }
  try { await folderStore.fetchTree(); } catch { /* 文件夹树加载失败不阻塞页面 */ }
  // 文件列表初始加载由上方 route.query.folder watch（immediate）驱动，此处不重复加载
});

onUnmounted(() => {
  if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }
  if (dragLeaveTimeout) { clearTimeout(dragLeaveTimeout); dragLeaveTimeout = null; }
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  if (uploadedRefetchTimer) { clearTimeout(uploadedRefetchTimer); uploadedRefetchTimer = null; }
  dragCounter = 0;
});
</script>

<style scoped>
.filelist-page {
  position: relative;
}

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
  transition: background var(--duration-fast), color var(--duration-fast);
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

/* ============ 工具栏 ============ */
.fl-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.fl-search-form {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  flex: 1;
  min-width: 220px;
  max-width: 420px;
}

.fl-search-input {
  flex: 1;
}

.fl-toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ============ 批量操作栏 ============ */
.fl-batchbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 12px;
  margin-bottom: 16px;
  background: var(--color-accent-soft);
  border: 1px solid var(--border-accent);
  border-radius: var(--radius-md);
}

.fl-batchbar-count {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-accent);
  margin-right: 4px;
}

/* ============ 标签筛选 ============ */
.fl-tagfilters {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

/* ============ Markdown 结果 ============ */
.fl-markdown {
  margin-bottom: 16px;
  padding: 16px;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-default);
}

.fl-markdown-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.fl-markdown-title {
  font-weight: 500;
}

.fl-markdown-actions {
  display: flex;
  gap: 8px;
}

/* ============ 空状态 ============ */
.empty-upload-icon {
  font-size: 48px;
  color: var(--text-tertiary);
  margin-bottom: 16px;
}

.empty-upload-hint {
  color: var(--text-secondary);
  margin-top: 8px;
}

.fl-loading {
  display: flex;
  justify-content: center;
  padding: 48px 0;
}

/* ============ OS 风格统一列表 ============ */
.os-list {
  padding: 0;
  overflow: hidden;
}

.os-list-scroll {
  overflow-x: auto;
}

.os-list-inner {
  min-width: 0;
}

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
/* 拖拽悬停的根目录（我的文件）路径项 */
.fl-path-item.drag-over {
  background: var(--color-accent-soft);
  color: var(--color-accent);
  outline: 1px dashed var(--color-accent);
}
/* 可拖动的文件行使用抓取光标提示 */
.os-file[draggable='true'] {
  cursor: grab;
}
.os-file[draggable='true']:active {
  cursor: grabbing;
}

/* 移动端长按弹出菜单：抑制文本选中与系统预览浮层 */
.os-file,
.os-folder,
.mobile-file-card,
.mobile-folder-row,
.upload-zone {
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
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

.os-muted {
  color: var(--text-tertiary);
}

.os-italic {
  font-style: italic;
  font-size: 13px;
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

.os-ops {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
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

.deleted-name {
  text-decoration: line-through;
  opacity: 0.6;
}

/* 无限滚动哨兵 */
.os-sentinel {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 12px 0;
  border-bottom: none;
}

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

.mobile-file-card-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 10px;
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

/* ============ 分页 ============ */
.fl-pagination {
  margin-top: 16px;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 16px;
}

.fl-pagesize {
  width: 130px;
}

/* ============ 拖拽覆盖层 ============ */
.drop-overlay {
  position: absolute;
  inset: 0;
  background: var(--color-accent-soft);
  border: 3px dashed var(--color-accent);
  border-radius: var(--radius-lg);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(8px);
}

.drop-overlay-content {
  text-align: center;
  color: var(--color-accent);
}

.drop-overlay-icon {
  font-size: 64px;
  margin-bottom: 16px;
}

.drop-overlay-content h2 {
  font-family: var(--font-display);
  font-size: 24px;
  font-weight: 600;
}

/* ============ 弹窗内辅助样式 ============ */
.fl-dialog-hint {
  margin-top: 8px;
  color: var(--text-secondary);
  font-size: 12px;
}

.fl-delete-body {
  line-height: 1.8;
}

.fl-delete-note {
  margin-top: 12px;
  padding: 12px;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--text-secondary);
}

.fl-delete-note-title {
  margin-bottom: 8px;
}

.fl-delete-note ul {
  margin: 0;
  padding-left: 20px;
}

.fl-batch-tags {
  margin-top: 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.fl-batch-tag {
  cursor: pointer;
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

/* ============ 响应式 ============ */
@media (max-width: 768px) {
  .fl-addressbar {
    padding: 8px 10px;
  }

  .fl-search-form {
    max-width: 100%;
  }

  .fl-path-item {
    max-width: 140px;
  }
}
</style>
