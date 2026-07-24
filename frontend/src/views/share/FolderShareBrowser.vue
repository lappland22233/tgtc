<template>
  <div class="folder-share-browser">
    <!-- 顶部：文件夹标题 + 面包屑 -->
    <div class="browser-header">
      <div class="folder-title-row">
        <span class="folder-icon-large">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
        </span>
        <h1 class="folder-title">{{ rootFolder.name }}</h1>
      </div>

      <nav class="breadcrumb" v-if="breadcrumb.length > 0">
        <a
          v-for="(item, idx) in breadcrumb"
          :key="item.id"
          class="breadcrumb-item"
          :class="{ active: idx === breadcrumb.length - 1 }"
          @click="onBreadcrumbClick(item, idx)"
        >
          <span class="breadcrumb-separator" v-if="idx > 0">/</span>
          <span class="breadcrumb-label">{{ item.name }}</span>
        </a>
      </nav>
    </div>

    <!-- 加载状态 -->
    <div v-if="loading" class="loading-state">
      <t-loading size="medium" text="加载中..." />
    </div>

    <!-- 内容区：子文件夹 + 文件 -->
    <div v-else class="browser-content">
      <!-- 空状态 -->
      <div v-if="currentContents.subfolders.length === 0 && currentContents.files.length === 0" class="empty-state">
        <div class="empty-icon">
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>
          </svg>
        </div>
        <p>此文件夹为空</p>
      </div>

      <!-- 子文件夹网格 -->
      <div v-if="currentContents.subfolders.length > 0" class="subfolder-section">
        <h2 class="section-title">文件夹 ({{ currentContents.subfolders.length }})</h2>
        <div class="card-grid">
          <div
            v-for="sub in currentContents.subfolders"
            :key="sub.id"
            class="subfolder-card"
            @click="openSubfolder(sub)"
          >
            <div class="subfolder-icon">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
            </div>
            <div class="subfolder-name" :title="sub.name">{{ sub.name }}</div>
          </div>
        </div>
      </div>

      <!-- 文件网格 -->
      <div v-if="currentContents.files.length > 0" class="file-section">
        <h2 class="section-title">文件 ({{ currentContents.files.length }})</h2>
        <div class="card-grid">
          <div
            v-for="file in currentContents.files"
            :key="file.id"
            class="share-file-card"
            :title="file.name"
          >
            <div class="file-card-preview">
              <FileTypeIcon :mimeType="file.mimeType" :fileName="file.name" :size="48" />
            </div>
            <div class="file-card-info">
              <div class="file-card-name" :title="file.name">{{ file.name }}</div>
              <div class="file-card-meta">
                <span>{{ formatSize(file.size) }}</span>
                <span class="meta-dot">·</span>
                <span>{{ formatRelativeDate(file.createdAt) }}</span>
              </div>
            </div>
            <button
              type="button"
              class="file-download-btn"
              :disabled="downloadingId === file.id"
              @click.stop="downloadFile(file)"
            >
              <span>{{ downloadingId === file.id ? '下载中...' : '下载' }}</span>
            </button>
          </div>
        </div>
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
import { ref, reactive } from 'vue';
import MessagePlugin from '@/utils/message';
import { triggerBrowserDownload } from '@/utils/download';
import FileTypeIcon from '@/components/FileTypeIcon.vue';

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
}
interface FolderContents {
  subfolders: FolderSummary[];
  files: FileSummary[];
}

const props = defineProps<{
  token: string;
  accessJwt?: string;
  rootFolder: FolderSummary;
  initialContents: FolderContents;
  initialBreadcrumb: FolderSummary[];
}>();

const loading = ref(false);
const downloadingId = ref<string | null>(null);
const currentFolderId = ref<string>(props.rootFolder.id);
const currentContents = reactive<FolderContents>({
  subfolders: [...props.initialContents.subfolders],
  files: [...props.initialContents.files],
});
const breadcrumb = ref<FolderSummary[]>([...props.initialBreadcrumb]);

/**
 * 直接调用浏览器原生下载。
 * 后端返回 Content-Disposition: attachment，浏览器下载器自带进度条、暂停/恢复、
 * 保存对话框，无需前端 fetch 预校验（旧实现的 GET 兜底会把整个文件先读进内存，
 * 相当于下载两次，已移除）。
 */
