<template>
  <t-dialog
    v-model:visible="dialogVisible"
    header="上传文件"
    :width="isMobile ? '100%' : '560px'"
    :footer="false"
    @close="handleClose"
    destroy-on-close
  >
    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
      <span style="font-size: 14px; color: var(--text-secondary);">同时上传文件数：</span>
      <t-select
        :value="uploadStore.fileConcurrency"
        :options="concurrencyOptions"
        style="width: 80px;"
        size="small"
        @change="handleConcurrencyChange"
      />
    </div>

    <!-- 标签选择 -->
    <div style="margin-bottom: 12px;">
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
        <span style="font-size: 12px; color: var(--text-secondary);">上传时添加标签：</span>
        <t-button size="small" variant="text" @click="showTagSelector = !showTagSelector">
          {{ selectedTagIds.length > 0 ? `已选 ${selectedTagIds.length} 个标签` : (tagStore.tags?.length ? '选择标签' : '新建标签') }}
        </t-button>
      </div>
      <div v-if="showTagSelector" style="padding: 8px; background: var(--bg-secondary); border-radius: 6px; border: 1px solid var(--border-color);">
        <!-- 已有标签选择 -->
        <div v-if="tagStore.tags && tagStore.tags.length > 0" style="display: flex; gap: 6px; flex-wrap: wrap;">
          <t-tag
            v-for="tag in tagStore.tags"
            :key="tag.id"
            :theme="selectedTagIds.includes(tag.id) ? 'primary' : 'default'"
            :variant="selectedTagIds.includes(tag.id) ? 'dark' : 'outline'"
            style="cursor: pointer;"
            @click="toggleTag(tag.id)"
          >
            <span :style="{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: tag.color, marginRight: '4px' }" />
            {{ tag.name }}
          </t-tag>
        </div>
        <!-- 在已有标签下方/独立区域：新建标签 -->
        <div style="display: flex; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border-color);">
          <t-input
            v-model="newTagName"
            placeholder="新建标签名称"
            size="small"
            style="flex: 1; min-width: 0;"
            autocomplete="off"
            name="upload-tag-name"
          />
          <t-button size="small" theme="primary" :disabled="!newTagName.trim()" @click="handleCreateTag">
            新建
          </t-button>
        </div>
      </div>
    </div>
    <div
      class="upload-zone"
      :class="{ dragover: isDragover }"
      @dragover.prevent="isDragover = true"
      @dragleave="isDragover = false"
      @drop.prevent="handleDrop"
      @click="triggerInput"
    >
      <input
        ref="fileInput"
        type="file"
        multiple
        :accept="acceptTypes"
        @change="handleFileSelect"
        style="display: none;"
      />
      <!-- 隐藏文件夹选择器（webkitdirectory 为非标准属性，主流桌面浏览器均支持） -->
      <input
        ref="folderInput"
        type="file"
        multiple
        webkitdirectory
        @change="handleFolderSelect"
        style="display: none;"
      />
      <div style="margin-bottom: 16px;">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 16V4M8 8l4-4 4 4" />
          <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
        </svg>
      </div>
      <h3>拖拽文件或文件夹到此处，或点击选择</h3>
      <p style="color: var(--text-secondary); margin-top: 8px;">
        单文件最大 {{ maxFileSizeMB }}MB，支持图片、PDF、ZIP 等格式；上传进行中可继续追加文件或文件夹
      </p>
      <div style="display: flex; gap: 8px; justify-content: center; margin-top: 12px;">
        <t-button size="small" variant="outline" theme="primary" @click.stop="triggerInput">
          选择文件
        </t-button>
        <t-button size="small" variant="outline" :disabled="preparing" @click.stop="triggerFolderInput">
          选择文件夹
        </t-button>
      </div>
      <div v-if="preparingMsg" style="margin-top: 8px; font-size: 12px; color: var(--text-secondary);">
        {{ preparingMsg }}
      </div>
    </div>

    <!-- 上传队列（读取全局 upload store，关闭弹窗后上传继续在后台进行） -->
    <div v-if="uploadStore.entries.length > 0" style="margin-top: 16px;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
        <div style="font-size: 12px; color: var(--text-secondary);">
          总进度 {{ uploadStore.overallProgress }}%
          <template v-if="hasActiveUploads"> · {{ uploadStore.overallSpeed }}</template>
          <template v-if="uploadStore.activeCount > 0"> · 进行中 {{ uploadStore.activeCount }}</template>
          <template v-if="uploadStore.queuedCount > 0"> · 排队 {{ uploadStore.queuedCount }}</template>
        </div>
        <t-button v-if="finishedCount > 0" size="small" variant="text" @click="uploadStore.clearFinished()">
          清除已完成
        </t-button>
      </div>
      <t-progress :percentage="uploadStore.overallProgress" size="small" style="margin-bottom: 12px;" />

      <div v-for="item in uploadStore.entries" :key="item.uid"
        style="padding: 12px; background: var(--bg-secondary); border-radius: 8px; margin-bottom: 8px; border: 1px solid var(--border-color);">
        <div style="display: flex; align-items: center; gap: 12px;">
          <img v-if="item.file && item.file.type.startsWith('image/')" :src="uploadStore.getPreviewUrl(item.file)" loading="lazy" style="width: 32px; height: 32px; object-fit: cover; border-radius: 4px; flex-shrink: 0;" />
          <FileTypeIcon v-else :mimeType="item.file?.type" :fileName="item.fileName" :size="20" />
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ item.fileName }}</div>
            <!-- 文件夹上传：文件名下方展示所属目录（次要色小字） -->
            <div v-if="item.relativePath"
              style="font-size: 12px; color: var(--text-tertiary); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
              {{ item.relativePath }}
            </div>
            <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
              {{ formatModalSize(item.totalBytes) }}
              <t-tag v-if="item.status === 'success'" theme="success" size="small" variant="light">成功</t-tag>
              <t-tag v-else-if="item.status === 'error'" theme="danger" size="small" variant="light">失败</t-tag>
              <t-tag v-else-if="item.status === 'cancelled'" theme="default" size="small" variant="light">已取消</t-tag>
              <t-tag v-else-if="item.status === 'processing' && (item.retryCount ?? 0) > 0" theme="warning" size="small" variant="light">自动重试中 ({{ item.retryCount }}/2)</t-tag>
              <t-tag v-else-if="item.status === 'processing'" theme="warning" size="small" variant="light">处理中</t-tag>
              <t-tag v-else-if="item.progress > 0" theme="primary" size="small" variant="light">{{ item.progress }}%</t-tag>
              <t-tag v-else theme="primary" size="small" variant="light">等待</t-tag>
            </div>
          </div>
          <t-button
            v-if="item.status === 'pending' || item.status === 'processing'"
            size="small"
            variant="text"
            shape="square"
            :aria-label="`取消上传 ${item.fileName}`"
            @click="uploadStore.cancelOne(item.uid)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </t-button>
        </div>
        <div v-if="item.progress > 0 && item.status !== 'success' && item.status !== 'error' && item.status !== 'cancelled'" style="margin-top: 8px;">
          <t-progress :percentage="item.progress" size="small" />
          <div style="display: flex; gap: 16px; margin-top: 4px; font-size: 12px; color: var(--text-secondary);">
            <span>{{ item.speed }}</span>
            <span>剩余 {{ item.eta }}</span>
          </div>
        </div>
        <div v-if="item.status === 'error' && item.errorReason" style="margin-top: 8px; font-size: 12px; color: var(--error);">
          {{ item.errorReason }}
        </div>
      </div>
    </div>

    <!-- 全部终态后的汇总提示（等价于原 batchResult 展示） -->
    <div v-if="allFinished" style="margin-top: 16px;">
      <t-tag v-if="failedEntries.length === 0" theme="success">
        全部 {{ successCount }} 个文件已接收，正在后台处理中...
      </t-tag>
      <t-tag v-else theme="warning">
        {{ successCount }} 个成功，{{ failedEntries.length }} 个失败<template v-if="cancelledCount > 0">，{{ cancelledCount }} 个已取消</template>
      </t-tag>

      <div v-if="failedEntries.length > 0" style="margin-top: 12px;">
        <div v-for="item in failedEntries" :key="'fail-' + item.uid"
          style="padding: 8px 12px; background: var(--bg-secondary); border-radius: 8px; margin-bottom: 8px; border: 1px solid var(--border-color);">
          <span style="color: var(--error); display: inline-flex;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <path d="M15 9l-6 6M9 9l6 6" />
            </svg>
          </span>
          <span style="margin-left: 8px; font-weight: 500;">{{ item.fileName }}</span>
          <span style="margin-left: 8px; color: var(--text-secondary);">{{ item.errorReason }}</span>
        </div>
      </div>

      <div style="margin-top: 16px; display: flex; gap: 8px; justify-content: flex-end;">
        <t-button variant="outline" @click="uploadStore.clearFinished()">
          清除已完成
        </t-button>
        <t-button theme="primary" @click="handleClose">
          完成
        </t-button>
      </div>
    </div>
  </t-dialog>

  <!-- 文件夹上传重复文件覆盖/跳过决策弹窗 -->
  <ConflictResolveDialog
    :visible="showConflictDialog"
    :conflicts="pendingConflict.conflicts"
    @confirm="handleConflictConfirm"
    @cancel="handleConflictCancel"
  />
