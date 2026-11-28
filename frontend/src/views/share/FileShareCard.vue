<template>
  <article class="file-share-card">
    <header class="file-share-head">
      <div class="security-hint">
        <t-icon :name="isEncrypted ? 'lock-on' : 'link'" aria-hidden="true" />
        <span>{{ isEncrypted ? '加密分享链接' : '公开分享链接' }}</span>
      </div>
      <h1 class="file-share-title" :title="info.name">{{ info.name }}</h1>
    </header>

    <div class="file-share-hero">
      <ThumbnailImg
        :file-id="info.id"
        :mime-type="info.mimeType"
        :file-name="info.name"
        :size="128"
        fit="contain"
        :src="buildShareThumbnailUrl(props.token, props.info.id)"
        :context="`s:${props.token}`"
        :version="info.uploadVersion"
      />
    </div>

    <div class="file-share-body">
      <dl class="file-share-meta">
        <dt>大小</dt><dd>{{ formatSize(info.size) }}</dd>
        <dt>类型</dt><dd>{{ info.mimeType }}</dd>
        <dt>上传时间</dt><dd>{{ formatDateTime(info.createdAt) }}</dd>
        <template v-if="info.expiresAt">
          <dt>有效期至</dt><dd>{{ formatDateTime(info.expiresAt) }}</dd>
        </template>
      </dl>
      <div class="file-share-actions">
        <button v-if="previewKind" type="button" class="preview-btn" @click="openPreview">
          <t-icon name="browse" aria-hidden="true" />
          在线预览
        </button>
        <button type="button" class="download-btn" :disabled="downloading" @click="handleDownload">
          <t-icon name="download" aria-hidden="true" />
          {{ downloading ? '下载中...' : '下载文件' }}
        </button>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import MessagePlugin from '@/utils/message';
import { triggerBrowserDownload, LARGE_FILE_DOWNLOAD_TIP, isLargeFile } from '@/utils/download';
import { getPreviewKind, buildSharePreviewUrl, buildShareThumbnailUrl } from '@/utils/preview';
import ThumbnailImg from '@/components/ThumbnailImg.vue';
import { useMediaPlaybackStore } from '../../stores/mediaPlayback';

interface FileInfo {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  createdAt: string;
  expiresAt?: string | null;
  uploadVersion?: number;
}

const props = defineProps<{
  info: FileInfo;
  token: string;
  encrypted?: boolean;
}>();

const isEncrypted = computed(() => !!props.encrypted);
const previewKind = computed(() => getPreviewKind(props.info.mimeType, props.info.name));
const mediaPlaybackStore = useMediaPlaybackStore();

function openPreview() {
  const kind = previewKind.value;
  if (!kind) return;
  mediaPlaybackStore.open({
    context: { type: 'share', token: props.token, encrypted: props.encrypted },
    item: {
      id: props.info.id,
      name: props.info.name,
      mimeType: props.info.mimeType,
      kind,
      size: props.info.size,
      src: buildSharePreviewUrl(props.token, props.info.id),
      downloadUrl: downloadUrl.value,
      contentVersion: props.info.uploadVersion,
    },
    playlist: [],
    playlistIndex: -1,
  });
}

const downloadUrl = computed(() => `/api/s/${encodeURIComponent(props.token)}/download/${encodeURIComponent(props.info.id)}`);

function formatSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDateTime(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return dateStr; }
}

const downloading = ref(false);

/**
 * 分享域下载。
 *
 * 说明（为何不走两阶段「下载任务」流程）：
 * 后端暂未提供分享域（`/api/s/:token`）的下载任务创建端点（任务化创建入口仅存在于
 * 需登录的 `POST /api/files/:id/download-tasks`）。因此这里不伪造接口，改为复用既有
 * 同源下载 URL 直接触发浏览器原生下载，并对大文件提示使用支持断点续传的下载器。
 *
 * 浏览器原生下载器不回传完成状态，故只提示「已开始下载」；不使用 fetch + blob。
 */
function handleDownload() {
  if (downloading.value) return;
  downloading.value = true;
  triggerBrowserDownload(downloadUrl.value, props.info.name);
  MessagePlugin.success(
    isLargeFile(props.info.size) ? LARGE_FILE_DOWNLOAD_TIP : '已开始下载，请查看浏览器下载进度',
  );
  window.setTimeout(() => { downloading.value = false; }, 1000);
}
</script>

<style scoped>
.file-share-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px 20px;
  padding: clamp(12px, 4vw, 24px);
  border: 1px solid var(--workspace-border);
  border-radius: var(--radius-lg);
  background: var(--workspace-surface);
}

.file-share-head {
  grid-column: 1 / -1;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--workspace-border);
}

.security-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--workspace-accent);
  font-size: 13px;
}

.file-share-title {
  margin: 6px 0 0;
  font-size: clamp(23px, 4vw, 32px);
  font-weight: 690;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.file-share-hero {
  display: grid;
  place-items: center;
  min-height: 152px;
  border: 1px solid var(--workspace-border);
  border-radius: 8px;
  background: var(--workspace-canvas);
}

.file-share-body {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 16px;
  min-width: 0;
}

.file-share-meta {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 6px 12px;
  align-items: baseline;
  margin: 0;
  font-size: 13px;
}

.file-share-meta dt { color: var(--workspace-muted); }
.file-share-meta dd { margin: 0; overflow-wrap: anywhere; }

.file-share-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.file-share-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 1 1 auto;
  gap: 6px;
  min-height: 44px;
  padding-inline: 12px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--radius-md);
  background: var(--workspace-surface);
  color: var(--workspace-accent);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.file-share-actions .download-btn {
  border-color: var(--workspace-accent);
  background: var(--workspace-accent);
  color: var(--workspace-on-accent);
}

.preview-btn:hover { background: var(--workspace-selected); }
.file-share-actions .download-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--workspace-accent) 90%, var(--workspace-text));
}

.download-btn:disabled { cursor: not-allowed; opacity: .72; }
.file-share-actions button:focus-visible { outline-color: var(--workspace-accent); }

@media (min-width: 481px) {
  .file-share-card { grid-template-columns: minmax(144px, 31%) minmax(0, 1fr); }
  .file-share-actions button { flex: 0 0 auto; }
}
</style>
