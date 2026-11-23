<template>
  <div ref="root" class="workspace-transfers" @keydown.esc="handleEscape">
    <button
      ref="trigger"
      type="button"
      class="transfer-button"
      :aria-controls="panelId"
      :aria-expanded="visible"
      :aria-label="taskCount ? `传输，${taskCount} 个任务` : '传输'"
      @click="visible = !visible"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m3 16 4 4 4-4M7 20V4m6 4 4-4 4 4m-4-4v16" />
      </svg>
      传输
      <span v-if="taskCount" class="transfer-count" aria-hidden="true">{{ taskCount }}</span>
    </button>

    <Teleport :to="dockTarget ?? 'body'" :disabled="!dockTarget">
      <section
        v-show="visible"
        :id="panelId"
        class="transfer-panel"
        :class="{ 'transfer-popover': !dockTarget }"
        :aria-labelledby="titleId"
        @keydown.esc="handleEscape"
      >
        <header class="transfer-header">
          <h2 :id="titleId">传输</h2>
          <button
            ref="closeButton"
            type="button"
            class="transfer-close"
            aria-label="关闭传输面板"
            @click="closePanel(true)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </header>
        <template v-if="visible">
          <div v-if="uploadStore.entries.length || downloadsStore.hasActiveJobs" class="transfer-queues">
            <UploadProgressIndicator @open-details="closePanel()" />
            <DownloadQueueIndicator embedded />
          </div>
          <p v-else class="transfer-empty">暂无传输任务</p>
        </template>
      </section>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { WORKSPACE_TRANSFERS } from '@/composables/workspaceTransfers';
import { useDownloadsStore } from '@/stores/downloads';
import { useUploadStore } from '@/stores/upload';
import MessagePlugin from '@/utils/message';
import DownloadQueueIndicator from './DownloadQueueIndicator.vue';
import UploadProgressIndicator from './UploadProgressIndicator.vue';

const route = useRoute();
const workspaceTransfers = inject(WORKSPACE_TRANSFERS, null);
const visible = workspaceTransfers?.visible ?? ref(false);
const dockTarget = computed(() => workspaceTransfers?.target.value ?? null);
const panelId = 'workspace-transfer-panel';
const titleId = 'workspace-transfer-heading';
const root = ref<HTMLDivElement>();
const trigger = ref<HTMLButtonElement>();
const closeButton = ref<HTMLButtonElement>();
const uploadStore = useUploadStore();
const downloadsStore = useDownloadsStore();
const uploadCount = computed(() => uploadStore.activeCount + uploadStore.queuedCount);
const taskCount = computed(() => uploadCount.value + downloadsStore.jobs.length);
const uploading = computed(() => uploadStore.isPumping || uploadCount.value > 0);

function closePanel(restoreFocus = false) {
  visible.value = false;
  if (restoreFocus) trigger.value?.focus();
}

function handleEscape(event: KeyboardEvent) {
  if (!visible.value) return;
  event.preventDefault();
  event.stopPropagation();
  closePanel(true);
}

function handleOutsidePress(event: PointerEvent) {
  if (!visible.value || dockTarget.value || !(event.target instanceof Element)) return;
  if (root.value?.contains(event.target) || event.target.closest('[role="dialog"], dialog[open]')) return;
  closePanel();
}

watch(() => route.path, () => closePanel());
watch(visible, async (open) => {
  if (!open) return;
  await nextTick();
  if (visible.value) closeButton.value?.focus();
});

watch(uploading, (active, wasActive) => {
  if (active || !wasActive || !uploadStore.entries.length) return;
  const { successCount, errorCount, cancelledCount } = uploadStore;
  const message = [
    successCount && `${successCount} 个已接收`,
    errorCount && `${errorCount} 个失败`,
    cancelledCount && `${cancelledCount} 个取消`,
  ].filter(Boolean).join('，');
  if (errorCount) MessagePlugin.warning(`上传已结束，${message}`);
  else if (successCount) MessagePlugin.success(`上传已结束，${message}`);
  else MessagePlugin.info(`上传已结束，${message}`);
});

onMounted(() => document.addEventListener('pointerdown', handleOutsidePress));
onUnmounted(() => document.removeEventListener('pointerdown', handleOutsidePress));
</script>

<style scoped>
.workspace-transfers {
  position: relative;
  flex: none;
}

:is(.transfer-button, .transfer-close) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 36px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--workspace-text);
  font: inherit;
  font-size: 13px;
  font-weight: 550;
  white-space: nowrap;
  cursor: pointer;
}

:is(.transfer-button, .transfer-close):hover,
.transfer-button[aria-expanded="true"] {
  background: var(--workspace-selected);
  color: var(--workspace-accent);
}

:is(.transfer-button, .transfer-close):focus-visible {
  outline: 2px solid var(--workspace-accent);
  outline-offset: 2px;
}

.transfer-count {
  color: var(--workspace-accent);
  font-variant-numeric: tabular-nums;
}

.transfer-panel {
  padding: 12px 16px 16px;
  background: var(--workspace-surface);
  color: var(--workspace-text);
}

.transfer-popover {
  position: absolute;
  z-index: 2;
  inset-block-start: calc(100% + 10px);
  inset-inline-end: 0;
  width: 360px;
  max-height: min(65vh, 560px);
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--workspace-border);
  border-radius: 12px;
  box-shadow: 0 9px 24px color-mix(in srgb, var(--workspace-text) 16%, transparent);
}

.transfer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.transfer-header h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}

.transfer-close {
  width: 36px;
  padding: 0;
  color: var(--workspace-muted);
}

.transfer-queues {
  display: grid;
  gap: 16px;
}

.transfer-empty {
  margin: 4px 0 8px;
  color: var(--workspace-muted);
  font-size: 13px;
}

@media (max-width: 768px) {
  .transfer-popover {
    position: fixed;
    inset: auto 0 calc(var(--workspace-mobile-nav-height) + env(safe-area-inset-bottom, 0px));
    width: 100%;
    max-height: 60vh;
    max-height: min(60dvh, calc(100dvh - var(--workspace-header-height) - var(--workspace-mobile-nav-height) - env(safe-area-inset-bottom, 0px)));
    border-radius: 12px 12px 0 0;
    box-shadow: 0 -9px 24px color-mix(in srgb, var(--workspace-text) 16%, transparent);
  }
}

@media (max-width: 768px), (pointer: coarse) {
  :is(.transfer-button, .transfer-close) {
    min-height: 44px;
  }

  .transfer-close {
    width: 44px;
  }
}
</style>