</template>

<script setup lang="ts">
import { ref, computed, watch, reactive } from 'vue';
import MessagePlugin from '@/utils/message';
import { useTagStore } from '../stores/tags';
import { useUploadStore } from '../stores/upload';
import { api } from '../stores/auth';
import { useMobile } from '../composables/useMobile';
import { formatSize as formatModalSize } from '../utils/format';
import { getErrorMessage } from '../utils/error';
import { reportUploadError } from '../utils/telemetry';
import FileTypeIcon from '@/components/FileTypeIcon.vue';
import ConflictResolveDialog from '@/components/ConflictResolveDialog.vue';
// 文件夹上传工具链：采集 → 路径校验 → 目录预创建/复用 → 重复检测
import { collectFromInput, collectFromDrop, validateParsedFiles } from '../utils/folder-traverse';
import type { ParsedFile, PathViolation, DropCollectResult } from '../utils/folder-traverse';
import { prepareDirectories } from '../utils/folder-resolver';
import { detectConflicts } from '../utils/conflict-detector';
import type { UploadCandidateItem, ConflictItem, ConflictDecisionEntry } from '../utils/conflict-detector';

const isMobile = useMobile();

const props = defineProps<{
  visible: boolean;
  initialFiles?: File[];
  folderId?: string | null;
  /** 页面级拖拽采集结果（由宿主页面 collectFromDrop 后转发，避免重复入队） */
  initialDropResult?: DropCollectResult | null;
}>();
const emit = defineEmits<{
  close: [];
  uploaded: [];
}>();

