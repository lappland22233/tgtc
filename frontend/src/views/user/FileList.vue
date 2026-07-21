<template>
  <div
    @dragover.prevent="isDraggedOver = true"
    @dragenter="handleDragEnter"
    @dragleave="handleDragLeave"
    @drop.prevent="handleDrop"
    style="position: relative;"
  >
    <!-- 拖拽上传覆盖层 -->
    <div v-if="isDraggedOver" class="drop-overlay">
      <div class="drop-overlay-content">
        <div style="font-size: 64px; margin-bottom: 16px;">📤</div>
        <h2>释放文件以上传</h2>
      </div>
    </div>

    <div class="drive-layout">
      <!-- 左侧文件夹树侧边栏（桌面端显示） -->
      <aside class="folder-sidebar" v-if="!isMobile">
        <FolderTree
          @create="openCreateFolderDialog"
          @navigate="onFolderNavigate"
          @rename="openRenameFolderDialog"
          @move="openMoveDialogForFolder"
        />
      </aside>

      <!-- 主内容区 -->
      <div class="drive-main">
        <div class="page-header">
          <h1>{{ folderStore.currentFolderName }}</h1>
          <p>管理您上传的所有文件，支持拖拽上传</p>
        </div>

        <FolderBreadcrumb @navigate="onFolderNavigate" />

        <div class="card">
      <!-- 主工具栏：视图切换 + 搜索（左）／上传（右） -->
      <div class="fl-toolbar">
        <div class="fl-toolbar-left">
          <t-radio-group
            :value="viewMode"
            variant="default-filled"
            size="medium"
            @change="onViewModeChange"
          >
            <t-radio-button value="card">
              <t-icon name="view-module" style="vertical-align: middle;" />
              <span style="margin-left: 4px;">卡片</span>
            </t-radio-button>
            <t-radio-button value="list">
              <t-icon name="view-list" style="vertical-align: middle;" />
              <span style="margin-left: 4px;">列表</span>
            </t-radio-button>
          </t-radio-group>
          <form autocomplete="off" class="fl-search-form" @submit.prevent="handleSearch">
            <t-input v-model="search" placeholder="搜索文件名..." class="search-input-field fl-search-input" autocomplete="off" name="q-file-search" @enter="handleSearch" />
            <t-button theme="default" @click="handleSearch">搜索</t-button>
            <t-button theme="default" variant="text" v-if="search" @click="handleClearSearch">清除</t-button>
          </form>
        </div>
        <div class="fl-toolbar-right">
          <t-button theme="primary" @click="showUploadModal = true">
            + 上传文件
          </t-button>
        </div>
      </div>

      <!-- 批量操作栏：仅在选中文件时出现 -->
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
        <t-button theme="default" variant="outline" size="small" @click="openBatchTagDialog">
          批量标签
        </t-button>
        <t-button theme="default" variant="outline" size="small" @click="openMoveDialogForFiles()">
          移动到...
        </t-button>
        <t-button theme="default" variant="text" size="small" @click="clearSelection">
          清除选择
        </t-button>
      </div>

      <!-- 标签筛选栏 -->
      <div
        :style="isMobile
          ? 'display: flex; gap: 4px; margin-bottom: 12px; flex-wrap: wrap; align-items: center; font-size: 12px;'
          : 'display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; align-items: center;'">
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
        <t-button v-if="selectedTagIds.length > 0" size="small" variant="text" @click="clearTagFilters">
          清除
        </t-button>
        <t-button size="small" variant="outline" @click="showTagManager = true">
          {{ (tagStore.tags && tagStore.tags.length > 0) || selectedTagIds.length > 0 ? '标签筛选' : '管理标签' }}
        </t-button>
      </div>

      <!-- Markdown 结果区域 -->
      <div v-if="markdownResult" style="margin-bottom: 16px; padding: 16px; background: var(--bg-secondary); border-radius: 8px; border: 1px solid var(--border-color);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span style="font-weight: 500;">Markdown 结果</span>
          <div style="display: flex; gap: 8px;">
            <t-button size="small" theme="primary" variant="outline" @click="copyMarkdown">复制</t-button>
            <t-button size="small" theme="default" variant="text" @click="markdownResult = ''">关闭</t-button>
          </div>
        </div>
        <t-input v-model="markdownResult" type="textarea" readonly :rows="6" autocomplete="off" />
      </div>

      <!-- 拖拽提示（空状态：当前文件夹下既无文件也无子文件夹） -->
      <div v-if="fileStore.files.length === 0 && subfoldersInCurrentFolder.length === 0 && !fileStore.loading && !cursorLoading"
        class="upload-zone"
        @click="showUploadModal = true"
      >
        <div style="font-size: 48px; margin-bottom: 16px;">📁</div>
        <h3>拖拽文件到此处，或点击上传</h3>
        <p style="color: var(--text-secondary); margin-top: 8px;">
          支持图片、PDF、ZIP 等格式，单文件最大限制见系统配置
        </p>
      </div>

      <t-loading v-if="fileStore.loading || cursorLoading" />
      <div v-else-if="displayFiles.length > 0 || subfoldersInCurrentFolder.length > 0">
        <!-- 卡片视图（默认）：响应式网格，桌面端 4-5 列，平板 3 列，手机 2 列 -->
        <div v-if="viewMode === 'card'" class="card-grid-view">
          <!-- 文件夹卡片 -->
          <FolderCard
            v-for="folder in subfoldersInCurrentFolder"
            :key="`folder-${folder.id}`"
            :folder="folder"
            :selectable="false"
            @dblclick="onFolderCardOpen"
            @open="onFolderCardOpen"
            @rename="onFolderCardRename"
            @move="onFolderCardMove"
            @delete="onFolderCardDelete"
          />
          <!-- 文件卡片 -->
          <FileCard
            v-for="file in displayFiles"
            :key="file.id"
            :file="file"
            :selected="selectedFileIds.includes(file.id)"
            :selectable="true"
            @toggle-select="onCardToggleSelect"
            @dblclick="onCardDownload"
            @download="onCardDownload"
            @share="onCardShare"
            @move="onCardMove"
            @tag="onCardTag"
            @delete="onCardDelete"
          />
        </div>

        <!-- 列表视图 -->
        <template v-else>
          <!-- 桌面端：现有表格 -->
          <t-table
            v-if="!isMobile"
            ref="tableRef"
            :data="displayFiles"
            :columns="columns"
            :row-class-name="getRowClassName"
            row-key="id"
            hover
            table-layout="auto"
          :selected-row-keys="selectedFileIds"
          :scroll="pageMode === 'infinite' ? { type: 'virtual', rowHeight: 56, bufferSize: 10, isFixedRowHeight: true } : undefined"
          :max-height="pageMode === 'infinite' ? 'calc(100vh - 280px)' : undefined"
          @select-change="handleSelectChange"
          @sort-change="handleSortChange"
        >
          <template #originalName="{ row }">
            <div style="display: flex; align-items: center; gap: 12px;">
              <ThumbnailImg :file-id="row.id" :mime-type="row.mimeType" :size="36" :emoji="getFileEmoji(row.mimeType)" />
              <div style="min-width: 0;">
                <span :class="{ 'deleted-name filename-text': row.isDeleted, 'filename-text': !row.isDeleted }">{{ row.originalName }}</span>
                <div style="margin-top: 2px;">
                  <t-tag v-if="row.status === 'error'" theme="danger" size="small">上传失败</t-tag>
                  <t-tag v-else-if="row.status === 'processing'" theme="primary" size="small">处理中</t-tag>
                  <t-tag v-else-if="row.isDeleted && row.deletedByAdmin" theme="danger" size="small">被管理员删除</t-tag>
                  <t-tag v-else-if="row.isDeleted" theme="warning" size="small">删除中</t-tag>
                  <span v-if="row.tags?.length" style="display: inline-flex; gap: 4px; margin-left: 4px;">
                    <span
                      v-for="tag in row.tags"
                      :key="tag.id"
                      style="cursor: pointer;"
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
                  </span>
                </div>
              </div>
            </div>
          </template>
          <template #size="{ row }">{{ formatSize(row.size) }}</template>
          <template #accessType="{ row }">
            <t-select
              v-if="isFileActionable(row)"
              :value="row.accessType"
              @change="(val: string) => handleAccessTypeChange(row.id, val)"
              :options="[
                { label: '公开', value: 'public' },
                { label: '私有', value: 'private' }
              ]"
              style="width: 100px;"
            />
            <span v-else-if="row.status === 'processing'" class="deleted-label">处理中</span>
            <span v-else class="deleted-label">删除中</span>
          </template>
          <template #password="{ row }">
            <t-button
              size="small"
              :theme="row.hasPassword ? 'warning' : 'default'"
              variant="outline"
              :disabled="!isFileActionable(row)"
              @click="openPasswordDialog(row)"
            >
              {{ row.hasPassword ? '🔒 已加密' : '🔓 未加密' }}
            </t-button>
          </template>
          <template #expiresIn="{ row }">
            <t-select
              :value="row.expiresIn"
              @change="(val: number | null) => handleExpiresChange(row.id, val)"
              :disabled="!isFileActionable(row)"
              :options="expiresOptions"
              style="width: 100px;"
            />
          </template>
          <template #maxAccessCount="{ row }">
            <t-input-number
              :value="row.maxAccessCount"
              :min="-1"
              :disabled="!isFileActionable(row)"
              @change="(val: number) => handleAccessCountChange(row.id, val)"
              style="width: 120px;"
            />
          </template>
          <template #createdAt="{ row }">
            <div>
              <div>{{ formatDate(row.createdAt) }}</div>
              <div v-if="row.isDeleted && row.deleteRequestedAt" style="font-size: 11px; color: var(--color-warning); margin-top: 2px;">
                删除于 {{ formatDate(row.deleteRequestedAt) }}
              </div>
            </div>
          </template>
          <template #operations="{ row }">
            <!-- 处理中状态：禁止所有操作 -->
            <template v-if="row.status === 'processing'">
              <span style="color: var(--text-placeholder); font-size: 12px;">处理中，请稍后...</span>
            </template>
            <!-- 已删除状态：显示恢复和强制删除 -->
            <template v-else-if="row.isDeleted">
              <t-button
                size="small"
                theme="success"
                variant="text"
                :disabled="row.deletedByAdmin && !isAdmin"
                @click="handleRestore(row.id)"
              >
                恢复
              </t-button>
              <t-button
                v-if="isAdmin"
                size="small"
                theme="danger"
                variant="text"
                @click="handleForceDelete(row.id)"
              >
                强制删除
              </t-button>
            </template>
            <!-- 正常状态：显示正常操作 -->
            <template v-else>
              <t-button size="small" theme="primary" variant="text" @click="copyLink(row)">复制链接</t-button>
              <t-button size="small" theme="default" variant="text" @click="downloadFile(row)">下载</t-button>
              <t-button size="small" variant="text" @click="openTagEditor(row)">标签</t-button>
              <t-button size="small" theme="danger" variant="text" @click="handleDelete(row)">删除</t-button>
            </template>
          </template>
        </t-table>

        <!-- 移动端：卡片列表 -->
        <div v-if="isMobile" class="mobile-card-list">
          <div v-for="file in displayFiles" :key="file.id" class="mobile-file-card">
            <div class="mobile-file-card-header">
              <ThumbnailImg :file-id="file.id" :mime-type="file.mimeType" :size="40" :emoji="getFileEmoji(file.mimeType)" />
              <div style="flex: 1; min-width: 0;">
                <div class="mobile-file-name" :class="{ 'deleted-name': file.isDeleted }">
                  {{ file.originalName }}
                </div>
                <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
                  {{ formatSize(file.size) }} · {{ formatDate(file.createdAt) }}
                </div>
                <div style="display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap;">
                  <t-tag v-if="file.isDeleted && file.deletedByAdmin" theme="danger" size="small">被管理员删除</t-tag>
                  <t-tag v-else-if="file.isDeleted" theme="warning" size="small">删除中</t-tag>
                  <t-tag v-else-if="file.accessType === 'public'" theme="success" size="small">公开</t-tag>
                  <t-tag v-else theme="default" size="small">私有</t-tag>
                  <t-tag v-if="file.hasPassword" theme="warning" size="small">已加密</t-tag>
                  <span
                    v-for="tag in file.tags?.slice(0, 2)"
                    :key="tag.id"
                    style="cursor: pointer;"
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
                  <span v-if="file.tags && file.tags.length > 2" style="font-size: 11px; color: var(--text-secondary);">
                    +{{ file.tags.length - 2 }}
                  </span>
                </div>
              </div>
            </div>
            <!-- 正常状态操作 -->
            <div v-if="!file.isDeleted" class="mobile-file-card-actions">
              <t-button size="small" theme="primary" variant="text" @click="copyLink(file)">复制</t-button>
              <t-button size="small" variant="text" @click="downloadFile(file)">下载</t-button>
              <t-button size="small" variant="text" @click="openTagEditor(file)">标签</t-button>
              <t-button size="small" theme="danger" variant="text" @click="handleDelete(file)">删除</t-button>
            </div>
            <!-- 已删除状态操作 -->
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
              <t-button
                v-if="isAdmin"
                size="small"
                theme="danger"
                variant="text"
                @click="handleForceDelete(file.id)"
              >
                强制删除
              </t-button>
            </div>
          </div>
        </div>
        </template>

        <div style="margin-top: 16px; display: flex; justify-content: center; align-items: center; gap: 16px;">
          <!-- 页面大小 / 模式切换 -->
          <t-select v-model="pageSize" :options="pageSizeOptions" style="width: 130px;" @change="handlePageSizeChange" />

          <!-- 传统分页 -->
          <t-pagination
            v-if="pageMode === 'paginated'"
            v-model="page"
            :total="fileStore.total"
            :page-size="Math.abs(pageSize)"
            :show-page-size="false"
            @change="handlePageChange"
          />

          <!-- 无限滚动加载指示器 -->
          <div v-else ref="scrollSentinel" style="text-align: center; padding: 8px 0;">
            <t-loading v-if="cursorLoading" size="small" text="加载中..." />
            <span v-else-if="!hasMore" style="color: var(--text-secondary);">已加载全部 {{ fileStore.total }} 个文件</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 上传弹窗 -->
    <UploadModal :visible="showUploadModal" :initial-files="dropFiles" @close="handleUploadModalClose" @uploaded="onUploaded" />

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
      <div style="margin-top: 8px; color: var(--text-secondary); font-size: 12px;">
        设置密码后，访问者需要输入密码才能查看该文件
      </div>
    </t-dialog>

    <!-- 删除确认弹窗 -->
    <t-dialog
      v-model:visible="deleteDialog.visible"
      header="确认删除文件"
      width="420px"
      @confirm="confirmDelete"
      @close="deleteDialog.visible = false"
    >
      <div style="line-height: 1.8;">
        <p>确定要删除文件 <strong>{{ deleteDialog.fileName }}</strong> 吗？</p>
        <div style="margin-top: 12px; padding: 12px; background: var(--bg-secondary); border-radius: 6px; font-size: 13px; color: var(--text-secondary);">
          <p style="margin-bottom: 8px;">⚙️ 删除说明：</p>
          <ul style="margin: 0; padding-left: 20px;">
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
      <div style="line-height: 1.8;">
        <p>为 <strong>{{ selectedFileIds.length }}</strong> 个文件添加标签：</p>
        <div style="margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px;">
          <t-tag
            v-for="tag in tagStore.tags"
            :key="tag.id"
            size="small"
            :theme="batchTagDialog.selectedTagIds.includes(tag.id) ? 'primary' : 'default'"
            variant="light"
            :style="{ cursor: 'pointer' }"
            @click="toggleBatchTag(tag.id)"
          >
            {{ tag.name }}
          </t-tag>
          <span v-if="!tagStore.tags || tagStore.tags.length === 0" style="color: var(--text-secondary); font-size: 13px;">
            暂无标签，请先在标签管理中创建
          </span>
        </div>
      </div>
    </t-dialog>

    <!-- 文件夹相关弹窗 -->
    <FolderCreateDialog
      v-model:visible="showCreateFolderDialog"
      :parent-id="folderStore.currentFolderId"
    />

    <FolderRenameDialog
      v-model:visible="showRenameFolderDialog"
      :folder="renameTargetFolder"
    />

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
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, reactive, watch, nextTick, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import MessagePlugin from '@/utils/message';
import { DialogPlugin } from 'tdesign-vue-next';
import { useFileStore } from '../../stores/files';
import { useAuthStore, api } from '../../stores/auth';
import { getErrorMessage } from '../../utils/error';
import { formatSize, formatDate, getFileEmoji } from '@/utils/format';
import { useCursorPagination } from '../../composables/useCursorPagination';
import { useMobile } from '../../composables/useMobile';
import UploadModal from '../../components/UploadModal.vue';
import TagManager from '../../components/TagManager.vue';
import FileTagEditor from '../../components/FileTagEditor.vue';
import ThumbnailImg from '../../components/ThumbnailImg.vue';
import FolderTree from '../../components/folder/FolderTree.vue';
import FolderBreadcrumb from '../../components/folder/FolderBreadcrumb.vue';
import FolderCreateDialog from '../../components/folder/FolderCreateDialog.vue';
import FolderRenameDialog from '../../components/folder/FolderRenameDialog.vue';
import FolderMoveDialog from '../../components/folder/FolderMoveDialog.vue';
import FileCard from '../../components/file/FileCard.vue';
import FolderCard from '../../components/file/FolderCard.vue';
import CreateShareDialog from '../../components/share/CreateShareDialog.vue';
import { useTagStore } from '../../stores/tags';
import { useFolderStore, type Folder } from '../../stores/folders';
import type { FileItem } from '../../types/file';

