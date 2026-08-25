<template>
  <div class="folder-share-browser">
    <!-- 顶部：文件夹标题 + 面包屑 -->
    <div class="browser-header">
      <div class="folder-title-row">
        <span class="folder-icon-large">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
        </span>
        <h1 class="folder-title">{{ rootFolder.name }}</h1>
      </div>

      <nav class="breadcrumb" v-if="breadcrumb.length > 0">
        <button
          v-for="(item, idx) in breadcrumb"
          :key="item.id"
          type="button"
          class="breadcrumb-item"
          :class="{ active: idx === breadcrumb.length - 1 }"
          :aria-current="idx === breadcrumb.length - 1 ? 'page' : undefined"
          :disabled="idx === breadcrumb.length - 1 || loading"
          @click="onBreadcrumbClick(item, idx)"
        >
          <span class="breadcrumb-separator" v-if="idx > 0">/</span>
          <span class="breadcrumb-label">{{ item.name }}</span>
        </button>
      </nav>
    </div>

    <!-- 加载状态 -->
    <div v-if="loading" class="loading-state">
      <t-loading size="medium" text="加载中..." />
    </div>

    <!-- 表格列表 -->
    <div v-else class="share-table">
      <div class="share-table-head">
        <span class="col col-name">名称</span>
        <span class="col col-size">大小</span>
        <span class="col col-date">上传时间</span>
        <span class="col col-ops">操作</span>
      </div>

      <!-- 空状态 -->
      <div v-if="currentContents.subfolders.length === 0 && currentContents.files.length === 0" class="empty-state">
        <div class="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>
          </svg>
        </div>
        <p>此文件夹为空</p>
      </div>

      <!-- 子文件夹行 -->
      <button
        v-for="sub in currentContents.subfolders"
        :key="sub.id"
        type="button"
        class="share-row folder-row"
        :aria-label="`打开文件夹 ${sub.name}`"
        :disabled="loading"
        @click="openSubfolder(sub)"
      >
        <span class="col col-name">
          <span class="row-icon folder-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </span>
          <span class="row-name" :title="sub.name">{{ sub.name }}</span>
        </span>
        <span class="col col-size">—</span>
        <span class="col col-date">{{ sub.createdAt ? formatRelativeDate(sub.createdAt) : '—' }}</span>
        <span class="col col-ops"><span class="op-link">打开</span></span>
      </button>

      <!-- 文件行 -->
      <div v-for="file in currentContents.files" :key="file.id" class="share-row file-row">
        <span class="col col-name">
          <ThumbnailImg
            :file-id="file.id"
            :mime-type="file.mimeType"
            :file-name="file.name"
            :size="40"
            :src="buildShareThumbnailUrl(props.token, file.id)"
            :context="`s:${props.token}`"
            :version="file.uploadVersion"
          />
          <span class="row-name" :title="file.name">{{ file.name }}</span>
        </span>
        <span class="col col-size">{{ formatSize(file.size) }}</span>
        <span class="col col-date">{{ formatRelativeDate(file.createdAt) }}</span>
        <span class="col col-ops">
          <button
            v-if="isPreviewable(file.mimeType, file.name)"
            type="button"
            class="op-link"
            @click.stop="openPreview(file)"
          >
            预览
          </button>
          <button
            type="button"
            class="op-link"
            :disabled="downloadingId === file.id"
            @click.stop="downloadFile(file)"
          >
            {{ downloadingId === file.id ? '下载中...' : '下载' }}
          </button>
        </span>
      </div>
    </div>

    <!-- 返回上级 -->
    <div v-if="currentFolderId !== rootFolder.id && !loading" class="back-to-parent">
      <t-button theme="default" variant="text" @click="goBack">
        ← 返回上级
      </t-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onUnmounted, watch } from 'vue';
import MessagePlugin from '@/utils/message';
import { triggerBrowserDownload } from '@/utils/download';
import { isPreviewable, getPreviewKind, buildSharePreviewUrl, buildShareThumbnailUrl } from '@/utils/preview';
import ThumbnailImg from '@/components/ThumbnailImg.vue';
import { useMediaPlaybackStore, type MediaSessionItem } from '../../stores/mediaPlayback';

interface FolderSummary {
  id: string;
  name: string;
  createdAt?: string;
}
interface FileSummary {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  createdAt: string;
  downloadUrl: string;
  /** 文件内容版本（覆盖上传时递增），用于进度记录版本校验 */
  uploadVersion?: number;
  /** 文件状态（ready/processing/error），用于过滤可预览文件 */
  status?: string;
}
interface FolderContents {
  subfolders: FolderSummary[];
  files: FileSummary[];
}

