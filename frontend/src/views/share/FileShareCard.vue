<template>
  <div class="file-share-card">
    <div :class="['type-icon-wrapper', iconType]">
      <div class="type-icon">{{ fileEmoji }}</div>
    </div>
    <h1 class="file-name" :title="info.name">{{ info.name }}</h1>
    <dl class="meta-list">
      <div class="meta-row"><dt>大小</dt><dd>{{ formatSize(info.size) }}</dd></div>
      <div class="meta-row"><dt>类型</dt><dd class="mime-type" :title="info.mimeType">{{ info.mimeType }}</dd></div>
      <div class="meta-row"><dt>上传时间</dt><dd>{{ formatDateTime(info.createdAt) }}</dd></div>
      <div v-if="info.expiresAt" class="meta-row"><dt>有效期至</dt><dd class="expiry">{{ formatDateTime(info.expiresAt) }}</dd></div>
    </dl>
    <a :href="downloadUrl" :download="info.name" class="download-btn" @click="onDownloadClick">
      <span class="download-icon">⬇</span>
      <span>下载文件</span>
    </a>
    <p class="security-hint">🔒 此文件通过加密分享链接提供，请勿传播</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

interface FileInfo {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  createdAt: string;
  expiresAt?: string | null;
}

const props = defineProps<{
  info: FileInfo;
  token: string;
  accessJwt?: string;
}>();

type IconType = 'image' | 'video' | 'audio' | 'pdf' | 'archive' | 'word' | 'excel' | 'ppt' | 'file';

const iconType = computed<IconType>(() => {
  const m = props.info.mimeType.toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (m.includes('zip') || m.includes('rar') || m.includes('7z') || m.includes('tar')) return 'archive';
  if (m.includes('word') || m.includes('msword') || m.includes('wordprocessing')) return 'word';
  if (m.includes('sheet') || m.includes('excel') || m.includes('spreadsheet')) return 'excel';
  if (m.includes('presentation') || m.includes('powerpoint')) return 'ppt';
  return 'file';
});

const fileEmoji = computed(() => {
  const map: Record<IconType, string> = {
    image: '🖼️', video: '🎬', audio: '🎵', pdf: '📄',
    archive: '🗜️', word: '📝', excel: '📊', ppt: '📽️', file: '📄',
  };
  return map[iconType.value];
});

const downloadUrl = computed(() => {
  let url = `/api/s/${encodeURIComponent(props.token)}/download/${encodeURIComponent(props.info.id)}`;
  if (props.accessJwt) {
    url += `?access=${encodeURIComponent(props.accessJwt)}`;
  }
  return url;
});

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

function onDownloadClick() {
  // 浏览器原生 <a download> 触发，无需额外处理。
  // access JWT 通过 query 传递，由后端 ShareController 校验。
}
</script>

<style scoped>
.file-share-card {
  background: #21262D;
  border: 1px solid #30363D;
  border-radius: 16px;
  padding: 48px 40px;
  width: 100%;
  max-width: 480px;
  text-align: center;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
  color: #E6EDF3;
}

.type-icon-wrapper {
  width: 128px;
  height: 128px;
  margin: 0 auto 24px;
  border-radius: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 72px;
  background: linear-gradient(135deg, rgba(0, 82, 217, 0.15), rgba(110, 118, 129, 0.1));
  border: 1px solid #30363D;
}

.type-icon-wrapper.image { background: linear-gradient(135deg, rgba(64, 192, 87, 0.2), rgba(110, 118, 129, 0.1)); }
.type-icon-wrapper.video { background: linear-gradient(135deg, rgba(255, 159, 64, 0.2), rgba(110, 118, 129, 0.1)); }
.type-icon-wrapper.audio { background: linear-gradient(135deg, rgba(255, 99, 132, 0.2), rgba(110, 118, 129, 0.1)); }
.type-icon-wrapper.pdf { background: linear-gradient(135deg, rgba(248, 81, 73, 0.2), rgba(110, 118, 129, 0.1)); }
.type-icon-wrapper.archive { background: linear-gradient(135deg, rgba(255, 205, 86, 0.2), rgba(110, 118, 129, 0.1)); }

.file-name {
  font-size: 22px;
  font-weight: 600;
  margin: 0 0 24px;
  word-break: break-all;
  line-height: 1.4;
  max-height: 4.2em;
  overflow: hidden;
}

.meta-list {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
  margin: 0 0 32px;
  padding: 16px 20px;
  background: rgba(13, 17, 23, 0.5);
  border-radius: 8px;
  text-align: left;
}

.meta-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  padding: 4px 0;
}

.meta-row dt { color: #8B949E; font-weight: normal; min-width: 80px; }
.meta-row dd { color: #E6EDF3; margin: 0; text-align: right; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.mime-type { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 12px; }
.expiry { color: #F0883E; }

.download-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 16px 24px;
  background: #0052D9;
  color: #fff;
  border: none;
  border-radius: 10px;
  font-size: 16px;
  font-weight: 500;
  cursor: pointer;
  text-decoration: none;
  transition: background 0.2s, transform 0.1s;
  font-family: inherit;
  margin-bottom: 16px;
}

.download-btn:hover { background: #0969DA; }
.download-btn:active { transform: scale(0.98); }

.download-icon {
  font-size: 18px;
  line-height: 1;
}

.security-hint {
  color: #6E7681;
  font-size: 12px;
  margin: 0;
}
</style>
