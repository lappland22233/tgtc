<template>
  <div class="file-share-card" :class="{ 'file-share-card--encrypted': isEncrypted }">
    <!-- 预览大区：居中放大缩略图（图片/视频显示缩略图，其余显示大类型图标） -->
    <div class="file-share-hero">
      <ThumbnailImg
        :file-id="info.id"
        :mime-type="info.mimeType"
        :file-name="info.name"
        :size="160"
        :src="buildShareThumbnailUrl(props.token, props.info.id)"
        :context="`s:${props.token}`"
        :version="info.uploadVersion"
      />
    </div>

    <!-- 内容区 -->
    <div class="file-share-body">
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
      <div class="file-share-actions">
        <button v-if="previewKind" type="button" class="preview-btn" @click="openPreview">
          <t-icon name="browse" />
          <span>在线预览</span>
        </button>
        <button type="button" class="download-btn" :disabled="downloading" @click="handleDownload">
          <t-icon name="download" />
          <span>{{ downloading ? '下载中...' : '下载文件' }}</span>
        </button>
      </div>
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
.file-share-card {
  width: 100%;
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xl);
  overflow: hidden;
  box-shadow: var(--shadow-lg);
  color: var(--text-primary);
  font-family: var(--font-body);
  transition: border-color var(--duration-fast), box-shadow var(--duration-fast);
}

.file-share-card:hover {
  border-color: var(--border-strong);
}

/* 预览大区：顶部极光渐变 + 居中放大缩略图 */
.file-share-hero {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 56px 24px;
  background:
    radial-gradient(120% 100% at 50% 0%, color-mix(in srgb, var(--seed-primary) 16%, transparent), transparent 62%),
    var(--color-bg);
}

/* 内容区 */
.file-share-body {
  padding: 28px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.file-name {
  margin: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 22px;
  font-weight: 600;
  line-height: 1.35;
  word-break: break-all;
}

.file-share-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
}
.meta-separator { color: var(--text-tertiary); }
.mime-type { max-width: 260px; overflow: hidden; font-family: var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.expiry { color: var(--color-warning); }

.security-hint {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-success) 12%, transparent);
  color: var(--color-success);
  font-size: 12px;
}
.security-hint.encrypted {
  background: color-mix(in srgb, var(--seed-primary) 16%, transparent);
  color: var(--seed-accent);
}

.file-share-actions {
  display: flex;
  gap: 12px;
  margin-top: 4px;
}
.file-share-actions button {
  display: inline-flex;
  flex: 1;
  min-height: 48px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 16px;
  border-radius: var(--radius-md);
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--duration-fast), border-color var(--duration-fast), color var(--duration-fast);
}
.preview-btn {
  color: var(--seed-primary);
  background: transparent;
  border: 1px solid var(--border-strong);
}
.preview-btn:hover { background: var(--color-accent-soft); border-color: var(--seed-primary); }
.download-btn { color: #fff; background: var(--seed-primary); border: 1px solid var(--seed-primary); }
.download-btn:hover { background: color-mix(in srgb, var(--seed-primary) 85%, #fff); }
.download-btn:disabled { cursor: not-allowed; opacity: .6; }

@media (max-width: 480px) {
  .file-share-hero { padding: 40px 16px; }
  .file-share-body { padding: 20px 16px; }
  .file-name { font-size: 18px; }
  .file-share-actions { flex-direction: column; }
  .mime-type { max-width: 160px; }
}
</style>