const props = defineProps<{
  token: string;
  /** 该分享是否设置过密码（凭据本身存于 HttpOnly Cookie，前端不持有 access JWT） */
  encrypted?: boolean;
  rootFolder: FolderSummary;
  initialContents: FolderContents;
  initialBreadcrumb: FolderSummary[];
}>();

/** 通知父级 ShareView：HttpOnly Cookie 凭据过期，需重新拉取元数据以切回密码输入状态 */
const emit = defineEmits<{
  (e: 'credential-expired'): void;
}>();

const loading = ref(false);
const downloadingId = ref<string | null>(null);
const currentFolderId = ref<string>(props.rootFolder.id);
const currentContents = reactive<FolderContents>({
  subfolders: [...props.initialContents.subfolders],
  files: [...props.initialContents.files],
});
const breadcrumb = ref<FolderSummary[]>([...props.initialBreadcrumb]);
// 仅记录已通过接口校验并提交的路径，返回上级不依赖可能陈旧的展示状态。
const verifiedPath = ref<FolderSummary[]>([...props.initialBreadcrumb]);

const mediaPlaybackStore = useMediaPlaybackStore();
let loadGeneration = 0;

watch(
  () => [props.token, props.rootFolder.id, props.initialContents, props.initialBreadcrumb] as const,
  () => {
    loadGeneration++;
    loadController?.abort();
    currentFolderId.value = props.rootFolder.id;
    currentContents.subfolders = [...props.initialContents.subfolders];
    currentContents.files = [...props.initialContents.files];
    breadcrumb.value = [...props.initialBreadcrumb];
    verifiedPath.value = [...props.initialBreadcrumb];
    loading.value = false;
  },
);
let loadController: AbortController | null = null;

/** 打开全局预览会话（分享上下文；跨路由/收起不中断播放）。仅 ready 文件可预览（H-12）。 */
function openPreview(file: FileSummary) {
  const kind = getPreviewKind(file.mimeType, file.name);
  if (!kind) return;
  if (file.status && file.status !== 'ready') return;
  const list = buildMediaPlaylist(kind);
  const index = Math.max(0, list.findIndex((i) => i.id === file.id));
  mediaPlaybackStore.open({
    context: { type: 'share', token: props.token, encrypted: props.encrypted },
    item: list[index] ?? {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      kind,
      size: file.size,
      src: buildSharePreviewUrl(props.token, file.id),
      downloadUrl: buildShareDownloadUrl(file.id),
      contentVersion: file.uploadVersion,
    },
    playlist: list,
    playlistIndex: index,
  });
}

// ============ 媒体快速预览列表 ============
function buildMediaPlaylist(kind: MediaSessionItem['kind']): MediaSessionItem[] {
  return currentContents.files
    // 仅 ready 文件进入播放列表（H-12）；错误/处理中文件展示失败状态，不发起预览
    .filter((file) => getPreviewKind(file.mimeType, file.name) === kind && (!file.status || file.status === 'ready'))
    .map((file) => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      kind,
      size: file.size,
      src: buildSharePreviewUrl(props.token, file.id),
      downloadUrl: buildShareDownloadUrl(file.id),
      contentVersion: file.uploadVersion,
    }));
}

/** 固定构造同源分享下载路径；凭据由 HttpOnly Cookie 携带，URL 不含访问 JWT */
function buildShareDownloadUrl(fileId: string): string {
  return `/api/s/${encodeURIComponent(props.token)}/download/${encodeURIComponent(fileId)}`;
}

/**
 * 直接调用浏览器原生下载。
 * 后端返回 Content-Disposition: attachment，浏览器下载器自带进度条、暂停/恢复、
 * 保存对话框，无需前端 fetch 预校验（旧实现的 GET 兜底会把整个文件先读进内存，
 * 相当于下载两次，已移除）。
 */
function downloadFile(file: FileSummary) {
  if (downloadingId.value) return;
  downloadingId.value = file.id;
  triggerBrowserDownload(buildShareDownloadUrl(file.id), file.name);
  MessagePlugin.success('已开始下载，请查看浏览器下载进度');
  // 短暂禁用避免重复点击；浏览器接管后无需等待前端异步完成
  window.setTimeout(() => { downloadingId.value = null; }, 1000);
}

