<template>
  <span
    class="file-type-icon"
    :class="[`file-type-icon--${iconType}`, { 'file-type-icon--with-bg': withBg }]"
    :style="{ width: size + 'px', height: size + 'px' }"
    role="img"
    :aria-label="ariaLabel"
  >
    <svg
      :width="svgSize"
      :height="svgSize"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <!-- image -->
      <template v-if="iconType === 'image'">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="M21 15l-5-5L5 21" />
      </template>
      <!-- video -->
      <template v-else-if="iconType === 'video'">
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M10 9l5 3-5 3V9z" />
      </template>
      <!-- audio -->
      <template v-else-if="iconType === 'audio'">
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </template>
      <!-- pdf -->
      <template v-else-if="iconType === 'pdf'">
        <path d="M6 2h9l5 5v13a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z" />
        <path d="M14 2v6h6" />
        <path d="M9 13h1.5a1.5 1.5 0 010 3H9v-3zM9 13v5" />
        <path d="M14 18v-5h1.5a1.5 1.5 0 011.5 1.5v0a1.5 1.5 0 01-1.5 1.5H14" />
      </template>
      <!-- word / document -->
      <template v-else-if="iconType === 'word'">
        <path d="M6 2h9l5 5v13a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z" />
        <path d="M14 2v6h6" />
        <path d="M8 13h8M8 16h5" />
      </template>
      <!-- excel / spreadsheet -->
      <template v-else-if="iconType === 'excel'">
        <path d="M6 2h9l5 5v13a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z" />
        <path d="M14 2v6h6" />
        <path d="M8 12h8v8H8z" />
        <path d="M8 15.5h8M11.5 12v8" />
      </template>
      <!-- ppt / presentation -->
      <template v-else-if="iconType === 'ppt'">
        <path d="M6 2h9l5 5v13a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z" />
        <path d="M14 2v6h6" />
        <rect x="8" y="12" width="8" height="5" rx="0.5" />
        <path d="M12 17v3" />
      </template>
      <!-- archive -->
      <template v-else-if="iconType === 'archive'">
        <path d="M6 2h9l5 5v13a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z" />
        <path d="M14 2v6h6" />
        <path d="M12 8v2M12 12v2M12 16v2" />
      </template>
      <!-- code -->
      <template v-else-if="iconType === 'code'">
        <path d="M6 2h9l5 5v13a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z" />
        <path d="M14 2v6h6" />
        <path d="M10 12l-2 2.5 2 2.5M14 12l2 2.5-2 2.5" />
      </template>
      <!-- text -->
      <template v-else-if="iconType === 'text'">
        <path d="M6 2h9l5 5v13a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z" />
        <path d="M14 2v6h6" />
        <path d="M8 12h8M8 15h8M8 18h4" />
      </template>
      <!-- folder -->
      <template v-else-if="iconType === 'folder'">
        <path d="M3 6a2 2 0 012-2h4l2 2h8a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V6z" />
      </template>
      <!-- generic / default -->
      <template v-else>
        <path d="M6 2h9l5 5v13a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z" />
        <path d="M14 2v6h6" />
      </template>
    </svg>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { getFileIconType, type FileIconType } from '../utils/file-icon-type';

const props = withDefaults(defineProps<{
  mimeType?: string;
  fileName?: string;
  size?: number;
  withBg?: boolean;
}>(), {
  mimeType: '',
  fileName: '',
  size: 20,
  withBg: false,
});

const svgSize = computed(() => Math.round(props.size * 0.6));

const iconType = computed<FileIconType>(() => {
  return getFileIconType(props.mimeType, props.fileName);
});

const ariaLabel = computed(() => {
  const labels: Record<FileIconType, string> = {
    image: '图片文件', video: '视频文件', audio: '音频文件',
    pdf: 'PDF 文档', word: 'Word 文档', excel: 'Excel 表格',
    ppt: '演示文稿', archive: '压缩文件', code: '代码文件',
    text: '文本文件', folder: '文件夹', generic: '文件',
  };
  return labels[iconType.value];
});
</script>

<style scoped>
.file-type-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--text-secondary, #5F6B7A);
}

.file-type-icon--with-bg {
  border-radius: 50%;
}

/* Type-specific colors (only applied with --with-bg) */
.file-type-icon--with-bg.file-type-icon--image { background: color-mix(in srgb, #7B2D8B 10%, var(--color-bg-surface, #fff)); color: #7B2D8B; }
.file-type-icon--with-bg.file-type-icon--video { background: color-mix(in srgb, #D36609 10%, var(--color-bg-surface, #fff)); color: #D36609; }
.file-type-icon--with-bg.file-type-icon--audio { background: color-mix(in srgb, #0E7490 10%, var(--color-bg-surface, #fff)); color: #0E7490; }
.file-type-icon--with-bg.file-type-icon--pdf { background: color-mix(in srgb, #D13212 10%, var(--color-bg-surface, #fff)); color: #D13212; }
.file-type-icon--with-bg.file-type-icon--word { background: color-mix(in srgb, #0972D3 10%, var(--color-bg-surface, #fff)); color: #0972D3; }
.file-type-icon--with-bg.file-type-icon--excel { background: color-mix(in srgb, #037F0C 10%, var(--color-bg-surface, #fff)); color: #037F0C; }
.file-type-icon--with-bg.file-type-icon--ppt { background: color-mix(in srgb, #D36609 10%, var(--color-bg-surface, #fff)); color: #D36609; }
.file-type-icon--with-bg.file-type-icon--archive { background: color-mix(in srgb, #92400E 10%, var(--color-bg-surface, #fff)); color: #92400E; }
.file-type-icon--with-bg.file-type-icon--code { background: color-mix(in srgb, #1D4ED8 10%, var(--color-bg-surface, #fff)); color: #1D4ED8; }
.file-type-icon--with-bg.file-type-icon--text { background: color-mix(in srgb, var(--seed-fg, #16191F) 8%, var(--color-bg-surface, #fff)); color: var(--text-secondary, #5F6B7A); }
.file-type-icon--with-bg.file-type-icon--folder { background: color-mix(in srgb, #B45309 10%, var(--color-bg-surface, #fff)); color: #B45309; }
.file-type-icon--with-bg.file-type-icon--generic { background: color-mix(in srgb, var(--seed-fg, #16191F) 6%, var(--color-bg-surface, #fff)); color: var(--text-tertiary, #5A6778); }

/* Dark theme adjustments */
[data-theme="dark"] .file-type-icon--with-bg.file-type-icon--image { color: #C084FC; }
[data-theme="dark"] .file-type-icon--with-bg.file-type-icon--video { color: #FB923C; }
[data-theme="dark"] .file-type-icon--with-bg.file-type-icon--audio { color: #22D3EE; }
[data-theme="dark"] .file-type-icon--with-bg.file-type-icon--pdf { color: #E8604C; }
[data-theme="dark"] .file-type-icon--with-bg.file-type-icon--word { color: #539FE5; }
[data-theme="dark"] .file-type-icon--with-bg.file-type-icon--excel { color: #53D769; }
[data-theme="dark"] .file-type-icon--with-bg.file-type-icon--ppt { color: #FB923C; }
[data-theme="dark"] .file-type-icon--with-bg.file-type-icon--archive { color: #FBBF24; }
[data-theme="dark"] .file-type-icon--with-bg.file-type-icon--code { color: #60A5FA; }
[data-theme="dark"] .file-type-icon--with-bg.file-type-icon--folder { color: #FBBF24; }
</style>