// 弹窗双向绑定代理（重命名避免与 props.visible 遮蔽混淆）
const dialogVisible = computed({
  get: () => props.visible,
  set: (val) => { if (!val) emit('close'); },
});

const uploadStore = useUploadStore();
const tagStore = useTagStore();

const maxFileSizeBytes = ref(20 * 1024 * 1024);
const maxFileSizeMB = ref(20);
const acceptTypes = ref('');
const fileTypeMode = ref<'blacklist' | 'whitelist'>('blacklist');

const fileInput = ref<HTMLInputElement>();
const folderInput = ref<HTMLInputElement>();
const isDragover = ref(false);
/** 目录预创建进行中（防重复触发 + 按钮禁用） */
const preparing = ref(false);
/** 目录准备进度文案（prepareDirectories onProgress 驱动） */
const preparingMsg = ref('');
const selectedTagIds = ref<string[]>([]);
const showTagSelector = ref(false);
const newTagName = ref('');
const concurrencyOptions = Array.from({ length: 4 }, (_, i) => ({ label: `${i + 1}`, value: i + 1 }));

// ---- 重复文件决策弹窗状态（仅文件夹链路） ----
const showConflictDialog = ref(false);
/** 待决批次：无冲突项 + 决策前快照的 tagIds/batchId，确认后统一入队 */
const pendingConflict = reactive({
  items: [] as UploadCandidateItem[],
  tagIds: [] as string[],
  batchId: '',
  conflicts: [] as ConflictItem[],
});