async function openSubfolder(folder: FolderSummary) {
  if (folder.id === currentFolderId.value) return;
  await loadFolderContents(folder.id);
}

async function onBreadcrumbClick(item: FolderSummary, _idx: number) {
  if (item.id === currentFolderId.value) return;
  await loadFolderContents(item.id);
}

async function goBack() {
  // 只使用最近一次成功提交的路径，避免展示中的陈旧 breadcrumb 让返回按钮静默失效。
  const idx = verifiedPath.value.findIndex((item) => item.id === currentFolderId.value);
  if (idx <= 0 || currentFolderId.value === props.rootFolder.id) return;
  const parent = verifiedPath.value[idx - 1];
  if (!parent?.id || parent.id === currentFolderId.value) return;
  await loadFolderContents(parent.id);
}

class CredentialExpiredError extends Error {}

function isCredentialExpiredResponse(response: Response): boolean {
  return response.status === 401 || response.status === 403;
}

function isFolderContents(value: unknown): value is FolderContents {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<FolderContents>;
  return Array.isArray(data.subfolders) && Array.isArray(data.files);
}

function isBreadcrumb(value: unknown): value is FolderSummary[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => (
    item && typeof item === 'object' && typeof item.id === 'string' && typeof item.name === 'string'
  ));
}

async function loadFolderContents(folderId: string) {
  const generation = ++loadGeneration;
  loadController?.abort();
  loadController = new AbortController();
  const { signal } = loadController;
  loading.value = true;
  try {
    // 两个请求必须同时成功且数据结构有效，之后才一次性提交目录状态。
    const [contentsRes, bcRes] = await Promise.all([
      fetch(`/api/s/${encodeURIComponent(props.token)}/folder/${encodeURIComponent(folderId)}/contents`, { signal }),
      fetch(`/api/s/${encodeURIComponent(props.token)}/folder/${encodeURIComponent(folderId)}/breadcrumb`, { signal }),
    ]);
    if (isCredentialExpiredResponse(contentsRes) || isCredentialExpiredResponse(bcRes)) {
      throw new CredentialExpiredError('分享凭据已过期，请重新验证');
    }
    if (!contentsRes.ok) throw new Error(`目录内容加载失败（HTTP ${contentsRes.status}）`);
    if (!bcRes.ok) throw new Error(`目录路径加载失败（HTTP ${bcRes.status}）`);

    const [contentsData, bcData] = await Promise.all([contentsRes.json(), bcRes.json()]);
    if (generation !== loadGeneration) return;
    if (contentsData?.data?.requiresPassword || bcData?.data?.requiresPassword) {
      throw new CredentialExpiredError('分享凭据已过期，请重新验证');
    }
    if (contentsData?.code !== 0) throw new Error(contentsData?.message || '目录内容加载失败');
    if (bcData?.code !== 0) throw new Error(bcData?.message || '目录路径加载失败');

    const nextContents = contentsData.data;
    const nextBreadcrumb = bcData.data?.breadcrumb;
    if (!isFolderContents(nextContents)) throw new Error('目录内容响应无效');
    if (!isBreadcrumb(nextBreadcrumb)) throw new Error('目录路径响应无效');
    if (nextBreadcrumb[nextBreadcrumb.length - 1].id !== folderId) {
      throw new Error('目录路径与当前目录不一致');
    }

    // 所有校验完成后原子更新，任一必要响应失败都不会污染旧状态。
    currentFolderId.value = folderId;
    currentContents.subfolders = [...nextContents.subfolders];
    currentContents.files = [...nextContents.files];
    breadcrumb.value = [...nextBreadcrumb];
    verifiedPath.value = [...nextBreadcrumb];
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    if (generation !== loadGeneration) return;
    if (err instanceof CredentialExpiredError) {
      emit('credential-expired');
      return;
    }
    console.error('文件夹加载失败:', err);
    MessagePlugin.error(err instanceof Error ? err.message : '目录加载失败，请稍后重试');
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
}

onUnmounted(() => {
  loadGeneration++;
  loadController?.abort();
});

function formatSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatRelativeDate(dateStr: string): string {
  try {
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
    return dateStr.slice(0, 10);
  } catch {
    return '';
  }
}
</script>

<style scoped>
.folder-share-browser {
  width: 100%;
  max-width: 960px;
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 16px 0 20px;
  box-shadow: var(--shadow-sm);
  font-family: var(--font-body);
  color: var(--text-primary);
}

.browser-header {
  border-bottom: 1px solid var(--border-default);
  padding: 0 20px 16px;
  margin-bottom: 16px;
}

.folder-title-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.folder-icon-large {
  display: inline-flex;
  align-items: center;
  color: var(--seed-primary);
}

.folder-title {
  font-size: 22px;
  font-weight: 600;
  margin: 0;
  color: var(--text-primary);
}

.breadcrumb {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  font-size: 14px;
}

.breadcrumb-item {
  display: inline-flex;
  align-items: center;
  border: 0;
  padding: 0;
  background: transparent;
  cursor: pointer;
  color: var(--text-secondary);
  font: inherit;
}

.breadcrumb-item:hover:not(:disabled) { color: var(--seed-primary); }
.breadcrumb-item:focus-visible,
.share-row:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
.breadcrumb-item.active,
.breadcrumb-item:disabled { color: var(--text-primary); font-weight: 500; cursor: default; }
.breadcrumb-separator { color: var(--text-tertiary); margin: 0 4px; }

.loading-state { padding: 48px 0; text-align: center; }

/* ===== 表格列表 ===== */
.share-table {
  display: flex;
  flex-direction: column;
}

/* 列宽：名称弹性 / 大小 / 上传时间 / 操作 */
.share-table-head,
.share-row {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) 96px 150px 160px;
  gap: 12px;
  align-items: center;
  padding: 0 16px;
}