const fileStore = useFileStore();
const authStore = useAuthStore();
const tagStore = useTagStore();
const folderStore = useFolderStore();
const router = useRouter();
const route = useRoute();
const page = ref(Number(route.query.page) || 1);
const pageSize = ref(Number(route.query.pageSize) || 20);
const search = ref((route.query.search as string) || '');
const showUploadModal = ref(false);
const isDraggedOver = ref(false);
const markdownResult = ref('');
const selectedFileIds = ref<string[]>([]);
const dropFiles = ref<File[]>([]);
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

/** 把 folderStore.currentFolderId (null | uuid) 转换为 API 期望的字符串 */
const currentFolderIdForApi = computed(() => {
  return folderStore.currentFolderId === null
    ? 'root'
    : folderStore.currentFolderId;
});

/** 用户点击文件夹树节点或面包屑导航时触发 */
async function onFolderNavigate(folderId: string | null) {
  await folderStore.openFolder(folderId);
  // 清空选中状态，避免移动到旧文件夹的文件残留
  selectedFileIds.value = [];
  // 触发文件列表刷新
  if (pageMode.value === 'infinite') {
    resetCursor();
    fileStore.replaceFiles([]);
    loadInitialFiles(true);
  } else {
    page.value = 1;
    refetchFiles(1);
  }
}