// ---- store 汇总派生状态（替代原 batchResult） ----
const hasActiveUploads = computed(
  () => uploadStore.isPumping || uploadStore.activeCount > 0 || uploadStore.queuedCount > 0,
);
const successCount = computed(() => uploadStore.entries.filter((e) => e.status === 'success').length);
const failedEntries = computed(() => uploadStore.entries.filter((e) => e.status === 'error'));
const cancelledCount = computed(() => uploadStore.entries.filter((e) => e.status === 'cancelled').length);
const finishedCount = computed(() => successCount.value + failedEntries.value.length + cancelledCount.value);
const allFinished = computed(() => uploadStore.entries.length > 0 && !hasActiveUploads.value);

// 每个文件上传成功即通知宿主刷新列表（store 后台异步完成，无法再用批量返回时机）
watch(successCount, (cur, old) => {
  if (cur > (old ?? 0)) emit('uploaded');
});

// 全部终态时给出与原 batchResult 完成提示等价的消息（仅状态翻转时触发一次）
watch(allFinished, (done, was) => {
  if (!done || was) return;
  if (failedEntries.value.length === 0) {
    MessagePlugin.success('文件接收完成，正在后台处理中，请稍后刷新查看');
  } else if (successCount.value > 0) {
    MessagePlugin.success(`${successCount.value} 个文件已接收，${failedEntries.value.length} 个失败。正在后台处理中`);
  }
});

function handleConcurrencyChange(value: unknown) {
  uploadStore.setFileConcurrency(Number(value));
}

function toggleTag(tagId: string) {
  const idx = selectedTagIds.value.indexOf(tagId);
  if (idx === -1) {
    selectedTagIds.value.push(tagId);
  } else {
    selectedTagIds.value.splice(idx, 1);
  }
}

async function handleCreateTag() {
  const name = newTagName.value.trim();
  if (!name) return;
  try {
    const tag = await tagStore.createTag(name);
    selectedTagIds.value = [...selectedTagIds.value, tag.id];
    newTagName.value = '';
  } catch (err) {
    MessagePlugin.error(getErrorMessage(err) || '创建标签失败');
  }
}

/**
 * 关闭弹窗仅收起 UI：上传调度已迁至模块级 upload store，
 * 不再 abort / resetQueue，上传继续在后台进行（由全局指示器展示进度）。
 */
function handleClose() {
  emit('close');
}

/** 校验单个文件是否匹配 acceptTypes 规则（MIME 精确 / image/* 前缀 / .ext 后缀） */
function matchesAcceptTypes(file: File): boolean {
  const accept = acceptTypes.value;
  if (!accept) return true; // 黑名单或未配置模式：前端不限制类型，交由后端校验
  const fileName = file.name.toLowerCase();
  const mime = file.type.toLowerCase();
  return accept.split(',').some((rule) => {
    const r = rule.trim().toLowerCase();
    if (!r) return true;
    if (r.endsWith('/*')) return mime.startsWith(r.slice(0, -1)); // 'image/*' → 'image/'
    if (r.startsWith('.')) return fileName.endsWith(r);           // '.pdf'
    return mime === r;                                            // 'application/pdf'
  });
}

function validateFiles(files: File[]): File[] {
  return files.filter((f) => {
    if (f.size > maxFileSizeBytes.value) {
      MessagePlugin.warning(`文件 "${f.name}" 超过 ${maxFileSizeMB.value}MB 限制，已跳过`);
      reportUploadError({
        stage: 'validation_size',
        message: `文件超过 ${maxFileSizeMB.value}MB 限制`,
        fileName: f.name,
        fileSize: f.size,
        mimeType: f.type,
      });
      return false;
    }
    // 白名单模式下前端同步校验类型，避免 accept 属性被绕过
    if (fileTypeMode.value === 'whitelist' && !matchesAcceptTypes(f)) {
      MessagePlugin.warning(`文件 "${f.name}" 类型不受支持，已跳过`);
      reportUploadError({
        stage: 'validation_type',
        message: '文件类型不受支持',
        fileName: f.name,
        fileSize: f.size,
        mimeType: f.type,
      });
      return false;
    }
    return true;
  });
}

/**
 * 追加式入队：校验通过后交给全局 upload store。
 * 上传进行中可重复调用（无 uploading 守卫），store 按 File 引用去重。
 * 标签在入队时快照到条目，后续修改选择不影响已入队文件。
 */
