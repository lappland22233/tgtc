<template>
  <div class="file-share-card">
    <div class="type-icon-wrapper">
      <ThumbnailImg
        :file-id="info.id"
        :mime-type="info.mimeType"
        :file-name="info.name"
        :size="112"
        :src="buildShareThumbnailUrl(props.token, props.info.id, props.accessJwt)"
      />
    </div>
    <h1 class="file-name" :title="info.name">{{ info.name }}</h1>
    <dl class="meta-list">
      <div class="meta-row"><dt>大小</dt><dd>{{ formatSize(info.size) }}</dd></div>
      <div class="meta-row"><dt>类型</dt><dd class="mime-type" :title="info.mimeType">{{ info.mimeType }}</dd></div>
      <div class="meta-row"><dt>上传时间</dt><dd>{{ formatDateTime(info.createdAt) }}</dd></div>
      <div v-if="info.expiresAt" class="meta-row"><dt>有效期至</dt><dd class="expiry">{{ formatDateTime(info.expiresAt) }}</dd></div>
    </dl>
    <!-- 在线预览（仅可预览类型显示） -->
    <button v-if="previewKind" type="button" class="preview-btn" @click="previewVisible = true">
      <span class="download-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>
          <circle cx="12" cy="12" r="3"/>
        </svg>
      </span>
      <span>在线预览</span>
    </button>
    <button type="button" class="download-btn" :disabled="downloading" @click="handleDownload">
      <span class="download-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3v12"/>
          <path d="m7 12 5 5 5-5"/>
          <path d="M5 21h14"/>
        </svg>
      </span>
      <span>{{ downloading ? '下载中...' : '下载文件' }}</span>
    </button>
    <p v-if="isEncrypted" class="security-hint encrypted">
      <svg class="hint-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
      此文件通过加密分享链接提供，请勿传播
    </p>
    <p v-else class="security-hint">
      <svg class="hint-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
      </svg>
      公开分享链接，任何持有链接的人都可访问
    </p>

    <!-- 在线预览弹窗 -->
    <FilePreviewDialog
      v-model:visible="previewVisible"
      :name="info.name"
      :mime-type="info.mimeType"
      :size="info.size"
      :kind="previewKind"
      :src="buildSharePreviewUrl(props.token, props.info.id, props.accessJwt)"
      :download-url="downloadUrl"
      :file-id="props.info.id"
      :share-token="props.token"
      :share-access-jwt="props.accessJwt"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import MessagePlugin from '@/utils/message';
import { triggerBrowserDownload } from '@/utils/download';
import { getPreviewKind, buildSharePreviewUrl, buildShareThumbnailUrl } from '@/utils/preview';
import ThumbnailImg from '@/components/ThumbnailImg.vue';
import FilePreviewDialog from '@/components/file/FilePreviewDialog.vue';

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

/** 预览类别；null 时不显示「在线预览」按钮 */
const previewKind = computed(() => getPreviewKind(props.info.mimeType, props.info.name));
const previewVisible = ref(false);


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
 * 直接调用浏览器原生下载。
 * 后端返回 Content-Disposition: attachment，浏览器下载器自带进度条、暂停/恢复、
 * 保存对话框，无需前端 fetch 预校验（旧实现的 GET 兜底会把整个文件先读进内存，
 * 相当于下载两次，已移除）。
 */
function handleDownload() {
  if (downloading.value) return;
  downloading.value = true;
  triggerBrowserDownload(downloadUrl.value, props.info.name);
  MessagePlugin.success('已开始下载，请查看浏览器下载进度');
  // 短暂禁用避免重复点击；浏览器接管后无需等待前端异步完成
  window.setTimeout(() => { downloading.value = false; }, 1000);
}
</script>

<style scoped>
.file-share-card {
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  padding: 48px 40px;
  width: 100%;
  max-width: 480px;
  text-align: center;
  box-shadow: var(--shadow-lg);
  font-family: var(--font-body);
  color: var(--text-primary);
}

.type-icon-wrapper {
  width: 128px;
  height: 128px;
  margin: 0 auto 24px;
  border-radius: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
}

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
  background: var(--color-bg);
  border-radius: var(--radius-md);
  text-align: left;
}

.meta-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  padding: 4px 0;
}

.meta-row dt { color: var(--text-secondary); font-weight: normal; min-width: 80px; }
.meta-row dd { color: var(--text-primary); margin: 0; text-align: right; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.mime-type { font-family: var(--font-mono); font-size: 12px; }
.expiry { color: var(--color-warning); }

.download-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 16px 24px;
  background: var(--seed-primary);
  color: #fff;
  border: none;
  border-radius: var(--radius-md);
  font-size: 16px;
  font-weight: 500;
  cursor: pointer;
  text-decoration: none;
  transition: background 0.2s, transform 0.1s;
  font-family: inherit;
  margin-bottom: 16px;
}

.download-btn:hover { background: color-mix(in srgb, var(--seed-primary) 85%, #fff); }
.download-btn:active { transform: scale(0.98); }
.download-btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }

/* 在线预览按钮：下载主按钮的弱化版（次级样式） */
.preview-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 14px 24px;
  margin-bottom: 12px;
  background: transparent;
  color: var(--seed-primary);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.2s, border-color 0.2s, transform 0.1s;
}

.preview-btn:hover { background: var(--color-accent-soft); border-color: var(--seed-primary); }
.preview-btn:active { transform: scale(0.98); }

.download-icon {
  display: inline-flex;
  align-items: center;
  line-height: 1;
}

.security-hint {
  color: var(--text-tertiary);
  font-size: 12px;
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.security-hint.encrypted {
  color: var(--color-warning);
}

.hint-icon {
  flex-shrink: 0;
}
</style>
