<template>
  <div v-if="loading" class="fpv-state">
    <t-loading size="medium" text="正在加载文本内容…" />
  </div>
  <div v-else-if="tooLarge" class="fpv-state fpv-error">
    <t-icon name="info-circle" class="fpv-state-icon" />
    <p>文件过大，请下载查看</p>
  </div>
  <div v-else-if="errorMessage" class="fpv-state fpv-error">
    <t-icon name="close-circle" class="fpv-state-icon" />
    <p>{{ errorMessage }}</p>
    <button type="button" class="fpv-btn" @click="emit('download')">
      <t-icon name="download" />下载文件
    </button>
  </div>
  <div v-else class="fpv-text-panel">
    <div class="fpv-text-toolbar">
      <div class="fpv-text-toolbar-left">
        <t-icon name="file-code" class="fpv-text-type-icon" aria-hidden="true" />
        <span class="fpv-text-type-label">文本文件</span>
      </div>
      <div class="fpv-text-toolbar-meta">
        <template v-if="mimeType"><span>{{ mimeType }}</span></template>
        <template v-if="size != null"><span> · {{ formatSize(size) }}</span></template>
        <template v-if="charCount > 0"><span> · {{ charCount }} 字符</span></template>
      </div>
    </div>
    <pre class="fpv-text">{{ content }}</pre>
  </div>
</template>

<script setup lang="ts">
/**
 * 文本预览面板（纯展示组件，M6 从 FilePreviewDialog.vue 拆出）。
 *
 * 三种兜底态（加载中 / 文件过大 / 读取失败）与正文面板互斥，判定优先级与
 * 拆分前的 v-if / v-else-if 链完全一致，由父组件传入的 props 驱动；
 * 组件本身不发起请求、不访问 store，下载意图经 download 事件回传宿主。
 */
import { formatSizeCompact as formatSize } from '../../utils/format';

withDefaults(defineProps<{
  /** 正在拉取文本内容 */
  loading: boolean;
  /** 超出可预览大小上限 */
  tooLarge: boolean;
  /** 读取失败原因；为空表示无错误 */
  errorMessage: string | null;
  /** 文本 MIME（工具栏展示） */
  mimeType: string;
  /** 文件字节数；null 表示未知 */
  size: number | null;
  /** 正文字符数；0 表示不展示 */
  charCount: number;
  /** 正文内容 */
  content: string;
}>(), {
  errorMessage: null,
  size: null,
  charCount: 0,
  content: '',
  mimeType: '',
  loading: false,
  tooLarge: false,
});

const emit = defineEmits<{
  download: [];
}>();
</script>

<style scoped src="./preview-shared.css"></style>

<style scoped>
/* ═══════════════ 文本预览面板 ═══════════════ */
.fpv-text-panel {
  align-self: stretch;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.fpv-text-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border-default);
  background: color-mix(in srgb, var(--seed-primary) 4%, var(--color-bg-overlay));
  flex-shrink: 0;
}

.fpv-text-toolbar-left {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.fpv-text-type-icon {
  font-size: 16px;
  color: var(--seed-primary);
  flex-shrink: 0;
}

.fpv-text-type-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fpv-text-toolbar-meta {
  display: flex;
  align-items: center;
  gap: 2px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 1;
}

.fpv-text {
  flex: 1;
  min-height: 0;
  margin: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 14px 16px;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-primary);
  tab-size: 4;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}

/* 文本阅读区滚动条 */
.fpv-text::-webkit-scrollbar { width: 8px; height: 8px; }
.fpv-text::-webkit-scrollbar-track { background: transparent; }
.fpv-text::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 4px; }
.fpv-text::-webkit-scrollbar-thumb:hover { background: var(--text-tertiary); }

@media (max-width: 720px) {
  .fpv-text-toolbar-meta {
    font-size: 10px;
  }
}
</style>