function openCreateFolderDialog() {
  showCreateFolderDialog.value = true;
}

function openRenameFolderDialog(folder: Folder) {
  renameTargetFolder.value = folder;
  showRenameFolderDialog.value = true;
}

/**
 * 打开移动弹窗：移动单个文件夹（带循环检测的 disabledIds）
 */
function openMoveDialogForFolder(folder: Folder) {
  moveTargetKind.value = 'folder';
  moveTargetIds.value = [folder.id];
  // 禁止把文件夹移入自身或其子树：简单起见，disabledIds 包含 folder.id 和它的所有子级
  // 但前端只标记自身 ID，后端会再做严格循环检测
  moveDisabledIds.value = [folder.id];
  showMoveDialog.value = true;
}

/**
 * 打开移动弹窗：批量移动选中的文件
 */
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
  // 文件夹或文件移动后刷新文件列表（如果当前在某个文件夹，文件可能进出）
  if (pageMode.value === 'infinite') {
    resetCursor();
    fileStore.replaceFiles([]);
    loadInitialFiles(true);
  } else {
    refetchFiles();
  }
  selectedFileIds.value = [];
}

// ============ 视图模式：卡片 / 列表 ============
type ViewMode = 'card' | 'list';
const VIEW_MODE_STORAGE_KEY = 'drive_view_mode';
const viewMode = ref<ViewMode>(
  ((): ViewMode => {
    try {
      const stored = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
      return stored === 'list' ? 'list' : 'card'; // 默认卡片视图
    } catch {
      return 'card'; // localStorage 不可用（隐私模式/SSR）时降级为默认视图
    }
  })(),
);