.share-table-head {
  min-height: 40px;
  background: var(--color-bg-elevated);
  border-bottom: 1px solid var(--border-strong);
  font-size: 12px;
  font-weight: 500;
  color: var(--text-tertiary);
}

.share-row {
  min-height: 52px;
  width: 100%;
  border: 0;
  border-bottom: 1px solid var(--border-default);
  background: transparent;
  text-align: left;
  font: inherit;
  color: var(--text-primary);
  cursor: default;
  transition: background var(--duration-fast);
}

.share-row:last-child { border-bottom: none; }

.share-row.folder-row { cursor: pointer; }
.share-row.folder-row:hover:not(:disabled) { background: var(--color-bg-hover); }
.share-row.folder-row:disabled { cursor: not-allowed; opacity: .6; }
.share-row.file-row:hover { background: var(--color-bg-hover); }

/* 名称列：图标/缩略图 + 名称 */
.col-name {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.row-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}
.row-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
}
.folder-icon { color: var(--seed-primary); }

.col-size {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.col-date {
  font-size: 13px;
  color: var(--text-secondary);
}
.col-ops {
  display: flex;
  align-items: center;
  gap: 16px;
}

.op-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--seed-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.op-link:hover { color: var(--seed-accent); }
.op-link:disabled { color: var(--text-disabled); cursor: not-allowed; }

.empty-state {
  padding: 48px 0;
  text-align: center;
  color: var(--text-tertiary);
}

.empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 8px;
  color: var(--text-tertiary);
}

.back-to-parent {
  margin-top: 16px;
  padding: 0 20px;
  text-align: left;
}

.back-to-parent :deep(.t-button) { color: var(--text-secondary); }
.back-to-parent :deep(.t-button:hover) { color: var(--seed-primary); }

@media (max-width: 768px) {
  .folder-share-browser { padding: 12px 0 16px; border-radius: var(--radius-sm); }
  .browser-header { padding: 0 12px 12px; }
  .folder-title { font-size: 18px; }
  .folder-icon-large svg { width: 24px; height: 24px; }
  .breadcrumb { font-size: 13px; }

  /* 移动端隐藏“上传时间”列；操作列改为 minmax 自适应，避免超宽横滚 */
  .share-table-head,
  .share-row {
    grid-template-columns: minmax(160px, 1fr) 88px minmax(96px, auto);
    gap: 8px;
    padding: 0 12px;
  }
  .col-date { display: none; }

  .row-name { font-size: 13px; }
  .col-size { font-size: 12px; }
  .back-to-parent { padding: 0 12px; }
}

/* 超窄屏（≤480px）：操作按钮压缩间距，避免挤占名称列导致横滚 */
@media (max-width: 480px) {
  .share-table-head,
  .share-row {
    grid-template-columns: minmax(140px, 1fr) 72px minmax(84px, auto);
    gap: 6px;
    padding: 0 10px;
  }
  .col-ops { gap: 10px; }
  .op-link { font-size: 12px; }
  .col-size { font-size: 11px; }
}
</style>
