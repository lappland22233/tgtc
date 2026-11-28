<template>
  <section class="workspace-details" aria-label="文件详情">
    <div class="details-heading">
      <h2>文件详情</h2>
      <button type="button" class="details-close" aria-label="关闭文件详情" @click="emit('close')">
        <t-icon name="close" aria-hidden="true" />
      </button>
    </div>
    <div class="details-body">
      <component
        :is="canPreview ? 'button' : 'div'"
        class="details-preview"
        v-bind="canPreview ? { type: 'button', 'aria-label': '预览 ' + file.originalName } : {}"
        @click="canPreview && emit('preview', file)"
      >
        <ThumbnailImg
          v-if="hasThumbnail"
          :key="file.id"
          :file-id="file.id"
          :mime-type="file.mimeType"
          :file-name="file.originalName"
          :context="thumbnailContext"
          :version="file.uploadVersion"
          :size="126"
          fit="contain"
          aria-hidden="true"
        />
        <span v-else-if="previewKind === 'pdf'" class="pdf-cover" aria-hidden="true">
          <small>PDF</small>
          <strong>{{ file.originalName.replace(/\.pdf$/i, '') }}</strong>
        </span>
        <FileTypeIcon v-else :mime-type="file.mimeType" :file-name="file.originalName" :size="52" with-bg aria-hidden="true" />
      </component>
      <div class="details-info" aria-live="polite">
        <h3>{{ file.originalName }}</h3>
        <p class="details-meta">{{ fileTypeLabel }} · {{ formatSize(file.size) }}</p>
        <dl class="details-attributes">
          <dt>上传时间</dt><dd>{{ formatDate(file.createdAt) }}</dd>
          <dt>访问权限</dt><dd>{{ file.accessType === 'public' ? '公开' : '私有' }}</dd>
          <template v-if="file.tags?.length">
            <dt>标签</dt><dd>{{ file.tags.map((tag) => tag.name).join('、') }}</dd>
          </template>
        </dl>
        <div v-if="canPreview || actionable" class="details-actions">
          <button v-if="canPreview" type="button" @click="emit('preview', file)"><t-icon name="view" aria-hidden="true" />预览</button>
          <template v-if="actionable">
            <button type="button" @click="emit('download', file)"><t-icon name="download" aria-hidden="true" />下载</button>
            <button type="button" @click="emit('share', file)"><t-icon name="share" aria-hidden="true" />分享</button>
          </template>
        </div>
        <p v-else-if="file.isDeleted || file.status === 'processing'" class="details-meta">
          {{ file.isDeleted ? '已删除' : '处理中' }}
        </p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import FileTypeIcon from '@/components/FileTypeIcon.vue';
import ThumbnailImg from '@/components/ThumbnailImg.vue';
import type { FileItem } from '@/types/file';
import { canPreviewFile, isFileActionable } from '@/utils/file-row-predicates';
import { formatDate, formatSize } from '@/utils/format';
import { getPreviewKind, type PreviewKind } from '@/utils/preview';

const props = defineProps<{ file: FileItem; thumbnailContext: string }>();
const emit = defineEmits<{
  close: [];
  preview: [file: FileItem];
  download: [file: FileItem];
  share: [file: FileItem];
}>();

const previewLabels: Record<PreviewKind, string> = {
  pdf: 'PDF 文档', image: '图像', video: '视频', audio: '音频', text: '文本',
};
const previewKind = computed(() => getPreviewKind(props.file.mimeType, props.file.originalName));
const actionable = computed(() => isFileActionable(props.file));
const canPreview = computed(() => canPreviewFile(props.file));
const hasThumbnail = computed(() => canPreview.value && (previewKind.value === 'image' || previewKind.value === 'video'));
const fileTypeLabel = computed(() => {
  if (previewKind.value) return previewLabels[previewKind.value];
  const extension = /\.([a-z\d]{1,12})$/i.exec(props.file.originalName)?.[1];
  return extension ? `${extension.toUpperCase()} 文件` : '文件';
});
</script>

<style scoped>
.workspace-details { min-width: 0; padding: 16px; color: var(--workspace-text); }

.details-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.details-heading h2 { font-size: 13px; font-weight: 650; }

.details-preview,
.details-close,
.details-actions button {
  color: inherit;
  font: inherit;
}

.details-preview {
  display: grid;
  place-items: center;
  width: 100%;
  min-width: 0;
  min-height: 166px;
  padding: 12px 0;
  border: 1px solid var(--workspace-border);
  border-radius: var(--radius-lg);
  background: var(--workspace-surface);
}

button.details-preview, .details-close, .details-actions button { cursor: pointer; }
button.details-preview:hover { border-color: var(--workspace-accent); }

.pdf-cover {
  position: relative;
  isolation: isolate;
  display: flex;
  flex-direction: column;
  gap: 9px;
  width: 104px;
  min-height: 132px;
  padding: 10px;
  border-radius: 3px;
  background: var(--workspace-archive);
  color: var(--workspace-on-archive);
  box-shadow: var(--shadow-md);
  text-align: start;
}

.pdf-cover::after {
  content: '';
  position: absolute;
  inset: 45% 0 0;
  z-index: -1;
  border-radius: inherit;
  background:
    radial-gradient(circle at 72% 68%, var(--workspace-archive-mark) 0 4px, transparent 5px),
    repeating-radial-gradient(circle at 92% 100%, transparent 0 15px, color-mix(in srgb, var(--workspace-archive-line) 38%, transparent) 15px 16px);
  mask-image: linear-gradient(transparent, currentColor 42%);
}

.pdf-cover small { font-size: 11px; font-weight: 650; letter-spacing: .12em; }
.pdf-cover strong { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; overflow-wrap: anywhere; font-size: 14px; line-height: 1.22; }
.details-info h3 { margin: 12px 0 2px; overflow-wrap: anywhere; font-size: 16px; font-weight: 650; }
.details-meta { margin: 0; color: var(--workspace-muted); font-size: 12px; }

.details-attributes {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 5px 10px;
  padding-top: 10px;
  margin: 12px 0;
  border-top: 1px solid var(--workspace-border);
  font-size: 12px;
}

.details-attributes dt { color: var(--workspace-muted); }
.details-attributes dd { margin: 0; overflow-wrap: anywhere; }
.details-actions { display: flex; flex-wrap: wrap; gap: 6px; }

.details-close, .details-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 34px;
  padding: 4px 7px;
  border: 1px solid var(--workspace-border);
  border-radius: var(--radius-md);
  background: var(--workspace-surface);
  font-size: 13px;
}

.details-close { width: 34px; border-color: transparent; background: transparent; font-size: 16px; }
.details-close:hover, .details-actions button:hover { color: var(--workspace-accent); background: var(--workspace-selected); }
.workspace-details button:focus-visible { outline: 2px solid var(--workspace-accent); outline-offset: 2px; }

@media (min-width: 481px) {
  .details-body { display: grid; grid-template-columns: minmax(112px, 38%) minmax(0, 1fr); gap: 12px; align-items: start; }
  .details-info h3 { margin-top: 0; }
}

@media (min-width: 769px) {
  .details-body { display: block; }
  .details-info h3 { margin-top: 12px; }
}

@media (pointer: coarse) {
  .details-close, .details-actions button { min-height: 44px; }
  .details-close { width: 44px; }
}
</style>