function setViewMode(mode: ViewMode) {
  viewMode.value = mode;
  try { localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode); } catch { /* localStorage 不可用时降级 */ }
}

// 视图模式切换处理器（显式类型，避免模板内联 any 参数）
function onViewModeChange(val: string | number | boolean) {
  setViewMode(val === 'list' ? 'list' : 'card');
}

// ============ 卡片视图派生子文件夹列表 ============
/**
 * 当前文件夹下的直接子文件夹（基于 folderStore.tree 派生）。
 * 不走后端 listContents 接口，因为 tree 已经包含全部文件夹数据。
 * 卡片视图下与文件列表合并展示。
 */
const subfoldersInCurrentFolder = computed<Folder[]>(() => {
  const parentId = folderStore.currentFolderId;
  if (parentId === null) {
    // 根目录：返回所有顶层文件夹
    return folderStore.tree;
  }
  // 在树中递归查找当前 folder，返回其 children
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
  return current?.children ?? [];
});

// ============ 卡片视图操作 handler（复用现有函数） ============
function onCardDownload(file: FileItem) { downloadFile(file); }
function onCardShare(file: FileItem) {
  shareTargetType.value = 'file';
  shareTargetId.value = file.id;
  shareTargetName.value = file.originalName;
  showShareDialog.value = true;
}
function onCardMove(file: FileItem) { openMoveDialogForFiles([file.id]); }
function onCardTag(file: FileItem) { openTagEditor(file); }
function onCardDelete(file: FileItem) { handleDelete(file); }
function onCardToggleSelect(file: FileItem) {
  const idx = selectedFileIds.value.indexOf(file.id);
  if (idx >= 0) {
    selectedFileIds.value.splice(idx, 1);
  } else {
    selectedFileIds.value.push(file.id);
  }
}