function downloadFile(file: FileSummary) {
  if (downloadingId.value) return;
  downloadingId.value = file.id;
  // 固定构造同源下载路径，禁止把访问 JWT 附加到后端返回的任意跨域 URL。
  const baseUrl = `/api/s/${encodeURIComponent(props.token)}/download/${encodeURIComponent(file.id)}`;
  const url = props.accessJwt
    ? `${baseUrl}?access=${encodeURIComponent(props.accessJwt)}`
    : baseUrl;
  triggerBrowserDownload(url, file.name);
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
  const idx = breadcrumb.value.findIndex((b) => b.id === currentFolderId.value);
  if (idx > 0) {
    await loadFolderContents(breadcrumb.value[idx - 1].id);
  }
}

async function loadFolderContents(folderId: string) {
  loading.value = true;
  try {
    const accessParam = props.accessJwt ? `?access=${encodeURIComponent(props.accessJwt)}` : '';
    const [contentsRes, bcRes] = await Promise.all([
      fetch(`/api/s/${encodeURIComponent(props.token)}/folder/${encodeURIComponent(folderId)}/contents${accessParam}`),
      fetch(`/api/s/${encodeURIComponent(props.token)}/folder/${encodeURIComponent(folderId)}/breadcrumb${accessParam}`),
    ]);
    if (!contentsRes.ok) throw new Error('加载失败');
    const contentsData = await contentsRes.json();
    if (contentsData.code !== 0) throw new Error(contentsData.message || '加载失败');
    const payload = contentsData.data;
    if (payload.requiresPassword) {
      throw new Error('访问凭证已失效，请重新输入密码');
    }
    currentFolderId.value = folderId;
    currentContents.subfolders = payload.subfolders || [];
    currentContents.files = payload.files || [];
    if (bcRes.ok) {
      const bcData = await bcRes.json();
      if (bcData.code === 0 && bcData.data.breadcrumb) {
        breadcrumb.value = bcData.data.breadcrumb;
      }
    }
  } catch (err) {
    console.error('文件夹加载失败:', err);
    MessagePlugin.error(err instanceof Error ? err.message : '网络错误');
  } finally {
    loading.value = false;
  }
}

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
  border-radius: var(--radius-lg);
  padding: 24px 32px 32px;
  box-shadow: var(--shadow-lg);
  font-family: var(--font-body);
  color: var(--text-primary);
}

.browser-header {
  border-bottom: 1px solid var(--border-default);
  padding-bottom: 16px;
  margin-bottom: 20px;
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
  cursor: pointer;
  color: var(--text-secondary);
}

.breadcrumb-item:hover { color: var(--seed-primary); }
.breadcrumb-item.active { color: var(--text-primary); font-weight: 500; cursor: default; }
.breadcrumb-separator { color: var(--text-tertiary); margin: 0 4px; }

.loading-state { padding: 48px 0; text-align: center; }

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

.browser-content {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.section-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  margin: 0 0 12px;
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(160px, 100%), 1fr));
  gap: 12px;
}

.subfolder-card {
  background: var(--color-bg);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 16px 12px;
  cursor: pointer;
  text-align: center;
  transition: all 0.2s;
}

.subfolder-card:hover {
  border-color: var(--seed-primary);
  background: var(--color-accent-soft);
  transform: translateY(-2px);
}

.subfolder-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 6px;
  color: var(--seed-primary);
}

.subfolder-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-primary);
}

.share-file-card {
  background: var(--color-bg);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  overflow: hidden;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  flex-direction: column;
}

.share-file-card:hover {
  border-color: var(--seed-primary);
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}

.file-card-preview {
  width: 100%;
  aspect-ratio: 1.4 / 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-hover);
}

.file-card-info {
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.file-card-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-card-meta {
  font-size: 11px;
  color: var(--text-tertiary);
  display: flex;
  align-items: center;
  gap: 4px;
}

.meta-dot { color: var(--text-tertiary); }

.file-download-btn {
  display: block;
  margin: 0 10px 10px;
  padding: 6px 12px;
  background: var(--seed-primary);
  color: #fff;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-family: inherit;
  text-align: center;
  text-decoration: none;
  cursor: pointer;
  transition: background 0.2s;
}

.file-download-btn:hover { background: color-mix(in srgb, var(--seed-primary) 85%, #fff); }
.file-download-btn:disabled { opacity: 0.6; cursor: not-allowed; }

.back-to-parent {
  margin-top: 16px;
  text-align: left;
}

.back-to-parent :deep(.t-button) { color: var(--text-secondary); }
.back-to-parent :deep(.t-button:hover) { color: var(--seed-primary); }

@media (min-width: 1200px) {
  .card-grid {
    grid-template-columns: repeat(auto-fill, minmax(160px, 200px));
    justify-content: start;
  }
}

@media (max-width: 768px) {
  .folder-share-browser { padding: 16px; }
  .card-grid {
    grid-template-columns: repeat(auto-fill, minmax(min(140px, 100%), 1fr));
    gap: 10px;
  }
}
</style>