function enqueueFiles(files: File[]) {
  const validated = validateFiles(files);
  if (validated.length === 0) return;
  uploadStore.enqueue(validated, props.folderId ?? null, selectedTagIds.value);
}

// ---- 文件夹上传链路 ----

/** 生成文件夹上传批次 ID（同一次选择/拖拽共享） */
function genBatchId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 文件夹链路公共处理：路径校验（违规整批阻止）→ 大小/类型校验（复用现有逻辑）
 * → prepareDirectories 预创建/复用目录 → 携带最终 folderId 入队。
 * handleFolderSelect / handleDrop / 页面拖拽转发 三个入口共用。
 */
async function processParsedFiles(
  parsed: ParsedFile[],
  emptyDirs: string[],
  violations?: PathViolation[],
) {
  // 准备中防重复触发
  if (preparing.value) {
    MessagePlugin.warning('正在准备目录，请稍候');
    return;
  }
  if (parsed.length === 0) {
    if (emptyDirs.length > 0) MessagePlugin.info('空文件夹不会被上传');
    return;
  }

  // 1. 路径校验：存在非法段（如 '..'/保留名/非法字符）时整批阻止
  const bad = violations ?? validateParsedFiles(parsed);
  if (bad.length > 0) {
    const v = bad[0];
    MessagePlugin.error(`文件夹路径非法："${v.relativePath}" — ${v.reason}（共影响 ${bad.length} 个文件，已阻止本批上传）`);
    return;
  }

  // 2. 复用现有大小/类型校验（逐文件提示并跳过）
  const validFiles = validateFiles(parsed.map((p) => p.file));
  if (validFiles.length === 0) return;
  const validSet = new Set(validFiles);
  const validParsed = parsed.filter((p) => validSet.has(p.file));

  if (emptyDirs.length > 0) MessagePlugin.info('空文件夹不会被上传');

  // 3. 预创建/复用目录（onProgress 驱动局部提示；不占上传令牌池）
  const baseParentId = props.folderId ?? null;
  preparing.value = true;
  preparingMsg.value = '正在准备目录…';
  try {
    const { dirIdMap, reusedCount } = await prepareDirectories(
      baseParentId,
      validParsed,
      (msg) => { preparingMsg.value = msg; },
    );
    if (reusedCount > 0) MessagePlugin.info(`${reusedCount} 个已存在目录将直接复用`);

    // 4. 生成 {file, folderId, relativePath} 候选（根级文件映射回当前目录）
    const items = validParsed.map((p) => ({
      file: p.file,
      folderId: p.relativePath ? (dirIdMap.get(p.relativePath) ?? baseParentId) : baseParentId,
      relativePath: p.relativePath,
    }));

    // 5. 重复检测（复用 folder contents 查询；独立限流，不占上传令牌池）
    const { conflicts, clean, blockedCount } = await detectConflicts(items);
    if (blockedCount > 0) {
      MessagePlugin.info(`${blockedCount} 个既有文件处理中，将按新文件上传`);
    }
    if (conflicts.length === 0) {
      uploadStore.enqueueFolderFiles(clean, selectedTagIds.value, genBatchId());
    } else {
      // 有冲突：暂存待决批次，交由决策弹窗；确认后再入队
      pendingConflict.items = clean;
      pendingConflict.tagIds = [...selectedTagIds.value];
      pendingConflict.batchId = genBatchId();
      pendingConflict.conflicts = conflicts;
      showConflictDialog.value = true;
    }
  } catch (err) {
    MessagePlugin.error(getErrorMessage(err) || '目录准备失败，请重试');
  } finally {
    preparing.value = false;
    preparingMsg.value = '';
  }
}

/** 决策确认：覆盖项携带 overwriteFileId 入队；跳过项不入队 */
function handleConflictConfirm(decisions: ConflictDecisionEntry[]) {
  showConflictDialog.value = false;
  const overwriteItems = decisions
    .filter((d) => d.decision === 'overwrite' && !d.conflict.overwriteBlocked)
    .map((d) => ({ ...d.conflict.item, overwriteFileId: d.conflict.existingId }));
  const skipCount = decisions.filter((d) => d.decision === 'skip' && !d.conflict.overwriteBlocked).length;
  const allItems = [...pendingConflict.items, ...overwriteItems];
  if (allItems.length === 0) {
    MessagePlugin.info('未上传任何文件');
    return;
  }
  uploadStore.enqueueFolderFiles(allItems, pendingConflict.tagIds, pendingConflict.batchId);
  if (skipCount > 0) MessagePlugin.info(`已跳过 ${skipCount} 个重复文件`);
}

