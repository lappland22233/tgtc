<template>
  <div class="file-share-row" :class="{ 'file-share-row--encrypted': isEncrypted }">
    <div class="file-share-main">
      <div class="file-share-thumb">
        <ThumbnailImg
          :file-id="info.id"
          :mime-type="info.mimeType"
          :file-name="info.name"
          :size="48"
          :src="buildShareThumbnailUrl(props.token, props.info.id)"
          :context="`s:${props.token}`"
          :version="info.uploadVersion"
        />
      </div>
      <div class="file-share-info">
        <h1 class="file-name" :title="info.name">{{ info.name }}</h1>
        <div class="file-share-meta">
          <span>{{ formatSize(info.size) }}</span>
          <span class="meta-separator">·</span>
          <span class="mime-type" :title="info.mimeType">{{ info.mimeType }}</span>
          <span class="meta-separator">·</span>
          <span>{{ formatDateTime(info.createdAt) }}</span>
          <template v-if="info.expiresAt">
            <span class="meta-separator">·</span>
            <span class="expiry">有效期至 {{ formatDateTime(info.expiresAt) }}</span>
          </template>
        </div>
        <div class="security-hint" :class="{ encrypted: isEncrypted }">
          <t-icon :name="isEncrypted ? 'lock-on' : 'link'" />
          <span>{{ isEncrypted ? '加密分享链接' : '公开分享链接' }}</span>
        </div>
      </div>
    </div>
    <div class="file-share-actions">
      <button v-if="previewKind" type="button" class="preview-btn" @click="openPreview">
        <t-icon name="browse" />
        <span>预览</span>
      </button>
      <button type="button" class="download-btn" :disabled="downloading" @click="handleDownload">
        <t-icon name="download" />
        <span>{{ downloading ? '下载中...' : '下载' }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import MessagePlugin from '@/utils/message';
import { triggerBrowserDownload } from '@/utils/download';
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

function handleDownload() {
  if (downloading.value) return;
  downloading.value = true;
  triggerBrowserDownload(downloadUrl.value, props.info.name);
  MessagePlugin.success('已开始下载，请查看浏览器下载进度');
  window.setTimeout(() => { downloading.value = false; }, 1000);
}
</script>

<style scoped>
.file-share-row {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 14px 16px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: var(--font-body);
  transition: border-color var(--duration-fast), background var(--duration-fast), box-shadow var(--duration-fast);
}

.file-share-row:hover {
  border-color: var(--border-accent);
  background: var(--color-bg-hover);
  box-shadow: var(--shadow-sm);
}

.file-share-main {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 14px;
}

.file-share-thumb {
  width: 48px;
  height: 48px;
  flex: 0 0 48px;
  display: grid;
  place-items: center;
  overflow: hidden;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--color-bg-surface);
}

.file-share-info { min-width: 0; }
.file-name {
  margin: 0 0 6px;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-share-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.meta-separator { color: var(--text-tertiary); }
.mime-type { max-width: 220px; overflow: hidden; font-family: var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.expiry { color: var(--color-warning); }

.security-hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 7px;
  color: var(--color-success);
  font-size: 12px;
}
.security-hint.encrypted { color: var(--color-warning); }

.file-share-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
}
.file-share-actions button {
  display: inline-flex;
  min-width: 76px;
  min-height: 36px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background var(--duration-fast), border-color var(--duration-fast), color var(--duration-fast);
}
.preview-btn {
  color: var(--seed-primary);
  background: transparent;
  border: 1px solid var(--border-default);
}
.preview-btn:hover { background: var(--color-accent-soft); border-color: var(--border-accent); }
.download-btn { color: #fff; background: var(--seed-primary); border: 1px solid var(--seed-primary); }
.download-btn:hover { background: color-mix(in srgb, var(--seed-primary) 85%, #fff); }
.download-btn:disabled { cursor: not-allowed; opacity: .6; }

@media (max-width: 640px) {
  .file-share-row { align-items: flex-start; flex-direction: column; gap: 14px; padding: 12px; }
  .file-share-main { width: 100%; }
  .file-share-actions { width: 100%; }
  .file-share-actions button { flex: 1; }
  .mime-type { max-width: 150px; }
}
</style>
