<template>
  <transition name="upload-indicator">
    <div v-if="visible" class="upload-indicator" role="status" aria-live="polite">
      <div class="upload-indicator__header">
        <span class="upload-indicator__icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 16V4M8 8l4-4 4 4" />
            <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
          </svg>
        </span>
        <span class="upload-indicator__title">{{ allFinished ? '上传完成' : '正在上传文件' }}</span>
        <button class="upload-indicator__close" aria-label="收起上传进度" @click="dismiss">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <t-progress :percentage="uploadStore.overallProgress" size="small" :status="allFinished ? 'success' : 'active'" />

      <div class="upload-indicator__meta">
        <template v-if="allFinished">
          {{ successCount }} 个成功<template v-if="failedCount > 0"> · {{ failedCount }} 个失败</template>
        </template>
        <template v-else>
          进行中 {{ uploadStore.activeCount }} · 排队 {{ uploadStore.queuedCount }} · {{ uploadStore.overallSpeed }}
        </template>
      </div>

      <div class="upload-indicator__actions">
        <t-button size="small" variant="text" @click="viewDetails">查看详情</t-button>
        <t-button v-if="!allFinished" size="small" variant="text" theme="danger" @click="handleCancelAll">全部取消</t-button>
        <t-button v-else size="small" variant="text" @click="clearAndDismiss">清除</t-button>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { DialogPlugin } from 'tdesign-vue-next';
import { useUploadStore } from '../stores/upload';

/**
 * 全局后台上传指示器：挂载在 Layout，跨路由常驻。
 * 上传调度位于模块级 upload store，关闭上传弹窗后此处继续展示进度。
 * 全部完成后短暂展示完成态，5 秒后自动收起（也可手动收起/清除）。
 */
const uploadStore = useUploadStore();
const router = useRouter();
const route = useRoute();

const dismissed = ref(false);
let hideTimer: ReturnType<typeof setTimeout> | null = null;

const hasActive = computed(
  () => uploadStore.isPumping || uploadStore.activeCount > 0 || uploadStore.queuedCount > 0,
);
const allFinished = computed(
  () => uploadStore.entries.length > 0 && !hasActive.value,
);
const successCount = computed(() => uploadStore.successCount);
const failedCount = computed(() => uploadStore.errorCount);
const visible = computed(() => !dismissed.value && uploadStore.entries.length > 0);

function clearHideTimer() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

// 有新活动 → 重置收起状态；全部完成 → 5 秒后自动收起完成态
watch(hasActive, (active) => {
  clearHideTimer();
  if (active) {
    dismissed.value = false;
  } else if (uploadStore.entries.length > 0 && !dismissed.value) {
    hideTimer = setTimeout(() => {
      dismissed.value = true;
    }, 5000);
  }
}, { immediate: true });

onUnmounted(clearHideTimer);

function dismiss() {
  clearHideTimer();
  dismissed.value = true;
}

function clearAndDismiss() {
  uploadStore.clearFinished();
  dismiss();
}

/** 跳转到文件页并打开上传弹窗：注入 uploadDialog=1 query，由 FileList 消费后清除 */
function viewDetails() {
  if (route.name === 'UserFiles') {
    router.push({ query: { ...route.query, uploadDialog: '1' } });
  } else {
    router.push({ path: '/files', query: { uploadDialog: '1' } });
  }
}

function handleCancelAll() {
  const pendingTotal = uploadStore.activeCount + uploadStore.queuedCount;
  const dialog = DialogPlugin.confirm({
    header: '取消全部上传',
    body: `确定取消 ${pendingTotal} 个进行中/排队中的文件上传吗？`,
    theme: 'warning',
    confirmBtn: '全部取消',
    cancelBtn: '返回',
    onConfirm: () => {
      uploadStore.cancelAll();
      dialog.hide();
    },
  });
}
</script>

<style scoped>
.upload-indicator {
  position: fixed;
  right: var(--space-4);
  bottom: var(--space-4);
  z-index: 2500;
  width: min(320px, calc(100vw - var(--space-8)));
  padding: var(--space-3) var(--space-4);
  background: var(--color-bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
}

.upload-indicator__header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.upload-indicator__icon {
  display: inline-flex;
  color: var(--seed-primary);
}

.upload-indicator__title {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.upload-indicator__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: background var(--duration-fast, 0.15s) ease, color var(--duration-fast, 0.15s) ease;
}

.upload-indicator__close:hover,
.upload-indicator__close:focus-visible {
  background: var(--color-bg-hover);
  color: var(--text-primary);
}

.upload-indicator__meta {
  margin-top: var(--space-2);
  font-size: 12px;
  color: var(--text-secondary);
}

.upload-indicator__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-1);
  margin-top: var(--space-1);
}

/* 进出场动画 */
.upload-indicator-enter-active,
.upload-indicator-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.upload-indicator-enter-from,
.upload-indicator-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