/** 决策取消：整批放弃 */
function handleConflictCancel() {
  showConflictDialog.value = false;
  MessagePlugin.info('已取消本次上传');
}

/** 处理拖拽采集结果：parsed 走文件夹链路，plainFiles 走现有平铺入队，同批共存 */
async function handleCollectResult(result: DropCollectResult) {
  if (result.degraded) {
    // Entry API 不可用：保持原行为（全部平铺）并提示已降级
    if (result.plainFiles.length > 0) {
      MessagePlugin.info('浏览器不支持文件夹拖拽解析，已按平铺方式上传');
      enqueueFiles(result.plainFiles);
    }
    return;
  }
  if (result.plainFiles.length > 0) enqueueFiles(result.plainFiles);
  await processParsedFiles(result.parsed, result.emptyDirs, result.violations);
}

async function fetchUploadConfig() {
  try {
    const res = await api.get('/files/upload-config');
    const data = res.data.data;
    if (data.maxFileSize) {
      maxFileSizeBytes.value = data.maxFileSize;
      maxFileSizeMB.value = Math.round((data.maxFileSize / 1024 / 1024) * 100) / 100;
    }
    fileTypeMode.value = data.fileTypeMode || 'blacklist';
    const filterList: string[] = data.fileTypeFilter || [];
    if (fileTypeMode.value === 'whitelist' && filterList.length > 0) {
      acceptTypes.value = filterList.join(',');
    } else {
      acceptTypes.value = '';
    }
  } catch {
    // 使用默认值
  }
}

async function handleDrop(e: DragEvent) {
  isDragover.value = false;
  const dt = e.dataTransfer;
  if (!dt) return;
  // Entry API 不可用时保持原有平铺行为
  if (!dt.items || dt.items.length === 0) {
    enqueueFiles(Array.from(dt.files || []));
    return;
  }
  try {
    const result = await collectFromDrop(dt.items);
    await handleCollectResult(result);
  } catch (err) {
    // 采集异常兜底：回退原有平铺行为
    console.warn('[上传弹窗] 拖拽采集异常，回退平铺上传:', err);
    enqueueFiles(Array.from(dt.files || []));
  }
}

function triggerInput() {
  fileInput.value?.click();
}

function triggerFolderInput() {
  if (preparing.value) return;
  folderInput.value?.click();
}

function handleFileSelect(e: Event) {
  const target = e.target as HTMLInputElement;
  const files = Array.from(target.files || []);
  enqueueFiles(files);
  target.value = '';
}

/** 文件夹选择器：采集 → 公共文件夹链路 */
async function handleFolderSelect(e: Event) {
  const target = e.target as HTMLInputElement;
  const files = Array.from(target.files || []);
  target.value = '';
  if (files.length === 0) return;
  const parsed = collectFromInput(files);
  await processParsedFiles(parsed, []);
}

// 上传配置改为弹窗打开时惰性获取，避免未打开弹窗也发请求
watch(() => props.visible, async (isVisible) => {
  if (isVisible) {
    // 打开时获取上传配置（大小上限/类型白名单），确保校验使用最新服务端配置
    await fetchUploadConfig();
    await tagStore.fetchTags();
    selectedTagIds.value = [];
    showTagSelector.value = false;
    newTagName.value = '';
    if (props.initialFiles && props.initialFiles.length > 0) {
      enqueueFiles(Array.from(props.initialFiles));
    }
    // 页面级拖拽转发的采集结果：走与弹窗拖拽完全一致的链路
    if (props.initialDropResult) {
      await handleCollectResult(props.initialDropResult);
    }
  }
});
</script>

<style scoped>
@media (max-width: 768px) {
  :deep(.t-dialog) {
    margin: 16px;
  }
  :deep(.t-dialog__body) {
    padding: 12px;
  }
}
</style>
