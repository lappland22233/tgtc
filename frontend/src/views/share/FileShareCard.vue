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
    <button type="button" class="download-btn" :disabled="downloading" @click="handleDownload">
      <span class="download-icon">⬇</span>
      <span>{{ downloading ? '下载中...' : '下载文件' }}</span>
    </button>
    <p v-if="isEncrypted" class="security-hint encrypted">🔒 此文件通过加密分享链接提供，请勿传播</p>
    <p v-else class="security-hint">🔗 公开分享链接，任何持有链接的人都可访问</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import MessagePlugin from '@/utils/message';

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

// accessJwt 仅在用户通过分享密码校验后由后端签发（见 ShareView.vue onPasswordSubmit），
// 因此它的存在即可靠地表示这是一个加密（有密码）分享。
const isEncrypted = computed(() => !!props.accessJwt);

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

const downloading = ref(false);

/**
 * 【P1 安全】通过 JS fetch + Blob 下载，避免把 accessJwt 渲染进 <a href>：
 * token 不再出现在 DOM / 浏览器历史 / 地址栏 / Referer 中，
 * 也不会被"复制链接"带走（修复 accessJwt 经 URL 泄露的问题）。
 *
 * 注意：后端 ShareController 目前仅从 query 参数 ?access= 读取 access JWT
 * （不读取请求头），故 token 仍随请求 URL 发送，但只存在于瞬时的 JS 请求中，
 * 不落入页面。彻底改为请求头传递需后端配合。
 */
async function handleDownload() {
  if (downloading.value) return;
  downloading.value = true;
  try {
    const res = await fetch(downloadUrl.value);
    if (!res.ok) {
      let msg = `下载失败（${res.status}）`;
      try {
        const data = await res.json();
        if (data?.message) msg = data.message;
      } catch {
        // 非 JSON 错误体，使用默认提示
      }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = props.info.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  } catch (err) {
    MessagePlugin.error(err instanceof Error ? err.message : '下载失败，请稍后重试');
  } finally {
    downloading.value = false;
  }
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

.mime-type { font-family: var(--font-mono); font-size: 12px; }
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
.download-btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }

.download-icon {
  font-size: 18px;
  line-height: 1;
}

.security-hint {
  color: #6E7681;
  font-size: 12px;
  margin: 0;
}

.security-hint.encrypted {
  color: #F0883E;
}
</style>