/** 清空当前文件选择（批量操作栏「清除选择」按钮） */
function clearSelection() {
  selectedFileIds.value = [];
}

function onFolderCardOpen(folder: Folder) { onFolderNavigate(folder.id); }
function onFolderCardRename(folder: Folder) { openRenameFolderDialog(folder); }
function onFolderCardMove(folder: Folder) { openMoveDialogForFolder(folder); }

async function onFolderCardDelete(folder: Folder) {
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

// 分页模式：'paginated' | 'infinite'
const pageMode = ref<'paginated' | 'infinite'>(
  (route.query.mode as 'paginated' | 'infinite') || 'paginated'
);

// 游标无限滚动 composable
const {
  hasMore,
  loading: cursorLoading,
  loadMore,
  reset: resetCursor,
} = useCursorPagination<FileItem>();

// 滚动哨兵 ref
const scrollSentinel = ref<HTMLElement | null>(null);
const tableRef = ref();
let tableScrollEl: HTMLElement | null = null;
let scrollObserver: IntersectionObserver | null = null;

// pageSize 选项（含无限）
const pageSizeOptions = computed(() => [
  { label: '10 条/页', value: 10 },
  { label: '20 条/页', value: 20 },
  { label: '50 条/页', value: 50 },
  { label: '100 条/页', value: 100 },
  { label: '无限滚动', value: -1 },
]);

// 用于表格渲染的 files 计算属性
// 无限模式直接使用 fileStore.files（由 replaceFiles 设置），传统模式不变
const displayFiles = computed(() => fileStore.files);

const isAdmin = computed(() => {
  const role = authStore.user?.role || fileStore.currentUserRole;
  return role === 'admin' || role === 'super_admin';
});

const isMobile = useMobile();

// 同步当前用户角色到 fileStore
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
    if (pageMode.value === 'infinite') {
      resetCursor();
      fileStore.replaceFiles([]);
      loadInitialFiles(true);
    } else {
      refetchFiles(page.value, Math.abs(pageSize.value));
    }
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
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

async function handleExpiresChange(id: string, expiresIn: number | null) {
  try {
    await fileStore.updateExpires(id, expiresIn);
    MessagePlugin.success('有效期已更新');
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

let dragLeaveTimeout: ReturnType<typeof setTimeout> | null = null;
let dragCounter = 0;

function handleDragEnter(_e: DragEvent) {
  dragCounter++;
  isDraggedOver.value = true;
}

function handleDragLeave(_e: DragEvent) {
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    isDraggedOver.value = false;
  }
}

function handleDrop(e: DragEvent) {
  dragCounter = 0;
  isDraggedOver.value = false;
  if (dragLeaveTimeout) clearTimeout(dragLeaveTimeout);
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length > 0) {
    dropFiles.value = files;
    showUploadModal.value = true;
  }
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

/** 统一的重新获取文件列表 */
async function refetchFiles(pageNum?: number, pageSz?: number) {
  const p = pageNum ?? page.value;
  const ps = pageSz ?? Math.abs(pageSize.value);
  const tagIds = selectedTagIds.value.length > 0 ? selectedTagIds.value : undefined;
  await fileStore.fetchFiles(p, ps, search.value || undefined, sortBy.value || undefined, sortOrder.value || undefined, tagIds, currentFolderIdForApi.value);
}

function applyFilters() {
  if (pageMode.value === 'infinite') {
    resetCursor();
    loadInitialFiles(true);
  } else {
    page.value = 1;
    refetchFiles(1);
  }
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
}

function onUploaded() {
  if (pageMode.value === 'infinite') {
    resetCursor();
    fileStore.replaceFiles([]);
    loadInitialFiles(true);
  } else {
    refetchFiles(page.value, Math.abs(pageSize.value));
  }
  selectedFileIds.value = [];
}

function handleSelectChange(selectedRowKeys: (string | number)[]) {
  selectedFileIds.value = selectedRowKeys.filter(k =>
    displayFiles.value.find(f => f.id === k && !f.isDeleted)
  ) as string[];
}

function handleSearch() {
  page.value = 1;
  if (pageMode.value === 'infinite') {
    resetCursor();
    fileStore.replaceFiles([]);
    loadInitialFiles(true);
  } else {
    refetchFiles(1);
  }
}

function handleClearSearch() {
  search.value = '';
  page.value = 1;
  if (pageMode.value === 'infinite') {
    resetCursor();
    fileStore.replaceFiles([]);
    loadInitialFiles(true);
  } else {
    refetchFiles(1);
  }
}

function handleSortChange(sortInfo: { sortBy: string; descending: boolean } | { sortBy: string; descending: boolean }[]) {
  const info = Array.isArray(sortInfo) ? sortInfo[0] : sortInfo;
  if (!info) return;
  sortBy.value = info.sortBy;
  sortOrder.value = info.descending ? 'DESC' : 'ASC';
  // 排序时切换到传统分页模式（游标分页固定按 createdAt DESC 排序）
  if (pageMode.value === 'infinite') {
    pageMode.value = 'paginated';
    pageSize.value = 20;
    resetCursor();
  }
  page.value = 1;
  refetchFiles(1);
}

// ==== 无限滚动加载逻辑 ====

/** 初始化 / 搜索 / 排序变化时加载文件列表 */
async function loadInitialFiles(resetCursorState = false) {
  const tagIds = selectedTagIds.value.length > 0 ? selectedTagIds.value : undefined;
  if (pageMode.value === 'paginated') {
    await fileStore.fetchFiles(page.value, Math.abs(pageSize.value), search.value || undefined, sortBy.value || undefined, sortOrder.value || undefined, tagIds, currentFolderIdForApi.value);
  } else {
    // 无限模式：使用游标分页
    if (resetCursorState) {
      resetCursor();
      fileStore.replaceFiles([]);
    }
    await loadMore(async (cursor, signal) => {
      const result = await fileStore.fetchFilesCursor(
        20,
        search.value || undefined,
        cursor,
        tagIds,
        signal,
        currentFolderIdForApi.value,
      );
      if (!result) return { data: [], nextCursor: null, hasMore: false };

      fileStore.replaceFiles([...fileStore.files, ...result.files]);
      return {
        data: result.files,
        nextCursor: result.nextCursor,
        hasMore: result.nextCursor !== null,
      };
    });
  }
}

/** 加载更多（无限模式下 IntersectionObserver 触发） */
async function loadMoreFiles() {
  if (!hasMore.value || cursorLoading.value) return;
  await loadMore(async (cursor, signal) => {
    const result = await fileStore.fetchFilesCursor(
      20,
      search.value || undefined,
      cursor,
      selectedTagIds.value.length > 0 ? selectedTagIds.value : undefined,
      signal,
      currentFolderIdForApi.value,
    );
    if (!result) return { data: [], nextCursor: null, hasMore: false };

    fileStore.replaceFiles([...fileStore.files, ...result.files]);
    return {
      data: result.files,
      nextCursor: result.nextCursor,
      hasMore: result.nextCursor !== null,
    };
  });
}

/** 表格内部滚动事件处理（虚拟滚动模式下触发加载更多） */
function onTableScroll() {
  if (!tableScrollEl) return;
  const { scrollTop, scrollHeight, clientHeight } = tableScrollEl;
  if (scrollHeight - scrollTop - clientHeight < 200) {
    loadMoreFiles();
  }
}

/** 设置滚动监听：优先使用表格内部滚动容器（虚拟滚动模式），降级为 IntersectionObserver */
function setupScrollObserver() {
  // 清理之前的监听
  if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }
  if (tableScrollEl) {
    tableScrollEl.removeEventListener('scroll', onTableScroll);
    tableScrollEl = null;
  }

  if (pageMode.value !== 'infinite') return;
  if (!scrollSentinel.value) return;

  // 尝试获取表格内部滚动容器（虚拟滚动模式下存在）
  const tableEl = (tableRef.value as any)?.$el as HTMLElement | undefined;
  if (tableEl) {
    tableScrollEl = tableEl.querySelector('.t-table__content');
  }

  if (tableScrollEl) {
    // 虚拟滚动模式：监听表格内部滚动
    tableScrollEl.addEventListener('scroll', onTableScroll, { passive: true });
  } else {
    // 降级模式：IntersectionObserver 监听哨兵元素
    scrollObserver = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMoreFiles();
        }
      },
      { rootMargin: '600px' },
    );
    scrollObserver.observe(scrollSentinel.value);
  }
}

