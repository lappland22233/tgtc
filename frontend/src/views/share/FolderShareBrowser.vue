<template>
  <div class="folder-share-browser">
    <!-- 顶部：文件夹标题 + 面包屑 -->
    <div class="browser-header">
      <div class="folder-title-row">
        <span class="folder-icon-large">📁</span>
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
        <div class="empty-icon">📂</div>
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
            <div class="subfolder-icon">📁</div>
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
              <span class="file-emoji">{{ getFileEmoji(file.mimeType) }}</span>
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

function getFileEmoji(mimeType: string): string {
  const m = (mimeType || '').toLowerCase();
  if (m.startsWith('image/')) return '🖼️';
  if (m.startsWith('video/')) return '🎬';
  if (m.startsWith('audio/')) return '🎵';
  if (m === 'application/pdf') return '📄';
  if (m.includes('zip') || m.includes('rar') || m.includes('7z')) return '🗜️';
  if (m.includes('word')) return '📝';
  if (m.includes('excel') || m.includes('sheet')) return '📊';
  if (m.includes('powerpoint') || m.includes('presentation')) return '📽️';
  return '📄';
}
</script>

<style scoped>
.folder-share-browser {
  width: 100%;
  max-width: 960px;
  background: #21262D;
  border: 1px solid #30363D;
  border-radius: 16px;
  padding: 24px 32px 32px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
  color: #E6EDF3;
}

.browser-header {
  border-bottom: 1px solid #30363D;
  padding-bottom: 16px;
  margin-bottom: 20px;
}

.folder-title-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.folder-icon-large { font-size: 36px; }

.folder-title {
  font-size: 22px;
  font-weight: 600;
  margin: 0;
  color: #E6EDF3;
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
  color: #8B949E;
}

.breadcrumb-item:hover { color: #58A6FF; }
.breadcrumb-item.active { color: #E6EDF3; font-weight: 500; cursor: default; }
.breadcrumb-separator { color: #6E7681; margin: 0 4px; }

.loading-state { padding: 48px 0; text-align: center; }

.empty-state {
  padding: 48px 0;
  text-align: center;
  color: #6E7681;
}

.empty-icon { font-size: 56px; margin-bottom: 8px; }

.browser-content {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.section-title {
  font-size: 14px;
  font-weight: 500;
  color: #8B949E;
  margin: 0 0 12px;
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(160px, 100%), 1fr));
  gap: 12px;
}

.subfolder-card {
  background: rgba(13, 17, 23, 0.5);
  border: 1px solid #30363D;
  border-radius: 8px;
  padding: 16px 12px;
  cursor: pointer;
  text-align: center;
  transition: all 0.2s;
}

.subfolder-card:hover {
  border-color: #58A6FF;
  background: rgba(0, 82, 217, 0.08);
  transform: translateY(-2px);
}

.subfolder-icon { font-size: 40px; margin-bottom: 6px; }

.subfolder-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #E6EDF3;
}

.share-file-card {
  background: rgba(13, 17, 23, 0.5);
  border: 1px solid #30363D;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  flex-direction: column;
}

.share-file-card:hover {
  border-color: #58A6FF;
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.file-card-preview {
  width: 100%;
  aspect-ratio: 1.4 / 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, rgba(110, 118, 129, 0.15), rgba(13, 17, 23, 0.4));
  font-size: 48px;
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
  color: #E6EDF3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-card-meta {
  font-size: 11px;
  color: #6E7681;
  display: flex;
  align-items: center;
  gap: 4px;
}

.meta-dot { color: #484F58; }

.file-download-btn {
  display: block;
  margin: 0 10px 10px;
  padding: 6px 12px;
  background: #0052D9;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
  text-align: center;
  text-decoration: none;
  cursor: pointer;
  transition: background 0.2s;
}

.file-download-btn:hover { background: #0969DA; }
.file-download-btn:disabled { opacity: 0.6; cursor: not-allowed; }

.back-to-parent {
  margin-top: 16px;
  text-align: left;
}

.back-to-parent :deep(.t-button) { color: #8B949E; }
.back-to-parent :deep(.t-button:hover) { color: #58A6FF; }

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