function handlePageChange(pageInfo: { current: number }) {
  refetchFiles(pageInfo.current);
}

function handlePageSizeChange(val: number) {
  selectedFileIds.value = [];
  if (val === -1) {
    // 切换到无限模式
    pageMode.value = 'infinite';
    page.value = 1;
    resetCursor();
    fileStore.replaceFiles([]);
    loadInitialFiles(true);
    nextTick(setupScrollObserver);
  } else {
    // 切换到传统分页
    pageMode.value = 'paginated';
    page.value = 1;
    pageSize.value = val;
    refetchFiles(1, val);
  }
}

const columns = [
  { colKey: 'row-select', type: 'multiple' as const, width: '50' },
  { colKey: 'originalName', title: '文件名', width: '260', ellipsis: true, sorter: true },
  { colKey: 'size', title: '大小', width: '90' },
  { colKey: 'accessType', title: '访问权限', width: '110' },
  { colKey: 'password', title: '加密', width: '110' },
  { colKey: 'maxAccessCount', title: '访问次数', width: '110' },
  { colKey: 'expiresIn', title: '限时访问', width: '110' },
  { colKey: 'createdAt', title: '上传时间', width: '160', sorter: true },
  { colKey: 'operations', title: '操作', width: '220' },
];

async function handleAccessTypeChange(id: string, accessType: string) {
  try {
    await fileStore.updateAccessType(id, accessType);
    MessagePlugin.success('更新成功');
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

async function handleAccessCountChange(id: string, maxAccessCount: number) {
  try {
    await fileStore.updateAccessCount(id, maxAccessCount);
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

async function downloadFile(row: Pick<FileItem, 'id'>) {
  try {
    const response = await api.get(`/files/${row.id}/download`, { responseType: 'blob' });
    const url = window.URL.createObjectURL(new Blob([response.data]));
    const link = document.createElement('a');
    link.href = url;
    const disposition = response.headers['content-disposition'];
    let filename = `file-${row.id}`;
    if (disposition) {
      const match = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
      if (match?.[1]) {
        filename = decodeURIComponent(match[1].replace(/['"]/g, ''));
      }
    }
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  } catch (error: unknown) {
    MessagePlugin.error('下载失败：' + getErrorMessage(error));
  }
}

/** 点击删除按钮 → 弹出确认对话框 */
function handleDelete(row: FileItem) {
  openDeleteDialog(row);
}

/** 确认删除 */
async function confirmDelete() {
  try {
    const result = await fileStore.deleteFile(deleteDialog.fileId);
    if (result.status === 'permanently_deleted') {
      MessagePlugin.success('文件已永久删除');
    } else if (result.status === 'already_deleted') {
      const scheduledDate = result.scheduledAt
        ? formatDate(result.scheduledAt)
        : '7天后';
      MessagePlugin.warning(`文件已处于待删除状态，将于 ${scheduledDate} 永久删除`);
    } else {
      const scheduledDate = result.scheduledAt
        ? formatDate(result.scheduledAt)
        : '7天后';
      MessagePlugin.success(`文件已标记为待删除，将于 ${scheduledDate} 永久删除，期间可恢复`);
    }
    deleteDialog.visible = false;
    if (pageMode.value === 'infinite') {
      resetCursor();
      fileStore.replaceFiles([]);
      loadInitialFiles(true);
    } else {
      await refetchFiles(page.value, Math.abs(pageSize.value));
    }
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

/** 恢复已删除的文件 */
async function handleRestore(id: string) {
  try {
    await fileStore.restoreFile(id);
    MessagePlugin.success('文件已恢复');
    if (pageMode.value === 'infinite') {
      resetCursor();
      fileStore.replaceFiles([]);
      loadInitialFiles(true);
    } else {
      await refetchFiles(page.value, Math.abs(pageSize.value));
    }
  } catch (error: unknown) {
    MessagePlugin.error(getErrorMessage(error));
  }
}

/** 管理员强制永久删除 */
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

  const baseUrl = window.location.origin;
  markdownResult.value = selectedImages.value
    .map((img) => `![${img.originalName}](${baseUrl}/files/public/${img.id})`)
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
  // 并发发送标签更新请求（替代串行 for...of + await），大幅缩短批量操作耗时
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

// 同步分页、搜索、排序、标签到 URL 查询参数
watch([page, pageSize, search, sortBy, sortOrder, pageMode, selectedTagIds], ([newPage, newPageSize, newSearch, newSortBy, newSortOrder, newMode, newTagIds]) => {
  const query: Record<string, string> = {};
  if (newMode === 'paginated') {
    if (newPage > 1) query.page = String(newPage);
    if (newPageSize !== 20 && newPageSize > 0) query.pageSize = String(newPageSize);
  } else {
    query.mode = 'infinite';
  }
  if (newSearch) query.search = newSearch;
  if (newSortBy) query.sortBy = newSortBy;
  if (newSortOrder) query.sortOrder = newSortOrder;
  if (newTagIds && newTagIds.length > 0) query.tagIds = newTagIds.join(',');
  router.replace({ query });
}, { flush: 'post' });

onMounted(async () => {
  try { await tagStore.fetchTags(); } catch { /* 标签加载失败不阻塞页面 */ }
  try { await folderStore.fetchTree(); } catch { /* 文件夹树加载失败不阻塞页面 */ }

  try {
    if (pageMode.value === 'infinite' || route.query.mode === 'infinite') {
      pageMode.value = 'infinite';
      pageSize.value = -1;
      await loadInitialFiles(true);
      nextTick(setupScrollObserver);
    } else {
      await refetchFiles(page.value, Math.abs(pageSize.value));
    }
  } catch {
    // 初始加载失败保留空列表，用户可手动刷新
  }
});

onUnmounted(() => {
  if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }
  if (tableScrollEl) { tableScrollEl.removeEventListener('scroll', onTableScroll); tableScrollEl = null; }
  if (dragLeaveTimeout) { clearTimeout(dragLeaveTimeout); dragLeaveTimeout = null; }
  dragCounter = 0;
});
</script>

<style scoped>
/* 卡片网格视图（响应式自适应列数） */
.card-grid-view {
  display: grid;
  /* 桌面端：minmax(180px, 1fr) → 宽屏 5+ 列，普通桌面 4 列
     平板：minmax(160px, 1fr) → 3 列
     手机：minmax(140px, 1fr) → 2 列
     全部通过 auto-fill + minmax 自动适配，无需 media query */
  grid-template-columns: repeat(auto-fill, minmax(min(180px, 100%), 1fr));
  gap: 16px;
  padding: 4px 0 16px;
}

@media (max-width: 768px) {
  .card-grid-view {
    grid-template-columns: repeat(auto-fill, minmax(min(140px, 100%), 1fr));
    gap: 12px;
  }
}

@media (min-width: 1200px) {
  .card-grid-view {
    /* 宽屏上限制单卡最大宽度，避免过宽 */
    grid-template-columns: repeat(auto-fill, minmax(180px, 220px));
    justify-content: start;
  }
}

/* 网盘布局：左侧文件夹树 + 右侧主内容区 */
.drive-layout {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  min-height: 0;
}

.folder-sidebar {
  width: 220px;
  flex-shrink: 0;
  background: var(--bg-secondary, var(--td-bg-color-container));
  border: 1px solid var(--border-color, var(--td-border-level-2-color));
  border-radius: 8px;
  position: sticky;
  top: 16px;
  max-height: calc(100vh - 32px);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.drive-main {
  flex: 1;
  min-width: 0;
}

/* 主工具栏 */
.fl-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 16px;
}
.fl-toolbar-left {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.fl-search-form {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  flex-wrap: wrap;
}
.fl-search-input {
  width: 280px;
}
.fl-toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 批量操作栏（选中文件时出现） */
.fl-batchbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 12px;
  margin-bottom: 16px;
  background: var(--color-accent-soft, rgba(77, 124, 254, 0.08));
  border: 1px solid var(--color-accent, #4D7CFE);
  border-radius: 8px;
}
.fl-batchbar-count {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-accent, #4D7CFE);
  margin-right: 4px;
}

.drop-overlay {
  position: absolute;
  inset: 0;
  background: rgba(77, 124, 254, 0.12);
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

.drop-overlay-content h2 {
  font-family: var(--font-display);
  font-size: 24px;
  font-weight: 600;
}

.deleted-name {
  text-decoration: line-through;
  opacity: 0.6;
}

.deleted-label {
  color: var(--text-tertiary);
  font-size: 13px;
  font-style: italic;
}

.filename-text {
  display: block;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.row-deleted) {
  background: rgba(255, 255, 255, 0.02);
  opacity: 0.85;
}

:deep(.row-processing) {
  background: var(--color-accent-soft);
  opacity: 0.9;
}

@media (max-width: 768px) {
  .search-input-field {
    width: 100% !important;
  }

  .mobile-file-card {
    background: var(--color-bg-surface);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    padding: 14px;
    margin-bottom: 10px;
    transition: border-color var(--duration-fast), box-shadow var(--duration-fast);
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

  .mobile-file-name {
    font-weight: 500;
    word-break: break-all;
    line-height: 1.4;
    font-size: 14px;
  }

  .mobile-file-card-actions {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    border-top: 1px solid var(--border-color);
    padding-top: 8px;
  }
}
</style>
